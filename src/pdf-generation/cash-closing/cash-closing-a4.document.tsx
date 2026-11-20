/**
 * cash-register-closing / T5 (S1,S2,S7) + pdf-a4-redesign T2 (S1-S3) —
 * printable A4 closing receipt on the shared A4 kit («libro mayor» artboard).
 *
 * Renders one frozen `CashClosingSnapshot` into an audit-ready PDF. Design
 * rules enforced here:
 *
 *   - Built-in Helvetica only: no font registration, no remote URL, no
 *     branding asset fetch. Deterministic offline rendering.
 *   - ONE wrapping `<Page>`: react-pdf paginates naturally; the footer is
 *     fixed with real `Página X de Y` numbers and pages 2+ repeat a compact
 *     header. No manual chunking, no static page text.
 *   - Declared vs expected AND verified vs declared are two INDEPENDENT
 *     difference columns. They are never collapsed into one number.
 *   - Differences print the word («$50.00 faltante» / «$5.00 sobrante») in
 *     the warning colour, «Sin diferencia» uncoloured — never red.
 *   - Combined totals are labelled as a cut summary, never as "physical
 *     cash" or profit; the cash channel is called out as the pooled drawer.
 *   - Opening float is shown separately from custody FLOAT/WITHDRAWAL.
 *   - People are printed by NAME. A user id (UUID) is never printed: an
 *     actor without a resolvable name reads «Usuario sin nombre».
 */
import { Document, StyleSheet, Text, View } from '@react-pdf/renderer';
import {
  A4KeyValueColumns,
  A4MetaBar,
  A4Page,
  A4PageHeader,
  A4Section,
  formatA4DateTime,
  formatA4Money,
  A4_COLORS,
  A4_FONTS,
  px,
  LedgerTable,
  type A4KeyValueItem,
  type LedgerCell,
  type LedgerColumn,
  type LedgerRowData,
} from '../templates/shared/a4-kit';
import type { CashSnapshotHandover } from '../../cash-register/domain/cash-snapshot';
import type {
  CashClosingPdfDocumentProps,
  CashClosingReceiptHandover,
  CashClosingReceiptSnapshot,
  CashHandoverTotals,
} from './cash-closing-receipt.types';

/** Printed when an actor's name is not in the snapshot nor resolvable. */
export const UNNAMED_USER_LABEL = 'Usuario sin nombre';

/** declared − expected for one channel or the cut totals. */
export function declarationVsExpectedCents(
  expectedCents: number,
  declaredCents: number,
): number {
  return declaredCents - expectedCents;
}

/** verified − declared, or `null` when the cut was never independently verified. */
export function verificationVsDeclarationCents(
  declaredCents: number,
  verifiedCents: number | null,
): number | null {
  return verifiedCents === null ? null : verifiedCents - declaredCents;
}

/** Split `FLOAT` (retained) from `WITHDRAWAL` (leaves the drawer). */
export function summarizeCashHandovers(
  handovers: readonly CashSnapshotHandover[],
): CashHandoverTotals {
  let floatDeclaredCents = 0;
  let floatReceivedCents = 0;
  let floatPendingCount = 0;
  let withdrawalDeclaredCents = 0;
  let withdrawalReceivedCents = 0;
  let withdrawalPendingCount = 0;

  for (const handover of handovers) {
    if (handover.kind === 'FLOAT') {
      floatDeclaredCents += handover.declaredCents;
      if (handover.receivedCents === null) {
        floatPendingCount += 1;
      } else {
        floatReceivedCents += handover.receivedCents;
      }
    } else {
      withdrawalDeclaredCents += handover.declaredCents;
      if (handover.receivedCents === null) {
        withdrawalPendingCount += 1;
      } else {
        withdrawalReceivedCents += handover.receivedCents;
      }
    }
  }

  return {
    floatDeclaredCents,
    floatReceivedCents,
    floatPendingCount,
    withdrawalDeclaredCents,
    withdrawalReceivedCents,
    withdrawalPendingCount,
  };
}

const OLD_UUID_FOLIO =
  /^CC-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Printed folio. Old closings carry a UUID-shaped `CC-<uuid>` folio, which
 * prints shortened to `CC-` + its first 8 hex characters (`CC-3f9a1c2b`); any
 * other folio (e.g. the sequential `CC-000124`) prints verbatim.
 */
export function formatClosingFolio(folio: string): string {
  const match = OLD_UUID_FOLIO.exec(folio);
  return match ? `CC-${match[1]}` : folio;
}

