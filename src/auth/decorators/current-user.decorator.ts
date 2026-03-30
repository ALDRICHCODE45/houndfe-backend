/**
 * CurrentUser Decorator - Extracts authenticated user from request.
 *
 * Use with @CurrentUser() in route handlers to get the user
 * payload set by JwtStrategy.validate().
 *
 * @example
 *   @Get('me')
 *   @UseGuards(JwtAuthGuard)
 *   getProfile(@CurrentUser() user: AuthenticatedUser) {
 *     return this.authService.getProfile(user.userId);
 *   }
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import type { AuthenticatedUser } from '../interfaces/jwt-payload.interface';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.user as AuthenticatedUser;
  },
);
