import {
  ListSalesDeliveryStatus,
  ListSalesPaymentMethod,
  ListSalesPaymentStatus,
  ListSalesStatus,
} from './list-sales-query.dto';

export interface SalesListBaseFilter {
  q?: string;
  cashierUserId?: string[];
  customerId?: string[];
  customerIncludeNull?: boolean;
  confirmedFrom?: Date;
  confirmedTo?: Date;
}

export interface SalesListExtendedFilter extends SalesListBaseFilter {
  folio?: string[];
  status?: ListSalesStatus[];
  paymentStatus?: ListSalesPaymentStatus[];
  deliveryStatus?: ListSalesDeliveryStatus[];
  paymentMethod?: ListSalesPaymentMethod[];
  paymentMethodIncludeNull?: boolean;
  totalMin?: number;
  totalMax?: number;
  debtMin?: number;
  debtMax?: number;
  dueDateFrom?: Date;
  dueDateTo?: Date;
  dueDateIncludeNull?: boolean;
  /** customer-pets / T3: sales with at least one line for this pet. */
  petId?: string;
  /**
   * sales-history-redesign S3 (contract §7) — `overdue=true`: only overdue
   * sales (CONFIRMED, open debt > 0, `dueDate` before this instant). The
   * service sets it to 00:00Z of today's local date in the business timezone
   * (the due day is the UTC calendar date of `dueDate`, as the POS shows it);
   * absent = no filter. Page filter only: never part of the base filters.
   */
  overdueBefore?: Date;
}
