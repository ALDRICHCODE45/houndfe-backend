# Exploration: WhatsApp AI Sales Chatbot

## Current State

HoundFe is a pet products retailer (CDMX, Mexico) that built a custom POS backend (this repo) to replace Pulpos (no API). The explicit end goal is an AI-powered WhatsApp chatbot that closes complete sales — replacing/augmenting human agents who today answer WhatsApp messages, quote products and shipping, and register sales manually. Humans have limited hours (no weekends) and non-trivial error rates.

### What exists today

**Sales module** (`src/sales/`) — mature aggregate root with full lifecycle:
- States: `DRAFT` → `CONFIRMED` (via `chargeDraft`)
- Channels: `POS` | `ONLINE` (enum exists)
- Delivery: `PENDING` | `DELIVERED` | `NOT_APPLICABLE`
- Payment methods: `CASH` | `CARD_CREDIT` | `CARD_DEBIT` | `TRANSFER` | `CREDIT`
- Payment status: `PAID` | `PARTIAL` | `CREDIT`
- Customer + shipping address assignment on drafts
- Multi-payment support with idempotency keys
- Post-charge payment collection (`addPayment`) for partial/credit sales
- Outbox events: `sale.confirmed`, `sale.payment.received`, `sale.fully.paid`
- Folio counter per period

**Customers module** (`src/customers/`) — tenant-scoped customer entity:
- Fields: firstName, lastName, phone, phoneCountryCode, email, comments
- Addresses: `CustomerAddress` with full Mexican address structure (street, ext/int number, zip, neighborhood, municipality, city, state)
- Billing data: RFC, fiscal regime, business name, billing address
- Price list assignment (globalPriceListId)

**Promotions module** (`src/promotions/`) — rich promotion engine:
- Types: `PRODUCT_DISCOUNT`, `ORDER_DISCOUNT`, `BUY_X_GET_Y`, `ADVANCED`
- Methods: `AUTOMATIC` | `MANUAL`
- Targeting: by categories, brands, products; customer scope (ALL, REGISTERED_ONLY, SPECIFIC)
- Scheduling: startDate/endDate, day-of-week restrictions
- Price list restrictions
- **Gap**: No public API or use case to "evaluate active promotions for a cart" — the POS applies discounts manually per item. The chatbot would need a "calculate best applicable promotions for these items" service.

**Public catalog** (`src/public-catalog/`) — hexagonal, no-JWT access:
- `PublicTenantGuard`: resolves tenant from `:tenantSlug` URL param, sets CLS
- Use cases: list products (paginated, filterable), product detail, branch list, cart validate
- Cart validate reuses `ValidatePublicCart` use case — validates items, checks stock, returns validated cart with warnings
- Throttled (separate scope from authenticated APIs)
- **No order creation** — the roadmap item `public-catalog-whatsapp-order` was deferred

**Orders module** (`src/orders/`) — simple order aggregate (DRAFT, PENDING, COMPLETED, CANCELLED). Appears to be an older/parallel concept. Sales module is the primary transaction aggregate for POS.

**Infrastructure patterns**:
- Multi-tenant: `nestjs-cls` → `TenantPrismaService` → `createTenantScopedPrisma` (Prisma `$extends` with row-level filtering)
- Outbox: `OutboxWriterService` → `OutboxPollerService` → `OutboxDispatcherService` → `EventEmitter2`
- Auth: JWT with `JwtAuthGuard` + `TenantContextGuard` + `PermissionsGuard` (CASL-based RBAC)
- Events: NestJS `EventEmitter2` (in-process)
- Files: S3-compatible (DigitalOcean Spaces) via `@aws-sdk/client-s3`
- No external message queue (no Redis, RabbitMQ, etc.)

---

## Affected Areas

- `src/sales/` — Bot must create sales (DRAFT→CONFIRMED) with channel=ONLINE, delivery=PENDING
- `src/customers/` — Bot must find-or-create customers by phone, manage addresses
- `src/promotions/` — Bot must evaluate active promotions for cart items (new use case needed)
- `src/public-catalog/` — Bot can reuse catalog search/detail/validate; may need richer search (NLP-friendly)
- `src/shared/outbox/` — Chatbot events (conversation started, order placed, handoff) should use outbox
- `src/shared/prisma/` — Tenant scoping for bot (it acts on behalf of a specific tenant)
- `src/auth/` — Bot needs a service account or API key auth mechanism (not user JWT)
- `prisma/schema.prisma` — New models: Conversation, ConversationMessage, ShippingQuote, PaymentConfirmation (at minimum)
- `src/files/` — Image uploads from WhatsApp for product recognition

