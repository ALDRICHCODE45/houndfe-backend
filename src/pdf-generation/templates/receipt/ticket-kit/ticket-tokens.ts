/**
 * Ticket kit — design tokens (pdf-ticket-redesign T2, spec artboard
 * design/pdf-ticket-redesign/01-libro-compacto.html).
 *
 * The 80 mm thermal printer is 1-bit: ONLY black ink on white paper. No grays,
 * no fills (they dither into noise). Typography is the built-in Helvetica /
 * Helvetica-Bold pair (deterministic offline render, no font CDN).
 * Artboard px × 0.75 = pt, via the A4 kit's `px`.
 */
import { A4_FONTS, px } from '../../shared/a4-kit';

export const TICKET_COLORS = {
  ink: '#000000',
  paper: '#ffffff',
} as const;

export const TICKET_FONTS = A4_FONTS;

/** Hairline rule (artboard 1 px), regular rule (2 px) and heavy rule (2 px). */
export const TICKET_RULES = {
  hairline: px(1),
  heavy: px(2),
} as const;

/** Artboard type scale (px → pt). Minimum text is 11 px = 8.25 pt. */
export const TICKET_SIZES = {
  base: px(11),
  strong: px(12),
  folio: px(13),
  debt: px(14),
  wordmark: px(24),
  grandTotal: px(26),
} as const;

/** Paper geometry: 303 px paper, 15.5 px side margin, 16 px top, 24 px bottom. */
export const TICKET_PAGE_PADDING = {
  top: px(16),
  horizontal: px(15.5),
  bottom: px(24),
} as const;

/** Line height of the artboard text blocks. */
export const TICKET_LINE_HEIGHT = 1.3;
