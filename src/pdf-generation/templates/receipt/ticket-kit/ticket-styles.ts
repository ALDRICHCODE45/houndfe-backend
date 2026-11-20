/**
 * Ticket kit — StyleSheet built from the 01-libro-compacto artboard.
 *
 * Structure comes from rules (solid + dotted), never from fills. Every color is
 * `TICKET_COLORS.ink` on `TICKET_COLORS.paper`.
 *
 * NOTE: no page-level `lineHeight` (react-pdf 4.5 quirk shared with the A4
 * kit); `lineHeight` is set on each Text instead.
 */
import { StyleSheet } from '@react-pdf/renderer';
import { px } from '../../shared/a4-kit';
import {
  TICKET_COLORS,
  TICKET_FONTS,
  TICKET_LINE_HEIGHT,
  TICKET_PAGE_PADDING,
  TICKET_RULES,
  TICKET_SIZES,
} from './ticket-tokens';

const text = {
  color: TICKET_COLORS.ink,
  fontFamily: TICKET_FONTS.regular,
  fontSize: TICKET_SIZES.base,
  lineHeight: TICKET_LINE_HEIGHT,
} as const;

const strong = {
  ...text,
  fontFamily: TICKET_FONTS.bold,
  fontSize: TICKET_SIZES.strong,
} as const;

const dottedRow = {
  borderBottomWidth: TICKET_RULES.hairline,
  borderBottomColor: TICKET_COLORS.ink,
  borderBottomStyle: 'dotted',
} as const;

export const TICKET_STYLES = StyleSheet.create({
  page: {
    paddingTop: TICKET_PAGE_PADDING.top,
    paddingHorizontal: TICKET_PAGE_PADDING.horizontal,
    paddingBottom: TICKET_PAGE_PADDING.bottom,
    backgroundColor: TICKET_COLORS.paper,
    color: TICKET_COLORS.ink,
    fontFamily: TICKET_FONTS.regular,
    fontSize: TICKET_SIZES.base,
  },
  text,
  bold: { ...text, fontFamily: TICKET_FONTS.bold },

  // ── Header: wordmark left, RECIBO + folio right, heavy rule under ──
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingBottom: px(6),
    borderBottomWidth: TICKET_RULES.heavy,
    borderBottomColor: TICKET_COLORS.ink,
    borderBottomStyle: 'solid',
  },
  wordmarkBox: { flexGrow: 0, flexShrink: 1, paddingRight: px(8) },
  wordmark: {
    ...text,
    fontFamily: TICKET_FONTS.bold,
    fontSize: TICKET_SIZES.wordmark,
    letterSpacing: -TICKET_SIZES.wordmark * 0.02,
    lineHeight: 1,
  },
  docBox: { flexShrink: 0, alignItems: 'flex-end' },
  docKind: {
    ...text,
    fontFamily: TICKET_FONTS.bold,
    letterSpacing: TICKET_SIZES.base * 0.16,
  },
  docFolio: {
    ...text,
    fontFamily: TICKET_FONTS.bold,
    fontSize: TICKET_SIZES.folio,
    marginTop: px(1),
  },

  // ── Label / value rows (Fecha, Cajero, Vendedor, Cliente) ──
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: px(3),
    ...dottedRow,
  },
  kvLabel: {
    ...text,
    flexShrink: 0,
    paddingRight: px(8),
    letterSpacing: TICKET_SIZES.base * 0.08,
  },
  kvValue: { ...strong, flexShrink: 1, textAlign: 'right' },

  // ── Section heads (PRODUCTO / IMPORTE, PAGOS / MONTO) ──
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: px(12),
    paddingBottom: px(3),
    borderBottomWidth: TICKET_RULES.hairline,
    borderBottomColor: TICKET_COLORS.ink,
    borderBottomStyle: 'solid',
  },
  sectionHeadText: {
    ...text,
    fontFamily: TICKET_FONTS.bold,
    letterSpacing: TICKET_SIZES.base * 0.1,
  },

  // ── Product rows ──
  item: { paddingVertical: px(4), ...dottedRow },
  itemName: strong,
  itemLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  itemDetail: { ...text, flexShrink: 1, paddingRight: px(8) },
  itemAmount: { ...strong, flexShrink: 0, textAlign: 'right' },
  itemDiscount: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  itemDiscountTitle: { ...text, flexShrink: 1, paddingRight: px(8) },
  itemDiscountAmount: { ...text, flexShrink: 0, textAlign: 'right' },
  empty: { ...text, paddingVertical: px(4), ...dottedRow },

  // ── Summary rows (Subtotal … Cambio) ──
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: px(3),
    ...dottedRow,
  },
  summaryLabel: { ...text, fontSize: TICKET_SIZES.strong, flexShrink: 1 },
  summaryValue: {
    ...text,
    fontSize: TICKET_SIZES.strong,
    flexShrink: 0,
    paddingLeft: px(8),
    textAlign: 'right',
  },
  summaryStrong: { fontFamily: TICKET_FONTS.bold },

  // ── Debt box (02-clasico-centrado, owner choice S3): 2 px border, no fill ──
  debtBox: {
    marginTop: px(5),
    paddingVertical: px(5),
    paddingHorizontal: px(8),
    borderWidth: TICKET_RULES.heavy,
    borderColor: TICKET_COLORS.ink,
    borderStyle: 'solid',
  },
  debtRow: { flexDirection: 'row', justifyContent: 'space-between' },
  debtText: {
    ...text,
    fontFamily: TICKET_FONTS.bold,
    fontSize: TICKET_SIZES.debt,
  },
  debtValue: { flexShrink: 0, paddingLeft: px(8), textAlign: 'right' },
  debtNote: { ...text, textAlign: 'center', marginTop: px(2) },

  // ── TOTAL between two heavy rules ──
  grand: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: px(6),
    paddingVertical: px(6),
    borderTopWidth: TICKET_RULES.heavy,
    borderTopColor: TICKET_COLORS.ink,
    borderTopStyle: 'solid',
    borderBottomWidth: TICKET_RULES.heavy,
    borderBottomColor: TICKET_COLORS.ink,
    borderBottomStyle: 'solid',
  },
  grandLabel: {
    ...text,
    fontFamily: TICKET_FONTS.bold,
    fontSize: TICKET_SIZES.strong,
    letterSpacing: TICKET_SIZES.strong * 0.14,
  },
  grandValue: {
    ...text,
    fontFamily: TICKET_FONTS.bold,
    fontSize: TICKET_SIZES.grandTotal,
    letterSpacing: -TICKET_SIZES.grandTotal * 0.02,
    lineHeight: 1,
    paddingLeft: px(8),
    textAlign: 'right',
  },

  // ── Payments ──
  payRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: px(4),
    ...dottedRow,
  },
  payInfo: { flexGrow: 1, flexShrink: 1 },
  payMethod: strong,
  payTime: { ...text, fontFamily: TICKET_FONTS.regular },
  payDetail: text,
  payAmount: {
    ...strong,
    flexShrink: 0,
    paddingLeft: px(8),
    textAlign: 'right',
  },

  // ── Closing ──
  end: {
    marginTop: px(14),
    paddingTop: px(7),
    borderTopWidth: TICKET_RULES.heavy,
    borderTopColor: TICKET_COLORS.ink,
    borderTopStyle: 'solid',
  },
  endThanks: { ...strong, textAlign: 'center' },
  endNote: { ...text, textAlign: 'center' },
});
