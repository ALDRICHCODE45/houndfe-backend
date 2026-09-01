# Historial de Ventas por Cliente — Guía Frontend

> Documento de handoff backend → frontend. Cubre la vista "historial de compras por cliente" con métricas (total vendido, deuda pendiente) y lista paginada de ventas confirmadas.
>
> **Estado del backend**: contrato implementado localmente en `houndfe-backend` (cambios aún no comiteados; pendiente de commit y deploy). Pendiente de implementación frontend.
>
> **Permiso frontend decide el alcance**: este documento es la **fuente de verdad para el contrato backend** (sección §2 y §3). Todo lo demás (componentes, layout, animaciones, copy, métricas adicionales) es **recomendación no vinculante** — el equipo de frontend tiene autoridad final sobre la implementación, siguiendo los patrones del módulo de clientes y `docs/customers-frontend.md`.

---

## 1. Resultado y decisiones clave (TL;DR)

- **Qué obtienes del backend**: al hacer `GET /sales` con `customerId=<uuid>` (omitiendo `customerIncludeNull` o enviando `false`), la respuesta ya incluye un bloque nuevo `summary` con `salesCount`, `totalSoldCents` y `outstandingDebtCents` para ese cliente. **El frontend ya no necesita sumar filas paginadas** — el summary es la fuente autoritativa.
- **Cero queries adicionales**: el bloque `summary` viene en la misma respuesta que la lista. La implementación backend usa un `prisma.sale.aggregate` que reemplaza el `count()` previo (no se añadió una 5ª query).
- **Semántica confirmada**: `summary` cuenta únicamente ventas con `status = 'CONFIRMED'`. Borradores (`DRAFT`) y canceladas (`CANCELED`) están excluidas por diseño — son estados incompletos o inválidos para "lo que compró el cliente".
- **Significado de `outstandingDebtCents`**: es la **suma de `debtCents`** persistido en cada venta confirmada del cliente. Es cero cuando todas están pagadas; positivo cuando hay alguna `PARTIAL` o `CREDIT`. El `debtCents` por venta es la fuente autoritativa; el backend summary lo agrega — el frontend debe leerlo, no recalcularlo.
- **Tenant-safe por construcción**: la query pasa por `TenantPrismaService` (CLS). Un `customerId` de otro tenant devuelve `summary: { salesCount: 0, totalSoldCents: 0, outstandingDebtCents: 0 }` y `data: []` — **nunca 403** (no se filtra presencia entre tenants).
- **Permiso requerido**: `read:Sale` (mismo que ya usas para el listado de ventas). Sin este permiso, el backend responde `403` y el frontend debe ocultar la acción.

> ⚠️ **Frontend decide cómo se ve, pero NO decide el contrato del bloque `summary`**. Su forma, nombres de campos y semántica son **vinculantes** — vienen del backend. Lo que sí es decisión frontend: dónde se muestra, qué métricas adicionales derivar, cómo se anima, qué copy usar.

---

## 2. Contrato backend (OBLIGATORIO — fuente de verdad)

### 2.1 Endpoint

```
GET /sales
```

Permiso: `read:Sale` (más `JWT` válido y contexto de tenant).

Sin cambios en el path, método ni autenticación. **Solo se adiciona el bloque `summary`** en el body de respuesta y se documenta explícitamente la semántica de los filtros base.

### 2.2 Query params para vista "historial por cliente"

| Param                 | Tipo                                         | Obligatorio                      | Descripción                                                                                                                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customerId`          | `string` (UUID, admite CSV)                  | ✅                               | UUID del cliente. **Cardinalidad máxima 200** (validado por backend; pasarse lanza `LISTING_TOO_MANY_VALUES`).                                                                                                                                                                                                        |
| `customerIncludeNull` | `boolean` (`true`/`false`)                   | opcional (default `false`)       | **Para historial de un cliente específico: omitir o enviar `false`**. Nunca enviar `true` aquí, porque mezclaría ventas anónimas (`Público en General`, con `customerId = null`) en el historial de ese cliente. Reservar `true` solo para vistas que explícitamente pidan "todas las ventas del cliente + anónimas". |
| `page`                | `int` (1..n)                                 | opcional (default `1`)           | Página actual.                                                                                                                                                                                                                                                                                                        |
| `limit`               | `int` (1..100)                               | opcional (default `20`)          | Tamaño de página. Máximo `100`.                                                                                                                                                                                                                                                                                       |
| `sortBy`              | `confirmedAt` \| `totalCents` \| `createdAt` | opcional (default `confirmedAt`) | Campo de orden.                                                                                                                                                                                                                                                                                                       |
| `sortOrder`           | `asc` \| `desc`                              | opcional (default `desc`)        | Sentido.                                                                                                                                                                                                                                                                                                              |
| `confirmedFrom`       | ISO 8601                                     | opcional                         | Fecha mínima de confirmación.                                                                                                                                                                                                                                                                                         |
| `confirmedTo`         | ISO 8601                                     | opcional                         | Fecha máxima de confirmación.                                                                                                                                                                                                                                                                                         |

**Resto de filtros heredados** (`paymentStatus`, `deliveryStatus`, `paymentMethod`, `totalMin/Max`, `debtMin/Max`, `dueDateFrom/To`, `cashierUserId`, `q`, `folio`, `status`) — aplican al listado como siempre (ver `docs/sales-frontend.md` y `docs/sales-pos-charge-frontend.md`). **Importante**: `summary` usa **solo el set base** de filtros (los que también aplican a `pagination.total` y `counts.all`). Los filtros extendidos como `paymentStatus`, `totalMin`, etc. **NO afectan `summary`** — eso es por diseño, para que `summary.salesCount === pagination.total === counts.all` se mantenga por construcción.

### 2.3 Ejemplo de query para un cliente

```
GET /sales
  ?customerId=8a7cbe67-7e82-4d3c-b8d0-5f0e613c1a7a
  &page=1
  &limit=10
  &sortBy=confirmedAt
  &sortOrder=desc
