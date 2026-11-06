# Cash — display fields for sessions and custody

**Status: implemented** on `feat/fe-design-pass`, not merged. The change is additive: no existing key was renamed, removed or retyped. Permissions, filters, pagination and the blind-count rules are unchanged.

Requested by the FE design pass: two rows «Caja Mostrador 2 · Cerrada · $1,000.00» could not be told apart, the session card said «Otra persona», and custody items had only ids.

## `GET /cash-sessions` — each item

Three new keys on every item:

```json
{
  "id": "5b0c2a64-6f1e-4d8a-9a43-0e4c1c6f9d21",
  "tenantId": "ced6cc10-a037-4f41-92af-ee69bbb51c8b",
  "registerId": "a1f3e0b2-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  "status": "CLOSED",
  "cashierUserId": "7d2e9c10-4b8a-4f6e-9c1d-2a3b4c5d6e7f",
  "openingCents": 100000,
  "frozenAt": "2026-11-05T22:10:00.000Z",
  "drawerReleasedAt": "2026-11-05T22:40:00.000Z",
  "blind": false,
  "expectedCashCents": 100000,
  "differenceCents": 0,
  "openedAt": "2026-11-05T15:02:11.000Z",
  "closedAt": "2026-11-05T22:45:30.000Z",
  "cashierDisplayName": "Ana Cajera"
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `openedAt` | ISO string | When the session was opened. Always present. |
| `closedAt` | ISO string \| `null` | When the session was closed (verified close). `null` until `status` is `CLOSED`. |
| `cashierDisplayName` | string \| `null` | The cashier's visible name (`User.name` of `cashierUserId`). |

## `GET /cash-sessions/:id` — `session` object

The `session` object gains the same three keys, with the same meaning. The rest of the document (`register`, `movements`, `counts`, `handovers`, `closing`, `channelSnapshot`, `requiredChannels`) is unchanged.

```json
{
  "session": {
    "id": "5b0c2a64-6f1e-4d8a-9a43-0e4c1c6f9d21",
    "status": "COUNTING",
    "cashierUserId": "7d2e9c10-4b8a-4f6e-9c1d-2a3b4c5d6e7f",
    "blind": true,
    "openedAt": "2026-11-05T15:02:11.000Z",
    "closedAt": null,
    "cashierDisplayName": "Ana Cajera"
  },
  "register": { "id": "a1f3e0b2-3c4d-4e5f-8a9b-0c1d2e3f4a5b", "name": "Caja Mostrador 2", "isActive": true }
}
```

(Other existing `session` keys are omitted from the example for brevity; they are still returned.) The new keys hold no expected amounts, so they are also present in a blind projection. Use `cashierDisplayName` instead of «Otra persona».

## `GET /cash-handovers/custody` — items in `pendingHandovers` and `eligibleFloat`

Three new keys on **every** item, whatever its `kind` (`FLOAT` or `WITHDRAWAL`):

```json
{
  "id": "e4b1c7d2-9a3f-4e6b-8c5d-1f2a3b4c5d6e",
  "sessionId": "5b0c2a64-6f1e-4d8a-9a43-0e4c1c6f9d21",
  "kind": "WITHDRAWAL",
  "declaredCents": 100000,
  "receivedCents": null,
  "senderUserId": "7d2e9c10-4b8a-4f6e-9c1d-2a3b4c5d6e7f",
  "receiverUserId": "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
  "declaredAt": "2026-11-05T22:30:00.000Z",
  "receivedAt": null,
  "senderDisplayName": "Ana Cajera",
  "sourceRegisterName": "Caja Mostrador 2",
  "notes": "Entrego todo el efectivo"
}
```

A `FLOAT` item still also carries `sourceRegisterId` and `sourceDrawerReleasedAt`, as before:

```json
{
  "kind": "FLOAT",
  "senderDisplayName": "Ana Cajera",
  "sourceRegisterName": "Caja Mostrador 2",
  "notes": null,
  "sourceRegisterId": "a1f3e0b2-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  "sourceDrawerReleasedAt": null
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `senderDisplayName` | string \| `null` | Visible name of the person who handed the cash over (`senderUserId`). |
| `sourceRegisterName` | string \| `null` | Name of the register of the session the cash came from. |
| `notes` | string \| `null` | The notes the sender wrote when creating the handover. `null` when they wrote none. The receiver's receipt notes are not included. |

## Null semantics

- A name is `null` only when the user (or register) row cannot be found. Cash rows block deleting a user or register they reference, so in practice this does not happen; treat `null` as «Sin nombre» and fall back to the id if you need one.
- A user who has since left the sucursal or been deactivated **keeps** their name on historical sessions and handovers.
- Names are read at request time, so a renamed user or register shows the current name.
- `sourceRegisterName` is resolved only inside the active tenant; it is never taken from another sucursal.

## Unchanged

- Same permissions (`read:CashSession`, `read:CashSessionAudit`, `read:CashHandover`) and same per-row visibility.
- Custody items still never include source-session expected totals, movements or channel snapshots.
