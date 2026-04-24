# Módulo de Productos — Contrato Técnico para Frontend

Documento técnico basado en código actual (`src/products`, `prisma/schema.prisma`, filtros de error).

---

## 1) Resumen de modelo de datos

## Product

- Tabla: `products`
- Campos relevantes:
  - `id: string (uuid, PK)`
  - `name: string`
  - `location?: string`
  - `description?: string`
  - `type: ProductType` (default `PRODUCT`)
  - `sku?: string` (unique)
  - `barcode?: string` (unique)
  - `unit: UnitOfMeasure` (default `UNIDAD`)
  - `satKey?: string`
  - `categoryId?: string` (FK a `categories`, onDelete `SetNull`)
  - `sellInPos: boolean` (default `true`)
  - `includeInOnlineCatalog: boolean` (default `true`)
  - `chargeProductTaxes: boolean` (default `true`)
  - `ivaRate: IvaRate` (default `IVA_16`)
  - `iepsRate: IepsRate` (default `NO_APLICA`)
  - `purchaseCostMode: PurchaseCostMode` (default `NET`)
  - `purchaseNetCostCents: int` (default `0`)
  - `purchaseGrossCostCents: int` (default `0`)
  - `useStock: boolean` (default `true`)
  - `useLotsAndExpirations: boolean` (default `false`)
  - `quantity: int` (default `0`)
  - `minQuantity: int` (default `0`)
  - `hasVariants: boolean` (default `false`)
  - `createdAt`, `updatedAt`

## Category

- Tabla: `categories`
- Campos: `id`, `name (unique)`, timestamps

## Variant

- Tabla: `variants`
- Campos:
  - `id`, `productId` (FK cascade)
  - `name`
  - `option?` (string libre, p. ej. `Tamaño`, `Color`)
  - `value?` (valor concreto, p. ej. `Mediano`, `Rojo`)
  - `sku?` (unique global)
  - `barcode?` (unique global)
  - `quantity` (default 0)
  - `minQuantity` (default 0)
  - `purchaseNetCostCents?` (nullable; `null` = hereda costo neto del producto)
  - timestamps

## Lot

- Tabla: `lots`
- Campos:
  - `id`, `productId` (FK cascade)
  - `lotNumber`
  - `quantity`
  - `manufactureDate?`
  - `expirationDate`
  - timestamps
- Restricción: `@@unique([productId, lotNumber])`

## GlobalPriceList

- Tabla: `global_price_lists`
- Campos:
  - `id`
  - `name` (unique global)
  - `isDefault` (solo `PUBLICO` = `true`)
  - timestamps

## PriceList

- Tabla: `price_lists`
- Campos:
  - `id`, `productId` (FK cascade)
  - `globalPriceListId` (FK cascade a `global_price_lists`)
  - `priceCents`
  - timestamps
- Restricción: `@@unique([productId, globalPriceListId])`

## VariantPrice

- Tabla: `variant_prices`
- Campos:
  - `id`, `variantId`, `priceListId`
  - `priceCents`
- Restricción: `@@unique([variantId, priceListId])`

## VariantTierPrice

- Tabla: `variant_tier_prices`
- Campos:
  - `id`, `variantPriceId`
  - `minQuantity`
  - `priceCents`
- Restricción: `@@unique([variantPriceId, minQuantity])`

## TierPrice

- Tabla: `tier_prices`
- Campos:
  - `id`, `priceListId` (FK cascade)
  - `minQuantity`
  - `priceCents`
- Restricción: `@@unique([priceListId, minQuantity])`

## ProductImage

- Tabla: `product_images`
- Campos:
  - `id`, `productId` (FK cascade)
  - `variantId?` (FK a `variants`, cascade)
  - `url`
  - `isMain` (default false)
  - `sortOrder` (default 0)
  - `createdAt`
- Restricciones adicionales por índice parcial (migración SQL):
  - 1 imagen main a nivel producto (`variantId IS NULL`)
  - 1 imagen main por variante (`variantId IS NOT NULL`)

---

## 2) Enumeraciones (valores permitidos exactos)

### ProductType

- `PRODUCT`
- `SERVICE`

