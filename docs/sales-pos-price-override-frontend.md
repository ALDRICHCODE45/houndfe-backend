# Price Override por Item en POS Draft Sales — Contrato Tecnico para Frontend

> Estado: **IMPLEMENTADO en backend** (listo para consumo frontend)

> Fuente de verdad: implementacion actual en `src/sales/**`, `src/products/**`, `prisma/schema.prisma`, `DomainExceptionFilter`.

---

## 0) Objetivo de este documento

Este documento te explica, de punta a punta, como integrar en frontend la funcionalidad de **cambio de precio por item** dentro de una venta en estado `DRAFT`.

Incluye:

- endpoints nuevos,
- payloads exactos,
- reglas de validacion,
- errores esperables,
- contrato de respuesta actualizado de `SaleItem`,
- flujo recomendado de UI.

---

## 1) Resumen ejecutivo (que ya quedo habilitado)

Se implementaron dos capacidades nuevas:

1. **Cambiar precio de un item** de una venta draft:

```http
PATCH /sales/drafts/:saleId/items/:itemId/price
```

2. **Consultar precios/listas disponibles** para un item draft:

```http
GET /sales/drafts/:saleId/items/:itemId/available-prices
```

Y se extendio `SaleItem` con metadatos para trazabilidad de origen de precio.

---

## 2) Seguridad y permisos

- Auth: `Authorization: Bearer <jwt>`
- Permiso requerido en ambos endpoints nuevos: **`sale:update`**
- Scope de negocio: solo ventas del usuario con ownership valido.

Si el usuario no tiene acceso, backend responde error (403/404 segun el caso).

---

## 3) Contrato actualizado de `SaleItem`

Ademas de los campos existentes (`id`, `productId`, `variantId`, `quantity`, `unitPriceCents`, etc.), ahora cada item puede incluir:

```ts
interface SaleItem {
  // ...campos existentes...
  unitPriceCents: number;
  unitPriceCurrency: 'MXN';

  // Nuevos campos
  originalPriceCents: number | null;
  priceSource: 'default' | 'price_list' | 'custom';
  appliedPriceListId: string | null;
  customPriceCents: number | null;
}
```

### Reglas importantes

1. `unitPriceCurrency` se mantiene siempre en **MXN**.
2. `originalPriceCents`:
   - se setea en el **primer override**,
   - luego queda inmutable.
3. Si el cambio fue por lista:
   - `priceSource = 'price_list'`
   - `appliedPriceListId` con valor
   - `customPriceCents = null`
4. Si el cambio fue por precio personalizado:
   - `priceSource = 'custom'`
   - `customPriceCents` con valor
   - `appliedPriceListId = null`

---

## 4) Endpoint A — Cambiar precio de item draft

```http
PATCH /sales/drafts/:saleId/items/:itemId/price
```

### 4.1 Body (XOR estricto)

Tenes que enviar **exactamente una** de estas dos opciones:

#### Opcion A: aplicar lista de precios

```json
{
  "priceListId": "uuid"
}
```

#### Opcion B: aplicar precio personalizado

```json
{
  "customPriceCents": 2198
}
```

### 4.2 Validaciones backend

- `priceListId` XOR `customPriceCents` (no ambos, no ninguno).
- `priceListId` debe ser UUID valido.
- `customPriceCents` debe ser entero positivo (`>= 1`).
- Venta debe existir, pertenecer al actor y estar en `DRAFT`.
- Item debe existir dentro de la venta.
- Si va `priceListId`, backend resuelve precio server-side (incluye tier por cantidad actual del item).

### 4.3 Respuesta

`200 OK` con la **venta completa actualizada** (`Sale` con `items[]`).

Ejemplo resumido:

```json
{
  "id": "sale-uuid",
  "status": "DRAFT",
  "items": [
    {
      "id": "item-uuid",
      "quantity": 2,
      "unitPriceCents": 2198,
      "unitPriceCurrency": "MXN",
      "originalPriceCents": 2500,
      "priceSource": "price_list",
      "appliedPriceListId": "price-list-uuid",
      "customPriceCents": null
    }
  ],
  "updatedAt": "2026-04-28T15:30:00.000Z"
}
```

---

## 5) Endpoint B — Precios disponibles por item

```http
GET /sales/drafts/:saleId/items/:itemId/available-prices
```

Devuelve todas las listas aplicables al producto/variante del item, con precio efectivo por cantidad actual (incluyendo tiers si corresponde).

> Importante: hoy el modelo no filtra por `isActive`; por contrato funcional actual se devuelven todas las listas aplicables existentes.

