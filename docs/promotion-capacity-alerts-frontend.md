# Capacidad de promociones y alertas — Guía de implementación frontend

> Handoff backend → frontend para el cupo opcional de unidades por promoción, el
> consumo en la confirmación de venta, el conflicto de re-cotización y las alertas
> de vencimiento/capacidad.
>
> **Estado del backend**: implementado e integrado en `main` local en `edf6ef8`
> (revisión de esta guía). No hay despliegue remoto verificado. La entrega de
> emails es asíncrona (outbox + Inngest). En desarrollo, sin
> `RESEND_API_KEY`, el mailer registra un mensaje con destinatarios ocultos en
> lugar de enviarlo: no prometas envío inmediato ni entrega en vivo.
>
> **Fuente de verdad**: lo marcado **Contrato backend** es obligatorio y sale del
> código actual; lo marcado **Recomendación frontend** es adaptable. No inventes
> endpoints ni campos fuera de este documento.
>
> **Fuera de alcance**: reservas en borrador/cotización, backfill histórico,
> restauración por reembolsos monetarios, destinatarios o canales por submódulo,
> notificaciones in-app/push/SMS/Slack, umbrales configurables e hitos múltiples.

---

## 1. Quick path

1. Muestra `maxProductUnits`, `consumedProductUnits` y `remainingProductUnits` tal como llegan; no los recalcules (§2.4).
2. En el formulario distingue tres estados del cupo: **omitir**, **`null`** y **número positivo**. Nunca envíes `consumedProductUnits` (§2.3).
3. Envía `POST /sales/drafts/:id/charge` con el header `idempotency-key` no vacío; responde `201` tanto en el alta como en el replay. Reutiliza la misma clave solo para reintentar el mismo cuerpo (§2.6).
4. Trata `409 PROMO_CAPACITY_RE_QUOTE` como "re-cotiza": re-lee el borrador y muestra los totales antes de reintentar como operación nueva (§2.7, §3.2).
5. En notificaciones, haz GET antes del PUT y reenvía **el subconjunto actualmente habilitado de las seis claves**; así preservas las acciones no relacionadas que ya estaban encendidas sin activar las que el tenant tenía apagadas (§2.10, §3.4).
6. Refresca el detalle y el listado de promociones tras cobrar o cancelar (§3.3).

---

## 2. Contrato backend (OBLIGATORIO — fuente de verdad)

### 2.1 Rutas, autorización y estados HTTP

Todas las rutas exigen JWT Bearer y derivan el tenant del token: el frontend **nunca** envía `tenantId`. Cadena de guards: `JwtAuthGuard` → `TenantContextGuard` → `PermissionsGuard`.

| Método   | Path                                              | Permiso                     |
| -------- | ------------------------------------------------- | --------------------------- |
| `POST`   | `/promotions`                                     | `create:Promotion`          |
| `GET`    | `/promotions`, `/promotions/:id`                  | `read:Promotion`            |
| `PATCH`  | `/promotions/:id`                                 | `update:Promotion`          |
| `PATCH`  | `/promotions/:id/end`, `/promotions/:id/activate` | `update:Promotion`          |
| `POST`   | `/promotions/batch-activate`, `/batch-end`        | `update:Promotion`          |
| `DELETE` | `/promotions/:id`                                 | `delete:Promotion`          |
| `POST`   | `/sales/drafts/:id/charge`                        | `update:Sale`               |
| `POST`   | `/sales/:id/cancel`                               | `delete:Sale`               |
| `GET`    | `/notification-config`                            | `read:NotificationConfig`   |
| `PUT`    | `/notification-config`                            | `update:NotificationConfig` |

Estados esperados: `401` sin JWT válido, `403` por permiso insuficiente, `400` de validación de DTO, `409` de dominio por conflicto de negocio (§2.9) y `404` cuando el recurso no existe en el tenant. El `404` usa **códigos distintos** según el recurso: `ENTITY_NOT_FOUND` para la promoción y `SALE_NOT_FOUND` para la venta.

> `POST /sales/drafts/:id/charge` exige el header `idempotency-key` no vacío; sin él responde `400` de Nest con `{ statusCode: 400, error: 'Bad Request', message: 'IDEMPOTENCY_KEY_REQUIRED' }` (`message` es un string, no el array del `ValidationPipe`). En éxito y en replay responde `201 Created`.