---

## Question 1: Topology

### Approaches

| Approach | Description | Pros | Cons | Effort |
|----------|-------------|------|------|--------|
| **A. Monolith module** | New `src/chatbot/` bounded context inside this NestJS app | Single deployment, direct access to all domain services, no API contract overhead, simpler for solo dev | Couples conversational AI to POS; LLM latency/failures could affect POS; harder to scale independently; AI SDK ecosystem is Node-native but adds heavy deps | Medium |
| **B. Separate service** | Standalone NestJS/Node service consuming this backend via HTTP API | Failure isolation (bot crash ≠ POS crash); independent scaling; can deploy on different infra optimized for AI workloads; cleaner separation | Requires building + maintaining an internal API surface; network latency; two deployments to manage; duplicated auth/config; harder for solo dev | High |
| **C. Hybrid (recommended)** | Separate conversational service for WhatsApp + AI + conversation state; new internal API module in this backend for bot-specific operations | Best of both: POS stability preserved; bot has its own lifecycle; internal API is thin (reuses existing domain services); AI processing isolated; clear contract | Two services to deploy; need internal API auth (API key or service JWT); slightly more complexity than pure monolith | Medium-High |

### Recommendation: Approach C — Hybrid

**Rationale**: The POS is mission-critical for daily retail operations. An AI chatbot introduces unpredictable latency (LLM calls), external webhook dependencies (WhatsApp), and potential for high-volume message processing. Coupling these into the POS monolith risks cascading failures. However, building a fully separate service would require duplicating domain logic or creating a comprehensive API.

The hybrid approach:
1. **This backend** gets a new `src/chatbot-api/` module: thin internal API endpoints that wrap existing domain services (catalog search, customer upsert, sale creation, promotion evaluation, stock check). Auth via API key (simple, sufficient for service-to-service in a single-dev context).
2. **New service** (`houndfe-chatbot` or similar): handles WhatsApp webhook ingestion, conversation state machine, LLM agent orchestration, message formatting, and calls the backend API for all domain operations.

For a solo developer, the "separate service" is a separate Node/NestJS app in a sibling directory or repo. It can start as a simple Express/Fastify app (lighter than NestJS) using the Vercel AI SDK for agent orchestration.

**Key point**: The chatbot service is stateless for business data — all state of truth remains in this backend's PostgreSQL. The chatbot only manages conversation state (which can be Redis or even PostgreSQL in a separate schema).

---

## Question 2: WhatsApp Channel

### WhatsApp Business Platform Landscape

**Meta Cloud API (direct):**
- Free tier: 1,000 free service conversations/month
- Pricing: Per-conversation (24h windows). As of 2025, marketing/utility/authentication conversations have different rates. Service conversations (customer-initiated) are cheapest (~$0.005-0.01 MXN equivalent per conversation in Mexico)
- Webhook model: Meta sends webhook events (messages, status updates, etc.) to your HTTPS endpoint
- 24-hour customer service window: After customer sends a message, you have 24h to respond freely. After 24h, you can only send pre-approved message templates
- Message templates: Must be pre-approved by Meta. Used for proactive outreach (order confirmations, shipping updates, follow-ups)
- Sandbox: Meta provides a test phone number; you can test with up to 5 numbers during development
- Number registration: Need a dedicated phone number (can port existing), verified via Facebook Business Manager
- Media support: Images, documents, location — customer can send photos (critical for image recognition feature)
- Rate limits: Tiered by quality rating (250 → 1K → 10K → 100K messages/day)

**On-premise API:**
- Self-hosted Docker containers
- Being deprecated by Meta in favor of Cloud API
- **Not recommended** — more operational burden, less features

