import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  constructEditorialPostgresClient,
  type PinnedPostgresTarget,
  type PostgresBinding,
} from './editorial-coordination-postgres-harness';

export interface BindingFile {
  stat(): Promise<Stats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export interface BindingLoaderDependencies {
  env: (name: 'EDITORIAL_COORDINATION_PG_BINDING') => string | undefined;
  lstat: (path: string) => Promise<Stats>;
  realpath: (path: string) => Promise<string>;
  open: (path: string, flags: number) => Promise<BindingFile>;
  uid: () => number | undefined;
  repoRoot: string;
  construct: (
    binding: PostgresBinding,
    pinned: PinnedPostgresTarget,
  ) => Promise<PrismaClient>;
}
const denied = () => new Error('Editorial PostgreSQL binding denied');
const defaults: BindingLoaderDependencies = {
  env: (name) => process.env[name],
  lstat,
  realpath,
  open,
  uid: () => process.getuid?.(),
  repoRoot: resolve(__dirname, '../../..'),
  construct: constructEditorialPostgresClient,
};
function checkFile(stat: Stats, uid: number | undefined): void {
  if (
    !Number.isInteger(uid) ||
    !stat.isFile() ||
    stat.uid !== uid ||
    (stat.mode & 0o7777) !== 0o600 ||
    stat.size < 0 ||
    stat.size > 4096
  )
    throw denied();
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// This seam is for offline tests; live callers use the guarded U5a constructor.
export async function loadEditorialPostgresClient(
  dependencies: Partial<BindingLoaderDependencies> = {},
): Promise<PrismaClient> {
  try {
    const d = { ...defaults, ...dependencies };
    const path = d.env('EDITORIAL_COORDINATION_PG_BINDING');
    if (!path || !isAbsolute(path)) throw denied();
    const uid = d.uid();
    const original = await d.lstat(path);
    checkFile(original, uid);
    const root = await d.realpath(d.repoRoot);
    const canonical = await d.realpath(path);
    const location = relative(root, canonical);
    if (
      !location ||
      (!isAbsolute(location) &&
        location !== '..' &&
        !location.startsWith(`..${sep}`))
    )
      throw denied();
    const file = await d.open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let text: string;
    try {
      const observed = await file.stat();
      checkFile(observed, uid);
      if (observed.dev !== original.dev || observed.ino !== original.ino)
        throw denied();
      // One extra byte detects growth without an unbounded readFile allocation.
      const buffer = Buffer.alloc(4097);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          size,
          buffer.length - size,
          size,
        );
        if (!bytesRead) break;
        size += bytesRead;
      }
      const final = await file.stat();
      checkFile(final, uid);
      if (size > 4096 || size !== observed.size || size !== final.size)
        throw denied();
      text = buffer.subarray(0, size).toString('utf8');
    } finally {
      await file.close();
    }
    const parsed: unknown = JSON.parse(text);
    if (
      !object(parsed) ||
      Object.keys(parsed).length !== 2 ||
      !Object.hasOwn(parsed, 'binding') ||
      !Object.hasOwn(parsed, 'pinned') ||
      !object(parsed.binding) ||
      !object(parsed.pinned)
    )
      throw denied();
    // U5a owns all nested shape, identity and generated-client admission checks.
    return await d.construct(
      // SAFETY: U5a validates this record before effects; the cast is not admission.
      parsed.binding as unknown as PostgresBinding,
      // SAFETY: U5a likewise validates the pin before any client/source effects.
      parsed.pinned as unknown as PinnedPostgresTarget,
    );
  } catch {
    throw denied();
  }
}
