# Chatbot settings API (attention hours, closed dates, SLA times, apply to all branches)

**Status:** implemented on `feat/human-intervention` (human-intervention unit 7a), **not merged, not pushed, not deployed**. Contract: `docs/proposals/human-intervention-backend-proposal.md` §5.4, §5.5, §12.7, §12.9, §4.9, §10.1 (unit 7). Owner decision S7 on "aplicar a todas" (2026-11-11): «Solo donde tenga membresía (Recomendado)».

**S11 additions (2026-11-12, additive):** `updatedBy` / `updatedAt` on every settings body, `closedDateReasons`, `fieldErrors` on every `400 VALIDATION_ERROR`, at most 6 ranges per day, and the inbox filter `windowClosingSoon` now uses `windowWarningMinutes`. `closedDates` is still `string[]`; nothing that existed changed shape.

Shapes in this document come from the controller, DTOs, service and their specs (`src/chatbot-settings/**`, `src/chatbot-requests/domain/chatbot-sla.ts`). Nothing was sent to the dev API.

**Not in this unit:**
- The sweep, the 50 % / 80 % / overdue notices and the escalation notices (unit 7c). The deadlines already exist on every request (`claimDeadlineAt`, `resolveDeadlineAt`); nothing marks a request overdue yet.
- Scheduled conversations (unit 14). `scheduling` and `enabledSubtypes` are **stored only**: saving them changes nothing else yet.
- `slaPaused` / `slaResumesAt` on request rows still come back `false` / `null`. Do not build UI on them yet.
- ~~Template sending~~ — done in unit 11: `POST /chatbot-requests/:id/template` uses `templateName`, `templateLanguageCode` and `templateCostText` (handoff 20, section 3c).

## 1. Rules

- Routes use `JWT → tenant context → active user → permissions`. The tenant and the actor come from the JWT, never from the body.
- One settings object **per sucursal** (each sucursal is a tenant). A sucursal that never saved settings answers the defaults with `version: 0`.
- All responses carry `Cache-Control: no-store`.
- Times are **business minutes**: they stop outside the opening hours and on closed dates, and are counted in the sucursal's own time zone (DST is handled). All instants in the API are UTC ISO strings.
- This is the **chat** schedule. It is separate from the store-pickup hours (`/tenants/:id/opening-hours`); editing one never changes the other.

## 2. Permissions

| Route | Needs |
| --- | --- |
| `GET /chatbot-settings` | `read:ChatbotSettings` |
| `PUT /chatbot-settings` | `read:ChatbotSettings` and `update:ChatbotSettings` |
| `POST /chatbot-settings/apply-to-all-tenants` | `update:ChatbotSettingsAllBranches` |

Initial grants (owner choice L2): Manager has the first two, **not** `ChatbotSettingsAllBranches`; Cashier has none. Hide the screen without `read:ChatbotSettings` and the "apply to all" button without `update:ChatbotSettingsAllBranches`.

## 3. `GET /chatbot-settings`

