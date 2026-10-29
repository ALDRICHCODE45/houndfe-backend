# Private sellable facts and care confirmation — proposal v0.2 (wire v0.5 addendum)

**DRAFT, pending final BE/FE technical review; not implementation authorization.** Covers T2 S1–S8, especially W01/W02; use with [wire v0.5](catalog-editorial-production-vocabulary-contract-proposal.md).
[Normalized inventory](editorial-vocabulary-normalized-proposal.md) §§4–7 supplies exact domains/D14; [source snapshot](editorial-vocabulary-source-snapshot.md) §7 supplies approved minima. Provenance/hashes are in wire §8. [Total policy mapping](catalog-editorial-production-vocabulary-policy-mapping.md) supplies the exclusive selected-route result; this addendum supplies inputs/audit, not a second option dispatch.
U01–U06/U09–U13 are actual-product evidence states, not taxonomy-wide blockers. S7 closes U14 for bag/pad/diaper; other unsupported forms remain incomplete. Neither table readiness nor an option test proves a manufacturer's declaration or legal compliance.

## 1. One private document shape (W01)

Append required `facts: SellableFacts[]` to schemaVersion2 DocumentV2. Every row is private, never public/indexed/faceted. Rows supplement, not replace, `values` or per-value evidence.
Use at most one row per actual sellable: actual variantId from authorized context, null only for a simple product. E is the EXISTING currently offered real-sellable eligibility result under existing coordination, not all real/current-care subjects or a new eligibility definition. Publication requires facts/review only for E; no generated identity, inheritance or sibling fallback.
All object branches below are closed; every listed key required. Omission means no row/declaration. Unknown is explicit and never false, empty, NA or a fabricated known value.

```ts
type FactEvidence = { sourceRef: string; verifiedOn: string };
type Fact<T> =
  | { state: 'known'; value: T; evidence: FactEvidence; basis: string }
  | { state: 'unknown'; evidence: null };
type DimensionCode =
  | 'measure.dimensions.external_length' | 'measure.dimensions.external_width'
  | 'measure.dimensions.external_height' | 'measure.dimensions.external_diameter'
  | 'measure.dimensions.internal_length' | 'measure.dimensions.internal_width'
  | 'measure.dimensions.internal_height' | 'measure.dimensions.internal_diameter';
type FitCode = 'measure.fit.neck' | 'measure.fit.chest' | 'measure.fit.back_length';
type CapacityCode = 'measure.capacity.container' | 'measure.capacity.habitat_usable_volume';
type EquipmentCode =
  | 'measure.equipment.power' | 'measure.equipment.voltage' | 'measure.equipment.frequency'
  | 'measure.equipment.flow' | 'measure.equipment.temperature';
type ContentMagnitude = 'mass' | 'volume' | 'count' | 'length' | 'area';
type Declaration =
  | ({ key: 'contentMagnitude' } & Fact<ContentMagnitude>)
  | ({ key: 'consumable' | 'animalApplied' | 'fitDeterminesChoice'
      | 'capacityDeterminesChoice' | 'electricalApplies' } & Fact<boolean>)
  | ({ key: 'relevantDimensionCodes' } & Fact<{ codes: DimensionCode[]; toyTypes: string[] }>)
  | ({ key: 'relevantFitCodes' } & Fact<FitCode[]>)
  | ({ key: 'relevantCapacityCodes' } & Fact<CapacityCode[]>)
  | ({ key: 'relevantEquipmentCodes' } & Fact<EquipmentCode[]>)
  | ({ key: 'presentationKind' } & Fact<'formulation' | 'device' | 'packaging'>)
  | ({ key: 'optionalNonpertinenceCodes' } & Fact<OptionalDefinitionCode[]>); // closed per-family enum in mapping §1
type SellableFacts = {
  variantId: string | null; presentation: string; declarations: Declaration[];
  careReview: CareReviewCapture | null;
};
```

