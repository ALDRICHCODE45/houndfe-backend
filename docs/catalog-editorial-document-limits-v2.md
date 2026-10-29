# Fresh V2 ordinary document limits

`assertFreshDocumentLimitsV2(candidate, operation)` accepts a wire-parsed
`DocumentShapeV2` and an admitted `save` or `publish` operation. It is dormant,
non-mutating and throws plain `Error('MALFORMED')` on a violated limit.

Both operations enforce nullable title up to 200 Unicode code points, nullable
description up to 20,000 code points, at most 20 media references, 200 values and
200 fact rows. The values and facts caps are independent. Astral characters count
as one code point. Ordinary title/description strings gain no new control-character
or lone-surrogate prohibition; facts and evidence have their own stricter rules.

Publish additionally requires a non-null title that is nonblank under ECMAScript
`trim`, and an empty media list until the media publication slice exists. Save
permits null or blank titles. Neither operation trims or normalizes stored text.

These rules come from editor contract §2.2, publish contract §2.1 and production
facts contract §1. They do not run on historical GET, receipt replay or the raw
Published document copied during initialization. The framework's 100kB serialized
JSON ceiling remains external; text payloads have no independent cap here.

Passing proves only these ordinary limits/minimums. Reference membership,
uniqueness, numeric domains, evidence, fact internals, NA applicability, archive
conservation, D14 and care confirmation remain separate obligations. This module
does not establish authority, lock stability, storage mutation or HTTP activation.
