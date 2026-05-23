import { DateRange, NumericRange } from '../../shared/listing';
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
  confirmedAt?: DateRange;
}

export interface SalesListExtendedFilter extends SalesListBaseFilter {
  folio?: string[];
  status?: ListSalesStatus[];
  paymentStatus?: ListSalesPaymentStatus[];
  deliveryStatus?: ListSalesDeliveryStatus[];
  paymentMethod?: ListSalesPaymentMethod[];
  paymentMethodIncludeNull?: boolean;
  total?: NumericRange;
  debt?: NumericRange;
  dueDate?: DateRange;
  dueDateIncludeNull?: boolean;
}
