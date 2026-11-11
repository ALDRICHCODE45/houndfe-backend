# Notifications: data model and pipeline

Human-intervention unit 6. Contract: `docs/proposals/human-intervention-backend-proposal.md` §5.1, §5.2, §6.3, §8 (D5, D14), §10.1 (R3, R8, R10). Migration: `prisma/migrations/20261111000000_notifications`. Code: `src/notifications/**`.

This module is separate from `notification-config` (`NotificationSettings`, recipients, actions). It does **not** read `NotificationSettings.enabled` (R8): a tenant without that row still gets request notices. `notification-config` keeps serving the emails that already exist.

## Tables

| Table | What it holds |
| --- | --- |
| `notifications` | One in-app notice per `(tenant, user, event)`: `type`, `requestId` (plain column, no FK), `payload` (`{folio, subtype}`, never customer data), `dedupKey`, `createdAt`, `readAt`. Unique `(tenantId, userId, dedupKey)`; list index `(tenantId, userId, createdAt DESC, id DESC)`; partial index `WHERE readAt IS NULL` for the badge and `unread=true` (migration-authoritative). Tenant-scoped (`TENANT_SCOPED_MODELS`). |
| `notification_preferences` | `userId` PK, `emailEnabled`, `soundEnabled`, both default `true`. Per **person**, not per tenant, so it follows them across sucursales. No row means the defaults. Not tenant-scoped; always read by the JWT `userId`. |

There is no email table: email jobs are `outbox_events` rows under the reserved prefix (below).

## Pipeline

```mermaid
flowchart LR
  A[state change tx] -->|enqueueNotice| B[(outbox: chatbot_request.notify)]
  B --> C[ChatbotRequestNotifyConsumer]
  C -->|recipients from permissions| D[(notifications)]
  C -->|emailEnabled and type has email| E[(outbox: chatbot_request.email)]
  E --> F[ChatbotRequestEmailDispatcher]
  F -->|one event per email| G[Inngest chatbot-request/email.requested]
  G --> H[load, then send-email via MAILER]
```

### Recipients are resolved by a consumer, not at enqueue time

Decision: the producer writes **one outbox row** in the transaction of the state change; a dedicated consumer resolves recipients later (contract §5.1).

- The hot path (request creation holds the per-tenant folio lock and the customer-group lock) pays one insert, not a permission join plus N inserts. "Avisar nunca bloquea el alta."
- Permissions are evaluated when the notice is delivered, so a role change in the seconds between is honored.
- A rollback leaves no outbox row, so no notification: the consumer only ever sees committed events.
- Cost: in-app notices appear after the consumer tick (1 s), not in the same commit.

The consumer processes **one row per local transaction** (`FOR UPDATE SKIP LOCKED`, no external call inside): resolve recipients, insert notifications (`createManyAndReturn` with `skipDuplicates`, so only new rows return), insert email jobs, call the realtime hook, mark the row `PUBLISHED`. A crash rolls it all back and the row stays `PENDING`. A failing row backs off (2 s, 5 s, 15 s, 60 s, 300 s) and ends `FAILED` after `NOTICE_NOTIFY_MAX_RETRIES` (5) without blocking the rest.

### Who receives what (§5.1)

| Type | Audience | Email | Producer |
| --- | --- | --- | --- |
| `REQUEST_CREATED` | active members with `read` + `update:ChatbotRequest` | batched, or immediate for `TALK_TO_HUMAN` / `COMPLAINT` | bot intake and the wrapped legacy hooks (unit 6) |
| `REQUEST_REASSIGNED` | the new assignee (never the actor) | immediate | staff `reassign` (unit 6) |
| `REQUEST_CANCELLED` | the assignee, if any | none | customer cancel (unit 6) |
| `REQUEST_CLAIM_REMINDER` | as `REQUEST_CREATED` | immediate | unit 7 |
| `REQUEST_ESCALATION`, `REQUEST_OVERDUE` | active members with `read:ChatbotEscalation` | immediate | unit 7 |

A grant counts when the role has the action or `manage`, on the subject or `all` (as `CaslAbilityFactory`). Only `User.isActive` members of the notice's tenant qualify. Unit 7 calls `enqueueNotice(tx, tenantId, notice)` from `src/notifications/infrastructure/chatbot-request-notice.writer.ts`; the types, audiences and consumer already exist.

### Email (D5, §6.3)

- Subject `[HoundFe] Nueva solicitud: <tipo> (<sucursal>) · S-000123`; a batch uses `[HoundFe] N solicitudes nuevas (<sucursal>)`. The body has type, branch, folio and one `${APP_WEB_URL}/chatbot/solicitudes/:id` link per request. **No customer name, phone, text or media**: the loader does not select them.
- **Batching:** a `BATCH` job is due at the end of its **fixed 2-minute clock window** (`batchWindowEnd`). All of a person's batched jobs share that instant, so they are due together and leave in one email with no per-user state. If a window holds more than `NOTICE_EMAIL_BATCH_SIZE` (100) jobs of one claim, the rest leave in the next tick as a second email.
- **Immediate:** the job is due now and leaves alone.
- The Inngest function re-checks at send time (`load` step): an inactive person, a lost membership or `emailEnabled = false` since queueing sends nothing. The in-app notice always exists.
- Delivery is at-least-once; the Inngest idempotency key is derived from the notification ids, so a replay of the same group is one email.

### R3: the generic poller never takes these rows

Every outbox type of this module starts with `chatbot_request.` (`RESERVED_OUTBOX_PREFIX` in `src/shared/outbox/outbox.types.ts`). The generic `OutboxPollerService` excludes it with `AND NOT starts_with("eventType", 'chatbot_request.')`, in the same change that registers `ChatbotRequestNoticeOutboxModule`. A new dedicated type under the prefix needs no edit to the generic poller. Tests: the claim SQL, every type in `NOTICE_OUTBOX_EVENT_TYPES` starts with the prefix, and a PostgreSQL spec shows the generic poller leaves both types `PENDING` and unlocked while a normal type is claimed.

### Realtime hook

`NOTIFICATION_EVENTS` (`notification-events.port.ts`) is a no-op until unit 8. `publishCreated(tx, event)` receives the consumer's transaction on purpose: unit 8 can insert its durable `RealtimeEvent` row and `NOTIFY` in the same commit, so a crash cannot lose the event. `notification.read` events are also unit 8.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_WEB_URL` | — | Origin of the deep links (shared with the other emails); without it the email has no link |
| `NOTICE_NOTIFY_BATCH_SIZE` / `NOTICE_NOTIFY_MAX_RETRIES` | 25 / 5 | Consumer rows per tick, attempts before `FAILED` |
| `NOTICE_EMAIL_BATCH_SIZE` / `NOTICE_EMAIL_LOCK_MS` / `NOTICE_EMAIL_MAX_RETRIES` | 100 / 60000 / 5 | Email jobs claimed per tick, lease, attempts |

## Known limits

- Retention (90 days, §5.2) is not scheduled yet; it joins the daily cron of §3.6.
- `FAILED` rows are only visible in `outbox_events`; the "failed notices" screen is later.
- The email shows no age or time remaining (needs request deadlines; unit 7).
- Both `@Interval` ticks run on every replica; `FOR UPDATE SKIP LOCKED` keeps them disjoint.

## R10: the receipt-review email

`receipt.review_requested` no longer carries `customerName` in its outbox payload, and the email has no "Cliente" row. It keeps the order folio, the amounts, the mismatch warning and the link. Rows queued before this change still hold the name in their payload; the function ignores it (covered by a spec).
