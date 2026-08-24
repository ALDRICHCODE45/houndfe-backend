# Proposal: Chatbot Sale-Flow Blockers (Q1–Q3)

## Intent

El bot de WhatsApp consume la `chatbot-api` del backend. El equipo del bot (Fabian) auditó
los 10 endpoints y detectó **3 gaps que bloquean el flujo de venta completo** (documento
`houndfe-chatbot/docs/backend-questions-sale-flow.md`, 2026-08-24). Este change cierra los
3 bloqueantes, **sin** entrar a los refinamientos no bloqueantes (Q4–Q8) ni a los slices
futuros (Skydropx, tarjeta Link EVO).

| # | Bloqueante | Síntoma hoy | Fix |
|---|------------|------------|-----|
| **Q1** | Datos bancarios para transferencia (R11) | No existe fuente: ni tabla, ni config, ni endpoint, ni RBAC para datos bancarios. El bot no puede decirle al cliente "transfiere a esta cuenta". | CRUD admin nuevo con permisos RBAC granulares + lectura read-only desde la chatbot-api. |
| **Q2** | Venta con precio de promoción (R13) | `confirmBotSale` rechaza cualquier `unitPriceCents` que no sea precio de lista (`PRICE_OUT_OF_DATE`) y hardcodea `discountCents: 0`. Imposible registrar una venta con promo por API. | Re-evaluación server-side con el motor de promos real; `discountCents` persistido = list − final. |
| **Q3** | Race condition en idempotencia de venta | `registerBotSale` reserva el slot de `SaleIdempotency` fuera de transacción, no corta en `IN_FLIGHT`, no compara `requestHash`, y el `update: {}` del `upsert` se traga silenciosamente la pérdida del unique constraint → dos requests concurrentes con la misma key crean ventas duplicadas. | Portar el patrón atómico del POS (`acquireChargeIdempotency`). |

Además: **drift de docs** que se cierra en este mismo change (ver § *Implications & Impact*).

## Scope

### In Scope
- **Q1 — Bank Details admin CRUD**: nuevo modelo Prisma `PaymentDetail`, migración, módulo admin (`src/admin/payment-details/`), DTOs, registro en `PERMISSION_REGISTRY` (auto-seeded), controlador admin (`/admin/payment-details`), endpoint read-only en `chatbot-api` para que el bot obtenga la cuenta activa.
- **Q2 — Promo on bot sale**: `confirmBotSale` re-evalúa con `recomputePricingAndPromotions` (POS engine real), recalcula `totalCents = Σ(unitPriceCents · qty) − discountCents`, compara contra el total cotizado por el bot y rechaza con re-quote si difiere; `BotSaleResponse` + `ConfirmBotSaleResult` exponen `discountCents`; `RegisterBotSaleRequestDto` gana el campo opcional `expectedTotalCents` para el chequeo.
- **Q3 — Idempotency race fix**: nuevo método `acquireSaleRegistrationIdempotency` en `PrismaSaleRepository` (clon de `acquireChargeIdempotency`, `operation = 'bot_sale_register'`); `registerBotSale` lo usa en lugar del `upsert` actual; `requestHash` = SHA-256 sobre payload canónico.
- **Docs drift**: `PROGRAM-CONTEXT.md` se actualiza al endpoint real (10 endpoints, no 9; documentar `POST /chatbot-api/sales/:saleId/cancel` + el nuevo `GET /chatbot-api/payment-details`).
- **Anexo de respuesta al bot**: el documento `houndfe-chatbot/docs/backend-questions-sale-flow.md` recibe respuesta formal (ver § *Annex Deliverable*).

### Out of Scope (este ciclo — non-goals explícitos)
- **Shipping / Skydropx** — slice futuro del bot.
- **Tarjeta Link EVO** — slice futuro.
- **Q5 (cobertura de `evaluate-cart`)** — solo se registra el criterio `needs_human_review` si el diseño de Q2 lo toca; no es bloqueante de este ciclo.
- **Q6 / Q7 (DTO relaxations)** — esas preguntas van al **anexo de respuesta al bot** (aclaraciones), pero no a este SDD ni a este change.
- Conversión de cotización → venta.
- Multi-moneda, multi-bot credential isolation (W-003), hard delete de `PaymentDetail`.
- Cambios al flow de receipt-review o a `SalesService.cancelSale`.

## Capabilities

### New Capabilities
- `admin-payment-details` (bounded concept nuevo): Prisma model `PaymentDetail`, módulo admin `src/admin/payment-details/`, DTOs, controller, service, RBAC subject `'PaymentDetail'` registrado en `PERMISSION_REGISTRY`.
- `chatbot-payment-details` (read-only): nuevo endpoint `GET /chatbot-api/payment-details` (scope `payment-details:read`).

