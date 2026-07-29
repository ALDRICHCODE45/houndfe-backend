import { IsOptional, IsString, MinLength } from 'class-validator';
import { BatchDeleteDto } from '../../shared/batch-delete/dto/batch-delete.dto';

/**
 * Batch terminate DTO — extends BatchDeleteDto with an optional
 * termination reason. Mirrors the single-record `TerminateEmployeeDto`
 * contract so the frontend can send the same fields.
 */
export class BatchTerminateEmployeeDto extends BatchDeleteDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  reason?: string;
}
