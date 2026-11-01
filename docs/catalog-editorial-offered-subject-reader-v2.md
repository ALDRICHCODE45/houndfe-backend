# Caller-transaction offered-subject reader

`readEditorialOfferedSubjectsV2(tx, scope)` loads a complete qualified Product
observation and invokes the existing pure all-context selector. Scope contains
trusted server-resolved actual tenant/Product IDs, captured before the first await.
Missing qualified Product fails `NOT_FOUND`; database errors propagate unchanged.

S78 uses every configured tenant binding regardless of `isActive` or
`catalogPublished`. No default fallback, positive-price prefilter, OFF-variant
pruning or pagination is applied during observation. Stale allowlist IDs remain
restricted, never converted into an empty allowlist. Variant prices are linked
using actual Product-price row IDs. Variants have deterministic ID ordering.

Every child collection has explicit tenant qualification; Product-owned children
and linked price lists also have Product qualification. Single-ID foreign keys
alone do not guarantee these boundaries. Mock tests assert exact query construction
and real-selector composition; they are not proof of database filtering.

The caller establishes current authority and owns the same ReadCommitted
transaction, with lifecycle SHARE → actual Tenant SHARE → qualified Product UPDATE
already held through validation, mutation, receipt and outer completion. This
adapter does not verify locks, acquire them, open a transaction, commit or write.
No existing writer, GET, public endpoint or publication flow calls it yet. Complete
transaction integration, cooperating-writer certification and PostgreSQL schedules
remain separate; `TransactionClient` is not proof of coordination or readiness.
