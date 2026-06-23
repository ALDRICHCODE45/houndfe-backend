# Delta for chatbot-api-foundation

## ADDED Requirements

### Requirement: Chatbot Sale Cancellation Endpoint

The system MUST expose `POST /chatbot-api/sales/:saleId/cancel` for the chatbot service, and the request MUST require the `sales:write` scope.

#### Scenario: Scoped chatbot client cancels a sale
- GIVEN the caller has `sales:write`
- WHEN the caller posts a valid cancellation request
- THEN the sale cancellation is accepted if the sale is otherwise eligible

#### Scenario: Missing scope is rejected
- GIVEN the caller lacks `sales:write`
- WHEN the caller posts to the cancel endpoint
- THEN the request is rejected