### 2.2 Listado `GET /promotions`: query, defaults y paginación

| Query           | Valores / límites                                                    |
| --------------- | -------------------------------------------------------------------- |
| `type`          | enum de tipo de promoción                                            |
| `status`        | `ACTIVE`, `SCHEDULED` o `ENDED` (se traduce a un rango de fechas)    |
| `method`        | enum de método                                                       |
| `customerScope` | enum de alcance de clientes                                          |
| `search`        | texto; `contains` case-insensitive sobre `title`                     |
| `page`          | entero `>= 1`, default **1**                                         |
| `limit`         | entero `1..100`, default **20**                                      |
| `sortBy`        | `title`, `createdAt`, `updatedAt` o `startDate`; default `createdAt` |
| `sortOrder`     | `asc` \| `desc`, default `desc`                                      |

El filtro `status` no es un `where` plano: `ACTIVE` y `SCHEDULED` exigen que la columna persistida no sea `ENDED`; `SCHEDULED` además exige `startDate > now`; `ACTIVE` exige (`startDate` nulo o `<= now`) y (`endDate` nulo o `>= now`); `ENDED` es la unión de `status = 'ENDED'` **o** `endDate < now`. Es decir, una promoción con `status` persistido `ENDED` nunca aparece en `ACTIVE`/`SCHEDULED`, y `ENDED` incluye además las vencidas por fecha aunque la columna siga en otro valor. La respuesta es un sobre con metadatos; los ítems traen la forma completa de §2.4:

```ts
interface PromotionListResponse {
  data: PromotionResponse[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}
```

`totalPages` es `Math.ceil(total / limit)` y queda en `0` cuando `total` es `0`. `limit` fuera de rango o `page < 1` devuelven `400` de validación (§2.9).

### 2.3 `maxProductUnits` en create y update (tri-estado)

Campo opcional en `CreatePromotionDto` y `UpdatePromotionDto` (los 4 tipos). Entero `1..2147483647` (`INT` de PostgreSQL) o `null`. El `ValidationPipe` global corre con `whitelist` y `forbidNonWhitelisted`.

| Payload                   | Create             | Update                      |
| ------------------------- | ------------------ | --------------------------- |
| Campo omitido             | Ilimitado (`null`) | **Preserva** el cupo actual |
| `"maxProductUnits": null` | Ilimitado (`null`) | **Quita** el cupo (`null`)  |
| `"maxProductUnits": 100`  | Cupo de 100        | Reemplaza el cupo por 100   |

- `0`, negativos, decimales, strings o valores `> 2147483647` → `400` de validación.
- No puedes bajar el cupo por debajo de `consumedProductUnits` ya registrado: responde `400 PRODUCT_UNIT_CAPACITY_EXCEEDED` (el mutador revalida contra el consumo persistido y nunca lo modifica).
- **`consumedProductUnits` no es un campo de request.** Enviarlo es rechazado por `forbidNonWhitelisted`; en update el consumo siempre se lee de la base (`INVALID_CONSUMED_PRODUCT_UNITS` existe solo como guarda interna de dominio).

### 2.4 Respuesta de promoción: contadores, nulabilidad y estado

Create, update, findOne, findAll y end/activate devuelven la misma forma. Extracto alineado a `Promotion.toResponse()` (el objeto real incluye además `targetItems`, `customers`, `priceLists` y `daysOfWeek`):

```ts
interface PromotionResponse {
  id: string;
  title: string;
  status: 'ACTIVE' | 'SCHEDULED' | 'ENDED';
  startDate: string | null; // ISO 8601
  endDate: string | null; // ISO 8601
  maxProductUnits: number | null; // null = ilimitado
  consumedProductUnits: number; // entero >= 0, derivado del ledger
  remainingProductUnits: number | null; // null si ilimitado
  createdAt: string;
  updatedAt: string;
  // ...resto de campos de la promoción
}
```

```json
{
  "maxProductUnits": 100,
  "consumedProductUnits": 80,
  "remainingProductUnits": 20
}
```