**BSPs (Business Solution Providers):**
- **Twilio**: Most mature, excellent docs, higher cost (~2-5x markup over direct), abstracts WhatsApp complexity, good for getting started fast
- **360dialog**: Lower markup than Twilio, closer to raw API, popular in LATAM
- **Gupshup**: Aggressive pricing in emerging markets
- **MessageBird**: Good API, now part of Bird

**Recommendation**: Start with **Meta Cloud API direct**. Reasons:
- No BSP markup (significant cost savings for a small business)
- Full control over webhook handling
- The developer needs to learn WhatsApp internals anyway (template approval, 24h window, etc.)
- BSPs add value at scale (compliance, analytics, multi-channel) but are overhead for a single-number, single-tenant use case
- If complexity proves too high, migrating to Twilio later is straightforward (similar webhook shape)

**Key constraints to design for:**
- 24-hour window: Bot must track when the customer last messaged; proactive messages (order updates) require approved templates
- Template approval: Need to plan templates early (order confirmation, shipping update, payment reminder, follow-up)
- Webhook verification: Meta sends a challenge; your endpoint must verify signature (SHA256 HMAC)
- Media handling: Customer photos arrive as media IDs; bot must download via Meta API, then process
- Message ordering: Webhooks may arrive out of order; need sequence handling or idempotent processing

---

## Question 3: Agent Architecture

### Approaches

| Approach | Description | Pros | Cons | Effort |
|----------|-------------|------|------|--------|
| **A. Pure LLM agent (tool-calling)** | Single LLM agent with tools: search_catalog, add_to_cart, create_order, quote_shipping, etc. | Maximum flexibility; handles edge cases naturally; easy to add new capabilities as tools | Unpredictable for transaction-critical steps; prompt injection risk; harder to guarantee business rules; expensive (every message = LLM call) | Medium |
| **B. State machine** | Deterministic flow: GREETING → PRODUCT_SEARCH → CART → SHIPPING → PAYMENT → CONFIRMATION | Predictable, testable, safe; no LLM cost for deterministic steps; clear audit trail | Brittle — customers don't follow linear flows; poor handling of "oh wait, I also want X"; requires coding every branch | High |
| **C. Hybrid (recommended)** | State machine for transaction-critical transitions (cart commit, order creation, payment confirmation); LLM agent for free conversation within states (product Q&A, recommendations, handling ambiguity) | Safe transactions + flexible conversation; LLM cost contained (only used for understanding intent and generating responses, not for executing transactions); state machine guarantees business rule compliance | More complex architecture; need clear boundary between "LLM decides" and "machine decides" | Medium-High |

### Recommendation: Approach C — Hybrid state machine + LLM

**Conversation state model:**
```
IDLE → BROWSING → CART_BUILDING → CHECKOUT → SHIPPING → PAYMENT_PENDING → COMPLETED
  ↕        ↕           ↕             ↕          ↕            ↕
HUMAN_HANDOFF (reachable from any state)
```

**LLM role**: Intent classification, product search query extraction, natural language responses, image description, handling ambiguous requests, suggesting alternatives.

**State machine role**: Cart operations (add/remove/modify), order creation, payment status tracking, shipping quote requests, human escalation triggers.

**Conversation persistence**: Each conversation needs:
- `conversationId` (maps to WhatsApp phone number + tenant)
- `state` (current state machine state)
- `cartItems[]` (in-progress cart before order creation)
- `customerInfo` (collected progressively: name, phone, address)
- `messageHistory[]` (for LLM context window — last N messages)
- `metadata` (assigned human agent if in handoff, etc.)

**AI SDK fit**: Vercel AI SDK with tool-calling is ideal for the LLM layer. The agent defines tools like `search_catalog`, `check_stock`, `get_shipping_quote`; the state machine controls WHEN the agent is invoked and validates the agent's tool call results before executing them.

---

## Question 4: Backend Gaps

### What the chatbot-api module needs to expose

