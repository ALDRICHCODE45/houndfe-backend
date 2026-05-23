# Shared listing conventions

This folder defines shared query conventions for listing endpoints.

## Multi-value CSV fields

- Parse CSV values with trim + dedupe semantics.
- Empty values and trailing commas are ignored.
- Cardinality caps are enforced per field.
- Violations return `LISTING_TOO_MANY_VALUES`.

## Range fields

- Numeric ranges use `*Min` / `*Max` pairs.
- Date ranges use `*From` / `*To` pairs.
- Inverted bounds return `LISTING_INVERTED_RANGE`.

## Null inclusion flags

- `customerIncludeNull`
- `paymentMethodIncludeNull`
- `dueDateIncludeNull`

Flags are OR-composed with their paired filter.

## Listing error codes

- `LISTING_INVERTED_RANGE`
- `LISTING_INVALID_ENUM_VALUE`
- `LISTING_TOO_MANY_VALUES`
- `LISTING_INVALID_DATE`
- `LISTING_INVALID_UUID`
- `LISTING_INVALID_NUMBER`

## Error envelope

All listing validation errors return HTTP 400:

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

## Add a new listing endpoint

1. Define query DTO fields using decorators from `src/shared/listing`.
2. Keep HTTP parsing/validation in the DTO layer.
3. Convert DTO into typed filter value objects at service boundary.
4. Keep repository contracts typed; do not pass raw DTOs into repositories.
5. Extend README + tests when introducing new listing conventions.
