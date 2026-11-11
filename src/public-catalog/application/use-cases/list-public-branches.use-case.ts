import { Inject, Injectable, Optional } from '@nestjs/common';
import type { PublicBranchDto } from '../dto/public-branch.dto';
import {
  type IPublicCatalogRepository,
  PUBLIC_CATALOG_REPOSITORY,
} from '../ports/public-catalog.repository';
import { PublicCatalogConfig } from '../services/public-catalog-config';

@Injectable()
export class ListPublicBranchesUseCase {
  constructor(
    @Inject(PUBLIC_CATALOG_REPOSITORY)
    private readonly repo: IPublicCatalogRepository,
    // Optional so callers that predate S5 keep building the use case without
    // it (no `whatsappNumber` key then); the module always provides it.
    @Optional() private readonly config?: PublicCatalogConfig,
  ) {}

  async execute(): Promise<PublicBranchDto[]> {
    const branches = await this.repo.findActiveBranches();
    if (!this.config) return branches;
    // S5 — one global bot number, the same value on every branch.
    const whatsappNumber = this.config.botWhatsappNumber();
    return branches.map((branch) => ({ ...branch, whatsappNumber }));
  }
}
