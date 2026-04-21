# Módulo de Promociones (POS) — Contrato Técnico Completo para Frontend

> Fuente de verdad: implementación actual en backend (`src/promotions/**`, `prisma/schema.prisma`, `DomainExceptionFilter`, módulos catálogo relacionados).

---

## 0) Objetivo de este documento

Este documento está hecho para que frontend implemente **/POS/promociones** sin adivinar.

Incluye:

- por qué está modelado así,
- qué payload mandar,
- qué devuelve cada endpoint,
- errores esperables,
- flujos de implementación UI,
- edge cases reales del código actual.

---

## 1) Alcance funcional actual

El módulo Promotions ya soporta CRUD de promociones con 4 tipos:

1. `PRODUCT_DISCOUNT` (descuento en productos)
2. `ORDER_DISCOUNT` (descuento en total del pedido)
3. `BUY_X_GET_Y` (2x1, 3x2, segundo al X%, etc.)
4. `ADVANCED` (si compra X de A, obtiene Y de B)

Y soporta condiciones:

- alcance de clientes (`ALL`, `REGISTERED_ONLY`, `SPECIFIC`),
- listas de precio,
- días de semana,
- vigencia por fechas.

### Fuera de alcance (intencional)

- Limitar por sucursales (branches)
- Motor de cálculo de promociones en checkout/POS (stacking/aplicación efectiva)
- Cron de sincronización de status

> El módulo Promotions hoy es **definición/gestión de reglas (CRUD)**. La aplicación en venta vive en POS/Ventas.

---

## 2) Decisiones de diseño (el porqué)

### 2.1 Un endpoint unificado (`POST /promotions`)

Se usa un payload unificado con `type` porque:

- simplifica el frontend wizard (un flujo, 4 variantes),
- reduce duplicación de endpoints,
- permite validación de reglas por tipo en entidad de dominio.

### 2.2 Modelo STI (single table + joins)

Se guarda todo en `promotions` + tablas de relación (`promotion_target_items`, `promotion_customers`, `promotion_price_lists`, `promotion_days_of_week`) porque:

- mantiene consultas simples para listado/filtros,
- soporta tipos distintos sin 4 tablas separadas,
- se alinea al patrón del proyecto.

### 2.3 `TargetSide` en targets (`DEFAULT | BUY | GET`)

Esto permite que `ADVANCED` tenga targets separados para lado compra y lado obtiene **sin duplicar estructura**.

### 2.4 Montos en centavos

Todos los montos fijos se manejan en `...Cents`/centavos para evitar errores de punto flotante.

### 2.5 Status “efectivo” lazy

El status se interpreta con fechas en lectura (`ACTIVE/SCHEDULED/ENDED`) sin cron. Manualmente podés forzar `ENDED` con endpoint dedicado.

---

## 3) Base URL, headers y comportamiento global

- Base path promociones: `/promotions`
- En esta app no hay `setGlobalPrefix('api')` en `main.ts`, por lo que los paths están directos.
- Las rutas de promociones están protegidas con:
  - `JwtAuthGuard` (requiere token válido)
  - `PermissionsGuard` + `@RequirePermissions(...)` (CASL)
- Validation global:
  - `whitelist: true`
  - `forbidNonWhitelisted: true`
  - `transform: true`

### Implicancias para frontend

1. Propiedades no definidas en DTO → `400 Bad Request`.
2. Parámetros route `:id` usan `ParseUUIDPipe` → si no mandás UUID válido, responde 400.
3. `query.page`/`query.limit` se transforman a number automáticamente.
4. Sin token JWT válido → `401`.
5. Sin permiso suficiente → `403` (`INSUFFICIENT_PERMISSIONS`).

### Permisos requeridos por endpoint de promociones

| Endpoint | Permiso |
|---|---|
| `POST /promotions` | `create:Promotion` |
| `GET /promotions` | `read:Promotion` |
| `GET /promotions/:id` | `read:Promotion` |
| `PATCH /promotions/:id` | `update:Promotion` |
| `PATCH /promotions/:id/end` | `update:Promotion` |
| `DELETE /promotions/:id` | `delete:Promotion` |

---

## 4) Enums (valores exactos)

## 4.1 Tipo de promoción

