import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { PrismaService } from '../shared/prisma/prisma.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import {
  TENANT_REPOSITORY,
  type ITenantRepository,
} from './domain/tenant.repository';

@Injectable()
export class TenantsService {
  constructor(
    @Inject(TENANT_REPOSITORY)
    private readonly tenantRepo: ITenantRepository,
    private readonly cls: ClsService<TenantClsStore>,
    private readonly prisma: PrismaService,
  ) {}

  private assertSuperAdmin(): void {
    const { isSuperAdmin } = this.cls.get();
    if (!isSuperAdmin) {
      throw new ForbiddenException('SUPER_ADMIN_REQUIRED');
    }
  }

  async create(dto: CreateTenantDto) {
    this.assertSuperAdmin();
    return this.tenantRepo.create(dto);
  }

  async findAll(includeInactive = false) {
    this.assertSuperAdmin();
    return this.tenantRepo.findAll(includeInactive);
  }

  async findOne(id: string) {
    this.assertSuperAdmin();
    const tenant = await this.tenantRepo.findById(id);
    if (!tenant) throw new NotFoundException('TENANT_NOT_FOUND');
    return tenant;
  }

  async update(id: string, dto: UpdateTenantDto) {
    this.assertSuperAdmin();
    const tenant = await this.tenantRepo.findById(id);
    if (!tenant) throw new NotFoundException('TENANT_NOT_FOUND');
    return this.tenantRepo.update(id, dto);
  }

  async deactivate(id: string): Promise<void> {
    this.assertSuperAdmin();
    const tenant = await this.tenantRepo.findById(id);
    if (!tenant) throw new NotFoundException('TENANT_NOT_FOUND');
    await this.tenantRepo.update(id, { isActive: false });
  }

  async findRoles(id: string): Promise<{ data: Array<{ id: string; name: string }> }> {
    this.assertSuperAdmin();

    const tenant = await this.tenantRepo.findById(id);
    if (!tenant) throw new NotFoundException('TENANT_NOT_FOUND');

    const roles = await this.prisma.role.findMany({
      where: { tenantId: id },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    return { data: roles };
  }

  async assertTenantActive(id: string): Promise<void> {
    const tenant = await this.tenantRepo.findById(id);
    if (!tenant) throw new NotFoundException('TENANT_NOT_FOUND');
    if (!tenant.isActive) {
      throw new ForbiddenException('TENANT_INACTIVE');
    }
  }
}
