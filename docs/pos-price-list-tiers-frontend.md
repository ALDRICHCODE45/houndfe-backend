# POS — Listas de Precios con Escalones por Cantidad (Tier Pricing)

> Backend autoritativo. El FE recibe la venta ya repriceada en cada respuesta de mutación.
> **Branch**: `feat/pos-price-list-tiers` (5 commits, NO mergeado a main todavía).

---

## 0) Qué cambió y por qué

**Antes**: `addItem` congelaba el precio default del producto para siempre. Cambiar la cantidad NUNCA cambiaba el precio, aunque existieran tiers configurados en el módulo de Productos. La UI de "Precios por Cantidad" (variante → lista → 0+ $300, 4+ $100) existía pero el POS la ignoraba.

**Ahora**: cada mutación del draft (`addItem`, `updateItemQuantity`, cambio de lista, `assignCustomer`) dispara un pipeline de repricing que re-resuelve el precio de cada línea según la lista activa y la cantidad actual. Si la cantidad cruza un umbral, el precio se actualiza automáticamente.

**El FE no tiene que hacer nada** — solo renderizar la respuesta. El backend es autoritativo.

---

## 1) Quick path — flujo mínimo para probar

1. Abrí un draft vacío.
2. `PUT /sales/drafts/:id/price-list` con `{ "globalPriceListId": "<uuid-de-mayoreo>" }`.
3. `POST /sales/drafts/:id/items` (addItem) — el precio ya sale tier-ajustado.
4. `PATCH /sales/drafts/:id/items/:itemId/quantity` — si la cantidad cruza un umbral, el unitPriceCents se actualiza en la respuesta.
5. Verificá que `globalPriceListId` aparece en el response del draft.

---

## 2) Endpoints nuevos

### `PUT /sales/drafts/:id/price-list`

Asigna o limpia la lista de precios de la venta. Dispara repricing inmediato de todas las líneas no-sticky.

| Aspecto | Detalle |
|---|---|
| **URL** | `PUT /sales/drafts/:id/price-list` |
| **Auth** | JWT + Tenant + `RequirePermissions(['update','Sale'])` |
| **Body** | `{ "globalPriceListId": "<uuid>" \| null }` |
| **Response** | `200` — draft completo repriceado (misma forma que `GET /sales/drafts/:id`) |
| **Errores** | `400` lista inexistente, `403` sin permiso, `404` venta no encontrada, `409` venta no en DRAFT |

**Request body** (`SetPriceListDto`):
```json
{
  "globalPriceListId": "uuid-de-mayoreo"
}
```
- `null` limpia la lista → las líneas no-sticky vuelven a la lista default (PUBLICO).
- `undefined` (campo ausente) es inválido — el DTO lo rechaza en validación.

**Response**: mismo shape que `GET /sales/drafts/:id`, pero con `globalPriceListId` poblado y todas las líneas no-sticky ya repriceadas. Ejemplo:
```json
{
  "id": "sale-abc",
  "status": "DRAFT",
  "globalPriceListId": "uuid-de-mayoreo",
  "items": [
    {
      "id": "item-1",
      "productId": "prod-x",
      "quantity": 5,
      "unitPriceCents": 80000,
      "priceSource": "price_list",
      "appliedPriceListId": null,
      "originalPriceCents": 100000
    }
  ],
  "subtotalCents": 400000,
  "totalCents": 400000
}
```

**Campos nuevos en el response del draft**:
- `globalPriceListId` (`string | null`) — la lista activa de la venta. `null` = sin lista asignada (usa default).
- Las líneas ahora pueden tener `priceSource: "price_list"` incluso sin `appliedPriceListId` (cuando vienen de la lista de la venta, no de un override por ítem).

---

## 3) Endpoints existentes con comportamiento nuevo

### `POST /sales/drafts/:id/items` (addItem)

**Cambio**: el `unitPriceCents` del ítem agregado ya NO es necesariamente el precio default del producto. Si la venta tiene una lista asignada (`globalPriceListId`), el precio se resuelve tier-aware a la cantidad del ítem.

