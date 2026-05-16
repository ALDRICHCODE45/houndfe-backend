# POS Ventas — Contrato Técnico Completo para Frontend

> Estado: **IMPLEMENTADO en backend (Fases 1-4 completas)**.
>
> Fuente de verdad: `src/sales/sales.controller.ts`, `src/sales/sales-payments.controller.ts`, `src/sales/sales-query.controller.ts`, `src/sales/sales.service.ts`, `src/sales/dto/`, `src/shared/filters/domain-exception.filter.ts`, `src/shared/outbox/`, esquema/migraciones Prisma.

---

## Índice

- [2) Permisos RBAC](#2-permisos-rbac)
- [2.5) Asignar cliente y dirección al draft](#25-asignar-cliente-y-dirección-al-draft)
- [2.6) Asignar o limpiar vendedor de una venta](#26-asignar-o-limpiar-vendedor-de-una-venta)
- [3) Endpoint: Cobrar draft](#3-endpoint-cobrar-draft)
- [3.7) Due date (nuevo)](#37-due-date-nuevo)
- [5) Idempotencia (MUY importante)](#5-idempotencia-muy-importante)

## 0) Qué se implementó (resumen ejecutivo)

Se habilitaron 4 capacidades del módulo de ventas POS:

1. **Cobrar draft** (`POST /sales/drafts/:id/charge`) — confirma venta con transacción atómica.
2. **Listar ventas confirmadas** (`GET /sales`) — paginado, filtros, búsqueda y contadores para tabs.
3. **Detalle de venta** (`GET /sales/:id`) — items con imagen, pagos, timeline automático y metadata.
4. **Registrar pago sobre deuda** (`POST /sales/:id/payments`) — cobrar deuda de ventas a crédito/parciales.

### Capacidades actuales

- **Pago múltiple**: hasta 5 métodos por cobro (ej: parte efectivo + parte tarjeta).
- **Crédito completo**: venta sin pago (`method: credit`) — requiere cliente asignado.
- **Pago parcial**: cobrar menos del total — crea deuda, requiere cliente asignado.
- **Cobro de deuda**: `POST /sales/:id/payments` para abonar a ventas con deuda pendiente.
- **Backward compatible**: el formato legacy de un solo pago (`{ method, amountCents }`) sigue funcionando.
- Canal fijo: `POS`. Caja fija: `Principal`.
- Entrega fija: `DELIVERED`. Timeline: `SALE_REGISTERED` + 0..N `PAYMENT_RECEIVED` + `PRODUCTS_DELIVERED`.
- `imageUrl` capturado como snapshot al agregar item al draft.
- **Eventos de dominio** (Transactional Outbox) para integración futura (impresión de tickets, notificaciones, etc.).

### Todavía NO implementado

- Múltiples cajas/canales.
- Facturación/CFDI.
- Acciones de venta (imprimir ticket, PDF, etc) — requiere WebSocket bridge.
- Límites de crédito por cliente.
- Refunds / cancelación de pagos.

---

## 1) Por qué se hizo así

1. **Integridad de caja**: no hay cobros parciales silenciosos.
2. **Integridad de inventario**: stock se descuenta SOLO al confirmar, en transacción atómica.
3. **Integridad de precio**: si cambió precio entre draft y cobro, se rechaza (`PRICE_OUT_OF_DATE`).
4. **All-or-nothing**: si falta stock en 1 ítem, se rechaza toda la venta.
5. **Resiliencia de red**: reintentos no duplican cobros ni pagos (idempotencia).
6. **Aislamiento tenant**: todos los paths están tenant-scoped.
7. **Eventos durables**: cada venta confirmada y cada pago genera un evento persistente que NUNCA se pierde (Transactional Outbox).
8. **Concurrencia segura**: cobros de deuda concurrentes protegidos con `SELECT FOR UPDATE` — no se puede sobre-pagar.

---

## 2) Permisos RBAC

| Endpoint | Permiso requerido |
|---|---|
| `POST /sales/drafts/:id/charge` | `update:Sale` |
| `PUT /sales/drafts/:id/customer` | `update:Sale` |
| `DELETE /sales/drafts/:id/customer` | `update:Sale` |
| `PUT /sales/drafts/:id/shipping-address` | `update:Sale` |
| `DELETE /sales/drafts/:id/shipping-address` | `update:Sale` |
| `PUT /sales/:id/seller` | `update:Sale` |
| `DELETE /sales/:id/seller` | `update:Sale` |
| `POST /sales/:id/payments` | `update:Sale` |
| `GET /sales` | `read:Sale` |
| `GET /sales/:id` | `read:Sale` |

Todos requieren JWT válido + tenant activo.

---

## 2.5) Asignar cliente y dirección al draft

Los drafts ahora permiten manejar cliente y dirección de envío con 4 endpoints:

> Para asignar vendedor en ventas DRAFT o CONFIRMED, ver §2.6.

1. `PUT /sales/drafts/:id/customer`
2. `DELETE /sales/drafts/:id/customer`
3. `PUT /sales/drafts/:id/shipping-address`
4. `DELETE /sales/drafts/:id/shipping-address`

### 3.1) Reglas funcionales clave

- Solo opera sobre ventas en estado `DRAFT`; si no, retorna `409 SALE_NOT_DRAFT`.
- Validación tenant-scoped: cliente/dirección de otro tenant responden como `404`.
- **Cuando cambia el cliente, la dirección de envío previa se borra automáticamente.**
- Endpoints `DELETE` y clears son idempotentes: si ya está en `null`, responden `204` y **no emiten evento**.
- Para cobro a crédito/parcial (`/charge`), el draft debe tener cliente asignado vía estos endpoints.

### 3.2) `PUT /sales/drafts/:id/customer`

Body:

```json
{
  "customerId": "f9d2f368-10be-4f4b-a3cc-0e67735f7f26",
  "shippingAddressId": "8f311d31-131f-449a-8a15-6a3257b0d865"
}
```

- `customerId`: UUID requerido.
- `shippingAddressId`: UUID opcional; puede enviarse explícitamente en `null`.

Respuesta `200` (shape):

```json
{
  "id": "sale-id",
  "status": "DRAFT",
  "customer": { "id": "...", "firstName": "Ada", "lastName": "Lovelace" },
  "shippingAddress": {
    "id": "...",
    "street": "Main",
    "exteriorNumber": "1",
    "interiorNumber": null,
    "zipCode": "64000",
    "neighborhood": "Centro",
    "municipality": "Monterrey",
    "city": "Monterrey",
    "state": "Nuevo León"
  }
}
```

Errores esperables: `404 CUSTOMER_NOT_FOUND`, `404 SHIPPING_ADDRESS_NOT_FOUND`, `422 SHIPPING_ADDRESS_NOT_FOR_CUSTOMER`, `409 SALE_NOT_DRAFT`, `403 SALE_UPDATE_FORBIDDEN`.

### 3.3) `DELETE /sales/drafts/:id/customer`

Sin body. Respuesta `204 No Content`.

- Si tenía cliente: limpia cliente + dirección.
- Si ya estaba en `null`: idem, `204` sin side effects.

### 3.4) `PUT /sales/drafts/:id/shipping-address`

Body:

```json
{
  "shippingAddressId": "8f311d31-131f-449a-8a15-6a3257b0d865"
}
```

También acepta `{"shippingAddressId": null}` para limpiar.

Errores esperables: `422 SHIPPING_ADDRESS_REQUIRES_CUSTOMER`, `404 SHIPPING_ADDRESS_NOT_FOUND`, `422 SHIPPING_ADDRESS_NOT_FOR_CUSTOMER`, `409 SALE_NOT_DRAFT`, `403 SALE_UPDATE_FORBIDDEN`.

### 3.5) `DELETE /sales/drafts/:id/shipping-address`

Sin body. Respuesta `204 No Content`.

- Limpia solo dirección (mantiene cliente).
- Idempotente: si ya era `null`, no emite evento.

### 3.6) Ejemplos curl

```bash
curl -X PUT "$API_URL/sales/drafts/$SALE_ID/customer" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"customerId":"f9d2f368-10be-4f4b-a3cc-0e67735f7f26"}'

curl -X PUT "$API_URL/sales/drafts/$SALE_ID/shipping-address" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"shippingAddressId":"8f311d31-131f-449a-8a15-6a3257b0d865"}'

curl -X DELETE "$API_URL/sales/drafts/$SALE_ID/customer" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 2.6) Asignar o limpiar vendedor de una venta

Estos endpoints aplican a ventas `DRAFT` y `CONFIRMED` (a diferencia de cliente, que es draft-only en §2.5):

- `PUT /sales/:id/seller`
- `DELETE /sales/:id/seller`

### `PUT /sales/:id/seller`

Body:

```json
{
  "sellerUserId": "8fb23d4c-93ca-4528-8cc1-fdc2443ad621"
}
```

Respuesta: `200` con el detalle actualizado de la venta.

Errores esperables:
- `404 SELLER_NOT_FOUND` (sellerUserId no existe en el tenant)
- `404 SALE_NOT_FOUND`
- `403` por RBAC (`update:Sale`)

### `DELETE /sales/:id/seller`

Sin body. Respuesta `204 No Content`.

- Idempotente: si ya no tiene vendedor, mantiene `204`.

Ejemplo curl:

```bash
curl -X PUT "$API_URL/sales/$SALE_ID/seller" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sellerUserId":"8fb23d4c-93ca-4528-8cc1-fdc2443ad621"}'

curl -X DELETE "$API_URL/sales/$SALE_ID/seller" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 3) Endpoint: Cobrar draft

