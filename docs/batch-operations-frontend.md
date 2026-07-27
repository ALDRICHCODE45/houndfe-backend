# Batch Operations — Frontend Integration Guide

**Feature**: Operaciones por lotes (batch delete, batch status)  
**Módulos**: Promociones, Empleados  
**Fecha**: 2026-07-24  
**Backend**: `houndfe-backend` — NestJS + Prisma + PostgreSQL

---

## 1. Resumen de endpoints

| Método | Endpoint | Permiso | Descripción |
|--------|----------|---------|-------------|
| `POST` | `/promotions/batch-delete` | `batch_delete:Promotion` | Eliminar múltiples promos |
| `POST` | `/promotions/batch-end` | `update:Promotion` | Finalizar múltiples promos |
| `DELETE` | `/admin/employees/:id` | `delete:Employee` | Eliminar un empleado |
| `POST` | `/admin/employees/batch-delete` | `batch_delete:Employee` | Eliminar múltiples empleados |
| `POST` | `/admin/employees/batch-terminate` | `update:Employee` | Terminar múltiples empleados |
| `POST` | `/admin/employees/batch-reactivate` | `update:Employee` | Reactivar múltiples empleados |

Todos requieren JWT (Bearer token). El tenant se determina automáticamente del token.

---

## 2. Contrato común de request

Todos los endpoints batch usan el mismo DTO:

```
Content-Type: application/json
```

```json
{
  "ids": [
    "550e8400-e29b-41d4-a716-446655440000",
    "550e8400-e29b-41d4-a716-446655440001"
  ]
}
```

### Reglas de validación

| Regla | Error si... |
|-------|-------------|
| `@ArrayMinSize(1)` | Array vacío `[]` |
| `@ArrayMaxSize(100)` | Más de 100 IDs |
| `@ArrayUnique()` | IDs duplicados |
| `@IsUUID('4', { each: true })` | Algún ID no es UUID v4 |

---

## 3. Promociones

### 3.1 `POST /promotions/batch-delete`

**Permiso**: `batch_delete:Promotion`  
> ⚠️ Este permiso es **explícito e independiente** de `manage:Promotion` y `delete:Promotion`. Ver sección 7.

#### Éxito — 200 OK

```json
{
  "deleted": 5
}
```

#### Promo referenciada por venta — 409 Conflict

```json
{
  "statusCode": 409,
  "error": "PROMOTION_REFERENCED_BY_SALE",
  "message": "Promotion(s) referenced by existing sale records cannot be deleted: 550e8400-...",
  "offendingIds": ["550e8400-e29b-41d4-a716-446655440000"],
  "timestamp": "2026-07-24T18:30:00.000Z"
}
```

#### IDs no encontrados — 409 Conflict

```json
{
  "statusCode": 409,
  "error": "BATCH_DELETE_NOT_FOUND",
  "message": "Promotion(s) not found in this tenant: 550e8400-...",
  "offendingIds": ["550e8400-e29b-41d4-a716-446655440099"],
  "timestamp": "2026-07-24T18:30:00.000Z"
}
```

#### Sin permiso — 403 Forbidden

```json
{
  "statusCode": 403,
  "error": "INSUFFICIENT_PERMISSIONS",
  "message": "Insufficient permissions",
  "timestamp": "2026-07-24T18:30:00.000Z"
}
```

#### Validación DTO — 400 Bad Request

Formato estándar de NestJS/class-validator:
```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": ["ids must contain no more than 100 elements"]
}
```

### 3.2 `POST /promotions/batch-end`

**Permiso**: `update:Promotion`

Finaliza múltiples promociones (equivalente a `PATCH /promotions/:id/end` por cada una). All-or-nothing: si una falla, ninguna se modifica.

#### Éxito — 200 OK

```json
{
  "ended": 3
}
```

#### IDs no encontrados — 404 Not Found

```json
{
  "statusCode": 404,
  "error": "BATCH_DELETE_NOT_FOUND",
  "message": "Promotion(s) not found in this tenant: 550e8400-...",
  "offendingIds": ["550e8400-e29b-41d4-a716-446655440099"],
  "timestamp": "2026-07-24T18:30:00.000Z"
}
```

---

## 4. Empleados

### 4.1 `DELETE /admin/employees/:id`

**Permiso**: `delete:Employee`

Eliminación individual (hard delete). Hace cascade de 5 tablas hijas (salarios, puestos, documentos, time-off, contactos de emergencia).

#### Éxito — 204 No Content

Sin body.

#### No encontrado — 404 Not Found

```json
{
  "statusCode": 404,
  "error": "ENTITY_NOT_FOUND",
  "message": "Employee with id \"550e8400-...\" not found",
  "timestamp": "2026-07-24T18:30:00.000Z"
}
```

### 4.2 `POST /admin/employees/batch-delete`

**Permiso**: `batch_delete:Employee`  
> ⚠️ Este permiso es **explícito e independiente** de `manage:Employee` y `delete:Employee`.

#### Éxito — 200 OK

```json
{
  "deleted": 5
}
```

#### IDs no encontrados — 404 Not Found

```json
{
  "statusCode": 404,
  "error": "BATCH_DELETE_NOT_FOUND",
  "message": "Employee(s) not found in this tenant: 550e8400-...",
  "offendingIds": ["550e8400-e29b-41d4-a716-446655440099"],
  "timestamp": "2026-07-24T18:30:00.000Z"
}
```

### 4.3 `POST /admin/employees/batch-terminate`

