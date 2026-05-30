import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface PublicTenantInfo {
  id: string;
  slug: string;
  name: string;
}

export const PublicTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PublicTenantInfo => {
    const request = ctx.switchToHttp().getRequest();
    return request.publicTenant;
  },
);
