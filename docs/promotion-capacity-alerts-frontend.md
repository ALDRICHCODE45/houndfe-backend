# Capacidad de promociones y alertas — Handoff Frontend

> Handoff backend → frontend para el cupo opcional de unidades por promoción, el
> consumo en confirmación de venta y las alertas de vencimiento/capacidad.
>
> **Fuente de verdad**: todo lo marcado como **Contrato backend** es obligatorio y
> sale del código actual. Todo lo marcado como **Recomendación frontend** es una
> propuesta adaptable; no inventes endpoints ni campos por fuera de este documento.
>
> **Estado del backend**: implementado en la rama `feat/promotion-capacity-alerts`
> (HEAD `9e1720d2`). La entrega de emails es asíncrona vía Inngest con pruebas
> mockeadas; no hay prueba en runtime vivo todavía. No prometas envío inmediato.
>
> **Fuera de alcance**: reservas en borrador/cotización, backfill histórico,
> restauración por reembolsos monetarios, destinatarios o canales por submódulo,
> notificaciones in-app/push/SMS/WhatsApp/Slack, umbrales configurables y
> múltiples hitos de vencimiento.

---

## 1. Quick path

1. Mostrá `maxProductUnits`, `consumedProductUnits` y `remainingProductUnits` tal
   como llegan; no los recalcules.
2. En el formulario de promoción, distinguí tres estados del cupo: **omitir**,
   **`null`** y **número positivo** (§2.2). No mandes `consumedProductUnits`.
3. Al cobrar (`POST /sales/drafts/:id/charge`), tratá `409 PROMO_CAPACITY_RE_QUOTE`
   como "re-cotizá": re-leé el borrador y volvé a mostrar totales antes de reintentar (§2.5).
4. Para alertas, agrupá `PROMOTION_EXPIRING` y `PROMOTION_NEAR_CAPACITY` bajo
   "Promociones" en la pantalla de notificaciones (§2.6 y §3.4).
5. Refrescá el detalle de la promoción después de cobrar o cancelar (§3.3).

---

## 2. Contrato backend (OBLIGATORIO — fuente de verdad)

### 2.1 Rutas relevantes

Todas exigen JWT Bearer y el tenant se deriva del token (el frontend **nunca**
envía `tenantId`). Cadena de guards: `JwtAuthGuard` → `TenantContextGuard` →
`PermissionsGuard`.

| Método  | Path                                              | Permiso                     |
| ------- | ------------------------------------------------- | --------------------------- |
| `POST`  | `/promotions`                                     | `create:Promotion`          |
| `GET`   | `/promotions`, `/promotions/:id`                  | `read:Promotion`            |
| `PATCH` | `/promotions/:id`                                 | `update:Promotion`          |
| `PATCH` | `/promotions/:id/end`, `/promotions/:id/activate` | `update:Promotion`          |
| `POST`  | `/promotions/batch-activate`, `/batch-end`        | `update:Promotion`          |
| `POST`  | `/sales/drafts/:id/charge`                        | `update:Sale`               |
| `POST`  | `/sales/:id/cancel`                               | `delete:Sale`               |
| `GET`   | `/notification-config`                            | `read:NotificationConfig`   |
| `PUT`   | `/notification-config`                            | `update:NotificationConfig` |

> `POST /sales/drafts/:id/charge` exige el header `idempotency-key` no vacío;
> sin él responde `400 IDEMPOTENCY_KEY_REQUIRED`.

### 2.2 `maxProductUnits` en create y update (tri-estado)

Campo opcional en `CreatePromotionDto` y `UpdatePromotionDto` (los 4 tipos).
Entero en `1..2147483647` (INT de PostgreSQL). El `ValidationPipe` global corre
con `whitelist` y `forbidNonWhitelisted`.

| Payload                   | Create             | Update                      |
| ------------------------- | ------------------ | --------------------------- |
| Campo omitido             | Ilimitado (`null`) | **Preserva** el cupo actual |
| `"maxProductUnits": null` | Ilimitado (`null`) | **Quita** el cupo (`null`)  |
| `"maxProductUnits": 100`  | Cupo de 100        | Reemplaza el cupo por 100   |

Reglas:

- `0`, negativos, decimales, strings o valores `> 2147483647` → `400` de validación.
- No podés bajar el cupo por debajo de `consumedProductUnits` ya registrado:
  responde `400 PRODUCT_UNIT_CAPACITY_EXCEEDED`.
- **`consumedProductUnits` no es un campo de request.** Enviarlo es rechazado por
  `forbidNonWhitelisted`; en update, `consumedProductUnits` siempre se lee de la
  base (`INVALID_CONSUMED_PRODUCT_UNITS` existe solo como guarda interna).

