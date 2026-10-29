# Production editorial vocabulary contract — proposal v0.5

**DRAFT — pending final joint BE/FE technical review, not implementation authorization.** T2, S1–S8 of
[`odd/tasks/editorial-production-vocabulary.md`](../odd/tasks/editorial-production-vocabulary.md), including its Log, governs this proposal.
S4–S8 business choices are approved. Everything specifying transport, identities, evaluator tables or provisioning below is proposed engineering, not implementation approval.
Use the complete immutable [normalized attachment](editorial-vocabulary-normalized-proposal.md), [source snapshot](editorial-vocabulary-source-snapshot.md) and normative proposed [private facts/care addendum](catalog-editorial-production-vocabulary-facts-contract.md). Provenance is in §8; source 514 + S7 overlay 3 = 517 options. The [total policy/provisioning mapping](catalog-editorial-production-vocabulary-policy-mapping.md) is normative proposed dispatch, not a prose deferral.
No code, tests, schema, DB execution, backfill, deployment, grants or public exposure is authorized.

## 1. Evidence and review path

Review §3–§5 for compatibility/receipt behavior, §6 for exact metadata/R, §7–§8 for normalized numeric/source provenance, the facts addendum for W01/W02 and §10 for sequencing.
Existing contracts: `docs/catalog-editorial-editor-contract-proposal.md` v3.2 and newer closed `docs/catalog-editorial-publish-contract-proposal.md` v0.3; the latter controls publish.
Read implementation evidence under `src/catalog-editorial/`:
- `http/editorial-{read,write,vocabulary}.controller.ts`; `application/catalog-editorial-core.ts` response/request shapes.
- `infrastructure/prisma-catalog-editorial.ts` raw state, receipt request/result handling, initialize and transitions.
- `infrastructure/prisma-editorial-vocabulary.ts`, `domain/{document,contextual-document,editorial-definitions}.ts`, `infrastructure/prisma-locked-editorial-definitions.ts`.
Persistence evidence: editorial models in `prisma/schema.prisma`; overwrite behavior in `prisma/editorial-vocabulary-seed.ts`.
Existing company-wide vocabulary tables/readers are not companyId-filtered; there is no Company model in that schema. Do not invent an existing company-scoped API.

Existing paths: `GET /catalog-editorial/vocabulary`; `GET /products/:productId/editorial`; `POST /products/:productId/editorial/draft/initialize`; `PUT /products/:productId/editorial/draft`; `POST /products/:productId/editorial/draft/publish`; `POST /products/:productId/editorial/draft/discard`.
Keep Bearer JWT → tenant guard, token-derived actor/tenant, qualified Product, exact manually granted editorial permissions, no `manage:all` fallback and `Cache-Control: no-store`.
Keep closed request bodies: initialize `{expectedCycle}`, save `{expectedCycle,expectedRevision,document}`, publish/discard `{expectedCycle,expectedRevision}`; no query parameters.
Initialize succeeds 201; other writes 200. CAS, revision limits, permission split and operation receipt scope remain as closed, except explicit proposed compatibility gates below.
Current receipts store JSON request/result; initialize uses the create-receipt table with request `{operation:'initialize',expectedCycle}`. Save/publish/discard store their body-shaped request, without the key.
Receipts are keyed by tenant/product/actor/key within existing operation storage; internal create is not a new HTTP route.
Current GET returns raw stored documents; save/initialize replay has contextual rechecks; publish/discard replay rechecks authority/existence. Do not describe all replays as unconditionally successful.

## 2. Approved business policy (S1–S8)

- Coordinate BE/FE; complete real seven-family vocabulary before full C3.3, not a reduced title-only delivery.
- Future public activation uses Published only: unpublished products excluded from listing, public detail 404. POS/bot remain operational.
- F = filter + detail; D = detail only; I = internal. Initial search is published title/description only; facetable never implies searchable.
- Public supported text only: ingredients, protein origin, composition, non-clinical manufacturer care/instructions.
- Clinical analysis/concentrations, regulatory warnings, private documentation, verification references/dates stay internal until specific review; supporting files never become public automatically.
- Recipient, compatibility, stage, composition and declared features need internal source reference/date. Title needs no evidence; not all attributes are mandatory.
- Unknown does not satisfy a requirement; NA only where subtype applicability permits, never a self-waiver.
- Approved aliases: Cobaya ↔ cuyo/cuy/conejillo de Indias; ninfa ↔ carolina; asno ↔ burro. One option identity, no extra facet/count.
- “Hámster ruso”, “periquito”, “tortuga”, “pez ángel”, “cangrejo” remain ambiguous: identify explicitly, never auto-assign. Groups select no members and prove no compatibility.
- S7 adds hygiene.form Bolsa/Tapete absorbente/Pañal with engineering codes in §8; no automatic assignment or packaging/type substitution.
- S8 existing authorized publisher explicitly confirms private product/presentation/jurisdiction/use review; recorded human declaration, not legal verification. Missing/conflicting/unresolved requirements, disclosure and live prescription controls still block.

## 3. Exact proposed headers and admission order