- `remainingProductUnits = maxProductUnits - consumedProductUnits`, o `null` cuando el cupo es ilimitado. **Nunca** lo calcules en el frontend: puede quedar obsoleto entre tu lectura y la próxima venta o edición del cupo.
- `consumedProductUnits` siempre es un entero `>= 0`; `remainingProductUnits` es `null` únicamente con `maxProductUnits === null`. El consumo puede ser mayor que cero con cupo ilimitado, y un cupo posterior no puede quedar por debajo de ese consumo ya registrado.
- `status` es **estado efectivo calculado en tiempo de lectura**: `manuallyEnded` lo fuerza a `ENDED`; si no, `startDate > now` → `SCHEDULED`, `endDate < now` → `ENDED`, en otro caso `ACTIVE`. No dependas de la columna persistida.

### 2.5 Quién consume y qué cuenta como unidad

| Evento                                               | Efecto sobre el cupo                |
| ---------------------------------------------------- | ----------------------------------- |
| Borrador / cotización (preview, opt-in manual, veto) | **No** consume ni reserva           |
| Confirmación de venta (`charge`)                     | Consume atómicamente                |
| Cancelación total de la venta confirmada             | Restaura lo consumido, una sola vez |
| Reembolso parcial o liquidación monetaria            | **No** restaura unidades            |

Semántica de unidades: cuenta solo unidades que reciben el beneficio (`PRODUCT_DISCOUNT`: cada unidad descontada; `ORDER_DISCOUNT`: cada unidad del pedido beneficiado; `BUY_X_GET_Y` y `ADVANCED`: solo unidades `GET` premiadas). Es todo-o-nada por venta: si falta cupo, esa promoción no aplica y nunca se excede el máximo.

### 2.6 `charge`: solicitud, respuesta e idempotencia

```ts
type ChargeMethod =
  | 'cash'
  | 'card_credit'
  | 'card_debit'
  | 'transfer'
  | 'credit';

interface ChargeRequest {
  method?: ChargeMethod; // forma legacy de pago único
  amountCents?: number;
  paymentMethodId?: string; // UUID del catálogo
  payments?: {
    method: ChargeMethod;
    amountCents: number; // entero >= 0
    reference?: string;
    paymentMethodId?: string;
  }[]; // máximo 5 entradas
  dueDate?: string; // ISO 8601
  delivery?: boolean; // requiere shippingAddressId para true
}

interface ChargeResponse {
  saleId: string;
  folio: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  paidCents: number;
  debtCents: number;
  changeDueCents: number;
  paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
  confirmedAt: string; // ISO 8601
}
```

```http
POST /sales/drafts/<draftId>/charge
Authorization: Bearer <JWT>
Content-Type: application/json
idempotency-key: <operationId>

{
  "payments": [{ "method": "cash", "amountCents": 15000 }],
  "delivery": false
}
```

El servidor hashea `{ saleId, actorId, payments (ordenados), dueDate, delivery }` y decide:

| Situación                                      | Resultado                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Misma clave + mismo cuerpo (reintento)         | Replay: `201` con el **mismo** payload confirmado                                     |
| Misma clave + cuerpo distinto                  | `409 IDEMPOTENCY_KEY_CONFLICT`                                                        |
| Misma clave mientras la primera sigue en vuelo | `409 IDEMPOTENCY_KEY_IN_FLIGHT`                                                       |
| Clave nueva (intento lógico nuevo)             | Nueva confirmación `201`; falla con `409 SALE_ALREADY_CONFIRMED` si ya no es borrador |

Regla práctica: **una clave por intento lógico**. Para reintentar tras un timeout de red reutiliza la clave y el cuerpo byte-idéntico; si el usuario cambió montos o pagos, genera una clave nueva. El `charge` recalcula promociones dentro de la transacción, así que el total cobrado refleja la elegibilidad vigente, no el último preview persistido. El status HTTP **no** distingue alta de replay: ambos responden `201 Created`.

### 2.7 Conflicto de re-cotización y conflictos de capacidad (409)

Si entre el último preview y el `charge` el cupo cambió y una promoción aplicada quedó excluida, la operación **no cobra** y devuelve:

```json
{
  "statusCode": 409,
  "error": "PROMO_CAPACITY_RE_QUOTE",
  "message": "Promotion capacity changed during charge — re-quote required",
  "timestamp": "2026-09-21T18:04:11.482Z",
  "appliedPromotionIds": ["promo-line-1", "promo-order-1"],
  "excludedPromotionIds": ["promo-line-1"]
}
```