### Modified Capabilities
- `sales`: `confirmBotSale` re-evalúa promociones con el motor real antes de confirmar; `discountCents` se calcula y persiste como `list − final`.
- `chatbot-api`: `registerBotSale` usa el patrón atómico de idempotencia (P2002 → `replay` / `conflict` / `in_flight`); `BotSaleResponse` expone `discountCents`; nuevo endpoint read-only `GET /chatbot-api/payment-details`.
- `sales-repository`: nuevo método `acquireSaleRegistrationIdempotency` (mismo shape que `acquireChargeIdempotency`, `operation = 'bot_sale_register'`).

## Approach

### Q1 — Bank Details (PaymentDetail) admin CRUD + bot read

**Modelo nuevo (Prisma):**
```prisma
model PaymentDetail {
  id            String   @id @default(uuid())
  tenantId      String
  bankName      String
  beneficiary   String
  clabe         String
  accountNumber String
  isActive      Boolean  @default(true)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, clabe])
  @@index([tenantId])
  @@map("payment_detail")
}
```

**Reglas de negocio baked-in (decisión del owner):**
- **RBAC granular**, no por rol: `read:PaymentDetail`, `create:PaymentDetail`, `update:PaymentDetail`, `delete:PaymentDetail`. Cualquier rol al que se le concedan esos permisos puede operar — sin restricción por rol especial.
- **Multi-tenant via CLS + TenantPrismaService**, igual que todo lo demás.
- **Multi-cuenta por tenant permitido** (un tenant puede tener N cuentas de banco distintas); `isActive` distingue la activa de las históricas.
- **Delete es lógico** (`isActive = false`), nunca hard delete. Historial auditable.
- **Bot solo ve la cuenta activa** (`isActive = true`); si hay varias, se devuelve la más reciente (`updatedAt DESC`); si no hay activa → 404 con `NO_ACTIVE_PAYMENT_DETAIL`.
- **Validación**: CLABE debe tener exactamente 18 dígitos (BBVA / Banxico); `accountNumber` ≥ 10 dígitos; `bankName` y `beneficiary` no vacíos. Sanitización de strings antes de persistir.
- **`@@unique([tenantId, clabe])`** impide duplicar la misma CLABE dentro de un tenant; cross-tenant puede coincidir (diferentes sucursales del mismo banco).

**Mecanismo RBAC (mismo patrón que `Quotation`):**
1. Agregar `'PaymentDetail'` a `AppSubjects` en `src/auth/authorization/domain/permission.ts`.
2. Append cuatro entradas en `PERMISSION_REGISTRY` con `subject: 'PaymentDetail', action: 'read'|'create'|'update'|'delete'`.
3. Nada más — `PermissionSeeder` auto-upsert en el próximo boot.

**Módulo admin** (espejo de `admin-role`):
- `src/admin/payment-details/admin-payment-detail.controller.ts` → `@Controller('admin/payment-details')` con `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)` y `@RequirePermissions(['<action>', 'PaymentDetail'])` por ruta.
- `AdminPaymentDetailService` → CRUD con `IPaymentDetailRepository` (symbol-injected) + `TenantPrismaService` + `ClsService<TenantClsStore>`.
- DTOs en `src/admin/payment-details/dto/`: `CreatePaymentDetailDto`, `UpdatePaymentDetailDto`, `PaymentDetailResponseDto`.
- Repository en `src/admin/payment-details/infrastructure/prisma-payment-detail.repository.ts`.

**Endpoint bot (read-only):**
- `GET /chatbot-api/payment-details` → scope `payment-details:read` (nuevo scope, agregado a `ServiceCredential.scopes` conocidas).
- Devuelve `{ bankName, beneficiary, clabe, accountNumber }` de la cuenta activa del tenant del credential.
- Si no hay activa → 404 `NO_ACTIVE_PAYMENT_DETAIL`.
- Audit-logged vía `BotAuditInterceptor` (igual que el resto de chatbot-api).

### Q2 — Re-evaluación con motor de promos real

**Decisión arquitectónica clave (resuelta por el owner):** server-side re-evaluación con el **POS engine** (`recomputePricingAndPromotions` en `sales.service.ts:477-634`), **no** con `evaluate-cart`. Razón: `evaluate-cart` solo soporta `PRODUCT_DISCOUNT` con `appliesTo='PRODUCTS'` + `AUTOMATIC`, sin tiers / categorías / marcas / BXGY / ADVANCED / price-list gate / customer scope — todos casos que sí pasan por el POS engine y que un cliente del bot debe poder recibir como promo.

**Flow nuevo de `confirmBotSale`:**

