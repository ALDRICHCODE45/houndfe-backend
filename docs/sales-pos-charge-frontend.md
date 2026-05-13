# POS Ventas — Contrato Técnico Completo para Frontend

> Estado: **IMPLEMENTADO en backend (Fase 1 completa)**.
>
> Fuente de verdad: `src/sales/sales.controller.ts`, `src/sales/sales-query.controller.ts`, `src/sales/sales.service.ts`, `src/sales/dto/`, `src/shared/filters/domain-exception.filter.ts`, esquema/migraciones Prisma.

---

## 0) Qué se implementó (resumen ejecutivo)

Se habilitaron 3 capacidades nuevas del módulo de ventas POS:

1. **Cobrar draft** (`POST /sales/drafts/:id/charge`) — confirma venta con transacción atómica.
2. **Listar ventas confirmadas** (`GET /sales`) — paginado, filtros, búsqueda y contadores para tabs.
3. **Detalle de venta** (`GET /sales/:id`) — items con imagen, pagos, timeline automático y metadata.

### Alcance actual

- Pago simple (1 método por request).
- Canal fijo: `POS`. Caja fija: `Principal`.
- Entrega fija: `DELIVERED`. Timeline: `SALE_REGISTERED` + 0..N eventos `PAYMENT_RECEIVED` + `PRODUCTS_DELIVERED`.
- `imageUrl` capturado como snapshot al agregar item al draft.

### Todavía NO implementado

- Pagos múltiples (`payments[]`).
- Crédito completo (customer + dueDate + deuda).
- Múltiples cajas/canales.
- Facturación/CFDI.
- Acciones de venta (imprimir, PDF, etc).

---

## 1) Por qué se hizo así

1. **Integridad de caja**: no hay cobros parciales silenciosos.
2. **Integridad de inventario**: stock se descuenta SOLO al confirmar, en transacción atómica.
3. **Integridad de precio**: si cambió precio entre draft y cobro, se rechaza (`PRICE_OUT_OF_DATE`).
4. **All-or-nothing**: si falta stock en 1 ítem, se rechaza toda la venta.
5. **Resiliencia de red**: reintentos no duplican cobros (idempotencia).
6. **Aislamiento tenant**: todos los paths están tenant-scoped.

---

## 2) Permisos RBAC

| Endpoint | Permiso requerido |
|---|---|
| `POST /sales/drafts/:id/charge` | `update:Sale` |
| `GET /sales` | `read:Sale` |
| `GET /sales/:id` | `read:Sale` |

Todos requieren JWT válido + tenant activo.

---

## 3) Endpoint: Cobrar draft

```http
POST /sales/drafts/:id/charge
Authorization: Bearer <jwt>
Idempotency-Key: <uuid-o-string-unico>
```

### Body

```json
{
  "method": "cash",
  "amountCents": 55000
}
```

| Campo | Tipo | Requerido | Reglas |
|---|---|---|---|
| `method` | `'cash' \| 'card_credit' \| 'card_debit' \| 'transfer' \| 'credit'` | Sí | Pago simple (1 método) |
| `amountCents` | `number` entero | Sí | `>= 0` |

### Reglas de validación de pago

| Método | Regla |
|---|---|
| `credit` | debe ser exactamente `0` (venta a crédito pura) |
| `cash`, `card_credit`, `card_debit`, `transfer` | permiten parcial (`0 < amountCents < totalCents`) o total (`>= totalCents`) |
| cualquier método no `credit` con `amountCents = 0` | error |

### Respuesta `200 OK`

