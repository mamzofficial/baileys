/**
 * lib/Socket/text-router.js — optional `sock.onText`/`sock.hears`/`sock.command`
 * helpers for routing incoming text messages to handlers by pattern, so you
 * don't have to hand-write the same messages.upsert-and-regex-match loop
 * yourself. Purely in-process; adds no network calls.
 */
const extractText = message => {
    if (!message)
        return '';
    return (message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        '');
};
const escapeRegExp = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const attachTextRouter = (sock) => {
    const routes = [];
    const addRoute = (pattern, handler) => {
        const route = { pattern, handler };
        routes.push(route);
        return () => {
            const idx = routes.indexOf(route);
            if (idx !== -1)
                routes.splice(idx, 1);
        };
    };
    const dispatch = async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append')
            return;
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe)
                continue;
            const text = extractText(msg.message);
            if (!text)
                continue;
            for (const route of routes.slice()) {
                let match = null;
                if (route.pattern instanceof RegExp) {
                    route.pattern.lastIndex = 0;
                    match = route.pattern.exec(text);
                }
                else if (typeof route.pattern === 'string') {
                    match = text === route.pattern ? [text] : null;
                }
                if (!match)
                    continue;
                try {
                    await route.handler(msg, match);
                }
                catch (error) {
                    sock.logger?.error?.({ error, text }, 'onText/hears handler threw');
                }
            }
        }
    };
    sock.ev.on('messages.upsert', dispatch);
    sock.onText = addRoute;
    sock.hears = addRoute;
    sock.command = (name, handler) => {
        const names = (Array.isArray(name) ? name : [name]).map(escapeRegExp);
        const pattern = new RegExp(`^/(?:${names.join('|')})(?:@\\S+)?(?:\\s+([\\s\\S]*))?$`, 'i');
        return addRoute(pattern, handler);
    };
    return sock;
};
