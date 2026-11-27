import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  buildZip,
  toDosDateTime,
  ZipBuildError,
  ZIP32_MAX_ENTRIES,
} from './zip-writer';

// ---------------------------------------------------------------------------
// Independent test-side reader: table-based CRC-32 and a minimal parser of the
// end-of-central-directory record, central directory and local file headers.
// It intentionally shares no code with the writer.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function referenceCrc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ParsedEntry {
  name: string;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  data: Buffer;
}

interface ParsedZip {
  entries: ParsedEntry[];
  centralDirectoryOffset: number;
  centralDirectorySize: number;
}

function parseZip(zip: Buffer): ParsedZip {
  // EOCD is the last 22 bytes when there is no archive comment.
  const eocd = zip.length - 22;
  expect(eocd).toBeGreaterThanOrEqual(0);
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  expect(zip.readUInt16LE(eocd + 4)).toBe(0); // disk number
  expect(zip.readUInt16LE(eocd + 6)).toBe(0); // disk with central dir
  const entriesOnDisk = zip.readUInt16LE(eocd + 8);
  const totalEntries = zip.readUInt16LE(eocd + 10);
  expect(entriesOnDisk).toBe(totalEntries);
  const centralDirectorySize = zip.readUInt32LE(eocd + 12);
  const centralDirectoryOffset = zip.readUInt32LE(eocd + 16);
  expect(zip.readUInt16LE(eocd + 20)).toBe(0); // comment length
  expect(centralDirectoryOffset + centralDirectorySize).toBe(eocd);

  const entries: ParsedEntry[] = [];
  let p = centralDirectoryOffset;
  for (let i = 0; i < totalEntries; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const dosTime = zip.readUInt16LE(p + 12);
    const dosDate = zip.readUInt16LE(p + 14);
    const crc = zip.readUInt32LE(p + 16);
    const compressedSize = zip.readUInt32LE(p + 20);
    const uncompressedSize = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    const localHeaderOffset = zip.readUInt32LE(p + 42);
    const nameBytes = zip.subarray(p + 46, p + 46 + nameLength);
    const name = nameBytes.toString('utf8');

    // Local header must agree with the central directory.
    const l = localHeaderOffset;
    expect(zip.readUInt32LE(l)).toBe(0x04034b50);
    expect(zip.readUInt16LE(l + 6)).toBe(flags);
    expect(zip.readUInt16LE(l + 8)).toBe(method);
    expect(zip.readUInt16LE(l + 10)).toBe(dosTime);
    expect(zip.readUInt16LE(l + 12)).toBe(dosDate);
    expect(zip.readUInt32LE(l + 14)).toBe(crc);
    expect(zip.readUInt32LE(l + 18)).toBe(compressedSize);
    expect(zip.readUInt32LE(l + 22)).toBe(uncompressedSize);
    const localNameLength = zip.readUInt16LE(l + 26);
    const localExtraLength = zip.readUInt16LE(l + 28);
    expect(
      zip.subarray(l + 30, l + 30 + localNameLength).equals(nameBytes),
    ).toBe(true);
    const dataStart = l + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect([0, 8]).toContain(method);
    expect(data.length).toBe(uncompressedSize);
    expect(referenceCrc32(data)).toBe(crc);

    entries.push({
      name,
      flags,
      method,
      dosTime,
      dosDate,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      data,
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  expect(p).toBe(centralDirectoryOffset + centralDirectorySize);
  return { entries, centralDirectoryOffset, centralDirectorySize };
}

// ---------------------------------------------------------------------------
// System unzip (Info-ZIP) as a second, fully external reader.
// ---------------------------------------------------------------------------

const UNZIP_AVAILABLE =
  spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0;
const UNZIP_ENV = { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' };
if (!UNZIP_AVAILABLE) {
  console.warn(
    '[zip-writer.spec] system `unzip` not found: external-reader tests are skipped',
  );
}
const itWithUnzip = UNZIP_AVAILABLE ? it : it.skip;

function listFilesRecursively(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    return statSync(full).isDirectory()
      ? listFilesRecursively(full, rel)
      : [rel];
  });
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'zip-writer-spec-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes the archive, runs `unzip -t`, extracts it and returns name → bytes. */
function extractWithSystemUnzip(zip: Buffer): Map<string, Buffer> {
  return withTempDir((dir) => {
    const archive = join(dir, 'archive.zip');
    const out = join(dir, 'out');
    writeFileSync(archive, zip);
    const test = execFileSync('unzip', ['-t', archive], {
      env: UNZIP_ENV,
    }).toString();
    expect(test).toMatch(/No errors detected/);
    execFileSync('unzip', ['-q', archive, '-d', out], { env: UNZIP_ENV });
    const files = new Map<string, Buffer>();
    for (const rel of listFilesRecursively(out)) {
      files.set(rel.normalize('NFC'), readFileSync(join(out, rel)));
    }
    return files;
  });
}

// A small PDF-like binary buffer: header, every byte value, and NULs.
const PDF_LIKE = Buffer.concat([
  Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'),
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  Buffer.alloc(64, 0),
  Buffer.from('\n%%EOF\n', 'latin1'),
]);

const FIXED_DATE = new Date(2026, 10, 27, 13, 45, 30); // local time

describe('buildZip', () => {
  describe('structure (in-test parser)', () => {
    it('builds a valid empty archive (EOCD only)', () => {
      const zip = buildZip([]);
      expect(zip.length).toBe(22);
      const parsed = parseZip(zip);
      expect(parsed.entries).toEqual([]);
      expect(parsed.centralDirectoryOffset).toBe(0);
    });

    it('builds a one-entry archive with correct CRC, sizes and STORE method', () => {
      const data = Buffer.from('hola mundo');
      const zip = buildZip([{ name: 'a.txt', data, modifiedAt: FIXED_DATE }]);
      const [entry] = parseZip(zip).entries;
      expect(entry.name).toBe('a.txt');
      expect(entry.method).toBe(0);
      expect(entry.crc).toBe(referenceCrc32(data));
      expect(entry.compressedSize).toBe(data.length);
      expect(entry.uncompressedSize).toBe(data.length);
      expect(entry.data.equals(data)).toBe(true);
      expect(entry.localHeaderOffset).toBe(0);
    });

    it('matches the well-known CRC-32 check value for "123456789"', () => {
      const zip = buildZip([{ name: 'check', data: Buffer.from('123456789') }]);
      expect(parseZip(zip).entries[0].crc).toBe(0xcbf43926);
    });

    it('keeps many entries in input order with increasing offsets', () => {
      const inputs = Array.from({ length: 50 }, (_, i) => ({
        name: `file-${String(i).padStart(2, '0')}.bin`,
        data: Buffer.from(`content ${i} `.repeat(i + 1)),
      }));
      const parsed = parseZip(buildZip(inputs));
      expect(parsed.entries.map((e) => e.name)).toEqual(
        inputs.map((e) => e.name),
      );
      parsed.entries.forEach((e, i) =>
        expect(e.data.equals(inputs[i].data)).toBe(true),
      );
      const offsets = parsed.entries.map((e) => e.localHeaderOffset);
      expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    });

    it('stores zero-length entries', () => {
      const [entry] = parseZip(
        buildZip([{ name: 'empty.txt', data: Buffer.alloc(0) }]),
      ).entries;
      expect(entry.uncompressedSize).toBe(0);
      expect(entry.crc).toBe(0);
    });

    it('encodes names as UTF-8 and sets general-purpose flag bit 11', () => {
      const names = ['Ana López.pdf', 'Muñoz Ñandú.pdf', 'Çé ü 日本.pdf'];
      const parsed = parseZip(
        buildZip(names.map((name) => ({ name, data: Buffer.from(name) }))),
      );
      expect(parsed.entries.map((e) => e.name)).toEqual(names);
      parsed.entries.forEach((e) => expect(e.flags & 0x0800).toBe(0x0800));
    });

    it('normalizes names to NFC so decomposed accents are stored canonically', () => {
      const decomposed = 'Lo\u0301pez.pdf';
      const [entry] = parseZip(
        buildZip([{ name: decomposed, data: Buffer.from('x') }]),
      ).entries;
      expect(entry.name).toBe('L\u00f3pez.pdf');
    });

    it('round-trips binary PDF-like data byte-identically', () => {
      const [entry] = parseZip(
        buildZip([{ name: 'doc.pdf', data: PDF_LIKE }]),
      ).entries;
      expect(entry.data.equals(PDF_LIKE)).toBe(true);
      expect(entry.crc).toBe(referenceCrc32(PDF_LIKE));
    });

    it('writes the DOS timestamp of modifiedAt', () => {
      const [entry] = parseZip(
        buildZip([
          { name: 'a', data: Buffer.from('x'), modifiedAt: FIXED_DATE },
        ]),
      ).entries;
      expect(entry.dosDate).toBe(((2026 - 1980) << 9) | (11 << 5) | 27);
      expect(entry.dosTime).toBe((13 << 11) | (45 << 5) | 15);
    });

    it('defaults modifiedAt to options.now', () => {
      const [entry] = parseZip(
        buildZip([{ name: 'a', data: Buffer.from('x') }], { now: FIXED_DATE }),
      ).entries;
      expect(entry.dosDate).toBe(((2026 - 1980) << 9) | (11 << 5) | 27);
    });

    it('is deterministic for the same input', () => {
      const input = [{ name: 'a.pdf', data: PDF_LIKE, modifiedAt: FIXED_DATE }];
      expect(buildZip(input).equals(buildZip(input))).toBe(true);
    });

    it('allows relative sub-directory paths', () => {
      const [entry] = parseZip(
        buildZip([{ name: 'dir/sub/a.txt', data: Buffer.from('x') }]),
      ).entries;
      expect(entry.name).toBe('dir/sub/a.txt');
    });
  });

  describe('DEFLATE', () => {
    it('deflates compressible data and inflates back byte-identically', () => {
      const data = Buffer.from('estado de cuenta '.repeat(500));
      const [entry] = parseZip(
        buildZip([{ name: 'a.txt', data }], { compression: 'deflate' }),
      ).entries;
      expect(entry.method).toBe(8);
      expect(entry.compressedSize).toBeLessThan(data.length);
      expect(entry.data.equals(data)).toBe(true);
    });

    it('falls back to STORE when deflate does not shrink the entry', () => {
      const data = Buffer.from([0x01]);
      const [entry] = parseZip(
        buildZip([{ name: 'a', data }], { compression: 'deflate' }),
      ).entries;
      expect(entry.method).toBe(0);
    });
  });

  describe('validation', () => {
    const d = Buffer.from('x');
    const expectCode = (fn: () => unknown, code: string) => {
      let caught: unknown;
      try {
        fn();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ZipBuildError);
      expect((caught as ZipBuildError).code).toBe(code);
      expect((caught as ZipBuildError).message.length).toBeGreaterThan(10);
    };

    it('rejects duplicate names', () => {
      expectCode(
        () =>
          buildZip([
            { name: 'a.pdf', data: d },
            { name: 'a.pdf', data: d },
          ]),
        'ZIP_DUPLICATE_ENTRY_NAME',
      );
    });

    it('rejects names that collide case-insensitively or after NFC normalization', () => {
      expectCode(
        () =>
          buildZip([
            { name: 'Ana.pdf', data: d },
            { name: 'ANA.PDF', data: d },
          ]),
        'ZIP_DUPLICATE_ENTRY_NAME',
      );
      expectCode(
        () =>
          buildZip([
            { name: 'López.pdf', data: d },
            { name: 'Lo\u0301pez.pdf', data: d },
          ]),
        'ZIP_DUPLICATE_ENTRY_NAME',
      );
    });

    it.each([
      ['empty', ''],
      ['absolute', '/etc/passwd'],
      ['parent traversal', '../evil.pdf'],
      ['nested traversal', 'a/../../evil.pdf'],
      ['dot segment', './a.pdf'],
      ['empty segment', 'a//b.pdf'],
      ['trailing slash (directory)', 'dir/'],
      ['backslash', 'a\\b.pdf'],
      ['windows drive', 'C:evil.pdf'],
      ['NUL byte', 'a\u0000b.pdf'],
      ['control char', 'a\nb.pdf'],
    ])('rejects an invalid name: %s', (_label, name) => {
      expectCode(() => buildZip([{ name, data: d }]), 'ZIP_INVALID_ENTRY_NAME');
    });

    it('rejects a name longer than 65,535 UTF-8 bytes', () => {
      expectCode(
        () => buildZip([{ name: 'ñ'.repeat(40000), data: d }]),
        'ZIP_INVALID_ENTRY_NAME',
      );
    });

    it('rejects non-Buffer data', () => {
      expectCode(
        () => buildZip([{ name: 'a', data: 'text' as unknown as Buffer }]),
        'ZIP_INVALID_ENTRY_DATA',
      );
    });

    it('rejects an invalid modifiedAt', () => {
      expectCode(
        () => buildZip([{ name: 'a', data: d, modifiedAt: new Date('nope') }]),
        'ZIP_INVALID_ENTRY_DATE',
      );
    });

    it('rejects more than 65,535 entries before touching any data', () => {
      expect(ZIP32_MAX_ENTRIES).toBe(65535);
      const many = Array.from({ length: ZIP32_MAX_ENTRIES + 1 }, (_, i) => ({
        name: `f${i}`,
        data: d,
      }));
      expectCode(() => buildZip(many), 'ZIP_TOO_MANY_ENTRIES');
    });

    it('accepts exactly 65,535 entries', () => {
      const many = Array.from({ length: ZIP32_MAX_ENTRIES }, (_, i) => ({
        name: `f${i}`,
        data: d,
      }));
      const zip = buildZip(many);
      expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(65535);
    });

    it('rejects an entry of 4 GiB or more (Zip64 not supported)', () => {
      // A Buffer-shaped stand-in: size limits are checked before any byte is read.
      const huge = Object.create(Buffer.prototype as object) as Buffer;
      Object.defineProperty(huge, 'length', { value: 2 ** 32 });
      expectCode(
        () => buildZip([{ name: 'big.bin', data: huge }]),
        'ZIP_ENTRY_TOO_LARGE',
      );
    });

    it('rejects an archive that would exceed 4 GiB in total', () => {
      const big = Object.create(Buffer.prototype as object) as Buffer;
      Object.defineProperty(big, 'length', { value: 2 ** 31 });
      expectCode(
        () =>
          buildZip([
            { name: 'a.bin', data: big },
            { name: 'b.bin', data: big },
          ]),
        'ZIP_ARCHIVE_TOO_LARGE',
      );
    });
  });

  describe('system unzip (external reader)', () => {
    itWithUnzip('accepts an empty archive', () => {
      withTempDir((dir) => {
        const archive = join(dir, 'empty.zip');
        writeFileSync(archive, buildZip([]));
        // Info-ZIP exits 1 with a warning ("zipfile is empty") but must not report corruption.
        const result = spawnSync('unzip', ['-l', archive], { env: UNZIP_ENV });
        expect(result.status === 0 || result.status === 1).toBe(true);
        expect(result.stdout.toString() + result.stderr.toString()).not.toMatch(
          /error|cannot find/i,
        );
      });
    });

    itWithUnzip(
      'tests and extracts one and many entries byte-identically (STORE)',
      () => {
        const inputs = [
          { name: 'Ana López.pdf', data: PDF_LIKE },
          { name: 'Muñoz Ñandú.pdf', data: Buffer.from('ñandú') },
          { name: 'José Ángel (2).pdf', data: Buffer.alloc(0) },
          ...Array.from({ length: 20 }, (_, i) => ({
            name: `n-${i}.txt`,
            data: Buffer.from(`#${i}`),
          })),
        ];
        const files = extractWithSystemUnzip(
          buildZip(inputs, { now: FIXED_DATE }),
        );
        expect([...files.keys()].sort()).toEqual(
          inputs.map((e) => e.name).sort(),
        );
        for (const input of inputs)
          expect(files.get(input.name)!.equals(input.data)).toBe(true);
      },
    );

    itWithUnzip('extracts DEFLATE entries byte-identically', () => {
      const text = Buffer.from('línea de estado de cuenta\n'.repeat(1000));
      const files = extractWithSystemUnzip(
        buildZip(
          [
            { name: 'a.txt', data: text },
            { name: 'b.pdf', data: PDF_LIKE },
          ],
          { compression: 'deflate' },
        ),
      );
      expect(files.get('a.txt')!.equals(text)).toBe(true);
      expect(files.get('b.pdf')!.equals(PDF_LIKE)).toBe(true);
    });

    itWithUnzip('reports the DOS timestamp in the listing', () => {
      withTempDir((dir) => {
        const archive = join(dir, 'ts.zip');
        writeFileSync(
          archive,
          buildZip([
            { name: 'a.txt', data: Buffer.from('x'), modifiedAt: FIXED_DATE },
          ]),
        );
        const listing = execFileSync('unzip', ['-l', archive], {
          env: UNZIP_ENV,
        }).toString();
        expect(listing).toMatch(/2026-11-27 13:45|11-27-2026 13:45/);
      });
    });
  });
});

describe('toDosDateTime', () => {
  it('encodes local date/time with 2-second resolution (seconds rounded down)', () => {
    expect(toDosDateTime(new Date(2026, 0, 2, 3, 4, 59))).toEqual({
      date: ((2026 - 1980) << 9) | (1 << 5) | 2,
      time: (3 << 11) | (4 << 5) | 29,
    });
  });

  it('clamps dates before 1980 to 1980-01-01 00:00:00', () => {
    expect(toDosDateTime(new Date(1970, 0, 1))).toEqual({
      date: (0 << 9) | (1 << 5) | 1,
      time: 0,
    });
  });

  it('clamps dates after 2107 to 2107-12-31 23:59:58', () => {
    expect(toDosDateTime(new Date(2200, 5, 1))).toEqual({
      date: (127 << 9) | (12 << 5) | 31,
      time: (23 << 11) | (59 << 5) | 29,
    });
  });
});
