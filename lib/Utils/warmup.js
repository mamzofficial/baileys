/**
 * lib/Utils/warmup.js — "AntiBanned" fresh-number throttle
 *
 * What this is: a small, transparent daily-send-limit ramp for numbers that
 * were only recently connected to this socket. Brand new WhatsApp numbers
 * get flagged for review more easily if they suddenly send a lot of
 * messages, so this throttle starts them at a low daily cap and increases
 * it every day until it "graduates" to unlimited after `warmUpDays`.
 *
 * What this is NOT: this does not touch message content, timing jitter
 * beyond a plain send delay, device/browser fingerprints, proxies, or
 * anything that tries to make automated traffic look indistinguishable
 * from a human. It only answers one question — "has this number sent a
 * suspiciously large number of messages today for how new it is?" — and
 * either delays or blocks the send if so. See README.md → "AntiBanned".
 *
 * "Fresh" vs "old" is decided purely from state you keep on your own end
 * (see `existingState` below) — this module makes no WhatsApp API calls
 * and reads no account data; it's just a local counter.
 */

export const DEFAULT_WARMUP_CONFIG = {
    /** How many days of ramp-up before this number is treated as "old" (unlimited). */
    warmUpDays: 7,
    /** Max messages allowed on day 1. */
    day1Limit: 20,
    /** Daily limit is multiplied by this factor each subsequent day. */
    growthFactor: 1.8,
    /** If graduated but silent for this many hours, restart the ramp from day 1. */
    inactivityThresholdHours: 24 * 3
};

export class NumberWarmUp {
    /**
     * @param config Partial<typeof DEFAULT_WARMUP_CONFIG>
     * @param existingState Pass in `exportState()` from a previous run (e.g.
     *   loaded alongside your auth state) so the ramp survives restarts.
     *   Omit it and every process restart is treated as a fresh number.
     */
    constructor(config = {}, existingState) {
        this.config = { ...DEFAULT_WARMUP_CONFIG, ...config };
        this.state = existingState || this.freshState();
    }

    freshState() {
        const now = Date.now();
        return {
            startedAt: now,
            lastActiveAt: now,
            dailyCounts: [],
            graduated: false
        };
    }

    getCurrentDay() {
        return Math.floor((Date.now() - this.state.startedAt) / (24 * 60 * 60 * 1000));
    }

    checkInactivity() {
        const hoursSinceActive = (Date.now() - this.state.lastActiveAt) / (60 * 60 * 1000);
        if (this.state.graduated && hoursSinceActive > this.config.inactivityThresholdHours) {
            this.state = this.freshState();
        }
    }

    getDailyLimit() {
        if (this.state.graduated) {
            return Infinity;
        }
        const day = this.getCurrentDay();
        if (day >= this.config.warmUpDays) {
            this.state.graduated = true;
            return Infinity;
        }
        return Math.round(this.config.day1Limit * Math.pow(this.config.growthFactor, day));
    }

    /** true = "old enough" or under today's limit; false = should be delayed/blocked. */
    canSend() {
        this.checkInactivity();
        if (this.state.graduated) {
            return true;
        }
        const day = this.getCurrentDay();
        const sentToday = this.state.dailyCounts[day] || 0;
        return sentToday < this.getDailyLimit();
    }

    /** Call once per message actually sent. */
    record() {
        const day = this.getCurrentDay();
        while (this.state.dailyCounts.length <= day) {
            this.state.dailyCounts.push(0);
        }
        this.state.dailyCounts[day]++;
        this.state.lastActiveAt = Date.now();
    }

    getStatus() {
        this.checkInactivity();
        const day = this.getCurrentDay();
        const sentToday = this.state.dailyCounts[day] || 0;
        const limit = this.getDailyLimit();
        return {
            isFreshNumber: !this.state.graduated,
            day: Math.min(day + 1, this.config.warmUpDays),
            totalWarmUpDays: this.config.warmUpDays,
            todayLimit: limit === Infinity ? null : limit,
            todaySent: sentToday
        };
    }

    /** Persist alongside your auth state so the ramp survives restarts. */
    exportState() {
        return { ...this.state, dailyCounts: [...this.state.dailyCounts] };
    }
}