```json
{
  "version": 3,
  "openingHours": {
    "timeZone": "America/Mexico_City",
    "days": [
      { "day": "MONDAY", "ranges": [{ "open": "09:00", "close": "19:00" }] },
      { "day": "TUESDAY", "ranges": [{ "open": "09:00", "close": "19:00" }] },
      { "day": "WEDNESDAY", "ranges": [{ "open": "09:00", "close": "19:00" }] },
      { "day": "THURSDAY", "ranges": [{ "open": "09:00", "close": "19:00" }] },
      { "day": "FRIDAY", "ranges": [{ "open": "09:00", "close": "19:00" }] },
      { "day": "SATURDAY", "ranges": [{ "open": "09:00", "close": "19:00" }] },
      { "day": "SUNDAY", "ranges": [] }
    ]
  },
  "closedDates": ["2026-12-25"],
  "closedDateReasons": { "2026-12-25": "Navidad" },
  "slas": [
    { "subtype": "RESTOCK", "claimMinutes": 60, "resolveMinutes": 240 },
    { "subtype": "EXPIRATION", "claimMinutes": 60, "resolveMinutes": 240 },
    { "subtype": "DELIVERY_ZONE", "claimMinutes": 60, "resolveMinutes": 240 },
    { "subtype": "TRANSFER_RECEIPT", "claimMinutes": null, "resolveMinutes": null },
    { "subtype": "TALK_TO_HUMAN", "claimMinutes": 10, "resolveMinutes": null },
    { "subtype": "COMPLAINT", "claimMinutes": 30, "resolveMinutes": 240 },
    { "subtype": "UNKNOWN_QUESTION", "claimMinutes": 30, "resolveMinutes": 120 },
    { "subtype": "DISCOUNT", "claimMinutes": 30, "resolveMinutes": 120 }
  ],
  "windowWarningMinutes": 120,
  "templateName": null,
  "templateCostText": "Enviar la plantilla tiene un costo para el negocio.",
  "enabledSubtypes": ["RESTOCK", "EXPIRATION", "DELIVERY_ZONE", "TRANSFER_RECEIPT", "TALK_TO_HUMAN", "COMPLAINT", "UNKNOWN_QUESTION", "DISCOUNT"],
  "receiptCloseMarginMinutes": 60,
  "startTimeoutSeconds": 120,
  "templateLanguageCode": "es_MX",
  "scheduling": { "enabled": false, "slotMinutes": 30, "slotsOffered": 3, "maxScheduledPerSlot": 3 },
  "branchOpeningHours": null,
  "updatedBy": { "id": "6f1c…", "displayName": "Ana López" },
  "updatedAt": "2026-11-12T15:04:05.123Z"
}
```

The example shows a saved sucursal. A sucursal with **no row** gets the defaults with `version: 0`, `closedDateReasons: {}`, `updatedBy: null` and `updatedAt: null` (the three S11 fields are always present). Field notes:

- `openingHours` is the same `OpeningHoursBody` (`{timeZone, days}`) the pickup editor already uses, so `OpeningHoursEditor` works unchanged. Seven days, ranges `HH:mm`, no overlaps or touching ranges, no range crossing midnight, latest close `23:59`.
- `closedDates`: real local dates `YYYY-MM-DD` in `openingHours.timeZone`, sorted and unique, at most 400. A closed date has no business time at all (a holiday). It stays a plain `string[]`. A repeated date in a `PUT` is merged, not an error.
- `closedDateReasons` (S11): `{ "YYYY-MM-DD": "reason" }`, an object keyed by date (chosen over a list of `{date, reason}` so the screen looks a reason up by date). Optional text per closed date, 1 to 80 characters after trimming, plain text. **Keys must be dates present in `closedDates`**, otherwise `400` with `REASON_WITHOUT_DATE`. Dates without a reason have no key. Always present in `GET` (`{}` when none). It is **copied by apply-to-all** together with `closedDates`.
- `updatedBy` / `updatedAt` (S11): who saved the settings last and when (UTC ISO). `updatedBy` is `{ id, displayName }`, where `displayName` is the name copied at the time of the save, so it **survives the deletion of that user** (the `id` may no longer exist). Both are `null` for a sucursal with no row (defaults). After "apply to all", a target sucursal shows the person who applied. A `PUT` that changes nothing keeps the previous author and time. **Read-only: do not send them back** (an unknown field is a `400`, same as `version`).
- `slas`: always **all eight subtypes**, in the order above. `null` means "no deadline of this kind". `TRANSFER_RECEIPT` has no claim time and **its resolve time is not configured**: a receipt is due at the close of the day when it arrives in hours with more than `receiptCloseMarginMinutes` left, otherwise at the close of the next business day (§5.4). Show those two fields as read-only.
- `TALK_TO_HUMAN.resolveMinutes` is `null` by design ("en vivo").
- `windowWarningMinutes` (0 to 1440): how long before the 24 h WhatsApp window closes a request counts as "closing soon". **S11: the inbox filter `windowClosingSoon` and the `windowClosingSoon` count of `/chatbot-requests/counts` use this value** (handoff 14 §16); `0` turns the warning off; a sucursal on the default (120) behaves as before.
- `templateName`: lowercase letters, digits and `_`, 1 to 512, or `null` (not configured: the send-template command answers `422 TEMPLATE_NOT_CONFIGURED`).
- `templateCostText`: plain text, 1 to 200 characters. Show it as is in the "Enviar plantilla" confirmation (§12.7).
- `enabledSubtypes`, `scheduling`: stored only (see above).
- `branchOpeningHours`: **read-only**, `{timeZone, days}` of the pickup hours of the **same** sucursal, or `null` when it has none (disable the "Copiar el horario de la sucursal" button). The button only loads these values into the editor; you save with the normal `PUT` (§12.9). It is never sent back usefully: the server ignores it on `PUT`.