```http
POST /sales/drafts/:id/charge
Authorization: Bearer <jwt>
Idempotency-Key: <uuid-o-string-unico>
```

### 3.1) Headers

| Header | Requerido | Notas |
|---|---|---|
| `Authorization` | Sí | Bearer JWT |
| `Idempotency-Key` | **Sí** | String no vacío. Si falta → `400 IDEMPOTENCY_KEY_REQUIRED` |

### 3.2) Body — DOS formatos soportados

#### Formato nuevo (recomendado): array de pagos

```json
{
  "payments": [
    { "method": "cash", "amountCents": 30000 },
    { "method": "card_debit", "amountCents": 25000, "reference": "VOUCHER-42" }
  ]
}
```

| Campo | Tipo | Requerido | Reglas |
|---|---|---|---|
| `payments` | `PaymentEntry[]` | Sí | Máximo 5 entries |
| `payments[].method` | `'cash' \| 'card_credit' \| 'card_debit' \| 'transfer'` | Sí | `'credit'` **NO permitido** en array |
| `payments[].amountCents` | `number` entero | Sí | `>= 0` |
| `payments[].reference` | `string` | Condicional | **Obligatorio** para `card_credit`, `card_debit`, `transfer`. NO enviar para `cash`. |

#### Formato legacy (sigue funcionando): un solo pago

```json
{
  "method": "cash",
  "amountCents": 55000
}
```

| Campo | Tipo | Requerido | Reglas |
|---|---|---|---|
| `method` | `'cash' \| 'card_credit' \| 'card_debit' \| 'transfer' \| 'credit'` | Sí | `'credit'` solo válido en formato legacy |
| `amountCents` | `number` entero | Sí | `>= 0` |

> **IMPORTANTE**: No mezclar ambos formatos en el mismo request. Enviar `method` + `amountCents` junto con `payments[]` causa → `422 AMBIGUOUS_PAYMENT_SHAPE`.

### 3.3) Reglas de validación de pago (en orden de evaluación)

| Regla | Error | HTTP |
|---|---|---|
| DTO inválido (class-validator) | mensaje de validación | 400 |
| Mezcla de formato legacy + array | `AMBIGUOUS_PAYMENT_SHAPE` | 422 |
| Más de 5 entries en `payments[]` | `TOO_MANY_PAYMENTS` | 422 |
| `method: 'credit'` dentro del array `payments[]` | `CREDIT_METHOD_NOT_VALID_IN_MULTI` | 422 |
| `card_credit`/`card_debit`/`transfer` sin `reference` (o solo espacios) | `REFERENCE_REQUIRED` | 422 |
| Método no reconocido | `PAYMENT_METHOD_NOT_SUPPORTED` | 422 |
| Crédito legacy con `amountCents > 0` | `INVALID_CREDIT_CHARGE` | 422 |
| Tarjeta/transferencia con monto mayor al total | `PAYMENT_AMOUNT_INVALID` | 422 |
| `amountCents < 0` | `PAYMENT_AMOUNT_INVALID` | 422 |
| Suma de pagos < total Y venta sin cliente asignado | `CUSTOMER_REQUIRED_FOR_CREDIT` | 422 |
| Venta no encontrada o de otro tenant | `SALE_NOT_FOUND` | 404 |
| Venta ya no es DRAFT | `SALE_ALREADY_CONFIRMED` | 409 |
| Precio del producto cambió desde el draft | `PRICE_OUT_OF_DATE` | 409 |
| Stock insuficiente al cobrar | `STOCK_INSUFFICIENT_AT_CONFIRM` | 409 |
| Idempotency-Key con payload distinto | `IDEMPOTENCY_KEY_CONFLICT` | 409 |
| Idempotency-Key en ejecución concurrente | `IDEMPOTENCY_KEY_IN_FLIGHT` | 409 |

### 3.4) Respuesta `200 OK`

```json
{
  "saleId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "folio": "A-202605-000001",
  "subtotalCents": 60000,
  "discountCents": 5000,
  "totalCents": 55000,
  "paidCents": 55000,
  "debtCents": 0,
  "changeDueCents": 5000,
  "paymentStatus": "PAID",
  "confirmedAt": "2026-05-06T20:00:00.000Z"
}
```

| Campo | Tipo | Significado |
|---|---|---|
| `saleId` | `string` (UUID) | ID de la venta confirmada |
| `folio` | `string` | Formato `A-YYYYMM-NNNNNN` (por tenant, secuencial) |
| `subtotalCents` | `number` | Suma base antes de descuentos |
| `discountCents` | `number` | Diferencia `subtotal - total` |
| `totalCents` | `number` | Monto final a cobrar |
| `paidCents` | `number` | Lo que efectivamente se pagó (min de lo entregado y el total) |
| `debtCents` | `number` | `totalCents - paidCents` (deuda restante) |
| `changeDueCents` | `number` | Cambio a devolver (ver reglas abajo) |
| `paymentStatus` | `string` | `PAID` / `PARTIAL` / `CREDIT` |
| `confirmedAt` | `string` (ISO) | Timestamp de confirmación |

