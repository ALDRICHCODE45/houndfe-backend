# Analítica de Ventas por Sucursal — Guía Frontend

> Handoff backend → frontend para el resumen analítico de una sucursal y su serie diaria.
>
> **Fuente de verdad**: las secciones de contrato y semántica contable son obligatorias. La propuesta de UI, nombres de componentes y estrategia de cache son recomendaciones adaptables al frontend.
>
> **Estado del backend — leer antes de integrar**:
>
> - `GET /analytics/sales/summary` — contrato existente y desplegado. Es la autoridad para las líneas del período (ventas, cobrado, deuda, reembolsos liquidados y obligaciones pendientes). Ver secciones 1 a 13.
> - `GET /analytics/sales/timeseries` — existe **solo** en la rama local `feat/branch-sales-timeseries`, commit `08c9822e…`. **No está mergeado, publicado ni desplegado.** El frontend debe confirmar la entrega de esa rama antes de usarlo contra un ambiente remoto. Ver sección 14.

## 1. Resultado esperado

Para el resumen del período, el frontend consulta un único endpoint y muestra ocho métricas agregadas de la sucursal autenticada:

- Ventas brutas.
- Ventas netas.
- Monto cobrado.
- Deuda pendiente.
- Cantidad de ventas.
- Ticket promedio.
- Reembolsos liquidados.
- Obligaciones de reembolso pendientes.

El backend resuelve el tenant desde el JWT. El frontend **no envía un `tenantId` ni un `branchId`**.

## 2. Quick path

1. Habilitar la pantalla únicamente para usuarios con `read:Analytics`.
2. Pedir un rango de fechas locales `from`/`to` en formato `YYYY-MM-DD`.
3. Consultar `GET /analytics/sales/summary`.
4. Mostrar los importes recibidos; no recalcularlos desde ventas o pagos.
5. Tratar ventas, reembolsos liquidados y obligaciones pendientes como líneas separadas.

Ejemplo:

```http
GET /analytics/sales/summary?from=2026-09-01&to=2026-10-01
Authorization: Bearer <jwt>
```

El rango anterior incluye desde el inicio local del 1 de septiembre hasta, pero sin incluir, el inicio local del 1 de octubre.

## 3. Contrato HTTP obligatorio

### 3.1 Endpoint

| Propiedad         | Valor                      |
| ----------------- | -------------------------- |
| Método            | `GET`                      |
| Path              | `/analytics/sales/summary` |
| Respuesta exitosa | `200 OK`                   |
| Autenticación     | JWT Bearer                 |
| Tenant            | Derivado del JWT           |
| Permiso exacto    | `read:Analytics`           |

La cadena de seguridad backend es:

1. `JwtAuthGuard`
2. `TenantContextGuard`
3. `PermissionsGuard`

`read:Analytics` **no se asigna automáticamente** a Manager ni Cashier. El rol debe recibirlo explícitamente; un superadministrador con `manage:all` también puede acceder.

### 3.2 Query params

| Param  | Tipo     | Obligatorio | Regla                                             |
| ------ | -------- | ----------- | ------------------------------------------------- |
| `from` | `string` | Sí          | Fecha local real y exacta `YYYY-MM-DD`; inclusiva |
| `to`   | `string` | Sí          | Fecha local real y exacta `YYYY-MM-DD`; exclusiva |

Reglas adicionales:

- Zona horaria fija: `America/Mexico_City`.
- El rango es semiabierto: `[from, to)`.
- `to` debe ser estrictamente posterior a `from`.
- La distancia máxima es de 366 días calendario.
- Se rechazan fechas imposibles, timestamps, año `0000`, rangos iguales o invertidos y parámetros desconocidos.
- No se aceptan parámetros de tenant, sucursal, usuario, moneda ni método de pago.

### 3.3 No convertir los límites con `Date`

`from` y `to` representan **fechas calendario locales**, no instantes UTC.

```ts
// Correcto: conservar el valor del input como string.
const query = {
  from: '2026-09-01',
  to: '2026-10-01',
};

// Incorrecto: puede desplazar el día por la zona horaria.
const from = new Date('2026-09-01');
```

Para presets como “hoy”, “esta semana” o “este mes”, calcular los días calendario en `America/Mexico_City`. No usar ciegamente la zona horaria del navegador si el usuario está en otra región.

## 4. Respuesta `200 OK`

### 4.1 Tipo TypeScript

