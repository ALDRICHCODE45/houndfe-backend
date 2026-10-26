import {
  db,
  scope,
  request,
  document,
  access,
  core,
  snapshot,
  rejectUnchanged,
  assertOptionLock,
} from './d16-create-fixture';

it.each(['old', 'missing'])(
  'legacy create rejects archived or missing option %s despite permissive port',
  async (code) => {
    await rejectUnchanged(
      () => core().create(scope, { ...request, document: document(code) }),
      'MALFORMED',
    );
  },
);
it('legacy active pairs work; replay cannot inject archived Draft or survive current archive', async () => {
  const input = { ...request, document: document('new') };
  const result = await core().create(scope, input);
  const before = await snapshot();
  expect(await core().create(scope, input)).toEqual(result);
  expect(await snapshot()).toEqual(before);
  await db.first
    .$executeRaw`UPDATE catalog_editorial_create_receipts SET result = jsonb_set(result, '{draft,document}', ${JSON.stringify(document())}::jsonb)`;
  await rejectUnchanged(() => core().create(scope, input), 'MALFORMED');
  await db.first
    .$executeRaw`UPDATE catalog_editorial_create_receipts SET result = ${JSON.stringify(result)}::jsonb`;
  await db.first
    .$executeRaw`UPDATE editorial_options SET "archivedAt" = now() WHERE code = 'new'`;
  await rejectUnchanged(() => core().create(scope, input), 'MALFORMED');
});
it('holds legacy active option locks through receipt insertion', async () => {
  await assertOptionLock('new', (client) =>
    core(access(), client).create(scope, {
      ...request,
      document: document('new'),
    }),
  );
});
