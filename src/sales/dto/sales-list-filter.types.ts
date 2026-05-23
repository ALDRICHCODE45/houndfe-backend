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
}
