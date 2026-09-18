# Quotation product IVA — customer PDF and deprecation (WU3)

Finish the backend feature: show customers one included-IVA amount without changing the quoted total, and signal that the manual tax-rate endpoint is deprecated.

## Scope and decisions
- User authorized WU3 in ODD; historical OpenSpec artifacts are reference inputs, not an active SDD workflow.
- WU1/WU2 implementation, normalization and acknowledged review remain complete; do not repeat them.
- Baseline: `/tmp/quotation-iva-wu3-baseline-v0jty11w`; six source files backed up, 1,130-path hash manifest recorded, index empty.
- Parent verified the five completed normalization hashes and temporary configuration hash before WU3.
- Keep `.pi-lens.json` intact. User explicitly accepted static mutation-disable evidence for WU3; live effective settings remain unproven. Stop on unexpected drift.
- Isolation removal remains separately blocked on the original successful deferred-drain evidence; no restart or new turn substitutes for it.
- Exclude frontend, schema/migrations, tax math, source cleanup, model/config changes, SDD/reset, staging, commits, push, PR and merge.
- Preserve cleanup3 accounting at 319/320 total and 73/74 evidence; WU3 is separate authorized work, not a budget reset.

## Allowed source changes
- `src/pdf-generation/pdf-generation.service.ts` and `.spec.ts`.
- `src/pdf-generation/templates/quotation/quotation-a4.document.tsx` and `.spec.tsx`.
- `src/quotations/controllers/quotations.controller.ts` and `.spec.ts`.
- This tracker is parent-owned; preserve all historical trackers and evidence.

## Tasks and acceptance
- [x] W3.1 — PDF: map `includedIvaCents` to the sum of breakdown amounts only when items and breakdown are nonempty; otherwise `null`. Render exactly one `IVA incluido` row before the divider when the value is not null. Known zero must render; unavailable IVA must not. Preserve existing totals, layout, and stream/buffer behavior; disclose no rates or classifications.
- [x] W3.2 — Deprecation: add `Deprecation: true` on the existing tax-rate PATCH without changing the route, DTO, guards or service call. Test header metadata and delegation; preserve DRAFT-only behavior and existing service-level tax isolation coverage. Do not claim direct controller unit tests prove HTTP status handling.
- [x] W3.3 — Verification: focused PDF/controller tests, full unit suite, build, diff-check and scope/hash guards pass. Report pre-existing failures and any untested HTTP/integration boundary honestly; evaluate the new WU3 candidate without reopening the completed WU2 review.
- [ ] W3.R — Separate review follow-up: resolve a WU3-only native review scope without repeating WU2 or performing unauthorized Git delivery operations. Current workspace projection includes both work units; no new review was started.

## Verification contract
- Global TDD is off (`openspec/config.yaml`, `apply.tdd: false`); W3.1/W3.2 retain their explicit task-local RED → GREEN requirement from historical T3.1/T3.2.
- PDF RED/GREEN: `pnpm test src/pdf-generation/pdf-generation.service.spec.ts src/pdf-generation/templates/quotation/quotation-a4.document.spec.tsx --runInBand`.
- Controller RED/GREEN: `pnpm test src/quotations/controllers/quotations.controller.spec.ts --runInBand`.
- Combined focused check: both PDF specs, controller spec and existing `src/quotations/application/quotations.service.spec.ts`, with `--runInBand`.
- Completion: `pnpm test --runInBand`, `pnpm build`, `git diff --check`; no fix flags.
- Runtime harness: Jest renderer-prop capture, template render-to-buffer and controller metadata/delegation tests. Unit Jest uses a Yoga stub; no real HTTP server, database integration or deployed PDF validation is claimed.
- Compare the current nonignored path/hash inventory with the baseline; only the six source files and this tracker may differ. Preserve all five completed source hashes and `.pi-lens.json` exactly.
- Rollback boundary: WU3-only changes in the six backed-up files plus this new tracker; preserve all pre-existing WU1/WU2 work. No automatic rollback of concurrent or unexplained changes.

## Progress and next step
WU3 is technically complete. Independent final verification passed: 136/136 focused tests, 3,612/3,612 full unit tests across 238 suites, build and diff-check exit 0. Source delta is 293 additions and one deletion across six files; the only additional changed path against the WU3 baseline is this tracker. All six expected source hashes and six protected hashes matched before and after verification; HEAD and the empty index were preserved.
Scoped ESLint returned raw exit 1: 153 errors and two warnings, exactly the original baseline per file and rule, with zero diagnostics on added lines and no added `any` or lint suppression. The writer's exit-0 label was incorrect. Evidence: `/tmp/quotation-iva-wu3-exact-run-1789604589139356706/`; independent verification also reran the focused/full suites, build and lint.
Three intended retrospective sensitivity mutations failed their assertions and were restored. Original test-first RED evidence remains unavailable; these checks do not recover it. Active LSP was unavailable; production PDF layout and actual HTTP behavior remain outside the unit harness coverage.
Native risk assessment was unavailable, so independent verification supplied the required fallback. A single authority inspection showed a workspace projection combining WU3 with existing WU2 changes; no untracked selection, START or new review was performed. No WU3 native approval is claimed, and the completed WU2 review remains untouched. Next: resolve the separate review/delivery scope only with appropriate authorization; no further source correction is indicated. Keep temporary isolation intact.
