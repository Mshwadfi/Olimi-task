# Design Document — Call Campaign Simulator

## Architecture Overview

The `Campaign` class implements `ICampaign` and acts as a state machine managing three primary queues and call slots:

1.  **Pending Queue**: Original customer numbers.
2.  **Retry Queue**: Failed calls scheduled for future attempts.
3.  **Active Slots**: Currently dialing or in-conversation calls.

The core logic is driven by the `tryStartCalls()` method, which is invoked whenever a state change occurs (start, resume, call finish, timer trigger).

## Scheduling Strategy

We use `luxon` to handle all date/time logic in a timezone-aware manner. 

- **Working Hours**: Checks if `now` (in the campaign's timezone) is within the `startTime` to `endTime` interval.
- **Daily Resets**: Before any call starts, we check if the calendar day (formatted as `yyyy-MM-dd`) has changed since the last reset. This handles the transition from 23:59 to 00:00 automatically.
- **Wake-up Timers**:
    - **Delayed Retries**: Use `setTimeout` to trigger `tryStartCalls` precisely when a retry becomes ready.
    - **Daily Cap**: If the daily cap is hit, we schedule a timer for the next local midnight.
    - **Working Windows**: If outside hours, we schedule for the next `startTime`.

## Edge Case Handling

1.  **DST Transitions**: By using `luxon`'s `DateTime`, we automatically handle day-length changes and potential "missing" or "duplicate" hours during Daylight Saving Time switches.
2.  **Pause/Resume Integrity**: When `pause()` is called, all pending `setTimeout` IDs are explicitly cleared via `clearTimeout`. When `resume()` is called, the state is re-evaluated, and necessary timers are recalculated based on the current `clock.now()`.
3.  **Invalid Configuration**: 
    - Defaults are provided for `maxRetries` (2) and `retryDelayMs` (1 hour) if omitted.
    - Invalid timezones fallback to UTC.
4.  **Concurrent Priority**: Ready retries are prioritized over new calls to ensure we don't build up an infinite backlog of failures while new numbers are still being processed.

## Performance Considerations

All operations are O(1) or O(N) where N is the number of pending retry items. Given the typical campaign size (100 numbers), this is extremely efficient. Timer management is handled via a `Set<number>` for constant-time cleanup.