### 3.5) Cómo se calcula `paymentStatus`

| Condición | Status |
|---|---|
| `paidCents === totalCents` | `PAID` |
| `paidCents === 0` | `CREDIT` |
| `0 < paidCents < totalCents` | `PARTIAL` |

### 3.6) Cómo se calcula `changeDueCents`

El cambio/vuelto SOLO aplica cuando se cumplen AMBAS condiciones:
1. Al menos un pago es `cash`
2. `paymentStatus` es `PAID` (se cubrió el total)

Fórmula: `changeDueCents = suma_total_entregada - totalCents`

En CUALQUIER otro caso → `changeDueCents = 0`.

> Ejemplo: total = $550, pagos = [cash $300, cash $300]. `paidCents` = 550 (capped al total), `changeDueCents` = 50, `paymentStatus` = PAID.

> Ejemplo: total = $550, pagos = [transfer $600]. Error `PAYMENT_AMOUNT_INVALID` — no se puede sobre-pagar con no-efectivo.

### 3.7) Regla de cliente para crédito/parcial

Si la **suma de todos los pagos es menor al total** de la venta, la venta crea deuda. Para esto, el draft **DEBE tener un cliente asignado** (`sale.customerId != null`).

No se puede extender crédito a "Público en General".

Si no hay cliente asignado y los pagos no cubren el total → `422 CUSTOMER_REQUIRED_FOR_CREDIT`.

### 3.8) Métodos duplicados en el mismo cobro

**SÍ está permitido**. Podés enviar dos entries de `cash` en el mismo array:

```json
{
  "payments": [
    { "method": "cash", "amountCents": 20000 },
    { "method": "cash", "amountCents": 15000 }
  ]
}
```

---

## 4) Idempotencia (MUY importante)

Aplica a AMBOS endpoints: `/charge` y `/payments`.

Header obligatorio:

```http
Idempotency-Key: <valor-unico-por-intento-logico>
```

| Caso | Resultado |
|---|---|
| Primera ejecución exitosa | Respuesta normal, se guarda resultado |
| Reintento mismo key + mismo payload | **Replay**: devuelve respuesta previa sin re-cobrar |
| Mismo key + payload distinto | `IDEMPOTENCY_KEY_CONFLICT` (409) |
| Mismo key en ejecución concurrente | `IDEMPOTENCY_KEY_IN_FLIGHT` (409) |

### Detalle técnico importante para `payments[]`

El hash de idempotencia se calcula sobre los pagos **ordenados** por `(method, amountCents, reference)`. Esto significa que si el frontend reintenta con los mismos pagos en **diferente orden**, se detecta como replay (no como conflicto).

```json
// Intento 1
{ "payments": [{ "method": "cash", "amountCents": 200 }, { "method": "transfer", "amountCents": 350, "reference": "X" }] }

// Reintento (mismo key, mismo contenido pero diferente orden) → REPLAY ✅
{ "payments": [{ "method": "transfer", "amountCents": 350, "reference": "X" }, { "method": "cash", "amountCents": 200 }] }
```

### Recomendación

- Generar UUID por intento de cobro/pago.
- Reusar ese key **solo para retries del mismo intento**.
- Si el usuario cambia monto/método, generar key nuevo.

---

## 5) Endpoint: Registrar pago sobre venta confirmada

```http
POST /sales/:id/payments
Authorization: Bearer <jwt>
Idempotency-Key: <uuid-o-string-unico>
```

Este endpoint es para **cobrar deuda** de ventas que quedaron con `paymentStatus: PARTIAL` o `CREDIT`.

### 5.1) Body

```json
{
  "method": "transfer",
  "amountCents": 15000,
  "reference": "TRF-001"
}
```

| Campo | Tipo | Requerido | Reglas |
|---|---|---|---|
| `method` | `'cash' \| 'card_credit' \| 'card_debit' \| 'transfer'` | Sí | **`credit` NO permitido** |
| `amountCents` | `number` entero | Sí | `>= 1` |
| `reference` | `string` | Opcional | Backend acepta sin reference incluso para tarjeta/transferencia (pero se recomienda enviar) |

> **Nota**: A diferencia del cobro (`/charge`), este endpoint solo acepta **UN pago por request**. Para abonar con varios métodos, enviar múltiples requests.

### 5.2) Reglas de validación

| Regla | Error | HTTP |
|---|---|---|
| Falta `Idempotency-Key` | `IDEMPOTENCY_KEY_REQUIRED` | 400 |
| `method: 'credit'` o método inválido | `PAYMENT_METHOD_NOT_SUPPORTED` | 422 |
| Venta no encontrada o de otro tenant | `SALE_NOT_FOUND` | 404 |
| Venta no está en status `CONFIRMED` | `SALE_NOT_CONFIRMABLE_FOR_PAYMENT` | 422 |
| Venta ya no tiene deuda (`debtCents = 0`) | `NO_OUTSTANDING_DEBT` | **422** |
| Monto mayor a la deuda actual | `PAYMENT_EXCEEDS_DEBT` | **422** |
| Idempotency replay | Devuelve respuesta previa | 200 |
| Idempotency conflicto / en vuelo | `IDEMPOTENCY_KEY_CONFLICT` / `IDEMPOTENCY_KEY_IN_FLIGHT` | 409 |

> **ATENCIÓN**: `NO_OUTSTANDING_DEBT` y `PAYMENT_EXCEEDS_DEBT` retornan **422** (no 409). El frontend debe manejar esto correctamente.

### 5.3) Respuesta `200 OK`

```json
{
  "saleId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "paidCents": 40000,
  "debtCents": 15000,
  "totalCents": 55000,
  "paymentStatus": "PARTIAL"
}
```

| Campo | Tipo | Significado |
|---|---|---|
| `saleId` | `string` (UUID) | ID de la venta |
| `paidCents` | `number` | Total pagado acumulado (recalculado desde el ledger) |
| `debtCents` | `number` | Deuda restante (`totalCents - paidCents`) |
| `totalCents` | `number` | Total original de la venta |
| `paymentStatus` | `string` | Estado actualizado: `PAID` / `PARTIAL` / `CREDIT` |

> Cuando `debtCents` llega a `0`, el `paymentStatus` cambia automáticamente a `PAID`.

### 5.4) Concurrencia segura

Si dos cajeros intentan cobrar la misma deuda al mismo tiempo, el backend usa `SELECT FOR UPDATE` para serializar los pagos. El segundo request verá los montos actualizados y será rechazado si excede la deuda restante.

---

## 6) Endpoint: Listar ventas confirmadas

```http
GET /sales
Authorization: Bearer <jwt>
```

### 6.1) Query params

