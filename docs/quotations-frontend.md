# Quotations (Cotizaciones) — Frontend Integration Guide

**Feature**: Cotizaciones para clientes  
**Módulo**: `src/quotations/` — nuevo bounded context  
**Fecha**: 2026-08-01  
**Backend**: `houndfe-backend` — NestJS + Prisma + PostgreSQL  
**Branch**: `feat/quotations` → `main`

---

## 1. Resumen de endpoints

| Método   | Endpoint                                              | Permiso              | Descripción                                  |
| -------- | ----------------------------------------------------- | -------------------- | -------------------------------------------- |
| `POST`   | `/quotations/drafts`                                  | `create:Quotation`   | Abrir nueva cotización (opcional: customerId) |
| `GET`    | `/quotations`                                         | `read:Quotation`     | Listar cotizaciones (paginado, filtrable)    |
| `GET`    | `/quotations/:id`                                     | `read:Quotation`     | Detalle de una cotización                    |
| `GET`    | `/quotations/:id/pdf?format=quotation-a4`             | `read:Quotation`     | Descargar/preview PDF                        |
| `PUT`    | `/quotations/drafts/:id/customer`                     | `update:Quotation`   | Asignar cliente (auto-seed price list)       |
| `PUT`    | `/quotations/drafts/:id/seller`                       | `update:Quotation`   | Asignar vendedor (solo DRAFT)                |
| `PUT`    | `/quotations/drafts/:id/price-list`                   | `update:Quotation`   | Cambiar lista de precios                     |
| `POST`   | `/quotations/drafts/:id/items`                        | `update:Quotation`   | Agregar producto                             |
| `PATCH`  | `/quotations/drafts/:id/items/:itemId/quantity`       | `update:Quotation`   | Cambiar cantidad                             |
| `DELETE` | `/quotations/drafts/:id/items/:itemId`                | `update:Quotation`   | Quitar producto                              |
| `PATCH`  | `/quotations/drafts/:id/items/:itemId/price`          | `update:Quotation`   | Sobrescribir precio manual                   |
| `PUT`    | `/quotations/drafts/:id/manual-promotions/:promoId`   | `update:Quotation`   | Aplicar promoción MANUAL                     |
| `DELETE` | `/quotations/drafts/:id/manual-promotions/:promoId`   | `update:Quotation`   | Quitar promoción MANUAL                      |
| `POST`   | `/quotations/drafts/:id/promotions/:promoId/veto`     | `update:Quotation`   | Vetar promoción AUTOMATIC                    |
| `DELETE` | `/quotations/drafts/:id/promotions/:promoId/veto`     | `update:Quotation`   | Re-aceptar promo vetada (opt-in)             |
| `PATCH`  | `/quotations/drafts/:id/expiry`                       | `update:Quotation`   | Poner/quitar fecha de expiración             |
| `PATCH`  | `/quotations/drafts/:id/notes`                        | `update:Quotation`   | Persistir notas para el cliente (280 max)    |
| `PATCH`  | `/quotations/drafts/:id/tax-rate`                     | `update:Quotation`   | **Deprecado** (`Deprecation: true`) — ver 3.18 |
| `POST`   | `/quotations/drafts/:id/send`                         | `update:Quotation`   | Enviar cotización por email + marcar SENT    |
| `POST`   | `/quotations/drafts/:id/cancel`                       | `update:Quotation`   | Cancelar cotización                          |
| `DELETE` | `/quotations/:id`                                     | `delete:Quotation`   | Eliminar cotización (solo DRAFT/CANCELLED)   |
| `POST`   | `/quotations/from-sale/:saleId`                       | `create:Quotation` + `delete:Sale` | Venta borrador del POS → cotización DRAFT (la venta se descarta) — ver 3.20 |
| `POST`   | `/quotations/:id/convert-to-sale`                     | `create:Sale` + `update:Quotation` | Cotización DRAFT/SENT → venta borrador del POS — ver 3.20 |

Todos requieren JWT (Bearer token). El tenant se determina del token automáticamente.

---

## 2. Ciclo de vida

```
DRAFT ──send()──▶ SENT ──(expiresAt < now)──▶ EXPIRED
  │                  │
  ├──cancel()──▶ CANCELLED ◀──cancel()──┘
  │                  │
  └─convert-to-sale──┴──▶ CONVERTED_TO_SALE   (saleId = venta borrador creada)
```

- **DRAFT**: editable. Se pueden agregar/quitar items, cambiar precios, promos, price list, expiry.
- **SENT**: solo lectura. El PDF ya fue enviado al cliente. No se puede editar.
- **EXPIRED**: transición automática (lazy) cuando `expiresAt` ya pasó. Solo lectura. Ojo: también un **DRAFT** con `expiresAt` vencido se lee como `effectiveStatus: 'EXPIRED'`.
- **CANCELLED**: terminal. No se puede reactivar.
- **CONVERTED_TO_SALE** (nuevo): terminal. La cotización (DRAFT o SENT, no vencida) se convirtió en una venta borrador del POS; `saleId` apunta a esa venta. Solo lectura: no se edita, no se envía, no se cancela (`QUOTATION_ALREADY_CONVERTED`, cancelá la venta) y no se elimina (`QUOTATION_CANNOT_DELETE`). La expiración lazy **nunca** la pasa a `EXPIRED`. El PDF sigue disponible. Si después se borra esa venta borrador en el POS, queda `CONVERTED_TO_SALE` con `saleId: null` y se puede volver a convertir (o cancelar). Detalle completo: [frontend-handoff/23-quotation-sale-conversion.md](frontend-handoff/23-quotation-sale-conversion.md).

