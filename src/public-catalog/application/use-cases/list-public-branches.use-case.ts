import { Inject, Injectable } from '@nestjs/common';
import type { PublicBranchDto } from '../dto/public-branch.dto';
import {
  type IPublicCatalogRepository,
  PUBLIC_CATALOG_REPOSITORY,
} from '../ports/public-catalog.repository';

@Injectable()
export class ListPublicBranchesUseCase {
  constructor(
    @Inject(PUBLIC_CATALOG_REPOSITORY)
    private readonly repo: IPublicCatalogRepository,
  ) {}

  async execute(): Promise<PublicBranchDto[]> {
    return this.repo.findActiveBranches();
  }
}
