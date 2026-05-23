import type {
  ParsedDateRange,
  ParsedNumericRange,
} from '../../shared/listing/listing-types';
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
  confirmedAt?: ParsedDateRange;
}

export interface SalesListExtendedFilter extends SalesListBaseFilter {
  folio?: string[];
  status?: ListSalesStatus[];
  paymentStatus?: ListSalesPaymentStatus[];
  deliveryStatus?: ListSalesDeliveryStatus[];
  paymentMethod?: ListSalesPaymentMethod[];
  paymentMethodIncludeNull?: boolean;
  total?: ParsedNumericRange;
  debt?: ParsedNumericRange;
  dueDate?: ParsedDateRange;
  dueDateIncludeNull?: boolean;
}
