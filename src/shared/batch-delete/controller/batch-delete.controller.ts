/**
 * BatchDeleteController — mixin factory for `POST <path>/batch-delete`.
 *
 * Spec: batch-delete/spec.md R3 (Controller factory), R6 (response
 * contract).
 *
 * Returns a NestJS class that:
 *  - is annotated with `@Controller('<path>')`
 *  - exposes `POST /batch-delete` with `@HttpCode(HttpStatus.OK)`
 *  - carries `@RequirePermissions(['batch_delete', subject])`
 *  - uses `@UseGuards(BatchDeleteGuard)` so R10 (manage ≠ batch_delete)
 *    is enforced even when the route is registered inside a context
 *    that already wires other guards.
 *
 * Each bounded context instantiates its own controller by calling
 * `POST({ subject, path })` and registers the returned class in its
 * NestJS module. The constructor injects the bound orchestrator and
 * the `BatchDeletableService` (the latter is consumed transitively
 * by the orchestrator — included here only so the controller's
 * module wiring has the right provider set).
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AppSubjects } from '../../../auth/authorization/domain/permission';
import { RequirePermissions } from '../../../auth/authorization/decorators/require-permissions.decorator';
import type { BatchDeleteOrchestrator } from '../orchestrator/batch-delete.orchestrator';
import type { BatchDeletableService } from '../batch-delete.types';
import { BatchDeleteDto } from '../dto/batch-delete.dto';
import { BatchDeleteGuard } from '../guards/batch-delete.guard';

export interface BatchDeleteControllerOptions {
  subject: AppSubjects;
  path: string;
}

/**
 * Mixin factory — returns a class wired for `<path>/batch-delete`.
 *
 * Each call yields a FRESH class; do not cache the result across
 * different `{ subject, path }` configurations.
 */
export function POST(options: BatchDeleteControllerOptions) {
  const { subject, path } = options;

  // NOTE: properties are `public readonly` (not `private`) because
  // TypeScript's `export` of an anonymous class type forbids private
  // modifiers on its members. The runtime semantics are the same —
  // NestJS only injects via the constructor parameter list, never
  // reads these fields outside the handler.
  @Controller(path)
  @UseGuards(BatchDeleteGuard)
  class BatchDeleteController {
    constructor(
      public readonly orchestrator: BatchDeleteOrchestrator,
      // The service is owned by the orchestrator; declaring it on the
      // constructor keeps the module's providers list honest (NestJS
      // needs both in scope for DI to resolve).
      public readonly _service: BatchDeletableService,
    ) {}

    @Post('batch-delete')
    @HttpCode(HttpStatus.OK)
    @RequirePermissions(['batch_delete', subject])
    async batchDelete(@Body() dto: BatchDeleteDto): Promise<{
      deleted: number;
    }> {
      return this.orchestrator.execute(dto.ids);
    }
  }

  return BatchDeleteController;
}