### UnitOfMeasure

- `UNIDAD`
- `CAJA`
- `BOLSA`
- `METRO`
- `CENTIMETRO`
- `KILOGRAMO`
- `GRAMO`
- `LITRO`

### IvaRate

- `IVA_16`
- `IVA_8`
- `IVA_0`
- `IVA_EXENTO`

### IepsRate

- `NO_APLICA`
- `IEPS_160`
- `IEPS_53`
- `IEPS_50`
- `IEPS_30_4`
- `IEPS_30`
- `IEPS_26_5`
- `IEPS_25`
- `IEPS_9`
- `IEPS_8`
- `IEPS_7`
- `IEPS_6`
- `IEPS_3`
- `IEPS_0`

### PurchaseCostMode

- `NET`
- `GROSS`

---

## 3) DTOs y constraints

## CreateProductDto

| Campo                    | Tipo                     | Req. | Constraints                     |
| ------------------------ | ------------------------ | ---: | ------------------------------- |
| `name`                   | `string`                 |   Sí | `maxLength(100)`                |
| `location`               | `string`                 |   No | `maxLength(120)`                |
| `description`            | `string`                 |   No | `maxLength(2000)`               |
| `type`                   | `'PRODUCT' \| 'SERVICE'` |   No | enum                            |
| `sku`                    | `string`                 |   No | —                               |
| `barcode`                | `string`                 |   No | —                               |
| `unit`                   | enum UnitOfMeasure       |   No | enum                            |
| `satKey`                 | `string`                 |   No | —                               |
| `categoryId`             | `string`                 |   No | (sin `IsUUID`; FK valida en DB) |
| `sellInPos`              | `boolean`                |   No | —                               |
| `includeInOnlineCatalog` | `boolean`                |   No | —                               |
| `chargeProductTaxes`     | `boolean`                |   No | —                               |
| `ivaRate`                | enum IvaRate             |   No | enum                            |
| `iepsRate`               | enum IepsRate            |   No | enum                            |
| `purchaseCost`           | objeto                   |   No | `mode` enum + `valueCents >= 0` |
| `useStock`               | `boolean`                |   No | —                               |
| `useLotsAndExpirations`  | `boolean`                |   No | —                               |
| `quantity`               | `number`                 |   No | `>= 0`                          |
| `minQuantity`            | `number`                 |   No | `>= 0`                          |
| `hasVariants`            | `boolean`                |   No | —                               |
| `priceCents`             | `number`                 |   No | `>= 0`                          |

## UpdateProductDto

- `PartialType(CreateProductDto)` → todos opcionales, mismas constraints.

## Variants

- `CreateVariantDto`
  - `name?: string` opcional (`maxLength(100)`)
  - `option?: string` opcional (`maxLength(50)`)
  - `value?: string` opcional (`maxLength(100)`)
  - `sku?: string`
  - `barcode?: string`
  - `quantity?: number` (`>= 0`)
  - `minQuantity?: number` (`>= 0`)
  - `purchaseNetCostCents?: number \| null` (`>= 0`; `null` restaura herencia)
- `UpdateVariantDto`: todos opcionales, mismas reglas.

Regla adicional en servicio (no solo DTO):

- Si vienen `option + value` → backend persiste `name = value`.
- Si no vienen ambos, usa `name` (y si no hay nombre válido, lanza `INVALID_ARGUMENT`).

## Lots

- `CreateLotDto`
  - `lotNumber: string` requerido
  - `quantity?: number` (`>= 0`)
  - `manufactureDate?: string` (`IsDateString`)
  - `expirationDate: string` (`IsDateString`, requerido)
- `UpdateLotDto`: opcionales (`quantity`, `manufactureDate`, `expirationDate`).

## Price Lists (nivel producto)

- `TierPriceDto`
  - `minQuantity: int` (`IsInt`, `>= 0`)
  - `priceCents: number` (`>= 0`)
- `UpdatePriceListDto`
  - `priceCents?: number` (`>= 0`)
  - `tierPrices?: TierPriceDto[]` (si viene, reemplaza todos)

## Global Price Lists

- `CreatePriceListDto` (`/price-lists`)
  - `name: string` requerido (`maxLength(50)`)