- `PRODUCT_DISCOUNT`
- `ORDER_DISCOUNT`
- `BUY_X_GET_Y`
- `ADVANCED`

## 4.2 Método de aplicación

- `AUTOMATIC`
- `MANUAL`

## 4.3 Estado

- `ACTIVE`
- `SCHEDULED`
- `ENDED`

## 4.4 Tipo de descuento clásico

- `PERCENTAGE`
- `FIXED`

## 4.5 Target type

- `CATEGORIES`
- `BRANDS`
- `PRODUCTS`

## 4.6 Alcance de clientes

- `ALL`
- `REGISTERED_ONLY`
- `SPECIFIC`

## 4.7 Días de semana

- `MONDAY`, `TUESDAY`, `WEDNESDAY`, `THURSDAY`, `FRIDAY`, `SATURDAY`, `SUNDAY`

## 4.8 Lado de target (respuesta)

- `DEFAULT`
- `BUY`
- `GET`

---

## 5) Catálogos que frontend necesita para los selects

Para construir el formulario (categorías, marcas, productos, clientes, listas de precio), usá:

| Uso UI | Endpoint | Respuesta útil mínima |
|---|---|---|
| Select categorías | `GET /categories` | `[{ id, name, ... }]` |
| Select marcas | `GET /brands` | `[{ id, name, ... }]` |
| Select productos | `GET /products` | incluye `id`, `name` (más campos) |
| Select clientes específicos | `GET /customers` | `id`, `firstName`, `lastName` (más campos) |
| Select listas de precio | `GET /price-lists` | `id`, `name`, `isDefault`, ... |

> Recomendación UI: mapear y cachear opciones (`value=id`, `label=name`) para evitar recargar todo cada vez que se abre el modal.

---

## 6) Contrato del payload de creación

Endpoint: `POST /promotions`

### 6.1 Campos compartidos

| Campo | Tipo | Req | Reglas |
|---|---:|---:|---|
| `title` | `string` | Sí | max 200, no vacío tras trim |
| `type` | enum | Sí | uno de `PromotionType` |
| `method` | enum | Sí | `AUTOMATIC` / `MANUAL` |
| `startDate` | string ISO | No | `IsDateString` |
| `endDate` | string ISO | No | `IsDateString`, y `endDate >= startDate` |
| `customerScope` | enum | No | default efectivo `ALL` |
| `customerIds` | `string[]` | No | IDs de clientes (si se envía, se validan en DB) |
| `priceListIds` | `string[]` | No | IDs de listas globales (se validan en DB) |
| `daysOfWeek` | enum[] | No | días de semana |

### 6.2 Campos por tipo

| Campo | PRODUCT_DISCOUNT | ORDER_DISCOUNT | BUY_X_GET_Y | ADVANCED |
|---|---|---|---|---|
| `discountType` | **Req** | **Req** | Prohibido | Prohibido |
| `discountValue` | **Req** | **Req** | Prohibido | Prohibido |
| `minPurchaseAmountCents` | Prohibido | Opcional | Prohibido | Prohibido |
| `appliesTo` | **Req** | Prohibido | *(no requerido por código)* | Prohibido |
| `targetItems[]` | Usado (DEFAULT) | No | Usado (DEFAULT) | No |
| `buyQuantity` | Prohibido | Prohibido | **Req** | **Req** |
| `getQuantity` | Prohibido | Prohibido | **Req** | **Req** |
| `getDiscountPercent` | Prohibido | Prohibido | **Req** | **Req** |
| `buyTargetType` | Prohibido | Prohibido | Prohibido | Opcional |
| `getTargetType` | Prohibido | Prohibido | Prohibido | Opcional |
| `buyTargetItems[]` | No | No | No | Usado (BUY) |
| `getTargetItems[]` | No | No | No | Usado (GET) |

### 6.3 Rangos y validaciones de negocio

- `discountValue`:
  - si `discountType=PERCENTAGE` → **1..100**
  - si `discountType=FIXED` → **> 0** (centavos)
