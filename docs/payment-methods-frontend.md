# Custom Payment Methods (Catálogo POS) — Frontend Integration Guide

**Feature**: `custom-payment-methods` — catálogo de métodos de cobro configurables por sucursal (POS)
**Módulo**: `src/admin/payment-methods/` (CRUD admin) + `src/sales/sales-catalog.controller.ts` (proyección POS)
**Fecha**: 2026-08-26
**Backend**: `houndfe-backend` — NestJS + Prisma + PostgreSQL
**Branch**: `main` (cambio archivado `2026-08-26-custom-payment-methods`)
**Estado**: ✅ Verificado PASS, archivado en `openspec/changes/archive/2026-08-26-custom-payment-methods/`

> **TL;DR.** Cada sucursal ahora administra su propio catálogo de métodos de cobro con nombre de marca (p. ej. "Mercado Pago", "SPEI Banorte", "Efectivo USD"). El POS los selecciona desde `GET /sales/payment-methods` y, al cobrar, manda opcionalmente `paymentMethodId` para que el backend guarde el nombre visible en el recibo y el detalle de venta (como snapshot inmutable). El catálogo **no** toca el método del bot (transfer/card siguen fijos en WhatsApp).

---

## 1. Resumen de endpoints

### Admin (CRUD completo — superficie de backoffice)

| Método | Endpoint | Permiso | Descripción |
| ------ | -------- | ------- | ----------- |
| `POST` | `/admin/payment-methods` | `create:PaymentMethod` | Crear método del catálogo (nace activo) |
| `GET` | `/admin/payment-methods` | `read:PaymentMethod` | Listar métodos del tenant (activos + inactivos), `updatedAt DESC` |
| `GET` | `/admin/payment-methods/:id` | `read:PaymentMethod` | Detalle de un método |
| `PATCH` | `/admin/payment-methods/:id` | `update:PaymentMethod` | Modificar campos (parcial; **incluye `isActive`** para reactivar) |
| `DELETE` | `/admin/payment-methods/:id` | `delete:PaymentMethod` | Baja lógica (`isActive=false`, `204`) |

### POS (proyección de solo lectura — selector del cierre de venta)

| Método | Endpoint | Permiso | Descripción |
| ------ | -------- | ------- | ----------- |
| `GET` | `/sales/payment-methods` | `read:Sale` | Listar métodos **activos** del tenant para el selector del POS. Shape `{ id, name, category, subtitle }`. |

### Integración con el flujo de cobro (snapshot en `SalePayment`)

| Método | Endpoint | Campo nuevo opcional | Comportamiento |
| ------ | -------- | -------------------- | -------------- |
| `POST` | `/sales/drafts/:id/charge` | `paymentMethodId` (en `payments[]` y en legacy single-payment) | Si está presente, el backend valida (activo + mismo tenant + categoría coincide) y guarda snapshot `{ paymentMethodId, name, subtitle? }` en `SalePayment.metadataJson.catalog`. Si está ausente → comportamiento legacy sin cambios. |
| `POST` | `/sales/:id/payments` | `paymentMethodId` (en `payments[]` y en legacy single-payment) | Idéntico al charge (mismo resolver, misma snapshot). El path del bot (`origin` key) **no** se ve afectado. |

Todos requieren JWT (Bearer token). El tenant se determina del token automáticamente (CLS). Un ID de otro tenant devuelve `404`, **no** `403` (no se filtra presencia entre sucursales).

---

## 2. Modelo de datos — shape de respuesta

### `PaymentMethodResponseDto` (todos los endpoints admin)

Shape completo que devuelven `POST`, `GET`, `GET /:id`, `PATCH /:id`:

```typescript
{
  id: string;                              // UUID
  tenantId: string;                        // UUID — sucursal dueña del método
  name: string;                            // p. ej. "Mercado Pago" (1..60 chars, trim)
  category: 'cash' | 'card_credit' | 'card_debit' | 'transfer';  // minúsculas en el wire
  subtitle: string | null;                 // opcional (≤120 chars, trim); null cuando no se envió
  isActive: boolean;                       // true = seleccionable en el POS
  createdAt: string;                       // ISO 8601
  updatedAt: string;                       // ISO 8601
}
```