**Stacking**: si el mismo producto+variante ya existe en la venta, las cantidades se acumulan y el tier se resuelve sobre la cantidad **acumulada** (no sobre la individual).

**Response**: el draft completo repriceado, incluyendo `globalPriceListId`.

### `PATCH /sales/drafts/:id/items/:itemId/quantity` (updateItemQuantity)

**Cambio**: al cambiar la cantidad, el sistema re-resuelve el precio de TODAS las líneas no-sticky según su cantidad actual. Si una línea cruza un umbral de tier (para arriba o para abajo), su `unitPriceCents` se actualiza en la respuesta.

**Response**: el draft completo repriceado.

### `PUT /sales/drafts/:id/customer` (assignCustomer) — existente, sin cambios de ruta

**Cambio**: si el cliente asignado tiene `globalPriceListId` y **el cajero NO eligió explícitamente una lista** en la venta, el sistema automáticamente siembra esa lista en la venta (la asigna y reprica).

Si el cajero YA eligió una lista a mano (vía `PUT .../price-list`), el `assignCustomer` NUNCA la pisa. La elección explícita del cajero siempre gana.

### `POST /sales/drafts/:id/items/:itemId/override-price` (overrideItemPrice)

**Sin cambios funcionales**. Pero ahora la línea overrideada se vuelve "sticky" — el repricing automático nunca la toca. Si el cajero cambia la lista de la venta o la cantidad, la línea con precio custom conserva su precio.

### `GET /sales/drafts/:id` (getSaleDetail)

**Cambio**: el response ahora incluye `globalPriceListId`.

### `GET /sales/drafts` (listar drafts del usuario)

**Cambio**: cada draft en la lista ahora incluye `globalPriceListId`.

---

## 4) Cómo funciona el tier pricing (reglas de negocio)

### Resolución de precio por cantidad

Para cada línea no-sticky, el sistema busca en los tiers de la lista activa:

1. Toma todos los tiers con `minQuantity <= cantidad_actual`.
2. Se queda con el de **mayor `minQuantity`**.
3. Ese tier define el `unitPriceCents`.
4. Si NO hay ningún tier aplicable (cantidad menor al primer umbral), se usa el precio base de la lista.
5. Tiers con `priceCents <= 0` se ignoran (se saltean, cae al siguiente).

**Ejemplo**: lista MAYOREO con tiers `0+ → $300.00`, `4+ → $100.00`:
| Cantidad | Precio resuelto | Razón |
|---|---|---|
| 1 | $300.00 | Tier 0+ aplica |
| 3 | $300.00 | Tier 0+ aplica |
| 4 | $100.00 | Tier 4+ aplica (mayor minQuantity ≤ 4) |
| 7 | $100.00 | Tier 4+ sigue aplicando |
| 10 | $100.00 | Mismo tier, no hay umbral superior |

### Tiers de variante vs tiers de producto

Si la línea tiene `variantId`, se usan los tiers de **variante** (`VariantTierPrice`). Si no tiene variante, se usan los tiers de **producto** (`TierPrice`). Los tiers de variante **reemplazan** completamente los de producto — no se combinan.

### Lista sin precio para un producto

Si la lista activa (ej. MAYOREO) no tiene una fila en `price_lists` para ese producto, esa línea se resuelve con la **lista default** (PUBLICO). Esto es por línea, no por venta — podés tener 3 ítems en MAYOREO y 1 en PUBLICO dentro de la misma venta.

---

## 5) Precedencia de precios (qué precio gana)

El sistema evalúa cada línea en este orden. La primera regla que aplica, gana:

| Prioridad | Condición | Comportamiento |
|---|---|---|
| **1 (sticky)** | `priceSource === 'custom'` O tiene descuento manual (`discountType` != null Y `promotionId` == null) | **Nunca se repricea**. El precio y descuento se conservan tal cual. |
| **2 (override)** | La línea tiene `appliedPriceListId` (override por ítem) | Se re-tierea dentro de **esa misma lista** al cambiar cantidad. No se ve afectada por cambios de lista de la venta. |
| **3 (venta)** | La venta tiene `globalPriceListId` asignado | Se resuelve tier-aware desde la lista de la **venta**. |
| **4 (default)** | Ninguna de las anteriores | Se usa el precio default del producto (lista PUBLICO). |

