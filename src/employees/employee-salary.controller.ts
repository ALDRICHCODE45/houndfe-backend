import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { EmployeeSalaryService } from './application/employee-salary.service';
import { AddSalaryChangeDto } from './dto/add-salary-change.dto';

@Controller('admin/employees/:employeeId/salary-history')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class EmployeeSalaryController {
  constructor(private readonly salaryService: EmployeeSalaryService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'EmployeeSalary'])
  create(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: AddSalaryChangeDto,
    @Req() req: any,
  ) {
    return this.salaryService.addSalaryChange(
      employeeId,
      dto,
      req.user?.id ?? null,
    );
  }

  @Get()
  @RequirePermissions(['read', 'EmployeeSalary'])
  list(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.salaryService.listSalaryHistory(employeeId);
  }
}