**Nota importante**: la proyección admin **NO** expone `metadataJson` (campo admin-only reservado para uso interno del backend). Si necesitan un campo extensible adicional en la respuesta admin, consultar con backend antes de leerlo del wire.

### `ActivePaymentMethodProjection` (`GET /sales/payment-methods` — POS)

Proyección **deliberadamente más chica** que la admin — el POS solo necesita lo necesario para el selector:

```typescript
{
  id: string;                              // UUID — el `paymentMethodId` que va en el cobro
  name: string;                            // p. ej. "Mercado Pago"
  category: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
  subtitle: string | null;                 // puede ser null; el POS decide si renderizarlo
}
```

**Diferencias con la proyección admin**:

| Campo | Admin (`/admin/payment-methods/*`) | POS (`/sales/payment-methods`) |
| ----- | ---------------------------------- | ------------------------------ |
| `id` | ✅ | ✅ |
| `tenantId` | ✅ | ❌ (no se filtra por sucursal desde el POS; ya viene del token) |
| `name` | ✅ | ✅ |
| `category` | ✅ | ✅ |
| `subtitle` | ✅ | ✅ |
| `isActive` | ✅ | ❌ (el POS **solo** ve los activos — el filtro ya se aplicó server-side) |
| `createdAt` / `updatedAt` | ✅ | ❌ |
| `metadataJson` | ❌ (nunca en el wire admin) | ❌ |

### `SaleDetailPaymentDto` (sale detail — extiende con catálogo)

Los pagos ya existentes en `GET /sales/:id` ahora pueden traer **tres campos opcionales adicionales** cuando se cobraron con un método del catálogo:

```typescript
{
  paymentId: string;
  method: string;                           // base category ('CASH', 'TRANSFER', ...)
  amountCents: number;
  tenderedCents: number;
  changeCents: number;
  reference: string | null;
  paidAt: string;
  // ── NUEVO (custom-payment-methods) — opcionales, ausentes en filas legacy ──
  paymentMethodId?: string;                // UUID del PaymentMethod al momento del cobro
  paymentMethodName?: string;              // p. ej. "Mercado Pago" — preferido para mostrar
  paymentMethodSubtitle?: string;          // p. ej. "Link" — sub-línea gris opcional
}
```

Si los tres campos nuevos están ausentes → la fila es legacy (sin `catalog` snapshot) y se debe mostrar `method` (etiqueta de categoría base) como hoy.

---

## 3. Endpoints — detalle completo

### 3.1 `POST /admin/payment-methods` — Crear método

**Request**:
```json
{
  "name": "Mercado Pago",
  "category": "transfer",
  "subtitle": "Link de pago"
}
```

| Campo | Tipo | Requerido | Validación |
| ----- | ---- | --------- | ---------- |
| `name` | string | ✅ | string no vacío tras trim; 1..60 chars |
| `category` | enum | ✅ | exactamente uno de: `cash`, `card_credit`, `card_debit`, `transfer`. **`credit` NO es válido** (rechazado con `400 INVALID_CATEGORY`). |
| `subtitle` | string | ❌ | string ≤120 chars tras trim; omitido o `null` → se guarda como `null` |

**Response** `201 Created`: `PaymentMethodResponseDto` con `isActive: true` (default).

**Reglas**:
- `name` y `subtitle` se **trimean** antes de persistir (sin espacios sobrantes).
- `isActive` **no** se acepta en el body (campo derivado: nace `true`, se baja con `DELETE`). Mandarlo produce `400` por `forbidNonWhitelisted`.
- El nuevo método nace **activo** y aparece en el POS inmediatamente (no requiere activación manual).
- Unicidad por sucursal: `@@unique([tenantId, name])`. El mismo nombre **sí** puede existir en otra sucursal.

