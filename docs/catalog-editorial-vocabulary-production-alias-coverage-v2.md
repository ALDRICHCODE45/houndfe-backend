# Require explicit approved production aliases

`assertProductionAliasCoverageV2(family, definitionsById)` is a dormant,
trusted-input assertion for fresh production candidates. It composes
`assertProductionChoiceCoverageV2`, then checks only the bound `animal.target`
definition of a canonical production family, resolving its actual definition ID.
No runtime consumer is activated.

## Contract and review path

| Rule    | Behavior                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S6, S17 | Every pair in shared `ALIASES` requires an explicit alias with an equivalent Unicode17 comparison key and the exact target option code. Option labels/codes cannot substitute. |
| S11     | Definition-local collision rejection remains the existing validator's precondition, not a second algorithm here.                                                               |
| S14     | Custom families retain generic semantics; unbound definitions are not inspected by this layer.                                                                                 |
| S15     | Valid extra aliases and archived targets are accepted; text, identities and ordering remain untouched.                                                                         |
| S16     | Custom policy contradiction/overlap checks are a separate admission unit, not implemented here.                                                                                |

Callers must supply a parsed family, validated definitions with unique IDs/codes,
checked references and stable inputs, indexed by actual IDs. Comparator errors
propagate unchanged. Comparison happens at use, not import, so the existing
Unicode17 runtime guard is never bypassed by precomputed keys.

Review the assertion first, then the public-validator fixtures: eight individual
omissions, validated wrong target, literal equivalents, explicit-entry boundaries,
extras/archives, preservation, actual-ID decoy, custom/unbound scope, composition
and runtime failure. `cuyo` can target the wrong option without a namespace
collision; retargeting `cobaya`, `ninfa` or `asno` instead collides with their
canonical option labels and fails the existing validator before this assertion.
The collision-pipeline test verifies rejection without rewriting submitted data.
All seven canonical families bind `animal.target`; removing that binding fails
composed production policy. The unbound-scope test therefore uses a genuinely
unbound different choice definition, not an invalid canonical-family fixture.

## Boundary

This is not global vocabulary admission, compatibility validation, legacy adoption,
assignment, publishing or transport activation. No stored data is rewritten and
no product compatibility is inferred. Full-suite, build and native assessment
remain separate delivery proofs.
