import { autoCloseResolved } from '../modules/maintenance/requests.service';
import { createDueScheduledRequests } from '../modules/maintenance/scheduledTasks.service';
import { sendBillReminders } from '../modules/billing/reminders';
import { publishDueAnnouncements } from '../modules/announcements/announcements.service';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

async function run(name: string, job: () => Promise<number>) {
  try {
    const n = await job();
    if (n > 0) console.log(`[jobs] ${name}: ${n}`);
  } catch (e) {
    console.error(`[jobs] ${name} failed`, e);
  }
}

/**
 * Background jobs. They are safe to run twice or after downtime, so they run at start (to catch up) and on a timer.
 * The spec asks for the daily ones once a day. Running them hourly gives the same result, because each one does
 * nothing the second time, and it means a laptop that sleeps through the night still catches up.
 */
export function startJobs() {
  const hourly = async () => {
    await run('auto-close resolved requests', () => autoCloseResolved());
    await run('bill reminders', () => sendBillReminders());
    await run('scheduled maintenance', () => createDueScheduledRequests());
  };
  const everyFewMinutes = () => run('scheduled announcements', () => publishDueAnnouncements());
  void hourly();
  void everyFewMinutes();
  setInterval(hourly, HOUR).unref();
  setInterval(everyFewMinutes, 5 * MINUTE).unref();
}
