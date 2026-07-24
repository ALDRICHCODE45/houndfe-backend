/**
 * BatchDeleteDto — request payload for `POST <module>/batch-delete`.
 *
 * Validates a non-empty UUID-4 array bounded by `BATCH_DELETE_MAX_SIZE`.
 * `class-validator` enforces; the orchestrator/guard stay type-clean.
 *
 * Spec: batch-delete/spec.md R2 (DTO validation).
 */
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsUUID } from 'class-validator';
import { BATCH_DELETE_MAX_SIZE } from '../batch-delete.constants';

export class BatchDeleteDto {
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_DELETE_MAX_SIZE)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  ids!: string[];
}