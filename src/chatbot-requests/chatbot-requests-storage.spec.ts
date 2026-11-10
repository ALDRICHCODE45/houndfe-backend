import { readFileSync } from 'fs';
import { join } from 'path';

const schema = readFileSync(
  join(process.cwd(), 'prisma/schema.prisma'),
  'utf8',
);
const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261110000000_chatbot_requests/migration.sql',
  ),
  'utf8',
);
const model = (name: string) =>
  schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
const OPEN = `WHERE "status" IN ('NEW', 'IN_PROGRESS')`;

describe('chatbot requests storage (human-intervention unit 2)', () => {
  it('is additive: creates tables and never alters or drops existing ones', () => {
    expect(sql).not.toMatch(/DROP |ALTER COLUMN|RENAME/);
    const altered = [...sql.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(
      new Set([
        'chatbot_requests',
        'chatbot_request_events',
        'chatbot_customer_groups',
        'chatbot_request_folio_counters',
      ]),
    );
  });

  it('keeps a per-tenant folio and the idempotent intake identity', () => {
    expect(model('ChatbotRequest')).toContain('@@unique([tenantId, folio])');
    expect(model('ChatbotRequest')).toContain(
      '@@unique([tenantId, source, sourceRequestId])',
    );
  });

  it('wraps each legacy row at most once through nullable unique FKs', () => {
    for (const column of [
      'humanDecisionId',
      'deliveryZoneRequestId',
      'receiptEvidenceId',
    ]) {
      expect(model('ChatbotRequest')).toMatch(
        new RegExp(`${column}\\s+String\\?\\s+@unique`),
      );
      expect(sql).toContain(`"chatbot_requests_${column}_fkey"`);
    }
    expect(sql).toContain('"chatbot_requests_wrapped_link_chk"');
  });

  it('serves the inbox, the per-customer list, the SLA sweep and the counters from indexes', () => {
    expect(sql).toContain(
      'ON "chatbot_requests"("tenantId", "customerKey", "status")',
    );
    expect(sql).toContain(`ON "chatbot_requests"("nextSlaCheckAt") ${OPEN}`);
    expect(sql).toContain(
      'ON "chatbot_customer_groups"("tenantId", "mostUrgentAt", "customerKey")',
    );
    expect(sql).toContain(
      `ON "chatbot_requests"("tenantId", "status") ${OPEN}`,
    );
    expect(sql).toContain(
      `ON "chatbot_requests"("tenantId", "assigneeUserId") WHERE "status" = 'IN_PROGRESS'`,
    );
    expect(sql).toMatch(
      /UNIQUE INDEX "chatbot_requests_open_dedup_key"[^;]+"dedupKey" IS NOT NULL/,
    );
  });

  it.each([
    'chatbot_requests_kind_subtype_chk',
    'chatbot_requests_assignee_state_chk',
    'chatbot_requests_resolved_state_chk',
    'chatbot_requests_cancelled_state_chk',
    'chatbot_requests_staff_cancel_reason_chk',
    'chatbot_requests_closed_at_chk',
    'chatbot_requests_sla_sweep_open_chk',
    'chatbot_requests_whatsapp_window_chk',
    'chatbot_requests_scheduling_chk',
    'chatbot_request_events_actor_chk',
    'chatbot_customer_groups_open_count_chk',
  ])('declares the %s CHECK', (name) => {
    expect(sql).toContain(`"${name}" CHECK`);
  });

  it('ties audit rows to their request inside the same tenant', () => {
    expect(model('ChatbotRequest')).toContain('@@unique([tenantId, id])');
    expect(model('ChatbotRequestEvent')).toContain(
      'fields: [tenantId, requestId], references: [tenantId, id]',
    );
    expect(model('ChatbotRequestEvent')).not.toContain('updatedAt');
  });

  it('makes the audit append-only while letting the tenant cascade delete it', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER "chatbot_request_events_append_only"\s+BEFORE UPDATE OR DELETE ON "chatbot_request_events"\s+FOR EACH ROW/,
    );
    expect(sql).toContain(
      "IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN",
    );
    expect(sql).not.toMatch(/BEFORE TRUNCATE/);
  });

  it('copies actor names instead of holding user FKs', () => {
    expect(sql).not.toMatch(/REFERENCES "users"/);
  });
});