## 4. `PUT /chatbot-settings`

Full replacement, plus the version you edited:

```json
{
  "expectedVersion": 3,
  "openingHours": { "timeZone": "America/Mexico_City", "days": [ ... seven days ... ] },
  "closedDates": ["2026-12-25"],
  "closedDateReasons": { "2026-12-25": "Navidad" },
  "slas": [ ... eight entries ... ],
  "windowWarningMinutes": 120,
  "templateName": null,
  "templateCostText": "Enviar la plantilla tiene un costo para el negocio.",
  "enabledSubtypes": ["RESTOCK", "COMPLAINT"],
  "receiptCloseMarginMinutes": 60,
  "startTimeoutSeconds": 120,
  "templateLanguageCode": "es_MX",
  "scheduling": { "enabled": false, "slotMinutes": 30, "slotsOffered": 3, "maxScheduledPerSlot": 3 }
}
```

You can send back exactly what `GET` returned (without `version`, `updatedBy` and `updatedAt`) plus `expectedVersion`. **`startTimeoutSeconds` and `templateLanguageCode` (unit 11) are additive and optional in the `PUT`: leaving them out keeps the stored values** (unlike `closedDateReasons`), so a screen that does not edit them cannot reset them. A `null` also means "keep". `closedDateReasons` is optional, but a `PUT` replaces the whole object: **leaving it out clears every reason**. `branchOpeningHours` may be present and is ignored. Any other unknown field is a `400`. `expectedVersion` is the `version` you loaded (`0` the first time).

Success: `200` with the new `GET` body plus one extra field, `recompute` (see below). The version goes up by one **only if something changed**; saving identical content answers `200` with the same version, `recompute: "NOT_NEEDED"`, and does nothing else. The `PUT` response also carries `updatedBy` / `updatedAt` of this save. **`recompute` exists only in the `PUT` response: do not send it back** (an unknown field is a `400`, same as `version`).

Limits, all checked on the server:

| Field | Rule |
| --- | --- |
| `slas[].claimMinutes`, `resolveMinutes` | `null` or an integer 1 to 10080; `resolveMinutes` not below `claimMinutes`; `TRANSFER_RECEIPT.resolveMinutes` must be `null` |
| `receiptCloseMarginMinutes` | integer 0 to 1440 |
| `startTimeoutSeconds` | integer **30 to 600** (default 120): how long a claim of a live conversation (unit 11) waits for the bot to confirm it is silent before the claim reverts. A change applies to the **next** claim, never to a session that already started |
| `templateLanguageCode` | `xx` or `xx_YY` (lowercase language, uppercase country), e.g. `es_MX` (default): the language of the paid WhatsApp template (unit 11) |
| `windowWarningMinutes` | integer 0 to 1440 |
| `openingHours` | at least one open range in the week; at most **6 ranges per day** (settings only) |
| `closedDateReasons` | keys are dates of `closedDates`; each reason 1 to 80 characters, plain text |
| `scheduling.slotMinutes` | 5 to 240; `slotsOffered` 1 to 10; `maxScheduledPerSlot` 1 to 50 |

### What a change does to open requests

A write that is saved is **never** answered with a 5xx because of this step. After the commit the server recomputes, and `recompute` in the `PUT` response says how it went:

| `recompute` | Meaning | What the UI does |
| --- | --- | --- |
| `DONE` | Every open request is on the new settings | nothing |
| `PARTIAL` | Some open requests were being changed by a command or created at that moment; they are stamped the next time something touches them | nothing, or a soft notice |
| `FAILED` | **The settings ARE saved** (new `version`), but the open requests still have the old deadlines (the server logged it) | show "Guardado; los plazos de las solicitudes abiertas se actualizarán más tarde". Do not retry the save with the old `expectedVersion` (that is a `409`); keep the returned `version` |
| `NOT_NEEDED` | Identical content, nothing was written | nothing |

After a change is saved, the **open** requests (`NEW`, `IN_PROGRESS`) of that sucursal get their `claimDeadlineAt`, `resolveDeadlineAt`, `slaPolicyVersion` and `nextSlaCheckAt` recomputed with the new settings, in the same call, in small batches. **Closed requests are never touched.** The inbox rows show the new deadlines on the next read. The claim deadline of a request that is already `IN_PROGRESS` is history and stays.

### Errors

| Status | `code` | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Shape, or a rule above. Has `fieldErrors` (below). When a rule failed it also has `reason`: `INVALID_OPENING_HOURS` (overlap, midnight, bad zone, missing day) or `INVALID_CHATBOT_SETTINGS` (everything else), and a fixed English `message` you can log |
| 401 / 403 | `UNAUTHORIZED` / `INSUFFICIENT_PERMISSIONS` | Not signed in or inactive / missing permission |
| 409 | `VERSION_CONFLICT` | Someone saved first. Body has `current`: the same object `GET` returns. Replace the form with it (or merge) and retry with `current.version`. (On `apply-to-all-tenants` `current` is present only if you also have `read:ChatbotSettings`, see §5) |

```json
{ "statusCode": 409, "code": "VERSION_CONFLICT", "message": "The settings changed; reload them", "current": { "version": 4, "openingHours": { }, "...": "...", "updatedBy": { "id": "6f1c…", "displayName": "Ana López" }, "updatedAt": "2026-11-12T15:04:05.123Z" } }
```

`current.updatedBy` / `current.updatedAt` tell the user who saved first ("Ana López guardó cambios hace 2 minutos"). Same rule on the `apply-to-all-tenants` `409` when it carries `current`.

### `fieldErrors` (S11)

Every `400 VALIDATION_ERROR` of `PUT /chatbot-settings` and of `POST /chatbot-settings/apply-to-all-tenants` has a `fieldErrors` array. `statusCode`, `code`, `message` (and `reason` when present) are exactly what they were; `fieldErrors` is the addition. The server reports **every** problem it finds in the body, not just the first (when the shape of the body is wrong, only the shape problems come back; fix them and send again).

```json
{
  "statusCode": 400,
  "code": "VALIDATION_ERROR",
  "reason": "INVALID_OPENING_HOURS",
  "message": "TUESDAY: ranges must not overlap or touch",
  "fieldErrors": [
    { "path": "openingHours.days[1].ranges[1]", "code": "OVERLAP" },
    { "path": "slas[3].resolveMinutes", "code": "MUST_BE_NULL" },
    { "path": "closedDates[2]", "code": "INVALID_DATE" }
  ]
}
```

`path` is JSON-path-like, relative to the body you sent: `openingHours.days[1].ranges[0].open`, `slas[3].resolveMinutes`, `closedDates[2]`, `closedDateReasons["2026-12-25"]`, `scheduling.slotMinutes`. Indexes are the positions **in your request**. The list never contains what you sent (no values). Use `code` for your own text; the `message` is English, for logs. An empty `fieldErrors` means the problem could not be located; show the generic error.

