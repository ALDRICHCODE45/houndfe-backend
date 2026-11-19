import {
  CONVERSATION_MEDIA_MAX_BYTES,
  assertMediaFits,
  detectConversationMedia,
  mediaMatchesMessageType,
  sanitizeStaffFilename,
} from './conversation-media';

const bytes = (...values: number[]) => Buffer.from(values);
const ascii = (s: string) => Buffer.from(s, 'latin1');
const pad = (head: Buffer, size = 64) =>
  Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);

const riffWebp = () =>
  pad(Buffer.concat([ascii('RIFF'), bytes(0x24, 0, 0, 0), ascii('WEBPVP8 ')]));
const ftyp = (brand: string) =>
  pad(Buffer.concat([bytes(0, 0, 0, 0x18), ascii('ftyp'), ascii(brand)]));

describe('detectConversationMedia (magic bytes, §3.6)', () => {
  it.each([
    ['jpeg', pad(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg', 'image'],
    [
      'png',
      pad(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
      'image/png',
      'image',
    ],
    ['webp', riffWebp(), 'image/webp', 'image'],
    ['pdf', pad(ascii('%PDF-1.7')), 'application/pdf', 'document'],
    ['ogg', pad(ascii('OggS')), 'audio/ogg', 'audio'],
    ['mp3 with ID3', pad(ascii('ID3\x04')), 'audio/mpeg', 'audio'],
    [
      'mp3 frame sync',
      pad(bytes(0xff, 0xfb, 0x90, 0x00)),
      'audio/mpeg',
      'audio',
    ],
    ['aac (ADTS)', pad(bytes(0xff, 0xf1, 0x50, 0x80)), 'audio/aac', 'audio'],
    ['m4a', ftyp('M4A '), 'audio/mp4', 'audio'],
    ['amr', pad(ascii('#!AMR\n')), 'audio/amr', 'audio'],
    ['amr-wb', pad(ascii('#!AMR-WB\n')), 'audio/amr', 'audio'],
  ])('%s', (_name, buffer, mimeType, kind) => {
    expect(detectConversationMedia(buffer)).toMatchObject({ mimeType, kind });
  });

  it('gives each type a fixed extension for the storage key', () => {
    expect(detectConversationMedia(pad(ascii('%PDF-1.7')))?.extension).toBe(
      'pdf',
    );
    expect(detectConversationMedia(riffWebp())?.extension).toBe('webp');
    expect(detectConversationMedia(ftyp('M4A '))?.extension).toBe('m4a');
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['text', ascii('hello world, not a file at all')],
    ['an html page', ascii('<html><script>alert(1)</script>')],
    ['svg (scriptable)', ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['gif', ascii('GIF89a\x01\x00\x01\x00')],
    ['video (mp4, isom brand)', ftyp('isom')],
    ['video (mp4, mp42 brand)', ftyp('mp42')],
    ['heic', ftyp('heic')],
    [
      'RIFF that is not webp (wav)',
      pad(
        Buffer.concat([ascii('RIFF'), bytes(0x24, 0, 0, 0), ascii('WAVEfmt ')]),
      ),
    ],
    ['an executable', pad(ascii('MZ'))],
    ['a zip', pad(ascii('PK\x03\x04'))],
  ])('refuses %s even when the client says otherwise', (_name, buffer) => {
    expect(detectConversationMedia(buffer)).toBeNull();
  });

  it('a lone 0xFF byte is not an mp3', () => {
    expect(detectConversationMedia(bytes(0xff))).toBeNull();
    expect(detectConversationMedia(bytes(0xff, 0x00))).toBeNull();
  });
});

describe('assertMediaFits', () => {
  it('10 MB is the limit', () => {
    expect(CONVERSATION_MEDIA_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(() => assertMediaFits(CONVERSATION_MEDIA_MAX_BYTES)).not.toThrow();
    expect(() => assertMediaFits(CONVERSATION_MEDIA_MAX_BYTES + 1)).toThrow();
    expect(() => assertMediaFits(0)).toThrow();
  });
});

describe('mediaMatchesMessageType', () => {
  it.each([
    ['IMAGE', 'image/jpeg', true],
    ['IMAGE', 'image/webp', true],
    ['IMAGE', 'application/pdf', false],
    ['STICKER', 'image/webp', true],
    ['STICKER', 'image/png', true],
    ['STICKER', 'audio/ogg', false],
    ['DOCUMENT', 'application/pdf', true],
    ['DOCUMENT', 'image/png', false],
    ['AUDIO', 'audio/ogg', true],
    ['AUDIO', 'audio/mp4', true],
    ['AUDIO', 'image/png', false],
  ])('%s with %s -> %s', (type, mime, ok) => {
    expect(mediaMatchesMessageType(type, mime)).toBe(ok);
  });
});

describe('sanitizeStaffFilename (T11c)', () => {
  const jpg = {
    mimeType: 'image/jpeg',
    extension: 'jpg',
    kind: 'image',
  } as const;
  const pdf = {
    mimeType: 'application/pdf',
    extension: 'pdf',
    kind: 'document',
  } as const;
  it.each([
    ['../../Mi  Foto <1>.png', jpg, 'Mi Foto 1.jpg'],
    ['C:\\temp\\Cotización "final".pdf', pdf, 'Cotizacion final.pdf'],
    ['   ', pdf, 'documento.pdf'],
    [undefined, jpg, 'imagen.jpg'],
    ['...', jpg, 'imagen.jpg'],
    ['\u0000\u202e.exe', jpg, 'imagen.jpg'],
  ])('%j -> %s', (raw, media, expected) => {
    expect(sanitizeStaffFilename(raw, media)).toBe(expected);
  });
  it('is at most 100 characters and keeps the detected extension', () => {
    const name = sanitizeStaffFilename('a'.repeat(300) + '.pdf', pdf);
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});
