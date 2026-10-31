# Single editorial contract — S35 target handoff

**TARGET, not implementation proof.** This supersedes conflicting editorial wire,
compatibility and adoption requirements in earlier proposals. Authority is
[T3d / S35 and its reconciliation override](../odd/tasks/editorial-production-vocabulary.md),
with retained S33 numeric admission, S34 custom facts and approved business rules.
Implementation evidence base: `2a807a4`; no new wire activation, database reset,
public consumer, deployment or completed runtime evaluator is claimed here.

## 1. One schema; one coordinated cutover

There is one strict contract, not two readers or a negotiation protocol.
`contractVersion: 2`, `schemaVersion: 2`, internal `receiptVersion: 2` and care
confirmation `review-v1` are constant schema/protocol identifiers. They do not
select capabilities. No document mode wrappers, historical projections, adoption,
version fallback or upgrade/downgrade errors remain in the target.
`minimumContractVersion` is absent from both Family and canonical R input, not an
inert compatibility field. Existing helpers containing it are evidence for other
retained fields, not the target Family DTO.

Quick FE path: vocabulary first → document GET pinned to its R and context GET in
parallel → install a coherent vocabulary/document pair atomically. Implement one
strict reader. Earlier v0.5 attachments are historical rationale, not a way to fill
machine-shape gaps or reintroduce superseded behavior.

## 2. HTTP surface and authority

Paths below are controller-relative (retain any existing deployment API prefix).
All seven paths/statuses are retained; no internal create or media route is added.
No query parameters are accepted. Product IDs use the existing UUID validation.
Document/context GET reject nonempty decoded bodies; GETs take no input document.

| Operation  | Method and relative path                               | Success / body           |
| ---------- | ------------------------------------------------------ | ------------------------ |
| Vocabulary | `GET /catalog-editorial/vocabulary`                    | `200 VocabularyResponse` |
| Document   | `GET /products/:productId/editorial`                   | `200 StateResponse`      |
| Context    | `GET /products/:productId/editorial/context`           | `200 Context`            |
| Initialize | `POST /products/:productId/editorial/draft/initialize` | `201 StateResponse`      |
| Save       | `PUT /products/:productId/editorial/draft`             | `200 StateResponse`      |
| Publish    | `POST /products/:productId/editorial/draft/publish`    | `200 StateResponse`      |
| Discard    | `POST /products/:productId/editorial/draft/discard`    | `200 StateResponse`      |

Bearer JWT → tenant guard; actor/tenant derive only from the principal. S53/S54
retain active persisted global Super Admin or global `manage:all` authority without
individual editorial grants; a JWT flag alone is not proof. A selected tenant
remains binding, including for global administrators. In global/null mode only
verified global administrators may resolve a Product's persisted tenant.
Tenant-local `manage:all` applies only within current active membership; ordinary
users retain exact editorial grants. Operational Product permissions do not suffice.
Vocabulary is global metadata under editorial read authority, not a tenant store.
For ordinary exact-grant access:

- Vocabulary/document/context: `ProductEditorialDraft:read`.
- Initialize/save/discard: `:read` + `:update`.
- Publish: `:read` + `:publish`; update is not required.
- Unavailable/foreign Product normally fails authority with 403; 404 is possible
  when Product disappears after authorization, not a universal existence promise.

All objects/unions below are **closed**: every listed key required except `?`, no
extra keys/defaults. Nullable is not optional. JSON numbers must be finite.

```ts
type InitializeBody = { expectedCycle: number | null };
type TransitionBody = { expectedCycle: number; expectedRevision: number };
type SaveBody = TransitionBody & { document: Document };
type Context = { variants: { id: string; name: string }[] };
```

Context is unchanged: complete variants sorted by name then id, no pagination,
SKU, stock, prices, flags, R envelope or invented revision semantics. Actual list
membership, not `hasVariants`, determines sellable identity: nonempty list requires
an actual variant ID; simple product uses null. Orphans stay visible for explicit
correction; never silently remove them. Save revalidates current references.

### Request and response headers

Header names are case-insensitive; semantic values are exact, untrimmed tokens.
Inspect raw occurrences: duplicate or comma-list semantic headers and malformed
values are `400 MALFORMED`, including when otherwise prohibited. Presence of a
prohibited header, even empty, fails. No version header is needed on requests.

| Request                 | `Editorial-Vocabulary-Revision` | `Idempotency-Key` | `Editorial-Care-Confirmation`             |
| ----------------------- | ------------------------------- | ----------------- | ----------------------------------------- |
| Vocabulary GET          | Forbidden                       | Forbidden         | Forbidden                                 |
| Document GET            | Required R                      | Forbidden         | Forbidden                                 |
| Initialize/save/discard | Required R                      | Required          | Forbidden                                 |
| Publish                 | Required R                      | Required          | Only exact `review-v1`; conditional below |