`Editorial-Contract-Version: 2` requests one atomic capability set: lossless modes, range/state/evidence, private sellable facts/care confirmation and complete family metadata. No independent feature flags.
Absent or explicit `1` normalize to legacy version 1, including receipt identity. Any other value, duplicate or list gives 406 `UNSUPPORTED_EDITORIAL_CONTRACT`.
All errors retain exactly `{statusCode,error}`; e.g. `{"statusCode":409,"error":"EDITORIAL_CLIENT_UPGRADE_REQUIRED"}`. New names are proposals, not existing API claims.
Version-2 revision/adoption/care-confirmation headers are single exact ASCII tokens; duplicate/comma-list values are malformed. Header names are case-insensitive. For version 1, preserve existing header admission: ignored GET Idempotency-Key and unrelated revision/adoption/care headers remain ignored, neither enabling capabilities nor entering receipt identity.

| Request | Version | Vocabulary revision request | Adoption request | Idempotency-Key |
| --- | --- | --- | --- | --- |
| Vocabulary GET | absent/1 | existing legacy admission | existing legacy admission | existing legacy admission |
| Vocabulary GET | 2 | prohibited | prohibited | prohibited |
| Document GET | absent/1 | existing legacy admission | existing legacy admission | existing legacy admission |
| Document GET | 2 | required R | prohibited | prohibited |
| Any write | absent/1 | existing legacy admission | existing legacy admission | required existing 1–200 characters, untrimmed |
| Initialize/publish/discard | 2 | required R | prohibited | required |
| Save | 2 | required R | conditional exact `Editorial-Adoption: legacy-to-v2` (§5) | required |

`Editorial-Care-Confirmation: review-v1` is accepted only on v2 publish: required for fresh care candidate, forbidden for non-care and all other v2 endpoints. Exact captured review, locked-CAS admission, actor/time audit and retries are specified in the addendum §3; closed publish body unchanged.
Version-2 prohibited/missing/malformed headers → 400 `MALFORMED`; conditional requiredness is checked after receipt miss/CAS. Legacy required idempotency validation remains unchanged. Valid R has syntax `ev2-sha256-` followed by 64 lowercase hex digits (§6).
Version-2 successful responses always send `Editorial-Contract-Version: 2` and `Editorial-Vocabulary-Revision: R` matching their envelope. Version 1 sends version `1`, no R.
Errors send normalized version when known, no R; invalid version sends neither. No error body includes documents. Transport Date/request IDs are not reproducibility promises.
Expose both response headers through CORS; permit request version/revision/adoption/care-confirmation/idempotency headers. Update HTTP/error/help/CORS docs and explicit publisher confirmation UX before activation.

Order after framework parsing: current auth/authority → header/body structure → Product lock for writes → receipt lookup/match → fresh CAS → compatibility/adoption gates → current-R check → domain/D14 validation → mutation+receipt atomically.
Pre-receipt body validation checks only the negotiated closed wire shape and primitive types, not current membership, numeric domain, completeness, evidence policy, conservation or applicability. Those fresh rules run only after a receipt miss. Receipt replay bypasses fresh CAS/current-R/adoption-state admission, never current authority/reference rechecks. GET compares R against one coherent metadata/state observation.
Fresh R mismatch → 409 `VOCABULARY_CHANGED`, no mutation/partial document; retain buffer, reload vocabulary then document and explicitly reconcile. Same applies to discard: reload metadata and retry new attempt/key, no document validation.
Every version-2 write pins current R under the existing coordination locks, including discard/initialize. No automatic key renewal or retry on 409.

Version-1 vocabulary filtering: retain families with `minimumContractVersion:1`; exclude whole advanced families, never partial bindings.
Include definitions referenced by retained families; exclude definitions referenced only by omitted families. Include genuinely unbound legacy-compatible definitions to preserve previous v1 behavior.
“Unbound” means zero bindings in the complete snapshot, not zero after filtering; unbound advanced/range definitions are excluded. Never leak orphan data from an omitted family by pretending it is unbound.
Strip version-2-only metadata for this legacy DTO; number units and single/multi options keep existing fields/order. Legacy families may not bind advanced definitions or policies; provisioning rejects that contradiction.
Legacy compatibility means the original five types, only legacy families, and no required version-2 policy; all proposed production families require version 2. Starter gains no public exposure.
Version-1 document GET/fresh writes refuse 409 `EDITORIAL_CLIENT_UPGRADE_REQUIRED` if either non-null state slot is production-v2/unsupported, or candidate selects a v2-only family.
No projected advanced document is returned to an old client; the save gate runs on locked current state even with matching CAS, so hidden fields cannot be erased.
Historical matching version-1 receipts are not fresh writes and cannot replace newer state.

## 4. Recorded responses, not replay-time reconstruction (B1)

Keep OLD/pre-versioned receipts and all legacy request/result JSON untouched; absent and explicit `1` use their original request identity and replay path.
Version-2 attempt against any pre-versioned receipt key → 409 `CONFLICT`, even with identical body. Conversely legacy against a v2 receipt conflicts. Neither rewrites the old row or prevents its matching v1 replay.
NEW v2 receipts record these exact closed logical request/result shapes in their existing JSON columns (a proposed adapter, not existing storage behavior):