- `buyQuantity` / `getQuantity` → `>= 1`
- `getDiscountPercent` → `0..99` (`0 = gratis`)
- `endDate < startDate` → error `INVALID_DATE_RANGE`
- targets duplicados (mismo `side+targetType+targetId`) → error `duplicate_target`
- para `ADVANCED`:
  - si envías `buyTargetType`, debe existir al menos un `buyTargetItems`
  - si envías `getTargetType`, debe existir al menos un `getTargetItems`
  - si no, error `advanced_missing_targets`

---

## 7) Cómo mapear tu UI legacy al payload

## 7.1 “Descuento en productos”

- `type = PRODUCT_DISCOUNT`
- `discountType`, `discountValue`
- `appliesTo = CATEGORIES | BRANDS | PRODUCTS`
- `targetItems = [{ targetType, targetId }]`

### Ejemplo

```json
{
  "title": "10% en categorías de iluminación",
  "type": "PRODUCT_DISCOUNT",
  "method": "AUTOMATIC",
  "discountType": "PERCENTAGE",
  "discountValue": 10,
  "appliesTo": "CATEGORIES",
  "targetItems": [
    { "targetType": "CATEGORIES", "targetId": "5e167f6f-9510-4f98-9f39-2a4327ad2a72" },
    { "targetType": "CATEGORIES", "targetId": "7fbfc2f0-2c5f-470f-b8b3-01a16f3c5e11" }
  ],
  "customerScope": "ALL",
  "daysOfWeek": ["MONDAY", "TUESDAY"]
}
```

## 7.2 “Descuento en total del pedido”

- `type = ORDER_DISCOUNT`
- `discountType`, `discountValue`
- `minPurchaseAmountCents` opcional

```json
{
  "title": "10% en compras mayores a $1,000",
  "type": "ORDER_DISCOUNT",
  "method": "AUTOMATIC",
  "discountType": "PERCENTAGE",
  "discountValue": 10,
  "minPurchaseAmountCents": 100000,
  "customerScope": "REGISTERED_ONLY"
}
```

## 7.3 “2x1, 3x2 o similares”

- `type = BUY_X_GET_Y`
- `buyQuantity`, `getQuantity`, `getDiscountPercent`
- `targetItems` para el conjunto al que aplica

```json
{
  "title": "2x1 en playeras seleccionadas",
  "type": "BUY_X_GET_Y",
  "method": "AUTOMATIC",
  "buyQuantity": 2,
  "getQuantity": 1,
  "getDiscountPercent": 0,
  "appliesTo": "PRODUCTS",
  "targetItems": [
    { "targetType": "PRODUCTS", "targetId": "6a6e6113-a74f-4d52-bdc4-a4f0f5431c11" }
  ]
}
```

> Nota: presets como “2x1”, “3x2”, “segundo al 50%” son responsabilidad de frontend.
> Backend solo guarda números (`buyQuantity`, `getQuantity`, `getDiscountPercent`).

## 7.4 “Promoción avanzada”

- `type = ADVANCED`
- lado compra: `buyQuantity + buyTargetType + buyTargetItems[]`
- lado obtiene: `getQuantity + getDiscountPercent + getTargetType + getTargetItems[]`

```json
{
  "title": "Compra 2 velas y lleva 1 maceta al 50%",
  "type": "ADVANCED",
  "method": "AUTOMATIC",
  "buyQuantity": 2,
  "buyTargetType": "PRODUCTS",
  "buyTargetItems": [
    { "targetId": "ec8f30f9-5840-4dcf-9f94-4bc2c95f4a95" }
  ],
  "getQuantity": 1,
  "getDiscountPercent": 50,
  "getTargetType": "PRODUCTS",
  "getTargetItems": [
    { "targetId": "a8175e13-80e6-4495-9860-5dd2f9e5f884" }
  ]
}
```

---

## 8) Endpoints del módulo Promotions

Base: `/promotions`

| Método | Path | Descripción | Status éxito |
|---|---|---|---|
| `POST` | `/promotions` | Crear promoción | `201` |
| `GET` | `/promotions` | Listar con filtros/paginación | `200` |
| `GET` | `/promotions/:id` | Obtener detalle por id | `200` |
| `PATCH` | `/promotions/:id` | Actualizar parcialmente | `200` |
| `PATCH` | `/promotions/:id/end` | Finalizar manualmente | `200` |
| `DELETE` | `/promotions/:id` | Borrado hard | `204` |