- `UpdatePriceListDto` (`/price-lists/:id`)
  - `name?: string` (`maxLength(50)`)

## Images

- `CreateImageDto`
  - `url: string` requerido (`IsUrl`)
  - `isMain?: boolean`
  - `sortOrder?: number`
  - `variantId?: string` (sin `IsUUID`)

## Variant Prices

- `VariantTierPriceDto`
  - `minQuantity: int` (`IsInt`, `>= 0`)
  - `priceCents: number` (`>= 0`)
- `UpsertVariantPriceDto`
  - `priceCents: number` requerido (`>= 0`)
  - `tierPrices?: VariantTierPriceDto[]`
- `BulkVariantPriceItemDto`
  - `priceListId: uuid` requerido
  - `priceCents: number` requerido (`>= 0`)
  - `tierPrices?: VariantTierPriceDto[]`
- `BulkUpsertVariantPricesDto`
  - `prices: BulkVariantPriceItemDto[]`

---

## 4) Catálogo de endpoints (ProductsController)

Base: `/products`

## Producto

| Método   | Path            | Body               | Respuesta                                                                  |
| -------- | --------------- | ------------------ | -------------------------------------------------------------------------- |
| `POST`   | `/products`     | `CreateProductDto` | `201`, detalle completo (producto + priceLists + variants + images + lots) |
| `GET`    | `/products`     | —                  | `200`, lista de productos (shape corto)                                    |
| `GET`    | `/products/:id` | —                  | `200`, detalle completo                                                    |
| `PATCH`  | `/products/:id` | `UpdateProductDto` | `200`, detalle completo                                                    |
| `DELETE` | `/products/:id` | —                  | `204`, sin body                                                            |

## Variantes

| Método   | Path                                | Body               | Respuesta                                       |
| -------- | ----------------------------------- | ------------------ | ----------------------------------------------- |
| `POST`   | `/products/:id/variants`            | `CreateVariantDto` | `201`, variante creada                          |
| `GET`    | `/products/:id/variants`            | —                  | `200`, variantes con `images` y `variantPrices` |
| `PATCH`  | `/products/:id/variants/:variantId` | `UpdateVariantDto` | `200`, variante actualizada                     |
| `DELETE` | `/products/:id/variants/:variantId` | —                  | `204`, sin body                                 |

## Precios por variante

| Método   | Path                                                           | Body                         | Respuesta                               |
| -------- | -------------------------------------------------------------- | ---------------------------- | --------------------------------------- |
| `GET`    | `/products/:productId/variants/:variantId/prices`              | —                            | `200`, array enriquecido                |
| `PUT`    | `/products/:productId/variants/:variantId/prices/:priceListId` | `UpsertVariantPriceDto`      | `200`, item enriquecido                 |
| `PUT`    | `/products/:productId/variants/:variantId/prices`              | `BulkUpsertVariantPricesDto` | `200`, array enriquecido (merge upsert) |
| `DELETE` | `/products/:productId/variants/:variantId/prices/:priceListId` | —                            | `204`, sin body                         |

## Lotes

| Método   | Path                        | Body           | Respuesta                                       |
| -------- | --------------------------- | -------------- | ----------------------------------------------- |
| `POST`   | `/products/:id/lots`        | `CreateLotDto` | `201`, lote creado                              |
| `GET`    | `/products/:id/lots`        | —              | `200`, lotes ordenados por `expirationDate asc` |
| `PATCH`  | `/products/:id/lots/:lotId` | `UpdateLotDto` | `200`, lote actualizado                         |
| `DELETE` | `/products/:id/lots/:lotId` | —              | `204`, sin body                                 |

## Listas de precios

| Método  | Path                                     | Body                 | Respuesta                               |
| ------- | ---------------------------------------- | -------------------- | --------------------------------------- |
| `GET`   | `/products/:id/price-lists`              | —                    | `200`, listas enriquecidas con `margin` |
| `PATCH` | `/products/:id/price-lists/:priceListId` | `UpdatePriceListDto` | `200`, lista enriquecida                |

## Catálogo global de listas de precios

