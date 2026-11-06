import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReceiptPreviewRasterizer } from '../domain/receipt-storage.port';
import type { PreviewRequest, PreviewResponse } from './pdf-preview.child';

export const PREVIEW_MAX_SIDE_PX = 1600;
const DEFAULT_TIMEOUT_MS = 15_000;
// Caps the child's V8 heap only. PDFium's WASM linear memory and Buffers
// live outside it, so they are bounded by the RSS watchdog below instead.
const DEFAULT_HEAP_MB = 256;
// Whole-process resident memory cap (Linux /proc); the child is SIGKILLed
// above it. Elsewhere only the timeout and the child boundary apply.
const DEFAULT_MAX_RSS_MB = 512;
const RSS_POLL_MS = 100;
const STDERR_TAIL_BYTES = 2_000;
// At most this many uploads wait for the single preview slot; beyond it the
// preview is UNAVAILABLE at once. Worst-case wait: (1 + 3) x timeout.
const DEFAULT_MAX_QUEUED = 3;

export type PreviewChildModule = {
  path: string;
  execArgv: string[];
  args?: string[];
};

/**
 * Locates the child entry point. Built code (`dist/`) forks the compiled
 * `.js` sibling; under ts-jest only the `.ts` source exists, so it is forked
 * through ts-node's transpile-only hook (a devDependency, never needed in
 * production).
 */
export function resolvePreviewChildModule(
  name = 'pdf-preview.child',
  dir = __dirname,
): PreviewChildModule {
  const compiled = join(dir, `${name}.js`);
  if (existsSync(compiled)) return { path: compiled, execArgv: [] };
  return {
    path: join(dir, `${name}.ts`),
    execArgv: ['--require', require.resolve('ts-node/register/transpile-only')],
  };
}

export class PreviewQueueFullError extends Error {
  constructor() {
    super('PDF preview queue is full');
  }
}

/** Runs at most `concurrency` tasks; up to `maxQueued` more wait in order. */
export class PreviewQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly options: { concurrency: number; maxQueued: number },
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.options.concurrency) {
      this.active += 1;
    } else {
      if (this.waiting.length >= this.options.maxQueued) {
        throw new PreviewQueueFullError();
      }
      // The releasing task hands its slot over without decrementing.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

/** One preview child at a time for the whole API process. */
const PROCESS_PREVIEW_QUEUE = new PreviewQueue({
  concurrency: 1,
  maxQueued: DEFAULT_MAX_QUEUED,
});

/**
 * Rasterizes in a short-lived child process, so a hostile PDF (decompression
 * bomb, PDFium crash, endless render) can only take down the child: it is
 * SIGKILLed at the deadline or above the memory cap, and any abnormal exit
 * rejects, which the upload maps to previewStatus UNAVAILABLE. The child
 * gets no API environment (no secrets).
 */
export class PdfiumPreviewRasterizer implements ReceiptPreviewRasterizer {
  private readonly timeoutMs: number;
  private readonly heapMb: number;
  private readonly maxRssMb: number;
  private readonly queue: PreviewQueue;
  private readonly child: PreviewChildModule;

  constructor(
    options: {
      timeoutMs?: number;
      heapMb?: number;
      maxRssMb?: number;
      queue?: PreviewQueue;
      child?: PreviewChildModule;
    } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.heapMb = options.heapMb ?? DEFAULT_HEAP_MB;
    this.maxRssMb = options.maxRssMb ?? DEFAULT_MAX_RSS_MB;
    this.queue = options.queue ?? PROCESS_PREVIEW_QUEUE;
    this.child = options.child ?? resolvePreviewChildModule();
  }

  rasterizeFirstPage(
    pdf: Buffer,
  ): Promise<{ bytes: Buffer; mimeType: 'image/png' }> {
    return this.queue.run(() => this.renderInChild(pdf));
  }

  private renderInChild(
    pdf: Buffer,
  ): Promise<{ bytes: Buffer; mimeType: 'image/png' }> {
    return new Promise((resolve, reject) => {
      const child = fork(this.child.path, this.child.args ?? [], {
        execArgv: [
          ...this.child.execArgv,
          `--max-old-space-size=${this.heapMb}`,
        ],
        env: process.env.NODE_ENV ? { NODE_ENV: process.env.NODE_ENV } : {},
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let stderr = '';
      let settled = false;

      const finish = (error: Error | null, bytes?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(watchdog);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
        if (error) reject(error);
        else resolve({ bytes: bytes as Buffer, mimeType: 'image/png' });
      };
      const fail = (message: string) => {
        const tail = stderr.trim().split('\n').slice(-3).join(' | ');
        finish(new Error(tail ? `${message}: ${tail}` : message));
      };

      const timer = setTimeout(
        () => fail('PDF preview rasterization timed out'),
        this.timeoutMs,
      );
      const watchdog = setInterval(() => {
        void residentMb(child.pid).then((mb) => {
          if (mb !== null && mb > this.maxRssMb) {
            fail(
              `PDF preview child exceeded the ${this.maxRssMb} MB memory cap`,
            );
          }
        });
      }, RSS_POLL_MS);

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
      });
      child.stderr?.on('error', () => undefined);
      child.once('message', (result: PreviewResponse) => {
        if (result.ok) finish(null, Buffer.from(result.bytes));
        else finish(new Error(`PDF preview failed: ${result.message}`));
      });
      child.once('error', (error) =>
        fail(`PDF preview child failed: ${error.message}`),
      );
      child.once('exit', (code, signal) =>
        fail(
          signal
            ? `PDF preview child killed by ${signal}`
            : `PDF preview child exited with code ${code}`,
        ),
      );

      const request: PreviewRequest = {
        pdf: new Uint8Array(pdf),
        maxSide: PREVIEW_MAX_SIDE_PX,
      };
      child.send(request, (error) => {
        if (error) fail(`PDF preview child unreachable: ${error.message}`);
      });
    });
  }
}

/** @returns the resident set of `pid` in MB, or null when unknown. */
async function residentMb(pid: number | undefined): Promise<number | null> {
  if (pid === undefined) return null;
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return match ? Number(match[1]) / 1024 : null;
  } catch {
    return null;
  }
}
