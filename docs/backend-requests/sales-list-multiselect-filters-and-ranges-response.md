# Respuesta backend — Filtros multi-valor y por rango en `GET /sales`

## 1. Resumen ejecutivo

Se implementó y quedó bloqueado el nuevo contrato de filtros para `GET /sales` con soporte de multi-valor (CSV), rangos numéricos/fecha y flags explícitos para incluir registros sin valor (`null`/sin filas asociadas). Para frontend, el cambio principal es que ahora puede combinar filtros avanzados en una sola request manteniendo semántica consistente: **OR dentro del mismo filtro** y **AND entre filtros distintos**. También queda canónico el uso de rangos `*Min/*Max` (numéricos) y `*From/*To` (fechas), con alias legacy `from`/`to` aún compatibles de forma temporal. No cambió el shape de la respuesta ni los contratos de auth/RBAC existentes.

## 2. Endpoint afectado

- **Endpoint**: `GET /sales`
- **Auth**: JWT requerido (igual que antes).
- **RBAC**: permiso `read:Sale` (igual que antes).
- **Scope**: tenant-scoped (igual que antes).
- **Respuesta**: **NO cambia** su forma; sigue devolviendo `data + pagination + counts`.

## 3. Tabla completa de query params

| Param | Tipo | Formato | Cap | Default | Descripción |
|---|---|---|---|---|---|
| `page` | int | entero `>= 1` | — | `1` | Página a solicitar. |
| `limit` | int | entero `>= 1` | `100` máx | `20` | Tamaño de página. |
| `sortBy` | enum | `confirmedAt` \| `totalCents` \| `createdAt` | — | `confirmedAt` | Campo de ordenamiento. |
| `sortOrder` | enum | `asc` \| `desc` | — | `desc` | Dirección de ordenamiento. |
| `q` | string | texto libre | — | — | Búsqueda libre (se mantiene). |
| `folio` | CSV string | `folio1,folio2,...` | `200` valores | — | Lista de folios exactos (match por `IN`). |
| `status` | CSV enum | `DRAFT,CONFIRMED,CANCELED` | `50` valores | — | Estado de venta. |
| `paymentStatus` | CSV enum | `PAID,PARTIAL,CREDIT` | `50` valores | — | Estado de pago. |
| `paymentMethod` | CSV enum | `CASH,CARD_DEBIT,CARD_CREDIT,TRANSFER` | `50` valores | — | Método de pago. **`CREDIT` NO es válido acá**. |
| `deliveryStatus` | CSV enum | `PENDING,DELIVERED,NOT_APPLICABLE` | `50` valores | — | Estado de entrega. |
| `cashierUserId` | CSV UUID | `uuid1,uuid2,...` | `200` valores | — | Filtra por cajero(s). |
| `customerId` | CSV UUID | `uuid1,uuid2,...` | `200` valores | — | Filtra por cliente(s). |
| `customerIncludeNull` | boolean | `true` / `false` | — | `false` | Incluye ventas sin cliente (`customerId = null`). |
| `paymentMethodIncludeNull` | boolean | `true` / `false` | — | `false` | Incluye ventas sin filas en `sale_payments` (crédito sin pagos). |
| `dueDateIncludeNull` | boolean | `true` / `false` | — | `false` | Incluye ventas sin `dueDate`. |
| `totalMin` | int | cents | — | — | Límite inferior de total (inclusive). |
| `totalMax` | int | cents | — | — | Límite superior de total (inclusive). |
| `debtMin` | int | cents | — | — | Límite inferior de deuda (inclusive). |
| `debtMax` | int | cents | — | — | Límite superior de deuda (inclusive). |
| `confirmedFrom` | ISO 8601 date-time | ej. `2026-06-01T00:00:00.000Z` | — | — | Inicio de rango para fecha de confirmación (inclusive, UTC). |
| `confirmedTo` | ISO 8601 date-time | ej. `2026-06-30T23:59:59.999Z` | — | — | Fin de rango para fecha de confirmación (inclusive, UTC). |
| `dueDateFrom` | ISO 8601 date-time | ej. `2026-06-01T00:00:00.000Z` | — | — | Inicio de rango de vencimiento (inclusive, UTC). |
| `dueDateTo` | ISO 8601 date-time | ej. `2026-06-30T23:59:59.999Z` | — | — | Fin de rango de vencimiento (inclusive, UTC). |
| `from` | ISO 8601 date-time | alias legacy de `confirmedFrom` | — | — | **DEPRECATED**. Sigue funcionando temporalmente. |
| `to` | ISO 8601 date-time | alias legacy de `confirmedTo` | — | — | **DEPRECATED**. Sigue funcionando temporalmente. |

## 4. Formato de transporte y semántica

### 4.1 Multi-valor (CSV)

- Sintaxis: `?paymentStatus=PAID,PARTIAL`.
- Se hace `trim` de espacios, dedupe de repetidos y se ignoran segmentos vacíos.
- Single value sigue válido: `?paymentStatus=PAID` equivale a array de un valor.
- Si se supera el cap configurado del campo, responde `LISTING_TOO_MANY_VALUES` (400).