export function CashClosingA4Document({
  receipt,
}: CashClosingPdfDocumentProps) {
  const { snapshot } = receipt;
  const folio = formatClosingFolio(receipt.folio);

  return (
    <Document
      title={`Corte de caja ${folio}`}
      author="HoundFe"
      creator="HoundFe"
      producer="HoundFe"
      creationDate={new Date(snapshot.closedAt)}
      modificationDate={new Date(snapshot.closedAt)}
    >
      <A4Page
        footerLabel={`Corte de caja ${folio}`}
        continuation={{
          kicker: 'Corte de caja · continuación',
          folio,
          brandSubtitle: 'Comprobante de corte de caja',
        }}
      >
        <A4PageHeader
          subtitle="Comprobante de corte de caja"
          kicker="Corte de caja"
          folio={folio}
        />
        <A4MetaBar
          items={[
            { label: 'Cierre', value: formatA4DateTime(snapshot.closedAt) },
            {
              label: 'Caja',
              value: snapshot.registerName ?? 'Caja sin nombre',
            },
          ]}
        />
        <MetaSection snapshot={snapshot} />
        <ChannelSection snapshot={snapshot} />
        <CustodySection snapshot={snapshot} />
        <HandoverSection snapshot={snapshot} />
        <DiscrepancyNotes snapshot={snapshot} />
      </A4Page>
    </Document>
  );
}

/** Short, human-friendly session reference — never the full session id. */
function sessionRef(sessionId: string): string {
  return `SES-${sessionId.split('-')[0].slice(0, 8).toUpperCase()}`;
}

/** Name when known; otherwise a fixed label — an id is never printed. */
function actorLabel(name: string | null, userId: string | null): string {
  if (userId === null) {
    return '—';
  }
  return name ?? UNNAMED_USER_LABEL;
}

function chunkColumns<T>(items: readonly T[], columns: number): T[][] {
  const size = Math.ceil(items.length / columns);
  return Array.from({ length: columns }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  ).filter((column) => column.length > 0);
}

function MetaSection({ snapshot }: { snapshot: CashClosingReceiptSnapshot }) {
  const items: A4KeyValueItem[] = [
    { label: 'Sesión', value: sessionRef(snapshot.sessionId) },
    {
      label: 'Cajero',
      value: actorLabel(snapshot.cashierName, snapshot.cashierUserId),
    },
    {
      label: 'Verificador',
      value:
        snapshot.verifiedCents === null
          ? 'Sin verificar'
          : actorLabel(snapshot.verifierName, snapshot.verifierUserId),
    },
    {
      label: 'Cerró',
      value: actorLabel(snapshot.closedByName, snapshot.closedByUserId),
    },
    ...(snapshot.openedAt === null
      ? []
      : [{ label: 'Apertura', value: formatA4DateTime(snapshot.openedAt) }]),
    { label: 'Conteo', value: formatA4DateTime(snapshot.countedAt) },
    {
      label: 'Verificación',
      value:
        snapshot.verifiedAt === null
          ? 'Pendiente'
          : formatA4DateTime(snapshot.verifiedAt),
    },
    { label: 'Cierre', value: formatA4DateTime(snapshot.closedAt) },
    { label: 'Fondo inicial', value: formatA4Money(snapshot.openingCents) },
  ];
  return (
    <A4Section
      title="Datos del corte"
      hint="Fondo inicial (apertura): se cuenta una sola vez y se reporta por separado de los retiros de custodia."
    >
      <A4KeyValueColumns columns={chunkColumns(items, 3)} />
    </A4Section>
  );
}

const CHANNEL_COLUMNS: readonly LedgerColumn[] = [
  { key: 'channel', label: 'Canal', flex: 1.6 },
  { key: 'expected', label: 'Esperado', flex: 1.25, align: 'right' },
  { key: 'declared', label: 'Declarado', flex: 1.25, align: 'right' },
  { key: 'verified', label: 'Verificado', flex: 1.25, align: 'right' },
  { key: 'declDiff', label: 'Dif. decl. − esp.', flex: 1.25, align: 'right' },
  {
    key: 'verifDiff',
    label: 'Dif. verif. − decl.',
    flex: 1.25,
    align: 'right',
  },
];

