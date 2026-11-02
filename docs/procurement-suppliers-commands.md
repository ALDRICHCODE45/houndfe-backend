# Supplier commands (O3a A2 command subunit)

**Unwired service, not an available API.** No controller, module registration,
list/detail reader, history endpoint or automatic role grant is added. A3 owns
HTTP authentication, raw-header duplicate admission, no-store and route wiring.
Root API3000 and existing databases are outside this unit.

## Public boundary

`SupplierCommands.create(key, unknownBody)` and
`SupplierCommands.update(unknownId, key, unknownBody)` return
`{ statusCode: 201 | 200, body: Supplier }`. Actor/tenant come only from authenticated
CLS (`userId`, `tenantId`), not arguments, body or caller permission flags. This
service does not authenticate JWTs; future HTTP wiring must populate trusted CLS.

Every call reuses the wire foundation's closed parsers, ID policy, exact
idempotency-key value validation and canonical body hash. A future route must
additionally call `parseSupplierIdempotencyKey(req.rawHeaders)` to detect duplicate
headers before calling the service. Inputs and identity are captured before awaits.
Terms omission preserves, null clears; status patches explicitly archive/reactivate.
Archived suppliers remain editable. Each fresh accepted update, including an
explicit same-value patch, consumes one version; there is no inferred transition.

Registry adds exactly create/read/update on `ProcurementSupplier`; no role grants,
default assignments, delete/manage row or purchase-order subject. Creation requires
create only; update requires read AND update. CASL retains ordinary manage/all
implication. A global super-admin claim or global role without selected-tenant
membership is not a bypass. No editorial administrator exception is copied.

## Transaction and recovery

1. Reject absent principal/tenant and ambient transactions. Use
   `TenantPrismaService.runInTransaction(..., ReadCommitted)` with its own transaction.
2. Reuse lifecycle shared gate, then lock selected Tenant FOR SHARE and require
   persisted active Tenant. Lock current User FOR SHARE and require active User.
3. Read selected-tenant membership → Role → RolePermission → Permission with
   `FOR SHARE OF m,r,rp,p`. Membership has **no active flag** in the current schema:
   persisted presence is membership. A role must belong to that tenant or be a
   legacy global role attached through that membership. Evaluate current CASL
   create or read+update inside this transaction, before any receipt disclosure.
4. Try a transaction advisory lock: signed first 64 SHA-256 bits of JSON tuple
   `["procurement-supplier-command-v1",tenant,actor,operation,target,exactKey]`.
   Busy returns `IDEMPOTENCY_KEY_IN_FLIGHT`; no retry, lease or durable busy row.
5. Query receipt by **all five namespace fields**, not advisory/body hash alone.
   CREATE target is literal `collection`; UPDATE target is normalized supplier UUID.
   Same namespace/different canonical body hash returns `IDEMPOTENCY_KEY_CONFLICT`.
   Same hash returns detached original HTTP status/body immediately, even after
   subsequent edits/archive. No current supplier/CAS/status check on replay.
6. Only fresh updates lock tenant-qualified supplier FOR UPDATE, then check CAS
   and SQL INTEGER ceiling (2147483647). Missing/foreign root is NOT_FOUND after
   authority. Conditional update increments exactly once; no automatic CAS refresh.
7. Supplier, resulting version, persisted UTC-ISO wire snapshot audit and original
   response receipt commit together. Audit/receipt errors roll back supplier too.
   Unknown failures are replaced with value-free INTERNAL_ERROR; driver causes
   are never returned. No cleanup/expiry or audit/receipt mutation API exists.

### Authority lock evidence and limits

`PrismaRoleRepository.assignPermissions` deletes/recreates role_permissions without
first locking Role. Locking Role alone would not protect current grants. The new
query locks the actual joined grant tuples, plus membership/role/permission; user
and tenant activity rows are also held. Ordinary updates/deletes of those tuples
must serialize. New grant gaps are not locked: absence denies, never authorizes.

This is a new feature-local lock query, not a change to existing writers. Broad
lock-graph/deadlock freedom is **not established**. Multi-statement writers can
still deadlock; unexpected database failures roll back and become INTERNAL_ERROR,
not partial success. Parent independent review must verify PostgreSQL join-lock
semantics and compatibility with authority writers (risk 2), gate/CAS serialization
and transaction rollback (risk 4). A receipt is historical acknowledgement, not
current authority/state. No stock, money, CxP, purchase order, outbox or send path
is invoked.

