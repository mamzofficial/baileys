/**
 * lib/Utils/session-pool.js — optional helper for running several
 * makeWASocket sessions (e.g. several numbers) side by side, with
 * exponential-backoff-with-jitter reconnects. You provide `makeSocket`;
 * this only tracks sessions and calls it again after a disconnect unless
 * the account was logged out or you called `remove()`.
 */
const DISCONNECT_REASON_LOGGED_OUT = 401;
export const createSessionPool = (options) => {
    const logger = options.logger;
    const maxBackoffMs = options.maxBackoffMs ?? 60000;
    const sessions = new Map();
    const computeBackoffMs = attempts => {
        const base = Math.min(1000 * 2 ** attempts, maxBackoffMs);
        return base + Math.floor(Math.random() * (base * 0.2));
    };
    const start = async (sessionId) => {
        const entry = sessions.get(sessionId) || { attempts: 0, stopped: false };
        sessions.set(sessionId, entry);
        if (entry.stopped)
            return;
        try {
            const sock = await options.makeSocket(sessionId);
            entry.sock = sock;
            options.onSessionUpdate?.(sessionId, sock);
            sock.ev.on('connection.update', update => {
                if (update.connection === 'open') {
                    entry.attempts = 0;
                }
                if (update.connection === 'close') {
                    const statusCode = update.lastDisconnect?.error?.output?.statusCode;
                    if (statusCode === DISCONNECT_REASON_LOGGED_OUT) {
                        logger?.info?.({ sessionId }, 'session logged out, removing from pool');
                        sessions.delete(sessionId);
                        options.onLoggedOut?.(sessionId);
                        return;
                    }
                    if (entry.stopped)
                        return;
                    entry.attempts += 1;
                    const backoffMs = computeBackoffMs(entry.attempts);
                    logger?.warn?.({ sessionId, attempt: entry.attempts, backoffMs }, 'session disconnected, reconnecting with backoff');
                    setTimeout(() => start(sessionId), backoffMs);
                }
            });
        }
        catch (error) {
            entry.attempts += 1;
            const backoffMs = computeBackoffMs(entry.attempts);
            logger?.error?.({ error, sessionId, backoffMs }, 'failed to start session, retrying with backoff');
            if (!entry.stopped) {
                setTimeout(() => start(sessionId), backoffMs);
            }
        }
    };
    const add = sessionId => start(sessionId);
    const remove = sessionId => {
        const entry = sessions.get(sessionId);
        if (!entry)
            return;
        entry.stopped = true;
        if (entry.sock?.end) {
            try {
                entry.sock.end(undefined);
            }
            catch { }
        }
        sessions.delete(sessionId);
    };
    const get = sessionId => sessions.get(sessionId)?.sock;
    const list = () => [...sessions.keys()];
    return { add, remove, get, list };
};
