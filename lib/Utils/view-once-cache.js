/**
 * lib/Utils/view-once-cache.js — opt-in helper that saves view-once media
 * (photos/videos/voice notes that WhatsApp normally lets you open only
 * once) to a local folder as it comes in, before it disappears. You call
 * this explicitly with a folder to use; it does nothing unless you wire it
 * up yourself, and everything stays on your own disk.
 */
import path from 'path';
import fs from 'fs';
import { downloadMediaMessage, extractMessageContent } from './messages.js';
import { extensionForMediaMessage } from './messages-media.js';

const VIEW_ONCE_WRAPPER_KEYS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
const VIEW_ONCE_INNER_KEYS = ['imageMessage', 'videoMessage', 'audioMessage'];

export const getViewOnceContent = (message) => {
    if (!message) {
        return null;
    }
    const content = extractMessageContent(message);
    if (!content) {
        return null;
    }
    for (const wrapperKey of VIEW_ONCE_WRAPPER_KEYS) {
        const wrapper = content[wrapperKey];
        if (wrapper?.message) {
            const inner = extractMessageContent(wrapper.message);
            if (inner) {
                return inner;
            }
        }
    }
    for (const key of VIEW_ONCE_INNER_KEYS) {
        if (content[key]?.viewOnce) {
            return { [key]: content[key] };
        }
    }
    return null;
};

/**
 * @param sock A connected socket (needs `sock.ev`, `sock.logger`, `sock.updateMediaMessage`).
 * @param options.cacheDir Folder to save into (default './viewonce-cache').
 * @param options.onCached Optional callback fired after each successful save.
 * @returns a function that unregisters the listener when called.
 */
export const autoCacheViewOnceMedia = (sock, options = {}) => {
    const cacheDir = options.cacheDir || './viewonce-cache';
    const logger = options.logger || sock.logger;
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    const handler = async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') {
            return;
        }
        for (const msg of messages) {
            try {
                const viewOnceContent = getViewOnceContent(msg.message);
                if (!viewOnceContent) {
                    continue;
                }
                const mediaType = Object.keys(viewOnceContent)[0];
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
                const extension = extensionForMediaMessage(viewOnceContent) || 'bin';
                const fileName = `${msg.key.id}.${extension}`;
                const filePath = path.join(cacheDir, fileName);
                fs.writeFileSync(filePath, buffer);
                logger?.debug?.({ id: msg.key.id, filePath, mediaType }, 'cached view-once media');
                options.onCached?.({ id: msg.key.id, jid: msg.key.remoteJid, filePath, type: mediaType });
            }
            catch (error) {
                logger?.warn?.({ error, id: msg.key?.id }, 'failed to cache view-once media');
            }
        }
    };
    sock.ev.on('messages.upsert', handler);
    return () => sock.ev.off('messages.upsert', handler);
};
