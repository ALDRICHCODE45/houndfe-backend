# receipt-review Specification

## Requirements

### Requirement: Per-sale receipt review queue

The system MUST expose a tenant-scoped per-sale queue of receipt evidence for authorized reviewers. The queue MUST return only actionable `PENDING` `ReceiptEvidence` rows for reviewable sales and MUST expose the stored `mediaUrl` directly with the declared amount/reference/date and current sale payment state.

#### Scenario: List only pending receipts
- GIVEN a sale has `PENDING`, `CONFIRMED`, and `REJECTED` receipts
- WHEN a reviewer requests the sale receipt queue
- THEN only the `PENDING` receipt is returned
- AND the response includes `mediaUrl`

#### Scenario: Inactive sale is not actionable
- GIVEN a receipt belongs to a sale that is cancelled or otherwise not reviewable
- WHEN a reviewer requests the queue
- THEN that receipt is not returned

### Requirement: Receipt state guards

The system MUST allow review actions only for `PENDING` receipts. `CONFIRMED` and `REJECTED` receipts MUST NOT be actionable again, and the receipt review queue MUST exclude them.

#### Scenario: Confirmed receipt cannot be re-acted
- GIVEN a receipt is already `CONFIRMED`
- WHEN a reviewer attempts to reject it
- THEN the action is rejected
- AND no new payment or event is created

#### Scenario: Pending receipt remains actionable
- GIVEN a receipt is `PENDING`
- WHEN a reviewer opens the queue
- THEN the receipt is available for confirm or reject

### Requirement: Confirm receipt through the unified payment path

The system MUST let an authorized reviewer confirm a `PENDING` receipt by recording the real bank amount and creating the sale payment through the shared sale-payment flow. The confirmation MUST set the receipt to `CONFIRMED`, persist `confirmedByUserId` and `confirmedAt`, and set the sale to `PAID` when the real amount clears the full balance or `PARTIAL` when it does not. It MUST NOT produce `CREDIT`.

#### Scenario: Declared amount differs from real amount
- GIVEN `declaredAmountCents` differs from the real confirmed amount
- WHEN the reviewer confirms the receipt with the real amount
- THEN the real amount is used to update paid and debt amounts
- AND the receipt becomes `CONFIRMED`

#### Scenario: Multiple receipts accumulate payment
- GIVEN a sale already has one confirmed receipt and another `PENDING` receipt
- WHEN the reviewer confirms the second receipt
- THEN the additional payment is applied to the same sale
- AND the remaining debt is recalculated

#### Scenario: Partial confirmation leaves a balance
- GIVEN the real amount is less than the sale debt
- WHEN the reviewer confirms the receipt
- THEN the sale becomes `PARTIAL`
- AND a balance remains outstanding

### Requirement: Reject receipt with reason

The system MUST let an authorized reviewer reject a `PENDING` receipt with a mandatory free-text reason. Rejection MUST set the receipt to `REJECTED`, persist the reason in `rejectionReason`, and leave the sale awaiting a new receipt; it MUST NOT cancel the sale or impose a retry limit.

#### Scenario: Reject with reason
- GIVEN a receipt is `PENDING`
- WHEN the reviewer rejects it with a reason
- THEN the receipt becomes `REJECTED`
- AND the reason is stored

#### Scenario: Missing reason is invalid
- GIVEN a reviewer submits a reject action without text
- WHEN the request is processed
- THEN the request is rejected
- AND the receipt remains `PENDING`