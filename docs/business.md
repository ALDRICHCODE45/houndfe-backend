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
  - En variantes, el stock se maneja por `variant.quantity`
- **Precios de venta**
  - `priceCents` (precio de lista por defecto `PUBLICO`)
  - Listas adicionales por endpoint separado (`/price-lists`) con escalas (`tierPrices`)
  - Precios por variante por lista (`/variants/:variantId/prices`) con escalas por variante
- **Medios**
  - Imágenes de producto y de variante
  - Imagen principal (`isMain`) por ámbito (producto o variante)

---

## Reglas de dependencia del formulario

> Clave: estas dependencias se aplican en dominio/servicio; frontend debe reflejarlas para evitar sorpresas.

| Campo/toggle origen                            | Si está en este valor                           | Impacto automático en otros campos                                                         | Por qué                                                         |
| ---------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `useStock`                                     | `false`                                         | Fuerza `useLotsAndExpirations=false`, `quantity=0`, `minQuantity=0`                        | Sin control de stock no tiene sentido lotes ni umbral mínimo    |
| `hasVariants`                                  | `true`                                          | Fuerza `useLotsAndExpirations=false`, `quantity=0`, `minQuantity=0` en nivel producto      | El stock pasa a manejarse por variante                          |
| `useLotsAndExpirations`                        | `true` (y `useStock=true`, `hasVariants=false`) | Fuerza `quantity=0` (pero **no** fuerza `minQuantity=0`)                                   | El inventario disponible sale de lotes, no de stock directo     |
| Crear variante (`POST /products/:id/variants`) | Siempre                                         | Si producto no tenía variantes, backend setea `hasVariants=true` y re-normaliza inventario | Consistencia: producto con variantes no usa stock directo/lotes |
| Crear variante (`POST /products/:id/variants`) | Siempre                                         | Auto-crea `VariantPrice(priceCents=0)` para **todas** las listas del producto              | Mantener matriz completa variante × lista en UI                 |
| Eliminar última variante                       | Queda `0` variantes                             | Backend setea `hasVariants=false`                                                          | Mantener flag consistente con datos reales                      |
| Crear lista (`POST /products/:id/price-lists`) | Siempre                                         | Auto-crea `VariantPrice(priceCents=0)` para **todas** las variantes existentes             | Mantener matriz completa variante × lista en UI                 |
| Crear lote (`POST /products/:id/lots`)         | `useLotsAndExpirations=false`                   | Rechaza operación (`LOTS_NOT_ENABLED`)                                                     | No se permiten lotes sin toggle activo                          |
| Crear lote (`POST /products/:id/lots`)         | `hasVariants=true`                              | Rechaza operación (`PRODUCT_HAS_VARIANTS`)                                                 | No hay lotes en productos con variantes                         |
| Crear imagen con `isMain=true`                 | Siempre                                         | Limpia main previo en mismo ámbito (`variantId` igual o `null`)                            | Debe haber una sola imagen principal por ámbito                 |
| `priceCents` en crear/editar producto          | Informado                                       | Afecta **solo** lista `PUBLICO`                                                            | `PUBLICO` es la lista base del producto                         |

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
- Se crea automáticamente lista de precios `PUBLICO` con:
  - `priceCents = dto.priceCents` o `0` si no se envía
- Al crear variante, se crean automáticamente precios de variante en `0` para todas las listas del producto.
- Al crear una nueva lista de precios, se crean automáticamente precios de variante en `0` para todas las variantes del producto.

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
3. Si requiere listas adicionales: `POST /products/:id/price-lists`.
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
  - Lista de precios duplicada por nombre dentro del producto
  - Lote duplicado por `lotNumber` dentro del producto
- `ENTITY_NOT_FOUND` (404)
  - Producto/variante/lote/lista/imagen inexistente
- `LOTS_NOT_ENABLED` (422)
  - Intento de crear lotes sin toggle activo
- `PRODUCT_HAS_VARIANTS` (422)
  - Intento de crear lotes en producto con variantes
- `DEFAULT_PRICE_LIST_PROTECTED` (422)
  - Intento de borrar `PUBLICO`
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

- Comportamiento especial por `type=SERVICE`: hoy se persiste el tipo, pero **no** hay reglas diferenciales de inventario/precio por ser servicio.
- Reasignar/renombrar lista `PUBLICO`: hoy no se borra y no hay endpoint para renombrarla.
- Validación previa de existencia de `categoryId` en servicio de productos: se depende de FK de DB (si mandás un id inválido, puede fallar a nivel persistencia).
