/**
 * HD-05b2 — PrismaBotApplicationOutcomeRepository DB-free behavior spec.
 *
 * Mocks `TenantPrismaService` (`isInTransaction` / `getTenantId` / `getClient`
 * / `runInTransaction`) so no PostgreSQL roundtrip happens. These tests prove
 * the adapter seams: the ambient-transaction guard, the unconditional CLS
 * tenant resolution, the defensive runtime re-parse + canonical evidence hash,
 * the tenant/source/type-scoped state read, the RESOLVED/version=2 gate, the
 * half-open `[resolvedAt, resolvedAt + 1h)` time-window classification, the
 * one-terminal `updateMany` CAS (exact predicate + mapped evidence), the
 * recorded/replayed/conflict codes, and the value-free failures.
 *
 * A+D disclosure: these mocked tests do NOT prove real PostgreSQL row locking,
 * the `human_decisions_application_outcome_state` DB CHECK, or an actual
 * two-writer race. The "synthetic concurrent CAS" cases below simulate
 * `updateMany` `count` 1/0; they are seam proofs only. A dedicated PostgreSQL
 * integration slice owns the real one-winner/commit-semantics proof. The
 * adapter never touches a provider, device, stock or sale model, and the mock
 * client asserts that scope.
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  DELIVERY_UNKNOWN,
  hashBotApplicationOutcomeEvidence,
  parseBotApplicationOutcomeRequest,
  PROVIDER_ACCEPTED,
  PROVIDER_ACCEPTED_LATE,
  STALE,
  type BotApplicationOutcomeRequest,
} from '../domain/bot-application-outcome.request';
import {
  BotApplicationOutcomeError,
  type RecordBotApplicationOutcomeCommand,
} from '../domain/bot-application-outcome.repository';
import {
  RESTOCK_SOURCE,
  RESTOCK_TYPE,
} from '../domain/restock-request-canonicalizer';
import {
  APPLICATION_OUTCOME_STATE_SELECT,
  BOT_APPLICATION_OUTCOME_CLOCK,
  PrismaBotApplicationOutcomeRepository,
} from './prisma-bot-application-outcome.repository';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const DECISION_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '3f1c1b7a-9c2e-4d5f-8a6b-1c2d3e4f5a6b';
const OTHER_ATTEMPT_ID = '0192a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b';
const PROVIDER_MESSAGE_ID = 'wamid.HBgLMTIzNDU2Nzg5MA==';
const RESOLVED_AT = new Date('2026-06-15T12:00:00.000Z');
const DEADLINE_AT = '2026-06-15T13:00:00.000Z';
const ATTEMPTED_AT = '2026-06-15T12:00:00.000Z';
const ACCEPTED_OBSERVED_AT = '2026-06-15T12:00:04.500Z';
const LATE_ATTEMPTED_AT = '2026-06-15T12:59:59.000Z';
const LATE_ACCEPTED_OBSERVED_AT = '2026-06-15T13:05:00.000Z';
const FIXED_NOW = new Date('2026-09-03T12:00:00.000Z');
const PERSISTED_ACK_AT = new Date('2026-06-15T12:01:00.000Z');
const ACCEPTED_HASH =
  'cc7534e067b71d1fc099250b65cab69dd714f1ec7b8c389d8ab8974c7e836831';
const STALE_HASH =
  'b623f85e54953edac8a33a25f84c8fdbe9c7baae60bdb4fe3d05d550c99ed9f0';

/** Exact internal state SELECT allowlist (version/status/resolvedAt/terminal+ACK). */
const STATE_SELECT_KEYS = [
  'ackReceivedAt',
  'applicationAttemptId',
  'applicationEvidenceHash',
  'applicationOutcome',
  'id',
  'resolvedAt',
  'status',
  'version',
];

/** Authority/evidence columns the classification read must never widen into. */
const FORBIDDEN_SELECT_KEYS = [
  'applicationAttemptedAt',
  'applicationEvidenceCode',
  'branchId',
  'canonicalRequestHash',
  'createdAt',
  'productId',
  'productName',
  'providerMessageId',
  'providerAcceptedObservedAt',
  'resolutionAction',
  'resolutionRequestId',
  'resolvedByActorId',
  'resolvedByDisplayName',
  'resolvedById',
  'restockDays',
  'source',
  'sourceRequestId',
  'submittedCredentialId',
  'tenantId',
  'updatedAt',
];

/** Exact one-terminal CAS predicate keys. */
const CAS_WHERE_KEYS = [
  'applicationOutcome',
  'id',
  'source',
  'status',
  'tenantId',
  'type',
  'version',
];

