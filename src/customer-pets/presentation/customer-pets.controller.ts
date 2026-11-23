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
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { CustomerPetsService } from '../application/customer-pets.service';
import type { PetView, PetWriteResult } from '../domain/customer-pet.types';
import { toPetHttpError } from './customer-pet-http-error';
import {
  ArchiveCustomerPetDto,
  CreateCustomerPetDto,
  DeleteCustomerPetQueryDto,
  ListCustomerPetsQueryDto,
  RestoreCustomerPetDto,
  UpdateCustomerPetDto,
} from './dto/customer-pet.dto';

/**
 * POS pet routes (contract §5), the same pattern and guards as the customer
 * addresses: `read`/`update`/`delete` on `Customer`, no new CASL subject. The
 * tenant is the token's. Every failure goes through `toPetHttpError` (code-only
 * envelope; the 400s of the DTOs come from the global `ValidationPipe`).
 */
@Controller('customers/:customerId/pets')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CustomerPetsController {
  constructor(private readonly pets: CustomerPetsService) {}

  @Get()
  @RequirePermissions(['read', 'Customer'])
  async list(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: ListCustomerPetsQueryDto,
  ): Promise<PetView[]> {
    try {
      return await this.pets.list(customerId, query.status);
    } catch (error) {
      throw toPetHttpError(error);
    }
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['update', 'Customer'])
  async create(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CreateCustomerPetDto,
  ): Promise<PetWriteResult> {
    try {
      return await this.pets.create(customerId, dto, 'POS');
    } catch (error) {
      throw toPetHttpError(error);
    }
  }

  @Patch(':petId')
  @RequirePermissions(['update', 'Customer'])
  async update(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('petId', ParseUUIDPipe) petId: string,
    @Body() dto: UpdateCustomerPetDto,
  ): Promise<PetWriteResult> {
    try {
      const { version, ...patch } = dto;
      return await this.pets.update(customerId, petId, version, patch);
    } catch (error) {
      throw toPetHttpError(error);
    }
  }

  @Post(':petId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Customer'])
  async archive(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('petId', ParseUUIDPipe) petId: string,
    @Body() dto: ArchiveCustomerPetDto,
  ): Promise<PetWriteResult> {
    try {
      return await this.pets.archive(
        customerId,
        petId,
        dto.version,
        dto.reason,
      );
    } catch (error) {
      throw toPetHttpError(error);
    }
  }

  @Post(':petId/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Customer'])
  async restore(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('petId', ParseUUIDPipe) petId: string,
    @Body() dto: RestoreCustomerPetDto,
  ): Promise<PetWriteResult> {
    try {
      return await this.pets.restore(customerId, petId, dto.version);
    } catch (error) {
      throw toPetHttpError(error);
    }
  }

  /** Real erasure (§6): scrubs the pet columns of its sale lines, `204`. */
  @Delete(':petId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'Customer'])
  async remove(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('petId', ParseUUIDPipe) petId: string,
    @Query() query: DeleteCustomerPetQueryDto,
  ): Promise<void> {
    try {
      await this.pets.delete(customerId, petId, query.version);
    } catch (error) {
      throw toPetHttpError(error);
    }
  }
}