```

Nota: `customerIncludeNull` se omite deliberadamente (equivale a `false`). No enviar `true` para historial de cliente.

### 2.4 Ejemplo de respuesta (200 OK)

```json
{
  "data": [
    {
      "id": "b5e2b8fd-bdfd-471f-b687-ec340d578885",
      "folio": "A-202608-000042",
      "status": "CONFIRMED",
      "paymentStatus": "PARTIAL",
      "deliveryStatus": "DELIVERED",
      "totalCents": 180000,
      "debtCents": 50000,
      "confirmedAt": "2026-08-30T18:42:11.000Z",
      "dueDate": "2026-09-14T18:42:11.000Z",
      "customer": {
        "id": "8a7cbe67-7e82-4d3c-b8d0-5f0e613c1a7a",
        "name": "Ana Reyes"
      },
      "cashier": {
        "id": "bf464f5b-267b-43c5-87c8-2b655bf7ffbc",
        "name": "Caja Principal"
      },
      "seller": null,
      "paymentMethods": ["CASH", "TRANSFER"]
    }
    // ... hasta `limit` filas, ordenadas por `confirmedAt DESC` por defecto
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 23,
    "totalPages": 3
  },
  "counts": {
    "all": 23,
    "pendingPayments": 4,
    "notDelivered": 1
  },
  "summary": {
    "salesCount": 23,
    "totalSoldCents": 1234500,
    "outstandingDebtCents": 78000
  }
}
```

### 2.5 Forma de cada fila (`data[]`)

Heredada del listado general de ventas (ver `docs/sales-frontend.md` §4). Para historial de cliente, los campos útiles son:

| Campo            | Tipo                                                        | Descripción                                                                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | `string` UUID                                               | ID de la venta. **Usar para navegar a `/pos/ventas/:id`** (ruta ya existente, nombre `pos-sale-detail`).                                                                                                                                                |
| `folio`          | `string \| null`                                            | Folio visible al usuario (ej. `A-202608-000042`).                                                                                                                                                                                                       |
| `status`         | `string`                                                    | En la consulta recomendada de historial (sin enviar el filtro `status`) es `CONFIRMED`. Si se envía `status` explícitamente, el listado puede cambiar; ver §3.1.                                                                                        |
| `paymentStatus`  | `'PAID' \| 'PARTIAL' \| 'CREDIT' \| null`                   | Estado de pago. `PAID` = sin deuda, `PARTIAL` = pagó algo, `CREDIT` = no pagó nada.                                                                                                                                                                     |
| `deliveryStatus` | `'PENDING' \| 'SHIPPED' \| 'DELIVERED' \| 'NOT_APPLICABLE'` | Estado de entrega.                                                                                                                                                                                                                                      |
| `totalCents`     | `number`                                                    | Total confirmado en centavos.                                                                                                                                                                                                                           |
| `debtCents`      | `number`                                                    | Deuda pendiente en centavos. **Es la fuente autoritativa para "saldo"**. El backend lo persiste por venta y lo suma en `summary.outstandingDebtCents`; el frontend NO debe recalcularlo a partir de `totalCents − paidCents` ni derivarlo del frontend. |
| `confirmedAt`    | `string` (ISO 8601) \| `null`                               | Cuándo se confirmó la venta. **Es la fecha que se muestra al usuario** ("Compró el…").                                                                                                                                                                  |
| `dueDate`        | `string` (ISO 8601) \| `null`                               | Fecha de vencimiento de la deuda (cuando aplica).                                                                                                                                                                                                       |
| `customer`       | `{ id, name } \| null`                                      | En la consulta recomendada (`customerId` + `customerIncludeNull` omitido) debe corresponder al cliente solicitado. El tipo sigue permitiendo `null` por compatibilidad con el listado general.                                                          |
| `cashier`        | `{ id, name }`                                              | Cajero que cobró.                                                                                                                                                                                                                                       |
| `seller`         | `{ id, name } \| null`                                      | Vendedor asignado, si hay.                                                                                                                                                                                                                              |
| `paymentMethods` | `string[]`                                                  | Métodos de pago usados (ej. `['CASH', 'TRANSFER']`). Útil para badge "Efectivo + Transferencia".                                                                                                                                                        |

> 📐 **Formato**: todos los importes vienen en **centavos** (entero `number`). Para mostrar al usuario, dividir por `100` y formatear con `Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })`. Fechas: parsear con `new Date(...)` y formatear con `Intl.DateTimeFormat('es-MX')` (ej. `30 ago 2026, 18:42`).

### 2.6 Forma del bloque `summary` (NUEVO)

```ts
type SaleListSummary = {
  salesCount: number; // === pagination.total === counts.all
  totalSoldCents: number; // suma de totalCents sobre las ventas confirmadas
  outstandingDebtCents: number; // suma de debtCents sobre las mismas ventas
};
```

**Garantías del backend**:

| Garantía                                                 | Verificación                                                                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `summary.salesCount === pagination.total === counts.all` | Por construcción: una sola query de Prisma (`aggregate`) alimenta los tres.                                                                               |
| Confirmadas únicamente                                   | `status: 'CONFIRMED'` en el WHERE base. Borradores y canceladas excluidas.                                                                                |
| Mismos filtros base que el count existente               | `customerId`, `cashierUserId`, `confirmedFrom/To`, `customerIncludeNull`, `q`.                                                                            |
| Sin filtros extendidos                                   | `paymentStatus`, `totalMin/Max`, `deliveryStatus`, etc. NO afectan `summary` (consistente con `counts.all` y `pagination.total`).                         |
| Cero cuando no hay matches                               | `summary` se devuelve con todos los campos en `0` (NO `null`). Null de Prisma se normaliza a `0` en el adapter.                                           |
| Tenant-safe                                              | `TenantPrismaService` filtra por tenant actual automáticamente. Cliente de otro tenant → `salesCount: 0`, `totalSoldCents: 0`, `outstandingDebtCents: 0`. |

### 2.7 Errores esperables

| HTTP                                 | Código                       | Causa                                                                                                | Acción frontend                                                         |
| ------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `400`                                | `LISTING_INVALID_ENUM_VALUE` | `sortBy` / `sortOrder` / `paymentStatus` / etc. inválido                                             | Mostrar mensaje "Filtro inválido".                                      |
| `400`                                | `LISTING_TOO_MANY_VALUES`    | Más de 200 ids en `customerId`                                                                       | Reducir/agrupar antes de enviar (no debería pasar con un solo cliente). |
| `400`                                | `LISTING_INVERTED_RANGE`     | `confirmedFrom > confirmedTo` o similar                                                              | Validar antes de enviar.                                                |
| `401`                                | —                            | Sin JWT                                                                                              | Redirigir a login.                                                      |
| `403`                                | —                            | Sin `read:Sale`                                                                                      | Ocultar la acción "Ver historial" en toda la UI.                        |
| `200` con `summary.salesCount === 0` | —                            | El cliente no tiene ventas confirmadas (o el `customerId` pertenece a otro tenant). **No es error**. | Mostrar estado vacío.                                                   |

> El cliente que pertenece a otro tenant **no devuelve 403** — devuelve `200` con `data: []` y `summary` en ceros. Esto es por diseño (no se filtra presencia). El frontend puede mostrar el estado vacío normalmente.

---

## 3. Semántica — lo que el equipo de frontend debe entender

### 3.1 Consulta recomendada: solo confirmadas

El historial de "lo que el cliente ha comprado" debe mostrar ventas **cerradas y confirmadas**, estén pagadas, parciales o a crédito. Por eso la consulta de esta feature debe **omitir el filtro `status`**: el backend aplica `CONFIRMED` por defecto. Los borradores son operaciones en curso y las canceladas no forman parte del KPI comercial propuesto.

| Estado      | ¿Incluido en `summary`? | ¿Incluido en `data` sin enviar `status`? |
| ----------- | ----------------------- | ---------------------------------------- |
| `CONFIRMED` | ✅ Sí                   | ✅ Sí                                    |
| `DRAFT`     | ❌ No                   | ❌ No                                    |
| `CANCELED`  | ❌ No                   | ❌ No                                    |

`summary.salesCount`, `pagination.total` y `counts.all` siempre usan el agregado confirmado de filtros base. Si frontend envía `status` explícitamente, `data` puede cambiar mientras esos KPIs permanecen confirmados; por eso esta vista no debe enviarlo. Mostrar canceladas con métricas coherentes sería una extensión futura del contrato.

### 3.2 ¿Qué significa `outstandingDebtCents`?

Es la **suma de `debtCents`** persistido en cada venta confirmada del cliente. Cada venta tiene su propio `debtCents` (campo persistente que se actualiza atómicamente al registrar pagos — ver `sales.service.ts#persistCollectedPayments` y la spec `docs/sales-pos-charge-frontend.md`). El valor de `debtCents` por venta y el `outstandingDebtCents` agregado por el backend son la fuente autoritativa: el frontend debe leer ambos campos del wire y mostrarlos, **sin recalcularlos**.

