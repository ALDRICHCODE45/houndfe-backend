import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../../../shared/tenant/tenant-cls-store.interface';
import { PrismaService } from '../../../shared/prisma/prisma.service';

@Injectable()
export class PublicTenantGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const slug: string | undefined = request.params?.tenantSlug;

    // Branches endpoint has no tenantSlug — bypass
    if (!slug) {
      return true;
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { slug, isActive: true },
    });

    if (!tenant) {
      throw new NotFoundException('Not Found');
    }

    // Set CLS context for downstream tenant-scoped queries
    this.cls.set('tenantId', tenant.id);
    this.cls.set('tenantSlug', tenant.slug);
    this.cls.set('isSuperAdmin', false);
    this.cls.set('userId', 'public');

    // Attach to request for @PublicTenant() decorator
    request.publicTenant = {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
    };

    return true;
  }
}
