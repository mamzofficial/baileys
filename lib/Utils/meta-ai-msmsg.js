/**
 * lib/Utils/meta-ai-msmsg.js — decrypts the "msmsg" message envelope used
 * when a bot (e.g. Meta AI in a chat/group) sends a response. This envelope
 * is encrypted differently from normal 1:1/group messages (it's keyed off
 * a `messageSecret` your own earlier message carried, not the usual Signal
 * session), so it needs its own decrypt path — see decode-wa-message.js's
 * `case 'msmsg':` for where this gets called from.
 *
 * Ported (CommonJS -> ES modules only, logic unchanged) from a sibling
 * fork; wired in here because the previous behavior was to silently drop
 * every incoming msmsg message instead of decrypting it (see the removed
 * "TODO: temporary fix" block in messages-recv.js's handleMessage).
 */
import { aesDecryptGCM } from './crypto.js';
import { proto } from '../../WAProto/index.js';
import nodeCrypto from 'crypto';

// crypto.js's `hkdf` re-export (backed by the optional whatsapp-rust-bridge
// native addon) only accepts a *string* for its `info` option. msmsg
// decryption needs raw-byte `info`/`aad` (concatenated id + jid bytes), so
// this file uses its own small, standard RFC 5869 HKDF-HMAC-SHA256
// implementation instead — self-contained, doesn't touch or replace the
// native hkdf used anywhere else in the codebase.
const hkdfExtractJS = (salt, ikm) => nodeCrypto.createHmac('sha256', salt).update(ikm).digest();
const hkdfExpandJS = (prk, length, info) => {
    const hashLen = 32;
    const n = Math.ceil(length / hashLen);
    let t = Buffer.alloc(0);
    let okm = Buffer.alloc(0);
    for (let i = 1; i <= n; i++) {
        t = nodeCrypto.createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
        okm = Buffer.concat([okm, t]);
    }
    return okm.subarray(0, length);
};
const hkdf = (ikm, length, options = {}) => {
    const ikmBuf = Buffer.isBuffer(ikm) ? ikm : Buffer.from(ikm);
    const saltBuf = options.salt ? (Buffer.isBuffer(options.salt) ? options.salt : Buffer.from(options.salt)) : Buffer.alloc(32);
    const infoBuf = options.info ? (Buffer.isBuffer(options.info) ? options.info : Buffer.from(options.info)) : Buffer.alloc(0);
    const prk = hkdfExtractJS(saltBuf, ikmBuf);
    return hkdfExpandJS(prk, length, infoBuf);
};

const BOT_MESSAGE_INFO = 'Bot Message';
const KEY_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;
const MSG_ID_HEX_RE = /^[0-9A-Fa-f]{32}$/;

const unpadRandomMax16 = (value) => {
    const bytes = new Uint8Array(value);
    if (!bytes.length) {
        throw new Error('unpadPkcs7 given empty bytes');
    }
    const padLength = bytes[bytes.length - 1];
    if (padLength > bytes.length) {
        throw new Error(`unpad given ${bytes.length} bytes, but pad is ${padLength}`);
    }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length - padLength);
};

const toBuffer = (value) => {
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    return Buffer.from(value);
};

const normalizeLidJid = (jid) => {
    if (!jid || !jid.endsWith('@lid') || !jid.includes(':')) {
        return jid;
    }
    return `${jid.split(':')[0]}@lid`;
};

const buildMessageIdRepresentations = (messageId) => {
    const ascii = Buffer.from(messageId);
    const binary = MSG_ID_HEX_RE.test(messageId) ? Buffer.from(messageId, 'hex') : ascii;
    return [
        { label: 'msgIdAscii', value: ascii },
        ...(binary.equals(ascii) ? [] : [{ label: 'msgIdBinary', value: binary }])
    ];
};

const pushUnique = (items, seen, item) => {
    const key = JSON.stringify([
        item.messageId,
        item.idSource,
        item.idSources,
        item.infoSource,
        item.aadSource,
        item.info.toString('hex'),
        item.aad.toString('hex')
    ]);
    if (!seen.has(key)) {
        seen.add(key);
        items.push(item);
    }
};

const getCandidateIds = (messageKey) => {
    const orderedCandidates = [
        messageKey?.botType === 'full'
            ? { source: 'stanzaId', messageId: messageKey?.stanzaId }
            : { source: 'botEditTargetId', messageId: messageKey?.botEditTargetId },
        { source: 'targetId', messageId: messageKey?.targetId },
        { source: 'metaTargetId', messageId: messageKey?.metaTargetId },
        { source: 'stanzaId', messageId: messageKey?.stanzaId }
    ];
    const targetIdCandidates = Array.isArray(messageKey?.targetIdCandidates) ? messageKey.targetIdCandidates : [];
    for (let index = 0; index < targetIdCandidates.length; index += 1) {
        orderedCandidates.push({
            source: `targetIdCandidates[${index}]`,
            messageId: targetIdCandidates[index]
        });
    }
    const grouped = new Map();
    for (const candidate of orderedCandidates) {
        if (!candidate.messageId) {
            continue;
        }
        const messageId = String(candidate.messageId);
        const existing = grouped.get(messageId);
        if (existing) {
            if (!existing.idSources.includes(candidate.source)) {
                existing.idSources.push(candidate.source);
            }
        }
        else {
            grouped.set(messageId, {
                messageId,
                idSource: candidate.source,
                idSources: [candidate.source]
            });
        }
    }
    return Array.from(grouped.values());
};