| Capability | Exists? | Gap |
|-----------|---------|-----|
| Catalog search (text) | Yes — `public-catalog` list with `q` filter | Sufficient for v1. May need fuzzy/NLP-friendly search later |
| Product detail | Yes — `public-catalog` detail | OK |
| Stock availability | Yes — `checkStockAvailability` in ProductsService | Needs internal API exposure |
| Cart validation | Yes — `ValidatePublicCart` use case | OK, reusable |
| Customer find-by-phone | **No** — customers are searched by name in POS, no phone lookup | Need `findOrCreateByPhone` use case |
| Customer address create | Partial — `CustomerAddress` exists but CRUD is basic | Need create-from-conversation flow |
| Create sale as DRAFT | Yes — `SalesService.openDraft` | Needs bot service account (not tied to JWT user) |
| Add items to sale | Yes — `SalesService.addItem` | OK, but needs service account context |
| Assign customer to sale | Yes — `SalesService.assignCustomer` | OK |
| Set shipping address | Yes — `SalesService.setShippingAddress` | OK |
| Charge/confirm sale | Yes — `SalesService.chargeDraft` | OK but payment method will be TRANSFER with deferred payment |
| **Evaluate promotions for cart** | **No** | Need `EvaluateCartPromotions` use case that checks active promotions against cart items |
| **Shipping quote** | **No** | Entire domain missing — need shipping aggregator integration |
| **Payment confirmation** | **Partial** — `addPayment` exists for post-charge collection | Mechanism for bot/customer to confirm bank transfer is an open design question |
| **Conversation records** | **No** | Need `Conversation` + `ConversationMessage` entities for audit/handoff |
| **Human handoff** | **No** | Need handoff queue, notification to human agent, conversation transfer |
| **Bot service auth** | **No** | Need API key or service-to-service JWT for bot→backend calls |
| **Tenant config for bot** | **No** | Need `Tenant.whatsappPhoneNumber`, `Tenant.whatsappBusinessAccountId`, greeting config, etc. |

### Missing domain concepts (new Prisma models needed):
1. `Conversation` — { id, tenantId, customerPhone, customerId?, state, assignedAgentUserId?, startedAt, lastMessageAt, closedAt }
2. `ConversationMessage` — { id, conversationId, direction(INBOUND|OUTBOUND), content, mediaUrl?, whatsappMessageId, timestamp }
3. `ShippingQuote` — { id, tenantId, saleId?, provider, originZip, destZip, weightGrams, quotedPriceCents, carrier, estimatedDays, quotedAt, expiresAt }
4. `PaymentConfirmation` — { id, tenantId, saleId, method, reference, evidenceFileId?, confirmedByUserId?, confirmedAt, status(PENDING|CONFIRMED|REJECTED) }
5. Extend `Tenant` with chatbot config fields

---

## Question 5: Shipping Quote Integration

### Mexican Shipping Aggregator Landscape

**Envios Perros** — Mentioned by the business. Not a well-known API provider; likely a local/regional broker or comparison site. **Verify during design** — may not have a programmatic API.

**Candidates with REST APIs:**

| Provider | API | Coverage | Pricing model | Notes |
|----------|-----|----------|---------------|-------|
| **Skydropx** | REST API, well-documented | 20+ carriers (Estafeta, FedEx, DHL, Redpack, etc.) | Per-shipment fee + carrier rate | Popular in Mexican e-commerce; good sandbox; strong CDMX coverage |
| **Envia.com** | REST API | 30+ carriers | Similar | Also popular, broader carrier network |
| **Mienvio** | REST API | Major carriers | Per-shipment | Acquired by larger company; still operational |
| **99minutos** | API | Same-day CDMX | Per-delivery | Good for CDMX metro same-day delivery — could be the "free shipping within CDMX" carrier |

**Integration pattern:**
1. Abstract behind a `ShippingQuotePort` interface (hexagonal)
2. Implement adapter for chosen provider(s)
3. Bot flow: collect destination address → call quote endpoint → present options to customer → lock quote for N minutes
4. Business rules engine: apply "free shipping in CDMX metro" rule, apply active shipping promotions

**Recommendation**: Start with **Skydropx** (best docs, sandbox available, strong Mexican market presence). Design the port interface to be provider-agnostic.

---

## Question 6: Image Recognition

### Feasible Approaches