```
1.  Validar `items[].unitPriceCents` contra `ProductsService.getApplicablePrices`
    (list prices, tier-aware) — UN solo elemento del set debe matchear. Si no → PRICE_OUT_OF_DATE.
    (Este check queda como precondición de "el precio cotizado por el bot sale de un list price válido".)

2.  Construir el `Sale` aggregate con Sale.create → assignCustomer() (auto-seed del globalPriceListId
    del customer) → addItem() con unitPriceCents del bot.

3.  Construir el PosEvalInput y llamar `recomputePricingAndPromotions(sale)`. Esto:
      a. Clear PROMO-sourced discounts.
      b. `repriceNonStickyLines` — re-cotiza tier-aware.
      c. `evaluatePromotionsForSale` — corre el POS engine real.
      d. Aplica per-line + order-level promos al aggregate.
      e. Prune orphaned MANUAL opt-ins.

4.  Calcular `totalCents = Σ(item.unitPriceCents · qty)` (post-promo, post-tier-reprice).
    Calcular `subtotalCents = Σ(item.originalPriceCents · qty)` (pre-promo, list + tier).
    `discountCents = subtotalCents − totalCents`.

5.  Si el bot envió `expectedTotalCents` (opcional, recomendado para evitar re-quotes silenciosos):
    comparar contra `totalCents`. Si difieren → throw `BusinessRuleViolationError(
    'PROMO_RE_QUOTE', 'PROMO_RE_QUOTE', { recomputedTotalCents, expectedTotalCents })`
    — el bot hace re-cotiza con el motor real.

6.  Persistir con `discountCents` REAL (no 0). Continuar el flow actual (folio, stock, outbox event).
```

**DTOs cambiados:**
- `RegisterBotSaleRequestDto`: nuevo campo opcional `expectedTotalCents?: number` (`@IsOptional(), @IsInt(), @Min(0)`).
- `BotSaleResponse`: nuevo campo `discountCents: number` (required, 0 si no hubo promo).
- `ConfirmBotSaleResult`: nuevo campo `discountCents: number`.
- `BotSaleResponse` mantiene **backward compatibility additive** (clientes que no leen `discountCents` no rompen; clientes que sí lo leen ahora ven el valor real).

**Seguridad:** backend es source of truth para precios — nunca se confía ciegamente en el `unitPriceCents` del bot. El check (1) garantiza que viene de un list price válido; el check (5) garantiza que el total cotizado coincide con la re-evaluación del motor real. Si difiere, se rechaza y el bot re-cotiza.

**Persistencia de `discountCents` para reportes:** se persiste el valor real (`subtotalCents − totalCents`, **list − final**), no el valor enviado por el bot. Esto garantiza que los reportes de descuentos reflejen exactamente lo que el POS engine aprobó, sin riesgo de que el bot envíe un descuento inventado.

**Casos:**
- **Bot no envía promo, sin promo aplicable** → `discountCents = 0`, total = sum(list × qty), flujo sigue idéntico al actual.
- **Bot no envía promo, promo automática aplicable** → `discountCents > 0`, total = sum(final × qty), flujo sigue.
- **Bot envía `expectedTotalCents` que matchea** → OK, procede.
- **Bot envía `expectedTotalCents` que difiere** → `PROMO_RE_QUOTE`, 409 con ambos totales para que el bot re-cotice.

### Q3 — Atomic idempotency para `registerBotSale`

**Patrón a portar (POS, ya probado en `prisma-sale.repository.ts:1647-1713`):**

```typescript
async acquireSaleRegistrationIdempotency(
  key: string,
  requestHash: string,
): Promise<
  | { kind: 'acquired'; token: string }
  | { kind: 'replay'; payload: unknown }
  | { kind: 'conflict' }
  | { kind: 'in_flight' }
>
```

Implementación: `create` atómico → en `P2002`, re-leer y discriminar por `requestHash` y `status`. Misma lógica que `acquireChargeIdempotency`, con `operation = 'bot_sale_register'`.

**Cambio en `ChatbotApiService.registerBotSale`:**

```
1.  Construir `requestHash` = SHA-256(JSON.stringify(canonicalPayload)), donde
    `canonicalPayload = sortItems(items)` para que el hash sea independiente del orden
    de los items. Keys canonicalizadas: { cashierUserId, customerId, shippingAddressId,
    items: [{ productId, variantId, quantity, unitPriceCents }] } (snake_case-stable,
    mismos nombres que el DTO). Sorting: items por productId+variantId ASC.

2.  Llamar `saleRepo.acquireSaleRegistrationIdempotency(input.idempotencyKey, requestHash)`.

3.  Branching:
    - 'replay'   → return cached response (semántica actual, preservada).
    - 'conflict' → throw `BusinessRuleViolationError('IDEMPOTENCY_KEY_CONFLICT',
                   'IDEMPOTENCY_KEY_CONFLICT')` → 409. El bot debe usar una key nueva.
    - 'in_flight'→ throw `BusinessRuleViolationError('IDEMPOTENCY_KEY_IN_FLIGHT',
                   'IDEMPOTENCY_KEY_IN_FLIGHT')` → 409. El bot reintenta más tarde.
    - 'acquired' → proceder con `salesService.confirmBotSale(...)`.

4.  Al terminar (success), `saleRepo.markSaleRegistrationIdempotencySucceeded(token,
    saleId, response)`.

5.  FAILED nunca se persiste (decisión del exploration: no se introduce marking de
    failure en este ciclo; el slot queda IN_FLIGHT hasta que el siguiente acquire lo
    detecte por status. El riesgo es un slot IN_FLIGHT permanente si un proceso muere
    entre acquire y succeed — aceptable, el operador puede limpiarlo manualmente; ver
    Risks).
```

