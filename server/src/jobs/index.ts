import { autoCloseResolved } from '../modules/maintenance/requests.service';

import { sendBillReminders } from '../modules/billing/reminders';

const HOUR = 60 * 60 * 1000;

async function run(name: string, job: () => Promise<number>) {
  try {
    const n = await job();
    if (n > 0) console.log(`[jobs] ${name}: ${n}`);
  } catch (e) {
    console.error(`[jobs] ${name} failed`, e);
  }
}

/**
 * Background jobs. They are safe to run twice or after downtime, so they run at start (to catch up) and then hourly.
 * (Sprint 4 moves these to a daily schedule alongside the bill reminders.)
 */
export function startJobs() {
  const tick = async () => {
    await run('auto-close resolved requests', () => autoCloseResolved());
    await run('bill reminders', () => sendBillReminders());
  };
  void tick();
  setInterval(tick, HOUR).unref();
}
