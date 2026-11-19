// Perf › chatbot inbox reads load test (human-intervention unit 4; contract
// §10.1 "Cómo se demuestra", performance row "Bandeja agrupada por cliente").
//
// A thin launcher. The load test itself is
// src/chatbot-requests/chatbot-inbox-load.integration.spec.ts, which runs inside
// the project's integration harness (`pnpm test:integration`): the harness
// resolves and guards the test-database URL, so this script never reads an env
// file and cannot point the test at the dev or the production database. The
// spec is skipped in every normal run; this launcher sets PERF=1.
//
//   node scripts/perf/chatbot-inbox-load.cjs [--enforce] [--report <path>]
//
//   --enforce        fail the run when a target is missed (default: report it)
//   --report <path>  where the JSON report goes (default /tmp/chatbot-inbox-load-report.json)
//
// Sizes are environment knobs of the spec: PERF_OPEN=5000 PERF_CUSTOMERS=2000
// PERF_CLOSED=20000 PERF_NOISE_OPEN=2500 PERF_NOISE_CLOSED=10000 PERF_SAMPLES=200.
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SPEC = 'src/chatbot-requests/chatbot-inbox-load.integration.spec.ts';
const USAGE =
  'node scripts/perf/chatbot-inbox-load.cjs [--enforce] [--report <path>]';

function parseArgs(argv) {
  const options = { enforce: false, report: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--enforce') options.enforce = true;
    else if (arg === '--report' && argv[i + 1]) options.report = argv[++i];
    else {
      console.error(`Unknown argument: ${arg}\nUsage: ${USAGE}`);
      process.exit(2);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const env = { ...process.env, PERF: '1' };
if (options.enforce) env.PERF_ENFORCE = '1';
if (options.report) env.PERF_REPORT_PATH = path.resolve(options.report);

const result = spawnSync('pnpm', ['test:integration', SPEC], {
  cwd: path.resolve(__dirname, '..', '..'),
  stdio: 'inherit',
  env,
});
process.exit(result.status === null ? 1 : result.status);