### 4.2 Rangos numéricos

- Cada límite es opcional de forma independiente.
- `totalMin=5000` → `>= 5000`.
- `totalMax=20000` → `<= 20000`.
- `totalMin + totalMax` → rango inclusive.
- `totalMin=0&totalMax=0` es válido y devuelve total exacto 0.
- Si `min > max`, error `LISTING_INVERTED_RANGE`.

### 4.3 Rangos de fecha

- Cada límite es opcional de forma independiente.
- Formato esperado: ISO 8601 con timezone (recomendado UTC), por ejemplo `2026-06-01T00:00:00.000Z`.
- Backend toma el timestamp recibido tal cual; el cálculo de end-of-day correcto lo define frontend antes de enviar `*To`.
- Si `from > to`, error `LISTING_INVERTED_RANGE`.

### 4.4 Flags de inclusión de nulls

- Son booleanos explícitos para incluir registros donde **ese campo** está en `null` (o sin filas relacionadas).
- `customerIncludeNull=true` incluye ventas sin cliente asignado (“Público en General”).
- `dueDateIncludeNull=true` incluye ventas sin fecha de vencimiento.
- `paymentMethodIncludeNull=true` incluye ventas sin pagos registrados; esto cubre ventas a crédito con 0 filas en `sale_payments`.
- Combinación con lista del mismo campo usa OR. Ejemplo: `customerId=<uuid1>,<uuid2>&customerIncludeNull=true` trae clientes listados **o** cliente null.

### 4.5 Combinación AND / OR

- Distintos filtros se combinan con **AND**.
- Múltiples valores dentro del mismo filtro se combinan con **OR**.
- No hay soporte para NOT, paréntesis arbitrarios, ni operadores configurables.

## 5. Ejemplos copy-paste

**Ejemplo 1 — Solo estado de pago**

```http
GET /sales?paymentStatus=PAID,PARTIAL
```

Devuelve ventas con estado de pago `PAID` **o** `PARTIAL`.

**Ejemplo 2 — Estado + método de pago**

```http
GET /sales?paymentStatus=PAID&paymentMethod=CASH,TRANSFER
```

Combina filtros distintos con AND: estado `PAID` y método `CASH` o `TRANSFER`.

**Ejemplo 3 — Rango numérico de total**

```http
GET /sales?totalMin=50000&totalMax=200000
```

Trae ventas con total entre 50.000 y 200.000 cents inclusive.

**Ejemplo 4 — Rango de confirmación en UTC**

```http
GET /sales?confirmedFrom=2026-06-01T00:00:00.000Z&confirmedTo=2026-06-30T23:59:59.999Z
```

Filtra por ventas confirmadas en ese intervalo exacto.

**Ejemplo 5 — Cliente específico + Público en General**

```http
GET /sales?customerId=550e8400-e29b-41d4-a716-446655440000&customerIncludeNull=true
```

Incluye ventas del cliente indicado **o** sin cliente.

**Ejemplo 6 — Sin vencimiento + sin método (crédito/no pagos)**

```http
GET /sales?dueDateIncludeNull=true&paymentMethodIncludeNull=true
```

Devuelve ventas sin `dueDate` y además sin pagos registrados.

**Ejemplo 7 — Caso canónico con múltiples filtros**

```http
GET /sales?paymentStatus=PAID,CREDIT&paymentMethod=CASH,TRANSFER&totalMin=50000&totalMax=200000&dueDateFrom=2026-06-01T00:00:00.000Z&dueDateTo=2026-06-30T23:59:59.999Z&customerIncludeNull=true&deliveryStatus=DELIVERED&q=Juan
```

Aplica filtros extendidos sobre la data del listado en una sola request.

**Ejemplo 8 — Búsqueda libre + filtro de tab**

```http
GET /sales?q=público&paymentStatus=CREDIT
```

`q` se combina por AND con el resto de filtros.

## 6. Respuesta

El shape **no cambia** respecto al endpoint ya existente.

```json
{
  "data": [
    {
      "id": "sale-match-1",
      "folio": "V-000123",
      "status": "CONFIRMED",
      "paymentStatus": "PAID",
      "deliveryStatus": "DELIVERED",
      "totalCents": 120000,
      "debtCents": 0,
      "confirmedAt": "2026-06-15T15:23:10.000Z",
      "dueDate": null,
      "customer": {
        "id": "8a7cbe67-7e82-4d3c-b8d0-5f0e613c1a7a",
        "name": "Juan Perez"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  },
  "counts": {
    "all": 3,
    "pendingPayments": 1,
    "notDelivered": 1
  }
}
```

## 7. Comportamiento de los KPIs (CRÍTICO)

Los KPIs (`counts.all`, `counts.pendingPayments`, `counts.notDelivered`) se calculan solo sobre el **filter set base**:

