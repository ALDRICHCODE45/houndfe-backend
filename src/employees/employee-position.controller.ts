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
import { EmployeePositionService } from './application/employee-position.service';
import { AddPositionChangeDto } from './dto/add-position-change.dto';

@Controller('admin/employees/:employeeId/position-history')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class EmployeePositionController {
  constructor(private readonly positionService: EmployeePositionService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['update', 'Employee'])
  create(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: AddPositionChangeDto,
    @Req() req: any,
  ) {
    return this.positionService.addPositionChange(
      employeeId,
      dto,
      req.user?.id ?? null,
    );
  }

  @Get()
  @RequirePermissions(['read', 'Employee'])
  list(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.positionService.listPositionHistory(employeeId);
  }
}