**Errores**:
| HTTP | Código | Causa |
| ---- | ------ | ----- |
| `400` | `INVALID_NAME` / `NAME_TOO_LONG` / `INVALID_CATEGORY` / `INVALID_SUBTITLE` / `SUBTITLE_TOO_LONG` | Validación de DTO o propiedad no permitida |
| `409` | `DUPLICATE_NAME` | Ya existe un método con ese `name` en esta sucursal |
| `401` | — | No autenticado |
| `403` | — | Sin permiso `create:PaymentMethod` |

---

### 3.2 `GET /admin/payment-methods` — Listar métodos

**Response** `200`: arreglo (sin paginación) con **todas** las filas del tenant — activas **e inactivas** — ordenadas por `updatedAt DESC`:

```json
[
  {
    "id": "11111111-2222-3333-4444-555555555555",
    "tenantId": "b3f2a1c4-...",
    "name": "Mercado Pago",
    "category": "transfer",
    "subtitle": "Link de pago",
    "isActive": true,
    "createdAt": "2026-08-26T10:00:00.000Z",
    "updatedAt": "2026-08-26T10:00:00.000Z"
  },
  {
    "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "tenantId": "b3f2a1c4-...",
    "name": "Efectivo USD",
    "category": "cash",
    "subtitle": null,
    "isActive": false,
    "createdAt": "2026-08-20T10:00:00.000Z",
    "updatedAt": "2026-08-25T10:00:00.000Z"
  }
]
```

**Comportamiento**: incluye inactivas para auditoría/historial (la lista del admin muestra quién fue dado de baja y cuándo).

---

### 3.3 `GET /admin/payment-methods/:id` — Detalle

**Response** `200`: `PaymentMethodResponseDto` (mismo shape que un item de la lista).

**Errores**:
| HTTP | Código | Causa |
| ---- | ------ | ----- |
| `404` | `ENTITY_NOT_FOUND` | ID no existe **o** pertenece a otro tenant (mismo código — no se filtra presencia) |

---

### 3.4 `PATCH /admin/payment-methods/:id` — Actualizar (parcial)

**Request** — todos los campos opcionales; solo se actualizan los enviados:
```json
{
  "subtitle": "QR"
}
```

```json
{
  "name": "Mercado Pago (QR)",
  "isActive": true
}
```

**Response** `200`: `PaymentMethodResponseDto` actualizado. `updatedAt` se bump a la hora del request.

**Reglas**:
- Mismas validaciones por campo que en create (un `name` de 61 chars en PATCH también da `400 NAME_TOO_LONG`).
- **`isActive` ES editable** por PATCH (a diferencia de `PaymentDetail`). Sirve para **reactivar** un método previamente desactivado: `PATCH { "isActive": true }` lo vuelve a mostrar en el POS sin recrear la fila.
- El `name` puede cambiarse a uno que **no esté tomado** en la misma sucursal; si ya existe, devuelve `409 DUPLICATE_NAME` (igual que el create).

**Errores**:
| HTTP | Código | Causa |
| ---- | ------ | ----- |
| `400` | `INVALID_*` / `*_TOO_LONG` | Validación de DTO o propiedad no permitida |
| `404` | `ENTITY_NOT_FOUND` | ID no existe o pertenece a otro tenant |
| `409` | `DUPLICATE_NAME` | El nuevo `name` ya existe en esta sucursal |
| `403` | — | Sin permiso `update:PaymentMethod` |

---

### 3.5 `DELETE /admin/payment-methods/:id` — Baja lógica

**Response** `204 No Content` (body vacío).

**Comportamiento**:
- **Baja lógica**: `isActive` → `false`. La fila **permanece en la DB** (historial auditable).
- **Idempotente**: borrar un método ya inactivo es un no-op (no falla).
- **Reactivable**: para volver a activarlo, `PATCH /admin/payment-methods/:id` con `{ "isActive": true }`.
- **No hay hard delete**.
- Tras la baja, el método **deja de aparecer** en `GET /sales/payment-methods` (proyección POS).

**Errores**:
| HTTP | Código | Causa |
| ---- | ------ | ----- |
| `404` | `ENTITY_NOT_FOUND` | ID no existe o pertenece a otro tenant |
| `403` | — | Sin permiso `delete:PaymentMethod` |

---

### 3.6 `GET /sales/payment-methods` — Proyección POS (selector)

