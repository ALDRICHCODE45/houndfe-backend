import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../../auth/auth.module';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { SupplierCommands } from './supplier-commands';
import { SupplierQueries } from './supplier-queries';
import { SupplierCursor } from './supplier-cursor';
import { SuppliersController } from './suppliers.controller';

@Module({
  imports: [AuthModule, DatabaseModule, ConfigModule],
  controllers: [SuppliersController],
  providers: [
    SupplierCommands,
    SupplierQueries,
    SupplierCursor,
    TenantContextGuard,
  ],
})
export class SuppliersModule {}
