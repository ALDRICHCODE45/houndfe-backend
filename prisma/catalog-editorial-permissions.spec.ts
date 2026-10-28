import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { PERMISSION_REGISTRY } from '../src/auth/authorization/domain/permission';
import { isEditorialPermission } from '../src/catalog-editorial/domain/editorial-permissions';

it('standalone seed excludes only exact editorial autogrants, preserving existing links', async () => {
  // Execute only the grant loop, never import/launch the side-effectful seed main.
  const source = readFileSync(join(__dirname, 'seed.ts'), 'utf8');
  const ast = ts.createSourceFile('seed.ts', source, ts.ScriptTarget.Latest, true);
  const loops: ts.ForOfStatement[] = [];
  const definitionLoops: ts.ForOfStatement[] = [];
  const roleLists: ts.VariableDeclaration[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isForOfStatement(node) &&
      node.expression.getText(ast) === 'allPermissionDefinitions'
    ) {
      definitionLoops.push(node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ['managerPermissionKeys', 'cashierPermissionKeys'].includes(
        node.name.getText(ast),
      )
    ) {
      roleLists.push(node);
    }
    if (
      ts.isForOfStatement(node) &&
      node.expression.getText(ast) === 'permissions.values()'
    ) {
      loops.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(loops).toHaveLength(1);
  expect(definitionLoops).toHaveLength(1);
  expect(roleLists).toHaveLength(2);
  for (const list of roleLists) {
    expect(list.initializer!.getText(ast)).not.toContain('ProductEditorialDraft');
  }
  const definitions = ts.transpileModule(definitionLoops[0].getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2023 },
  }).outputText;
  const permissionUpsert = jest.fn(async ({ create }) => ({ ...create, id: 'id' }));
  const seedDefinitions = new Function(
    'tx', 'allPermissionDefinitions', 'permissions', 'permissionKey',
    `return (async () => { ${definitions} })();`,
  ) as (...args: unknown[]) => Promise<void>;
  await seedDefinitions(
    { permission: { upsert: permissionUpsert } },
    PERMISSION_REGISTRY,
    new Map(),
    (subject: string, action: string) => `${subject}:${action}`,
  );
  expect(permissionUpsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({
        subject: 'ProductEditorialDraft',
        action: 'publish',
      }),
    }),
  );
  const loop = ts.transpileModule(loops[0].getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2023 },
  }).outputText;
  const inputs = [
    ...PERMISSION_REGISTRY,
    { subject: 'ProductEditorialDraft', action: 'manage' },
    { subject: 'FutureResource', action: 'update' },
  ].map((p, index) => ({ ...p, id: String(index) }));
  const existingPublishGrant = inputs.find(
    (p) => p.subject === 'ProductEditorialDraft' && p.action === 'publish',
  );
  expect(existingPublishGrant).toBeDefined();
  const links = new Set(['existing-editorial-grant']);
  const upsert = jest.fn((args: { create: { permissionId: string } }) => {
    links.add(args.create.permissionId);
  });
  const run = new Function(
    'tx', 'permissions', 'superAdminRole', 'isEditorialPermission',
    `return (async () => { ${loop} })();`,
  ) as (...args: unknown[]) => Promise<void>;
  await run(
    { rolePermission: { upsert } },
    new Map(inputs.map((p) => [p.id, p])),
    { id: 'super-admin' },
    isEditorialPermission,
  );
  const excluded = inputs.filter((p) => !links.has(p.id));
  expect(excluded.map(({ subject, action }) => ({ subject, action }))).toEqual([
    { subject: 'ProductEditorialDraft', action: 'read' },
    { subject: 'ProductEditorialDraft', action: 'update' },
    { subject: 'ProductEditorialDraft', action: 'publish' },
  ]);
  expect(upsert).toHaveBeenCalledTimes(inputs.length - 3);
  links.add(existingPublishGrant!.id);
  await run(
    { rolePermission: { upsert } },
    new Map(inputs.map((p) => [p.id, p])),
    { id: 'super-admin' },
    isEditorialPermission,
  );
  expect(links.has(existingPublishGrant!.id)).toBe(true);
  expect(links.has('existing-editorial-grant')).toBe(true);
  expect(
    source.includes(
      "import { isEditorialPermission } from '../src/catalog-editorial/domain/editorial-permissions'",
    ),
  ).toBe(true);
});
