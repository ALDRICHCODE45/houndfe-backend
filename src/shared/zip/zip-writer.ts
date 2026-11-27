import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Minimal in-memory ZIP writer (PKWARE APPNOTE 6.3.x subset), no dependency.
 *
 * - STORE (method 0) by default; optional DEFLATE (method 8) per entry, which
 *   falls back to STORE when it does not shrink the data.
 * - UTF-8 entry names (general-purpose flag bit 11), normalized to NFC.
 * - No Zip64, no data descriptors, no comments, no extra fields: archives are
 *   limited to 65,535 entries and every size/offset must fit in 32 bits.
 * - CRC-32 from Node's built-in `zlib.crc32` (Node >= 22.2; the image runs 24).
 */

export const ZIP32_MAX_ENTRIES = 0xffff;
/** Largest value a ZIP32 size/offset field can hold (0xFFFFFFFF is the Zip64 marker). */
export const ZIP32_MAX_BYTES = 0xfffffffe;

export type ZipCompression = 'store' | 'deflate';

export interface ZipEntryInput {
  /** Relative path inside the archive, `/`-separated. */
  name: string;
  data: Buffer;
  /** Defaults to `options.now`, then to the current time. Encoded as local DOS time. */
  modifiedAt?: Date;
}

export interface BuildZipOptions {
  compression?: ZipCompression;
  now?: Date;
}

export type ZipBuildErrorCode =
  | 'ZIP_INVALID_ENTRY_NAME'
  | 'ZIP_DUPLICATE_ENTRY_NAME'
  | 'ZIP_INVALID_ENTRY_DATA'
  | 'ZIP_INVALID_ENTRY_DATE'
  | 'ZIP_TOO_MANY_ENTRIES'
  | 'ZIP_ENTRY_TOO_LARGE'
  | 'ZIP_ARCHIVE_TOO_LARGE';

export class ZipBuildError extends Error {
  constructor(
    public readonly code: ZipBuildErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ZipBuildError';
  }
}

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const VERSION_NEEDED = 20; // 2.0: deflate + directories
const VERSION_MADE_BY = (3 << 8) | 20; // UNIX host, spec 2.0
const FLAG_UTF8 = 0x0800;
const UNIX_FILE_MODE = 0o100644;

/** Encodes `date` as MS-DOS date/time (local time, 2-second resolution, 1980–2107). */
export function toDosDateTime(date: Date): { date: number; time: number } {
  const year = date.getFullYear();
  if (year < 1980) return { date: (1 << 5) | 1, time: 0 };
  if (year > 2107) {
    return {
      date: (127 << 9) | (12 << 5) | 31,
      time: (23 << 11) | (59 << 5) | 29,
    };
  }
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      (date.getSeconds() >> 1),
  };
}

function validateName(
  raw: unknown,
  index: number,
): { name: string; bytes: Buffer } {
  const fail = (why: string): never => {
    throw new ZipBuildError(
      'ZIP_INVALID_ENTRY_NAME',
      `ZIP entry #${index} has an invalid name (${why}): ${JSON.stringify(raw)}`,
    );
  };
  if (typeof raw !== 'string' || raw.length === 0) return fail('empty');
  const name = raw.normalize('NFC');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) fail('control character');
  if (name.includes('\\')) fail('backslash');
  if (name.startsWith('/')) fail('absolute path');
  if (/^[A-Za-z]:/.test(name)) fail('drive letter');
  if (name.endsWith('/')) fail('directory entries are not supported');
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.' || segment === '..')
      fail('empty, "." or ".." path segment');
  }
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length > 0xffff) fail('longer than 65,535 UTF-8 bytes');
  return { name, bytes };
}

interface PreparedEntry {
  nameBytes: Buffer;
  data: Buffer;
  modifiedAt: Date;
}

