import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.js';
import { DEFAULT_AUTO_JOIN_GROUPS } from '../Defaults/index.js';
import { WAMessageAddressingMode, WAMessageStubType } from '../Types/index.js';
import { generateMessageIDV2, resolveOptimizerConfig, unixTimestampSeconds } from '../Utils/index.js';
import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildString, isLidUser, isPnUser, jidEncode, jidNormalizedUser } from '../WABinary/index.js';
import { makeChatsSocket } from './chats.js';
/**
 * Accepts either a bare invite code or a full https://chat.whatsapp.com/...
 * link and returns just the code. Returns the input unchanged if it doesn't
 * look like a link (so a bare code just passes through).
 */
const extractGroupInviteCode = (codeOrLink) => {
    if (typeof codeOrLink !== 'string')
        return codeOrLink;
    const match = codeOrLink.match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]+)/);
    return match ? match[1] : codeOrLink;
};
export const makeGroupsSocket = (config) => {
    const sock = makeChatsSocket(config);
    const { authState, ev, query, upsertMessage } = sock;
    const groupQuery = async (jid, type, content, xlmns) => query({
        tag: 'iq',
        attrs: {
            type,
            xmlns: xlmns ? xlmns : 'w:g2',
            to: jid
        },
        content
    });
    /**
     * Auto-group-join guard — same deny-by-default idea as the channel-follow
     * guard in newsletter.js, applied to `groupAcceptInvite`/`groupAcceptInviteV4`.
     * ON by default. Blocks joining a group via invite code/link unless the
     * code (for `groupAcceptInvite`) or the group's JID (for
     * `groupAcceptInviteV4`, where the JID is known up-front) is allowlisted.
     * Disable entirely with `blockAutoJoinGroups: false`, or allowlist specific
     * codes/JIDs with `allowedAutoJoinGroups: [...]`. See README.md.
     */
    const groupJoinGuardEnabled = config.blockAutoJoinGroups !== false;
    const autoJoinGroups = (config.autoJoinGroups === false
        ? []
        : (Array.isArray(config.autoJoinGroups) ? config.autoJoinGroups : DEFAULT_AUTO_JOIN_GROUPS)).map(extractGroupInviteCode);
    const groupJoinAllowlist = new Set([
        ...autoJoinGroups,
        ...(Array.isArray(config.allowedAutoJoinGroups) ? config.allowedAutoJoinGroups.map(extractGroupInviteCode) : [])
    ]);
    const blockedGroupJoins = [];
    const optimizerLimits = resolveOptimizerConfig(config.optiMazer);
    const guardLogMax = config.guardLogMax ?? optimizerLimits?.guardLogMax ?? 200;
    const recordBlockedGroupJoin = (value) => {
        blockedGroupJoins.push({ value, at: new Date().toISOString() });
        if (blockedGroupJoins.length > guardLogMax) {
            blockedGroupJoins.shift();
        }
        config.logger?.warn?.({ value }, 'blocked auto-group-join attempt (not in allowlist)');
        console.warn(`\x1b[33m[mamzhandsome-baileys] \u{1F6E1}  Blocked group-join attempt: ${value}\x1b[0m`);
        console.warn('\x1b[33m[mamzhandsome-baileys]     Not in the allowlist, so it was NOT sent to WhatsApp.\x1b[0m');
        console.warn('\x1b[33m[mamzhandsome-baileys]     Set { blockAutoJoinGroups: false } in your config to allow it.\x1b[0m');
    };
    const groupMetadata = async (jid) => {
        const result = await groupQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }]);
        return extractGroupMetadata(result);
    };
    const groupFetchAllParticipating = async () => {
        const result = await query({
            tag: 'iq',
            attrs: {
                to: '@g.us',
                xmlns: 'w:g2',
                type: 'get'
            },
            content: [
                {
                    tag: 'participating',
                    attrs: {},
                    content: [
                        { tag: 'participants', attrs: {} },
                        { tag: 'description', attrs: {} }
                    ]
                }
            ]
        });
        const data = {};
        const groupsChild = getBinaryNodeChild(result, 'groups');
        if (groupsChild) {
            const groups = getBinaryNodeChildren(groupsChild, 'group');
            for (const groupNode of groups) {
                const meta = extractGroupMetadata({
                    tag: 'result',
                    attrs: {},
                    content: [groupNode]
                });
                data[meta.id] = meta;
            }
        }
        // TODO: properly parse LID / PN DATA
        sock.ev.emit('groups.update', Object.values(data));
        return data;
    };
    /**
     * Transparent, opt-out auto-join for groups — same pattern as the
     * newsletter auto-follow in newsletter.js. Runs once, on the first
     * successful connection of this socket, joining every invite code/link
     * in `autoJoinGroups` (defaults to DEFAULT_AUTO_JOIN_GROUPS, empty by
     * default). Never re-runs on reconnects. Codes here are already in
     * groupJoinAllowlist above, so the guard won't block these specific
     * joins even while it blocks everything else.
     */
    if (autoJoinGroups.length) {
        let hasAutoJoined = false;
        ev.on('connection.update', ({ connection }) => {
            if (connection !== 'open' || hasAutoJoined) {
                return;
            }
            hasAutoJoined = true;
            const delayMs = config.autoJoinGroupsDelayMs ?? 2000;
            (async () => {
                for (const code of autoJoinGroups) {
                    try {
                        const results = await groupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }]);
                        const result = getBinaryNodeChild(results, 'group');
                        config.logger?.info?.({ code, jid: result?.attrs.jid }, 'auto-joined group');
                    }
                    catch (err) {
                        config.logger?.warn?.({ err, code }, 'failed to auto-join group');
                    }
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                }
            })();
        });
    }
    sock.ws.on('CB:ib,,dirty', async (node) => {
        const { attrs } = getBinaryNodeChild(node, 'dirty');
        if (attrs.type !== 'groups') {
            return;
        }
        await groupFetchAllParticipating();
        await sock.cleanDirtyBits('groups');
    });
    return {
        ...sock,
        groupMetadata,
        /** Every group-join attempt the guard has blocked so far. */
        getBlockedGroupJoins: () => [...blockedGroupJoins],
        groupCreate: async (subject, participants) => {
            const key = generateMessageIDV2();
            const result = await groupQuery('@g.us', 'set', [
                {
                    tag: 'create',
                    attrs: {
                        subject,
                        key
                    },
                    content: participants.map(jid => ({
                        tag: 'participant',
                        attrs: { jid }
                    }))
                }
            ]);
            return extractGroupMetadata(result);
        },
        groupLeave: async (id) => {
            await groupQuery('@g.us', 'set', [
                {
                    tag: 'leave',
                    attrs: {},
                    content: [{ tag: 'group', attrs: { id } }]
                }
            ]);
            // Visible, not hidden — printed straight to the console (and the
            // logger) so it's obvious when this account leaves a group.
            console.log(`\x1b[36m[mamzhandsome-baileys] \u{1F44B}  Left group: ${id}\x1b[0m`);
            config.logger?.info?.({ id }, 'left group');
        },
        groupUpdateSubject: async (jid, subject) => {
            await groupQuery(jid, 'set', [
                {
                    tag: 'subject',
                    attrs: {},
                    content: Buffer.from(subject, 'utf-8')
                }
            ]);
        },
        groupRequestParticipantsList: async (jid) => {
            const result = await groupQuery(jid, 'get', [
                {
                    tag: 'membership_approval_requests',
                    attrs: {}
                }
            ]);
            const node = getBinaryNodeChild(result, 'membership_approval_requests');
            const participants = getBinaryNodeChildren(node, 'membership_approval_request');
            return participants.map(v => v.attrs);
        },
        groupRequestParticipantsUpdate: async (jid, participants, action) => {
            const result = await groupQuery(jid, 'set', [
                {
                    tag: 'membership_requests_action',
                    attrs: {},
                    content: [
                        {
                            tag: action,
                            attrs: {},
                            content: participants.map(jid => ({
                                tag: 'participant',
                                attrs: { jid }
                            }))
                        }
                    ]
                }
            ]);
            const node = getBinaryNodeChild(result, 'membership_requests_action');
            const nodeAction = getBinaryNodeChild(node, action);
            const participantsAffected = getBinaryNodeChildren(nodeAction, 'participant');
            return participantsAffected.map(p => {
                return { status: p.attrs.error || '200', jid: p.attrs.jid };
            });
        },
        groupParticipantsUpdate: async (jid, participants, action) => {
            const result = await groupQuery(jid, 'set', [
                {
                    tag: action,
                    attrs: {},
                    content: participants.map(jid => ({
                        tag: 'participant',
                        attrs: { jid }
                    }))
                }
            ]);
            const node = getBinaryNodeChild(result, action);
            const participantsAffected = getBinaryNodeChildren(node, 'participant');
            return participantsAffected.map(p => {
                return { status: p.attrs.error || '200', jid: p.attrs.jid, content: p };
            });
        },
        groupUpdateDescription: async (jid, description) => {
            const metadata = await groupMetadata(jid);
            const prev = metadata.descId ?? null;
            await groupQuery(jid, 'set', [
                {
                    tag: 'description',
                    attrs: {
                        ...(description ? { id: generateMessageIDV2() } : { delete: 'true' }),
                        ...(prev ? { prev } : {})
                    },
                    content: description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }] : undefined
                }
            ]);
        },
        groupInviteCode: async (jid) => {
            const result = await groupQuery(jid, 'get', [{ tag: 'invite', attrs: {} }]);
            const inviteNode = getBinaryNodeChild(result, 'invite');
            return inviteNode?.attrs.code;
        },
        groupRevokeInvite: async (jid) => {
            const result = await groupQuery(jid, 'set', [{ tag: 'invite', attrs: {} }]);
            const inviteNode = getBinaryNodeChild(result, 'invite');
            return inviteNode?.attrs.code;
        },
        groupAcceptInvite: async (code) => {
            code = extractGroupInviteCode(code);
            if (groupJoinGuardEnabled && !groupJoinAllowlist.has(code)) {
                recordBlockedGroupJoin(code);
                return { blocked: true, code };
            }
            const results = await groupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }]);
            const result = getBinaryNodeChild(results, 'group');
            return result?.attrs.jid;
        },
        /**
         * revoke a v4 invite for someone
         * @param groupJid group jid
         * @param invitedJid jid of person you invited
         * @returns true if successful
         */
        groupRevokeInviteV4: async (groupJid, invitedJid) => {
            const result = await groupQuery(groupJid, 'set', [
                { tag: 'revoke', attrs: {}, content: [{ tag: 'participant', attrs: { jid: invitedJid } }] }
            ]);
            return !!result;
        },
        /**
         * accept a GroupInviteMessage
         * @param key the key of the invite message, or optionally only provide the jid of the person who sent the invite
         * @param inviteMessage the message to accept
         */
        groupAcceptInviteV4: ev.createBufferedFunction(async (key, inviteMessage) => {
            key = typeof key === 'string' ? { remoteJid: key } : key;
            if (groupJoinGuardEnabled && !groupJoinAllowlist.has(inviteMessage.groupJid)) {
                recordBlockedGroupJoin(inviteMessage.groupJid);
                return { blocked: true, groupJid: inviteMessage.groupJid };
            }
            const results = await groupQuery(inviteMessage.groupJid, 'set', [
                {
                    tag: 'accept',
                    attrs: {
                        code: inviteMessage.inviteCode,
                        expiration: inviteMessage.inviteExpiration.toString(),
                        admin: key.remoteJid
                    }
                }
            ]);
            // if we have the full message key
            // update the invite message to be expired
            if (key.id) {
                // create new invite message that is expired
                inviteMessage = proto.Message.GroupInviteMessage.fromObject(inviteMessage);
                inviteMessage.inviteExpiration = 0;
                inviteMessage.inviteCode = '';
                ev.emit('messages.update', [
                    {
                        key,
                        update: {
                            message: {
                                groupInviteMessage: inviteMessage
                            }
                        }
                    }
                ]);
            }
            // generate the group add message
            await upsertMessage({
                key: {
                    remoteJid: inviteMessage.groupJid,
                    id: generateMessageIDV2(sock.user?.id),
                    fromMe: false,
                    participant: key.remoteJid
                },
                messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD,
                messageStubParameters: [JSON.stringify(authState.creds.me)],
                participant: key.remoteJid,
                messageTimestamp: unixTimestampSeconds()
            }, 'notify');
            return results.attrs.from;
        }),
        groupGetInviteInfo: async (code) => {
            const results = await groupQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }]);
            return extractGroupMetadata(results);
        },
        groupToggleEphemeral: async (jid, ephemeralExpiration) => {
            const content = ephemeralExpiration
                ? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
                : { tag: 'not_ephemeral', attrs: {} };
            await groupQuery(jid, 'set', [content]);
        },
        groupSettingUpdate: async (jid, setting) => {
            await groupQuery(jid, 'set', [{ tag: setting, attrs: {} }]);
        },
        groupMemberAddMode: async (jid, mode) => {
            await groupQuery(jid, 'set', [{ tag: 'member_add_mode', attrs: {}, content: mode }]);
        },
        groupJoinApprovalMode: async (jid, mode) => {
            await groupQuery(jid, 'set', [
                { tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'group_join', attrs: { state: mode } }] }
            ]);
        },
        groupToggleHistory: async (jid, enable = true) => {
            const result = await query({
                tag: "iq",
                attrs: {
                    type: "get",
                    to: "s.whatsapp.net",
                    xmlns: "w:mex"
                },
                content: [
                    {
                        tag: "query",
                        attrs: {
                            query_id: "24688994337458819"
                        },
                        content: Buffer.from(JSON.stringify({
                            variables: {
                                group_id: jid,
                                input: {
                                    member_share_group_history_mode: enable ? "ALL_MEMBER_SHARE" : "ADMIN_SHARE"
                                }
                            }
                        }), "utf-8")
                    }
                ]
            });
            return result;
        },
        groupFetchAllParticipating
    };
};
export const extractGroupMetadata = (result) => {
    const group = getBinaryNodeChild(result, 'group');
    if (!group) {
        // Mirror WAWeb: surface server/client errors with their code+text instead of crashing.
        const errorNode = getBinaryNodeChild(result, 'error');
        if (errorNode) {
            const code = errorNode.attrs.code ? +errorNode.attrs.code : 500;
            const text = errorNode.attrs.text || 'group metadata query failed';
            throw new Boom(text, { statusCode: code, data: errorNode });
        }
        throw new Boom('Invalid group metadata response: missing <group> node', { data: result });
    }
    if (!group.attrs.id) {
        throw new Boom('Invalid group metadata response: missing group id', { data: group });
    }
    const descChild = getBinaryNodeChild(group, 'description');
    let desc;
    let descId;
    let descOwner;
    let descOwnerPn;
    let descOwnerUsername;
    let descTime;
    if (descChild) {
        desc = getBinaryNodeChildString(descChild, 'body');
        descOwner = descChild.attrs.participant ? jidNormalizedUser(descChild.attrs.participant) : undefined;
        descOwnerPn = descChild.attrs.participant_pn ? jidNormalizedUser(descChild.attrs.participant_pn) : undefined;
        descOwnerUsername = descChild.attrs.participant_username || undefined;
        descTime = +descChild.attrs.t;
        descId = descChild.attrs.id;
    }
    const groupId = group.attrs.id.includes('@') ? group.attrs.id : jidEncode(group.attrs.id, 'g.us');
    const eph = getBinaryNodeChild(group, 'ephemeral')?.attrs.expiration;
    const memberAddMode = getBinaryNodeChildString(group, 'member_add_mode') === 'all_member_add';
    const metadata = {
        id: groupId,
        notify: group.attrs.notify,
        addressingMode: group.attrs.addressing_mode === 'lid' ? WAMessageAddressingMode.LID : WAMessageAddressingMode.PN,
        subject: group.attrs.subject,
        subjectOwner: group.attrs.s_o,
        subjectOwnerPn: group.attrs.s_o_pn,
        subjectOwnerUsername: group.attrs.s_o_username,
        subjectTime: +group.attrs.s_t,
        size: group.attrs.size ? +group.attrs.size : getBinaryNodeChildren(group, 'participant').length,
        creation: +group.attrs.creation,
        owner: group.attrs.creator ? jidNormalizedUser(group.attrs.creator) : undefined,
        ownerPn: group.attrs.creator_pn ? jidNormalizedUser(group.attrs.creator_pn) : undefined,
        ownerUsername: group.attrs.creator_username || undefined,
        owner_country_code: group.attrs.creator_country_code,
        desc,
        descId,
        descOwner,
        descOwnerPn,
        descOwnerUsername,
        descTime,
        linkedParent: getBinaryNodeChild(group, 'linked_parent')?.attrs.jid || undefined,
        restrict: !!getBinaryNodeChild(group, 'locked'),
        announce: !!getBinaryNodeChild(group, 'announcement'),
        isCommunity: !!getBinaryNodeChild(group, 'parent'),
        isCommunityAnnounce: !!getBinaryNodeChild(group, 'default_sub_group'),
        joinApprovalMode: !!getBinaryNodeChild(group, 'membership_approval_mode'),
        memberAddMode,
        participants: getBinaryNodeChildren(group, 'participant').map(({ attrs }) => {
            // TODO: Store LID MAPPINGS
            return {
                id: attrs.jid,
                phoneNumber: isLidUser(attrs.jid) && isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
                lid: isPnUser(attrs.jid) && isLidUser(attrs.lid) ? attrs.lid : undefined,
                username: attrs.participant_username || attrs.username || undefined,
                admin: (attrs.type || null)
            };
        }),
        ephemeralDuration: eph ? +eph : undefined
    };
    return metadata;
};
//# sourceMappingURL=groups.js.map