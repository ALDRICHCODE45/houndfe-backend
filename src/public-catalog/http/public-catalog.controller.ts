import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  ParseUUIDPipe,
  NotFoundException,
} from '@nestjs/common';
import { PublicTenantGuard } from './guards/public-tenant.guard';
import {
  PublicTenant,
  type PublicTenantInfo,
} from './decorators/public-tenant.decorator';
import { ListPublicBranchesUseCase } from '../application/use-cases/list-public-branches.use-case';

@Controller('public/catalog')
@UseGuards(PublicTenantGuard)
export class PublicCatalogController {
  constructor(
    private readonly listBranches: ListPublicBranchesUseCase,
  ) {}

  @Get('branches')
  async getBranches() {
    return this.listBranches.execute();
  }
}