| Param | Tipo | Default | Notas |
|---|---|---|---|
| `page` | `number` | `1` | `>= 1` |
| `limit` | `number` | `20` | `1..100` |
| `sortBy` | `'confirmedAt' \| 'totalCents' \| 'createdAt'` | `confirmedAt` | |
| `sortOrder` | `'asc' \| 'desc'` | `desc` | |
| `q` | `string` | — | Búsqueda libre (ver abajo) |
| `status` | `'DRAFT' \| 'CONFIRMED' \| 'CANCELED'` | — | Filtro opcional |
| `paymentStatus` | `'PAID' \| 'PARTIAL' \| 'CREDIT'` | — | Filtro por tab |
| `deliveryStatus` | `'PENDING' \| 'DELIVERED' \| 'NOT_APPLICABLE'` | — | Filtro por tab |
| `from` | ISO date | — | Rango inicio |
| `to` | ISO date | — | Rango fin |
| `cashierUserId` | UUID | — | Filtrar por cajero |
| `customerId` | UUID | — | Filtrar por cliente |

### 6.2) Búsqueda (`q`)

El parámetro `q` busca en:
- **Folio**: si `q` es numérico, busca por los últimos dígitos de la secuencia del folio (ej: `q=12` encuentra `A-202605-000012`).
- **Nombre de cliente**: `firstName` y `lastName`. Busca con normalización de acentos (ej: `q=publico` encuentra "Público en General").
- **Nombre de cajero**: campo `name` del usuario cajero.
- **Nombre de vendedor**: campo `name` del usuario vendedor.
- Tokens especiales: `publico`, `general`, `público` también incluyen ventas SIN cliente (`customerId = null`) que representan "Público en General".

### 6.3) Respuesta `200 OK`

```json
{
  "data": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "folio": "A-202605-000012",
      "status": "CONFIRMED",
      "paymentStatus": "PARTIAL",
      "deliveryStatus": "DELIVERED",
      "totalCents": 127000,
      "debtCents": 27000,
      "confirmedAt": "2026-05-06T14:43:00.000Z",
      "customer": { "id": "uuid", "name": "María López" },
      "cashier": { "id": "uuid", "name": "César Flores" },
      "seller": null,
      "paymentMethods": ["CASH", "CARD_DEBIT"]
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 50,
    "totalPages": 3
  },
  "counts": {
    "all": 50,
    "pendingPayments": 8,
    "notDelivered": 1
  }
}
```

### 6.4) Tipos de cada campo en `data[]`

| Campo | Tipo | Nullable | Descripción |
|---|---|---|---|
| `id` | `string` (UUID) | No | |
| `folio` | `string` | Sí (`null` para DRAFT) | Formato `A-YYYYMM-NNNNNN` |
| `status` | `string` | No | `'DRAFT'` / `'CONFIRMED'` |
| `paymentStatus` | `string` | Sí (`null` para DRAFT) | `'PAID'` / `'PARTIAL'` / `'CREDIT'` |
| `deliveryStatus` | `string` | No | `'PENDING'` / `'DELIVERED'` / `'NOT_APPLICABLE'` |
| `totalCents` | `number` | No | En centavos |
| `debtCents` | `number` | No | `totalCents - paidCents` |
| `confirmedAt` | `string` (ISO) | Sí (`null` para DRAFT) | |
| `customer` | `{ id, name }` | Sí | `null` = "Público en General" |
| `cashier` | `{ id, name }` | No | |
| `seller` | `{ id, name }` | Sí | `null` = sin vendedor asignado |
| `paymentMethods` | `string[]` | No | Métodos de pago únicos usados. `[]` si crédito puro sin pagos. Valores: `CASH`, `CARD_CREDIT`, `CARD_DEBIT`, `TRANSFER`. Ordenados por fecha del primer uso. |

### 6.5) Semántica de `counts`

Los contadores se calculan sobre la base `tenant + CONFIRMED + q + from/to + cashier/customer` **SIN aplicar** los filtros de `paymentStatus`/`deliveryStatus`/`status`:

| Contador | Significado |
|---|---|
| `all` | Total de ventas que coinciden con la búsqueda base |
| `pendingPayments` | Ventas donde `paymentStatus != PAID` (incluye PARTIAL y CREDIT) |
| `notDelivered` | Ventas donde `deliveryStatus != DELIVERED` |

Esto permite que los tabs siempre muestren totales reales sin importar qué filtro esté activo.

### 6.6) Mapeo para tabla frontend

| Columna | Campo | Formato |
|---|---|---|
| Venta | `folio` | Link a `/pos/sales/:id` |
| Fecha | `confirmedAt` | `DD/MM/YYYY HH:mm` o relativo |
| Cliente | `customer.name` | Si `null` → "Público en General" |
| Pago | `paymentStatus` | Badge: `Pagada` verde / `Parcial` amarillo / `Crédito` naranja |
| Método | `paymentMethods` | Iconos o tags por método. Si `[]` y `paymentStatus === 'CREDIT'` → mostrar "Crédito" |
| Total | `totalCents` | `$X,XXX.XX` (dividir entre 100) |
| Deuda | `debtCents` | `$X,XXX.XX` o vacío si `0` |
| Productos | `deliveryStatus` | Badge: `Entregados` verde / `Pendiente` amarillo |
| Cajero | `cashier.name` | |
| Vendedor | `seller.name` | Nombre o vacío |
| Canal | — | Fijo `"Punto de Venta"` |
| Factura | — | Columna vacía (fuera de alcance) |

### 6.7) Tabs del frontend

| Tab | Filtro query | Contador |
|---|---|---|
| **Todas** | Sin filtro adicional | `counts.all` |
| **Pagos Pendientes** | `paymentStatus=PARTIAL` o `paymentStatus=CREDIT` | `counts.pendingPayments` |
| **No Entregadas** | `deliveryStatus=PENDING` | `counts.notDelivered` |

---

## 7) Endpoint: Detalle de venta

```http
GET /sales/:id
Authorization: Bearer <jwt>
```

`:id` debe ser UUID válido (si no → `400 Validation failed (uuid is expected)`).
Venta no encontrada o de otro tenant → `404`.

