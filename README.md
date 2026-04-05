# Call Campaign Simulator

A robust Node.js + TypeScript simulator for outbound call campaigns.

## Features

- **Sequential Processing**: Calls numbers in order, prioritizing retries.
- **Concurrency Management**: Respects `maxConcurrentCalls` limit.
- **Scheduling**: Respects daily working hours (`startTime` to `endTime`).
- **Timezone Awareness**: Handles scheduling and daily resets in specified IANA timezones.
- **Daily Usage Cap**: Automatically pauses when `maxDailyMinutes` is reached and resumes at midnight.
- **Retry Logic**: Configurable retries with delays.
- **Pause/Resume**: Full control over campaign execution state.

## Installation

```bash
npm install
```

## Building

```bash
npm run build
```
(Or use `npx tsc`)

## Assumptions

1. **Working Hours**: We assume `startTime` is earlier than `endTime` within the same calendar day. Overnight shifts (e.g., 22:00 to 06:00) are not explicitly supported in the current comparison logic but the implementation follows standard business hours logic.
2. **Daily Cap**: The "risk exceeding" requirement is interpreted as: do not initiate new calls if the daily minute cap has been reached or exceeded. Since call durations are unknown until they finish, a call started just before the cap may push the total slightly over, which is standard for "per-day" limits in most telephony systems.
3. **Timezones**: If an invalid timezone is provided, the system falls back to UTC to ensure continuity.
4. **Clock**: All time operations strictly use the provided `IClock` instance.
