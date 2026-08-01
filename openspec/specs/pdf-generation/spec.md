# Delta: PDF Generation — Quotation-A4 Format

## ADDED Requirements

### Requirement: Quotation-A4 Format Registration
**Status**: ADDED
**Priority**: P0

The PDF generation template registry MUST register a new `quotation-a4` format key mapped to a `QuotationA4Template` React component. The template MUST reuse the existing `@react-pdf/renderer` `<Document>`/`<Page>` shell pattern from `receipt-a4` but with quotation-specific header, items table, totals, and footer. The template MUST NOT include payment-related sections (amount paid, cambio, payment method).

#### Scenario: quotation-a4 is registered in the format registry
- **GIVEN** the `FormatKey` enum includes `quotation-a4`
- **WHEN** `PdfGenerationService` resolves the template for format `quotation-a4`
- **THEN** the `QuotationA4Template` React component is returned

#### Scenario: quotation-a4 header renders "COTIZACIÓN"
- **GIVEN** a quotation with tenant info and a customer
- **WHEN** the `quotation-a4` template renders the header
- **THEN** the document title is "COTIZACIÓN" (not "RECIBO" or "TICKET")

#### Scenario: quotation-a4 footer has no payment lines
- **GIVEN** a quotation with items and totals
- **WHEN** the `quotation-a4` template renders the footer
- **THEN** the footer contains totals summary and expiry date (if set)
- **AND** the footer does NOT contain "Pagado", "Cambio", or payment method fields

---

### Requirement: Quotation PDF Route
**Status**: ADDED
**Priority**: P0

The PDF generation controller MUST expose `GET /quotations/:id/pdf?format=quotation-a4`. The route MUST load the quotation via `QuotationsService`, render it through the `quotation-a4` template, and return the PDF stream.

#### Scenario: PDF route renders quotation
- **GIVEN** a quotation with id Q1, items, and customer
- **WHEN** `GET /quotations/:id/pdf?format=quotation-a4` is called
- **THEN** `QuotationsService.getQuotationById(Q1)` is called
- **AND** `PdfGenerationService.renderQuotationPdf(quotation, 'quotation-a4')` is called
- **AND** the response is `application/pdf` with `Content-Disposition: inline`

#### Scenario: Non-existent quotation returns 404
- **GIVEN** no quotation with id Q-MISSING
- **WHEN** `GET /quotations/:id/pdf?format=quotation-a4` is called
- **THEN** the request returns 404

#### Scenario: Cross-tenant quotation on PDF route returns 404
- **GIVEN** quotation Q1 belongs to tenant T1
- **WHEN** a user from tenant T2 calls `GET /quotations/:id/pdf` for Q1
- **THEN** the request returns 404

---

### Requirement: PdfGenerationModule Imports QuotationsModule
**Status**: ADDED
**Priority**: P0

`PdfGenerationModule` MUST import `QuotationsModule` so the PDF service can resolve quotation data for rendering.

#### Scenario: Module wiring resolves QuotationsService
- **GIVEN** `PdfGenerationModule` imports `QuotationsModule`
- **WHEN** the NestJS DI container resolves `PdfGenerationService`
- **THEN** `QuotationsService` is injectable and usable for quotation PDF rendering
