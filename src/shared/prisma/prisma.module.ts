/**
 * DatabaseModule - Global module that provides PrismaService.
 *
 * Marked as @Global() so any module can inject PrismaService
 * without explicitly importing this module.
 */
import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { PrismaService } from './prisma.service';
import { TenantPrismaService } from './tenant-prisma.service';

@Global()
@Module({
  imports: [ClsModule],
  providers: [PrismaService, TenantPrismaService],
  exports: [PrismaService, TenantPrismaService],
})
export class DatabaseModule {}
