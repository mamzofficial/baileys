/**
 * lib/Utils/adaptive-healing.js — connection-quality helpers.
 * `AdaptiveDelayManager` is a small backoff/cooldown timer (grows delay on
 * repeated errors, cools back down on success) for use around any retry
 * loop. `autoHealSession` is a targeted recovery step for the specific
 * "MAC error" / decryption-failure symptom of a desynced Signal session:
 * it just re-fetches the media connection info, nothing more invasive.
 */
export class AdaptiveDelayManager {
    constructor(options = {}) {
        this.baseDelay = options.baseDelay || 1200;
        this.maxDelay = options.maxDelay || 10000;
        this.currentDelay = this.baseDelay;
        this.consecutiveErrors = 0;
    }

    recordSuccess() {
        this.consecutiveErrors = 0;
        // Gradual cooldown back to base delay
        if (this.currentDelay > this.baseDelay) {
            this.currentDelay = Math.max(this.baseDelay, this.currentDelay - 200);
        }
    }

    recordError() {
        this.consecutiveErrors++;
        // Exponential backoff with ceiling
        this.currentDelay = Math.min(this.maxDelay, this.baseDelay * Math.pow(1.5, this.consecutiveErrors));
    }

    async wait() {
        const jitter = Math.random() * 300;
        const delayTime = Math.floor(this.currentDelay + jitter);
        await new Promise(resolve => setTimeout(resolve, delayTime));
    }
}

export async function autoHealSession(sock, error) {
    console.warn('[AutoHeal] Detecting session anomaly or MAC error:', error?.message || error);
    try {
        if (error?.output?.statusCode === 428 || error?.message?.includes('MAC') || error?.message?.includes('Decryption')) {
            console.log('[AutoHeal] Attempting automatic pre-key synchronization and session recovery...');
            if (typeof sock.refreshMediaConn === 'function') {
                await sock.refreshMediaConn(true);
            }
            console.log('[AutoHeal] Recovery sequence executed successfully.');
            return true;
        }
    } catch (healError) {
        console.error('[AutoHeal] Session healing failed:', healError);
    }
    return false;
}