**Sin cambios de schema:** `SaleIdempotency` ya tiene `requestHash String` (required) y `@@unique([tenantId, operation, key])`. Solo se usa `operation = 'bot_sale_register'` con la nueva variante de acquire.

**Validación de key:** el controller actual pasa `idempotencyKey ?? ''` al service. Se valida en el DTO (`@IsString(), @IsNotEmpty(), @MaxLength(200)`) para que un key vacío retorne 400 antes de tocar la DB.

**Tests existentes:** `chatbot-api.service.spec.ts:799+` cubre el replay semantics actual. Esos tests siguen verdes con la nueva implementación (la rama replay es la misma). Se agregan tests nuevos para: conflict, in_flight, requestHash mismatch, retry-after-in-flight.

## Implications & Impact

### Áreas afectadas

| Área | Impacto | Descripción |
|------|---------|-------------|
| `prisma/schema.prisma` | Nuevo modelo | `PaymentDetail` + índices + `@@unique([tenantId, clabe])`; `PaymentDetail` se agrega a `Tenant.idempotencyRecords`-style reverse relation en `Tenant`. Migración `prisma migrate dev --name add_payment_detail`. |
| `prisma/migrations/<ts>_add_payment_detail/` | Nueva migración | Forward: create table + FK a Tenant; reverse: drop table. |
| `src/auth/authorization/domain/permission.ts` | Modificado | Append `'PaymentDetail'` a `AppSubjects` + 4 entradas en `PERMISSION_REGISTRY`. |
| `src/admin/payment-details/` | Nuevo módulo | Controller, service, DTOs, repository, module, module wiring en `AdminModule`. |
| `src/admin/admin.module.ts` | Modificado | Importar `AdminPaymentDetailModule` (o inlining del controller). |
| `src/sales/sales.service.ts` | Modificado | `confirmBotSale` re-evalúa con `recomputePricingAndPromotions`, calcula `discountCents`, compara contra `expectedTotalCents`. |
| `src/sales/sales.service.spec.ts` | Modificado | Tests del flow re-evaluado: promo aplica, sin promo, conflict, re-quote. |
| `src/sales/domain/sale.entity.ts` | Posible | Si la signatura de `ConfirmBotSaleResult` cambia, agregar `discountCents`. Si el entity necesita tracking nuevo del bot-quoted total, agregarlo con un método dedicado. |
| `src/sales/infrastructure/prisma-sale.repository.ts` | Modificado | Nuevo `acquireSaleRegistrationIdempotency` + `markSaleRegistrationIdempotencySucceeded` + `acquireSaleRegistrationIdempotency` private helper. |
| `src/sales/sales.repository.interface.ts` | Modificado | Firmas nuevas en `ISaleRepository`. |
| `src/chatbot-api/application/chatbot-api.service.ts` | Modificado | `registerBotSale` usa el patrón atómico; `getActivePaymentDetail` nuevo método. |
| `src/chatbot-api/application/chatbot-api.service.spec.ts` | Modificado | Tests del flow atómico: replay, conflict, in_flight, success. |
| `src/chatbot-api/presentation/chatbot-api.controller.ts` | Modificado | Validación de `idempotencyKey` en DTO; nueva ruta `GET /chatbot-api/payment-details`. |
| `src/chatbot-api/presentation/dto/register-bot-sale.request.ts` | Modificado | Campo `expectedTotalCents?`. |
| `src/chatbot-api/presentation/dto/bot-sale.response.ts` | Modificado | Campo `discountCents`. |
| `src/chatbot-api/presentation/dto/payment-detail.response.ts` | Nuevo | DTO de respuesta del endpoint bot. |
| `src/chatbot-api/chatbot-api.module.ts` | Modificado | Si el nuevo método requiere export adicional. (Ya importa SalesModule — no debería necesitar más.) |
| `openspec/program/whatsapp-ai-chatbot/PROGRAM-CONTEXT.md` | Modificado | **Drift fix**: documentar los 10 endpoints reales (incluyendo `POST /chatbot-api/sales/:saleId/cancel` que faltaba) + el nuevo `GET /chatbot-api/payment-details` + nueva sección de idempotency atómica + nota sobre `discountCents` en la response. |
| `openspec/specs/sales/spec.md` | Modificado | Delta: `confirmBotSale` re-evalúa promociones, `discountCents` se persiste. |
| `openspec/specs/chatbot-api-foundation/spec.md` | Modificado | Delta: nuevo endpoint read-only + cambios en `registerBotSale`. |
| `openspec/specs/admin-rbac/spec.md` (o equivalente) | Modificado | Delta: 4 nuevos permisos `*:PaymentDetail`. |
| `houndfe-chatbot/docs/backend-questions-sale-flow.md` | Respuesta formal | **Anexo**: contestar las preguntas del bot (Q1–Q3 + aclaraciones Q4–Q8). Producido tras archivar este change, sourced desde este spec. |

