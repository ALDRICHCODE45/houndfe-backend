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
import { SuppliersModule } from './suppliers.module';
import { SuppliersController } from './suppliers.controller';
import { SupplierCommands } from './supplier-commands';
import { SupplierQueries } from './supplier-queries';
import { SupplierCursor } from './supplier-cursor';

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

describe('supplier module/controller composition', () => {
  it('resolves feature providers through normal Auth/Database/Config imports without runtime access', async () => {
    const module = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true }), SuppliersModule],
    })
      .overrideModule(AuthModule)
      .useModule(OfflineAuthModule)
      .overrideModule(DatabaseModule)
      .useModule(OfflineDatabaseModule)
      .overrideProvider(ConfigService)
      .useValue(new ConfigService({ JWT_SECRET: 'offline-only' }))
      .compile();
    try {
      expect(module.get(SuppliersController)).toBeInstanceOf(
        SuppliersController,
      );
      expect(module.get(SupplierCommands)).toBeInstanceOf(SupplierCommands);
      expect(module.get(SupplierQueries)).toBeInstanceOf(SupplierQueries);
      expect(module.get(SupplierCursor)).toBeInstanceOf(SupplierCursor);
      const imports: unknown[] = Reflect.getMetadata(
        'imports',
        SuppliersModule,
      ) as unknown[];
      expect(imports).toEqual(
        expect.arrayContaining([AuthModule, DatabaseModule, ConfigModule]),
      );
    } finally {
      await module.close();
    }
  });
  it('registers the feature and early parser in production composition, after CORS and before listen', () => {
    const root = readFileSync(join(__dirname, '../../app.module.ts'), 'utf8');
    expect(root).toContain('    SuppliersModule,');
    const main = readFileSync(join(__dirname, '../../main.ts'), 'utf8');
    const call = main.indexOf('  installSupplierBodyParser(app);');
    expect(call).toBeGreaterThan(main.lastIndexOf('app.enableCors('));
    expect(call).toBeLessThan(main.indexOf('await app.listen('));
  });
  it('passes the exact observed raw header including whitespace, not normalized headers lookup', async () => {
    const body = { displayName: 'Supplier', termsText: null, status: 'ACTIVE' };
    const create = jest.fn().mockResolvedValue({ statusCode: 201, body });
    const controller = new SuppliersController(
      { create } as unknown as SupplierCommands,
      {} as SupplierQueries,
    );
    const request = {
      query: {},
      body,
      rawHeaders: ['iDeMpOtEnCy-KeY', ' \tOpaque,Key\t '],
      headers: { 'idempotency-key': 'WRONG joined value' },
    } as unknown as Request;
    const status = jest.fn();
    expect(
      await controller.create(request, { status } as unknown as Response),
    ).toEqual(body);
    expect(create).toHaveBeenCalledWith(' \tOpaque,Key\t ', body);
    expect(status).toHaveBeenCalledWith(201);
  });
});
