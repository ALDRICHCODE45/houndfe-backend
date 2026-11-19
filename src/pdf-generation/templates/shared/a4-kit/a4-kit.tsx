/**
 * A4 kit — components (pdf-a4-redesign T2, artboard 01-libro-mayor).
 *
 * Ledger / minimal: no fills, no cards. Building blocks shared by the four
 * A4 documents: page shell with FIXED footer (real `Página X de Y` through
 * react-pdf's `render` prop) and a repeated continuation header, page header,
 * section title, key/value columns, ledger table and totals block.
 *
 * Pagination is natural: one wrapping `<Page>`; rows are `wrap={false}` so a
 * row never splits across pages.
 */
import { Page, Text, View } from '@react-pdf/renderer';
import type { ReactNode } from 'react';
import { PAPER_SIZES } from '../../../pdf-generation.constants';
import { A4_STYLES as s } from './a4-styles';
import { A4_FONTS, toneColor, type A4Tone } from './tokens';

export interface A4Continuation {
  /** Right-hand kicker of the repeated header (e.g. «Entregas y recepciones»). */
  readonly kicker: string;
  readonly folio: string;
  readonly brandSubtitle: string;
}

export interface A4PageProps {
  readonly children: ReactNode;
  /** Footer left text after «HoundFe ·» (e.g. «Corte de caja CC-1»). */
  readonly footerLabel: string;
  /** When set, pages 2+ repeat a compact header (fixed). */
  readonly continuation?: A4Continuation;
}

/** Wrapping A4 page: natural pagination, fixed footer, optional continuation. */
export function A4Page({ children, footerLabel, continuation }: A4PageProps) {
  return (
    <Page
      size={{ width: PAPER_SIZES.A4.width, height: PAPER_SIZES.A4.height }}
      style={s.page}
      wrap
    >
      <A4GoldMark />
      {continuation ? <A4ContinuationHeader {...continuation} /> : null}
      {children}
      <A4Footer label={footerLabel} />
    </Page>
  );
}

/** Fixed footer; page numbers come from react-pdf, never from static text. */
export function A4Footer({ label }: { label: string }) {
  return (
    <View fixed style={s.footer}>
      <Text style={s.footerText}>
        <Text style={s.footerStrong}>HoundFe</Text>
        {` · ${label}`}
      </Text>
      <Text
        style={s.footerText}
        render={({ pageNumber, totalPages }) =>
          `Página ${pageNumber} de ${totalPages}`
        }
      />
    </View>
  );
}

/** Header repeated on every page after the first (hidden on page 1). */
export function A4ContinuationHeader(props: A4Continuation) {
  return (
    <View
      fixed
      render={({ pageNumber }) =>
        pageNumber > 1 ? (
          <View style={s.continuation}>
            <A4PageHeader
              subtitle={props.brandSubtitle}
              kicker={props.kicker}
              folio={props.folio}
            />
          </View>
        ) : null
      }
    />
  );
}

/**
 * Thin gold brand mark at the page's top-left edge — the only place gold
 * appears. Fixed + absolute: it repeats on every page and takes no flow space.
 */
export function A4GoldMark() {
  return <View fixed style={s.goldMark} />;
}

export interface A4PageHeaderProps {
  readonly subtitle: string;
  readonly kicker: string;
  readonly folio: string;
  readonly brandName?: string;
}

/** Logo placeholder box + brand on the left, kicker/folio on the right. */
export function A4PageHeader({
  subtitle,
  kicker,
  folio,
  brandName = 'HoundFe',
}: A4PageHeaderProps) {
  return (
    <View>
      <View style={s.header}>
        <View style={s.brand}>
          <View style={s.logoBox}>
            <Text style={s.logoText}>Logo</Text>
          </View>
          <View>
            <Text style={s.brandName}>{brandName}</Text>
            <Text style={s.brandSub}>{subtitle}</Text>
          </View>
        </View>
        <View style={s.docMeta}>
          <Text style={s.kicker}>{kicker}</Text>
          <Text style={s.folio}>{folio}</Text>
        </View>
      </View>
    </View>
  );
}

export interface A4MetaBarItem {
  readonly label: string;
  readonly value: string;
}

/** Sub-header strip under the header (e.g. closing time · register). */
export function A4MetaBar({ items }: { items: readonly A4MetaBarItem[] }) {
  return (
    <View style={s.metaBar}>
      {items.map((item) => (
        <Text key={item.label} style={s.metaBarText}>
          {`${item.label} `}
          <Text style={s.metaBarValue}>{item.value}</Text>
        </Text>
      ))}
    </View>
  );
}

export interface A4SectionProps {
  readonly title: string;
  /** Small muted text at the right of the title rule. */
  readonly aside?: string;
  readonly hint?: string;
  readonly children?: ReactNode;
}

/**
 * Section title (accent, uppercase, strong rule) + optional hint, followed by
 * the section body as FLAT siblings (a Fragment, no wrapper View). Flatness is
 * deliberate: react-pdf only honours `minPresenceAhead` when the node has a
 * previous sibling to break away from, so the heading never ends a page alone.
 */
export function A4Section({ title, aside, hint, children }: A4SectionProps) {
  return (
    <>
      <View style={s.section} minPresenceAhead={84} wrap={false}>
        <View style={s.sectionHeading}>
          <Text style={s.sectionTitle}>{title}</Text>
          {aside ? <Text style={s.sectionAside}>{aside}</Text> : null}
        </View>
        {hint ? <Text style={s.hint}>{hint}</Text> : null}
      </View>
      {children}
    </>
  );
}

export interface A4KeyValueItem {
  readonly label: string;
  readonly value: string;
  readonly tone?: A4Tone;
}