`presentation` is the manufacturer's exact subject/presentation description, not a free-standing reusable approval or substitute for actual identity. Evidence/basis in that row explicitly refer to this product, variant and presentation.
The existing authorized editor records human manufacturer declarations. Backend verifies capture/reference scope, not source authenticity, URL reachability, document existence or legal truth.
sourceRef is only a textual locator (e.g. manufacturer document/version/page); no URL fetch, upload, asset IDs or invented asset support. A locator naming a private file grants no access to it.
Fact evidence is mandatory for every **known** declaration, including false booleans, empty subsets and documented nonpertinence; basis records what the source establishes for this subject. No `source.reference`/`source.checked_at` duplicate typed assignments are provisioned: those normalized rows describe these associations, not extra values.
Per-value evidence remains separate: a relevance statement never automatically supplies evidence for animal compatibility, composition, stage or declared features. Do not convert a fact row into hidden attribute assignments.

### Exact capture bounds and scope

- At most 200 fact rows total, unique variantId, independently of the unchanged <=200 `values` assignments. At most 12 declarations per row, unique key; no blank rows required for optional/unknown facts. The existing 100kB serialized JSON body ceiling still applies to everything combined.
- Strings count Unicode code points, preserve exactly, reject lone surrogates. Presentation 1–300; sourceRef 1–1000; basis 1–2000; nonblank under ECMAScript trim. SourceRef disallows C0/DEL controls; no trimming, normalization or automatic interpretation.
- verifiedOn is exactly 10 ASCII characters, real Gregorian `YYYY-MM-DD`, year 0001–9999; no invented expiry/recency/future-date policy. Same bounds apply to per-value Evidence sourceRef/date in new v2 candidates.
- Dimension codes array <=8; fit <=3; capacity <=2 (accessory only container); equipment <=5; all unique. toyTypes <=15, unique exact `toy.type` option codes; non-toy requires []; toy requires the exact selected known toy.type set at publish. Arrays are sets semantically; preserve submitted order on storage/replay.
- optionalNonpertinenceCodes is permitted in all families, <=68 unique definition codes, restricted to that family's optional-route parameters in the mapping. Known [] denies nothing; unknown/omission grants no NA. Each listed code is an explicit evidenced nonpertinence determination; cannot waive required/conditional rules.
- Allowed other fact keys by family: contentMagnitude all where corresponding content measure is bound; consumable/animalApplied hygiene only; dimensions toy/hygiene/accessory/habitat/care; fit flag/codes accessory only; capacity flag accessory only, capacity codes accessory/habitat; electrical flag/codes accessory/habitat; presentationKind care only. Other key/family or unbound axis/code is malformed, not a new option.
- Custom families may capture contentMagnitude when the corresponding canonical content measure is bound, and unknown or known-empty optionalNonpertinenceCodes. Nonempty optionalNonpertinenceCodes and production-only declarations are malformed for custom families; custom metadata or minimumContractVersion does not confer production fact permissions. This rule applies only to fresh V2 admission, not historical decoding or receipt replay.
- A careReview may be non-null only for care; familyCode null requires facts=[]. Omitted facts `[]`, unknown declarations and missing prepared reviews save as valid incomplete drafts. Malformed supplied evidence/date, duplicate key/variant, foreign/deleted variant or invalid axis is 400 MALFORMED with no revision change.
- Contradictory but structurally valid declarations can be saved for correction; publish blocks them, never picks one convenient source. Known facts require evidence even in drafts; absent/unknown facts do not require invented evidence.

## 2. Finite family evaluator, no new rule engine

Use normalized §5 D14 as resolved by total mapping §1–§2 per E subject under existing locks. Family is the document field. Each binding chooses one fact_rule OR option_cases; consume that one five-field result once. Production uses only the enumerated fact routes, never a second unconditional OptionTest after fact NA.
Root minima are unconditional for E; optional assertions use when_asserted. All rows undergo shape/reference checks, including inactive subjects. Structurally valid inactive rows are retained/digest-covered; incomplete inactive facts/review never add a publish gate. Never block an entire taxonomy on one product's unknown facts.

