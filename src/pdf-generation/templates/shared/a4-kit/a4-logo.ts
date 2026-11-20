/**
 * A4 kit — packaged wordmark (pdf-a4-redesign T8, S2).
 *
 * The four A4 documents draw the same local wordmark: no network fetch at
 * render time and no per-document logo. `nest-cli.json` copies
 * `pdf-generation/assets/**` to the same path under `dist`, so this resolves
 * both from `src` (tests) and from `dist` (runtime).
 */
import { resolve } from 'node:path';
import { px } from './tokens';

/** Absolute path of the packaged wordmark (512×191 px PNG). */
export const A4_LOGO_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'assets',
  'houndfe-logo-report.png',
);

/** Wordmark intrinsic size (px). */
export const A4_LOGO_ASPECT = 512 / 191;

/** The wordmark is drawn 36 artboard px tall → ≈96.5 px wide (pt via `px`). */
export const A4_LOGO_WIDTH = px(36 * A4_LOGO_ASPECT);
