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
| `PATCH`  | `/quotations/drafts/:id/tax-rate`                     | `update:Quotation`   | Cambiar tasa de IVA (0 = exento)             |
| `POST`   | `/quotations/drafts/:id/send`                         | `update:Quotation`   | Enviar cotización por email + marcar SENT    |
| `POST`   | `/quotations/drafts/:id/cancel`                       | `update:Quotation`   | Cancelar cotización                          |
| `DELETE` | `/quotations/:id`                                     | `delete:Quotation`   | Eliminar cotización (solo DRAFT/CANCELLED)   |

Todos requieren JWT (Bearer token). El tenant se determina del token automáticamente.

---

## 2. Ciclo de vida

```
DRAFT ──send()──▶ SENT ──(expiresAt < now)──▶ EXPIRED
  │                  │
  └──cancel()──▶ CANCELLED
```

- **DRAFT**: editable. Se pueden agregar/quitar items, cambiar precios, promos, price list, expiry.
- **SENT**: solo lectura. El PDF ya fue enviado al cliente. No se puede editar.
- **EXPIRED**: transición automática (lazy) cuando `expiresAt` ya pasó. Solo lectura.
- **CANCELLED**: terminal. No se puede reactivar.

**Importante**: La conversión de cotización a venta (`CONVERTED_TO_SALE`) NO está en este slice. Es un follow-up.

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
| `status`     | string   | —       | Filtrar por estado: `DRAFT`,`SENT`,`EXPIRED`,`CANCELLED` |
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

Renderiza el PDF de la cotización. Funciona en **cualquier estado** (DRAFT, SENT, EXPIRED, CANCELLED) — el vendedor puede previsualizar antes de enviar.

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
| `409` | `Quotation is not DRAFT` | Solo se puede editar en estado DRAFT |
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
| `409` | `Quotation is not DRAFT` | Solo se puede cambiar en estado DRAFT |

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
| `409` | `Quotation is not DRAFT` | Solo DRAFT |
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
| `409` | `Quotation is not DRAFT` | Solo DRAFT |

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
| `409` | `Quotation is not DRAFT` | Solo DRAFT |

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
| `409` | `Quotation is not DRAFT` | Solo DRAFT |

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
| `409` | `Quotation is not DRAFT` | Solo DRAFT |

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
| `409` | `Quotation is not DRAFT` | Solo DRAFT |

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
| `409` | — | La cotización no está en DRAFT |
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
| `409` | — | Ya está cancelada (idempotente, no tira error realmente) |
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
| `409` | `QUOTATION_NOT_DRAFT` | No está en DRAFT |
| `404` | — | Cotización no encontrada |

---

### 3.18 `PATCH /quotations/drafts/:id/tax-rate` — Tasa de IVA

Cambia la tasa de IVA de la cotización caso por caso (exención de IVA incluida). El `taxCents` se recalcula automáticamente del lado del backend.

**Request**:
```json
{
  "taxRate": 0
}
```

**Valores válidos**:
| taxRate | Significado            |
|---------|------------------------|
| `0`     | Exento de IVA          |
| `0.08`  | IVA 8%                 |
| `0.16`  | IVA 16% (default)      |
| `0.21`  | IVA 21%                |

**Response** `200`: `QuotationResponseDto` completo con `taxRate` y `taxCents` actualizados.

**Reglas**:
- `taxRate` debe ser un número entre `0` y `1`.
- Solo funciona en estado `DRAFT`.
- `taxCents` se calcula como `totalCents * taxRate / (1 + taxRate)` (IVA incluido en precios).
- Si `taxRate` es `0`, `taxCents` es `0`.

**Errores**:
| HTTP | Código | Causa |
|------|--------|-------|
| `400` | `INVALID_TAX_RATE` | `taxRate` fuera de rango [0, 1] |
| `409` | `QUOTATION_NOT_DRAFT` | No está en DRAFT |
| `404` | — | Cotización no encontrada |

---

### 3.19 `DELETE /quotations/:id` — Eliminar cotización

Hard-delete de una cotización. **Solo** `DRAFT` y `CANCELLED` se pueden eliminar — `SENT` y `EXPIRED` son registros permanentes (ya fueron comunicados al cliente).

**Response** `204 No Content` (body vacío).