- `appliedPromotionIds` es la **fotografía completa** de promociones aplicadas (línea + orden) tomada antes del recómputo, ordenada y sin duplicados.
- `excludedPromotionIds` es el **subconjunto** de esa fotografía que el recómputo excluyó: la intersección, no la lista cruda de exclusiones del motor.
- El `DomainExceptionFilter` aplana `details` al primer nivel: los arrays van **fuera** de un objeto `details`.

Los otros dos conflictos de capacidad usan el mismo sobre plano y son guardas de carrera interna (la transacción revierte y la venta no queda cobrada); trátalos como reintentables, no como éxito:

- `PROMOTION_CAPACITY_EXCEEDED` → `{ saleId, promotionId, units }`.
- `PROMOTION_CAPACITY_CLAIM_MISMATCH` → `{ saleId, promotionId, units }`.

> No confundas con `PROMO_RE_QUOTE` (pre-existente, ruta bot con `expectedTotalCents`), que también es `409` pero devuelve `{ recomputedTotalCents, expectedTotalCents, discountCents }`.

### 2.8 Cancelación: motivo, restauración exacta y reembolsos

El `reason` del cuerpo es obligatorio y debe ser uno de: `CUSTOMER_REQUEST`,
`ORDER_ERROR`, `OUT_OF_STOCK`, `DUPLICATE_SALE`, `OTHER`.

```ts
interface CancelSaleResponse {
  saleId: string;
  status: 'CANCELED';
  refundedCents: number;
  restockedItems: {
    productId: string;
    variantId: string | null;
    quantity: number;
  }[];
  canceledAt: string; // ISO 8601
}
```

```http
POST /sales/<saleId>/cancel
Authorization: Bearer <JWT>
Content-Type: application/json

{ "reason": "CUSTOMER_REQUEST" }
```

- `reason` es obligatorio y se valida contra el enum; cualquier otro valor devuelve `400`.
- La restauración de unidades ocurre **exactamente una vez** por venta, en la misma transacción, con una marca `restoredAt` aplicada primero: solo el intento que gana la marca decrementa el contador.
- La restauración devuelve **todas** las unidades reclamadas por la venta, sin importar el monto monetario reembolsado.
- Los **reembolsos parciales y las liquidaciones no restauran** unidades: solo la cancelación total lo hace.
- La cancelación es idempotente con clave derivada en el servidor (`sale:cancel:<saleId>`); el frontend no envía `idempotency-key`. El hash de la solicitud cubre `{ saleId, actorId, reason }`: repetir la cancelación con el **mismo actor y el mismo motivo** devuelve el replay del resultado previo; con **otro actor u otro motivo** responde `409 IDEMPOTENCY_KEY_CONFLICT` (sin volver a restaurar).

### 2.9 Cuatro sobres de error distintos (no los unifiques)

| Origen                                           | Cuerpo                                                                           | ¿`timestamp`? |
| ------------------------------------------------ | -------------------------------------------------------------------------------- | ------------- |
| Dominio (`DomainExceptionFilter`)                | `{ statusCode, error: '<CODE_DOMINIO>', message, timestamp, ...detallesPlanos }` | Sí            |
| Validación Nest (DTO o guarda de controller)     | `{ statusCode: 400, error: 'Bad Request', message }`                             | No            |
| Validación de listados                           | `{ statusCode: 400, code: 'LISTING_*', message, field, details? }`               | No            |
| `NotificationConfig` (solo política de servicio) | `{ error: 'UNKNOWN_ACTION_KEY' o 'INVALID_RECIPIENT', message }`                 | No            |

