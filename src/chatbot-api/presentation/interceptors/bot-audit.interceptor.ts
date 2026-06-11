import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { catchError, from, map, Observable, switchMap, throwError } from 'rxjs';
import type { ServiceCredential } from '../../domain/service-credential.entity';
import { BOT_AUDIT_LOG_REPOSITORY } from '../../infrastructure/prisma-bot-audit-log.repository';
import type {
  BotAuditLogEntry,
  IBotAuditLogRepository,
} from '../../infrastructure/prisma-bot-audit-log.repository';

type AuditRequest = {
  method?: string;
  route?: { path?: string };
  params?: Record<string, string | undefined>;
  serviceCredential?: Pick<ServiceCredential, 'id' | 'tenantId'>;
};

type AuditResponse = {
  statusCode?: number;
};

type RouteAuditDefinition = {
  action: string;
  resourceType: string;
  resourceIdParam?: string;
};

const ROUTE_AUDIT_MAP: Record<string, RouteAuditDefinition> = {
  'GET catalog/search': {
    action: 'catalog.search',
    resourceType: 'catalog',
  },
  'GET catalog/:productId/stock': {
    action: 'catalog.check_stock',
    resourceType: 'product',
    resourceIdParam: 'productId',
  },
  'GET customers/by-phone': {
    action: 'customers.find_by_phone',
    resourceType: 'customer',
  },
  'PUT customers/by-phone': {
    action: 'customers.upsert_profile',
    resourceType: 'customer',
  },
  'POST pricing/evaluate-cart': {
    action: 'pricing.evaluate_cart',
    resourceType: 'cart',
  },
  'POST sales': {
    action: 'sales.register',
    resourceType: 'sale',
  },
  'POST sales/:saleId/receipts': {
    action: 'sales.attach_receipt',
    resourceType: 'sale',
    resourceIdParam: 'saleId',
  },
  'PATCH sales/:saleId/delivery': {
    action: 'sales.update_delivery',
    resourceType: 'sale',
    resourceIdParam: 'saleId',
  },
  'GET customers/by-phone/:phone/orders': {
    action: 'customers.order_history',
    resourceType: 'customer',
    resourceIdParam: 'phone',
  },
};

@Injectable()
export class BotAuditInterceptor implements NestInterceptor {
  constructor(
    @Inject(BOT_AUDIT_LOG_REPOSITORY)
    private readonly auditLogs: IBotAuditLogRepository,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuditRequest>();
    const response = context.switchToHttp().getResponse<AuditResponse>();
    const entry = this.buildBaseEntry(request);

    if (!entry) {
      return next.handle();
    }

    return next.handle().pipe(
      switchMap((payload: unknown) =>
        from(
          this.auditLogs.append({
            ...entry,
            metadata: {
              branchId: entry.tenantId,
              httpMethod: request.method ?? 'GET',
              routePath: request.route?.path ?? 'unknown',
              statusCode: response.statusCode ?? 200,
              outcome: 'success',
            },
          }),
        ).pipe(map(() => payload)),
      ),
      catchError((error: unknown) =>
        from(
          this.auditLogs.append({
            ...entry,
            metadata: {
              branchId: entry.tenantId,
              httpMethod: request.method ?? 'GET',
              routePath: request.route?.path ?? 'unknown',
              statusCode: this.resolveErrorStatus(error, response.statusCode),
              outcome: 'error',
              errorMessage: this.resolveErrorMessage(error),
            },
          }),
        ).pipe(switchMap(() => throwError(() => error))),
      ),
    );
  }

  private buildBaseEntry(
    request: AuditRequest,
  ): Omit<BotAuditLogEntry, 'metadata'> | null {
    const credential = request.serviceCredential;
    const routePath = normalizeRoutePath(request.route?.path);
    const method = (request.method ?? 'GET').toUpperCase();
    const definition = ROUTE_AUDIT_MAP[`${method} ${routePath}`];

    if (!credential || !definition) {
      return null;
    }

    return {
      tenantId: credential.tenantId,
      credentialId: credential.id,
      action: definition.action,
      resourceType: definition.resourceType,
      resourceId: definition.resourceIdParam
        ? (request.params?.[definition.resourceIdParam] ?? null)
        : null,
    };
  }

  private resolveErrorStatus(error: unknown, fallback?: number): number {
    if (error instanceof HttpException) {
      return error.getStatus();
    }

    return fallback ?? 500;
  }

  private resolveErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown chatbot API error';
  }
}

function normalizeRoutePath(routePath?: string): string {
  const normalized = (routePath ?? 'unknown').replace(/^\/+/, '');

  if (normalized.startsWith('chatbot-api/')) {
    return normalized.slice('chatbot-api/'.length);
  }

  return normalized;
}