| Approach | Description | Pros | Cons | Effort |
|----------|-------------|------|------|--------|
| **A. Multimodal LLM** | Send customer photo + catalog context to GPT-4o/Claude with tool `search_catalog_by_description` | Excellent at understanding "I saw this on TikTok" photos; can describe product and search by description; no custom ML pipeline | LLM cost per image; may not be precise for similar products; depends on catalog having good descriptions | Low |
| **B. Image embeddings** | Pre-compute CLIP embeddings for all product images; embed customer photo; nearest-neighbor search | Very accurate for visual similarity; fast after setup; cost is one-time embedding | Requires all products to have images; embedding pipeline setup; may miss context ("I want this but for large dogs") | Medium |
| **C. Hybrid (recommended)** | Use multimodal LLM to describe the image and extract key attributes (brand, product type, size, animal), then search catalog using extracted text | Best accuracy: visual understanding + catalog search; handles "I saw this but want the bigger one"; LLM contextualizes the image | Two-step process (slight latency); LLM cost | Low-Medium |

### Recommendation: Approach C — Multimodal LLM → catalog search

The catalog has product images (`ProductImage` model with S3 URLs), but coverage may be incomplete. Using a multimodal LLM (GPT-4o or Claude) to describe the customer's photo and extract searchable attributes, then running a catalog search with those attributes, is the most robust approach for v1.

**How it works:**
1. Customer sends photo via WhatsApp
2. Bot downloads media via WhatsApp Cloud API
3. Send to multimodal LLM: "Describe this pet product. Extract: brand name, product type, target animal, size/weight if visible"
4. Use extracted text to search catalog (`q` parameter)
5. Present top matches to customer for confirmation

**Future enhancement (v2)**: Add CLIP embeddings for visual similarity as a fallback when text search returns no results.

---

## Question 7: Payment Confirmation

### Open Design Question — Mechanism Options

| Mechanism | Description | Pros | Cons | Risk |
|-----------|-------------|------|------|------|
| **A. Human-in-the-loop confirm** | Customer says "ya pague" → bot notifies human agent → human checks bank app → human clicks "confirm" in POS admin | Simplest; zero false positives; works today (humans already do this) | Depends on human availability; delays closing the sale; defeats purpose of automation | Low |
| **B. Receipt image upload + OCR** | Customer sends transfer receipt screenshot → OCR extracts amount/reference → auto-match with pending sale | Semi-automated; customer already has receipt | OCR accuracy varies (especially phone screenshots of bank apps); needs human fallback for OCR failures; fraud risk (doctored images) | Medium |
| **C. Bank API/webhook reconciliation** | Integrate with bank's open banking API or use a payment reconciliation service; match incoming transfers by reference | Fully automated; most reliable; no fraud risk | Mexican banks have limited open banking APIs; setup complexity; may not be feasible for all banks; HoundFe likely uses a single bank account | High |
| **D. Reference-based matching** | Bot generates unique reference per sale (e.g. "HF-240610-001"); customer includes reference in transfer concept; nightly reconciliation script matches | Semi-automated; reasonably reliable; standard practice in Mexican commerce | Customers may forget/mistype reference; needs manual reconciliation fallback; not real-time | Medium |
| **E. Hybrid: Reference + human fallback (recommended for v1)** | Generate unique reference per sale; customer transfers with reference; bot periodically asks "ya transferiste?"; human confirms via admin panel; future: add bank reconciliation | Pragmatic; starts with existing human workflow; reference prepares for future automation | Still depends on human for confirmation in v1 | Low |

### Recommendation: Option E — Reference + human fallback

**Rationale**: Payment confirmation is the highest-risk step (financial). Starting with a human-in-the-loop confirmation is the safest approach. The bot's job is to:
1. Generate a unique payment reference for each sale
2. Provide bank details + reference to the customer
3. Track the sale as `PAYMENT_PENDING` (which maps to existing `paymentStatus: CREDIT` or `PARTIAL`)
4. Notify the human agent that a payment is expected
5. Human confirms payment in admin panel → triggers `addPayment` → sale becomes `PAID`

**Future automation path**: Add OCR for receipt screenshots as a confidence layer (auto-confirm if OCR matches amount + reference; otherwise escalate to human). Bank API integration is a v3+ feature dependent on HoundFe's bank providing API access.

---

## Question 8: Safety and Guardrails