```ts
export interface BranchSalesSummary {
  timeZone: 'America/Mexico_City';
  from: string;
  to: string;
  grossSalesCents: number;
  netSalesCents: number;
  collectedCents: number;
  outstandingDebtCents: number;
  saleCount: number;
  averageTicketCents: number;
  settledRefundsCents: number;
  pendingRefundObligationsCents: number;
}

export interface BranchSalesSummaryQuery {
  from: string;
  to: string;
}
```

### 4.2 Ejemplo

```json
{
  "timeZone": "America/Mexico_City",
  "from": "2026-09-01",
  "to": "2026-10-01",
  "grossSalesCents": 125000,
  "netSalesCents": 110000,
  "collectedCents": 80000,
  "outstandingDebtCents": 30000,
  "saleCount": 4,
  "averageTicketCents": 27500,
  "settledRefundsCents": 5000,
  "pendingRefundObligationsCents": 2500
}
```

Todos los importes son enteros expresados en centavos. La respuesta no incluye una moneda, así que el frontend necesita recibirla desde una fuente externa definida por el producto. Si esa fuente todavía no existe, resolver esa decisión antes de mostrar un símbolo monetario. No inferir `MXN` únicamente desde `America/Mexico_City`.

### 4.3 Significado de cada campo

| Campo                           | Semántica autoritativa                                                         |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `timeZone`                      | Zona usada para convertir los días calendario en límites de consulta           |
| `from`                          | Límite local inclusivo solicitado                                              |
| `to`                            | Límite local exclusivo solicitado                                              |
| `grossSalesCents`               | Suma de `subtotalCents` de ventas confirmadas; antes de descuentos             |
| `netSalesCents`                 | Suma de `totalCents` de ventas confirmadas; después de descuentos              |
| `collectedCents`                | Suma del `paidCents` autoritativo de las ventas confirmadas del rango          |
| `outstandingDebtCents`          | Suma del `debtCents` autoritativo de las ventas confirmadas del rango          |
| `saleCount`                     | Cantidad de ventas confirmadas del rango                                       |
| `averageTicketCents`            | `netSalesCents / saleCount`, redondeado al centavo más cercano; `0` sin ventas |
| `settledRefundsCents`           | Salida real del ledger de reembolsos liquidada dentro del rango                |
| `pendingRefundObligationsCents` | Saldo positivo aún adeudado de reembolsos creados dentro del rango             |

## 5. Semántica temporal y contable

Las métricas no representan todas el mismo tipo de medida. El frontend debe conservar esta distinción.

| Grupo                   | Selección temporal                                                                             | Qué representa                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Ventas                  | Venta `CONFIRMED` cuyo `confirmedAt` cae en `[from,to)`                                        | Cohorte de ventas confirmadas dentro del rango                        |
| Cobrado y deuda         | Estado actual `paidCents`/`debtCents` de esa cohorte                                           | Situación actual de las ventas del rango, no flujo de pagos por fecha |
| Reembolsos liquidados   | Settlement cuyo `settledAt` cae en `[from,to)`                                                 | Flujo real de dinero devuelto durante el rango                        |
| Obligaciones pendientes | Reembolso cuyo `createdAt` cae en `[from,to)` menos settlements históricos del mismo reembolso | Stock pendiente actual para obligaciones creadas en el rango          |

Consecuencias importantes:

- Solo las ventas `CONFIRMED` participan en las métricas de ventas.
- `collectedCents` **no** es “pagos recibidos durante el rango”. Es el monto actualmente pagado de las ventas confirmadas dentro del rango.
- `outstandingDebtCents` puede disminuir después si esas ventas reciben pagos posteriores.
- `pendingRefundObligationsCents` puede disminuir después, incluso si la liquidación ocurre fuera del rango consultado, porque utiliza el ledger completo del reembolso.
- `settledRefundsCents` sí es un flujo por fecha de liquidación.
- El backend no suma `SalePayment.amountCents`: un pago en efectivo puede guardar el monto entregado por el cliente, incluido el cambio.

### 5.1 Líneas que no deben mezclarse

El contrato no entrega un “neto de caja” y el frontend no debe inventarlo.

```ts
// Incorrecto: mezcla métricas con semánticas temporales diferentes.
const cashNet = summary.collectedCents - summary.settledRefundsCents;
```

También quedan fuera del contrato:

- Mix por método de pago.
- Flujo de cobros por fecha del pago.
- IVA/impuestos desglosados.
- Moneda en el payload.
- Comparación con un período anterior.
- Agrupación semanal o mensual.
- Selección de múltiples sucursales.