| Family | Fact inputs required to resolve the existing minimum |
| --- | --- |
| food | Known contentMagnitude → bound matching content measure; animal.target and food.format always required |
| treat | Same, restricted to mass/volume/count; animal.target and treat.form always required |
| toy | toy.type and animal.target required; known dimension determination covers every selected toy type, and requires union of named axes once each. Known empty codes allowed only with documented nonpertinence basis for all selected uses, not a name-based waiver |
| hygiene | hygiene.type required; consumable true → hygiene.form + known contentMagnitude/matching measure, false → those minima NA; animalApplied true → animal.target, false → recipient minimum NA. Unknown/omitted flags block only these conditions |
| accessory | accessory.type required; fitDeterminesChoice true → known nonempty fit subset and every named range, false → minimum NA; capacityDeterminesChoice analogous with container. Unknown either flag blocks that condition |
| habitat | habitat.type required; known dimension and capacity determinations require named measures, one/both sets as pertinent. Both empty require explicit evidenced equipment-only nonpertinence in both bases. Known electricalApplies true → nonempty equipment subset + each named measure; false → electrical minimum NA |
| care | care.type, known presentationKind, known contentMagnitude/matching measure, and confirmed review in §3. formulation→care.form; device→care.device; packaging→pack.form. No instrument/medicine label exempts content or review |

Matching content measure: mass→measure.net_mass, volume→measure.net_volume, count→measure.content_count, length→measure.coverage.length, area→measure.coverage.area; reject a family-unbound combination. pack_count cannot satisfy content. Optional content.kind, if asserted, must agree.
For a required conditional minimum, true relevance with missing/unknown/empty subset blocks; false plus nonempty subset or a known associated value contradicts it and blocks publication. True+nonempty subset names required axes; unlisted axes remain optional, NOT inferred NA. Explicit evidenced empty relevance authorizes NA only for the corresponding conditional minimum. A known assertion in a selected-route NA outcome remains a valid conflicting draft but rejects publish. No silent deletion/normalization.
Habitat's dimension/capacity inputs are known subsets with evidence; no additional universal capacity flag. Accessory electrical/dimensions, hygiene/care dimensions and other optional facts are not extra D14 minima: omitted/unknown optional facts do not seed checks. If asserted, their scoped evidence and consistency are checked, not promoted into unrelated requirements.
Evidence, numeric domains, live controls, referenced variants and all required bindings (including absent assignments) still validate independently. No automatic conversion, calculation from dimensions, animal expansion, source-to-value copying or scope inheritance.
U07 fit uses finite ordered inclusive ranges with named cm/mm, no extra lower bound. U08 equipment scalars finite with exact named units, no invented signs/bounds; temperature finite ordered signed °C. Other physical/count positivity and integer/unit rules are normalized §4, not changed here.
U13 still requires explicit recipient identification/species-cycle support; an ambiguous term never creates a valid option. Optional life.stage remains optional; evidence cannot invent an unsupported stage.

## 3. Prepared care review and publisher confirmation (W02/S8)

Review capture is a private human-authored dossier, never a client-controlled approved/ready flag. It records the exact presentation from its row; known presentationKind and content remain separate facts. No legal checklist or new grant is defined.

```ts
type Requirement = {
  key: string; description: string;
  disposition: 'satisfied' | 'not_applicable' | 'unresolved' | 'conflicting';
  evidence: FactEvidence[]; basis: string;
};
type ReviewWarning = {
  key: string; requirementKeys: string[]; text: string;
  disclosure: 'private_only' | 'public_required' | 'unresolved';
  evidence: FactEvidence[]; handlingBasis: string;
};
type CareReviewCapture = { state: 'unknown' } | {
  state: 'prepared'; jurisdiction: string; intendedUse: string;
  determination: 'identified' | 'none_applicable';
  evidence: FactEvidence[]; basis: string; requirements: Requirement[]; warnings: ReviewWarning[];
};
type CareAttestation = { // server-owned receipt evidence, never a DocumentV2 input field
  actorId: string; confirmedAt: string; tenantId: string; productId: string;
  cycle: number; draftRevision: number; publishedRevision: number;
  vocabularyRevision: string; documentDigest: string;
  subjects: { variantId: string | null; presentation: string }[];
};
```