## Evidence and remaining parent execution

Offline test-first: public-interface stub rejected with `Not implemented`; intended
command assertions failed, supplier registry was empty, existing wire104 remained
passing. One test-table argument shape was corrected before GREEN (not production
behavior evidence). Baseline registry SHA-256 pins all pre-existing entries and
order; supplier-only entries are checked separately. Offline mocks cover authority
before replay, exact namespaces/gates, CAS/ceiling/lost-write branch, original replay,
archive/reactivation, null/omission, audit/receipt rollback and sanitized failures.
Latest offline validation: **134 tests PASS** (wire104, command27, registry2,
fixture drift guard1),
explicit scoped no-emit TypeScript PASS, scoped ESLint PASS and diff whitespace
check PASS. Mock refinements added namespace/lock-shape/CAS-hash triangulation.
Mocks establish branch contracts, **not PostgreSQL locking or rollback**.

`supplier-commands.integration.spec.ts` is authored for the existing guarded
integration config/global setup. **Not executed by this writer.** Parent must
verify the exact newly owned disposable database before invoking that config;
normal test URL validation alone does not establish ownership. Specs use random
owned tenant/user/role fixtures left only in that disposable target, no cleanup
deletes or shared seed updates. Permission lookup may insert missing supplier
registry identities, never modifies existing grants. Cases cover real persisted
wire/audits/replay, four authority revocations, cross-tenant roots/actor namespaces,
two-key concurrent CAS, externally held same-key gate and manual recovery,
grant-edge lock timeout followed by revocation/replay denial, and injected
audit/receipt failures in real transactions. The grant-lock probe pauses only the
fresh receipt lookup after the real query and authority acquisition; it is not a full HTTP test.
Zero-effect assertions sample owned-tenant products/sales/payments/outbox; source
inspection additionally bounds the service to supplier/audit/receipt delegates.

### Parent SQL correction and independent verification

Parent job8 reported offline142 PASS (including storage9), SQL26 PASS/3 FAIL:
the grant barrier and both injected-failure cases did not reach their intended
observation points. The isolated Prisma runtime's raw methods depend on receiver
state (`this._createPrismaPromise`, `this.$executeRawInternal`). Fixture object
spreads flatten the client proxy and change that receiver; ordinary uninjected
command SQL cases passed. No production defect is inferred from these failures.

One correction batch replaces both spreading sites with a narrow fixture-local
Proxy. Nonintercepted methods delegate bound to the original transaction/delegate;
the receipt barrier now invokes the original query before pausing. The explicit
barrier-reached assertion, both actual-write observations, exact SQLSTATE55P03
lock-timeout assertion and rollback/effect checks remain intact. A focused offline
drift guard failed before the correction (1 FAIL/133 PASS), then passed with the
whole authorized offline set (134 PASS); this guard catches client spreading,
**not database behavior**. No SQL was executed by the writer. Scoped types, lint
and whitespace checks passed. Parent job9 refreshed disposable target ownership
and passed all 143 offline tests and 29 PostgreSQL tests, including the three
previously failing grant-lock and rollback cases. Existing databases were untouched.

Independent verification passed scoped S1–S4: 134 tests in an isolated scratch
copy, scoped TypeScript, permission-registry diff and whitespace checks. The
verifier read the parent SQL logs; it did not independently execute SQL. Grant-edge
UPDATE locking is experimentally covered; compatibility with the existing
permission delete/recreate writer also relies on source and locking analysis.
Exhaustive authority race schedules and deadlock freedom remain unproven.

The broad parent suite initially stopped because isolated AppModule tests lacked
required environment configuration; its chained build did not execute. A run
with synthetic offline configuration passed: 507 suites and 12,735 tests passed;
one suite and 58 tests were skipped. The chained Nest build also exited zero.
No HTTP, browser or native-review approval is claimed by these command-unit results.

S1/S2: supplier commands/audit only, current configurable permissions, CAS/replay.
S3: exact wire foundation reused; all responses use persisted values and UTC ISO.
List/search/cursors/HTTP remain A3. S4: no DB execution, runtime, installs, secrets,
migrations, publication, commits or unrelated edits in this writer session.

Rollback boundary: remove the two command/authority files, their two command specs,
supplier permission spec, three registry entries/subject and this document. Keep
A1 storage and the earlier wire foundation independently reviewable. No operational
or destructive rollback command is supplied. Runtime harness: N/A for this unwired
unit; real database/integration and isolated runtime proof remain parent-owned.