| Método   | Path               | Body       | Respuesta                                          |
| -------- | ------------------ | ---------- | -------------------------------------------------- |
| `GET`    | `/price-lists`     | —          | `200`, listas globales                             |
| `POST`   | `/price-lists`     | `{ name }` | `201`, crea catálogo + PriceList/VariantPrice en 0 |
| `PATCH`  | `/price-lists/:id` | `{ name }` | `200`, renombra lista global (no default)          |
| `DELETE` | `/price-lists/:id` | —          | `204`, borra global + cascadas                     |

## Imágenes

| Método   | Path                                 | Body             | Respuesta                                           |
| -------- | ------------------------------------ | ---------------- | --------------------------------------------------- |
| `POST`   | `/products/:id/images`               | `CreateImageDto` | `201`, imagen creada                                |
| `GET`    | `/products/:id/images`               | —                | `200`, imágenes del producto (incluye de variantes) |
| `PATCH`  | `/products/:id/images/:imageId/main` | —                | `200`, imagen actualizada como main                 |
| `DELETE` | `/products/:id/images/:imageId`      | —                | `204`, sin body                                     |

---

## 5) Diferencias de shape: lista vs detalle

## `GET /products` (lista)

Devuelve `product.toResponse()` por ítem, más campos calculados de precio y agregados de variantes:

- Datos del producto
- `priceCents: number` → precio de venta calculado desde la lista PUBLICO (`isDefault=true`). No es columna, es campo virtual.
- `priceDecimal: number` → `priceCents / 100`
- `purchaseCost` calculado (`mode`, `netCents`, `grossCents`, `netDecimal`, `grossDecimal`)
- Si `hasVariants=true`:
  - `variantStockTotal: number` → suma de `quantity` de todas las variantes del producto
  - `variantCount: number` → cantidad total de variantes del producto
- Si `hasVariants=false`:
  - no se incluyen claves `variantStockTotal` ni `variantCount`
- **No incluye** `priceLists`, `variants`, `images`, `lots`

## `GET /products/:id`, `POST /products`, `PATCH /products/:id` (detalle)

Devuelve:

- Todo lo de `toResponse()`
- `priceCents: number` → precio de venta calculado desde la lista PUBLICO (`isDefault=true`)
- `priceDecimal: number` → `priceCents / 100`
- `priceLists[]` (con `tierPrices[]`, `priceDecimal`, `margin`)
- `variants[]` (si `hasVariants=true`; si no, `[]`) con:
  - `option`, `value`
  - `minQuantity`
  - `purchaseNetCostCents` (raw) + `purchaseNetCostDecimal`
  - `variantPrices[]` enriquecidos (`priceListName`, `priceDecimal`, `margin`, `tierPrices[]`)
- `images[]` (solo imágenes de producto nivel raíz: `variantId=null`)
- `lots[]` (si `useLotsAndExpirations=true`; si no, `[]`)

Nota: `GET /products/:id/images` sí devuelve todas las imágenes (producto + variantes), ordenadas por `isMain desc`, `sortOrder asc`.

---

## 6) Mapeo de errores (DomainExceptionFilter)

Mapeo de clase a HTTP:

- `EntityNotFoundError` → `404`
- `EntityAlreadyExistsError` → `409`
- `BusinessRuleViolationError` → `422`
- `InvalidArgumentError` → `400`

Shape de respuesta:

```json
{
  "statusCode": 409,
  "error": "ENTITY_ALREADY_EXISTS",
  "message": "SKU \"ABC\" already exists",
  "timestamp": "2026-04-01T00:00:00.000Z"
}
```

Errores comunes para productos:

- `ENTITY_NOT_FOUND`
- `ENTITY_ALREADY_EXISTS`
- `LOTS_NOT_ENABLED`
- `PRODUCT_HAS_VARIANTS`
- `DEFAULT_PRICE_LIST_PROTECTED`
- `PRICE_LIST_PRODUCT_MISMATCH`
- `INVALID_TIER_SEQUENCE`
- `VARIANT_PRODUCT_MISMATCH`
- `MAIN_IMAGE_CONFLICT`
- `INVALID_ARGUMENT`

---

## 7) Fórmulas de pricing (exactas al código)