function ChannelSection({
  snapshot,
}: {
  snapshot: CashClosingReceiptSnapshot;
}) {
  const rows: LedgerRowData[] = snapshot.channels.map((channel) => ({
    key: channel.channelKey,
    cells: {
      channel: channel.channelLabel,
      expected: formatA4Money(channel.expectedCents),
      declared: formatA4Money(channel.declaredCents),
      verified: formatOptionalCurrency(channel.verifiedCents),
      declDiff: differenceCell(
        declarationVsExpectedCents(
          channel.expectedCents,
          channel.declaredCents,
        ),
      ),
      verifDiff: differenceCell(
        verificationVsDeclarationCents(
          channel.declaredCents,
          channel.verifiedCents,
        ),
      ),
    },
  }));
  const total: LedgerRowData = {
    key: 'total',
    cells: {
      channel: 'Totales del corte',
      expected: { text: formatA4Money(snapshot.expectedCents), bold: true },
      declared: { text: formatA4Money(snapshot.declaredCents), bold: true },
      verified: {
        text: formatOptionalCurrency(snapshot.verifiedCents),
        bold: true,
      },
      declDiff: differenceCell(
        declarationVsExpectedCents(
          snapshot.expectedCents,
          snapshot.declaredCents,
        ),
        'Diferencia declarado − esperado',
      ),
      verifDiff: differenceCell(
        verificationVsDeclarationCents(
          snapshot.declaredCents,
          snapshot.verifiedCents,
        ),
        'Diferencia verificado − declarado',
      ),
    },
  };
  return (
    <A4Section
      title="Detalle por canal"
      aside="Cierre: totales del corte en la última fila"
      hint="El canal Efectivo agrupa el total físico del cajón; los demás canales se reportan por separado."
    >
      <LedgerTable
        columns={CHANNEL_COLUMNS}
        rows={rows}
        total={total}
        emptyText="Sin canales registrados en el corte."
      />
    </A4Section>
  );
}

function CustodySection({
  snapshot,
}: {
  snapshot: CashClosingReceiptSnapshot;
}) {
  const totals = summarizeCashHandovers(snapshot.handovers);
  return (
    <A4Section
      title="Custodia y entregas"
      hint="El fondo retenido (FLOAT) inicia la siguiente apertura; los retiros (WITHDRAWAL) salen del cajón. No se suman entre sí ni con el fondo inicial."
    >
      <A4KeyValueColumns
        columns={[
          [
            {
              label: 'Retiros declarados',
              value: formatA4Money(totals.withdrawalDeclaredCents),
            },
            {
              label: 'Retiros recibidos',
              value: formatReceived(
                totals.withdrawalReceivedCents,
                totals.withdrawalPendingCount,
              ),
            },
          ],
          [
            {
              label: 'Fondo retenido declarado',
              value: formatA4Money(totals.floatDeclaredCents),
            },
            {
              label: 'Fondo retenido recibido',
              value: formatReceived(
                totals.floatReceivedCents,
                totals.floatPendingCount,
              ),
            },
          ],
        ]}
      />
    </A4Section>
  );
}

const HANDOVER_COLUMNS: readonly LedgerColumn[] = [
  { key: 'kind', label: 'Tipo', flex: 0.95 },
  { key: 'sender', label: 'Entrega', flex: 1.45 },
  { key: 'receiver', label: 'Recibe', flex: 1.45 },
  { key: 'actor', label: 'Confirma', flex: 1.45 },
  { key: 'declared', label: 'Declarado', flex: 1.25, align: 'right' },
  { key: 'received', label: 'Recibido', flex: 1.25, align: 'right' },
];

function handoverRow(handover: CashClosingReceiptHandover): LedgerRowData {
  return {
    key: handover.handoverId,
    cells: {
      kind: handoverKindLabel(handover.kind),
      sender: actorLabel(handover.senderName, handover.senderUserId),
      receiver: actorLabel(handover.receiverName, handover.receiverUserId),
      actor: actorLabel(handover.receiptActorName, handover.receiptActorUserId),
      declared: {
        text: formatA4Money(handover.declaredCents),
        bold: true,
        sub: formatA4DateTime(handover.declaredAt),
      },
      received:
        handover.receivedCents === null
          ? { text: 'Pendiente', tone: 'warning', bold: true }
          : {
              text: formatA4Money(handover.receivedCents),
              bold: true,
              sub:
                handover.receivedAt === null
                  ? undefined
                  : formatA4DateTime(handover.receivedAt),
            },
    },
  };
}

function HandoverSection({
  snapshot,
}: {
  snapshot: CashClosingReceiptSnapshot;
}) {
  const count = snapshot.handovers.length;
  return (
    <A4Section
      title="Entregas y recepciones"
      aside={
        count === 0
          ? undefined
          : `${count} ${count === 1 ? 'registro' : 'registros'}`
      }
    >
      <LedgerTable
        columns={HANDOVER_COLUMNS}
        rows={snapshot.handovers.map(handoverRow)}
        emptyText="Sin movimientos de custodia registrados en el corte."
      />
    </A4Section>
  );
}

