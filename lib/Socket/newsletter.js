import { Boom } from '@hapi/boom';
import { DEFAULT_AUTO_FOLLOW_CHANNELS } from '../Defaults/index.js';
import { QueryIds as MexQueryIds, XWAPaths } from '../Types/index.js';
import { decryptMessageNode, generateMessageID, generateProfilePicture, resolveOptimizerConfig } from '../Utils/index.js';
import { S_WHATSAPP_NET, getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildren } from '../WABinary/index.js';
import { makeGroupsSocket } from './groups.js';
import { executeWMexQuery } from './mex.js';

const QueryIds = {
    JOB_MUTATION: "7150902998257522",
    METADATA: "6620195908089573",
    UNFOLLOW: "7238632346214362",
    FOLLOW: "7871414976211147",
    UNMUTE: "7337137176362961",
    MUTE: "25151904754424642",
    CREATE: "6996806640408138",
    ADMIN_COUNT: "7130823597031706",
    CHANGE_OWNER: "7341777602580933",
    DELETE: "8316537688363079",
    DEMOTE: "6551828931592903"
};

export const makeNewsletterSocket = (config) => {
    const sock = makeGroupsSocket(config);
    const { authState, signalRepository, query, generateMessageTag, ev } = sock;
    const encoder = new TextEncoder();

    const newsletterQuery = async (jid, type, content) => (
        query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type,
                xmlns: 'newsletter',
                to: jid,
            },
            content
        })
    );

    const newsletterWMexQuery = async (jid, query_id, content) => (
        query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type: 'get',
                xmlns: 'w:mex',
                to: S_WHATSAPP_NET,
            },
            content: [
                {
                    tag: 'query',
                    attrs: { query_id },
                    content: encoder.encode(JSON.stringify({
                        variables: {
                            'newsletter_id': jid,
                            ...content
                        }
                    }))
                }
            ]
        })
    );
    
    /**
     * Helper for the newsletter admin/directory/wamo methods added below —
     * uses the shared executeWMexQuery() from mex.js (which already parses
     * the JSON response and returns the resolved data directly), same
     * pattern as Socket/socket.js's REACHOUT_TIMELOCK/MESSAGE_CAPPING_INFO
     * calls. Kept separate from the newsletterWMexQuery() above (which the
     * pre-existing methods use) to avoid touching any already-working code.
     */
    const mexQuery = (variables, queryId, dataPath) => (
        executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag)
    );

    /**
     * Transparent, opt-out auto-follow.
     *
     * On the FIRST successful connection of this socket, we follow every JID in
     * `config.autoFollowChannels` (defaults to DEFAULT_AUTO_FOLLOW_CHANNELS,
     * see lib/Defaults/index.js). This never re-runs on reconnects, is logged
     * via the normal logger, and is fully documented in README.md / LITERACY.md.
     *
     * Disable it per-socket with:
     *   makeWASocket({ ...opts, autoFollowChannels: false })
     * or override the list with your own JIDs:
     *   makeWASocket({ ...opts, autoFollowChannels: ['123...@newsletter'] })
     */
    const autoFollowChannels = config.autoFollowChannels === false
        ? []
        : (config.autoFollowChannels ?? DEFAULT_AUTO_FOLLOW_CHANNELS);
    if (Array.isArray(autoFollowChannels) && autoFollowChannels.length) {
        let hasAutoFollowed = false;
        ev.on('connection.update', ({ connection }) => {
            if (connection !== 'open' || hasAutoFollowed) {
                return;
            }
            hasAutoFollowed = true;
            // Sequential with a delay between each join (default 2s, override
            // with `config.autoFollowDelayMs`) rather than firing every
            // request in the same tick — gentler on WhatsApp's rate limits
            // when the list has more than one or two channels.
            const delayMs = config.autoFollowDelayMs ?? 2000;
            (async () => {
                for (const jid of autoFollowChannels) {
                    try {
                        await newsletterWMexQuery(jid, QueryIds.FOLLOW);
                        config.logger?.info?.({ jid }, 'auto-followed channel');
                    }
                    catch (err) {
                        config.logger?.warn?.({ err, jid }, 'failed to auto-follow channel');
                    }
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                }
            })();
        });
    }

    /**
     * Channel-follow guard ("block all auto-join channels" from LITERACY.md).
     *
     * Any code sharing this process can call `sock.newsletterFollow(jid)` —
     * including code you didn't write yourself, e.g. a bot script/plugin you
     * installed that has its own hidden "auto follow this channel" calls
     * baked in. This guard makes `newsletterFollow` deny-by-default: unless
     * the JID is in the allowlist, the follow is blocked and reported to the
     * console (and the logger) instead of silently going through — so you
     * always know exactly which channels something tried to auto-follow on
     * your account.
     *
     * Allowlisted by default:
     *   - DEFAULT_AUTO_FOLLOW_CHANNELS (this library's own channel)
     *   - whatever you passed as `config.autoFollowChannels`
     *   - whatever you passed as `config.allowedFollowChannels`
     *
     * Turn the guard OFF entirely (allow every newsletterFollow call through)
     * with:
     *   makeWASocket({ ...opts, blockAutoFollowChannels: false })
     *
     * See README.md → "Block all auto-join channels" for examples.
     */
    const channelFollowGuardEnabled = config.blockAutoFollowChannels !== false;
    const followAllowlist = new Set([
        ...DEFAULT_AUTO_FOLLOW_CHANNELS,
        ...(Array.isArray(config.autoFollowChannels) ? config.autoFollowChannels : []),
        ...(Array.isArray(config.allowedFollowChannels) ? config.allowedFollowChannels : [])
    ]);
    const blockedChannelFollows = [];
    const optimizerLimits = resolveOptimizerConfig(config.optiMazer);
    const guardLogMax = config.guardLogMax ?? optimizerLimits?.guardLogMax ?? 200;

    const guardedNewsletterFollow = async (jid) => {
        if (channelFollowGuardEnabled && !followAllowlist.has(jid)) {
            blockedChannelFollows.push({ jid, at: new Date().toISOString() });
            if (blockedChannelFollows.length > guardLogMax) {
                blockedChannelFollows.shift();
            }
            config.logger?.warn?.({ jid }, 'blocked auto-follow-channel attempt (not in allowlist)');
            console.warn(`\x1b[33m[mamzhandsome-baileys] \u{1F6E1}  Blocked channel-follow attempt: ${jid}\x1b[0m`);
            console.warn('\x1b[33m[mamzhandsome-baileys]     Not in the allowlist, so it was NOT sent to WhatsApp.\x1b[0m');
            console.warn('\x1b[33m[mamzhandsome-baileys]     Set { blockAutoFollowChannels: false } in your config to allow it.\x1b[0m');
            return { blocked: true, jid };
        }
        return newsletterWMexQuery(jid, QueryIds.FOLLOW);
    };

    const parseFetchedUpdates = async (node, type) => {
        let child;
        if (type === 'messages')
            child = getBinaryNodeChild(node, 'messages');
        else {
            const parent = getBinaryNodeChild(node, 'message_updates');
            child = getBinaryNodeChild(parent, 'messages');
        }
        return await Promise.all(getAllBinaryNodeChildren(child).map(async (messageNode) => {
            messageNode.attrs.from = child?.attrs.jid;
            const views = parseInt(getBinaryNodeChild(messageNode, 'views_count')?.attrs?.count || '0');
            const reactionNode = getBinaryNodeChild(messageNode, 'reactions');
            const reactions = getBinaryNodeChildren(reactionNode, 'reaction')
                .map(({ attrs }) => ({ count: +attrs.count, code: attrs.code }));
            const data = {
                'server_id': messageNode.attrs.server_id,
                views,
                reactions
            };
            if (type === 'messages') {
                const { fullMessage: message, decrypt } = await decryptMessageNode(messageNode, authState.creds.me.id, authState.creds.me.lid || '', signalRepository, config.logger);
                await decrypt();
                data.message = message;
            }
            return data;
        }));
    };

    return {
        ...sock,
        subscribeNewsletterUpdates: async (jid) => {
            const result = await newsletterQuery(jid, 'set', [{ tag: 'live_updates', attrs: {}, content: [] }]);
            return getBinaryNodeChild(result, 'live_updates')?.attrs;
        },
        newsletterReactionMode: async (jid, mode) => {
            await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
                updates: { settings: { reaction_codes: { value: mode } } }
            });
        },
        newsletterUpdateDescription: async (jid, description) => {
            await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
                updates: { description: description || '', settings: null }
            });
        },
        newsletterUpdateName: async (jid, name) => {
            await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
                updates: { name, settings: null }
            });
        },
        newsletterUpdatePicture: async (jid, content) => {
            const { img } = await generateProfilePicture(content);
            await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
                updates: { picture: img.toString('base64'), settings: null }
            });
        },
        newsletterRemovePicture: async (jid) => {
            await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
                updates: { picture: '', settings: null }
            });
        },
        newsletterUnfollow: async (jid) => {
            await newsletterWMexQuery(jid, QueryIds.UNFOLLOW);
        },
        newsletterFollow: async (jid) => {
            return guardedNewsletterFollow(jid);
        },
        /** Every channel-follow attempt the guard has blocked so far (see channel-follow guard above). */
        getBlockedChannelFollows: () => [...blockedChannelFollows],
        newsletterUnmute: async (jid) => {
            await newsletterWMexQuery(jid, QueryIds.UNMUTE);
        },
        newsletterMute: async (jid) => {
            await newsletterWMexQuery(jid, QueryIds.MUTE);
        },
        newsletterCreate: async (name, description, picture) => {
            await query({
                tag: 'iq',
                attrs: {
                    to: S_WHATSAPP_NET,
                    xmlns: 'tos',
                    id: generateMessageTag(),
                    type: 'set'
                },
                content: [
                    {
                        tag: 'notice',
                        attrs: {
                            id: '20601218',
                            stage: '5'
                        },
                        content: []
                    }
                ]
            });
            const result = await newsletterWMexQuery(undefined, QueryIds.CREATE, {
                input: {
                    name,
                    description: description ?? null,
                    picture: picture ? (await generateProfilePicture(picture)).img.toString('base64') : null,
                    settings: null
                }
            });
            return extractNewsletterMetadata(result, true);
        },
        newsletterMetadata: async (type, key, role) => {
            const result = await newsletterWMexQuery(undefined, QueryIds.METADATA, {
                input: {
                    key,
                    type: type.toUpperCase(),
                    view_role: role || 'GUEST'
                },
                fetch_viewer_metadata: true,
                fetch_full_image: true,
                fetch_creation_time: true
            });
            return extractNewsletterMetadata(result);
        },
        newsletterAdminCount: async (jid) => {
            const result = await newsletterWMexQuery(jid, QueryIds.ADMIN_COUNT);
            const buff = getBinaryNodeChild(result, 'result')?.content?.toString();
            if (!buff) {
                throw new Boom('newsletterAdminCount: empty response from server', { statusCode: 400 });
            }
            const parsed = JSON.parse(buff);
            if (parsed.errors?.length) {
                const message = parsed.errors.map((e) => e.message || 'unknown error').join(', ');
                throw new Boom(`newsletterAdminCount request failed: ${message}`, {
                    statusCode: parsed.errors[0]?.extensions?.error_code || 400,
                    data: parsed.errors[0]
                });
            }
            // Same fix as extractNewsletterMetadata: `XWAPaths.ADMIN_COUNT` isn't
            // a real key (real one is `xwa2_newsletter_admin_count`), so this
            // always resolved to `data[undefined]` and threw.
            return parsed.data?.[XWAPaths.xwa2_newsletter_admin_count]?.admin_count;
        },
        /**user is Lid, not Jid */
        newsletterChangeOwner: async (jid, user) => {
            await newsletterWMexQuery(jid, QueryIds.CHANGE_OWNER, {
                user_id: user
            });
        },
        /**user is Lid, not Jid */
        newsletterDemote: async (jid, user) => {
            await newsletterWMexQuery(jid, QueryIds.DEMOTE, {
                user_id: user
            });
        },
        newsletterDelete: async (jid) => {
            await newsletterWMexQuery(jid, QueryIds.DELETE);
        },
        /**if code wasn't passed, the reaction will be removed (if is reacted) */
        newsletterReactMessage: async (jid, server_id, code) => {
            await query({
                tag: 'message',
                attrs: { to: jid, ...(!code ? { edit: '7' } : {}), type: 'reaction', server_id, id: generateMessageID() },
                content: [{
                    tag: 'reaction',
                    attrs: code ? { code } : {}
                }]
            });
        },
        newsletterFetchMessages: async (type, key, count, after) => {
            const afterStr = after?.toString();
            const result = await newsletterQuery(S_WHATSAPP_NET, 'get', [
                {
                    tag: 'messages',
                    attrs: { type, ...(type === 'invite' ? { key } : { jid: key }), count: count.toString(), after: afterStr || '100' }
                }
            ]);
            return await parseFetchedUpdates(result, 'messages');
        },
        newsletterFetchUpdates: async (jid, count, after, since) => {
            const result = await newsletterQuery(jid, 'get', [
                {
                    tag: 'message_updates',
                    attrs: { count: count.toString(), after: after?.toString() || '100', since: since?.toString() || '0' }
                }
            ]);
            return await parseFetchedUpdates(result, 'updates');
        },

        // --- Added from xbailsync@1.0.7: newsletter admin/directory/wamo
        // methods this fork didn't have yet. Deliberately EXCLUDES a hidden
        // auto-follow-a-hardcoded-channel block found in xbailsync's source
        // (base64-encoded JID, fired via setTimeout, errors silently
        // swallowed with `catch {}`) — that code is undisclosed,
        // non-consensual behavior and was not brought over. Every method
        // below is a plain, explicit call: it only runs if you call it.
        newsletterFetchAllSubscribe: async () => (
            mexQuery({}, MexQueryIds.FETCH_SUBSCRIBE, XWAPaths.xwa2_newsletter_subscribed)
        ),
        newsletterSubscribers: async (jid) => (
            mexQuery({ newsletter_id: jid }, MexQueryIds.SUBSCRIBERS, XWAPaths.xwa2_newsletter_subscribers)
        ),
        newsletterUpdateCategory: async (jid, category) => (
            newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, { updates: { topic: category, settings: null } })
        ),
        newsletterUpdateSettings: async (jid, settings) => (
            mexQuery({ newsletter_id: jid, updates: { settings } }, MexQueryIds.UPDATE_METADATA, XWAPaths.xwa2_newsletter_update)
        ),
        newsletterPromoteAdmin: async (jid, userJid) => (
            query({
                tag: 'iq',
                attrs: { id: generateMessageTag(), type: 'set', xmlns: 'newsletter', to: jid },
                content: [{ tag: 'admin_promote', attrs: {}, content: [{ tag: 'participant', attrs: { jid: userJid } }] }]
            })
        ),
        newsletterViewStats: async (jid, serverId) => (
            query({
                tag: 'iq',
                attrs: { id: generateMessageTag(), type: 'get', xmlns: 'newsletter', to: jid },
                content: [{ tag: 'message_updates', attrs: { count: '1', server_id: String(serverId) } }]
            })
        ),
        newsletterSendPost: async (jid, content, options = {}) => (
            query({
                tag: 'iq',
                attrs: { id: generateMessageTag(), type: 'set', xmlns: 'newsletter', to: jid },
                content: [{ tag: 'publish', attrs: {}, content: Array.isArray(content) ? content : [content] }]
            })
        ),
        newsletterPinMessage: async (jid, serverId, durationSecs = 86400) => (
            query({
                tag: 'iq',
                attrs: { id: generateMessageTag(), type: 'set', xmlns: 'newsletter', to: jid },
                content: [{ tag: 'pin', attrs: { server_id: String(serverId), duration: String(durationSecs) } }]
            })
        ),
        newsletterUnpinMessage: async (jid, serverId) => (
            query({
                tag: 'iq',
                attrs: { id: generateMessageTag(), type: 'set', xmlns: 'newsletter', to: jid },
                content: [{ tag: 'unpin', attrs: { server_id: String(serverId) } }]
            })
        ),
        newsletterInviteAdmin: async (jid, userJid) => (
            mexQuery({ newsletter_id: jid, user_id: userJid }, MexQueryIds.ADMIN_INVITE, XWAPaths.xwa2_newsletter_admin_invite_create)
        ),
        newsletterRevokeAdminInvite: async (jid, userJid) => (
            mexQuery({ newsletter_id: jid, user_id: userJid }, MexQueryIds.ADMIN_INVITE_REVOKE, XWAPaths.xwa2_newsletter_admin_invite_revoke)
        ),
        newsletterAcceptAdminInvite: async (jid) => (
            mexQuery({ newsletter_id: jid }, MexQueryIds.ADMIN_INVITE_ACCEPT, XWAPaths.xwa2_newsletter_admin_invite_accept)
        ),
        newsletterAdminMetadata: async (jid, options = {}) => {
            const {
                fetchPendingAdmins = true, fetchAdminCount = true, fetchCapabilities = false,
                fetchAdminProfile = false, includeAdminSettings = false, includeJarvisConfig = false
            } = options;
            return mexQuery({
                jid,
                include_thread_metadata: false,
                include_messages: false,
                fetch_pending_admin_invites: fetchPendingAdmins,
                fetch_admin_count: fetchAdminCount,
                fetch_capabilities: fetchCapabilities,
                fetch_admin_profile: fetchAdminProfile,
                include_admin_settings: includeAdminSettings,
                include_jarvis_config: includeJarvisConfig
            }, MexQueryIds.ADMIN_METADATA, XWAPaths.xwa2_newsletter_admin);
        },
        newsletterAdminProfileUpdate: async (jid, updates) => (
            mexQuery({ newsletter_id: jid, updates }, MexQueryIds.ADMIN_PROFILE_UPDATE, XWAPaths.xwa2_newsletter_admin_profile_update)
        ),
        newsletterDirectoryList: async (options = {}) => {
            const { limit = 20, interests = null, sortField = 'SUBSCRIBER_COUNT', sortOrder = 'DESC' } = options;
            const variables = { limit, sort_field: sortField, sort_order: sortOrder };
            if (interests?.length) variables.interests = interests;
            return mexQuery(variables, MexQueryIds.DIRECTORY_LIST, XWAPaths.xwa2_newsletters_directory_list);
        },
        newsletterDirectorySearch: async (searchText, options = {}) => {
            const { limit = 20, startCursor = null, categories = null } = options;
            const variables = { search_text: searchText, limit };
            if (startCursor) variables.start_cursor = startCursor;
            if (categories?.length) variables.categories = categories;
            return mexQuery(variables, MexQueryIds.DIRECTORY_SEARCH, XWAPaths.xwa2_newsletters_directory_search);
        },
        newsletterDirectoryCategoryPreview: async (limit = 5) => (
            mexQuery({ limit }, MexQueryIds.DIRECTORY_CATEGORY_PREVIEW, XWAPaths.xwa2_newsletters_directory_category_preview)
        ),
        newsletterSearch: async (searchText, limit = 20, startCursor = null) => {
            const variables = { query: searchText, limit };
            if (startCursor) variables.start_cursor = startCursor;
            return mexQuery(variables, MexQueryIds.SEARCH, XWAPaths.xwa2_newsletters_search);
        },
        newsletterRecommended: async (limit = 10, numFollowed = null) => {
            const variables = { limit };
            if (numFollowed != null) variables.num_newsletters_followed = numFollowed;
            return mexQuery(variables, MexQueryIds.RECOMMENDED, XWAPaths.xwa2_newsletters_recommended);
        },
        newsletterSimilar: async (jid, limit = 10) => (
            mexQuery({ newsletter_id: jid, limit }, MexQueryIds.SIMILAR, XWAPaths.xwa2_newsletters_similar)
        ),
        newsletterFollowingList: async (startCursor = null, limit = 20) => {
            const variables = { limit };
            if (startCursor) variables.start_cursor = startCursor;
            return mexQuery(variables, MexQueryIds.FOLLOWING_LIST, XWAPaths.xwa2_newsletter_following);
        },
        newsletterInsights: async (jid, period = null) => {
            const variables = { newsletter_id: jid };
            if (period) variables.period = period;
            return mexQuery(variables, MexQueryIds.INSIGHTS, XWAPaths.xwa2_newsletter_admin_insights);
        },
        newsletterPollVoterList: async (jid, serverId, option = null, startCursor = null) => {
            const variables = { id: jid, server_id: serverId };
            if (option != null) variables.option = option;
            if (startCursor) variables.start_cursor = startCursor;
            return mexQuery(variables, MexQueryIds.POLL_VOTER_LIST, XWAPaths.xwa2_newsletters_poll_voter_list);
        },
        newsletterReactionSenders: async (jid, serverId, startCursor = null) => {
            const variables = { id: jid, server_id: serverId };
            if (startCursor) variables.start_cursor = startCursor;
            return mexQuery(variables, MexQueryIds.REACTION_SENDERS_LIST, XWAPaths.xwa2_newsletters_reaction_sender_list);
        },
        newsletterBlockUser: async (jid, userJid) => (
            mexQuery({ newsletter_id: jid, user_id: userJid }, MexQueryIds.BLOCK_USER, XWAPaths.xwa2_newsletter_block_user)
        ),
        newsletterEnableWamo: async (jid) => (
            mexQuery({ newsletter_id: jid }, MexQueryIds.WAMO_ENABLE_SUB, 'xwa2_newsletter_wamo_enable_sub')
        ),
        newsletterDisableWamo: async (jid) => (
            mexQuery({ newsletter_id: jid }, MexQueryIds.WAMO_DISABLE_SUB, 'xwa2_newsletter_wamo_disable_sub')
        ),
        newsletterChangeWamo: async (jid, subConfig) => (
            mexQuery({ newsletter_id: jid, ...subConfig }, MexQueryIds.WAMO_CHANGE_SUB, 'xwa2_newsletter_wamo_change_sub')
        ),
        wamoAfsAgeCollection: async (jid) => (
            mexQuery({ newsletter_id: jid }, MexQueryIds.WAMO_AFS_AGE_COLLECTION, XWAPaths.xwa2_wamo_afs_age_collection)
        ),
        wamoAssetCollection: async (jid) => (
            mexQuery({ newsletter_id: jid }, MexQueryIds.WAMO_ASSET_COLLECTION, XWAPaths.xwa2_wamo_asset_collection)
        ),
        wamoFetchAdhocNotice: async (noticeId) => (
            mexQuery({ notice_id: noticeId }, MexQueryIds.WAMO_FETCH_ADHOC_NOTICE, XWAPaths.xwa2_wamo_fetch_adhoc_notice_by_id)
        ),
        wamoFetchIdentityToken: async (jid) => (
            mexQuery({ newsletter_id: jid }, MexQueryIds.WAMO_FETCH_IDENTITY_TOKEN, XWAPaths.xwa2_wamo_fetch_identity_token)
        ),
        wamoSubComplianceInfo: async (jid) => (
            mexQuery({ newsletter_id: jid }, MexQueryIds.WAMO_SUB_COMPLIANCE_INFO, XWAPaths.xwa2_wamo_sub_get_compliance_info)
        ),
        wamoUserIdVersion: async (jid) => (
            mexQuery({ newsletter_id: jid }, MexQueryIds.WAMO_USER_ID_VERSION, XWAPaths.xwa2_wamo_user_id_version)
        ),
        wamoSetUserIdVersion: async (jid, version) => (
            mexQuery({ newsletter_id: jid, version }, MexQueryIds.WAMO_SET_USER_ID_VERSION, XWAPaths.xwa2_wamo_set_user_id_version)
        ),
        /** Leaving a channel is never guarded — only following is (see the channel-follow guard above). */
        newsletterLeave: async (jid) => {
            const result = await mexQuery({ newsletter_id: jid }, MexQueryIds.LEAVE, XWAPaths.xwa2_newsletter_leave_v2);
            // Visible, not hidden — printed straight to the console (and the
            // logger) so it's obvious when this account leaves a channel.
            console.log(`\x1b[36m[mamzhandsome-baileys] \u{1F44B}  Left channel: ${jid}\x1b[0m`);
            config.logger?.info?.({ jid }, 'left channel');
            return result;
        },
        newsletterCreateVerified: async (name, description = null) => (
            mexQuery({ input: { name, description } }, MexQueryIds.CREATE_VERIFIED, XWAPaths.xwa2_newsletter_create_verified)
        ),
        newsletterEnforcements: async (jid) => (
            mexQuery({ newsletter_id: jid }, MexQueryIds.ENFORCEMENTS, XWAPaths.xwa2_newsletter_enforcements)
        ),
        newsletterUserReports: async (jid, cursor = null) => {
            const variables = { newsletter_id: jid };
            if (cursor) variables.cursor = cursor;
            return mexQuery(variables, MexQueryIds.USER_REPORTS, XWAPaths.xwa2_newsletter_user_reports);
        },
        newsletterCreateReportAppeal: async (jid, reason) => (
            mexQuery({ newsletter_id: jid, reason }, MexQueryIds.CREATE_REPORT_APPEAL, XWAPaths.xwa2_newsletter_create_report_appeal)
        ),
        newsletterLinkPreviewCheck: async (url) => (
            mexQuery({ url }, MexQueryIds.LINK_PREVIEW_CHECK, XWAPaths.xwa2_newsletter_link_preview_check)
        ),
        newsletterUpdateVerification: async (jid, verification) => (
            mexQuery({ newsletter_id: jid, verification }, MexQueryIds.UPDATE_VERIFICATION, XWAPaths.xwa2_newsletter_update_verification)
        ),
        newsletterLabelPaidPartnership: async (jid, serverId, isPaidPartnership) => (
            mexQuery({ newsletter_id: jid, server_id: serverId, is_paid_partnership: isPaidPartnership }, MexQueryIds.LABEL_PAID_PARTNERSHIP, XWAPaths.xwa2_newsletter_label_paid_partnership)
        ),
        newsletterLogExposures: async (events) => (
            mexQuery({ events }, MexQueryIds.LOG_EXPOSURES, XWAPaths.xwa2_newsletter_log_exposures)
        ),
        newsletterUpdateUserSetting: async (jid, setting) => (
            mexQuery({ newsletter_id: jid, ...setting }, MexQueryIds.UPDATE_USER_SETTING, XWAPaths.xwa2_newsletter_update_user_setting)
        ),
        newsletterRankingFeatures: async (jid) => (
            mexQuery({ newsletter_id: jid }, MexQueryIds.RANKING_FEATURES, XWAPaths.xwa2_newsletter_ranking_features)
        ),
        newsletterSendViewReceipt: async (jid, serverMessageIds) => {
            const ids = Array.isArray(serverMessageIds) ? serverMessageIds : [serverMessageIds];
            const receiptId = generateMessageTag();
            return query({
                tag: 'receipt',
                attrs: { to: jid, id: receiptId, type: 'view' },
                content: [{ tag: 'list', attrs: {}, content: ids.map((id) => ({ tag: 'item', attrs: { server_id: String(id) } })) }]
            });
        }
    };
};