**Reglas**:
- Mostrar el botón de eliminar solo si `status === 'DRAFT' || status === 'CANCELLED'`.
- Confirmación previa obligatoria: "¿Eliminar la cotización? Esta acción no se puede deshacer."

**Errores**:
| HTTP | Código | Causa |
|------|--------|-------|
| `409` | `QUOTATION_CANNOT_DELETE` | La cotización está en `SENT` o `EXPIRED` |
| `404` | — | Cotización no encontrada |
| `403` | — | Sin permiso `delete:Quotation` |

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
  status: 'DRAFT' | 'SENT' | 'EXPIRED' | 'CANCELLED';
  expiresAt: string | null;            // ISO 8601 o null
  cancelReason: 'CUSTOMER_REQUEST' | 'PRICE_OBJECTION' | 'EXPIRED' | 'OTHER' | null;
  canceledAt: string | null;           // ISO 8601
  subtotalCents: number;               // subtotal en centavos (sin descuentos)
  discountCents: number;               // descuento total aplicado en centavos
  taxRate: number;                     // tasa de IVA (0 = exento, 0.16 = 16%)
  taxCents: number;                    // monto de IVA en centavos
  totalCents: number;                  // total final = subtotal - discount (IVA incluido)
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
  createdAt: string;                   // ISO 8601
  updatedAt: string;                   // ISO 8601
}
```

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

| HTTP | Código interno              | Significado                                      | Acción recomendada                        |
| ---- | --------------------------- | ------------------------------------------------ | ----------------------------------------- |
| 400  | `INVALID_FORMAT`            | Formato de PDF no soportado                      | Solo usar `quotation-a4`                  |
| 400  | `Invalid quantity`          | Cantidad < 1                                     | Validar antes de enviar                   |
| 400  | `INVALID_TAX_RATE`          | `taxRate` fuera de rango [0, 1]                  | Validar con slider/select de tasas        |
| 400  | `NOTES_TOO_LONG`            | Notas superan los 280 caracteres                 | Mostrar contador 0/280 y bloquear envío   |
| 400  | `PROMOTION_IS_NOT_MANUAL`   | PUT manual-promotions con promo AUTOMATIC        | Usar endpoints de veto para AUTOMATIC     |
| 401  | —                           | Token expirado o inválido                        | Redirigir a login                         |
| 403  | —                           | Sin permiso (`read:Quotation`, etc.)             | Ocultar botones sin permiso               |
| 404  | —                           | ID no existe o no pertenece al tenant            | Mostrar "No encontrado"                   |
| 409  | `Quotation is not DRAFT`    | Intentando editar una cotización ya enviada/cancelada | Deshabilitar edición si status ≠ DRAFT |
| 409  | `QUOTATION_CANNOT_DELETE`   | Intentando eliminar una cotización SENT/EXPIRED  | Ocultar botón eliminar si no es DRAFT/CANCELLED |
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

Si un usuario no tiene `update:Quotation`, ocultá todos los botones de edición/items/promos/send/cancel en DRAFT. Si no tiene `create:Quotation`, ocultá "Crear cotización" del menú del cliente. Si no tiene `delete:Quotation`, ocultá el botón de eliminar.

---

## 10. Notas técnicas

- **Migración**: El schema de cotizaciones es nuevo (5 tablas + 4 enums) + 2 columnas nuevas (`customerNotes`, `taxRate`). No afecta tablas existentes. `prisma migrate deploy` es seguro en prod.
- **Tenant isolation**: Todas las queries pasan por `TenantPrismaService`. Un ID de otro tenant devuelve 404, no 403.
- **Engine widening**: `PosEvalInput` ahora acepta `context?: 'SALE' | 'QUOTATION'`. Las ventas existentes no se ven afectadas (default `'SALE'`).
- **IVA configurable**: El `taxRate` default es `0.16`. Se puede cambiar por cotización vía `PATCH /tax-rate`. A futuro se integrará el IVA por producto (`Product.ivaRate`: IVA_16/IVA_8/IVA_0/IVA_EXENTO).
- **No stock checks**: La cotización no valida stock. Para badges de stock, `GET /products/:id` incluye `variantStockTotal` (fix aplicado).
- **PDF streaming**: El PDF se streamea directo al response, no se bufferea en memoria (para items ≤50). Para el envío por email, se renderiza en memoria como Buffer.