### 8.0 Nota sobre respuesta de `POST`

`POST /promotions` devuelve la entidad guardada desde repositorio.

- En la práctica incluye los mismos campos funcionales de detalle,
- pero para mantener contrato uniforme en frontend (normalización/status efectivo), se recomienda hacer `GET /promotions/:id` luego de crear.

### 8.1 GET /promotions (query params)

| Query | Tipo | Default | Regla |
|---|---|---|---|
| `type` | enum | — | `PromotionType` |
| `status` | enum | — | `ACTIVE|SCHEDULED|ENDED` |
| `method` | enum | — | `AUTOMATIC|MANUAL` |
| `customerScope` | enum | — | `ALL|REGISTERED_ONLY|SPECIFIC` |
| `search` | string | — | `contains` case-insensitive sobre `title` |
| `page` | number | `1` | `>=1` |
| `limit` | number | `20` | `1..100` |
| `sortBy` | enum | `createdAt` | `title|createdAt|updatedAt|startDate` |
| `sortOrder` | enum | `desc` | `asc|desc` |

#### Semántica real del filtro `status`

- `ENDED`: incluye promos con `status=ENDED` **o** con `endDate < now`.
- `SCHEDULED`: `startDate > now` y `status != ENDED`.
- `ACTIVE`: `status != ENDED` y `(startDate null o <= now)` y `(endDate null o >= now)`.

### 8.2 Respuesta de GET /promotions