- El sobre de dominio lleva `error` con el **código de negocio** y `timestamp`; los `409` de §2.7 usan esta forma.
- El `400` de validación de DTO trae `error: 'Bad Request'` y `message` como **array** de objetos `ValidationError` (por ejemplo `maxProductUnits` fuera de rango o un campo no permitido). Cuando el DTO declara contexto de listado, la forma cambia a `code` + `field` y sin `error`.
- Una guarda de controller que lanza `BadRequestException` con un string (por ejemplo `IDEMPOTENCY_KEY_REQUIRED` en `charge`) también es un `400` de Nest, pero con `message` **string** en lugar de array.
- El `400` de configuración de notificaciones con `{ error, message }` **solo** proviene de la política del servicio para `UNKNOWN_ACTION_KEY` o `INVALID_RECIPIENT` y **no** incluye `timestamp` ni `statusCode`. Cualquier otro fallo del `PUT` (falta `enabled`, tipos incorrectos o `recipients` en vez de `recipientUserIds`) es validación de DTO y usa el sobre Nest 400 habitual. No lo trates como error de dominio.

### 2.10 Configuración de notificaciones: GET vs PUT y reemplazo completo

```ts
type NotificationActionKey =
  | 'LOW_STOCK'
  | 'TIME_OFF_REQUESTED'
  | 'DELIVERY_NEXT_STOP'
  | 'PROMOTION_EXPIRING'
  | 'PROMOTION_NEAR_CAPACITY'
  | 'DELIVERY_THANK_YOU';

// GET /notification-config — respuesta (round-trip del PUT)
interface NotificationConfigResponse {
  enabled: boolean;
  recipients: string[]; // userIds, orden ascendente
  enabledActions: NotificationActionKey[]; // orden ascendente
}

// PUT /notification-config — los tres campos son obligatorios
interface NotificationConfigUpdateRequest {
  enabled: boolean;
  recipientUserIds: string[]; // userIds, lista compartida de staff (alertas de staff)
  enabledActions: string[];
}
```

**Diferencia crítica de nombres**: el GET responde `recipients`; el PUT recibe `recipientUserIds`. `recipients` no es un alias aceptado en el PUT: es un campo desconocido y el pipe global lo rechaza con `400`.

```http
PUT /notification-config
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "enabled": true,
  "recipientUserIds": ["<userId>", "<userId>"],
  "enabledActions": [
    "LOW_STOCK",
    "TIME_OFF_REQUESTED",
    "DELIVERY_NEXT_STOP",
    "PROMOTION_EXPIRING",
    "DELIVERY_THANK_YOU"
  ]
}
```

- `enabled` es el master toggle del tenant y el primer gate: en `false` ninguna alerta envía.
- Los destinatarios (`recipients`/`recipientUserIds`) son **una única lista compartida de staff** y aplican **solo a las alertas de staff** (stock, time-off, próximo stop, promociones): los emails se resuelven al enviar y se filtran usuarios inactivos. **No** aplican a `DELIVERY_THANK_YOU`; ese correo al cliente resolverá su dirección con una búsqueda **independiente y con alcance de tenant** del email del cliente en el momento del envío (consumidor aún no implementado en DTE-1). El frontend nunca recibe ni administra direcciones de email.
- El canal es **solo email**. Las seis claves son miembros planos y equivalentes del enum; el grupo visual "Promociones" **no** existe en el backend.
- El `PUT` es un **reemplazo completo**: destinatarios y acciones se borran y se recrean desde el cuerpo, y responde la misma vista que el `GET`; todo lo omitido se pierde.
- **Preserva solo lo que estaba habilitado**: al togglear una acción debes reenviar las claves **actualmente habilitadas** (subconjunto de las seis permitidas), incluidas las no relacionadas que ya estaban encendidas (por ejemplo `LOW_STOCK` o `DELIVERY_NEXT_STOP`). Enviar siempre las seis claves **habilitaría** las que el tenant tenía apagadas; omitir una habilitada la borraría.
- **`DELIVERY_THANK_YOU` (`feat/delivery-thank-you-email`, DTE-1)**: sexta clave plana, registrada para el correo de agradecimiento al cliente tras un check-in de entrega exitoso. Hoy el backend **solo la registra**: no existe todavía productor, evento, poller ni remitente, así que **activarla no envía ningún correo**. Llega **deshabilitada** por defecto (sin filas sembradas) y solo se enciende por `PUT`. Nunca la uses como destinatario: los `recipients`/`recipientUserIds` siguen siendo **staff** (userIds internos) y jamás la dirección del cliente; la clave se envía dentro de `enabledActions`, no en la lista de destinatarios.
- Tenant sin configuración: `{ "enabled": false, "recipients": [], "enabledActions": [] }`. No hay filas sembradas para las claves nuevas (las dos de promociones y `DELIVERY_THANK_YOU`): quedan **deshabilitadas** hasta que el tenant las active por `PUT`.
- Errores: `400 UNKNOWN_ACTION_KEY` (clave fuera del set) y `400 INVALID_RECIPIENT` (usuario que no pertenece al tenant).