/** Label-left / value-right lines, laid out in explicit columns. */
export function A4KeyValueColumns({
  columns,
}: {
  columns: readonly (readonly A4KeyValueItem[])[];
}) {
  return (
    <View style={s.kvColumns}>
      {columns.map((column, index) => (
        <View
          key={`kv-${index}`}
          style={index === columns.length - 1 ? s.kvColumnLast : s.kvColumn}
        >
          {column.map((item) => (
            <View key={item.label} style={s.kvLine} wrap={false}>
              <Text style={s.kvLabel}>{item.label}</Text>
              <Text
                style={[s.kvValue, { color: toneColor(item.tone ?? 'ink') }]}
              >
                {item.value}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

// ── Ledger table ─────────────────────────────────────────────────────

export interface LedgerColumn {
  readonly key: string;
  readonly label: string;
  readonly flex: number;
  readonly align?: 'left' | 'right';
}

export interface LedgerCellObject {
  readonly text: string;
  /** Secondary muted line under the value (a date, a note). */
  readonly sub?: string;
  readonly tone?: A4Tone;
  readonly bold?: boolean;
}

/** A cell is plain text or a structured value with tone / sub line. */
export type LedgerCell = string | LedgerCellObject;

export interface LedgerRowData {
  readonly key: string;
  readonly cells: Readonly<Record<string, LedgerCell>>;
}

export interface LedgerTableProps {
  readonly columns: readonly LedgerColumn[];
  readonly rows: readonly LedgerRowData[];
  /** Totals row: rules above and below in accent. */
  readonly total?: LedgerRowData;
  /** Shown instead of rows when `rows` is empty. */
  readonly emptyText?: string;
  /** Repeat the header on every page the table spans (default true). */
  readonly repeatHeader?: boolean;
}

function columnStyle(column: LedgerColumn) {
  return {
    flex: column.flex,
    textAlign: column.align ?? 'left',
    paddingRight: 4,
  } as const;
}

function LedgerCellView({
  column,
  cell,
  strong,
}: {
  column: LedgerColumn;
  cell: LedgerCell | undefined;
  strong?: boolean;
}) {
  const value: LedgerCellObject =
    cell === undefined
      ? { text: '' }
      : typeof cell === 'string'
        ? { text: cell }
        : cell;
  const bold = value.bold === true || strong === true;
  return (
    <View style={{ flex: column.flex, paddingRight: 4 }}>
      <Text
        style={[
          s.ledgerCellText,
          {
            textAlign: column.align ?? 'left',
            color: toneColor(value.tone ?? 'ink'),
            fontFamily: bold ? A4_FONTS.bold : A4_FONTS.regular,
          },
        ]}
      >
        {value.text}
      </Text>
      {value.sub ? (
        <Text style={[s.ledgerCellSub, { textAlign: column.align ?? 'left' }]}>
          {value.sub}
        </Text>
      ) : null}
    </View>
  );
}

export function LedgerHeaderRow({
  columns,
}: {
  columns: readonly LedgerColumn[];
}) {
  return (
    <View style={s.ledgerHeaderRow}>
      {columns.map((column) => (
        <Text
          key={column.key}
          style={[s.ledgerHeaderText, columnStyle(column)]}
        >
          {column.label}
        </Text>
      ))}
    </View>
  );
}

/**
 * Ledger table: header text muted + bold with a bottom rule (no fill), rows
 * with a hairline bottom rule, amounts right-aligned. Every row is
 * `wrap={false}`; the header is `fixed` so it repeats on continuation pages.
 */
export function LedgerTable({
  columns,
  rows,
  total,
  emptyText,
  repeatHeader = true,
}: LedgerTableProps) {
  return (
    <View>
      <View fixed={repeatHeader}>
        <LedgerHeaderRow columns={columns} />
      </View>
      {rows.length === 0 && emptyText ? (
        <Text style={s.ledgerEmpty}>{emptyText}</Text>
      ) : (
        rows.map((row) => (
          <View key={row.key} style={s.ledgerRow} wrap={false}>
            {columns.map((column, index) => (
              <LedgerCellView
                key={column.key}
                column={column}
                cell={row.cells[column.key]}
                strong={index === 0}
              />
            ))}
          </View>
        ))
      )}
      {total ? (
        <View style={s.ledgerTotalRow} wrap={false}>
          {columns.map((column, index) => (
            <LedgerCellView
              key={column.key}
              column={column}
              cell={
                index === 0 && typeof total.cells[column.key] === 'string'
                  ? {
                      text: total.cells[column.key] as string,
                      tone: 'accent',
                      bold: true,
                    }
                  : total.cells[column.key]
              }
              strong
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ── Totals block ─────────────────────────────────────────────────────

export interface A4TotalsLine {
  readonly label: string;
  readonly value: string;
  readonly tone?: A4Tone;
}

export interface A4TotalsBlockProps {
  readonly lines?: readonly A4TotalsLine[];
  /** «Total» row: label + amount in accent with rules above and below. */
  readonly total: { readonly label?: string; readonly value: string };
}

export function A4TotalsBlock({ lines = [], total }: A4TotalsBlockProps) {
  return (
    <View style={s.totalsWrap} wrap={false}>
      <View style={s.totalsBox}>
        {lines.map((line) => (
          <View key={line.label} style={s.totalsLine}>
            <Text style={s.totalsLabel}>{line.label}</Text>
            <Text
              style={[s.totalsValue, { color: toneColor(line.tone ?? 'ink') }]}
            >
              {line.value}
            </Text>
          </View>
        ))}
        <View style={s.totalsGrand}>
          <Text style={s.totalsGrandLabel}>{total.label ?? 'Total'}</Text>
          <Text style={s.totalsGrandValue}>{total.value}</Text>
        </View>
      </View>
    </View>
  );
}