**Permiso requerido**: `read:Sale` (el mismo que `GET /sales/pos-catalog`, **NO** `read:PaymentMethod`).

**Response** `200`: arreglo con **únicamente** las filas activas del tenant, shape `{ id, name, category, subtitle }` (orden estable por nombre):

```json
[
  { "id": "11111111-2222-3333-4444-555555555555", "name": "Mercado Pago", "category": "transfer", "subtitle": "Link" },
  { "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "name": "Efectivo USD", "category": "cash", "subtitle": null }
]
```

**Comportamiento**:
- Inactivas **NO** aparecen.
- Otras sucursales **NO** aparecen.
- `metadataJson` **NO** se expone (campo admin-only).
- Pensado para ser llamado al abrir el POS / al iniciar un cobro; seguro de llamar repetidamente (idempotente y barato).

**Errores**:
| HTTP | Código | Causa |
| ---- | ------ | ----- |
| `401` | — | No autenticado |
| `403` | — | Sin permiso `read:Sale` |

---

## 4. Errores — tabla de referencia rápida

### Endpoints admin (`/admin/payment-methods/*`)

| HTTP | Código interno | Significado | Acción recomendada |
| ---- | -------------- | ----------- | ------------------ |
| 400 | `INVALID_NAME` / `NAME_TOO_LONG` | `name` vacío / >60 chars | Validar en el formulario antes de enviar |
| 400 | `INVALID_CATEGORY` | `category` fuera del whitelist (`cash`, `card_credit`, `card_debit`, `transfer` — **NO** `credit`) | Mostrar selector con las 4 opciones válidas |
| 400 | `INVALID_SUBTITLE` / `SUBTITLE_TOO_LONG` | `subtitle` no-string o >120 chars | Trimear y validar largo en el formulario |
| 400 | — | Propiedad no permitida en body (`forbidNonWhitelisted`) — p. ej. `id`, `tenantId`, `createdAt`, `isActive` en create | No enviar campos derivados del backend |
| 401 | — | Token expirado o inválido | Redirigir a login |
| 403 | — | Sin permiso CASL (`create/read/update/delete:PaymentMethod`) | Ocultar acciones sin permiso |
| 404 | `ENTITY_NOT_FOUND` | ID inexistente o de otro tenant | Mostrar "No encontrado"; **no** filtrar presencia entre sucursales |
| 409 | `DUPLICATE_NAME` | Ya existe un método con ese `name` en esta sucursal | Mensaje claro: "Ya existe un método con ese nombre en esta sucursal" |

### Endpoints de cobro (`POST /sales/drafts/:id/charge`, `POST /sales/:id/payments`) — cuando se manda `paymentMethodId`

| HTTP | Código interno | Significado | Acción recomendada |
| ---- | -------------- | ----------- | ------------------ |
| 400 | `INVALID_PAYMENT_METHOD_ID` | `paymentMethodId` no es UUID | Validar formato en el cliente antes de enviar |
| 400 | `PAYMENT_METHOD_CATEGORY_MISMATCH` | El `category` del método no coincide con el `method` base del entry | Mostrar: "Este método es de otra categoría. Elige el método correcto." — limpiar selección |
| 404 | `PAYMENT_METHOD_NOT_FOUND` | El `paymentMethodId` no existe **o** pertenece a otra sucursal | Mostrar: "Método de cobro no disponible." y refrescar el selector desde `GET /sales/payment-methods` |
| 409 | `INACTIVE_PAYMENT_METHOD` | El método existe pero fue desactivado después de seleccionarlo | Mostrar: "Este método fue desactivado." y refrescar el selector |

### Cobros legacy (sin `paymentMethodId`)

Si el cliente **NO** manda `paymentMethodId`, todo el flujo de error es exactamente el de antes del cambio (ningún código nuevo se introduce). Los snapshots no se escriben y `SalePayment.metadataJson` se queda como estaba (sin `catalog` key).

---

## 5. Permisos

