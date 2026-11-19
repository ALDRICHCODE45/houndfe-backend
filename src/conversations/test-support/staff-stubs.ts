/**
 * Test-only stand-ins for the staff guards of the conversation specs: the
 * caller (tenant, user, role) comes from headers and the role maps to a CASL
 * ability. The real guards have their own specs; the route's
 * `@RequirePermissions` is still enforced against the stubbed ability.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { ClsService } from 'nestjs-cls';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import { InsufficientPermissionsError } from '../../shared/domain/domain-error';

type Grant = [AppActions, AppSubjects];
const READ_UPDATE: Grant[] = [
  ['read', 'ChatbotRequest'],
  ['update', 'ChatbotRequest'],
];

export const STUB_ROLES: Record<string, Grant[]> = {
  manager: [
    ...READ_UPDATE,
    ['read', 'ChatbotConversation'],
    ['read', 'CustomerPhone'],
  ],
  cashier: [...READ_UPDATE, ['read', 'ChatbotConversation']],
  conversationOnly: [['read', 'ChatbotConversation']],
  updateOnly: READ_UPDATE,
  readOnly: [['read', 'ChatbotRequest']],
};

@Injectable()
export class StubGuard implements CanActivate {
  constructor(private readonly cls: ClsService) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user: unknown;
      ability: AppAbility;
    }>();
    const tenantId = req.headers['x-test-tenant'];
    const userId = req.headers['x-test-user'];
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    for (const [action, subject] of STUB_ROLES[req.headers['x-test-role']] ??
      [])
      can(action, subject);
    req.user = { userId, tenantId, isSuperAdmin: false };
    req.ability = build();
    this.cls.set('tenantId', tenantId);
    this.cls.set('userId', userId);
    return true;
  }
}

@Injectable()
export class StubPermissionsGuard extends StubGuard {
  constructor(
    cls: ClsService,
    private readonly reflector: Reflector,
  ) {
    super(cls);
  }
  override canActivate(context: ExecutionContext): boolean {
    super.canActivate(context);
    const required = this.reflector.get<Array<[AppActions, AppSubjects]>>(
      PERMISSIONS_KEY,
      context.getHandler(),
    );
    const { ability } = context
      .switchToHttp()
      .getRequest<{ ability: AppAbility }>();
    for (const [action, subject] of required ?? []) {
      if (!ability.can(action, subject))
        throw new InsufficientPermissionsError();
    }
    return true;
  }
}