**Permiso**: `update:Employee`

Termina múltiples empleados (equivalente a `POST /admin/employees/:id/terminate`). El campo `terminationDate` se pone en `now()` y `status = 'TERMINATED'`. Requiere el body de `TerminateEmployeeDto` (con `reason`).

> ⚠️ **A diferencia de otros batch, este endpoint acepta un body extendido** que incluye `reason` para el motivo de terminación. Ver request abajo.

#### Request

```json
{
  "ids": [
    "550e8400-e29b-41d4-a716-446655440000"
  ],
  "reason": "Finalización de contrato"
}
```

#### Éxito — 200 OK

```json
{
  "updated": 3
}
```

#### IDs no encontrados — 404 Not Found

```json
{
  "statusCode": 404,
  "error": "BATCH_DELETE_NOT_FOUND",
  "message": "Employee(s) not found in this tenant: ...",
  "offendingIds": ["550e8400-..."],
  "timestamp": "2026-07-24T18:30:00.000Z"
}
```

### 4.4 `POST /admin/employees/batch-reactivate`

**Permiso**: `update:Employee`

Reactive múltiples empleados (equivalente a `POST /admin/employees/:id/reactivate`). Cambia `status = 'ACTIVE'` y `terminationDate = null`.

#### Request

```json
{
  "ids": [
    "550e8400-e29b-41d4-a716-446655440000"
  ]
}
```

#### Éxito — 200 OK

```json
{
  "updated": 3
}
```

#### IDs no encontrados — 404 Not Found

```json
{
  "statusCode": 404,
  "error": "BATCH_DELETE_NOT_FOUND",
  "message": "Employee(s) not found in this tenant: ...",
  "offendingIds": ["550e8400-..."],
  "timestamp": "2026-07-24T18:30:00.000Z"
}
```

---

## 5. Tabla de códigos de error

| HTTP | Código | Significado | Campo extra |
|------|--------|-------------|-------------|
| 400 | `Bad Request` | Body inválido (DTO validation) | `message: string[]` |
| 401 | `Unauthorized` | JWT inválido o expirado | — |
| 403 | `INSUFFICIENT_PERMISSIONS` | Sin permiso requerido | — |
| 404 | `ENTITY_NOT_FOUND` | Recurso individual no existe | — |
| 404 | `BATCH_DELETE_NOT_FOUND` | IDs no existen en el tenant | `offendingIds: string[]` |
| 409 | `PROMOTION_REFERENCED_BY_SALE` | Promo referenciada por venta (solo batch-delete) | `offendingIds: string[]` |

---

## 6. Flujo UX recomendado

### Para TODOS los batch

1. **Checkboxes** en la tabla (selección múltiple)
2. **Botón de acción** que aparece al seleccionar ≥1 items
3. **Diálogo de confirmación** listando los items seleccionados con nombre/estado
4. **Manejo de respuesta**:
   - 200: toast verde, recargar lista, limpiar selección
   - 404/409: toast rojo/amarillo con los IDs ofensivos, resaltarlos en la tabla
   - 403: redirigir o mostrar mensaje de permisos

### Check de permisos

Llamar `GET /auth/me/permissions` y buscar los permisos requeridos:

| Funcionalidad | Buscar en response |
|---------------|-------------------|
| Batch delete promos | `{ action: "batch_delete", subject: "Promotion" }` |
| Batch end promos | `{ action: "update", subject: "Promotion" }` |
| Delete empleado | `{ action: "delete", subject: "Employee" }` |
| Batch delete empleados | `{ action: "batch_delete", subject: "Employee" }` |
| Terminate/reactivate | `{ action: "update", subject: "Employee" }` |

> ⚠️ `{ action: "manage", subject: "Promotion" }` **NO** implica `batch_delete`. Los permisos batch_delete son explícitos.

---

## 7. Notas importantes

### All-or-nothing
Todos los endpoints batch son **atómicos**: si un solo ID del lote falla, **ninguno** se procesa. No hay operaciones parciales.

### Promociones
- **batch-delete**: si una promo fue usada en alguna venta, no se puede eliminar. Para "desactivarla" usar `batch-end` o `PATCH /promotions/:id/end`.
- **batch-end**: idempotente — finalizar una promo ya finalizada es no-op.
- El estado (ACTIVE, ENDED, SCHEDULED) no bloquea ninguna operación.

### Empleados
- **DELETE (individual o batch)**: hard delete con cascade. **Irreversible**. Destruye todo el historial (salarios, puestos, documentos, time-off, contactos).
- **batch-terminate**: soft-delete. Conserva el historial. Recomendado sobre delete.
- **batch-reactivate**: revierte una terminación. Solo funciona en empleados TERMINATED.
- El `managerId` de los subordinados se pone en `NULL` al eliminar.

### Límite
Máximo **100 IDs por request**. Configurable vía `BATCH_DELETE_MAX_SIZE`.

### Transacción
Todas las operaciones batch corren en una transacción de base de datos. Si el servidor se cae a medio camino, la DB revierte automáticamente.

---

## 8. Endpoints individuales relacionados

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `DELETE` | `/promotions/:id` | Eliminar una promo |
| `PATCH` | `/promotions/:id/end` | Finalizar una promo |
| `DELETE` | `/admin/employees/:id` | Eliminar un empleado |
| `POST` | `/admin/employees/:id/terminate` | Terminar un empleado |
| `POST` | `/admin/employees/:id/reactivate` | Reactivar un empleado |