| Acción | Permiso CASL | Descripción |
| ------ | ------------ | ----------- |
| Crear método | `create:PaymentMethod` | Create payment methods |
| Ver lista/detalle admin | `read:PaymentMethod` | View payment methods (admin) |
| Editar / reactivar | `update:PaymentMethod` | Update payment methods |
| Baja lógica | `delete:PaymentMethod` | Delete (logical) payment methods |
| Selector POS (`GET /sales/payment-methods`) | `read:Sale` | **Mismo permiso que el resto del POS** (`pos-catalog`, `sales`); el POS NO necesita `read:PaymentMethod` |

**Notas**:
- Los 4 permisos de `PaymentMethod` se **auto-siembran** en el boot (`PermissionSeeder.onApplicationBootstrap`, upsert idempotente desde `PERMISSION_REGISTRY`). No hay acción manual de seed.
- Se otorgan como cualquier otro permiso, con el endpoint existente `PATCH /admin/roles/:id/permissions` (requiere `update:Role`), pasando los `Permission.id` correspondientes.
- El rol **Super Admin (`manage:all`)** ya cubre estos endpoints (el seeder lo liga automáticamente).
- Para que un cajero de POS pueda cargar el selector, basta con `read:Sale` (que ya tiene). **No** requiere `read:PaymentMethod`.
- Ocultar el menú/sección admin si el usuario no tiene `read:PaymentMethod`; ocultar los botones de crear/editar/eliminar según los permisos faltantes.

---

## 6. Guía de UI

### 6.1 Pantalla admin "Métodos de cobro" (`/admin/payment-methods`)

- **Lista**: mostrar **todas** las filas (activas e inactivas) ordenadas por `updatedAt DESC` (ya viene así del backend). Badge de estado:
  - `Activo` (verde) cuando `isActive === true`
  - `Inactivo` (gris) cuando `isActive === false`
- **Crear**: formulario con `name` (input texto, máx. 60 chars, validar en vivo), `category` (selector con **4 opciones**: Efectivo, Tarjeta de crédito, Tarjeta de débito, Transferencia — **NO** incluir "Crédito" / "A crédito" porque no es categoría válida del catálogo), `subtitle` (input texto opcional, máx. 120 chars). El método nace **activo**.
- **Editar**: pre-rellenar con los valores actuales. `name`, `category`, `subtitle` son editables. **Sí** exponer un toggle de `Activo/Inactivo` que mande `PATCH { isActive: true|false }` (a diferencia de `PaymentDetail`, aquí la reactivación SÍ existe vía PATCH).
- **Desactivar**: botón "Desactivar" con **confirmación obligatoria** — "¿Desactivar este método? Ya no aparecerá como opción al cobrar." Es baja lógica: la fila se queda visible como inactiva en la lista (auditoría). **No** hay hard delete.
- **Reactivar**: en la fila inactiva, botón "Reactivar" que llama `PATCH { isActive: true }`. No requiere recrear.
- **No enviar** `id`, `tenantId`, `createdAt`, `updatedAt` ni `metadataJson` en create/edit (rechazados por `forbidNonWhitelisted`).
- **Category → ícono (derivado en cliente, opcional)**:
  - `cash` → ícono de efectivo/billete
  - `card_credit` → ícono de tarjeta + badge "CRÉDITO"
  - `card_debit` → ícono de tarjeta + badge "DÉBITO"
  - `transfer` → ícono de transferencia / SPEI
  El backend **no** devuelve un `iconKey` — el frontend decide el ícono según `category`.

### 6.2 Selector del POS (cobro / cierre de venta)

1. Al abrir el POS o iniciar un cobro: `GET /sales/payment-methods` (solo necesita `read:Sale`).
2. Renderizar las opciones del selector con `name` como label principal y `subtitle` (cuando exista) como sub-línea gris.
3. Cuando el cajero elige una opción, capturar `id` (ese será el `paymentMethodId` que se mandará al cobrar).
4. Al cobrar, enviar `payments[]` con cada entry incluyendo `paymentMethodId` (ver §7) — **o** omitirlo para mantener el comportamiento legacy (etiqueta de categoría base).

**Si el selector viene vacío**: probablemente la sucursal no tiene métodos personalizados configurados. Mostrar solo los métodos legacy (Efectivo / Tarjeta Crédito / Tarjeta Débito / Transferencia / A Crédito) sin warning; el catálogo es opt-in por sucursal.

