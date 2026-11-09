// Ops › showcase catalog › image fetching. https only, image/jpeg|png|webp,
// at most 10 MiB, bounded time. `probeImage` is the dry-run check (HEAD, or a
// GET whose body is never read when the server refuses HEAD); `downloadImage`
// returns the bytes for ProductsService.uploadProductImage.
'use strict';

const path = require('node:path');
const {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  baseMime,
  isAllowedImageUrl,
} = require('./core.cjs');

const TIMEOUT_MS = 30_000;
// Wikimedia answers 429 to agents without a contact URL or email (its User-Agent
// policy); SHOWCASE_IMAGE_USER_AGENT overrides the default.
const USER_AGENT =
  process.env.SHOWCASE_IMAGE_USER_AGENT ??
  'houndfe-showcase-loader/1.0 (+https://houndfe.com; catalog image import)';
const EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

class ImageError extends Error {}

function checkResponse(response, url) {
  if (!response.ok) throw new ImageError(`HTTP ${response.status}`);
  if (!isAllowedImageUrl(response.url || url)) {
    throw new ImageError(`redirected off https: ${response.url}`);
  }
  const mime = baseMime(response.headers.get('content-type'));
  if (!IMAGE_MIME_TYPES.includes(mime)) {
    throw new ImageError(`content-type ${mime || '(none)'} not allowed`);
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) {
    throw new ImageError(`${length} bytes exceeds 10 MiB`);
  }
  return { mime, length: Number.isFinite(length) ? length : null };
}

const RETRIES = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seconds of a Retry-After header, else exponential backoff from 2 s. */
function retryDelayMs(header, attempt) {
  const seconds = header == null || header === '' ? NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds, 60) * 1000;
  return 2000 * 2 ** attempt;
}

// Image hosts (Wikimedia included) rate-limit bursts with 429: requests are
// spaced by PACE_MS process-wide, and a 429/503 waits and retries.
const PACE_MS = 500;
let nextSlot = 0;
async function paced() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + PACE_MS;
  if (slot > now) await sleep(slot - now);
}

async function request(url, method) {
  if (!isAllowedImageUrl(url)) throw new ImageError('url must be https');
  for (let attempt = 0; ; attempt += 1) {
    await paced();
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: IMAGE_MIME_TYPES.join(',') },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (![429, 503].includes(response.status) || attempt >= RETRIES) {
      return response;
    }
    await response.body?.cancel();
    await sleep(retryDelayMs(response.headers.get('retry-after'), attempt));
  }
}

/** Dry-run validation: `{ mime, length }` or throws ImageError. */
async function probeImage(url) {
  let response = await request(url, 'HEAD');
  if (response.status === 405 || response.status === 501) {
    response = await request(url, 'GET');
    try {
      return checkResponse(response, url);
    } finally {
      await response.body?.cancel();
    }
  }
  return checkResponse(response, url);
}

/** Bytes, MIME type and a file name for the upload, or throws ImageError. */
async function downloadImage(url, baseName) {
  const response = await request(url, 'GET');
  const { mime } = checkResponse(response, url);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) {
      await response.body.cancel?.();
      throw new ImageError('body exceeds 10 MiB');
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new ImageError('empty body');
  const name = path.basename(baseName).replace(/[^A-Za-z0-9._-]/g, '-');
  return {
    buffer: Buffer.concat(chunks),
    mimetype: mime,
    originalname: `${name}${EXTENSIONS[mime]}`,
    size,
  };
}

/** Runs `work` over `items` with at most `limit` in flight; keeps order. */
async function mapLimit(items, limit, work) {
  const results = [];
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  };
  const lanes = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) lanes.push(lane());
  await Promise.all(lanes);
  return results;
}

module.exports = {
  ImageError,
  downloadImage,
  mapLimit,
  probeImage,
  retryDelayMs,
};