### 7.1) Respuesta `200 OK`

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "folio": "A-202605-000012",
  "status": "CONFIRMED",
  "channel": "POS",
  "register": "Principal",
  "confirmedAt": "2026-05-06T14:43:00.000Z",
  "subtotalCents": 127000,
  "discountCents": 0,
  "totalCents": 127000,
  "paidCents": 100000,
  "debtCents": 27000,
  "changeDueCents": 0,
  "paymentStatus": "PARTIAL",
  "deliveryStatus": "DELIVERED",
  "customer": { "id": "uuid", "name": "María López" },
  "cashier": { "id": "uuid", "name": "César Flores" },
  "seller": null,
  "items": [
    {
      "productName": "Jean Recto",
      "variantName": "Talla 32",
      "imageUrl": "https://cdn.example.com/products/jean.jpg",
      "unitPriceCents": 85000,
      "quantity": 1,
      "discountCents": 0,
      "subtotalCents": 85000
    },
    {
      "productName": "Playera Básica",
      "variantName": null,
      "imageUrl": null,
      "unitPriceCents": 42000,
      "quantity": 1,
      "discountCents": 0,
      "subtotalCents": 42000
    }
  ],
  "payments": [
    {
      "method": "CASH",
      "amountCents": 60000,
      "tenderedCents": 60000,
      "changeCents": 0,
      "reference": null,
      "paidAt": "2026-05-06T14:43:00.000Z"
    },
    {
      "method": "CARD_DEBIT",
      "amountCents": 40000,
      "tenderedCents": 40000,
      "changeCents": 0,
      "reference": "VOUCHER-42",
      "paidAt": "2026-05-06T14:43:00.000Z"
    }
  ],
  "timeline": [
    {
      "type": "SALE_REGISTERED",
      "at": "2026-05-06T14:40:00.000Z",
      "actor": { "id": "cashier-1", "name": "César" },
      "register": "Caja secundaria"
    },
    {
      "type": "PAYMENT_RECEIVED",
      "at": "2026-05-06T14:43:00.000Z",
      "method": "CASH",
      "amountCents": 60000,
      "reference": null,
      "actor": { "id": "cashier-1", "name": "César" },
      "register": "Caja secundaria"
    },
    {
      "type": "PAYMENT_RECEIVED",
      "at": "2026-05-06T14:43:00.000Z",
      "method": "CARD_DEBIT",
      "amountCents": 40000,
      "reference": "VOUCHER-42",
      "actor": { "id": "cashier-1", "name": "César" },
      "register": "Caja secundaria"
    },
    {
      "type": "PRODUCTS_DELIVERED",
      "at": "2026-05-06T14:43:00.000Z",
      "actor": { "id": "cashier-1", "name": "César" },
      "register": "Caja secundaria"
    }
  ]
}
```

### 7.2) Campos del detalle

| Sección | Campo | Tipo | Nullable | Descripción |
|---|---|---|---|---|
| **Metadata** | `id` | `string` (UUID) | No | |
| | `folio` | `string` | Sí | `A-YYYYMM-NNNNNN` |
| | `status` | `string` | No | `'CONFIRMED'` |
| | `channel` | `string` | No | `'POS'` (fijo por ahora) |
| | `register` | `string` | No | `'Principal'` (fijo por ahora) |
| | `confirmedAt` | `string` (ISO) | Sí | |
| **Montos** | `subtotalCents` | `number` | No | |
| | `discountCents` | `number` | No | |
| | `totalCents` | `number` | No | |
| | `paidCents` | `number` | No | Acumulado de todos los pagos |
| | `debtCents` | `number` | No | `totalCents - paidCents` |
| | `changeDueCents` | `number` | No | Solo > 0 si hay cash y PAID |
| **Estados** | `paymentStatus` | `string` | Sí | `'PAID'` / `'PARTIAL'` / `'CREDIT'` |
| | `deliveryStatus` | `string` | No | `'PENDING'` / `'DELIVERED'` / `'NOT_APPLICABLE'` |
| **Actores** | `customer` | `{ id, name }` | Sí | `null` = "Público en General" |
| | `cashier` | `{ id, name }` | No | |
| | `seller` | `{ id, name }` | Sí | `null` = sin vendedor |

### 7.3) Items

| Campo | Tipo | Nullable | Descripción |
|---|---|---|---|
| `productName` | `string` | No | Nombre del producto (snapshot) |
| `variantName` | `string` | Sí | Nombre de la variante si aplica |
| `imageUrl` | `string` | Sí | URL de imagen (snapshot al momento del draft) |
| `unitPriceCents` | `number` | No | Precio unitario en centavos |
| `quantity` | `number` | No | Cantidad |
| `discountCents` | `number` | No | Descuento en centavos |
| `subtotalCents` | `number` | No | `unitPriceCents * quantity - discountCents` |

### 7.4) Pagos

| Campo | Tipo | Nullable | Descripción |
|---|---|---|---|
| `method` | `string` | No | **⚠️ MAYÚSCULAS**: `'CASH'`, `'CARD_CREDIT'`, `'CARD_DEBIT'`, `'TRANSFER'`, `'CREDIT'` |
| `amountCents` | `number` | No | Monto del pago |
| `tenderedCents` | `number` | No | = `amountCents` (por ahora siempre igual) |
| `changeCents` | `number` | No | Siempre `0` (el cambio vive en `Sale.changeDueCents`, no por pago) |
| `reference` | `string` | Sí | Referencia del pago (voucher, número de transferencia, etc.) |
| `paidAt` | `string` (ISO) | No | Timestamp del pago |

> **⚠️ CUIDADO con el case de `method`**: En los REQUEST bodies se envía en **minúsculas** (`cash`, `card_credit`). En la RESPUESTA del detalle viene en **MAYÚSCULAS** (`CASH`, `CARD_CREDIT`). Mapear consistentemente en el frontend.

### 7.5) Timeline

```ts
type TimelineEvent =
  | { type: 'SALE_REGISTERED'; at: string; actor: { id: string; name: string } | null; register: string }
  | { type: 'PAYMENT_RECEIVED'; at: string; method: string; amountCents: number; reference: string | null; actor: { id: string; name: string } | null; register: string }
  | { type: 'PRODUCTS_DELIVERED'; at: string; actor: { id: string; name: string } | null; register: string }
