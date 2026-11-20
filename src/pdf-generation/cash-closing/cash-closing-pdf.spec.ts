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
import {
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  Document,
  Image,
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
  CashClosingA4Document,
  UNNAMED_USER_LABEL,
  formatClosingFolio,
  summarizeCashHandovers,
} from './cash-closing-a4.document';
import { A4_COLORS, A4_LOGO_PATH } from '../templates/shared/a4-kit';
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
const KIT_SOURCE = ['a4-kit.tsx', 'a4-styles.ts', 'tokens.ts']
  .map((file) =>
    readFileSync(`${SOURCE_DIR}/../templates/shared/a4-kit/${file}`, 'utf8'),
  )
  .join('\n');
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

type AnyElement = ReactElement<Record<string, unknown>>;

/** Every element of the tree, expanding kit function components. */
function collectElements(
  node: ReactNode,
  out: AnyElement[] = [],
): AnyElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => collectElements(child as ReactNode, out));
    return out;
  }
  if (!isValidElement<Record<string, unknown>>(node)) {
    return out;
  }
  out.push(node);
  if (typeof node.type === 'function' && !HOST_COMPONENTS.has(node.type)) {
    const Component = node.type as (props: unknown) => ReactNode;
    collectElements(Component(node.props), out);
  } else {
    collectElements(node.props.children as ReactNode, out);
  }
  return out;
}

function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...(style as unknown[]).map(flatStyle)) as Record<
      string,
      unknown
    >;
  }
  return typeof style === 'object' && style !== null
    ? (style as Record<string, unknown>)
    : {};
}

/** Merged style of the first Text whose flattened content equals `content`. */
function textStyleOf(
  receipt: ReturnType<typeof makeReceipt>,
  content: string,
): Record<string, unknown> {
  const match = collectElements(CashClosingA4Document({ receipt })).find(
    (element) =>
      element.type === Text &&
      flattenText(element.props.children as ReactNode).trim() === content,
  );
  if (match === undefined) {
    throw new Error(`no Text with content "${content}"`);
  }
  return flatStyle(match.props.style);
}

/** All the extras a snapshot frozen BEFORE the optional names existed lacks. */
function oldSnapshotDocument(): CashDocument {
  return makeDocument({ registerName: 'Caja 1' });
}

/** A snapshot frozen at close AFTER pdf-a4-redesign T2 (names on handovers). */
function newSnapshotDocument(): CashDocument {
  const document = makeDocument();
  const snapshot = document.snapshot as Record<string, CashJson>;
  const handovers = (snapshot.handovers as Array<Record<string, CashJson>>).map(
    (handover) => ({
      ...handover,
      senderName: 'Ana Cajera',
      receiverName: handover.receiverUserId === null ? null : 'Rosa Recibe',
      receiptActorName:
        handover.receiptActorUserId === null ? null : 'Paco Confirma',
    }),
  );
  return { ...document, snapshot: { ...snapshot, handovers } };
}