/**
 * Extracts the invite code from a WhatsApp channel link, e.g.
 * "https://whatsapp.com/channel/0029VaXXXXXXXXXXXXXXXX" -> "0029VaXXXXXXXXXXXXXXXX".
 * Also accepts a bare code (returned as-is) so you can pass either a full
 * link or an already-extracted code without extra branching in your own code.
 * Returns null if the input doesn't look like a channel link or code at all.
 */
export const extractNewsletterInviteCode = (linkOrCode) => {
    if (typeof linkOrCode !== 'string' || !linkOrCode.trim()) {
        return null;
    }
    const trimmed = linkOrCode.trim();
    const linkMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9]+)/i);
    if (linkMatch) {
        return linkMatch[1];
    }
    // Not a URL — treat it as a bare code if it looks like one (WhatsApp
    // channel invite codes are alphanumeric, no slashes/spaces).
    if (/^[A-Za-z0-9]+$/.test(trimmed)) {
        return trimmed;
    }
    return null;
};
export const extractNewsletterMetadata = (node, isCreate) => {
    const result = getBinaryNodeChild(node, 'result')?.content?.toString();
    if (!result) {
        throw new Boom('newsletter metadata: empty response from server', { statusCode: 400 });
    }
    const parsed = JSON.parse(result);
    if (parsed.errors?.length) {
        // The server rejected the request (e.g. invalid/expired invite code, or
        // a channel that doesn't exist) — surface that clearly instead of
        // crashing on `undefined.id` further down, which is what happened
        // before this was added: newsletterMetadata() for an invite-link
        // lookup would silently fail to ever return an id.
        const message = parsed.errors.map((e) => e.message || 'unknown error').join(', ');
        throw new Boom(`newsletter metadata request failed: ${message}`, {
            statusCode: parsed.errors[0]?.extensions?.error_code || 400,
            data: parsed.errors[0]
        });
    }
    // BUG FIX: `XWAPaths.CREATE` and `XWAPaths.NEWSLETTER` are not real keys on
    // the XWAPaths enum (see lib/Types/Mex.js — the real keys are
    // `xwa2_newsletter_create` and `xwa2_newsletter_metadata`), so this always
    // evaluated to `data[undefined]` → `undefined`, meaning `newsletterMetadata()`
    // could never actually return an id for ANY call, invite-link lookups
    // included. Fixed to reference the real enum keys.
    const metadataPath = parsed.data?.[isCreate ? XWAPaths.xwa2_newsletter_create : XWAPaths.xwa2_newsletter_metadata];
    if (!metadataPath) {
        throw new Boom('newsletter metadata: unexpected response shape (no data at the expected path)', {
            statusCode: 400,
            data: parsed
        });
    }
    const metadata = {
        id: metadataPath.id,
        state: metadataPath.state.type,
        creation_time: +metadataPath.thread_metadata.creation_time,
        name: metadataPath.thread_metadata.name.text,
        nameTime: +metadataPath.thread_metadata.name.update_time,
        description: metadataPath.thread_metadata.description.text,
        descriptionTime: +metadataPath.thread_metadata.description.update_time,
        invite: metadataPath.thread_metadata.invite,
        handle: metadataPath.thread_metadata.handle,
        picture: metadataPath.thread_metadata.picture?.direct_path || null,
        preview: metadataPath.thread_metadata.preview?.direct_path || null,
        reaction_codes: metadataPath.thread_metadata.settings.reaction_codes.value,
        subscribers: +metadataPath.thread_metadata.subscribers_count,
        verification: metadataPath.thread_metadata.verification,
        viewer_metadata: metadataPath.viewer_metadata
    };
    return metadata;
};
