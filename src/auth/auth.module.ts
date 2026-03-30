/**
 * AuthModule - NestJS module for the Auth bounded context.
 *
 * This is where Dependency Inversion happens:
 * - Domain defines IUserRepository (port)
 * - We register PrismaUserRepository (adapter)
 * - NestJS injects the adapter when the port is requested
 *
 * Exports AuthService and JwtAuthGuard so other modules can use them.
 */
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import type ms from 'ms';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './infrastructure/strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PrismaUserRepository } from './infrastructure/prisma-user.repository';
import { USER_REPOSITORY } from './domain/user.repository';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { CaslAbilityFactory } from './authorization/casl-ability.factory';
import { PermissionsGuard } from './authorization/guards/permissions.guard';
import { PermissionSeeder } from './authorization/infrastructure/permission.seeder';
import { PrismaRoleRepository } from './authorization/infrastructure/prisma-role.repository';
import { ROLE_REPOSITORY } from './authorization/domain/role.repository';
import { PrismaPermissionRepository } from './authorization/infrastructure/prisma-permission.repository';
import { PERMISSION_REPOSITORY } from './authorization/domain/permission.repository';

@Module({
  imports: [
    DatabaseModule, // Provides PrismaService
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: config.get<ms.StringValue>('JWT_ACCESS_EXPIRATION', '15m'),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtAuthGuard,
    {
      provide: USER_REPOSITORY,
      useClass: PrismaUserRepository,
    },
    CaslAbilityFactory,
    PermissionsGuard,
    PermissionSeeder,
    {
      provide: ROLE_REPOSITORY,
      useClass: PrismaRoleRepository,
    },
    {
      provide: PERMISSION_REPOSITORY,
      useClass: PrismaPermissionRepository,
    },
  ],
  exports: [
    AuthService,
    JwtAuthGuard,
    CaslAbilityFactory,
    PermissionsGuard,
    USER_REPOSITORY,
    ROLE_REPOSITORY,
    PERMISSION_REPOSITORY,
  ],
})
export class AuthModule {}
