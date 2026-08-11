# Módulo de Productos — Comportamiento de Negocio (fuente: código actual)

Este documento describe **cómo se comporta hoy** el módulo de productos en backend para que frontend pueda integrar sin suposiciones.

---

## Qué se puede configurar

En creación/edición de producto se puede configurar:

- **Identidad y clasificación**
  - `name` (obligatorio)
  - `type` (`PRODUCT` | `SERVICE`)
  - `categoryId` (opcional, FK a categorías)
  - `unit`, `satKey`, `location`, `description`
- **Identificadores comerciales**
  - `sku` (opcional, único global: productos + variantes)
  - `barcode` (opcional, único global: productos + variantes)
- **Visibilidad**
  - `sellInPos`
  - `includeInOnlineCatalog`
- **Impuestos y costo de compra**
  - `chargeProductTaxes`
  - `ivaRate`, `iepsRate`
  - `purchaseCost.mode` (`NET` | `GROSS`) + `purchaseCost.valueCents`
- **Inventario**
  - `useStock`
  - `useLotsAndExpirations`
  - `quantity`
  - `minQuantity`
  - `hasVariants`
  - En variantes, el stock se maneja por `variant.quantity` + `variant.minQuantity`
- **Precios de venta**
  - `priceCents` → campo **calculado** desde la lista global por defecto `PUBLICO` (no es columna del producto)
  - Listas adicionales por endpoint global (`/price-lists`)
  - Escalas (`tierPrices`) por producto/lista (`PATCH /products/:id/price-lists/:priceListId`)
  - Precios por variante por lista (`/variants/:variantId/prices`) con escalas por variante
- **Medios**
  - Imágenes de producto y de variante
  - Imagen principal (`isMain`) por ámbito (producto o variante)

---

## Reglas de dependencia del formulario

> Clave: estas dependencias se aplican en dominio/servicio; frontend debe reflejarlas para evitar sorpresas.

| Campo/toggle origen                                    | Si está en este valor                           | Impacto automático en otros campos                                                                             | Por qué                                                          |
| ------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `useStock`                                             | `false`                                         | Fuerza `useLotsAndExpirations=false`, `quantity=0`, `minQuantity=0`                                            | Sin control de stock no tiene sentido lotes ni umbral mínimo     |
| `hasVariants`                                          | `true`                                          | Fuerza `useLotsAndExpirations=false`, `quantity=0`, `minQuantity=0` en nivel producto                          | El stock pasa a manejarse por variante                           |
| `useLotsAndExpirations`                                | `true` (y `useStock=true`, `hasVariants=false`) | Fuerza `quantity=0` (pero **no** fuerza `minQuantity=0`)                                                       | El inventario disponible sale de lotes, no de stock directo      |
| Crear variante (`POST /products/:id/variants`)         | Siempre                                         | Si producto no tenía variantes, backend setea `hasVariants=true` y re-normaliza inventario                     | Consistencia: producto con variantes no usa stock directo/lotes  |
| Crear variante (`POST /products/:id/variants`)         | Siempre                                         | Auto-crea `VariantPrice(priceCents=0)` para **todas** las listas del producto                                  | Mantener matriz completa variante × lista en UI                  |
| Eliminar última variante                               | Queda `0` variantes                             | Backend setea `hasVariants=false`                                                                              | Mantener flag consistente con datos reales                       |
| Crear lista global (`POST /price-lists`)               | Siempre                                         | Auto-crea `PriceList(priceCents=0)` para **todos** los productos + `VariantPrice(priceCents=0)` para variantes | Mantener matriz completa producto/variante × lista               |
| Crear lote (`POST /products/:id/lots`)                 | `useLotsAndExpirations=false`                   | Rechaza operación (`LOTS_NOT_ENABLED`)                                                                         | No se permiten lotes sin toggle activo                           |
| Crear lote (`POST /products/:id/lots`)                 | `hasVariants=true`                              | Rechaza operación (`PRODUCT_HAS_VARIANTS`)                                                                     | No hay lotes en productos con variantes                          |
| Crear lote (`POST /products/:id/lots`)                 | `type=SERVICE`                                  | Rechaza operación (`LOTS_NOT_ALLOWED_ON_SERVICE`, 400)                                                         | R2 — servicios no manejan inventario                             |
| Crear/editar producto `type=SERVICE` con `sku`         | siempre                                         | Rechaza operación (`INVALID_ARGUMENT`, 400)                                                                    | R1 — servicios no tienen SKU                                     |
| Crear/editar producto `type=SERVICE` con `barcode`     | siempre                                         | Rechaza operación (`INVALID_ARGUMENT`, 400)                                                                    | R1 — servicios no tienen barcode                                 |
| Crear/editar producto `type=SERVICE` con `brandId`     | siempre                                         | Rechaza operación (`INVALID_ARGUMENT`, 400)                                                                    | R1 — servicios no tienen marca                                   |
| Crear producto `type=SERVICE`                          | siempre                                         | Backend fuerza `useStock=false`, `useLotsAndExpirations=false`, `quantity=0`, `minQuantity=0`, `sku=null`, `barcode=null`, `brandId=null`, `purchaseNetCostCents=0`, `purchaseGrossCostCents=0`; crea fila `ServiceDetail` 1:1 | R1 + R4 — normalización + tabla de detalle                      |
| Editar producto `type=PRODUCT→SERVICE`                 | `quantity>0` o lotes activos                    | Rechaza operación (`PRODUCT_TYPE_CHANGE_BLOCKED`, 400)                                                          | R5 — no perder stock al "convertir"                              |
| Editar producto `type=SERVICE→PRODUCT`                 | siempre                                         | Limpia fila `ServiceDetail` y restaura defaults PRODUCT (admin agrega stock después)                           | R4 + R5 — limpiar rastro de servicio                             |
| Editar producto `type=SERVICE` con `serviceDetail`     | siempre                                         | Upsert en la fila 1:1 (`capacity` ≥ 1, `notes` ≤ 500)                                                         | R4 — detalle editable por variante de servicio                   |
| Crear imagen con `isMain=true`                         | Siempre                                         | Limpia main previo en mismo ámbito (`variantId` igual o `null`)                                                | Debe haber una sola imagen principal por ámbito                  |
| `priceCents` en crear/editar producto                  | Informado                                       | Afecta **solo** lista `PUBLICO`                                                                                | `PUBLICO` es la lista base del producto                          |
| Crear/editar variante con `useStock=false` en producto | Siempre                                         | Backend normaliza `variant.minQuantity=0`                                                                      | Si no hay control de stock, umbral mínimo por variante no aplica |
| `variant.purchaseNetCostCents`                         | `null`/omitido                                  | Margen por variante usa costo neto del producto                                                                | Herencia de costo por defecto                                    |
| `variant.purchaseNetCostCents`                         | número `>= 0`                                   | Margen por variante usa costo neto de la variante                                                              | Permite override por variante                                    |

