# Delivery Routes — Mensaje de entrega para frontend

> **Para:** equipo frontend (houndfe)
> **De:** backend (houndfe-backend)
> **Feature:** `delivery-routes` — rutas de entrega con repartidor, check-in por parada y email "tu paquete está por llegar"
> **Rama:** `main` (mergeada)
> **Doc técnica completa:** `docs/delivery-routes-frontend.md` (endpoints, DTOs, errores y checklist al detalle)

---

## 1. Resumen ejecutivo

Implementamos el equivalente a Circuit dentro de HoundFe, adaptado a cómo trabajan tus clientes hoy (envíos con repartidores internos). El flujo es:

1. Un **route-manager** agrupa ventas elegibles en una **ruta** (`DeliveryRoute`) y le asigna un **repartidor**.
2. El repartidor **inicia la ruta** y va haciendo **check-in** parada por parada desde el frontend web (sin GPS).
3. Cada check-in marca la venta como `DELIVERED` automáticamente.
4. Si hay una parada siguiente, el sistema le envía un email al cliente de esa parada avisando que su paquete está por llegar (**solo si el cliente tiene email** y el tenant lo habilitó).

El repartidor **es un `User` con un rol específico** (no un `Employee`). Se reutiliza todo el RBAC existente.

---

## 2. Decisiones de negocio que necesitás conocer

| Decisión | Detalle |
|---|---|
| **Repartidor** | Es un `User` con un rol que tenga permisos `read` + `update` sobre `DeliveryRoute`. No es un Employee. |
| **Discriminador manager vs driver** | Si el usuario tiene `create` **o** `delete` sobre `DeliveryRoute` → es **manager** (crea/edita/reordena/borra rutas). Si solo tiene `read` + `update` → es **driver** (solo ve sus rutas y hace check-in). |
| **Parada = venta** | Una parada es una venta existente con `deliveryStatus ∈ {PENDING, SHIPPED}` **y** con `shippingAddress`. No se crean paradas sueltas. |
| **Una venta en una sola ruta activa** | El backend garantiza (a nivel de BD) que una venta no esté en dos rutas activas a la vez. Si pasa, `start` devuelve `409`. |
| **Email al cliente** | Opt-in por tenant vía `PUT /notification-config`. El destinatario es el **email del cliente de la parada siguiente**, resuelto en el momento del envío. |
| **Sin GPS ni tráfico** | El orden de las paradas es **manual** (drag & drop). La optimización automática por mapas queda como fase futura detrás de un puerto abstraído. |

---

## 3. Endpoints (resumen)

Todos bajo `/delivery-routes`, requieren JWT. El tenant se resuelve del token (CLS); una ruta de otro tenant devuelve `404` (nunca `403`, para no filtrar presencia).

| Método | Endpoint | Permiso | Uso |
|---|---|---|---|
| `POST` | `/delivery-routes` | `create:DeliveryRoute` | Crear ruta DRAFT con ≥1 venta + repartidor |
| `GET` | `/delivery-routes` | `read:DeliveryRoute` | Listar (drivers ven solo las suyas, managers todas) |
| `GET` | `/delivery-routes/:id` | `read:DeliveryRoute` | Detalle + `timeline` |
| `PATCH` | `/delivery-routes/:id` | `update:DeliveryRoute` | Editar repartidor/notas (solo DRAFT) |
| `DELETE` | `/delivery-routes/:id` | `delete:DeliveryRoute` | Borrar DRAFT con 0 paradas |
| `POST` | `/delivery-routes/:id/start` | `update:DeliveryRoute` | DRAFT → ACTIVE |
| `POST` | `/delivery-routes/:id/cancel` | `update:DeliveryRoute` | DRAFT/ACTIVE → CANCELLED |
| `POST` | `/delivery-routes/:id/stops` | `update:DeliveryRoute` | Agregar una venta a un DRAFT |
| `POST` | `/delivery-routes/:id/stops/:stopId/check-in` | `update:DeliveryRoute` | Check-in de parada (marca venta DELIVERED + dispara email de la siguiente) |
| `PUT` | `/delivery-routes/:id/stops/reorder` | `update:DeliveryRoute` | Reordenar paradas (solo DRAFT) |

**Ciclo de vida:** `DRAFT → ACTIVE → COMPLETED` (o `CANCELLED`). `COMPLETED` es terminal. Check-in del último stop auto-completa la ruta.

---

## 4. Lo más importante para la UI

### 4.1 Detectar manager vs driver

Usá `GET /auth/me/permissions`:

- ¿Tiene `create:DeliveryRoute` o `delete:DeliveryRoute`? → **UI de manager** (crear, editar, reordenar, borrar, iniciar).
- ¿Solo `read` + `update`? → **UI de driver** (lista de sus rutas + botón de check-in).

**No** infieras el rol desde el payload de la ruta. El backend ya filtra la lista por `driverUserId = self` para los drivers; no mandes parámetro `driverUserId` (no existe en el query).

