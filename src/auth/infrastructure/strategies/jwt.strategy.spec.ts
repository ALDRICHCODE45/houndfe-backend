import type { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import type { JwtTokenPayload } from '../../interfaces/jwt-payload.interface';

describe('JwtStrategy', () => {
  const createStrategy = () => {
    const configService = {
      getOrThrow: jest.fn().mockReturnValue('test-jwt-secret-32-characters-long'),
    } as unknown as ConfigService;

    return new JwtStrategy(configService);
  };

  it('returns authenticated user with tenant and super-admin claims', () => {
    const strategy = createStrategy();
    const payload: JwtTokenPayload = {
      sub: 'user-1',
      email: 'john@example.com',
      tenantId: 'tenant-1',
      tenantSlug: 'centro',
      isSuperAdmin: false,
    };

    expect(strategy.validate(payload)).toEqual({
      userId: 'user-1',
      email: 'john@example.com',
      tenantId: 'tenant-1',
      tenantSlug: 'centro',
      isSuperAdmin: false,
    });
  });

  it('keeps null tenant context for global super-admin', () => {
    const strategy = createStrategy();
    const payload: JwtTokenPayload = {
      sub: 'user-2',
      email: 'super-admin@example.com',
      tenantId: null,
      tenantSlug: null,
      isSuperAdmin: true,
    };

    expect(strategy.validate(payload)).toEqual({
      userId: 'user-2',
      email: 'super-admin@example.com',
      tenantId: null,
      tenantSlug: null,
      isSuperAdmin: true,
    });
  });
});
