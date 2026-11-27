/**
 * customers-bulk-actions / T1 (S1) — the selection object shared by the bulk
 * actions (`docs/proposals/customers-bulk-actions-contract.md` §2.1, §2.2).
 *
 *   { mode: "ids", customerIds: [uuid, …] }                 row checkboxes
 *   { mode: "filter", filter: {…}, excludeIds?: [uuid, …] }  «todos los del filtro»
 *
 * The global pipe validates the SHAPE only. `filter` stays a plain object
 * here: `CustomerBulkSelectionResolver` validates it with the listing DTO
 * (`parseCustomerBulkFilter`), so its errors keep the listing codes and the
 * plain param names.
 */
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsObject,
  IsUUID,
  ValidateIf,
  registerDecorator,
  type ValidationArguments,
} from 'class-validator';

/** Contract §2.2: `customerIds` and `excludeIds` hold at most 1,000 UUIDs. */
export const MAX_BULK_SELECTION_IDS = 1000;

export enum CustomerBulkSelectionMode {
  ids = 'ids',
  filter = 'filter',
}

/** A key of one mode sent with the other mode → 400 on that key (§2.1). */
function OnlyInMode(mode: CustomerBulkSelectionMode): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'bulkSelectionModeOnly',
      target: target.constructor,
      propertyName: propertyName.toString(),
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          if (value === undefined) return true;
          return (args.object as { mode?: unknown }).mode === mode;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} is only allowed with mode "${mode}"`;
        },
      },
    });
  };
}

export class CustomerBulkSelectionDto {
  @IsEnum(CustomerBulkSelectionMode)
  mode!: CustomerBulkSelectionMode | `${CustomerBulkSelectionMode}`;

  /** Ids mode: 1–1,000 UUIDs; duplicates are removed by the resolver. */
  @ValidateIf(
    (o: CustomerBulkSelectionDto) =>
      o.mode === CustomerBulkSelectionMode.ids || o.customerIds !== undefined,
  )
  @OnlyInMode(CustomerBulkSelectionMode.ids)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_BULK_SELECTION_IDS)
  @IsUUID('all', { each: true })
  customerIds?: string[];

  /**
   * Filter mode: the `GET /customers/listing` params exactly as in the URL
   * (string values, CSV lists as one comma-separated string). `{}` = every
   * customer of the branch. `page`, `limit`, `sortBy`, `sortOrder` rejected.
   */
  @ValidateIf(
    (o: CustomerBulkSelectionDto) =>
      o.mode === CustomerBulkSelectionMode.filter || o.filter !== undefined,
  )
  @OnlyInMode(CustomerBulkSelectionMode.filter)
  @IsObject()
  filter?: Record<string, unknown>;

  /** Filter mode: 0–1,000 UUIDs never selected; non-matching ids ignored. */
  @ValidateIf((o: CustomerBulkSelectionDto) => o.excludeIds !== undefined)
  @OnlyInMode(CustomerBulkSelectionMode.filter)
  @IsArray()
  @ArrayMaxSize(MAX_BULK_SELECTION_IDS)
  @IsUUID('all', { each: true })
  excludeIds?: string[];
}
