import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { TenantClsStore } from './tenant-cls-store.interface';

@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(private readonly cls: ClsService<TenantClsStore>) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('Authenticated user required');
    }

    this.cls.set('userId', user.userId);
    this.cls.set('tenantId', user.tenantId);
    this.cls.set('tenantSlug', user.tenantSlug);
    this.cls.set('isSuperAdmin', user.isSuperAdmin);

    if (!user.tenantId && !user.isSuperAdmin) {
      throw new UnauthorizedException('Tenant context required');
    }

    return true;
  }
}