/** Exact terminal write payload keys; never status/version/resolution. */
const OUTCOME_DATA_KEYS = [
  'ackReceivedAt',
  'applicationAttemptId',
  'applicationAttemptedAt',
  'applicationEvidenceCode',
  'applicationEvidenceHash',
  'applicationOutcome',
  'providerAcceptedObservedAt',
  'providerMessageId',
];

/** Exact five-key back-end acknowledgment. */
const ACK_KEYS = ['ackReceivedAt', 'attemptId', 'id', 'outcome', 'version'];

interface OutcomeStateRow {
  id: string;
  status: string;
  version: number;
  resolvedAt: Date | null;
  applicationOutcome: string | null;
  applicationAttemptId: string | null;
  applicationEvidenceHash: string | null;
  ackReceivedAt: Date | null;
}

interface ClientMock {
  humanDecision: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
  };
  sale: { updateMany: jest.Mock; update: jest.Mock; create: jest.Mock };
  product: { updateMany: jest.Mock; update: jest.Mock; create: jest.Mock };
  tenant: { update: jest.Mock; updateMany: jest.Mock };
  user: { update: jest.Mock; updateMany: jest.Mock };
}

interface CapturedFindFirst {
  where: Record<string, unknown>;
  select: Record<string, boolean>;
}

interface CapturedUpdateMany {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

interface RepoOptions {
  tenantId?: string | null;
  inTransaction?: boolean;
}

function makeClient(): ClientMock {
  return {
    humanDecision: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    sale: { updateMany: jest.fn(), update: jest.fn(), create: jest.fn() },
    product: { updateMany: jest.fn(), update: jest.fn(), create: jest.fn() },
    tenant: { update: jest.fn(), updateMany: jest.fn() },
    user: { update: jest.fn(), updateMany: jest.fn() },
  };
}

function makeRepo(client: ClientMock, options: RepoOptions = {}) {
  const tenantId =
    options.tenantId === undefined ? TENANT_ID : options.tenantId;
  const tenantPrisma = {
    isInTransaction: jest.fn(() => options.inTransaction === true),
    getTenantId: jest.fn(() => {
      if (!tenantId) {
        throw new Error('Tenant context required');
      }
      return tenantId;
    }),
    getClient: jest.fn(() => client),
    runInTransaction: jest.fn(
      async (work: () => Promise<unknown>): Promise<unknown> => work(),
    ),
  };
  const repo = new PrismaBotApplicationOutcomeRepository(
    tenantPrisma as unknown as TenantPrismaService,
    () => FIXED_NOW,
  );
  return { repo, tenantPrisma };
}

function findFirstArgs(client: ClientMock, call = 0): CapturedFindFirst {
  const calls = client.humanDecision.findFirst.mock.calls as Array<
    [CapturedFindFirst]
  >;
  return calls[call][0];
}

function updateManyArgs(client: ClientMock, call = 0): CapturedUpdateMany {
  const calls = client.humanDecision.updateMany.mock.calls as Array<
    [CapturedUpdateMany]
  >;
  return calls[call][0];
}

function acceptedBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptId: ATTEMPT_ID,
    attemptedAt: ATTEMPTED_AT,
    expectedResolutionVersion: 2,
    outcome: PROVIDER_ACCEPTED,
    providerAcceptedObservedAt: ACCEPTED_OBSERVED_AT,
    providerMessageId: PROVIDER_MESSAGE_ID,
    ...overrides,
  };
}

function lateBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptId: ATTEMPT_ID,
    attemptedAt: LATE_ATTEMPTED_AT,
    expectedResolutionVersion: 2,
    outcome: PROVIDER_ACCEPTED_LATE,
    providerAcceptedObservedAt: LATE_ACCEPTED_OBSERVED_AT,
    providerMessageId: PROVIDER_MESSAGE_ID,
    ...overrides,
  };
}

function unknownBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptId: ATTEMPT_ID,
    attemptedAt: ATTEMPTED_AT,
    expectedResolutionVersion: 2,
    outcome: DELIVERY_UNKNOWN,
    ...overrides,
  };
}

function staleBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptId: ATTEMPT_ID,
    expectedResolutionVersion: 2,
    outcome: STALE,
    ...overrides,
  };
}

/** Parse a body into the exact typed command input the transport would build. */
function parseRequest(
  body: Record<string, unknown>,
): BotApplicationOutcomeRequest {
  return parseBotApplicationOutcomeRequest(body);
}

function command(
  request: BotApplicationOutcomeRequest,
  decisionId = DECISION_ID,
): RecordBotApplicationOutcomeCommand {
  return { decisionId, request };
}

/** Raw JS typed as the command surface, exactly as a bypassing caller could. */
function rawCommand(
  request: unknown,
  decisionId = DECISION_ID,
): RecordBotApplicationOutcomeCommand {
  return {
    decisionId,
    request: request as BotApplicationOutcomeRequest,
  };
}

