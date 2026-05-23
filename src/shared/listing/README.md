# Shared listing conventions

This folder defines shared query conventions for listing endpoints.

## Multi-value transport (CSV)

- Transport format is CSV in a single query param: `?field=A,B,C`.
- Parse behavior is **trim + dedupe**:
  - `A, B ,A` → `['A', 'B']`
  - Empty fragments are discarded: `A,, ,B,` → `['A', 'B']`
- Empty or whitespace-only values are treated as absent (no filter).

## Cardinality caps

- Enum-typed CSV filters: max **50** values.
- UUID and free-form string CSV filters: max **200** values.
- Exceeding the cap returns `LISTING_TOO_MANY_VALUES`.

## Range fields

- Numeric ranges use `*Min` / `*Max` (example: `totalMin`, `totalMax`).
- Date ranges use `*From` / `*To` (example: `confirmedFrom`, `confirmedTo`).
- Bounds are **inclusive** (`>= min/from` and `<= max/to`).
- Dates are interpreted in **UTC**.
- Inverted bounds return `LISTING_INVERTED_RANGE`.

## Null inclusion flags (explicit booleans)

- Null inclusion is modeled with dedicated boolean flags, for example:
  - `customerIncludeNull`
  - `paymentMethodIncludeNull`
  - `dueDateIncludeNull`
- Do **not** use reserved tokens inside arrays (for example, no `NULL` sentinel mixed into CSV values).
- Rationale: explicit flags keep value domains clean, avoid token collisions, and preserve type-safe DTO validation.

## AND/OR semantics (locked)

- **AND** between distinct filters.
- **OR** within values of the same filter (multi-value `IN` semantics).
- No `NOT` operator and no arbitrary boolean expression tree.

## Listing error codes

- `LISTING_INVERTED_RANGE`
- `LISTING_INVALID_ENUM_VALUE`
- `LISTING_TOO_MANY_VALUES`
- `LISTING_INVALID_DATE`
- `LISTING_INVALID_UUID`
- `LISTING_INVALID_NUMBER`

## Error envelope

All listing validation errors return HTTP 400 with this shape:

```json
{
  "statusCode": 400,
  "code": "LISTING_INVALID_ENUM_VALUE",
  "message": "paymentStatus is invalid",
  "field": "paymentStatus",
  "details": {
    "allowed": ["PAID", "PARTIAL", "CREDIT"]
  }
}
```

Envelope contract:

- `{ statusCode, code, message, field, details? }`
- `details` is optional and may include structured context (for example `allowed`, `cap`, `min`, `max`).

## Decorators available

### `@CsvEnum(...)`

```ts
@CsvEnum(ListSalesPaymentStatus, { max: 50, field: 'paymentStatus' })
paymentStatus?: ListSalesPaymentStatus[];
```

### `@CsvUuid(...)`

```ts
@CsvUuid({ max: 200, field: 'customerId' })
customerId?: string[];
```

### `@CsvString(...)`

```ts
@CsvString({ max: 200, field: 'folio' })
folio?: string[];
```

### `@NumericRange(...)`

```ts
@NumericRange({ peer: 'totalMax', role: 'min', field: 'total' })
totalMin?: number;

@NumericRange({ peer: 'totalMin', role: 'max', field: 'total' })
totalMax?: number;
```

### `@DateRange(...)`

```ts
@DateRange({ peer: 'confirmedTo', role: 'from', field: 'confirmedAt' })
confirmedFrom?: Date;

@DateRange({ peer: 'confirmedFrom', role: 'to', field: 'confirmedAt' })
confirmedTo?: Date;
```

## Add a new listing endpoint (5-step recipe)

1. Define query DTO fields with shared decorators from `src/shared/listing`.
2. Ensure `ValidationPipe.exceptionFactory` maps listing validation contexts to the listing envelope (if not already global).
3. Translate DTO values into typed repository filters and then into Prisma `where` clauses.
4. Add tests for parser/decorator behavior, DTO validation, and repository WHERE semantics.
5. Document endpoint-specific filter contract in frontend-facing docs and link to this conventions README.
