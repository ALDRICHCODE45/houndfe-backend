# Frontend Quick Start — Módulo de Productos

Guía rápida para integrar el módulo **sin suposiciones**.  
Fuente de verdad: backend actual (`products` + `categories`).

---

## 1) URLs base

- Productos: `/products`
- Categorías: `/categories`
- Catálogo global de listas de precio: `/price-lists`

---

## 2) Checklist mínimo de implementación

1. Construir formulario con secciones:
   - Datos del producto
   - Datos adicionales
   - Existencias
   - Impuestos
   - Variantes
   - Precio de compra
   - Precios de venta
   - Imágenes
2. Aplicar dependencias de estado (ver sección 3).
3. Crear producto (`POST /products`).
4. Según toggles:
   - variantes → `POST /products/:id/variants`
   - lotes → `POST /products/:id/lots`
5. Si hay variantes, gestionar precios por variante:
   - `GET /products/:id/variants/:variantId/prices`
   - `PUT /products/:id/variants/:variantId/prices/:priceListId`
   - `PUT /products/:id/variants/:variantId/prices` (bulk)
6. Cargar listas de precios extra (globales) → `POST /price-lists`
7. Cargar imágenes → `POST /products/:id/images`
8. Refrescar detalle completo → `GET /products/:id`

---

## 3) Reglas de estado del formulario (CRÍTICO)

### Inventario

- Si `useStock = false`:
  - forzar `useLotsAndExpirations = false`
  - forzar `quantity = 0`
  - forzar `minQuantity = 0`

- Si `hasVariants = true`:
  - ocultar/deshabilitar lotes
  - forzar `useLotsAndExpirations = false`
  - forzar `quantity = 0`
  - forzar `minQuantity = 0`

- Si `useStock = false` en producto con variantes:
  - backend normaliza `variant.minQuantity = 0` (aunque envíes otro valor)

- Si `useLotsAndExpirations = true` (con `useStock=true` y `hasVariants=false`):
  - `quantity` del producto debe ir en `0`
  - stock real se maneja con lotes
  - `minQuantity` se mantiene editable

### Precios

- Siempre existe lista `PUBLICO`.
- `priceCents` **no es columna** del producto — es un campo calculado desde la lista `PUBLICO`.
- En las respuestas (`GET /products`, `GET /products/:id`, `POST`, `PATCH`) el producto incluye `priceCents` y `priceDecimal` calculados desde PUBLICO.
- `priceCents` en `POST/PATCH /products` se redirige internamente a la lista `PUBLICO`.
- Listas adicionales se crean globalmente (`POST /price-lists`).
- Al crear variante, backend crea `VariantPrice=0` para todas las listas del producto.
- Al crear lista global nueva, backend crea:
  - `PriceList=0` para todos los productos
  - `VariantPrice=0` para todas las variantes
- En upsert de precio por variante:
  - `tierPrices` omitido = no tocar tiers
  - `tierPrices: []` = limpiar tiers
  - `tierPrices: [...]` = reemplazar tiers

### Imágenes

- `isMain=true` debe quedar única por ámbito:
  - ámbito producto (`variantId = null`)
  - ámbito variante (`variantId = <uuid>`)

---

## 4) Flujos con payloads copy/paste

## A. Crear producto base (sin variantes, sin lotes)

### Request

`POST /products`

```json
{
  "name": "Jabón artesanal",
  "sku": "JAB-001",
  "barcode": "7501234567890",
  "unit": "UNIDAD",
  "categoryId": "f3e2f7a4-5fb9-4f2e-9b36-1d77d6f9c111",
  "location": "Estante A-1",
  "description": "Jabón de lavanda",
  "sellInPos": true,
  "includeInOnlineCatalog": true,
  "chargeProductTaxes": true,
  "ivaRate": "IVA_16",
  "iepsRate": "NO_APLICA",
  "purchaseCost": {
    "mode": "NET",
    "valueCents": 12000
  },
  "useStock": true,
  "useLotsAndExpirations": false,
  "quantity": 50,
  "minQuantity": 5,
  "hasVariants": false,
  "priceCents": 45005,
  "satKey": "01010101"
}
```

