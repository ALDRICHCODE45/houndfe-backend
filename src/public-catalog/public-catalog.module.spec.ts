/**
 * Public catalog v0 — the production module wires S4/S5/S6: the branch and
 * share controllers resolve with their real dependencies (including
 * PickupLocationService through ShippingPickupModule).
 */
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { PrismaService } from '../shared/prisma/prisma.service';
import { PublicBranchController } from './http/public-branch.controller';
import { SharePreviewController } from './http/share-preview.controller';
import { PublicCatalogController } from './http/public-catalog.controller';
import { PublicCatalogConfig } from './application/services/public-catalog-config';
import { PublicCatalogModule } from './public-catalog.module';

describe('PublicCatalogModule wiring', () => {
  it('resolves the branch and share controllers and the env-backed config', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_SECRET: 'x'.repeat(32),
              JWT_REFRESH_SECRET: 'y'.repeat(32),
              PUBLIC_BOT_WHATSAPP: '+5215500000000',
              PUBLIC_STORE_URL: 'https://sistem.houndfe.com/catalogo/',
            }),
          ],
        }),
        ClsModule.forRoot({ global: true }),
        DatabaseModule,
        PublicCatalogModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(PublicCatalogController)).toBeDefined();
    expect(moduleRef.get(PublicBranchController)).toBeDefined();
    expect(moduleRef.get(SharePreviewController)).toBeDefined();
    const config = moduleRef.get(PublicCatalogConfig);
    expect(config.botWhatsappNumber()).toBe('+5215500000000');
    expect(config.storeUrl()).toBe('https://sistem.houndfe.com/catalogo');
    await moduleRef.close();
  });
});