---

## 6) Sticky lines — líneas que NUNCA se reprican

Dos tipos de líneas son inmunes al repricing automático:

1. **Precio custom** (`priceSource: "custom"`): el cajero puso un precio manual.
2. **Descuento manual** (`discountType` != null Y `promotionId` == null): el cajero aplicó un descuento libre (no de promoción automática).

Estas líneas conservan su `unitPriceCents` y su descuento sin importar:
- Cambios de cantidad.
- Cambios de lista de la venta.
- Asignación de cliente.
- Recomputes múltiples.

---

## 7) Errores

| Código | HTTP | Cuándo ocurre |
|---|---|---|
| `PRICE_LIST_NOT_FOUND` | **400** | El `globalPriceListId` enviado no existe en el catálogo. |
| `SALE_NOT_FOUND` | 404 | La venta no existe. |
| `SALE_UPDATE_FORBIDDEN` | **403** | El usuario no es dueño del draft o no tiene permiso `update:Sale`. |
| `SALE_NOT_DRAFT` | **409** | La venta ya está confirmada o cancelada. |
| `PRICE_OUT_OF_DATE` | 409 | (Solo en `chargeDraft`) El precio del catálogo cambió después del último recompute. |
| `INVALID_PRICE_LIST_FOR_ITEM` | 400 | Se intentó aplicar una lista que no tiene precio para ese producto (solo en override por ítem). |

---

## 8) `priceListExplicitlySet` — campo interno, NO EXPUESTO

Este campo **no va en el wire**. Es un discriminador interno que el backend usa para saber si el cajero eligió explícitamente una lista (vía `PUT .../price-list`) o si la lista fue sembrada automáticamente por `assignCustomer`. El FE no necesita conocerlo.

La diferencia de comportamiento ya está resuelta del lado del backend:
- Si el cajero eligió lista → `assignCustomer` no la pisa.
- Si nadie eligió lista → `assignCustomer` siembra la del cliente.

---

## 9) Ejemplos de flujo

### Flujo 1: Venta con lista MAYOREO

```bash
# 1. Abrir draft
POST /sales/drafts
→ { "id": "draft-1", "globalPriceListId": null, "items": [] }

# 2. Asignar lista MAYOREO
PUT /sales/drafts/draft-1/price-list
Body: { "globalPriceListId": "uuid-mayoreo" }
→ { "id": "draft-1", "globalPriceListId": "uuid-mayoreo", "items": [] }

# 3. Agregar producto X (tiers: 1+ $300, 5+ $200, 10+ $150)
POST /sales/drafts/draft-1/items
Body: { "productId": "prod-x", "quantity": 3 }
→ { "items": [{ "productId": "prod-x", "quantity": 3, "unitPriceCents": 30000, "priceSource": "price_list" }] }

# 4. Subir cantidad a 6 (cruza el umbral de 5+)
PATCH /sales/drafts/draft-1/items/item-1/quantity
Body: { "quantity": 6 }
→ { "items": [{ "quantity": 6, "unitPriceCents": 20000, "priceSource": "price_list" }] }
```

### Flujo 2: Cliente mayorista asigna lista automáticamente

```bash
# 1. Abrir draft sin lista explícita
POST /sales/drafts → { "id": "draft-2", "globalPriceListId": null }

# 2. Agregar producto
POST /sales/drafts/draft-2/items
Body: { "productId": "prod-x", "quantity": 1 }
→ { "items": [{ "unitPriceCents": 50000 }] }  # precio default (PUBLICO)

# 3. Asignar cliente mayorista (tiene globalPriceListId = "uuid-mayoreo")
PUT /sales/drafts/draft-2/customer
Body: { "customerId": "cust-mayoreo" }
→ { "globalPriceListId": "uuid-mayoreo", "items": [{ "unitPriceCents": 30000, "priceSource": "price_list" }] }
# La lista se sembró y el precio se actualizó automáticamente
```