function resolvedRow(
  overrides: Partial<OutcomeStateRow> = {},
): OutcomeStateRow {
  return {
    id: DECISION_ID,
    status: 'RESOLVED',
    version: 2,
    resolvedAt: RESOLVED_AT,
    applicationOutcome: null,
    applicationAttemptId: null,
    applicationEvidenceHash: null,
    ackReceivedAt: null,
    ...overrides,
  };
}

function terminalRow(
  overrides: Partial<OutcomeStateRow> = {},
): OutcomeStateRow {
  return resolvedRow({
    applicationOutcome: PROVIDER_ACCEPTED,
    applicationAttemptId: ATTEMPT_ID,
    applicationEvidenceHash: ACCEPTED_HASH,
    ackReceivedAt: PERSISTED_ACK_AT,
    ...overrides,
  });
}

function acceptedAcknowledgment() {
  return {
    id: DECISION_ID,
    version: 2,
    attemptId: ATTEMPT_ID,
    outcome: PROVIDER_ACCEPTED,
    ackReceivedAt: PERSISTED_ACK_AT,
  };
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  return run().catch((caught: unknown) => caught);
}

function expectDomainError(error: unknown): BotApplicationOutcomeError {
  expect(error).toBeInstanceOf(BotApplicationOutcomeError);
  if (!(error instanceof BotApplicationOutcomeError)) {
    throw new Error('expected BotApplicationOutcomeError');
  }
  return error;
}

