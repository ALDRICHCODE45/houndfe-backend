# Fresh V2 publish compatibility

`assertFreshPublishCompatibilityV2(sourceDraft, currentPublished): void` is a
pure, dormant compatibility gate for T3d S2/S32 and contract §5. The caller
establishes decoded finite acyclic JSON, current authority, receipt miss and
locked active-Draft CAS first. An absent Draft is an outer CAS concern, not an
input branch of this API.

Both present documents use the existing historical mode classifier:

| Draft         | Published absent, legacy or production-v2 | Published unsupported               |
| ------------- | ----------------------------------------- | ----------------------------------- |
| legacy        | `EDITORIAL_ADOPTION_REQUIRED`             | `EDITORIAL_CLIENT_UPGRADE_REQUIRED` |
| production-v2 | returns `undefined`                       | `EDITORIAL_CLIENT_UPGRADE_REQUIRED` |
| unsupported   | `EDITORIAL_CLIENT_UPGRADE_REQUIRED`       | `EDITORIAL_CLIENT_UPGRADE_REQUIRED` |

Unsupported in either slot takes precedence over legacy-Draft adoption. Every
legacy Draft requires adoption by save, including `{}` and JSON `null`; no
legacy adoptability recognizer is needed here. A present Published slot whose
document is JSON `null` is legacy, not an absent Published slot, and is allowed
with a production Draft.

Failures are plain `Error` instances with exactly the messages above. Unexpected
reflection, parser, TypeError and non-Error failures propagate unchanged; there
is no catch. Neither slot nor its document is mutated or converted.

Compatibility is not fresh publication approval. Recognizable historical V2
conflicts, reversed ranges, duplicate values and old evidence dates can pass
this gate but still require applicable fresh validation, D14 and care
confirmation. This helper reads no current metadata, revision, header or candidate
and grants no authority. It performs no storage, HTTP or lifecycle integration.
S32 approves HTTP 409 for both compatibility codes, but the existing HTTP filter
is unchanged and the upgrade code is currently unmapped: these unit tests prove
source errors, not registered HTTP status behavior or V2 activation.

## Key Learnings

- Current Published must be classified independently; a legacy Draft cannot mask
  an unsupported Published format.
- Legacy mode and legacy adoptability are different boundaries. Publish requires
  adoption of all legacy Drafts, unlike save's representability gate.