/**
 * Notes + closing block. The closing note, the signatures and the provenance
 * line live in ONE non-wrapping `<View>`: react-pdf moves the whole block to
 * the next page when it does not fit, so the signature lines can never land
 * alone on a page (they always carry the closing note above them).
 * `minPresenceAhead` on the signatures alone does not achieve this.
 */
function DiscrepancyNotes({
  snapshot,
}: {
  snapshot: CashClosingReceiptSnapshot;
}) {
  return (
    <A4Section title="Notas de diferencia">
      <Note
        label="Declaración"
        value={snapshot.declarationNotes}
        empty="Sin notas de declaración."
      />
      <Note
        label="Verificación"
        value={snapshot.verificationNotes}
        empty="Sin notas de verificación."
      />
      <View style={styles.closingBlock} wrap={false}>
        <Note
          label="Cierre"
          value={snapshot.closingNotes}
          empty="Sin notas de cierre."
        />
        <Signatures snapshot={snapshot} />
        <Text style={styles.provenance}>
          Documento generado a partir del corte congelado. No se recalcula con
          movimientos, pagos ni cancelaciones posteriores.
        </Text>
      </View>
    </A4Section>
  );
}

/**
 * Label + text are FLAT siblings inside the section (no wrapper View): the
 * label's `minPresenceAhead` only moves it to the next page when it has a
 * previous sibling to break away from, so a label never ends a page alone.
 */
function Note({
  label,
  value,
  empty,
}: {
  label: string;
  value: string | null;
  empty: string;
}) {
  return (
    <>
      <View minPresenceAhead={44}>
        <Text style={styles.noteLabel}>{label}</Text>
      </View>
      <Text style={styles.noteValue}>{value ?? empty}</Text>
    </>
  );
}

function Signatures({ snapshot }: { snapshot: CashClosingReceiptSnapshot }) {
  return (
    <View style={styles.signatures} wrap={false}>
      <Text style={styles.signature}>
        {`Cajero · ${actorLabel(snapshot.cashierName, snapshot.cashierUserId)}`}
      </Text>
      <Text style={styles.signature}>
        {snapshot.verifiedCents === null
          ? 'Verificador · Sin verificar'
          : `Verificador · ${actorLabel(snapshot.verifierName, snapshot.verifierUserId)}`}
      </Text>
    </View>
  );
}

const palette = A4_COLORS;

const styles = StyleSheet.create({
  closingBlock: { flexDirection: 'column' },
  noteLabel: {
    paddingTop: px(8),
    fontFamily: A4_FONTS.bold,
    fontSize: px(10.5),
    letterSpacing: px(10.5) * 0.06,
    textTransform: 'uppercase',
    color: palette.muted,
  },
  noteValue: {
    fontSize: px(12),
    paddingTop: px(2),
    paddingBottom: px(8),
    borderBottomWidth: px(1),
    borderBottomColor: palette.border,
    borderBottomStyle: 'solid',
    lineHeight: 1.4,
    color: palette.ink,
  },
  signatures: { flexDirection: 'row', marginTop: px(46) },
  signature: {
    flex: 1,
    marginRight: px(26),
    paddingTop: px(5),
    borderTopWidth: px(1),
    borderTopColor: palette.strong,
    borderTopStyle: 'solid',
    fontSize: px(10.5),
    color: palette.muted,
  },
  provenance: {
    fontSize: px(10),
    fontStyle: 'italic',
    color: palette.muted,
    marginTop: px(12),
    lineHeight: 1.4,
  },
});

/**
 * Cash difference: «$X faltante» / «$X sobrante» in the warning colour with
 * the word written (never red); «Sin diferencia» uncoloured; `—` when the
 * cut was never independently verified.
 */
export function differenceCell(cents: number | null, sub?: string): LedgerCell {
  if (cents === null) {
    return { text: '—', sub };
  }
  if (cents === 0) {
    return { text: 'Sin diferencia', sub };
  }
  return {
    text: `${formatA4Money(Math.abs(cents))} ${cents < 0 ? 'faltante' : 'sobrante'}`,
    tone: 'warning',
    bold: true,
    sub,
  };
}

function handoverKindLabel(kind: CashSnapshotHandover['kind']): string {
  return kind === 'FLOAT' ? 'Fondo (FLOAT)' : 'Retiro';
}

function formatOptionalCurrency(cents: number | null): string {
  return cents === null ? '—' : formatA4Money(cents);
}

function formatReceived(amountCents: number, pendingCount: number): string {
  const base = formatA4Money(amountCents);
  if (pendingCount === 0) {
    return base;
  }
  return `${base}${pendingCount === 1 ? ' (1 pendiente)' : ` (${pendingCount} pendientes)`}`;
}