- `q`
- `confirmedFrom` / `confirmedTo`
- `cashierUserId`
- `customerId` + `customerIncludeNull`

Los filtros extendidos (`paymentStatus`, `paymentMethod`, `deliveryStatus`, `status`, `folio`, `totalMin/Max`, `debtMin/Max`, `dueDateFrom/To`, `dueDateIncludeNull`, etc.) **NO alteran los counts**.

Esto es intencional: los KPIs muestran el universo general (fecha/cajero/cliente/búsqueda), no el recorte de chips/tabs de la tabla.

Ejemplo concreto: si aplicás `paymentStatus=PAID`, la `data` sí se reduce a pagadas, pero `counts` sigue mostrando `all/pendingPayments/notDelivered` como si ese filtro extendido no estuviera aplicado.

## 8. Manejo de errores

### 8.1 Shape del error envelope

Todos los errores de validación de listado responden `HTTP 400` con este shape:

```json
{
  "statusCode": 400,
  "code": "LISTING_INVALID_ENUM_VALUE",
  "message": "paymentStatus is invalid",
  "field": "paymentStatus",
  "details": {
    "allowed": ["PAID", "PARTIAL", "CREDIT"]
  }
}
```

### 8.2 Tabla de error codes

| code | Cuándo dispara | Ejemplo de body |
|---|---|---|
| `LISTING_INVALID_ENUM_VALUE` | Cuando un CSV enum trae un valor no permitido para ese campo. | `{"statusCode":400,"code":"LISTING_INVALID_ENUM_VALUE","message":"paymentStatus is invalid","field":"paymentStatus","details":{"allowed":["PAID","PARTIAL","CREDIT"]}}` |
| `LISTING_INVALID_UUID` | Cuando un campo CSV UUID contiene al menos un UUID inválido. | `{"statusCode":400,"code":"LISTING_INVALID_UUID","message":"customerId is invalid","field":"customerId"}` |
| `LISTING_INVALID_DATE` | Cuando una fecha/rango de fecha no parsea a una fecha válida. | `{"statusCode":400,"code":"LISTING_INVALID_DATE","message":"confirmedFrom is invalid","field":"confirmedFrom"}` |
| `LISTING_INVALID_NUMBER` | Cuando un rango numérico trae un valor no numérico/no finito. | `{"statusCode":400,"code":"LISTING_INVALID_NUMBER","message":"totalMin is invalid","field":"totalMin"}` |
| `LISTING_INVERTED_RANGE` | Cuando el límite inferior supera al superior (numérico o fecha). | `{"statusCode":400,"code":"LISTING_INVERTED_RANGE","message":"total range is inverted","field":"total"}` |
| `LISTING_TOO_MANY_VALUES` | Cuando la cardinalidad de un CSV supera el cap del campo. | `{"statusCode":400,"code":"LISTING_TOO_MANY_VALUES","message":"customerId exceeds max values","field":"customerId","details":{"cap":200}}` |

### 8.3 Errores de auth (sin cambios)

- Sin JWT → `401 Unauthorized`.
- JWT válido pero sin `read:Sale` → `403 Forbidden`.

## 9. Migración del alias `from` / `to` → `confirmedFrom` / `confirmedTo`

**ESTÁS LEYENDO ESTO MIENTRAS EL ALIAS SIGUE FUNCIONANDO**. Está así para mantener compatibilidad durante migración frontend.

1. Hoy sigue válido:

```http
GET /sales?from=2026-01-01T00:00:00.000Z&to=2026-12-31T23:59:59.999Z
```

2. Cada request que use `from`/`to` genera warning server-side en logs de prod.
3. El nombre canónico nuevo es `confirmedFrom` / `confirmedTo`.
4. Si enviás ambos (`from=X` y `confirmedFrom=Y`), **gana `confirmedFrom=Y`**. El warning igual se emite.
5. En una versión futura (SDD separado) se elimina el alias con coordinación previa con frontend.

## 10. Validaciones recomendadas del lado frontend

Para evitar 400 evitables:

- Validar caps de cardinalidad antes de enviar:
  - enums: hasta 50
  - UUIDs y strings: hasta 200
- Validar formato de fecha ISO 8601 estricto.
- Validar rangos no invertidos.
- Validar enums contra listas permitidas.
- Para `*To` de fecha, calcular correctamente end-of-day en UTC (`23:59:59.999Z`).

## 11. Performance y caps

- Índices aplicados en backend:
  - `sales(tenantId, status, confirmedAt DESC)`
  - `sale_payments(tenantId, method)`
- Caps por filtro:
  - Hasta `200` para UUID/string CSV
  - Hasta `50` para enum CSV
- `limit` de paginación: máximo `100`.

## 12. Qué NO está incluido (no-goals)

- No existe endpoint de metadata de filtros para descubrimiento dinámico.
- No hay operadores configurables (NOT, comparación estricta custom, etc.).
- No hay persistencia backend de presets de filtros por usuario.
- `q` no usa full-text search (FTS5); sigue estrategia LIKE/contains actual.