Por convención de UI: si `outstandingDebtCents > 0`, mostrar en rojo/naranja y un badge "Con saldo pendiente". Si es `0` y `salesCount > 0`, badge "Al corriente" (opcional).

### 3.3 Aislamiento por tenant

Todas las queries pasan por `TenantPrismaService` (CLS-injected). Esto significa:

- Si el usuario A (tenant X) intenta abrir el historial del cliente Y (tenant Z) por cualquier medio (URL compartida, copy-paste, etc.), **el backend devuelve `200` con `summary` en ceros y `data: []`** — nunca `403`, nunca error.
- Esto es **deliberado**: no se filtra la existencia de clientes entre tenants (es un agujero de información).
- Frontend debe tratar el estado vacío como normal en este caso. Si necesitas distinguir "no tiene ventas" vs "no existe", tendrás que combinar con `GET /customers/:id` (que sí devuelve `404` para id de otro tenant).

### 3.4 Reglas de oro para el frontend

- **Nunca recalcular el summary a partir de `data` paginado**: `data` está paginado (ej. 20 filas). Sumar `totalCents` de las filas visibles **subestima** el total. Usa siempre `summary.totalSoldCents` y `summary.outstandingDebtCents` del wire.
- **El summary usa filtros base**. `confirmedFrom` y `confirmedTo` sí lo afectan. Filtros extendidos como `paymentStatus`, `deliveryStatus` o rangos de monto afectan `data`, pero no `summary`. La vista compacta propuesta no debería ofrecer esos filtros. Si en el futuro se necesitan KPIs con filtros extendidos, hay que ampliar el contrato backend; no se deben derivar desde la página visible.
- **`customerIncludeNull` para historial de cliente: omitir o `false`**. Enviar `true` mezclaría ventas anónimas (`Público en General`, con `customerId = null`) en la lista del cliente y haría que `summary.salesCount` exceda el conteo real de ventas del cliente.

