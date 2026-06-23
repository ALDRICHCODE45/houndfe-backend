# Delta for sale-payments

## ADDED Requirements

### Requirement: Cancellation Refund Audit Preserves Payment History

The system MUST record sale refunds in dedicated refund rows whose total matches the original recorded payment total for the canceled sale. The original sale payment records and the sale's financial totals MUST remain available for audit on the canceled sale.

#### Scenario: Refund rows match the original payments
- GIVEN a CONFIRMED sale with one or more recorded payments is canceled
- WHEN the refund audit is stored
- THEN the sum of refund amounts equals the sum of the original payment amounts
- AND the original payment rows remain unchanged

#### Scenario: Canceled sale keeps financial audit values
- GIVEN a sale is canceled
- WHEN the sale is read later for audit
- THEN its original financial totals are still available