### 6.3 Sale detail / timeline / recibo

- En `GET /sales/:id`, si `paymentMethodName` está presente en un pago, **preferirlo** sobre `method` para mostrar el nombre al usuario. Si está ausente → usar la etiqueta de `method` como hoy.
- Si `paymentMethodSubtitle` está presente, renderizarlo como sub-línea gris bajo el nombre.
- El timeline `PAYMENT_RECEIVED` también expone los dos campos opcionales (misma regla de preferencia).
- El PDF del recibo (`pdf-generation/templates/shared/payments-list.tsx`) **ya** está actualizado para preferir el nombre del catálogo.

### 6.4 Reglas operacionales recomendadas

- **Nombre duplicado**: el backend rechaza con `409 DUPLICATE_NAME`; mostrar mensaje específico. El mismo nombre **sí** es válido en otra sucursal — solo mostrar el error cuando aplique.
- **Categoría inválida (`credit`)**: si alguien intenta crear un método "A crédito" desde el formulario, **bloquearlo en el cliente** (el selector no debe ofrecer esa opción). Si pasa, el backend responde `400 INVALID_CATEGORY`.
- **Reactivación segura**: tras un `PATCH { isActive: true }`, refrescar la lista; el método vuelve a `GET /sales/payment-methods` en el siguiente fetch.

---

## 7. Integración con el flujo de cobro (charge / add-payment) — IMPORTANTE

Tanto `POST /sales/drafts/:id/charge` como `POST /sales/:id/payments` aceptan un campo opcional nuevo: `paymentMethodId`. Si se manda, el backend valida, resuelve el método del catálogo y guarda un **snapshot inmutable** del nombre/subtítulo en `SalePayment.metadataJson.catalog`. Si se omite, **todo sigue exactamente igual** que antes (sin cambios para clientes legacy).

### 7.1 Request — charge con método personalizado

`POST /sales/drafts/:draftId/charge`:
```json
{
  "payments": [
    {
      "method": "transfer",
      "amountCents": 250000,
      "paymentMethodId": "11111111-2222-3333-4444-555555555555"
    }
  ]
}
```

O usando el shape legacy single-payment:
```json
{
  "method": "transfer",
  "amountCents": 250000,
  "paymentMethodId": "11111111-2222-3333-4444-555555555555"
}
```

### 7.2 Lo que el backend hace al recibir `paymentMethodId`

1. **Resuelve** el `PaymentMethod` por `id` filtrando por el tenant del token.
   - No existe → `404 PAYMENT_METHOD_NOT_FOUND`
   - Pertenece a otro tenant → `404 PAYMENT_METHOD_NOT_FOUND` (mismo código — no se filtra presencia)
   - Existe pero `isActive === false` → `409 INACTIVE_PAYMENT_METHOD`
   - El `category` del método **no** coincide con el `method` del entry (case-insensitive) → `400 PAYMENT_METHOD_CATEGORY_MISMATCH`
2. **Persiste** el `SalePayment` con:
   - `method` = categoría base resuelta (p. ej. `"TRANSFER"`) — el enum canónico **no** cambia.
   - `metadataJson.catalog = { paymentMethodId: "<uuid>", name: "Mercado Pago", subtitle: "Link" }` (el campo `subtitle` se omite cuando es `null`).
3. **Expone** en `SaleDetailPaymentDto` los tres campos nuevos: `paymentMethodId`, `paymentMethodName`, `paymentMethodSubtitle` (todos opcionales; ausentes en filas legacy).

### 7.3 Idempotencia

El hash de idempotencia de cargo y add-payment **incluye** `paymentMethodId` cuando está presente. Esto significa:

- Mismo `paymentMethodId` + mismo monto + misma categoría → mismo hash → replay seguro (no se duplica el cobro).
- Misma categoría + mismo monto + **distinto** `paymentMethodId` → **hash distinto** → no colisionan (puedes cobrar dos métodos personalizados distintos de la misma categoría sin que el segundo se confunda con replay del primero).
- Payload legacy sin `paymentMethodId` → **hash byte-idéntico** al de antes del cambio (compatibilidad total con clientes existentes).