### Drift de documentación

`openspec/program/whatsapp-ai-chatbot/PROGRAM-CONTEXT.md` lista 9 endpoints; el código
tiene 10 (falta documentar `POST /chatbot-api/sales/:saleId/cancel`,
`src/chatbot-api/presentation/chatbot-api.controller.ts:153`). Además, la §4.3 (Idempotency)
describe el comportamiento actual que **no es atómico** — debe actualizarse para reflejar
el patrón nuevo. Este change cierra todo ese drift junto con los 3 blockers.

### Compatibilidad hacia atrás

- **Bot-side**: si el bot ignora `discountCents` en la response, sigue funcionando
  (campo additive). Si el bot no envía `expectedTotalCents`, el server no rechaza (campo
  opcional) — solo no aplica el chequeo anti-drift. Recomendado (no obligatorio) para
  que el bot se proteja contra cambios de precio entre cotiza y confirma.
- **Idempotency keys existentes**: las keys que ya tienen `SUCCEEDED` siguen
  funcionando con el nuevo flow (la rama `replay` las maneja idénticamente).
- **Idempotency keys en `IN_FLIGHT` huérfanas**: el nuevo código las detecta como
  `in_flight` en lugar de absorberlas. Riesgo: si hay slots huérfanos pre-existentes,
  el bot verá 409 hasta que se limpien. Limpieza = DELETE manual del row o esperar
  retry. Operacional, no técnico.

### Tenant / multi-branch

- `PaymentDetail` tenant-scoped via CLS + `TenantPrismaService`, igual que el resto.
- Un tenant puede tener N cuentas (multi-cuenta por sucursal). El bot solo ve la
  activa (`isActive = true`, más reciente por `updatedAt`).
- Cross-tenant access siempre 404, sin leakage.

## Edge Cases

### Q1
- **Tenant sin `PaymentDetail`** → `GET /chatbot-api/payment-details` retorna 404
  `NO_ACTIVE_PAYMENT_DETAIL`. Bot: "Aún no tengo una cuenta configurada, te contacto
  con un humano".
- **Tenant con múltiples cuentas activas (data inconsistency)** → bot solo ve una
  (la más reciente por `updatedAt`). El admin no debería poder activar más de una a
  la vez; se documenta como restricción operativa (no enforced en DB) — ver Risks.
- **Soft-delete de la única cuenta activa** → todas las lecturas del bot retornan 404
  hasta que se active otra.
- **CLABE inválida (≠ 18 dígitos)** → 400 `INVALID_CLABE` en create/update.
- **CLABE duplicada en el mismo tenant** → 409 `DUPLICATE_CLABE`.
- **Cross-tenant CLABE collision** → permitido por diseño (sucursales distintas del
  mismo banco).

### Q2
- **Promo aplicable, bot no envía `expectedTotalCents`** → server re-evalúa, aplica
  promo, persiste `discountCents > 0`. **Comportamiento deseable**: el bot recibe
  el `discountCents` en la response y puede ajustar lo que le dijo al cliente.
- **Promo aplicable, `expectedTotalCents` matchea el re-evaluado** → 201, `discountCents > 0`.
- **Promo aplicable, `expectedTotalCents` NO matchea** → 409 `PROMO_RE_QUOTE` con
  `{ recomputedTotalCents, expectedTotalCents, discountCents }`. Bot re-cotiza.
- **Bot envía `unitPriceCents` que NO es list price** → 400 `PRICE_OUT_OF_DATE`
  (rechazo antes de tocar promos).
- **Promo deja de ser aplicable entre cotiza y confirma** (ej. cambió `daysOfWeek` o
  expiró) → `expectedTotalCents` del bot difiere del re-evaluado → 409 `PROMO_RE_QUOTE`.
  Esto es **deseable** — el bot re-cotiza con la nueva realidad.
- **Manual promo opt-in por el bot** → NO soportado en este ciclo. El bot solo recibe
  promos automáticas. `optedInManualPromotionIds` se queda vacío por construcción.
- **Cart con promo de ORDER_DISCOUNT** → `sale.setAppliedOrderPromotion` lo captura;
  el `discountCents` final incluye la promo order-level.
- **Sale con promo de BXGY / ADVANCED** → soportado por el POS engine, `discountCents`
  refleja el reward. Tests deben cubrir.

### Q3
- **Same key, mismo payload, segundo request después del SUCCEEDED** → replay
  (response cacheada). Sin cambio.
- **Same key, distinto payload, segundo request** → 409 `IDEMPOTENCY_KEY_CONFLICT`.
  El bot debe usar key nueva.
- **Same key, mismo payload, segundo request mientras el primero está IN_FLIGHT** →
  409 `IDEMPOTENCY_KEY_IN_FLIGHT`. El bot espera y reintenta.