El desglose **diario** de ventas no forma parte de este resumen: vive en su propio endpoint y contrato (sección 14), separado para no mezclar la cohorte del período con la serie por día.

Si el producto necesita alguno de esos datos, debe ampliarse el contrato backend; no derivarlos desde esta respuesta.

## 6. Integración sugerida con TanStack Vue Query

Adaptar el cliente HTTP y el helper de permisos a las convenciones reales del frontend.

```ts
import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';

export function useBranchSalesSummary(from: Ref<string>, to: Ref<string>) {
  const enabled = computed(
    () =>
      /^\d{4}-\d{2}-\d{2}$/.test(from.value) &&
      /^\d{4}-\d{2}-\d{2}$/.test(to.value) &&
      from.value < to.value,
  );

  return useQuery({
    queryKey: computed(() => [
      'analytics',
      'sales-summary',
      { from: from.value, to: to.value },
    ]),
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<BranchSalesSummary> => {
      return api.get('/analytics/sales/summary', {
        params: { from: from.value, to: to.value },
      });
    },
  });
}
```

> El ejemplo presupone que `api.get()` devuelve el body. Si el cliente devuelve `AxiosResponse`, retornar `response.data`.

La validación frontend mejora la experiencia, pero el backend sigue siendo la autoridad para fechas reales y el límite de 366 días.

### 6.1 Query key e invalidación

La query key debe incluir ambos límites. Invalidar o refrescar el resumen cuando ocurra alguna mutación que pueda cambiarlo:

- Confirmación de una venta.
- Registro de un cobro sobre una venta.
- Creación de un reembolso.
- Liquidación parcial o total de un reembolso.

No hace falta invalidar por cambios puramente visuales o navegación.

## 7. Permisos y navegación

| Situación                    | Comportamiento frontend                                                           |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Usuario con `read:Analytics` | Mostrar ruta, navegación y contenido analítico                                    |
| Usuario sin `read:Analytics` | Ocultar punto de entrada; si llega por URL y recibe `403`, mostrar “Sin permisos” |
| JWT ausente o expirado       | Manejar `401` con el flujo global de reautenticación/login                        |
| Rol recién actualizado       | Refrescar sesión/permisos antes de volver a evaluar la navegación                 |

El ocultamiento frontend es UX, no seguridad. El backend siempre vuelve a verificar el permiso.

## 8. Errores y estados de UI

### 8.1 Errores HTTP

| HTTP  | Causa típica                                                                                      | Acción sugerida                                               |
| ----- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `400` | Fechas faltantes, inválidas, iguales/invertidas, rango mayor a 366 días o query param desconocido | Marcar el formulario y conservar el rango anterior válido     |
| `401` | JWT ausente o inválido                                                                            | Delegar al flujo global de sesión                             |
| `403` | Falta `read:Analytics`                                                                            | Ocultar acceso y mostrar mensaje de permisos si llegó por URL |
| `500` | Fallo inesperado de agregación                                                                    | Estado de error con botón “Reintentar”                        |

No acoplar el frontend a una forma específica del body de error para este endpoint. Usar el normalizador global de errores HTTP del proyecto.

### 8.2 Estados visuales

| Estado          | Condición                             | Presentación sugerida                         |
| --------------- | ------------------------------------- | --------------------------------------------- |
| Loading inicial | Primera consulta                      | Skeleton de filtros y tarjetas                |
| Refetch         | Cambio de rango con datos previos     | Mantener datos previos con indicador discreto |
| Data            | Al menos una métrica distinta de cero | Tarjetas agrupadas en “Ventas” y “Reembolsos” |
| Empty           | Todas las métricas numéricas son cero | “No hubo actividad para este rango”           |
| Error           | Query fallida                         | Mensaje contextual y acción de reintento      |

No usar solamente `saleCount === 0` para decidir el estado vacío: puede haber reembolsos liquidados u obligaciones pendientes aunque no existan ventas confirmadas dentro del mismo rango.

Helper sugerido:

```ts
export function isBranchSalesSummaryEmpty(
  summary: BranchSalesSummary,
): boolean {
  return (
    summary.saleCount === 0 &&
    summary.grossSalesCents === 0 &&
    summary.netSalesCents === 0 &&
    summary.collectedCents === 0 &&
    summary.outstandingDebtCents === 0 &&
    summary.averageTicketCents === 0 &&
    summary.settledRefundsCents === 0 &&
    summary.pendingRefundObligationsCents === 0
  );
}
```