function prepare(
  entries: readonly ZipEntryInput[],
  now: Date,
): PreparedEntry[] {
  if (entries.length > ZIP32_MAX_ENTRIES) {
    throw new ZipBuildError(
      'ZIP_TOO_MANY_ENTRIES',
      `ZIP archive has ${entries.length} entries; the maximum without Zip64 is ${ZIP32_MAX_ENTRIES}`,
    );
  }
  const seen = new Map<string, number>();
  let projectedSize = EOCD_SIZE;
  const prepared = entries.map((entry, index) => {
    const { name, bytes } = validateName(entry?.name, index);
    const key = name.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new ZipBuildError(
        'ZIP_DUPLICATE_ENTRY_NAME',
        `ZIP entry #${index} name ${JSON.stringify(name)} collides with entry #${previous} (names are compared case-insensitively)`,
      );
    }
    seen.set(key, index);
    if (!Buffer.isBuffer(entry.data)) {
      throw new ZipBuildError(
        'ZIP_INVALID_ENTRY_DATA',
        `ZIP entry ${JSON.stringify(name)} data must be a Buffer`,
      );
    }
    if (entry.data.length > ZIP32_MAX_BYTES) {
      throw new ZipBuildError(
        'ZIP_ENTRY_TOO_LARGE',
        `ZIP entry ${JSON.stringify(name)} is ${entry.data.length} bytes; the maximum without Zip64 is ${ZIP32_MAX_BYTES}`,
      );
    }
    const modifiedAt = entry.modifiedAt ?? now;
    if (!(modifiedAt instanceof Date) || Number.isNaN(modifiedAt.getTime())) {
      throw new ZipBuildError(
        'ZIP_INVALID_ENTRY_DATE',
        `ZIP entry ${JSON.stringify(name)} has an invalid modifiedAt`,
      );
    }
    projectedSize +=
      LOCAL_HEADER_SIZE +
      CENTRAL_HEADER_SIZE +
      2 * bytes.length +
      entry.data.length;
    return { nameBytes: bytes, data: entry.data, modifiedAt };
  });
  // Worst case (STORE) checked before reading any byte; DEFLATE never grows an entry here.
  assertArchiveSize(projectedSize);
  return prepared;
}

function assertArchiveSize(size: number): void {
  if (size > ZIP32_MAX_BYTES) {
    throw new ZipBuildError(
      'ZIP_ARCHIVE_TOO_LARGE',
      `ZIP archive would be ${size} bytes; the maximum without Zip64 is ${ZIP32_MAX_BYTES}`,
    );
  }
}

/** Builds a complete ZIP archive in memory. Entries keep the input order. */
export function buildZip(
  entries: readonly ZipEntryInput[],
  options: BuildZipOptions = {},
): Buffer {
  const prepared = prepare(entries, options.now ?? new Date());
  const chunks: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of prepared) {
    const crc = crc32(entry.data) >>> 0;
    let method = 0;
    let payload = entry.data;
    if (options.compression === 'deflate' && entry.data.length > 0) {
      const deflated = deflateRawSync(entry.data);
      if (deflated.length < entry.data.length) {
        method = 8;
        payload = deflated;
      }
    }
    const { date, time } = toDosDateTime(entry.modifiedAt);
    const nameLength = entry.nameBytes.length;

    const local = Buffer.alloc(LOCAL_HEADER_SIZE);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameLength, 26);
    local.writeUInt16LE(0, 28); // extra length

    const central = Buffer.alloc(CENTRAL_HEADER_SIZE);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    local.copy(central, 6, 4, 28); // version needed .. name length are identical
    // extra (30), comment (32), disk start (34), internal attrs (36) stay 0
    central.writeUInt32LE((UNIX_FILE_MODE << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    chunks.push(local, entry.nameBytes, payload);
    centralHeaders.push(central, entry.nameBytes);
    offset += LOCAL_HEADER_SIZE + nameLength + payload.length;
  }

  const centralDirectorySize = centralHeaders.reduce(
    (sum, b) => sum + b.length,
    0,
  );
  assertArchiveSize(offset + centralDirectorySize + EOCD_SIZE);

  const eocd = Buffer.alloc(EOCD_SIZE);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(prepared.length, 8);
  eocd.writeUInt16LE(prepared.length, 10);
  eocd.writeUInt32LE(centralDirectorySize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, ...centralHeaders, eocd]);
}