### Flujo 3: Línea custom no se toca

```bash
# 1. Draft con lista MAYOREO
PUT /sales/drafts/draft-3/price-list → { "globalPriceListId": "uuid-mayoreo" }

# 2. Agregar producto (precio MAYOREO tier)
POST /sales/drafts/draft-3/items → { "items": [{ "unitPriceCents": 30000, "priceSource": "price_list" }] }

# 3. Override manual de precio
POST /sales/drafts/draft-3/items/item-1/override-price
Body: { "customPriceCents": 25000 }
→ { "items": [{ "unitPriceCents": 25000, "priceSource": "custom" }] }

# 4. Cambiar lista a CONTADO
PUT /sales/drafts/draft-3/price-list
Body: { "globalPriceListId": "uuid-contado" }
→ { "items": [{ "unitPriceCents": 25000, "priceSource": "custom" }] }
# ↑ El precio custom NO cambió — es sticky
```

---

## 10) Edge cases

| Escenario | Comportamiento |
|---|---|
| **Lista sin precio para un producto** | Ese ítem usa el precio default (PUBLICO). Los demás ítems de la venta sí usan la lista asignada. |
| **Tier con priceCents=0** | Se ignora. Si es el único tier, se usa el precio base de la lista. |
| **Cantidad 0 o negativa** | `updateItemQuantity` rechaza con error de validación. |
| **Ítem duplicado (stacking)** | `addItem` del mismo product+variant acumula cantidades. El tier se resuelve sobre la cantidad combinada. |
| **Lista cambiada en venta vacía** | Se guarda el binding. El próximo `addItem` ya resuelve desde esa lista. |
| **Cliente sin lista (globalPriceListId=null)** | `assignCustomer` no cambia nada en el pricing. |
| **Eliminar ítem (removeItem)** | Dispara recompute. Los ítems restantes se reprican con sus cantidades actuales. |
| **Descuento manual + cambio de lista** | La línea con descuento manual es sticky: ni el precio ni el descuento cambian. |
| **Promoción automática + tier** | La promo descuenta DESDE el precio tier-ajustado. Ej: tier $200 + promo 10% = precio final $180. |

---

## 11) Resumen de cambios en el contrato

### Campos nuevos en responses

| Response | Campo | Tipo | Cuándo aparece |
|---|---|---|---|
| `GET /sales/drafts/:id` | `globalPriceListId` | `string \| null` | Siempre |
| `GET /sales/drafts` | `globalPriceListId` | `string \| null` | Siempre |
| `PUT .../price-list` | `globalPriceListId` | `string \| null` | Refleja el valor seteado |
| `POST .../items` | `items[].priceSource` | `"price_list"` | Cuando el precio viene de lista (venta o override) |
| `POST .../items` | `items[].priceSource` | `"custom"` | Cuando el cajero puso precio manual |

### Endpoints con comportamiento modificado

| Endpoint | Qué cambió |
|---|---|
| `POST /sales/drafts/:id/items` | `unitPriceCents` ahora es tier-aware. La respuesta incluye el draft repriceado. |
| `PATCH .../items/:itemId/quantity` | Dispara repricing de TODAS las líneas. Tier-crossing actualiza precios. |
| `PUT .../customer` | Siembra `globalPriceListId` del cliente si el cajero no eligió una. |
| `GET /sales/drafts/:id` | Nuevo campo `globalPriceListId`. |
| `GET /sales/drafts` | Nuevo campo `globalPriceListId` en cada draft. |

---

## 12) Siguientes pasos (para el FE)

1. Agregar el selector de lista de precios en el POS (dropdown con las GlobalPriceList disponibles).
2. Llamar a `PUT /sales/drafts/:id/price-list` al cambiar la lista.
3. Mostrar `globalPriceListId` en la UI de la venta (nombre de la lista activa).
4. Confiar en que `addItem` y `updateItemQuantity` ya devuelven precios tier-ajustados.
5. Para el modal de "Precios por Cantidad" en Productos, el CRUD ya funciona — consultar `GET /products/:id` (el endpoint de producto ya incluye `variantPrices[].tierPrices`).
