/**
 * cash-register-closing / T5 (S1,S2,S7) — printable A4 closing receipt.
 *
 * Renders one frozen `CashClosingSnapshot` into an audit-ready PDF. Design
 * rules enforced here:
 *
 *   - Built-in Helvetica only: no font registration, no remote URL, no
 *     branding asset fetch. Deterministic offline rendering.
 *   - Declared vs expected AND verified vs declared are two INDEPENDENT
 *     difference columns. They are never collapsed into one number.
 *   - Combined totals are labelled as a cut summary, never as "physical
 *     cash" or profit; the cash channel is called out as the pooled drawer.
 *   - Opening float is shown separately from custody FLOAT/WITHDRAWAL.
 *   - Actor rows show the stable user id (plus the snapshot's name when it
 *     offers one). Nothing is looked up live.
 *   - Handovers paginate across explicit pages with a repeated table header
 *     and a `Página X de Y` footer.
 */
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { PAPER_SIZES } from '../pdf-generation.constants';
import { SHARED_STYLES } from '../templates/shared/styles';
import type { CashSnapshotHandover } from '../../cash-register/domain/cash-snapshot';
import {
  CASH_CLOSING_HANDOVERS_FIRST_PAGE,
  CASH_CLOSING_HANDOVERS_PAGE,
  type CashClosingPdfDocumentProps,
  type CashClosingReceiptSnapshot,
  type CashHandoverTotals,
} from './cash-closing-receipt.types';

export { CASH_CLOSING_HANDOVERS_FIRST_PAGE, CASH_CLOSING_HANDOVERS_PAGE };

const CLOSING_TIME_ZONE = 'America/Mexico_City';

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

/**
 * Chunk handovers into pages: the summary page carries a smaller first
 * budget (channels + totals share the page). An empty list still yields one
 * (empty) page so the template always has a page to render.
 */
export function paginateCashClosingHandovers<T>(
  handovers: readonly T[],
): T[][] {
  if (handovers.length === 0) {
    return [[]];
  }

  const pages: T[][] = [];
  let budget = CASH_CLOSING_HANDOVERS_FIRST_PAGE;
  let current: T[] = [];

  for (const handover of handovers) {
    if (current.length >= budget) {
      pages.push(current);
      current = [];
      budget = CASH_CLOSING_HANDOVERS_PAGE;
    }
    current.push(handover);
  }

  pages.push(current);
  return pages;
}

export function CashClosingA4Document({
  receipt,
}: CashClosingPdfDocumentProps) {
  const { snapshot } = receipt;
  const handoverPages = paginateCashClosingHandovers(snapshot.handovers);
  const totalPages = handoverPages.length;
  const hasHandovers = snapshot.handovers.length > 0;

  return (
    <Document
      title={`Corte de caja ${receipt.folio}`}
      author="HoundFe"
      creator="HoundFe"
      producer="HoundFe"
      creationDate={new Date(snapshot.closedAt)}
      modificationDate={new Date(snapshot.closedAt)}
    >
      {handoverPages.map((rows, index) => (
        <Page
          key={`closing-${index}`}
          size={{ width: PAPER_SIZES.A4.width, height: PAPER_SIZES.A4.height }}
          style={[SHARED_STYLES.modern.page, styles.page]}
        >
          {index === 0 ? (
            <ClosingSummary receipt={receipt} />
          ) : (
            <ContinuationHeader receipt={receipt} />
          )}

          <HandoverSection rows={rows} empty={!hasHandovers} />

          {index === totalPages - 1 ? (
            <DiscrepancyNotes snapshot={snapshot} />
          ) : null}

          <Text style={styles.footer}>
            {`Página ${index + 1} de ${totalPages}`}
          </Text>
        </Page>
      ))}
    </Document>
  );
}

function ClosingSummary({ receipt }: CashClosingPdfDocumentProps) {
  const { snapshot } = receipt;
  return (
    <View>
      <BrandHeader receipt={receipt} />
      <MetaCard snapshot={snapshot} />
      <OpeningFloat snapshot={snapshot} />
      <ChannelSection snapshot={snapshot} />
      <TotalsSection snapshot={snapshot} />
      <CustodySummary snapshot={snapshot} />
      <Text style={styles.provenance}>
        Documento generado a partir del corte congelado. No se recalcula con
        movimientos, pagos ni cancelaciones posteriores.
      </Text>
    </View>
  );
}

function ContinuationHeader({ receipt }: CashClosingPdfDocumentProps) {
  return (
    <View style={styles.headerRow}>
      <View>
        <Text style={SHARED_STYLES.modern.header.companyName}>HoundFe</Text>
        <Text style={SHARED_STYLES.modern.header.companySub}>
          Comprobante de corte de caja
        </Text>
      </View>
      <View
        style={[SHARED_STYLES.modern.cardCompact, { alignItems: 'flex-end' }]}
      >
        <Text style={SHARED_STYLES.modern.header.metaTitle}>
          ENTREGAS Y RECEPCIONES
        </Text>
        <Text style={styles.metaFolio}>{receipt.folio}</Text>
      </View>
    </View>
  );
}

