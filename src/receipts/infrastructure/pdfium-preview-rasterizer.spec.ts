import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
  PdfiumPreviewRasterizer,
  PreviewQueue,
  resolvePreviewChildModule,
} from './pdfium-preview-rasterizer';

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

const fixture = resolvePreviewChildModule(
  'fake-preview-child',
  join(__dirname, 'test-support'),
);

/** Rasterizer forking the misbehaving fixture child in `mode`. */
function fake(
  mode: string,
  options: ConstructorParameters<typeof PdfiumPreviewRasterizer>[0] = {},
) {
  const logFile = join(mkdtempSync(join(tmpdir(), 'rcpt-preview-')), 'log');
  writeFileSync(logFile, '');
  const rasterizer = new PdfiumPreviewRasterizer({
    queue: new PreviewQueue({ concurrency: 1, maxQueued: 3 }),
    ...options,
    child: { ...fixture, args: [mode, logFile] },
  });
  const lines = () =>
    readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' '));
  return { rasterizer, lines, logFile };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

  it('resolves the real child module next to the rasterizer', () => {
    const child = resolvePreviewChildModule();
    expect(existsSync(child.path)).toBe(true);
    expect(child.path).toMatch(/pdf-preview\.child\.(js|ts)$/);
  });

  describe('child process isolation', () => {
    it('rejects when the child exits abnormally and the parent survives', async () => {
      const { rasterizer } = fake('exit');

      await expect(
        rasterizer.rasterizeFirstPage(Buffer.from('%PDF')),
      ).rejects.toThrow(/exited with code 70/);
    });

    it('SIGKILLs a hung child at the deadline', async () => {
      const { rasterizer, lines } = fake('hang', { timeoutMs: 3_000 });

      await expect(
        rasterizer.rasterizeFirstPage(Buffer.from('%PDF')),
      ).rejects.toThrow(/timed out/);

      const pid = Number(lines()[0][1]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(isAlive(pid)).toBe(false);
    });

    it('caps the child JS heap with --max-old-space-size', async () => {
      const { rasterizer } = fake('heap', { heapMb: 32, timeoutMs: 20_000 });

      await expect(
        rasterizer.rasterizeFirstPage(Buffer.from('%PDF')),
      ).rejects.toThrow(/preview child/);
    });

    const linux = existsSync('/proc/self/status') ? it : it.skip;
    linux(
      'kills a child whose off-heap memory exceeds the RSS cap',
      async () => {
        const { rasterizer } = fake('external', {
          maxRssMb: 200,
          timeoutMs: 20_000,
        });

        await expect(
          rasterizer.rasterizeFirstPage(Buffer.from('%PDF')),
        ).rejects.toThrow(/memory cap/);
      },
    );

    it('does not hand the API environment (secrets) to the child', async () => {
      process.env.RCPT_TEST_SECRET = 'x';
      try {
        const { rasterizer, logFile } = fake('env');
        await rasterizer.rasterizeFirstPage(Buffer.from('%PDF'));
        const env = readFileSync(logFile, 'utf8');
        expect(env).toMatch(/^env /m);
        expect(env).not.toContain('RCPT_TEST_SECRET');
        expect(env).not.toContain('DATABASE_URL');
      } finally {
        delete process.env.RCPT_TEST_SECRET;
      }
    });

    it('renders one preview at a time and rejects at once when the queue is full', async () => {
      const queue = new PreviewQueue({ concurrency: 1, maxQueued: 1 });
      const { rasterizer, lines } = fake('slow', { queue });
      const pdf = Buffer.from('%PDF');

      const results = await Promise.allSettled([
        rasterizer.rasterizeFirstPage(pdf),
        rasterizer.rasterizeFirstPage(pdf),
        rasterizer.rasterizeFirstPage(pdf),
      ]);

      expect(results.map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'rejected',
      ]);
      expect((results[2] as PromiseRejectedResult).reason).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/queue is full/) as string,
        }),
      );
      const events = lines();
      expect(events.map(([event]) => event)).toEqual([
        'start',
        'end',
        'start',
        'end',
      ]);
      expect(Number(events[2][2])).toBeGreaterThanOrEqual(Number(events[1][2]));
    });

    it('shares one process-wide queue by default', async () => {
      const first = fake('slow', { queue: undefined });
      const second = new PdfiumPreviewRasterizer({
        child: { ...fixture, args: ['slow', first.logFile] },
      });
      const pdf = Buffer.from('%PDF');

      await Promise.all([
        first.rasterizer.rasterizeFirstPage(pdf),
        second.rasterizeFirstPage(pdf),
      ]);

      expect(first.lines().map(([event]) => event)).toEqual([
        'start',
        'end',
        'start',
        'end',
      ]);
    });

    it('releases the slot after a failure', async () => {
      const queue = new PreviewQueue({ concurrency: 1, maxQueued: 0 });
      const crashing = fake('exit', { queue }).rasterizer;
      const healthy = fake('slow', { queue }).rasterizer;

      await expect(
        crashing.rasterizeFirstPage(Buffer.from('%PDF')),
      ).rejects.toThrow();
      await expect(
        healthy.rasterizeFirstPage(Buffer.from('%PDF')),
      ).resolves.toMatchObject({ mimeType: 'image/png' });
    });
  });
});
