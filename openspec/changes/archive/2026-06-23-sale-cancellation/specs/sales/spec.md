# Delta for sales

## ADDED Requirements

### Requirement: Canceled Sales Remain Queryable But Are Excluded From CONFIRMED Reporting

The system MUST exclude CANCELED sales from KPI, revenue, and other CONFIRMED-scoped listing queries. The system MUST still return CANCELED sales when a caller explicitly filters by CANCELED status.

#### Scenario: Confirmed reporting excludes canceled sales
- GIVEN sales include both CONFIRMED and CANCELED records
- WHEN KPI or revenue queries run
- THEN CANCELED sales are excluded

#### Scenario: Listing by CANCELED returns canceled sales
- GIVEN canceled sales exist for the tenant
- WHEN a list request filters by CANCELED status
- THEN the response includes the canceled sales
- AND it does not drop CANCELED from the filter