## 9. Layout recomendado

### 9.1 Filtros

- Selector `from`.
- Selector `to`, visualmente aclarado como fecha final exclusiva o presentado al usuario como un rango inclusivo que internamente suma un día al límite final.
- Presets opcionales: Hoy, Últimos 7 días, Este mes, Mes anterior.
- Texto de contexto: `Zona horaria: America/Mexico_City`.

Si la UI presenta ambos días como inclusivos, convertir el último día seleccionado al `to` exclusivo antes de llamar al backend. Mantener esa conversión en un único helper testeado.

### 9.2 Tarjetas de ventas

- Ventas netas como métrica principal.
- Ventas brutas.
- Cobrado.
- Deuda pendiente.
- Cantidad de ventas.
- Ticket promedio.

### 9.3 Tarjetas de reembolsos

- Reembolsos liquidados.
- Obligaciones pendientes.

No fusionar las tarjetas de ventas y reembolsos en un único total financiero.

### 9.4 Formato monetario

```ts
export function formatCents(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
  }).format(cents / 100);
}
```

Pasar al formatter una moneda obtenida desde la fuente que el producto defina fuera de este payload. No mostrar el entero crudo, no inferir la moneda desde la zona horaria y no aplicar redondeos adicionales.

## 10. Casos importantes

| Caso                                         | Resultado esperado                                           |
| -------------------------------------------- | ------------------------------------------------------------ |
| Rango válido sin actividad                   | `200` con todas las métricas en `0`                          |
| Rango de exactamente 366 días                | Aceptado                                                     |
| Rango de 367 días                            | `400`                                                        |
| `from === to`                                | `400`                                                        |
| `to < from`                                  | `400`                                                        |
| `2026-02-29`                                 | `400` porque no es una fecha real                            |
| Año `0000`                                   | `400`                                                        |
| Se envía un timestamp ISO                    | `400`; solo se acepta `YYYY-MM-DD`                           |
| Query param extra                            | `400`                                                        |
| Sin permiso                                  | `403`                                                        |
| Otro tenant                                  | No puede seleccionarse: el tenant proviene del JWT           |
| Sin ventas, pero con settlements en el rango | Renderizar la sección de reembolsos; no mostrar empty global |

## 11. Testing frontend recomendado

### 11.1 API/composable

- Construye la URL con `from` y `to` sin convertirlos a `Date`.
- Query key cambia cuando cambia cualquiera de los límites.
- No ejecuta la query con campos vacíos o con `to <= from`.
- Conserva los 11 campos de la respuesta.
- Maneja `400`, `401`, `403` y `500` mediante los flujos del proyecto.

### 11.2 Componentes

- Render de las ocho métricas.
- Conversión correcta de centavos con una moneda suministrada externamente al payload.
- Empty global solo cuando todas las métricas son cero.
- `saleCount === 0` con `settledRefundsCents > 0` no activa empty global.
- Deuda y obligaciones pendientes usan tratamiento visual de atención sin depender solo del color.
- Loading, refetch y error son distinguibles.
- La pantalla/ruta no aparece sin `read:Analytics`.

### 11.3 E2E

- Usuario sin autenticar → `401`/flujo de login.
- Usuario autenticado sin permiso → acceso oculto y backend `403` si fuerza la URL.
- Usuario con `read:Analytics` → cambia rango y ve los valores del wire.
- Rango inválido → feedback de formulario y backend `400` si se fuerza la request.
- Liquidar un reembolso → invalidar/refrescar y observar el cambio en las líneas correspondientes.

## 12. Checklist de implementación

- [ ] Definir `BranchSalesSummary` y `BranchSalesSummaryQuery`.
- [ ] Crear el método API para `GET /analytics/sales/summary`.
- [ ] Mantener `from` y `to` como strings `YYYY-MM-DD`.
- [ ] Crear query key con ambos límites.
- [ ] Implementar formulario/presets respetando `[from,to)` y `America/Mexico_City`.
- [ ] Proteger navegación y ruta con `read:Analytics`.
- [ ] Renderizar las ocho métricas sin recalcularlas.
- [ ] Separar visualmente ventas, deuda y reembolsos.
- [ ] Resolver la moneda desde una fuente externa definida por el producto.
- [ ] Implementar loading, refetch, empty, error y sin-permiso.
- [ ] Invalidar el resumen después de ventas, cobros y reembolsos relevantes.
- [ ] Cubrir composable, componentes y autorización con tests.

