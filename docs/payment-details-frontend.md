# Payment Details (Datos bancarios) — Frontend Integration Guide

**Feature**: Datos bancarios (PaymentDetail) — configuración de cuentas para cobros por transferencia (WhatsApp bot + futuros usos)
**Módulo**: `src/admin/payment-details/` — nuevo bounded context
**Fecha**: 2026-08-24
**Backend**: `houndfe-backend` — NestJS + Prisma + PostgreSQL
**Branch**: `main` (cambio archivado `2026-08-24-chatbot-sale-flow-blockers`)

---

## 1. Resumen de endpoints

| Método | Endpoint | Permiso | Descripción |
| ------ | -------- | ------- | ----------- |
| `POST` | `/admin/payment-details` | `create:PaymentDetail` | Crear cuenta bancaria (CLABE + número de cuenta) |
| `GET` | `/admin/payment-details` | `read:PaymentDetail` | Listar cuentas del tenant (activas + inactivas) |
| `GET` | `/admin/payment-details/:id` | `read:PaymentDetail` | Detalle de una cuenta |
| `PATCH` | `/admin/payment-details/:id` | `update:PaymentDetail` | Actualizar campos (parcial) |
| `DELETE` | `/admin/payment-details/:id` | `delete:PaymentDetail` | Baja lógica (`isActive=false`, `204`) |

Todos requieren JWT (Bearer token). El tenant se determina del token automáticamente (CLS). Un ID de otro tenant devuelve `404`, no `403` (no se filtra presencia).

---

## 2. Modelo de datos — shape de respuesta

### `PaymentDetailResponseDto` (todos los endpoints admin)

```typescript
{
  id: string;                 // UUID
  tenantId: string;           // UUID — sucursal dueña de la cuenta
  bankName: string;           // p. ej. "AFIRME"
  beneficiary: string;        // p. ej. "HUN F.E. COMERCIALIZADORA SA DE CV"
  clabe: string;              // exactamente 18 dígitos
  accountNumber: string;      // ≥ 10 dígitos
  isActive: boolean;          // true = cuenta activa (la que ve el bot)
  createdAt: string;          // ISO 8601
  updatedAt: string;          // ISO 8601
}
```

**Nota**: el endpoint del bot (`GET /chatbot-api/payment-details`) usa una proyección distinta y más chica: `{ id, bankName, beneficiary, clabe, accountNumber, isActive, updatedAt }` (sin `tenantId` ni `createdAt`). Los endpoints admin devuelven el shape completo de arriba.

---

## 3. Endpoints — detalle completo

### 3.1 `POST /admin/payment-details` — Crear cuenta

**Request**:
```json
{
  "bankName": "AFIRME",
  "beneficiary": "HUN F.E. COMERCIALIZADORA SA DE CV",
  "clabe": "012345678901234567",
  "accountNumber": "1234567890"
}
```

| Campo | Tipo | Requerido | Validación |
| ----- | ---- | --------- | ---------- |
| `clabe` | string | ✅ | `@Matches(/^\d{18}$/)` — exactamente 18 dígitos |
| `accountNumber` | string | ✅ | `@MinLength(10)` + `@Matches(/^\d+$/)` — solo dígitos, ≥ 10 |
| `bankName` | string | ✅ | `@IsString()` + `@IsNotEmpty()` + `@Matches(/\S/)` — no vacío tras trim |
| `beneficiary` | string | ✅ | igual que `bankName` |

**Response** `201 Created`: `PaymentDetailResponseDto` con `isActive: true` (default) y timestamps.

**Reglas**:
- Los campos string se **trimean** antes de persistir (sin espacios sobrantes).
- **No** se acepta `isActive` en el body: el `ValidationPipe` global usa `forbidNonWhitelisted`, mandarlo produce `400` (es un estado derivado: nace `true`, baja con DELETE).
- Unicidad por sucursal: `@@unique([tenantId, clabe])`. La misma CLABE **sí** puede existir en otra sucursal.

**Errores**:
| HTTP | Código | Causa |
| ---- | ------ | ----- |
| `400` | — | Error de validación del DTO (clabe ≠ 18 dígitos, accountNumber < 10 dígitos, banco/beneficiario vacíos, propiedad no permitida) |
| `409` | `DUPLICATE_CLABE` | La CLABE ya existe en esta sucursal |
| `401` | — | No autenticado |
| `403` | — | Sin permiso `create:PaymentDetail` |

