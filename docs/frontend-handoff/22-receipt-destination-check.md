# Receipt destination check (N18)

Status: implemented on `feat/receipt-destination-check`, not merged. Additive only: no existing key changes meaning.

## 1. What changed for staff

The chatbot can now read the **destination** of a transfer receipt (bank, beneficiary name, last 4 digits of the CLABE/account/card) and the payer name. At upload, the backend compares that destination with **every active payment account** of the sucursal (`payment_detail`, the accounts configured in admin) and stores the result once. It is never recomputed, even if the business accounts change later.

The result is a staff hint, like the amount mismatch: nothing is auto-rejected and the customer message does not change. A human always decides.

## 2. New key `destinationCheck`

| Value | Meaning | Suggested UI |
| --- | --- | --- |
| `"mismatch"` | The receipt was sent to an account that is not an active account of the business. | Warning, same style as the amount alert: «⚠ El destinatario no coincide con la cuenta del negocio». |
| `"match"` | The destination matches an active business account. | Nothing (optionally a subtle «Destinatario verificado»). |
| `"unknown"` | Not verified: the receipt had no destination data, the sucursal had no active account, or the receipt is older than this change. | Nothing (optionally «Destinatario no verificado»). **No alert.** |

Treat any other value as `"unknown"` (forward compatibility).

Rule used by the backend (for the tooltip or help text, not to recompute):

1. When the last 4 digits were read: `match` only if they are the last 4 of the CLABE or the account number of an active account.
2. Otherwise, when the beneficiary name was read: `match` if it looks like the beneficiary of an active account (at least two shared name words, or the only word of a one-word name; accents, case and punctuation ignored).
3. Otherwise `unknown`. The bank never decides.

`destinationCheck` is independent of `mismatch.flagged` (amount only). A receipt can show both alerts.

## 3. Where it appears

### Receipt review queues

`GET /sales/:id/receipts` and `GET /sales/receipts/pending` (see [08-transfer-receipts-review.md](08-transfer-receipts-review.md)): every item gets `destinationCheck` (always present, never `null`).

### Chatbot request detail

`GET /chatbot-requests/:id`, `decision` of subtype `TRANSFER_RECEIPT` (see [14-chatbot-request-inbox.md](14-chatbot-request-inbox.md)): gets `destinationCheck` (always present).

### Inside existing keys

- `extracted` may now carry four more optional keys, each present only when the chatbot read it:

  | Key | Type | Show as |
  | --- | --- | --- |
  | `destinationBank` | string (≤ 80) | «Banco destino» |
  | `destinationName` | string (≤ 120) | «Beneficiario» |
  | `destinationAccountLast4` | string, 4 digits | «Cuenta destino» as `****9616` |
  | `originName` | string (≤ 120) | «Ordenante» |

- `mismatch` may carry `destinationCheck` too (that is where it is stored). Read the top-level `destinationCheck` instead; it already applies the `unknown` default.

Example queue item (shortened):

```json
{
  "id": "6f1c…",
  "status": "PENDING",
  "saleDebtCents": 25000,
  "extracted": {
    "amountCents": 25000,
    "destinationBank": "BBVA MEXICO",
    "destinationName": "Abril Alejandra Vazquez Ramos",
    "destinationAccountLast4": "9616"
  },
  "mismatch": { "debtCents": 25000, "extractedDiffCents": 0, "flagged": false, "destinationCheck": "mismatch" },
  "destinationCheck": "mismatch",
  "createdAt": "2026-11-18T10:00:00.000Z"
}
```

## 4. Staff email

The `RECEIPT_REVIEW_REQUESTED` email adds the line «⚠ El destinatario del comprobante no coincide con la cuenta del negocio: verifica que el pago llegó antes de confirmar.» only when `destinationCheck` is `"mismatch"`. Nothing to build in the FE.

## 5. Not included

- No filter or sort by `destinationCheck` in the queues.
- The confirm and reject bodies are unchanged.