| `code` | Meaning | Typical `path` |
| --- | --- | --- |
| `REQUIRED` | Missing (or `null` where a value is required), or a weekday / subtype missing from the list | `receiptCloseMarginMinutes`, `openingHours.days`, `slas` |
| `INVALID_TYPE` | Wrong JSON type | `windowWarningMinutes`, `closedDates[1]` |
| `INVALID_VALUE` | Not one of the allowed values | `slas[0].subtype`, `enabledSubtypes[1]`, `openingHours.days[2].day` |
| `UNKNOWN_FIELD` | A field the route does not accept (including `version`, `updatedBy`, `updatedAt`, `recompute`) | `tenantId` |
| `OUT_OF_RANGE` | A number outside its limit (table above) or not an integer | `slas[5].resolveMinutes`, `scheduling.slotMinutes`, `expectedVersion` |
| `INVALID_LENGTH` | Text too short or too long (reason 1 to 80, cost text 1 to 200) | `closedDateReasons["2026-12-25"]`, `templateCostText` |
| `INVALID_TEXT` | Control characters in a text | `templateCostText`, `closedDateReasons[...]` |
| `INVALID_TEMPLATE_NAME` | Not lowercase letters, digits and `_` (1 to 512) | `templateName` |
| `INVALID_LANGUAGE_CODE` | Not `xx` or `xx_YY` | `templateLanguageCode` |
| `INVALID_TIME` | Not `HH:mm` between `00:00` and `23:59` | `openingHours.days[0].ranges[0].open` |
| `CROSSES_MIDNIGHT` | Closes before it opens (for example `22:00` to `02:00`); split it across days | `openingHours.days[0].ranges[0]` |
| `EMPTY_RANGE` | Opens and closes at the same time | `openingHours.days[0].ranges[0]` |
| `OVERLAP` | The range overlaps or touches another of the same day; the path is the **later** one | `openingHours.days[1].ranges[1]` |
| `TOO_MANY_RANGES` | More than 6 ranges in one day | `openingHours.days[3].ranges` |
| `INVALID_TIMEZONE` | Not an IANA time zone | `openingHours.timeZone` |
| `INVALID_DAY` / `DUPLICATE_DAY` | Unknown weekday name / weekday repeated | `openingHours.days[2].day` |
| `NO_OPEN_RANGE` | Every day is closed | `openingHours.days` |
| `INVALID_DATE` | Not a real `YYYY-MM-DD` date | `closedDates[2]`, `closedDateReasons["2026-02-30"]` |
| `TOO_MANY_DATES` | More than 400 distinct closed dates | `closedDates` |
| `REASON_WITHOUT_DATE` | A reason for a date that is not in `closedDates` | `closedDateReasons["2026-12-24"]` |
| `DUPLICATE_SUBTYPE` | A subtype appears twice in `slas` | `slas[7].subtype` |
| `MUST_BE_NULL` | `TRANSFER_RECEIPT.resolveMinutes` must be `null` | `slas[3].resolveMinutes` |
| `RESOLVE_BELOW_CLAIM` | `resolveMinutes` is lower than `claimMinutes` | `slas[5].resolveMinutes` |

New codes may be added later; treat an unknown `code` as a generic error on that `path`. (`DUPLICATE_DATE` does not exist: a repeated closed date is merged.)

On `apply-to-all-tenants`, `fieldErrors` covers its small body: `dryRun` (`INVALID_TYPE`), `expectedVersion` (`OUT_OF_RANGE` / `INVALID_TYPE`) and unknown fields (`UNKNOWN_FIELD`).

Two people saving at once: exactly one wins, the others get `409`.

## 5. `POST /chatbot-settings/apply-to-all-tenants`

Copies this sucursal's **saved** settings to the other sucursales **where you have `update:ChatbotSettingsAllBranches` through a membership** (S7). Nothing changes about permissions or about how new sucursales are created: a super admin is added to a new sucursal by hand, and until then it is simply not reached.

Request body (both optional):

```json
{ "dryRun": true, "expectedVersion": 4 }
```

- `dryRun: true`: reports what would change and writes nothing. Call it first and show "N sucursales cambian" before the user confirms.
- `expectedVersion`: the version of **this** sucursal's settings the user saw. A stale one answers `409 VERSION_CONFLICT`, so you never copy something other than what was on screen. The body carries `current` (same object as `GET`) **only if you also have `read:ChatbotSettings` in this sucursal**, because this route requires just `update:ChatbotSettingsAllBranches` and must not be a way around `GET`. Without that permission the `409` has no `current` key: `{ "statusCode": 409, "code": "VERSION_CONFLICT", "message": "The settings changed; reload them" }`. Handle both: if `current` is missing, tell the user the settings changed and ask them to reload (a `GET` will work if they can read; otherwise just retry the dry run). Save with `PUT` first, then apply.

