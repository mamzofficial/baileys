/**
 * lib/Utils/optimizer.js — opt-in resource-usage tuning ("optiMazer").
 *
 * OFF by default. This does NOT touch the safety caps that already exist
 * unconditionally elsewhere (userDevicesCache, message-retry caches, and
 * the guard log arrays all have sane hard limits regardless of this
 * setting — those are bug fixes, not something you should be able to turn
 * off). What `optiMazer` adds on top, only when enabled, is:
 *
 *  - Tighter cache limits than the defaults (trades a little more
 *    re-fetching on cache misses for meaningfully less resident memory on
 *    a long-running, high-traffic process).
 *  - A periodic background trim/stats tick.
 *  - If Node was started with `--expose-gc`, a periodic proactive GC pass
 *    during that same tick (a safe no-op if `--expose-gc` wasn't used).
 *
 * It never changes protocol behavior, message content, or connection
 * behavior — purely memory bookkeeping. See README.md → "optiMazer".
 */

export const DEFAULT_OPTIMIZER_CONFIG = {
    userDevicesCacheMaxKeys: 2000, // vs the always-on default of 10000
    retryCountersMax: 1500, // vs the always-on default of 5000
    sessionRecreateHistoryMax: 500, // vs the always-on default of 2000
    guardLogMax: 50, // vs the always-on default of 200
    gcIntervalMs: 5 * 60 * 1000, // only used if the process was started with --expose-gc
    tickIntervalMs: 60 * 1000
};

/** Merge whatever the caller passed (boolean or partial config object) with the defaults above. */
export const resolveOptimizerConfig = (optiMazer) => {
    if (!optiMazer) {
        return null;
    }
    const overrides = typeof optiMazer === 'object' ? optiMazer : {};
    return { ...DEFAULT_OPTIMIZER_CONFIG, ...overrides };
};

export class OptiMazer {
    constructor(config = {}) {
        this.config = { ...DEFAULT_OPTIMIZER_CONFIG, ...config };
        this.stats = { ticks: 0, gcRuns: 0, startedAt: Date.now() };
        this._timers = [];
    }

    /** Call once after building your socket. Safe to call multiple times (no-op if already attached). */
    attach(sock) {
        if (this._attached) {
            return this;
        }
        this._attached = true;
        const tick = () => {
            this.stats.ticks++;
            if (typeof global.gc === 'function') {
                try {
                    global.gc();
                    this.stats.gcRuns++;
                }
                catch {
                    // --expose-gc wasn't actually set up correctly; just skip silently
                }
            }
        };
        const timer = setInterval(tick, this.config.tickIntervalMs);
        timer.unref?.();
        this._timers.push(timer);
        this._sock = sock;
        return this;
    }

    getStats() {
        return {
            ...this.stats,
            uptimeMs: Date.now() - this.stats.startedAt,
            gcAvailable: typeof global.gc === 'function',
            memory: process.memoryUsage()
        };
    }

    stop() {
        for (const t of this._timers) {
            clearInterval(t);
        }
        this._timers = [];
        this._attached = false;
    }
}

/** Convenience factory so you can also do `import { optiMazer } from '@mamzhandsome/baileys'`. */
export const optiMazer = (config) => new OptiMazer(config);