```ts
const PROMOTION_KEYS = [
  'PROMOTION_EXPIRING',
  'PROMOTION_NEAR_CAPACITY',
] as const;
const ALL_KEYS: NotificationActionKey[] = [
  'LOW_STOCK',
  'TIME_OFF_REQUESTED',
  'DELIVERY_NEXT_STOP',
  ...PROMOTION_KEYS,
  'DELIVERY_THANK_YOU',
];

function togglePromotionAction(
  current: NotificationConfigResponse,
  key: (typeof PROMOTION_KEYS)[number],
  next: boolean,
): NotificationConfigUpdateRequest {
  const enabled = new Set(current.enabledActions);
  if (next) enabled.add(key);
  else enabled.delete(key);

  return {
    enabled: current.enabled,
    recipientUserIds: current.recipients,
    // Reenvía solo las claves habilitadas: el PUT reemplaza la lista completa.
    enabledActions: ALL_KEYS.filter((candidate) => enabled.has(candidate)),
  };
}
```

### 2.11 Semántica de umbrales y entrega asíncrona

- **Vencimiento (`PROMOTION_EXPIRING`)**: un email cuando una promoción efectivamente `ACTIVE` vence dentro de la ventana `(ahora, ahora + 7 días]`. La elegibilidad se deriva solo de fechas (`manuallyEnded = false`, `endDate` no nulo, ya iniciada), nunca del `status` persistido. Deduplica por valor de `endDate`: un `A → B → A` no vuelve a alertar por `A`.
- **Capacidad (`PROMOTION_NEAR_CAPACITY`)**: email cuando el consumo cruza **hacia arriba** el 80% de un cupo finito (`previo·5 < max·4` y `nuevo·5 >= max·4`). No hay segundo email mientras siga por encima; se rearma solo si una cancelación baja el consumo por debajo del 80% y luego vuelve a cruzar con una venta nueva.
- Las promociones ilimitadas (`maxProductUnits: null`) nunca disparan alerta de capacidad.
- Detección y umbral se acoplan en la misma transacción; la **entrega** es asíncrona, agrupada en lote por tenant (`batchEvents` con `key: 'event.data.tenantId'`) e idempotente por huella del evento: `${tenantId}:${promotionId}:${endDate}` para vencimiento y `${tenantId}:${promotionId}:${saleId}` para capacidad. Un reintento del mismo evento deduplica; un evento nuevo sí puede alertar, la acción y los destinatarios se re-leen **al momento del envío** y nada garantiza entrega inmediata.

---

## 3. Recomendaciones frontend (adaptables)

### 3.1 Estados de cupo sugeridos

| Estado           | Condición                                   | UI sugerida                             |
| ---------------- | ------------------------------------------- | --------------------------------------- |
| Ilimitado        | `maxProductUnits === null`                  | "Sin límite"                            |
| Disponible       | `remainingProductUnits > 0` y consumo < 80% | Cupo normal con restante                |
| Cerca del límite | consumo `>= 80%` del cupo                   | Aviso ámbar, texto "quedan N unidades"  |
| Agotado          | `remainingProductUnits === 0`               | Badge "Sin cupo"; no ofrecer opt-in     |
| Consumo sin cupo | `maxProductUnits === null` y consumo `> 0`  | Mostrar consumo histórico, sin restante |

### 3.2 Flujo de re-cotización (`PROMO_CAPACITY_RE_QUOTE`)

1. No reintentes automáticamente, ni una sola vez.
2. Re-lee el borrador y vuelve a renderizar `subtotalCents`/`discountCents`/`totalCents`.
3. Resalta las promociones de `excludedPromotionIds` como "ya no aplicable".
4. Pide confirmación explícita antes del nuevo `charge`, que debe ser una **operación nueva con clave de idempotencia nueva**.
5. No uses `appliedPromotionIds` para recalcular precios: es evidencia del snapshot, no una tarifa.

### 3.3 Invalidación de caché