```ts
type ReceiptRequestV2 = {
  receiptVersion: 2; contractVersion: 2; vocabularyRevision: string;
  adoption: 'legacy-to-v2' | null; careConfirmation: 'review-v1' | null;
  body: InitializeBody | SaveBodyV2 | TransitionBody;
};
type ReceiptResultV2 = {
  receiptVersion: 2; status: 200 | 201; body: StateV2;
  headers: { 'Editorial-Contract-Version': '2'; 'Editorial-Vocabulary-Revision': string };
  careAttestation: CareAttestation | null; // internal server-owned audit; addendum §3, not HTTP body
};
type InitializeBody = { expectedCycle: number | null };
type TransitionBody = { expectedCycle: number; expectedRevision: number };
type SaveBodyV2 = TransitionBody & { document: DocumentV2 };
```

Receipt status must match operation, header R equals body R equals request R. Scope remains operation/tenant/product/actor/key; same key with different normalized version/R/adoption/careConfirmation/body → 409 `CONFLICT`.
Compare JSON structurally using existing JSONB equality semantics, not request serialization whitespace or key order. New legacy receipts retain legacy recording, not v2 wrappers.
On fresh v2 success capture negotiated status, full StateV2 (including modes and optional warnings), semantic version/R headers and careAttestation (null except confirmed care publish) atomically with mutation. This proposed new receipt JSON storage introduces no client-approved flag or existing audit-column claim.
Matching replay returns recorded status/envelope/header pair exactly as JSON values; preserves server attestation internally, never re-confirms/changes audit time, reconstructs modes/warnings or fetches historical vocabulary. Preserve original stored/replay JSON; byte layout/dynamic transport headers are not re-encoding guarantees.
Existing contextual/reference rechecks can reject replay; they must be a separate side-effect-free gate, not a mapper replacing recorded warnings or a fresh validator of raw historical results.
In particular old finite numbers/null units and raw copied history do not acquire new mandatory-value/domain checks. Keep existing authority/existence and reference/conservation rechecks, with historical decoding separated from fresh validation.
New receipt recording is required; forbidden OLD receipt backfill is not a reason to omit it. Dynamic transport headers and JSON byte layout need not be identical.
FE treats replay as acknowledgement, not permission to overwrite a newer local buffer/expected state. Retry ambiguity with original headers/body/key, not today's R.

## 5. State modes, lifecycle bridge and explicit adoption (B2)

All objects in these proposed wire types are closed. All fields are required unless marked `?`; null is a value, not omission. `Json` is any finite-number JSON value.

```ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type DocumentView =
  | { mode: 'legacy'; document: Json }
  | { mode: 'production-v2'; document: DocumentV2 }
  | { mode: 'unsupported'; document: Json };
type ArchivedWarning = {
  code: 'ARCHIVED_OPTION'; familyId: string; definitionId: string;
  owner: 'product' | 'sellable'; variantId: string | null; optionCode: string;
};
type EditorialStateV2 = {
  cycle: number | null;
  draft: { revision: number; basePublishedRevision: number | null; document: DocumentView } | null;
  published: { revision: number; document: DocumentView } | null;
  warnings?: ArchivedWarning[]; // omitted if empty; existing write warnings only
};
type StateV2 = { contractVersion: 2; vocabularyRevision: string; state: EditorialStateV2 };
```

Modes are historical decoding, not current-domain validity. No schemaVersion field → legacy history (including old `{}`); exact recognizable schemaVersion 2 → production-v2; other versions/malformed versioned shapes → unsupported.
A structurally malformed version-2 document is unsupported/read-only; current metadata invalidity alone never changes a structurally recognizable v2 mode. GET has no fresh validation or normalization.
Historical V2 recognition requires closed shapes, primitive types, finite numbers and declared static enums, including the static dimension/fit/capacity/equipment code unions. Duplicate identities or entries, family-null values/facts, product owners with non-null variants, reversed ranges and dangling care requirement references remain recognizable `production-v2` conflicts, available for correction. They do not become `unsupported` solely for those conflicts. Fresh save/publish enforce their applicable validity rules. Historical recognition does not reapply fresh string/date/count bounds, current membership, evidence sufficiency or publication completeness; stored data is never repaired or normalized by recognition.
Initialize version 2, after matching expectedCycle and no active draft, always copies raw Published JSON unchanged, including unsupported data; null Published uses the existing five-key legacy `emptyDocument()`.
No schemaVersion/evidence injection, fresh limits or D14 checks on that copy. Existing warnings arise only from valid conservation sources, never fabricated from invalid history.

| Current Published | Current Draft | Fresh v2 initialize result |
| --- | --- | --- |
| null, no state | absent | 201, cycle 1, Draft revision 1/base null, legacy empty document, Published null |
| null, existing state cycle N | absent | 201, cycle N+1, Draft revision 1/base null, legacy empty document |
| legacy revision P | absent | 201, next cycle, Draft revision 1/base P, identical legacy JSON; Published untouched |
| production-v2 revision P | absent | 201, next cycle, Draft revision 1/base P, identical production JSON; Published untouched |
| unsupported revision P | absent | 201, next cycle, Draft revision 1/base P, identical unsupported JSON, read-only; Published untouched |
| any of above | present, any mode | 409 CONFLICT; no change |

