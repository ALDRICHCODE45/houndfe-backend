# sale-payments Specification

## Requirements

### Requirement: Sale payment authorization and reviewer routing

The system MUST allow payment registration when the actor owns the sale or is authorized to review the linked `ReceiptEvidence`, and it MUST continue to allow the original cashier path without regression. For cashier-created payments, `SalePayment.userId` MUST remain the cashier's user id. For receipt-confirmation payments, `SalePayment.userId` MUST be `NULL`, `SalePayment.method` MUST be `TRANSFER`, the bot-origin fact MUST be recorded in `SalePayment.metadataJson.origin`, and the human validator MUST be recorded on `ReceiptEvidence.confirmedByUserId` and `confirmedAt`.

#### Scenario: Original cashier can still add payment
- GIVEN the actor owns the sale
- WHEN the actor registers a normal payment
- THEN the payment succeeds
- AND the cashier path behaves as before
- AND `SalePayment.userId` is the cashier's user id

#### Scenario: Authorized reviewer can register receipt payment
- GIVEN a bot-created sale has actionable receipt evidence and the actor can update that `ReceiptEvidence`
- WHEN the actor confirms the receipt through the shared payment path
- THEN the payment succeeds even though the actor is not the original cashier
- AND `SalePayment.userId` is `NULL`
- AND `SalePayment.method` is `TRANSFER`
- AND `SalePayment.metadataJson.origin` records the bot-originated `ONLINE` sale context
- AND `ReceiptEvidence.confirmedByUserId` and `confirmedAt` are set to the reviewer and confirmation time

#### Scenario: Unauthorized non-owner is blocked
- GIVEN the actor does not own the sale and lacks receipt-review permission
- WHEN the actor attempts to register a payment
- THEN the request is rejected

### Requirement: Sale payment idempotency and events are preserved

The system MUST preserve the existing payment idempotency behavior and MUST continue to emit `sale.payment.received` for every created payment and `sale.fully.paid` when the sale debt reaches zero.

#### Scenario: Duplicate submission replays safely
- GIVEN a payment request has already succeeded for the same idempotency key
- WHEN the actor submits the same request again
- THEN the original result is returned
- AND no duplicate payment or event is created

#### Scenario: Fully settled sale still emits both events
- GIVEN a payment settles the remaining debt to zero
- WHEN the payment is registered through the unified path
- THEN `sale.payment.received` is emitted
- AND `sale.fully.paid` is emitted

### Requirement: Cancellation Refund Audit Preserves Payment History

The system MUST record sale refunds in dedicated refund rows whose total matches the original recorded payment total for the canceled sale. The original sale payment records and the sale's financial totals MUST remain available for audit on the canceled sale.

#### Scenario: Refund rows match the original payments
- GIVEN a CONFIRMED sale with one or more recorded payments is canceled
- WHEN the refund audit is stored
- THEN the sum of refund amounts equals the sum of the original payment amounts
- AND the original payment rows remain unchanged

#### Scenario: Canceled sale keeps financial audit values
- GIVEN a sale is canceled
- WHEN the sale is read later for audit
- THEN its original financial totals are still available