## 7.1 Conversión costo compra NET/GROSS

En `PurchaseCost.create(mode, valueCents, ivaMultiplier, iepsMultiplier)`:

- `totalTaxMultiplier = 1 + ivaMultiplier + iepsMultiplier`

Si `mode = NET`:

- `netCents = round(valueCents)`
- `grossCents = round(netCents * totalTaxMultiplier)`

Si `mode = GROSS`:

- `grossCents = round(valueCents)`
- `netCents = round(grossCents / totalTaxMultiplier)`

Donde:

- `ivaMultiplier = percentage(ivaRate) / 100`
- `iepsMultiplier = percentage(iepsRate) / 100`

## 7.2 Margen para PriceList/TierPrice y VariantPrice/VariantTierPrice

En `enrichPriceListResponse(...)`:

- `netCostCents = product.purchaseCost.netCents`
- Para lista principal:
  - `margin.amountCents = salePriceCents - netCostCents`
  - `margin.amountDecimal = margin.amountCents / 100`
  - `margin.percent = salePriceCents > 0 ? round((margin.amountCents / salePriceCents) * 100) : 0`
- Para cada tier:
  - `tier.margin.amountCents = tier.priceCents - netCostCents`
  - `tier.margin.amountDecimal = tier.margin.amountCents / 100`
  - `tier.margin.percent = tier.priceCents > 0 ? round((tier.margin.amountCents / tier.priceCents) * 100) : 0`

La misma fórmula de margen se aplica a:

- `VariantPrice.priceCents`
- `VariantTierPrice.priceCents`

Con diferencia de costo base:

- `enrichPriceListResponse(...)` (nivel producto) **siempre** usa `product.purchaseCost.netCents`.
- `enrichVariantPriceResponse(...)` (nivel variante) usa:
  - `netCostCents = variant.purchaseNetCostCents ?? product.purchaseCost.netCents`
  - Es decir: si la variante define override, el margen sale de ese costo; si no, hereda del producto.

Importante: porcentaje es entero redondeado (`Math.round`), no decimal.

## 7.3 Semántica de `tierPrices` en upsert de precio por variante

En `PUT /products/:productId/variants/:variantId/prices/:priceListId` y en bulk:

- `tierPrices` **omitido**: no toca tiers actuales.
- `tierPrices: []`: borra todos los tiers.
- `tierPrices: [...]`: reemplaza tiers (delete + create).

Estas operaciones corren de forma transaccional.

---

## 8) Invariantes de inventario (estado actual)

Normalización central (`normalizeStockConfiguration`):

1. Si `useStock = false`:
   - `useLotsAndExpirations = false`
   - `quantity = 0`
   - `minQuantity = 0`
2. Si `hasVariants = true`:
   - `useLotsAndExpirations = false`
   - `quantity = 0`
   - `minQuantity = 0`
3. Si `useLotsAndExpirations = true` (sin variantes, con stock):
   - `quantity = 0`
   - `minQuantity` se conserva

Reglas operativas:

- No se pueden crear lotes si `useLotsAndExpirations=false` (`LOTS_NOT_ENABLED`).
- No se pueden crear lotes si `hasVariants=true` (`PRODUCT_HAS_VARIANTS`).
- Al crear primera variante, backend activa `hasVariants=true` y re-normaliza inventario.
- Si `product.useStock=false`, cualquier `variant.minQuantity` se normaliza a `0` al crear/editar variante.
- Si `PATCH /products/:id` cambia `useStock` a `false`, backend ejecuta cascade `updateMany` para forzar `variant.minQuantity=0` en todas las variantes del producto.
- Al crear variante, backend auto-crea `VariantPrice` en `0` para todas las listas del producto.
- Al crear lista global (`POST /price-lists`), backend auto-crea `PriceList` en `0` para todos los productos y `VariantPrice` en `0` para todas las variantes.

---

## 9) Notas de integración frontend

## Mapeo de estado de formulario

- Mantener un estado derivado para inventario:
  - Si `!useStock` → ocultar/deshabilitar lotes + cantidades y enviar en `0`.
  - Si `hasVariants` → ocultar/deshabilitar lotes + `quantity/minQuantity` de producto.
  - Si `useLotsAndExpirations` → `quantity` de producto debe quedar 0; gestionar stock por lotes.