Cycle overflow/stale expectedCycle retains 409; null expectedCycle is only for absent state. Receipt replay precedes this table.
V2 save requires an active recognizable legacy or production Draft; unsupported or unrepresentable legacy Draft refuses 409 `EDITORIAL_CLIENT_UPGRADE_REQUIRED`. Server independently runs the recognition gate below; a client header alone cannot authorize dropping history.
V2 publish refuses with 409 `EDITORIAL_CLIENT_UPGRADE_REQUIRED` if Draft **or current Published** is unsupported, even when the other is supported; never silently overwrite a future Published format. This check precedes the legacy-Draft adoption check.
Otherwise a legacy Draft refuses V2 publish with 409 `EDITORIAL_ADOPTION_REQUIRED`: it must first be explicitly adopted by save. Supported history still undergoes publish's fresh validation/D14; a legacy Published alone does not require adoption. Discard accepts any Draft mode under existing read+update authority/CAS, removes only Draft and leaves unsupported Published byte-independent JSON values untouched.
No extra recovery permission, raw-write route or automatic server conversion is introduced.

**One adoption mechanism:** V2 save requires `Editorial-Adoption: legacy-to-v2` exactly when the locked source Draft is legacy; it is forbidden for a production Draft, and never permits editing an unsupported Draft.
The header is forbidden on other version-2 operations; legacy admission is unchanged and cannot perform adoption. Its normalized value/null is part of v2 receipt identity. Missing required/forbidden adoption → 400 MALFORMED (after receipt/CAS on fresh requests).
FE offers explicit “Adopt legacy draft” only after recognizing the original closed five-key document and each closed legacy value branch in `domain/document.ts`, independent of today's metadata validity/limits:

```ts
type LegacyPayload =
  | { type: 'text'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'number'; value: number; unit: string | null }
  | { type: 'single'; value: string }
  | { type: 'multi'; value: string[] };
type LegacyDocument = {
  commercialTitle: string | null; description: string | null; mediaRefs: string[];
  familyCode: string | null;
  values: (Key & LegacyPayload)[];
};
```

Recognition requires unique string mediaRefs, unique `[code,variantId]`, finite number values, unique multi strings and exactly the closed keys/types above; no extra fields or unrepresentable types.
For family null require empty values; product owner requires null variantId. Current variant/reference/unit membership is fresh validation, not historical recognition.
Unknown fields, malformed old objects or unrepresentable history remain read-only; never drop fields to make adoption possible. Authorized discard remains available, but does not repair Published.
Construct an **unsaved local** V2 buffer: preserve title/description/media/family, value order, keys, owner, variant, type/value and all units including null; wrap each legacy payload as `state:'known', payload:..., evidence:null`, add `schemaVersion:2, facts:[]`. No invented known facts; initialize still copies raw source unchanged.
Do not fabricate evidence, infer ranges/units/NA or convert product owners into sellable owners. Show all required manual remediation before confirmation of the first fresh save.
The submitted candidate may contain explicit user edits; server does not assert it is an untouched conversion. It validates the entire V2 candidate under current rules and preserves invalid source history until success.
`expectedCycle`/`expectedRevision` pin the actual source Draft; initialization's basePublishedRevision pins its copied source. No separate source blob or adoption DB mutation occurs before validated save.

## 6. Proposed metadata DTO and endpoint-scoped content R (B3/B4)

All keys below required; no extra keys; no wire defaults. IDs/codes/labels nonblank strings, sortOrder safe integer, revisions positive int32 where used. Normalized inventory plus facts addendum supplies finite family applicability; no general rule framework is required.
R is a canonical content digest in the current authenticated API authority/origin, not a globally identifying company token. No vocabularyScope/companyId field, new config, authority adapter or Company model is needed; existing global vocabulary storage stays unchanged.
Equal DTOs may have equal R across deployments. FE query/cache keys retain API/account scope; R alone is never authorization, a route, tenant identity or a substitute for qualified Product/CAS/receipt scope.

```ts
type Owner = 'product' | 'sellable';
type UnitV2 = { code: string | null; label: string | null; sortOrder: number };
type OptionV2 = { code: string; label: string; archived: boolean; sortOrder: number };
type GroupV2 = { code: string; label: string; optionCodes: string[] };
type AliasV2 = { label: string; optionCode: string };
type NumericPolicy = { status: 'pending' } | {
  status: 'resolved'; magnitude: string; integer: boolean;
  lower: number | null; lowerInclusive: boolean; upper: number | null; upperInclusive: boolean;
};
type DefinitionV2 = { id: string; code: string; label: string } & (
  | { type: 'text' | 'boolean' }
  | { type: 'number' | 'range'; units: UnitV2[]; numericPolicy: NumericPolicy }
  | { type: 'single' | 'multi'; options: OptionV2[]; groups: GroupV2[]; aliases: AliasV2[] }
);
type OptionTest = {
  definitionCode: string; operator: 'equals_set' | 'contains_all' | 'intersects'; optionCodes: string[];
};
type PolicyCase = {
  code: string; when: OptionTest[];
  applicability: 'applicable' | 'not_applicable' | 'unresolved';
  required: boolean; allowNA: boolean; evidenceRequired: boolean;
  documentary: 'resolved' | 'not_applicable' | 'unresolved';
};
type ProductionFamily = 'food' | 'treat' | 'toy' | 'hygiene' | 'accessory' | 'habitat' | 'care';
type RuleId = 'required' | 'optional' | 'animal' | 'form' | 'content' | 'dimensions'
  | 'fit' | 'capacity' | 'space' | 'equipment' | 'optional_equipment' | 'presentation';
type FactRule = { family: ProductionFamily; ruleId: RuleId; parameter: ProductionDefinitionCode }; // closed 68-code union/triples: mapping §1
type RuleResult = Pick<PolicyCase, 'applicability' | 'required' | 'allowNA' | 'evidenceRequired' | 'documentary'>; // same five required fields, no extras
type BindingPolicy = { route: 'pending' }
  | { route: 'option_cases'; cases: PolicyCase[] }
  | { route: 'fact_rule'; rule: FactRule }; // no cases/status on this branch
type BindingV2 = {
  definitionId: string; definitionCode: string; owner: Owner; sortOrder: number;
  exposure: 'INTERNAL' | 'DETAIL' | 'FACET'; searchable: boolean;
  publicationCheck: 'always' | 'when_asserted'; policy: BindingPolicy;
};
type FamilyV2 = {
  id: string; code: string; label: string; minimumContractVersion: 1 | 2; bindings: BindingV2[];
};
type VocabularyV2 = {
  semanticsVersion: 'editorial-production-1'; families: FamilyV2[]; definitions: DefinitionV2[];
};
type VocabularyResponseV2 = { contractVersion: 2; vocabularyRevision: string; vocabulary: VocabularyV2 };
```

