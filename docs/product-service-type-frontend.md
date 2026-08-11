# Frontend Handoff — Tipo de Producto "SERVICIO"

## 1) ¿Qué cambió?

El tipo `SERVICE` ya existía en el enum `ProductType` (`PRODUCT | SERVICE`) pero **no tenía comportamiento diferencial** — crear un servicio era idéntico a crear un producto físico. Ahora el backend aplica reglas de dominio específicas para servicios. El frontend debe reflejar estas reglas en el formulario de creación/edición.

**Alcance MVP:** Paseo de perros con variantes de duración. Sin spa, guardería ni veterinaria (fases futuras).

---

## 2) Nuevos valores de enum

### `UnitOfMeasure` — 6 valores nuevos para servicios

Se agregaron al enum existente:

| Valor | Uso típico |
|---|---|
| `HORA` | Paseo por hora, entrenamiento |
| `SESION` | Sesión de grooming, consulta |
| `DIA` | Guardería diaria (futuro) |
| `CONSULTA` | Consulta veterinaria (futuro) |
| `CURSO` | Curso de adiestramiento (futuro) |
| `PAQUETE` | Paquete de sesiones (futuro) |

**Regla:** Cuando `type=SERVICE`, el selector de unidad debe mostrar **solo** estos 6 valores (HORA, SESION, DIA, CONSULTA, CURSO, PAQUETE). Cuando `type=PRODUCT`, mostrar solo los 8 tradicionales (UNIDAD, CAJA, BOLSA, METRO, CENTIMETRO, KILOGRAMO, GRAMO, LITRO).

---

## 3) API — `POST /products` (crear producto)

### Endpoint

```
POST /products
Authorization: Bearer <jwt>
Content-Type: application/json
```

### Body completo (todos los campos posibles)

```json
{
  "name": "Paseo de perros",
  "type": "SERVICE",
  "description": "Paseo recreativo con correa",
  "location": "Zona norte",
  "unit": "HORA",
  "categoryId": "uuid-de-categoria-servicios",
  "sellInPos": true,
  "includeInOnlineCatalog": true,
  "requiresPrescription": false,
  "chargeProductTaxes": true,
  "ivaRate": "IVA_16",
  "iepsRate": "NO_APLICA",
  "satKey": "80101500",
  "priceCents": 15000,
  "hasVariants": true,
  "serviceDetail": {
    "capacity": 5,
    "notes": "Sujeto a disponibilidad del paseador"
  },
  "variants": [
    {
      "option": "Duración",
      "value": "30 minutos",
      "priceCents": 10000
    },
    {
      "option": "Duración",
      "value": "1 hora",
      "priceCents": 15000
    }
  ],
  "images": [
    {
      "url": "https://storage.digitalocean.com/...",
      "isMain": true,
      "sortOrder": 0
    }
  ]
}
```

### Campos NUEVOS para SERVICE

#### `serviceDetail` (opcional, solo relevante para SERVICE)

```json
{
  "serviceDetail": {
    "capacity": 5,
    "notes": "Detalles adicionales del servicio"
  }
}
```

| Campo | Tipo | Validación | Default |
|---|---|---|---|
| `capacity` | `number` | `>= 1`, entero | `null` (sin límite) |
| `notes` | `string` | `maxLength: 500` | `null` |

- **`capacity`**: Capacidad máxima (cupo). Para el MVP de paseo probablemente no se use (va `null`). En futuro aplica para guardería ("10 perros por día").
- **`notes`**: Campo libre para notas operativas. Visible en el detalle del producto pero no en POS/ticket.
- Ambos campos son **opcionales y nullable**. Si no se envían, la fila `service_details` se crea igual (1:1 con el producto) con ambos en `null`.
- Para `type=PRODUCT`, el backend **ignora** este campo aunque se envíe.

### Campos BLOQUEADOS para SERVICE

**El backend rechaza con 400** si se envían estos campos cuando `type=SERVICE`:

| Campo | Error |
|---|---|
| `sku` | `"sku: SERVICE products cannot have a SKU"` |
| `barcode` | `"barcode: SERVICE products cannot have a barcode"` |
| `brandId` | `"brandId: SERVICE products cannot have a brand"` |
| `lots[]` | `"lots: SERVICE products cannot have lots"` |
| `useLotsAndExpirations: true` | `"useLotsAndExpirations: SERVICE products cannot enable lots"` |

**Recomendación:** Esconder estos campos del formulario cuando `type=SERVICE`. Si por algún motivo el frontend los manda, el backend los rechaza defensivamente.

### Campos con defaults forzados para SERVICE

El backend ignora el valor enviado y fuerza:

| Campo | Valor forzado |
|---|---|
| `useStock` | `false` |
| `useLotsAndExpirations` | `false` |
| `quantity` | `0` |
| `minQuantity` | `0` |
| `purchaseCost.mode` | `NET` |
| `purchaseCost.valueCents` | `0` |

**Recomendación:** Deshabilitar/ocultar estos campos también para SERVICE. El backend los fuerza igual, pero evitás confusión en la UI.

### Campo `location` — semántica dual

- **PRODUCT**: "Ubicación en almacén" (ej: "Bodega 3, Estante A12")
- **SERVICE**: "Zona de servicio" (ej: "Zona norte", "Sucursal Centro")

Es el mismo campo, pero la etiqueta en el formulario debería cambiar según el `type`. El backend no impone ninguna validación especial — es un string libre de máximo 120 caracteres.

### `hasVariants` + `variants[]` para SERVICE

Los servicios **sí** soportan variantes. Para el MVP de paseo de perros:

```json
{
  "type": "SERVICE",
  "unit": "HORA",
  "hasVariants": true,
  "variants": [
    { "option": "Duración", "value": "30 minutos" },
    { "option": "Duración", "value": "1 hora" }
  ]
}
```

- Las variantes heredan `useStock=false` del producto padre.
- El `unit` del producto aplica a todas las variantes. No hay `unit` por variante.
- Cada variante puede tener su propio `priceCents` a través de `priceLists` (lo maneja el backend automáticamente si `hasVariants=true`).

---

## 4) API — `PATCH /products/:id` (actualizar producto)

Mismo endpoint de siempre. `UpdateProductDto` es `PartialType(CreateProductDto)` — **todos los campos son opcionales**.

### Cambio de tipo (`type`) — regla CRÍTICA

```json
// PRODUCT → SERVICE (se bloquea si hay stock)
PATCH /products/uuid-1
{ "type": "SERVICE" }

// Respuesta 400 si el producto tiene quantity > 0 o lotes activos:
{
  "statusCode": 400,
  "error": "PRODUCT_TYPE_CHANGE_BLOCKED",
  "message": "Cannot convert a PRODUCT to SERVICE while stock or active lots remain"
}
```

| Transición | ¿Permitido? | Qué hace el backend |
|---|---|---|
| `PRODUCT → SERVICE` | ❌ Bloqueado si `quantity > 0` o hay lotes con stock | 400 `PRODUCT_TYPE_CHANGE_BLOCKED` |
| `PRODUCT → SERVICE` | ✅ Permitido si `quantity = 0` y sin lotes activos | Fuerza defaults SERVICE (stock=false, sku=null, etc.) |
| `SERVICE → PRODUCT` | ✅ Siempre | Restaura `useStock=true` y defaults de PRODUCT. Admin debe agregar stock después. |

**IMPORTANTE:** Cuando `SERVICE → PRODUCT`, el backend **limpia** la fila `ServiceDetail` y restaura los defaults. El admin debe hacer un PATCH posterior para setear stock/costos si es necesario. Avisar en la UI con un toast/warning.

---

## 5) API — `GET /products` (listar productos)

### Nuevo query param: `type`

```
GET /products?type=SERVICE    → solo servicios
GET /products?type=PRODUCT    → solo productos físicos
GET /products                  → ambos (comportamiento actual)
```

El enum aceptado es exactamente `PRODUCT` o `SERVICE`. Cualquier otro valor es ignorado por el `ValidationPipe` (devuelve ambos).

