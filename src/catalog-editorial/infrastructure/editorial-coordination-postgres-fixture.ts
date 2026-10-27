import { createHash } from 'node:crypto';

export interface EditorialSqlClient {
  $executeRaw(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number>;
  $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}
type Observer = Pick<EditorialSqlClient, '$queryRaw'>;
type Row = Record<string, unknown>;
function identity(key: string) {
  const id = (label: string) => {
    const h = createHash('sha256')
      .update(JSON.stringify([key, label]))
      .digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const ids = {
    userId: id('user'),
    tenantId: id('tenant'),
    foreignTenantId: id('foreign-tenant'),
    roleId: id('role'),
    readJoinId: id('read-join'),
    updateJoinId: id('update-join'),
    membershipId: id('membership'),
    productId: id('product'),
    foreignProductId: id('foreign-product'),
    variantId: id('variant'),
    globalPriceListId: id('global-price-list'),
    priceListId: id('price-list'),
    variantPriceId: id('variant-price'),
    assetId: id('asset'),
    unrelatedAssetId: id('unrelated-asset'),
    familyId: id('family'),
    definitionId: id('definition'),
  };
  const values = {
    email: `${ids.userId}@example.invalid`,
    sku: ids.productId.toUpperCase(),
    variantSku: ids.variantId.toUpperCase(),
    activeOptionCode: id('active-option'),
    archivedOptionCode: id('archived-option'),
    unrelatedOptionCode: id('unrelated-option'),
  };
  return { ids, values };
}
export type EditorialFixture = ReturnType<typeof identity> & {
  permissionIds: { read: string; update: string };
};

// Caller supplies an admitted client/transaction in the disposable migrated schema.
// Each key is single-use; only the two global permission rows are shared.
export async function seedEditorialPostgres(
  client: EditorialSqlClient,
  key: string,
): Promise<EditorialFixture> {
  const fixture = identity(key);
  const { ids: i, values: v } = fixture;
  for (const tenant of [i.tenantId, i.foreignTenantId])
    await client.$executeRaw`INSERT INTO "tenants" ("id", "name", "slug", "updatedAt")
      VALUES (${tenant}, ${tenant}, ${tenant}, CURRENT_TIMESTAMP)`;
  await client.$executeRaw`INSERT INTO "users" ("id", "email", "hashedPassword", "name", "updatedAt")
    VALUES (${i.userId}, ${v.email}, ${'not-a-login-hash'}, ${'Synthetic editorial user'}, CURRENT_TIMESTAMP)`;
  await client.$executeRaw`INSERT INTO "roles" ("id", "name", "tenantId", "updatedAt")
    VALUES (${i.roleId}, ${i.roleId}, ${i.tenantId}, CURRENT_TIMESTAMP)`;
  const permissionIds = { read: '', update: '' };
  for (const action of ['read', 'update'] as const) {
    const subject = 'ProductEditorialDraft';
    await client.$executeRaw`INSERT INTO "permissions" ("id", "subject", "action")
      VALUES (${`${i.roleId}-${action}`}, ${subject}, ${action}) ON CONFLICT ("subject", "action") DO NOTHING`;
    const rows = await client.$queryRaw<
      { id: string }[]
    >`SELECT "id" FROM "permissions"
      WHERE "subject" = ${subject} AND "action" = ${action}`;
    if (rows.length !== 1 || !rows[0].id)
      throw new Error('Editorial seed permission unavailable');
    permissionIds[action] = rows[0].id;
    await client.$executeRaw`INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
      VALUES (${action === 'read' ? i.readJoinId : i.updateJoinId}, ${i.roleId}, ${rows[0].id})`;
  }
  await client.$executeRaw`INSERT INTO "tenant_memberships" ("id", "userId", "tenantId", "roleId")
    VALUES (${i.membershipId}, ${i.userId}, ${i.tenantId}, ${i.roleId})`;
  for (const [product, tenant] of [
    [i.productId, i.tenantId],
    [i.foreignProductId, i.foreignTenantId],
  ])
    await client.$executeRaw`INSERT INTO "products" ("id", "tenantId", "name", "sku", "hasVariants", "updatedAt")
      VALUES (${product}, ${tenant}, ${product}, ${product.toUpperCase()}, ${product === i.productId}, CURRENT_TIMESTAMP)`;
  await client.$executeRaw`INSERT INTO "variants" ("id", "tenantId", "productId", "name", "sku", "quantity", "updatedAt")
    VALUES (${i.variantId}, ${i.tenantId}, ${i.productId}, ${i.variantId}, ${v.variantSku}, ${10}, CURRENT_TIMESTAMP)`;
  await client.$executeRaw`INSERT INTO "global_price_lists" ("id", "name", "updatedAt")
    VALUES (${i.globalPriceListId}, ${i.globalPriceListId}, CURRENT_TIMESTAMP)`;
  await client.$executeRaw`INSERT INTO "price_lists" ("id", "tenantId", "productId", "globalPriceListId", "priceCents", "updatedAt")
    VALUES (${i.priceListId}, ${i.tenantId}, ${i.productId}, ${i.globalPriceListId}, ${1234}, CURRENT_TIMESTAMP)`;
  await client.$executeRaw`INSERT INTO "variant_prices" ("id", "tenantId", "variantId", "priceListId", "priceCents")
    VALUES (${i.variantPriceId}, ${i.tenantId}, ${i.variantId}, ${i.priceListId}, ${1234})`;
  for (const asset of [i.assetId, i.unrelatedAssetId])
    await client.$executeRaw`INSERT INTO "private_media_assets" ("id", "tenantId", "productId", "storageKey", "mimeType", "sizeBytes")
      VALUES (${asset}, ${i.tenantId}, ${i.productId}, ${`editorial-test/${asset}`}, ${'image/png'}, ${1})`;
  await client.$executeRaw`INSERT INTO "editorial_families" ("id", "code") VALUES (${i.familyId}, ${i.familyId})`;
  await client.$executeRaw`INSERT INTO "editorial_definitions" ("id", "code", "type") VALUES (${i.definitionId}, ${i.definitionId}, ${'single'})`;
  await client.$executeRaw`INSERT INTO "editorial_bindings" ("familyId", "definitionId", "owner") VALUES (${i.familyId}, ${i.definitionId}, ${'product'})`;
  for (const code of [
    v.activeOptionCode,
    v.archivedOptionCode,
    v.unrelatedOptionCode,
  ])
    await client.$executeRaw`INSERT INTO "editorial_options" ("definitionId", "definitionType", "code", "archivedAt")
      VALUES (${i.definitionId}, ${'single'}, ${code}, ${code === v.archivedOptionCode ? new Date('2020-01-01T00:00:00Z') : null})`;
  return { ...fixture, permissionIds };
}

export async function currentBackendPid(client: Observer): Promise<number> {
  const rows = await client.$queryRaw<
    { pid: number }[]
  >`SELECT pg_backend_pid() AS pid`;
  if (rows.length !== 1 || !Number.isInteger(rows[0].pid))
    throw new Error('Editorial backend observation failed');
  return rows[0].pid;
}
export async function waitForLockWait(
  client: Observer,
  pid: number,
  { timeoutMs = 5000, intervalMs = 25 } = {},
): Promise<number[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 5000 ||
      !Number.isInteger(intervalMs) ||
      intervalMs <= 0 ||
      intervalMs > 5000
    )
      throw new Error();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await Promise.race([
        client.$queryRaw<
          { blockers: number[] }[]
        >`SELECT pg_blocking_pids(pid) AS blockers
          FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock'`,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error()), deadline - Date.now());
        }),
      ]);
      clearTimeout(timer);
      if (rows[0]?.blockers.length) return [...rows[0].blockers];
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, Math.min(intervalMs, deadline - Date.now())),
        ),
      );
    }
    throw new Error();
  } catch {
    throw new Error('Editorial lock observation failed');
  } finally {
    clearTimeout(timer);
  }
}
export async function readEditorialRows(
  client: Observer,
  tenantId: string,
  productId: string,
) {
  const states = await client.$queryRaw<
    Row[]
  >`SELECT * FROM "catalog_editorial_states"
    WHERE "tenantId" = ${tenantId} AND "productId" = ${productId}`;
  const createReceipts = await client.$queryRaw<
    Row[]
  >`SELECT * FROM "catalog_editorial_create_receipts"
    WHERE "tenantId" = ${tenantId} AND "productId" = ${productId} ORDER BY "actorId", "idempotencyKey"`;
  const saveReceipts = await client.$queryRaw<
    Row[]
  >`SELECT * FROM "catalog_editorial_save_receipts"
    WHERE "tenantId" = ${tenantId} AND "productId" = ${productId} ORDER BY "actorId", "idempotencyKey"`;
  return { states, createReceipts, saveReceipts };
}
export async function readVariantMembership(
  client: Observer,
  tenantId: string,
  productId: string,
) {
  const products = await client.$queryRaw<
    {
      id: string;
      hasVariants: boolean;
      useStock: boolean;
      useLotsAndExpirations: boolean;
      quantity: number;
      minQuantity: number;
    }[]
  >`
    SELECT "id", "hasVariants", "useStock", "useLotsAndExpirations", "quantity", "minQuantity"
    FROM "products" WHERE "tenantId" = ${tenantId} AND "id" = ${productId}`;
  const variants = await client.$queryRaw<
    { id: string; quantity: number; minQuantity: number }[]
  >`
    SELECT "id", "quantity", "minQuantity" FROM "variants"
    WHERE "tenantId" = ${tenantId} AND "productId" = ${productId} ORDER BY "id"`;
  return { products, variants };
}
export async function readVariantPrices(
  client: Observer,
  tenantId: string,
  variantId: string,
) {
  return client.$queryRaw<
    { id: string; priceListId: string; priceCents: number }[]
  >`
    SELECT "id", "priceListId", "priceCents" FROM "variant_prices"
    WHERE "tenantId" = ${tenantId} AND "variantId" = ${variantId} ORDER BY "id"`;
}
