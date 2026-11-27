/**
 * customers-bulk-actions / T1 (S2) — body of `POST /customers/bulk/export`
 * (`docs/proposals/customers-bulk-actions-contract.md` §4.1).
 */
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEnum,
  IsObject,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import {
  CustomersListingSortBy,
  CustomersListingSortOrder,
} from '../listing/customers-listing-query.dto';
import { CustomerBulkSelectionDto } from './customer-bulk-selection.dto';

export class CustomersBulkExportBodyDto {
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => CustomerBulkSelectionDto)
  selection!: CustomerBulkSelectionDto;

  /** Same values, default (`createdAt`) and permission rule as the listing. */
  @IsOptional()
  @IsEnum(CustomersListingSortBy)
  sortBy?: CustomersListingSortBy;

  /** Default `desc`. */
  @IsOptional()
  @IsEnum(CustomersListingSortOrder)
  sortOrder?: CustomersListingSortOrder;
}