## 13. Definition of done

La integración frontend está lista cuando:

- El usuario con permiso puede consultar cualquier rango válido de hasta 366 días.
- El usuario sin permiso no ve el punto de entrada y no puede acceder por URL.
- Las fechas no se desplazan por parseo UTC o por la zona del navegador.
- Los importes coinciden exactamente con el payload backend.
- No se calculan totales sumando ventas paginadas, pagos o métodos de pago.
- Las líneas de ventas, deuda, reembolsos liquidados y obligaciones pendientes permanecen separadas.
- Los estados de carga, vacío, error y refetch están cubiertos.
- Los tests frontend prueban autorización, rango y render de métricas.

## 14. Serie diaria de ventas (timeseries)

> **Estado**: existe solo en la rama local `feat/branch-sales-timeseries` (commit `08c9822e…`). **No está mergeado, publicado ni desplegado.** Confirmar la entrega de esa rama antes de apuntar a un ambiente remoto. Las secciones 1 a 13 describen el contrato desplegado del resumen.

`GET /analytics/sales/timeseries` devuelve la misma cohorte de ventas confirmadas que el resumen, pero desglosada en **un punto ordenado por día calendario local**, rellenando con ceros los días sin ventas. Sirve para la gráfica diaria; **no** reemplaza al resumen.

### 14.1 Contrato HTTP

| Propiedad         | Valor                         |
| ----------------- | ----------------------------- |
| Método            | `GET`                         |
| Path              | `/analytics/sales/timeseries` |
| Respuesta exitosa | `200 OK`                      |
| Autenticación     | JWT Bearer                    |
| Tenant            | Derivado del JWT              |
| Permiso exacto    | `read:Analytics`              |

La cadena de seguridad es idéntica al resumen: `JwtAuthGuard` → `TenantContextGuard` → `PermissionsGuard`. Aplica el mismo comportamiento de `401` (JWT ausente/inválido) y `403` (falta de `read:Analytics`).

### 14.2 Query params

| Param      | Tipo     | Obligatorio | Regla                                               |
| ---------- | -------- | ----------- | --------------------------------------------------- |
| `from`     | `string` | Sí          | Fecha local exacta `YYYY-MM-DD`; inclusiva          |
| `to`       | `string` | Sí          | Fecha local exacta `YYYY-MM-DD`; exclusiva          |
| `interval` | `string` | No          | Default `day`; **`day` es el único valor aceptado** |

Hereda exactamente las reglas del resumen (secciones 3.2 y 3.3):

- Zona horaria `America/Mexico_City`; rango semiabierto `[from, to)`.
- `to` estrictamente posterior a `from`; máximo 366 días calendario.
- Fechas imposibles, timestamps, año `0000`, rangos iguales o invertidos y parámetros desconocidos se rechazan con `400`.
- No se aceptan `tenantId`, `branchId`, `userId`, `currency`, `paymentMethod` ni ningún otro parámetro.
- No hay `week` ni `month`: solo `day`. Cualquier otro `interval` da `400`.

### 14.3 Respuesta `200 OK`

```ts
export type BranchSalesTimeseriesInterval = 'day';

export interface BranchSalesTimeseriesPoint {
  date: string; // día local YYYY-MM-DD
  grossSalesCents: number;
  netSalesCents: number;
  collectedCents: number;
  outstandingDebtCents: number;
  saleCount: number;
  averageTicketCents: number;
}

export interface BranchSalesTimeseriesResponse {
  timeZone: 'America/Mexico_City';
  from: string;
  to: string;
  interval: BranchSalesTimeseriesInterval;
  points: BranchSalesTimeseriesPoint[];
}

export interface BranchSalesTimeseriesQuery {
  from: string;
  to: string;
  interval?: BranchSalesTimeseriesInterval;
}
```

Claves exactas: el cuerpo trae **solo** `timeZone`, `from`, `to`, `interval` y `points`; cada punto trae **solo** `date`, `grossSalesCents`, `netSalesCents`, `collectedCents`, `outstandingDebtCents`, `saleCount` y `averageTicketCents`.

Ejemplo:

```http
GET /analytics/sales/timeseries?from=2026-01-01&to=2026-01-04&interval=day
Authorization: Bearer <jwt>
```

