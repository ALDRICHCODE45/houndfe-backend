/**
 * T7e: a spec that boots the real AppModule must not get any @Interval /
 * @Cron / @Timeout job registered (SLA sweep, purges, outbox pollers,
 * scanners…) unless it opts in. Also pins the inventory of jobs that exist
 * when a spec does opt in, so a new scheduled provider is noticed.
 */
import { Test } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AppModule } from '../../app.module';
import { enableSchedulersForSpec } from './scheduler-gate';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

async function registered(): Promise<{
  intervals: string[];
  timeouts: string[];
  crons: string[];
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  try {
    const registry = moduleRef.get(SchedulerRegistry, { strict: false });
    return {
      intervals: [...registry.getIntervals()],
      timeouts: [...registry.getTimeouts()],
      crons: [...registry.getCronJobs().keys()],
    };
  } finally {
    await app.close();
  }
}

describeIfDb('scheduled jobs under integration tests (real AppModule)', () => {
  it('registers no interval, timeout or cron by default', async () => {
    await expect(registered()).resolves.toEqual({
      intervals: [],
      timeouts: [],
      crons: [],
    });
  }, 60_000);

  it('registers the application jobs when the spec opts in', async () => {
    const restore = enableSchedulersForSpec();
    try {
      const { intervals, timeouts, crons } = await registered();
      // 17 @Interval providers today (unnamed jobs get generated ids, so the
      // count is the inventory). Update when a scheduled provider is added.
      expect(intervals).toHaveLength(17);
      expect(timeouts).toEqual([]);
      expect(crons).toEqual([]);
    } finally {
      restore();
    }
  }, 60_000);
});
