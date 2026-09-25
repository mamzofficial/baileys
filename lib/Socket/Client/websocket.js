import WebSocket from 'ws';
import { DEFAULT_ORIGIN } from '../../Defaults/index.js';
import { AbstractSocketClient } from './types.js';
export class WebSocketClient extends AbstractSocketClient {
    constructor() {
        super(...arguments);
        this.socket = null;
    }
    get isOpen() {
        return this.socket?.readyState === WebSocket.OPEN;
    }
    get isClosed() {
        return this.socket === null || this.socket?.readyState === WebSocket.CLOSED;
    }
    get isClosing() {
        return this.socket === null || this.socket?.readyState === WebSocket.CLOSING;
    }
    get isConnecting() {
        return this.socket?.readyState === WebSocket.CONNECTING;
    }
    connect() {
        if (this.socket) {
            return;
        }
        
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': '*/*',
            'DNT': '1',
            'Pragma': 'no-cache',
            'Cache-Control': 'no-cache',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-GPC': '1',
            ...this.config.options?.headers
        };

        this.socket = new WebSocket(this.url, {
            origin: DEFAULT_ORIGIN,
            headers: headers,
            handshakeTimeout: this.config.connectTimeoutMs || 30000,
            timeout: this.config.connectTimeoutMs || 30000,
            agent: this.config.agent,
            perMessageDeflate: false,
            maxPayload: 100 * 1024 * 1024,
            rejectUnauthorized: false,
            keepalive: true,
            keepaliveInterval: 25000
        });
        
        this.socket.setMaxListeners(0);
        
        this.socket.on('error', (error) => {
            const errorCode = error?.code;
            if (errorCode === 'ECONNREFUSED' || errorCode === 'ENOTFOUND') {
                console.warn('WebSocket connection refused, retrying...');
            }
        });

        // The underlying `ws` library does NOT automatically close/error the
        // connection when the server rejects the handshake with a non-101 HTTP
        // response (e.g. a 403/429/edge block) — it only emits
        // 'unexpected-response' and otherwise leaves things dangling. Without
        // this listener, nothing ever calls back an 'error' or 'close' for
        // that case, so anything awaiting the connection (waitForSocketOpen,
        // requestPairingCode, the initial login flow, etc.) would hang
        // indefinitely instead of failing with a clear, catchable error.
        this.socket.on('unexpected-response', (request, response) => {
            const statusCode = response?.statusCode;
            const denyReason = response?.headers?.['x-deny-reason'];
            const message = `WebSocket handshake rejected by server (HTTP ${statusCode ?? 'unknown'}${denyReason ? `, reason: ${denyReason}` : ''})`;
            request?.destroy?.();
            const err = new Error(message);
            err.statusCode = statusCode;
            this.emit('error', err);
        });

        const events = ['close', 'error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response'];
        for (const event of events) {
            this.socket?.on(event, (...args) => this.emit(event, ...args));
        }
    }
    async close() {
        if (!this.socket) {
            return;
        }
        const closePromise = new Promise(resolve => {
            this.socket?.once('close', resolve);
        });
        this.socket.close();
        await closePromise;
        this.socket = null;
    }
    send(str, cb) {
        this.socket?.send(str, cb);
        return Boolean(this.socket);
    }
}
//# sourceMappingURL=websocket.js.map