### 4.2 Pantalla de manager

1. Elegir ventas elegibles (filtro client-side: `deliveryStatus ∈ {PENDING, SHIPPED}` + `shippingAddress != null`; el backend re-valida).
2. `POST /delivery-routes` con `{ saleIds[], driverUserId, notes? }` → ruta en `DRAFT`.
3. Mientras esté en `DRAFT`: editar repartidor/notas (`PATCH`), agregar venta (`POST :id/stops`), reordenar (`PUT :id/stops/reorder`).
4. `POST :id/start` para arrancar. Si devuelve `409 DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE`, es que una venta ya está en otra ruta activa → mostrar conflicto y recargar.

### 4.3 Pantalla de driver

1. `GET /delivery-routes?status=ACTIVE` → ya solo devuelve sus rutas.
2. Detalle con `GET /delivery-routes/:id`: paradas ordenadas por `sortOrder`, con `customer.name` + `shippingAddress` (formatear: `label` primero, luego calle/número, colonia, `CP zipCode`).
3. Check-in: `POST /delivery-routes/:id/stops/:stopId/check-in`. Es **idempotente** (reintentar un check-in ya hecho no duplica el email).
4. Renderizar el `timeline` (ver §5).

### 4.4 Notificaciones (opt-in del email)

En la pantalla de "Notificaciones", agregar un toggle "Notificación de próxima entrega" que incluya `DELIVERY_NEXT_STOP` en `enabledActions`. El `PUT /notification-config` es **reemplazo total**: leer la config actual con `GET`, mergear el toggle y reenviar todo.

---

## 5. Timeline (shape exacto)

`GET /delivery-routes/:id` devuelve un `timeline` ordenado ascendente por `at` (el backend ya ordena). Tipos:

```typescript
type DeliveryRouteTimelineEvent =
  | { type: 'ROUTE_CREATED';    at: string; actor: { id: string; name: string } | null }
  | { type: 'ROUTE_STARTED';    at: string; actor: { id: string; name: string } | null }
  | { type: 'STOP_CHECKED_IN';  at: string; stopId: string; sortOrder: number;
      actor: { id: string; name: string } | null }
  | { type: 'ROUTE_COMPLETED';  at: string; actor: { id: string; name: string } | null }
  | { type: 'ROUTE_CANCELLED';  at: string; actor: { id: string; name: string } | null };
```

- `ROUTE_CREATED` siempre está, con `actor: null` (no se persiste el creador en esta fase).
- `ROUTE_COMPLETED` y `ROUTE_CANCELLED` son mutuamente excluyentes.
- El `actor` de los eventos de inicio/check-in/completado/cancelado es el **repartidor asignado** (no se persisten actores por acción en esta fase).

---

## 6. Errores que vas a encontrarte

| HTTP | Código | Cuándo |
|---|---|---|
| `404` | `ENTITY_NOT_FOUND` | Ruta no existe o es de otro tenant |
| `403` | — | Falta permiso, o un driver intenta actuar sobre la ruta de otro |
| `409` | `DELIVERY_ROUTE_STOP_SALE_ALREADY_ON_ACTIVE_ROUTE` | Una venta ya está en otra ruta activa al hacer `start` |
| `422` | `DELIVERY_ROUTE_INVALID_TRANSITION` | Transición ilegal (editar no-DRAFT, cancelar COMPLETED, check-in en DRAFT, reorder inválido) |
| `422` | `DELIVERY_ROUTE_STOP_SALE_NOT_ELIGIBLE` | Venta no `PENDING`/`SHIPPED` o sin dirección de envío |
| `400` | — | Validación de DTO (uuid inválido, `saleIds` vacío, `notes` > 280) |

Envelope global: `{ statusCode, error, message, timestamp }` + `details` cuando aplica.

---

## 7. Checklist de integración

- [ ] Leer `GET /auth/me/permissions` para decidir manager vs driver.
- [ ] Manager: crear ruta, editar en DRAFT, reordenar, iniciar (manejar `409`).
- [ ] Manager: `DELETE` solo con DRAFT + 0 paradas (botón oculto si ya tiene paradas).
- [ ] Driver: listar solo sus rutas, detalle con direcciones, check-in idempotente.
- [ ] Renderizar `timeline` (5 tipos de evento).
- [ ] Pantalla de notificaciones: toggle `DELIVERY_NEXT_STOP` con `PUT /notification-config` (reemplazo total).
- [ ] No enviar `id`, `tenantId`, `createdAt`, `updatedAt`, `timeline` ni `activeRouteId` en los bodies (se rechazan por `forbidNonWhitelisted`).

---

## 8. Referencia

La doc técnica completa está en **`docs/delivery-routes-frontend.md`** — ahí está el shape TypeScript de cada DTO de respuesta, la tabla de errores extendida y las notas técnicas (tenant isolation, atomicidad del check-in, pipeline del email). Ante cualquier duda del contrato, ese archivo es la fuente de verdad.