R syntax: `ev2-sha256-` followed by 64 lowercase hex digits. Write keys retain the
existing 1–200 character, untrimmed contract. Context retains existing header
behavior; do not attach new pinning/idempotency requirements to it. The obsolete
**request** headers `Editorial-Contract-Version` and `Editorial-Adoption` are
forbidden on this editorial surface and produce `400 MALFORMED`.
Publish parses a supplied confirmation token before lookup. After receipt miss
and locked CAS, fresh care publish requires it; fresh non-care publish forbids it.
The identical token/null belongs to receipt intent, never an implicit UI default.

Plain transport rules:

- All editorial successes/errors: `Cache-Control: no-store`.
- Vocabulary/document/write successes: `Editorial-Contract-Version: 2` and
  `Editorial-Vocabulary-Revision: R`, equal to envelope R (recorded R on replay).
- Context: unchanged `{variants}` response; no semantic revision/version envelope.
- Target editorial errors: informational `Editorial-Contract-Version: 2`, no
  `Editorial-Vocabulary-Revision`, no document or vocabulary in error body.
- CORS allows `Authorization`, `Content-Type`, `Editorial-Vocabulary-Revision`,
  `Idempotency-Key`, `Editorial-Care-Confirmation`; exposes
  `Editorial-Contract-Version` and `Editorial-Vocabulary-Revision`. Obsolete request
  version/adoption headers are not supported CORS inputs.
- Dynamic Date/request IDs and JSON byte layout are not replay guarantees.

### Registered document GET implementation boundary

The dedicated document reader admits current authority before query/body/raw-header
validation, then reads qualified Product existence, complete metadata and state in
one RepeatableRead transaction. Authority is a separate current observation, not
part of that data snapshot. Actual canonical R must equal the single requested R.
Stored documents/counters pass structural decoding only: legacy/future/malformed
slots reject the whole response as INTERNAL_ERROR; recognizable historical conflicts
remain unchanged for correction. No fresh qualification or fabricated warnings.
The old writer provider remains separate; GET itself does not activate V2 writes/replay.
Registered HTTP tests substitute JWT/Prisma I/O; transaction-client provenance is
composition evidence, not real PostgreSQL concurrency or browser proof.

### Registered initialize implementation boundary

Initialize uses current persisted read/update authority before semantic admission,
then rechecks authority in its ReadCommitted transaction. Product locking and
namespaced JSONB receipt identity precede absent/exact-cycle CAS, no-active-Draft
and int32 increment gates. Complete metadata locks and a fresh snapshot precede
current-R comparison, reference observations, mutation and the atomic 201 receipt.

Fresh initialization creates the exact empty V2 document or copies recognizable
Published unchanged. It never applies fresh bounds, evidence, numeric or facts
qualification to that copy. Whole-source S42 eligibility controls conservation
warnings: an ineligible historical source is still copied, without warnings.
Actual qualified variant/private-media sources are observed even for empty copies;
source outages propagate. Internal create and its shared legacy helper are unchanged.

Replay validates the recorded initialization relationships (cycle increment, draft
revision1, base Published revision, and exact Published/empty document copy).
Current reference/conservation gates remain side-effect-free; reference loss can
reject replay. No current-state CAS or current-R equality is applied; recorded
status/body/R and warning presence/order are returned without rebuilding them.
Malformed recorded structure/relationships fail as INTERNAL_ERROR.
Mock composition covers these paths, not database JSONB equality, rollback, writer
coordination or lock privileges. The operational prerequisites below still apply.

### Registered discard implementation boundary

Initialize and discard use dedicated V2 writers; save/publish retain their
existing providers. Current persisted read/update authority precedes semantic
admission and is rechecked inside the transaction. Raw duplicate/list headers,
missing R/key, prohibited care/version/adoption headers and nonclosed bodies fail.
Matching namespaced receipt intent replays the decoded recorded acknowledgement
before CAS, current metadata or fresh validation; changed same-key intent conflicts.

On a miss, the qualified Product lock and state CAS precede table SHARE locks:
families, definitions, bindings, options, units, groups, group members, aliases,
then vocabulary metadata. This order matches the inspected seed's families-first
ordering. A separate, awaited ReadCommitted snapshot on the same transaction
supplies current R after acquisition, including metadata unrelated to this Product.
Only Draft fields are cleared; cycle and Published stay unchanged. The discarded
document is not read or validated. Surviving Published is decoded structurally,
not freshly qualified. State mutation and the complete V2 receipt share one
transaction; success is emitted only after commit. No automatic retries or
unlocked fallback are provided; unexpected database errors are sanitized.

**Operational prerequisites remain unproved:** SHARE requires ownership or
UPDATE/DELETE/TRUNCATE privilege on every metadata table; SELECT-only is not
enough. No grants are added. Default Prisma transaction bounds remain unchanged.
Mocked HTTP composition verifies SQL ordering, parameters and failure propagation,
not PostgreSQL blocking, fresh snapshots after waiting, rollback or deployed role
privileges. External metadata-to-Product lock orders may deadlock and fail closed.
Real isolated-DB proof and service activation require separate authorization.

## 3. Document, values and evidence