Unit code null iff label null; range units cannot be null. Non-null labels nonblank; arrays always present, possibly empty. Null numeric bound means unbounded and its inclusive flag must be false; finite bounds ordered, equal bounds require both inclusive.
Definitions/families unique by ID and code; binding unique definition per family and ID/code must identify the same definition. Options unique per definition; units unique including at most one null; alias labels unique per definition, no ambiguous target collision; groups unique code, all member codes resolve.
Group member and test option arrays contain unique existing option codes. Alias target resolves within the same definition. Archives remain visible; no option identity reuse.
Global owner stays product|sellable for real legacy compatibility; **all production candidates** separately use sellable owner. Never override owner in a submitted value.
Resolve exposure/policy by selected family binding, never union across families. Missing exposure/searchability defaults INTERNAL/false only at legacy-policy resolution/provisioning; strict v2 wire emits both explicitly.
One material multi definition, groups `material.base` and `material.rigid`, same option identities: group/option/alias identities are distinct and overlapping group membership does not duplicate counts.

**One exclusive dispatch:** mapping §1 supplies every production triple, publicationCheck and evidence policy; all required/optional production routes are resolved fact_rule, never pending. Parameter is the exact bound definition-code enum, not arbitrary text. Pending is reserved for intentionally incomplete legacy/unused optional metadata, never a production placeholder.
For legacy option_cases only: `when` is conjunction; empty when unconditional; tests use single/multi bindings in the same family, with no duplicate tested definition. There is no option case evaluation after a fact_rule result.
Read the tested value at that binding's owner/subject (product null; sellable current variant/null). Known single is singleton option set; known multi uses its exact selected set. `equals_set` requires identical sets; `contains_all` requires every expected option in the actual set; `intersects` requires at least one common option. Expected sets must be nonempty. All comparisons ignore order, with no alias/group expansion.
Missing/unknown/NA test values never match, including an empty expected set. No free text, code execution or numeric formula in OptionTest. Product relevance comes only from the explicit scoped human declarations in the facts addendum, never inferred by matching an option.
On option_cases only, case codes are unique within a binding and exactly one must match per evaluated subject; zero/multiple matches or pending policy → unresolved. A fact_rule returns its one five-field result without case matching. No fall-through/default inference. Reject contradictory/overlapping cases and cyclic selector dependencies in the manifest; runtime still fails closed. Root selector policies are unconditional, never depend on themselves.
For each E subject (existing eligibility, §9), publication evaluates always bindings plus when_asserted bindings with a known or NA assertion, then only selected option_cases dependencies. Omitted/unknown optional assertions do not seed evaluation. Any potentially required case must have `publicationCheck:'always'`; never hide a requirement behind optional evaluation. Dependencies are read only to resolve selected rules, not promoted into unrelated mandatory evidence requirements. Pending unused optional rules do not block publication. Exhaustive inventory fixtures must cover toy.type combinations, missing selectors, zero/multiple matches and irrelevant optional stage/material omissions.
NA admission uses only the selected route's resolved result: applicability=not_applicable && allowNA=true. No second unconditional option case may re-require a fact-authorized NA. Applicable/unresolved results forbid NA; required is true only when applicable. Known contradictory assertions may save structurally valid drafts but reject publication, never silently disappear.
Known/unknown assertions may be stored while unresolved, but no NA waiver; unresolved policy/documentary status within the publication evaluation set blocks publication. Applicable+required requires known; known assertions with evidenceRequired need source/date at publish, not fabricated draft evidence.
A selected-route resolved not_applicable result permits omission; allowNA controls explicit NA, never counts as evidence. Required does not mean every optional known assertion can omit required evidence.
`documentary` describes policy readiness only, not actual-product compliance. W01/W02 mapping is the exact private Fact/CareReviewCapture and publisher confirmation contract in the addendum; sourceRef/date alone cannot establish authenticity or legal compliance.
Use the total mapping's single family-owned result per binding/E subject; the addendum supplies captured inputs, not a second dispatch engine. Fact evidence, known-value evidence, numeric validation and care confirmation are separate checks. Closed semanticsVersion is hashed; any admission/rule/evidence/NA/eligibility-consumption semantics change must bump it, not reuse editorial-production-1. Per-product unknowns never block taxonomy implementation.