```

- `SALE_REGISTERED`: `{ at, actor, register }`
- `PAYMENT_RECEIVED`: `{ at, method, amountCents, reference, actor, register }`
- `PRODUCTS_DELIVERED`: `{ at, actor, register }` (**solo** si `deliveryStatus === 'DELIVERED'`)

**Regla actor (fallback):**
- Si el pago tiene `SalePayment.userId`, `actor` sale de ese usuario (quien registró ese pago).
- Si `SalePayment.userId` es `null` (pagos históricos), `actor` cae al cajero de la venta (`Sale.user`).

`register` es la etiqueta libre guardada en la venta (`Sale.register`).

**Orden**: siempre ascendente por `at`.

**Comportamiento clave:**
- Venta con pago completo al cobrar: 1 `SALE_REGISTERED` + N `PAYMENT_RECEIVED` (uno por método) + 1 `PRODUCTS_DELIVERED`.
- Venta a crédito puro o pendiente: 1 `SALE_REGISTERED` + 0 `PAYMENT_RECEIVED` (+ `PRODUCTS_DELIVERED` solo cuando aplica).
- Venta con cobros de deuda posteriores: cada `POST /sales/:id/payments` agrega un nuevo `PAYMENT_RECEIVED` al timeline.

> Compatibilidad: clientes FE que solo leen `type` y `at` siguen funcionando. Los campos nuevos son aditivos.

### 7.6) Layout recomendado del detalle

**Panel izquierdo:**
1. Badge de entrega (`deliveryStatus`)
2. Tabla de items con thumbnail (`imageUrl`), nombre, precio, cantidad, subtotal
3. Resumen de totales (subtotal, descuentos, total, pagado, deuda, cambio)
4. Historial (timeline) — del más reciente arriba al más antiguo abajo

**Sidebar derecho:**

| Campo | Valor |
|---|---|
| Estado | Badge `paymentStatus` + monto pagado/total |
| Deuda | `debtCents` formateado (mostrar solo si > 0) |
| Factura | Ignorar por ahora |
| Fecha | `confirmedAt` |
| Canal | `"Punto de Venta"` |
| Caja | `register` |
| Cajero | `cashier.name` |
| Vendedor | `seller.name` o "Asignar Vendedor" si `null` |

**Botón "Registrar Pago"**: Mostrar solo cuando `paymentStatus !== 'PAID'` (hay deuda). Al hacer click, abrir modal que envía `POST /sales/:id/payments`.

---

## 8) Errores esperables (referencia consolidada)

### Formato estándar de error

```json
{
  "statusCode": 422,
  "error": "CUSTOMER_REQUIRED_FOR_CREDIT",
  "message": "CUSTOMER_REQUIRED_FOR_CREDIT",
  "timestamp": "2026-05-13T20:00:00.000Z"
}
```

### 8.1) Errores de cobro (`POST /sales/drafts/:id/charge`)

| Código | HTTP | Cuándo pasa | Acción sugerida |
|---|---:|---|---|
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Falta header | Bug del frontend — siempre enviar |
| `AMBIGUOUS_PAYMENT_SHAPE` | 422 | Se envió `method` + `payments[]` | Bug del frontend — usar UN solo formato |
| `TOO_MANY_PAYMENTS` | 422 | Más de 5 entries en `payments[]` | Limitar UI a máximo 5 métodos |
| `CREDIT_METHOD_NOT_VALID_IN_MULTI` | 422 | `method: 'credit'` dentro de `payments[]` | Usar formato legacy para crédito puro |
| `REFERENCE_REQUIRED` | 422 | Tarjeta/transferencia sin referencia | Pedir referencia en UI |
| `PAYMENT_METHOD_NOT_SUPPORTED` | 422 | Método no reconocido | Bug del frontend |
| `INVALID_CREDIT_CHARGE` | 422 | Crédito con `amountCents > 0` | Bug del frontend |
| `PAYMENT_AMOUNT_INVALID` | 422 | No-cash sobre-paga, o negativo | Validar en frontend antes de enviar |
| `CUSTOMER_REQUIRED_FOR_CREDIT` | 422 | Pago parcial/crédito sin cliente | Pedir asignar cliente antes de cobrar |
| `SALE_NOT_FOUND` | 404 | Venta no existe o de otro tenant | Refrescar listado |
| `SALE_ALREADY_CONFIRMED` | 409 | Venta ya cobrada | Refrescar — probablemente otro cajero cobró |
| `PRICE_OUT_OF_DATE` | 409 | Precio cambió desde el draft | Mostrar alerta, recargar draft |
| `STOCK_INSUFFICIENT_AT_CONFIRM` | 409 | Sin stock suficiente | Mostrar alerta, mantener draft editable |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Reintento con payload distinto | Generar nuevo key |
| `IDEMPOTENCY_KEY_IN_FLIGHT` | 409 | Cobro en proceso | Esperar y reintentar |

### 8.2) Errores de cobro de deuda (`POST /sales/:id/payments`)

| Código | HTTP | Cuándo pasa | Acción sugerida |
|---|---:|---|---|
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Falta header | Bug del frontend |
| `PAYMENT_METHOD_NOT_SUPPORTED` | 422 | `method: 'credit'` o inválido | No mostrar 'credit' como opción |
| `SALE_NOT_FOUND` | 404 | Venta no existe o de otro tenant | Refrescar |
| `SALE_NOT_CONFIRMABLE_FOR_PAYMENT` | 422 | Venta no está CONFIRMED | Estado inesperado — refrescar |
| `NO_OUTSTANDING_DEBT` | **422** | Venta ya pagada completamente | Refrescar detalle — alguien ya pagó |
| `PAYMENT_EXCEEDS_DEBT` | **422** | Monto mayor a la deuda | Mostrar deuda actual, pedir re-ingreso |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Reintento con payload distinto | Generar nuevo key |
| `IDEMPOTENCY_KEY_IN_FLIGHT` | 409 | Pago en proceso | Esperar y reintentar |

### 8.3) Errores de consulta

| Código | HTTP | Cuándo pasa |
|---|---:|---|
| Validación DTO | 400 | Query params inválidos |
| UUID inválido | 400 | `:id` no es UUID válido |
| No encontrado | 404 | Venta no existe o de otro tenant |

---

## 9) Eventos de dominio (Transactional Outbox)

El backend ahora emite eventos durables por cada operación de dinero. Estos eventos están diseñados para integración futura con:
- 🖨️ Impresión de tickets (vía WebSocket bridge → Web Serial API)
- 📊 Contabilidad / Analytics
- 🔔 Notificaciones
- 🌐 Webhooks a sistemas externos

**Estado actual**: los eventos se persisten y despachan internamente. El WebSocket bridge para que el frontend los reciba en tiempo real **todavía no está implementado**. Esta sección documenta los payloads para cuando se implemente.

### 9.1) `sale.confirmed`

Se emite UNA vez cuando una venta se cobra exitosamente.

```json
{
  "saleId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "folio": "A-202605-000012",
  "tenantId": "tenant-uuid",
  "actorId": "cashier-user-uuid",
  "totalCents": 127000,
  "paidCents": 100000,
  "debtCents": 27000,
  "paymentStatus": "PARTIAL",
  "confirmedAt": "2026-05-06T14:43:00.000Z"
}
```

### 9.2) `sale.payment.received`

Se emite UNA vez por cada pago registrado. Tanto al cobrar (uno por cada entry del array) como al cobrar deuda.

```json
{
  "saleId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "tenantId": "tenant-uuid",
  "actorId": "cashier-user-uuid",
  "paymentId": "payment-uuid",
  "method": "cash",
  "amountCents": 60000,
  "reference": null,
  "occurredAt": "2026-05-06T14:43:00.000Z",
  "resultingPaidCents": 60000,
  "resultingDebtCents": 67000,
  "resultingPaymentStatus": "PARTIAL"
}
```

> **Nota**: `method` en los eventos viene en **minúsculas** (`cash`, `card_credit`), a diferencia de la respuesta del detalle que viene en MAYÚSCULAS.

Los campos `resultingPaidCents`, `resultingDebtCents` y `resultingPaymentStatus` son **acumulativos**: muestran el estado DESPUÉS de aplicar este pago. En un cobro multi-método, cada evento refleja el avance progresivo.

### 9.3) `sale.fully.paid`

Se emite cuando `debtCents` llega a `0` (ya sea al cobrar o al cobrar deuda).

```json
{
  "saleId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "tenantId": "tenant-uuid",
  "folio": "A-202605-000012",
  "totalCents": 127000,
  "paidAt": "2026-05-06T14:45:00.000Z"
}
```

### 9.4) Cuándo se usa cada evento (guía para el futuro)

| Evento | Caso de uso futuro |
|---|---|
| `sale.confirmed` | Imprimir ticket, notificar nueva venta, registrar en contabilidad |
| `sale.payment.received` | Actualizar saldo en pantalla, log de caja |
| `sale.fully.paid` | Cerrar cuenta del cliente, trigger de envío/entrega |

---

## 10) Guía de integración frontend

### 10.1) Flujo de cobro

```
┌─ Cajero arma draft ──────────────────────────────────────┐
│  (agregar items, descuentos, asignar cliente si aplica)  │
└──────────────────────┬───────────────────────────────────┘
                       ▼