---

## Defaults

Defaults efectivos en backend al crear producto:

- `type = PRODUCT`
- `unit = UNIDAD`
- `sellInPos = true`
- `includeInOnlineCatalog = true`
- `chargeProductTaxes = true`
- `ivaRate = IVA_16`
- `iepsRate = NO_APLICA`
- `purchaseCost.mode = NET`
- `purchaseCost.netCents = 0`, `purchaseCost.grossCents = 0`
- `useStock = true`
- `useLotsAndExpirations = false`
- `quantity = 0`
- `minQuantity = 0`
- `hasVariants = false`
- En variantes: `minQuantity = 0` por defecto
- En variantes: `purchaseNetCostCents = null` por defecto (hereda costo de producto)
- Al crear producto, se crean price lists para **todas** las `GlobalPriceList` existentes:
  - si la lista es default (`PUBLICO`), usa `dto.priceCents` o `0`
  - las demás listas inician en `0`
- Al crear variante, se crean automáticamente precios de variante en `0` para todas las listas del producto.
- Al crear una nueva lista global, se crean automáticamente price lists y precios de variante en `0` para toda la base.

---

## Validaciones críticas

- `name` obligatorio (máx 100)
- `sku` y `barcode` únicos globales (entre productos y variantes)
- `quantity`, `minQuantity`, `priceCents`, `purchaseCost.valueCents` no negativos
- Variantes:
  - si vienen `option + value`, backend usa `name = value` (ignora `name` enviado)
  - si no vienen ambos, debe existir `name`
- Umbrales de `tierPrices`:
  - enteros
  - `>= 0`
  - únicos
  - estrictamente ascendentes
- Umbrales de `tierPrices` de variante: mismas reglas (`int`, `>=0`, únicos, ascendentes)
- `lotNumber` único por producto
- `expirationDate` obligatorio en lotes
- `variantId` de imagen debe pertenecer al mismo producto
- Solo 1 imagen principal por ámbito:
  - ámbito producto (`variantId = null`)
  - ámbito variante (`variantId = <id variante>`)

---

## Flujos recomendados para UI

### 1) Crear producto sin variantes

1. `POST /products` con datos base.
2. Si usa stock directo: mantener `hasVariants=false`, `useStock=true`, `useLotsAndExpirations=false`, gestionar `quantity/minQuantity`.
3. Si requiere listas adicionales: `POST /price-lists`.
4. Si requiere imágenes: `POST /products/:id/images`.

### 2) Crear producto con variantes

1. `POST /products` (podés enviar `hasVariants=true` o dejar que se active al crear primera variante).
2. `POST /products/:id/variants` por cada variante (idealmente enviando `option` + `value`).
3. Cargar imágenes por variante con `variantId`.
4. No mostrar UI de lotes ni stock directo de producto (queda normalizado a 0 a nivel producto).
5. Para editar matriz de precios por variante, usar endpoints `/products/:id/variants/:variantId/prices`.

