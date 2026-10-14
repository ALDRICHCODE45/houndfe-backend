/** Test-only deterministic row digests; never exposes or persists row contents. */
export function buildSnapshotSql(): string {
  // \gexec executes the current query buffer. A preceding semicolon would
  // also print generated statements, polluting the digest-only output.
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT format('SELECT %L AS table_name, count(*)::text AS row_count, md5(coalesce(string_agg(row_json, chr(10) ORDER BY row_json COLLATE "C"), '''')) AS data_digest FROM (SELECT to_jsonb(t)::text AS row_json FROM %I.%I t) rows;', schemaname||'.'||tablename, schemaname, tablename) FROM pg_tables WHERE schemaname='public' ORDER BY tablename
\\gexec
ROLLBACK;
`;
}

export interface SnapshotTable {
  table: string;
  rowCount: number;
  digest: string;
}

export function parseSnapshotOutput(output: string): SnapshotTable[] {
  const rows = output.trim().split('\n');
  const seen = new Set<string>();
  return rows.map((row) => {
    const match = /^(public\.[a-zA-Z0-9_]+)\|(\d+)\|([a-f0-9]{32})$/.exec(row);
    if (!match || seen.has(match[1])) throw new Error('Invalid snapshot output');
    const rowCount = Number(match[2]);
    if (!Number.isSafeInteger(rowCount)) throw new Error('Invalid snapshot output');
    seen.add(match[1]);
    return { table: match[1], rowCount, digest: match[3] };
  }).sort((a, b) => a.table < b.table ? -1 : a.table > b.table ? 1 : 0);
}
