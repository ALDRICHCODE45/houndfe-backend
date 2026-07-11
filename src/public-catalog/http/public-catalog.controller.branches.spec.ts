import { ListPublicBranchesUseCase } from '../application/use-cases/list-public-branches.use-case';
import type { PublicBranchDto } from '../application/dto/public-branch.dto';
import type { IPublicCatalogRepository } from '../application/ports/public-catalog.repository';

describe('ListPublicBranchesUseCase', () => {
  let useCase: ListPublicBranchesUseCase;
  let repo: { findActiveBranches: jest.Mock };

  beforeEach(() => {
    repo = { findActiveBranches: jest.fn() };
    useCase = new ListPublicBranchesUseCase(
      repo as unknown as IPublicCatalogRepository,
    );
  });

  it('should return active branches sorted by name', async () => {
    const branches: PublicBranchDto[] = [
      {
        id: 'b1',
        name: 'Centro',
        slug: 'centro',
        address: 'Av. Juárez 123',
        phone: '+525512345678',
      },
      { id: 'b2', name: 'Norte', slug: 'norte', address: null, phone: null },
    ];
    repo.findActiveBranches.mockResolvedValue(branches);

    const result = await useCase.execute();

    expect(result).toEqual(branches);
    expect(repo.findActiveBranches).toHaveBeenCalledTimes(1);
  });

  it('should return empty array when no active branches exist', async () => {
    repo.findActiveBranches.mockResolvedValue([]);

    const result = await useCase.execute();

    expect(result).toEqual([]);
  });

  it('should never expose internal tenant fields', async () => {
    const branch: PublicBranchDto = {
      id: 'b1',
      name: 'Centro',
      slug: 'centro',
      address: 'Addr',
      phone: '123',
    };
    repo.findActiveBranches.mockResolvedValue([branch]);

    const result = await useCase.execute();

    const keys = Object.keys(result[0]);
    expect(keys).not.toContain('isActive');
    expect(keys).not.toContain('createdAt');
    expect(keys).not.toContain('updatedAt');
  });
});
