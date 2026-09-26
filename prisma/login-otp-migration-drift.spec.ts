import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';

// File/DMMF-only: no PrismaClient, configuration loader, connection or migration.
const schema = readFileSync(join(__dirname, 'schema.prisma'), 'utf8');
const migration = readFileSync(
  join(__dirname, 'migrations/20260926183000_login_email_otp/migration.sql'),
  'utf8',
);

function model(name: string) {
  return Prisma.dmmf.datamodel.models.find((entry) => entry.name === name)!;
}

function block(name: string): string {
  return schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))![1];
}

describe('Login OTP schema/migration mapping', () => {
  it('maps the lock target and account FK to the existing TEXT user key', () => {
    expect(model('User').dbName).toBe('users');
    const id = model('User').fields.find((field) => field.name === 'id')!;
    expect(id.type).toBe('String');
    expect(block('User')).toMatch(/id\s+String\s+@id\s*\n/);
    expect(model('LoginOtpChallenge').dbName).toBe('login_otp_challenges');
    expect(model('LoginOtpChallenge').primaryKey).toBeNull();
    expect(
      model('LoginOtpChallenge').fields.find((field) => field.name === 'userId')
        ?.isId,
    ).toBe(true);
    expect(migration).toContain('"userId" TEXT NOT NULL');
    expect(migration).toContain('PRIMARY KEY ("userId")');
    expect(migration).toContain(
      'REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    );
    expect(block('LoginOtpChallenge')).toContain(
      '@relation(fields: [userId], references: [id], onDelete: Cascade)',
    );
  });

  it('matches every persisted challenge column and native type', () => {
    const columns: Record<string, string> = {
      userId: 'TEXT NOT NULL',
      generation: 'TEXT NOT NULL',
      handleHash: 'CHAR(64) NOT NULL',
      codeMac: 'CHAR(64) NOT NULL',
      state: '"LoginOtpState" NOT NULL DEFAULT \'PENDING\'',
      expiresAt: 'TIMESTAMP(3) NOT NULL',
      createdAt: 'TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
      updatedAt: 'TIMESTAMP(3) NOT NULL',
      consumedAt: 'TIMESTAMP(3)',
    };
    expect(
      model('LoginOtpChallenge')
        .fields.filter((field) => field.kind !== 'object')
        .map((field) => field.name)
        .sort(),
    ).toEqual(Object.keys(columns).sort());
    for (const [name, sqlType] of Object.entries(columns)) {
      expect(migration).toContain(`"${name}" ${sqlType}`);
      const field = model('LoginOtpChallenge').fields.find(
        (entry) => entry.name === name,
      );
      expect(field).toBeDefined();
      // Prisma DMMF versions omit dbName or expose null for unmapped columns.
      expect(field?.dbName ?? null).toBeNull();
    }
    for (const name of ['handleHash', 'codeMac'])
      expect(block('LoginOtpChallenge')).toMatch(
        new RegExp(`${name}[^\\n]+@db.Char\\(64\\)`),
      );
    for (const name of ['expiresAt', 'createdAt', 'updatedAt', 'consumedAt'])
      expect(block('LoginOtpChallenge')).toMatch(
        new RegExp(`${name}[^\\n]+@db.Timestamp\\(3\\)`),
      );
    expect(migration).toContain(
      "CREATE TYPE \"LoginOtpState\" AS ENUM ('PENDING', 'ACTIVE', 'CONSUMED', 'FAILED')",
    );
    expect(
      Prisma.dmmf.datamodel.enums
        .find((entry) => entry.name === 'LoginOtpState')
        ?.values.map((entry) => entry.name),
    ).toEqual(['PENDING', 'ACTIVE', 'CONSUMED', 'FAILED']);
  });

  it('matches unique/index definitions and independent durable buckets', () => {
    expect(block('LoginOtpChallenge')).toContain('@@index([expiresAt])');
    expect(block('LoginOtpChallenge')).toMatch(/handleHash[^\n]+@unique/);
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "login_otp_challenges_handleHash_key" ON "login_otp_challenges"("handleHash")',
    );
    expect(migration).toContain(
      'CREATE INDEX "login_otp_challenges_expiresAt_idx" ON "login_otp_challenges"("expiresAt")',
    );
    expect(model('AuthRateBucket').dbName).toBe('auth_rate_buckets');
    expect(block('AuthRateBucket')).not.toContain('@relation');
    expect(block('AuthRateBucket')).toMatch(
      /key\s+String\s+@id @db.Char\(64\)/,
    );
    expect(block('AuthRateBucket')).toMatch(/count\s+Int/);
    expect(block('AuthRateBucket')).toMatch(
      /windowStart\s+DateTime @db.Timestamp\(3\)/,
    );
    expect(migration).toContain('"key" CHAR(64) NOT NULL');
    expect(migration).toContain('"count" INTEGER NOT NULL');
    expect(migration).toContain('"windowStart" TIMESTAMP(3) NOT NULL');
    expect(migration).toContain('PRIMARY KEY ("key")');
    expect(block('AuthRateBucket')).toContain('@@index([windowStart])');
    expect(migration).toContain(
      'CREATE INDEX "auth_rate_buckets_windowStart_idx" ON "auth_rate_buckets"("windowStart")',
    );
  });
});
