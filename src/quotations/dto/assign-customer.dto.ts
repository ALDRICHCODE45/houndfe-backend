import { IsUUID } from 'class-validator';

/**
 * Body for `PUT /quotations/drafts/:id/customer`.
 *
 * WU2 — Assign a customer to an existing DRAFT quotation. On success the
 * service auto-seeds the draft's `globalPriceListId` from
 * `customer.globalPriceListId` UNLESS the cashier has explicitly set a
 * price list (the `priceListExplicitlySet` discriminator protects the
 * cashier's choice — see `Quotation.assignCustomer`).
 */
export class AssignCustomerDto {
  @IsUUID()
  customerId!: string;
}
