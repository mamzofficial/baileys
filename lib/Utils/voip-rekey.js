/**
 * lib/Utils/voip-rekey.js — decode the E2E rekey payload WhatsApp sends to
 * rotate call/media encryption keys during a VOIP call. Pure protobuf
 * decode, no network or crypto side effects of its own.
 */
import { proto } from '../../WAProto/index.js';

const REKEY_TYPE_NAMES = {
    [proto.RekeyKeyType.REKEY_KEY_AUDIO]: 'REKEY_KEY_AUDIO',
    [proto.RekeyKeyType.REKEY_KEY_VIDEO]: 'REKEY_KEY_VIDEO',
    [proto.RekeyKeyType.REKEY_KEY_APPDATA]: 'REKEY_KEY_APPDATA'
};

export const decodeE2eRekeyPayload = (buffer) => {
    if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
        throw new TypeError('decodeE2eRekeyPayload: buffer must be Buffer or Uint8Array');
    }
    const decoded = proto.E2eRekeyPayload.decode(buffer);
    return {
        keys: (decoded.keys || []).map((entry) => ({
            type: REKEY_TYPE_NAMES[entry.type] ?? entry.type,
            key: entry.key ? Buffer.from(entry.key) : Buffer.alloc(0)
        }))
    };
};