function BrandHeader({ receipt }: CashClosingPdfDocumentProps) {
  return (
    <View style={styles.headerRow}>
      <View>
        <Text style={SHARED_STYLES.modern.header.companyName}>HoundFe</Text>
        <Text style={SHARED_STYLES.modern.header.companySub}>
          Comprobante de corte de caja
        </Text>
      </View>
      <View
        style={[SHARED_STYLES.modern.cardCompact, { alignItems: 'flex-end' }]}
      >
        <Text style={SHARED_STYLES.modern.header.metaTitle}>CORTE DE CAJA</Text>
        <Text style={styles.metaFolio}>{receipt.folio}</Text>
        <Text style={SHARED_STYLES.modern.header.metaDate}>
          {`Cierre ${formatInstant(receipt.snapshot.closedAt)}`}
        </Text>
      </View>
    </View>
  );
}

function MetaCard({ snapshot }: { snapshot: CashClosingReceiptSnapshot }) {
  return (
    <View style={[SHARED_STYLES.modern.card, styles.metaCard]}>
      <Field
        label="Caja"
        value={snapshot.registerName ?? snapshot.registerId}
      />
      <Field label="Sesión" value={snapshot.sessionId} />
      <Field
        label="Cajero"
        actor={{ name: snapshot.cashierName, id: snapshot.cashierUserId }}
      />
      <Field
        label="Verificador"
        actor={
          snapshot.verifiedCents === null
            ? null
            : { name: snapshot.verifierName, id: snapshot.verifierUserId }
        }
      />
      <Field
        label="Cerró"
        actor={{ name: snapshot.closedByName, id: snapshot.closedByUserId }}
      />
      <Field label="Conteo" value={formatInstant(snapshot.countedAt)} />
      <Field
        label="Verificación"
        value={
          snapshot.verifiedAt === null
            ? 'Pendiente'
            : formatInstant(snapshot.verifiedAt)
        }
      />
      <Field label="Cierre" value={formatInstant(snapshot.closedAt)} />
    </View>
  );
}

function Field({
  label,
  value,
  actor,
}: {
  label: string;
  value?: string;
  actor?: { name: string | null; id: string | null } | null;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.metaLabel}>{label}</Text>
      {actor === undefined ? (
        <Text style={styles.metaValue}>{value}</Text>
      ) : (
        <ActorValue actor={actor} />
      )}
    </View>
  );
}

function ActorValue({
  actor,
}: {
  actor: { name: string | null; id: string | null } | null;
}) {
  if (actor === null || actor.id === null) {
    return <Text style={styles.metaValue}>Sin verificar</Text>;
  }
  if (actor.name === null) {
    return <Text style={styles.metaValue}>{actor.id}</Text>;
  }
  return (
    <View>
      <Text style={styles.metaValue}>{actor.name}</Text>
      <Text style={styles.metaId}>{actor.id}</Text>
    </View>
  );
}

function OpeningFloat({ snapshot }: { snapshot: CashClosingReceiptSnapshot }) {
  return (
    <View style={[SHARED_STYLES.modern.card, { marginBottom: 12 }]}>
      <Text style={styles.sectionLabel}>FONDO INICIAL (APERTURA)</Text>
      <Text style={styles.openingValue}>
        {formatCurrency(snapshot.openingCents)}
      </Text>
      <Text style={styles.notice}>
        Se cuenta una sola vez y se reporta por separado de los retiros de
        custodia.
      </Text>
    </View>
  );
}