- **Empty / null `idempotencyKey`** → 400 `INVALID_IDEMPOTENCY_KEY` en el DTO,
  antes de tocar la DB. El controller actual pasaba `idempotencyKey ?? ''` — esto
  es una mejora del DTO.
- **Slot IN_FLIGHT huérfano** (proceso murió entre acquire y succeed) → todas las
  próximas requests con esa key retornan `in_flight` indefinidamente. **Mitigación
  operativa**: el operador limpia el row manualmente. Riesgo aceptado para este
  ciclo (ver Risks).
- **requestHash determinístico**: items se canonicalizan (sort por `productId+variantId`)
  ANTES de hashear, igual que `sortPaymentsForHash` en el POS.

## Product Decisions (RESOLVED — baked-in)

1. **Q1 RBAC** → Permisos granulares `read:PaymentDetail`, `create:PaymentDetail`,
   `update:PaymentDetail`, `delete:PaymentDetail` siguiendo la convención CASL existente
   (auto-seeded al boot vía `permission.seeder.ts`). Cualquier rol al que se le concedan
   esos permisos puede operar — sin restricción por rol especial. Datos tenant-scoped vía
   CLS + `TenantPrismaService`, como todo lo demás. Multi-cuenta por tenant permitido
   con flag `isActive`. Delete es lógico (`isActive=false`), nunca hard delete. El
   endpoint del bot retorna solo la cuenta activa.

2. **Q2 engine** → Re-evaluación server-side usando el motor de promos REAL
   (`recomputePricingAndPromotions`, `sales.service.ts:477`) al confirm time. Si el
   total re-computado difiere del total cotizado por el bot → reject con error de
   re-quote (bot re-cotiza). `discountCents` se persiste como valor real (list − final)
   para reportes. El DTO de bot sale gana los campos necesarios. Seguridad: backend
   es source of truth para precios — nunca se confía ciegamente en precios cotizados
   por el bot.

3. **Q3 idempotency** → Portar el patrón atómico del POS charge (`acquireChargeIdempotency`:
   create con unique constraint, P2002 → replay / conflict / in_flight, comparación real
   de `requestHash`) a `registerBotSale`. `SaleIdempotency` ya tiene columna `requestHash`
   + `@@unique([tenantId, operation, key])` — sin cambio de schema. Preservar la
   semántica de replay para misma key.

## Annex Deliverable (definido por este change)

Este change produce la **respuesta formal al documento del bot** (`houndfe-chatbot/docs/backend-questions-sale-flow.md`) como deliverable post-archivo. El anexo se redacta **tras** archivar este change (cuando el código está merged), y se construye **fuente-de-spec** desde este proposal + la implementación:

- **Q1 → Q3**: decisiones finales del backend, con paths a los endpoints / archivos relevantes y un mini-snippet por endpoint (bank detail read, promo re-evaluation, idempotency atomic).
- **Q4 → Q8 (aclaraciones no bloqueantes)**: respuestas cortas a las preguntas que el bot tenía en su doc. Estas aclaraciones NO se implementan en este change — son solo respuestas a preguntas que el bot ya hizo. Ejemplos esperados:
  - Q5: "`evaluate-cart` ya soporta `needs_human_review` — cuando el motor POS evalúe y no pueda clasificar automáticamente, la response del `registerBotSale` recibirá ese flag para que el bot haga handoff a humano."
  - Q6/Q7: "los DTOs actuales requieren todos los campos; si el bot quiere relajar, abrir un change dedicado."
- **Wording**: en español, mismo registro que `PROGRAM-CONTEXT.md`. Owner revisa antes de publicar.

El anexo se publica en `houndfe-chatbot/docs/backend-questions-sale-flow-responses.md` (o path equivalente que el equipo del bot prefiera — se confirma al archivar).

## Risks