```
✅ Correcto (resumen financiero del cliente):
  const total = response.summary.totalSoldCents;
  const saldo = response.summary.outstandingDebtCents;

❌ Incorrecto:
  const total = response.data.reduce((s, r) => s + r.totalCents, 0);
  //   ↑ solo suma la página actual (20 de N ventas)
  const saldo = response.data.reduce((s, r) => s + r.debtCents, 0);
  //   ↑ mismo problema, peor en escenarios de pagos parciales

❌ Incorrecto (mezcla anónimas en historial del cliente):
  GET /sales?customerId=8a7c...&customerIncludeNull=true
  //   ↑ incluye ventas con customerId = null en la lista del cliente
```

> ⚠️ **Regla de oro**: nunca derives totales financieros sumando filas de `data`. Usa siempre `summary`. No recomputes `debtCents` por venta — el valor persistido y el resumen agregado por backend son la fuente autoritativa.

---

## 4. Recomendaciones de UI (NO VINCULANTES — frontend decide)

> Esta sección es **recomendación** basada en los flujos de legacy y capturas adjuntas. El equipo de frontend tiene **autoridad final** sobre el diseño, los componentes, el copy, las animaciones y cualquier detalle visual. Lo único obligatorio es el contrato de la sección §2.

### 4.1 Punto de entrada

Superficies existentes en el frontend del módulo `customers` (bajo `src/features/POS/customers/**`):

- `CustomersView.vue`: tabla/listado con menú de acciones por fila.
- `CustomerCard.vue`: presentación responsive con acciones.
- `CustomerUpsertSlideover.vue`: creación/edición. Actualmente no existe una página dedicada de detalle del cliente.

**Acciones sugeridas** (elige la que mejor encaje con tu UI):

| Ubicación                                   | Acción                    | Comentario                                                           |
| ------------------------------------------- | ------------------------- | -------------------------------------------------------------------- |
| Tabla de clientes — fila / menú de acciones | "Ver historial de ventas" | Acceso rápido desde `CustomersView.vue`.                             |
| `CustomerCard.vue`                          | "Ver historial de ventas" | Mantiene paridad responsive.                                         |
| Futura página de detalle                    | Botón / tab "Historial"   | Solo si frontend decide crear esa superficie; no existe actualmente. |

### 4.2 Pantalla / modal — opciones de layout

Tres patrones que encajan bien (legacy y propuesta); **frontend elige**:

#### Opción A — Slideover lateral (recomendado para desktop)

- Panel deslizante desde la derecha (~480-560 px de ancho).
- Header: foto/nombre del cliente + botón "Cerrar".
- Tres **tarjetas de métrica** en la parte superior:
  - **Ventas confirmadas** — `summary.salesCount` (ej. "23 ventas").
  - **Total vendido** — `formatCurrency(summary.totalSoldCents / 100)` (ej. "$12,345.00 MXN").
  - **Saldo pendiente** — `formatCurrency(summary.outstandingDebtCents / 100)`. Si `> 0`, color de alerta (rojo/naranja) + icono de advertencia.
- Lista paginada debajo de las métricas, scroll infinito o paginación tradicional.
- Footer con botón "Cerrar" + opcional "Ver detalle completo" (link a vista full-page).

#### Opción B — Página completa (recomendado si la lista es densa)

- Ruta dedicada, ej. `/clientes/:id/ventas`.
- Breadcrumb: Clientes › {nombre} › Ventas.
- Mismas tarjetas de métrica en la parte superior.
- Tabla con todas las columnas (folio, fecha, total, deuda, estado pago, estado entrega, cajero, vendedor, métodos de pago).
- Paginación inferior.

#### Opción C — Tab dentro de la tarjeta del cliente

- Si tu UI de detalle de cliente tiene tabs (ej. "Datos", "Direcciones", "Ventas"), agregar tab "Ventas".
- Mismas métricas + lista, pero sin slideover ni ruta adicional.

### 4.3 Componentes y composables sugeridos (Vue, si aplica)

> Esto es solo un boceto. Adapta a la librería real del proyecto (Pinia, Vue Query, Nuxt, etc.).

```ts
// composable sugerido — nombres son recomendaciones, frontend ajusta
// API: src/features/POS/sales/api/sale.api.ts — usa saleApi.listConfirmed y saleApi.getById
import { useQuery } from '@tanstack/vue-query';
import { saleApi } from '@/features/POS/sales/api/sale.api';

export function useCustomerSalesHistory(
  customerId: Ref<string>,
  page: Ref<number>,
) {
  return useQuery({
    queryKey: ['customer-sales-history', customerId, page],
    queryFn: async () => {
      // IMPORTANTE: omitir `customerIncludeNull` (o enviar false). Nunca true
      // aquí — eso mezclaría ventas anónimas en la lista del cliente.
      const response = await saleApi.listConfirmed({
        customerId: [customerId.value],
        page: page.value,
        limit: 20,
        sortBy: 'confirmedAt',
        sortOrder: 'desc',
      });
      // `saleApi.listConfirmed` ya devuelve ConfirmedSalesListResponse,
      // no un AxiosResponse. Retornar el objeto completo conserva
      // `data`, `pagination`, `counts` y el nuevo `summary`.
      return response;
    },
    staleTime: 30_000,
    keepPreviousData: true,
  });
}
```

Antes del composable, extender el tipo existente en `src/features/POS/sales/interfaces/sale.types.ts`:

