# Dormant editorial vocabulary read

`readEditorialVocabulary(source)` awaits one read and always returns the complete canonical envelope via `materializeHistoricalVocabularyResponseV2`. There is no version argument, runtime version validation, V1 dispatch or return union.

## Boundary

- The awaited source read is outside representation translation. Database rejection and malformed snapshot-adapter errors retain identity.
- The canonical materializer receives the exact snapshot object. Only `EditorialVocabularyRepresentationError` becomes a new `EditorialVocabularyUnrepresentableError`, with message `EDITORIAL_VOCABULARY_UNREPRESENTABLE` and the original error in `cause`.
- S23 representation failures reject the whole response (S35/S36 supersedes S29 classification): no metadata omission, version promotion, storage mutation or automatic adoption. Unexpected runtime and Unicode failures retain identity.

## Proof and limits

Tests compose the real `PrismaEditorialVocabularySnapshot` with the real canonical materializer over frozen raw storage-shaped fixtures, checking exact body/R, detachment, archive ordering, stored-column 1/2 invariance and deferred single-read behavior. A mocked `$queryRaw` proves one query invocation and deterministic composition, not SQL execution or Prisma network decoding. The existing adapter uses one SQL statement; this function adds no snapshot-coherence guarantee beyond its source contract.

### Isolated SQL-to-response proof

The opt-in `prisma-editorial-vocabulary-snapshot.integration.spec.ts` also executes the adapter's exact SQL template through disposable PostgreSQL 16, then passes the real reader directly to this composition. It verifies:

- Missing global metadata rejects the whole response.
- Valid custom metadata produces the exact canonical envelope, including archive flags, ordering and the canonical revision preimage.
- Storage column 1 and 2 produce identical DTO/R with resolved policies; raw snapshots still retain the column and remain unchanged by reads.
- Every composed read issues one query. Raw snapshots before/after successful and rejected reads remain equal.
- Both owned test containers are absent after cleanup.

Run the snapshot opt-in command described in [the snapshot proof guide](catalog-editorial-vocabulary-snapshot.md). S22 isolation remains mandatory: no host mounts, published ports, ambient database URL or production access. This proves actual PostgreSQL SQL-to-response composition, **not Prisma client/network decoding**.

**Current single-contract fixture proof passed both tests in parent job74.** Preservation container `d85d3ed9a0d5e38edb0edaf81c8ad29368d386ef4132ad64286622023d98386d` and composition container `dc17eecf883400c0d5affea55b1785e042c58a1e54875db6b90e7b22edca3e3c` were verified absent by the harness. The following older results do not validate the updated fixture.

Historical S35/S36 run (parent job69, both tests passed): preservation container `f7e954a4956ae13e6d203b21d0ac84878914f37aae9d29118180b852b4c3db98` and composition container `b33dcd336a419e0bcb3796199fd3b9f969748eed8534efdd83cc6ec1370992fa` were verified absent. The preceding job68 invocation failed before any test because of an incorrect Jest transform pattern; it is not SQL evidence.

Historical pre-S35 observation (not validation of the updated fixture): both integration tests passed. Preservation container `d18116678bbf827528e6ae8dcc9845912bf3ce6f0107129e3eaa140bb59e7fef` and composition container `491448a2454d27a5fdcc2602679cee2a4306062e3837de581a5df29859f3c3fb` were verified absent. These IDs are test-run evidence, not reusable cleanup targets.

This is dormant: no controller, module, provider, header negotiation or live-reader replacement. Historical projectors and shared snapshot types are retained outside this slice; this API cannot dispatch V1. Generic empty/custom vocabularies remain allowed; no full-production gate is introduced. S27's future HTTP `{statusCode,error}` mapping belongs to a transport adapter/filter, not this function. No HTTP behavior or activation is implemented here.
