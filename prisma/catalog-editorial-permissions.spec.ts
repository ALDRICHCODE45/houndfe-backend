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
  function visit(node: ts.Node) {
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
  const loop = ts.transpileModule(loops[0].getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2023 },
  }).outputText;
  const inputs = [
    ...PERMISSION_REGISTRY,
    { subject: 'ProductEditorialDraft', action: 'manage' },
    { subject: 'FutureResource', action: 'update' },
  ].map((p, index) => ({ ...p, id: String(index) }));
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
  ]);
  expect(upsert).toHaveBeenCalledTimes(inputs.length - 2);
  expect(links.has('existing-editorial-grant')).toBe(true);
  expect(
    source.includes(
      "import { isEditorialPermission } from '../src/catalog-editorial/domain/editorial-permissions'",
    ),
  ).toBe(true);
});