```ts
export interface SaleListSummary {
  salesCount: number;
  totalSoldCents: number;
  outstandingDebtCents: number;
}

export interface ConfirmedSalesListResponse {
  data: ConfirmedSaleRow[];
  pagination: SalesListPagination;
  counts: SalesListCounts;
  summary: SaleListSummary;
}
```

**Componentes propuestos** (no vinculante):

| Componente                          | Propósito                                                                          | Notas                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `<CustomerSalesHistorySlideover />` | Wrapper con slideover/header/footer.                                               | Compone los sub-componentes.                                           |
| `<SalesHistoryMetrics />`           | Tres tarjetas de métrica (`salesCount`, `totalSoldCents`, `outstandingDebtCents`). | Recibe `summary` por prop. **Lee siempre del wire; nunca recalcules.** |
| `<SalesHistoryTable />`             | Tabla/lista de ventas.                                                             | Recibe `data[]` por prop.                                              |
| `<SalesHistoryEmpty />`             | Estado vacío (no hay ventas o cliente de otro tenant).                             | Mensaje: "Este cliente aún no tiene ventas confirmadas."               |
| `<SalesHistorySkeleton />`          | Loading state con skeletons para métricas + filas.                                 | 3 skeletons arriba + 5 filas.                                          |
| `<SalesHistoryError />`             | Error state (401, 403, 500).                                                       | Mensaje + botón "Reintentar".                                          |

### 4.4 Estados UI

| Estado          | Cuándo                                                                                                                    | Cómo mostrar                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Loading**     | Mientras se hace la query (primer fetch, page change, refresh).                                                           | Skeletons en métricas + 5 filas placeholder. No mostrar spinner inline.                                                      |
| **Empty**       | `summary.salesCount === 0`.                                                                                               | Mensaje centrado: "Este cliente aún no tiene ventas confirmadas." + icono decorativo. **No es error** — es un estado válido. |
| **Error**       | `401` → redirigir a login. `403` → toast "Sin permisos". `500` → "No pudimos cargar el historial. Reintentar." con botón. | Diferenciar 401 (redirige) vs 403 (oculta acción) vs 500 (botón reintentar).                                                 |
| **Data**        | Hay ventas.                                                                                                               | Métricas + lista. Si `outstandingDebtCents > 0`, la métrica se ve en color de alerta.                                        |
| **Sin permiso** | Usuario sin `read:Sale`.                                                                                                  | **Ocultar la acción "Ver historial"** completamente (no mostrar slideover vacío).                                            |

### 4.5 Formato de importes y fechas

- **Importes** (centavos → MXN): `Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(cents / 100)`. Ej. `1234500` → `"$12,345.00"`.
- **Fechas**: parsear `confirmedAt` con `new Date(iso)` y formatear con `Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' })`. Ej. `"2026-08-30T18:42:11.000Z"` → `"30 ago 2026, 18:42"`. Si solo quieres fecha (sin hora): `dateStyle: 'medium'`.
- **Deuda**: mismo formato que importes. Si `outstandingDebtCents === 0`, NO mostrar la cifra en ceros (UX: omitir o badge "Al corriente").

### 4.6 Navegación al detalle

Cuando el usuario hace click en una fila, navegar al detalle de venta existente:

```ts
// Vue Router ejemplo — ruta existente: /pos/ventas/:id (nombre 'pos-sale-detail')
import { saleApi } from '@/features/POS/sales/api/sale.api';

router.push({ name: 'pos-sale-detail', params: { id: row.id } });

// Cargar detalle vía API:
const detail = await saleApi.getById(row.id);
```

La ruta **`/pos/ventas/:id`** (nombre `pos-sale-detail`) ya existe (se reutiliza — `GET /sales/:id` con permiso `read:Sale`). Backend no requiere cambios. El archivo del composable / store de detalle vive bajo `src/features/POS/sales/**`.

### 4.7 Evidencia legacy (referencias visuales)

Las siguientes capturas son referencias del producto legacy — la pantalla nueva puede diferir visualmente, pero sirven como punto de partida para entender el flujo:

- `/home/aldrich_coder45/Pictures/Screenshots/Screenshot_2026-08-31-16-56-43_4520x2520.png` — vista legacy completa del detalle de cliente: métricas **Ventas**, **Total Vendido** y **Deuda Pendiente**, bloque de últimas ventas y bloque de últimos cobros.
- `/home/aldrich_coder45/Pictures/Screenshots/Screenshot_2026-08-31-16-58-26_4520x2520.png` — vista legacy completa del detalle de una venta individual, alcanzada haciendo click sobre una venta de la pantalla anterior. Muestra productos, totales, estado y el historial de eventos, incluido el cobro.

> Estas capturas son referencias visuales del producto legacy (no son mockups del slideover nuevo ni del estado vacío). La implementación nueva es libre de divergir visualmente. Las rutas son absolutas y locales a esta máquina; al compartir el documento fuera de este entorno, adjuntar también las dos imágenes.

---

## 5. Cache, query keys y reactividad

### 5.1 Query keys recomendadas

| Recurso                           | Query key                                                                    | Notas                                                          |
| --------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Historial de un cliente, página N | `['customer-sales-history', customerId, { page, limit, sortBy, sortOrder }]` | Incluir todos los params que cambien el resultado.             |
| Detalle de una venta              | `['sale-detail', saleId]`                                                    | Reutilizar el cache existente del detalle (`saleApi.getById`). |

### 5.2 Invalidación

Invalidar la query de historial cuando:

