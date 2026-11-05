import { PNG } from 'pngjs';
import { PdfiumPreviewRasterizer } from './pdfium-preview-rasterizer';

/** Builds a tiny valid PDF: one page with a filled black rectangle. */
function tinyPdf(width: number, height: number): Buffer {
  const content = '0 0 0 rg 10 10 50 30 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

describe('PdfiumPreviewRasterizer', () => {
  jest.setTimeout(30_000);

  it('rasterizes the first page into a PNG capped at 1600 px', async () => {
    const rasterizer = new PdfiumPreviewRasterizer();

    const preview = await rasterizer.rasterizeFirstPage(tinyPdf(200, 100));

    expect(preview.mimeType).toBe('image/png');
    const png = PNG.sync.read(preview.bytes);
    expect(png.width).toBe(1600);
    expect(png.height).toBe(800);
    // Opaque white background with the black rectangle somewhere on it.
    expect(png.data[3]).toBe(255);
    expect(
      png.data.some((value, index) => index % 4 !== 3 && value === 0),
    ).toBe(true);
  });

  it('rejects a corrupt PDF', async () => {
    const rasterizer = new PdfiumPreviewRasterizer();
    await expect(
      rasterizer.rasterizeFirstPage(Buffer.from('%PDF-1.4\nnot a pdf')),
    ).rejects.toThrow();
  });

  it('terminates rendering that exceeds the time guard', async () => {
    const rasterizer = new PdfiumPreviewRasterizer({ timeoutMs: 1 });
    await expect(
      rasterizer.rasterizeFirstPage(tinyPdf(200, 100)),
    ).rejects.toThrow(/timed out/);
  });
});