### Prompt Injection Resistance
- **System prompt isolation**: LLM system prompt must be hardcoded, not user-modifiable
- **Input sanitization**: Strip any prompt-injection patterns from customer messages before feeding to LLM
- **Tool-call validation**: State machine validates every LLM tool call before execution; the LLM CANNOT directly execute actions
- **Restricted tool set**: LLM only has access to read operations and cart manipulation; financial operations (charge, payment) are state-machine-controlled

### Data Leak Prevention
- **Tenant-scoped projections**: Bot→backend API must use the same tenant-scoped Prisma client; NEVER expose raw queries
- **Public-safe fields only**: API responses for the bot must NEVER include: `purchaseCostCents`, `purchaseGrossCostCents`, `marginPercent`, `supplierId`, `tenantId`, `createdBy`, `updatedBy`, or any internal financial data
- **System prompt must explicitly forbid**: discussing costs/margins, revealing supplier info, discussing other tenants, sharing internal business metrics
- **Response filtering**: Post-process LLM responses to scan for accidentally leaked patterns (cost figures, internal IDs)

### Human Escalation Triggers
- Customer explicitly asks for a human ("quiero hablar con alguien")
- Bot confidence is low (LLM returns uncertain intent classification)
- Customer expresses frustration (sentiment detection)
- Transaction-critical step fails (payment issues, stock problems)
- Conversation exceeds N turns without progress
- Customer asks about something outside bot's scope (returns, complaints, warranty)

### Audit Logging
- Every conversation message stored with direction, timestamp, WhatsApp message ID
- Every tool call logged (what the LLM requested, what the state machine executed)
- Every state transition logged
- Payment-related actions require dual logging (outbox event + conversation log)
- Human handoff events logged with agent assignment

---

## Question 9: Phased Roadmap (SDD Slices)

### Recommended slicing — each independently shippable

| # | Slice name | Scope | Depends on | Est. LOC | Notes |
|---|-----------|-------|------------|----------|-------|
| 1 | `chatbot-api-foundation` | Internal API module in this backend: API key auth, catalog search, stock check, customer find-by-phone endpoints | None | 400-600 | Foundation for all bot operations |
| 2 | `whatsapp-webhook-echo` | Separate service: webhook verification, message reception, echo response; WhatsApp Cloud API integration | Slice 1 (for deployment pattern) | 300-500 | Proves WhatsApp connectivity |
| 3 | `conversation-state-persistence` | Conversation + message models in backend; state machine skeleton in bot service | Slices 1, 2 | 400-600 | State persistence + basic flow |
| 4 | `catalog-qa-agent` | LLM agent with catalog search tool; customer asks about products, bot answers from DB | Slices 1-3 | 400-600 | First real AI value |
| 5 | `cart-and-order-flow` | Bot builds cart, collects customer info, creates sale draft, assigns customer + address | Slices 1-4 | 500-700 | Core sales flow |
| 6 | `promotion-evaluation` | New use case: evaluate active promotions for cart items; bot applies best promotions | Slice 5 | 300-500 | Accurate pricing |
| 7 | `shipping-quotes` | Shipping aggregator integration (Skydropx adapter); bot quotes shipping; free-CDMX rule | Slice 5 | 400-600 | Delivery logistics |
| 8 | `payment-confirmation` | Payment reference generation; human confirmation flow; admin notification | Slice 5 | 300-500 | Closes the sale |
| 9 | `image-recognition` | Multimodal LLM product identification from customer photos | Slice 4 | 200-400 | Photo → product matching |
| 10 | `human-handoff` | Handoff queue, agent notification, conversation transfer, agent takes over in admin | Slices 1-3 | 400-600 | Safety net |
| 11 | `message-templates-and-followup` | WhatsApp template messages for order confirmations, payment reminders, shipping updates | Slices 5, 7, 8 | 200-400 | Proactive communication |

**Critical path**: 1 → 2 → 3 → 4 → 5 → 8 (minimum viable chatbot that can close a sale)

**Parallel tracks after slice 3**: slices 4, 6, 7, 9, 10 can progress semi-independently.

### Relationship to existing roadmap item `public-catalog-whatsapp-order`