Capture bounds: requirements/warnings <=32 each, unique key within each array; key 1–80 nonblank, description/basis/handlingBasis 1–2000 nonblank; warning text 1–4000 nonblank; jurisdiction 1–200, intendedUse 1–1000 nonblank. Evidence arrays <=16 unique sourceRef/date pairs; empty permitted on draft. Same string/date rules as §1.
requirementKeys <=32 unique keys referencing requirements in this same row; no cross-row references. Missing/unresolved/conflicting review evidence saves if well-formed but blocks publish. A malformed supplied locator/date/reference is rejected on save, not treated as evidence.
At publish require exactly one prepared valid care row for every E subject, with nonempty jurisdiction/intendedUse/basis and >=1 scoped review evidence. Inactive rows undergo shape/reference checks but their incomplete reviews are not gates. Identified determination requires >=1 requirement; each satisfied/NA requirement needs >=1 evidence and explicit basis; unresolved/conflicting disposition blocks.
none_applicable requires requirements=[] and warnings=[], evidenced basis explicitly documenting why no requirements apply to this jurisdiction/use/presentation. Empty list alone never passes; publisher confirms that documented determination, not an automated exemption.
Every recorded warning needs >=1 evidence and explicit handlingBasis; unresolved disclosure blocks. `private_only` is the publisher's evidenced declaration that no public warning is required, not automatic S4 declassification. If a warning must be public, `public_required` blocks this slice: no approved public regulatory-warning channel exists here. Do not mirror private text into description/instructions or treat the header as approval of a new channel.
Review records human declarations, not authenticated manufacturer documents, legal verification or certification. Existing live prescription/operational controls remain authoritative and cannot be waived by evidence, disposition, private text or publisher confirmation.

### One confirmation request mechanism and atomic audit

Only `POST /products/:productId/editorial/draft/publish` with version 2 accepts `Editorial-Care-Confirmation: review-v1` (exact single ASCII value). Body remains exactly `{expectedCycle,expectedRevision}`; R and Idempotency-Key remain required.
For a fresh locked care candidate, that header is required; for non-care it is forbidden. All other v2 endpoints prohibit it. Version 1 keeps ignored-header behavior, never gains confirmation powers or production write admission.
Header absence on required care publish/forbidden presence → 400 MALFORMED; invalid/duplicate/list token → 400 before receipt lookup. Presence is explicit after UI displays ALL captured candidate care reviews and exact revision, inactive rows labeled (not extra gates); never an automatic default. Captured newly eligible reviews were therefore displayed; a newly eligible subject with no row fails under lock. No new eligibility-context pin is introduced.
Pre-lookup validates only header and closed wire shape/primitive types. New ReceiptRequestV2 adds required `careConfirmation:'review-v1'|null`; normalized token enters identity with body, version, R and adoption. Same key changed token/body/R is 409 CONFLICT.
After receipt miss: existing publisher authority (read+publish), Product/state CAS, pinned R, all minima/evidence/applicability for E plus all-row reference checks and existing live controls and unsupported-Published guard must pass. Confirmation cannot rescue failed gates.
Successful publish atomically confirms the exact locked candidate named by expectedCycle/revision, copies it to Published, consumes Draft and records CareAttestation. Actor is from current authorized principal, time server UTC ISO8601 with milliseconds, scope from qualified tenant/product; never client actor/time/scope.
Digest: `ecd2-sha256-` plus SHA256 lowercase hex over `{cycle,draftRevision,document}` serialized by wire §6 steps 4–5 and UTF8, **preserving document array order**; no vocabulary-array sorting. R separately pins policy. subjects=candidate.facts filtered by E, projected to variantId/presentation in original row order, no extras/omissions. Whole-document digest retains all arrays/rows including inactive capture; changing inactive content changes digest too.
**Proposed storage need:** add required internal `careAttestation:CareAttestation|null` to NEW v2 ReceiptResultV2 JSON, atomically with state/result; null on non-care operations. This is an immutable private receipt attestation, separate from StateV2/body and document payload, not an assertion that audit columns already exist. The receipt body already retains the exact Published review/facts and digest source; no second arbitrary baseline or client audit field.
Matching same-key replay rechecks existing authority/reference gates but returns original acknowledgement/version/R and attestation unchanged; never re-confirms at today's time, rebuilds modes/warnings, fetches old metadata or validates raw history under new facts rules. No old receipt/result backfill.
A changed saved Draft has another revision, so old confirmation cannot authorize it: new explicit confirmation/key with current CAS is required. An old-key exact retry only acknowledges its old publication and cannot publish again. A later cycle never reuses that CAS pair; prior attestation is not a reusable approval on initialize/save.
Failure stores no success attestation, changes no Draft/Published and grants no recovery authority. Ordinary editor correction/discard uses existing permissions; receipt retention must preserve these private attestations with their recorded acknowledgements, not expose them in public queries/caches.

