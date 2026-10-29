# V1 editorial compatibility protection

`assertEditorialCompatibilityV1(state, candidateFamilyCode, vocabulary)` is a
pure, dormant gate. It throws plain `Error('EDITORIAL_CLIENT_UPGRADE_REQUIRED')`
when either present document slot is production V2/unsupported, or the selected
family has `minimumContractVersion: 2`. Otherwise it returns undefined.

## Preconditions and scope

The caller supplies decoded finite JSON and complete, coherent family metadata
with unique codes and valid versions from the authorized observation. Retained
V1 families already satisfy legacy metadata compatibility. Use the persisted
`VocabularyReadSnapshot` family collection, not a filtered V1 DTO or a guessed
boolean. No family names are hardcoded and no missing version is defaulted.

An unknown candidate family is left to reference validation; passing this gate
is not evidence that the family exists or the candidate is valid. Unrelated V2
families do not block a legacy selection. An absent slot differs from a present
JSON null document, which is legacy. Other unversioned history is not freshly
validated or converted. Inputs remain unchanged; unexpected failures propagate.

## Future integration

V1 document GET and all four fresh writes need this protection, including
initialize and discard. Save supplies the candidate family; other operations
supply null. Authority and a coherent state/metadata observation belong outside
this helper. Writes invoke it after receipt miss and locked CAS; matching
historical receipts bypass this fresh gate and retain their existing replay path.

No controller, HTTP error mapping, receipt handling, locks, storage or V2
activation is implemented here. The contract specifies HTTP 409, but these tests
prove the isolated source error, not registered endpoint behavior. Later legacy
integration requires its own preservation and transaction checks.
