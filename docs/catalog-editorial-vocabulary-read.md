# Dormant editorial vocabulary read

`readEditorialVocabulary(source, version)` reads once and returns the existing historical V1 projection or historical V2 envelope. Callers must supply an explicitly validated `1 | 2`; invalid runtime versions reject before reading.

## Boundary

- The awaited source read is outside representation translation. Database rejection and malformed snapshot-adapter errors retain identity.
- V1 receives the exact snapshot and its errors pass through unchanged.
- V2 receives that same object. Only `EditorialVocabularyRepresentationError` becomes a new `EditorialVocabularyUnrepresentableError`, with message `EDITORIAL_VOCABULARY_UNREPRESENTABLE` and the original error in `cause`.
- S23 representation failures reject the whole response (S35/S36 supersedes S29 classification): no metadata omission, version promotion, storage mutation or automatic adoption. Unexpected runtime and Unicode failures retain identity.

## Proof and limits

Tests compose the real `PrismaEditorialVocabularySnapshot` with real projectors over frozen raw storage-shaped fixtures. A mocked `$queryRaw` proves one query invocation and deterministic composition, not SQL execution or Prisma network decoding. The existing adapter uses one SQL statement; this function adds no snapshot-coherence guarantee beyond its source contract.

### Isolated SQL-to-response proof

The opt-in `prisma-editorial-vocabulary-snapshot.integration.spec.ts` also executes the adapter's exact SQL template through disposable PostgreSQL 16, then passes the real reader directly to this composition. It verifies:

- Missing global metadata rejects V2 while empty V1 remains readable.
- Valid custom metadata produces exact V1 and V2 envelopes, including archive flags, ordering and the canonical revision preimage.
- The S35/S36 fixture now expects storage column 1 and 2 to produce identical DTO/R with resolved policies; raw snapshots still retain the column and remain unchanged by reads. The updated opt-in proof passed both tests in parent job69; both owned containers were verified absent.
- Every composed read issues one query. Raw snapshots before/after successful and rejected reads remain equal.
- Both owned test containers are absent after cleanup.

Run the snapshot opt-in command described in [the snapshot proof guide](catalog-editorial-vocabulary-snapshot.md). S22 isolation remains mandatory: no host mounts, published ports, ambient database URL or production access. This proves actual PostgreSQL SQL-to-response composition, **not Prisma client/network decoding**.

S35/S36 run: preservation container `f7e954a4956ae13e6d203b21d0ac84878914f37aae9d29118180b852b4c3db98` and composition container `b33dcd336a419e0bcb3796199fd3b9f969748eed8534efdd83cc6ec1370992fa` were verified absent. The preceding job68 invocation failed before any test because of an incorrect Jest transform pattern; it is not SQL evidence.

Historical pre-S35 observation (not validation of the updated fixture): both integration tests passed. Preservation container `d18116678bbf827528e6ae8dcc9845912bf3ce6f0107129e3eaa140bb59e7fef` and composition container `491448a2454d27a5fdcc2602679cee2a4306062e3837de581a5df29859f3c3fb` were verified absent. These IDs are test-run evidence, not reusable cleanup targets.

This is dormant: no controller, module, provider, default version, header negotiation or live-reader replacement. Generic empty/custom vocabularies remain allowed; no full-production gate is introduced. S27's future HTTP `{statusCode,error}` mapping belongs to a transport adapter/filter, not this function. No HTTP behavior or activation is implemented here.