The chatbot **supersedes** the `public-catalog-whatsapp-order` SDD. That SDD proposed a simple `wa.me` deep-link endpoint — a URL that opens WhatsApp with a pre-formatted message. The AI chatbot is a fundamentally different (and superior) approach: instead of the customer composing a message from a web catalog, the bot handles the entire conversation natively in WhatsApp. The deep-link endpoint becomes unnecessary because:
1. Customers initiate conversations directly in WhatsApp (no web catalog needed as entry point)
2. The bot handles product discovery, cart building, and checkout conversationally
3. The web catalog can still link to WhatsApp ("Chatea con nosotros para comprar") but doesn't need a structured order payload

**Recommendation**: Archive `public-catalog-whatsapp-order` as "superseded by whatsapp-ai-chatbot" and redirect its scope here.

---

## Approaches (Topology — primary decision)

1. **Monolith module** — New bounded context inside this NestJS app
   - Pros: Single deployment, direct domain access, simpler infrastructure
   - Cons: Couples AI workload to POS, failure propagation risk, scaling constraints
   - Effort: Medium

2. **Separate service** — Standalone Node service consuming HTTP API
   - Pros: Full isolation, independent scaling, clean separation
   - Cons: API maintenance overhead, two deployments, duplicated concerns
   - Effort: High

3. **Hybrid** — Thin internal API in this backend + separate conversational service
   - Pros: POS stability preserved, bot has own lifecycle, reuses domain services, AI isolated
   - Cons: Two services, internal API auth needed, slightly more complex than monolith
   - Effort: Medium-High

## Recommendation

**Hybrid topology (Approach 3)** with the phased roadmap above. Start with slice 1 (internal API foundation in this backend) and slice 2 (WhatsApp echo bot in separate service) to prove the architecture. The chatbot supersedes the simpler `public-catalog-whatsapp-order` roadmap item.

**Recommended first slice**: `chatbot-api-foundation` — it's entirely within this backend, follows existing hexagonal patterns, and unblocks all subsequent chatbot work.

## Risks

1. **WhatsApp Business API approval delay** — Meta can take days/weeks to approve a business account and message templates. Start the application process ASAP, use sandbox numbers for development.
2. **LLM cost at scale** — Every customer conversation involves multiple LLM calls. Need to estimate cost per conversation and compare with human agent cost. Mitigation: cache common Q&A, use cheaper models for intent classification, reserve expensive models for complex queries.
3. **Prompt injection / data leaks** — A customer could attempt to manipulate the bot into revealing internal data. Mitigation: strict tool-call validation, tenant-scoped projections, response filtering.
4. **Payment fraud** — Bank transfer confirmation is inherently trust-based without bank API integration. Mitigation: human-in-the-loop for v1, add OCR confidence layer later.
5. **Shipping quote accuracy** — Aggregator quotes expire; prices change. Mitigation: lock quotes with TTL, re-quote at checkout.
6. **Solo developer bandwidth** — This is a multi-month, multi-SDD effort. Risk of scope creep. Mitigation: strict slicing, ship each slice to production independently.
7. **24-hour WhatsApp window** — If the bot takes too long to respond or the customer returns after 24h, the bot can only send template messages. Mitigation: design templates early, implement window tracking.

## Ready for Proposal

**Yes** — with these open questions that the proposal phase MUST resolve with the user:

1. **Deployment target**: Where will the chatbot service run? (Same VPS as the backend? Separate server? Serverless?) This affects architecture decisions.
2. **WhatsApp account status**: Has HoundFe already registered a WhatsApp Business account, or does this need to be done? What phone number will be used?
3. **Budget for LLM API calls**: Is there a monthly budget ceiling for OpenAI/Anthropic API costs? This affects model selection and caching strategy.
4. **Payment confirmation preference**: The owner needs to choose the v1 approach — pure human confirm vs. reference-based with human fallback. Both are safe; the choice depends on their operational preference.
5. **Shipping provider preference**: Is "Envios Perros" a service they want to keep using, or are they open to switching to Skydropx/Envia.com for API access?
6. **First priority**: Should we start with the internal API foundation (recommended) or does the owner want to see a WhatsApp echo bot first as proof of concept?
7. **Existing WhatsApp conversation data**: Do they have examples of real customer conversations (anonymized) that could inform the bot's conversation design?
8. **Multi-tenant or HoundFe-only?**: Is the chatbot exclusively for HoundFe's tenant, or should it be designed as a multi-tenant feature from day one?
