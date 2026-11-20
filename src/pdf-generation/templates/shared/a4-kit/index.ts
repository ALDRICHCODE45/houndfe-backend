/**
 * A4 kit barrel (pdf-a4-redesign T2). Additive: nothing here changes the
 * legacy `SHARED_STYLES` consumers.
 */
export { A4_COLORS, A4_FONTS, A4_PAGE_PADDING, px, toneColor } from './tokens';
export type { A4Tone } from './tokens';
export { A4_STYLES } from './a4-styles';
export { A4_LOGO_ASPECT, A4_LOGO_PATH, A4_LOGO_WIDTH } from './a4-logo';
export {
  A4_TIME_ZONE,
  formatA4Money,
  formatA4Date,
  formatA4DateTime,
  formatA4Time,
} from './a4-format';
export {
  A4_DEFAULT_BRAND_NAME,
  A4ContinuationHeader,
  A4Footer,
  A4GoldMark,
  A4KeyValueColumns,
  A4MetaBar,
  A4Page,
  A4PageHeader,
  A4Section,
  A4TotalsBlock,
  LedgerHeaderRow,
  LedgerTable,
} from './a4-kit';
export type {
  A4Brand,
  A4Continuation,
  A4KeyValueItem,
  A4MetaBarItem,
  A4PageHeaderProps,
  A4PageProps,
  A4SectionProps,
  A4TotalsBlockProps,
  A4TotalsLine,
  LedgerCell,
  LedgerCellObject,
  LedgerColumn,
  LedgerRowData,
  LedgerTableProps,
} from './a4-kit';
