/**
 * lib/Socket/privacy.js — account privacy settings, text status, trusted
 * devices, linked profiles, etc. All calls act on YOUR OWN connected
 * account via WhatsApp's standard 'w:mex' query mechanism (same transport
 * newsletter.js and other Socket modules already use) — nothing here reads
 * or modifies another user's data.
 */
import { executeWMexQuery } from './mex.js';
const PRIVACY_MEX_IDS = {
    GET_SETTINGS: '32774292262215380',
    SET_SETTING: '26887749497493184',
    UPDATE_CONTACT_LIST: '26375158178762800',
    GET_CONTACT_LIST: '25700444246275824',
    UPDATE_TEXT_STATUS: '25863197129975892',
    GET_TEXT_STATUS_LIST: '25741205615468936',
    UPDATE_USER_STATUS: '7452341274886724',
    FETCH_USER_PICTURE: '24983561624604410',
    PROFILE_PICTURE_MUTATION: '24714239711610700',
    ACCOUNT_LOGIN: '27298465499757130',
    ACCOUNT_LOGOUT: '26863447609979190',
    MULTI_ACCOUNT_REVOKE: '25846242091639660',
    ADD_MULTI_ACCOUNT_LINK: '25502812266025190',
    ADD_TRUSTED_DEVICE: '24522952587403290',
    GET_TRUSTED_DEVICES: '25123358920671964',
    UNTRUST_TRUSTED_DEVICE: '26574930682133620',
    DELETE_TRUSTED_DEVICE: '33867503889559536',
    MOBILE_CONFIG_FETCH: '25676911271914596',
    NOTIFY_PUSH_NAME: '25900490552974544',
    CONTACT_INTEGRITY: '25924358997169496',
    BIZ_INTEGRITY: '25975613018777536',
    LINKED_PROFILES_SET: '25013968611531010',
    LINKED_PROFILES_REMOVE: '24537675509265524',
    LINKED_PROFILES_UPDATE: '24876967165297616',
    MIGRATE_BLOCKLIST_LID: '25028600226770430',
    QR_CODE_SCAN: '26287165600869744'
};
export const makePrivacySocket = (sock) => {
    const { query, generateMessageTag } = sock;
    const mexQuery = (variables, queryId, dataPath) => executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag);
    const getPrivacySettings = (jid, features = null) => {
        const users = [{ jid, ...(features ? { privacy_features: features } : {}) }];
        return mexQuery({ users }, PRIVACY_MEX_IDS.GET_SETTINGS, 'xwa2_fetch_wa_users');
    };
    const setPrivacySetting = (feature, setting) => mexQuery({ feature, setting }, PRIVACY_MEX_IDS.SET_SETTING, 'xwa2_privacy_feature_update');
    const updatePrivacyContactList = (feature, setting, jids) => mexQuery({ feature, setting, contacts: jids.map(jid => ({ jid })) }, PRIVACY_MEX_IDS.UPDATE_CONTACT_LIST, 'xwa2_privacy_contact_list_update');
    const getPrivacyContactList = (feature, setting) => mexQuery({ feature, setting }, PRIVACY_MEX_IDS.GET_CONTACT_LIST, 'xwa2_privacy_contact_list');
    const updateTextStatus = (text, emoji = null) => {
        const input = { text };
        if (emoji)
            input.emoji = { content: emoji };
        return mexQuery({ text_status_input: input }, PRIVACY_MEX_IDS.UPDATE_TEXT_STATUS, 'xwa2_text_status_update');
    };
    const getTextStatusList = (jids, lastUpdateTime = null) => {
        const input = jids.map(jid => ({ jid, last_update_time: lastUpdateTime }));
        return mexQuery({ input }, PRIVACY_MEX_IDS.GET_TEXT_STATUS_LIST, 'xwa2_text_status_list');
    };
    const updateUserStatus = status => mexQuery({ status }, PRIVACY_MEX_IDS.UPDATE_USER_STATUS, 'xwa2_update_user_status');
    const fetchUserPictureInfo = jid => mexQuery({ jid }, PRIVACY_MEX_IDS.FETCH_USER_PICTURE, 'xwa2_fetch_user_picture_info');
    const setProfilePictureMex = (imageBase64, type = 'image') => mexQuery({ input: { image: imageBase64, type } }, PRIVACY_MEX_IDS.PROFILE_PICTURE_MUTATION, 'xwa2_profile_picture_mutation');
    const accountLogin = phoneNumber => mexQuery({ input: { phone_number: phoneNumber } }, PRIVACY_MEX_IDS.ACCOUNT_LOGIN, 'xwa2_account_login');
    const accountLogout = (phoneNumber, enabledBiometric = false) => mexQuery({ input: { phone_number: phoneNumber, enabled_biometric: enabledBiometric } }, PRIVACY_MEX_IDS.ACCOUNT_LOGOUT, 'xwa2_account_logout');
    const addMultiAccountLink = phoneNumber => mexQuery({ input: { phone_number: phoneNumber } }, PRIVACY_MEX_IDS.ADD_MULTI_ACCOUNT_LINK, 'xwa2_add_multi_account_link');
    const addTrustedDevice = (deviceId, deviceName) => mexQuery({ device_id: deviceId, device_name: deviceName }, PRIVACY_MEX_IDS.ADD_TRUSTED_DEVICE, 'xwa2_add_trusted_device');
    const getTrustedDevices = () => mexQuery({}, PRIVACY_MEX_IDS.GET_TRUSTED_DEVICES, 'xwa2_get_trusted_devices');
    const untrustTrustedDevice = (deviceId, reason = 'USER_INITIATED') => mexQuery({ device_id: deviceId, reason }, PRIVACY_MEX_IDS.UNTRUST_TRUSTED_DEVICE, 'xwa2_untrust_trusted_device');
    const deleteTrustedDevice = deviceId => mexQuery({ device_id: deviceId }, PRIVACY_MEX_IDS.DELETE_TRUSTED_DEVICE, 'xwa2_delete_trusted_device');
    const revokeMultiAccount = accountJid => mexQuery({ account_jid: accountJid }, PRIVACY_MEX_IDS.MULTI_ACCOUNT_REVOKE, 'xwa2_multi_account_revoke');
    const fetchMobileConfig = (apiVersion = 0, epRefreshId = 0, flags = '') => mexQuery({ api_version: apiVersion, ep_refresh_id: epRefreshId, flags }, PRIVACY_MEX_IDS.MOBILE_CONFIG_FETCH, 'xwa2_mobile_config_fetch');
    const notifyPushName = (groupJid, participants) => mexQuery({
        input: {
            group_jid: groupJid,
            participants: participants.map(({ jid, pushName }) => ({ jid, push_name: pushName }))
        }
    }, PRIVACY_MEX_IDS.NOTIFY_PUSH_NAME, 'xwa2_notify_push_name');
    const contactIntegrityQuery = (jids, useCase = 'START_CHAT_CONTEXT') => mexQuery({ users: jids.map(jid => ({ jid })), use_case: useCase }, PRIVACY_MEX_IDS.CONTACT_INTEGRITY, 'xwa2_fetch_wa_users');
    const bizIntegrityQuery = jids => mexQuery({ users: jids.map(jid => ({ jid })) }, PRIVACY_MEX_IDS.BIZ_INTEGRITY, 'xwa2_fetch_wa_users');
    const linkedProfilesSet = profiles => {
        const mapped = profiles.map(p => {
            const entry = { type: p.type };
            if (p.vid)
                entry.vid = p.vid;
            else if (p.username)
                entry.username = p.username;
            return entry;
        });
        return mexQuery({ profiles: mapped }, PRIVACY_MEX_IDS.LINKED_PROFILES_SET, 'xwa2_linked_profiles_set');
    };
    const linkedProfilesRemove = types => mexQuery({ profiles: types.map(type => ({ type })) }, PRIVACY_MEX_IDS.LINKED_PROFILES_REMOVE, 'xwa2_linked_profiles_remove');
    const linkedProfilesUpdate = profiles => mexQuery({ profiles: profiles.map(({ type, showOnProfile }) => ({ type, show_on_profile: showOnProfile })) }, PRIVACY_MEX_IDS.LINKED_PROFILES_UPDATE, 'xwa2_linked_profiles_update');
    const migrateBlocklistLid = (jids, dhash = '', dirtyAck = true) => mexQuery({
        input: {
            blocklist: jids.map(jid => ({ jid })),
            dhash,
            dirty_ack: dirtyAck
        }
    }, PRIVACY_MEX_IDS.MIGRATE_BLOCKLIST_LID, 'xwa2_migrate_blocklist_lid');
    const qrCodeScan = qrData => mexQuery({ qr_data: qrData }, PRIVACY_MEX_IDS.QR_CODE_SCAN, 'xwa2_qr_code_scan');
    return {
        ...sock,
        getPrivacySettings,
        setPrivacySetting,
        updatePrivacyContactList,
        getPrivacyContactList,
        updateTextStatus,
        getTextStatusList,
        updateUserStatus,
        fetchUserPictureInfo,
        setProfilePictureMex,
        accountLogin,
        accountLogout,
        addMultiAccountLink,
        addTrustedDevice,
        getTrustedDevices,
        untrustTrustedDevice,
        deleteTrustedDevice,
        revokeMultiAccount,
        fetchMobileConfig,
        notifyPushName,
        contactIntegrityQuery,
        bizIntegrityQuery,
        linkedProfilesSet,
        linkedProfilesRemove,
        linkedProfilesUpdate,
        migrateBlocklistLid,
        qrCodeScan,
        PRIVACY_MEX_IDS
    };
};