Copied: `openingHours`, `closedDates`, `closedDateReasons`, `slas`, `windowWarningMinutes`, `receiptCloseMarginMinutes`, `scheduling`. **Not copied** (they stay per sucursal): `templateName`, `templateLanguageCode`, `templateCostText`, `enabledSubtypes`, `startTimeoutSeconds`.

Response `200`:

```json
{
  "dryRun": false,
  "source": { "tenantId": "…", "version": 4 },
  "tenantsApplied": [{ "tenantId": "…", "name": "Sucursal Norte", "recompute": "DONE" }],
  "tenantsUnchanged": [{ "tenantId": "…", "name": "Sucursal Centro" }],
  "tenantsSkipped": [{ "tenantId": "…", "name": "Sucursal Sur", "reason": "NO_PERMISSION" }],
  "tenantsFailed": []
}
```

| List | Meaning |
| --- | --- |
| `tenantsApplied` | Changed (with `dryRun`: would change). Version +1, one audit event. Each entry has `recompute` (not on a dry run): `DONE`, `PARTIAL` or `FAILED`, as in §4. **`FAILED` means the settings are saved on that sucursal but its open requests keep the old deadlines**; it is not also in `tenantsFailed` |
| `tenantsUnchanged` | Already identical, or the source sucursal itself. Nothing written |
| `tenantsSkipped` | You are a member but cannot apply there. `reason`: `NO_PERMISSION` (your roles there lack the permission) or `TENANT_INACTIVE` (the sucursal is deactivated) |
| `tenantsFailed` | The **settings write itself** failed on that sucursal (nothing was saved there); the others were still applied. Retry; the call is idempotent |

Every sucursal appears in **exactly one** of the four lists. Show a warning for the `tenantsApplied` entries with `recompute: "FAILED"`.

**Sucursales where you have no membership at all are not listed and not counted**, so the response never reveals other branches. Each sucursal is its own transaction, so a partial result is possible and is why `tenantsFailed` exists. Whether you can apply in a sucursal is decided by your effective permissions there, computed exactly as for every other route (the same `CASL` ability the permission guard uses): they merge across your roles in one sucursal and `manage:all` counts.

Tell the user in the confirmation text that sucursales they do not belong to are not reached.

## 6. Deadlines on the request rows (what changes in the inbox)

Request rows and details already return `claimDeadlineAt`, `resolveDeadlineAt` (UTC ISO or `null`). From this unit they are filled:

- **On creation:** claim = business minutes from creation; resolve likewise. For `TRANSFER_RECEIPT`: the §5.4 receipt rule.
- **On claim** (`NEW → IN_PROGRESS`): the claim clock stops mattering; the row follows `resolveDeadlineAt` (the resolve clock keeps counting from creation, it is not restarted).
- **On release** (`IN_PROGRESS → NEW`): the claim clock **restarts** from the release, a fresh window for the next person.
- **On a settings change:** recomputed as above.
- A request created before the sucursal ever saved settings uses the defaults (`slaPolicyVersion: 0`).
- Open requests that existed before this unit (backfilled) are counted from their original `createdAt`, so old ones are already past due; they are marked overdue once the sweep exists (unit 7c).

`mostUrgentAt` of a customer group, and the row order inside the inbox, follow these deadlines.

## 7. Suggested screen

1. `GET` on enter; keep `version`.
2. One form per section (hours with `OpeningHoursEditor`, closed dates, SLA table, template and margin). A single "Guardar" sends the whole object with `expectedVersion`.
3. "Copiar el horario de la sucursal": disabled when `branchOpeningHours` is `null`; otherwise fills the editor, saved by the normal `PUT`.
4. "Aplicar a todas las sucursales" (only with the permission): `PUT` pending changes, then `POST … {dryRun:true, expectedVersion}`, show the counts and the `tenantsSkipped` reasons, confirm, then `POST … {expectedVersion}`.
5. On `409`, show a "se modificó por otra persona" notice and reload from `current`.
