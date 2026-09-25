/**
 * lib/Socket/managed-account.js — account-linking/sponsorship, PIN, and
 * WhatsApp Payments passkey flows. Every call acts on your own account via
 * the standard mex query mechanism; nothing here targets other users.
 */
import { executeWMexQuery } from './mex.js';
const MANAGED_ACCOUNT_MEX_IDS = {
    QUERY: '27232244463035264',
    INITIATE_LINKING: '26671873552498548',
    VALIDATE_LINKING: '35449808311284430',
    ACCEPT_LINKING: '26708926155457676',
    COMPLETE_LINKING: '26866501363013204',
    REVOKE_LINKING: '27435058196100676',
    SYNC_ACTIVITIES: '26594352680227840',
    UPDATE_PIN: '27653949584193080',
    GET_SPONSOR_AGE_VERIFICATION: '26433623289634520',
    PAYMENTS_PASSKEY_HAS_CREDENTIAL: '26328228500182424',
    PAYMENTS_PASSKEY_ENROLL_CHALLENGE: '25233109079721000',
    PAYMENTS_PASSKEY_ENROLL_VERIFY: '26563835863283056',
    PAYMENTS_PASSKEY_REGISTER_FINISH: '26658791263822236',
    PAYMENTS_PASSKEY_AUTH_CHALLENGE: '26425370627105628',
    PAYMENTS_PASSKEY_TOGGLE_ON: '25841989828834576',
    PAYMENTS_PASSKEY_TOGGLE_OFF: '26267673096201390',
    PAYMENTS_PASSKEY_TOGGLE_CHALLENGE: '26133062322993190',
    PAYMENTS_PASSKEY_TOGGLE_CLEANUP: '26492078607084840',
    PAYMENTS_PASSKEY_CLEANUP: '26538338805859092',
    PAYMENTS_IS_RECOVERABLE: '26524118810513490',
    UPI_SEND_OTP: '25829794080022468',
    UPI_VERIFY_OTP: '34104109149204668',
    IPLS_HANDSHAKE_INIT: '25523747957257184',
    IPLS_CLIENT_HELLO: '25376330595367716',
    IPLSD_CLIENT_HELLO_V2: '26561780580105680',
    IPLSD_CLIENT_INIT_V2: '26547193874915344'
};
export const makeManagedAccountSocket = (sock) => {
    const { query, generateMessageTag } = sock;
    const mexQuery = (variables, queryId, dataPath) => executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag);
    const managedAccountQuery = jid => mexQuery({ jid }, MANAGED_ACCOUNT_MEX_IDS.QUERY, 'xwa2_managed_account');
    const managedAccountInitiateLinking = phoneNumber => mexQuery({ phone_number: phoneNumber }, MANAGED_ACCOUNT_MEX_IDS.INITIATE_LINKING, 'xwa2_managed_account_initiate_linking');
    const managedAccountValidateLinking = (linkingToken, sponsorJid) => mexQuery({ linking_token: linkingToken, sponsor_jid: sponsorJid }, MANAGED_ACCOUNT_MEX_IDS.VALIDATE_LINKING, 'xwa2_managed_account_validate_linking');
    const managedAccountAcceptLinking = linkingToken => mexQuery({ linking_token: linkingToken }, MANAGED_ACCOUNT_MEX_IDS.ACCEPT_LINKING, 'xwa2_managed_account_accept_linking');
    const managedAccountCompleteLinking = linkingToken => mexQuery({ linking_token: linkingToken }, MANAGED_ACCOUNT_MEX_IDS.COMPLETE_LINKING, 'xwa2_managed_account_complete_linking');
    const managedAccountRevokeLinking = sponsoredJid => mexQuery({ sponsored_jid: sponsoredJid }, MANAGED_ACCOUNT_MEX_IDS.REVOKE_LINKING, 'xwa2_managed_account_revoke_linking');
    const managedAccountSyncActivities = (jid, lastSyncTime = null) => {
        const variables = { jid };
        if (lastSyncTime != null)
            variables.last_sync_time = lastSyncTime;
        return mexQuery(variables, MANAGED_ACCOUNT_MEX_IDS.SYNC_ACTIVITIES, 'xwa2_managed_account_sync_activities');
    };
    const managedAccountUpdatePin = (oldPin, newPin) => mexQuery({ input: { old_pin: oldPin, new_pin: newPin } }, MANAGED_ACCOUNT_MEX_IDS.UPDATE_PIN, 'xwa2_managed_account_update_pin');
    const managedAccountGetSponsorAgeVerification = sponsorJid => mexQuery({ sponsor_jid: sponsorJid }, MANAGED_ACCOUNT_MEX_IDS.GET_SPONSOR_AGE_VERIFICATION, 'xwa2_managed_account_sponsor_age_verification');
    const paymentsPasskeyHasCredential = () => mexQuery({}, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_HAS_CREDENTIAL, 'xwa2_payments_passkey_has_credential');
    const paymentsPasskeyEnrollChallenge = () => mexQuery({}, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_ENROLL_CHALLENGE, 'xwa2_payments_passkey_enroll_challenge');
    const paymentsPasskeyEnrollVerify = (credentialId, attestationObject, clientDataJson) => mexQuery({ credential_id: credentialId, attestation_object: attestationObject, client_data_json: clientDataJson }, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_ENROLL_VERIFY, 'xwa2_payments_passkey_enroll_verify');
    const paymentsPasskeyRegisterFinish = (credentialId, attestationObject, clientDataJson) => mexQuery({ credential_id: credentialId, attestation_object: attestationObject, client_data_json: clientDataJson }, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_REGISTER_FINISH, 'xwa2_payments_passkey_register_finish');
    const paymentsPasskeyAuthChallenge = credentialId => mexQuery({ credential_id: credentialId }, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_AUTH_CHALLENGE, 'xwa2_payments_passkey_auth_challenge');
    const paymentsPasskeyToggleOn = () => mexQuery({}, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_TOGGLE_ON, 'xwa2_payments_passkey_toggle_on');
    const paymentsPasskeyToggleOff = () => mexQuery({}, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_TOGGLE_OFF, 'xwa2_payments_passkey_toggle_off');
    const paymentsPasskeyToggleChallenge = credentialId => mexQuery({ credential_id: credentialId }, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_TOGGLE_CHALLENGE, 'xwa2_payments_passkey_toggle_challenge');
    const paymentsPasskeyToggleCleanup = () => mexQuery({}, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_TOGGLE_CLEANUP, 'xwa2_payments_passkey_toggle_cleanup');
    const paymentsPasskeyCleanup = () => mexQuery({}, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_CLEANUP, 'xwa2_payments_passkey_cleanup');
    const paymentsIsAccountRecoverable = () => mexQuery({}, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_IS_RECOVERABLE, 'xwa2_payments_is_account_recoverable');
    const upiSendOtp = phoneNumber => mexQuery({ phone_number: phoneNumber }, MANAGED_ACCOUNT_MEX_IDS.UPI_SEND_OTP, 'xwa2_upi_send_otp');
    const upiVerifyOtp = (phoneNumber, otp) => mexQuery({ phone_number: phoneNumber, otp }, MANAGED_ACCOUNT_MEX_IDS.UPI_VERIFY_OTP, 'xwa2_upi_verify_otp');
    const iplsHandshakeInit = payload => mexQuery({ payload }, MANAGED_ACCOUNT_MEX_IDS.IPLS_HANDSHAKE_INIT, 'xwa2_ipls_handshake_init');
    const iplsClientHello = payload => mexQuery({ payload }, MANAGED_ACCOUNT_MEX_IDS.IPLS_CLIENT_HELLO, 'xwa2_ipls_client_hello');
    const iplsdClientHelloV2 = payload => mexQuery({ payload }, MANAGED_ACCOUNT_MEX_IDS.IPLSD_CLIENT_HELLO_V2, 'xwa2_iplsd_client_hello_v2');
    const iplsdClientInitV2 = payload => mexQuery({ payload }, MANAGED_ACCOUNT_MEX_IDS.IPLSD_CLIENT_INIT_V2, 'xwa2_iplsd_client_init_v2');
    return {
        ...sock,
        managedAccountQuery,
        managedAccountInitiateLinking,
        managedAccountValidateLinking,
        managedAccountAcceptLinking,
        managedAccountCompleteLinking,
        managedAccountRevokeLinking,
        managedAccountSyncActivities,
        managedAccountUpdatePin,
        managedAccountGetSponsorAgeVerification,
        paymentsPasskeyHasCredential,
        paymentsPasskeyEnrollChallenge,
        paymentsPasskeyEnrollVerify,
        paymentsPasskeyRegisterFinish,
        paymentsPasskeyAuthChallenge,
        paymentsPasskeyToggleOn,
        paymentsPasskeyToggleOff,
        paymentsPasskeyToggleChallenge,
        paymentsPasskeyToggleCleanup,
        paymentsPasskeyCleanup,
        paymentsIsAccountRecoverable,
        upiSendOtp,
        upiVerifyOtp,
        iplsHandshakeInit,
        iplsClientHello,
        iplsdClientHelloV2,
        iplsdClientInitV2,
        MANAGED_ACCOUNT_MEX_IDS
    };
};
