/**
 * customers-bulk-actions / T3 (S5) — body of `POST /customers/bulk/statements`
 * (`docs/proposals/customers-bulk-actions-contract.md` §3.1):
 *
 *   { "selection": {…}, "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }
 *
 * `from` / `to` are inherited from `CustomerStatementQueryDto`, so the rules
 * are exactly the single statement's (shared constraints, not copied): exact
 * local `YYYY-MM-DD` dates in the business timezone, half-open `[from, to)`,
 * 1–366 days. `selection` is the shared bulk selection (ids or filter +
 * excludeIds).
 */
import { Type } from 'class-transformer';
import { IsDefined, IsObject, ValidateNested } from 'class-validator';
import { CustomerBulkSelectionDto } from '../../customers/bulk';
import { CustomerStatementQueryDto } from './customer-statement.dto';

export class CustomerBulkStatementsBodyDto extends CustomerStatementQueryDto {
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => CustomerBulkSelectionDto)
  selection!: CustomerBulkSelectionDto;
}
