import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule } from '../../auth/auth.module';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PurchaseOrderCommands } from './po-commands';
import { PurchaseOrderQueries } from './po-queries';
import { PurchaseOrderCursor } from './po-cursor';
import { PurchaseOrdersController } from './purchase-orders.controller';

@Module({
  imports: [AuthModule, DatabaseModule, ConfigModule],
  controllers: [PurchaseOrdersController],
  providers: [
    PurchaseOrderCommands,
    PurchaseOrderQueries,
    {
      provide: PurchaseOrderCursor,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new PurchaseOrderCursor(config.getOrThrow<string>('JWT_SECRET')),
    },
    TenantContextGuard,
  ],
})
export class PurchaseOrdersModule {}
