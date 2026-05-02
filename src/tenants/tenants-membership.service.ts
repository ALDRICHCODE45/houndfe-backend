import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import {
  TENANT_MEMBERSHIP_REPOSITORY,
  type ITenantMembershipRepository,
} from './domain/tenant-membership.repository';
import { CreateMembershipDto } from './dto/create-membership.dto';
import { UpdateMembershipDto } from './dto/update-membership.dto';

@Injectable()
export class TenantsMembershipService {
  constructor(
    @Inject(TENANT_MEMBERSHIP_REPOSITORY)
    private readonly membershipRepo: ITenantMembershipRepository,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  private async assertCanManageTenant(tenantId: string): Promise<void> {
    const { isSuperAdmin, userId } = this.cls.get();
    if (isSuperAdmin) return;

    const memberships = await this.membershipRepo.findByUserAndTenant(
      userId,
      tenantId,
    );

    if (memberships.length === 0) {
      throw new ForbiddenException('TENANT_ACCESS_DENIED');
    }
  }

  async create(tenantId: string, dto: CreateMembershipDto) {
    await this.assertCanManageTenant(tenantId);
    return this.membershipRepo.create({ ...dto, tenantId });
  }

  async findByTenant(tenantId: string) {
    await this.assertCanManageTenant(tenantId);
    return this.membershipRepo.findByTenant(tenantId);
  }

  async update(tenantId: string, membershipId: string, dto: UpdateMembershipDto) {
    await this.assertCanManageTenant(tenantId);
    const tenantMemberships = await this.membershipRepo.findByTenant(tenantId);
    const exists = tenantMemberships.some((m) => m.id === membershipId);
    if (!exists) throw new NotFoundException('TENANT_MEMBERSHIP_NOT_FOUND');
    return this.membershipRepo.update(membershipId, dto);
  }

  async remove(tenantId: string, membershipId: string): Promise<void> {
    await this.assertCanManageTenant(tenantId);
    const tenantMemberships = await this.membershipRepo.findByTenant(tenantId);
    const exists = tenantMemberships.some((m) => m.id === membershipId);
    if (!exists) throw new NotFoundException('TENANT_MEMBERSHIP_NOT_FOUND');
    await this.membershipRepo.delete(membershipId);
  }
}