### 7.4 El path del bot NO se ve afectado

El flujo del revisor humano del bot (bot channel → `POST /sales/:id/payments` desde el panel del revisor) **no** cambia: hard-codifica `method: "transfer"` y estampa `metadataJson.origin = { kind: "bot", channel }`. Esa rama **no** manda `paymentMethodId` y no escribe la key `catalog`. Las keys `reference`, `origin` y `catalog` viven en niveles disjuntos de `metadataJson` y no colisionan.

### 7.5 Refunds

`SaleRefund.method` sigue siendo el enum base (`CASH | CARD_CREDIT | CARD_DEBIT | TRANSFER | CREDIT`). La cancelación de una venta con un pago de método personalizado **no** requiere conocimiento del catálogo: el backend lee `SalePayment.method` (que es la categoría base) y crea el refund correspondiente. **No** se introduce un valor `CUSTOM` en el enum.

### 7.6 Snapshot semantics (renombrar / desactivar NO reescribe historia)

Si después de cobrar con un método personalizado, el admin:
- Le cambia el `name` al método → el `paymentMethodName` en `SalePayment.metadataJson.catalog.name` **NO** cambia. El recibo histórico sigue diciendo "Mercado Pago" aunque hoy el catálogo diga "Mercado Pago v2".
- Lo desactiva (`DELETE`) → el snapshot **NO** cambia. Cobros nuevos **sí** lo rechazan (`409 INACTIVE_PAYMENT_METHOD`), pero el histórico se mantiene íntegro.
- Lo elimina (no hay hard delete, pero si lo hubiera) → el `paymentMethodId` del snapshot queda como referencia opaca (no es FK vivo). El recibo histórico no se toca.

---

## 8. Checklist para frontend (integración)

### Admin (`/admin/payment-methods`)

- [ ] Sección "Métodos de cobro" visible solo con `read:PaymentMethod`; ocultar menú sin permiso.
- [ ] Lista con **todas** las filas (activas + inactivas), orden `updatedAt DESC`, badge de estado.
- [ ] Formulario de creación con validación: `name` 1..60 chars, `category` selector con **4 opciones** (no incluir "Crédito"), `subtitle` opcional ≤120 chars.
- [ ] Validación de `category` en cliente para impedir `credit` (también el backend lo rechaza con `400 INVALID_CATEGORY`).
- [ ] No enviar `id`, `tenantId`, `createdAt`, `updatedAt`, `metadataJson`, `isActive` en create (rechazados por `forbidNonWhitelisted`).
- [ ] Manejo de `409 DUPLICATE_NAME` con mensaje específico ("Ya existe un método con ese nombre en esta sucursal").
- [ ] Manejo de `404` (ID de otro tenant / inexistente) con "No encontrado" — sin filtrar presencia.
- [ ] Edición parcial con `PATCH` (pre-rellenar con valores actuales). Incluir un **toggle de activo/inactivo** que mande `PATCH { isActive: true|false }` (reactivación posible).
- [ ] Baja lógica con `DELETE` + confirmación explícita ("¿Desactivar? Ya no aparecerá al cobrar"). La fila pasa a inactiva sin desaparecer de la lista. **No** construir hard delete.
- [ ] Ocultar botones de crear/editar/eliminar según permisos CASL.

### POS (`/sales/payment-methods`)

- [ ] Llamar `GET /sales/payment-methods` al abrir el selector de método de cobro (necesita solo `read:Sale`).
- [ ] Renderizar `name` como label principal; `subtitle` (si existe y no es null) como sub-línea gris.
- [ ] Si la lista viene vacía, no mostrar warning: el catálogo es opt-in; los métodos legacy siguen disponibles.
- [ ] Capturar `id` de la opción seleccionada para mandarlo como `paymentMethodId` en el cobro.

### Cierre de venta (charge / add-payment)