### 5.1 Response

```ts
interface AvailablePricesResponse {
  saleId: string;
  itemId: string;
  prices: Array<{
    priceListId: string;
    priceListName: string;
    priceCents: number;
    priceDecimal: number;
    currency: 'MXN';
    isCurrent: boolean;
  }>;
}
```

### 5.2 Ejemplo

```json
{
  "saleId": "sale-uuid",
  "itemId": "item-uuid",
  "prices": [
    {
      "priceListId": "uuid-publico",
      "priceListName": "PUBLICO",
      "priceCents": 2198,
      "priceDecimal": 21.98,
      "currency": "MXN",
      "isCurrent": true
    },
    {
      "priceListId": "uuid-mayoreo",
      "priceListName": "MAYOREO",
      "priceCents": 1998,
      "priceDecimal": 19.98,
      "currency": "MXN",
      "isCurrent": false
    }
  ]
}
```

---

## 6) Como interpreta frontend el `isCurrent`

`isCurrent` viene calculado server-side con esta prioridad:

1. Si el item tiene `appliedPriceListId`, marca `true` en esa lista.
2. Si no tiene `appliedPriceListId`, usa fallback por coincidencia de `unitPriceCents`.

Con eso podes preseleccionar en UI la opcion activa al abrir modal/sheet de cambio de precio.

---

## 7) Errores esperables

Formato estandar:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "..."
}
```

Tabla de referencia:

| Caso | HTTP | Mensaje esperado (referencial) |
|---|---:|---|
| No enviar ninguno (`priceListId` y `customPriceCents` ausentes) | 400 | Must specify either priceListId or customPriceCents |
| Enviar ambos campos | 400 | Cannot specify both priceListId and customPriceCents |
| `customPriceCents <= 0` o no entero | 400 | customPriceCents must be a positive integer |
| Sin permiso `sale:update` | 403 | Insufficient permissions |
| Venta no existe / fuera de ownership | 404 | Sale not found |
| Item no pertenece a la venta | 404 | Item not found in this sale |
| Lista no aplicable al item | 422/409 segun mapping de negocio | Product/variant does not have a price in the specified price list |
| Venta no esta en `DRAFT` | 409 | Sale is not a draft |

> Nota: hay errores de negocio que pasan por `DomainExceptionFilter` con mapping por codigo interno.

---

## 8) Reglas de calculo para UI

- `lineTotalCents = unitPriceCents * quantity`
- `saleTotalCents = sum(lineTotalCents de todos los items)`
- El cambio de precio impacta total **inmediatamente** porque PATCH devuelve la venta actualizada.
- En esta version **no hay repricing automatico** al cambiar cantidad luego del override.

---

## 9) Flujo recomendado de integracion frontend

1. Usuario abre menu de item y toca “Cambiar precio”.
2. Front llama `GET /available-prices` para renderizar opciones.
3. Usuario elige:
   - lista (`priceListId`) o
   - custom (`customPriceCents`).
4. Front manda `PATCH /price`.
5. Backend responde `Sale` completa.
6. Front reemplaza el estado de la venta en store por la respuesta (source of truth).

---

## 10) Checklist rapido para frontend

- [ ] Agregar action UI “Cambiar precio” por item.
- [ ] Consumir `GET /sales/drafts/:saleId/items/:itemId/available-prices`.
- [ ] Soportar dos modos en formulario: `priceListId` o `customPriceCents`.
- [ ] Validar en UI `customPriceCents >= 1` antes de enviar.
- [ ] Manejar errores 400/403/404/409/422 con mensajes claros.
- [ ] Actualizar rendering de item usando nuevos campos (`priceSource`, `originalPriceCents`, etc.).
- [ ] Recalcular totales locales desde payload devuelto por backend.

---

## 11) Ejemplos cURL

### Listas disponibles

```bash
curl -X GET "http://localhost:3000/sales/drafts/<saleId>/items/<itemId>/available-prices" \
  -H "Authorization: Bearer <token>"
```

### Override por lista

```bash
curl -X PATCH "http://localhost:3000/sales/drafts/<saleId>/items/<itemId>/price" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"priceListId":"<uuid>"}'
```

### Override por custom

```bash
curl -X PATCH "http://localhost:3000/sales/drafts/<saleId>/items/<itemId>/price" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"customPriceCents":2198}'
```

---

Si queres, en una siguiente iteracion te paso una mini-guia de UX states (loading/empty/error/success) para que el modal de override quede redondo.
