# Dormant alias comparison: collision-key-ucd17-v1

`editorialAliasComparisonKeyV1(unknown)` derives a comparison key without changing
original labels or identities. It is an isolated T3c prerequisite for S6/S11/S12;
S13 authorizes the generated-data review size. It activates no V2 transport,
choice parser, vocabulary, HTTP endpoint, database write or startup behavior.

## Exact algorithm

1. At **every use**, require actual `process.versions.unicode === '17.0'`.
   Otherwise throw before validation or normalization. Importing does not check it.
2. Require a primitive string and reuse `canonicalEditorialJson` to reject lone
   surrogates. Empty strings and empty derived keys are allowed here.
3. Apply native NFD, pinned Unicode 17.0.0 full default case folding (C/F only,
   ignoring S/T), then native NFD again.
4. Remove only characters in native Unicode17 **General_Category Mark ∩
   Diacritic**. Neither property alone is sufficient.
5. Collapse literal Unicode White_Space's 25 code points to ASCII space, then
   remove leading/trailing ASCII spaces only. No JavaScript `trim` or `\s`.

This uses neither NFKD nor a lowercase substitute. Full folding itself expands
some compatibility characters (`ﬃ` → `ffi`); it does not otherwise perform
compatibility decomposition (`①`, `²` remain intact). FEFF and zero-width space
remain significant. Original strings must be retained by callers.

| Input                   | Derived key  |
| ----------------------- | ------------ |
| `café`, `CAFE` + U+0301 | `cafe`       |
| `pez  ángel`            | `pez angel`  |
| `Straße`, `STRASSE`     | `strasse`    |
| U+0301 alone            | empty string |

## Future namespace rules (not implemented here)

A future choice-definition validator must index **key → set<optionCode>** within
each definition using option-code, option-label and alias keys, not require
globally unique normalized option labels:

- Homonymous option labels (for example distinct `Adulto` options) remain valid.
- Reject an alias whose key names **any different target**, including a collision
  with an option code, option label or another alias (S11).
- Reject exact original alias-label duplicates, even for the same target.
- Allow distinct equivalent alias spellings pointing only to the same target.
- Keep groups separate; selecting a group neither selects members nor proves
  product compatibility. Regional aliases identify one option, not extra filters
  or counts. Ambiguous terms still require identification (S6).

This helper does not enforce nonblank source labels, target existence, duplicate
rules, namespace construction, group membership or adoption. Those remain future
parser responsibilities; deriving a key is not permission to merge identities.

## Provenance and regeneration

- Source: <https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt>
- SHA-256: `ff8d8fefbf123574205085d6714c36149eb946d717a0c585c27f0f4ef58c4183`
- Table: `src/catalog-editorial/domain/editorial-unicode17-case-fold.generated.ts`
- Exactly **1,585** unique C/F mappings, sorted by source scalar, one per line.
- License: exact bytes from <https://www.unicode.org/license.txt> in
  `docs/licenses/unicode-3.0.txt`; its header must be `UNICODE LICENSE V3`.

Run `node scripts/generate-editorial-unicode17-case-fold.mjs` to regenerate, or
append `--check` for read-only byte parity. Both commands require network access;
the source checksum is verified **before generation or either artifact write**.
The license endpoint is unversioned: `--check` deliberately detects any upstream
license-byte change instead of silently updating it. Generation has no timestamp,
locale dependence, dependency addition or runtime configuration effect.

Unit tests run offline and cover literal vectors, every White_Space code point,
scalar rejection, property intersection, all generated fold equivalences, source
count/provenance, checksum rejection, and the actual unsupported-runtime branch
with descriptor restoration. They do not claim full UCD normalization conformance
or implement the future namespace contract. Native normalization/properties are
supported only on Unicode 17.0; deployment/runtime changes remain out of scope.
