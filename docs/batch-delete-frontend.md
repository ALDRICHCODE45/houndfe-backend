# Batch Deletion — Frontend Integration Guide

**Feature**: Eliminación por lotes (batch delete)  
**Módulo piloto**: Promociones  
**Fecha**: 2026-07-24  
**Backend**: `houndfe-backend` — NestJS + Prisma + PostgreSQL

---

## 1. Qué se implementó

Un sistema de **eliminación masiva all-or-nothing** para promociones. Envías una lista de IDs y el backend:
1. Valida que todos los IDs existan en tu tenant
2. Verifica que ninguna promoción esté referenciada por una venta activa
3. Si todo pasa → borra todo en una sola transacción
4. Si algo falla → **no se borra nada** y te devuelve exactamente qué IDs fallaron y por qué

La abstracción es **reutilizable** — en el futuro se extenderá a productos, clientes, etc.

---

## 2. Endpoint

```
POST /promotions/batch-delete
```

**Autenticación**: JWT (Bearer token)  
**Tenant**: Automático vía `TenantContextGuard` (el token ya incluye el tenant)  
**Permiso requerido**: `batch_delete` sobre `Promotion`

> ⚠️ **Importante**: El permiso `batch_delete` es **independiente** de `delete` y `manage`. Un usuario con `manage:Promotion` pero sin el permiso explícito `batch_delete:Promotion` **no puede** usar este endpoint. El admin debe asignar este permiso explícitamente en la configuración de roles.

---

## 3. Request

### Headers

```
Authorization: Bearer <jwt-token>
Content-Type: application/json
```

### Body

```json
{
  "ids": [
    "550e8400-e29b-41d4-a716-446655440000",
    "550e8400-e29b-41d4-a716-446655440001",
    "550e8400-e29b-41d4-a716-446655440002"
  ]
}
```

### Reglas de validación del body

| Regla | Error si... |
|-------|-------------|
| `@ArrayMinSize(1)` | El array está vacío `[]` |
| `@ArrayMaxSize(100)` | El array tiene más de 100 IDs |
| `@ArrayUnique()` | Hay IDs duplicados en el array |
| `@IsUUID('4', { each: true })` | Algún ID no es un UUID v4 válido |

### Límite de batch

**Máximo 100 IDs por request.** Configurable vía variable de entorno `BATCH_DELETE_MAX_SIZE` (default: 100).

---

## 4. Response

### Éxito — 200 OK

```json
{
  "deleted": 5
}
```

`deleted` es la cantidad de registros eliminados. Coincide con `ids.length` (all-or-nothing: o se borran todos, o ninguno).

---

### Error de validación — 400 Bad Request

Cuando el body no cumple las reglas de validación (DTO). NestJS + class-validator devuelve el formato estándar:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": [
    "ids must contain no more than 100 elements",
    "each value in ids must be a UUID"
  ]
}
```

---

### Promociones referenciadas por ventas — 409 Conflict

Cuando una o más promociones del batch están siendo usadas por registros de venta (`SaleItem` o `SalePromotionApplied`). **No se borra nada.**

```json
{
  "statusCode": 409,
  "error": "PROMOTION_REFERENCED_BY_SALE",
  "message": "Promotion(s) referenced by existing sale records cannot be deleted: 550e8400-e29b-41d4-a716-446655440000, 550e8400-e29b-41d4-a716-446655440001",
  "offendingIds": [
    "550e8400-e29b-41d4-a716-446655440000",
    "550e8400-e29b-41d4-a716-446655440001"
  ],
  "timestamp": "2026-07-24T18:30:00.000Z"
}
```

**`offendingIds`**: Array con los IDs que causaron el rechazo. Son los que debés mostrar al usuario para que entienda **por qué** no se pudieron borrar.

---

### IDs no encontrados en el tenant — 409 Conflict

Cuando uno o más IDs no existen en la base de datos del tenant actual (cross-tenant o IDs inválidos).

```json
{
  "statusCode": 409,
  "error": "BATCH_DELETE_NOT_FOUND",
  "message": "Promotion(s) not found in this tenant: 550e8400-e29b-41d4-a716-446655440099",
  "offendingIds": [
    "550e8400-e29b-41d4-a716-446655440099"
  ],
  "timestamp": "2026-07-24T18:30:00.000Z"
}
```

---

### Sin permiso — 403 Forbidden

Cuando el usuario no tiene el permiso `batch_delete:Promotion`:

```json
{
  "statusCode": 403,
  "error": "INSUFFICIENT_PERMISSIONS",
  "message": "Insufficient permissions",
  "timestamp": "2026-07-24T18:30:00.000Z"
}
```

---

### No autenticado — 401 Unauthorized

Cuando el JWT falta, es inválido o expiró. Formato estándar de NestJS.

---

## 5. Tabla de códigos de error

| HTTP | Código (`error`) | Significado | Campo extra |
|------|-----------------|-------------|-------------|
| 400 | `Bad Request` | Body inválido (DTO validation) | `message: string[]` |
| 401 | `Unauthorized` | JWT inválido o expirado | — |
| 403 | `INSUFFICIENT_PERMISSIONS` | Usuario no tiene `batch_delete:Promotion` | — |
| 409 | `PROMOTION_REFERENCED_BY_SALE` | Al menos una promo está referenciada por una venta | `offendingIds: string[]` |
| 409 | `BATCH_DELETE_NOT_FOUND` | IDs no existen en el tenant | `offendingIds: string[]` |

---

## 6. Flujo UX recomendado

### Vista de lista de promociones

1. Agregar **checkboxes de selección múltiple** en la tabla de promociones
2. Al seleccionar ≥1 promociones, mostrar un botón **"Eliminar seleccionadas"**
3. El botón **solo se habilita** si el usuario tiene el permiso `batch_delete:Promotion` (leer desde `GET /auth/me/permissions`)

### Diálogo de confirmación

Antes de enviar el request, mostrar un diálogo que:
- Liste las promociones seleccionadas (título + estado)
- Advierte que la acción **no se puede deshacer**
- Muestra un badge de advertencia si alguna está en estado `ACTIVE` o `SCHEDULED`

### Manejo de respuesta

```
ÉXITO (200):
  → Toast verde: "5 promociones eliminadas"
  → Recargar la lista de promociones
  → Limpiar selección