```json
{
  "timeZone": "America/Mexico_City",
  "from": "2026-01-01",
  "to": "2026-01-04",
  "interval": "day",
  "points": [
    {
      "date": "2026-01-01",
      "grossSalesCents": 125000,
      "netSalesCents": 110000,
      "collectedCents": 80000,
      "outstandingDebtCents": 30000,
      "saleCount": 4,
      "averageTicketCents": 27500
    },
    {
      "date": "2026-01-02",
      "grossSalesCents": 0,
      "netSalesCents": 0,
      "collectedCents": 0,
      "outstandingDebtCents": 0,
      "saleCount": 0,
      "averageTicketCents": 0
    },
    {
      "date": "2026-01-03",
      "grossSalesCents": 90000,
      "netSalesCents": 88000,
      "collectedCents": 88000,
      "outstandingDebtCents": 0,
      "saleCount": 2,
      "averageTicketCents": 44000
    }
  ]
}
```

### 14.4 Semántica de los puntos

| Regla           | Detalle                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orden           | Ascendente por `date`, desde el inicio local de `from` hasta el último día anterior a `to`                                                                                                        |
| Cardinalidad    | **Exactamente un punto por día calendario local** en `[from, to)`; nunca se omiten días                                                                                                           |
| Zero fill       | Los días sin ventas aparecen con todas las métricas en `0`                                                                                                                                        |
| Promedio diario | `averageTicketCents = 0` si `saleCount = 0`; si no, `Math.round(netSalesCents / saleCount)`                                                                                                       |
| Cohorte         | Ventas `CONFIRMED` del tenant, agrupadas por `confirmedAt` dentro de cada día local                                                                                                               |
| Métricas        | `grossSalesCents` = suma de `subtotalCents`; `netSalesCents` = suma de `totalCents`; `collectedCents` = suma de `paidCents`; `outstandingDebtCents` = suma de `debtCents`; `saleCount` = cantidad |

`collectedCents` y `outstandingDebtCents` son el **estado actual** de las ventas confirmadas en ese día; no son flujos agrupados por la fecha del pago.

### 14.5 Qué NO trae la serie

La serie es deliberadamente más chica que el resumen. **No incluye**:

- Reembolsos liquidados ni obligaciones de reembolso pendientes.
- Moneda ni desglose por método de pago.
- Comparación con períodos anteriores.
- Totales de caja ni flujo de cobros por fecha de pago.

Para las líneas de reembolsos del período, **el resumen sigue siendo la autoridad**. La serie solo desglosa la cohorte de ventas por día.

### 14.6 No sintetizar la gráfica en el frontend

El frontend **debe** llamar al endpoint de timeseries para dibujar la serie. No vale:

- Repartir el total del resumen entre los días, ni en partes iguales ni ponderadas.
- Sumar páginas de ventas, pagos o métodos de pago para reconstruir el día.
- Derivar puntos desde `summary` o desde cualquier otro endpoint.

Esas reconstrucciones reproducen exactamente los errores de redondeo y de cohorte que el backend ya resolvió.

### 14.7 Fechas y etiquetas

`from` y `to` siguen siendo **strings** `YYYY-MM-DD`; no conviertas los límites con `new Date('YYYY-MM-DD')`, porque se interpreta como medianoche UTC y desplaza el día. Para las etiquetas del eje X usa directamente el campo `date` de cada punto: ya es el día calendario local.

### 14.8 Integración sugerida con TanStack Vue Query

```ts
import { computed, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';

export function useBranchSalesTimeseries(from: Ref<string>, to: Ref<string>) {
  const enabled = computed(
    () =>
      /^\d{4}-\d{2}-\d{2}$/.test(from.value) &&
      /^\d{4}-\d{2}-\d{2}$/.test(to.value) &&
      from.value < to.value,
  );

  return useQuery({
    queryKey: computed(() => [
      'analytics',
      'sales-timeseries',
      { from: from.value, to: to.value, interval: 'day' },
    ]),
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<BranchSalesTimeseriesResponse> => {
      const response = await api.get('/analytics/sales/timeseries', {
        params: { from: from.value, to: to.value, interval: 'day' },
      });
      return response.data ?? response;
    },
  });
}
```

La query key incluye rango e `interval`. Invalida o refresca la serie cuando ocurra una mutación que cambie ventas confirmadas del rango (confirmación de venta, cobro, cambio de período). El backend es la autoridad de validación de fechas y del tope de 366 días.

### 14.9 Estados de UI, permisos y errores