## Orden recomendado de llamadas

1. Crear producto (`POST /products`).
2. Según toggles:
   - variantes: `POST /products/:id/variants`
   - lotes: `POST /products/:id/lots`
3. Si usás variantes, operar precios por variante:
   - lectura: `GET /products/:id/variants/:variantId/prices`
   - upsert individual: `PUT /products/:id/variants/:variantId/prices/:priceListId`
   - upsert bulk: `PUT /products/:id/variants/:variantId/prices`
4. Listas adicionales globales: `POST /price-lists`.
5. Imágenes: `POST /products/:id/images`.
6. Para refrescar pantalla completa: `GET /products/:id`.

## Cuándo usar cada endpoint de lectura

- Grilla/listado: `GET /products` (más liviano).
- Pantalla detalle/edición completa: `GET /products/:id`.
- Gestión avanzada de imágenes (incluyendo por variante): `GET /products/:id/images`.

---

## 10) Modulo de Ventas — POS Catalog Search

### 10.1) Arquitectura

El modulo de ventas expone un endpoint de busqueda de catalogo optimizado para punto de venta (`GET /sales/pos-catalog`). Aunque el catalogo vive en el dominio de Products, la busqueda se expone bajo el namespace `sales` para:

1. Alinearse con el contexto de uso (POS = herramienta de ventas)
2. Unificar permisos bajo `read:Sale` (mismo permiso que draft management)
3. Permitir politicas futuras especificas de POS sin tocar el modulo de productos

**Flujo de datos:**

```
HTTP GET /sales/pos-catalog?q=...
  │
  ▼
SalesCatalogController (@Controller('sales'))
  │  [JwtAuthGuard + PermissionsGuard: read:Sale]
  │
  ▼
SalesService.searchPosCatalog(dto)  [facade — validaciones POS]
  │
  ▼
ProductsService.searchForPOS(dto)  [query + mapping core]
  │
  ▼
PrismaService
  WHERE sellInPos = true
  AND (q search across product.name, sku, barcode + variant fields)
  AND optional categoryId/brandId filters
  INCLUDE: category, brand, images (take 5), variants.images, variants.variantPrices, priceLists
  │
  ▼
Mapping in-memory:
  - Resolve mainImage (first isMain or first by sortOrder)
  - Resolve default price from PUBLICO price list (isDefault=true)
  - Cap images[] to 5
  - Map variants with per-variant price/stock
  │
  ▼
Response: { items: PosCatalogItem[], total, limit, offset }
```

**Separacion de concerns:**

- `SalesCatalogController` (Sales namespace): HTTP adapter, guards, DTO binding
- `SalesService`: Facade — punto de extension para logica POS futura (ej: filtro por sucursal)
- `ProductsService`: Query y mapeo de catalogo — reutilizable para otros contextos
- `PrismaService`: Persistencia

### 10.2) Filtros y paginacion

| Parametro | Tipo | Default | Validacion | Proposito |
|---|---|---|---|---|
| `q` | `string?` | - | `maxLength(100)` | Busqueda full-text sobre `product.name`, `product.sku`, `product.barcode`, `variant.name`, `variant.sku`, `variant.barcode` (case-insensitive, `contains`) |
| `limit` | `number?` | `25` | `min(1)`, `max(50)` | Items por pagina (hard cap en 50 para proteger performance) |
| `offset` | `number?` | `0` | `min(0)` | Paginacion offset-based (autocomplete UX necesita `total`) |
| `categoryId` | `UUID?` | - | `IsUUID` | Filtro opcional por categoria |
| `brandId` | `UUID?` | - | `IsUUID` | Filtro opcional por marca |

**Invariante**: Solo productos con `sellInPos = true` son incluidos (filtro siempre aplicado).

**Estrategia de busqueda**: Prisma `contains` mode sobre multiples campos con `OR`. No hay fuzzy search ni ranking en v1 (puede agregarse con FTS5 o Typesense en v2).

### 10.3) Resolucion de precio default