- El usuario cierra el slideover y vuelve a abrirlo con el mismo cliente → **NO invalidar** (`staleTime: 30s` es suficiente; opcional `keepPreviousData: true`).
- El usuario registra un pago nuevo desde la página del cliente (futuro) → invalidar `['customer-sales-history', customerId]`.
- El usuario cancela una venta desde `/pos/ventas/:id` → invalidar ambas (`['customer-sales-history', ...]` y `['sale-detail', id]`).

### 5.3 Concurrencia

Si tu UI permite abrir varios slideovers en paralelo (ej. el usuario navega entre clientes rápidamente), cada uno mantiene su propia query. No compartir cache entre clientes.

---

## 6. Permisos y RBAC

| Acción frontend                            | Permiso requerido | Comportamiento si falta                                                                                           |
| ------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| Ver botón "Ver historial"                  | `read:Sale`       | **Ocultar la acción** (no mostrar el botón ni la ruta).                                                           |
| Llamar `GET /sales` con `customerId`       | `read:Sale`       | Backend devuelve `403` → mostrar toast "Sin permisos" y loguear.                                                  |
| Navegar a `/pos/ventas/:id` desde una fila | `read:Sale`       | Mismo permiso. Si falta, la navegación igual abre el detalle y el backend responde `403` (comportamiento actual). |

**Para roles sin `read:Sale`**: el módulo completo de ventas queda invisible. Esto ya funciona en el frontend actual — no requiere cambios especiales, solo respeta la convención existente.

---

## 7. Accesibilidad (a11y)

> Recomendación — el equipo frontend puede ajustar según su librería y design system.

- **Slideover**: debe tener `role="dialog"`, `aria-modal="true"`, `aria-labelledby` apuntando al header con el nombre del cliente. Foco atrapado dentro mientras esté abierto. Cerrar con `Esc` y con click fuera (configurable).
- **Tabla de ventas**: cada fila es un link/botón accesible (no usar `<div onClick>`). `aria-label` descriptivo: `"Venta folio A-202608-000042 del 30 ago 2026 por $1,800.00 con saldo de $500.00"`.
- **Métricas**: cada tarjeta con `<dt>` (label) + `<dd>` (valor). Si `outstandingDebtCents > 0`, agregar `aria-live="polite"` y tono de alerta.
- **Loading**: skeletons con `aria-busy="true"` en el contenedor.
- **Estado vacío**: imagen con `alt=""` (decorativa) + texto real en `<p>` con `role="status"`.
- **Errores**: `<div role="alert">` para que lectores de pantalla anuncien el mensaje.

---

## 8. Edge cases (cubiertos por el backend, documentados para el frontend)

| Caso                                              | Comportamiento backend                                                                                                                          | Cómo mostrarlo en UI                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cliente sin ventas confirmadas                    | `summary: { salesCount: 0, totalSoldCents: 0, outstandingDebtCents: 0 }`, `data: []`                                                            | Estado vacío (no error).                                                                                                                                                                                                                                                                        |
| Cliente de otro tenant                            | Idem: `summary` en ceros, `data: []`                                                                                                            | Estado vacío. **No** error. (No se filtra presencia.)                                                                                                                                                                                                                                           |
| 200 ventas pero todas pagadas                     | `summary.outstandingDebtCents === 0`                                                                                                            | Mostrar métrica con texto "Al corriente" o similar (UX decide).                                                                                                                                                                                                                                 |
| 1 venta `PARTIAL` con `debtCents: 50_000`         | `summary.outstandingDebtCents: 50_000`                                                                                                          | Métrica en color de alerta.                                                                                                                                                                                                                                                                     |
| Filtros extendidos activos (`paymentStatus=PAID`) | **No afectan** `summary` — sigue sumando todas las confirmadas.                                                                                 | UX: si filtraste por "Pagadas", la métrica global sigue siendo del total sin filtros extendidos. **No recalcular** desde `data` (ver §3.4). Si en el futuro la UI requiere KPIs filtrados, eso requiere extender el contrato backend (`summary` con filtros extendidos) — fuera de alcance hoy. |
| Paginación cerca del límite (200 ids máx)         | `LISTING_TOO_MANY_VALUES` (400)                                                                                                                 | No debería ocurrir (solo se pasa un `customerId`).                                                                                                                                                                                                                                              |
| Venta con `dueDate` vencida                       | Está en `data` y suma a `outstandingDebtCents` si tiene deuda.                                                                                  | Opcional: badge "Vencida" si `new Date(dueDate) < new Date()`.                                                                                                                                                                                                                                  |
| Venta creada por bot (ONLINE channel)             | Aparece normalmente en la consulta recomendada si está confirmada y asignada al cliente.                                                        | Sin acción — comportamiento correcto.                                                                                                                                                                                                                                                           |
| Se envía `status=CANCELED` explícitamente         | `data` puede devolver ventas canceladas porque `status` es un filtro extendido, pero `summary` continúa agregando confirmadas con filtros base. | No enviar `status` desde esta vista. Si se necesita historial de canceladas y KPIs coherentes, ampliar el contrato backend en una feature futura.                                                                                                                                               |
| `customerIncludeNull=true` enviado por error      | El backend incluye ventas anónimas en `data` y las cuenta en `summary`.                                                                         | **Nunca enviar `true` para historial de cliente** (ver §3.4).                                                                                                                                                                                                                                   |

---

## 9. Testing — sugerencias para el equipo frontend

> Recomendación no vinculante.

### 9.1 Tests unitarios / componentes

