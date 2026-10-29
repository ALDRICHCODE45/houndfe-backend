# Fresh V2 save compatibility

`assertFreshSaveCompatibilityV2(sourceDraft, adoption): void` is a dormant,
non-mutating application gate for T3d S2, production vocabulary contract §5.
It directly composes the existing document-mode classifier and legacy recognizer.

## Caller preconditions

- The source document is decoded, finite, acyclic JSON; null is a present JSON
  document, not an absent Draft. Active-Draft existence belongs to outer CAS.
- Current authority, a receipt miss and locked active-Draft CAS are established.
- Adoption is the already-admitted token `legacy-to-v2` or null. This helper does
  not perform raw-header admission or re-check operation/header syntax.

## Ordered outcome

| Source Draft document                          | Adoption null                       | Adoption `legacy-to-v2` |
| ---------------------------------------------- | ----------------------------------- | ----------------------- |
| Recognizable legacy                            | `MALFORMED`                         | returns undefined       |
| Recognizable production V2                     | returns undefined                   | `MALFORMED`             |
| Unsupported                                    | `EDITORIAL_CLIENT_UPGRADE_REQUIRED` | same upgrade error      |
| Unrecognizable legacy (including `{}` or null) | upgrade error                       | upgrade error           |

Representability precedes conditional adoption requirements. Deliberate failures
are plain `Error` instances with exactly those messages, not `HttpException`.
Unexpected classifier/recognizer failures propagate unchanged by identity.
Historical strings, null units, negative zero and recognizable V2 relational
conflicts remain untouched; passing is not fresh candidate validity.

## Integration limits

No conversion, clone, candidate validation, metadata/current revision lookup,
Published lookup, permissions, receipts, HTTP or storage behavior is implemented.
The existing HTTP filter does not map the upgrade code: this gate does not
activate transport behavior or promise an HTTP status. Publish errors are specified
separately in the production contract §5; publish/V1 gates are excluded here.
