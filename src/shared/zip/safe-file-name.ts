/**
 * Pure helpers to turn display names (e.g. a customer's name) into file names
 * that are valid on Windows, macOS and Linux, and to disambiguate duplicates
 * deterministically (`Ana López.pdf`, `Ana López (2).pdf`, …).
 *
 * Accents, ñ and other letters are kept; only characters that are invalid or
 * dangerous in file names are replaced or removed.
 */

export const DEFAULT_FILE_NAME_MAX_LENGTH = 100;

export interface SanitizeFileNameOptions {
  /** Maximum length of the base name in code points (default 100). */
  maxLength?: number;
}

export interface SafeFileNameOptions extends SanitizeFileNameOptions {
  /** Used when the name is empty or has nothing usable left. Sanitized too. */
  fallback: string;
  /** E.g. `.pdf` (a leading dot is added if missing) or `''` for none. */
  extension: string;
}

export interface FileNameCandidate {
  name: string | null | undefined;
  fallback: string;
}

// Invalid on Windows (and `/` everywhere).
const INVALID_CHARS = /[<>:"/\\|?*]/g;
// C0/C1 controls, bidi overrides/isolates, zero-width chars and BOM.
const STRIP_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function trimEdges(value: string): string {
  return value.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
}

function capLength(value: string, maxLength: number): string {
  const codePoints = Array.from(value);
  return codePoints.length > maxLength
    ? codePoints.slice(0, maxLength).join('')
    : value;
}

/**
 * Returns a file-system-safe base name (no extension added), or `''` when
 * nothing usable is left. Never contains path separators.
 */
export function sanitizeFileNameBase(
  raw: string,
  options: SanitizeFileNameOptions = {},
): string {
  const maxLength = options.maxLength ?? DEFAULT_FILE_NAME_MAX_LENGTH;
  let value = raw
    .normalize('NFC')
    .replace(/[\t\n\r\v\f]/g, ' ')
    .replace(STRIP_CHARS, '')
    .replace(INVALID_CHARS, '-')
    .replace(/\s+/g, ' ');
  value = trimEdges(value);
  // `CON`, `nul.txt`, … are reserved device names on Windows regardless of extension.
  const dot = value.indexOf('.');
  const stem = dot === -1 ? value : value.slice(0, dot);
  if (WINDOWS_RESERVED.test(stem))
    value = `${stem}_${value.slice(stem.length)}`;
  return trimEdges(capLength(value, maxLength));
}

function normalizeExtension(extension: string): string {
  if (extension === '') return '';
  return extension.startsWith('.') ? extension : `.${extension}`;
}

function resolveBase(
  name: string | null | undefined,
  fallback: string,
  maxLength: number,
): string {
  const fromName =
    typeof name === 'string' ? sanitizeFileNameBase(name, { maxLength }) : '';
  if (fromName) return fromName;
  const fromFallback = sanitizeFileNameBase(fallback, { maxLength });
  if (!fromFallback) {
    throw new Error(
      `File name fallback ${JSON.stringify(fallback)} has nothing usable left after sanitization`,
    );
  }
  return fromFallback;
}

/** Sanitized `name` (or `fallback`) plus extension. Does not disambiguate. */
export function toSafeFileName(
  name: string | null | undefined,
  options: SafeFileNameOptions,
): string {
  const maxLength = options.maxLength ?? DEFAULT_FILE_NAME_MAX_LENGTH;
  return (
    resolveBase(name, options.fallback, maxLength) +
    normalizeExtension(options.extension)
  );
}

export interface FileNameAllocator {
  /** Returns a unique safe file name; later duplicates get ` (2)`, ` (3)`, … */
  allocate(name: string | null | undefined, fallback: string): string;
}

/**
 * Stateful allocator: collisions are checked case-insensitively on the final
 * file name, so the result is deterministic for a given call order.
 */
export function createFileNameAllocator(options: {
  extension: string;
  maxLength?: number;
}): FileNameAllocator {
  const maxLength = options.maxLength ?? DEFAULT_FILE_NAME_MAX_LENGTH;
  const extension = normalizeExtension(options.extension);
  const taken = new Set<string>();
  const take = (fileName: string): string => {
    taken.add(fileName.toLowerCase());
    return fileName;
  };
  return {
    allocate(name, fallback) {
      const base = resolveBase(name, fallback, maxLength);
      if (!taken.has(`${base}${extension}`.toLowerCase()))
        return take(`${base}${extension}`);
      for (let n = 2; ; n++) {
        const suffix = ` (${n})`;
        const room = Math.max(1, maxLength - suffix.length);
        const trimmed =
          trimEdges(capLength(base, room)) || capLength(base, room);
        const candidate = `${trimmed}${suffix}${extension}`;
        if (!taken.has(candidate.toLowerCase())) return take(candidate);
      }
    },
  };
}

/** Disambiguates a whole list in input order. Same rules as the allocator. */
export function disambiguateFileNames(
  candidates: readonly FileNameCandidate[],
  extension: string,
  options: SanitizeFileNameOptions = {},
): string[] {
  const allocator = createFileNameAllocator({
    extension,
    maxLength: options.maxLength,
  });
  return candidates.map((c) => allocator.allocate(c.name, c.fallback));
}
