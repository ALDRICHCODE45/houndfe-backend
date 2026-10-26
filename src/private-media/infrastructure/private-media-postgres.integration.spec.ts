import { withPrivateMediaTestDatabase } from './private-media-postgres-runner';
test('two sessions see committed fixtures, rollback, and exact owned-schema cleanup', async () => {
  const removed: string[] = [];
  await withPrivateMediaTestDatabase(async ({ first, second, schema }) => {
    removed.push(schema);
    const identity =
      'SELECT pg_backend_pid() AS pid, current_schema() AS schema';
    const [a] =
      await first.$queryRawUnsafe<{ pid: number; schema: string }[]>(identity);
    const [b] =
      await second.$queryRawUnsafe<{ pid: number; schema: string }[]>(identity);
    expect(a.pid).not.toBe(b.pid);
    expect([a.schema, b.schema]).toEqual([schema, schema]);
    await first.$executeRaw`CREATE TABLE fixture (value TEXT NOT NULL)`;
    await first.$executeRaw`INSERT INTO fixture VALUES ('committed-synthetic')`;
    expect(await second.$queryRaw`SELECT value FROM fixture`).toEqual([
      { value: 'committed-synthetic' },
    ]);
    await expect(
      first.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO fixture VALUES ('rolled-back-synthetic')`;
        throw new Error('synthetic rollback');
      }),
    ).rejects.toThrow('synthetic rollback');
    expect(await second.$queryRaw`SELECT value FROM fixture`).toEqual([
      { value: 'committed-synthetic' },
    ]);
  });
  await expect(
    withPrivateMediaTestDatabase(({ schema }) => {
      removed.push(schema);
      return Promise.reject(new Error('synthetic callback failure'));
    }),
  ).rejects.toThrow('synthetic callback failure');
  await withPrivateMediaTestDatabase(async ({ first, schema }) => {
    expect(removed).not.toContain(schema);
    for (const name of removed) {
      const rows = await first.$queryRawUnsafe(
        'SELECT nspname FROM pg_namespace WHERE nspname = $1',
        name,
      );
      expect(rows).toEqual([]);
    }
  });
});