### Cambios en la respuesta

Cada producto en la lista y en el detalle (`GET /products/:id`) ahora incluye:

```json
{
  "id": "uuid",
  "name": "Paseo de perros",
  "type": "SERVICE",
  "unit": "HORA",
  "useStock": false,
  "useLotsAndExpirations": false,
  "quantity": 0,
  "minQuantity": 0,
  "sku": null,
  "barcode": null,
  "brandId": null,
  "brand": null,
  "purchaseCost": {
    "mode": "NET",
    "netCents": 0,
    "grossCents": 0,
    "netDecimal": 0,
    "grossDecimal": 0
  },
  "serviceDetail": {
    "capacity": 5,
    "notes": "Sujeto a disponibilidad del paseador"
  },
  "hasVariants": true,
  "variants": [
    {
      "id": "uuid-variant-1",
      "name": "30 minutos",
      "option": "Duración",
      "value": "30 minutos",
      "quantity": 0,
      "minQuantity": 0
    }
  ],
  "category": { "id": "uuid-cat", "name": "Servicios" },
  "priceCents": 15000,
  "priceDecimal": 150.00
}
```

**Nuevo campo `serviceDetail`:**
- `null` cuando `type=PRODUCT` o el producto SERVICE no tiene datos cargados
- `{ capacity: number | null, notes: string | null }` cuando hay datos
- `capacity` y `notes` pueden ser ambos `null` (fila existe pero vacía)

---

## 6) API — `POST /products/:id/lots` (agregar lote)

### Bloqueado para SERVICE

```
POST /products/uuid-service/lots
→ 422 LOTS_NOT_ALLOWED_ON_SERVICE
```

**Recomendación:** Ocultar la sección de lotes / pestaña de inventario para productos SERVICE. Si el usuario llega a la URL directa, el backend lo rechaza.

---

## 7) API — `POST /products/:id/variants` (agregar variante)

### Comportamiento heredado

Las variantes de un SERVICE heredan `useStock=false`. El backend permite crearlas normalmente. Los campos `sku`, `barcode`, `quantity` y `minQuantity` son opcionales y se ignoran (el backend los fuerza a null/0).

**Recomendación:** En el formulario de variantes para SERVICE, mostrar solo `option`, `value` y `purchaseNetCostCents` (si aplica). Ocultar `sku`, `barcode`, `quantity`, `minQuantity`.

---

## 8) Matriz de visibilidad de campos en el formulario

| Campo | PRODUCT | SERVICE | Nota |
|---|---|---|---|
| `name` | ✅ | ✅ | |
| `description` | ✅ | ✅ | |
| `type` | ✅ | ✅ | Selector principal |
| `unit` | ✅ (8 valores) | ✅ (6 valores) | Filtrar opciones según type |
| `location` | ✅ "Ubicación" | ✅ "Zona de servicio" | Cambiar label |
| `categoryId` | ✅ | ✅ | |
| `brandId` | ✅ | ❌ Ocultar | Backend fuerza null |
| `sku` | ✅ | ❌ Ocultar | Backend rechaza con 400 |
| `barcode` | ✅ | ❌ Ocultar | Backend rechaza con 400 |
| `satKey` | ✅ | ✅ | |
| `sellInPos` | ✅ | ✅ | |
| `includeInOnlineCatalog` | ✅ | ✅ | |
| `requiresPrescription` | ✅ | ✅ | |
| `chargeProductTaxes` | ✅ | ✅ | |
| `ivaRate` | ✅ | ✅ | |
| `iepsRate` | ✅ | ✅ | |
| `purchaseCost` | ✅ | ❌ Ocultar | Backend fuerza 0 |
| `useStock` | ✅ | ❌ Ocultar | Backend fuerza false |
| `useLotsAndExpirations` | ❌ Ocultar si useStock=false | ❌ Ocultar | Backend fuerza false |
| `quantity` | ✅ | ❌ Ocultar | Backend fuerza 0 |
| `minQuantity` | ✅ | ❌ Ocultar | Backend fuerza 0 |
| `hasVariants` | ✅ | ✅ | |
| `variants[]` | ✅ | ✅ | Solo option/value para SERVICE |
| `lots[]` | ✅ (si useLots=true) | ❌ Ocultar | Backend rechaza con 422 |
| `priceCents` | ✅ | ✅ | Precio de venta |
| `serviceDetail` | ❌ Ocultar | ✅ Mostrar | capacity + notes |
| `images[]` | ✅ | ✅ | |
| `priceLists[]` | ✅ | ✅ | |