- [ ] Si se eligió un método del catálogo, enviar `paymentMethodId` (en `payments[]` o en el legacy single-payment) junto con el `method` base que coincida con su `category`.
- [ ] Si no se eligió método del catálogo, omitir `paymentMethodId` y enviar solo `method` + `amountCents` (comportamiento legacy, hash byte-idéntico).
- [ ] Manejar `400 PAYMENT_METHOD_CATEGORY_MISMATCH` (categoría no coincide) — limpiar selección del catálogo.
- [ ] Manejar `404 PAYMENT_METHOD_NOT_FOUND` — refrescar `GET /sales/payment-methods` y volver a pedir selección.
- [ ] Manejar `409 INACTIVE_PAYMENT_METHOD` — avisar al usuario y refrescar el selector.
- [ ] Manejar `400 INVALID_PAYMENT_METHOD_ID` — validar formato UUID en cliente antes de enviar.

### Sale detail / timeline / recibo

- [ ] En `SaleDetailPaymentDto`, si `paymentMethodName` está presente, **preferirlo** sobre `method` para mostrar al usuario. Si no, usar etiqueta de `method` como antes.
- [ ] Si `paymentMethodSubtitle` está presente, mostrarlo como sub-línea gris.
- [ ] Misma regla para el evento `PAYMENT_RECEIVED` del timeline.
- [ ] El PDF del recibo ya está actualizado en backend — no requiere cambios adicionales en el frontend para reflejar el nombre.

---

## 9. Notas técnicas

- **Migración**: tabla nueva `payment_methods` (modelo `PaymentMethod`): FK `tenantId` → `Tenant` con `onDelete: Cascade`, `@@unique([tenantId, name])`, índice en `tenantId`. En Prisma se mapea con `@@map("payment_methods")`. `prisma migrate deploy` es seguro en prod; no afecta tablas existentes.
- **Enum**: nuevo `enum PaymentMethodCategory` con **4 valores** (`CASH | CARD_CREDIT | CARD_DEBIT | TRANSFER`). El valor `CREDIT` está **excluido estructuralmente** del catálogo (es un marcador de estado de venta, no un método configurable).
- **Tenant isolation**: todas las queries pasan por `TenantPrismaService` (CLS) más `where: { id, tenantId }` explícito como defense in depth. Un ID de otro tenant devuelve `404`, **nunca** `403`.
- **Baja lógica + reactivación**: `DELETE` solo flipea `isActive=false`; `PATCH { isActive: true }` reactiva en el mismo registro (diferencia con `PaymentDetail`, que no permite reactivación).
- **Permisos nuevos**: 4 filas en la tabla `Permission` (subject `PaymentMethod`), auto-seed en boot; otorgables vía `PATCH /admin/roles/:id/permissions`. El POS NO requiere `read:PaymentMethod` (usa `read:Sale`, mismo que `pos-catalog`).
- **Snapshot semantics**: el `name`/`subtitle` que llega al recibo es el del momento del cobro — renombrar o desactivar el método después **no** reescribe historia. El `paymentMethodId` en el snapshot es una referencia opaca (no es FK vivo).
- **Idempotencia**: `paymentMethodId` entra al hash de cargo y add-payment **solo cuando está presente**. Payloads legacy sin el campo hashan byte-idéntico a antes del cambio.
- **Refund**: `SaleRefund.method` mantiene el enum base. La cancelación de ventas con métodos personalizados funciona sin cambios — no se introduce `CUSTOM`.
- **Resolver pattern**: el módulo de ventas consume un puerto de solo lectura (`PAYMENT_METHOD_RESOLVER`), no el repositorio del admin. Esto evita que ventas dependa de operaciones de escritura del catálogo y centraliza los códigos de error del catálogo en un solo lugar (`PAYMENT_METHOD_NOT_FOUND`, `INACTIVE_PAYMENT_METHOD`, `PAYMENT_METHOD_CATEGORY_MISMATCH`).
- **Path del bot**: el flujo del revisor humano del bot (`POST /sales/:id/payments` con `method: "transfer"` + `metadataJson.origin`) **no** se ve afectado — sigue funcionando como antes, no escribe la key `catalog`. Las keys `reference`, `origin` y `catalog` viven en niveles disjuntos de `metadataJson`.
