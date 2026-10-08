/**
 * cash-register-closing / T3 — facade-independent transaction test harness.
 *
 * Extracted verbatim from `prisma-cash-register.spec.ts` (T3 security
 * correction) so the new `prisma-cash-register.security.spec.ts` exercises the
 * SAME in-memory fake `TenantPrismaService` (rollback-aware transaction state
 * and real CASL abilities) instead of duplicating it. There is no PostgreSQL
 * roundtrip here; mock/unit tests do not prove PG races. The parent's T6
 * isolated-database proof is still required for that.
 */
/* eslint-disable @typescript-eslint/require-await -- Async DB fakes intentionally turn synchronous failures into rejected promises, matching Prisma. */
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { randomUUID } from 'crypto';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { CashActor } from '../cash-application.port';

// ── Fake transaction state ──────────────────────────────────────────────

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

interface FakeDb {
  registers: Row[];
  sessions: Row[];
  movements: Row[];
  counts: Row[];
  handovers: Row[];
  closings: Row[];
  commands: Row[];
  users: Row[];
  memberships: Row[];
}

export interface Host {
  db: FakeDb;
  depth: number;
  tenantId: string;
}

function emptyDb(): FakeDb {
  return {
    registers: [],
    sessions: [],
    movements: [],
    counts: [],
    handovers: [],
    closings: [],
    commands: [],
    users: [],
    memberships: [],
  };
}

// DB rows contain scalar Dates and JSON fields. Reconstruct Date columns in
// Jest's realm: Node structuredClone otherwise returns foreign-realm Dates
// after rollback, unlike Prisma, and domain instanceof Date guards reject them.
function cloneDb(db: FakeDb): FakeDb {
  const copy = emptyDb();
  for (const table of Object.keys(copy) as Array<keyof FakeDb>) {
    copy[table] = db[table].map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          value instanceof Date
            ? new Date(value.getTime())
            : structuredClone(value),
        ]),
      ),
    );
  }
  return copy;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTime(value: unknown): number {
  return value instanceof Date
    ? value.getTime()
    : new Date(String(value)).getTime();
}