**R algorithm (one exact recommendation):** materialize the complete authorized VocabularyV2 wire DTO, including explicit resolved legacy defaults/pending tags; hash no internal/unrequested DB columns.
1. Sort families by label then code; definitions by code; bindings by sortOrder then definitionCode; options/units by sortOrder then code (null first). Use UTF-8 bytewise lexical comparison, not locale/SQL collation.
2. Sort groups by code, aliases by label then optionCode, all optionCodes arrays by code; only for option_cases sort cases by code and when tests by definitionCode; fact_rule has no cases. Reject duplicate identities rather than relying on input order.
3. Build preimage object exactly `{contractVersion:2,vocabulary:V}`. No company/scope/tenant field is hashed. This is content identity within authenticated endpoint context; equal DTOs may produce identical R across deployments.
4. Serialize recursively: object keys ascending UTF-8 bytes (no integer-key enumeration special case); arrays in the order above. Emit no whitespace/BOM/trailing newline. Retain all required nulls/empty arrays; reject undefined/extra keys/nonfinite numbers/lone UTF-16 surrogates.
5. Strings: double quotes; escape quote/backslash as `\"`/`\\`; every U+0000–U+001F as lowercase `\u00xx`; all other Unicode scalar values emitted literally, no Unicode normalization or slash escaping. Numbers use ECMAScript JSON.stringify finite-number spelling, -0 as 0; booleans/null lowercase.
6. UTF-8 encode that serialization; SHA-256 digest; R is `ev2-sha256-` + 64 lowercase hex digits, no quotes. Hash excludes envelope R/HTTP headers/product facts/audits; includes exactly DTO labels/policies/archives and all other explicit metadata keys.
Return the DTO with those array orders. GET and fresh write must compute/compare this same snapshot under coherent reads/locks; new metadata inserts and policy changes must coordinate too, not evade locks on previously selected rows.
No old snapshot storage/fetch is needed for replay: §4 records its envelope/R. R is not a substitute for state CAS or an authorization lease.

## 7. Values, numeric inventory and historical compatibility (B5)

```ts
type Evidence = { sourceRef: string; verifiedOn: string }; // exact bounds: facts addendum §1
type Key = { code: string; owner: Owner; variantId: string | null };
type KnownPayload =
  | { type: 'text'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'number'; value: number; unit: string | null }
  | { type: 'single'; value: string }
  | { type: 'multi'; value: string[] }
  | { type: 'range'; min: number; max: number; unit: string };
type ValueV2 = Key & (
  | { state: 'known'; payload: KnownPayload; evidence: Evidence | null }
  | { state: 'unknown'; evidence: null }
  | { state: 'not_applicable'; evidence: null }
);
type DocumentV2 = {
  schemaVersion: 2; commercialTitle: string | null; description: string | null;
  mediaRefs: string[]; familyCode: string | null; values: ValueV2[];
  facts: SellableFacts[]; // exact closed types/bounds in facts addendum; always required, may be []
};
```

Closed branches, all keys required; unique `[code,variantId]`, mediaRefs and multi option strings; exact family/type/owner/options/units; product owner null variant, sellable actual variant required when variants exist, otherwise null. Family null requires empty values and facts; media references remain private IDs of this product.
Number finite; range finite inclusive min/max, min<=max, one same named allowed unit, equality allowed. No mixed endpoints, implicit conversion, numeric strings or multidimensional text substitute.
Separate dimension/fit axes remain separate bindings. Source V157–158 supplies count units `piece`, `dose_unit`, `sheet`, `roll`, `unit`; production counts cannot quietly allow null. Historical allowed null-unit numbers remain readable and preserved in adoption buffers.
Exact 25 numeric definitions/units/domains are normalized §4: source-positive physical/count measures retain those bounds; counts positive integers. U07 fit finite ordered inclusive cm/mm ranges, no extra lower bound; U08 equipment scalars finite named W/V/Hz/l/h, no invented signs/bounds. Neither is an unresolved taxonomy blocker.
`measure.equipment.temperature` uses finite ordered signed °C, including zero; e.g. `{type:'range',min:-5,max:30,unit:'°C'}`. No degC alias, blanket positivity, conversion or extra safety threshold.
All 25 production numericPolicy entries are resolved by the total mapping. Pending is only intentionally incomplete legacy/unused optional metadata, never a required production mapping; it is not unbounded resolved. Null bounds in a resolved policy mean reviewed unbounded, not missing inventory.
For fresh V2 known number/range assertions under pending numeric policies, save permits incomplete numeric assertions while publish rejects with 400 `MALFORMED` until their policies are resolved. Finite values, ordered range endpoints and exact allowed-unit membership remain mandatory. This does not change V1 behavior, historical decoding or receipt replay.
Omission means no assertion, not false/zero/unknown/NA. Known false is distinct. Unknown never meets required; NA is controlled by §6, not a self-waiver.
Example known assertion: `{code:'feature.waterproof',owner:'sellable',variantId:null,state:'known',payload:{type:'boolean',value:false},evidence:{sourceRef:'manufacturer:manual-42',verifiedOn:'2026-07-01'}}` (candidate definition code).
Unknown/NA same key uses respectively `{state:'unknown',evidence:null}` / `{state:'not_applicable',evidence:null}`, with no payload. Evidence stays internal and sourceRef is never automatically dereferenced or exposed.
Historical decoder accepts old finite signed/fractional/zero numbers and allowed null units under old shape, independent of new domain policy. Fresh save validates the entire submitted candidate; manual remediation never silently rewrites the original.
GET, raw initialize copy and recorded results are not fed into fresh limits/evidence/D14 checks. Existing reference rechecks stay separate; preserve original stored/history/receipt JSON values.

