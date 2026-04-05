import { DateTime } from "luxon";
import {
  CallHandler,
  CallResult,
  CampaignConfig,
  CampaignState,
  CampaignStatus,
  ICampaign,
  IClock,
} from "./interfaces";

type InternalCall = {
  phoneNumber: string;
  retryCount: number;
};

type RetryItem = {
  phoneNumber: string;
  retryCount: number;
  readyAt: number;
};

export class Campaign implements ICampaign {
  private config: CampaignConfig;
  private callHandler: CallHandler;
  private clock: IClock;

  // Queues
  private pendingCallsQueue: InternalCall[] = [];
  private retryCallsQueue: RetryItem[] = [];

  // Campaign state
  private state: CampaignState = "idle";
  private activeCalls: number = 0;

  // Statistics
  private totalProcessed: number = 0;
  private totalFailed: number = 0;
  private dailyMinutesUsed: number = 0;
  private lastProcessedDay: string = "";

  // Timer management
  private activeTimers: Set<number> = new Set();

  constructor(config: CampaignConfig, callHandler: CallHandler, clock: IClock) {
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

  start(): void {
    if (this.state !== "idle") return;
    this.state = "running";
    this.tryStartCalls();
  }

  pause(): void {
    if (this.state !== "running") return;
    this.state = "paused";
    this.clearAllTimers();
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.state = "running";
    this.tryStartCalls();
  }

  getStatus(): CampaignStatus {
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

  private getLocalDateTime(): DateTime {
    const zone = this.config.timezone || "UTC";
    const dt = DateTime.fromMillis(this.clock.now(), { zone });
    if (!dt.isValid) {
      // Fallback to UTC if timezone is invalid
      return DateTime.fromMillis(this.clock.now(), { zone: "UTC" });
    }
    return dt;
  }

  private checkAndResetDailyStats() {
    const currentDay = this.getLocalDateTime().toFormat("yyyy-MM-dd");
    if (this.lastProcessedDay !== currentDay) {
      this.dailyMinutesUsed = 0;
      this.lastProcessedDay = currentDay;
    }
  }

  private tryStartCalls() {
    if (this.state !== "running") return;

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
      if (!next) break;

      this.startCall(next);
    }

    this.checkCompletion();
  }

  private isWithinWorkingHours(): boolean {
    const now = this.getLocalDateTime();
    const [startH, startM] = this.config.startTime.split(":").map(Number);
    const [endH, endM] = this.config.endTime.split(":").map(Number);

    const currentTime = now.hour * 60 + now.minute;
    const startTime = startH * 60 + startM;
    const endTime = endH * 60 + endM;

    // We assume startTime < endTime (same day)
    return currentTime >= startTime && currentTime < endTime;
  }

  private scheduleNextWorkingWindow() {
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

  private scheduleMidnightReset() {
    const now = this.getLocalDateTime();
    const nextMidnight = now
      .plus({ days: 1 })
      .set({ hour: 0, minute: 0, second: 0, millisecond: 0 });

    const delay = nextMidnight.toMillis() - this.clock.now();
    this.setSafeTimeout(() => this.tryStartCalls(), delay);
  }

  private canStartCall(): boolean {
    if (this.state !== "running") return false;
    if (this.activeCalls >= this.config.maxConcurrentCalls) return false;
    if (this.dailyMinutesUsed >= this.config.maxDailyMinutes) return false;
    return true;
  }

  private pickNextCall(): InternalCall | null {
    const now = this.clock.now();

    // Priority: Retries that are ready
    const readyRetryIdx = this.retryCallsQueue.findIndex(
      (r) => r.readyAt <= now
    );
    if (readyRetryIdx !== -1) {
      const retry = this.retryCallsQueue.splice(readyRetryIdx, 1)[0];
      return {
        phoneNumber: retry.phoneNumber,
        retryCount: retry.retryCount,
      };
    }

    // Then new calls from the queue
    const nextPending = this.pendingCallsQueue.shift();
    if (nextPending) return nextPending;

    // If we have retries but they aren't ready yet, schedule a wake-up
    if (this.retryCallsQueue.length > 0) {
      const earliestRetry = Math.min(
        ...this.retryCallsQueue.map((r) => r.readyAt)
      );
      this.setSafeTimeout(
        () => this.tryStartCalls(),
        earliestRetry - this.clock.now()
      );
    }

    return null;
  }

  private startCall(call: InternalCall) {
    this.activeCalls++;
    this.callHandler(call.phoneNumber)
      .then((result) => this.onCallFinished(call, result))
      .catch(() => this.onCallFinished(call, { answered: false, durationMs: 0 }));
  }

  private onCallFinished(call: InternalCall, result: CallResult) {
    this.activeCalls--;
    this.dailyMinutesUsed += result.durationMs / 60_000;

    if (result.answered) {
      this.totalProcessed++;
    } else {
      this.handleFailure(call);
    }

    this.tryStartCalls();
  }

  private handleFailure(call: InternalCall) {
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

  private checkCompletion() {
    if (
      this.pendingCallsQueue.length === 0 &&
      this.retryCallsQueue.length === 0 &&
      this.activeCalls === 0
    ) {
      this.state = "completed";
      this.clearAllTimers();
    }
  }

  private setSafeTimeout(callback: () => void, delayMs: number) {
    // Prevent negative delays and pilling up same-time timers
    const safeDelay = Math.max(0, delayMs);
    const id = this.clock.setTimeout(() => {
      this.activeTimers.delete(id);
      callback();
    }, safeDelay);
    this.activeTimers.add(id);
  }

  private clearAllTimers() {
    for (const id of this.activeTimers) {
      this.clock.clearTimeout(id);
    }
    this.activeTimers.clear();
  }
}

