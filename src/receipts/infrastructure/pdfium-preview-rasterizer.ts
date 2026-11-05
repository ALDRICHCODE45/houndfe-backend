import { Worker } from 'node:worker_threads';
import type { ReceiptPreviewRasterizer } from '../domain/receipt-storage.port';

export const PREVIEW_MAX_SIDE_PX = 1600;
const DEFAULT_TIMEOUT_MS = 15_000;
// Caps the worker's JS heap; PDFium's WASM memory is bounded by the page
// bitmap (<= 1600x1600 BGRA, ~10 MB) plus the parsed document (<= 10 MB file).
const WORKER_HEAP_MB = 256;

/**
 * Runs inside a short-lived worker thread so a hostile PDF cannot block the
 * event loop: PDFium is synchronous WASM and only `worker.terminate()` can
 * stop it. Plain CommonJS because it is evaluated, not compiled.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { PDFiumLibrary } = require(workerData.pdfiumPath);
const { PNG } = require(workerData.pngjsPath);
(async () => {
  const library = await PDFiumLibrary.init();
  const document = await library.loadDocument(new Uint8Array(workerData.pdf));
  try {
    if (document.getPageCount() < 1) throw new Error('PDF has no pages');
    const page = document.getPage(0);
    const { originalWidth, originalHeight } = page.getOriginalSize();
    const longest = Math.max(originalWidth, originalHeight);
    if (!Number.isFinite(longest) || longest <= 0) throw new Error('Invalid page size');
    const scale = workerData.maxSide / longest;
    const bitmap = await page.render({ scale, render: 'bitmap', colorSpace: 'BGRA', transparent: false });
    const png = new PNG({ width: bitmap.width, height: bitmap.height, colorType: 6 });
    const data = bitmap.data;
    for (let i = 0; i < data.length; i += 4) {
      png.data[i] = data[i + 2];
      png.data[i + 1] = data[i + 1];
      png.data[i + 2] = data[i];
      png.data[i + 3] = data[i + 3];
    }
    const bytes = PNG.sync.write(png);
    parentPort.postMessage({ ok: true, bytes }, [bytes.buffer]);
  } finally {
    document.destroy();
    library.destroy();
  }
})().catch((error) => {
  parentPort.postMessage({ ok: false, message: String(error && error.message || error) });
});
`;

type WorkerResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; message: string };

export class PdfiumPreviewRasterizer implements ReceiptPreviewRasterizer {
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  rasterizeFirstPage(
    pdf: Buffer,
  ): Promise<{ bytes: Buffer; mimeType: 'image/png' }> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          pdf: new Uint8Array(pdf),
          maxSide: PREVIEW_MAX_SIDE_PX,
          pdfiumPath: require.resolve('@hyzyla/pdfium'),
          pngjsPath: require.resolve('pngjs'),
        },
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      });
      let settled = false;
      const finish = (error: Error | null, bytes?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        if (error) reject(error);
        else resolve({ bytes: bytes as Buffer, mimeType: 'image/png' });
      };
      const timer = setTimeout(
        () => finish(new Error('PDF preview rasterization timed out')),
        this.timeoutMs,
      );
      worker.once('message', (result: WorkerResult) => {
        if (result.ok) finish(null, Buffer.from(result.bytes));
        else finish(new Error(`PDF preview failed: ${result.message}`));
      });
      worker.once('error', (error) => finish(error));
      worker.once('exit', (code) =>
        finish(new Error(`PDF preview worker exited with code ${code}`)),
      );
    });
  }
}
