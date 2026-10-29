# Fresh V2 document references

`assertFreshDocumentReferencesV2(candidate, references, vocabulary)` is a dormant,
reference-only assertion for T3d S2 (wire contract §§7/9 and facts §1).

Preconditions: a wire-parsed candidate; coherent, validated, unique-ID/code,
reference-consistent V2 metadata; tenant/product-qualified all-real variant IDs
and selected-asset union. Outer coordination must keep those observations stable.
This function neither establishes authority nor proves locking.

It checks media membership/uniqueness, selected family, actual binding/definition
identity, owner/subject, composite value keys, exact known type/unit/option codes,
multi uniqueness, and every fact row's unique real subject (including inactive
variants, independently of E). Null family requires empty values and facts.
Unknown and NA still require binding/owner/subject, without invented payloads.
Failures deliberately throw plain `Error('MALFORMED')`; inputs remain unchanged.

Archived-option membership alone passes: this is **not assignment permission**.
Completeness, numeric policy/domain/range ordering, evidence, NA applicability,
fact internals, bounds, archive conservation and D14 remain separate checks.
Pending numeric policy is not interpreted as unbounded; it is not inspected here.
No defaults, canonical IDs, legacy/history/replay validation or HTTP activation.

## Key Learnings

- Resolve custom metadata through actual binding IDs/codes, never production IDs.
- Value uniqueness excludes owner. An owner-changing duplicate can also fail owner
  matching; same-owner tests isolate duplication, not that ambiguous case.
