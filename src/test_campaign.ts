import { Campaign } from "./campaign";
import { CampaignConfig, CallResult, IClock } from "./interfaces";

class MockClock implements IClock {
  private currentTime: number = 0;
  private timers: Map<number, { callback: () => void; readyAt: number }> =
    new Map();
  private nextTimerId: number = 1;

  now() {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextTimerId++;
    this.timers.set(id, { callback, readyAt: this.currentTime + delayMs });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  // Advance time and trigger ready timers
  tick(ms: number) {
    this.currentTime += ms;
    const toTrigger: Array<() => void> = [];
    for (const [id, timer] of this.timers.entries()) {
      if (timer.readyAt <= this.currentTime) {
        toTrigger.push(timer.callback);
        this.timers.delete(id);
      }
    }
    toTrigger.forEach((cb) => cb());
  }
}

async function runTest() {
  const clock = new MockClock();
  const config: CampaignConfig = {
    customerList: ["111", "222", "333", "444", "555"],
    startTime: "09:00",
    endTime: "17:00",
    maxConcurrentCalls: 2,
    maxDailyMinutes: 10,
    maxRetries: 1,
    retryDelayMs: 1000,
    timezone: "UTC",
  };

  const callHandler = async (phone: string): Promise<CallResult> => {
    console.log(`[${clock.now()}] Calling ${phone}...`);
    // Simulated call duration: 3 minutes
    return { answered: true, durationMs: 3 * 60 * 1000 };
  };

  const campaign = new Campaign(config, callHandler, clock);

  console.log("--- Starting campaign at midnight UTC ---");
  campaign.start();
  console.log("Status at midnight:", campaign.getStatus());

  console.log("\n--- Ticking to 09:00 (working hours start) ---");
  clock.tick(9 * 60 * 60 * 1000);
  console.log("Status at 09:00:", campaign.getStatus());

  console.log("\n--- Ticking 1ms to trigger first batch ---");
  clock.tick(1);
  console.log("Status after first calls started:", campaign.getStatus());

  console.log(
    "\n--- Finishing calls (they are async promises in this mock, but Campaign handles them) ---",
  );
  // In a real environment, the promise resolves. Our mock needs to wait.
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log("Status after calls finished:", campaign.getStatus());

  console.log(
    "\n--- Testing Daily Cap (10 mins cap, we used 6 mins already with 2 calls) ---",
  );
  clock.tick(1);
  await new Promise((resolve) => setTimeout(resolve, 100)); // finish 3rd and 4th call (total 12 mins)
  console.log(
    "Status after hitting cap (should be 4 processed, 12 mins):",
    campaign.getStatus(),
  );

  console.log("\n--- Ticking to next midnight (cap reset) ---");
  clock.tick(15 * 60 * 60 * 1000); // 09:00 + 15h = 00:00 next day
  console.log("Status at midnight:", campaign.getStatus());

  console.log("\n--- Ticking to 09:01 (next working window) ---");
  clock.tick(9 * 60 * 60 * 1000 + 60000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log("Status after finishing last call:", campaign.getStatus());
}

runTest().catch(console.error);
