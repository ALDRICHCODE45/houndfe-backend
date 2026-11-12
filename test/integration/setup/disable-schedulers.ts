/**
 * Jest setupFile (integration config only).
 *
 * Installs the scheduler gate so `@Interval` / `@Cron` / `@Timeout` jobs do
 * not register when a spec boots `AppModule` (or any module that calls
 * `ScheduleModule.forRoot()`) against the shared test DB. Specs that test a
 * scheduler keep calling its tick explicitly; a spec that truly needs the
 * timers opts in with `enableSchedulersForSpec()` before app init.
 *
 * Runs per test file, in the spec's own module registry, so the patched
 * `ScheduleExplorer` is the same class the spec's Nest app instantiates.
 * The unit config and production never load this file.
 */
import { installSchedulerGate } from '../../../src/shared/scheduling/scheduler-gate';

installSchedulerGate();