### 2.3 Respuesta de promoción con contadores derivados

Create, update, findOne y findAll devuelven la misma forma. Extracto alineado a
`Promotion.toResponse()`:

```json
{
  "id": "6d2c1c9e-0d0f-4c1f-9d5f-2f6b0a7c1234",
  "maxProductUnits": 100,
  "consumedProductUnits": 80,
  "remainingProductUnits": 20
}
```

- `maxProductUnits`: número o `null`.
- `consumedProductUnits`: entero `>= 0`, siempre derivado del ledger en el servidor.
- `remainingProductUnits`: `maxProductUnits - consumedProductUnits`, o `null`
  cuando el cupo es ilimitado.

**Nunca** calcules `remaining` en el frontend: el valor puede quedar obsoleto
entre tu lectura y la próxima venta.

> Una promoción puede tener `maxProductUnits: null` y `consumedProductUnits > 0`:
> el consumo se registra desde el deploy aunque el cupo sea ilimitado. Un cupo
> posterior no puede quedar por debajo de ese consumo ya registrado.

### 2.4 Quién consume y quién no

| Evento                                               | Efecto sobre el cupo                |
| ---------------------------------------------------- | ----------------------------------- |
| Borrador / cotización (preview, opt-in manual, veto) | **No** consume ni reserva           |
| Confirmación de venta (`charge`)                     | Consume atómicamente                |
| Cancelación total de la venta confirmada             | Restaura lo consumido, una sola vez |
| Reembolso parcial o liquidación monetaria            | **No** restaura unidades            |

Semántica de unidades: cuenta solo unidades que reciben el beneficio
(`PRODUCT_DISCOUNT`: cada unidad descontada; `ORDER_DISCOUNT`: cada unidad del
pedido beneficiado; `BUY_X_GET_Y` y `ADVANCED`: solo unidades `GET` premiadas).
Es todo-o-nada por venta: si falta cupo, esa promoción no aplica y nunca se
excede el máximo.

### 2.5 Conflicto de re-cotización al confirmar (409)

Si entre el último preview y el `charge` el cupo cambió y una promoción aplicada
quedó excluida, la operación **no cobra** y devuelve:

```json
{
  "statusCode": 409,
  "error": "PROMO_CAPACITY_RE_QUOTE",
  "message": "Promotion capacity changed during charge — re-quote required",
  "timestamp": "2026-09-21T18:04:11.482Z",
  "appliedPromotionIds": ["9a1f..."],
  "excludedPromotionIds": ["9a1f..."]
}
```

El `DomainExceptionFilter` aplana `details` en el body: `appliedPromotionIds` y
`excludedPromotionIds` van al primer nivel (no dentro de un `details`). Los
mismos campos planos aplican a los otros dos conflictos de capacidad de 409:

- `PROMOTION_CAPACITY_EXCEEDED` → `{ saleId, promotionId, units }`.
- `PROMOTION_CAPACITY_CLAIM_MISMATCH` → `{ saleId, promotionId, units }`.

Ambos son guardas de carrera interna: la transacción revierte y la venta no
queda cobrada. Tratalos como conflicto reintentable, no como éxito.

> No confundir con `PROMO_RE_QUOTE` (pre-existente, ruta bot con
> `expectedTotalCents`), que también es 409 pero devuelve
> `{ recomputedTotalCents, expectedTotalCents, discountCents }`.

### 2.6 Notificaciones: claves, toggle y destinatarios

Contrato de `GET`/`PUT /notification-config`:

```json
{
  "enabled": false,
  "recipients": ["<userId>", "<userId>"],
  "enabledActions": ["LOW_STOCK", "PROMOTION_EXPIRING"]
}
```

- `enabled`: master toggle del tenant. Es el primer gate: en `false`, ninguna alerta envía.
- `recipients`: **userIds** de una única lista compartida por todas las acciones.
  Los emails se resuelven recién al enviar y se filtran usuarios inactivos; el
  frontend no recibe ni administra direcciones de email.
- `enabledActions`: subconjunto de claves válidas. Las dos nuevas son
  `PROMOTION_EXPIRING` y `PROMOTION_NEAR_CAPACITY`. Una acción deshabilitada no envía.
- Tenant sin configuración: `{ "enabled": false, "recipients": [], "enabledActions": [] }`.
  No hay filas sembradas para las dos claves nuevas: quedan **deshabilitadas**
  hasta que el tenant las active por `PUT`.
- `PUT` es un **reemplazo completo** y exige `enabled`, `recipientUserIds` y
  `enabledActions`. Errores: `400 UNKNOWN_ACTION_KEY` (clave fuera del set) y
  `400 INVALID_RECIPIENT` (usuario que no pertenece al tenant).

