import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { AuthModule } from '../../auth/auth.module';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CaslAbilityFactory } from '../../auth/authorization/casl-ability.factory';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { PurchaseOrdersModule } from './purchase-orders.module';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrderCommands } from './po-commands';
import { PurchaseOrderQueries } from './po-queries';
import { PurchaseOrderCursor } from './po-cursor';

@Module({
  providers: [
    { provide: JwtAuthGuard, useValue: {} },
    { provide: CaslAbilityFactory, useValue: {} },
  ],
  exports: [JwtAuthGuard, CaslAbilityFactory],
})
class OfflineAuthModule {}
@Global()
@Module({
  providers: [{ provide: TenantPrismaService, useValue: {} }],
  exports: [TenantPrismaService],
})
class OfflineDatabaseModule {}

describe('PO composition', () => {
  it('resolves providers through normal imports without runtime access', async () => {
    const module = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true }), PurchaseOrdersModule],
    })
      .overrideModule(AuthModule)
      .useModule(OfflineAuthModule)
      .overrideModule(DatabaseModule)
      .useModule(OfflineDatabaseModule)
      .overrideProvider(ConfigService)
      .useValue(new ConfigService({ JWT_SECRET: 'offline-only' }))
      .compile();
    try {
      expect(module.get(PurchaseOrdersController)).toBeInstanceOf(
        PurchaseOrdersController,
      );
      expect(module.get(PurchaseOrderCommands)).toBeInstanceOf(
        PurchaseOrderCommands,
      );
      expect(module.get(PurchaseOrderQueries)).toBeInstanceOf(
        PurchaseOrderQueries,
      );
      expect(module.get(PurchaseOrderCursor)).toBeInstanceOf(
        PurchaseOrderCursor,
      );
      expect(Reflect.getMetadata('imports', PurchaseOrdersModule)).toEqual(
        expect.arrayContaining([AuthModule, DatabaseModule, ConfigModule]),
      );
    } finally {
      await module.close();
    }
  });
  it('registers feature and early parser after CORS and before listen', () => {
    const root = readFileSync(join(__dirname, '../../app.module.ts'), 'utf8');
    expect(root).toContain('    PurchaseOrdersModule,');
    const main = readFileSync(join(__dirname, '../../main.ts'), 'utf8');
    const call = main.indexOf('  installPurchaseOrderBodyParser(app);');
    expect(call).toBeGreaterThan(main.lastIndexOf('app.enableCors('));
    expect(call).toBeLessThan(main.indexOf('await app.listen('));
  });
  it('preserves raw key whitespace rather than using joined headers', async () => {
    const body = {
      supplierId: null,
      note: null,
      location: { detail: null },
      lines: [],
    };
    const createDraft = jest.fn().mockResolvedValue({ statusCode: 201, body });
    const controller = new PurchaseOrdersController(
      { createDraft } as unknown as PurchaseOrderCommands,
      {} as PurchaseOrderQueries,
    );
    const request = {
      query: {},
      body,
      rawHeaders: ['iDeMpOtEnCy-KeY', ' \tOpaque,Key\t '],
      headers: { 'idempotency-key': 'WRONG joined value' },
      is: () => 'application/json',
    } as unknown as Request;
    const status = jest.fn();
    expect(
      await controller.create(request, { status } as unknown as Response),
    ).toEqual(body);
    expect(createDraft).toHaveBeenCalledWith(' \tOpaque,Key\t ', body);
    expect(status).toHaveBeenCalledWith(201);
  });
});