┌─ Pantalla de cobro ──────────────────────────────────────┐
│  1. Mostrar total a cobrar                               │
│  2. Seleccionar método(s) de pago                        │
│     - Un solo método: formato legacy o array con 1 entry │
│     - Varios métodos: usar formato array (max 5)         │
│     - Crédito puro: formato legacy { method: "credit" }  │
│  3. Si tarjeta/transferencia → pedir referencia          │
│  4. Si pago parcial → verificar que haya cliente         │
│  5. Generar Idempotency-Key (UUID)                       │
│  6. POST /sales/drafts/:id/charge                        │
└──────────────────────┬───────────────────────────────────┘
                       ▼
┌─ Resultado ──────────────────────────────────────────────┐
│  200 → Mostrar comprobante (folio, totales, cambio)      │
│  409 PRICE_OUT_OF_DATE → Recargar draft, alertar cajero  │
│  409 STOCK_INSUFFICIENT → Alertar, mantener draft        │
│  422 CUSTOMER_REQUIRED → Pedir asignar cliente           │
│  409 IDEMPOTENCY_KEY_IN_FLIGHT → Reintentar en 2s       │
│  Timeout/red → Reintentar con MISMO Idempotency-Key     │
└──────────────────────────────────────────────────────────┘
```

### 10.2) Flujo de cobro de deuda

```
┌─ Detalle de venta con deuda (paymentStatus ≠ PAID) ─────┐
│  1. Mostrar botón "Registrar Pago"                       │
│  2. Al click → Modal con:                                │
│     - Deuda actual: debtCents                            │
│     - Selector de método (sin 'credit')                  │
│     - Input de monto (max = debtCents)                   │
│     - Input de referencia (si tarjeta/transferencia)     │
│  3. Generar Idempotency-Key (UUID)                       │
│  4. POST /sales/:id/payments                             │
│  5. Recargar detalle para ver pagos actualizados         │
└──────────────────────────────────────────────────────────┘
```

### 10.3) Flujo de listado

1. Al entrar al módulo Ventas → `GET /sales` (default: `page=1&limit=20&sortBy=confirmedAt&sortOrder=desc`).
2. Renderizar tabla con `data[]` y tabs con `counts`.
3. Al cambiar tab → agregar query param (`paymentStatus` o `deliveryStatus`).
4. Al buscar → enviar `q=<texto>`.
5. Al paginar → cambiar `page`.

### 10.4) Flujo de detalle

1. Click en folio de tabla → `GET /sales/:id`.
2. Renderizar panel izquierdo (items + totales + timeline) y sidebar (metadata).
3. Si `imageUrl` es `null` → placeholder de imagen.
4. Timeline: del más reciente arriba al más antiguo abajo.
5. Si `paymentStatus !== 'PAID'` → mostrar botón "Registrar Pago".

---

## 11) Ejemplos completos

### 11.1) Cobro efectivo exacto (formato legacy)

```json
// Request
POST /sales/drafts/abc123/charge
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000

{ "method": "cash", "amountCents": 55000 }

// Response 200
{
  "saleId": "abc123",
  "folio": "A-202605-000001",
  "subtotalCents": 60000,
  "discountCents": 5000,
  "totalCents": 55000,
  "paidCents": 55000,
  "debtCents": 0,
  "changeDueCents": 0,
  "paymentStatus": "PAID",
  "confirmedAt": "2026-05-13T20:00:00.000Z"
}
```

### 11.2) Cobro efectivo con cambio

```json
// Request
{ "method": "cash", "amountCents": 60000 }

// total = 55000 → Response
{
  "paidCents": 55000,
  "debtCents": 0,
  "changeDueCents": 5000,
  "paymentStatus": "PAID"
}
```

### 11.3) Crédito puro (sin pago)

```json
// Venta DEBE tener cliente asignado
// Request
{ "method": "credit", "amountCents": 0 }

// Response
{
  "paidCents": 0,
  "debtCents": 55000,
  "changeDueCents": 0,
  "paymentStatus": "CREDIT"
}
```

### 11.4) Multi-método: efectivo + tarjeta (pago completo)

```json
// Request
{
  "payments": [
    { "method": "cash", "amountCents": 30000 },
    { "method": "card_debit", "amountCents": 25000, "reference": "VOUCHER-42" }
  ]
}

// total = 55000 → Response
{
  "paidCents": 55000,
  "debtCents": 0,
  "changeDueCents": 0,
  "paymentStatus": "PAID"
}
```

### 11.5) Multi-método parcial (crea deuda)

```json
// Venta DEBE tener cliente asignado
// Request
{
  "payments": [
    { "method": "cash", "amountCents": 20000 },
    { "method": "transfer", "amountCents": 10000, "reference": "TRF-991" }
  ]
}

// total = 55000 → Response
{
  "paidCents": 30000,
  "debtCents": 25000,
  "changeDueCents": 0,
  "paymentStatus": "PARTIAL"
}
```

### 11.6) Multi-método con cash de sobra (cambio)

```json
// Request
{
  "payments": [
    { "method": "cash", "amountCents": 35000 },
    { "method": "card_credit", "amountCents": 25000, "reference": "AUTH-7744" }
  ]
}

// total = 55000 → Response
{
  "paidCents": 55000,
  "debtCents": 0,
  "changeDueCents": 5000,
  "paymentStatus": "PAID"
}
```

### 11.7) Cobro de deuda

```json
// Venta con debtCents = 25000
// Request
POST /sales/abc123/payments
Idempotency-Key: 660e8400-e29b-41d4-a716-446655440099

{ "method": "transfer", "amountCents": 25000, "reference": "TRF-002" }

// Response 200
{
  "saleId": "abc123",
  "paidCents": 55000,
  "debtCents": 0,
  "totalCents": 55000,
  "paymentStatus": "PAID"
}
```

### 11.8) Cobro de deuda parcial

```json
// Venta con debtCents = 25000
// Request
{ "method": "cash", "amountCents": 10000 }

// Response 200
{
  "saleId": "abc123",
  "paidCents": 40000,
  "debtCents": 15000,
  "totalCents": 55000,
  "paymentStatus": "PARTIAL"
}
```

### 11.9) Error: sobre-pago de deuda

```json
// Venta con debtCents = 15000
// Request
{ "method": "cash", "amountCents": 20000 }

