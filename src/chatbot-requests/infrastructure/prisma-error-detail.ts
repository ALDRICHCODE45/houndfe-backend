/**
 * A log-safe description of a failure (unit 14, A5). For a Prisma error it is
 * the error name, the Prisma code and the constraint target (column names, the
 * model or the foreign-key field): enough to tell a unique violation from a
 * timeout without a debugger. Never the message and never the rest of `meta`:
 * both can carry the customer's phone or text values.
 */
export function describePrismaError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const { code, meta } = error as {
    code?: unknown;
    meta?: Record<string, unknown>;
  };
  if (typeof code !== 'string') return error.name;
  const target = targetOf(meta);
  return `${error.name} code=${code}${target ? ` target=${target}` : ''}`;
}

function targetOf(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  for (const key of ['target', 'field_name', 'modelName']) {
    const value = meta[key];
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      return value.join(',');
    }
    if (typeof value === 'string') return value;
  }
  return null;
}
