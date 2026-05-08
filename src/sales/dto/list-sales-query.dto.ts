import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export enum ListSalesSortBy {
  confirmedAt = 'confirmedAt',
  totalCents = 'totalCents',
  createdAt = 'createdAt',
}

export enum ListSalesSortOrder {
  asc = 'asc',
  desc = 'desc',
}

export enum ListSalesStatus {
  DRAFT = 'DRAFT',
  CONFIRMED = 'CONFIRMED',
  CANCELED = 'CANCELED',
}

export enum ListSalesPaymentStatus {
  PAID = 'PAID',
  PARTIAL = 'PARTIAL',
  CREDIT = 'CREDIT',
}

export enum ListSalesDeliveryStatus {
  PENDING = 'PENDING',
  DELIVERED = 'DELIVERED',
  NOT_APPLICABLE = 'NOT_APPLICABLE',
}

export class ListSalesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @IsOptional()
  @IsEnum(ListSalesSortBy)
  sortBy: ListSalesSortBy = ListSalesSortBy.confirmedAt;

  @IsOptional()
  @IsEnum(ListSalesSortOrder)
  sortOrder: ListSalesSortOrder = ListSalesSortOrder.desc;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsEnum(ListSalesStatus)
  status?: ListSalesStatus;

  @IsOptional()
  @IsEnum(ListSalesPaymentStatus)
  paymentStatus?: ListSalesPaymentStatus;

  @IsOptional()
  @IsEnum(ListSalesDeliveryStatus)
  deliveryStatus?: ListSalesDeliveryStatus;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @IsOptional()
  @IsUUID()
  cashierUserId?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;
}