function ChannelSection({
  snapshot,
}: {
  snapshot: CashClosingReceiptSnapshot;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Detalle por canal</Text>
      <Text style={styles.notice}>
        El canal Efectivo agrupa el total físico del cajón; los demás canales se
        reportan por separado.
      </Text>
      <View style={styles.tableHeader}>
        <Text style={[styles.headerCell, styles.colChannel]}>CANAL</Text>
        <Text style={[styles.headerCell, styles.colMoney]}>ESPERADO</Text>
        <Text style={[styles.headerCell, styles.colMoney]}>DECLARADO</Text>
        <Text style={[styles.headerCell, styles.colMoney]}>VERIFICADO</Text>
        <Text style={[styles.headerCell, styles.colMoney]}>
          DIF. DECL. − ESP.
        </Text>
        <Text style={[styles.headerCell, styles.colMoney]}>
          DIF. VERIF. − DECL.
        </Text>
      </View>
      {snapshot.channels.length === 0 ? (
        <Text style={styles.empty}>Sin canales registrados en el corte.</Text>
      ) : (
        snapshot.channels.map((channel) => (
          <View key={channel.channelKey} style={styles.row} wrap={false}>
            <Text style={[styles.cell, styles.colChannel]}>
              {channel.channelLabel}
            </Text>
            <Text style={[styles.cell, styles.colMoney]}>
              {formatCurrency(channel.expectedCents)}
            </Text>
            <Text style={[styles.cell, styles.colMoney]}>
              {formatCurrency(channel.declaredCents)}
            </Text>
            <Text style={[styles.cell, styles.colMoney]}>
              {formatOptionalCurrency(channel.verifiedCents)}
            </Text>
            <Text style={[styles.cell, styles.colMoney]}>
              {formatCurrency(
                declarationVsExpectedCents(
                  channel.expectedCents,
                  channel.declaredCents,
                ),
              )}
            </Text>
            <Text style={[styles.cell, styles.colMoney]}>
              {formatOptionalCurrency(
                verificationVsDeclarationCents(
                  channel.declaredCents,
                  channel.verifiedCents,
                ),
              )}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

function TotalsSection({ snapshot }: { snapshot: CashClosingReceiptSnapshot }) {
  return (
    <View style={[SHARED_STYLES.modern.card, { marginBottom: 12 }]}>
      <Text style={styles.sectionLabel}>TOTALES DEL CORTE</Text>
      <Row label="Esperado" value={formatCurrency(snapshot.expectedCents)} />
      <Row label="Declarado" value={formatCurrency(snapshot.declaredCents)} />
      <Row
        label="Verificado"
        value={formatOptionalCurrency(snapshot.verifiedCents)}
      />
      <Row
        label="Diferencia declarado − esperado"
        value={formatCurrency(
          declarationVsExpectedCents(
            snapshot.expectedCents,
            snapshot.declaredCents,
          ),
        )}
      />
      <Row
        label="Diferencia verificado − declarado"
        value={formatOptionalCurrency(
          verificationVsDeclarationCents(
            snapshot.declaredCents,
            snapshot.verifiedCents,
          ),
        )}
      />
    </View>
  );
}

function CustodySummary({
  snapshot,
}: {
  snapshot: CashClosingReceiptSnapshot;
}) {
  const totals = summarizeCashHandovers(snapshot.handovers);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Custodia y entregas</Text>
      <Text style={styles.notice}>
        El fondo retenido (FLOAT) inicia la siguiente apertura; los retiros
        (WITHDRAWAL) salen del cajón. No se suman entre sí ni con el fondo
        inicial.
      </Text>
      <Row
        label="Retiros declarados"
        value={formatCurrency(totals.withdrawalDeclaredCents)}
      />
      <Row
        label="Retiros recibidos"
        value={formatReceived(
          totals.withdrawalReceivedCents,
          totals.withdrawalPendingCount,
        )}
      />
      <Row
        label="Fondo retenido declarado"
        value={formatCurrency(totals.floatDeclaredCents)}
      />
      <Row
        label="Fondo retenido recibido"
        value={formatReceived(
          totals.floatReceivedCents,
          totals.floatPendingCount,
        )}
      />
    </View>
  );
}

function HandoverSection({
  rows,
  empty,
}: {
  rows: CashSnapshotHandover[];
  empty: boolean;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Entregas y recepciones</Text>
      <View style={styles.tableHeader}>
        <Text style={[styles.headerCell, styles.colKind]}>TIPO</Text>
        <Text style={[styles.headerCell, styles.colMoney]}>DECLARADO</Text>
        <Text style={[styles.headerCell, styles.colMoney]}>RECIBIDO</Text>
        <Text style={[styles.headerCell, styles.colActor]}>ENTREGA</Text>
        <Text style={[styles.headerCell, styles.colActor]}>RECIBE</Text>
        <Text style={[styles.headerCell, styles.colActor]}>CONFIRMA</Text>
        <Text style={[styles.headerCell, styles.colDate]}>DECLARADO EN</Text>
        <Text style={[styles.headerCell, styles.colDate]}>RECIBIDO EN</Text>
      </View>
      {empty ? (
        <Text style={styles.empty}>
          Sin movimientos de custodia registrados en el corte.
        </Text>
      ) : (
        rows.map((handover) => (
          <View key={handover.handoverId} style={styles.row} wrap={false}>
            <Text style={[styles.cell, styles.colKind]}>
              {handoverKindLabel(handover.kind)}
            </Text>
            <Text style={[styles.cell, styles.colMoney]}>
              {formatCurrency(handover.declaredCents)}
            </Text>
            <Text style={[styles.cell, styles.colMoney]}>
              {handover.receivedCents === null
                ? 'Pendiente'
                : formatCurrency(handover.receivedCents)}
            </Text>
            <Text style={[styles.cell, styles.colActor]}>
              {handover.senderUserId}
            </Text>
            <Text style={[styles.cell, styles.colActor]}>
              {handover.receiverUserId ?? '—'}
            </Text>
            <Text style={[styles.cell, styles.colActor]}>
              {handover.receiptActorUserId ?? '—'}
            </Text>
            <Text style={[styles.cell, styles.colDate]}>
              {formatInstant(handover.declaredAt)}
            </Text>
            <Text style={[styles.cell, styles.colDate]}>
              {handover.receivedAt === null
                ? 'Pendiente'
                : formatInstant(handover.receivedAt)}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

function DiscrepancyNotes({
  snapshot,
}: {
  snapshot: CashClosingReceiptSnapshot;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Notas de diferencia</Text>
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
      <Note
        label="Cierre"
        value={snapshot.closingNotes}
        empty="Sin notas de cierre."
      />
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

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
    <View style={styles.noteRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.noteValue}>{value ?? empty}</Text>
    </View>
  );
}

const palette = SHARED_STYLES.modern.palette;

const styles = StyleSheet.create({
  page: {
    // Built-in family only — deterministic offline render (no font CDN).
    fontFamily: 'Helvetica',
    paddingBottom: 40,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  metaCard: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  field: {
    width: '50%',
    marginBottom: 8,
    paddingRight: 8,
  },
  metaLabel: {
    fontSize: 7.5,
    fontWeight: 700,
    color: palette.gray,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  metaValue: {
    fontSize: 9,
    fontWeight: 600,
    color: palette.ink,
    marginTop: 1,
  },
  metaId: {
    fontSize: 7.5,
    color: palette.grayLight,
  },
  metaFolio: {
    fontSize: 10,
    fontWeight: 700,
    color: palette.ink,
    marginTop: 3,
  },
  sectionLabel: {
    fontSize: 8,
    fontWeight: 700,
    color: palette.gray,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  openingValue: {
    fontSize: 18,
    fontWeight: 700,
    color: palette.accent,
    marginTop: 2,
  },
  section: {
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 9,
    fontWeight: 700,
    color: palette.ink,
    marginBottom: 4,
  },
  notice: {
    fontSize: 7.5,
    color: palette.gray,
    lineHeight: 1.4,
    marginBottom: 4,
  },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
    borderBottomStyle: 'solid',
    paddingBottom: 4,
    marginBottom: 2,
  },
  headerCell: {
    fontSize: 6.5,
    fontWeight: 700,
    color: palette.gray,
    letterSpacing: 0.2,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderBottomWidth: 1,
    borderBottomColor: palette.surface,
    borderBottomStyle: 'solid',
    paddingVertical: 4,
  },
  cell: {
    fontSize: 7,
    color: palette.inkSoft,
  },
  colChannel: {
    flex: 1.6,
    paddingRight: 4,
  },
  colKind: {
    flex: 1.4,
    paddingRight: 4,
  },
  colActor: {
    flex: 1.6,
    paddingRight: 4,
  },
  colDate: {
    flex: 1.5,
    paddingRight: 4,
  },
  colMoney: {
    flex: 1.2,
    textAlign: 'right',
    paddingRight: 4,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 2,
  },
  summaryLabel: {
    fontSize: 8.5,
    color: palette.gray,
  },
  summaryValue: {
    fontSize: 9,
    fontWeight: 600,
    color: palette.ink,
  },
  noteRow: {
    marginBottom: 6,
  },
  noteValue: {
    fontSize: 8.5,
    color: palette.inkSoft,
    marginTop: 1,
  },
  empty: {
    fontSize: 8.5,
    color: palette.gray,
    fontStyle: 'italic',
    marginTop: 4,
  },
  provenance: {
    fontSize: 7,
    color: palette.gray,
    fontStyle: 'italic',
    marginTop: 4,
  },
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
    textAlign: 'center',
    fontSize: 7.5,
    color: palette.grayLight,
  },
});

function handoverKindLabel(kind: CashSnapshotHandover['kind']): string {
  return kind === 'FLOAT' ? 'Fondo (FLOAT)' : 'Retiro';
}

function formatCurrency(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const [whole, decimals] = (Math.abs(cents) / 100).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${grouped}.${decimals}`;
}

function formatOptionalCurrency(cents: number | null): string {
  return cents === null ? '—' : formatCurrency(cents);
}

function formatReceived(amountCents: number, pendingCount: number): string {
  const base = formatCurrency(amountCents);
  if (pendingCount === 0) {
    return base;
  }
  return `${base}${pendingCount === 1 ? ' (1 pendiente)' : ` (${pendingCount} pendientes)`}`;
}

function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  try {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone: CLOSING_TIME_ZONE,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(date)
      .replace(/\./g, '')
      .toUpperCase();
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}