---

## 9) POS / Catálogo de venta

Los productos SERVICE aparecen en `GET /sales/pos-catalog` **igual que los PRODUCT**. La respuesta del POS ya incluye `type`, `useStock`, y `serviceDetail`. El frontend del POS no necesita cambios: si `useStock=false`, el flujo de venta simplemente no descuenta inventario (comportamiento que ya existe).

---

## 10) Cotizaciones y ventas

Cero cambios en el contrato. Un SERVICE se puede agregar a una cotización o venta igual que un PRODUCT. El `QuotationItem` / `SaleItem` referencian al `Product` por FK, que no cambió.

---

## 11) Errores específicos de SERVICE

| Código | HTTP | Cuándo |
|---|---|---|
| `INVALID_ARGUMENT` | 400 | `sku`, `barcode`, `brandId`, `lots` enviados con `type=SERVICE` |
| `INVALID_ARGUMENT` | 400 | `useLotsAndExpirations: true` con `type=SERVICE` |
| `PRODUCT_TYPE_CHANGE_BLOCKED` | 400 | Cambio `PRODUCT → SERVICE` con stock o lotes activos |
| `LOTS_NOT_ALLOWED_ON_SERVICE` | 422 | `POST /products/:id/lots` en un SERVICE |

---

## 12) Checklist mínimo para el frontend

1. **Selector de tipo**: Al cambiar entre PRODUCT y SERVICE, mostrar/ocultar campos según la matriz de la sección 8.
2. **Selector de unidad**: Filtrar opciones según `type` (8 para PRODUCT, 6 para SERVICE).
3. **Label de `location`**: Cambiar entre "Ubicación en almacén" y "Zona de servicio".
4. **Sección `serviceDetail`**: Mostrar solo cuando `type=SERVICE`. Campos: `capacity` (number, opcional) y `notes` (textarea, máx 500 chars).
5. **Sección de inventario**: Ocultar completamente para SERVICE (`useStock`, `quantity`, `minQuantity`, `purchaseCost`, `lots`).
6. **Sección de marca**: Ocultar `brandId` para SERVICE.
7. **Campos `sku`/`barcode`**: Ocultar para SERVICE.
8. **Formulario de variantes**: Para variantes de SERVICE, ocultar `sku`, `barcode`, `quantity`, `minQuantity`. Mostrar solo `option`, `value`, `purchaseNetCostCents`.
9. **Cambio de tipo en edición**: Si el usuario cambia `PRODUCT → SERVICE`, advertir que se perderá el inventario. Si cambia `SERVICE → PRODUCT`, advertir que debe agregar stock manualmente después.
10. **Listado**: Agregar filtro por `type` (`?type=SERVICE` o `?type=PRODUCT`).
11. **Badge/etiqueta en tabla**: Mostrar un badge "Servicio" vs "Producto" en la columna de tipo en listados.
12. **POS**: Sin cambios requeridos. El backend ya omite el descuento de stock para `useStock=false`.

---

## 13) Fuera de alcance actual (próximas fases)

- ❌ `deliveryMode` (a domicilio / en sucursal) — no implementado
- ❌ Asignación de staff/empleado al servicio
- ❌ Booking/agendamiento de servicios
- ❌ Capacidad con control de sobreventa (el campo `capacity` existe pero es informativo)
- ❌ Unidades de medida adicionales para spa/veterinaria
- ❌ `hidePriceInOnlineCatalog` (ya existe en BD con default `false`, pero no está expuesto en la API de productos)
