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
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
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
    @Req() req: any,
  ) {
    return this.timeOffService.request(
      employeeId,
      dto,
      req.user?.id ?? req.user?.userId,
    );
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
    @Req() req: any,
  ) {
    const reviewerUserId = req.user?.id ?? req.user?.userId;
    return this.timeOffService.review(
      employeeId,
      timeOffId,
      dto,
      reviewerUserId,
    );
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

  /** GET /admin/employees-time-off/pending-approvals?managerId=:uuid — manager view */
  @Get('admin/employees-time-off/pending-approvals')
  @RequirePermissions(['read', 'EmployeeTimeOff'])
  pendingApprovals(@Query('managerId', ParseUUIDPipe) managerId: string) {
    // ability not passed — service defaults to most-restrictive (strips SICK reasons)
    return this.timeOffService.listPendingApprovalsForManager(managerId);
  }
}