describe('PrismaBotApplicationOutcomeRepository', () => {
  describe('record — recorded one-terminal CAS', () => {
    it('records PROVIDER_ACCEPTED with the exact predicate, mapped evidence and a five-key version-2 acknowledgment', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(terminalRow({ ackReceivedAt: FIXED_NOW }));
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);
      const request = parseRequest(acceptedBody());

      const result = await repo.record(command(request));

      expect(result).toEqual({
        status: 'recorded',
        acknowledgment: {
          id: DECISION_ID,
          version: 2,
          attemptId: ATTEMPT_ID,
          outcome: PROVIDER_ACCEPTED,
          ackReceivedAt: FIXED_NOW,
        },
      });
      expect(Object.keys(result.acknowledgment).sort()).toEqual(ACK_KEYS);
      expect(result.acknowledgment.version).toBe(2);
      expect(client.humanDecision.updateMany).toHaveBeenCalledTimes(1);
      expect(updateManyArgs(client).where).toEqual({
        id: DECISION_ID,
        tenantId: TENANT_ID,
        source: RESTOCK_SOURCE,
        type: RESTOCK_TYPE,
        status: 'RESOLVED',
        version: 2,
        applicationOutcome: null,
      });
      expect(Object.keys(updateManyArgs(client).where).sort()).toEqual(
        CAS_WHERE_KEYS,
      );
      expect(updateManyArgs(client).data).toEqual({
        applicationOutcome: PROVIDER_ACCEPTED,
        applicationAttemptId: ATTEMPT_ID,
        applicationEvidenceHash: ACCEPTED_HASH,
        applicationEvidenceCode: null,
        providerMessageId: PROVIDER_MESSAGE_ID,
        providerAcceptedObservedAt: new Date(ACCEPTED_OBSERVED_AT),
        applicationAttemptedAt: new Date(ATTEMPTED_AT),
        ackReceivedAt: FIXED_NOW,
      });
      expect(Object.keys(updateManyArgs(client).data).sort()).toEqual(
        OUTCOME_DATA_KEYS,
      );
    });

    it('records PROVIDER_ACCEPTED_LATE with late provider evidence and an in-window attempt', async () => {
      const client = makeClient();
      const request = parseRequest(lateBody());
      const hash = hashBotApplicationOutcomeEvidence(request);
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(
          terminalRow({
            applicationOutcome: PROVIDER_ACCEPTED_LATE,
            applicationEvidenceHash: hash,
            ackReceivedAt: FIXED_NOW,
          }),
        );
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      const result = await repo.record(command(request));

      expect(result.status).toBe('recorded');
      expect(result.acknowledgment).toEqual({
        id: DECISION_ID,
        version: 2,
        attemptId: ATTEMPT_ID,
        outcome: PROVIDER_ACCEPTED_LATE,
        ackReceivedAt: FIXED_NOW,
      });
      expect(updateManyArgs(client).data).toEqual({
        applicationOutcome: PROVIDER_ACCEPTED_LATE,
        applicationAttemptId: ATTEMPT_ID,
        applicationEvidenceHash: hash,
        applicationEvidenceCode: null,
        providerMessageId: PROVIDER_MESSAGE_ID,
        providerAcceptedObservedAt: new Date(LATE_ACCEPTED_OBSERVED_AT),
        applicationAttemptedAt: new Date(LATE_ATTEMPTED_AT),
        ackReceivedAt: FIXED_NOW,
      });
    });

    it.each<[string, Record<string, unknown>]>([
      ['without the audit-only providerMessageId', unknownBody()],
      [
        'with the audit-only providerMessageId',
        unknownBody({ providerMessageId: PROVIDER_MESSAGE_ID }),
      ],
    ])(
      'records DELIVERY_UNKNOWN %s, coupling accepted-at to null',
      async (_label, body) => {
        const client = makeClient();
        const request = parseRequest(body);
        const hash = hashBotApplicationOutcomeEvidence(request);
        client.humanDecision.findFirst
          .mockResolvedValueOnce(resolvedRow())
          .mockResolvedValueOnce(
            terminalRow({
              applicationOutcome: DELIVERY_UNKNOWN,
              applicationEvidenceHash: hash,
              ackReceivedAt: FIXED_NOW,
            }),
          );
        client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
        const { repo } = makeRepo(client);

        const result = await repo.record(command(request));

        expect(result.acknowledgment.outcome).toBe(DELIVERY_UNKNOWN);
        expect(updateManyArgs(client).data).toEqual({
          applicationOutcome: DELIVERY_UNKNOWN,
          applicationAttemptId: ATTEMPT_ID,
          applicationEvidenceHash: hash,
          applicationEvidenceCode: null,
          providerMessageId:
            'providerMessageId' in request ? request.providerMessageId : null,
          providerAcceptedObservedAt: null,
          applicationAttemptedAt: new Date(ATTEMPTED_AT),
          ackReceivedAt: FIXED_NOW,
        });
      },
    );

    it('records STALE with no attempt and no provider evidence', async () => {
      const client = makeClient();
      const request = parseRequest(staleBody());
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(
          terminalRow({
            applicationOutcome: STALE,
            applicationEvidenceHash: STALE_HASH,
            ackReceivedAt: FIXED_NOW,
          }),
        );
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      const result = await repo.record(command(request));

      expect(result.acknowledgment.outcome).toBe(STALE);
      expect(updateManyArgs(client).data).toEqual({
        applicationOutcome: STALE,
        applicationAttemptId: ATTEMPT_ID,
        applicationEvidenceHash: STALE_HASH,
        applicationEvidenceCode: null,
        providerMessageId: null,
        providerAcceptedObservedAt: null,
        applicationAttemptedAt: null,
        ackReceivedAt: FIXED_NOW,
      });
    });

    it('always writes applicationEvidenceCode null and the canonical server hash', async () => {
      const client = makeClient();
      const request = parseRequest(acceptedBody());
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(terminalRow({ ackReceivedAt: FIXED_NOW }));
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      await repo.record(command(request));

      expect(updateManyArgs(client).data.applicationEvidenceCode).toBeNull();
      expect(updateManyArgs(client).data.applicationEvidenceHash).toBe(
        hashBotApplicationOutcomeEvidence(request),
      );
      expect(updateManyArgs(client).data.applicationEvidenceHash).toBe(
        ACCEPTED_HASH,
      );
    });

    it('re-reads the committed row after the update and reuses the same predicate', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(terminalRow({ ackReceivedAt: FIXED_NOW }));
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      await repo.record(command(parseRequest(acceptedBody())));

      expect(client.humanDecision.findFirst).toHaveBeenCalledTimes(2);
      expect(findFirstArgs(client, 1).where).toEqual(
        findFirstArgs(client, 0).where,
      );
    });

    it('mutates only humanDecision.updateMany and never a bot/provider/stock/sale row', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(terminalRow({ ackReceivedAt: FIXED_NOW }));
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      await repo.record(command(parseRequest(acceptedBody())));

      expect(client.humanDecision.update).not.toHaveBeenCalled();
      expect(client.humanDecision.create).not.toHaveBeenCalled();
      expect(client.humanDecision.findUnique).not.toHaveBeenCalled();
      expect(client.sale.updateMany).not.toHaveBeenCalled();
      expect(client.sale.update).not.toHaveBeenCalled();
      expect(client.sale.create).not.toHaveBeenCalled();
      expect(client.product.updateMany).not.toHaveBeenCalled();
      expect(client.product.update).not.toHaveBeenCalled();
      expect(client.product.create).not.toHaveBeenCalled();
      expect(client.tenant.update).not.toHaveBeenCalled();
      expect(client.tenant.updateMany).not.toHaveBeenCalled();
      expect(client.user.update).not.toHaveBeenCalled();
      expect(client.user.updateMany).not.toHaveBeenCalled();
    });

    it('never mutates decision status or version in the terminal write', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(terminalRow({ ackReceivedAt: FIXED_NOW }));
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      await repo.record(command(parseRequest(acceptedBody())));

      const data = updateManyArgs(client).data;
      expect(data).not.toHaveProperty('status');
      expect(data).not.toHaveProperty('version');
      expect(data).not.toHaveProperty('resolvedAt');
      expect(data).not.toHaveProperty('resolutionAction');
      expect(data).not.toHaveProperty('resolvedByActorId');
    });
  });

  describe('record — pinned query predicates and SELECT allowlist', () => {
    it('reads the state with id+tenant+source+type and no status filter', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(terminalRow({ ackReceivedAt: FIXED_NOW }));
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      await repo.record(command(parseRequest(acceptedBody())));

      const where = findFirstArgs(client, 0).where;
      expect(where).toEqual({
        id: DECISION_ID,
        tenantId: TENANT_ID,
        source: RESTOCK_SOURCE,
        type: RESTOCK_TYPE,
      });
      expect(where).not.toHaveProperty('status');
      expect(Object.keys(where).sort()).toEqual([
        'id',
        'source',
        'tenantId',
        'type',
      ]);
    });

    it('selects exactly the state allowlist and no authority/evidence column', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(terminalRow({ ackReceivedAt: FIXED_NOW }));
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      await repo.record(command(parseRequest(acceptedBody())));

      const select = findFirstArgs(client, 0).select;
      expect(Object.keys(select).sort()).toEqual(STATE_SELECT_KEYS);
      for (const forbidden of FORBIDDEN_SELECT_KEYS) {
        expect(select).not.toHaveProperty(forbidden);
      }
      expect(Object.keys(APPLICATION_OUTCOME_STATE_SELECT).sort()).toEqual(
        STATE_SELECT_KEYS,
      );
    });

    it('resolves the tenant from the CLS context before opening the transaction', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(terminalRow({ ackReceivedAt: FIXED_NOW }));
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo, tenantPrisma } = makeRepo(client);

      await repo.record(command(parseRequest(acceptedBody())));

      expect(tenantPrisma.getTenantId).toHaveBeenCalledTimes(1);
      expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(1);
      expect(tenantPrisma.getClient).toHaveBeenCalled();
    });
  });

  describe('record — resolution gates', () => {
    it('returns a sanitized NOT_FOUND for a missing/foreign decision and runs no mutation', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValueOnce(null);
      const { repo } = makeRepo(client);

      const error = expectDomainError(
        await captureError(() =>
          repo.record(command(parseRequest(acceptedBody()))),
        ),
      );

      expect(error.code).toBe('NOT_FOUND');
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });

    it('returns VERSION_CONFLICT for a PENDING decision and runs no mutation', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValueOnce(
        resolvedRow({ status: 'PENDING', version: 1, resolvedAt: null }),
      );
      const { repo } = makeRepo(client);

      const error = expectDomainError(
        await captureError(() =>
          repo.record(command(parseRequest(acceptedBody()))),
        ),
      );

      expect(error.code).toBe('VERSION_CONFLICT');
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });

    it.each<[string, Record<string, unknown>, number]>([
      ['a stale expectedResolutionVersion 1', acceptedBody(), 1],
      ['a future expectedResolutionVersion 3', acceptedBody(), 3],
    ])(
      'returns VERSION_CONFLICT for %s',
      async (_label, body, expectedResolutionVersion) => {
        const client = makeClient();
        client.humanDecision.findFirst.mockResolvedValueOnce(resolvedRow());
        const { repo } = makeRepo(client);
        const request = parseRequest({ ...body, expectedResolutionVersion });

        const error = expectDomainError(
          await captureError(() => repo.record(command(request))),
        );

        expect(error.code).toBe('VERSION_CONFLICT');
        expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
      },
    );

    it('returns VERSION_CONFLICT when the persisted row version is not 2', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValueOnce(
        resolvedRow({ version: 3 }),
      );
      const { repo } = makeRepo(client);

      const error = expectDomainError(
        await captureError(() =>
          repo.record(command(parseRequest(acceptedBody()))),
        ),
      );

      expect(error.code).toBe('VERSION_CONFLICT');
    });

    it('accepts a negative-resolution decision (version 2, RESOLVED) as still eligible', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(terminalRow({ ackReceivedAt: FIXED_NOW }));
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      const result = await repo.record(command(parseRequest(acceptedBody())));

      expect(result.status).toBe('recorded');
      expect(client.humanDecision.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('record — half-open application window', () => {
    it('accepts an attempt exactly at resolvedAt', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(terminalRow({ ackReceivedAt: FIXED_NOW }));
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      const result = await repo.record(
        command(parseRequest(acceptedBody({ attemptedAt: ATTEMPTED_AT }))),
      );

      expect(result.status).toBe('recorded');
    });

    it('rejects an attempt exactly at the deadline (half-open upper bound)', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValueOnce(resolvedRow());
      const { repo } = makeRepo(client);

      const error = await captureError(() =>
        repo.record(
          command(
            parseRequest(
              acceptedBody({
                attemptedAt: DEADLINE_AT,
                providerAcceptedObservedAt: DEADLINE_AT,
              }),
            ),
          ),
        ),
      );

      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an attempt strictly before resolvedAt', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValueOnce(resolvedRow());
      const { repo } = makeRepo(client);

      const error = await captureError(() =>
        repo.record(
          command(
            parseRequest(
              acceptedBody({
                attemptedAt: '2026-06-15T11:59:59.000Z',
                providerAcceptedObservedAt: ACCEPTED_OBSERVED_AT,
              }),
            ),
          ),
        ),
      );

      expect(error).toBeInstanceOf(InvalidArgumentError);
    });

    it('rejects PROVIDER_ACCEPTED observed exactly at the deadline', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValueOnce(resolvedRow());
      const { repo } = makeRepo(client);

      const error = await captureError(() =>
        repo.record(
          command(
            parseRequest(
              acceptedBody({
                attemptedAt: LATE_ATTEMPTED_AT,
                providerAcceptedObservedAt: DEADLINE_AT,
              }),
            ),
          ),
        ),
      );

      expect(error).toBeInstanceOf(InvalidArgumentError);
    });

    it('accepts PROVIDER_ACCEPTED_LATE observed exactly at the deadline', async () => {
      const client = makeClient();
      const request = parseRequest(
        lateBody({ providerAcceptedObservedAt: DEADLINE_AT }),
      );
      const hash = hashBotApplicationOutcomeEvidence(request);
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(
          terminalRow({
            applicationOutcome: PROVIDER_ACCEPTED_LATE,
            applicationEvidenceHash: hash,
            ackReceivedAt: FIXED_NOW,
          }),
        );
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      const result = await repo.record(command(request));

      expect(result.status).toBe('recorded');
      expect(updateManyArgs(client).data.providerAcceptedObservedAt).toEqual(
        new Date(DEADLINE_AT),
      );
    });

    it('rejects a DELIVERY_UNKNOWN attempt outside the window', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValueOnce(resolvedRow());
      const { repo } = makeRepo(client);

      const error = await captureError(() =>
        repo.record(
          command(parseRequest(unknownBody({ attemptedAt: DEADLINE_AT }))),
        ),
      );

      expect(error).toBeInstanceOf(InvalidArgumentError);
    });

    it('fails value-free on an invalid window', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValueOnce(resolvedRow());
      const { repo } = makeRepo(client);

      const error = await captureError(() =>
        repo.record(
          command(parseRequest(unknownBody({ attemptedAt: DEADLINE_AT }))),
        ),
      );

      expect(error).toBeInstanceOf(InvalidArgumentError);
      const invalid = error as InvalidArgumentError;
      expect(invalid.message).not.toContain(DECISION_ID);
      expect(invalid.message).not.toContain(ATTEMPT_ID);
      expect(invalid.message).not.toContain(TENANT_ID);
      expect(invalid.message).not.toContain(DEADLINE_AT);
    });
  });

  describe('record — idempotent replay and terminal conflicts', () => {
    it('replays an exact same-attempt/same-hash terminal with the persisted acknowledgment and no write', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValueOnce(terminalRow());
      const { repo } = makeRepo(client);

      const result = await repo.record(command(parseRequest(acceptedBody())));

      expect(result).toEqual({
        status: 'replayed',
        acknowledgment: acceptedAcknowledgment(),
      });
      expect(result.acknowledgment.ackReceivedAt).toBe(PERSISTED_ACK_AT);
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
      expect(client.humanDecision.findFirst).toHaveBeenCalledTimes(1);
    });

    it('does NOT revalidate the time window on replay, even after the deadline', async () => {
      const client = makeClient();
      // Window is [11:00, 12:00); the request attempt (12:00) is exactly at the
      // deadline and would be rejected on a fresh record. A persisted terminal
      // must still classify as an exact replay.
      client.humanDecision.findFirst.mockResolvedValueOnce(
        terminalRow({ resolvedAt: new Date('2026-06-15T11:00:00.000Z') }),
      );
      const { repo } = makeRepo(client);

      const result = await repo.record(command(parseRequest(acceptedBody())));

      expect(result.status).toBe('replayed');
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });

    it('classifies a same-attempt different-hash terminal as IDEMPOTENCY_CONFLICT with no write', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValueOnce(
        terminalRow({ applicationEvidenceHash: 'a'.repeat(64) }),
      );
      const { repo } = makeRepo(client);

      const error = expectDomainError(
        await captureError(() =>
          repo.record(command(parseRequest(acceptedBody()))),
        ),
      );

      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });

    it('classifies a different-attempt terminal as OUTCOME_ALREADY_RECORDED with no write', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValueOnce(
        terminalRow({ applicationAttemptId: OTHER_ATTEMPT_ID }),
      );
      const { repo } = makeRepo(client);

      const error = expectDomainError(
        await captureError(() =>
          repo.record(command(parseRequest(acceptedBody()))),
        ),
      );

      expect(error.code).toBe('OUTCOME_ALREADY_RECORDED');
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });

    it.each([DELIVERY_UNKNOWN, PROVIDER_ACCEPTED_LATE])(
      'classifies a different attempt as OUTCOME_ALREADY_RECORDED while a %s hold is terminal',
      async (persistedOutcome) => {
        const client = makeClient();
        client.humanDecision.findFirst.mockResolvedValueOnce(
          terminalRow({
            applicationOutcome: persistedOutcome,
            applicationEvidenceHash: 'b'.repeat(64),
            applicationAttemptId: OTHER_ATTEMPT_ID,
          }),
        );
        const { repo } = makeRepo(client);

        const error = expectDomainError(
          await captureError(() =>
            repo.record(command(parseRequest(acceptedBody()))),
          ),
        );

        expect(error.code).toBe('OUTCOME_ALREADY_RECORDED');
      },
    );

    it('classifies a same-attempt different-hash STALE terminal as IDEMPOTENCY_CONFLICT', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValueOnce(
        terminalRow({
          applicationOutcome: STALE,
          applicationEvidenceHash: STALE_HASH,
        }),
      );
      const { repo } = makeRepo(client);

      const error = expectDomainError(
        await captureError(() =>
          repo.record(command(parseRequest(acceptedBody()))),
        ),
      );

      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  describe('record — synthetic concurrent CAS (updateMany count 0; seam proof only)', () => {
    it('replays when the count-0 follow-read winner is a same-attempt exact match', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(terminalRow());
      client.humanDecision.updateMany.mockResolvedValue({ count: 0 });
      const { repo } = makeRepo(client);

      const result = await repo.record(command(parseRequest(acceptedBody())));

      expect(result).toEqual({
        status: 'replayed',
        acknowledgment: acceptedAcknowledgment(),
      });
      expect(client.humanDecision.updateMany).toHaveBeenCalledTimes(1);
      expect(client.humanDecision.findFirst).toHaveBeenCalledTimes(2);
    });

    it('classifies a different-attempt count-0 winner as OUTCOME_ALREADY_RECORDED', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(
          terminalRow({ applicationAttemptId: OTHER_ATTEMPT_ID }),
        );
      client.humanDecision.updateMany.mockResolvedValue({ count: 0 });
      const { repo } = makeRepo(client);

      const error = expectDomainError(
        await captureError(() =>
          repo.record(command(parseRequest(acceptedBody()))),
        ),
      );

      expect(error.code).toBe('OUTCOME_ALREADY_RECORDED');
    });

    it('classifies a changed same-attempt count-0 winner as IDEMPOTENCY_CONFLICT', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(
          terminalRow({ applicationEvidenceHash: 'c'.repeat(64) }),
        );
      client.humanDecision.updateMany.mockResolvedValue({ count: 0 });
      const { repo } = makeRepo(client);

      const error = expectDomainError(
        await captureError(() =>
          repo.record(command(parseRequest(acceptedBody()))),
        ),
      );

      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it.each<[string, OutcomeStateRow | null]>([
      ['a missing winner', null],
      ['a PENDING winner', resolvedRow({ status: 'PENDING', version: 1 })],
      ['a terminal-less RESOLVED winner', resolvedRow()],
    ])(
      'fails VERSION_CONFLICT when the count-0 follow-read sees %s',
      async (_label, winner) => {
        const client = makeClient();
        client.humanDecision.findFirst
          .mockResolvedValueOnce(resolvedRow())
          .mockResolvedValueOnce(winner);
        client.humanDecision.updateMany.mockResolvedValue({ count: 0 });
        const { repo } = makeRepo(client);

        const error = expectDomainError(
          await captureError(() =>
            repo.record(command(parseRequest(acceptedBody()))),
          ),
        );

        expect(error.code).toBe('VERSION_CONFLICT');
      },
    );
  });

  describe('record — integrity guards', () => {
    it.each<[string, number]>([
      ['negative', -1],
      ['two', 2],
      ['large', 42],
    ])(
      'fails closed with a value-free plain Error for a %s update count',
      async (_label, count) => {
        const client = makeClient();
        client.humanDecision.findFirst.mockResolvedValueOnce(resolvedRow());
        client.humanDecision.updateMany.mockResolvedValue({ count });
        const { repo } = makeRepo(client);

        const error = await captureError(() =>
          repo.record(command(parseRequest(acceptedBody()))),
        );

        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(BotApplicationOutcomeError);
        if (!(error instanceof Error)) {
          throw new Error('expected an Error');
        }
        expect((error as { code?: unknown }).code).toBeUndefined();
        expect(error.message).not.toContain(DECISION_ID);
        expect(error.message).not.toContain(ATTEMPT_ID);
        expect(client.humanDecision.findFirst).toHaveBeenCalledTimes(1);
        expect(client.humanDecision.updateMany).toHaveBeenCalledTimes(1);
      },
    );

    it('fails closed when the committed re-read after a count-1 write is missing', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(null);
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      const error = await captureError(() =>
        repo.record(command(parseRequest(acceptedBody()))),
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(BotApplicationOutcomeError);
    });
  });

  describe('record — fail-closed context guards', () => {
    it('rejects a nested record before any tenant lookup, query or transaction', async () => {
      const client = makeClient();
      const { repo, tenantPrisma } = makeRepo(client, { inTransaction: true });

      const error = await captureError(() =>
        repo.record(command(parseRequest(acceptedBody()))),
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(BotApplicationOutcomeError);
      expect(tenantPrisma.isInTransaction).toHaveBeenCalledTimes(1);
      expect(tenantPrisma.getTenantId).not.toHaveBeenCalled();
      expect(tenantPrisma.runInTransaction).not.toHaveBeenCalled();
      expect(tenantPrisma.getClient).not.toHaveBeenCalled();
      expect(client.humanDecision.findFirst).not.toHaveBeenCalled();
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });

    it('fails closed without a tenant context before any query or transaction', async () => {
      const client = makeClient();
      const { repo, tenantPrisma } = makeRepo(client, { tenantId: null });

      await expect(
        repo.record(command(parseRequest(acceptedBody()))),
      ).rejects.toThrow('Tenant context required');

      expect(tenantPrisma.runInTransaction).not.toHaveBeenCalled();
      expect(tenantPrisma.getClient).not.toHaveBeenCalled();
      expect(client.humanDecision.findFirst).not.toHaveBeenCalled();
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('record — defensive runtime re-parse', () => {
    it('rejects a raw body with a smuggled authority key before any DB work', async () => {
      const client = makeClient();
      const { repo } = makeRepo(client);

      const error = await captureError(() =>
        repo.record(
          rawCommand({
            ...acceptedBody(),
            decisionId: DECISION_ID,
            tenantId: TENANT_ID,
          }),
        ),
      );

      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect(client.humanDecision.findFirst).not.toHaveBeenCalled();
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a raw body carrying a client-supplied evidence hash key before hashing', async () => {
      const client = makeClient();
      const { repo } = makeRepo(client);

      const error = await captureError(() =>
        repo.record(
          rawCommand({
            ...acceptedBody(),
            applicationEvidenceHash: 'deadbeef',
          }),
        ),
      );

      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect(client.humanDecision.updateMany).not.toHaveBeenCalled();
    });

    it('re-hashes well-formed raw input identically to its parsed form', async () => {
      const client = makeClient();
      client.humanDecision.findFirst
        .mockResolvedValueOnce(resolvedRow())
        .mockResolvedValueOnce(terminalRow({ ackReceivedAt: FIXED_NOW }));
      client.humanDecision.updateMany.mockResolvedValue({ count: 1 });
      const { repo } = makeRepo(client);

      await repo.record(rawCommand(acceptedBody()));

      expect(updateManyArgs(client).data.applicationEvidenceHash).toBe(
        ACCEPTED_HASH,
      );
    });
  });

  describe('record — value-free failures', () => {
    it('never echoes the decision id, attempt id or tenant id in a domain error', async () => {
      const client = makeClient();
      client.humanDecision.findFirst.mockResolvedValueOnce(
        terminalRow({
          applicationAttemptId: OTHER_ATTEMPT_ID,
          applicationEvidenceHash: 'd'.repeat(64),
        }),
      );
      const { repo } = makeRepo(client);

      const error = expectDomainError(
        await captureError(() =>
          repo.record(command(parseRequest(acceptedBody()))),
        ),
      );

      expect(error.message).not.toContain(DECISION_ID);
      expect(error.message).not.toContain(ATTEMPT_ID);
      expect(error.message).not.toContain(OTHER_ATTEMPT_ID);
      expect(error.message).not.toContain(TENANT_ID);
    });
  });

  describe('record — injected clock', () => {
    it('exposes an injection token for the optional server clock', () => {
      expect(typeof BOT_APPLICATION_OUTCOME_CLOCK).toBe('symbol');
    });
  });
});
