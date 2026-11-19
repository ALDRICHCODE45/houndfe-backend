/**
 * A4 kit — design tokens (pdf-a4-redesign T2, spec artboard
 * design/pdf-a4-redesign/01-libro-mayor.html).
 *
 * Palette = the frontend design system (L5): one accent for titles and the
 * «Total» rules, ink/muted text, hairline + strong borders, warning/success
 * for amounts. Danger is reserved for voids/errors; gold is only the small
 * brand mark at the top-left of a page — never a status colour.
 *
 * Typography: built-in Helvetica / Helvetica-Bold only (deterministic offline
 * render, no font CDN). The artboard's weight 600 maps to Helvetica-Bold.
 * Artboard px × 0.75 = pt.
 *
 * This module is ADDITIVE: it does not touch `SHARED_STYLES`, so the receipt,
 * quotation and report templates keep rendering exactly as before.
 */

export const A4_COLORS = {
  accent: '#173968',
  ink: '#24313d',
  muted: '#576574',
  border: '#dce2e8',
  strong: '#8593a3',
  warning: '#805511',
  success: '#236044',
  /** Voids / errors only. Never used for cash differences. */
  danger: '#b42318',
  /** Brand mark only. Never a status colour. */
  gold: '#f6bb13',
  white: '#ffffff',
} as const;

export type A4Tone =
  | 'ink'
  | 'muted'
  | 'accent'
  | 'warning'
  | 'success'
  | 'danger';

export const A4_FONTS = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
} as const;

/** Artboard pixels → PDF points. */
export function px(value: number): number {
  return Math.round(value * 0.75 * 100) / 100;
}

export function toneColor(tone: A4Tone): string {
  return A4_COLORS[tone];
}

/** Page geometry from the artboard (padding 46/52/70 px). */
export const A4_PAGE_PADDING = {
  top: px(46),
  horizontal: px(52),
  bottom: px(70),
} as const;