```json
{
  "data": [
    {
      "id": "uuid",
      "title": "10% en iluminación",
      "type": "PRODUCT_DISCOUNT",
      "method": "AUTOMATIC",
      "status": "ACTIVE",
      "startDate": null,
      "endDate": null,
      "customerScope": "ALL",
      "discountType": "PERCENTAGE",
      "discountValue": 10,
      "minPurchaseAmountCents": null,
      "appliesTo": "CATEGORIES",
      "buyQuantity": null,
      "getQuantity": null,
      "getDiscountPercent": null,
      "buyTargetType": null,
      "getTargetType": null,
      "targetItems": [
        {
          "id": "uuid",
          "side": "DEFAULT",
          "targetType": "CATEGORIES",
          "targetId": "uuid"
        }
      ],
      "customers": [],
      "priceLists": [],
      "daysOfWeek": [],
      "createdAt": "2026-04-20T00:00:00.000Z",
      "updatedAt": "2026-04-20T00:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

### 8.3 GET /promotions/:id

Devuelve el mismo shape de un ítem de `data[]`.

### 8.4 PATCH /promotions/:id

`UpdatePromotionDto = Partial(CreatePromotionDto sin type)`.

#### Importante

- `type` no se puede cambiar.
- El backend revalida invariantes por tipo en cada update.
- Para relaciones (`targetItems`, `customerIds`, `priceListIds`, `daysOfWeek`) si enviás el campo, se considera reemplazo del set.

Ejemplo parcial:

```json
{
  "title": "10% iluminación (actualizada)",
  "discountValue": 15,
  "daysOfWeek": ["FRIDAY", "SATURDAY"]
}
```

### 8.5 PATCH /promotions/:id/end

Marca promoción como `ENDED` (idempotente). Devuelve promoción actualizada.

### 8.6 DELETE /promotions/:id

`204 No Content`.

Se elimina promoción y filas relacionadas (cascade):

- `promotion_target_items`
- `promotion_customers`
- `promotion_price_lists`
- `promotion_days_of_week`

---

## 9) Shape de respuesta de relaciones

## 9.1 targetItems

```json
[
  {
    "id": "uuid",
    "side": "DEFAULT|BUY|GET",
    "targetType": "CATEGORIES|BRANDS|PRODUCTS",
    "targetId": "uuid"
  }
]
```

## 9.2 customers

```json
[
  {
    "id": "uuid",
    "customerId": "uuid",
    "customer": {
      "id": "uuid",
      "firstName": "Juan",
      "lastName": "Pérez"
    }
  }
]
```

## 9.3 priceLists

```json
[
  {
    "id": "uuid",
    "globalPriceListId": "uuid",
    "globalPriceList": {
      "id": "uuid",
      "name": "PUBLICO"
    }
  }
]
```

## 9.4 daysOfWeek

```json
[
  { "id": "uuid", "day": "MONDAY" }
]
```

---

## 10) Lógica de status (clave para la tabla UI)

Estado efectivo (`status` en respuestas) sigue esta lógica:

1. Si status guardado es `ENDED` → `ENDED` (override manual permanente)
2. Si `startDate` > `now` → `SCHEDULED`
3. Si `endDate` < `now` → `ENDED`
4. Caso contrario → `ACTIVE`

### Mapeo UI sugerido

- `ACTIVE` → “Activa”
- `SCHEDULED` → “Programada”
- `ENDED` → “Finalizada”

### Importante timezone

Mandá fechas ISO con zona (`Z` o `-06:00`, etc.) para evitar desfasajes.

---

## 11) Errores: qué puede romper y cómo manejarlo

## 11.1 Error envelope de dominio

```json
{
  "statusCode": 400,
  "error": "INVALID_TARGET",
  "message": "Category with id '...' not found",
  "timestamp": "2026-04-20T00:00:00.000Z"
}
```

## 11.2 Error envelope de validación DTO (Nest ValidationPipe)

```json
{
  "statusCode": 400,
  "message": [
    "type must be a valid enum value",
    "property unexpectedField should not exist"
  ],
  "error": "Bad Request"
}
```

## 11.3 Catálogo práctico de errores en Promotions

| HTTP | error/code | Cuándo pasa |
|---:|---|---|
| `404` | `ENTITY_NOT_FOUND` | `id` de promoción no existe (`GET by id`, `PATCH`, `DELETE`, `PATCH /end`) |
| `400` | `MISSING_REQUIRED_FIELD` | falta campo requerido por tipo |
| `400` | `FORBIDDEN_FIELD` | enviaste campo no permitido para ese tipo |
| `400` | `INVALID_FIELD_VALUE` | rango inválido (`discountValue`, `getDiscountPercent`, qty) |
| `400` | `INVALID_DATE_RANGE` | `endDate < startDate` |
| `400` | `INVALID_TARGET` | id inexistente en categorías/marcas/productos/clientes/price-lists |
| `400` | `duplicate_target` | target repetido (mismo side+type+id) |
| `400` | `advanced_missing_targets` | ADVANCED con `buyTargetType/getTargetType` sin sus items |
| `400` | `Bad Request` validación | UUID inválido en path o payload inválido DTO |

---

## 12) Guía de implementación frontend (paso a paso)

## Paso 1 — Cargar catálogos iniciales

En paralelo:

- `GET /categories`
- `GET /brands`
- `GET /products`
- `GET /customers`
- `GET /price-lists`

## Paso 2 — Mapear wizard a payload

1. Bloque “Promoción” → `title`, `type`
2. Bloque “Cómo se aplica” → `method`
3. Bloque por tipo:
   - PRODUCT/ORDER → `discountType`, `discountValue`, `minPurchaseAmountCents`
   - BUY_X_GET_Y → `buyQuantity`, `getQuantity`, `getDiscountPercent`, `appliesTo`, `targetItems`
   - ADVANCED → `buy*` + `get*`
4. Bloque “Vigencia” → `startDate`, `endDate`
5. Bloque “Condiciones” → `customerScope`, `customerIds`, `priceListIds`, `daysOfWeek`

## Paso 3 — Crear

- `POST /promotions`
- Recomendación práctica: luego de crear, hacer `GET /promotions/:id` para refrescar shape normalizado.

### Ejemplo rápido con `fetch`

```ts
await fetch('/promotions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: '10% en categoría jardín',
    type: 'PRODUCT_DISCOUNT',
    method: 'AUTOMATIC',
    discountType: 'PERCENTAGE',
    discountValue: 10,
    appliesTo: 'CATEGORIES',
    targetItems: [{ targetType: 'CATEGORIES', targetId: 'uuid-categoria' }]
  })
})
```

## Paso 4 — Listado

- `GET /promotions?page=1&limit=20&status=ACTIVE&search=...`

## Paso 5 — Editar/finalizar/eliminar

- Editar: `PATCH /promotions/:id`
- Finalizar manualmente: `PATCH /promotions/:id/end`
- Eliminar: `DELETE /promotions/:id`

---

## 13) Edge cases y consideraciones reales del código actual

1. **No cambiar `type`**
   - El endpoint de update no permite cambio de tipo.

2. **`method` en update**
   - Aunque DTO lo acepta, hoy el servicio preserva el método existente.
   - Recomendación FE: tratar `method` como inmutable post-creación por ahora.

3. **`appliesTo` vs `targetItems.targetType`**
   - Backend no fuerza consistencia entre ambos campos.
   - Recomendación FE: mantenerlos coherentes siempre.

4. **`customerScope` vs `customerIds`**
   - Backend valida ids si los envías.
   - Recomendación FE:
     - si `customerScope != SPECIFIC`, enviar `customerIds: []` o no enviar.

5. **Días repetidos**
   - Evitá duplicar `daysOfWeek` para no chocar constraint única en DB.

6. **Porcentajes UI legacy en saltos de 5%**
   - Backend permite cualquier entero `0..99` para `getDiscountPercent`.
   - Si quieren replicar legacy exacto, restringir en frontend a `0,5,10,...,95`.

---

## 14) Contratos recomendados para frontend (tipos TS)

```ts
export type PromotionType =
  | 'PRODUCT_DISCOUNT'
  | 'ORDER_DISCOUNT'
  | 'BUY_X_GET_Y'
  | 'ADVANCED'