### 3) Crear producto con lotes

1. `POST /products` con `useStock=true`, `hasVariants=false`, `useLotsAndExpirations=true`.
2. `POST /products/:id/lots` para cada lote.
3. Considerar que `quantity` de producto se mantiene en 0 (inventario vive en lotes).

---

## Casos que bloquean operación

Errores representativos que frontend debería mapear:

- `ENTITY_ALREADY_EXISTS` (409)
  - SKU duplicado
  - Barcode duplicado
  - Lista global de precios duplicada por nombre
  - Lote duplicado por `lotNumber` dentro del producto
- `ENTITY_NOT_FOUND` (404)
  - Producto/variante/lote/lista/imagen inexistente
- `LOTS_NOT_ENABLED` (422)
  - Intento de crear lotes sin toggle activo
- `PRODUCT_HAS_VARIANTS` (422)
  - Intento de crear lotes en producto con variantes
- `DEFAULT_PRICE_LIST_PROTECTED` (422)
  - Intento de borrar o renombrar `PUBLICO`
- `PRICE_LIST_PRODUCT_MISMATCH` (422)
  - Se intentó usar una lista que no pertenece al producto
- `INVALID_TIER_SEQUENCE` (422)
  - Escalas repetidas o no ascendentes
- `VARIANT_PRODUCT_MISMATCH` (422)
  - Imagen enviada con variante que no pertenece al producto
- `MAIN_IMAGE_CONFLICT` (422)
  - Conflicto por unicidad de imagen principal en mismo ámbito
- `INVALID_ARGUMENT` (400)
  - Reglas numéricas de dominio (p. ej. negativos o umbrales inválidos)

Formato de error de dominio:

```json
{
  "statusCode": 422,
  "error": "DEFAULT_PRICE_LIST_PROTECTED",
  "message": "Cannot delete the default PUBLICO price list",
  "timestamp": "2026-04-01T00:00:00.000Z"
}
```

---

## Lo que NO está en alcance hoy

- Reasignar lista default a otra distinta de `PUBLICO`: hoy no hay endpoint para mutar `isDefault`.
- Validación previa de existencia de `categoryId` en servicio de productos: se depende de FK de DB (si mandás un id inválido, puede fallar a nivel persistencia).

---

## SERVICE — reglas diferenciales

`type=SERVICE` (p. ej. "Paseo de perros") tiene comportamiento distinto de `type=PRODUCT`. Resumen para frontend:

- **Campos bloqueados al crear/editar** (devuelven 400 con `INVALID_ARGUMENT`): `sku`, `barcode`, `brandId`, `lots[]`, `useLotsAndExpirations=true`.
- **Defaults forzados al crear SERVICE**: `useStock=false`, `useLotsAndExpirations=false`, `quantity=0`, `minQuantity=0`, `sku=null`, `barcode=null`, `brandId=null`, `purchaseNetCostCents=0`, `purchaseGrossCostCents=0`.
- **Unidades permitidas para variantes de servicio** (UnitOfMeasure): `HORA`, `SESION`, `DIA`, `CONSULTA`, `CURSO`, `PAQUETE`. Las 8 unidades tradicionales siguen disponibles para PRODUCT.
- **ServiceDetail** (sub-recurso 1:1): objeto opcional en create/update con `capacity?: number ≥ 1` y `notes?: string ≤ 500`. La fila existe siempre para productos SERVICE (campos nullables); la respuesta de `GET /products` siempre incluye `serviceDetail: {capacity, notes} | null`.
- **Cambio de tipo** (`PATCH /products/:id` con `type`):
  - `PRODUCT → SERVICE` se **bloquea** con 400 (`PRODUCT_TYPE_CHANGE_BLOCKED`) si `quantity>0` o hay lotes activos. Mensaje al admin: "no se puede convertir mientras tenga stock o lotes".
  - `SERVICE → PRODUCT` se permite siempre. Backend limpia la fila `ServiceDetail` y restaura defaults. El admin debe agregar stock en un PATCH posterior.
- **Filtro por tipo** (`GET /products?type=SERVICE|PRODUCT`): acepta ambos valores; sin `type` devuelve los dos tipos.
- **Lotes en servicio**: `POST /products/:id/lots` rechaza con 400 (`LOTS_NOT_ALLOWED_ON_SERVICE`).
- **POS**: los SERVICE aparecen en `GET /sales/pos-catalog` igual que los PRODUCT. La venta funciona idéntica — el path de stock en `decrementStockForCharge` ya respeta `useStock=false` (R6).
- **SAT CFDI / unit key para invoice**: la unidad de la variante (HORA, SESION, etc.) llega al PDF tal cual desde el variant. Confirmar con contabilidad que el `satKey` aplica para servicios antes del primer comprobante fiscal de un servicio.
