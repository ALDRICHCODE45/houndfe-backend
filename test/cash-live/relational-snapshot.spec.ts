import { buildSnapshotSql, parseSnapshotOutput } from './relational-snapshot';

describe('read-only relational snapshot', () => {
  it('executes generated queries without first printing their SQL', () => {
    const sql = buildSnapshotSql();
    expect(sql).toContain('REPEATABLE READ READ ONLY');
    expect(sql).toMatch(/ORDER BY tablename\n\\gexec/);
    expect(sql).not.toMatch(/ORDER BY tablename;\n\\gexec/);
    expect(sql).toContain('COLLATE "C"');
  });
  it('accepts sorted digest rows, never row contents', () => {
    expect(parseSnapshotOutput('public.users|3|' + 'a'.repeat(32))).toEqual([
      { table: 'public.users', rowCount: 3, digest: 'a'.repeat(32) },
    ]);
  });
  it.each(['', 'SELECT secret;', 'public.users|x|' + 'a'.repeat(32),
    'public.users|1|bad', 'public.users|1|' + 'a'.repeat(32) + '\npublic.users|1|' + 'a'.repeat(32)])('rejects malformed or duplicate output', (output) => {
    expect(() => parseSnapshotOutput(output)).toThrow('Invalid snapshot output');
  });
});