ERROR 409 (PROMOTION_REFERENCED_BY_SALE):
  → Toast rojo: "X promociones no se pueden eliminar porque están referenciadas por ventas"
  → Resaltar en la tabla los IDs en offendingIds
  → Sugerir usar "Finalizar" (PATCH /promotions/:id/end) en lugar de eliminar

ERROR 409 (BATCH_DELETE_NOT_FOUND):
  → Toast amarillo: "Algunas promociones ya no existen"
  → Recargar la lista (posiblemente fueron eliminadas por otro usuario)

ERROR 403:
  → Redirigir o mostrar mensaje de permisos insuficientes

ERROR 400:
  → El frontend no debería generar requests inválidos (validar antes de enviar)
```

### Check de permisos

Llamar a `GET /auth/me/permissions` y buscar:
```json
{ "action": "batch_delete", "subject": "Promotion" }
```

Si no existe, ocultar/deshabilitar la funcionalidad de eliminación por lotes. Recordar que `{ "action": "manage", "subject": "Promotion" }` **no es suficiente** — el permiso `batch_delete` debe ser explícito.

---

## 7. Notas importantes

1. **All-or-nothing estricto**: Si el batch tiene 10 IDs y 1 solo falla, los otros 9 **no se borran**. No hay eliminación parcial.

2. **Transacción atómica**: Todo corre dentro de una transacción de base de datos. Si el servidor se cae a mitad del proceso, la DB revierte automáticamente.

3. **Promociones con ventas**: Si una promoción fue usada en alguna venta (aunque la venta ya esté confirmada/cancelada), **no se puede eliminar por batch**. Para "desactivarla" sin borrarla, usar `PATCH /promotions/:id/end`.

4. **Cualquier estado es eliminable**: `ACTIVE`, `SCHEDULED`, `ENDED` — todos se pueden borrar por batch. Si querés conservar el historial, usá `end()` en lugar de `delete`.

5. **Sin límite de rate por ahora**: El endpoint no tiene rate limiting. Si tu UI permite seleccionar 100 promociones de una, es válido. Pero sé razonable — no hagas 50 requests seguidos de 100 IDs cada uno.

6. **Cascade automático**: Al borrar una promoción, se eliminan automáticamente sus registros asociados (targetItems, customers, priceLists, daysOfWeek). No necesitás limpiar nada antes.

---

## 8. Extensión futura

Esta misma abstracción (`BatchDeletableService` + `BatchDeleteOrchestrator`) se usará para implementar batch delete en otros módulos. El contrato será el mismo:

- Mismo endpoint pattern: `POST /<module>/batch-delete`
- Mismo body: `{ ids: string[] }`
- Mismo response shape
- Mismo manejo de errores
- Permiso: `batch_delete:<Subject>` específico por módulo

Cuando se implemente en productos, clientes, etc., esta guía aplica con mínimos cambios (solo cambia el `subject` del permiso y las reglas de pre-flight específicas de cada entidad).