- `<SalesHistoryMetrics />`: render correcto con `salesCount > 0`, con `outstandingDebtCents === 0`, con `outstandingDebtCents > 0` (color de alerta), y formato MXN correcto.
- `<SalesHistoryTable />`: renderiza filas, formato de fechas, formato de importes, navegación al detalle al click, badge de estado de pago.
- `<CustomerSalesHistorySlideover />`: cierra con `Esc`, cierra con click fuera, foco atrapado, `aria-modal` correcto.

### 9.2 Tests de integración (API mockeada)

- Caso happy path: cliente con 23 ventas confirmadas → métricas correctas, paginación correcta, formato correcto.
- Cliente sin ventas → empty state.
- Cliente de otro tenant → empty state (no error).
- `customerIncludeNull` omitido (default `false`) → solo ventas del cliente en `data` y `summary`.
- Error `403` → toast "Sin permisos", no rompe UI.
- Error `500` → botón "Reintentar" funciona.
- Cambio de página → URL/pagination state actualizado, query refetched.

### 9.3 Tests E2E (Cypress / Playwright)

- Login → ir a clientes → click "Ver historial" en un cliente con ventas → slideover abre con métricas correctas → click en una fila → URL cambia a `/pos/ventas/:id` → detalle carga.
- Mismo flujo pero con cliente sin ventas → empty state.
- Mismo flujo pero con un usuario sin `read:Sale` → botón no aparece en ningún lado.

---

## 10. Criterios de aceptación (definición de "listo")

### 10.1 Backend (completado localmente, pendiente de commit/deploy)

- [x] `GET /sales` con `customerId` devuelve el bloque `summary` con `salesCount`, `totalSoldCents`, `outstandingDebtCents`.
- [x] `summary.salesCount === pagination.total === counts.all` (verificado por tests).
- [x] Una sola query de Prisma (`aggregate`) reemplaza al `count()` previo — no se añadió 5ª query.
- [x] Null de Prisma normalizado a `0` cuando no hay matches.
- [x] Tenant-safe: cliente de otro tenant devuelve `summary` en ceros, no `403`.
- [x] Tests RED/GREEN ejecutados y pasando (`sales.service.spec.ts`, `prisma-sale.repository.spec.ts`).
- [ ] **Pendiente**: commit y deploy (estado actual: implementado localmente, sin commit).

### 10.2 Frontend (a verificar cuando se implemente)

- [ ] Existe al menos un punto de entrada para abrir el historial por cliente (slideover, tab o página).
- [ ] Las tres métricas se muestran formateadas en MXN.
- [ ] La lista muestra filas con folio, fecha, total, deuda, estado de pago, estado de entrega, cajero.
- [ ] Click en fila navega a `/pos/ventas/:id` (nombre `pos-sale-detail`) y carga el detalle vía `saleApi.getById`.
- [ ] Estados loading / empty / error diferenciados correctamente.
- [ ] Permiso `read:Sale` se respeta (botón oculto sin permiso).
- [ ] El usuario **nunca** ve totales derivados de sumar filas de `data` — siempre de `summary`.
- [ ] El frontend **nunca** envía `customerIncludeNull=true` para historial de un cliente específico.
- [ ] Accesibilidad básica (roles ARIA, foco atrapado en slideover, navegación por teclado).
- [ ] Cache invalidado correctamente cuando aplica.

---

## 11. Non-goals (fuera de alcance)

Para evitar scope creep:

- ❌ **Editar o cancelar ventas desde el historial.** Ya hay pantalla `/pos/ventas/:id` para eso. El historial es solo lectura.
- ❌ **Re-implementar el listado completo de ventas.** Ya existe `docs/sales-frontend.md` §4. El slideover/página solo necesita los campos de la §2.5.
- ❌ **Cancelar/eliminar cliente desde aquí.** Ya está en `docs/customers-frontend.md` §3.
- ❌ **Exportar a Excel/CSV.** No es parte del alcance. Si lo piden, futuro.
- ❌ **Gráficas / dashboards.** Si las piden, futuro.
- ❌ **Filtros extendidos dentro del slideover** (estado de pago, entrega, monto, etc.). Si lo piden, futuro. Hoy, el slideover muestra el historial completo del cliente (paginable). Los filtros base de fecha (`confirmedFrom`/`confirmedTo`) sí afectan `summary`, aunque tampoco son necesarios para esta primera versión.
- ❌ **KPIs con filtros extendidos**. Si se piden en el futuro, requieren extender el contrato backend (`summary` con los mismos filtros o un endpoint dedicado). No se pueden derivar correctamente en el frontend desde filas paginadas.
- ❌ **Notificaciones push cuando hay deuda vencida.** Futuro.

---

## 12. Checklist de implementación frontend

> Recomendación — frontend ajusta según su flujo de trabajo.

### Preparación

- [ ] Revisar `docs/sales-frontend.md` (contrato general de ventas) y `docs/customers-frontend.md` (entidad Customer).
- [ ] Identificar el componente `<Customer* />` existente donde se va a integrar.
- [ ] Verificar que el stack tiene `saleApi.listConfirmed` y `saleApi.getById` listos en `src/features/POS/sales/api/sale.api.ts` (según contexto del proyecto).
- [ ] Confirmar que el design system tiene componentes de slideover / tabla / métricas (o reutilizar los del módulo de clientes bajo `src/features/POS/customers/**`).

### Implementación

