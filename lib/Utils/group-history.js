/**
 * lib/Utils/group-history.js — decode WhatsApp's "group history" payload
 * (the zlib-compressed bundle sent when a group's shared history sync
 * happens). Pure protobuf decode + optional inflate, no network calls.
 */
import { inflateSync } from 'zlib';
import { proto } from '../../WAProto/index.js';

export const decodeGroupHistory = (buffer, options = {}) => {
    const { inflate = true, withMessageBytes = false } = options;
    if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
        throw new TypeError('decodeGroupHistory: buffer must be Buffer or Uint8Array');
    }
    let data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (inflate) {
        try {
            data = inflateSync(data);
        }
        catch {
            // not actually deflated — fall through and try decoding as-is
        }
    }
    if (withMessageBytes) {
        const decoded = proto.GroupHistoryWithMessageBytes.decode(data);
        const expand = (list) => (list || []).map((entry) => entry?.messageBytes ? proto.WebMessageInfo.decode(entry.messageBytes) : { key: entry?.key });
        return {
            messages: expand(decoded.messages),
            commentMessages: expand(decoded.commentMessages),
            outOfWindowPinnedMessages: expand(decoded.outOfWindowPinnedMessages),
            uncountedAssociatedMessageLists: (decoded.uncountedAssociatedMessageLists || []).map((l) => ({
                parentMessage: l.parentMessage,
                messages: expand(l.messages)
            }))
        };
    }
    return proto.GroupHistory.decode(data);
};

export const processGroupHistory = (groupHistory) => {
    const gh = groupHistory || {};
    return {
        messages: gh.messages || [],
        commentMessages: gh.commentMessages || [],
        outOfWindowPinnedMessages: gh.outOfWindowPinnedMessages || [],
        uncountedAssociatedMessageLists: gh.uncountedAssociatedMessageLists || []
    };
};