```json
{
  "saleId": "uuid",
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

| Campo | Significado |
|---|---|
| `subtotalCents` | Suma base antes de descuentos |
| `discountCents` | Diferencia `subtotal - total` |
| `totalCents` | Monto final a cobrar |
| `changeDueCents` | Cambio (solo efectivo; 0 en otros métodos) |
| `paymentStatus` | `PAID` \/ `PARTIAL` \/ `CREDIT` según total pagado |
| `folio` | Formato `A-YYYYMM-NNNNNN` (por tenant) |

---

## 4) Idempotencia (MUY importante)

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

### Recomendación

- Generar UUID por intento de cobro.
- Reusar ese key **solo para retries del mismo intento**.
- Si el usuario cambia monto/método, generar key nuevo.

---

## 5) Endpoint: Listar ventas confirmadas

```http
GET /sales
Authorization: Bearer <jwt>
```

### Query params

| Param | Tipo | Default | Notas |
|---|---|---|---|
| `page` | number | `1` | `>= 1` |
| `limit` | number | `20` | `1..100` |
| `sortBy` | `confirmedAt \| totalCents \| createdAt` | `confirmedAt` | |
| `sortOrder` | `asc \| desc` | `desc` | |
| `q` | string | — | Busca en folio, nombre de cliente, cajero, vendedor |
| `status` | `DRAFT \| CONFIRMED` | — | Filtro opcional |
| `paymentStatus` | `PAID \| PARTIAL \| CREDIT` | — | Filtro por tab |
| `deliveryStatus` | `PENDING \| DELIVERED \| NOT_APPLICABLE` | — | Filtro por tab |
| `from` | ISO date | — | Rango inicio `confirmedAt` |
| `to` | ISO date | — | Rango fin `confirmedAt` |
| `cashierUserId` | UUID | — | Filtrar por cajero |
| `customerId` | UUID | — | Filtrar por cliente |

### Respuesta `200 OK`

```json
{
  "data": [
    {
      "id": "uuid",
      "folio": "A-202605-000012",
      "status": "CONFIRMED",
      "paymentStatus": "PAID",
      "deliveryStatus": "DELIVERED",
      "totalCents": 127000,
      "debtCents": 0,
      "confirmedAt": "2026-05-06T14:43:00.000Z",
      "customer": { "id": "uuid", "name": "Empresa F." },
      "cashier": { "id": "uuid", "name": "cesar flores" },
      "seller": null
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
    "pendingPayments": 3,
    "notDelivered": 1
  }
}
```

### Semántica de `counts`

Los contadores se calculan sobre la base `tenant + CONFIRMED` **sin aplicar** los filtros de `paymentStatus`/`deliveryStatus`:

| Contador | Significado |
|---|---|
| `all` | Total de ventas confirmadas del tenant |
| `pendingPayments` | Ventas donde `paymentStatus != PAID` |
| `notDelivered` | Ventas donde `deliveryStatus != DELIVERED` |

Esto permite que los tabs siempre muestren totales reales sin importar qué filtro esté activo.

---

## 5.1) Endpoint: Registrar pago sobre venta confirmada

```http
POST /sales/:id/payments
Authorization: Bearer <jwt>
Idempotency-Key: <uuid-o-string-unico>
```

Body:

```json
{
  "method": "transfer",
  "amountCents": 2000,
  "reference": "TRF-001"
}
```

Reglas clave:
- `method` permitido: `cash | card_credit | card_debit | transfer` (`credit` NO permitido aquí).
- `amountCents >= 1` y `amountCents <= debtCents`.
- Si la venta no tiene deuda (`debtCents = 0` o `paymentStatus = PAID`) retorna error.
- Un mismo `Idempotency-Key` en operación `sale_payment` hace replay sin duplicar pagos.

### Mapeo para tabla frontend

| Columna | Campo | Formato |
|---|---|---|
| Venta | `folio` | Link a `/pos/sales/:id` |
| Fecha | `confirmedAt` | `DD/MM/YYYY HH:mm:ss` o relativo |
| Cliente | `customer.name` | Vacío si `null` (Público en General) |
| Pago | `paymentStatus` | Badge: `Pagada` verde / `Impaga` naranja / `Deuda` rojo |
| Total | `totalCents` | `$X,XXX.XX` (dividir entre 100) |
| Deuda | `debtCents` | `$X,XXX.XX` o vacío si `0` |
| Productos | `deliveryStatus` | Badge: `Entregados` verde / `No Entregados` rojo |
| Cajero | `cashier.name` | Nombre |
| Vendedor | `seller.name` | Nombre o vacío |
| Canal | — | Fijo `"Punto de Venta"` (por ahora) |
| Factura | — | Columna vacía (fuera de alcance) |

### Tabs del frontend

| Tab | Filtro query | Contador |
|---|---|---|
| **Todas** | Sin filtro adicional | `counts.all` |
| **Pagos Pendientes** | `paymentStatus=PARTIAL` o `paymentStatus=CREDIT` | `counts.pendingPayments` |
| **No Entregadas** | `deliveryStatus=PENDING` | `counts.notDelivered` |

---

## 6) Endpoint: Detalle de venta

```http
GET /sales/:id
Authorization: Bearer <jwt>
```

`:id` debe ser UUID válido (si no, `400`).

### Respuesta `200 OK`

```json
{
  "id": "uuid",
  "folio": "A-202605-000012",
  "status": "CONFIRMED",
  "channel": "POS",
  "register": "Principal",
  "confirmedAt": "2026-05-06T14:43:00.000Z",
  "subtotalCents": 127000,
  "discountCents": 0,
  "totalCents": 127000,
  "paidCents": 127000,
  "debtCents": 0,
  "changeDueCents": 0,
  "paymentStatus": "PAID",
  "deliveryStatus": "DELIVERED",
  "customer": { "id": "uuid", "name": "Empresa F." },
  "cashier": { "id": "uuid", "name": "cesar flores" },
  "seller": null,
  "items": [
    {
      "productName": "Jean Recto",
      "variantName": null,
      "imageUrl": "https://cdn.example.com/products/jean.jpg",
      "unitPriceCents": 17000,
      "quantity": 1,
      "discountCents": 0,
      "subtotalCents": 17000
    }
  ],
  "payments": [
    {
      "method": "CASH",
      "amountCents": 127000,
      "tenderedCents": 127000,
      "changeCents": 0,
      "reference": null,
      "paidAt": "2026-05-06T14:43:00.000Z"
    }
  ],
  "timeline": [
    {
      "type": "SALE_REGISTERED",
      "at": "2026-05-06T14:43:00.000Z"
    },
    {
      "type": "PAYMENT_RECEIVED",
      "at": "2026-05-06T14:43:00.000Z"
    },
    {
      "type": "PRODUCTS_DELIVERED",
      "at": "2026-05-06T14:43:00.000Z"
    }
  ]
}
```

### Campos del detalle

| Sección | Campos | Notas |
|---|---|---|
| **Metadata** | `id`, `folio`, `status`, `channel`, `register`, `confirmedAt` | `channel` = `POS` fijo; `register` = `Principal` fijo |
| **Montos** | `subtotalCents`, `discountCents`, `totalCents`, `paidCents`, `debtCents`, `changeDueCents` | Todo en centavos |
| **Estados** | `paymentStatus`, `deliveryStatus` | |
| **Actores** | `customer`, `cashier`, `seller` | `null` si no aplica |
| **Items** | `productName`, `variantName`, `imageUrl`, `unitPriceCents`, `quantity`, `discountCents`, `subtotalCents` | Snapshot inmutable al momento de cobro |
| **Pagos** | `method`, `amountCents`, `tenderedCents`, `changeCents`, `reference`, `paidAt` | `tenderedCents/changeCents` relevantes solo para cash |
| **Timeline** | `type`, `at` | Siempre `SALE_REGISTERED` y `PRODUCTS_DELIVERED`; `PAYMENT_RECEIVED` aparece una vez por cada pago real |

### Layout recomendado del detalle

**Panel izquierdo:**
1. Badge de entrega (`deliveryStatus`)
2. Tabla de items con thumbnail (`imageUrl`), nombre, precio, cantidad, subtotal
3. Resumen de totales (subtotal, descuentos, total)
4. Historial (timeline) — del más reciente arriba al más antiguo abajo

**Sidebar derecho:**

| Campo | Valor |
|---|---|
| Estado | Badge `paymentStatus` + total |
| Factura | Ignorar por ahora |
| Fecha | `confirmedAt` |
| Canal | `"Punto de Venta"` (derivado de `channel`) |
| Caja | `register` |
| Cajero | `cashier.name` |
| Vendedor | `seller.name` o "Asignar Vendedor" si `null` |

---

## 7) Errores esperables

Formato estándar:

```json
{
  "statusCode": 409,
  "error": "PRICE_OUT_OF_DATE",
  "message": "PRICE_OUT_OF_DATE",
  "timestamp": "2026-05-06T20:00:00.000Z"
}
```

### Errores de cobro

| Código | HTTP | Cuándo pasa |
|---|---:|---|
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Falta header `Idempotency-Key` |
| `SALE_NOT_FOUND` | 404 | Venta no existe o no pertenece al actor/tenant |
| `SALE_ALREADY_CONFIRMED` | 409 | Intento de cobrar una venta no-DRAFT |
| `PRICE_OUT_OF_DATE` | 409 | Precio vigente difiere del snapshot del draft |
| `STOCK_INSUFFICIENT_AT_CONFIRM` | 409 | Algún item sin stock suficiente al cobrar |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Mismo key con payload distinto |
| `IDEMPOTENCY_KEY_IN_FLIGHT` | 409 | Key en ejecución concurrente |
| `PAYMENT_METHOD_NOT_SUPPORTED` | 422 | Método no soportado |
| `PAYMENT_AMOUNT_INSUFFICIENT` | 422 | Monto menor al total |
| `PAYMENT_AMOUNT_INVALID` | 422 | No-efectivo con monto mayor al total |
| `INVALID_CREDIT_CHARGE` | 422 | `method=credit` con `amountCents > 0` |
| `CUSTOMER_REQUIRED_FOR_CREDIT` | 422 | Venta parcial o crédito sin cliente |

### Errores de cobro de deuda (`POST /sales/:id/payments`)

| Código | HTTP | Cuándo pasa |
|---|---:|---|
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Falta header `Idempotency-Key` |
| `SALE_NOT_FOUND` | 404 | Venta no existe o es de otro tenant |
| `PAYMENT_METHOD_NOT_SUPPORTED` | 422 | `method=credit` o método inválido |
| `NO_OUTSTANDING_DEBT` | 409 | Venta sin deuda pendiente |
| `PAYMENT_EXCEEDS_DEBT` | 409 | `amountCents` mayor a deuda actual |

### Errores de consulta

| Código | HTTP | Cuándo pasa |
|---|---:|---|
| Validación DTO | 400 | Query params inválidos (tipo, rango, enum) |
| UUID inválido | 400 | `:id` no es UUID válido |
| No encontrado | 404 | Venta no existe o pertenece a otro tenant |

---

## 8) Guía de integración frontend

### Flujo de cobro

1. Usuario arma draft como hoy (`/sales/drafts`, items, descuentos, override).
2. Al tocar **Cobrar**:
   - Calcular/mostrar total actual.
   - Pedir método + monto.
   - Generar `Idempotency-Key` (UUID).
3. Enviar `POST /sales/drafts/:id/charge`.
4. Si `200`, cerrar tab draft y mostrar comprobante con `folio` + `confirmedAt`.
5. Si `PRICE_OUT_OF_DATE`, recargar draft y pedir confirmación al cajero.
6. Si `STOCK_INSUFFICIENT_AT_CONFIRM`, avisar y mantener draft editable.
7. Si timeout/red, reintentar con el **mismo** `Idempotency-Key`.

### Flujo de listado

1. Al entrar al módulo Ventas, llamar `GET /sales` (default: `page=1&limit=20&sortBy=confirmedAt&sortOrder=desc`).
2. Renderizar tabla con datos de `data[]` y tabs con `counts`.
3. Al cambiar tab, agregar query param correspondiente (`paymentStatus` o `deliveryStatus`).
4. Al buscar, enviar `q=<texto>` (busca en folio, cliente, cajero, vendedor).
5. Al paginar, cambiar `page`.

### Flujo de detalle

1. Click en folio de tabla → `GET /sales/:id`.
2. Renderizar panel izquierdo (items + totales + timeline) y sidebar derecho (metadata).
3. Si `imageUrl` es `null`, mostrar placeholder de imagen.
4. Timeline se muestra del más reciente arriba al más antiguo abajo.

---

## 9) Valores por defecto fijos (fase actual)

| Campo | Valor fijo | Cuándo cambia |
|---|---|---|
| Canal | `"POS"` → "Punto de Venta" | Cuando se agreguen otros canales |
| Caja | `"Principal"` | Cuando se implementen múltiples cajas |
| Entrega | `"DELIVERED"` → "Entregados" | Cuando se implementen envíos |
| Timeline | 3 eventos automáticos | Cuando existan envíos reales |
| Vendedor | = Cajero o `null` | Cuando se implemente asignación de vendedor |
| Factura | Vacío | Cuando se implemente CFDI |

---

## 10) Ejemplos rápidos

### 10.1 Cobro efectivo con cambio

```json
// Request
{ "method": "cash", "amountCents": 60000 }

// Si total = 55000 → changeDueCents = 5000
```

### 10.2 Cobro tarjeta exacta

```json
// Request
{ "method": "card_debit", "amountCents": 55000 }

// Si mandás 56000 → PAYMENT_AMOUNT_INVALID (422)
```

### 10.3 Listado con búsqueda

```
GET /sales?q=jean&page=1&limit=20
```

### 10.4 Listado tab "Pagos Pendientes"

```
GET /sales?paymentStatus=PARTIAL&page=1&limit=20
```

### 10.5 Detalle de venta

```
GET /sales/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

---

## 11) Checklist para frontend

### Cobro
- [ ] Enviar siempre `Idempotency-Key`.
- [ ] Tratar `409` por código de dominio (no solo por status HTTP).
- [ ] Reintentar con mismo key solo si es el mismo intento lógico.
- [ ] Manejar `PRICE_OUT_OF_DATE` y `STOCK_INSUFFICIENT_AT_CONFIRM` como errores de negocio esperables.

### Listado
- [ ] Usar `counts` para renderizar tabs (no contar localmente).
- [ ] Al cambiar tab, solo agregar filtro; no resetear búsqueda/paginación.
- [ ] Usar `pagination.totalPages` para navegación.

### Detalle
- [ ] Manejar `imageUrl: null` con placeholder.
- [ ] Renderizar `timeline` del más reciente arriba al más antiguo abajo.
- [ ] `seller: null` mostrar "Asignar Vendedor" (no vacío).
- [ ] `customer: null` mostrar "Público en General" en contexto de tabla.

### General
- [ ] Renderizar montos en centavos con conversión segura a decimal (`/ 100`).
- [ ] Todos los endpoints requieren JWT + tenant activo.
