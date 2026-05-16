import { IsISO8601, IsOptional, ValidateIf } from 'class-validator';

export class UpdateSaleDueDateDto {
  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== null && value !== undefined)
  @IsISO8601()
  dueDate?: string | null;
}
