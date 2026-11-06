/**
 * Misbehaving stand-in for `pdf-preview.child.ts`, forked by the rasterizer
 * spec. argv: <mode> <logFile>. Every run appends `start`/`end` lines with
 * its pid to the log so the spec can check kills and concurrency.
 */
import { appendFileSync } from 'node:fs';

const [mode, logFile] = process.argv.slice(2);
const log = (line: string) =>
  appendFileSync(logFile, `${line} ${process.pid} ${Date.now()}\n`);

function reply(bytes: number[]): void {
  process.send?.({ ok: true, bytes: new Uint8Array(bytes) }, () =>
    process.disconnect(),
  );
}

/** Synchronous like PDFium: only a signal stops it before the deadline. */
function hang(): void {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    // busy
  }
}

/** Grows the JS heap until --max-old-space-size aborts the process. */
function exhaustHeap(): void {
  const hog: number[][] = [];
  for (let i = 0; i < 1_000_000; i += 1) {
    hog.push(new Array<number>(1_000_000).fill(i));
  }
}

/** Off-heap memory, like PDFium's WASM buffer: not capped by the heap flag. */
function growExternal(): void {
  const hog: Buffer[] = [];
  setInterval(() => {
    for (let i = 0; i < 8; i += 1) hog.push(Buffer.alloc(8 * 1024 * 1024, 1));
  }, 20);
}

const modes: Record<string, () => void> = {
  exit: () => process.exit(70),
  hang,
  heap: exhaustHeap,
  external: growExternal,
  env: () => {
    appendFileSync(
      logFile,
      `env ${JSON.stringify(Object.keys(process.env))}\n`,
    );
    reply([1]);
  },
  slow: () => {
    setTimeout(() => {
      log('end');
      reply([1, 2, 3]);
    }, 300);
  },
};

process.once('message', () => {
  log('start');
  modes[mode]();
});