function makeManyHandoversDocument(count: number): CashDocument {
  const document = newSnapshotDocument();
  const snapshot = document.snapshot as Record<string, CashJson>;
  const [template] = snapshot.handovers as Array<Record<string, CashJson>>;
  const handovers = Array.from({ length: count }, (_, index) => ({
    ...template,
    handoverId: `handover-${index}`,
  }));
  return { ...document, snapshot: { ...snapshot, handovers } };
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

  it('accepts OLD snapshots without handover names (names read as null)', () => {
    const receipt = parseCashClosingReceipt(oldSnapshotDocument());

    expect(receipt.snapshot.handovers).toHaveLength(2);
    for (const handover of receipt.snapshot.handovers) {
      expect(handover.senderName).toBeNull();
      expect(handover.receiverName).toBeNull();
      expect(handover.receiptActorName).toBeNull();
    }
  });

  it('accepts NEW snapshots and keeps the frozen handover names', () => {
    const receipt = parseCashClosingReceipt(newSnapshotDocument());

    expect(receipt.snapshot.handovers[0]).toMatchObject({
      senderUserId: CASHIER_ID,
      senderName: 'Ana Cajera',
      receiverName: 'Rosa Recibe',
      receiptActorName: 'Paco Confirma',
    });
    expect(receipt.snapshot.handovers[1].receiverName).toBeNull();
  });

  it('rejects a handover name that is not text', () => {
    const document = newSnapshotDocument();
    const snapshot = document.snapshot as Record<string, CashJson>;
    const handovers = [
      ...(snapshot.handovers as Array<Record<string, CashJson>>),
    ];
    handovers[0] = { ...handovers[0], senderName: 42 };

    expect(() =>
      parseCashClosingReceipt({
        ...document,
        snapshot: { ...snapshot, handovers },
      }),
    ).toThrow(CashClosingSnapshotParseError);
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

  it('emits a Document titled with the folio and ONE wrapping A4 Page (natural pagination)', () => {
    const receipt = parseCashClosingReceipt(makeManyHandoversDocument(19));
    const element = CashClosingA4Document({ receipt }) as unknown as {
      type: unknown;
      props: { title: string; children: ReactNode };
    };

    expect(element.type).toBe(Document);
    expect(element.props.title).toContain(FOLIO);

    const pages = collectElements(element).filter(
      (child) => child.type === Page,
    );
    // 19 handovers still render ONE <Page>: react-pdf paginates by itself.
    expect(pages).toHaveLength(1);
    const pageProps = pages[0].props as { size: unknown; wrap?: boolean };
    expect(pageProps.size).toEqual({ width: 595, height: 842 });
    expect(pageProps.wrap).toBe(true);
  });

  it('prints real page numbers through a FIXED footer render prop (no static page text)', () => {
    const elements = collectElements(
      CashClosingA4Document({ receipt: makeReceipt() }),
    );
    const pageText = elements.find(
      (element) =>
        element.type === Text && typeof element.props.render === 'function',
    );

    expect(pageText).toBeDefined();
    const render = pageText?.props.render as (info: {
      pageNumber: number;
      totalPages: number;
    }) => string;
    expect(render({ pageNumber: 2, totalPages: 3 })).toBe('Página 2 de 3');
    // The footer container is fixed so it repeats on every physical page.
    const footers = elements.filter(
      (element) =>
        element.type === View &&
        element.props.fixed === true &&
        flattenText(element.props.children as ReactNode).includes('HoundFe'),
    );
    expect(footers.length).toBeGreaterThan(0);
    // Nothing prints a hard-coded «Página i de n».
    expect(renderText()).not.toMatch(/Página \d+ de \d+/);
    expect(DOCUMENT_SOURCE).not.toMatch(/Página \$\{/);
  });

  it('repeats a continuation header only after page 1 (fixed render prop)', () => {
    const header = collectElements(
      CashClosingA4Document({ receipt: makeReceipt() }),
    ).find(
      (element) =>
        element.type === View &&
        element.props.fixed === true &&
        typeof element.props.render === 'function',
    );

    expect(header).toBeDefined();
    const render = header?.props.render as (info: {
      pageNumber: number;
    }) => ReactNode;
    expect(render({ pageNumber: 1 })).toBeNull();
    const continued = render({ pageNumber: 2 });
    // Neutral label: the continuation page may hold notes or signatures.
    expect(flattenText(continued)).toContain('Corte de caja · continuación');
    expect(flattenText(continued)).not.toContain('Entregas y recepciones');
    expect(flattenText(continued)).toContain(FOLIO);
  });

  describe('printed folio (S4)', () => {
    const OLD_UUID_FOLIO = 'CC-3f9a1c2b-5d4e-4f60-8a71-0b2c3d4e5f60';

    it('shortens an old UUID-shaped folio to CC- + the first 8 hex chars', () => {
      expect(formatClosingFolio(OLD_UUID_FOLIO)).toBe('CC-3f9a1c2b');
      expect(formatClosingFolio(OLD_UUID_FOLIO.toUpperCase())).toBe(
        'CC-3F9A1C2B',
      );
    });

    it('prints any other folio verbatim (sequential CC-000124 and legacy ones)', () => {
      expect(formatClosingFolio('CC-000124')).toBe('CC-000124');
      expect(formatClosingFolio(FOLIO)).toBe(FOLIO);
      // Looks like a UUID but has no CC- prefix / is not UUID-shaped.
      expect(formatClosingFolio('3f9a1c2b-5d4e-4f60-8a71-0b2c3d4e5f60')).toBe(
        '3f9a1c2b-5d4e-4f60-8a71-0b2c3d4e5f60',
      );
      expect(formatClosingFolio('CC-3f9a1c2b-extra')).toBe('CC-3f9a1c2b-extra');
    });

    it('prints the shortened folio everywhere in the document, never the UUID', () => {
      const receipt = { ...makeReceipt(), folio: OLD_UUID_FOLIO };
      const element = CashClosingA4Document({ receipt }) as unknown as {
        props: { title: string };
      };
      const text = renderText(receipt);

      expect(element.props.title).toBe('Corte de caja CC-3f9a1c2b');
      expect(text).toContain('Corte de caja CC-3f9a1c2b');
      expect(text).not.toContain('5d4e-4f60');
      expect(text).not.toContain(OLD_UUID_FOLIO);
    });

    it('prints a sequential folio verbatim in header, footer and title', () => {
      const receipt = { ...makeReceipt(), folio: 'CC-000124' };
      const element = CashClosingA4Document({ receipt }) as unknown as {
        props: { title: string };
      };

      expect(element.props.title).toBe('Corte de caja CC-000124');
      expect(renderText(receipt)).toContain('CC-000124');
    });
  });

  it('prints dates in the one A4 format (lowercase month, 24 h, CDMX)', () => {
    const text = renderText();

    // CLOSED_AT 2026-01-15T18:30Z → 12:30 in America/Mexico_City.
    expect(text).toContain('15 ene 2026, 12:30');
    expect(text).not.toMatch(/\b(ENE|FEB)\b/);
  });

  it('prints the business name (default HoundFe) in the footer and continuation header', () => {
    const elements = collectElements(
      CashClosingA4Document({ receipt: makeReceipt() }),
    );
    const footer = elements.find(
      (element) =>
        element.type === View &&
        element.props.fixed === true &&
        typeof element.props.render !== 'function' &&
        flattenText(element.props.children as ReactNode).includes(
          'Corte de caja',
        ),
    );

    expect(flattenText(footer?.props.children as ReactNode)).toContain(
      'HoundFe',
    );
    const images = elements.filter((element) => element.type === Image);
    expect(images.length).toBeGreaterThanOrEqual(1);
    expect(images[0].props.src).toBe(A4_LOGO_PATH);
    expect(flattenText(images[0])).not.toContain('Logo');
    expect(renderText()).not.toMatch(/\bLogo\b/);
  });

  it('groups the closing note, signatures and provenance in ONE non-wrapping block (signatures never alone on a page)', () => {
    const elements = collectElements(
      CashClosingA4Document({ receipt: makeReceipt() }),
    );
    const groups = elements.filter(
      (element) =>
        element.type === View &&
        element.props.wrap === false &&
        flattenText(element.props.children as ReactNode).includes('Cajero ·'),
    );
    const outer = groups.find((element) => {
      const text = flattenText(element.props.children as ReactNode);
      return (
        text.includes('Se retira el excedente.') &&
        text.includes('Verificador ·') &&
        text.includes('corte congelado')
      );
    });

    expect(outer).toBeDefined();
    // The signatures are inside that block, not siblings of it.
    const signatureLines = collectElements(outer?.props.children as ReactNode)
      .filter(
        (element) =>
          element.type === Text &&
          flattenText(element.props.children as ReactNode).includes(' · '),
      )
      .map((element) => flattenText(element.props.children as ReactNode));
    expect(signatureLines.some((line) => line.startsWith('Cajero ·'))).toBe(
      true,
    );
    // No other element carries the signatures outside the group.
    const outside = elements.filter(
      (element) =>
        element.type === Text &&
        flattenText(element.props.children as ReactNode).startsWith('Cajero ·'),
    );
    expect(outside).toHaveLength(1);
  });

  it('renders Spanish audit labels, differences, custody and notes', () => {
    const text = renderText();

    // Header + opening float kept separate from custody withdrawals.
    expect(text).toContain('Comprobante de corte de caja');
    expect(text).toContain('Fondo inicial');
    expect(text).toContain('$500.00');

    // Channel table: expected / declared / verified + both differences.
    expect(text).toContain('Canal');
    expect(text).toContain('Esperado');
    expect(text).toContain('Declarado');
    expect(text).toContain('Verificado');
    expect(text).toContain('Dif. decl. − esp.');
    expect(text).toContain('Dif. verif. − decl.');
    expect(text).toContain('Efectivo');
    expect(text).toContain('Tarjeta');

    // Declaration-expected AND verification-declaration, never combined.
    expect(text).toContain('Diferencia declarado − esperado');
    expect(text).toContain('Diferencia verificado − declarado');
    expect(text).toContain('$10.00 faltante');

    // Names from the snapshot extras (no live lookup).
    expect(text).toContain('Ana Cajera');
    expect(text).toContain('Beto Encargado');
    expect(text).toContain('Carla Supervisora');

    // Custody: FLOAT vs WITHDRAWAL.
    expect(text).toContain('Retiro');
    expect(text).toContain('Fondo (FLOAT)');
    expect(text).toContain('Custodia y entregas');

    // Discrepancy notes preserved verbatim.
    expect(text).toContain('Faltó cambio menudeado.');
    expect(text).toContain('Recuento confirmado por el encargado.');
    expect(text).toContain('Se retira el excedente.');

    // The frozen-snapshot provenance is stated.
    expect(text).toContain('corte congelado');
  });

  describe('people by name, never by UUID (pdf-a4-redesign T2/S1)', () => {
    it('prints the frozen handover names for NEW snapshots', () => {
      const text = renderText(parseCashClosingReceipt(newSnapshotDocument()));

      expect(text).toContain('Ana Cajera');
      expect(text).toContain('Rosa Recibe');
      expect(text).toContain('Paco Confirma');
      expect(text).not.toMatch(UUID_PATTERN);
    });

    it('prints «Usuario sin nombre» for OLD snapshots without any name and never a UUID', () => {
      const text = renderText(parseCashClosingReceipt(oldSnapshotDocument()));

      expect(text).toContain(UNNAMED_USER_LABEL);
      expect(text).not.toMatch(UUID_PATTERN);
      expect(text).not.toContain(CASHIER_ID);
      expect(text).not.toContain(VERIFIER_ID);
      expect(text).not.toContain(CLOSER_ID);
      expect(text).not.toContain(RECEIVER_ID);
      expect(text).not.toContain(SESSION_ID);
      expect(text).not.toContain(REGISTER_ID);
    });

    it('never falls back to the register id when the register has no name', () => {
      const document = makeDocument({});
      const text = renderText(parseCashClosingReceipt(document));

      expect(text).toContain('Caja sin nombre');
      expect(text).not.toContain(REGISTER_ID);
    });

    it('shows a short session reference instead of the full session id', () => {
      const text = renderText();

      expect(text).toContain('SES-22222222');
      expect(text).not.toContain(SESSION_ID);
    });

    it('keeps «—» for a handover without receiver or confirmer (not yet received)', () => {
      const text = renderText(parseCashClosingReceipt(newSnapshotDocument()));

      expect(text).toContain('—');
      expect(text).toContain('Pendiente');
    });
  });

  describe('cash differences (palette L5: warning amber, never red)', () => {
    function amountDocument(
      expected: number,
      declared: number,
      verified: number | null,
    ): ReturnType<typeof makeReceipt> {
      const snapshot = createCashClosingSnapshot({
        session: makeSession(),
        folio: FOLIO,
        expectedCents: expected,
        declaredCents: declared,
        verifiedCents: verified,
        verifierUserId: verified === null ? null : VERIFIER_ID,
        channels: [
          {
            channelKey: 'CASH',
            channelLabel: 'Efectivo',
            method: 'CASH',
            expectedCents: expected,
            declaredCents: declared,
            verifiedCents: verified,
            differenceCents: declared - expected,
          },
        ],
        handovers: [],
        countedAt: COUNTED_AT,
        verifiedAt: verified === null ? null : VERIFIED_AT,
        closedAt: CLOSED_AT,
        closedByUserId: CLOSER_ID,
      });
      return parseCashClosingReceipt(makeDocument({}, snapshot));
    }

    it('writes «$X faltante» in the warning colour', () => {
      const receipt = amountDocument(10_000, 5_000, 5_000);

      expect(renderText(receipt)).toContain('$50.00 faltante');
      const style = textStyleOf(receipt, '$50.00 faltante');
      expect(style.color).toBe(A4_COLORS.warning);
      expect(style.color).toBe('#805511');
    });

    it('writes «$X sobrante» in the warning colour (not green, not red)', () => {
      const receipt = amountDocument(10_000, 10_500, 10_500);

      expect(renderText(receipt)).toContain('$5.00 sobrante');
      expect(textStyleOf(receipt, '$5.00 sobrante').color).toBe('#805511');
    });

    it('prints «Sin diferencia» uncoloured (ink), never a signed zero', () => {
      const receipt = amountDocument(10_000, 10_000, 10_000);

      expect(renderText(receipt)).toContain('Sin diferencia');
      expect(textStyleOf(receipt, 'Sin diferencia').color).toBe(A4_COLORS.ink);
    });

    it('prints «Sin verificar» when the cut was never verified', () => {
      const receipt = amountDocument(10_000, 10_000, null);

      expect(renderText(receipt)).toContain('Sin verificar');
    });

    it('never uses the danger red for differences, and gold only for the mark', () => {
      expect(DOCUMENT_SOURCE).not.toMatch(/#b42318|danger/i);
      expect(DOCUMENT_SOURCE).not.toMatch(/#f6bb13|gold/i);
      expect(KIT_SOURCE.match(/A4_COLORS\.gold/g)).toHaveLength(1);
    });

    it('marks a pending handover reception «Pendiente» in the warning colour', () => {
      const receipt = parseCashClosingReceipt(newSnapshotDocument());

      expect(textStyleOf(receipt, 'Pendiente').color).toBe(A4_COLORS.warning);
    });
  });

  describe('session opening time (cash-redesign-reads T2/S7)', () => {
    const OPENED_AT = '2026-01-15T14:00:00.000Z';

    function withOpenedAt(openedAt: CashJson | undefined): CashDocument {
      const doc = makeDocument();
      const snapshot = { ...(doc.snapshot as Record<string, CashJson>) };
      if (openedAt === undefined) {
        delete snapshot.openedAt;
      } else {
        snapshot.openedAt = openedAt;
      }
      return { ...doc, snapshot };
    }

    it('parses openedAt verbatim and renders it as the opening time', () => {
      const receipt = parseCashClosingReceipt(withOpenedAt(OPENED_AT));

      expect(receipt.snapshot.openedAt).toBe(OPENED_AT);
      const text = renderText(receipt);
      expect(text).toContain('Apertura');
      // America/Mexico_City is UTC−6 in January: 14:00Z → 08:00.
      expect(text).toContain('08:00');
    });

    it.each([
      ['absent (snapshot frozen before T2)', undefined],
      ['null', null],
    ])('reads openedAt %s as null and omits the field', (_label, value) => {
      const receipt = parseCashClosingReceipt(withOpenedAt(value));

      expect(receipt.snapshot.openedAt).toBeNull();
      expect(renderText(receipt)).not.toContain('Apertura');
    });

    it('rejects a malformed openedAt', () => {
      expect(() => parseCashClosingReceipt(withOpenedAt('not-a-date'))).toThrow(
        CashClosingSnapshotParseError,
      );
    });
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
    expect(KIT_SOURCE).toContain("regular: 'Helvetica'");
    expect(KIT_SOURCE).toContain("bold: 'Helvetica-Bold'");
    expect(DOCUMENT_SOURCE).not.toContain('getModernFontFamily');
    expect(DOCUMENT_SOURCE).not.toContain('registerModernFont');
    expect(DOCUMENT_SOURCE).not.toContain('https://');
    expect(DOCUMENT_SOURCE).not.toContain('Image');
    expect(KIT_SOURCE).not.toContain('https://');
    expect(KIT_SOURCE).not.toContain('registerModernFont');
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