```ts
type Owner = 'product' | 'sellable';
type Evidence = { sourceRef: string; verifiedOn: string };
type KnownPayload =
  | { type: 'text'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'number'; value: number; unit: string | null }
  | { type: 'single'; value: string }
  | { type: 'multi'; value: string[] }
  | { type: 'range'; min: number; max: number; unit: string };
type Value = { code: string; owner: Owner; variantId: string | null } & (
  | { state: 'known'; payload: KnownPayload; evidence: Evidence | null }
  | { state: 'unknown'; evidence: null }
  | { state: 'not_applicable'; evidence: null }
);
type Document = {
  schemaVersion: 2;
  commercialTitle: string | null;
  description: string | null;
  mediaRefs: string[];
  familyCode: string | null;
  values: Value[];
  facts: SellableFacts[];
};
```

Fresh admission uses unique `[code,variantId]`; code/type/owner must match the
actual selected family binding/definition. Product owner requires null variant;
sellable owner uses actual context identity. Family null requires values/facts `[]`.
Media are unique private asset IDs of this product, not URLs. Single/multi values
use exact option codes; multi is unique, no group/alias expansion or inference.
Unknown, omission, known false, known empty and NA are distinct. Unknown cannot
satisfy a requirement; explicit NA is controlled by selected applicability (§7).

Finite numbers and finite ordered inclusive range endpoints (`min <= max`, equal
allowed) use exact definition unit membership. Range unit is non-null; no mixed
units, conversions, numeric strings, dimension calculation or free-text substitute.
Resolved numeric policy applies integer/bounds/inclusivity to scalar and both
endpoints. S33: pending numeric policy allows incomplete known numeric draft save,
but publish rejects it with `400 MALFORMED`; pending never means reviewed unbounded.
Finite/order/unit checks still apply on save.

Fresh save/publish bounds: title ≤200 and description ≤20000 Unicode code points;
media ≤20, values ≤200, facts ≤200; text payload has no separate limit beyond the
framework's existing 100 kB serialized JSON ceiling. Publish additionally requires
non-null ECMAScript-trim-nonblank title and media `[]`; preserve strings exactly,
never trim on storage. Initialize copies and recorded acknowledgements are not fed
through fresh bounds. GET does not turn into fresh domain/completeness admission.

Evidence capture: sourceRef 1–1000 Unicode scalar code points, nonblank under
ECMAScript trim, no lone surrogate or C0/DEL control; verifiedOn exactly real
Gregorian ASCII `YYYY-MM-DD`, year 0001–9999. No expiry/future-date rule, URL fetch,
source authenticity or automatic file access. Supplied malformed evidence fails
fresh admission even on drafts. Missing per-value evidence may remain incomplete
on save; publish requires it when the selected rule says so. Title needs no evidence.

## 4. Private facts and care capture

These are exact capture forms. The subset unions below constrain reference
admission; primitive wire parsing does not replace family/current-membership checks.

```ts
type DimensionCode =
  | 'measure.dimensions.external_length'
  | 'measure.dimensions.external_width'
  | 'measure.dimensions.external_height'
  | 'measure.dimensions.external_diameter'
  | 'measure.dimensions.internal_length'
  | 'measure.dimensions.internal_width'
  | 'measure.dimensions.internal_height'
  | 'measure.dimensions.internal_diameter';
type FitCode =
  | 'measure.fit.neck'
  | 'measure.fit.chest'
  | 'measure.fit.back_length';
type CapacityCode =
  | 'measure.capacity.container'
  | 'measure.capacity.habitat_usable_volume';
type EquipmentCode =
  | 'measure.equipment.power'
  | 'measure.equipment.voltage'
  | 'measure.equipment.frequency'
  | 'measure.equipment.flow'
  | 'measure.equipment.temperature';
type ContentMagnitude = 'mass' | 'volume' | 'count' | 'length' | 'area';
type DeclarationValues = {
  contentMagnitude: ContentMagnitude;
  consumable: boolean;
  animalApplied: boolean;
  fitDeterminesChoice: boolean;
  capacityDeterminesChoice: boolean;
  electricalApplies: boolean;
  relevantDimensionCodes: { codes: DimensionCode[]; toyTypes: string[] };
  relevantFitCodes: FitCode[];
  relevantCapacityCodes: CapacityCode[];
  relevantEquipmentCodes: EquipmentCode[];
  presentationKind: 'formulation' | 'device' | 'packaging';
  optionalNonpertinenceCodes: ProductionDefinitionCode[];
};
type Declaration = {
  [K in keyof DeclarationValues]:
    | { key: K; state: 'unknown'; evidence: null }
    | {
        key: K;
        state: 'known';
        value: DeclarationValues[K];
        evidence: Evidence;
        basis: string;
      };
}[keyof DeclarationValues];
type SellableFacts = {
  variantId: string | null;
  presentation: string;
  declarations: Declaration[];
  careReview: CareReview | null;
};
type Requirement = {
  key: string;
  description: string;
  disposition: 'satisfied' | 'not_applicable' | 'unresolved' | 'conflicting';
  evidence: Evidence[];
  basis: string;
};
type ReviewWarning = {
  key: string;
  requirementKeys: string[];
  text: string;
  disclosure: 'private_only' | 'public_required' | 'unresolved';
  evidence: Evidence[];
  handlingBasis: string;
};
type CareReview =
  | { state: 'unknown' }
  | {
      state: 'prepared';
      jurisdiction: string;
      intendedUse: string;
      determination: 'identified' | 'none_applicable';
      evidence: Evidence[];
      basis: string;
      requirements: Requirement[];
      warnings: ReviewWarning[];
    };
```

