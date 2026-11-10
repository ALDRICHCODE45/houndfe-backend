import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
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
import { CredentialRateLimiter } from './credential-rate-limiter';
import {
  CREDENTIAL_LIMIT_CLASSES,
  ROUTE_CLASS_KEY,
  type BotRouteClassName,
} from './route-class';
import {
  DEFAULT_CLASS_LIMITS,
  ROUTE_RATE_LIMITER,
  type RouteRateLimiter,
} from './route-rate-limiter';

type ServiceRequest = {
  headers?: Record<string, string | string[] | undefined>;
  serviceCredential?: unknown;
};

type ServiceResponse = {
  setHeader(name: string, value: string): void;
};

@Injectable()
export class ServiceAuthGuard implements CanActivate {
  /**
   * Fallback for graphs that do not wire the shared limiter (unit specs
   * that build the guard alone). It counts per process, so production wires
   * `ROUTE_RATE_LIMITER` (PostgreSQL counters shared by every replica, R2) in
   * the global `BotRateLimitModule`.
   */
  private readonly memoryLimiter = new CredentialRateLimiter();

  constructor(
    @Inject(SERVICE_CREDENTIAL_REPOSITORY)
    private readonly credentials: IServiceCredentialRepository,
    private readonly cls: ClsService<TenantClsStore>,
    private readonly reflector: Reflector,
    @Optional()
    @Inject(ROUTE_RATE_LIMITER)
    private readonly sharedLimiter?: RouteRateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ServiceRequest>();
    const response = context.switchToHttp().getResponse<ServiceResponse>();
    const rawToken = this.extractBearerToken(request.headers?.authorization);

    if (!rawToken.startsWith('svc_')) {
      throw new UnauthorizedException('Invalid service credential');
    }

    const hashedKey = createHash('sha256').update(rawToken).digest('hex');
    const credential = await this.credentials.findByHashedKey(hashedKey);

    if (
      !credential ||
      !this.hashesMatch(credential.hashedKey, hashedKey) ||
      !credential.isActive ||
      credential.revokedAt
    ) {
      throw new UnauthorizedException('Invalid service credential');
    }

    this.assertBranchScope(request, credential.tenantId);

    // Method-level @RequiredScopes intentionally replace the controller-level
    // default when present. We use getAllAndOverride here on purpose instead of
    // merging scopes so specific routes can narrow or change access rules.
    const requiredScopes =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (!credentialHasRequiredScopes(credential, requiredScopes)) {
      throw new ForbiddenException('Insufficient service scope');
    }

    // Routes without a class keep the credential's own budget (`default`);
    // the human-decision routes have the same budget in their own bucket.
    const routeClass =
      this.reflector.getAllAndOverride<BotRouteClassName>(ROUTE_CLASS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'default';
    const defaultLimit = CREDENTIAL_LIMIT_CLASSES.includes(routeClass)
      ? credential.rateLimit
      : DEFAULT_CLASS_LIMITS[routeClass as keyof typeof DEFAULT_CLASS_LIMITS];
    const decision = this.sharedLimiter
      ? await this.sharedLimiter.check({
          credentialId: credential.id,
          routeClass,
          defaultLimit,
        })
      : this.memoryLimiter.check({
          credentialId: `${credential.id}:${routeClass}`,
          limit: defaultLimit,
        });

    if (!decision.allowed) {
      response.setHeader(
        'Retry-After',
        Math.max(1, Math.ceil(decision.retryAfterMs / 1000)).toString(),
      );
      throw new HttpException(
        'Service credential rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
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

  private hashesMatch(storedHash: string, computedHash: string): boolean {
    const stored = this.decodeSha256Hex(storedHash);
    const computed = this.decodeSha256Hex(computedHash);

    if (!stored || !computed || stored.length !== computed.length) {
      return false;
    }

    return timingSafeEqual(stored, computed);
  }

  private decodeSha256Hex(value: string): Buffer | null {
    if (value.length !== 64 || !/^[0-9a-f]+$/i.test(value)) {
      return null;
    }

    return Buffer.from(value, 'hex');
  }
}