---

### 3.2 `GET /admin/payment-details` — Listar cuentas

**Response** `200`: arreglo (sin paginación) con **todas** las cuentas del tenant — activas e inactivas — ordenadas por `updatedAt DESC` (la más reciente primero):
```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "tenantId": "b3f2a1c4-...",
    "bankName": "AFIRME",
    "beneficiary": "HUN F.E. COMERCIALIZADORA SA DE CV",
    "clabe": "012345678901234567",
    "accountNumber": "1234567890",
    "isActive": true,
    "createdAt": "2026-08-24T10:00:00.000Z",
    "updatedAt": "2026-08-24T10:00:00.000Z"
  }
]
```

**Comportamiento**: incluye inactivas para auditoría/historial (bajas lógicas visibles).

---

### 3.3 `GET /admin/payment-details/:id` — Detalle

**Response** `200`: `PaymentDetailResponseDto` (mismo shape que el item de lista).

**Errores**:
| Código | Causa |
| ------ | ----- |
| `404` | ID no existe o no pertenece al tenant |

---

### 3.4 `PATCH /admin/payment-details/:id` — Actualizar (parcial)

**Request** — todos los campos opcionales; solo se actualizan los enviados:
```json
{
  "beneficiary": "HUN F.E. COMERCIALIZADORA SA DE CV (NORTE)"
}
```

**Response** `200`: `PaymentDetailResponseDto` actualizado. `updatedAt` se bump a la hora del request.

**Reglas**:
- Mismas validaciones por campo que en create (una CLABE de 17 dígitos en PATCH también da `400`).
- **`isActive` no es editable** por PATCH (no está en el DTO; `forbidNonWhitelisted` → `400`). Para desactivar usar `DELETE` (3.5). No existe reactivación: para activar una cuenta nueva se crea un registro nuevo.

**Errores**:
| HTTP | Código | Causa |
| ---- | ------ | ----- |
| `400` | — | Validación de DTO (campo inválido o no permitido) |
| `404` | — | ID no existe o no pertenece al tenant |
| `409` | `DUPLICATE_CLABE` | La CLABE nueva ya existe en esta sucursal |

---

### 3.5 `DELETE /admin/payment-details/:id` — Baja lógica

**Response** `204 No Content` (body vacío).

**Comportamiento**:
- **Baja lógica**: `isActive` → `false`. La fila **permanece en la DB** (historial auditable).
- **No existe hard delete** ni endpoint de reactivar.
- Idempotente: borrar una cuenta ya inactiva es un no-op (no falla).

**Errores**:
| HTTP | Código | Causa |
| ---- | ------ | ----- |
| `404` | — | ID no existe o no pertenece al tenant |
| `403` | — | Sin permiso `delete:PaymentDetail` |

---

## 4. Errores — tabla de referencia rápida

| HTTP | Código interno | Significado | Acción recomendada |
| ---- | -------------- | ----------- | ------------------ |
| 400 | — | Validación del DTO (clabe/accountNumber/bankName/beneficiary) o propiedad no permitida (`forbidNonWhitelisted`) | Validar en el formulario antes de enviar |
| 401 | — | Token expirado o inválido | Redirigir a login |
| 403 | — | Sin permiso CASL (`create/read/update/delete:PaymentDetail`) | Ocultar acciones sin permiso |
| 404 | `ENTITY_NOT_FOUND` | ID inexistente o de otro tenant | Mostrar "No encontrado"; no filtrar presencia entre tenants |
| 409 | `DUPLICATE_CLABE` | La CLABE ya está registrada en esta sucursal | Mostrar mensaje claro: "Esta CLABE ya existe en esta sucursal" |

---

## 5. Permisos

| Acción | Permiso CASL | Descripción |
| ------ | ------------ | ----------- |
| Crear | `create:PaymentDetail` | Create payment details |
| Ver lista/detalle | `read:PaymentDetail` | View payment details |
| Editar | `update:PaymentDetail` | Update payment details |
| Baja lógica | `delete:PaymentDetail` | Delete (logical) payment details |

**Notas**:
- Los 4 permisos se **auto-siembran** en el boot (`PermissionSeeder.onApplicationBootstrap`, upsert idempotente desde `PERMISSION_REGISTRY`). No hay acción manual de seed.
- Se otorgan como cualquier otro permiso, con el endpoint existente `PATCH /admin/roles/:id/permissions` (requiere `update:Role`), pasando los `Permission.id` correspondientes.
- El rol **Super Admin (`manage:all`)** ya cubre estos endpoints (el seeder lo liga automáticamente).
- Ocultar el menú/sección si el usuario no tiene `read:PaymentDetail`; ocultar los botones de crear/editar/eliminar según los permisos faltantes.

