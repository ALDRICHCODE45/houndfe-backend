# Delta: Send and PDF — Quotations

## ADDED Requirements

### Requirement: Send Quotation Email (Auto-SENT)
**Status**: ADDED
**Priority**: P0

The system MUST expose an endpoint to email a quotation PDF to the assigned customer. On successful email delivery, the quotation MUST transition to `SENT` atomically. If the customer has no email, the endpoint MUST reject with 422. If the email provider (Resend) fails, the quotation MUST stay in `DRAFT` and the endpoint MUST return 502. The `send` endpoint is the ONLY gate to `SENT` status — there is no manual transition.

#### Scenario: Send succeeds — status flips to SENT
- **GIVEN** a DRAFT quotation with items, customer C1 (email: c1@example.com), and a rendered PDF
- **WHEN** `POST /quotations/drafts/:id/send` is called
- **THEN** `mailer.send()` is called with `to: c1@example.com`, subject, HTML body, and PDF attachment
- **AND** on Resend success response, quotation.status becomes `SENT`
- **AND** the response returns `200 { status: 'SENT' }`

#### Scenario: Customer has no email — rejected with 422
- **GIVEN** a DRAFT quotation with customer C2 (email: null)
- **WHEN** `POST /quotations/drafts/:id/send` is called
- **THEN** the request is rejected with 422 and error code `QUOTATION_CUSTOMER_HAS_NO_EMAIL`
- **AND** quotation.status stays `DRAFT`

#### Scenario: Email provider fails — stays DRAFT, returns 502
- **GIVEN** a DRAFT quotation with a valid customer email, and Resend returns an error
- **WHEN** `POST /quotations/drafts/:id/send` is called
- **THEN** quotation.status stays `DRAFT` (NOT committed to SENT)
- **AND** the request returns 502 with error details
- **AND** the SENT transition and email send share the same atomic flow (status changes only on mailer success)

#### Scenario: Send on non-DRAFT quotation is rejected
- **GIVEN** a quotation with status `SENT`
- **WHEN** `POST /quotations/drafts/:id/send` is called
- **THEN** the request is rejected with 409

#### Scenario: Send on quotation with no items is rejected
- **GIVEN** a DRAFT quotation with zero items
- **WHEN** `POST /quotations/drafts/:id/send` is called
- **THEN** the request is rejected with 422

---

### Requirement: PDF Preview for Quotation
**Status**: ADDED
**Priority**: P1

The system MUST allow rendering a quotation PDF in `quotation-a4` format regardless of status (DRAFT previews allowed). The PDF MUST include the quotation header with "COTIZACIÓN" title, items table, totals section, expiry date (if set), and footer (no payment/cambio lines).

#### Scenario: Render PDF for DRAFT quotation
- **GIVEN** a DRAFT quotation with items, customer, and price list
- **WHEN** `GET /quotations/:id/pdf?format=quotation-a4` is called
- **THEN** a PDF is rendered with the `quotation-a4` template and returned as `application/pdf`

#### Scenario: Render PDF for SENT quotation
- **GIVEN** a SENT quotation with items
- **WHEN** `GET /quotations/:id/pdf?format=quotation-a4` is called
- **THEN** a PDF is rendered successfully (PDF is the historical snapshot of the sent quote)

#### Scenario: Render PDF for EXPIRED quotation
- **GIVEN** an EXPIRED quotation
- **WHEN** `GET /quotations/:id/pdf?format=quotation-a4` is called
- **THEN** a PDF is rendered successfully

#### Scenario: Unknown format returns 400
- **GIVEN** any quotation
- **WHEN** `GET /quotations/:id/pdf?format=invalid` is called
- **THEN** the request is rejected with 400

#### Scenario: PDF does NOT include payment/cambio section
- **GIVEN** a quotation with items and totals
- **WHEN** the `quotation-a4` PDF is rendered
- **THEN** the PDF contains "COTIZACIÓN" header
- **AND** the PDF does NOT contain payment amount, cambio, or payment method fields (unlike `receipt-a4`)
- **AND** the PDF does contain an expiry date line if `expiresAt` is set
