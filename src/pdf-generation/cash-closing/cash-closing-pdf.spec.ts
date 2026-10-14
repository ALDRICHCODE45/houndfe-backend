/**
 * cash-register-closing / T5 (S1,S2,S3,S7) — printable A4 closing receipt.
 *
 * The receipt is driven ONLY by the frozen closing snapshot delivered by the
 * `CASH_APPLICATION` port. These tests pin four contracts:
 *   1. Parsing fails closed on any malformed/foreign payload (no `any`, no
 *      null-to-zero coercion, ISO strings kept verbatim, negative
 *      differences preserved).
 *   2. The A4 template renders Spanish audit labels, both independent
 *      differences (declarado − esperado and verificado − declarado),
 *      custody FLOAT vs WITHDRAWAL, actors and discrepancy notes.
 *   3. The controller enforces UUID parsing, `read:CashClosing`, the actor
 *      ability, and safe headers (`application/pdf`, safe filename,
 *      `private, no-store`).
 *   4. The service fetches exclusively through `CASH_APPLICATION` with a
 *      `CLOSING` query — never a live sales/Prisma read.
 */
import { readFileSync } from 'node:fs';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import {
  Document,
  Page,
  Text,
  View,
  renderToBuffer,
} from '@react-pdf/renderer';
import {
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { Request, Response } from 'express';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import type {
  CashActor,
  CashDocument,
  CashJson,
  ICashApplication,
} from '../../cash-register/cash-application.port';
import {
  createCashClosingSnapshot,
  type CashClosingSnapshot,
} from '../../cash-register/domain/cash-snapshot';
import type { CashSession } from '../../cash-register/domain/cash-register.types';
import {
  CASH_CLOSING_HANDOVERS_FIRST_PAGE,
  CASH_CLOSING_HANDOVERS_PAGE,
  CashClosingA4Document,
  paginateCashClosingHandovers,
  summarizeCashHandovers,
} from './cash-closing-a4.document';
import {
  CASH_CLOSING_SNAPSHOT_INVALID,
  CashClosingSnapshotParseError,
  parseCashClosingReceipt,
} from './cash-closing-receipt.parser';
import { CashClosingPdfService } from './cash-closing-pdf.service';
import {
  CashClosingPdfController,
  buildCashClosingPdfFilename,
} from './cash-closing-pdf.controller';

const SOURCE_DIR = __dirname;
const SERVICE_SOURCE = readFileSync(
  `${SOURCE_DIR}/cash-closing-pdf.service.ts`,
  'utf8',
);
const CONTROLLER_SOURCE = readFileSync(
  `${SOURCE_DIR}/cash-closing-pdf.controller.ts`,
  'utf8',
);
const DOCUMENT_SOURCE = readFileSync(
  `${SOURCE_DIR}/cash-closing-a4.document.tsx`,
  'utf8',
);

const PDF_MAGIC = Buffer.from('%PDF', 'utf8');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CLOSING_ID = '33333333-3333-4333-8333-333333333333';
const REGISTER_ID = '44444444-4444-4444-8444-444444444444';
const CASHIER_ID = '55555555-5555-4555-8555-555555555555';
const VERIFIER_ID = '66666666-6666-4666-8666-666666666666';
const CLOSER_ID = '77777777-7777-4777-8777-777777777777';
const RECEIVER_ID = '88888888-8888-4888-8888-888888888888';
const FOLIO = 'CC-2026-0001';

const COUNTED_AT = new Date('2026-01-15T18:00:00.000Z');
const VERIFIED_AT = new Date('2026-01-15T18:10:00.000Z');
const CLOSED_AT = new Date('2026-01-15T18:30:00.000Z');
const HANDOVER_DECLARED_AT = new Date('2026-01-15T18:05:00.000Z');
const HANDOVER_RECEIVED_AT = new Date('2026-01-15T18:07:00.000Z');

function makeSession(): CashSession {
  return {
    id: SESSION_ID,
    tenantId: TENANT_ID,
    registerId: REGISTER_ID,
    cashierUserId: CASHIER_ID,
    status: 'CLOSED',
    openingCents: 50_000,
    frozenAt: COUNTED_AT,
    drawerReleasedAt: HANDOVER_RECEIVED_AT,
  };
}

/** Frozen fixture: built through the real domain snapshot factory. */
function frozenSnapshot(): CashClosingSnapshot {
  return createCashClosingSnapshot({
    session: makeSession(),
    folio: FOLIO,
    expectedCents: 55_000,
    declaredCents: 54_000,
    verifiedCents: 53_000,
    verifierUserId: VERIFIER_ID,
    channels: [
      {
        channelKey: 'CASH',
        channelLabel: 'Efectivo',
        method: 'CASH',
        expectedCents: 35_000,
        declaredCents: 34_000,
        verifiedCents: 34_000,
        differenceCents: -1_000,
      },
      {
        channelKey: 'PM:card',
        channelLabel: 'Tarjeta',
        method: 'CARD_CREDIT',
        expectedCents: 20_000,
        declaredCents: 20_000,
        verifiedCents: 19_000,
        differenceCents: 0,
      },
    ],
    handovers: [
      {
        handoverId: 'handover-withdrawal',
        kind: 'WITHDRAWAL',
        declaredCents: 10_000,
        receivedCents: 10_000,
        senderUserId: CASHIER_ID,
        receiverUserId: RECEIVER_ID,
        receiptActorUserId: RECEIVER_ID,
        declaredAt: HANDOVER_DECLARED_AT,
        receivedAt: HANDOVER_RECEIVED_AT,
      },
      {
        handoverId: 'handover-float',
        kind: 'FLOAT',
        declaredCents: 24_000,
        receivedCents: null,
        senderUserId: CASHIER_ID,
        receiverUserId: null,
        receiptActorUserId: null,
        declaredAt: HANDOVER_DECLARED_AT,
        receivedAt: null,
      },
    ],
    countedAt: COUNTED_AT,
    verifiedAt: VERIFIED_AT,
    closedAt: CLOSED_AT,
    closedByUserId: CLOSER_ID,
  });
}

function toCashJson(value: unknown): CashJson {
  return JSON.parse(JSON.stringify(value)) as CashJson;
}

/** Envelope plus the agreed optional snapshot extras. */
function makeDocument(
  extras: Record<string, CashJson> = {
    registerName: 'Caja 1',
    declarationNotes: 'Faltó cambio menudeado.',
    verificationNotes: 'Recuento confirmado por el encargado.',
    closingNotes: 'Se retira el excedente.',
    cashierName: 'Ana Cajera',
    verifierName: 'Beto Encargado',
    closedByName: 'Carla Supervisora',
  },
  snapshotOverride?: CashClosingSnapshot,
): CashDocument {
  const snapshot = snapshotOverride ?? frozenSnapshot();
  return {
    id: CLOSING_ID,
    sessionId: SESSION_ID,
    folio: FOLIO,
    createdAt: CLOSED_AT.toISOString(),
    snapshot: toCashJson({ ...snapshot, ...extras }),
  };
}

function makeReceipt() {
  return parseCashClosingReceipt(makeDocument());
}

function makeAbility(allowed = true): AppAbility {
  return { can: jest.fn(() => allowed) } as unknown as AppAbility;
}

function makeActor(allowed = true): CashActor {
  return { userId: CASHIER_ID, ability: makeAbility(allowed) };
}

function makeUser(): AuthenticatedUser {
  return {
    userId: CASHIER_ID,
    email: 'cajera@test.com',
    tenantId: TENANT_ID,
    tenantSlug: 'test',
    isSuperAdmin: false,
  };
}

type RequestWithAbility = Request & { ability?: AppAbility };

function makeRequest(ability?: AppAbility): RequestWithAbility {
  return { ability } as unknown as RequestWithAbility;
}

/** Mock response with `jest.Mock` getters (avoids unbound-method lint). */
type MockResponse = Response & { set: jest.Mock; send: jest.Mock };

function makeRes(): MockResponse {
  return {
    set: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as unknown as MockResponse;
}

/** react-pdf host components: recurse their children instead of invoking. */
const HOST_COMPONENTS = new Set<unknown>([Document, Page, Text, View]);

function flattenText(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(flattenText).join('');
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    return typeof node === 'string' ? `${node} ` : '';
  }
  if (typeof node.type === 'function' && !HOST_COMPONENTS.has(node.type)) {
    const Component = node.type as (props: unknown) => ReactNode;
    return flattenText(Component(node.props));
  }
  return flattenText(node.props.children);
}

function renderText(receipt = makeReceipt()): string {
  return flattenText(CashClosingA4Document({ receipt }));
}

// ── Parser ───────────────────────────────────────────────────────────────

describe('parseCashClosingReceipt', () => {
  it('parses the frozen snapshot using exact domain keys', () => {
    const receipt = makeReceipt();

    expect(receipt.id).toBe(CLOSING_ID);
    expect(receipt.sessionId).toBe(SESSION_ID);
    expect(receipt.folio).toBe(FOLIO);
    expect(receipt.snapshot.openingCents).toBe(50_000);
    expect(receipt.snapshot.expectedCents).toBe(55_000);
    expect(receipt.snapshot.declaredCents).toBe(54_000);
    expect(receipt.snapshot.verifiedCents).toBe(53_000);
    expect(receipt.snapshot.verifierUserId).toBe(VERIFIER_ID);
    expect(receipt.snapshot.channels).toHaveLength(2);
    expect(receipt.snapshot.channels[0].differenceCents).toBe(-1_000);
    expect(receipt.snapshot.handovers).toHaveLength(2);
  });

  it('keeps ISO date strings verbatim (no Date reparsing)', () => {
    const receipt = makeReceipt();

    expect(receipt.snapshot.countedAt).toBe(COUNTED_AT.toISOString());
    expect(receipt.snapshot.verifiedAt).toBe(VERIFIED_AT.toISOString());
    expect(receipt.snapshot.closedAt).toBe(CLOSED_AT.toISOString());
    expect(receipt.snapshot.handovers[0].declaredAt).toBe(
      HANDOVER_DECLARED_AT.toISOString(),
    );
    expect(receipt.snapshot.handovers[1].receivedAt).toBeNull();
  });

  it('parses a snapshot serialized as a JSON string', () => {
    const document = makeDocument();
    const serialized: CashDocument = {
      ...document,
      snapshot: JSON.stringify(document.snapshot) as CashJson,
    };

    const receipt = parseCashClosingReceipt(serialized);
    expect(receipt.snapshot.folio).toBe(FOLIO);
    expect(receipt.snapshot.channels[0].expectedCents).toBe(35_000);
  });

  it('preserves negative differences instead of clamping them', () => {
    const receipt = makeReceipt();

    expect(receipt.snapshot.channels[0].differenceCents).toBeLessThan(0);
    expect(receipt.snapshot.declaredCents).toBeLessThan(
      receipt.snapshot.expectedCents,
    );
    expect(receipt.snapshot.verifiedCents).toBeLessThan(
      receipt.snapshot.declaredCents,
    );
  });

  it('does not coerce a null verification into zero', () => {
    const snapshot = createCashClosingSnapshot({
      session: makeSession(),
      folio: FOLIO,
      expectedCents: 55_000,
      declaredCents: 54_000,
      verifiedCents: null,
      verifierUserId: null,
      channels: [],
      handovers: [],
      countedAt: COUNTED_AT,
      verifiedAt: null,
      closedAt: CLOSED_AT,
      closedByUserId: CLOSER_ID,
    });
    const receipt = parseCashClosingReceipt(makeDocument({}, snapshot));

    expect(receipt.snapshot.verifiedCents).toBeNull();
    expect(receipt.snapshot.verifierUserId).toBeNull();
    expect(receipt.snapshot.verifiedAt).toBeNull();
  });

  it.each([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])(
    'preserves safe integer boundary %s',
    (expectedCents) => {
      const doc = makeDocument();
      const receipt = parseCashClosingReceipt({
        ...doc,
        snapshot: { ...(doc.snapshot as object), expectedCents },
      });
      expect(receipt.snapshot.expectedCents).toBe(expectedCents);
    },
  );

  it.each([Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1])(
    'rejects unsafe monetary integer %s without mutating the snapshot',
    (expectedCents) => {
      const doc = makeDocument();
      const input = {
        ...doc,
        snapshot: { ...(doc.snapshot as object), expectedCents },
      };
      const before = JSON.stringify(input);
      expect(() => parseCashClosingReceipt(input)).toThrow(
        CashClosingSnapshotParseError,
      );
      expect(JSON.stringify(input)).toBe(before);
    },
  );

  const invalidCases: Array<[string, () => unknown]> = [
    ['missing snapshot', () => ({ ...makeDocument(), snapshot: undefined })],
    [
      'missing declaredCents',
      () => {
        const doc = makeDocument();
        const snapshot = { ...(doc.snapshot as Record<string, CashJson>) };
        delete snapshot.declaredCents;
        return { ...doc, snapshot };
      },
    ],
    [
      'fractional cents',
      () => {
        const doc = makeDocument();
        return {
          ...doc,
          snapshot: { ...(doc.snapshot as object), openingCents: 10.5 },
        };
      },
    ],
    [
      'non-numeric cents',
      () => {
        const doc = makeDocument();
        return {
          ...doc,
          snapshot: { ...(doc.snapshot as object), expectedCents: '0' },
        };
      },
    ],
    [
      'unknown channel method',
      () => {
        const doc = makeDocument();
        const snapshot = doc.snapshot as Record<string, CashJson>;
        const channels = JSON.parse(JSON.stringify(snapshot.channels)) as Array<
          Record<string, CashJson>
        >;
        channels[0].method = 'BITCOIN';
        return { ...doc, snapshot: { ...snapshot, channels } };
      },
    ],
    [
      'invalid ISO timestamp',
      () => {
        const doc = makeDocument();
        return {
          ...doc,
          snapshot: { ...(doc.snapshot as object), countedAt: 'not-a-date' },
        };
      },
    ],
    [
      'envelope/session mismatch',
      () => ({
        ...makeDocument(),
        sessionId: '99999999-9999-4999-8999-999999999999',
      }),
    ],
    [
      'envelope/folio mismatch',
      () => ({ ...makeDocument(), folio: 'OTRO-FOLIO' }),
    ],
    ['root is not an object', () => 'nope'],
    ['snapshot JSON is corrupt', () => ({ ...makeDocument(), snapshot: '{' })],
  ];

  it.each(invalidCases)('fails closed on %s', (_label, build) => {
    let caught: unknown;
    try {
      parseCashClosingReceipt(build());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CashClosingSnapshotParseError);
    expect((caught as CashClosingSnapshotParseError).code).toBe(
      CASH_CLOSING_SNAPSHOT_INVALID,
    );
  });
});

// ── Difference + custody helpers ─────────────────────────────────────────

describe('closing receipt helpers', () => {
  it('paginates handovers with a smaller first-page budget', () => {
    expect(paginateCashClosingHandovers([])).toEqual([[]]);
    expect(paginateCashClosingHandovers([1, 2, 3])).toEqual([[1, 2, 3]]);
    expect(
      paginateCashClosingHandovers(
        Array.from({ length: 20 }, (_, index) => index),
      ),
    ).toEqual([
      Array.from({ length: CASH_CLOSING_HANDOVERS_FIRST_PAGE }, (_, i) => i),
      Array.from({ length: CASH_CLOSING_HANDOVERS_PAGE }, (_, i) => i + 5),
      [19],
    ]);
  });

  it('separates FLOAT and WITHDRAWAL custody totals', () => {
    const totals = summarizeCashHandovers(frozenSnapshot().handovers);

    expect(totals.withdrawalDeclaredCents).toBe(10_000);
    expect(totals.withdrawalReceivedCents).toBe(10_000);
    expect(totals.withdrawalPendingCount).toBe(0);
    expect(totals.floatDeclaredCents).toBe(24_000);
    expect(totals.floatReceivedCents).toBe(0);
    expect(totals.floatPendingCount).toBe(1);
  });
});

// ── Template ─────────────────────────────────────────────────────────────

describe('CashClosingA4Document', () => {
  it('renders a non-empty PDF buffer with PDF magic bytes', async () => {
    const buffer = await renderToBuffer(
      createElement(CashClosingA4Document, { receipt: makeReceipt() }) as never,
    );

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(true);
  });

  it('emits a Document titled with the folio and one A4 Page per chunk', () => {
    const receipt = makeReceipt();
    const element = CashClosingA4Document({ receipt }) as unknown as {
      type: unknown;
      props: { title: string; children: ReactNode };
    };

    expect(element.type).toBe(Document);
    expect(element.props.title).toContain(FOLIO);

    const pages = Children.toArray(element.props.children).filter(
      (child) => isValidElement(child) && child.type === Page,
    );
    expect(pages).toHaveLength(
      paginateCashClosingHandovers(receipt.snapshot.handovers).length,
    );
    const pageProps = (pages[0] as { props: { size: unknown } }).props;
    expect(pageProps.size).toEqual({ width: 595, height: 842 });
  });

  it('renders Spanish audit labels, differences, custody and notes', () => {
    const text = renderText();

    // Header + opening float kept separate from custody withdrawals.
    expect(text).toContain('Comprobante de corte de caja');
    expect(text).toContain('FONDO INICIAL (APERTURA)');
    expect(text).toContain('$500.00');

    // Channel table: expected / declared / verified + both differences.
    expect(text).toContain('CANAL');
    expect(text).toContain('ESPERADO');
    expect(text).toContain('DECLARADO');
    expect(text).toContain('VERIFICADO');
    expect(text).toContain('DIF. DECL. − ESP.');
    expect(text).toContain('DIF. VERIF. − DECL.');
    expect(text).toContain('Efectivo');
    expect(text).toContain('Tarjeta');

    // Declaration-expected AND verification-declaration, never combined.
    expect(text).toContain('Diferencia declarado − esperado');
    expect(text).toContain('Diferencia verificado − declarado');
    expect(text).toContain('-$10.00');

    // Stable IDs plus optional names from the snapshot (no live lookup).
    expect(text).toContain(CASHIER_ID);
    expect(text).toContain(VERIFIER_ID);
    expect(text).toContain(CLOSER_ID);
    expect(text).toContain('Ana Cajera');
    expect(text).toContain('Beto Encargado');
    expect(text).toContain('Carla Supervisora');

    // Custody: FLOAT vs WITHDRAWAL, declared/received receiver + actor.
    expect(text).toContain('Retiro');
    expect(text).toContain('Fondo (FLOAT)');
    expect(text).toContain(RECEIVER_ID);
    expect(text).toContain('Custodia y entregas');

    // Discrepancy notes preserved verbatim.
    expect(text).toContain('Faltó cambio menudeado.');
    expect(text).toContain('Recuento confirmado por el encargado.');
    expect(text).toContain('Se retira el excedente.');

    // The frozen-snapshot provenance is stated.
    expect(text).toContain('corte congelado');
  });

  it('never labels the combined totals as physical cash or profit', () => {
    const text = renderText().toLowerCase();

    expect(text).not.toContain('efectivo físico');
    expect(text).not.toContain('utilidad');
    expect(text).not.toContain('ganancia');
    expect(text).not.toContain('profit');
  });

  it('renders an empty-custody notice when there are no handovers', () => {
    const snapshot = createCashClosingSnapshot({
      session: makeSession(),
      folio: FOLIO,
      expectedCents: 55_000,
      declaredCents: 54_000,
      verifiedCents: null,
      verifierUserId: null,
      channels: [],
      handovers: [],
      countedAt: COUNTED_AT,
      verifiedAt: null,
      closedAt: CLOSED_AT,
      closedByUserId: CLOSER_ID,
    });
    const text = renderText(
      parseCashClosingReceipt(makeDocument({}, snapshot)),
    );

    expect(text).toContain('Sin movimientos de custodia');
    expect(text).toContain('Sin canales registrados');
  });

  it('uses built-in Helvetica with no remote assets or fonts', () => {
    expect(DOCUMENT_SOURCE).toContain("fontFamily: 'Helvetica'");
    expect(DOCUMENT_SOURCE).not.toContain('getModernFontFamily');
    expect(DOCUMENT_SOURCE).not.toContain('registerModernFont');
    expect(DOCUMENT_SOURCE).not.toContain('https://');
    expect(DOCUMENT_SOURCE).not.toContain('Image');
  });
});

// ── Service ──────────────────────────────────────────────────────────────

describe('CashClosingPdfService', () => {
  let cashApplication: { query: jest.Mock; execute: jest.Mock };
  let service: CashClosingPdfService;

  beforeEach(() => {
    cashApplication = { query: jest.fn(), execute: jest.fn() };
    service = new CashClosingPdfService(
      cashApplication as unknown as ICashApplication,
    );
  });

  it('fetches the closing through CASH_APPLICATION only', async () => {
    cashApplication.query.mockResolvedValue(makeDocument());
    const actor = makeActor();

    const result = await service.generateClosingReceipt(actor, CLOSING_ID);

    expect(cashApplication.query).toHaveBeenCalledTimes(1);
    expect(cashApplication.query).toHaveBeenCalledWith(actor, {
      kind: 'CLOSING',
      id: CLOSING_ID,
    });
    expect(cashApplication.execute).not.toHaveBeenCalled();
    expect(result.folio).toBe(FOLIO);
  });

  it('renders a PDF buffer from the frozen snapshot', async () => {
    cashApplication.query.mockResolvedValue(makeDocument());

    const result = await service.generateClosingReceipt(
      makeActor(),
      CLOSING_ID,
    );

    expect(result.buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(
      true,
    );
  });

  it('fails closed with 500 on an invalid snapshot instead of rendering', async () => {
    cashApplication.query.mockResolvedValue({ id: CLOSING_ID });

    let caught: unknown;
    try {
      await service.generateClosingReceipt(makeActor(), CLOSING_ID);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InternalServerErrorException);
    expect((caught as InternalServerErrorException).message).toBe(
      CASH_CLOSING_SNAPSHOT_INVALID,
    );
  });

  it('propagates the port NotFoundException without translating it', async () => {
    cashApplication.query.mockRejectedValue(new NotFoundException());

    await expect(
      service.generateClosingReceipt(makeActor(), CLOSING_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('never imports or reads live sales/Prisma data', () => {
    expect(SERVICE_SOURCE).not.toContain('SalesService');
    expect(SERVICE_SOURCE).not.toContain('PrismaService');
    expect(SERVICE_SOURCE).not.toContain('../sales');
    expect(SERVICE_SOURCE).not.toContain('CASH_LEDGER');
  });
});

// ── Controller ───────────────────────────────────────────────────────────

describe('CashClosingPdfController', () => {
  let service: { generateClosingReceipt: jest.Mock };
  let controller: CashClosingPdfController;

  beforeEach(() => {
    service = { generateClosingReceipt: jest.fn() };
    controller = new CashClosingPdfController(
      service as unknown as CashClosingPdfService,
    );
  });

  it('requires read:CashClosing and the standard guard stack', () => {
    const handler = (
      CashClosingPdfController.prototype as unknown as {
        getClosingPdf: object;
      }
    ).getClosingPdf;
    const permissions = Reflect.getMetadata(
      PERMISSIONS_KEY,
      handler,
    ) as unknown;
    expect(permissions).toEqual([['read', 'CashClosing']]);

    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      CashClosingPdfController,
    ) as unknown;
    expect(guards).toEqual([
      JwtAuthGuard,
      TenantContextGuard,
      PermissionsGuard,
    ]);
    expect(CONTROLLER_SOURCE).toContain('ParseUUIDPipe');
  });

  it('builds the actor from the user id + request ability', async () => {
    const ability = makeAbility();
    const buffer = Buffer.from('%PDF-1.4 fake');
    service.generateClosingReceipt.mockResolvedValue({ buffer, folio: FOLIO });

    const res = makeRes();
    await controller.getClosingPdf(
      CLOSING_ID,
      makeUser(),
      makeRequest(ability),
      res,
    );

    expect(service.generateClosingReceipt).toHaveBeenCalledWith(
      { userId: CASHIER_ID, ability },
      CLOSING_ID,
    );
  });

  it('sets application/pdf, a safe filename and private, no-store', async () => {
    const buffer = Buffer.from('%PDF-1.4 fake');
    service.generateClosingReceipt.mockResolvedValue({ buffer, folio: FOLIO });
    const res = makeRes();

    await controller.getClosingPdf(
      CLOSING_ID,
      makeUser(),
      makeRequest(makeAbility()),
      res,
    );

    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="corte-caja-${FOLIO}.pdf"`,
      'Cache-Control': 'private, no-store',
    });
    expect(res.send).toHaveBeenCalledWith(buffer);
  });

  it('strips CRLF and unsafe characters from the filename', () => {
    const filename = buildCashClosingPdfFilename(CLOSING_ID, 'a"\r\n/../b');

    expect(filename).toBe('corte-caja-ab.pdf');
    expect(filename).not.toMatch(/[\r\n"]/);
  });

  it('falls back to the validated UUID when the folio sanitizes to empty', () => {
    expect(buildCashClosingPdfFilename(CLOSING_ID, '///')).toBe(
      `corte-caja-${CLOSING_ID}.pdf`,
    );
  });

  it('fails closed with 403 when the guard did not attach an ability', async () => {
    const res = makeRes();

    await expect(
      controller.getClosingPdf(CLOSING_ID, makeUser(), makeRequest(), res),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.generateClosingReceipt).not.toHaveBeenCalled();
  });

  it('fails closed with 403 when the ability denies read:CashClosing', async () => {
    const res = makeRes();

    await expect(
      controller.getClosingPdf(
        CLOSING_ID,
        makeUser(),
        makeRequest(makeAbility(false)),
        res,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.generateClosingReceipt).not.toHaveBeenCalled();
  });

  it('fails closed with 401 when no authenticated principal is attached', async () => {
    const res = makeRes();
    const user = { ...makeUser(), userId: ' ' };

    await expect(
      controller.getClosingPdf(
        CLOSING_ID,
        user,
        makeRequest(makeAbility()),
        res,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.generateClosingReceipt).not.toHaveBeenCalled();
  });
});