| Mutación                                                              | Invalidar                                            |
| --------------------------------------------------------------------- | ---------------------------------------------------- |
| create / update de promoción (el cupo altera `remainingProductUnits`) | detalle de la promoción + listado                    |
| end / activate / batch-activate / batch-end                           | detalles afectados + listado                         |
| `charge` exitoso                                                      | promoción (§2.4) + listado + borrador/venta          |
| cancelación exitosa                                                   | promoción (contadores restaurados) + listado + venta |
| `PUT /notification-config`                                            | `GET /notification-config`                           |

No caches `recipients` como emails: son `userIds` resueltos server-side al enviar. `consumedProductUnits` solo cambia por mutaciones de venta (`charge`/`cancel`), pero `maxProductUnits` y por lo tanto `remainingProductUnits` también cambian al **crear o actualizar el cupo**: refresca el detalle y el listado tras esas mutaciones, no solo después de cobrar o cancelar.

### 3.4 Grupo visual "Promociones" (solo UI)

Renderiza dos toggles separados —`PROMOTION_EXPIRING` y `PROMOTION_NEAR_CAPACITY`— dentro de un grupo visual "Promociones", encima del master toggle y de la lista compartida de destinatarios. Este agrupamiento es **exclusivo del frontend**: al `PUT` envía claves planas dentro de `enabledActions`. Escribe el estado optimista a partir de la respuesta del `PUT` (round-trip) en lugar de asumir el resultado.

---

## 4. Matriz de aceptación QA

| #   | Escenario                           | Entrada / acción                                                                 | Resultado esperado                                                         |
| --- | ----------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | Create sin cupo                     | `POST /promotions` sin `maxProductUnits`                                         | `maxProductUnits: null`, `remainingProductUnits: null`                     |
| 2   | Create con cupo explícito `null`    | `maxProductUnits: null`                                                          | Ilimitado, sin error                                                       |
| 3   | Create con cupo inválido            | `0`, `-1`, `1.5`, `2147483648` o `"100"`                                         | `400` validación, `message` como array                                     |
| 4   | Update: tri-estado del cupo         | `PATCH` con campo omitido, `null` o número                                       | Preserva, quita o reemplaza el cupo                                        |
| 5   | Update encoge bajo el consumo       | cupo `17` con consumo `20`                                                       | `400 PRODUCT_UNIT_CAPACITY_EXCEEDED`                                       |
| 6   | Intento de escribir el consumo      | `PATCH` con `consumedProductUnits`                                               | `400` por `forbidNonWhitelisted`                                           |
| 7   | Listado con defaults                | `GET /promotions`                                                                | `meta.page = 1`, `meta.limit = 20`, `totalPages` coherente                 |
| 8   | Filtro `ENDED` por columna          | `GET /promotions?status=ENDED` con `status` persistido `ENDED`                   | Aparece: `ENDED` incluye `status = 'ENDED'`                                |
| 9   | Filtro excluye `ENDED`              | `GET /promotions?status=ACTIVE` o `SCHEDULED`                                    | Nunca incluye filas con `status` persistido `ENDED`                        |
| 10  | Charge sin clave de idempotencia    | `POST .../charge` sin header                                                     | `400` Nest `{ error: 'Bad Request', message: 'IDEMPOTENCY_KEY_REQUIRED' }` |
| 11  | Alta nueva del `charge`             | `POST .../charge` con clave nueva                                                | `201` con payload confirmado                                               |
| 12  | Reintento idéntico                  | Misma `idempotency-key` + mismo cuerpo                                           | `201` con payload idéntico (replay)                                        |
| 13  | Reuso indebido de la clave          | Misma clave + cuerpo distinto                                                    | `409 IDEMPOTENCY_KEY_CONFLICT`                                             |
| 14  | Cupo cambiado durante el cobro      | Promoción aplicada pasa a excluida                                               | `409 PROMO_CAPACITY_RE_QUOTE` con arrays planos                            |
| 15  | Cancelación con motivo inválido     | `{ "reason": "NOPE" }`                                                           | `400` de validación                                                        |
| 16  | Restauración única                  | Cancelar dos veces con el mismo actor y motivo                                   | Replay: unidades restauradas exactamente una vez                           |
| 17  | Cancelación repetida distinta       | Cancelar con otro actor u otro motivo                                            | `409 IDEMPOTENCY_KEY_CONFLICT`, sin restaurar de nuevo                     |
| 18  | Reembolso parcial                   | Liquidar un reembolso parcial                                                    | El cupo **no** se restaura                                                 |
| 19  | `404` de promoción vs venta         | Operar con un id inexistente                                                     | `404 ENTITY_NOT_FOUND` para promoción; `404 SALE_NOT_FOUND` para venta     |
| 20  | Configuración inválida de política  | `PUT` con `enabledActions: ["FOO"]` o `recipientUserIds` ajeno                   | `400 { error, message }` sin `timestamp`                                   |
| 21  | Configuración inválida de DTO       | `PUT` sin `enabled` o con `recipients` en vez de `recipientUserIds`              | `400` Nest con `message` array y `error: 'Bad Request'`                    |
| 22  | Toggle preserva el resto            | Activar `PROMOTION_EXPIRING` tras el GET con otra clave habilitada y una apagada | Solo se reenvían las habilitadas; la apagada sigue apagada                 |
| 23  | Update del cupo refresca contadores | `PATCH /promotions/:id` cambiando `maxProductUnits` sin ventas                   | `remainingProductUnits` cambia aunque no haya venta                        |
| 24  | Round-trip de configuración         | Comparar respuesta del `PUT` con `GET`                                           | Misma forma (`recipients`, orden ascendente)                               |

