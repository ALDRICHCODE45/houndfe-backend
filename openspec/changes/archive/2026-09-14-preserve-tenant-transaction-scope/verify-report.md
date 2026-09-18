```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:f424b5295cffae1c312e49f3451b8874edbeeb02dc3a1d9686839d0cc3ef9cc9
verdict: pass
blockers: 0
critical_findings: 0
requirements: 10/10
scenarios: 22/22
test_command: pnpm test -- src/shared/prisma/tenant-prisma.service.spec.ts
test_exit_code: 0
test_output_hash: sha256:a95703710f5be7b14db97f1d7544cd110b40f1d5071901f074e77694e507d859
build_command: pnpm build
build_exit_code: 0
build_output_hash: sha256:b8fdf000eae9126826084a1290fe36def0b65aeaa6959d1a6d7ddb5a62e7adf0
```

# Verification Report — PASS

Change: `preserve-tenant-transaction-scope` (WU2).

## Evidence

- `pnpm test -- src/shared/prisma/tenant-prisma.service.spec.ts` — exit 0; 11/11; `sha256:a95703710f5be7b14db97f1d7544cd110b40f1d5071901f074e77694e507d859`.
- `pnpm test:integration -- src/shared/prisma/tenant-prisma.service.integration.spec.ts` — exit 0; 8/8; `sha256:b02c41616131490615fb7840b113a7f2bfae696d9889c6747c58a83bb0699748`.
- `pnpm test:integration -- tenant-isolation.spec.ts` — exit 0; 7/7; `sha256:d8cd483df843d03f0fe76043c13d1d44fc57148e39dd7a87e9208c62ecd0eae9`.
- `pnpm build` — exit 0; `sha256:b8fdf000eae9126826084a1290fe36def0b65aeaa6959d1a6d7ddb5a62e7adf0`.
- `git diff --check` — exit 0 and clean.

`.env.test` SHA-256 remained `8e7ae32b553b01fc2b4f5b7b711ae9d6608f8a5bc2d626c23cd7bd848905d9d6`; mode remained `644`.

## Coverage and tasks

Requirements: 10/10. Scenarios: 22/22. Unit evidence covers extended-root provenance, CLS lifecycle, ambient identity, nested reuse, result forwarding, and error propagation. PostgreSQL evidence covers outer/nested reads, cross-tenant update/delete rollback, and outer/nested create attribution with unscoped persistence reloads. No unchecked WU1/WU2 implementation tasks remain.

## Scope and findings

Blockers: 0. Critical findings: 0. The production switch is limited to `runInTransaction()`; integration evidence is limited to WU2. Tracked candidate accounting is 44 additions and 50 deletions; the expected untracked WU2 integration spec is additional candidate content. The WU7 task records this prerequisite and remains blocked until local commit. Runtime SDD status/actionContext was not queried because independent verification is read-only and parent-owned.

## Verification notes

Strict TDD was not active (`tdd=false`), but apply progress records RED/GREEN evidence and the focused GREEN suites remain passing. Test assertions are behavior-bearing; no callback `$extends` assertion is used as extension-propagation proof. Prisma emitted pre-existing configuration-deprecation and major-version-update warnings only.

Evidence-revision relationship: `sha256:f424b5295cffae1c312e49f3451b8874edbeeb02dc3a1d9686839d0cc3ef9cc9` is the fresh PASS evidence bundle digest, distinct from stale failed evidence `sha256:2ad47c2a226ddc6afed4f49b46b4eacc24e06c523bfd951290f08b86cb142216` and remediation evidence `sha256:c0472556c5fcfae50302bb945f62f2070c46d475ded1804ef6042c7f7bd4e812`.
