# Chatbot API Foundation Specification

## Purpose

Expose an internal, authenticated service-to-service API so the separate WhatsApp chatbot service can operate HoundFe POS data without human JWT auth, internal data leakage, or direct database access.

## Repo Reality Findings

- Sales currently support `DRAFT` and `CONFIRMED`; payment status is `PAID`, `PARTIAL`, or `CREDIT`; delivery status is only `PENDING`, `DELIVERED`, or `NOT_APPLICABLE`. Carrier, tracking reference, ETA, receipt evidence, and explicit pending-payment status are missing.
- Customers and addresses exist, but no dedicated phone lookup, visual references, carrier-reachable phone, or preferred payment method fields exist.
- Promotions module exists with rich promotion definitions, but no cart/promotion evaluation API exists.
- Public catalog exists and is tenant-scoped by slug, but it does not expose package/weight data and only searches product name/brand.

## Requirements

### Requirement: Service Credential Authentication

The system MUST authenticate chatbot-service calls with a non-human service credential scoped to one or more branches and permissions, and MUST support credential rotation, revocation, rate limiting, and audit attribution.

#### Scenario: Authorized bot call
- GIVEN an active bot credential scoped to branch A and catalog-read permission
- WHEN the bot calls a branch A catalog endpoint
- THEN the request succeeds without a human JWT
- AND the audit trail records the credential identity and branch scope

#### Scenario: Revoked or out-of-scope credential
- GIVEN a revoked credential or a credential scoped only to branch A
- WHEN the bot calls a branch B sale endpoint
- THEN the request is rejected
- AND no domain mutation occurs

### Requirement: Bot-Safe Catalog Search

The system MUST provide free-text product search for conversation use by name, brand, and variant where available, returning only bot-safe fields: product/variant identity, name, brand, image, public description, price, promo-aware price summary, stock summary, and package/weight data needed for later shipping quotes. It MUST NOT expose cost, margin, supplier, tenant internals, or audit fields.

#### Scenario: Search returns safe projections
- GIVEN matching catalog products exist
- WHEN the bot searches by product or brand text
- THEN results include bot-safe price, promotion, stock, and package data
- AND internal financial or supplier fields are absent

#### Scenario: No matching product
- GIVEN no product matches the query
- WHEN the bot searches the catalog
- THEN the API returns an empty result set, not an error

### Requirement: Branch Stock Check

The system MUST expose per-product and per-variant stock for the credential's branch scope, distinguishing available, low stock, zero stock, and not-stock-managed states.

#### Scenario: Zero stock is answerable
- GIVEN a valid product has zero stock in the requested branch
- WHEN the bot checks stock
- THEN the API returns `out_of_stock` with quantity `0`
- AND it does not treat the condition as an exception

#### Scenario: Unknown product
- GIVEN the product ID does not exist in the credential's branch scope
- WHEN the bot checks stock
- THEN the API returns a not-found error

### Requirement: Promotion-Aware Pricing

The system MUST return pricing that reflects active promotions applicable at quote time. If automatic promotion evaluation is incomplete, the response MUST expose a clear `promotionEvaluationStatus` so the bot can request human confirmation instead of inventing a discount.

#### Scenario: Active promotion applies
- GIVEN an active promotion applies to requested cart items
- WHEN the bot requests pricing
- THEN the API returns original price, applied promotion label, discount amount, and final price

#### Scenario: Promotion engine cannot evaluate cart
- GIVEN active promotions exist but no complete evaluator supports the request
- WHEN the bot requests pricing
- THEN the API returns base pricing with `promotionEvaluationStatus: needs_human_review`

### Requirement: Customer Profile by WhatsApp Phone

The system MUST lookup, create, and update customer profiles by normalized phone number for WhatsApp identity, including name, address, visual delivery references, postal code, carrier-reachable phone, and preferred payment method.

#### Scenario: Returning customer lookup
- GIVEN a customer exists with the WhatsApp phone number
- WHEN the bot looks up the profile
- THEN the API returns customer identity, saved delivery data, and preferred payment method

#### Scenario: New delivery data is captured
- GIVEN no customer exists for a WhatsApp phone number
- WHEN the bot creates a profile with delivery data
- THEN the API stores the customer and delivery profile within the credential's branch scope

### Requirement: Order History for Reorder

The system MUST provide recent confirmed sale history by customer phone so the bot can support "same as last time" reorder flows without exposing internal-only sale data.

#### Scenario: Last order found
- GIVEN a customer has a previous confirmed sale
- WHEN the bot requests order history by phone
- THEN the API returns recent products, quantities, delivery profile, payment method, and totals

#### Scenario: No prior orders
- GIVEN a customer has no confirmed sales
- WHEN the bot requests order history
- THEN the API returns an empty history, not an error

### Requirement: Bot Sale Registration

The system MUST let the bot create an `ONLINE` sale through existing sale aggregates with customer, address, items, promo-aware prices, and payment method. Bot-created transfer sales MUST support the lifecycle created/pending-payment → paid by human confirmation → delivery scheduled/shipped with carrier, tracking reference, and ETA.

#### Scenario: Pending transfer sale created
- GIVEN a validated cart and customer delivery profile
- WHEN the bot registers a transfer sale
- THEN the API creates an `ONLINE` sale awaiting human payment confirmation
- AND the sale remains auditable to the bot credential

#### Scenario: Delivery metadata recorded
- GIVEN a bot-created sale exists and a human has already confirmed payment so the sale payment status is `PAID`
- WHEN delivery is scheduled or shipped
- THEN the API records carrier, tracking reference, ETA, and delivery status

### Requirement: Receipt Attachment and Human Payment Confirmation

The system MUST allow the bot to attach transfer receipt evidence to a pending sale and MUST require a human actor to confirm or reject payment before the sale becomes paid.

#### Scenario: Receipt attached
- GIVEN a pending transfer sale exists
- WHEN the bot attaches media URL or media ID, declared amount, date, and reference
- THEN the receipt is stored as pending evidence
- AND the sale is not marked paid automatically

#### Scenario: Human confirms payment
- GIVEN pending receipt evidence exists
- WHEN an authenticated human confirms the payment amount and reference
- THEN the system records the transfer payment and marks the sale paid when fully covered

### Requirement: Audit, Idempotency, and Abuse Controls

The system MUST audit every bot read/write action, enforce idempotency for sale and payment mutations, validate all input DTOs, and apply credential-specific rate limits.

#### Scenario: Idempotent sale registration
- GIVEN the bot retries sale creation with the same idempotency key
- WHEN the previous request already succeeded
- THEN the API returns the original sale result without creating a duplicate sale

#### Scenario: Rate limit exceeded
- GIVEN the bot credential exceeds its configured rate limit
- WHEN another request arrives in the same window
- THEN the API rejects it with a retryable rate-limit response

### Requirement: Chatbot Sale Cancellation Endpoint

The system MUST expose `POST /chatbot-api/sales/:saleId/cancel` for the chatbot service, and the request MUST require the `sales:write` scope.

#### Scenario: Scoped chatbot client cancels a sale
- GIVEN the caller has `sales:write`
- WHEN the caller posts a valid cancellation request
- THEN the sale cancellation is accepted if the sale is otherwise eligible

#### Scenario: Missing scope is rejected
- GIVEN the caller lacks `sales:write`
- WHEN the caller posts to the cancel endpoint
- THEN the request is rejected