El precio devuelto en `price.priceCents` se resuelve de la siguiente forma:

1. Buscar en `priceLists[]` del producto la entrada donde `globalPriceList.isDefault = true` (normalmente `PUBLICO`)
2. Si existe, usar `priceList.priceCents`
3. Si no existe, devolver `0` (fallback safe; no rompe el contrato)

Para variantes:

1. Buscar en `variant.variantPrices[]` la entrada donde `priceList.globalPriceList.isDefault = true`
2. Si existe, usar `variantPrice.priceCents`
3. Si no existe, devolver `0`

**Nota**: `priceDecimal = priceCents / 100` (calculado en el mapper).  
**Nota**: `priceListName` siempre es el nombre de la lista global default (ej: `"PUBLICO"`).

### 10.4) Resolucion de imagenes

**Main image:**

- Si existe imagen con `isMain = true` (a nivel producto o variante segun corresponda), usar su `url`
- Si no, usar la primera imagen ordenada por `sortOrder asc`
- Si no hay imagenes, devolver `null`

**Images array:**

- Ordenar por `isMain desc`, `sortOrder asc`
- Tomar las primeras 5 (hard cap)
- Devolver como array de URLs (strings)

**Variantes:**

- Cada variante tiene su propio `mainImage` resuelto desde `product_images WHERE variantId = variant.id`
- Si la variante no tiene imagenes propias, `mainImage = null` (NO hereda del producto)

### 10.5) Comportamiento de stock

- Si `product.useStock = false`: `stock = null` a nivel producto
- Si `product.hasVariants = true`: `stock = null` a nivel producto (el stock real esta en las variantes)
- Si `product.useStock = true` y `hasVariants = false`: `stock = { quantity, minQuantity }`
- Para variantes: si `product.useStock = false`, entonces `variant.stock = null` (normalizado en DB)

### 10.6) RBAC y permisos

**Permiso requerido:** `read:Sale`

**Rationale:**

- El catalogo POS es una herramienta de **ventas**, no de administracion de productos
- Los cajeros necesitan buscar productos para armar ventas, pero no necesitan editar el catalogo
- El permiso `read:Sale` ya se usa en `GET /sales/drafts` (listar borradores del usuario)
- Alinear permisos bajo `Sale` permite asignar un solo permiso para todo el flujo POS (borradores + catalogo)
- Los administradores de productos usan `GET /products` con permiso `read:Product` (endpoint separado, sin filtro POS)

**Compatibilidad:**

- Roles con `read:Sale` → acceso a catalogo POS (ej: cajeros, vendedores)
- Roles con `manage:Sale` → acceso a catalogo POS + draft management completo
- Roles con solo `read:Product` → NO tienen acceso a catalogo POS (por diseño; deben usar `/products`)
- Roles con `manage:all` (Super Admin) → acceso a todo

**No-goals:**

- No se introduce dependencia de `read:Product` en el modulo Sales
- No se modifica el contrato de `GET /products` (sigue siendo endpoint de administracion)
- No se mezclan permisos de admin y POS en el mismo endpoint

---

## 11) Caveats conocidos (para evitar sorpresas)

1. **`PUBLICO` no se puede borrar ni renombrar** (`DEFAULT_PRICE_LIST_PROTECTED`).
2. `PATCH /products/:id` con `priceCents` solo actualiza la lista global default (`isDefault=true`, normalmente `PUBLICO`).
3. `GET /products/:id` trae `images` solo de ámbito producto (`variantId=null`), no las de variante.
4. `categoryId` no se valida previamente en servicio de productos; depende de FK DB.
5. `variantId` en imágenes se valida contra pertenencia real al producto (`VARIANT_PRODUCT_MISMATCH`).
6. Hay unicidad de imagen principal por ámbito, reforzada por índice parcial y manejo de conflicto (`MAIN_IMAGE_CONFLICT`).
7. `name` de variante puede ser sobreescrito por backend cuando vienen `option + value` (`name = value`).
8. Varias propiedades monetarias/cantidades usan `IsNumber` (no `IsInt`), pero DB persiste en `Int`; enviar decimales puede generar comportamiento no deseado/errores de persistencia.