export type PromotionMethod = 'AUTOMATIC' | 'MANUAL'
export type PromotionStatus = 'ACTIVE' | 'SCHEDULED' | 'ENDED'
export type DiscountType = 'PERCENTAGE' | 'FIXED'
export type PromotionTargetType = 'CATEGORIES' | 'BRANDS' | 'PRODUCTS'
export type CustomerScope = 'ALL' | 'REGISTERED_ONLY' | 'SPECIFIC'
export type DayOfWeek =
  | 'MONDAY'
  | 'TUESDAY'
  | 'WEDNESDAY'
  | 'THURSDAY'
  | 'FRIDAY'
  | 'SATURDAY'
  | 'SUNDAY'

export interface PromotionResponse {
  id: string
  title: string
  type: PromotionType
  method: PromotionMethod
  status: PromotionStatus
  startDate: string | null
  endDate: string | null
  customerScope: CustomerScope
  discountType: DiscountType | null
  discountValue: number | null
  minPurchaseAmountCents: number | null
  appliesTo: PromotionTargetType | null
  buyQuantity: number | null
  getQuantity: number | null
  getDiscountPercent: number | null
  buyTargetType: PromotionTargetType | null
  getTargetType: PromotionTargetType | null
  targetItems: Array<{
    id: string
    side: 'DEFAULT' | 'BUY' | 'GET'
    targetType: PromotionTargetType
    targetId: string
  }>
  customers: Array<{
    id: string
    customerId: string
    customer?: { id: string; firstName: string; lastName: string | null } | null
  }>
  priceLists: Array<{
    id: string
    globalPriceListId: string
    globalPriceList?: { id: string; name: string } | null
  }>
  daysOfWeek: Array<{ id: string; day: DayOfWeek }>
  createdAt: string
  updatedAt: string
}
```

---

## 15) Checklist de implementación frontend

- [ ] Mapeé labels UI ↔ enums backend correctamente.
- [ ] Estoy enviando montos fijos en centavos.
- [ ] Estoy enviando fechas ISO con zona horaria.
- [ ] No mando campos extra (whitelist estricto).
- [ ] Para ADVANCED, mando target type + target items en ambos lados cuando corresponda.
- [ ] Para SPECIFIC customers, mando `customerIds` válidos.
- [ ] Para update, no intento cambiar `type`.
- [ ] Después de create/update/end refresco detalle por `GET /promotions/:id`.

---

## 16) Nota final para el equipo

Este módulo ya quedó preparado para operar como **catálogo de reglas promocionales**.

Cuando se implemente el motor de cálculo en POS, estas promociones se evaluarán sobre carrito/cliente/lista/día y se resolverá la acumulación de descuentos.

Si necesitan, en un siguiente documento armamos la parte de **estrategia de aplicación en checkout** (prioridades, stacking, conflictos, redondeos, y trazabilidad por línea).