## 8. Normalized source, S7 overlay and summary matrix

**Technical normalized candidate codes, not a production manifest or implementation approval.** Full exact definitions/bindings/options are in the immutable attachment, not generated from this summary. F=FACET, D=DETAIL, I=INTERNAL; all searchable false. `1`/`*`/`b` denote types, not code suffixes.
All production rows are sellable; pertinence is captured per actual product using the facts addendum, never an invented global subtype default.

| Scope/family | Candidate bindings/exposure |
| --- | --- |
| All pertinent | F `animal.target*`, `life.stage*` (habitat stage optional); D `pack.form1`, `pack.sale1`, `content.kind1` |
| toy, hygiene, accessory, habitat | F `material*`, groups `material.base`/`material.rigid` |
| toy, accessory, habitat | F `color.base*` |
| toy, accessory | F `size.label1` |
| food, treat, toy, accessory | F `size.animal*` |
| accessory, hygiene, habitat | D `feature.washable b`, `feature.reusable b`, `feature.waterproof b` |
| food | F `food.format1`, `food.role1`, `food.texture*`, `food.aquatic1`; D `food.process*` |
| treat | F `treat.form1`, `food.texture*`; D `treat.base*`, shared `food.process*` |
| toy | F `toy.type*`, `toy.feature*` |
| hygiene | F `hygiene.type1`, `hygiene.form1`, `hygiene.litter*`; D `hygiene.scent1` |
| accessory | F `accessory.type1`, `accessory.feature*`; D `accessory.closure*` |
| habitat | F `habitat.type1`, `habitat.environment*`, `habitat.substrate*`, `habitat.component*` |
| care | F `care.type1`, `care.form1`; D `care.device1` |
| Numeric wherever applicable | Exact `measure.*` definitions, bindings, units and bounds in normalized §4; dimensions/fit separate axes, net content distinct from capacity |
| Supported text where applicable | D exact `text.ingredients`, `text.protein_origin`, `text.composition`, `text.manufacturer_care`, `text.instructions` with normalized bindings |
| Sensitive | I clinical analyses/concentrations, regulatory warnings, private documentation, evidence references/dates |

Immutable local source: `docs/editorial-vocabulary-source-snapshot.md`, blob `9538de694f1125e79e5f2b60e2e4eb49b2e0a05d`, SHA256 `2ce7b92a4866c3693a7a373fe0e1cbc7199b67e0c3a1e66725534fed9c8a8205`; transport HEAD `5629d61eb3dcf79b65882175fe40e9999b6a64e1`, not inferred current main.
Immutable normalized copy: `docs/editorial-vocabulary-normalized-proposal.md`, blob `fd89f5a29edb8015f4a361888cbcddfd6098b173`, SHA256 `1dc079543c8607c8d984f548ec22d21c4092f342577c7c2e14dba7c5467488a9`. Original frontend-relative links/checker paths remain untouched; parent verified 67 rows/514 exact options/32 choice definitions/bindings, fixtures 4 and 3+3, ten operator vectors. No production test proof.
S7 additive overlay: `hygiene.form.bag=Bolsa`, `.pad=Tapete absorbente`, `.diaper=Pañal` (fully qualified hygiene.form codes). Same single/sellable/F/searchable-false hygiene binding, numeric/content semantics unchanged, no auto assignment. Original 514 remains immutable; combined 517.
U01–U06/U09–U13 are product-specific unknowns captured by the addendum; U07/U08 numeric capture is resolved above; S7 closes U14 for these three forms. No broad unresolved taxonomy/code list remains. Final joint acceptance of the exact three-document proposal remains; total dispatch/provisioning is specified in the mapping, not left for another business questionnaire.
Source snapshot §8 D16 replace-before-republish wording is overridden by current closed C3.2 Published conservation; source §7 D14 minima otherwise remain. No duplicate source.reference/source.checked_at typed assignments: addendum maps them to scoped evidence.

## 9. D14 completeness, conservation and controlled provisioning

