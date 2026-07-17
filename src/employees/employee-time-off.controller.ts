import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { EmployeeTimeOffService } from './application/employee-time-off.service';
import { CreateTimeOffDto } from './dto/create-time-off.dto';
import { ReviewTimeOffDto } from './dto/review-time-off.dto';
import { ListTimeOffQueryDto } from './dto/list-time-off.query.dto';

@Controller()
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class EmployeeTimeOffController {
  constructor(private readonly timeOffService: EmployeeTimeOffService) {}

  /** POST /admin/employees/:employeeId/time-off — request time-off */
  @Post('admin/employees/:employeeId/time-off')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'EmployeeTimeOff'])
  request(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: CreateTimeOffDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.timeOffService.request(employeeId, dto, user.userId);
  }

  /** GET /admin/employees/:employeeId/time-off — list time-off for employee */
  @Get('admin/employees/:employeeId/time-off')
  @RequirePermissions(['read', 'EmployeeTimeOff'])
  list(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: ListTimeOffQueryDto,
  ) {
    // ability not passed — service defaults to most-restrictive (strips SICK reasons)
    return this.timeOffService.listForEmployee(employeeId, query);
  }

  /** GET /admin/employees/:employeeId/time-off/vacation-balance */
  @Get('admin/employees/:employeeId/time-off/vacation-balance')
  @RequirePermissions(['read', 'EmployeeTimeOff'])
  vacationBalance(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query('year', new ParseIntPipe({ optional: true })) year?: number,
  ) {
    return this.timeOffService.getVacationBalance(employeeId, year);
  }

  /** POST /admin/employees/:employeeId/time-off/:timeOffId/review — approve or reject */
  @Post('admin/employees/:employeeId/time-off/:timeOffId/review')
  @RequirePermissions(['update', 'EmployeeTimeOff'])
  review(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('timeOffId', ParseUUIDPipe) timeOffId: string,
    @Body() dto: ReviewTimeOffDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.timeOffService.review(employeeId, timeOffId, dto, user.userId);
  }

  /** POST /admin/employees/:employeeId/time-off/:timeOffId/cancel */
  @Post('admin/employees/:employeeId/time-off/:timeOffId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'EmployeeTimeOff'])
  cancel(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('timeOffId', ParseUUIDPipe) timeOffId: string,
  ) {
    return this.timeOffService.cancel(employeeId, timeOffId);
  }

  /** GET /admin/employees-time-off/pending-approvals — tenant-wide inbox */
  @Get('admin/employees-time-off/pending-approvals')
  @RequirePermissions(['read', 'EmployeeTimeOff'])
  pendingApprovals() {
    // Slice 1 — tenant-wide pending-approvals inbox. The previous
    // manager-scoped routes (`by-manager/:managerId` + current-user
    // resolution) were removed: the sole `Employee.userId` reader
    // retired along with the schema column. See
    // `employee-time-off.service.ts` for the new query.
    return this.timeOffService.listPendingApprovals();
  }
}