function matchCond(value: unknown, cond: unknown): boolean {
  if (isObj(cond)) {
    if ('in' in cond) {
      return (cond.in as unknown[]).includes(value);
    }
    if ('not' in cond) {
      return cond.not === null
        ? value !== null && value !== undefined
        : value !== cond.not;
    }
    if ('gte' in cond) {
      return toTime(value) >= toTime(cond.gte);
    }
    if ('lt' in cond) {
      return toTime(value) < toTime(cond.lt);
    }
    throw new Error(`unsupported where condition: ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

function matches(row: Row, where?: Where): boolean {
  if (!where) {
    return true;
  }
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') {
      return (cond as Where[]).every((entry) => matches(row, entry));
    }
    if (key === 'OR') {
      return (cond as Where[]).some((entry) => matches(row, entry));
    }
    return matchCond(row[key], cond);
  });
}

function sortRows(rows: Row[], orderBy?: Row): Row[] {
  if (!orderBy) {
    return rows;
  }
  const entries = Object.entries(orderBy);
  return [...rows].sort((left, right) => {
    for (const [key, direction] of entries) {
      const a = left[key];
      const b = right[key];
      let cmp: number;
      if (a instanceof Date && b instanceof Date) {
        cmp = a.getTime() - b.getTime();
      } else if (typeof a === 'number' && typeof b === 'number') {
        cmp = a - b;
      } else {
        cmp = String(a).localeCompare(String(b));
      }
      if (cmp !== 0) {
        return direction === 'desc' ? -cmp : cmp;
      }
    }
    return 0;
  });
}

function delegate<K extends keyof FakeDb>(
  host: Host,
  key: K,
  defaults: () => Row,
) {
  const rows = (): Row[] => host.db[key];
  return {
    create: async ({ data }: { data: Row }): Promise<Row> => {
      const row = {
        ...defaults(),
        ...data,
        id: typeof data.id === 'string' ? data.id : randomUUID(),
      };
      rows().push(row);
      return row;
    },
    createMany: async ({
      data,
    }: {
      data: Row[];
    }): Promise<{ count: number }> => {
      for (const entry of data) {
        rows().push({ ...defaults(), ...entry, id: randomUUID() });
      }
      return { count: data.length };
    },
    findFirst: async (args: {
      where?: Where;
      orderBy?: Row;
    }): Promise<Row | null> =>
      sortRows(
        rows().filter((row) => matches(row, args.where)),
        args.orderBy,
      )[0] ?? null,
    findMany: async (args: {
      where?: Where;
      orderBy?: Row;
      skip?: number;
      take?: number;
    }): Promise<Row[]> => {
      let found = sortRows(
        rows().filter((row) => matches(row, args.where)),
        args.orderBy,
      );
      if (args.skip !== undefined) {
        found = found.slice(args.skip);
      }
      if (args.take !== undefined) {
        found = found.slice(0, args.take);
      }
      return found;
    },
    count: async (args: { where?: Where }): Promise<number> =>
      rows().filter((row) => matches(row, args.where)).length,
    update: async (args: { where: Where; data: Row }): Promise<Row> => {
      const row = rows().find((candidate) => candidate.id === args.where.id);
      if (!row) {
        throw new Error('fake record not found');
      }
      Object.assign(row, args.data);
      return row;
    },
  };
}

function sqlParts(arg: unknown): { text: string; values: unknown[] } {
  if (isObj(arg)) {
    const strings = arg.strings;
    const values = arg.values;
    if (Array.isArray(strings)) {
      return {
        text: strings.join(''),
        values: Array.isArray(values) ? (values as unknown[]) : [],
      };
    }
  }
  if (Array.isArray(arg)) {
    return { text: arg.join(''), values: [] };
  }
  return { text: '', values: [] };
}

function makeClient(host: Host) {
  return {
    cashRegister: delegate(host, 'registers', () => ({
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    cashSession: delegate(host, 'sessions', () => ({
      status: 'OPEN',
      openedAt: new Date(),
      frozenAt: null,
      submittedAt: null,
      closedAt: null,
      drawerReleasedAt: null,
      openingHandoverId: null,
      expectedJson: null,
    })),
    cashMovement: delegate(host, 'movements', () => ({
      createdAt: new Date(),
    })),
    cashCount: delegate(host, 'counts', () => ({
      revision: 1,
      denominationsJson: null,
      notes: null,
      createdAt: new Date(),
    })),
    cashHandover: delegate(host, 'handovers', () => ({
      receivedCents: null,
      notes: null,
      receiptNotes: null,
      receivedAt: null,
      receivedByUserId: null,
      createdAt: new Date(),
    })),
    cashClosing: delegate(host, 'closings', () => ({ createdAt: new Date() })),
    cashCommand: delegate(host, 'commands', () => ({ createdAt: new Date() })),
    user: delegate(host, 'users', () => ({ isActive: true })),
    tenantMembership: delegate(host, 'memberships', () => ({
      createdAt: new Date(),
    })),
    $queryRaw: async (arg: unknown): Promise<Row[]> => {
      const { text, values } = sqlParts(arg);
      if (text.includes('pg_advisory_xact_lock')) {
        return [{ locked: true }];
      }
      const tenantId = values[0];
      const id = values[1];
      const tableFor = (table: keyof FakeDb): Row[] => host.db[table];
      const source =
        text.includes('"cash_registers"') && text.includes('FOR UPDATE')
          ? tableFor('registers')
          : text.includes('"cash_sessions"') && text.includes('FOR UPDATE')
            ? tableFor('sessions')
            : text.includes('"cash_handovers"') && text.includes('FOR UPDATE')
              ? tableFor('handovers')
              : null;
      if (!source) {
        return [];
      }
      return source
        .filter((row) => row.id === id && row.tenantId === tenantId)
        .map((row) => ({ id: row.id }));
    },
  };
}

export function makeTenantHarness() {
  const host: Host = { db: emptyDb(), depth: 0, tenantId: 'tenant-a' };
  const client = makeClient(host);
  const tenantPrisma = {
    getTenantId: () => host.tenantId,
    isInTransaction: () => host.depth > 0,
    getClient: () => client,
    runInTransaction: async <T>(work: () => Promise<T>): Promise<T> => {
      const backup = cloneDb(host.db);
      host.depth += 1;
      try {
        return await work();
      } catch (error) {
        host.db = backup;
        throw error;
      } finally {
        host.depth -= 1;
      }
    },
  };
  return {
    host,
    // SAFETY: this fake implements the tenant/transaction/client methods used
    // by cash operations; unrelated TenantPrismaService members are not called.
    tenantPrisma: tenantPrisma as unknown as TenantPrismaService,
  };
}

// ── Ability / actor helpers ─────────────────────────────────────────────

const ALL_CASH: ReadonlyArray<readonly [AppActions, AppSubjects]> = [
  ['create', 'CashRegister'],
  ['read', 'CashRegister'],
  ['update', 'CashRegister'],
  ['create', 'CashSession'],
  ['read', 'CashSession'],
  ['create', 'CashCount'],
  ['create', 'CashIn'],
  ['create', 'CashOut'],
  ['create', 'CashVerification'],
  ['create', 'CashHandover'],
  ['update', 'CashHandover'],
  ['create', 'CashClosing'],
  ['read', 'CashClosing'],
  ['read', 'CashSessionAudit'],
];

function ability(
  permissions: ReadonlyArray<readonly [AppActions, AppSubjects]> = ALL_CASH,
): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  for (const [action, subject] of permissions) {
    can(action, subject);
  }
  return build();
}

function seedMember(host: Host, userId: string): void {
  host.db.users.push({
    id: userId,
    name: `Name ${userId}`,
    email: `${userId}@example.test`,
    hashedPassword: 'x',
    isActive: true,
  });
  host.db.memberships.push({
    id: `m-${userId}`,
    userId,
    tenantId: host.tenantId,
    roleId: 'role-1',
  });
}

export function actor(
  userId: string,
  permissions?: ReadonlyArray<readonly [AppActions, AppSubjects]>,
): CashActor {
  return { userId, ability: ability(permissions) };
}

export const asJson = (value: unknown): Record<string, unknown> =>
  (value ?? {}) as Record<string, unknown>;

export const asItems = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

export function seedActors(host: Host, ids: readonly string[]): void {
  for (const id of ids) {
    seedMember(host, id);
  }
}