| Situación              | Comportamiento                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Con `read:Analytics`   | Mostrar la gráfica y llamar a la serie                                                                                  |
| Sin `read:Analytics`   | Ocultar el punto de entrada; `403` si llega por URL                                                                     |
| JWT ausente o expirado | Flujo global de `401`/re-login                                                                                          |
| `400`                  | Rango inválido o `interval` no soportado: marcar el formulario                                                          |
| `500`                  | Estado de error con acción de reintento                                                                                 |
| Loading inicial        | Skeleton de filtros y gráfica                                                                                           |
| Refetch                | Conservar puntos previos con indicador discreto                                                                         |
| Empty                  | Todos los puntos en cero: “Sin ventas en el rango” (la serie siempre trae puntos; el vacío es de datos, no de longitud) |
| Data                   | Render punto a punto desde `points`                                                                                     |

No decidas el estado vacío por la longitud de `points`: siempre hay un punto por día. El vacío depende de que todas las métricas de todos los puntos sean `0`.

### 14.10 Checklist de integración

- [ ] Definir `BranchSalesTimeseriesResponse`, `BranchSalesTimeseriesPoint` y `BranchSalesTimeseriesQuery`.
- [ ] Crear el método API para `GET /analytics/sales/timeseries`.
- [ ] Mantener `from`/`to` como strings; enviar `interval` omitido o `day`.
- [ ] Crear query key con rango e interval.
- [ ] Renderizar usando `points[].date` como etiqueta local, sin `Date`.
- [ ] Dibujar la gráfica llamando al endpoint; sin síntesis desde resumen, ventas o pagos.
- [ ] Mostrar empty solo cuando todos los puntos están en cero.
- [ ] Cubrir `read:Analytics`, `401`/`403`, loading/refetch/error.
- [ ] Leer los reembolsos del período desde el resumen, no desde la serie.

### 14.11 Definition of done (timeseries)

- La serie se consume del endpoint; nunca se sintetiza.
- La cantidad de `points` equivale a los días locales de `[from, to)`, con los días vacíos en cero.
- `averageTicketCents` coincide con el backend, incluido el caso `saleCount = 0`.
- Las fechas no se desplazan por parseo UTC ni por la zona del navegador.
- Reembolsos y moneda no se mezclan con la serie; el resumen sigue siendo la autoridad de período.
- Existe cobertura de autorización, rango, `interval` inválido, empty y render.

## 15. Reporte de ventas por vendedor (seller sales report)

> **Estado**: existe solo en la rama local `feat/seller-sales-report`. **No está mergeado, publicado ni desplegado.** Confirmar la entrega antes de apuntar a un ambiente remoto.

`GET /analytics/sales/sellers/:sellerUserId/report` devuelve, para un vendedor del tenant autenticado, dos secciones separadas: ventas **confirmadas** atribuidas por `confirmedAt` y ventas **canceladas** (informativas) atribuidas por `canceledAt`. No es un listado general de ventas ni reemplaza al resumen de sucursal.

### 15.1 Contrato HTTP

| Propiedad         | Valor                                           |
| ----------------- | ----------------------------------------------- |
| Método            | `GET`                                           |
| Path              | `/analytics/sales/sellers/:sellerUserId/report` |
| Respuesta exitosa | `200 OK` (`Cache-Control: no-store`)            |
| Autenticación     | JWT Bearer                                      |
| Tenant            | Derivado del JWT                                |
| Permisos exactos  | `read:Analytics` **Y** `read:Sale`              |

La cadena de seguridad es la misma del resumen (`JwtAuthGuard` → `TenantContextGuard` → `PermissionsGuard`). `read:User` es requisito de entrada de la UI, **no** permiso del endpoint. Falta cualquiera de los dos permisos del endpoint → `403`.

### 15.2 Path y query params

| Param          | Ubicación | Tipo     | Regla                                       |
| -------------- | --------- | -------- | ------------------------------------------- |
| `sellerUserId` | path      | `string` | UUID real del vendedor; otro valor da `400` |
| `from`         | query     | `string` | Fecha local exacta `YYYY-MM-DD`; inclusiva  |
| `to`           | query     | `string` | Fecha local exacta `YYYY-MM-DD`; exclusiva  |

Hereda las reglas de rango del resumen (secciones 3.2 y 3.3): zona `America/Mexico_City`, semiabierto `[from,to)`, máximo 366 días, sin `tenantId`/`status`/`sort`/`limit`/`currency`. El tenant se toma del JWT; no se envía.

### 15.3 Respuesta `200 OK`