### Resultado esperado

- `201`
- Devuelve detalle completo del producto.
- Crea lista `PUBLICO` automáticamente.

---

## B. Crear producto con variantes

### 1) Crear producto

`POST /products`

```json
{
  "name": "Playera",
  "hasVariants": true,
  "useStock": true,
  "priceCents": 19900
}
```

### 2) Crear variantes

`POST /products/:id/variants`

```json
{
  "option": "Tamaño",
  "value": "Mediano",
  "sku": "PLAY-M",
  "barcode": "770000000001",
  "quantity": 30,
  "minQuantity": 5,
  "purchaseNetCostCents": 4500
}
```

`POST /products/:id/variants`

```json
{
  "option": "Tamaño",
  "value": "Grande",
  "sku": "PLAY-G",
  "barcode": "770000000002",
  "quantity": 12,
  "minQuantity": 2,
  "purchaseNetCostCents": null
}
```

### Resultado esperado

- Al crear primera variante, backend mantiene consistencia de inventario a nivel producto.
- No usar lotes en productos con variantes.
- Si enviás `option + value`, backend guarda `name = value`.
- `purchaseNetCostCents` en variante es opcional:
  - `null` (o ausente) = hereda costo de compra neto del producto
  - número `>= 0` = override por variante
- Se auto-crean cruces de precios por variante para todas las listas existentes (inician en 0).

---

## C. Crear producto con lotes

### 1) Crear producto en modo lotes

`POST /products`

```json
{
  "name": "Suplemento",
  "useStock": true,
  "hasVariants": false,
  "useLotsAndExpirations": true,
  "minQuantity": 10,
  "priceCents": 8900
}
```

### 2) Agregar lote

`POST /products/:id/lots`

```json
{
  "lotNumber": "LOTE-2026-04",
  "quantity": 66,
  "manufactureDate": "2026-04-01T00:00:00.000Z",
  "expirationDate": "2026-10-01T00:00:00.000Z"
}
```

---

## D. Categorías (combo + modal "crear categoría")

### Crear categoría

`POST /categories`

```json
{
  "name": "Alimentos"
}
```

### Listar categorías

`GET /categories`

### Regla importante

- `name` es único.
- Si eliminás una categoría ya usada, el producto queda con `categoryId = null`.

---

## E. Listas de precio y precios por cantidad

### Crear lista adicional global

`POST /price-lists`

```json
{
  "name": "Mayoreo"
}
```

### Reglas

- `minQuantity` de tiers: entero, `>= 0`, único, estrictamente ascendente.
- No se puede borrar ni renombrar `PUBLICO`.
- Al crear una lista nueva, backend auto-crea price lists/variant prices en 0 de forma masiva.

### Precios por variante (single upsert)

`PUT /products/:productId/variants/:variantId/prices/:priceListId`

```json
{
  "priceCents": 18900,
  "tierPrices": [
    { "minQuantity": 0, "priceCents": 18900 },
    { "minQuantity": 10, "priceCents": 16900 }
  ]
}
```

### Precios por variante (bulk merge)

`PUT /products/:productId/variants/:variantId/prices`

```json
{
  "prices": [
    {
      "priceListId": "uuid-publico",
      "priceCents": 19900,
      "tierPrices": [{ "minQuantity": 0, "priceCents": 19900 }]
    },
    {
      "priceListId": "uuid-mayoreo",
      "priceCents": 15900
    }
  ]
}
```

---

## F. Imágenes (producto y variante)

### Imagen de producto

`POST /products/:id/images`

```json
{
  "url": "https://cdn.tu-dominio.com/products/jabon-1.jpg",
  "isMain": true,
  "sortOrder": 0
}
```

### Imagen de variante

`POST /products/:id/images`