---

## 6. Guía de UI

- **Lista**: mostrar **todas** las cuentas (activas e inactivas) ordenadas por `updatedAt DESC` (ya viene así del backend). Badge de estado: `Activa` / `Inactiva`.
- **Crear**: formulario con `bankName`, `beneficiary`, `clabe` (input numérico de 18 dígitos con validación en vivo) y `accountNumber` (≥ 10 dígitos). La cuenta nace **activa**.
- **Desactivar**: botón de baja (DELETE) con **confirmación obligatoria** — "¿Desactivar esta cuenta? El bot dejará de mostrarla en el mensaje de transferencia." Es baja lógica; la fila queda visible como inactiva. **No hay hard delete.**
- **Activar**: no existe "reactivar" ni campo `isActive` editable: la cuenta nueva se **crea** (nace activa) y la vieja se **desactiva** con DELETE. No construir un toggle que mande `isActive` por PATCH (da `400`).
- **Regla operacional**: exactamente **una cuenta activa por sucursal** (no forzada por la DB). El bot lee la activa más reciente por `updatedAt`; si no hay ninguna activa, el bot recibe `404 NO_ACTIVE_PAYMENT_DETAIL` y no puede renderizar el mensaje de transferencia.
  - ⚠️ Advertencia visual recomendada: si la sucursal queda sin cuenta activa, mostrar un banner "Sin cuenta activa — el bot no puede cobrar por transferencia".
- **CLABE duplicada**: el backend rechaza la misma CLABE dentro de la misma sucursal (`409 DUPLICATE_CLABE`); la misma CLABE en otra sucursal es válida (mostrar mensaje solo cuando aplique).

---

## 7. Checklist para frontend (integración)

- [ ] Sección "Datos bancarios" / "Cuentas de transferencia" visible solo con `read:PaymentDetail` (ocultar menú sin permiso).
- [ ] Lista con todas las cuentas (activas + inactivas), orden `updatedAt DESC`, badge de estado.
- [ ] Formulario de creación con validación: `clabe` exactamente 18 dígitos, `accountNumber` ≥ 10 dígitos (solo dígitos), `bankName`/`beneficiary` no vacíos.
- [ ] Manejo de `409 DUPLICATE_CLABE` con mensaje específico.
- [ ] Manejo de `404` (ID de otro tenant / inexistente) con "No encontrado".
- [ ] Edición parcial con `PATCH` (pre-rellenar el formulario con los valores actuales).
- [ ] Baja con `DELETE` + confirmación explícita; la fila pasa a inactiva sin desaparecer de la lista.
- [ ] No exponer controles de `isActive` en crear/editar (campo no permitido por el backend).
- [ ] Ocultar botones de crear/editar/eliminar según permisos CASL.
- [ ] Banner/alerta cuando la sucursal no tiene ninguna cuenta activa.
- [ ] (Opcional) Verificación E2E: crear cuenta → el bot muestra los datos correctos en el mensaje de transferencia (R11).

---

## 8. Notas técnicas

- **Migración**: tabla nueva `payment_detail` (modelo `PaymentDetail`): FK `tenantId` → `Tenant` (cascade on delete), `@@unique([tenantId, clabe])`, índice en `tenantId`. `prisma migrate deploy` es seguro en prod; no afecta tablas existentes.
- **Tenant isolation**: todas las queries pasan por `TenantPrismaService` (CLS). Un ID de otro tenant devuelve `404`, nunca `403`.
- **Baja lógica**: `DELETE` solo flipea `isActive=false`; no hay ruta de hard delete ni de reactivación en este slice.
- **Consumo del bot**: `GET /chatbot-api/payment-details` (scope `payment-details:read`, ServiceCredential) devuelve la cuenta activa más reciente por `updatedAt`; `404 NO_ACTIVE_PAYMENT_DETAIL` si no hay. Lo que el admin configure aquí es lo que el bot muestra al cliente.
- **Permisos nuevos**: 4 filas en la tabla `Permission` (subject `PaymentDetail`), auto-seed en boot; otorgables vía `PATCH /admin/roles/:id/permissions`.
