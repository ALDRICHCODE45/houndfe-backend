import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('/orders retirement (O1 / S9)', () => {
  it('removes the orders module, its routes and its listener', () => {
    expect(existsSync(join(root, 'src/orders'))).toBe(false);
    const appModule = read('src/app.module.ts');
    expect(appModule).not.toMatch(/\bOrdersModule\b|from .\.\/orders\//);
  });

  it('keeps the Order model and table (no destructive migration)', () => {
    expect(read('prisma/schema.prisma')).toMatch(/model Order \{/);
    expect(read('prisma/schema.prisma')).toMatch(/model OrderItem \{/);
  });
});