- [ ] Extender `ConfirmedSalesListResponse` con `summary: SaleListSummary` en `src/features/POS/sales/interfaces/sale.types.ts`.
- [ ] Crear composable `useCustomerSalesHistory(customerId, page)` con query key `['customer-sales-history', customerId, params]`. Retornar la respuesta completa de `saleApi.listConfirmed`; **no desestructurar solo `data` y no enviar `customerIncludeNull`**.
- [ ] Crear componente `<CustomerSalesHistorySlideover />` (o equivalente).
- [ ] Crear `<SalesHistoryMetrics />` que renderiza las 3 tarjetas leyendo `summary` del backend (sin recalcular).
- [ ] Crear `<SalesHistoryTable />` que itera `data[]` y formatea cada fila.
- [ ] Crear `<SalesHistoryEmpty />` y `<SalesHistorySkeleton />` y `<SalesHistoryError />`.
- [ ] Cablear la acción "Ver historial" en `CustomersView.vue` y `CustomerCard.vue`, respetando `read:Sale`.
- [ ] Verificar que la navegación al detalle (`/pos/ventas/:id`, nombre `pos-sale-detail`) funciona desde cada fila vía `saleApi.getById`.
- [ ] Verificar formato MXN y formato de fecha con `Intl.*`.

### Verificación

- [ ] Probar con cliente con ventas (métricas correctas, lista correcta).
- [ ] Probar con cliente sin ventas (empty state, no error).
- [ ] Probar con usuario sin `read:Sale` (botón oculto en toda la UI).
- [ ] Probar paginación (page=2, page=3 — totales de `summary` no cambian, sí cambia la lista).
- [ ] Probar caché: cerrar y reabrir el slideover rápidamente — datos consistentes.
- [ ] Probar en mobile (si aplica): slideover se comporta como bottom-sheet o full-screen.

### Limpieza

- [ ] Remover cualquier TODO / código de prueba.
- [ ] Actualizar CHANGELOG / release notes del frontend mencionando la nueva vista.
- [ ] Coordinar con backend para validar el flujo end-to-end en staging.

---

## 13. Anexo — cambio backend resumido (para que el equipo frontend tenga contexto)

> Esta sección NO requiere acción del frontend — solo documenta qué cambió del lado backend para que entiendan el bloque `summary`.

### 13.1 Archivos modificados

| Archivo                                                   | Cambio                                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sales/domain/sale.repository.ts`                     | Nuevo método en el port: `aggregateSummaryConfirmed(input)`.                                                                                                                    |
| `src/sales/infrastructure/prisma-sale.repository.ts`      | Implementación: una sola query `prisma.sale.aggregate` con `_count._all`, `_sum.totalCents`, `_sum.debtCents`. Normaliza `null` a `0`.                                          |
| `src/sales/sales.service.ts`                              | `listSales` reemplaza la llamada a `countConfirmed` por `aggregateSummaryConfirmed` en el `Promise.all` (mismo número de queries paralelas). Devuelve `summary` en el response. |
| `src/sales/dto/sale-list-response.dto.ts`                 | Adiciona `summary: { salesCount, totalSoldCents, outstandingDebtCents }` al `SaleListResponseDto`.                                                                              |
| `src/sales/sales.service.spec.ts`                         | Tests nuevos para `summary` (filtro por cliente, suma no cero, normalización a cero en empty).                                                                                  |
| `src/sales/infrastructure/prisma-sale.repository.spec.ts` | Tests nuevos para `aggregateSummaryConfirmed` (contrato, null→0, customerId propagation, filtros base).                                                                         |

### 13.2 Garantías

- **Sin schema migration**: no se modificó `prisma/schema.prisma`. Solo se reusaron las columnas existentes (`totalCents`, `debtCents`).
- **Sin nueva query**: el `countConfirmed` existente fue **reemplazado** por `aggregateSummaryConfirmed`. Sigue habiendo 4 queries paralelas en `listSales`.
- **Sin breaking change**: `data`, `pagination`, `counts` mantienen exactamente la misma forma. `summary` es puramente aditivo.
- **Retro-compatible con frontend que ignora `summary`**: cualquier frontend que hoy consume `GET /sales` y no lee `summary` seguirá funcionando igual.

---

## 14. Referencias cruzadas

- Contrato general de ventas: `docs/sales-frontend.md` (módulo POS /sales base).
- Contrato del cargo (charge, payment, dueDate): `docs/sales-pos-charge-frontend.md`.
- Entidad cliente (cómo se carga el `customerId`): `docs/customers-frontend.md` §3.
- API de ventas (cliente HTTP): `src/features/POS/sales/api/sale.api.ts` (`saleApi.listConfirmed`, `saleApi.getById`).
- Módulo de clientes (componentes, layouts): `src/features/POS/customers/**`.
- Permisos RBAC: `docs/RBAC.md` (buscar `read:Sale` y `manage:Sale`).
- Aislación de tenant y multi-tenancy: `docs/multi-tenant-api.md`.

---

## 15. Próximo paso

Cuando el equipo de frontend abra el ticket de implementación:

1. Crear rama desde `main` (frontend).
2. Reusar `saleApi.listConfirmed` y `saleApi.getById` (ya existen en `src/features/POS/sales/api/sale.api.ts` según el contexto del proyecto — verificar nombres reales allí).
3. Implementar los componentes de la §4 y la checklist de la §12.
4. **No enviar `customerIncludeNull` para historial de cliente** (omitir o `false`). Usar siempre `summary` del backend como fuente autoritativa de métricas.
5. Probar contra `staging.houndfe.com` (o el ambiente que usen).
6. Hacer PR referenciando este documento (`docs/customer-sales-history-frontend.md`).

**Contacto backend**: si surge cualquier duda sobre el bloque `summary`, abrir issue en el repo `houndfe-backend` referenciando este doc y la sección correspondiente (ej. "§2.6 — ¿`summary` incluye ventas del bot?"). Para issues de diseño UI o copy, decisión es 100% frontend.
