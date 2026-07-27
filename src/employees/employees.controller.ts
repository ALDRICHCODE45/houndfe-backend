import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { EmployeesService } from './application/employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { ListEmployeesQueryDto } from './dto/list-employees.query.dto';
import { TerminateEmployeeDto } from './dto/terminate-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import {
  BatchDeleteDto,
  BatchDeleteGuard,
  BatchDeleteOrchestrator,
} from '../shared/batch-delete';

@Controller('admin/employees')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class EmployeesController {
  constructor(
    private readonly employeesService: EmployeesService,
    private readonly batchDeleteOrchestrator: BatchDeleteOrchestrator,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'Employee'])
  create(@Body() dto: CreateEmployeeDto) {
    return this.employeesService.create(dto);
  }

  @Get()
  @RequirePermissions(['read', 'Employee'])
  findAll(@Query() query: ListEmployeesQueryDto) {
    return this.employeesService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions(['read', 'Employee'])
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.employeesService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(['update', 'Employee'])
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.employeesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'Employee'])
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.employeesService.remove(id);
  }

  @Post(':id/terminate')
  @RequirePermissions(['update', 'Employee'])
  terminate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TerminateEmployeeDto,
  ) {
    return this.employeesService.terminate(id, dto);
  }

  @Post(':id/reactivate')
  @RequirePermissions(['update', 'Employee'])
  reactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.employeesService.reactivate(id);
  }

  @Get(':id/subordinates')
  @RequirePermissions(['read', 'Employee'])
  findSubordinates(@Param('id', ParseUUIDPipe) id: string) {
    return this.employeesService.findSubordinates(id);
  }

  @Get(':id/manager-chain')
  @RequirePermissions(['read', 'Employee'])
  findManagerChain(@Param('id', ParseUUIDPipe) id: string) {
    return this.employeesService.findManagerChain(id);
  }

  // ==================== Batch Delete ====================

  /**
   * `POST /admin/employees/batch-delete`
   *
   * All-or-nothing deletion of multiple employees. Pre-flight
   * validation rejects the whole batch if any ID does not exist in
   * the current tenant — see `EmployeesService.validateForBatchDeletion`
   * for the rules. The 5 child tables (`EmployeeSalaryHistory`,
   * `EmployeePositionHistory`, `EmployeeDocument`, `EmployeeTimeOff`,
   * `EmployeeEmergencyContact`) cascade via the Prisma schema.
   *
   * Permission enforcement:
   *  - `@RequirePermissions(['batch_delete', 'Employee'])` is read by
   *    both the standard `PermissionsGuard` (chain) and the dedicated
   *    `BatchDeleteGuard` (R10: manage does NOT imply batch_delete).
   */
  @Post('batch-delete')
  @HttpCode(HttpStatus.OK)
  @UseGuards(BatchDeleteGuard)
  @RequirePermissions(['batch_delete', 'Employee'])
  async batchDelete(
    @Body() dto: BatchDeleteDto,
  ): Promise<{ deleted: number }> {
    return this.batchDeleteOrchestrator.execute(dto.ids);
  }

  // ==================== Batch Status (inline) ====================

  /**
   * `POST /admin/employees/batch-terminate`
   *
   * Inline batch terminate — every id in `dto.ids` is flipped to
   * `status = TERMINATED` and `terminationDate = now()` in a single
   * Prisma `updateMany`. The inline pattern (no shared orchestrator)
   * mirrors the inline batch-delete DTO contract: same request body,
   * same 404 shape on missing ids. The `update:Employee` permission
   * is reused — terminating is logically an UPDATE, not a DELETE.
   */
  @Post('batch-terminate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Employee'])
  async batchTerminate(
    @Body() dto: BatchDeleteDto,
  ): Promise<{ updated: number }> {
    return this.employeesService.batchTerminate(dto.ids);
  }

  /**
   * `POST /admin/employees/batch-reactivate`
   *
   * Inline batch reactivate — every id in `dto.ids` is flipped to
   * `status = ACTIVE` and `terminationDate = null` in a single
   * Prisma `updateMany`. Mirrors the `batchTerminate` contract for
   * requests, response (`{ updated: N }`), and 404 shape on
   * missing ids. Reuses `update:Employee` — reactivating is also
   * logically an UPDATE.
   */
  @Post('batch-reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Employee'])
  async batchReactivate(
    @Body() dto: BatchDeleteDto,
  ): Promise<{ updated: number }> {
    return this.employeesService.batchReactivate(dto.ids);
  }
}
