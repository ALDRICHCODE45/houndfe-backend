/**
 * Bot pet routes (contract §7). `ServiceAuthGuard` authenticates the `svc_`
 * credential, pins the trusted tenant into CLS and checks the route's scope;
 * nothing about the tenant is read from the request. Every route calls the
 * same `CustomerPetsService` as the POS (`createdVia = 'CHATBOT'`) and fails
 * through `toPetHttpError`, so bodies and codes are the POS ones.
 *
 * Only create is keyed (`X-Idempotency-Key`); PATCH, archive and restore rely
 * on `version` (a retry whose first attempt applied gets `PET_VERSION_CONFLICT`).
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { RequiredScopes } from '../../../chatbot-api/presentation/decorators/required-scopes.decorator';
import { BotRouteClass } from '../../../chatbot-api/presentation/guards/route-class';
import { ServiceAuthGuard } from '../../../chatbot-api/presentation/guards/service-auth.guard';
import { BotAuditInterceptor } from '../../../chatbot-api/presentation/interceptors/bot-audit.interceptor';
import { ParseIdempotencyKeyPipe } from '../../../chatbot-api/presentation/pipes/parse-idempotency-key.pipe';
import { InvalidArgumentError } from '../../../shared/domain/domain-error';
import { CustomerPetsService } from '../../application/customer-pets.service';
import { CUSTOMER_PET_SCOPES } from '../../domain/customer-pet-scopes';
import type { PetView, PetWriteResult } from '../../domain/customer-pet.types';
import { petHttpError, toPetHttpError } from '../customer-pet-http-error';
import {
  ArchiveCustomerPetDto,
  CreateCustomerPetDto,
  DeleteCustomerPetQueryDto,
  ListCustomerPetsQueryDto,
  RestoreCustomerPetDto,
  UpdateCustomerPetDto,
} from '../dto/customer-pet.dto';
import { CustomerPetBotCreateService } from './customer-pet-bot-create.service';

/** The key pipe throws a code-only `InvalidArgumentError` (400); keep its code. */
function parseKey(raw: unknown): string {
  try {
    return new ParseIdempotencyKeyPipe().transform(raw, { type: 'custom' });
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      throw petHttpError(400, error.code);
    }
    throw toPetHttpError(error);
  }
}

@Controller('chatbot-api/customers/:customerId/pets')
@UseGuards(ServiceAuthGuard)
@UseInterceptors(BotAuditInterceptor)
export class CustomerPetsBotController {
  constructor(
    private readonly pets: CustomerPetsService,
    private readonly creator: CustomerPetBotCreateService,
  ) {}

  @Get()
  @BotRouteClass('read')
  @RequiredScopes(CUSTOMER_PET_SCOPES.read)
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

  /** `201` created; `200` when the same key and body already created it. */
  @Post()
  @BotRouteClass('write')
  @RequiredScopes(CUSTOMER_PET_SCOPES.write)
  async create(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CreateCustomerPetDto,
    @Headers('x-idempotency-key') rawKey: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PetWriteResult> {
    try {
      const key = parseKey(rawKey);
      const result = await this.creator.create(customerId, dto, key);
      response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
      return result.pet;
    } catch (error) {
      throw toPetHttpError(error);
    }
  }

  @Patch(':petId')
  @BotRouteClass('write')
  @RequiredScopes(CUSTOMER_PET_SCOPES.write)
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
  @BotRouteClass('write')
  @RequiredScopes(CUSTOMER_PET_SCOPES.write)
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
  @BotRouteClass('write')
  @RequiredScopes(CUSTOMER_PET_SCOPES.write)
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
  @BotRouteClass('write')
  @RequiredScopes(CUSTOMER_PET_SCOPES.delete)
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