D14 is separate from fresh structural validation: candidate + complete selected-family policy + current real offered sellables + internal evidence/documentary facts. No candidate-supplied exclusion or `hasVariants` shortcut.
Under existing tenant-qualified Product FOR UPDATE, receipt/state and vocabulary/reference coordination, load all required/conditional bindings and dependencies, **including absent values**, not just selected definitions.
Let E be the existing currently offered real-sellable eligibility result under existing coordination, not a new all-real/current-care set. Evaluate all E subjects, never only the first; simple identity remains null under existing eligibility. Product-owned legacy rules evaluate once. All captured rows still undergo shape/reference checks; inactive valid rows remain stored/digest-covered, not extra publication gates.
Title remains nonblank. Media deferred/empty for publish; no photo minimum. Retain <=200 assignments pending representative variant/catalog evidence; existing title<=200, description<=20000 code points, fresh save media<=20, framework 100kB JSON limit remain.
Draft permits incomplete/unknown values/facts and missing per-value/review evidence; known relevance declarations require evidence even at save as specified in the addendum. Enforce shape, reference scope, numeric domain and NA applicability. Unresolved applicable conditions block publish, not creation of an incomplete draft.
Hygiene: recipient only for animal-applied items; consumable presentation/content for consumables, not tools or invented species for environmental cleaners.
Accessory: fit when selection depends on fit, capacity for relevant containers, not both universally. Habitat/equipment dimensions/capacity/electrical specifications only where applicable.
Care distinguishes formulations/instruments; unresolved applicable documentary/regulatory conditions block publication **even when text is INTERNAL**. Evidence presence is not legal compliance; invent no legal rule.
Fresh save archived conservation uses stored Draft; initialize copies Published unchanged; publish uses **current Published**, null meaning empty. Adoption wrapping must compare identical legacy payload identity to avoid losing valid conservation merely from transport version change.
Keep same family/definition/owner/variant/type/option assignment only; no new/moved/re-added archived options or reopening. Invalid stored baseline grants no conservation rights; corrected candidates remain possible. No D14 replay gate.
Public readers later construct allowlisted DTOs from Published and selected bindings: never raw documents, INTERNAL attributes, evidence/private refs/files. FACET allows detail/filtering, DETAIL only detail; neither permits search automatically.

Recommend one controlled versioned manifest/provisioner: add missing entries, resolve IDs by canonical code, preserve custom labels/aliases/order/archive timestamps, retain omissions; no type/owner reinterpretation with data.
Current `prisma/editorial-vocabulary-seed.ts` overwrites labels/type/owner/order and cannot be used unchanged. No silent unarchive or alias-target reassignment.
Proposed future command, not executed/existing API: `pnpm run editorial-vocabulary:provision -- --manifest production-v1 --dry-run`.
Dry-run deterministic sorted additions/preservations/conflicts; type/owner/data or alias-target collision blocks. No mutation. Explicit apply separately authorized target + reviewed plan digest + transactional drift recheck, conflict aborts all.
No startup auto-run, backfill, DB execution, automatic grant, online dictionary CRUD/new company mutation grant or full admin UI prerequisite.

## 10. Dependency-ordered units and future acceptance

1. **Prerequisite U1 — normalized source/policy + provisioning:** implement the total mapping's exclusive routes/semanticsVersion, immutable inventory plus S7 overlay, exact numeric domains and preservation-safe ID/order/default expansion in reviewed persistence/manifest/provisioner. No new scope adapter or DB execution.
2. **Prerequisite U2 — lossless transport/receipts/adoption:** decoder versus fresh validator, DTOs/facts/headers/filter, metadata R, recorded v2 responses/private care attestation and FE explicit confirmation bridge; focused compatibility tests and editor/publish/help docs.
3. **Prerequisite U3 — D14 coordination:** complete locked policy loading, per-sellable evaluation and publish integration; preserve baselines/recovery/idempotency and FE explanations. Vocabulary completion requires U1–U3, not this draft alone.
4. **DOWNSTREAM, OUTSIDE vocabulary completion — full C3.3:** Published-only public DTO/query/facets/cache and live operational eligibility, OR-within/AND-between, own-facet-excluded counts, correlated variant matching, unique products before pagination. No reduced title-only substitute.

| Future interface scenario | Required observation, not a claim of implemented verification |
| --- | --- |
| Matching v2 replay after metadata/labels change | Original status/StateV2/modes/warnings/version/R; no historical metadata fetch, no fresh validation |
| Explicit1 vs absent; v2 reuses pre-versioned key | Same legacy identity/replay for first pair; v2 409 CONFLICT; old row untouched |
| Old tab saves advanced state with correct CAS | 409 EDITORIAL_CLIENT_UPGRADE_REQUIRED; no lossy projection or replacement |
| Initialize legacy/unsupported Published | Raw copy, revision1/new cycle/base P, correct mode; unsupported remains read-only |
| Adoption exact legacy shape with null-unit number | Unsaved lossless buffer/evidence null; header+CAS required; current invalid production unit requires manual remediation before save |
| Supported Draft with unsupported Published | Publish refuses; discard removes only Draft under existing authority |
| v2 GET/write R mismatch including discard | 409 VOCABULARY_CHANGED; reload metadata, discard still never validates document |
| Count with null unit; thermal negative/zero range | Fresh production count rejected; old historical count readable; thermal allowed by normalized signed domain, reversed/nonfinite range rejected |
| NA self-waiver; variant B absent required binding | Reject impermissible NA; publish rejects incomplete B after absent-binding loading |
| Regulatory applicability unresolved but text INTERNAL | Draft possible, publish blocked, no invented legal requirement |
| Published I text/evidence/private files | Absent from public detail/facets/search/cache; no raw public document endpoint |
| Manifest conflict dry-run | Deterministic report, zero mutation; custom labels/aliases/archives conserved |
| Archived Draft assignment absent from Published | Save may conserve; publish rejects, never uses Draft as publish baseline |

## Key Learnings

1. Existing receipt requests/results are JSON and initialize shares create-receipt storage with an operation discriminator.
2. Existing initialize copies Published or the legacy empty document; transport version must not become an implicit stored-document migration.
3. R is content identity within authenticated API/account context, not a globally identifying company or authorization token.
4. Counts have source-declared named units; historical null-unit compatibility does not approve null production count units.
