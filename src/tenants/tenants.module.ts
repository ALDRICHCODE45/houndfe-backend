import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { TENANT_REPOSITORY } from './domain/tenant.repository';
import { TENANT_MEMBERSHIP_REPOSITORY } from './domain/tenant-membership.repository';
import { PrismaTenantRepository } from './infrastructure/prisma-tenant.repository';
import { PrismaTenantMembershipRepository } from './infrastructure/prisma-tenant-membership.repository';
import { TenantsController } from './tenants.controller';
import { TenantsMembersController } from './tenants-members.controller';
import { TenantsService } from './tenants.service';
import { TenantsMembershipService } from './tenants-membership.service';

@Module({
  imports: [DatabaseModule, ClsModule],
  controllers: [TenantsController, TenantsMembersController],
  providers: [
    TenantsService,
    TenantsMembershipService,
    {
      provide: TENANT_REPOSITORY,
      useClass: PrismaTenantRepository,
    },
    {
      provide: TENANT_MEMBERSHIP_REPOSITORY,
      useClass: PrismaTenantMembershipRepository,
    },
  ],
  exports: [TenantsService, TenantsMembershipService],
})
export class TenantsModule {}
