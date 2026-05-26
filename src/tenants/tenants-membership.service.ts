import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { CaslAbilityFactory } from '../auth/authorization/casl-ability.factory';
import type {
  AppActions,
  AppSubjects,
} from '../auth/authorization/domain/permission';
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
    private readonly caslAbilityFactory: CaslAbilityFactory,
  ) {}

  private async assertCanManageTenant(
    tenantId: string,
    action: AppActions,
    subject: AppSubjects = 'TenantMembership',
  ): Promise<void> {
    const { isSuperAdmin, userId } = this.cls.get();

    if (isSuperAdmin) return;

    const memberships = await this.membershipRepo.findByUserAndTenant(
      userId,
      tenantId,
    );

    if (memberships.length === 0) {
      throw new ForbiddenException('TENANT_ACCESS_DENIED');
    }

    const ability = await this.caslAbilityFactory.createForUser(userId, {
      tenantId,
      isSuperAdmin: false,
    });

    if (!ability.can(action, subject)) {
      throw new ForbiddenException('INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT');
    }
  }

  async create(tenantId: string, dto: CreateMembershipDto) {
    await this.assertCanManageTenant(tenantId, 'create', 'TenantMembership');
    return this.membershipRepo.create({ ...dto, tenantId });
  }

  async findByTenant(tenantId: string) {
    await this.assertCanManageTenant(tenantId, 'read', 'TenantMembership');
    return this.membershipRepo.findByTenant(tenantId);
  }

  async update(
    tenantId: string,
    membershipId: string,
    dto: UpdateMembershipDto,
  ) {
    await this.assertCanManageTenant(tenantId, 'update', 'TenantMembership');
    const tenantMemberships = await this.membershipRepo.findByTenant(tenantId);
    const exists = tenantMemberships.some((m) => m.id === membershipId);
    if (!exists) throw new NotFoundException('TENANT_MEMBERSHIP_NOT_FOUND');
    return this.membershipRepo.update(membershipId, dto);
  }

  async remove(tenantId: string, membershipId: string): Promise<void> {
    await this.assertCanManageTenant(tenantId, 'delete', 'TenantMembership');
    const tenantMemberships = await this.membershipRepo.findByTenant(tenantId);
    const exists = tenantMemberships.some((m) => m.id === membershipId);
    if (!exists) throw new NotFoundException('TENANT_MEMBERSHIP_NOT_FOUND');
    await this.membershipRepo.delete(membershipId);
  }
}
