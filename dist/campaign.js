"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Campaign = void 0;
const luxon_1 = require("luxon");
class Campaign {
    config;
    callHandler;
    clock;
    // Queues
    pendingCallsQueue = [];
    retryCallsQueue = [];
    // Campaign state
    state = "idle";
    activeCalls = 0;
    // Statistics
    totalProcessed = 0;
    totalFailed = 0;
    dailyMinutesUsed = 0;
    lastProcessedDay = "";
    // Timer management
    activeTimers = new Set();
    constructor(config, callHandler, clock) {
        this.config = {
            ...config,
            maxRetries: config.maxRetries ?? 2,
            retryDelayMs: config.retryDelayMs ?? 3600000,
        };
        this.callHandler = callHandler;
        this.clock = clock;
        this.pendingCallsQueue = config.customerList.map((customer) => ({
            phoneNumber: customer,
            retryCount: 0,
        }));
        // Initialize the current day
        this.lastProcessedDay = this.getLocalDateTime().toFormat("yyyy-MM-dd");
    }
    start() {
        if (this.state !== "idle")
            return;
        this.state = "running";
        this.tryStartCalls();
    }
    pause() {
        if (this.state !== "running")
            return;
        this.state = "paused";
        this.clearAllTimers();
    }
    resume() {
        if (this.state !== "paused")
            return;
        this.state = "running";
        this.tryStartCalls();
    }
    getStatus() {
        this.checkAndResetDailyStats();
        return {
            state: this.state,
            totalProcessed: this.totalProcessed,
            totalFailed: this.totalFailed,
            activeCalls: this.activeCalls,
            pendingRetries: this.retryCallsQueue.length,
            dailyMinutesUsed: Math.floor(this.dailyMinutesUsed),
        };
    }
    getLocalDateTime() {
        const zone = this.config.timezone || "UTC";
        const dt = luxon_1.DateTime.fromMillis(this.clock.now(), { zone });
        if (!dt.isValid) {
            // Fallback to UTC if timezone is invalid
            return luxon_1.DateTime.fromMillis(this.clock.now(), { zone: "UTC" });
        }
        return dt;
    }
    checkAndResetDailyStats() {
        const currentDay = this.getLocalDateTime().toFormat("yyyy-MM-dd");
        if (this.lastProcessedDay !== currentDay) {
            this.dailyMinutesUsed = 0;
            this.lastProcessedDay = currentDay;
        }
    }
    tryStartCalls() {
        if (this.state !== "running")
            return;
        this.checkAndResetDailyStats();
        // 1. Check if we are within working hours
        if (!this.isWithinWorkingHours()) {
            this.scheduleNextWorkingWindow();
            return;
        }
        // 2. Check if we hit the daily cap
        if (this.dailyMinutesUsed >= this.config.maxDailyMinutes) {
            this.scheduleMidnightReset();
            return;
        }
        // 3. Start calls for available slots
        while (this.canStartCall()) {
            const next = this.pickNextCall();
            if (!next)
                break;
            this.startCall(next);
        }
        this.checkCompletion();
    }
    isWithinWorkingHours() {
        const now = this.getLocalDateTime();
        const [startH, startM] = this.config.startTime.split(":").map(Number);
        const [endH, endM] = this.config.endTime.split(":").map(Number);
        const currentTime = now.hour * 60 + now.minute;
        const startTime = startH * 60 + startM;
        const endTime = endH * 60 + endM;
        // We assume startTime < endTime (same day)
        return currentTime >= startTime && currentTime < endTime;
    }
    scheduleNextWorkingWindow() {
        const now = this.getLocalDateTime();
        const [startH, startM] = this.config.startTime.split(":").map(Number);
        let nextStart = now.set({
            hour: startH,
            minute: startM,
            second: 0,
            millisecond: 0,
        });
        if (nextStart <= now) {
            nextStart = nextStart.plus({ days: 1 });
        }
        const delay = nextStart.toMillis() - this.clock.now();
        this.setSafeTimeout(() => this.tryStartCalls(), delay);
    }
    scheduleMidnightReset() {
        const now = this.getLocalDateTime();
        const nextMidnight = now
            .plus({ days: 1 })
            .set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
        const delay = nextMidnight.toMillis() - this.clock.now();
        this.setSafeTimeout(() => this.tryStartCalls(), delay);
    }
    canStartCall() {
        if (this.state !== "running")
            return false;
        if (this.activeCalls >= this.config.maxConcurrentCalls)
            return false;
        if (this.dailyMinutesUsed >= this.config.maxDailyMinutes)
            return false;
        return true;
    }
    pickNextCall() {
        const now = this.clock.now();
        // Priority: Retries that are ready
        const readyRetryIdx = this.retryCallsQueue.findIndex((r) => r.readyAt <= now);
        if (readyRetryIdx !== -1) {
            const retry = this.retryCallsQueue.splice(readyRetryIdx, 1)[0];
            return {
                phoneNumber: retry.phoneNumber,
                retryCount: retry.retryCount,
            };
        }
        // Then new calls from the queue
        const nextPending = this.pendingCallsQueue.shift();
        if (nextPending)
            return nextPending;
        // If we have retries but they aren't ready yet, schedule a wake-up
        if (this.retryCallsQueue.length > 0) {
            const earliestRetry = Math.min(...this.retryCallsQueue.map((r) => r.readyAt));
            this.setSafeTimeout(() => this.tryStartCalls(), earliestRetry - this.clock.now());
        }
        return null;
    }
    startCall(call) {
        this.activeCalls++;
        this.callHandler(call.phoneNumber)
            .then((result) => this.onCallFinished(call, result))
            .catch(() => this.onCallFinished(call, { answered: false, durationMs: 0 }));
    }
    onCallFinished(call, result) {
        this.activeCalls--;
        this.dailyMinutesUsed += result.durationMs / 60_000;
        if (result.answered) {
            this.totalProcessed++;
        }
        else {
            this.handleFailure(call);
        }
        this.tryStartCalls();
    }
    handleFailure(call) {
        if (call.retryCount >= (this.config.maxRetries ?? 2)) {
            this.totalFailed++;
            return;
        }
        const retryAt = this.clock.now() + (this.config.retryDelayMs ?? 3600000);
        this.retryCallsQueue.push({
            phoneNumber: call.phoneNumber,
            retryCount: call.retryCount + 1,
            readyAt: retryAt,
        });
        // Schedule a wake-up for this retry
        this.setSafeTimeout(() => this.tryStartCalls(), retryAt - this.clock.now());
    }
    checkCompletion() {
        if (this.pendingCallsQueue.length === 0 &&
            this.retryCallsQueue.length === 0 &&
            this.activeCalls === 0) {
            this.state = "completed";
            this.clearAllTimers();
        }
    }
    setSafeTimeout(callback, delayMs) {
        // Prevent negative delays and pilling up same-time timers
        const safeDelay = Math.max(0, delayMs);
        const id = this.clock.setTimeout(() => {
            this.activeTimers.delete(id);
            callback();
        }, safeDelay);
        this.activeTimers.add(id);
    }
    clearAllTimers() {
        for (const id of this.activeTimers) {
            this.clock.clearTimeout(id);
        }
        this.activeTimers.clear();
    }
}
exports.Campaign = Campaign;
