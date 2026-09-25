import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as fs2 from 'node:fs';
import * as path from 'node:path';
import * as import_events from 'node:events';
import * as _fsPromises from 'node:fs/promises';
import * as _fsSync from 'node:fs';
import * as _path3 from 'node:path';
import * as import_fs from 'node:fs';
import * as path2 from 'node:path';

const require2 = createRequire(import.meta.url);

var TIME_CONSTANTS = {
    MS_PER_SECOND: 1e3,
    MS_PER_MINUTE: 6e4,
    MS_PER_HOUR: 36e5,
    MS_PER_DAY: 864e5,
    BURST_RESET_MS: 3e4,
    IDENTICAL_WINDOW_MS: 36e5
};
var DEFAULT_CONFIG = {
    maxPerMinute: 8,
    maxPerHour: 200,
    maxPerDay: 1500,
    minDelayMs: 1500,
    maxDelayMs: 5e3,
    newChatDelayMs: 3e3,
    maxIdenticalMessages: 3,
    burstAllowance: 3,
    identicalMessageWindowMs: TIME_CONSTANTS.IDENTICAL_WINDOW_MS
};
var RateLimiter = class {
    config;
    messages = [];
    identicalCount = new Map();
    knownChats = new Set();
    burstCount = 0;
    lastMessageTime = 0;
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    async getDelay(recipient, content) {
        const now = Date.now();
        this.cleanup(now);
        const contentHash = this.hashContent(content);
        const dayMessages = this.messages.filter(m => now - m.timestamp < TIME_CONSTANTS.MS_PER_DAY);
        if (dayMessages.length >= this.config.maxPerDay) {
            return -1;
        }
        const hourMessages = this.messages.filter(m => now - m.timestamp < TIME_CONSTANTS.MS_PER_HOUR);
        if (hourMessages.length >= this.config.maxPerHour) {
            hourMessages.sort((a, b) => a.timestamp - b.timestamp);
            const oldestInHour = hourMessages[0];
            const delay2 = oldestInHour
                ? oldestInHour.timestamp + TIME_CONSTANTS.MS_PER_HOUR - now
                : TIME_CONSTANTS.MS_PER_HOUR;
            return Math.max(delay2, TIME_CONSTANTS.MS_PER_MINUTE);
        }
        const minuteMessages = this.messages.filter(m => now - m.timestamp < TIME_CONSTANTS.MS_PER_MINUTE);
        if (minuteMessages.length >= this.config.maxPerMinute) {
            minuteMessages.sort((a, b) => a.timestamp - b.timestamp);
            const oldestInMinute = minuteMessages[0];
            const delay2 = oldestInMinute
                ? oldestInMinute.timestamp + TIME_CONSTANTS.MS_PER_MINUTE - now
                : TIME_CONSTANTS.MS_PER_MINUTE;
            return Math.max(delay2, TIME_CONSTANTS.MS_PER_SECOND);
        }
        const tracker = this.identicalCount.get(contentHash);
        if (tracker) {
            if (now - tracker.firstSeen < this.config.identicalMessageWindowMs) {
                if (tracker.count >= this.config.maxIdenticalMessages) {
                    return -1;
                }
            }
        }
        let delay = 0;
        if (this.burstCount < this.config.burstAllowance) {
            this.burstCount++;
            delay = this.jitter(this.config.minDelayMs * 0.5, this.config.minDelayMs);
        }
        else {
            delay = this.jitter(this.config.minDelayMs, this.config.maxDelayMs);
        }
        const isInterop = recipient.endsWith('@interop');
        if (!this.knownChats.has(recipient) || isInterop) {
            delay += this.jitter(this.config.newChatDelayMs * 0.5, this.config.newChatDelayMs);
        }
        const timeSinceLast = now - this.lastMessageTime;
        if (timeSinceLast < this.config.minDelayMs) {
            delay = Math.max(delay, this.config.minDelayMs - timeSinceLast);
        }
        const typingDelay = Math.min(content.length * 30, 3e3);
        delay += this.jitter(typingDelay * 0.5, typingDelay);
        return Math.round(delay);
    }
    record(recipient, content) {
        const now = Date.now();
        const contentHash = this.hashContent(content);
        const timeSinceLast = now - this.lastMessageTime;
        if (timeSinceLast > TIME_CONSTANTS.BURST_RESET_MS) {
            this.burstCount = 0;
        }
        this.messages.push({ timestamp: now, recipient, contentHash });
        this.knownChats.add(recipient);
        this.lastMessageTime = now;
        const tracker = this.identicalCount.get(contentHash);
        if (tracker) {
            if (now - tracker.firstSeen < this.config.identicalMessageWindowMs) {
                tracker.count++;
                tracker.lastSeen = now;
            }
            else {
                this.identicalCount.set(contentHash, { count: 1, firstSeen: now, lastSeen: now });
            }
        }
        else {
            this.identicalCount.set(contentHash, { count: 1, firstSeen: now, lastSeen: now });
        }
    }
    getStats() {
        const now = Date.now();
        this.cleanup(now);
        return {
            lastMinute: this.messages.filter(m => now - m.timestamp < TIME_CONSTANTS.MS_PER_MINUTE).length,
            lastHour: this.messages.filter(m => now - m.timestamp < TIME_CONSTANTS.MS_PER_HOUR).length,
            lastDay: this.messages.filter(m => now - m.timestamp < TIME_CONSTANTS.MS_PER_DAY).length,
            limits: {
                perMinute: this.config.maxPerMinute,
                perHour: this.config.maxPerHour,
                perDay: this.config.maxPerDay
            },
            knownChats: this.knownChats.size
        };
    }
    getKnownChats() {
        return this.knownChats;
    }
    restoreKnownChats(chats) {
        for (const jid of chats) {
            this.knownChats.add(jid);
        }
    }
    cleanup(now) {
        this.messages = this.messages.filter(m => now - m.timestamp < TIME_CONSTANTS.MS_PER_DAY);
        for (const [hash, tracker] of this.identicalCount.entries()) {
            if (now - tracker.lastSeen > this.config.identicalMessageWindowMs) {
                this.identicalCount.delete(hash);
            }
        }
    }
    jitter(min, max) {
        const u1 = Math.random();
        const u2 = Math.random();
        const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        const normalized = (normal + 3) / 6;
        const clamped = Math.max(0, Math.min(1, normalized));
        return Math.round(min + clamped * (max - min));
    }
    hashContent(content) {
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash |= 0;
        }
        return hash.toString(36);
    }
};
var DEFAULT_CONFIG2 = {
    warmUpDays: 7,
    day1Limit: 20,
    growthFactor: 1.8,
    inactivityThresholdHours: 72
};
var WarmUp = class {
    config;
    state;
    constructor(config = {}, existingState) {
        this.config = { ...DEFAULT_CONFIG2, ...config };
        this.state = existingState || this.freshState();
    }
    getDailyLimit() {
        if (this.state.graduated)
            return Infinity;
        const day = this.getCurrentDay();
        if (day >= this.config.warmUpDays) {
            this.state.graduated = true;
            return Infinity;
        }
        return Math.round(this.config.day1Limit * Math.pow(this.config.growthFactor, day));
    }
    canSend() {
        this.checkInactivity();
        if (this.state.graduated)
            return true;
        const day = this.getCurrentDay();
        const todayCount = this.state.dailyCounts[day] || 0;
        return todayCount < this.getDailyLimit();
    }
    record() {
        const now = Date.now();
        const day = this.getCurrentDay();
        while (this.state.dailyCounts.length <= day) {
            this.state.dailyCounts.push(0);
        }
        this.state.dailyCounts[day]++;
        this.state.lastActiveAt = now;
    }
    getStatus() {
        const day = this.getCurrentDay();
        const todaySent = this.state.dailyCounts[day] || 0;
        const limit = this.getDailyLimit();
        return {
            phase: this.state.graduated ? 'graduated' : 'warming',
            day: Math.min(day + 1, this.config.warmUpDays),
            totalDays: this.config.warmUpDays,
            todayLimit: limit === Infinity ? -1 : limit,
            todaySent,
            progress: this.state.graduated ? 100 : Math.round((day / this.config.warmUpDays) * 100)
        };
    }
    exportState() {
        return { ...this.state };
    }
    reset() {
        this.state = this.freshState();
    }
    getCurrentDay() {
        return Math.floor((Date.now() - this.state.startedAt) / 864e5);
    }
    checkInactivity() {
        const hoursSinceActive = (Date.now() - this.state.lastActiveAt) / 36e5;
        if (hoursSinceActive > this.config.inactivityThresholdHours && this.state.graduated) {
            this.state = this.freshState();
            this.state.graduated = false;
        }
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
};
var DEFAULT_CONFIG3 = {
    disconnectWarningThreshold: 3,
    disconnectCriticalThreshold: 5,
    failedMessageThreshold: 5,
    autoPauseAt: 'high'
};
var HealthMonitor = class {
    config;
    events = [];
    startTime = Date.now();
    paused = false;
    lastRisk = 'low';
    lastBadEventTime = Date.now();
    lastEventWasSevere = false;
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG3, ...config };
    }
    recordDisconnect(reason) {
        const reasonStr = String(reason);
        if (reasonStr === '403' || reasonStr === 'forbidden') {
            this.events.push({ type: 'forbidden', timestamp: Date.now(), detail: reasonStr });
            this.lastBadEventTime = Date.now();
            this.lastEventWasSevere = true;
        }
        else if (reasonStr === '401' || reasonStr === 'loggedOut') {
            this.events.push({ type: 'loggedOut', timestamp: Date.now(), detail: reasonStr });
            this.lastBadEventTime = Date.now();
            this.lastEventWasSevere = true;
        }
        else if (reasonStr === '463') {
            this.events.push({ type: 'reachoutTimelocked', timestamp: Date.now(), detail: reasonStr });
            this.lastBadEventTime = Date.now();
            this.lastEventWasSevere = false;
        }
        else {
            this.events.push({ type: 'disconnect', timestamp: Date.now(), detail: reasonStr });
            this.lastBadEventTime = Date.now();
            this.lastEventWasSevere = false;
        }
        this.checkAndNotify();
    }
    recordReconnect() {
        this.events.push({ type: 'reconnect', timestamp: Date.now() });
    }
    recordMessageFailed(error) {
        this.events.push({ type: 'messageFailed', timestamp: Date.now(), detail: error });
        this.lastBadEventTime = Date.now();
        this.lastEventWasSevere = false;
        this.checkAndNotify();
    }
    recordReachoutTimelock(detail) {
        this.events.push({ type: 'reachoutTimelocked', timestamp: Date.now(), detail });
        this.lastBadEventTime = Date.now();
        this.lastEventWasSevere = false;
        this.checkAndNotify();
    }
    getStatus() {
        const now = Date.now();
        this.cleanup(now);
        const hourEvents = this.events.filter(e => now - e.timestamp < 36e5);
        const disconnects = hourEvents.filter(e => e.type === 'disconnect').length;
        const forbidden = hourEvents.filter(e => e.type === 'forbidden').length;
        const loggedOut = hourEvents.filter(e => e.type === 'loggedOut').length;
        const failedMessages = hourEvents.filter(e => e.type === 'messageFailed').length;
        let score = 0;
        const reasons = [];
        if (forbidden > 0) {
            score += 40 * forbidden;
            reasons.push(`${forbidden} forbidden (403) error${forbidden > 1 ? 's' : ''} in last hour`);
        }
        if (loggedOut > 0) {
            score += 60;
            reasons.push('Logged out by WhatsApp \u2014 possible temporary ban');
        }
        const timelocked = hourEvents.filter(e => e.type === 'reachoutTimelocked').length;
        if (timelocked > 0) {
            score += 25;
            reasons.push(`${timelocked} reachout timelock (463) error${timelocked > 1 ? 's' : ''} in last hour`);
        }
        if (disconnects >= this.config.disconnectCriticalThreshold) {
            score += 30;
            reasons.push(`${disconnects} disconnects in last hour (critical threshold)`);
        }
        else if (disconnects >= this.config.disconnectWarningThreshold) {
            score += 30;
            reasons.push(`${disconnects} disconnects in last hour`);
        }
        if (failedMessages >= this.config.failedMessageThreshold) {
            score += 20;
            reasons.push(`${failedMessages} failed messages in last hour`);
        }
        score = Math.min(100, score);
        const minutesSinceLastBad = (now - this.lastBadEventTime) / 6e4;
        const decayRate = this.lastEventWasSevere ? 2 : 5;
        score = Math.max(0, score - Math.floor(minutesSinceLastBad * decayRate));
        let risk;
        if (score >= 80)
            risk = 'critical';
        else if (score >= 40)
            risk = 'high';
        else if (score >= 15)
            risk = 'medium';
        else
            risk = 'low';
        let recommendation;
        switch (risk) {
            case 'critical':
                recommendation = 'STOP ALL MESSAGING IMMEDIATELY. Disconnect and wait 24-48 hours before reconnecting.';
                break;
            case 'high':
                recommendation = 'Reduce messaging rate by 80%. Consider pausing for 1-2 hours.';
                break;
            case 'medium':
                recommendation = 'Reduce messaging rate by 50%. Increase delays between messages.';
                break;
            default:
                recommendation = 'Operating normally. Continue monitoring.';
        }
        const lastDisconnect = [...this.events]
            .reverse()
            .find(e => e.type === 'disconnect' || e.type === 'forbidden' || e.type === 'loggedOut');
        return {
            risk,
            score,
            reasons: reasons.length ? reasons : ['No issues detected'],
            recommendation,
            stats: {
                disconnectsLastHour: disconnects,
                failedMessagesLastHour: failedMessages,
                forbiddenErrors: forbidden,
                timelockErrors: timelocked,
                uptimeMs: now - this.startTime,
                lastDisconnectReason: lastDisconnect?.detail
            }
        };
    }
    isPaused() {
        if (this.paused)
            return true;
        const status = this.getStatus();
        const riskOrder = ['low', 'medium', 'high', 'critical'];
        return riskOrder.indexOf(status.risk) >= riskOrder.indexOf(this.config.autoPauseAt);
    }
    setPaused(paused) {
        this.paused = paused;
    }
    reset() {
        this.events = [];
        this.startTime = Date.now();
        this.paused = false;
        this.lastRisk = 'low';
        this.lastBadEventTime = Date.now();
        this.lastEventWasSevere = false;
    }
    cleanup(now) {
        this.events = this.events.filter(e => now - e.timestamp < 216e5);
    }
    checkAndNotify() {
        const status = this.getStatus();
        if (status.risk !== this.lastRisk) {
            this.lastRisk = status.risk;
            this.config.onRiskChange?.(status);
        }
    }
};
var DEFAULT_CONFIG4 = {
    resumeBufferMs: 1e4
};
var TimelockGuard = class {
    config;
    state = {
        isActive: false,
        errorCount: 0
    };
    knownChats = new Set();
    resumeTimer = null;
    timerGeneration = 0;
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG4, ...config };
    }
    onTimelockUpdate(data) {
        const wasActive = this.state.isActive;
        this.state.isActive = !!data.isActive;
        this.state.enforcementType = data.enforcementType;
        this.state.expiresAt = data.timeEnforcementEnds;
        if (this.state.isActive && !wasActive) {
            this.state.detectedAt = new Date();
            this.state.errorCount = 0;
            this.config.onTimelockDetected?.(this.getState());
            this.scheduleResume();
        }
        else if (this.state.isActive && wasActive) {
            this.scheduleResume();
        }
        if (!this.state.isActive && wasActive) {
            this.clearResumeTimer();
            this.config.onTimelockLifted?.(this.getState());
        }
    }
    record463Error() {
        this.state.errorCount++;
        if (!this.state.isActive) {
            this.state.isActive = true;
            this.state.detectedAt = new Date();
            this.state.expiresAt = new Date(Date.now() + 6e4);
            this.config.onTimelockDetected?.(this.getState());
            this.scheduleResume();
        }
    }
    registerKnownChat(jid) {
        this.knownChats.add(jid);
    }
    registerKnownChats(jids) {
        for (const jid of jids) {
            this.knownChats.add(jid);
        }
    }
    canSend(jid) {
        if (!this.state.isActive) {
            return { allowed: true };
        }
        if (this.state.expiresAt) {
            const expiryWithBuffer = this.state.expiresAt.getTime() + this.config.resumeBufferMs;
            if (Date.now() >= expiryWithBuffer) {
                this.lift();
                return { allowed: true };
            }
        }
        if (jid.endsWith('@g.us') || jid.endsWith('@newsletter')) {
            return { allowed: true };
        }
        if (this.knownChats.has(jid)) {
            return { allowed: true };
        }
        const expiresIn = this.state.expiresAt ? Math.max(0, this.state.expiresAt.getTime() - Date.now()) : 6e4;
        return {
            allowed: false,
            reason: `Reachout timelocked (${this.state.enforcementType || 'unknown'}). New contacts blocked. Expires in ${Math.ceil(expiresIn / 1e3)}s.`
        };
    }
    getState() {
        return { ...this.state };
    }
    isTimelocked() {
        if (!this.state.isActive)
            return false;
        if (this.state.expiresAt) {
            const expiryWithBuffer = this.state.expiresAt.getTime() + this.config.resumeBufferMs;
            if (Date.now() >= expiryWithBuffer) {
                this.lift();
                return false;
            }
        }
        return true;
    }
    getKnownChats() {
        return new Set(this.knownChats);
    }
    lift() {
        if (this.state.isActive) {
            this.state.isActive = false;
            this.clearResumeTimer();
            this.config.onTimelockLifted?.(this.getState());
        }
    }
    reset() {
        this.state = { isActive: false, errorCount: 0 };
        this.knownChats.clear();
        this.clearResumeTimer();
    }
    scheduleResume() {
        this.clearResumeTimer();
        if (this.state.expiresAt) {
            const delay = this.state.expiresAt.getTime() - Date.now() + this.config.resumeBufferMs;
            if (delay > 0) {
                this.timerGeneration++;
                const currentGeneration = this.timerGeneration;
                this.resumeTimer = setTimeout(() => {
                    if (currentGeneration === this.timerGeneration) {
                        this.lift();
                    }
                }, delay);
            }
        }
    }
    clearResumeTimer() {
        if (this.resumeTimer) {
            clearTimeout(this.resumeTimer);
            this.resumeTimer = null;
            this.timerGeneration++;
        }
    }
};
var DEFAULT_CONFIG5 = {
    enabled: false,
    minRatio: 0.1,
    minMessagesBeforeEnforce: 5,
    inboundAutoReplyProbability: 0.25,
    autoReplyTemplates: ['\u{1F44D}', '\u{1F44C}', 'ok', 'noted', 'thanks', '\u{1F64F}', 'got it'],
    cooldownHoursOnViolation: 24,
    scope: 'individual'
};
var ReplyRatioGuard = class {
    config;
    contacts = new Map();
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG5, ...config };
    }
    beforeSend(jid) {
        if (!this.config.enabled) {
            return { allowed: true };
        }
        if (this.isGroup(jid) && this.config.scope === 'individual') {
            return { allowed: true };
        }
        const record = this.contacts.get(jid);
        if (!record) {
            return { allowed: true };
        }
        if (record.cooledUntil && Date.now() < record.cooledUntil) {
            const hoursLeft = Math.ceil((record.cooledUntil - Date.now()) / 36e5);
            return {
                allowed: false,
                reason: `Reply ratio cooldown \u2014 ${record.sent} sent, ${record.received} received. Retry in ${hoursLeft}h`
            };
        }
        if (record.sent >= this.config.minMessagesBeforeEnforce) {
            const ratio = record.sent === 0 ? 1 : record.received / record.sent;
            if (ratio < this.config.minRatio) {
                record.cooledUntil = Date.now() + this.config.cooldownHoursOnViolation * 36e5;
                return {
                    allowed: false,
                    reason: `Reply ratio too low (${(ratio * 100).toFixed(1)}% < ${(this.config.minRatio * 100).toFixed(1)}%). Cooldown ${this.config.cooldownHoursOnViolation}h`
                };
            }
        }
        return { allowed: true };
    }
    recordSent(jid) {
        if (!this.config.enabled)
            return;
        const record = this.contacts.get(jid) || { sent: 0, received: 0 };
        record.sent++;
        this.contacts.set(jid, record);
    }
    recordReceived(jid) {
        if (!this.config.enabled)
            return;
        const record = this.contacts.get(jid) || { sent: 0, received: 0 };
        record.received++;
        delete record.cooledUntil;
        this.contacts.set(jid, record);
    }
    suggestReply(jid, _msgText) {
        if (!this.config.enabled) {
            return { shouldReply: false };
        }
        if (this.isGroup(jid) && this.config.scope === 'individual') {
            return { shouldReply: false };
        }
        if (Math.random() < this.config.inboundAutoReplyProbability) {
            const templates = this.config.autoReplyTemplates;
            const suggestedText = templates[Math.floor(Math.random() * templates.length)];
            return { shouldReply: true, suggestedText };
        }
        return { shouldReply: false };
    }
    getStats() {
        const perContact = Array.from(this.contacts.entries()).map(([jid, record]) => ({
            jid,
            sent: record.sent,
            received: record.received,
            ratio: record.sent === 0 ? 0 : record.received / record.sent,
            cooledUntil: record.cooledUntil
        }));
        const globalSent = perContact.reduce((sum, c) => sum + c.sent, 0);
        const globalReceived = perContact.reduce((sum, c) => sum + c.received, 0);
        const globalRatio = globalSent === 0 ? 0 : globalReceived / globalSent;
        const contactsOnCooldown = perContact.filter(c => c.cooledUntil && Date.now() < c.cooledUntil).length;
        return {
            perContact,
            globalSent,
            globalReceived,
            globalRatio,
            contactsOnCooldown
        };
    }
    reset() {
        this.contacts.clear();
    }
    exportState() {
        return {
            contacts: Array.from(this.contacts.entries())
        };
    }
    restoreState(state) {
        if (state?.contacts && Array.isArray(state.contacts)) {
            this.contacts = new Map(state.contacts);
        }
    }
    isGroup(jid) {
        return jid.endsWith('@g.us');
    }
};
var DEFAULT_CONFIG6 = {
    enabled: false,
    requireHandshakeBeforeGroupSend: true,
    handshakeMinDelayMs: 36e5,
    groupLurkPeriodMs: 432e5,
    maxStrangerMessagesPerDay: 5,
    autoRegisterOnIncoming: true
};
var ContactGraphWarmer = class {
    config;
    contacts = new Map();
    groups = new Map();
    strangerMessagesToday = 0;
    lastStrangerResetDay = this.getCurrentDay();
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG6, ...config };
    }
    canMessage(jid) {
        if (!this.config.enabled) {
            return { allowed: true };
        }
        const currentDay = this.getCurrentDay();
        if (currentDay !== this.lastStrangerResetDay) {
            this.strangerMessagesToday = 0;
            this.lastStrangerResetDay = currentDay;
        }
        if (this.isGroup(jid)) {
            return this.checkGroupMessage(jid);
        }
        return this.checkIndividualMessage(jid);
    }
    markHandshakeSent(jid) {
        if (!this.config.enabled)
            return;
        if (this.isGroup(jid))
            return;
        const record = this.contacts.get(jid) || { state: 'stranger' };
        record.state = 'handshake_sent';
        record.handshakeSentAt = Date.now();
        this.contacts.set(jid, record);
    }
    markHandshakeComplete(jid) {
        if (!this.config.enabled)
            return;
        if (this.isGroup(jid))
            return;
        const record = this.contacts.get(jid) || { state: 'stranger' };
        record.state = 'handshake_complete';
        this.contacts.set(jid, record);
    }
    registerKnownContact(jid) {
        if (!this.config.enabled)
            return;
        if (this.isGroup(jid))
            return;
        const record = this.contacts.get(jid) || { state: 'stranger' };
        record.state = 'known';
        this.contacts.set(jid, record);
    }
    registerGroupJoin(groupJid) {
        if (!this.config.enabled)
            return;
        if (!this.isGroup(groupJid))
            return;
        this.groups.set(groupJid, { joinedAt: Date.now() });
    }
    getContactState(jid) {
        if (this.isGroup(jid))
            return 'known';
        return this.contacts.get(jid)?.state || 'stranger';
    }
    onIncomingMessage(jid) {
        if (!this.config.enabled)
            return;
        if (this.isGroup(jid))
            return;
        if (this.config.autoRegisterOnIncoming) {
            this.registerKnownContact(jid);
        }
    }
    getStats() {
        const knownContacts = Array.from(this.contacts.values()).filter(c => c.state === 'known').length;
        const pendingHandshakes = Array.from(this.contacts.values()).filter(c => c.state === 'handshake_sent').length;
        const groupsJoined = Array.from(this.groups.entries()).map(([groupJid, record]) => ({
            groupJid,
            joinedAt: record.joinedAt,
            firstSendUnlocksAt: record.joinedAt + this.config.groupLurkPeriodMs
        }));
        return {
            knownContacts,
            pendingHandshakes,
            strangersToday: this.strangerMessagesToday,
            groupsJoined
        };
    }
    reset() {
        this.contacts.clear();
        this.groups.clear();
        this.strangerMessagesToday = 0;
        this.lastStrangerResetDay = this.getCurrentDay();
    }
    exportState() {
        return {
            contacts: Array.from(this.contacts.entries()),
            groups: Array.from(this.groups.entries()),
            strangerMessagesToday: this.strangerMessagesToday,
            lastStrangerResetDay: this.lastStrangerResetDay
        };
    }
    restoreState(state) {
        if (state?.contacts && Array.isArray(state.contacts)) {
            this.contacts = new Map(state.contacts);
        }
        if (state?.groups && Array.isArray(state.groups)) {
            this.groups = new Map(state.groups);
        }
        if (typeof state?.strangerMessagesToday === 'number') {
            this.strangerMessagesToday = state.strangerMessagesToday;
        }
        if (typeof state?.lastStrangerResetDay === 'number') {
            this.lastStrangerResetDay = state.lastStrangerResetDay;
        }
    }
    isGroup(jid) {
        return jid.endsWith('@g.us');
    }
    getCurrentDay() {
        return Math.floor(Date.now() / 864e5);
    }
    checkGroupMessage(groupJid) {
        const record = this.groups.get(groupJid);
        if (!record) {
            return { allowed: true };
        }
        const lurkEndsAt = record.joinedAt + this.config.groupLurkPeriodMs;
        if (Date.now() < lurkEndsAt) {
            const minutesLeft = Math.ceil((lurkEndsAt - Date.now()) / 6e4);
            return {
                allowed: false,
                reason: `Group lurk period not elapsed \u2014 wait ${minutesLeft} minutes`
            };
        }
        return { allowed: true };
    }
    checkIndividualMessage(jid) {
        const record = this.contacts.get(jid);
        if (!record || record.state === 'stranger') {
            if (this.config.requireHandshakeBeforeGroupSend) {
                if (this.strangerMessagesToday >= this.config.maxStrangerMessagesPerDay) {
                    return {
                        allowed: false,
                        reason: `Daily new-contact limit reached (${this.config.maxStrangerMessagesPerDay})`,
                        needsHandshake: true
                    };
                }
                this.strangerMessagesToday++;
            }
            return { allowed: true, needsHandshake: true };
        }
        if (record.state === 'handshake_sent') {
            if (!record.handshakeSentAt) {
                return { allowed: true };
            }
            const elapsed = Date.now() - record.handshakeSentAt;
            if (elapsed < this.config.handshakeMinDelayMs) {
                const minutesLeft = Math.ceil((this.config.handshakeMinDelayMs - elapsed) / 6e4);
                return {
                    allowed: false,
                    reason: `Handshake too recent \u2014 wait ${minutesLeft} minutes`
                };
            }
        }
        return { allowed: true };
    }
};
var DEFAULT_CONFIG7 = {
    enabled: false,
    enableCircadianRhythm: true,
    timezone: 'UTC',
    activityCurve: 'office',
    circadian: {
        enabled: true,
        profile: 'default',
        timezone: 'UTC'
    },
    distractionPauseProbability: 0.05,
    distractionPauseMinMs: 3e5,
    distractionPauseMaxMs: 12e5,
    readReceiptDelayMinMs: 3e3,
    readReceiptDelayMaxMs: 45e3,
    readReceiptSkipProbability: 0.15,
    offlineGapProbability: 0.03,
    offlineGapMinMs: 3e5,
    offlineGapMaxMs: 9e5,
    enableTypingModel: true,
    typingWPM: 45,
    typingWPMStdDev: 15,
    thinkPauseProbability: 0.08,
    thinkPauseMinMs: 800,
    thinkPauseMaxMs: 3500,
    intermittentPausedProbability: 0.4,
    typingMaxMs: 9e4,
    typingMinMs: 600
};
var ACTIVITY_CURVES = {
    office: [
        0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1,
        0.5, 0.5,
        0.95, 0.95,
        0.6,
        0.9, 0.9, 0.9, 0.9,
        0.6, 0.6,
        0.4, 0.4,
        0.2, 0.2, 0.2, 0.2
    ],
    social: [
        0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1,
        0.3, 0.4,
        0.7, 0.8,
        0.5,
        0.7, 0.7,
        0.4,
        0.8, 0.9, 0.9,
        0.6,
        0.8, 0.85, 0.9, 0.95, 1
    ],
    global: [
        0.5, 0.5, 0.5, 0.5, 0.5, 0.5,
        0.4, 0.4,
        0.6, 0.7, 0.8, 0.8,
        0.6,
        0.8, 0.8, 0.8, 0.8,
        0.7, 0.7,
        0.6, 0.5, 0.5, 0.5, 0.5, 0.5
    ]
};
function getCircadianMultiplier(date = new Date(), profile = 'default', timezone) {
    if (profile === 'always_on') {
        return 1;
    }
    let hour;
    if (timezone) {
        try {
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: timezone,
                hour: 'numeric',
                hour12: false
            });
            const parts = formatter.formatToParts(date);
            const hourPart = parts.find(p => p.type === 'hour');
            hour = hourPart ? parseInt(hourPart.value, 10) : date.getHours();
        }
        catch {
            hour = date.getHours();
        }
    }
    else {
        hour = date.getHours();
    }
    let shiftedHour = hour;
    if (profile === 'nightOwl') {
        shiftedHour = (hour - 3 + 24) % 24;
    }
    else if (profile === 'earlyBird') {
        shiftedHour = (hour + 2) % 24;
    }
    if (shiftedHour >= 9 && shiftedHour < 22) {
        const t = (shiftedHour - 9) / 13;
        return 1 + 0.2 * Math.cos(2 * Math.PI * t);
    }
    else if (shiftedHour >= 22 && shiftedHour < 24) {
        const t = (shiftedHour - 22) / 2;
        return 1.2 + 1.3 * t;
    }
    else if (shiftedHour >= 0 && shiftedHour < 2) {
        const t = shiftedHour / 2;
        return 2.5 + 1.5 * t;
    }
    else if (shiftedHour >= 2 && shiftedHour < 6) {
        const t = (shiftedHour - 2) / 4;
        return 5 + 1 * Math.cos(Math.PI * t);
    }
    else {
        const t = (shiftedHour - 6) / 3;
        return 4 - 3 * t;
    }
}
var PresenceChoreographer = class {
    config;
    stats = {
        distractionPausesInjected: 0,
        offlineGapsInjected: 0,
        readReceiptsDelayed: 0,
        readReceiptsSkipped: 0,
        typingPlansComputed: 0,
        typingPlansExecuted: 0,
        totalTypingTimeMs: 0
    };
    constructor(config = {}) {
        this.config = {
            ...DEFAULT_CONFIG7,
            ...config,
            circadian: {
                ...DEFAULT_CONFIG7.circadian,
                ...(config.circadian || {})
            }
        };
    }
    getCurrentActivityFactor() {
        if (!this.config.enabled || !this.config.enableCircadianRhythm) {
            return 1;
        }
        const hour = this.getLocalHour();
        const curve = ACTIVITY_CURVES[this.config.activityCurve];
        return curve[hour] || 0.5;
    }
    shouldPauseForDistraction() {
        if (!this.config.enabled) {
            return { pause: false, durationMs: 0 };
        }
        if (Math.random() < this.config.distractionPauseProbability) {
            const durationMs = this.randomBetween(this.config.distractionPauseMinMs, this.config.distractionPauseMaxMs);
            this.stats.distractionPausesInjected++;
            return { pause: true, durationMs };
        }
        return { pause: false, durationMs: 0 };
    }
    shouldTakeOfflineGap() {
        if (!this.config.enabled) {
            return { offline: false, durationMs: 0 };
        }
        if (Math.random() < this.config.offlineGapProbability) {
            const durationMs = this.randomBetween(this.config.offlineGapMinMs, this.config.offlineGapMaxMs);
            this.stats.offlineGapsInjected++;
            return { offline: true, durationMs };
        }
        return { offline: false, durationMs: 0 };
    }
    shouldMarkRead() {
        if (!this.config.enabled) {
            return { mark: true, delayMs: 0 };
        }
        if (Math.random() < this.config.readReceiptSkipProbability) {
            this.stats.readReceiptsSkipped++;
            return { mark: false, delayMs: 0 };
        }
        const baseDelayMs = this.randomBetween(this.config.readReceiptDelayMinMs, this.config.readReceiptDelayMaxMs);
        let delayMs = baseDelayMs;
        if (this.config.circadian.enabled) {
            const circadianMultiplier = getCircadianMultiplier(new Date(), this.config.circadian.profile, this.config.circadian.timezone);
            delayMs = Math.floor(baseDelayMs * circadianMultiplier);
        }
        this.stats.readReceiptsDelayed++;
        return { mark: true, delayMs };
    }
    computeTypingPlan(messageLength) {
        if (!this.config.enabled || !this.config.enableTypingModel) {
            return [{ state: 'composing', durationMs: this.config.typingMinMs }];
        }
        this.stats.typingPlansComputed++;
        if (messageLength === 0) {
            return [{ state: 'composing', durationMs: this.config.typingMinMs }];
        }
        const wpmSample = this.clamp(this.gaussianSample(this.config.typingWPM, this.config.typingWPMStdDev), 10, 120);
        const cps = (wpmSample * 5) / 60;
        const baseMs = (messageLength / cps) * 1e3;
        let circadianMultiplier = 1;
        if (this.config.circadian.enabled) {
            circadianMultiplier = getCircadianMultiplier(new Date(), this.config.circadian.profile, this.config.circadian.timezone);
        }
        const targetMs = this.clamp(baseMs * circadianMultiplier, this.config.typingMinMs, this.config.typingMaxMs);
        const plan = [];
        let remainingBudget = targetMs;
        let position = 0;
        const chunkSize = 10;
        const numChunks = Math.max(1, Math.ceil(messageLength / chunkSize));
        for (let i = 0; i < numChunks && remainingBudget > 0; i++) {
            const charsInChunk = Math.min(chunkSize, messageLength - position);
            const remainingChunks = numChunks - i;
            const chunkBudget = remainingBudget / remainingChunks;
            const chunkTypingMs = Math.floor(Math.min(chunkBudget, remainingBudget));
            if (chunkTypingMs <= 0)
                break;
            if (i > 0 && i < numChunks - 1 && Math.random() < this.config.thinkPauseProbability) {
                plan.push({ state: 'composing', durationMs: chunkTypingMs });
                remainingBudget -= chunkTypingMs;
                const basePauseMs = this.randomBetween(this.config.thinkPauseMinMs, this.config.thinkPauseMaxMs);
                const pauseMs = Math.floor(basePauseMs * circadianMultiplier);
                plan.push({ state: 'paused', durationMs: pauseMs });
            }
            else {
                if (plan.length === 0 || plan[plan.length - 1].state === 'paused') {
                    plan.push({ state: 'composing', durationMs: chunkTypingMs });
                }
                else {
                    plan[plan.length - 1].durationMs += chunkTypingMs;
                }
                remainingBudget -= chunkTypingMs;
            }
            position += charsInChunk;
        }
        if (Math.random() < this.config.intermittentPausedProbability) {
            const baseFinalPauseMs = this.randomBetween(200, 800);
            const finalPauseMs = Math.floor(baseFinalPauseMs * circadianMultiplier);
            plan.push({ state: 'paused', durationMs: finalPauseMs });
        }
        if (plan.length === 0 || !plan.some(step => step.state === 'composing')) {
            return [{ state: 'composing', durationMs: this.config.typingMinMs }];
        }
        return plan;
    }
    async executeTypingPlan(sock, jid, plan, options) {
        this.stats.typingPlansExecuted++;
        for (const step of plan) {
            if (options?.signal?.aborted) {
                await Promise.resolve(sock.sendPresenceUpdate('paused', jid));
                throw new Error('Typing plan aborted');
            }
            await Promise.resolve(sock.sendPresenceUpdate(step.state, jid));
            await this.sleep(step.durationMs);
            this.stats.totalTypingTimeMs += step.durationMs;
        }
    }
    getStats() {
        return {
            currentActivityFactor: this.getCurrentActivityFactor(),
            distractionPausesInjected: this.stats.distractionPausesInjected,
            offlineGapsInjected: this.stats.offlineGapsInjected,
            readReceiptsDelayed: this.stats.readReceiptsDelayed,
            readReceiptsSkipped: this.stats.readReceiptsSkipped,
            currentHourLocal: this.getLocalHour(),
            typingPlansComputed: this.stats.typingPlansComputed,
            typingPlansExecuted: this.stats.typingPlansExecuted,
            totalTypingTimeMs: this.stats.totalTypingTimeMs
        };
    }
    reset() {
        this.stats = {
            distractionPausesInjected: 0,
            offlineGapsInjected: 0,
            readReceiptsDelayed: 0,
            readReceiptsSkipped: 0,
            typingPlansComputed: 0,
            typingPlansExecuted: 0,
            totalTypingTimeMs: 0
        };
    }
    getLocalHour() {
        try {
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: this.config.timezone,
                hour: 'numeric',
                hour12: false
            });
            const parts = formatter.formatToParts(new Date());
            const hourPart = parts.find(p => p.type === 'hour');
            if (hourPart) {
                return parseInt(hourPart.value, 10);
            }
        }
        catch (error) { }
        return new Date().getUTCHours();
    }
    randomBetween(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }
    gaussianSample(mean, stdDev) {
        const u1 = Math.random();
        const u2 = Math.random();
        const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return mean + z0 * stdDev;
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
};
var DEFAULT_CONFIG8 = {
    enabled: false,
    maxRetries: 5,
    spiralThreshold: 3,
    onSpiral: () => { }
};
var RetryReasonTracker = class {
    config;
    retries = new Map();
    totalRetries = 0;
    reasonCounts = {
        no_session: 0,
        invalid_key: 0,
        bad_mac: 0,
        decryption_failure: 0,
        server_error_463: 0,
        server_error_429: 0,
        timeout: 0,
        no_route: 0,
        node_malformed: 0,
        unknown: 0
    };
    spiralsDetected = 0;
    constructor(config) {
        this.config = { ...DEFAULT_CONFIG8, ...config };
    }
    onMessageUpdate(update) {
        if (!this.config.enabled)
            return;
        const msgId = update.key?.id;
        if (!msgId)
            return;
        if (update.status !== 0 && !update.error)
            return;
        const reason = this.classify(update.error || update);
        this.recordRetry(msgId, reason);
    }
    classify(err) {
        if (!err)
            return 'unknown';
        const statusCode = err.output?.statusCode || err.statusCode || err.status;
        if (statusCode === 463)
            return 'server_error_463';
        if (statusCode === 429)
            return 'server_error_429';
        const errorMsg = (err.message || err.text || String(err)).toLowerCase();
        if (errorMsg.includes('bad mac'))
            return 'bad_mac';
        if (errorMsg.includes('no session') || errorMsg.includes('session not found'))
            return 'no_session';
        if (errorMsg.includes('invalid key') || errorMsg.includes('key error'))
            return 'invalid_key';
        if (errorMsg.includes('decryption') || errorMsg.includes('decrypt'))
            return 'decryption_failure';
        if (errorMsg.includes('timeout') || errorMsg.includes('timed out'))
            return 'timeout';
        if (errorMsg.includes('no route') || errorMsg.includes('unreachable') || errorMsg.includes('offline'))
            return 'no_route';
        if (errorMsg.includes('malformed') || errorMsg.includes('invalid node'))
            return 'node_malformed';
        return 'unknown';
    }
    recordRetry(msgId, reason) {
        const now = Date.now();
        let record = this.retries.get(msgId);
        if (!record) {
            record = {
                msgId,
                count: 0,
                reasons: [],
                firstRetry: now,
                lastRetry: now
            };
            this.retries.set(msgId, record);
        }
        record.count++;
        record.reasons.push(reason);
        record.lastRetry = now;
        this.totalRetries++;
        this.reasonCounts[reason]++;
        if (record.count >= this.config.spiralThreshold) {
            this.spiralsDetected++;
            this.config.onSpiral(msgId, reason);
        }
    }
    isSpiraling(msgId) {
        const record = this.retries.get(msgId);
        return record ? record.count >= this.config.spiralThreshold : false;
    }
    clear(msgId) {
        this.retries.delete(msgId);
    }
    getStats() {
        return {
            totalRetries: this.totalRetries,
            byReason: { ...this.reasonCounts },
            spiralsDetected: this.spiralsDetected,
            activeRetries: this.retries.size
        };
    }
    cleanup() {
        const now = Date.now();
        const maxAge = 5 * 60 * 1e3;
        for (const [msgId, record] of this.retries.entries()) {
            if (now - record.lastRetry > maxAge) {
                this.retries.delete(msgId);
            }
        }
    }
    destroy() {
        this.retries.clear();
        this.cleanup();
    }
};
var DEFAULT_CONFIG9 = {
    enabled: false,
    rampDurationMs: 6e4,
    initialRateMultiplier: 0.1,
    rampSteps: 6,
    baselineRatePerMinute: null
};
var PostReconnectThrottle = class {
    config;
    throttledSince = null;
    throttledSendCount = 0;
    lifetimeReconnects = 0;
    rampTimer = null;
    currentStep = 0;
    sendsInCurrentWindow = 0;
    currentWindowStart = 0;
    WINDOW_DURATION_MS = 6e4;
    constructor(config) {
        this.config = {
            ...DEFAULT_CONFIG9,
            ...config,
            baselineRatePerMinute: config?.baselineRatePerMinute || null
        };
    }
    onReconnect() {
        if (!this.config.enabled)
            return;
        this.throttledSince = Date.now();
        this.currentStep = 0;
        this.throttledSendCount = 0;
        this.lifetimeReconnects++;
        this.sendsInCurrentWindow = 0;
        this.currentWindowStart = Date.now();
        if (this.rampTimer) {
            clearTimeout(this.rampTimer);
        }
        this.scheduleNextRampStep();
    }
    onDisconnect() { }
    scheduleNextRampStep() {
        if (this.currentStep >= this.config.rampSteps) {
            this.throttledSince = null;
            this.rampTimer = null;
            return;
        }
        const stepDuration = this.config.rampDurationMs / this.config.rampSteps;
        this.rampTimer = setTimeout(() => {
            this.currentStep++;
            this.scheduleNextRampStep();
        }, stepDuration);
    }
    getCurrentMultiplier() {
        if (!this.config.enabled || !this.throttledSince) {
            return 1;
        }
        const elapsed = Date.now() - this.throttledSince;
        if (elapsed >= this.config.rampDurationMs) {
            return 1;
        }
        const progress = this.currentStep / this.config.rampSteps;
        const multiplier = this.config.initialRateMultiplier + (1 - this.config.initialRateMultiplier) * progress;
        return Math.min(1, multiplier);
    }
    beforeSend() {
        if (!this.config.enabled || !this.throttledSince) {
            return { allowed: true };
        }
        const now = Date.now();
        const multiplier = this.getCurrentMultiplier();
        if (multiplier >= 1) {
            this.throttledSince = null;
            return { allowed: true };
        }
        if (now - this.currentWindowStart >= this.WINDOW_DURATION_MS) {
            this.sendsInCurrentWindow = 0;
            this.currentWindowStart = now;
        }
        const baselineRate = this.config.baselineRatePerMinute ? this.config.baselineRatePerMinute() : 8;
        const allowedInWindow = Math.max(1, Math.floor(baselineRate * multiplier));
        if (this.sendsInCurrentWindow >= allowedInWindow) {
            const windowRemaining = this.WINDOW_DURATION_MS - (now - this.currentWindowStart);
            return {
                allowed: false,
                reason: `Post-reconnect throttle: ${Math.floor(multiplier * 100)}% rate (${this.sendsInCurrentWindow}/${allowedInWindow} sends in window)`,
                retryAfterMs: windowRemaining
            };
        }
        this.sendsInCurrentWindow++;
        this.throttledSendCount++;
        return { allowed: true };
    }
    getStats() {
        const multiplier = this.getCurrentMultiplier();
        const isThrottled = this.throttledSince !== null && multiplier < 1;
        const remainingMs = isThrottled && this.throttledSince
            ? Math.max(0, this.config.rampDurationMs - (Date.now() - this.throttledSince))
            : 0;
        return {
            isThrottled,
            currentMultiplier: multiplier,
            throttledSinceMs: this.throttledSince,
            remainingMs,
            throttledSendCount: this.throttledSendCount,
            lifetimeReconnects: this.lifetimeReconnects
        };
    }
    destroy() {
        if (this.rampTimer) {
            clearTimeout(this.rampTimer);
            this.rampTimer = null;
        }
        this.throttledSince = null;
    }
};
var DEFAULT_CONFIG10 = {
    canonical: 'pn',
    maxEntries: 1e4
};
var LidResolver = class {
    config;
    persistence;
    lidToPn = new Map();
    pnToLid = new Map();
    stats = {
        learnedFromEvents: 0,
        lookupsServed: 0,
        lookupMisses: 0
    };
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG10, ...config };
        this.persistence = config.persistence;
        if (this.persistence?.load) {
            void this.hydrate();
        }
    }
    learn(mapping) {
        let lid = mapping.lid ? this.normalizeJid(mapping.lid) : void 0;
        let pn = mapping.pn ? this.normalizeJid(mapping.pn) : void 0;
        const phone = mapping.phone;
        if (!lid || (!pn && !phone)) {
            return;
        }
        if (!pn && phone) {
            pn = `${phone}@s.whatsapp.net`;
        }
        if (!lid || !pn)
            return;
        if (!lid.endsWith('@lid'))
            return;
        if (!pn.endsWith('@s.whatsapp.net'))
            return;
        const existing = this.lidToPn.get(lid);
        if (existing) {
            existing.seenCount++;
            existing.learnedAt = Date.now();
            return;
        }
        const extractedPhone = phone || pn.split('@')[0];
        const newMapping = {
            lid,
            pn,
            phone: extractedPhone,
            learnedAt: Date.now(),
            seenCount: 1
        };
        if (this.lidToPn.size >= this.config.maxEntries) {
            this.evictLRU();
        }
        this.lidToPn.set(lid, newMapping);
        this.pnToLid.set(pn, lid);
        this.stats.learnedFromEvents++;
        if (this.persistence?.save) {
            void this.flush();
        }
    }
    resolveCanonical(jid) {
        const normalized = this.normalizeJid(jid);
        if (this.config.canonical === 'pn') {
            if (normalized.endsWith('@lid')) {
                const mapping = this.lidToPn.get(normalized);
                if (mapping) {
                    this.stats.lookupsServed++;
                    mapping.learnedAt = Date.now();
                    return mapping.pn;
                }
                this.stats.lookupMisses++;
                return jid;
            }
            this.stats.lookupsServed++;
            return normalized;
        }
        else {
            if (normalized.endsWith('@s.whatsapp.net')) {
                const lid = this.pnToLid.get(normalized);
                if (lid) {
                    this.stats.lookupsServed++;
                    const mapping = this.lidToPn.get(lid);
                    if (mapping) {
                        mapping.learnedAt = Date.now();
                    }
                    return lid;
                }
                this.stats.lookupMisses++;
                return jid;
            }
            this.stats.lookupsServed++;
            return normalized;
        }
    }
    getLid(pn) {
        const normalized = this.normalizeJid(pn);
        const lid = this.pnToLid.get(normalized);
        if (lid) {
            const mapping = this.lidToPn.get(lid);
            if (mapping) {
                mapping.learnedAt = Date.now();
            }
        }
        return lid || null;
    }
    getPn(lid) {
        const normalized = this.normalizeJid(lid);
        const mapping = this.lidToPn.get(normalized);
        if (mapping) {
            mapping.learnedAt = Date.now();
            return mapping.pn;
        }
        return null;
    }
    getMapping(jid) {
        const normalized = this.normalizeJid(jid);
        const byLid = this.lidToPn.get(normalized);
        if (byLid) {
            byLid.learnedAt = Date.now();
            return byLid;
        }
        const lid = this.pnToLid.get(normalized);
        if (lid) {
            const mapping = this.lidToPn.get(lid);
            if (mapping) {
                mapping.learnedAt = Date.now();
                return mapping;
            }
        }
        return null;
    }
    async hydrate() {
        if (!this.persistence?.load)
            return;
        try {
            const stored = await this.persistence.load();
            if (!stored || typeof stored !== 'object')
                return;
            for (const [lid, serialized] of Object.entries(stored)) {
                if (typeof serialized === 'string') {
                    const pn = serialized;
                    const phone = pn.split('@')[0];
                    const mapping = {
                        lid,
                        pn,
                        phone,
                        learnedAt: Date.now(),
                        seenCount: 1
                    };
                    this.lidToPn.set(lid, mapping);
                    this.pnToLid.set(pn, lid);
                }
                else if (typeof serialized === 'object' && serialized !== null) {
                    const mapping = serialized;
                    this.lidToPn.set(lid, mapping);
                    this.pnToLid.set(mapping.pn, lid);
                }
            }
        }
        catch (error) { }
    }
    async flush() {
        if (!this.persistence?.save)
            return;
        try {
            const toStore = {};
            for (const [lid, mapping] of this.lidToPn.entries()) {
                toStore[lid] = mapping;
            }
            await this.persistence.save(toStore);
        }
        catch (error) { }
    }
    getStats() {
        return {
            totalMappings: this.lidToPn.size,
            learnedFromEvents: this.stats.learnedFromEvents,
            lookupsServed: this.stats.lookupsServed,
            lookupMisses: this.stats.lookupMisses,
            canonicalForm: this.config.canonical
        };
    }
    reset() {
        this.lidToPn.clear();
        this.pnToLid.clear();
        this.stats = {
            learnedFromEvents: 0,
            lookupsServed: 0,
            lookupMisses: 0
        };
    }
    destroy() {
        this.reset();
        if (this.persistence?.save) {
            void this.flush();
        }
    }
    normalizeJid(jid) {
        return jid.replace(/:\d+@/, '@');
    }
    evictLRU() {
        let oldestLid = null;
        let oldestTime = Infinity;
        for (const [lid, mapping] of this.lidToPn.entries()) {
            if (mapping.learnedAt < oldestTime) {
                oldestTime = mapping.learnedAt;
                oldestLid = lid;
            }
        }
        if (oldestLid) {
            const mapping = this.lidToPn.get(oldestLid);
            if (mapping) {
                this.pnToLid.delete(mapping.pn);
            }
            this.lidToPn.delete(oldestLid);
        }
    }
};
var DEFAULT_CONFIG11 = {
    enabled: false,
    canonicalizeOutbound: true,
    learnFromEvents: true
};
var JidCanonicalizer = class {
    config;
    lidResolver;
    ownsResolver;
    stats = {
        outboundCanonicalized: 0,
        outboundPassthrough: 0,
        inboundLearned: 0,
        canonicalKeyHits: 0,
        canonicalKeyMisses: 0
    };
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG11, ...config };
        if (config.resolver) {
            this.lidResolver = config.resolver;
            this.ownsResolver = false;
        }
        else {
            this.lidResolver = new LidResolver(config.resolverConfig);
            this.ownsResolver = true;
        }
    }
    get resolver() {
        return this.lidResolver;
    }
    canonicalizeTarget(jid) {
        if (!this.config.enabled || !this.config.canonicalizeOutbound) {
            return jid;
        }
        const canonical = this.lidResolver.resolveCanonical(jid);
        if (canonical !== jid) {
            this.stats.outboundCanonicalized++;
        }
        else {
            this.stats.outboundPassthrough++;
        }
        return canonical;
    }
    canonicalKey(jid) {
        if (!jid || typeof jid !== 'string' || jid.trim() === '') {
            return 'thread:invalid';
        }
        const normalized = jid.trim().toLowerCase();
        const atIndex = normalized.indexOf('@');
        if (atIndex === -1) {
            return 'thread:invalid';
        }
        const user = normalized.substring(0, atIndex);
        const domain = normalized.substring(atIndex + 1);
        if (domain === 'g.us') {
            return `thread:group:${user}`;
        }
        if (domain === 'broadcast') {
            return `thread:broadcast:${user}`;
        }
        if (domain === 'newsletter') {
            return `thread:newsletter:${user}`;
        }
        if (domain === 's.whatsapp.net') {
            this.stats.canonicalKeyHits++;
            return `thread:${user}`;
        }
        if (domain === 'lid') {
            const mapping = this.lidResolver.getMapping(normalized);
            if (mapping?.pn) {
                const pnUser = mapping.pn.split('@')[0];
                this.stats.canonicalKeyHits++;
                return `thread:${pnUser}`;
            }
            else {
                this.stats.canonicalKeyMisses++;
                return `thread:lid:${user}`;
            }
        }
        return `thread:${domain}:${user}`;
    }
    onIncomingEvent(upsert) {
        if (!this.config.enabled || !this.config.learnFromEvents) {
            return;
        }
        for (const msg of upsert.messages || []) {
            this.learnFromMessage(msg);
        }
    }
    onMessageUpdate(updates) {
        if (!this.config.enabled || !this.config.learnFromEvents) {
            return;
        }
        for (const update of updates) {
            if (update.key) {
                this.learnFromMessageKey(update.key);
            }
        }
    }
    getStats() {
        return {
            resolver: this.lidResolver.getStats(),
            outboundCanonicalized: this.stats.outboundCanonicalized,
            outboundPassthrough: this.stats.outboundPassthrough,
            inboundLearned: this.stats.inboundLearned,
            canonicalKeyHits: this.stats.canonicalKeyHits,
            canonicalKeyMisses: this.stats.canonicalKeyMisses
        };
    }
    destroy() {
        if (this.ownsResolver) {
            this.lidResolver.destroy();
        }
    }
    learnFromMessage(msg) {
        if (!msg.key)
            return;
        this.learnFromMessageKey(msg.key);
        if (msg.participantPn && msg.key.participant) {
            this.lidResolver.learn({
                lid: msg.key.participant.endsWith('@lid') ? msg.key.participant : void 0,
                pn: msg.participantPn
            });
            this.stats.inboundLearned++;
        }
    }
    learnFromMessageKey(key) {
        if (!key)
            return;
        if (key.participant && key.participantPn) {
            if (key.participant.endsWith('@lid')) {
                this.lidResolver.learn({
                    lid: key.participant,
                    pn: key.participantPn
                });
                this.stats.inboundLearned++;
            }
        }
        if (key.remoteJid && key.senderPn) {
            if (key.remoteJid.endsWith('@lid')) {
                this.lidResolver.learn({
                    lid: key.remoteJid,
                    pn: key.senderPn
                });
                this.stats.inboundLearned++;
            }
        }
        if (key.participant && key.remoteJid) {
            if (key.participant.endsWith('@s.whatsapp.net') && key.remoteJid.endsWith('@lid')) {
                this.lidResolver.learn({
                    lid: key.remoteJid,
                    pn: key.participant
                });
                this.stats.inboundLearned++;
            }
        }
    }
};
function classifyDisconnect(statusCode) {
    if (statusCode === 401 || statusCode === 440) {
        return {
            category: 'fatal',
            shouldReconnect: false,
            message: 'Logged out \u2014 restart with QR code required',
            code: statusCode
        };
    }
    if (statusCode === 515) {
        return {
            category: 'fatal',
            shouldReconnect: false,
            message: 'Restart required by WhatsApp \u2014 client too old or protocol mismatch',
            code: statusCode
        };
    }
    if (statusCode === 405) {
        return {
            category: 'fatal',
            shouldReconnect: false,
            message: 'Method not allowed \u2014 server rejected connection method',
            code: statusCode
        };
    }
    if (statusCode === 409 || statusCode === 428) {
        return {
            category: 'fatal',
            shouldReconnect: false,
            message: 'Connection replaced \u2014 another device took over',
            code: statusCode
        };
    }
    if (statusCode === 412) {
        return {
            category: 'recoverable',
            shouldReconnect: true,
            backoffMs: 3e4,
            message: 'Precondition failed \u2014 auth state mismatch, retry after delay',
            code: statusCode
        };
    }
    if (statusCode === 429) {
        return {
            category: 'rate-limited',
            shouldReconnect: true,
            backoffMs: 3e5,
            message: 'Rate limited by WhatsApp \u2014 cool-off period required',
            code: statusCode
        };
    }
    if (statusCode === 503) {
        return {
            category: 'rate-limited',
            shouldReconnect: true,
            backoffMs: 6e4,
            message: 'WhatsApp service unavailable \u2014 temporary outage',
            code: statusCode
        };
    }
    if (statusCode === 408) {
        return {
            category: 'recoverable',
            shouldReconnect: true,
            backoffMs: 5e3,
            message: 'Connection timeout \u2014 network issue, safe to retry',
            code: statusCode
        };
    }
    if (statusCode === 500) {
        return {
            category: 'recoverable',
            shouldReconnect: true,
            backoffMs: 1e4,
            message: 'WhatsApp internal error \u2014 temporary server issue',
            code: statusCode
        };
    }
    if (statusCode === 1e3) {
        return {
            category: 'recoverable',
            shouldReconnect: true,
            backoffMs: 2e3,
            message: 'Connection closed gracefully \u2014 safe to reconnect',
            code: statusCode
        };
    }
    return {
        category: 'unknown',
        shouldReconnect: true,
        backoffMs: 15e3,
        message: `Unknown disconnect reason (code ${statusCode}) \u2014 reconnect with caution`,
        code: statusCode
    };
}
var DEFAULT_HEALTH_CONFIG = {
    badMacThreshold: 3,
    badMacWindowMs: 6e4
};
var SessionHealthMonitor = class {
    config;
    onDegraded;
    onRecovered;
    stats = {
        decryptSuccess: 0,
        decryptFail: 0,
        badMacCount: 0,
        isDegraded: false
    };
    badMacTimestamps = [];
    constructor(config = {}) {
        this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
        this.onDegraded = config.onDegraded;
        this.onRecovered = config.onRecovered;
    }
    recordDecryptSuccess() {
        this.stats.decryptSuccess++;
        this.checkRecovery();
    }
    recordDecryptFail(isBadMac = false) {
        this.stats.decryptFail++;
        if (isBadMac) {
            const now = Date.now();
            this.stats.badMacCount++;
            this.stats.lastBadMac = new Date(now);
            this.badMacTimestamps.push(now);
            const cutoff = now - this.config.badMacWindowMs;
            this.badMacTimestamps = this.badMacTimestamps.filter(ts => ts > cutoff);
            if (!this.stats.isDegraded && this.badMacTimestamps.length >= this.config.badMacThreshold) {
                this.stats.isDegraded = true;
                this.stats.degradedSince = new Date(now);
                this.onDegraded?.(this.getStats());
            }
        }
    }
    checkRecovery() {
        if (!this.stats.isDegraded)
            return;
        const now = Date.now();
        const cutoff = now - this.config.badMacWindowMs;
        this.badMacTimestamps = this.badMacTimestamps.filter(ts => ts > cutoff);
        if (this.badMacTimestamps.length < this.config.badMacThreshold) {
            this.stats.isDegraded = false;
            this.stats.degradedSince = void 0;
            this.onRecovered?.(this.getStats());
        }
    }
    getStats() {
        return { ...this.stats };
    }
    reset() {
        this.stats = {
            decryptSuccess: 0,
            decryptFail: 0,
            badMacCount: 0,
            isDegraded: false
        };
        this.badMacTimestamps = [];
    }
};
function wrapWithSessionStability(sock, config = {}) {
    const { canonicalJidNormalization = true, healthMonitoring = true, health: healthConfig, lidResolver } = config;
    const healthMonitor = healthMonitoring ? new SessionHealthMonitor(healthConfig) : null;
    return new Proxy(sock, {
        get(target, prop) {
            if (prop === 'sendMessage' && canonicalJidNormalization && lidResolver) {
                return async (jid, content, options) => {
                    const canonical = lidResolver.resolveCanonical(jid);
                    return target.sendMessage(canonical, content, options);
                };
            }
            if (prop === 'sessionHealthStats' && healthMonitor) {
                return healthMonitor.getStats();
            }
            if (prop === 'sessionHealthMonitor' && healthMonitor) {
                return healthMonitor;
            }
            return target[prop];
        }
    });
}
var PRESETS = {
    conservative: {
        maxPerMinute: 5,
        maxPerHour: 100,
        maxPerDay: 800,
        minDelayMs: 2500,
        maxDelayMs: 7e3,
        newChatDelayMs: 4e3,
        warmupDays: 10,
        day1Limit: 15,
        growthFactor: 1.8,
        inactivityThresholdHours: 72,
        autoPauseAt: 'medium',
        groupMultiplier: 0.5,
        groupProfiles: false,
        logging: true
    },
    moderate: {
        maxPerMinute: 10,
        maxPerHour: 300,
        maxPerDay: 1500,
        minDelayMs: 1500,
        maxDelayMs: 5e3,
        newChatDelayMs: 3e3,
        warmupDays: 7,
        day1Limit: 20,
        growthFactor: 1.8,
        inactivityThresholdHours: 72,
        autoPauseAt: 'high',
        groupMultiplier: 0.7,
        groupProfiles: false,
        logging: true
    },
    aggressive: {
        maxPerMinute: 20,
        maxPerHour: 800,
        maxPerDay: 4e3,
        minDelayMs: 800,
        maxDelayMs: 3e3,
        newChatDelayMs: 2e3,
        warmupDays: 4,
        day1Limit: 35,
        growthFactor: 2,
        inactivityThresholdHours: 48,
        autoPauseAt: 'critical',
        groupMultiplier: 0.9,
        groupProfiles: false,
        logging: true
    }
};
function resolveConfig(input) {
    if (input === void 0) {
        return { ...PRESETS.conservative };
    }
    if (typeof input === 'string') {
        if (!(input in PRESETS)) {
            throw new Error(`Unknown preset "${input}". Valid: ${Object.keys(PRESETS).join(', ')}`);
        }
        return { ...PRESETS[input] };
    }
    const { preset = 'conservative', ...overrides } = input;
    if (!(preset in PRESETS)) {
        throw new Error(`Unknown preset "${preset}". Valid: ${Object.keys(PRESETS).join(', ')}`);
    }
    return { ...PRESETS[preset], ...overrides };
}
var KNOWN_CHATS_MAX = 1e3;
var DEBOUNCE_MS = 5e3;
var StateManager = class {
    path;
    debounceTimer = null;
    constructor(filePath) {
        this.path = filePath;
    }
    load() {
        try {
            const raw = fs.readFileSync(this.path, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed.version !== 3) {
                process.stderr.write('[baileys-antiban] WARN: corrupt state file or version mismatch, starting fresh\n');
                return null;
            }
            return parsed;
        }
        catch {
            if (fs.existsSync(this.path)) {
                process.stderr.write('[baileys-antiban] WARN: corrupt state file, starting fresh\n');
            }
            return null;
        }
    }
    saveDebounced(state) {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.writeFile(state);
            this.debounceTimer = null;
        }, DEBOUNCE_MS);
    }
    saveImmediate(state) {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.writeFile(state);
    }
    flush() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }
    destroy() {
        this.flush();
    }
    writeFile(state) {
        const toSave = {
            ...state,
            savedAt: Date.now(),
            knownChats: state.knownChats.length > KNOWN_CHATS_MAX ? state.knownChats.slice(-KNOWN_CHATS_MAX) : state.knownChats
        };
        try {
            fs.writeFileSync(this.path, JSON.stringify(toSave, null, 2), 'utf-8');
        }
        catch (err) {
            process.stderr.write(`[baileys-antiban] WARN: failed to write state to ${this.path}: ${err}\n`);
        }
    }
};
function isGroup(jid) {
    return jid.endsWith('@g.us');
}
function isNewsletter(jid) {
    return jid.endsWith('@newsletter');
}
function isBroadcast(jid) {
    return jid === 'status@broadcast' || jid.endsWith('@broadcast');
}
function shouldUseGroupProfile(jid) {
    return isGroup(jid) || isNewsletter(jid);
}
function applyGroupMultiplier(limits, multiplier) {
    return {
        maxPerMinute: Math.max(1, Math.floor(limits.maxPerMinute * multiplier)),
        maxPerHour: Math.max(1, Math.floor(limits.maxPerHour * multiplier)),
        maxPerDay: Math.max(1, Math.floor(limits.maxPerDay * multiplier))
    };
}
function isLegacyConfig(cfg) {
    if (typeof cfg !== 'object' || cfg === null)
        return false;
    return ('rateLimiter' in cfg ||
        'warmUp' in cfg ||
        'health' in cfg ||
        'timelock' in cfg ||
        'replyRatio' in cfg ||
        'contactGraph' in cfg ||
        'presence' in cfg ||
        'retryTracker' in cfg ||
        'reconnectThrottle' in cfg ||
        'lidResolver' in cfg ||
        'jidCanonicalizer' in cfg ||
        'sessionStability' in cfg);
}
function mapLegacyToFlat(legacy) {
    process.stderr.write('[baileys-antiban] DEPRECATED: Nested config (v2 style) detected. Migrate to flat config: new AntiBan({ maxPerMinute: 8 }).\n');
    const flat = {};
    if (legacy.rateLimiter?.maxPerMinute !== void 0)
        flat.maxPerMinute = legacy.rateLimiter.maxPerMinute;
    if (legacy.rateLimiter?.maxPerHour !== void 0)
        flat.maxPerHour = legacy.rateLimiter.maxPerHour;
    if (legacy.rateLimiter?.maxPerDay !== void 0)
        flat.maxPerDay = legacy.rateLimiter.maxPerDay;
    if (legacy.rateLimiter?.minDelayMs !== void 0)
        flat.minDelayMs = legacy.rateLimiter.minDelayMs;
    if (legacy.rateLimiter?.maxDelayMs !== void 0)
        flat.maxDelayMs = legacy.rateLimiter.maxDelayMs;
    if (legacy.rateLimiter?.newChatDelayMs !== void 0)
        flat.newChatDelayMs = legacy.rateLimiter.newChatDelayMs;
    if (legacy.warmUp?.warmUpDays !== void 0)
        flat.warmupDays = legacy.warmUp.warmUpDays;
    if (legacy.warmUp?.day1Limit !== void 0)
        flat.day1Limit = legacy.warmUp.day1Limit;
    if (legacy.warmUp?.growthFactor !== void 0)
        flat.growthFactor = legacy.warmUp.growthFactor;
    if (legacy.logging !== void 0)
        flat.logging = legacy.logging;
    return flat;
}
var AntiBan = class {
    rateLimiter;
    warmUp;
    health;
    timelockGuard;
    replyRatioGuard;
    contactGraphWarmer;
    presenceChoreographer;
    retryTrackerModule;
    reconnectThrottleModule;
    lidResolverModule = null;
    jidCanonicalizerModule = null;
    sessionStabilityMonitor = null;
    stateManager = null;
    resolvedConfig;
    logging;
    stats = {
        messagesAllowed: 0,
        messagesBlocked: 0,
        totalDelayMs: 0
    };
    constructor(input, warmUpStateArg) {
        let flatConfig;
        let legacyPassthrough = null;
        let warmUpState = warmUpStateArg;
        if (isLegacyConfig(input)) {
            legacyPassthrough = input;
            flatConfig = mapLegacyToFlat(legacyPassthrough);
        }
        else {
            flatConfig = {};
            legacyPassthrough = null;
        }
        const cfg = isLegacyConfig(input) ? resolveConfig(flatConfig) : resolveConfig(input);
        this.resolvedConfig = cfg;
        let savedState = null;
        if (cfg.persist) {
            this.stateManager = new StateManager(cfg.persist);
            savedState = this.stateManager.load();
            if (savedState) {
                warmUpState = savedState.warmup;
            }
        }
        this.logging = cfg.logging ?? true;
        this._log = (msg) => { if (this.logging)
            process.stdout.write(`[antiban] ${msg}\n`); };
        this.rateLimiter = new RateLimiter({
            maxPerMinute: cfg.maxPerMinute,
            maxPerHour: cfg.maxPerHour,
            maxPerDay: cfg.maxPerDay,
            minDelayMs: cfg.minDelayMs,
            maxDelayMs: cfg.maxDelayMs,
            newChatDelayMs: cfg.newChatDelayMs,
            ...(legacyPassthrough?.rateLimiter || {})
        });
        if (savedState?.knownChats) {
            this.rateLimiter.restoreKnownChats(savedState.knownChats);
        }
        this.warmUp = new WarmUp({
            warmUpDays: cfg.warmupDays,
            day1Limit: cfg.day1Limit,
            growthFactor: cfg.growthFactor,
            inactivityThresholdHours: cfg.inactivityThresholdHours,
            ...(legacyPassthrough?.warmUp || {})
        }, warmUpState);
        this.health = new HealthMonitor({
            autoPauseAt: cfg.autoPauseAt,
            ...(legacyPassthrough?.health || {}),
            onRiskChange: status => {
                const emoji = { low: '\u{1F7E2}', medium: '\u{1F7E1}', high: '\u{1F7E0}', critical: '\u{1F534}' };
                this._log(`${emoji[status.risk]} Risk level: ${status.risk.toUpperCase()} (score: ${status.score})`);
                this._log(status.recommendation);
                status.reasons.forEach(r => this._log(`  \u2192 ${r}`));
                legacyPassthrough?.health?.onRiskChange?.(status);
            }
        });
        this.timelockGuard = new TimelockGuard({
            ...(legacyPassthrough?.timelock || {}),
            onTimelockDetected: state => {
                this.health.recordReachoutTimelock(state.enforcementType);
                this._log(`REACHOUT TIMELOCKED \u2014 ${state.enforcementType || 'unknown'}, expires ${state.expiresAt?.toISOString() || 'unknown'}`);
                legacyPassthrough?.timelock?.onTimelockDetected?.(state);
            },
            onTimelockLifted: state => {
                this._log('Timelock lifted \u2014 resuming new contact messages');
                legacyPassthrough?.timelock?.onTimelockLifted?.(state);
            }
        });
        this.replyRatioGuard = new ReplyRatioGuard(legacyPassthrough?.replyRatio);
        this.contactGraphWarmer = new ContactGraphWarmer(legacyPassthrough?.contactGraph);
        this.presenceChoreographer = new PresenceChoreographer(legacyPassthrough?.presence);
        this.retryTrackerModule = new RetryReasonTracker({
            ...(legacyPassthrough?.retryTracker || {}),
            onSpiral: (msgId, reason) => {
                this._log(`\u26A0\uFE0F  Message ${msgId} stuck in retry spiral (${reason})`);
                legacyPassthrough?.retryTracker?.onSpiral?.(msgId, reason);
            }
        });
        this.reconnectThrottleModule = new PostReconnectThrottle({
            ...(legacyPassthrough?.reconnectThrottle || {}),
            baselineRatePerMinute: () => this.rateLimiter.getStats().limits.perMinute
        });
        if (legacyPassthrough?.jidCanonicalizer?.enabled) {
            if (legacyPassthrough.jidCanonicalizer.resolver) {
                this.jidCanonicalizerModule = new JidCanonicalizer(legacyPassthrough.jidCanonicalizer);
                this.lidResolverModule = legacyPassthrough.jidCanonicalizer.resolver;
            }
            else {
                const resolverConfig = legacyPassthrough.lidResolver || legacyPassthrough.jidCanonicalizer.resolverConfig;
                const resolver = new LidResolver(resolverConfig);
                this.lidResolverModule = resolver;
                this.jidCanonicalizerModule = new JidCanonicalizer({
                    ...legacyPassthrough.jidCanonicalizer,
                    resolver
                });
            }
        }
        else if (legacyPassthrough?.lidResolver) {
            this.lidResolverModule = new LidResolver(legacyPassthrough.lidResolver);
        }
        if (legacyPassthrough?.sessionStability?.enabled) {
            const healthConfig = {
                badMacThreshold: legacyPassthrough.sessionStability.badMacThreshold,
                badMacWindowMs: legacyPassthrough.sessionStability.badMacWindowMs,
                onDegraded: stats => {
                    this._log(`\u{1F534} SESSION DEGRADED \u2014 Bad MAC rate: ${stats.badMacCount} in last ${legacyPassthrough?.sessionStability?.badMacWindowMs || 6e4}ms`);
                    this._log('Consider restarting session or switching to LID-based canonical form');
                },
                onRecovered: () => {
                    this._log('\u{1F7E2} SESSION RECOVERED \u2014 decrypt success rate improved');
                }
            };
            this.sessionStabilityMonitor = new SessionHealthMonitor(healthConfig);
        }
    }
    async beforeSend(recipient, content) {
        const healthStatus = this.health.getStatus();
        if (this.health.isPaused()) {
            this.stats.messagesBlocked++;
            this._log(`\u26D4 BLOCKED \u2014 health risk too high (${healthStatus.risk})`);
            return {
                allowed: false,
                delayMs: 0,
                reason: `Health risk ${healthStatus.risk}: ${healthStatus.recommendation}`,
                health: healthStatus
            };
        }
        const timelockDecision = this.timelockGuard.canSend(recipient);
        if (!timelockDecision.allowed) {
            this.stats.messagesBlocked++;
            this._log(`TIMELOCKED \u2014 ${timelockDecision.reason}`);
            return {
                allowed: false,
                delayMs: 0,
                reason: timelockDecision.reason,
                health: healthStatus
            };
        }
        if (!this.warmUp.canSend()) {
            this.stats.messagesBlocked++;
            const warmUpStatus = this.warmUp.getStatus();
            this._log(`\u23F3 BLOCKED \u2014 warm-up day ${warmUpStatus.day}/${warmUpStatus.totalDays}, limit reached (${warmUpStatus.todaySent}/${warmUpStatus.todayLimit})`);
            return {
                allowed: false,
                delayMs: 0,
                reason: `Warm-up limit: ${warmUpStatus.todaySent}/${warmUpStatus.todayLimit} messages today (day ${warmUpStatus.day})`,
                health: healthStatus,
                warmUpDay: warmUpStatus.day
            };
        }
        const contactGraphDecision = this.contactGraphWarmer.canMessage(recipient);
        if (!contactGraphDecision.allowed) {
            this.stats.messagesBlocked++;
            this._log(`\u{1F4CA} BLOCKED \u2014 contact graph: ${contactGraphDecision.reason}`);
            return {
                allowed: false,
                delayMs: 0,
                reason: `Contact graph: ${contactGraphDecision.reason}`,
                health: healthStatus
            };
        }
        const replyRatioDecision = this.replyRatioGuard.beforeSend(recipient);
        if (!replyRatioDecision.allowed) {
            this.stats.messagesBlocked++;
            this._log(`\u{1F4AC} BLOCKED \u2014 reply ratio: ${replyRatioDecision.reason}`);
            return {
                allowed: false,
                delayMs: 0,
                reason: `Reply ratio: ${replyRatioDecision.reason}`,
                health: healthStatus
            };
        }
        const reconnectThrottleDecision = this.reconnectThrottleModule.beforeSend();
        if (!reconnectThrottleDecision.allowed) {
            this.stats.messagesBlocked++;
            this._log(`\u{1F504} BLOCKED \u2014 reconnect throttle: ${reconnectThrottleDecision.reason}`);
            return {
                allowed: false,
                delayMs: reconnectThrottleDecision.retryAfterMs || 0,
                reason: reconnectThrottleDecision.reason || 'Post-reconnect throttle',
                health: healthStatus
            };
        }
        if (this.resolvedConfig.groupProfiles && shouldUseGroupProfile(recipient)) {
            const groupLimits = applyGroupMultiplier({
                maxPerMinute: this.resolvedConfig.maxPerMinute,
                maxPerHour: this.resolvedConfig.maxPerHour,
                maxPerDay: this.resolvedConfig.maxPerDay
            }, this.resolvedConfig.groupMultiplier);
            const stats = this.rateLimiter.getStats();
            if (stats.lastMinute >= groupLimits.maxPerMinute ||
                stats.lastHour >= groupLimits.maxPerHour ||
                stats.lastDay >= groupLimits.maxPerDay) {
                this.stats.messagesBlocked++;
                this._log(`\u{1F6AB} BLOCKED \u2014 group rate limit exceeded for ${recipient}`);
                return { allowed: false, delayMs: 0, reason: 'Group rate limit exceeded', health: healthStatus };
            }
        }
        let delay = await this.rateLimiter.getDelay(recipient, content);
        if (delay === -1) {
            this.stats.messagesBlocked++;
            this._log(`\u{1F6AB} BLOCKED \u2014 rate limit or identical message spam`);
            return {
                allowed: false,
                delayMs: 0,
                reason: 'Rate limit exceeded or identical message spam detected',
                health: healthStatus
            };
        }
        const activityFactor = this.presenceChoreographer.getCurrentActivityFactor();
        if (activityFactor < 1) {
            const multiplier = Math.min(5, 1 / activityFactor);
            delay = Math.floor(delay * multiplier);
        }
        const distractionCheck = this.presenceChoreographer.shouldPauseForDistraction();
        if (distractionCheck.pause) {
            delay += distractionCheck.durationMs;
            this._log(`\u23F8\uFE0F  Distraction pause: +${Math.floor(distractionCheck.durationMs / 6e4)}min`);
        }
        const offlineCheck = this.presenceChoreographer.shouldTakeOfflineGap();
        if (offlineCheck.offline) {
            delay += offlineCheck.durationMs;
            this._log(`\u{1F4F4} Offline gap: +${Math.floor(offlineCheck.durationMs / 6e4)}min`);
        }
        this.stats.totalDelayMs += delay;
        return {
            allowed: true,
            delayMs: delay,
            health: healthStatus
        };
    }
    afterSend(recipient, content) {
        this.rateLimiter.record(recipient, content);
        this.warmUp.record();
        this.replyRatioGuard.recordSent(recipient);
        this.stats.messagesAllowed++;
        this.persistStateDebounced();
    }
    afterSendFailed(error) {
        this.health.recordMessageFailed(error);
    }
    onDisconnect(reason) {
        this.health.recordDisconnect(reason);
        this.reconnectThrottleModule.onDisconnect();
        const reasonStr = String(reason);
        if (reasonStr === '403' || reasonStr === '401' || reasonStr === 'forbidden' || reasonStr === 'loggedOut') {
            this.persistStateImmediate();
        }
    }
    onReconnect() {
        this.health.recordReconnect();
        this.reconnectThrottleModule.onReconnect();
    }
    onIncomingMessage(jid, msgText) {
        this.replyRatioGuard.recordReceived(jid);
        this.contactGraphWarmer.onIncomingMessage(jid);
        return this.replyRatioGuard.suggestReply(jid, msgText);
    }
    getStats() {
        const stats = {
            ...this.stats,
            health: this.health.getStatus(),
            warmUp: this.warmUp.getStatus(),
            rateLimiter: this.rateLimiter.getStats()
        };
        if (this.replyRatioGuard['config']?.enabled) {
            stats.replyRatio = this.replyRatioGuard.getStats();
        }
        if (this.contactGraphWarmer['config']?.enabled) {
            stats.contactGraph = this.contactGraphWarmer.getStats();
        }
        if (this.presenceChoreographer['config']?.enabled) {
            stats.presence = this.presenceChoreographer.getStats();
        }
        if (this.retryTrackerModule['config']?.enabled) {
            stats.retryTracker = this.retryTrackerModule.getStats();
        }
        if (this.reconnectThrottleModule['config']?.enabled) {
            stats.reconnectThrottle = this.reconnectThrottleModule.getStats();
        }
        if (this.lidResolverModule) {
            stats.lidResolver = this.lidResolverModule.getStats();
        }
        if (this.jidCanonicalizerModule) {
            stats.jidCanonicalizer = this.jidCanonicalizerModule.getStats();
        }
        if (this.sessionStabilityMonitor) {
            stats.sessionStability = this.sessionStabilityMonitor.getStats();
        }
        return stats;
    }
    get timelock() {
        return this.timelockGuard;
    }
    get replyRatio() {
        return this.replyRatioGuard;
    }
    get contactGraph() {
        return this.contactGraphWarmer;
    }
    get presence() {
        return this.presenceChoreographer;
    }
    get retryTracker() {
        return this.retryTrackerModule;
    }
    get reconnectThrottle() {
        return this.reconnectThrottleModule;
    }
    get lidResolver() {
        return this.lidResolverModule;
    }
    get jidCanonicalizer() {
        return this.jidCanonicalizerModule;
    }
    get sessionStability() {
        return this.sessionStabilityMonitor;
    }
    exportWarmUpState() {
        return this.warmUp.exportState();
    }
    pause() {
        this.health.setPaused(true);
        this._log('\u23F8\uFE0F  Sending paused manually');
    }
    resume() {
        this.health.setPaused(false);
        this._log('\u25B6\uFE0F  Sending resumed');
    }
    reset() {
        this.timelockGuard.reset();
        this.health.reset();
        this.warmUp.reset();
        this.replyRatioGuard.reset();
        this.contactGraphWarmer.reset();
        this.presenceChoreographer.reset();
        this.retryTrackerModule.destroy();
        this.reconnectThrottleModule.destroy();
        this.stats = { messagesAllowed: 0, messagesBlocked: 0, totalDelayMs: 0 };
        this._log('\u{1F504} Reset \u2014 starting fresh warm-up');
    }
    persistStateDebounced() {
        if (!this.stateManager)
            return;
        const state = {
            warmup: this.warmUp.exportState(),
            knownChats: Array.from(this.rateLimiter.getKnownChats()),
            savedAt: Date.now(),
            version: 3
        };
        this.stateManager.saveDebounced(state);
    }
    persistStateImmediate() {
        if (!this.stateManager)
            return;
        const state = {
            warmup: this.warmUp.exportState(),
            knownChats: Array.from(this.rateLimiter.getKnownChats()),
            savedAt: Date.now(),
            version: 3
        };
        this.stateManager.saveImmediate(state);
    }
    destroy() {
        this.stateManager?.destroy();
        this.timelockGuard.reset();
        this.replyRatioGuard.reset();
        this.contactGraphWarmer.reset();
        this.presenceChoreographer.reset();
        this.retryTrackerModule.destroy();
        this.reconnectThrottleModule.destroy();
        this.jidCanonicalizerModule?.destroy();
        this.lidResolverModule?.destroy();
        this.sessionStabilityMonitor?.reset();
        this._log('\u{1F9F9} Destroyed \u2014 all timers cleared');
    }
};
var LidFirstResolver = class {
    lidToPhone = new Map();
    phoneToLid = new Map();
    loadFromAuthDir(authDir) {
        try {
            if (!fs2.existsSync(authDir)) {
                return;
            }
            const files = fs2.readdirSync(authDir);
            const reverseMappingFiles = files.filter(f => f.startsWith('lid-mapping-') && f.endsWith('_reverse.json'));
            for (const file of reverseMappingFiles) {
                const filePath = path.join(authDir, file);
                const content = fs2.readFileSync(filePath, 'utf-8');
                const data = JSON.parse(content);
                for (const [lid, pnJid] of Object.entries(data)) {
                    if (typeof pnJid === 'string') {
                        const phone = this.extractPhone(pnJid);
                        if (phone && lid.endsWith('@lid')) {
                            const mapping = {
                                lid: this.normalizeLid(lid),
                                phone,
                                learnedAt: Date.now(),
                                source: 'auth-dir'
                            };
                            this.lidToPhone.set(mapping.lid, mapping);
                            this.phoneToLid.set(phone, mapping.lid);
                        }
                    }
                }
            }
        }
        catch (error) { }
    }
    learnFromEvent(event) {
        try {
            if (event.key?.remoteJid) {
                const jid = event.key.remoteJid;
                this.learnJid(jid, 'event');
            }
            if (event.key?.participant) {
                const jid = event.key.participant;
                this.learnJid(jid, 'event');
            }
            if (event.id) {
                this.learnJid(event.id, 'event');
            }
            if (event.pushName && event.key?.remoteJid) {
                this.learnJid(event.key.remoteJid, 'event');
            }
        }
        catch (error) { }
    }
    resolveToLID(phoneOrJid) {
        const phone = this.extractPhone(phoneOrJid);
        if (!phone)
            return null;
        return this.phoneToLid.get(phone) || null;
    }
    resolveToPhone(lid) {
        const normalized = this.normalizeLid(lid);
        const mapping = this.lidToPhone.get(normalized);
        return mapping ? mapping.phone : null;
    }
    getMapping(jid) {
        const normalized = this.normalizeLid(jid);
        const byLid = this.lidToPhone.get(normalized);
        if (byLid)
            return byLid;
        const phone = this.extractPhone(jid);
        if (phone) {
            const lid = this.phoneToLid.get(phone);
            if (lid)
                return this.lidToPhone.get(lid) || null;
        }
        return null;
    }
    size() {
        return this.lidToPhone.size;
    }
    clear() {
        this.lidToPhone.clear();
        this.phoneToLid.clear();
    }
    learnJid(_jid, _source) { }
    extractPhone(jid) {
        if (!jid)
            return null;
        let cleaned = jid.replace('@s.whatsapp.net', '');
        cleaned = cleaned.replace(/:\d+$/, '');
        if (/^\d+$/.test(cleaned)) {
            return cleaned;
        }
        return null;
    }
    normalizeLid(lid) {
        return lid.replace(/:\d+@/, '@');
    }
};
function createLidFirstResolver() {
    return new LidFirstResolver();
}
var MessageRetryReason;
(function (MessageRetryReason2) {
    MessageRetryReason2[(MessageRetryReason2['UnknownError'] = 0)] = 'UnknownError';
    MessageRetryReason2[(MessageRetryReason2['GenericError'] = 1)] = 'GenericError';
    MessageRetryReason2[(MessageRetryReason2['SignalErrorInvalidKeyId'] = 3)] = 'SignalErrorInvalidKeyId';
    MessageRetryReason2[(MessageRetryReason2['SignalErrorInvalidMessage'] = 4)] = 'SignalErrorInvalidMessage';
    MessageRetryReason2[(MessageRetryReason2['SignalErrorNoSession'] = 5)] = 'SignalErrorNoSession';
    MessageRetryReason2[(MessageRetryReason2['SignalErrorBadMac'] = 7)] = 'SignalErrorBadMac';
    MessageRetryReason2[(MessageRetryReason2['MessageExpired'] = 8)] = 'MessageExpired';
    MessageRetryReason2[(MessageRetryReason2['DecryptionError'] = 9)] = 'DecryptionError';
})(MessageRetryReason || (MessageRetryReason = {}));
var MAC_ERROR_CODES = new Set([
    MessageRetryReason.SignalErrorBadMac,
    MessageRetryReason.SignalErrorInvalidMessage,
    MessageRetryReason.SignalErrorNoSession,
    MessageRetryReason.SignalErrorInvalidKeyId
]);
function parseRetryReason(code) {
    if (code === void 0 || code === null) {
        return MessageRetryReason.UnknownError;
    }
    const n = typeof code === 'string' ? parseInt(code, 10) : code;
    if (isNaN(n)) {
        return MessageRetryReason.UnknownError;
    }
    if (Object.values(MessageRetryReason).includes(n)) {
        return n;
    }
    return MessageRetryReason.UnknownError;
}
function isMacError(reason) {
    return MAC_ERROR_CODES.has(reason);
}
function getRetryReasonDescription(reason) {
    switch (reason) {
        case MessageRetryReason.UnknownError:
            return 'Unknown error';
        case MessageRetryReason.GenericError:
            return 'Generic error';
        case MessageRetryReason.SignalErrorInvalidKeyId:
            return 'Invalid key ID \u2014 peer prekey rotated';
        case MessageRetryReason.SignalErrorInvalidMessage:
            return 'Invalid message format';
        case MessageRetryReason.SignalErrorNoSession:
            return 'No session \u2014 peer not initialized';
        case MessageRetryReason.SignalErrorBadMac:
            return 'Bad MAC \u2014 encryption session mismatch';
        case MessageRetryReason.MessageExpired:
            return 'Message expired \u2014 too old to decrypt';
        case MessageRetryReason.DecryptionError:
            return 'Decryption failed';
        default:
            return `Unknown reason code ${reason}`;
    }
}
function wrapSocket(sock, config, warmUpState, wrapOptions) {
    const antiban = new AntiBan(config, warmUpState);
    const options = {
        autoRespondToIncoming: false,
        ...wrapOptions
    };
    if (typeof sock.ev.process === 'function') {
        sock.ev.process(async (events) => {
            if (events['connection.update']) {
                const update = events['connection.update'];
                if (update.connection === 'close') {
                    const reason = update.lastDisconnect?.error?.output?.statusCode || 'unknown';
                    antiban.onDisconnect(reason);
                }
                if (update.connection === 'open') {
                    antiban.onReconnect();
                }
                if (update.reachoutTimeLock) {
                    antiban.timelock.onTimelockUpdate({
                        isActive: update.reachoutTimeLock.isActive,
                        timeEnforcementEnds: update.reachoutTimeLock.timeEnforcementEnds,
                        enforcementType: update.reachoutTimeLock.enforcementType
                    });
                }
            }
            if (events['messages.update']) {
                const updates = events['messages.update'];
                for (const update of updates) {
                    if (update?.update?.messageStubParameters) {
                        const params = update.update.messageStubParameters;
                        if (params.includes(463) || params.includes('463')) {
                            antiban.timelock.record463Error();
                        }
                    }
                    antiban.retryTracker.onMessageUpdate(update);
                }
                antiban.jidCanonicalizer?.onMessageUpdate(updates);
            }
            if (events['messages.upsert']) {
                const { messages } = events['messages.upsert'];
                antiban.jidCanonicalizer?.onIncomingEvent(events['messages.upsert']);
                for (const msg of messages || []) {
                    const jid = msg.key?.remoteJid;
                    if (!jid)
                        continue;
                    antiban.timelock.registerKnownChat(jid);
                    const isSelf = msg.key?.fromMe || false;
                    if (isSelf)
                        continue;
                    const msgText = msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        msg.message?.imageMessage?.caption ||
                        msg.message?.videoMessage?.caption ||
                        '';
                    const replySuggestion = antiban.onIncomingMessage(jid, msgText);
                    if (options.autoRespondToIncoming && replySuggestion.shouldReply && replySuggestion.suggestedText) {
                        const replyDelay = Math.floor(Math.random() * 12e3) + 3e3;
                        setTimeout(async () => {
                            try {
                                await sock.sendMessage(jid, { text: replySuggestion.suggestedText });
                            }
                            catch (error) { }
                        }, replyDelay);
                    }
                }
            }
        });
    }
    else {
        sock.ev.on('connection.update', update => {
            if (update.connection === 'close') {
                const reason = update.lastDisconnect?.error?.output?.statusCode || 'unknown';
                antiban.onDisconnect(reason);
            }
            if (update.connection === 'open') {
                antiban.onReconnect();
            }
            if (update.reachoutTimeLock) {
                antiban.timelock.onTimelockUpdate({
                    isActive: update.reachoutTimeLock.isActive,
                    timeEnforcementEnds: update.reachoutTimeLock.timeEnforcementEnds,
                    enforcementType: update.reachoutTimeLock.enforcementType
                });
            }
        });
        sock.ev.on('messages.update', updates => {
            for (const update of updates) {
                if (update?.update?.messageStubParameters) {
                    const params = update.update.messageStubParameters;
                    if (params.includes(463) || params.includes('463')) {
                        antiban.timelock.record463Error();
                    }
                }
                antiban.retryTracker.onMessageUpdate(update);
            }
            antiban.jidCanonicalizer?.onMessageUpdate(updates);
        });
        sock.ev.on('messages.upsert', upsert => {
            const { messages } = upsert;
            antiban.jidCanonicalizer?.onIncomingEvent(upsert);
            for (const msg of messages || []) {
                const jid = msg.key?.remoteJid;
                if (!jid)
                    continue;
                antiban.timelock.registerKnownChat(jid);
                const isSelf = msg.key?.fromMe || false;
                if (isSelf)
                    continue;
                const msgText = msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.imageMessage?.caption ||
                    msg.message?.videoMessage?.caption ||
                    '';
                const replySuggestion = antiban.onIncomingMessage(jid, msgText);
                if (options.autoRespondToIncoming && replySuggestion.shouldReply && replySuggestion.suggestedText) {
                    const replyDelay = Math.floor(Math.random() * 12e3) + 3e3;
                    setTimeout(async () => {
                        try {
                            await sock.sendMessage(jid, { text: replySuggestion.suggestedText });
                        }
                        catch (error) { }
                    }, replyDelay);
                }
            }
        });
    }
    const originalSendMessage = sock.sendMessage.bind(sock);
    const wrappedSendMessage = async (jid, content, options2) => {
        const canonicalJid = antiban.jidCanonicalizer?.canonicalizeTarget(jid) || jid;
        const text = content?.text || content?.caption || content?.image?.caption || '';
        const decision = await antiban.beforeSend(canonicalJid, text);
        if (!decision.allowed) {
            throw new Error(`[baileys-antiban] Message blocked: ${decision.reason}`);
        }
        if (decision.delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, decision.delayMs));
        }
        try {
            const result = await originalSendMessage(canonicalJid, content, options2);
            antiban.afterSend(canonicalJid, text);
            antiban.timelock.registerKnownChat(canonicalJid);
            if (result?.key?.id) {
                antiban.retryTracker.clear(result.key.id);
            }
            return result;
        }
        catch (error) {
            antiban.afterSendFailed(error instanceof Error ? error.message : String(error));
            throw error;
        }
    };
    // Plain spread, matching every other socket layer in this codebase
    // ({...sock, newMethod}) — NOT Object.create(sock). Object.create makes
    // sock's own properties (ev, query, every other layer's methods) live on
    // the PROTOTYPE of the wrapped object rather than as its own properties.
    // That's invisible here (property lookup still finds them), but any
    // later layer that does `{...wrapped}` (object spread only copies OWN
    // enumerable properties) would silently drop all of them — which is
    // exactly what happened to lib/Socket/message-builder.js before this
    // was fixed to use a flat spread instead.
    const wrapped = { ...sock, sendMessage: wrappedSendMessage, antiban };
    wrapped.antiban.destroy = antiban.destroy.bind(antiban);
    return wrapped;
}
var DEFAULT_CONFIG12 = {
    maxAttempts: 3,
    retryBaseDelayMs: 3e4,
    maxQueueSize: 1e3,
    priorityOrder: true
};
var MessageQueue = class extends import_events.EventEmitter {
    config;
    queue = [];
    processing = false;
    sendFn = null;
    drainTimer = null;
    idCounter = 0;
    constructor(config = {}) {
        super();
        this.config = { ...DEFAULT_CONFIG12, ...config };
    }
    setSendFunction(fn) {
        this.sendFn = fn;
    }
    add(recipient, content, options) {
        if (this.queue.length >= this.config.maxQueueSize) {
            throw new Error(`Queue full (${this.config.maxQueueSize} messages)`);
        }
        const id = `msg_${Date.now()}_${++this.idCounter}`;
        const message = {
            id,
            recipient,
            content,
            priority: options?.priority || 'normal',
            addedAt: Date.now(),
            attempts: 0,
            maxAttempts: this.config.maxAttempts,
            scheduledFor: options?.scheduledFor?.getTime(),
            metadata: options?.metadata
        };
        this.queue.push(message);
        this.sortQueue();
        this.emit('added', message);
        return id;
    }
    addBulk(recipients, content, options) {
        return recipients.map(r => this.add(r, content, options));
    }
    start(intervalMs = 1e3) {
        if (this.drainTimer)
            return;
        this.drainTimer = setInterval(() => this.processNext(), intervalMs);
        this.emit('started');
    }
    stop() {
        if (this.drainTimer) {
            clearInterval(this.drainTimer);
            this.drainTimer = null;
        }
        this.emit('stopped');
    }
    destroy() {
        this.stop();
    }
    async processNext() {
        if (this.processing || !this.sendFn)
            return;
        const now = Date.now();
        const message = this.queue.find(m => !m.scheduledFor || m.scheduledFor <= now);
        if (!message)
            return;
        this.processing = true;
        try {
            message.attempts++;
            await this.sendFn(message.recipient, message.content);
            this.queue = this.queue.filter(m => m.id !== message.id);
            this.emit('sent', message);
        }
        catch (err) {
            message.lastError = err.message;
            if (err.message?.includes('baileys-antiban')) {
                message.attempts--;
                this.emit('delayed', message, err.message);
            }
            else if (message.attempts >= message.maxAttempts) {
                this.queue = this.queue.filter(m => m.id !== message.id);
                this.emit('failed', message, err.message);
            }
            else {
                const backoff = this.config.retryBaseDelayMs * Math.pow(2, message.attempts - 1);
                message.scheduledFor = Date.now() + backoff;
                this.emit('retry', message, message.attempts, backoff);
            }
        }
        finally {
            this.processing = false;
        }
    }
    getStats() {
        const now = Date.now();
        return {
            total: this.queue.length,
            pending: this.queue.filter(m => !m.scheduledFor || m.scheduledFor <= now).length,
            scheduled: this.queue.filter(m => m.scheduledFor && m.scheduledFor > now).length,
            byPriority: {
                high: this.queue.filter(m => m.priority === 'high').length,
                normal: this.queue.filter(m => m.priority === 'normal').length,
                low: this.queue.filter(m => m.priority === 'low').length
            },
            processing: this.processing,
            isRunning: this.drainTimer !== null
        };
    }
    clear() {
        const count = this.queue.length;
        this.queue = [];
        this.emit('cleared', count);
    }
    remove(id) {
        const before = this.queue.length;
        this.queue = this.queue.filter(m => m.id !== id);
        return this.queue.length < before;
    }
    export() {
        return [...this.queue];
    }
    import(messages) {
        this.queue = [...messages];
        this.sortQueue();
    }
    sortQueue() {
        if (!this.config.priorityOrder)
            return;
        const priorityWeight = { high: 0, normal: 1, low: 2 };
        this.queue.sort((a, b) => {
            const pDiff = priorityWeight[a.priority] - priorityWeight[b.priority];
            if (pDiff !== 0)
                return pDiff;
            return a.addedAt - b.addedAt;
        });
    }
};
var DEFAULT_CONFIG13 = {
    zeroWidthChars: true,
    punctuationVariation: true,
    emojiPadding: false,
    synonyms: false
};
var ZERO_WIDTH = [
    '\u200B',
    '\u200C',
    '\u200D',
    '\uFEFF'
];
var SYNONYMS = {
    hello: ['hi', 'hey', 'howdy'],
    hi: ['hello', 'hey', 'howdy'],
    thanks: ['thank you', 'thx', 'cheers'],
    please: ['kindly', 'pls'],
    great: ['awesome', 'excellent', 'wonderful'],
    good: ['great', 'nice', 'fine'],
    buy: ['purchase', 'get', 'grab'],
    sell: ['offer', 'list'],
    price: ['cost', 'amount', 'value'],
    available: ['in stock', 'on offer'],
    check: ['look at', 'see', 'view'],
    join: ['participate', 'enter', 'come to'],
    start: ['begin', 'kick off', 'commence'],
    end: ['finish', 'close', 'conclude'],
    bid: ['offer', 'place a bid'],
    win: ['secure', 'take home'],
    item: ['lot', 'piece', 'product']
};
var ContentVariator = class {
    config;
    counter = 0;
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG13, ...config };
    }
    vary(text) {
        let result = text;
        this.counter++;
        if (this.config.customVariator) {
            return this.config.customVariator(result, this.counter);
        }
        if (this.config.synonyms) {
            result = this.applySynonyms(result);
        }
        if (this.config.zeroWidthChars) {
            result = this.addZeroWidth(result);
        }
        if (this.config.punctuationVariation) {
            result = this.varyPunctuation(result);
        }
        if (this.config.emojiPadding) {
            result = this.addEmojiPadding(result);
        }
        return result;
    }
    varyBulk(text, count) {
        const results = [];
        const seen = new Set();
        for (let i = 0; i < count; i++) {
            let variation = this.vary(text);
            let attempts = 0;
            while (seen.has(variation) && attempts < 10) {
                variation = this.vary(text);
                attempts++;
            }
            seen.add(variation);
            results.push(variation);
        }
        return results;
    }
    addZeroWidth(text) {
        const words = text.split(' ');
        if (words.length < 2)
            return text;
        const positions = this.randomPositions(words.length - 1, Math.min(2, words.length - 1));
        return words
            .map((word, i) => {
            if (positions.includes(i)) {
                const zwc = ZERO_WIDTH[Math.floor(Math.random() * ZERO_WIDTH.length)];
                return word + zwc;
            }
            return word;
        })
            .join(' ');
    }
    varyPunctuation(text) {
        const variations = [
            () => text + ' ',
            () => text + '  ',
            () => (text.endsWith('.') ? text.slice(0, -1) : text + '.'),
            () => text,
            () => (text.charAt(0) === text.charAt(0).toUpperCase() ? text.charAt(0).toLowerCase() + text.slice(1) : text)
        ];
        return variations[this.counter % variations.length]();
    }
    addEmojiPadding(text) {
        const emojis = ['', ' \u{1F44D}', ' \u2705', ' \u{1F4CC}', ' \u{1F4AC}', ' \u{1F4E2}'];
        return text + emojis[this.counter % emojis.length];
    }
    applySynonyms(text) {
        const words = text.split(/\b/);
        let replaced = false;
        return words
            .map(word => {
            if (replaced)
                return word;
            const lower = word.toLowerCase();
            const synonymList = SYNONYMS[lower];
            if (synonymList && Math.random() > 0.5) {
                replaced = true;
                const synonym = synonymList[Math.floor(Math.random() * synonymList.length)];
                return word[0] === word[0].toUpperCase() ? synonym.charAt(0).toUpperCase() + synonym.slice(1) : synonym;
            }
            return word;
        })
            .join('');
    }
    randomPositions(max, count) {
        const positions = [];
        while (positions.length < count) {
            const pos = Math.floor(Math.random() * max);
            if (!positions.includes(pos))
                positions.push(pos);
        }
        return positions;
    }
};
var DEFAULT_CONFIG14 = {
    urls: [],
    minRiskLevel: 'medium',
    cooldownMs: 3e5,
    includeStats: true
};
var WebhookAlerts = class {
    config;
    lastAlertTime = 0;
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG14, ...config };
    }
    async alert(data) {
        const riskOrder = ['low', 'medium', 'high', 'critical'];
        if (riskOrder.indexOf(data.risk) < riskOrder.indexOf(this.config.minRiskLevel)) {
            return;
        }
        const now = Date.now();
        if (now - this.lastAlertTime < this.config.cooldownMs) {
            return;
        }
        this.lastAlertTime = now;
        const payload = {
            source: 'baileys-antiban',
            timestamp: new Date().toISOString(),
            ...data
        };
        for (const url of this.config.urls) {
            this.postWebhook(url, payload).catch(() => { });
        }
        if (this.config.telegram) {
            const emoji = { low: '\u{1F7E2}', medium: '\u{1F7E1}', high: '\u{1F7E0}', critical: '\u{1F534}' }[data.risk] || '\u26AA';
            const text = `${emoji} *baileys-antiban Alert*

Risk: *${data.risk.toUpperCase()}* (score: ${data.score})
${data.recommendation}

Reasons:
${data.reasons.map(r => `\u2022 ${r}`).join('\n')}`;
            this.postWebhook(`https://api.telegram.org/bot${this.config.telegram.botToken}/sendMessage`, {
                chat_id: this.config.telegram.chatId,
                text,
                parse_mode: 'Markdown'
            }).catch(() => { });
        }
        if (this.config.discord) {
            const color = { low: 65280, medium: 16776960, high: 16746496, critical: 16711680 }[data.risk] || 0;
            this.postWebhook(this.config.discord.webhookUrl, {
                embeds: [
                    {
                        title: '\u{1F6E1}\uFE0F baileys-antiban Alert',
                        color,
                        fields: [
                            { name: 'Risk', value: data.risk.toUpperCase(), inline: true },
                            { name: 'Score', value: String(data.score), inline: true },
                            { name: 'Recommendation', value: data.recommendation },
                            { name: 'Reasons', value: data.reasons.join('\n') }
                        ],
                        timestamp: new Date().toISOString()
                    }
                ]
            }).catch(() => { });
        }
    }
    async postWebhook(url, payload) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...this.config.headers
                },
                body: JSON.stringify(payload)
            });
            if (!response.ok) {
                process.stderr.write(`[baileys-antiban] Webhook failed: ${response.status}\n`);
            }
        }
        catch (err) {
            process.stderr.write(`[baileys-antiban] Webhook error: ${err}\n`);
        }
    }
};
var DEFAULT_CONFIG15 = {
    timezone: 'UTC',
    activeHours: [8, 21],
    weekendFactor: 0.5,
    peakHours: [10, 14],
    peakFactor: 1.3,
    lunchBreak: [12, 13],
    lunchFactor: 0.5
};
var Scheduler = class {
    config;
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG15, ...config };
    }
    isActiveTime() {
        const hour = this.getCurrentHour();
        const [start, end] = this.config.activeHours;
        return hour >= start && hour < end;
    }
    getSpeedFactor() {
        if (!this.isActiveTime())
            return 0;
        const hour = this.getCurrentHour();
        const day = this.getCurrentDay();
        let factor = 1;
        if (day === 0 || day === 6) {
            factor *= this.config.weekendFactor;
        }
        const [peakStart, peakEnd] = this.config.peakHours;
        if (hour >= peakStart && hour < peakEnd) {
            factor *= this.config.peakFactor;
        }
        const [lunchStart, lunchEnd] = this.config.lunchBreak;
        if (hour >= lunchStart && hour < lunchEnd) {
            factor *= this.config.lunchFactor;
        }
        return factor;
    }
    msUntilActive() {
        if (this.isActiveTime())
            return 0;
        const now = new Date();
        const hour = now.getHours();
        const [start] = this.config.activeHours;
        let nextActive;
        if (hour >= this.config.activeHours[1]) {
            nextActive = new Date(now);
            nextActive.setDate(nextActive.getDate() + 1);
            nextActive.setHours(start, 0, 0, 0);
        }
        else {
            nextActive = new Date(now);
            nextActive.setHours(start, 0, 0, 0);
        }
        return nextActive.getTime() - now.getTime();
    }
    adjustDelay(baseDelayMs) {
        const factor = this.getSpeedFactor();
        if (factor === 0)
            return -1;
        return Math.round(baseDelayMs / factor);
    }
    getStatus() {
        const hour = this.getCurrentHour();
        const day = this.getCurrentDay();
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        return {
            active: this.isActiveTime(),
            currentHour: hour,
            day: dayNames[day],
            isWeekend: day === 0 || day === 6,
            speedFactor: this.getSpeedFactor(),
            msUntilActive: this.msUntilActive(),
            activeWindow: `${this.config.activeHours[0]}:00 - ${this.config.activeHours[1]}:00`
        };
    }
    getCurrentHour() {
        return new Date().getHours();
    }
    getCurrentDay() {
        return new Date().getDay();
    }
};
var FileStateAdapter = class {
    basePath;
    constructor(basePath) {
        this.basePath = basePath;
    }
    async save(key, state) {
        const filePath = _path3.join(this.basePath, `${key}.json`);
        await _fsPromises.mkdir(this.basePath, { recursive: true });
        await _fsPromises.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
    }
    async load(key) {
        const filePath = _path3.join(this.basePath, `${key}.json`);
        try {
            const data = await _fsPromises.readFile(filePath, 'utf-8');
            return JSON.parse(data);
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return null;
            throw err;
        }
    }
    async delete(key) {
        const filePath = _path3.join(this.basePath, `${key}.json`);
        try {
            await _fsPromises.unlink(filePath);
        }
        catch (err) {
            if (err.code !== 'ENOENT')
                throw err;
        }
    }
    async list() {
        try {
            const files = await _fsPromises.readdir(this.basePath);
            return files.filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return [];
            throw err;
        }
    }
};
var DEFAULT_CONFIG16 = {
    maxTrackedChats: 1e3,
    maxGapMs: 30 * 6e4,
    persistDebounceMs: 2e3,
    onGapFilled: () => { },
    logger: {
        info: () => { },
        warn: () => { },
        error: () => { }
    }
};
function messageRecovery(sock, config) {
    const cfg = { ...DEFAULT_CONFIG16, ...config };
    const logger = cfg.logger;
    const lastSeen = new Map();
    let disconnectedAt = null;
    let totalRecovered = 0;
    let lastReconnectAt = null;
    let lastGapMs = null;
    let persistTimer = null;
    let loggedFetchWarning = false;
    if (cfg.persistPath) {
        loadPersistence();
    }
    const messagesListener = sock.ev.process ? setupProcessListener() : setupLegacyListener();
    const connectionListener = update => {
        if (update.connection === 'close') {
            disconnectedAt = Date.now();
            logger.info?.(`[messageRecovery] Disconnected at ${new Date(disconnectedAt).toISOString()}`);
        }
        if (update.connection === 'open' && disconnectedAt !== null) {
            void recoverMessages();
        }
    };
    sock.ev.on('connection.update', connectionListener);
    function setupProcessListener() {
        const listener = async (events) => {
            if (events['messages.upsert']) {
                const { messages, type } = events['messages.upsert'];
                if (type === 'notify') {
                    for (const msg of messages || []) {
                        trackMessage(msg);
                    }
                }
            }
        };
        sock.ev.process(listener);
        return listener;
    }
    function setupLegacyListener() {
        const listener = upsert => {
            const { messages, type } = upsert;
            if (type === 'notify') {
                for (const msg of messages || []) {
                    trackMessage(msg);
                }
            }
        };
        sock.ev.on('messages.upsert', listener);
        return listener;
    }
    function trackMessage(msg) {
        const jid = msg.key?.remoteJid;
        const messageId = msg.key?.id;
        const timestamp = msg.messageTimestamp;
        if (!jid || !messageId || !timestamp)
            return;
        if (msg.key?.fromMe)
            return;
        const now = Date.now();
        lastSeen.set(jid, {
            messageId,
            timestamp: typeof timestamp === 'number' ? timestamp : parseInt(timestamp, 10),
            lastTouchedAt: now
        });
        if (lastSeen.size > cfg.maxTrackedChats) {
            evictOldest();
        }
        schedulePersist();
    }
    function evictOldest() {
        let oldestJid = null;
        let oldestTime = Infinity;
        for (const [jid, entry] of lastSeen) {
            if (entry.lastTouchedAt < oldestTime) {
                oldestTime = entry.lastTouchedAt;
                oldestJid = jid;
            }
        }
        if (oldestJid) {
            lastSeen.delete(oldestJid);
        }
    }
    async function recoverMessages() {
        const recoveryStartMs = Date.now();
        const gapMs = recoveryStartMs - disconnectedAt;
        logger.info?.(`[messageRecovery] Reconnected after ${(gapMs / 1e3).toFixed(1)}s`);
        if (gapMs > cfg.maxGapMs) {
            logger.warn?.(`[messageRecovery] Gap too large (${(gapMs / 1e3).toFixed(0)}s > ${(cfg.maxGapMs / 1e3).toFixed(0)}s) \u2014 skipping recovery`);
            disconnectedAt = null;
            lastGapMs = gapMs;
            await cfg.onGapTooLarge?.(gapMs);
            return;
        }
        let recovered = 0;
        const chatsToRecover = Array.from(lastSeen.entries());
        if (typeof sock.fetchMessageHistory !== 'function') {
            if (!loggedFetchWarning) {
                logger.warn?.(`[messageRecovery] sock.fetchMessageHistory not available \u2014 recovery disabled. Baileys version may not support history fetch. User must implement manual reconciliation.`);
                loggedFetchWarning = true;
            }
            disconnectedAt = null;
            lastReconnectAt = new Date();
            lastGapMs = gapMs;
            await cfg.onRecoveryComplete?.({
                chats: 0,
                recovered: 0,
                durationMs: Date.now() - recoveryStartMs
            });
            return;
        }
        for (const [jid, lastSeenEntry] of chatsToRecover) {
            try {
                const messages = await sock.fetchMessageHistory(jid, 50, {
                    before: void 0
                });
                if (!messages || !Array.isArray(messages))
                    continue;
                const gapMessages = messages.filter(msg => {
                    const ts = msg.messageTimestamp;
                    if (!ts)
                        return false;
                    const msgTs = typeof ts === 'number' ? ts : parseInt(ts, 10);
                    return msgTs > lastSeenEntry.timestamp;
                });
                gapMessages.sort((a, b) => {
                    const aTs = typeof a.messageTimestamp === 'number' ? a.messageTimestamp : parseInt(a.messageTimestamp, 10);
                    const bTs = typeof b.messageTimestamp === 'number' ? b.messageTimestamp : parseInt(b.messageTimestamp, 10);
                    return aTs - bTs;
                });
                for (const msg of gapMessages) {
                    await cfg.onGapFilled(msg, jid);
                    recovered++;
                    const msgTs = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : parseInt(msg.messageTimestamp, 10);
                    if (msgTs > lastSeenEntry.timestamp) {
                        lastSeenEntry.timestamp = msgTs;
                        lastSeenEntry.messageId = msg.key?.id || lastSeenEntry.messageId;
                        lastSeenEntry.lastTouchedAt = Date.now();
                    }
                }
                if (gapMessages.length > 0) {
                    logger.info?.(`[messageRecovery] Recovered ${gapMessages.length} messages from ${jid}`);
                }
            }
            catch (err) {
                logger.error?.(`[messageRecovery] Failed to recover from ${jid}: ${err.message}`);
            }
        }
        totalRecovered += recovered;
        lastReconnectAt = new Date();
        lastGapMs = gapMs;
        disconnectedAt = null;
        logger.info?.(`[messageRecovery] Recovery complete: ${recovered} messages across ${chatsToRecover.length} chats in ${Date.now() - recoveryStartMs}ms`);
        await cfg.onRecoveryComplete?.({
            chats: chatsToRecover.length,
            recovered,
            durationMs: Date.now() - recoveryStartMs
        });
    }
    function schedulePersist() {
        if (!cfg.persistPath)
            return;
        if (persistTimer) {
            clearTimeout(persistTimer);
        }
        persistTimer = setTimeout(() => {
            void flushPersistence();
        }, cfg.persistDebounceMs);
    }
    async function flushPersistence() {
        if (!cfg.persistPath)
            return;
        try {
            const data = {};
            for (const [jid, entry] of lastSeen) {
                data[jid] = {
                    id: entry.messageId,
                    timestamp: entry.timestamp
                };
            }
            await _fsPromises.writeFile(cfg.persistPath, JSON.stringify(data, null, 2), 'utf-8');
        }
        catch (err) {
            logger.error?.(`[messageRecovery] Failed to persist state: ${err.message}`);
        }
    }
    function loadPersistence() {
        if (!cfg.persistPath)
            return;
        try {
            if (!fs2.existsSync(cfg.persistPath))
                return;
            const raw = fs2.readFileSync(cfg.persistPath, 'utf-8');
            const data = JSON.parse(raw);
            for (const [jid, entry] of Object.entries(data)) {
                lastSeen.set(jid, {
                    messageId: entry.id,
                    timestamp: entry.timestamp,
                    lastTouchedAt: Date.now()
                });
            }
            logger.info?.(`[messageRecovery] Loaded ${lastSeen.size} entries from ${cfg.persistPath}`);
        }
        catch (err) {
            logger.warn?.(`[messageRecovery] Failed to load persisted state: ${err.message}`);
        }
    }
    return {
        async stop() {
            sock.ev.off('connection.update', connectionListener);
            if (!sock.ev.process) {
                sock.ev.off('messages.upsert', messagesListener);
            }
            if (persistTimer) {
                clearTimeout(persistTimer);
                persistTimer = null;
            }
            await flushPersistence();
            logger.info?.(`[messageRecovery] Stopped \u2014 total recovered: ${totalRecovered}`);
        },
        markSeen(chatJid, messageId, timestamp) {
            lastSeen.set(chatJid, {
                messageId,
                timestamp,
                lastTouchedAt: Date.now()
            });
            schedulePersist();
        },
        getStats() {
            return {
                trackedChats: lastSeen.size,
                totalRecovered,
                lastReconnectAt,
                lastGapMs
            };
        }
    };
}
var DEFAULT_APP_VERSION_POOL = [
    [2, 24, 5, 18],
    [2, 24, 5, 17],
    [2, 24, 4, 77],
    [2, 24, 5, 15],
    [2, 24, 3, 91],
    [2, 24, 5, 20]
];
var DEFAULT_OS_VERSION_POOL = ['10', '11', '12', '13', '14'];
var DEFAULT_DEVICE_MODEL_POOL = [
    'Pixel 6',
    'Pixel 7',
    'Galaxy S22',
    'Galaxy S23',
    'Xiaomi 13',
    'Xiaomi 12',
    'OnePlus 11',
    'Moto G84',
    'Moto G54',
    'Realme 11',
    'Vivo V29',
    'Oppo Find X6'
];
var SeededRandom = class {
    state;
    constructor(seed) {
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
            hash = (hash << 5) - hash + seed.charCodeAt(i);
            hash = hash & hash;
        }
        this.state = Math.abs(hash) || 1;
    }
    next() {
        let t = (this.state += 1831565813);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    pick(array) {
        return array[Math.floor(this.next() * array.length)];
    }
};
function generateFingerprint(config = {}, sessionId) {
    const { enabled = true, randomizeAppVersion = true, randomizeOsVersion = true, randomizeDeviceModel = true, seed, appVersionPool = DEFAULT_APP_VERSION_POOL, osVersionPool = DEFAULT_OS_VERSION_POOL, deviceModelPool = DEFAULT_DEVICE_MODEL_POOL } = config;
    const finalSessionId = sessionId || `session-${Date.now()}-${Math.random()}`;
    const rng = new SeededRandom(seed || finalSessionId);
    const appVersion = enabled && randomizeAppVersion ? rng.pick(appVersionPool) : appVersionPool[0];
    const osVersion = enabled && randomizeOsVersion ? rng.pick(osVersionPool) : osVersionPool[0];
    const deviceModel = enabled && randomizeDeviceModel ? rng.pick(deviceModelPool) : deviceModelPool[0];
    return {
        appVersion: [...appVersion],
        osVersion,
        deviceModel,
        sessionId: finalSessionId
    };
}
function applyFingerprint(socketConfig, fp) {
    const config = { ...socketConfig };
    if (config.version !== void 0 || 'version' in config || true) {
        config.version = fp.appVersion;
    }
    if (config.browser !== void 0 || 'browser' in config || true) {
        config.browser = [fp.deviceModel, fp.osVersion, `WhatsApp/${fp.appVersion.join('.')}`];
    }
    return config;
}
var noop = () => { };
function credsSnapshot(config) {
    const { credsPath, snapshotDir = path2.join(path2.dirname(credsPath), '.snapshots'), keep = 3, logger = {} } = config;
    const log = {
        info: logger.info || noop,
        warn: logger.warn || noop,
        error: logger.error || noop
    };
    async function take() {
        try {
            try {
                await import_fs.promises.access(credsPath);
            }
            catch {
                log.warn(`[credsSnapshot] Creds file not found: ${credsPath}`);
                return null;
            }
            await import_fs.promises.mkdir(snapshotDir, { recursive: true });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const snapshotPath = path2.join(snapshotDir, `creds-${timestamp}.json`);
            const tmpPath = `${snapshotPath}.tmp`;
            await import_fs.promises.copyFile(credsPath, tmpPath);
            await import_fs.promises.rename(tmpPath, snapshotPath);
            log.info(`[credsSnapshot] Snapshot taken: ${snapshotPath}`);
            await rotate();
            return snapshotPath;
        }
        catch (err) {
            log.error(`[credsSnapshot] Failed to take snapshot: ${err}`);
            return null;
        }
    }
    async function rotate() {
        try {
            const snapshots = await list();
            const toDelete = snapshots.slice(keep);
            for (const snap of toDelete) {
                await import_fs.promises.unlink(snap.path);
                log.info(`[credsSnapshot] Rotated out: ${snap.path}`);
            }
        }
        catch (err) {
            log.error(`[credsSnapshot] Rotation failed: ${err}`);
        }
    }
    async function list() {
        try {
            await import_fs.promises.access(snapshotDir);
        }
        catch {
            return [];
        }
        try {
            const files = await import_fs.promises.readdir(snapshotDir);
            const snapshots = await Promise.all(files
                .filter(f => f.startsWith('creds-') && f.endsWith('.json'))
                .map(async (f) => {
                const fullPath = path2.join(snapshotDir, f);
                const stat = await import_fs.promises.stat(fullPath);
                return {
                    path: fullPath,
                    takenAt: stat.mtime,
                    size: stat.size
                };
            }));
            return snapshots.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
        }
        catch (err) {
            log.error(`[credsSnapshot] Failed to list snapshots: ${err}`);
            return [];
        }
    }
    async function restoreLatest() {
        const snapshots = await list();
        if (snapshots.length === 0) {
            log.warn('[credsSnapshot] No snapshots available to restore');
            return false;
        }
        return restore(snapshots[0].path);
    }
    async function restore(snapshotPath) {
        try {
            await import_fs.promises.access(snapshotPath);
            const tmpPath = `${credsPath}.tmp`;
            await import_fs.promises.copyFile(snapshotPath, tmpPath);
            await import_fs.promises.rename(tmpPath, credsPath);
            log.info(`[credsSnapshot] Restored from: ${snapshotPath}`);
            return true;
        }
        catch (err) {
            log.error(`[credsSnapshot] Failed to restore from ${snapshotPath}: ${err}`);
            return false;
        }
    }
    return {
        take,
        restoreLatest,
        restore,
        list
    };
}
function gaussianRandom() {
    let u = 0;
    let v = 0;
    while (u === 0)
        u = Math.random();
    while (v === 0)
        v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function readReceiptVariance(config = {}) {
    const { meanMs = 1500, stdDevMs = 800, minMs = 200, maxMs = 8e3, skipIfOlderThanMs = 6e4 } = config;
    const pendingTimers = new Set();
    function delayMs() {
        const gaussian = gaussianRandom();
        const value = meanMs + gaussian * stdDevMs;
        return Math.max(minMs, Math.min(maxMs, value));
    }
    function wrap(sock) {
        const originalReadMessages = sock.readMessages.bind(sock);
        const wrappedReadMessages = async (keys) => {
            const now = Date.now();
            const oldMessages = keys.every(key => {
                if (!key.messageTimestamp)
                    return false;
                const msgTime = typeof key.messageTimestamp === 'number'
                    ? key.messageTimestamp * 1e3
                    : parseInt(key.messageTimestamp, 10) * 1e3;
                return now - msgTime > skipIfOlderThanMs;
            });
            if (oldMessages) {
                return originalReadMessages(keys);
            }
            const delay = delayMs();
            return new Promise((resolve, reject) => {
                const timer = setTimeout(async () => {
                    pendingTimers.delete(timer);
                    try {
                        const result = await originalReadMessages(keys);
                        resolve(result);
                    }
                    catch (err) {
                        reject(err);
                    }
                }, delay);
                pendingTimers.add(timer);
            });
        };
        return new Proxy(sock, {
            get(target, prop) {
                if (prop === 'readMessages') {
                    return wrappedReadMessages;
                }
                return target[prop];
            }
        });
    }
    function stop() {
        for (const timer of pendingTimers) {
            clearTimeout(timer);
        }
        pendingTimers.clear();
    }
    return {
        wrap,
        delayMs,
        stop
    };
}
var NoopLogger = {
    info: () => { },
    warn: () => { },
    error: () => { }
};
function proxyRotator(config) {
    const { pool, strategy = 'round-robin', rotateOn = ['disconnect', 'ban-warning'], scheduledIntervalMs = 0, maxFailures = 3, deadCooldownMs = 6e5, logger = NoopLogger } = config;
    if (!pool || pool.length === 0) {
        throw new Error('proxyRotator: pool cannot be empty');
    }
    if (pool.length === 1) {
        logger.warn?.('proxyRotator: pool size is 1. Rotation is a no-op.');
    }
    if (scheduledIntervalMs > 0 && scheduledIntervalMs < 6e4) {
        logger.warn?.(`proxyRotator: scheduledIntervalMs (${scheduledIntervalMs}ms) is < 60s. May hammer proxy provider.`);
    }
    const states = pool.map(endpoint => ({
        endpoint,
        failures: 0,
        lastUsedAt: null,
        isDead: false
    }));
    let currentIndex = 0;
    let totalRotations = 0;
    const rotationsByTrigger = {};
    let scheduledTimer = null;
    const agentCache = new Map();
    const moduleCache = {};
    function buildProxyUrl(endpoint) {
        const { type, host, port, username, password } = endpoint;
        const auth = username && password ? `${username}:${password}@` : '';
        return `${type}://${auth}${host}:${port}`;
    }
    function createAgentForEndpointSync(endpoint) {
        if (agentCache.has(endpoint)) {
            return agentCache.get(endpoint);
        }
        const url = buildProxyUrl(endpoint);
        let agent = null;
        try {
            if (endpoint.type === 'socks5' || endpoint.type === 'socks5h') {
                if (!moduleCache['socks-proxy-agent']) {
                    try {
                        moduleCache['socks-proxy-agent'] = require2('socks-proxy-agent');
                    }
                    catch {
                        logger.error?.('socks-proxy-agent not installed. Run: npm install socks-proxy-agent');
                        return null;
                    }
                }
                agent = new moduleCache['socks-proxy-agent'].SocksProxyAgent(url);
            }
            else if (endpoint.type === 'http') {
                if (!moduleCache['http-proxy-agent']) {
                    try {
                        moduleCache['http-proxy-agent'] = require2('http-proxy-agent');
                    }
                    catch {
                        logger.error?.('http-proxy-agent not installed. Run: npm install http-proxy-agent');
                        return null;
                    }
                }
                agent = new moduleCache['http-proxy-agent'].HttpProxyAgent(url);
            }
            else if (endpoint.type === 'https') {
                if (!moduleCache['https-proxy-agent']) {
                    try {
                        moduleCache['https-proxy-agent'] = require2('https-proxy-agent');
                    }
                    catch {
                        logger.error?.('https-proxy-agent not installed. Run: npm install https-proxy-agent');
                        return null;
                    }
                }
                agent = new moduleCache['https-proxy-agent'].HttpsProxyAgent(url);
            }
            else {
                logger.error?.(`Unknown proxy type: ${endpoint.type}`);
                return null;
            }
            if (agent) {
                agentCache.set(endpoint, agent);
            }
            return agent;
        }
        catch (err) {
            logger.error?.(`Failed to create agent for ${endpoint.label || endpoint.host}: ${err}`);
            return null;
        }
    }
    function getAliveEndpoints() {
        const now = Date.now();
        return states
            .map((s, idx) => {
            if (s.isDead && s.lastUsedAt) {
                if (now - s.lastUsedAt.getTime() >= deadCooldownMs) {
                    s.isDead = false;
                    s.failures = 0;
                    logger.info?.(`Resurrected endpoint ${s.endpoint.label || s.endpoint.host} after cooldown`);
                }
            }
            const cooldown = s.endpoint.cooldownMs || 0;
            if (cooldown > 0 && s.lastUsedAt) {
                if (now - s.lastUsedAt.getTime() < cooldown) {
                    return -1;
                }
            }
            return !s.isDead ? idx : -1;
        })
            .filter(idx => idx !== -1);
    }
    function selectNextIndex(alive) {
        if (alive.length === 0)
            return currentIndex;
        if (strategy === 'round-robin') {
            const afterCurrent = alive.filter(idx => idx > currentIndex);
            if (afterCurrent.length > 0)
                return afterCurrent[0];
            return alive[0];
        }
        if (strategy === 'random') {
            return alive[Math.floor(Math.random() * alive.length)];
        }
        if (strategy === 'least-recently-used') {
            const neverUsed = alive.filter(idx => states[idx].lastUsedAt === null);
            if (neverUsed.length > 0) {
                return neverUsed[0];
            }
            let oldestIdx = alive[0];
            let oldestTime = states[oldestIdx].lastUsedAt.getTime();
            for (const idx of alive) {
                const time = states[idx].lastUsedAt.getTime();
                if (time < oldestTime) {
                    oldestTime = time;
                    oldestIdx = idx;
                }
            }
            return oldestIdx;
        }
        if (strategy === 'weighted') {
            const weights = alive.map(idx => {
                const failures = states[idx].failures;
                return 1 / (failures + 1);
            });
            const totalWeight = weights.reduce((a, b) => a + b, 0);
            let rand = Math.random() * totalWeight;
            for (let i = 0; i < alive.length; i++) {
                rand -= weights[i];
                if (rand <= 0)
                    return alive[i];
            }
            return alive[alive.length - 1];
        }
        return alive[0];
    }
    function rotateImpl(reason = 'manual') {
        if (pool.length === 1) {
            return states[0].endpoint;
        }
        const alive = getAliveEndpoints();
        if (alive.length === 0) {
            logger.warn?.('All endpoints are dead. Cannot rotate.');
            return states[currentIndex].endpoint;
        }
        const nextIdx = selectNextIndex(alive);
        if (nextIdx === currentIndex && alive.length > 1) {
            const others = alive.filter(idx => idx !== currentIndex);
            if (others.length > 0) {
                currentIndex = others[0];
            }
            else {
                currentIndex = nextIdx;
            }
        }
        else {
            currentIndex = nextIdx;
        }
        states[currentIndex].lastUsedAt = new Date();
        totalRotations++;
        rotationsByTrigger[reason] = (rotationsByTrigger[reason] || 0) + 1;
        const label = states[currentIndex].endpoint.label || states[currentIndex].endpoint.host;
        logger.info?.(`Rotated to endpoint ${label} (reason: ${reason})`);
        return states[currentIndex].endpoint;
    }
    function markFailureImpl() {
        const state = states[currentIndex];
        state.failures++;
        const label = state.endpoint.label || state.endpoint.host;
        logger.warn?.(`Endpoint ${label} failed (${state.failures}/${maxFailures})`);
        if (state.failures >= maxFailures) {
            state.isDead = true;
            logger.error?.(`Endpoint ${label} marked DEAD after ${maxFailures} failures`);
            const alive = getAliveEndpoints();
            if (alive.length > 0) {
                rotateImpl('manual');
            }
        }
    }
    function resurrectAllImpl() {
        let count = 0;
        for (const state of states) {
            if (state.isDead) {
                state.isDead = false;
                state.failures = 0;
                count++;
            }
        }
        if (count > 0) {
            logger.info?.(`Resurrected ${count} dead endpoint(s)`);
        }
    }
    function stopImpl() {
        if (scheduledTimer) {
            clearInterval(scheduledTimer);
            scheduledTimer = null;
            logger.info?.('Stopped scheduled rotation timer');
        }
    }
    function getStatsImpl() {
        return {
            totalRotations,
            rotationsByTrigger: { ...rotationsByTrigger },
            endpointHealth: states.map(s => ({
                label: s.endpoint.label || s.endpoint.host,
                inUse: states[currentIndex] === s,
                failures: s.failures,
                lastUsedAt: s.lastUsedAt,
                isDead: s.isDead
            })),
            currentEndpoint: states[currentIndex].endpoint.label || states[currentIndex].endpoint.host
        };
    }
    function currentAgentImpl() {
        const endpoint = states[currentIndex].endpoint;
        return createAgentForEndpointSync(endpoint);
    }
    function currentImpl() {
        return states[currentIndex].endpoint;
    }
    if (rotateOn.includes('scheduled') && scheduledIntervalMs > 0) {
        scheduledTimer = setInterval(() => {
            rotateImpl('scheduled');
        }, scheduledIntervalMs);
        logger.info?.(`Scheduled rotation enabled (every ${scheduledIntervalMs}ms)`);
    }
    states[0].lastUsedAt = new Date();
    return {
        currentAgent: currentAgentImpl,
        current: currentImpl,
        rotate: rotateImpl,
        markFailure: markFailureImpl,
        resurrectAll: resurrectAllImpl,
        stop: stopImpl,
        getStats: getStatsImpl
    };
}

export {
    AntiBan,
    ContactGraphWarmer,
    ContentVariator,
    FileStateAdapter,
    HealthMonitor,
    JidCanonicalizer,
    LidFirstResolver,
    LidResolver,
    MAC_ERROR_CODES,
    MessageQueue,
    MessageRetryReason,
    PRESETS,
    PostReconnectThrottle,
    PresenceChoreographer,
    RateLimiter,
    ReplyRatioGuard,
    RetryReasonTracker,
    Scheduler,
    SessionHealthMonitor,
    StateManager,
    TimelockGuard,
    WarmUp,
    WebhookAlerts,
    applyFingerprint,
    applyGroupMultiplier,
    classifyDisconnect,
    createLidFirstResolver,
    credsSnapshot,
    generateFingerprint,
    getCircadianMultiplier,
    getRetryReasonDescription,
    isBroadcast,
    isGroup,
    isMacError,
    isNewsletter,
    messageRecovery,
    parseRetryReason,
    proxyRotator,
    readReceiptVariance,
    resolveConfig,
    shouldUseGroupProfile,
    wrapSocket,
    wrapWithSessionStability
};
