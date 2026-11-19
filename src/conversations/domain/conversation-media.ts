/**
 * DOMAIN: the media the bot may upload for the conversation mirror
 * (human-intervention unit 9; contract §3.6, §6.4, §12.5). The type is decided
 * by the leading bytes only (as for receipts): whatever the client declared is
 * ignored. Allowed: `image/jpeg|png|webp` (stickers are webp), `application/
 * pdf` and audio (`audio/ogg|mpeg|mp4|aac|amr`), up to 10 MB. Everything else
 * (video, location, SVG, HTML, archives, executables) is refused: v1 stores no
 * video (§3.6) and nothing scriptable is ever served back.
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';

export const CONVERSATION_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

export type ConversationMediaKind = 'image' | 'document' | 'audio';

export interface DetectedMedia {
  mimeType: string;
  /** A fixed extension for the storage key; never taken from the client. */
  extension: string;
  kind: ConversationMediaKind;
}

const detected = (
  mimeType: string,
  extension: string,
  kind: ConversationMediaKind,
): DetectedMedia => ({ mimeType, extension, kind });

const startsWith = (bytes: Buffer, signature: number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, i) => bytes[offset + i] === byte);

const ascii = (text: string): number[] =>
  Array.from(text, (ch) => ch.charCodeAt(0));

export function detectConversationMedia(bytes: Buffer): DetectedMedia | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return detected('image/jpeg', 'jpg', 'image');
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return detected('image/png', 'png', 'image');
  }
  // RIFF....WEBP (a RIFF that is not WEBP, such as WAV, is not accepted).
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) {
    return detected('image/webp', 'webp', 'image');
  }
  if (startsWith(bytes, ascii('%PDF-'))) {
    return detected('application/pdf', 'pdf', 'document');
  }
  if (startsWith(bytes, ascii('OggS'))) {
    return detected('audio/ogg', 'ogg', 'audio');
  }
  if (startsWith(bytes, ascii('#!AMR'))) {
    return detected('audio/amr', 'amr', 'audio');
  }
  // MPEG-4 audio only (`M4A `/`M4B `): the generic `isom`/`mp42` brands are
  // also what a video uses, and v1 stores no video.
  if (startsWith(bytes, ascii('ftyp'), 4)) {
    const brand = bytes.subarray(8, 12).toString('latin1');
    return brand === 'M4A ' || brand === 'M4B '
      ? detected('audio/mp4', 'm4a', 'audio')
      : null;
  }
  if (startsWith(bytes, ascii('ID3'))) {
    return detected('audio/mpeg', 'mp3', 'audio');
  }
  // 11-bit frame sync (0xFFE). The layer bits tell MP3 (01, 10, 11) from ADTS
  // AAC (00).
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return (bytes[1] & 0x06) === 0
      ? detected('audio/aac', 'aac', 'audio')
      : detected('audio/mpeg', 'mp3', 'audio');
  }
  return null;
}

/** `413`/`400` decisions are the service's; this only states the size rule. */
export function assertMediaFits(sizeBytes: number): void {
  if (
    !Number.isInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > CONVERSATION_MEDIA_MAX_BYTES
  ) {
    throw new InvalidArgumentError('Media size is out of range');
  }
}

/**
 * A mirrored `IMAGE` points at an image, a `DOCUMENT` at a PDF, an `AUDIO` at
 * audio and a `STICKER` at an image (webp in practice): the timeline renders
 * by message type, so a mismatch is refused.
 */
export function mediaMatchesMessageType(
  messageType: string,
  mimeType: string,
): boolean {
  switch (messageType) {
    case 'IMAGE':
    case 'STICKER':
      return mimeType.startsWith('image/');
    case 'DOCUMENT':
      return mimeType === 'application/pdf';
    case 'AUDIO':
      return mimeType.startsWith('audio/');
    default:
      return false;
  }
}

export const STAFF_FILENAME_MAX = 100;

/**
 * The name the customer sees for a staff file (S16 9). Staff chooses it, so it
 * is cleaned to a plain file name: no directories, quotes, control characters
 * or non-ASCII (it goes into a quoted `Content-Disposition` and the bot's
 * WhatsApp document), at most 100 characters, and the extension always matches
 * the detected type. Nothing usable falls back to `imagen.<ext>` /
 * `documento.pdf`.
 */
export function sanitizeStaffFilename(
  raw: unknown,
  media: DetectedMedia,
): string {
  const fallback = media.kind === 'document' ? 'documento' : 'imagen';
  const text = typeof raw === 'string' ? raw : '';
  const base = text.split(/[\\/]/).pop() ?? '';
  const stem = base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F"';:*?<>|%\\]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, STAFF_FILENAME_MAX - media.extension.length - 1)
    .trim();
  return `${stem || fallback}.${media.extension}`;
}
