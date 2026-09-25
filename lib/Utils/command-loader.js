/**
 * lib/Utils/command-loader.js — optional, opt-in "!command" style handler.
 * Loads command modules from a local folder you point it at (each module
 * exports { name, aliases?, execute(ctx) }) and dispatches incoming text
 * messages that start with your chosen prefix to the matching command.
 * Does nothing unless you call this yourself with a real `commandsDir`.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * @param sock A connected socket (needs `sock.ev`, optionally `sock.logger`).
 * @param options.commandsDir Folder containing your command modules.
 * @param options.prefix Command prefix, default '!'.
 * @param options.logger Optional logger override.
 * @param options.onError Optional (error, msg) => void override for failures.
 */
export const createCommandHandler = (sock, options) => {
    const prefix = options.prefix ?? '!';
    const logger = options.logger || sock.logger;
    const commands = new Map();
    const load = () => {
        commands.clear();
        const dir = options.commandsDir;
        if (!fs.existsSync(dir)) {
            logger?.warn?.({ dir }, 'commands directory does not exist');
            return;
        }
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
        for (const file of files) {
            const fullPath = path.join(dir, file);
            try {
                delete require.cache[require.resolve(fullPath)];
                const mod = require(fullPath);
                const cmd = mod?.default || mod;
                if (!cmd?.name || typeof cmd.execute !== 'function') {
                    logger?.warn?.({ file }, 'skipping invalid command module (missing name/execute)');
                    continue;
                }
                commands.set(cmd.name.toLowerCase(), cmd);
                for (const alias of cmd.aliases || []) {
                    commands.set(alias.toLowerCase(), cmd);
                }
            }
            catch (error) {
                logger?.error?.({ error, file }, 'failed to load command');
            }
        }
        logger?.debug?.({ count: commands.size }, 'commands loaded');
    };
    load();
    const handler = async ({ messages, type }) => {
        if (type !== 'notify') {
            return;
        }
        for (const msg of messages) {
            try {
                if (!msg.message || msg.key.fromMe) {
                    continue;
                }
                const body = msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption ||
                    '';
                if (!body.startsWith(prefix)) {
                    continue;
                }
                const [cmdName, ...args] = body.slice(prefix.length).trim().split(/\s+/);
                if (!cmdName) {
                    continue;
                }
                const cmd = commands.get(cmdName.toLowerCase());
                if (!cmd) {
                    continue;
                }
                const jid = msg.key.remoteJid;
                const ctx = {
                    sock,
                    msg,
                    args,
                    text: args.join(' '),
                    jid,
                    sender: msg.key.participant || msg.key.remoteJid,
                    isGroup: !!jid && jid.endsWith('@g.us')
                };
                await cmd.execute(ctx);
            }
            catch (error) {
                if (options.onError) {
                    options.onError(error, msg);
                }
                else {
                    logger?.error?.({ error }, 'command execution failed');
                }
            }
        }
    };
    sock.ev.on('messages.upsert', handler);
    return {
        commands,
        reload: load,
        stop: () => sock.ev.off('messages.upsert', handler)
    };
};
