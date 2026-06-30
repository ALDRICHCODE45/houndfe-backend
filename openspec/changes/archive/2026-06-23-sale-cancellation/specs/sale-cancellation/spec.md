# Delta for sale-cancellation

## ADDED Requirements

### Requirement: Confirmed Sale Cancellation

The system MUST allow cancellation of a CONFIRMED sale that is not SHIPPED or DELIVERED. A successful cancellation MUST change the sale status to CANCELED, restore stock for the sold items, record a full refund for all recorded payments, and emit exactly one `sale.canceled` event.

#### Scenario: Confirmed non-delivered sale is canceled
- GIVEN a sale is CONFIRMED and not SHIPPED or DELIVERED
- WHEN an authorized actor cancels the sale with a valid reason
- THEN the sale status becomes CANCELED
- AND stock is restored for every sold item
- AND a refund is recorded for the full payment total
- AND `sale.canceled` is emitted once

#### Scenario: Cancellation does not publish on failure
- GIVEN cancellation fails validation or state checks
- WHEN the request is processed
- THEN the sale remains unchanged
- AND no refund is recorded
- AND no `sale.canceled` event is emitted

### Requirement: Credit Sale Cancellation

The system MUST cancel a CONFIRMED CREDIT sale by restoring stock, clearing debt, and recording zero refunded cents.

#### Scenario: CREDIT sale cancels without money refund
- GIVEN a CONFIRMED sale with payment method CREDIT
- WHEN the sale is canceled successfully
- THEN stock is restored
- AND refunded cents are 0
- AND the sale debt is cleared

### Requirement: Cancellation Guard and Reason

The system MUST reject cancellation unless the sale is CONFIRMED and not SHIPPED or DELIVERED. The cancellation request MUST include a reason from `CUSTOMER_REQUEST`, `ORDER_ERROR`, `OUT_OF_STOCK`, `DUPLICATE_SALE`, or `OTHER`.

#### Scenario: Invalid state is rejected with conflict
- GIVEN a sale is DRAFT, SHIPPED, or DELIVERED
- WHEN a cancellation is requested
- THEN the request fails with 409 Conflict

#### Scenario: Missing or invalid reason is rejected
- GIVEN a cancellation request without a valid enum reason
- WHEN the request is submitted
- THEN the request is rejected

### Requirement: Idempotent Cancellation

The system MUST make cancellation retries safe. Repeating the same cancellation request MUST not double-restock items, double-record refunds, or duplicate the cancellation event.

#### Scenario: Retry returns the original outcome
- GIVEN a cancellation already succeeded for the same idempotency context
- WHEN the request is retried
- THEN the original cancellation result is returned
- AND no additional stock or refund side effects occur

### Requirement: Admin Cancellation Access

The system MUST expose `POST /sales/:id/cancel` and MUST require `delete:Sale` permission to use it.

#### Scenario: Authorized admin cancels a sale
- GIVEN the caller has `delete:Sale`
- WHEN the caller posts to `/sales/:id/cancel`
- THEN the cancellation is accepted if the sale is otherwise eligible

#### Scenario: Unauthorized admin caller is rejected
- GIVEN the caller lacks `delete:Sale`
- WHEN the caller posts to `/sales/:id/cancel`
- THEN the request is rejected