```ts
export type SellerReportPaymentStatus = 'PAID' | 'PARTIAL' | 'CREDIT';

export interface SellerSalesReportConfirmedRow {
  id: string;
  folio: string | null;
  confirmedAt: string; // ISO UTC
  totalCents: number;
  paidCents: number;
  debtCents: number;
  paymentStatus: SellerReportPaymentStatus;
}

export interface SellerSalesReportCanceledRow {
  id: string;
  folio: string | null;
  confirmedAt: string | null; // ISO UTC o null, sin fallback
  canceledAt: string; // ISO UTC
  totalCents: number;
}

export interface SellerSalesReport {
  seller: { id: string; name: string };
  tenantId: string;
  timeZone: 'America/Mexico_City';
  from: string;
  to: string;
  generatedAt: string; // ISO UTC, momento de generación
  attribution: 'CURRENT_SELLER';
  balances: 'CURRENT';
  rowLimit: 1000;
  rowCount: number;
  confirmed: {
    dateBasis: 'confirmedAt';
    summary: {
      saleCount: number;
      netSalesCents: number;
      collectedCents: number;
      outstandingDebtCents: number;
      averageTicketCents: number;
    };
    rows: SellerSalesReportConfirmedRow[];
  };
  canceled: {
    dateBasis: 'canceledAt';
    saleCount: number;
    rows: SellerSalesReportCanceledRow[];
  };
}
```

### 15.4 Semántica

| Regla                | Detalle                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Atribución           | Vendedor **actual** de la venta (`CURRENT_SELLER`); no se reconstruye historial                                                 |
| Confirmadas          | Cohorte por `confirmedAt` en `[from,to)`; alimentan `summary` y sus totales                                                      |
| Canceladas           | Cohorte informativa por `canceledAt`; **excluidas** de los totales confirmados                                                   |
| Saldos               | `paidCents`/`debtCents` son el estado **actual** (`CURRENT`), no flujos por fecha de pago                                        |
| Orden                | Ascendente por fecha (`confirmedAt`/`canceledAt`) y luego por `id`, dentro de cada sección                                       |
| Centavos             | Enteros no negativos seguros; se validan filas y sumas                                                                          |
| `averageTicketCents` | `netSalesCents / saleCount` redondeado; `0` sin ventas                                                                          |
| `rowCount`           | Suma de filas de ambas secciones                                                                                                |
| Elegibilidad         | El usuario existe y tiene membresía en el tenant (cualquier rol, activo o inactivo) o alguna venta asignada; un miembro inactivo **sin ventas sigue siendo elegible** |
| `generatedAt`        | Momento de generación, no un corte contable histórico                                                                            |

Sin reembolsos, sin moneda ni data de cliente/cajero/items/motivo de cancelación. No derivar un "neto de caja".

### 15.5 Errores

| HTTP  | Causa                                                                                        |
| ----- | -------------------------------------------------------------------------------------------- |
| `400` | UUID inválido, fechas inválidas o fuera de rango, rango > 366 días, params desconocidos      |
| `401` | JWT ausente o inválido                                                                       |
| `403` | Falta `read:Analytics` o `read:Sale`                                                         |
| `404` | `SELLER_NOT_FOUND`: vendedor inexistente o sin vínculo con el tenant (mismo envelope)        |
| `422` | `SELLER_REPORT_ROW_LIMIT_EXCEEDED`: más de 1000 filas combinadas; **no hay reporte parcial** |
| `500` | Fallo inesperado de lectura/validación                                                       |

El `422` trae `{ statusCode, error: 'SELLER_REPORT_ROW_LIMIT_EXCEEDED', message, timestamp, rowLimit: 1000, rowCount }`. Ante `422`, pedir un rango más corto; no renderizar un reporte parcial.

### 15.6 UI y cobertura recomendadas

- Filtros `from`/`to` con las mismas reglas del resumen y selector de vendedor.
- Mostrar confirmadas (con totales) y canceladas separadas; no sumar las canceladas a los totales confirmados.
- Usar `rows[].folio` si existe; formatear `confirmedAt`/`canceledAt` (ISO UTC) en `America/Mexico_City`.
- Diferenciar `400`/`403`/`404`/`422`; tratar `no-store` como "no cachear".
- Cobertura: permiso doble (falta cualquiera → `403`), UUID inválido → `400`, rango inválido → `400`, `404`, `422`, secciones separadas y estado vacío (`rowCount === 0`).
