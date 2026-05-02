/**
 * JwtPayload - Shape of the JWT token payload.
 *
 * Created by JwtStrategy.validate() and attached to request.user.
 * Used by @CurrentUser() decorator to extract typed user info.
 *
 * WHY centralized: Avoids inline { userId: string; email: string }
 * repeated across controller, decorator, and strategy.
 */

/** Raw payload inside the JWT token (standard claims). */
export interface JwtTokenPayload {
  sub: string;
  email: string;
  tenantId: string | null;
  tenantSlug: string | null;
  isSuperAdmin: boolean;
  iat?: number;
  exp?: number;
}

/**
 * Validated user payload attached to request.user by JwtStrategy.
 * This is what @CurrentUser() returns to route handlers.
 */
export interface AuthenticatedUser {
  userId: string;
  email: string;
  tenantId: string | null;
  tenantSlug: string | null;
  isSuperAdmin: boolean;
}
