/** Ticket kit barrel (pdf-ticket-redesign T2). */
export { TICKET_STYLES } from './ticket-styles';
export {
  TICKET_COLORS,
  TICKET_FONTS,
  TICKET_LINE_HEIGHT,
  TICKET_PAGE_PADDING,
  TICKET_RULES,
  TICKET_SIZES,
} from './ticket-tokens';
export {
  formatTicketMethod,
  formatTicketQuantity,
  softBreakLongTokens,
} from './ticket-format';
export {
  resolveTicketBrandName,
  TICKET_DEBT_NOTE,
  TICKET_DEFAULT_BRAND_NAME,
  TicketDebtBox,
  TicketEmptyRow,
  TicketFooter,
  TicketGrandTotal,
  TicketHeader,
  TicketItem,
  TicketKeyValue,
  TicketPayment,
  TicketSectionHead,
  TicketSummaryRow,
} from './ticket-kit';
export type { TicketItemProps, TicketPaymentProps } from './ticket-kit';