| Riesgo | Likelihood | Mitigation |
|--------|------------|------------|
| Review size: ~1,500–2,000 LOC (Q1 model + admin CRUD + Q2 engine re-eval + Q3 atomic port + tests) excede el budget de 400 líneas | High | Forecast en tasks phase; **chained-PR slices**: WU1 Q1 schema + admin CRUD + RBAC; WU2 Q3 atomic idempotency; WU3 Q2 engine re-eval + discountCents + expectedTotalCents + bot endpoint read-only + docs drift fix. Cada WU es revertible individualmente. |
| Engine re-evaluation en `confirmBotSale` puede "corregir" precios que el bot le cotizó al cliente, sorprendiendo al cliente final | Med | El bot DEBE usar el flujo `evaluate-cart` → `registerBotSale` y siempre enviar `expectedTotalCents` igual al último `CartEvaluationResult.finalPriceCents`. Si difiere (cambio de precio, expiración de promo, etc.) → `PROMO_RE_QUOTE` y el bot re-cotiza antes de confirmar. Documentado en el anexo al bot. |
| `recomputePricingAndPromotions` puede re-cotizar líneas no-sticky a un tier distinto del que el bot asumió, generando re-quotes constantes | Low | El bot ya debe estar usando el list price correcto (validado por el check de `getApplicablePrices`). El engine respeta ese baseline. Si hay drift, es por cambio legítimo de tier / promo. |
| Múltiples cuentas activas simultáneamente (data inconsistency en `PaymentDetail`) | Low | Documentar como restricción operativa: el admin debe desactivar la vieja antes de activar la nueva. No enforced en DB para no romper migraciones; tradeoff explícito. |
| Slot `IN_FLIGHT` huérfano bloquea la key indefinidamente | Low | Decisión del exploration: `FAILED` no se persiste en este ciclo. Mitigación operativa: cleanup manual via SQL. Riesgo aceptable v1. |
| `requestHash` canonicalization rota el contrato si cambian los campos del DTO | Low | Hash sobre un sub-set explícito y documentado de campos (`{ cashierUserId, customerId, shippingAddressId, items: [{productId, variantId, quantity, unitPriceCents}] }`); cambios a campos como `productName` o `variantName` no afectan el hash. |
| Drift de docs en `PROGRAM-CONTEXT.md` no se cierra porque se "olvidó" | Low | Este change tiene la sección §Implications que lo llama explícitamente + lista `PROGRAM-CONTEXT.md` en la tabla de affected areas. Tasks phase debe incluir un task dedicado al docs drift. |
| Auto-seed de los 4 nuevos permisos no corre si el seed falla | Low | `PermissionSeeder` es idempotente y safe-on-restart (`upsert`); cualquier fallo se detecta al boot. Test de boot smoke debe incluir los 4 nuevos permissions. |
| `evaluate-cart` (simplified engine) y `recomputePricingAndPromotions` (POS engine) pueden diverger en la misma promo | Med | Documentado: `evaluate-cart` solo soporta PRODUCT_DISCOUNT+AUTOMATIC. Cuando el POS engine evalúe una promo más compleja, el `unitPriceCents` final puede diferir del previewed. El bot debe manejar el `PROMO_RE_QUOTE` como flujo normal, no como error. |
| `BotSaleResponse` agregado campo `discountCents` rompe clientes que hacen validación strict de shape | Low | Additive change; documented en CHANGELOG / response annex. Bot que use TypeScript con tipos estrictos debe actualizar su interface. |

## Rollback Plan

**Single revert del feature branch**, WU por WU (ver Risks). Detalles por bloqueante:

- **WU1 (Q1)**: revert WU1 migration con `prisma migrate resolve --rolled-back` sobre la única migración nueva (`add_payment_detail`). Las 4 nuevas entradas en `PERMISSION_REGISTRY` quedan como rows en `Permission` (inocuas si no se otorgan a ningún rol). Remover `PaymentDetail` de `AppSubjects` y `PERMISSION_REGISTRY` — pero **cuidado**: si el admin ya creó roles con esos permisos, dejar las rows de Permission (no las borres) y solo sacar la entrada de código. El módulo admin desaparece del import de `AdminModule`.
- **WU2 (Q3)**: revert puro de código. El shape de `SaleIdempotency` no cambia (la columna `requestHash` ya existía). `registerBotSale` vuelve al `upsert` con `update: {}`. Las keys `IN_FLIGHT` existentes siguen funcionando con el código viejo.
- **WU3 (Q2 + bot endpoint + docs)**: revert puro de código + docs. `discountCents` deja de calcularse (vuelve a 0 hardcoded); `expectedTotalCents` deja de validarse; el endpoint read-only desaparece. `BotSaleResponse` queda sin `discountCents` (cliente que ignore el campo sigue funcionando). `PROGRAM-CONTEXT.md` queda con el drift conocido — abrir issue para corregirlo en un change dedicado si no se mergea este.

No hay data migration en producción que requiera cleanup (Q1 es greenfield, Q2 nunca escribió promos a `discountCents`, Q3 solo cambia la mecánica de acquire).

## Dependencies

- `nestjs-cls` + `TenantPrismaService` (ya shipped).
- `PermissionSeeder` + `PERMISSION_REGISTRY` (ya shipped).
- `SalesService.recomputePricingAndPromotions` + `PosEvaluatePromotionsUseCase` (ya shipped).
- `SaleIdempotency` model + `acquireChargeIdempotency` (ya shipped, patrón a portar).
- `ChatbotApiModule` ya importa `SalesModule` (sin cambio).
- `AdminModule` + `AdminRoleController`/`AdminRoleService` (shape a espejar).
- Backend tests: `sales.service.spec.ts`, `chatbot-api.service.spec.ts`, `chatbot-api.controller.spec.ts` (extender, no reemplazar).

## Success Criteria

