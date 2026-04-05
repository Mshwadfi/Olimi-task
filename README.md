# Call Campaign Simulator

A robust Node.js + TypeScript simulator for outbound call campaigns with timezone awareness, concurrency management, retry logic, and schedule-aware execution.

## Features

- **Sequential Processing**: Calls numbers in order, prioritizing due retries over new calls.
- **Concurrency Management**: Respects `maxConcurrentCalls` limit at all times.
- **Working Hours Scheduling**: Only places calls within the configured daily window (`startTime`–`endTime`). Auto-resumes when the next window opens.
- **Timezone Awareness** *(Plus Task)*: Interprets working hours and daily resets in the campaign's configured IANA timezone.
- **Daily Usage Cap**: Tracks cumulative call minutes per calendar day. Pauses new call initiation when the cap is reached and auto-resumes at the next local midnight.
- **Retry Logic**: Configurable max retries and retry delay. Failed calls are re-queued with exponential scheduling.
- **Pause / Resume**: Full lifecycle control — pausing clears all pending timers; resuming re-evaluates state from scratch.
- **IClock Abstraction**: All time operations go through an injected `IClock` interface, enabling deterministic testing.

## Installation

```bash
npm install
```

## Building

```bash
npm run build
```

## Running the Test Script

```bash
npx ts-node test_campaign.ts
```

---

## Assumptions & Design Decisions

The task specification leaves several behaviors intentionally ambiguous. Below are the assumptions made, along with the reasoning behind each.

### 1. Working Hours — Same-Day Window Only

**Assumption**: `startTime` is always earlier than `endTime` within the same calendar day.

**Rationale**: The spec examples use `"09:00"` to `"17:00"`, which is a standard business-hours pattern. Overnight windows (e.g., `"22:00"` to `"06:00"`) would require significantly different comparison logic and are not a typical outbound calling scenario. If overnight support were needed, the time-range check would split into two sub-ranges straddling midnight.

### 2. Working Hours — Boundary Semantics

**Assumption**: Calls may be initiated at or after `startTime` and strictly before `endTime`. A call will **not** be initiated at exactly `endTime`.

**Rationale**: The spec says calls are placed *"between startTime and endTime"*. We interpret `startTime` as inclusive and `endTime` as exclusive, which is the standard half-open interval `[start, end)` used in most scheduling systems. This prevents a call from being placed at the very last moment of the window with no remaining time.

### 3. Daily Minute Cap — Post-Hoc Accounting

**Assumption**: Call duration is unknown until the call completes. The daily cap is checked *before* initiating a call, but the actual minutes are recorded *after* the call finishes. This means the total may slightly exceed the configured `maxDailyMinutes` when concurrent calls finish.

**Rationale**: Since the `CallHandler` is a black box that resolves with duration only upon completion, pre-estimating duration is impossible. In real telephony systems, daily caps are typically soft limits with post-hoc accounting — the system stops *initiating* new calls once the budget is consumed, but does not terminate calls in progress. This is the behavior we implement.

**Example**: With `maxDailyMinutes: 120` and `maxConcurrentCalls: 3`, if three 50-minute calls are active simultaneously, the final total could reach 150 minutes. No new calls would be started after 120 minutes are recorded.

### 4. Retry Priority Over New Calls

**Assumption**: When a call slot opens, due retries (those whose `retryDelayMs` has elapsed) are serviced before new numbers from the customer list.

**Rationale**: This prevents a growing backlog of unresolved retries. If new calls were always prioritized, retries could be indefinitely starved. Prioritizing retries ensures failed numbers are resolved promptly, which is typically the desired behavior in production call campaigns.

### 5. Campaign Lifecycle — Single Use

**Assumption**: `start()` can only be called once (from `idle` state). Calling `start()` on a `running`, `paused`, or `completed` campaign is a no-op.

**Rationale**: The spec defines a linear lifecycle: `idle → running ⇄ paused → completed`. There is no mention of restarting a completed campaign. If restart were required, it would need to re-initialize internal state, which is better served by creating a new `Campaign` instance.

### 6. Active Calls During Pause

**Assumption**: When `pause()` is called, currently active calls are allowed to finish. Their results are recorded normally. However, no *new* calls are initiated until `resume()` is called.

**Rationale**: The spec explicitly states *"Active calls may finish"* during pause. Abruptly terminating in-progress calls would be destructive and unrealistic in a telephony context.

### 7. Timezone Fallback

**Assumption**: If the `timezone` field is omitted, empty, or contains an invalid IANA string, the campaign defaults to UTC.

**Rationale**: Failing hard on an invalid timezone would halt the entire campaign. A UTC fallback is safe and predictable. The fallback is logged implicitly by Luxon's `DateTime.isValid` check, and the campaign continues operating.

### 8. Call Handler Errors

**Assumption**: If the injected `CallHandler` promise rejects (throws), the call is treated as unanswered with zero duration (`{ answered: false, durationMs: 0 }`), and normal retry logic applies.

**Rationale**: The spec doesn't define behavior for handler exceptions. Treating exceptions as failures is the safest approach — the number gets retried, and the campaign doesn't crash.

### 9. Completion State

**Assumption**: The campaign transitions to `completed` when all three conditions are met simultaneously:
1. The pending queue is empty (all numbers have been attempted)
2. The retry queue is empty (no retries are scheduled)
3. No calls are currently active

**Rationale**: This matches the spec's definition: *"all numbers have been called and either succeeded or exhausted their retry attempts — and no retries remain pending."*

### 10. Timer Cleanup on Pause

**Assumption**: `pause()` clears all pending timers (retry wake-ups, working-window wake-ups, midnight reset timers). `resume()` recalculates everything from scratch based on the current clock time.

**Rationale**: Timers scheduled before the pause may be stale (e.g., a retry timer set for 1 hour ago). Clearing and recalculating ensures the campaign resumes with accurate scheduling.