// Response 422
{
  "statusCode": 422,
  "error": "PAYMENT_EXCEEDS_DEBT",
  "message": "PAYMENT_EXCEEDS_DEBT",
  "timestamp": "2026-05-13T20:10:00.000Z"
}
```

### 11.10) Listado con búsqueda por folio

```
GET /sales?q=12&page=1&limit=20
// Encuentra A-202605-000012
```

### 11.11) Listado tab "Pagos Pendientes"

```
GET /sales?paymentStatus=PARTIAL&page=1&limit=20
// También puedes usar paymentStatus=CREDIT para ver solo créditos puros
```

---

## 12) Valores por defecto fijos (fase actual)

| Campo | Valor fijo | Cuándo cambia |
|---|---|---|
| Canal | `"POS"` → "Punto de Venta" | Cuando se agreguen otros canales |
| Caja | `"Principal"` | Cuando se implementen múltiples cajas |
| Entrega | `"DELIVERED"` → "Entregados" | Cuando se implementen envíos |
| Vendedor | = Cajero o `null` | Cuando se implemente asignación de vendedor |
| Factura | Vacío | Cuando se implemente CFDI |

---

## 13) Checklist para frontend

### Cobro
- [ ] Enviar siempre `Idempotency-Key` (UUID).
- [ ] Decidir formato: usar `payments[]` para nuevas integraciones, legacy solo para backward compat.
- [ ] Validar que `card_credit`/`card_debit`/`transfer` incluyan `reference` antes de enviar.
- [ ] Limitar UI a máximo 5 métodos de pago simultáneos.
- [ ] No ofrecer `credit` como opción dentro de `payments[]` — solo en formato legacy.
- [ ] Si la suma de pagos < total → verificar que haya cliente asignado ANTES de enviar.
- [ ] Tratar errores por código de dominio (`error` field), no solo por HTTP status.
- [ ] Reintentar con mismo `Idempotency-Key` solo en timeout/error de red.
- [ ] Manejar `PRICE_OUT_OF_DATE` y `STOCK_INSUFFICIENT_AT_CONFIRM` como errores esperables.

### Cobro de deuda
- [ ] Mostrar botón "Registrar Pago" solo cuando `paymentStatus !== 'PAID'`.
- [ ] No permitir `method: 'credit'` en el modal de cobro de deuda.
- [ ] Limitar monto máximo al `debtCents` actual.
- [ ] Manejar `PAYMENT_EXCEEDS_DEBT` (422) — refrescar detalle para ver deuda actual.
- [ ] Manejar `NO_OUTSTANDING_DEBT` (422) — alguien más ya pagó.
- [ ] Después de pago exitoso, recargar detalle (`GET /sales/:id`) para ver timeline actualizado.
- [ ] Enviar siempre `Idempotency-Key`.

### Listado
- [ ] Usar `counts` para renderizar tabs (no contar localmente).
- [ ] Al cambiar tab, solo agregar filtro; no resetear búsqueda/paginación.
- [ ] Usar `pagination.totalPages` para navegación.
- [ ] Mostrar `debtCents` cuando > 0 (nueva columna vs Fase 1).

### Detalle
- [ ] Manejar `imageUrl: null` con placeholder.
- [ ] Renderizar `timeline` del más reciente arriba al más antiguo abajo.
- [ ] Timeline ahora puede tener MÚLTIPLES `PAYMENT_RECEIVED` (uno por cada pago).
- [ ] `seller: null` → "Asignar Vendedor" (no vacío).
- [ ] `customer: null` → "Público en General".
- [ ] `payments[].method` viene en MAYÚSCULAS — mapear para display.
- [ ] `payments[].reference` ahora es campo directo (puede ser `null`).

### General
- [ ] Renderizar montos en centavos con conversión segura a decimal (`/ 100`).
- [ ] Todos los endpoints requieren JWT + tenant activo.
- [ ] Los métodos en REQUEST van en minúsculas: `cash`, `card_credit`, `card_debit`, `transfer`, `credit`.
- [ ] Los métodos en RESPONSE de detalle vienen en MAYÚSCULAS: `CASH`, `CARD_CREDIT`, etc.
- [ ] Los métodos en EVENTOS de dominio van en minúsculas: `cash`, `card_credit`, etc.

---

## 14) Tabla resumen: case de `method` por contexto

| Contexto | Case | Ejemplo |
|---|---|---|
| Request body (`/charge`, `/payments`) | **minúsculas** | `"cash"`, `"card_credit"` |
| Response detalle (`payments[].method`) | **MAYÚSCULAS** | `"CASH"`, `"CARD_CREDIT"` |
| Eventos de dominio (outbox payloads) | **minúsculas** | `"cash"`, `"card_credit"` |
| Enum values en DB (Prisma) | **MAYÚSCULAS** | `CASH`, `CARD_CREDIT` |

---

## Changelog vs Fase 1

| Cambio | Fase 1 | Fase 2-4 (actual) |
|---|---|---|
| Body de `/charge` | Solo `{ method, amountCents }` | También `{ payments: [...] }` (max 5) |
| Crédito puro | `credit` con `amountCents: 0` | Sin cambio |
| Pago parcial | Soportado pero sin cobro posterior | `POST /sales/:id/payments` para cobrar deuda |
| Multi-método | No soportado | Hasta 5 métodos simultáneos en `payments[]` |
| `paymentStatus` | `PAID` / `PARTIAL` / `CREDIT` | Sin cambio de valores |
| `NO_OUTSTANDING_DEBT` HTTP | Documentado como 409 | **Corregido: es 422** |
| `PAYMENT_EXCEEDS_DEBT` HTTP | Documentado como 409 | **Corregido: es 422** |
| Timeline | 1 `PAYMENT_RECEIVED` por venta | N `PAYMENT_RECEIVED` (uno por pago) |
| `SalePayment.reference` | En `metadataJson` | Campo directo en DB y response |
| Nuevos errores | — | `AMBIGUOUS_PAYMENT_SHAPE`, `TOO_MANY_PAYMENTS`, `CREDIT_METHOD_NOT_VALID_IN_MULTI`, `REFERENCE_REQUIRED`, `SALE_NOT_CONFIRMABLE_FOR_PAYMENT` |
| Eventos de dominio | No existían | `sale.confirmed`, `sale.payment.received`, `sale.fully.paid` (outbox) |
### 3.7) Due date (nuevo)

- `POST /sales/drafts/:id/charge` ahora acepta `dueDate` opcional (ISO-8601) en el body.
- Si la venta confirmada queda con `paymentStatus !== PAID` y frontend NO envía `dueDate`, backend asigna default `confirmedAt + 15 días`.
- Si `paymentStatus === PAID`, `dueDate` queda en `null`.
- Si frontend envía `dueDate` y es menor a `confirmedAt`, retorna `422 INVALID_DUE_DATE`.

Nuevo endpoint:

```http
PATCH /sales/:id/due-date
Authorization: Bearer <jwt>
```

Body:

```json
{
  "dueDate": "2026-07-01T00:00:00.000Z"
}
```

También acepta clear explícito:

```json
{
  "dueDate": null
}
```

Reglas:

- Permiso: `update:Sale`.
- Solo ventas `CONFIRMED` con `paymentStatus !== PAID`.
- Si está `PAID`: `409 SALE_FULLY_PAID`.
- Si `dueDate < confirmedAt`: `422 INVALID_DUE_DATE`.
- Idempotente por overwrite (last-write-wins).

Respuestas `GET /sales/:id` y `GET /sales` incluyen ahora `dueDate: string | null`.

Ejemplo curl:

```bash
curl -X PATCH "$API_URL/sales/$SALE_ID/due-date" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dueDate":"2026-07-01T00:00:00.000Z"}'
```