### Q1 — PaymentDetail CRUD + bot read
- [ ] Modelo `PaymentDetail` en `prisma/schema.prisma` + migración aplicada.
- [ ] Cuatro permisos `*:PaymentDetail` en `PERMISSION_REGISTRY` y auto-seeded al boot.
- [ ] `POST /admin/payment-details` con `create:PaymentDetail` crea una cuenta y la retorna.
- [ ] `GET /admin/payment-details` con `read:PaymentDetail` lista las cuentas del tenant.
- [ ] `PATCH /admin/payment-details/:id` con `update:PaymentDetail` actualiza los campos.
- [ ] `DELETE /admin/payment-details/:id` con `delete:PaymentDetail` hace soft-delete (`isActive=false`).
- [ ] Cross-tenant access siempre 404.
- [ ] `GET /chatbot-api/payment-details` con scope `payment-details:read` retorna la cuenta activa (más reciente por `updatedAt`).
- [ ] Sin cuenta activa → 404 `NO_ACTIVE_PAYMENT_DETAIL`.
- [ ] CLABE ≠ 18 dígitos → 400 `INVALID_CLABE`. CLABE duplicada mismo tenant → 409 `DUPLICATE_CLABE`.

### Q2 — Promo re-evaluation
- [ ] `confirmBotSale` invoca `recomputePricingAndPromotions(sale)` antes de persistir.
- [ ] `discountCents` se calcula como `subtotalCents − totalCents` (list − final, post-engine).
- [ ] `discountCents` se persiste en el Sale (no hardcoded 0).
- [ ] `BotSaleResponse` expone `discountCents` (campo additive, backward-compat).
- [ ] `RegisterBotSaleRequestDto.expectedTotalCents?` validado y opcional.
- [ ] Si `expectedTotalCents` enviado y difiere del re-computado → 409 `PROMO_RE_QUOTE` con `{ recomputedTotalCents, expectedTotalCents, discountCents }`.
- [ ] Si `expectedTotalCents` no enviado → no se rechaza; server aplica la promo y devuelve `discountCents` en la response.
- [ ] `unitPriceCents` no-list-price → 400 `PRICE_OUT_OF_DATE` (antes del engine).
- [ ] BXGY / ADVANCED / ORDER_DISCOUNT soportados por el engine re-usado.
- [ ] Sale emite `sale.confirmed` con `discountCents` en el payload del outbox event.

### Q3 — Atomic idempotency
- [ ] Nuevo método `acquireSaleRegistrationIdempotency(key, requestHash)` en `ISaleRepository`.
- [ ] `registerBotSale` usa el patrón atómico: `create` → `P2002` → `replay|conflict|in_flight`.
- [ ] `requestHash` = SHA-256 sobre `{ cashierUserId, customerId, shippingAddressId, items sorted }`.
- [ ] Same key + same payload + post-SUCCEEDED → replay (response cacheada), preserva semántica actual.
- [ ] Same key + different payload → 409 `IDEMPOTENCY_KEY_CONFLICT`.
- [ ] Same key + IN_FLIGHT → 409 `IDEMPOTENCY_KEY_IN_FLIGHT`.
- [ ] Empty `idempotencyKey` → 400 `INVALID_IDEMPOTENCY_KEY` en el DTO.
- [ ] Tests existentes en `chatbot-api.service.spec.ts:799+` siguen verdes.
- [ ] Tests nuevos para conflict, in_flight, requestHash mismatch, retry-after-in-flight.

### Globales
- [ ] `pnpm run test` y `pnpm run build` verdes; sin regresión en suite completa.
- [ ] `PROGRAM-CONTEXT.md` actualizado: 10 endpoints reales (incluyendo cancel), nuevo endpoint read-only, sección §4.3 idempotency describe el patrón atómico, response de bot expone `discountCents`.
- [ ] `openspec/specs/sales/spec.md` delta: `confirmBotSale` re-evalúa promos, persiste `discountCents`.
- [ ] `openspec/specs/chatbot-api-foundation/spec.md` delta: nuevo endpoint read-only + cambios en `registerBotSale`.
- [ ] `openspec/specs/admin-rbac/spec.md` (o equivalente) delta: 4 nuevos permisos.
- [ ] Anexo `houndfe-chatbot/docs/backend-questions-sale-flow-responses.md` redactado tras archivar, sourced desde este spec.
- [ ] Cobertura de tests en archivos nuevos/modificados ≥ 80%.
- [ ] Lint scoped (`pnpm exec eslint src/chatbot-api src/admin/payment-details src/sales`) verde.

## Size Signal

**Forecast: 1,500–2,000 líneas added** (sin contar cliente Prisma generado):
- WU1 (Q1): ~600 LOC (modelo + migración + admin module 4 archivos + tests + RBAC registry + DTOs).
- WU2 (Q3): ~400 LOC (2 métodos nuevos en repo + refactor `registerBotSale` + 4 tests + validación DTO).
- WU3 (Q2 + bot endpoint + docs): ~700 LOC (re-eval en `confirmBotSale` + nuevo método en chatbot-api service + endpoint read-only + tests + docs drift fix).

Excede el budget de 400 líneas por review. **Ejecución recomendada: chained PR slices** en el orden WU1 → WU2 → WU3 (cada WU revertible individualmente; WU2 y WU3 independientes entre sí, podrían mergearse en cualquier orden tras WU1). Confirmado en la fase `sdd-tasks`.
