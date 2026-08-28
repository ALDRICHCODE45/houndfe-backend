# POS — Venta "para entrega" al cobrar (flag `delivery`)

> Documento orientado al equipo frontend. Complementa (no reemplaza) el contrato canónico de cobro en `docs/sales-pos-charge-frontend.md` (§3) y el de rutas en `docs/delivery-routes-frontend.md`.

## 1) Resumen

Antes, toda venta del POS (mostrador) nacía con `deliveryStatus: 'DELIVERED'` y **nunca** podía agregarse a una ruta de entrega (`DeliveryRoute`). Ahora el cajero puede marcar, en el mismo momento de cobrar, que la venta es **"para entrega a domicilio"**. La venta queda con `deliveryStatus: 'PENDING'` y pasa a ser elegible para una ruta.

El cambio para el frontend es mínimo:

- **Un campo nuevo y opcional** en el body del cobro: `delivery?: boolean`.
- **Un error nuevo** a manejar: `422 SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY`.
- Todo lo demás (formato de pagos, respuesta, idempotencia) no cambia.

## 2) Endpoint

```http
POST /sales/drafts/:id/charge
Authorization: Bearer <jwt>
Idempotency-Key: <uuid-o-string-unico>
```

Permiso: `update:Sale` (el mismo de siempre para cobrar).

### Body

Se agrega el campo opcional `delivery` a los dos formatos ya soportados.

**Formato array (recomendado):**

```json
{
  "payments": [
    { "method": "cash", "amountCents": 55000 }
  ],
  "delivery": true
}
```

**Formato legacy (un solo pago):**

```json
{
  "method": "cash",
  "amountCents": 55000,
  "delivery": true
}
```

| Campo | Tipo | Requerido | Reglas |
|---|---|---|---|
| `delivery` | `boolean` | No | Solo `true` activa el flujo de entrega. `false` u omitido = comportamiento actual. |

> El campo `delivery` es independiente del formato de pago: podés combinarlo con `payments[]`, con `method`/`amountCents` legacy, y con `dueDate`.

### Requisito previo obligatorio: dirección de envío

Si `delivery: true`, la venta **DEBE tener una dirección de envío asignada** (`shippingAddressId != null`). La dirección se asigna **antes de cobrar**, con:

```http
PUT /sales/drafts/:id/shipping-address
Authorization: Bearer <jwt>
Content-Type: application/json
```

```json
{ "shippingAddressId": "uuid-de-la-direccion" }
```

- Permiso: `update:Sale`.
- La dirección requiere que la venta tenga un **cliente asignado** (se asigna con `PUT /sales/drafts/:id/customer`). Sin cliente → error `SHIPPING_ADDRESS_REQUIRES_CUSTOMER`.
- Para quitar la dirección: `DELETE /sales/drafts/:id/shipping-address` (204).

## 3) Errores nuevos / relevantes

| Caso | Error | HTTP |
|---|---|---|
| `delivery: true` sin dirección de envío | `SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY` | 422 |
| Dirección sin cliente asignado | `SHIPPING_ADDRESS_REQUIRES_CUSTOMER` | 422 |
| Retry con mismo `Idempotency-Key` pero distinto valor de `delivery` | `IDEMPOTENCY_KEY_CONFLICT` | 409 |

> Los errores vienen en el cuerpo estándar `ProblemDetails` (mismo formato que el resto de la API).

## 4) Respuesta del cobro

**No cambia.** La respuesta es idéntica a la actual (`saleId`, `folio`, `subtotalCents`, `discountCents`, `totalCents`, `paidCents`, `debtCents`, `changeDueCents`, `paymentStatus`, `confirmedAt`).

El `deliveryStatus` de la venta resultante se consulta por separado (`GET /sales/:id` o el listado), y será `PENDING` cuando se cobró con `delivery: true`.

## 5) Flujo completo de una venta para entrega

```text
1. Cajero arma el draft (productos, cliente).
2. Asigna dirección: PUT /sales/drafts/:id/shipping-address  { shippingAddressId }
3. Cobra con el flag:  POST /sales/drafts/:id/charge  { ..., "delivery": true }
   └─ la venta confirma con deliveryStatus = PENDING
4. (En el módulo de rutas) la venta PENDING aparece como elegible y se agrega
   a una DeliveryRoute como parada.
5. Al hacer check-in de la parada, la ruta la marca como entregada
   (deliveryStatus = DELIVERED).
```

- `PENDING` → elegible para ruta (con dirección).
- `DELIVERED` (default actual) → **no** elegible.
- `SHIPPED` → estado exclusivo del flujo del bot (WhatsApp/ONLINE), **no** se usa en POS.

## 6) Listado de ventas pendientes de entrega

Para mostrar "ventas por entregar", filtrar el listado existente:

```http
GET /sales?deliveryStatus=PENDING
```

El filtro `deliveryStatus` ya existe (CSV, acepta múltiples valores separados por coma, p. ej. `PENDING,SHIPPED`). Valores válidos hoy: `PENDING`, `DELIVERED`, `NOT_APPLICABLE`.

> Nota: `SHIPPED` todavía no es un valor filtrable en el listado (gap preexistente, fuera de alcance de este cambio). Para POS alcanza con filtrar `PENDING`.

## 7) Notas de UX sugeridas (frontend)

1. En la pantalla/paso de cobro, agregar un **toggle "Entrega a domicilio"** (o similar) que envíe `delivery: true`.
2. El toggle debería **deshabilitarse** (o pedir acción) si la venta no tiene dirección de envío asignada. Si se envía `delivery: true` sin dirección, el backend responde `422 SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY` — mostrar ese mensaje al cajero.
3. `delivery` omitido o `false` = cobro normal de mostrador. No hay impacto en el flujo actual si el frontend no lo usa todavía.
4. Al cobrar con `delivery: true`, no hace falta cambiar nada en la pantalla de éxito; la venta ya queda `PENDING` y disponible para el módulo de rutas.

## 8) Ejemplos curl

```bash
# Asignar dirección a un draft (requiere cliente previo)
curl -X PUT 'https://api.houndfe.com/sales/drafts/<saleId>/shipping-address' \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{ "shippingAddressId": "<uuid>" }'

# Cobrar marcando entrega a domicilio
curl -X POST 'https://api.houndfe.com/sales/drafts/<saleId>/charge' \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: <uuid-unico>" \
  -d '{ "payments": [ { "method": "cash", "amountCents": 55000 } ], "delivery": true }'

# Listar ventas pendientes de entrega
curl 'https://api.houndfe.com/sales?deliveryStatus=PENDING' \
  -H "Authorization: Bearer <jwt>"
```

## 9) Referencias

- `docs/sales-pos-charge-frontend.md` — contrato completo del cobro (formato de pagos, idempotencia, cálculo de `paymentStatus`/`changeDueCents`).
- `docs/delivery-routes-frontend.md` — módulo de rutas de entrega (paradas, check-in, elegibilidad).
- `docs/customers-frontend.md` — direcciones y clientes.
