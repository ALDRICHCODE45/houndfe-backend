import { Injectable } from '@nestjs/common';
import { Interval, ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import {
  SCHEDULERS_ENV_FLAG,
  enableSchedulersForSpec,
  installSchedulerGate,
} from './scheduler-gate';

@Injectable()
class TickingJob {
  @Interval('gate-spec-job', 60_000)
  tick(): void {
    // never fires within this spec (60 s); registration is what we observe.
  }
}

async function bootAndListIntervals(): Promise<string[]> {
  const moduleRef = await Test.createTestingModule({
    imports: [ScheduleModule.forRoot()],
    providers: [TickingJob],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  try {
    return [...moduleRef.get(SchedulerRegistry).getIntervals()];
  } finally {
    await app.close();
  }
}

describe('scheduler gate (integration-test scheduler isolation)', () => {
  const original = process.env[SCHEDULERS_ENV_FLAG];

  afterEach(() => {
    if (original === undefined) delete process.env[SCHEDULERS_ENV_FLAG];
    else process.env[SCHEDULERS_ENV_FLAG] = original;
  });

  it('registers @Interval jobs by default when the gate is not installed (production/dev behavior)', async () => {
    delete process.env[SCHEDULERS_ENV_FLAG];
    await expect(bootAndListIntervals()).resolves.toEqual(['gate-spec-job']);
  });

  describe('once installed', () => {
    let uninstall: () => void;
    beforeEach(() => {
      uninstall = installSchedulerGate();
    });
    afterEach(() => uninstall());

    it('does not register any interval unless the spec opts in', async () => {
      delete process.env[SCHEDULERS_ENV_FLAG];
      await expect(bootAndListIntervals()).resolves.toEqual([]);
    });

    it('registers intervals when the spec opts in, and restores the gate afterwards', async () => {
      const restore = enableSchedulersForSpec();
      await expect(bootAndListIntervals()).resolves.toEqual(['gate-spec-job']);
      restore();
      await expect(bootAndListIntervals()).resolves.toEqual([]);
    });

    it('is idempotent: installing twice neither stacks wrappers nor breaks opt-in', async () => {
      const second = installSchedulerGate();
      const restore = enableSchedulersForSpec();
      await expect(bootAndListIntervals()).resolves.toEqual(['gate-spec-job']);
      restore();
      second();
    });
  });
});