---

## 3. Endpoints — detalle completo

### 3.1 `POST /quotations/drafts` — Abrir cotización

Abre una nueva cotización en estado `DRAFT`.

**Request**:
```json
{
  "customerId": "550e8400-e29b-41d4-a716-446655440000"  // opcional
}
```

**Response** `201 Created`:
```json
{
  "id": "a1b2c3d4-...",
  "customerId": "550e8400-...",
  "customer": {
    "id": "550e8400-...",
    "firstName": "María",
    "lastName": "García",
    "email": "maria@test.com"
  },
  "globalPriceListId": "pl-uuid-...",
  "status": "DRAFT",
  "expiresAt": null,
  "subtotalCents": 0,
  "discountCents": 0,
  "totalCents": 0,
  "items": [],
  "appliedPromotions": [],
  "vetoedPromotionIds": [],
  "optedInManualPromotionIds": [],
  "createdAt": "2026-08-01T20:00:00.000Z",
  "updatedAt": "2026-08-01T20:00:00.000Z"
}
```

**Comportamiento**:
- Si se pasa `customerId`, el backend auto-asigna la lista de precios del cliente (`customer.globalPriceListId`).
- Si no se pasa `customerId`, `globalPriceListId` queda en `null` y los precios se resuelven de la lista global por defecto.

---

### 3.2 `GET /quotations` — Listar cotizaciones

**Query params**:

| Parámetro    | Tipo     | Default | Descripción                                |
| ------------ | -------- | ------- | ------------------------------------------ |
| `page`       | number   | `1`     | Página                                     |
| `limit`      | number   | `20`    | Items por página                           |
| `status`     | string   | —       | Filtrar por estado (CSV, OR): `DRAFT`,`SENT`,`EXPIRED`,`CANCELLED`,`CONVERTED_TO_SALE` |
| `customerId` | UUID     | —       | Filtrar por cliente                        |
| `search`     | string   | —       | Búsqueda por nombre de cliente             |
| `sortBy`     | string   | `createdAt` | Campo de orden                         |
| `sortOrder`  | string   | `desc`  | `asc` o `desc`                             |

**Response** `200`:
```json
{
  "data": [
    {
      "id": "a1b2c3d4-...",
      "customerId": "...",
      "customer": { "id": "...", "firstName": "María", "lastName": "García", "email": "maria@test.com" },
      "status": "DRAFT",
      "expiresAt": "2026-08-15T00:00:00.000Z",
      "subtotalCents": 15000,
      "totalCents": 13500,
      "discountCents": 1500,
      "items": [ /* array de QuotationItemResponseDto */ ],
      "appliedPromotions": [ /* array de promos aplicadas */ ],
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 5,
    "totalPages": 1
  }
}
```

**Nota**: Las cotizaciones `SENT` con `expiresAt` en el pasado se convierten automáticamente a `EXPIRED` al leerse (transición lazy, sin cron job).

---

### 3.3 `GET /quotations/:id` — Detalle

Igual forma que el item de lista, pero con todos los campos. Aplica lazy `EXPIRED` en el read.

**Response** `200`: igual que el item dentro de `data[]` en 3.2.

**Errores**:
| Código | Error | Causa |
|--------|-------|-------|
| `404` | `Quotation not found` | ID no existe o no pertenece al tenant |

---

### 3.4 `GET /quotations/:id/pdf?format=quotation-a4` — PDF

Renderiza el PDF de la cotización. Funciona en **cualquier estado** (DRAFT, SENT, EXPIRED, CANCELLED, CONVERTED_TO_SALE) — el vendedor puede previsualizar antes de enviar.

**Query params**:
| Parámetro | Tipo   | Default          | Descripción                                |
| --------- | ------ | ---------------- | ------------------------------------------ |
| `format`  | string | `quotation-a4`   | Por ahora solo `quotation-a4` es válido    |

**Response**: `200` con `Content-Type: application/pdf` y `Content-Disposition: inline; filename="cotizacion-{id}.pdf"`.

**Errores**:
| Código | Mensaje | Causa |
|--------|---------|-------|
| `400` | `INVALID_FORMAT` | Formato no soportado |
| `404` | `Quotation not found` | ID no existe |
| `401` | — | No autenticado |
| `403` | — | Sin permiso `read:Quotation` |

---

### 3.5 `PUT /quotations/drafts/:id/customer` — Asignar cliente

