# Design Document — Call Campaign Simulator

## Architecture Overview

The `Campaign` class implements `ICampaign` and acts as an **event-driven state machine** with four states: `idle`, `running`, `paused`, and `completed`.

### Internal Data Structures

| Structure | Type | Purpose |
|---|---|---|
| `pendingCallsQueue` | `InternalCall[]` | Ordered queue of not-yet-attempted phone numbers |
| `retryCallsQueue` | `RetryItem[]` | Failed calls awaiting retry, each with a `readyAt` timestamp |
| `activeTimers` | `Set<number>` | Tracks all scheduled timer IDs for safe cleanup on pause |
| `activeCalls` | `number` | Counter of currently in-progress calls |

### Core Loop: `tryStartCalls()`

The central scheduling method is `tryStartCalls()`. It is invoked on every state transition:

```
start() ──→ tryStartCalls()
resume() ──→ tryStartCalls()
onCallFinished() ──→ checkCompletion() ──→ tryStartCalls()
timer fires ──→ tryStartCalls()
```

The method follows a decision cascade:

```
tryStartCalls()
  ├─ Check state === "running"           → exit if not
  ├─ Reset daily stats if day changed
  ├─ Check working hours                 → schedule wake-up & exit if outside
  ├─ Check daily cap                     → schedule midnight reset & exit if hit
  └─ Fill available call slots
       ├─ Pick ready retry (priority)
       ├─ Pick next pending number
       └─ Schedule retry wake-up if only future retries remain
```

This design ensures that every state change naturally re-evaluates all constraints without redundant logic.

---

## Scheduling Strategy

All scheduling uses the injected `IClock.setTimeout()`. Three types of delayed wake-ups exist:

### 1. Working Window Wake-up
When `tryStartCalls()` detects we're outside working hours, it calculates the next `startTime` in the campaign's timezone and schedules a timer.

### 2. Daily Cap Midnight Reset
When the daily minute cap is reached, a timer is set for the next local midnight. On trigger, `tryStartCalls()` runs again with a fresh daily budget.

### 3. Retry Delay Wake-up
When a call fails and is queued for retry, a timer fires at `now + retryDelayMs`. Additionally, if `pickNextCall()` finds only future retries (none ready yet), it schedules a wake-up for the earliest one.

### Timer Safety
- All timers go through `setSafeTimeout()`, which clamps negative delays to 0 and tracks IDs.
- `pause()` clears all timers via `clearAllTimers()`.
- `resume()` calls `tryStartCalls()` which recalculates all necessary timers from scratch.

---

## Timezone Handling (Plus Task)

### Implementation

All date/time operations use `luxon`'s `DateTime.fromMillis(clock.now(), { zone })` where `zone` is the campaign's configured IANA timezone string.

This means:
- **Working hours** (`startTime` / `endTime`) are compared against the local time in the campaign timezone.
- **Daily resets** happen at midnight in the campaign timezone, not UTC.
- **The IClock remains timezone-agnostic** — it deals only in UTC milliseconds. Timezone conversion is purely a campaign-layer concern.

### Invalid Timezone

If the timezone string is invalid (e.g., `"Not/A/Zone"`), `DateTime.fromMillis()` returns an invalid DateTime. We detect this via `dt.isValid` and fall back to UTC silently.

### DST Edge Cases

#### Spring Forward (Clocks Skip Ahead)

**Scenario**: Campaign timezone is `"America/New_York"`, `startTime` is `"02:30"`.
On the spring-forward day, 2:00 AM jumps to 3:00 AM — the time 02:30 **does not exist**.

**Behavior**: Luxon resolves non-existent local times by pushing forward to the next valid time. So `02:30` effectively becomes `03:00`, and the working window starts 30 minutes late on that specific day. This is the correct real-world behavior — you can't make calls at a time that doesn't exist.

#### Fall Back (Clocks Repeat)

**Scenario**: Same timezone, `endTime` is `"01:30"`.
On the fall-back day, 1:00 AM occurs twice. The working window check (`currentTime < endTime`) works correctly because Luxon's offset-aware arithmetic handles the ambiguity — it uses the first occurrence by default.

**Impact on daily minutes**: The calendar day is one hour longer during fall-back. Since we track minutes used (not wall-clock time), the daily cap is unaffected. However, the working window is effectively one hour longer too (if it spans the transition), which is the physically correct behavior.

#### Working Window Duration Changes

On a spring-forward day, the wall-clock working window is one hour shorter. On a fall-back day, it's one hour longer. We do **not** attempt to compensate — the window is defined by wall-clock times, and the actual available minutes naturally vary. This matches how real-world business hours operate.

---

## Completion Detection

The `checkCompletion()` method is called in two places:

1. **Inside `onCallFinished()`** — immediately after recording the result. This is the primary completion check and catches the case where the last call finishes outside working hours (which would otherwise cause `tryStartCalls()` to exit early before reaching the completion check).

2. **Inside `tryStartCalls()`** — at the end of the call-filling loop, as a secondary catch-all.

Completion requires all three conditions:
- `pendingCallsQueue` is empty
- `retryCallsQueue` is empty
- `activeCalls === 0`

---

## Concurrency Model

JavaScript's single-threaded event loop guarantees that `tryStartCalls()` executes atomically — even if multiple timers fire at the same logical time, they are processed sequentially. This means:

- No race conditions between concurrent `tryStartCalls()` invocations
- The `activeCalls` counter is always accurate
- No mutex or locking is needed

The `callHandler` returns a Promise. When it resolves, `onCallFinished()` decrements `activeCalls` and re-triggers scheduling. Since promise callbacks are microtasks processed in order, the system remains consistent.

---

## Performance Characteristics

| Operation | Complexity | Notes |
|---|---|---|
| Start a call | O(R) | Scans retry queue for ready items (R = retry queue length) |
| Complete a call | O(1) | Counter decrement + push to retry or increment processed |
| Check working hours | O(1) | Simple arithmetic comparison |
| Pause | O(T) | Clears T active timers |
| Get status | O(1) | Returns cached counters |

For a campaign of 100 numbers with at most 200 retries (100 × maxRetries), all operations are effectively instant.
