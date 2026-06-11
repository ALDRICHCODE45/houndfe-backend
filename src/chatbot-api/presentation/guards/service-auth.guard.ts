import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../../../shared/tenant/tenant-cls-store.interface';
import {
  IServiceCredentialRepository,
  SERVICE_CREDENTIAL_REPOSITORY,
} from '../../domain/service-credential.repository';
import {
  credentialHasRequiredScopes,
  REQUIRED_SCOPES_KEY,
} from '../decorators/required-scopes.decorator';

type ServiceRequest = {
  headers?: Record<string, string | string[] | undefined>;
  serviceCredential?: unknown;
};

@Injectable()
export class ServiceAuthGuard implements CanActivate {
  constructor(
    @Inject(SERVICE_CREDENTIAL_REPOSITORY)
    private readonly credentials: IServiceCredentialRepository,
    private readonly cls: ClsService<TenantClsStore>,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ServiceRequest>();
    const rawToken = this.extractBearerToken(request.headers?.authorization);

    if (!rawToken.startsWith('svc_')) {
      throw new UnauthorizedException('Invalid service credential');
    }

    const hashedKey = createHash('sha256').update(rawToken).digest('hex');
    const credential = await this.credentials.findByHashedKey(hashedKey);

    if (!credential || !credential.isActive || credential.revokedAt) {
      throw new UnauthorizedException('Invalid service credential');
    }

    this.assertBranchScope(request, credential.tenantId);

    const requiredScopes =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (!credentialHasRequiredScopes(credential, requiredScopes)) {
      throw new ForbiddenException('Insufficient service scope');
    }

    this.cls.set('tenantId', credential.tenantId);
    this.cls.set('userId', `service:${credential.id}`);
    this.cls.set('isSuperAdmin', false);
    request.serviceCredential = credential;
    await this.credentials.touchLastUsedAt(credential.id);

    return true;
  }

  private extractBearerToken(authorization?: string | string[]): string {
    const value = Array.isArray(authorization)
      ? authorization[0]
      : authorization;

    if (!value?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Service authorization required');
    }

    return value.slice('Bearer '.length).trim();
  }

  private assertBranchScope(request: ServiceRequest, tenantId: string): void {
    const branchIdHeader = request.headers?.['x-branch-id'];
    const branchId = Array.isArray(branchIdHeader)
      ? branchIdHeader[0]
      : branchIdHeader;

    if (branchId && branchId !== tenantId) {
      throw new ForbiddenException(
        'Credential is out of scope for this branch',
      );
    }
  }
}