**Request**:
```json
{
  "customerId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response** `200`: cotización actualizada (mismo shape que detalle).

**Comportamiento**: Auto-asigna `globalPriceListId` desde `customer.globalPriceListId`. Si la cotización ya tenía un `globalPriceListId` seteado explícitamente, **NO** lo sobreescribe (respeta la elección explícita del cajero).

**Errores**:
| Código | Mensaje | Causa |
|--------|---------|-------|
| `404` | `Customer not found` | El customerId no existe |
| `422` | `QUOTATION_NOT_DRAFT` | Solo se puede editar en estado DRAFT |
| `404` | `Quotation not found` | ID de cotización no existe |

---

### 3.6 `PUT /quotations/drafts/:id/seller` — Asignar vendedor

Asigna un vendedor distinto al usuario autenticado (la persona que trajo al cliente puede diferir de quien crea/envía la cotización). Solo permitido mientras la cotización esté en `DRAFT`. El vendedor se muestra en el email **y** en el PDF A4.

**Request**:
```json
{
  "sellerUserId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response** `200`: cotización actualizada (mismo shape que detalle). El campo `seller` del response ahora trae `{ id, name }` con el nombre a mostrar del vendedor:

```json
{
  "id": "a1b2c3d4-...",
  "sellerUserId": "550e8400-e29b-41d4-a716-446655440000",
  "seller": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Pedro Pérez"
  },
  "status": "DRAFT"
}
```

**Reglas**:
- Cualquier usuario del tenant puede ser elegido (se valida que exista).
- `sellerUserId` debe ser un UUID válido (`@IsUUID`), si no → `400 Bad Request` por validación de DTO.
- El `name` del `seller` cae al `sellerUserId` crudo si el usuario no se encuentra al resolver el wire (nunca renderiza una fila "Vendedor" vacía).

**Errores**:
| Código | Mensaje | Causa |
|--------|---------|-------|
| `404` | `Quotation not found` | ID de cotización no existe |
| `404` | `SELLER_NOT_FOUND` | El `sellerUserId` no existe en el tenant |
| `422` | `QUOTATION_NOT_DRAFT` | Solo se puede cambiar en estado DRAFT |

---

### 3.7 `PUT /quotations/drafts/:id/price-list` — Cambiar lista de precios

**Request**:
```json
{
  "globalPriceListId": "pl-uuid-..."
}
```

Para **quitar** la lista de precios y volver a la default global:
```json
{
  "globalPriceListId": null
}
```

**Response** `200`: cotización actualizada con TODOS los items re-preciados según la nueva lista. Items con precio manual (`priceSource = 'CUSTOM'`) no se tocan.

**Errores**:
| Código | Mensaje | Causa |
|--------|---------|-------|
| `404` | `Price list not found` | ID de price list no existe |
| `422` | `QUOTATION_NOT_DRAFT` | Solo DRAFT |
| `404` | `Quotation not found` | ID no existe |

---

### 3.8 `POST /quotations/drafts/:id/items` — Agregar producto

**Request**:
```json
{
  "productId": "prod-uuid-...",
  "variantId": "var-uuid-...",
  "quantity": 3
}
```

| Campo       | Tipo   | Requerido | Descripción                    |
| ----------- | ------ | --------- | ------------------------------ |
| `productId` | UUID   | ✅        | ID del producto                |
| `variantId` | UUID   | ❌        | ID de la variante (si aplica)  |
| `quantity`  | number | ✅        | Cantidad (mínimo 1)            |

**Response** `201`: cotización actualizada con el item agregado y totales recalculados.

**Comportamiento**:
- El precio se resuelve de la lista de precios activa (con tiers si aplica).
- Si la cotización tiene promos automáticas, se re-evalúan al agregar el item.
- **NO hay validación de stock** — la cotización es una promesa, no una reserva.

**Errores**:
| Código | Mensaje | Causa |
|--------|---------|-------|
| `400` | `Invalid quantity` | quantity < 1 |
| `404` | `Product not found` | productId o variantId no existe |
| `422` | `QUOTATION_NOT_DRAFT` | Solo DRAFT |

---

### 3.9 `PATCH /quotations/drafts/:id/items/:itemId/quantity` — Cambiar cantidad

**Request**:
```json
{
  "quantity": 5
}
```

**Response** `200`: cotización actualizada con el item modificado y totales recalculados.

**Errores**:
| Código | Mensaje | Causa |
|--------|---------|-------|
| `400` | `Invalid quantity` | quantity < 1 |
| `404` | `Item not found` | itemId no pertenece a la cotización |
| `422` | `QUOTATION_NOT_DRAFT` | Solo DRAFT |

---

### 3.10 `DELETE /quotations/drafts/:id/items/:itemId` — Quitar producto

**Response** `200`: cotización actualizada con el item removido y totales recalculados.

---

### 3.11 `PATCH /quotations/drafts/:id/items/:itemId/price` — Sobrescribir precio

**Request**:
```json
{
  "unitPriceCents": 19900
}
```

**Response** `200`: cotización con el item marcado como `priceSource: 'CUSTOM'`. Este item **no se re-preciará** en recomputes futuros (cambio de price list, cambio de cantidad).

**Errores**:
| Código | Mensaje | Causa |
|--------|---------|-------|
| `400` | `unitPriceCents must be >= 0` | Precio negativo |
| `404` | `Item not found` | itemId no pertenece |
| `422` | `QUOTATION_NOT_DRAFT` | Solo DRAFT |

---

### 3.12 Promociones manuales

#### `PUT /quotations/drafts/:id/manual-promotions/:promoId` — Aplicar

Aplica una promoción de tipo `MANUAL` a la cotización. El `promoId` debe ser una promoción existente con `method: 'MANUAL'`.

**Response** `200`: cotización con la promo aplicada y totales recalculados.

#### `DELETE /quotations/drafts/:id/manual-promotions/:promoId` — Quitar

Quita una promo MANUAL previamente aplicada. Idempotente (no falla si ya estaba quitada).

**Errores**:
| Código | Mensaje | Causa |
|--------|---------|-------|
| `404` | `Promotion not found` | promoId no existe |
| `400` | `Promotion is not MANUAL` | Solo promos MANUAL se aplican así |
| `422` | `QUOTATION_NOT_DRAFT` | Solo DRAFT |

---

### 3.13 Promociones automáticas (veto/opt-in)

#### `POST /quotations/drafts/:id/promotions/:promoId/veto` — Vetar

Excluye una promoción `AUTOMATIC` de la evaluación. Útil cuando el vendedor no quiere que se aplique cierta promo automática.

**Response** `200`: la promo se agrega a `vetoedPromotionIds` y se dispara un recompute.

#### `DELETE /quotations/drafts/:id/promotions/:promoId/veto` — Re-activar (opt-in)

Re-acepta una promo automática que había sido vetada. La promo vuelve a evaluarse en el siguiente recompute.

**Errores**:
| Código | Mensaje | Causa |
|--------|---------|-------|
| `404` | `Promotion not found` | promoId no existe |
| `422` | `QUOTATION_NOT_DRAFT` | Solo DRAFT |

---

### 3.14 `PATCH /quotations/drafts/:id/expiry` — Fecha de expiración

**Request** (setear):
```json
{
  "expiresAt": "2026-08-15T23:59:59.000Z"
}
```

**Request** (quitar — sin expiración):
```json
{
  "expiresAt": null
}
```

**Response** `200`: cotización actualizada.

**Comportamiento**:
- Si `expiresAt` es `null`, la cotización **nunca expira**.
- Si `expiresAt` está seteado, cuando la fecha pase, la cotización transiciona automáticamente a `EXPIRED` al ser leída (no hay cron job).

---

### 3.15 `POST /quotations/drafts/:id/send` — Enviar por email

**Query params**:
| Parámetro | Tipo    | Default | Descripción                                       |
| --------- | ------- | ------- | ------------------------------------------------- |
| `email`   | string  | `true`  | `true` = enviar email, `false` = solo marcar SENT |

**Comportamiento (email=true)**:
1. Renderiza el PDF en memoria
2. Envía email al `customer.email` con el PDF adjunto vía Resend
3. Si Resend responde OK → transiciona a `SENT`
4. Si Resend falla → se queda en `DRAFT` y devuelve `502`

**Comportamiento (email=false)**:
1. Solo transiciona a `SENT` (para entrega de PDF en persona)

**Response** `200`: cotización en estado `SENT`.

**Errores**:
| Código | Código interno | Causa |
|--------|---------------|-------|
| `422` | `QUOTATION_NOT_DRAFT` | La cotización no está en DRAFT |
| `422` | `QUOTATION_HAS_NO_ITEMS` | La cotización no tiene productos — no se puede enviar vacía |
| `422` | `QUOTATION_CUSTOMER_HAS_NO_EMAIL` | La cotización tiene cliente pero no tiene email — no se puede enviar |
| `404` | — | Cotización no encontrada |
| `502` | — | Falló el envío del email (Resend) — la cotización sigue en DRAFT, reintentá |

**IMPORTANTE**: El envío es **atómico**. Si el email falla, el estado NO cambia a SENT. Podés reintentar el `POST` sin riesgo de estado inconsistente.

---

### 3.16 `POST /quotations/drafts/:id/cancel` — Cancelar

**Request**:
```json
{
  "cancelReason": "CUSTOMER_REQUEST"
}
```

**CancelReason válidos**:
| Valor              | Significado                        |
| ------------------ | ---------------------------------- |
| `CUSTOMER_REQUEST` | El cliente pidió cancelar          |
| `PRICE_OBJECTION`  | El cliente rechazó por precio      |
| `EXPIRED`          | La cotización expiró sin respuesta |
| `OTHER`            | Otro motivo                        |

**Response** `200`: cotización en estado `CANCELLED`.

**Errores**:
| Código | Mensaje | Causa |
|--------|---------|-------|
| `200` | — | Ya está cancelada: idempotente, devuelve la cotización sin error |
| `422` | `QUOTATION_ALREADY_CONVERTED` | La cotización ya es una venta (`CONVERTED_TO_SALE` con `saleId`); el body trae `saleId`. Cancelá la venta. |
| `404` | — | Cotización no encontrada |

---

### 3.17 `PATCH /quotations/drafts/:id/notes` — Notas para el cliente

Persiste las notas visibles al cliente en el PDF/email. Se guardan en el backend (no en localStorage).

**Request**:
```json
{
  "customerNotes": "Entrega en sucursal Norte. Contactar a Juan al 555-1234."
}
```

**Limpiar notas**:
```json
{
  "customerNotes": null
}
```

**Response** `200`: `QuotationResponseDto` completo con `customerNotes` actualizado.

**Reglas**:
- Máximo **280 caracteres**.
- Solo funciona en estado `DRAFT`.

**Errores**:
| HTTP | Código | Causa |
|------|--------|-------|
| `400` | `NOTES_TOO_LONG` | Más de 280 caracteres |
| `422` | `QUOTATION_NOT_DRAFT` | No está en DRAFT |
| `404` | — | Cotización no encontrada |

---

### 3.18 `PATCH /quotations/drafts/:id/tax-rate` — **DEPRECADO** (IVA por producto)

**Regla para el FE: no uses este endpoint ni muestres un selector de tasa de IVA.** El IVA de una cotización ya no es una tasa global: sale de **cada producto** (snapshot por línea). El endpoint sigue existiendo solo por compatibilidad y se va a eliminar.

Qué hace hoy (código: `quotations.controller.ts` `setTaxRate`, commits `e5c40988` y `e30c8a93`):

- Responde con el header **`Deprecation: true`**. Si tu cliente HTTP lo ve, es una llamada a migrar.
- Solo en `DRAFT`. Guarda la columna legacy `Quotation.taxRate` y **nada más**: no cambia precios, `subtotalCents`, `discountCents`, `totalCents`, `ivaBreakdown[]` ni el renglón de IVA del PDF.
- La respuesta es el `QuotationResponseDto` completo, que **ya no trae `taxRate` ni `taxCents`** (se quitaron del wire en el mismo cambio).
- Errores: `400 INVALID_TAX_RATE` (fuera de `[0, 1]`), `422 QUOTATION_NOT_DRAFT`, `404`.

**Cómo funciona el IVA por ítem (lo que el FE debe usar):**

- Los precios son **con IVA incluido**; el total no cambia por el IVA.
- Al agregar una línea (y cada vez que una línea `PRICE_LIST` se re-precia en `DRAFT`) el backend guarda el snapshot fiscal del **producto padre**: su `ivaRate` (`IVA_16`, `IVA_8`, `IVA_0`, `IVA_EXENTO`) y si `chargeProductTaxes`. Las variantes heredan del padre. Las líneas `CUSTOM` conservan el snapshot que tenían. Una vez `SENT`, el snapshot queda congelado aunque el producto cambie después.
- `ivaBreakdown: { classification, amountCents }[]` en cada lectura: IVA incluido por clasificación, solo las clasificaciones presentes, en el orden `IVA_16`, `IVA_8`, `IVA_0`, `IVA_EXENTO`, `NOT_TAXABLE` (`NOT_TAXABLE` = producto con `chargeProductTaxes = false`). Puede traer montos `0` (por ejemplo `IVA_0`).
- `ivaBreakdown: []` cuando la cotización no tiene ítems **o alguna línea no tiene snapshot** (cotizaciones viejas, anteriores a la migración `20260915210500`). En ese caso **no muestres IVA** (no es "IVA $0").
- IVA total a mostrar = suma de `amountCents`. El PDF muestra exactamente eso en un único renglón "IVA incluido" (sin tasas ni desglose) y lo omite cuando `ivaBreakdown` está vacío.

---

### 3.19 `DELETE /quotations/:id` — Eliminar cotización

Hard-delete de una cotización. **Solo** `DRAFT` y `CANCELLED` se pueden eliminar — `SENT`, `EXPIRED` y `CONVERTED_TO_SALE` son registros permanentes (ya fueron comunicados al cliente o originaron una venta).

**Response** `204 No Content` (body vacío).

**Reglas**:
- Mostrar el botón de eliminar solo si `status === 'DRAFT' || status === 'CANCELLED'`.
- Confirmación previa obligatoria: "¿Eliminar la cotización? Esta acción no se puede deshacer."

**Errores**:
| HTTP | Código | Causa |
|------|--------|-------|
| `422` | `QUOTATION_CANNOT_DELETE` | La cotización está en `SENT`, `EXPIRED` o `CONVERTED_TO_SALE` |
| `404` | — | Cotización no encontrada |
| `403` | — | Sin permiso `delete:Quotation` |

---

### 3.20 Conversión venta ↔ cotización (pestaña "Pedido" del POS)

Contrato completo (bodies, respuestas, errores, ejemplos): [frontend-handoff/23-quotation-sale-conversion.md](frontend-handoff/23-quotation-sale-conversion.md). Resumen:

- `POST /quotations/from-sale/:saleId` (`create:Quotation` + `delete:Sale`, header `Idempotency-Key` obligatorio): crea una cotización `DRAFT` con cliente, vendedor, lista de precios, líneas (precio vigente) y `customerNotes` opcional del body, y **borra** la venta borrador en la misma transacción. Responde `201 { quotation, discardedSaleId, droppedAdjustments }`. `droppedAdjustments` lista lo que una cotización no puede representar (promo de orden, 2x1/avanzadas, promos que ya no aplican).
- `POST /quotations/:id/convert-to-sale` (`create:Sale` + `update:Quotation`, header `Idempotency-Key` obligatorio): desde `DRAFT` o `SENT` no vencida crea una venta borrador del POS con los **precios y descuentos cotizados** y pasa la cotización a `CONVERTED_TO_SALE` con `saleId`. Responde `201 { quotation, sale, suppressedPromotions }`. **Exacta por defecto (S8):** al abrir, el total de la venta es exactamente el de la cotización (por línea y total, al centavo); las promociones automáticas que aplicarían hoy se **vetan** en la venta y se listan en `suppressedPromotions: Array<{ promotionId: string; title: string | null }>` (`[]` si ninguna). Después el cajero ajusta con las rutas normales del borrador: re-activar una promo `POST /sales/drafts/:id/manual-promotions/:promotionId`, quitarla `DELETE /sales/drafts/:id/promotions/:promotionId`, cambiar precio `PATCH /sales/drafts/:id/items/:itemId/price`, descuentos `PATCH|DELETE /sales/drafts/:id/items/:itemId/discount` y `PATCH|DELETE /sales/drafts/:id/discount` (detalle en `docs/frontend-handoff/23-quotation-sale-conversion.md`). Rechazos `422`: `QUOTATION_EXPIRED`, `QUOTATION_CANCELLED`, `QUOTATION_ALREADY_CONVERTED` (+ `saleId`), `QUOTATION_HAS_NO_ITEMS`, `QUOTATION_LINES_UNAVAILABLE` (+ `lines` con el motivo por línea: producto inexistente/no vendible, stock insuficiente).
- Mismo `Idempotency-Key` + misma petición → misma respuesta (no duplica). Dos conversiones simultáneas de la misma cotización → una sola venta.

---

## 4. Modelo de datos — shape de respuesta

### `QuotationResponseDto`

```typescript
{
  id: string;                          // UUID
  sellerUserId: string;                // UUID del vendedor actual
  seller: {                            // snapshot de identidad del vendedor
    id: string;
    name: string;                      // nombre a mostrar (fallback: UUID crudo)
  } | null;
  customerId: string | null;
  customer: {                          // null si no hay customer asignado
    id: string;
    firstName: string;
    lastName: string | null;
    email: string | null;
  } | null;
  globalPriceListId: string | null;     // ID de la lista de precios activa
  priceListExplicitlySet: boolean;      // true si el cajero eligió la lista manualmente
  status: 'DRAFT' | 'SENT' | 'EXPIRED' | 'CANCELLED' | 'CONVERTED_TO_SALE';
  effectiveStatus: 'DRAFT' | 'SENT' | 'EXPIRED' | 'CANCELLED' | 'CONVERTED_TO_SALE';
                                       // status con la expiración lazy aplicada — usalo para el badge
  expiresAt: string | null;            // ISO 8601 o null
  cancelReason: 'CUSTOMER_REQUEST' | 'PRICE_OBJECTION' | 'EXPIRED' | 'OTHER' | null;
  canceledAt: string | null;           // ISO 8601
  subtotalCents: number;               // subtotal en centavos (sin descuentos)
  discountCents: number;               // descuento total aplicado en centavos
  totalCents: number;                  // total final = subtotal - discount (IVA incluido)
  ivaBreakdown: Array<{                // IVA incluido por clasificación (ver 3.18). [] = no mostrar IVA
    classification: 'IVA_16' | 'IVA_8' | 'IVA_0' | 'IVA_EXENTO' | 'NOT_TAXABLE';
    amountCents: number;               // entero >= 0 (centavos)
  }>;
  // taxRate / taxCents YA NO existen en la respuesta (IVA por ítem, ver 3.18)
  manuallyEnded: boolean;              // interno — siempre false para cotizaciones
  items: QuotationItemResponseDto[];
  appliedPromotions: {                 // promos aplicadas (manuales + automáticas)
    promotionId: string;
    title: string;
    discountCents: number;
  }[];
  vetoedPromotionIds: string[];        // IDs de promos vetadas
  optedInManualPromotionIds: string[]; // IDs de promos MANUAL aplicadas
  customerNotes: string | null;        // notas para el cliente (max 280 chars)
  saleId: string | null;               // venta borrador creada (solo CONVERTED_TO_SALE; null si se descartó)
  saleStatus: 'DRAFT' | 'CONFIRMED' | 'CANCELED' | null;
                                       // estado de la venta enlazada; null sin enlace o si la venta ya no existe
  convertedAt: string | null;          // ISO 8601, cuándo se convirtió
  createdAt: string;                   // ISO 8601
  updatedAt: string;                   // ISO 8601
}
```

La venta borrador creada desde una cotización trae `quotationId` en sus lecturas (`GET /sales/drafts`, respuestas de mutaciones del borrador y `GET /sales/:id`). En ventas que no vienen de una cotización la clave **no aparece**.

"Ver venta" según `saleStatus`: `DRAFT` → la venta es un borrador del POS **del cajero que convirtió** (`sale.userId`); sólo él la ve en `GET /sales/drafts` (que lista únicamente los borradores propios) y sólo él puede modificarla (otro usuario recibe `SALE_UPDATE_FORBIDDEN`); `GET /sales/:id` da 404 para borradores. `CONFIRMED` / `CANCELED` → `GET /sales/:id` (`read:Sale`). `null` → sin venta (mostrar "Venta descartada" si `status = CONVERTED_TO_SALE`).

### `QuotationItemResponseDto`

```typescript
{
  id: string;                   // UUID
  productId: string;            // UUID del producto
  variantId: string | null;     // UUID de la variante (si aplica)
  product: {                    // info del producto (siempre presente)
    id: string;
    name: string;
    sku: string;
    imageUrl: string | null;
  };
  variant: {                    // info de la variante (si aplica)
    id: string;
    name: string;
    sku: string;
  } | null;
  quantity: number;             // cantidad
  unitPriceCents: number;       // precio unitario en centavos
  priceSource: 'PRICE_LIST' | 'TIER_PRICE' | 'CUSTOM' | 'PROMOTION';
                                // CUSTOM = el vendedor lo cambió manualmente
  discountType: 'PERCENTAGE' | 'FIXED' | null;
  discountValue: number | null;
  discountAmountCents: number;  // monto del descuento aplicado a esta línea
  discountTitle: string | null; // nombre de la promo que aplicó descuento
  promotionId: string | null;   // ID de la promo que aplicó
  manuallyAdjusted: boolean;    // true si el precio fue sobrescrito
  overrideNote: string | null;  // nota del vendedor (no implementado aún)
  createdAt: string;
  updatedAt: string;
}
```

---

## 5. Flujos de UI recomendados

### 5.1 Crear cotización desde cliente

```
Lista de clientes → "3 puntos" → "Crear cotización"
  → POST /quotations/drafts { customerId }
  → Redirigir a pantalla de cotización con el ID
```

### 5.2 Pantalla de cotización (DRAFT)

```
┌────────────────────────────────────────────┐
│ Cotización #abc123              [DRAFT] [▼]│
│ Cliente: María García                     │
│ Lista de precios: Precio Público [Cambiar] │
│ Expira: 15/08/2026              [Cambiar] │
├────────────────────────────────────────────┤
│ Producto          Cant  Precio  Subt  Desc │
│ ──────────────────────────────────────    │
│ Playera M          2    $150   $300       │
│   Precio manual ✏️  →  $120   $240  -$60  │
│ Jeans 32           1    $450   $450       │
│   Promo: 10% off          -$45          │
├────────────────────────────────────────────┤
│ Subtotal: $750 | Descuento: $105         │
│ TOTAL: $645                               │
├────────────────────────────────────────────┤
│ [+ Agregar producto]                      │
│ [Aplicar promoción manual]                │
│ [Previsualizar PDF] [Enviar] [Cancelar]   │
└────────────────────────────────────────────┘
```

### 5.3 Flujo de envío

```
[Enviar] → Confirm dialog: "¿Enviar a maria@test.com?"
  → POST /quotations/drafts/:id/send?email=true
  → OK: mostrar toast "Cotización enviada" + cambiar badge a SENT
  → 422 (no email): mostrar dialog pidiendo email del cliente
  → 502 (Resend fail): mostrar toast "Error al enviar, reintentá"
```

### 5.4 Preview del PDF

```
[Previsualizar PDF] → GET /quotations/:id/pdf?format=quotation-a4
  → Abrir en nueva pestaña o iframe (Content-Disposition: inline)
```

---

## 6. Promociones en cotizaciones — comportamiento

- Las cotizaciones usan el **mismo motor de promociones** que las ventas.
- Promos `AUTOMATIC` se evalúan automáticamente al agregar/quitar items o cambiar precios.
- Promos `MANUAL` las aplica el vendedor explícitamente.
- El vendedor puede **vetar** promos automáticas que no quiera aplicar.
- **No hay reglas separadas** para cotizaciones en este slice (a futuro se puede agregar vía el campo `context` del engine).

---

## 7. Consideraciones para el frontend

### 7.1 URL base
`GET /quotations/:id/pdf` usa `Content-Disposition: inline`. Para mostrar el PDF en un iframe:
```html
<iframe src="https://api.tudominio.com/quotations/abc123/pdf?format=quotation-a4"
        width="100%" height="600px"></iframe>
```
El JWT se envía normalmente en el header `Authorization` — si usás iframe, necesitás que el browser envíe las cookies/httpOnly token, o usar un approach de blob:
```typescript
const res = await fetch(`/quotations/${id}/pdf`, { headers: { Authorization } });
const blob = await res.blob();
const url = URL.createObjectURL(blob);
// usar url en <iframe> o <object>
```

### 7.2 Campo `customer.email`
El modelo `Customer` ya tiene `email: String?`. Si un cliente no tiene email, el endpoint `send` devuelve `422 QUOTATION_CUSTOMER_HAS_NO_EMAIL`. El frontend debería:
1. Antes de enviar, verificar que `customer.email` no sea null.
2. Si es null, mostrar un dialog para que el vendedor ingrese el email (usando el endpoint de update de customer).

### 7.3 Polling / actualización en tiempo real
No hay WebSocket para cotizaciones. Después de cada mutación (agregar item, cambiar precio, etc.), el backend devuelve la cotización completa actualizada. Reemplazá el estado local con la respuesta.

### 7.4 Expiración lazy
La transición `SENT → EXPIRED` ocurre al **leer** la cotización, no en background. Si una cotización aparece como `SENT` pero su `expiresAt` ya pasó, en el **siguiente** GET va a aparecer como `EXPIRED`. No hace falta polling — la UI puede calcularlo del lado del cliente si `status === 'SENT' && expiresAt && new Date(expiresAt) < new Date()`.

### 7.5 Items con precio manual
Cuando un item tiene `priceSource: 'CUSTOM'` y `manuallyAdjusted: true`, mostrá un indicador visual (ícono de lápiz ✏️ o badge) para que el vendedor sepa que ese precio fue cambiado manualmente y no se actualizará al cambiar la lista de precios.

### 7.6 Stock de productos con variantes — `variantStockTotal`

`GET /products/:id` ahora incluye `variantStockTotal` y `variantCount` para productos con variantes (fix backend):

```json
{
  "hasVariants": true,
  "variantStockTotal": 180,
  "variantCount": 3,
  "quantity": 0
}
```

**Importante**: para productos con variantes, `quantity` a nivel producto es `0` (el stock real vive en las variantes). Usar:
```typescript
const stockQty = p.hasVariants && p.variantStockTotal != null
  ? p.variantStockTotal
  : p.quantity;
```

---

## 8. Errores comunes — tabla de referencia rápida

> **Corrección (2026-11-18):** `QUOTATION_NOT_DRAFT` y `QUOTATION_CANNOT_DELETE` se responden con **HTTP 422**, no 409: son `BusinessRuleViolationError` sin mapeo propio en `DomainExceptionFilter` (que solo manda a 409 los códigos `SALE_NOT_DRAFT`, `IDEMPOTENCY_KEY_*`, etc.). Las tablas de 3.x ya están corregidas. Siempre decidí por el campo `error` del body, no por el status.

| HTTP | Código interno              | Significado                                      | Acción recomendada                        |
| ---- | --------------------------- | ------------------------------------------------ | ----------------------------------------- |
| 400  | `INVALID_FORMAT`            | Formato de PDF no soportado                      | Solo usar `quotation-a4`                  |
| 400  | `Invalid quantity`          | Cantidad < 1                                     | Validar antes de enviar                   |
| 400  | `INVALID_TAX_RATE`          | `taxRate` fuera de rango [0, 1] (endpoint deprecado) | No usar `PATCH tax-rate` (ver 3.18)    |
| 400  | `NOTES_TOO_LONG`            | Notas superan los 280 caracteres                 | Mostrar contador 0/280 y bloquear envío   |
| 400  | `PROMOTION_IS_NOT_MANUAL`   | PUT manual-promotions con promo AUTOMATIC        | Usar endpoints de veto para AUTOMATIC     |
| 401  | —                           | Token expirado o inválido                        | Redirigir a login                         |
| 403  | —                           | Sin permiso (`read:Quotation`, etc.)             | Ocultar botones sin permiso               |
| 404  | —                           | ID no existe o no pertenece al tenant            | Mostrar "No encontrado"                   |
| 422  | `QUOTATION_NOT_DRAFT`       | Intentando editar/enviar una cotización que no está en DRAFT (incluye `CONVERTED_TO_SALE`) | Deshabilitar edición si status ≠ DRAFT |
| 422  | `QUOTATION_CANNOT_DELETE`   | Intentando eliminar una cotización SENT/EXPIRED/CONVERTED_TO_SALE | Ocultar botón eliminar si no es DRAFT/CANCELLED |
| 422  | `QUOTATION_EXPIRED` / `QUOTATION_CANCELLED` / `QUOTATION_ALREADY_CONVERTED` / `QUOTATION_LINES_UNAVAILABLE` | Conversión a venta rechazada (ver 3.20) | Ver handoff 23 |
| 409  | `IDEMPOTENCY_KEY_CONFLICT`  | Mismo `Idempotency-Key` con otra petición (conversiones) | Generar una key nueva por acción |
| 422  | `QUOTATION_HAS_NO_ITEMS`    | Intentando enviar cotización sin productos       | Validar items.length > 0 antes de enviar  |
| 422  | `QUOTATION_CUSTOMER_HAS_NO_EMAIL` | Cliente sin email al intentar enviar       | Pedir email antes de enviar               |
| 500  | `PDF_GENERATION_FAILED`     | Error al generar el PDF                          | Reintentar, reportar si persiste          |
| 502  | —                           | Error del proveedor de email (Resend)            | Reintentar, el estado quedó en DRAFT      |

---

## 9. Permisos requeridos

| Acción              | Permiso CASL            |
| ------------------- | ----------------------- |
| Crear cotización    | `create:Quotation`      |
| Ver lista/detalle   | `read:Quotation`        |
| Editar (items, etc) | `update:Quotation`      |
| Eliminar cotización | `delete:Quotation`      |
| Ver PDF             | `read:Quotation`        |
| Venta borrador → cotización (`POST /quotations/from-sale/:saleId`) | `create:Quotation` **y** `delete:Sale` |
| Cotización → venta borrador (`POST /quotations/:id/convert-to-sale`) | `create:Sale` **y** `update:Quotation` |

Si un usuario no tiene `update:Quotation`, ocultá todos los botones de edición/items/promos/send/cancel en DRAFT. Si no tiene `create:Quotation`, ocultá "Crear cotización" del menú del cliente. Si no tiene `delete:Quotation`, ocultá el botón de eliminar.

---

## 10. Notas técnicas

- **Migración**: El schema de cotizaciones es nuevo (5 tablas + 4 enums) + 2 columnas nuevas (`customerNotes`, `taxRate`). No afecta tablas existentes. `prisma migrate deploy` es seguro en prod.
- **Tenant isolation**: Todas las queries pasan por `TenantPrismaService`. Un ID de otro tenant devuelve 404, no 403.
- **Engine widening**: `PosEvalInput` ahora acepta `context?: 'SALE' | 'QUOTATION'`. Las ventas existentes no se ven afectadas (default `'SALE'`).
- **IVA por producto (ya integrado)**: cada línea guarda el snapshot fiscal del producto (`ivaRate` + `chargeProductTaxes`, migración `20260915210500`) y la respuesta expone `ivaBreakdown[]`. La columna legacy `taxRate` y `PATCH /tax-rate` están deprecados (`Deprecation: true`) y no influyen en nada visible (ver 3.18).
- **Conversión a venta (migración `20261118000000`)**: nuevo valor `CONVERTED_TO_SALE` en el enum y columnas `quotations.convertedSaleId` (única, FK a `sales` con `ON DELETE SET NULL`) y `convertedAt`. Aditiva; los estados y lecturas existentes no cambian.
- **No stock checks**: La cotización no valida stock. Para badges de stock, `GET /products/:id` incluye `variantStockTotal` (fix aplicado).
- **PDF streaming**: El PDF se streamea directo al response, no se bufferea en memoria (para items ≤50). Para el envío por email, se renderiza en memoria como Buffer.