`ProductionDefinitionCode` is the exact finite 68-code union exported by
[the production catalog's CHOICES, NUMBERS and OTHER](../src/catalog-editorial/domain/editorial-production-vocabulary-catalog.ts),
not arbitrary string or a union extended by custom definitions. This named inventory
is normative for both optionalNonpertinenceCodes and FactRule.parameter below.
Optional lists are further restricted to the selected family's exact `optional`
fact_rule parameters, not `optional_equipment` or merely `when_asserted` bindings.

Capture and references (all supplied rows, including inactive subjects):

- One row per actual sellable; no sibling/product inheritance. Presentation is exact
  manufacturer subject/presentation prose, 1–300 code points. Declarations ≤12,
  unique key. Known declarations, including false/empty, require Evidence and basis
  1–2000; unknown has no value/basis. No invented known facts for absent rows.
- Presentation/basis and care prose are nonblank Unicode scalar strings, preserved;
  the C0/DEL prohibition belongs only to sourceRef, not all prose.
- Unique subsets: dimensions ≤8, fit ≤3, capacity ≤2, equipment ≤5, toyTypes ≤15,
  optionalNonpertinenceCodes ≤68. Preserve submitted order. Axes must be bound;
  toyTypes resolve exact `toy.type` options, non-toy requires `[]`.
- Content magnitude maps mass→`measure.net_mass`, volume→`measure.net_volume`,
  count→`measure.content_count`, length→`measure.coverage.length`,
  area→`measure.coverage.area`; corresponding measure must be bound.
- Production permissions: consumable/animalApplied hygiene only; dimensions
  toy/hygiene/accessory/habitat/care; fit flag/codes accessory; capacity flag
  accessory, capacity codes accessory/habitat (accessory container only);
  electrical flag/codes accessory/habitat; presentationKind care only.
  Content magnitude and optional lists follow their bound/route checks in all seven.
- **S34 custom subset:** only contentMagnitude with bound canonical measure, and
  unknown or known-empty optionalNonpertinenceCodes. Reject nonempty optional lists
  and every production-only declaration, even unknown. Custom policy metadata does
  not confer production rights. Non-null careReview is care-only.
- Care requirements/warnings ≤32 each, unique exact keys in separate namespaces;
  keys 1–80, descriptions/bases/handlingBasis 1–2000, warning text 1–4000,
  jurisdiction 1–200, intendedUse 1–1000. Each evidence array ≤16 unique exact
  sourceRef/date pairs; empty allowed on draft. requirementKeys ≤32 unique keys
  resolving within this row's requirements, never cross-row.

Unknown/missing facts and structurally valid contradictory declarations can save as
incomplete drafts. Invalid evidence, reference, duplicate identity or capture bound
is malformed and changes no revision. Capture, reference admission, evidence
sufficiency, NA permission and publication readiness are separate gates (§7).

## 5. Full vocabulary metadata

```ts
type Unit = { code: string | null; label: string | null; sortOrder: number };
type Option = {
  code: string;
  label: string;
  archived: boolean;
  sortOrder: number;
};
type Group = { code: string; label: string; optionCodes: string[] };
type Alias = { label: string; optionCode: string };
type NumericPolicy =
  | { status: 'pending' }
  | {
      status: 'resolved';
      magnitude: string;
      integer: boolean;
      lower: number | null;
      lowerInclusive: boolean;
      upper: number | null;
      upperInclusive: boolean;
    };
type Definition = { id: string; code: string; label: string } & (
  | { type: 'text' | 'boolean' }
  | { type: 'number' | 'range'; units: Unit[]; numericPolicy: NumericPolicy }
  | {
      type: 'single' | 'multi';
      options: Option[];
      groups: Group[];
      aliases: Alias[];
    }
);
type OptionTest = {
  definitionCode: string;
  operator: 'equals_set' | 'contains_all' | 'intersects';
  optionCodes: string[];
};
type PolicyCase = {
  code: string;
  when: OptionTest[];
  applicability: 'applicable' | 'not_applicable' | 'unresolved';
  required: boolean;
  allowNA: boolean;
  evidenceRequired: boolean;
  documentary: 'resolved' | 'not_applicable' | 'unresolved';
};
type ProductionFamily =
  | 'food'
  | 'treat'
  | 'toy'
  | 'hygiene'
  | 'accessory'
  | 'habitat'
  | 'care';
type RuleId =
  | 'required'
  | 'optional'
  | 'animal'
  | 'form'
  | 'content'
  | 'dimensions'
  | 'fit'
  | 'capacity'
  | 'space'
  | 'equipment'
  | 'optional_equipment'
  | 'presentation';
type FactRule = {
  family: ProductionFamily;
  ruleId: RuleId;
  parameter: ProductionDefinitionCode;
};
type RuleResult = Pick<
  PolicyCase,
  'applicability' | 'required' | 'allowNA' | 'evidenceRequired' | 'documentary'
>;
type BindingPolicy =
  | { route: 'pending' }
  | { route: 'option_cases'; cases: PolicyCase[] }
  | { route: 'fact_rule'; rule: FactRule };
type Binding = {
  definitionId: string;
  definitionCode: string;
  owner: Owner;
  sortOrder: number;
  exposure: 'INTERNAL' | 'DETAIL' | 'FACET';
  searchable: boolean;
  publicationCheck: 'always' | 'when_asserted';
  policy: BindingPolicy;
};
type Family = { id: string; code: string; label: string; bindings: Binding[] };
type Vocabulary = {
  semanticsVersion: 'editorial-production-1';
  families: Family[];
  definitions: Definition[];
};
type VocabularyResponse = {
  contractVersion: 2;
  vocabularyRevision: string;
  vocabulary: Vocabulary;
};
```

No missing branch metadata/defaults: arrays present even empty; magnitude is a
string, not an invented enum. IDs/codes/labels nonblank; sortOrder safe integer.
Unit code null iff label null; ranges forbid null units. Null numeric bound means
reviewed unbounded with inclusive=false; finite bounds ordered, equality requires
both inclusive. Families/definitions unique by ID/code; bindings unique definition
per family, definitionId/code resolve the same identity. Units/options/groups and
members/test options have unique identities within their definition; references
resolve there. No archive identity reuse or option/group conflation.

Production membership/types/units/domains/routes come from the named 68-code
catalog above and [total policy mapping §1](catalog-editorial-production-vocabulary-policy-mapping.md).
Seven production families retain exact approved bindings, all sellable; custom
extensions use separate custom families. Custom bindings may use pending or
option_cases policies, never production fact_rule policies; removing the family
minimum-version field does not relax this business-rule boundary. Valid extra choice/group identities and
memberships preserve canonical identities/required memberships. Counts use named
`piece,dose_unit,sheet,roll` and pack count `unit`; physical units retain exact
catalog membership (`mg,g,kg`, `ml,l`, `mm,cm,m`, `cm,mm`, `g,kg`, `W,V,Hz,l/h,°C`,
`m,m²` per definition), not interchangeable units. Positive physical measures and
positive integer counts retain catalog bounds; fit ranges and equipment are finite
without invented positivity, temperature signed ordered °C. All 25 production
numeric policies are resolved; pending is incomplete metadata, not production readiness.

Aliases use existing Unicode17 comparison: block alias duplicate/ambiguous
other-target collisions, preserve original text and homonymous option labels.
Required explicit equivalences: Cobaya↔cuyo/cuy/conejillo de Indias,
ninfa↔carolina, asno↔burro. Ambiguous animal names do not auto-select identities;
groups select no members and prove no compatibility. S7 retains explicit
`hygiene.form.bag`, `.pad`, `.diaper` (Bolsa, Tapete absorbente, Pañal), separate
from packaging and product types. No automatic product assignment.

## 6. Canonical content revision R

Materialize exactly the complete authorized Vocabulary DTO, including explicit
policy tags; no internal DB fields or Family minimum version. Preserve the existing
§6 algorithm with that removed field; no old synthetic digest is promised.

1. Sort families by label then code; definitions by code; bindings by sortOrder then
   definitionCode; options/units by sortOrder then code (null first). All string
   comparisons are UTF-8 bytewise, never locale/SQL collation.
2. Sort groups by code, aliases by label then optionCode and every optionCodes array
   by code. For option_cases sort cases by code and when tests by definitionCode;
   fact_rule has no cases. Reject duplicates, do not stabilize them by input order.
3. Hash preimage exactly `{contractVersion:2,vocabulary:V}`. No company, tenant,
   authority, state or product scope field is added.
4. Recursively serialize object keys ascending UTF-8 bytes (no integer-key special
   case), arrays in specified order. No whitespace/BOM/trailing newline. Retain
   required nulls/empty arrays; reject undefined, extra keys, nonfinite numbers and
   lone UTF-16 surrogates.
5. Quote strings; escape quote/backslash as `\"`/`\\`; U+0000–U+001F use lowercase
   `\u00xx`. Emit other Unicode scalar values literally, no normalization/slash
   escaping. Numbers use ECMAScript JSON.stringify finite spelling, -0 as 0;
   booleans/null lowercase.
6. UTF-8 encode; SHA-256; prefix lowercase hex with `ev2-sha256-`. Exclude envelope R,
   HTTP headers, product facts/audits. Include every explicit DTO field, labels,
   archive flags and policies. Return vocabulary in the same array orders.

R identifies content within authenticated endpoint/account context, not authority,
a global company token or CAS lease. Equal DTOs can share R across deployments;
FE cache keys include API/account scope. GET observes coherent metadata/state;
fresh writes compare the same current snapshot under coordination, including new
metadata insertions. Semantics changes require changing semanticsVersion, not
silently reusing `editorial-production-1`. Replay needs no historical metadata fetch.

## 7. Selected policy, completeness and care publication

Each binding selects exactly one route, never option matching after fact_rule.
For option_cases: AND tests; empty when unconditional. Read each tested binding's
owner/subject (product→null; sellable→current subject). Known single is a singleton,
known multi its exact set. equals_set means equality, contains_all means all expected
members, intersects means any common member; order ignored. Expected sets nonempty;
missing/unknown/NA never match. No aliases/groups/evidence prerequisite for matching.
Exactly one case must match; zero/multiple/pending fails closed as unresolved. Static
checks reject contradictory/overlapping custom cases and selector dependency cycles.
S44: reject policy metadata where a product-owned target tests a sellable-owned
selector. Product→product, sellable→product and sellable→sellable dependencies
remain allowed; no cross-variant aggregation is inferred.

For every E subject evaluate always bindings, including absent assignments, plus
when_asserted bindings with known/NA assertion and selected option-case dependencies.
Omitted/unknown optional assertions do not seed evaluation. Potentially required
cases must be always; dependencies are not unrelated mandatory evidence checks.
NA admission requires selected applicability=not_applicable AND allowNA=true;
applicable/unresolved forbids NA. Known assertions contradicting a selected NA result
may save but cannot publish. Required implies applicable, and requires known at
publish; unresolved evaluated applicability/documentary status blocks. Required
single/text/multi must be nonempty (ECMAScript trim only to test text emptiness);
valid boolean/number/range can satisfy required. Optional known false/empty remains
a known assertion. Policy `documentary` is readiness metadata, never product legal
compliance or evidence. Product-owned rules evaluate once, not once per variant.
S50: even when E is empty, product-owned always bindings and known/NA assertions
are evaluated once. This adds no sellable subject or null identity to E and does
not waive any other publication gate.

Production route results have exact five-field values in order
(applicability, required, allowNA, evidenceRequired, documentary):
O=(applicable,false,false,true,resolved), R=(applicable,true,false,true,resolved),
N=(not_applicable,false,true,true,resolved), U=(unresolved,false,false,true,resolved).
All production known assertions require per-value evidence at publish, including
optional false/empty values. Required/optional routes yield R/O respectively;
optionalNonpertinenceCodes selects N only for its permitted optional parameter.
Content selects the matching required measure; other bound measures remain O,
not inferred NA. Care presentation selects one required representation, others O.

E is the union of offered real sellable identities over all available tenant
catalog price-list bindings, not stock/search/category/pagination or only default
context. Retain hidden-price/prescription exceptions. Validate/attest each identity
once; no generated subject or sibling fallback. All captured rows undergo reference
checks, but incomplete inactive rows do not add publication gates.

| Family    | Retained per-E minima / determinations                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| food      | animal.target + food.format; known bound content magnitude/measure                                                        |
| treat     | animal.target + treat.form; mass/volume/count content                                                                     |
| toy       | animal.target + toy.type; dimension determination covers exact selected toy type set and union of pertinent axes          |
| hygiene   | hygiene.type; animalApplied true→recipient, false→NA; consumable true→form/content, false→NA                              |
| accessory | accessory.type; fit/capacity relevance flags decide required named subsets/measures, not universally both                 |
| habitat   | habitat.type; known pertinent dimensions/capacity, electricalApplies decides equipment subset/measures                    |
| care      | care.type + presentationKind + content + confirmed review; formulation→care.form, device→care.device, packaging→pack.form |

Unknown relevance blocks its condition, never inferred false. True requires nonempty
pertinent subset; false with nonempty subset/known associated value contradicts
publication. Evidenced empty subset can establish nonpertinence only for its
condition; unlisted axes remain optional, not inferred NA. Habitat both spatial
subsets empty needs explicit evidenced equipment-only bases. Optional facts are not
extra universal minima. Optional nonpertinence cannot waive required/conditional
routes. Content.kind, if asserted, must agree; pack_count is not content. Evidence
for facts never substitutes for compatibility/stage/composition/declared-value evidence.

S52: a known canonical `content.kind` assertion requires a known matching
`contentMagnitude`, even in an otherwise optional context: `content.kind.mass`→mass,
`content.kind.volume`→volume, `content.kind.count`→count,
`content.kind.length`→length and `content.kind.area`→area. The same canonical
meaning applies in custom families. Unmapped extra options block publication
until explicitly mapped; labels, aliases and prefixes do not establish agreement.
Absent/unknown/NA kind skips this comparison; explicit-NA admission remains
independent. This agreement does not select owners/subjects or infer aggregation.

S46: accessory `optional_equipment` returns O when `electricalApplies` is missing
or unknown, even for a known equipment value with valid evidence. Unknown electrical
relevance alone does not block that optional assertion; all other checks remain.

Care publication requires one prepared valid review for each E subject, scoped to
presentation/jurisdiction/use, nonblank basis and ≥1 review evidence. Identified
requires ≥1 requirement; satisfied/NA requirements need evidence/basis; unresolved
or conflicting blocks. none_applicable requires requirements=[] and warnings=[],
with evidenced explanation, not an empty-list exemption. Each warning needs
≥1 evidence and handlingBasis; unresolved disclosure blocks. public_required blocks
this slice because no public regulatory-warning channel is approved. private_only
is a human evidenced declaration, not automatic declassification. Existing live
prescription/operational controls remain mandatory.

Publisher explicitly sees all candidate reviews and exact revision, inactive rows
labeled, before sending review-v1. No legal verification/certification is claimed;
source/date alone or a ready policy cannot pass. No private warning copied into
public description/instructions. New eligibility under lock requires its review;
confirmation cannot waive missing facts or E coverage. Runtime option selection,
full D14/E evaluator and transactional integration remain implementation work.

## 8. State, lifecycle, conservation and execution order

```ts
type ArchivedWarning = {
  code: 'ARCHIVED_OPTION';
  familyId: string;
  definitionId: string;
  owner: Owner;
  variantId: string | null;
  optionCode: string;
};
type EditorialState = {
  cycle: number | null;
  draft: {
    revision: number;
    basePublishedRevision: number | null;
    document: Document;
  } | null;
  published: { revision: number; document: Document } | null;
  warnings?: ArchivedWarning[];
};
type StateResponse = {
  contractVersion: 2;
  vocabularyRevision: string;
  state: EditorialState;
};
```

Direct document slots, no wrapper or synthetic document. No state means
cycle/draft/published all null. Fresh empty initializer is exactly:

```ts
{ schemaVersion: 2, commercialTitle: null, description: null,
  mediaRefs: [], familyCode: null, values: [], facts: [] }
```

Initialize requires no active draft, expectedCycle null only for absent state,
otherwise exact current cycle; new cycle 1 or prior+1, draft revision1/base current
Published revision or null. Existing target Published is copied unchanged into the
new draft; no conversion, injection, fresh bounds or completeness check on copy.
Save replaces whole draft and increments revision. Publish revalidates locked draft,
copies unchanged at Published revision1 or prior+1, clears draft. Discard clears
only draft without document validation. Publish/discard retain cycle. No pair reuse,
publication history API or expectedPublishedRevision. Persisted counters are positive
int32; attempted counter overflow/stale CAS is 409 CONFLICT, no partial mutation.
Malformed nonpositive/noninteger request counters are 400; do not invent a new
pre-lookup safe-integer or storage-bound wire rule.

Archived assignments conserve only identical family/definition/owner/variant/type/
option identity: save baseline is stored Draft; publish baseline current Published
(null→empty), initialize source Published. No new/moved/re-added archived option.
S42: a structurally or context/reference-invalid baseline grants no conservation
as a whole, not per surviving row. Do not disqualify a baseline solely for unrelated
new evidence, numeric-policy or facts validation failures. The fresh candidate
still passes every applicable fresh check; corrected fresh candidates remain possible.
Media ownership remains a server-side check; baseline presence is not ownership proof.
Valid conservation warnings use exact IDs/fields above; fresh empty warning array
omitted, GET does not fabricate warnings from invalid history. Recorded warnings
are preserved exactly, including ordering/presence, never rebuilt on replay.

Order: framework parsing → current auth/authority → closed wire/header admission →
write Product coordination/lock → receipt lookup and identity match → on miss fresh
locked CAS → conditional care requiredness/current R → domain/reference/conservation/
D14/live controls → mutation plus receipt atomically. Wire admission before lookup
checks primitive/closed shapes, not current membership, evidence sufficiency,
numeric domains, NA or completeness. Current R mismatch on fresh writes (including
initialize/discard), or coherent document GET, is 409 VOCABULARY_CHANGED. Fresh R
is checked after receipt/CAS, not ahead of a matching historical acknowledgement.
Retain existing transaction/reference gates; S9/S10 integration must verify writer
coverage and global lifecycle→Tenant→Product→children lock order, not claim it done.

## 9. Receipt identity, recorded acknowledgement and private audit

```ts
type ReceiptRequest = {
  receiptVersion: 2;
  contractVersion: 2;
  vocabularyRevision: string;
  careConfirmation: 'review-v1' | null;
  body: InitializeBody | SaveBody | TransitionBody;
};
type CareAttestation = {
  actorId: string;
  confirmedAt: string;
  tenantId: string;
  productId: string;
  cycle: number;
  draftRevision: number;
  publishedRevision: number;
  vocabularyRevision: string;
  documentDigest: string;
  subjects: { variantId: string | null; presentation: string }[];
};
type ReceiptResult = {
  receiptVersion: 2;
  status: 200 | 201;
  body: StateResponse;
  headers: {
    'Editorial-Contract-Version': '2';
    'Editorial-Vocabulary-Revision': string;
  };
  careAttestation: CareAttestation | null;
};
```

Namespace is operation/tenant/product/actor/key; request body must correspond to
operation. Compare R/body/careConfirmation (and fixed schema identifiers) with
existing structural JSONB equality, not serialization whitespace/key order.
No adoption identity. Same key different intent→409 CONFLICT. Same intent→exact
recorded status/body/R/warnings acknowledgement, not current GET, no restoration or
republish. Current authority/existence and established reference/conservation gates
remain side-effect-free replay gates; replay may still fail them. No fresh current-R,
CAS, numeric/evidence/domain/D14 checks, historical metadata fetch or result rebuild.

Record success atomically: initialize201, other writes200; result header/body/request
R equal. Private attestation null except confirmed care publish; never expose the
full receipt/attestation as HTTP body. Actor/time/scope server-owned; confirmedAt is
UTC ISO8601 with milliseconds. Cycle/draftRevision match request; publishedRevision
matches result. subjects project E rows to variantId/presentation in original facts
order, no extras/omissions. Digest is `ecd2-sha256-` + lowercase SHA256 hex over
`{cycle,draftRevision,document}` using §6 canonical serialization/UTF8 but **preserving
all document array order**, including inactive rows. R separately pins policy.
Replay preserves audit/time/digest, never re-confirms. New saved revision/cycle needs
new explicit confirmation; old acknowledgement is not reusable publication authority.
Failure changes no state and records no successful attestation.

## 10. Errors, FE reconciliation and reset boundary

Editorial envelope is exactly `{statusCode,error}`, no message/timestamp/field
hints/document/R. The complete target error enum is:

| Status | error                                | Meaning                                                          |
| ------ | ------------------------------------ | ---------------------------------------------------------------- |
| 400    | MALFORMED                            | Wire/header/UUID or fresh document/publication admission         |
| 401    | UNAUTHORIZED                         | Missing/invalid authentication                                   |
| 403    | FORBIDDEN                            | Current editorial authority or qualified-product failure         |
| 404    | NOT_FOUND                            | Product lost after authorization                                 |
| 409    | CONFLICT                             | CAS, absent/active draft, overflow, receipt intent mismatch/race |
| 409    | VOCABULARY_CHANGED                   | Pinned R differs from current coherent snapshot                  |
| 500    | EDITORIAL_VOCABULARY_UNREPRESENTABLE | Whole metadata response cannot be represented; never omit/prune  |
| 500    | INTERNAL_ERROR                       | Sanitized unexpected failure                                     |

No 406, unsupported, adoption or upgrade errors. The registered editorial filter
maps the original codes plus deliberate `VOCABULARY_CHANGED` and typed vocabulary
representation failures; arbitrary same-message representation errors stay internal.
Errors carry version2/no-store and remove any stale revision header. Framework
invalid JSON/413/unmatched-route errors remain outside this local envelope; FE
handles non-envelope failures generically.

Bootstrap CORS specializes only the seven editorial routes and their preflights,
including Express case/trailing-slash aliases and malformed Product IDs. Original
origin/credentials policy and unrelated routes' reflected headers stay unchanged.
HTTP tests use real Nest/Express CORS with synthetic JWT/Prisma I/O or error probes;
this is not live database/browser or complete document/write integration proof.
CORS exclusions are not direct-request header admission; remaining lifecycle
header validation belongs to the coordinated document/write integration.

FE installs vocabulary/document only with equal R and API/account/product scope.
If requests race metadata changes, discard the incoherent pair and reload explicitly;
context is parallel current identity information, not R-pinned. Preserve local buffer.
Ambiguous retries freeze original key/R/body/token exactly, even after later GET or
metadata change. Receipt is acknowledgement, never overwrite a newer buffer/expected
state with it. On either 409 retain edits and offer explicit reload/reconciliation;
no autosave retry, inferred success or automatic new key. A newly confirmed user
attempt uses current CAS/R and a new key, not an automatic renewal by deduction.

Cutover must retire old test editorial state and all old receipt namespaces so old
state/receipts cannot remain replayable. This is a separate authorized environment
operation, not conversion/backfill or permission to execute deletion. Read-only
schema finding: four editorial receipt tables reference state with FK Restrict;
selected receipts must precede selected state in the reset proposal. Do not infer
SQL/environment selector, reset target, Product deletion or operational cascade.
No operational stock/price/sales/POS data deletion is needed or authorized here.

No public evidence, warnings, review or attestation exposure. Future C3.3 uses only
Published, excludes unpublished list items/detail404 and builds allowlisted DTOs:
FACET filter+detail, DETAIL detail only, INTERNAL never public; initial search only
published title/description. Supporting files stay private; exposure never implies
searchability. Bounded repository finding: inspected current public repository reads
operational Product, not editorial Published. This document does not wire that
consumer, activate public visibility or prove revision-bound eligibility coverage.

## Key Learnings

- One schema removes compatibility state, not permissions, CAS, R or atomic receipts.
- Private capture and policy readiness do not establish legal truth or publishability.
- Review target shapes and cutover prerequisites before FE delivery/source changes.

Retained field evidence: domain `editorial-document-shape-v2.ts`,
`editorial-value-shape-v2.ts`, `editorial-known-payload-shape-v2.ts`,
`editorial-evidence-v2.ts`, `editorial-declaration-shape-v2.ts`,
`editorial-sellable-facts-shape-v2.ts`, `editorial-care-{capture,entry}-shape-v2.ts`,
`editorial-vocabulary-{simple,numeric,choice,policy-shape,family-shape,shape}-v2.ts`,
`contextual-document.ts`; application `editorial-recorded-receipt-result-v2.ts`.
These are retained-field evidence only: remove superseded Family minimum-version,
request adoption and state document-mode fields; do not copy their old envelopes.
