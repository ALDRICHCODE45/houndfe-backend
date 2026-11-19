/**
 * Scheduler gate — keeps `@Interval` / `@Cron` / `@Timeout` jobs from
 * registering under integration tests unless a spec explicitly opts in.
 *
 * WHY: many integration specs boot the whole `AppModule` (and several
 * feature modules call `ScheduleModule.forRoot()` themselves), so every
 * scheduled job (SLA sweep, purges, outbox pollers, promotion scanners…)
 * ticked against the shared test DB while unrelated specs ran, producing
 * intermittent cross-spec failures. Specs that test a scheduler call its
 * `tick()` explicitly, so none of them needs the timer.
 *
 * HOW: `ScheduleExplorer.explore()` is what discovers decorated methods and
 * registers their timers at `onModuleInit`. This gate wraps it so it is a
 * no-op unless `HOUNDFE_SCHEDULERS=on` at init time. A single prototype
 * patch covers every `ScheduleModule.forRoot(...)` instance, so no feature
 * module has to change.
 *
 * SCOPE: this file is only imported by the integration Jest setup file
 * (`test/integration/setup/disable-schedulers.ts`) and its own spec. It is
 * NOT imported by application code, so production and dev keep the library
 * default (schedulers on).
 */
import { ScheduleExplorer } from '@nestjs/schedule/dist/schedule.explorer';

export const SCHEDULERS_ENV_FLAG = 'HOUNDFE_SCHEDULERS';
const ENABLED_VALUE = 'on';
const INSTALLED = Symbol.for('houndfe.schedulerGate.installed');

type Explorer = { explore: () => void; [INSTALLED]?: true };

/**
 * Wraps `ScheduleExplorer.prototype.explore`. Idempotent: if already
 * installed it returns a no-op restore function. The returned function
 * restores the original method.
 */
export function installSchedulerGate(): () => void {
  // SAFETY: `explore` is a public method of ScheduleExplorer (its .d.ts omits
  // the marker symbol only); the cast adds the symbol slot we own.
  const proto = ScheduleExplorer.prototype as unknown as Explorer;
  if (proto[INSTALLED]) return () => undefined;

  const original = proto.explore;
  proto.explore = function gatedExplore(this: unknown): void {
    if (process.env[SCHEDULERS_ENV_FLAG] !== ENABLED_VALUE) return;
    original.call(this);
  };
  proto[INSTALLED] = true;

  return () => {
    proto.explore = original;
    delete proto[INSTALLED];
  };
}

/**
 * Spec opt-in: call before the Nest app/module is initialized (e.g. in
 * `beforeAll`), and call the returned function in `afterAll`.
 */
export function enableSchedulersForSpec(): () => void {
  const previous = process.env[SCHEDULERS_ENV_FLAG];
  process.env[SCHEDULERS_ENV_FLAG] = ENABLED_VALUE;
  return () => {
    if (previous === undefined) delete process.env[SCHEDULERS_ENV_FLAG];
    else process.env[SCHEDULERS_ENV_FLAG] = previous;
  };
}