## 4. Integration, overlay and acceptance vectors

Fresh V2 save requires the complete DocumentV2 including facts (possibly []); adoption constructs `facts:[]` only in the unsaved local buffer, never invents known declarations. Fresh initialize still copies raw Published/legacy empty unchanged. No historical documents/replay payloads are backfilled; no nonfinite cross-version conversion.
S7 controlled manifest overlay: `hygiene.form.bag=Bolsa`, `hygiene.form.pad=Tapete absorbente`, `hygiene.form.diaper=Pañal`. Same hygiene.form single/sellable/F/searchable-false binding and consumable/content rules; distinct from pack.form and hygiene.type. No auto assignment or altered numeric units.
Original immutable 67 source rows/514 options remain exact; 3 approved additive options yield 517 combined options. Normalized semantic source/date rows map to evidence associations above, not duplicate typed metadata assignments. Source snapshot D16 republish replacement wording is overridden by closed current C3.2 Published-conservation rule.

| Public HTTP boundary exercised privately by authorized clients | Deterministic future expectation (not executed tests) |
| --- | --- |
| Hygiene consumable=false, animalApplied=false, each with evidence/basis | Valid draft; those three minima condition-authorized NA, no invented recipient/content/form |
| Same flags unknown/omitted | Valid incomplete draft; affected publication conditions fail, never false |
| Known false or known [] without evidence; supplied invalid date | 400 save, no revision change; known negative findings need evidence |
| Fact row references another product's variant, null on variant product, duplicate key or measure.fit in dimensions | 400 save; no scope inheritance/code reinterpretation |
| Optional accessory electrical fact omitted/unknown; material/stage omitted | No new publication blocker; existing required fit/capacity determinations still evaluated |
| Toy ball+chew axes cover only ball, or true fit flag with empty codes | Save well-formed incomplete/conflicting data; publish fails until all selected uses/required axes resolved |
| Care review prepared + source/date, no confirmation header | 400 publish, no mutation/attestation; policy readiness is not confirmation |
| Confirmation present, missing requirement evidence/conflicting status/public_required warning | 400 publish, no mutation/attestation; no waiver or private-to-public leakage |
| Care none_applicable with empty evidence/basis | Cannot pass; documented NA determination and explicit publisher confirmation required |
| Confirm revision r but saved current r+1 | 409 CONFLICT; old confirmation/attestation cannot authorize r+1 |
| E={A}, valid prepared A + inactive unknown review B | Publish gate checks A only; subjects=[A], B retained/digest-covered; B edit changes whole-document digest |
| B becomes eligible after capture/display, but B has no row or unknown review | Publication fails under lock; header cannot waive E review requirement |
| Exact successful receipt retry after new draft/metadata | Original status/JSON/version/R/attestation, subject to existing rechecks; no repeated publish/audit timestamp |
| Same key without original confirmation token | 409 CONFLICT after structural admission; no result reconstruction/backfill |

## Key Learnings

1. Manufacturer relevance facts are scoped declarations per real sellable, not facts derivable from a taxonomy option.
2. S7 adds three forms without changing the immutable 514-option source inventory.
3. S8 assigns confirmation to the existing publisher; a captured review is not itself legal verification or publication authority.