---

## 5. Checklist de implementación

- [ ] El formulario distingue omitir / `null` / número y nunca envía `consumedProductUnits`.
- [ ] La UI muestra `remainingProductUnits` del servidor sin recalcular.
- [ ] El `charge` reutiliza la clave solo con cuerpo idéntico, espera `201` en alta y replay, y maneja `409 PROMO_CAPACITY_RE_QUOTE`.
- [ ] La cancelación usa el enum de motivo y no asume restauración por reembolso ni replay con otro actor o motivo.
- [ ] El `PUT` de notificaciones usa `recipientUserIds` y reenvía solo las claves actualmente habilitadas (subconjunto de las seis), sin activar las apagadas.
- [ ] Los cuatro sobres de error se distinguen por forma, no solo por status.
- [ ] El refetch corre tras cobrar y cancelar.

## 6. Fuentes en el backend

- `src/promotions/dto/create-promotion.dto.ts`, `src/promotions/dto/update-promotion.dto.ts`, `src/promotions/dto/promotion-query.dto.ts`
- `src/promotions/domain/promotion.entity.ts` (`toResponse`, `getEffectiveStatus`, `remainingProductUnits`)
- `src/promotions/promotions.controller.ts`, `src/promotions/promotions.service.ts`, `src/promotions/infrastructure/prisma-promotion.repository.ts`
- `src/promotions/infrastructure/prisma-promotion-usage.repository.ts` (claim, umbral 80%, `restoreForSale`)
- `src/promotions/domain/promotion-expiry-alert-state.repository.ts`, `src/promotions/expiry/promotion-expiry.scanner.ts` (ventana de 7 días)
- `src/promotions/outbox/promotion-capacity-outbox.types.ts`, `src/promotions/inngest/promotion-expiry.functions.ts`, `src/promotions/inngest/promotion-near-capacity.functions.ts`
- `src/sales/sales.service.ts` (re-cómputo y `claimForSale`, `PROMO_CAPACITY_RE_QUOTE`, `restoreForSale`), `src/sales/sales.controller.ts`, `src/sales/sales-query.controller.ts`, `src/sales/dto/charge-sale.dto.ts`, `src/sales/dto/cancel-sale.dto.ts`
- `src/shared/filters/domain-exception.filter.ts`, `src/shared/domain/domain-error.ts` (`ENTITY_NOT_FOUND` para promoción vs `SALE_NOT_FOUND` para venta), `src/shared/listing/listing-validation-exception.factory.ts`, `src/shared/listing/listing.exceptions.ts`
- `src/notification-config/domain/notification-config.ts`, `src/notification-config/notification-config.service.ts`, `src/notification-config/notification-config.controller.ts`, `src/notification-config/dto/update-notification-config.dto.ts`
- `src/main.ts` (ValidationPipe `whitelist` + `forbidNonWhitelisted`)