```json
{
  "url": "https://cdn.tu-dominio.com/products/jabon-mediano.jpg",
  "variantId": "9a44bf7f-6db0-4dd5-a58a-6cd52f5818c4",
  "isMain": true,
  "sortOrder": 1
}
```

### Advertencia

- Si `variantId` no pertenece al producto, backend responde `VARIANT_PRODUCT_MISMATCH`.

---

## 5) Manejo de errores por pantalla

## Pantalla: crear/editar producto

- `409 ENTITY_ALREADY_EXISTS`
  - SKU duplicado o barcode duplicado
  - Acción UI: marcar campo, mostrar “Ya existe”.
- `400 INVALID_ARGUMENT`
  - números negativos, formato inválido
  - Acción UI: mostrar validación de campo.

## Pantalla: lotes

- `422 LOTS_NOT_ENABLED`
  - intentaste crear lote sin toggle activo
- `422 PRODUCT_HAS_VARIANTS`
  - intentaste lotes en producto con variantes
- `409 ENTITY_ALREADY_EXISTS`
  - `lotNumber` duplicado en ese producto

## Pantalla: listas de precio

- `422 DEFAULT_PRICE_LIST_PROTECTED`
  - intentaste borrar o renombrar `PUBLICO`
- `422 INVALID_TIER_SEQUENCE`
  - tiers repetidos / no ascendentes

## Pantalla: precios por variante

- `422 DEFAULT_PRICE_LIST_PROTECTED`
  - intentaste borrar precio de variante para `PUBLICO`
- `422 VARIANT_PRODUCT_MISMATCH`
  - variante no pertenece al producto
- `422 PRICE_LIST_PRODUCT_MISMATCH`
  - lista de precio no pertenece al producto

## Pantalla: imágenes

- `422 VARIANT_PRODUCT_MISMATCH`
  - variante no pertenece al producto
- `422 MAIN_IMAGE_CONFLICT`
  - conflicto de unicidad de imagen principal en mismo ámbito

## Error envelope

```json
{
  "statusCode": 422,
  "error": "INVALID_TIER_SEQUENCE",
  "message": "Tier thresholds must be strictly ascending and unique: 10 -> 10",
  "timestamp": "2026-04-01T00:00:00.000Z"
}
```

---

## 6) Campos clave para mapear en UI

### Enums

- `type`: `PRODUCT`, `SERVICE`
- `unit`: `UNIDAD`, `CAJA`, `BOLSA`, `METRO`, `CENTIMETRO`, `KILOGRAMO`, `GRAMO`, `LITRO`
- `ivaRate`: `IVA_16`, `IVA_8`, `IVA_0`, `IVA_EXENTO`
- `iepsRate`: `NO_APLICA`, `IEPS_160`, `IEPS_53`, `IEPS_50`, `IEPS_30_4`, `IEPS_30`, `IEPS_26_5`, `IEPS_25`, `IEPS_9`, `IEPS_8`, `IEPS_7`, `IEPS_6`, `IEPS_3`, `IEPS_0`
- `purchaseCost.mode`: `NET`, `GROSS`

### Moneda

- Backend maneja montos en **centavos** (`priceCents`, `valueCents`).
- Convertir en UI para mostrar moneda (`/100`) y volver a centavos al guardar.

---

## 7) "Do this, not that"

- ✅ Usar `GET /products` para grilla (liviano).
  - Cuando `hasVariants=true`, la grilla recibe además:
    - `variantStockTotal` (suma de stock de variantes)
    - `variantCount` (cantidad de variantes)
  - Cuando `hasVariants=false`, esos campos no vienen en el JSON.
- ✅ Usar `GET /products/:id` para editar detalle.
- ✅ Después de operaciones complejas (variantes/lotes/precios), refrescar detalle.

- ❌ No asumir que `quantity` representa stock real cuando hay lotes.
- ❌ No intentar renombrar o borrar lista `PUBLICO`.
- ❌ No mandar `variantId` cualquiera al subir imagen.

---

## 8) Fuera de alcance actual

- Lógica especial para `type=SERVICE` (todavía no implementada).