Las dos claves son miembros planos y equivalentes del enum; el canal es
**solo email**. El grupo visual "Promociones" **no** existe en el backend.

### 2.7 Semántica de umbrales

- **Vencimiento (`PROMOTION_EXPIRING`)**: un email cuando una promoción
  efectivamente `ACTIVE` vence dentro de la ventana `(ahora, ahora + 7 días]`.
  La elegibilidad se deriva solo de fechas (`manuallyEnded = false`,
  `endDate` no nulo, ya iniciada), nunca del `status` persistido. Deduplica por
  valor de `endDate`: un `A → B → A` no vuelve a alertar por `A`.
- **Capacidad (`PROMOTION_NEAR_CAPACITY`)**: email cuando el consumo cruza
  **hacia arriba** el 80% de un cupo finito (`previo·5 < max·4` y
  `nuevo·5 >= max·4`). No hay segundo email mientras siga por encima; se rearma
  solo si una cancelación baja el consumo por debajo del 80% y luego vuelve a cruzar.
- Promociones ilimitadas (`maxProductUnits: null`) nunca disparan alerta de capacidad.
- Creación y umbral se acoplan en la misma transacción; la **entrega** del email
  es asíncrona e idempotente. No garantices entrega inmediata.

---

## 3. Recomendación frontend (adaptable)

### 3.1 Estados de cupo sugeridos

| Estado           | Condición                                   | UI sugerida                             |
| ---------------- | ------------------------------------------- | --------------------------------------- |
| Ilimitado        | `maxProductUnits === null`                  | "Sin límite"                            |
| Disponible       | `remainingProductUnits > 0` y consumo < 80% | Cupo normal con restante                |
| Cerca del límite | consumo `>= 80%` del cupo                   | Aviso ámbar, texto "quedan N unidades"  |
| Agotado          | `remainingProductUnits === 0`               | Badge "Sin cupo"; no ofrecer opt-in     |
| Consumo sin cupo | `maxProductUnits === null` y consumo `> 0`  | Mostrar consumo histórico, sin restante |

### 3.2 UI de re-cotización (409)

Ante `PROMO_CAPACITY_RE_QUOTE`: no reintentes automáticamente. Re-leé el borrador,
volvé a renderizar `subtotalCents`/`discountCents`/`totalCents`, resaltá las
promociones de `excludedPromotionIds` como "ya no aplicable" y pedí confirmación
explícita antes de reintentar el `charge` como una operación nueva.
No inspecciones `appliedPromotionIds` para recalcular precios.

### 3.3 Refetch de cache

Disparadores de refetch del detalle/listado de promociones: tras
create/update/end/activate/batch y tras `charge` o `cancel` exitosos, porque los
contadores cambian. Para el form, invalidá también el borrador tras el `charge`.
Los `recipients` de notificaciones se resuelven server-side al enviar, así que no
los caches como emails.

### 3.4 Grupo "Promociones" (solo UI)

Renderizá dos toggles separados —`PROMOTION_EXPIRING` y `PROMOTION_NEAR_CAPACITY`—
dentro de un grupo visual "Promociones", encima del master toggle y la lista
compartida de destinatarios. Este agrupamiento es **exclusivo del frontend**: al
`PUT` mandate claves planas dentro de `enabledActions`.

---

## 4. Checklist de implementación

- [ ] El formulario distingue omitir / `null` / número y nunca manda `consumedProductUnits`.
- [ ] La UI muestra `remainingProductUnits` del servidor sin recalcular.
- [ ] El `charge` maneja `409 PROMO_CAPACITY_RE_QUOTE` con flujo de re-cotización.
- [ ] Los toggles de las dos acciones nuevas se envían como claves planas.
- [ ] El refetch corre tras cobrar y cancelar.

## 5. Fuentes en el backend

- `src/promotions/dto/create-promotion.dto.ts`, `update-promotion.dto.ts`
- `src/promotions/domain/promotion.entity.ts` (`toResponse`, `remainingProductUnits`)
- `src/promotions/promotions.service.ts` (merge create/update del cupo)
- `src/sales/sales.service.ts` (claim en `charge`, `PROMO_CAPACITY_RE_QUOTE`)
- `src/shared/filters/domain-exception.filter.ts` (mapeo 409 y body plano)
- `src/notification-config/domain/notification-config.ts` y `notification-config.service.ts`
- `src/promotions/domain/promotion-expiry-alert-state.repository.ts`,
  `src/promotions/infrastructure/prisma-promotion-usage.repository.ts`
