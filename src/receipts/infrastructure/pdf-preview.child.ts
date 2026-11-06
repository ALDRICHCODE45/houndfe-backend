/**
 * Child process entry point that rasterizes the first page of a receipt PDF
 * (forked by PdfiumPreviewRasterizer, never imported by the API). It
 * receives one request over IPC, answers once and disconnects. A hostile PDF
 * can only crash, hang or exhaust this process; the parent kills it and
 * marks the preview UNAVAILABLE.
 */
import { PDFiumLibrary } from '@hyzyla/pdfium';
import { PNG } from 'pngjs';

export type PreviewRequest = { pdf: Uint8Array; maxSide: number };

export type PreviewResponse =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; message: string };

async function renderFirstPage(request: PreviewRequest): Promise<Buffer> {
  const library = await PDFiumLibrary.init();
  const document = await library.loadDocument(request.pdf);
  try {
    if (document.getPageCount() < 1) throw new Error('PDF has no pages');
    const page = document.getPage(0);
    const { originalWidth, originalHeight } = page.getOriginalSize();
    const longest = Math.max(originalWidth, originalHeight);
    if (!Number.isFinite(longest) || longest <= 0) {
      throw new Error('Invalid page size');
    }
    const bitmap = await page.render({
      scale: request.maxSide / longest,
      render: 'bitmap',
      colorSpace: 'BGRA',
      transparent: false,
    });
    const png = new PNG({
      width: bitmap.width,
      height: bitmap.height,
      colorType: 6,
    });
    const data = bitmap.data;
    for (let i = 0; i < data.length; i += 4) {
      png.data[i] = data[i + 2];
      png.data[i + 1] = data[i + 1];
      png.data[i + 2] = data[i];
      png.data[i + 3] = data[i + 3];
    }
    return PNG.sync.write(png);
  } finally {
    document.destroy();
    library.destroy();
  }
}

function reply(response: PreviewResponse): void {
  process.send?.(response, () => process.disconnect());
}

process.once('message', (request: PreviewRequest) => {
  renderFirstPage(request).then(
    (bytes) => reply({ ok: true, bytes: new Uint8Array(bytes) }),
    (error: unknown) =>
      reply({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }),
  );
});