const getJidCandidates = (messageKey) => {
    const ordered = [
        { source: 'meId', jid: messageKey?.meId },
        { source: 'conversationJid', jid: messageKey?.conversationJid },
        { source: 'senderJid', jid: messageKey?.senderJid },
        { source: 'meLidNormalized', jid: normalizeLidJid(messageKey?.meLid) }
    ];
    const seen = new Set();
    const candidates = [];
    for (const candidate of ordered) {
        if (!candidate.jid) {
            continue;
        }
        const jid = String(candidate.jid);
        if (!seen.has(jid)) {
            seen.add(jid);
            candidates.push({ source: candidate.source, jid, value: Buffer.from(jid) });
        }
    }
    return candidates;
};

const buildMsmsgDecryptionStrategies = (messageKey) => {
    const botJid = String(messageKey?.participant || '');
    const botJidBuffer = Buffer.from(botJid);
    const targetIds = getCandidateIds(messageKey);
    const jidCandidates = getJidCandidates(messageKey);
    const primaryJid = jidCandidates[0];
    const alternateJid = jidCandidates.find((candidate) => candidate.source !== primaryJid?.source && candidate.jid !== botJid);
    const strategies = [];
    const seen = new Set();
    for (const idCandidate of targetIds) {
        const idForms = buildMessageIdRepresentations(idCandidate.messageId);
        for (const idForm of idForms) {
            pushUnique(strategies, seen, {
                mode: '2step',
                idSource: idCandidate.idSource,
                idSources: idCandidate.idSources,
                infoSource: `${idForm.label}+meId+botJid`,
                aadSource: `${idForm.label}+0+botJid`,
                authTagLayout: 'trailing',
                messageId: idCandidate.messageId,
                info: Buffer.concat([idForm.value, primaryJid.value, botJidBuffer, Buffer.alloc(0)]),
                aad: Buffer.concat([idForm.value, Buffer.from([0]), botJidBuffer]),
                attemptLabel: `${idCandidate.idSource}:${idForm.label}:primary`
            });
            if (alternateJid) {
                pushUnique(strategies, seen, {
                    mode: '2step',
                    idSource: idCandidate.idSource,
                    idSources: idCandidate.idSources,
                    infoSource: `${idForm.label}+${alternateJid.source}+botJid`,
                    aadSource: `${idForm.label}+0+${alternateJid.source}`,
                    authTagLayout: 'trailing',
                    messageId: idCandidate.messageId,
                    info: Buffer.concat([idForm.value, alternateJid.value, botJidBuffer, Buffer.alloc(0)]),
                    aad: Buffer.concat([idForm.value, Buffer.from([0]), alternateJid.value]),
                    attemptLabel: `${idCandidate.idSource}:${idForm.label}:${alternateJid.source}`
                });
            }
        }
    }
    return strategies.slice(0, 12);
};

const assertRequired = (value, label) => {
    if (!value ||
        (Buffer.isBuffer(value) && value.length === 0) ||
        (value instanceof Uint8Array && value.byteLength === 0)) {
        throw new Error(`Missing required ${label} for msmsg decryption`);
    }
};

const decryptWithStrategy = (messageSecret, msMsg, strategy) => {
    const baseSecret = Buffer.from(hkdf(toBuffer(messageSecret), KEY_LENGTH, { info: BOT_MESSAGE_INFO }));
    const key = Buffer.from(hkdf(baseSecret, KEY_LENGTH, { info: strategy.info }));
    const payload = toBuffer(msMsg.encPayload);
    const ciphertextWithTag = Buffer.concat([payload.slice(0, -AUTH_TAG_LENGTH), payload.slice(-AUTH_TAG_LENGTH)]);
    return Buffer.from(aesDecryptGCM(ciphertextWithTag, key, toBuffer(msMsg.encIv), strategy.aad));
};

export const decodeDecryptedMsmsgMessage = (decrypted) => {
    const messageBuffer = toBuffer(decrypted);
    try {
        const unpadded = Buffer.from(unpadRandomMax16(messageBuffer));
        const decoded = proto.Message.decode(unpadded);
        const hasContent = Object.keys(decoded).some((key) => key !== 'messageContextInfo' && decoded[key] != null);
        if (hasContent) {
            return decoded;
        }
    }
    catch {
        // fall through to decoding the raw buffer below
    }
    return proto.Message.decode(messageBuffer);
};

export const decryptMsmsgBotMessage = async (messageSecret, messageKey, msMsg) => {
    assertRequired(messageSecret, 'messageSecret');
    assertRequired(messageKey?.participant, 'participant');
    assertRequired(messageKey?.meId, 'meId');
    assertRequired(msMsg?.encIv, 'encIv');
    assertRequired(msMsg?.encPayload, 'encPayload');
    if (getCandidateIds(messageKey).length === 0) {
        throw new Error('Missing required target message id for msmsg decryption');
    }
    const strategies = buildMsmsgDecryptionStrategies(messageKey);
    const attemptedStrategies = [];
    let lastError;
    for (const strategy of strategies) {
        const attempt = {
            idSource: strategy.idSource,
            idSources: strategy.idSources,
            infoSource: strategy.infoSource,
            aadSource: strategy.aadSource,
            messageId: strategy.messageId
        };
        try {
            return await decryptWithStrategy(messageSecret, msMsg, strategy);
        }
        catch (error) {
            attemptedStrategies.push(attempt);
            lastError = error;
        }
    }
    const error = new Error('Failed to decrypt msmsg with bounded deterministic strategies');
    error.attemptedStrategies = attemptedStrategies;
    error.cause = lastError;
    throw error;
};
