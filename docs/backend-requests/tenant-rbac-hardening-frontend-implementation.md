# Guía de implementación frontend — SDD `tenant-rbac-hardening`

> Este documento cubre **exclusivamente** los dos cambios mergeados el 26 de mayo de 2026
> (commits `3c33301` y `a9832d5`, merge `f54e26b`). No es un documento general de RBAC.
> No cubre BE-1 ni BE-2 — esos están documentados en
> `docs/backend-requests/tenant-members-flow-response-and-revisions.md`.

---

## 1. Resumen ejecutivo

### Qué se mergeó

El SDD `tenant-rbac-hardening` entró en `main` el **26 de mayo de 2026** (merge commit `f54e26b`) con dos commits funcionales:

| Commit | Mensaje | Qué hizo |
|---|---|---|
| `3c33301` | `refactor(authz): remove dead PATCH /admin/users/:id/roles endpoint` | Eliminó el endpoint y todo su código soporte (BE-3) |
| `a9832d5` | `feat(authz): enforce target-tenant permissions in tenant member operations` | Cerró la escalación cross-tenant en operaciones de membership (BE-4) |

### Para el frontend: dos cambios que afectan su código hoy

1. **Endpoint eliminado** — `PATCH /admin/users/:id/roles` ya no existe. Cualquier llamada a esa URL retorna **404**. No es un cambio de respuesta: es que la ruta no existe.

2. **Nuevo código de error 403** — Las operaciones de membership cross-tenant ahora pueden devolver `INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT`. Antes de este merge, un usuario con permisos altos en el Tenant A podía operar en el Tenant B sin que el backend lo bloqueara. Ahora se bloquea con 403.

### Efecto colateral aceptado por diseño

Los usuarios con rol **Cashier únicamente** ya no pueden listar miembros de su tenant. `GET /admin/tenants/:id/members` retorna 403 para ellos. Este es un cambio intencional — ver sección 4.

---

## 2. Cambio 1 — Endpoint eliminado: `PATCH /admin/users/:id/roles`

### 2.1 Qué hacía antes

El handler existía en `src/admin/admin-user.controller.ts` y delegaba a `AdminUserService.assignRoles()`. Internamente, `assignRoles` llamaba a `this.userRepo.assignRoles(userId, dto.roleIds)`, que estaba declarado en la interfaz `IUserRepository` pero cuya implementación en `PrismaUserRepository` hacía `throw new Error('deprecated — use TenantMembership')`. Cualquier llamada real a este endpoint terminaba en un **500 Internal Server Error** en runtime. El endpoint estaba funcionalmente muerto.

### 2.2 Qué pasa ahora

La ruta `PATCH /admin/users/:id/roles` no existe en el router de NestJS. NestJS retorna **404 Not Found**. No hay handler, no hay DTO, no hay método en el service.

Archivos afectados en `3c33301`:
- `src/admin/admin-user.controller.ts` — handler `assignRoles` eliminado (era líneas 58–66 antes del commit)
- `src/admin/admin-user.service.ts` — método `assignRoles` eliminado
- `src/admin/dto/assign-roles.dto.ts` — archivo eliminado
- `src/auth/domain/user.repository.ts` — método `assignRoles` eliminado de la interfaz
- `src/auth/infrastructure/prisma-user.repository.ts` — implementación deprecated eliminada
- `src/auth/auth.service.spec.ts` — mocks obsoletos eliminados

### 2.3 Por qué se eliminó

El endpoint nunca cumplió su propósito en producción. El caso de uso real — agregar un usuario existente a un tenant con un rol — ya está cubierto por `POST /admin/tenants/:tenantId/members`. El modelo de datos del sistema es a través de `TenantMembership`, no mediante asignación directa de roles globales a usuarios. Mantener una ruta que siempre tira 500 era deuda de seguridad activa.

### 2.4 Qué tiene que hacer el frontend

1. **Eliminar el componente que llama a este endpoint.** En el doc previo (`tenant-members-flow-response-and-revisions.md`, sección 2.3) ya se anticipó esto como FE-1: eliminar `UserAssignRolesSlideover` o equivalente.

2. **Eliminar cualquier llamada HTTP** de la forma:
   ```ts
   axios.patch(`/admin/users/${userId}/roles`, { roleIds: [...] })
   ```

3. **Migrar el caso de uso** a `POST /admin/tenants/:tenantId/members`:
   ```ts
   axios.post(`/admin/tenants/${tenantId}/members`, {
     userId: string,
     roleId: string,
   })
   ```
   Nota: el endpoint actual acepta un `roleId` singular, no un array. Si el caso de uso requería asignar múltiples roles en una sola operación, hay que hacer múltiples `POST` (uno por rol) o plantear la necesidad como nuevo requerimiento.

### 2.5 Ejemplo antes/después

**Antes (ROTO — tira 404 ahora):**

```ts
// Eliminar este código
async function assignRolesToUser(userId: string, roleIds: string[]) {
  return apiClient.patch(`/admin/users/${userId}/roles`, { roleIds });
}
```

**Después (correcto):**

```ts
// Crear una membership por rol
async function addMemberToTenant(
  tenantId: string,
  userId: string,
  roleId: string,
) {
  return apiClient.post(`/admin/tenants/${tenantId}/members`, {
    userId,
    roleId,
  });
}
```

### 2.6 Archivos backend afectados (commit `3c33301`)

| Archivo | Cambio |
|---|---|
| `src/admin/admin-user.controller.ts` | Handler `@Patch(':id/roles')` eliminado |
| `src/admin/admin-user.service.ts` | Método `assignRoles()` eliminado |
| `src/admin/dto/assign-roles.dto.ts` | Archivo eliminado |
| `src/auth/domain/user.repository.ts` | `assignRoles()` removido de la interfaz (`IUserRepository`) |
| `src/auth/infrastructure/prisma-user.repository.ts` | Implementación deprecated eliminada |
| `src/auth/auth.service.spec.ts` | Mocks de `assignRoles` eliminados |

---

## 3. Cambio 2 — Permission enforcement en el tenant target (BE-4)

### 3.1 Bug que se cerró

**Escenario concreto del bug:**

Un usuario U tiene dos memberships:
- `Manager` en Sucursal A → tiene `create:TenantMembership`, `read:TenantMembership`, etc.
- `Cashier` en Sucursal B → NO tiene `create:TenantMembership`.

Antes de `a9832d5`, el método `assertCanManageTenant` en `src/tenants/tenants-membership.service.ts` solo verificaba que U tuviera **alguna** membership en el tenant target. Si la tenía, pasaba. El nivel de permiso en ese tenant nunca se evaluaba.

Resultado: U podía llamar `POST /admin/tenants/TENANT_B/members` y agregar miembros a Sucursal B usando los permisos que tenía en Sucursal A. Escalación cross-tenant real.

La firma del método anterior era:

```ts
// ANTES (código eliminado en a9832d5)
private async assertCanManageTenant(tenantId: string): Promise<void> {
  // Solo verificaba existencia de membership — no nivel de permiso
}
```

### 3.2 Comportamiento nuevo

`assertCanManageTenant` ahora acepta `action` y `subject` como parámetros, y reconstruye la CASL ability **en el contexto del tenant target** (no el del JWT).

Implementación actual en `src/tenants/tenants-membership.service.ts:30-56`:

```ts
private async assertCanManageTenant(
  tenantId: string,
  action: AppActions,
  subject: AppSubjects = 'TenantMembership',
): Promise<void> {
  const { isSuperAdmin, userId } = this.cls.get();

  if (isSuperAdmin) return; // Super-admin: bypass total

  const memberships = await this.membershipRepo.findByUserAndTenant(
    userId,
    tenantId,
  );

  if (memberships.length === 0) {
    throw new ForbiddenException('TENANT_ACCESS_DENIED'); // Sin membership
  }

  // Reconstruye ability en el contexto del TARGET tenant
  const ability = await this.caslAbilityFactory.createForUser(userId, {
    tenantId,
    isSuperAdmin: false,
  });

  if (!ability.can(action, subject)) {
    throw new ForbiddenException('INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT');
  }
}
```

Cada operación de membership pasa su acción específica (`src/tenants/tenants-membership.service.ts:58-86`):

```ts
create(tenantId, dto)      → assertCanManageTenant(tenantId, 'create', 'TenantMembership')
findByTenant(tenantId)     → assertCanManageTenant(tenantId, 'read', 'TenantMembership')
update(tenantId, mid, dto) → assertCanManageTenant(tenantId, 'update', 'TenantMembership')
remove(tenantId, mid)      → assertCanManageTenant(tenantId, 'delete', 'TenantMembership')
```

### 3.3 Tabla de operaciones y permiso requerido en el tenant target

| Endpoint | Permiso requerido en el tenant de la URL |
|---|---|
| `POST /admin/tenants/:id/members` | `create:TenantMembership` |
| `GET /admin/tenants/:id/members` | `read:TenantMembership` |
| `PATCH /admin/tenants/:id/members/:mid` | `update:TenantMembership` |
| `DELETE /admin/tenants/:id/members/:mid` | `delete:TenantMembership` |

El permiso que importa es el que el usuario tiene en el tenant identificado por `:id` en la URL, **no** el del tenant en el JWT.

### 3.4 Nuevo código de error: `INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT`

HTTP status: **403 Forbidden**.

Distinguir del error preexistente `TENANT_ACCESS_DENIED`:

| Código | Significado | Cuándo ocurre |
|---|---|---|
| `TENANT_ACCESS_DENIED` | El usuario no tiene ninguna membership en el tenant target | Usuario completamente ajeno al tenant |
| `INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT` | El usuario tiene membership en el tenant target, pero su rol NO tiene el permiso específico para esa operación | Usuario conocido del tenant, pero con rol insuficiente (ej: Cashier intentando crear miembro) |

Ambos retornan HTTP 403. La diferencia está en el `message` del body.

Cuerpo de respuesta esperado para `INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT`:

```json
{
  "statusCode": 403,
  "message": "INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT",
  "error": "Forbidden"
}
```

Cuerpo de respuesta esperado para `TENANT_ACCESS_DENIED`:

```json
{
  "statusCode": 403,
  "message": "TENANT_ACCESS_DENIED",
  "error": "Forbidden"
}
```

Importante: el código de error específico va en el campo `message`, NO en el campo `error`. El campo `error` siempre dice `"Forbidden"` (es el nombre genérico del status HTTP que agrega NestJS). El interceptor del frontend debe leer `response.data.message` para distinguir entre los dos códigos.

### 3.5 Qué tiene que hacer el frontend

1. **Agregar el nuevo error code al interceptor de errores 403.** Hoy probablemente solo maneja `TENANT_ACCESS_DENIED`. Ahora hay dos códigos distintos que requieren mensajes distintos al usuario.

2. **Mostrar mensajes diferenciados:**
   - `TENANT_ACCESS_DENIED` → "No tenés acceso a esta sucursal."
   - `INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT` → "Tu rol en esta sucursal no te permite realizar esta operación."

3. **No tratar ambos igual** — aunque los dos son 403, tienen semánticas distintas. `TENANT_ACCESS_DENIED` implica que el usuario ni siquiera debería ver ese tenant en la UI. `INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT` implica que el usuario sí tiene acceso al tenant pero no al recurso específico.

### 3.6 Ejemplo de error handler

```ts
// En el interceptor HTTP (axios, fetch wrapper, etc.)
function handle403(errorCode: string, tenantName: string) {
  switch (errorCode) {
    case 'TENANT_ACCESS_DENIED':
      showError(`No tenés acceso a ${tenantName}.`);
      redirectToTenantSelector();
      break;

    case 'INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT':
      showError(
        `Tu rol en ${tenantName} no te permite realizar esta operación.`,
      );
      // No redirigir — el usuario puede seguir en el tenant
      break;

    default:
      showError('Acceso denegado.');
  }
}

// En el interceptor de respuesta
apiClient.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 403) {
      const code = error.response.data?.message;
      const tenantName = getCurrentTenantName(); // nombre del tenant activo
      handle403(code, tenantName);
    }
    return Promise.reject(error);
  },
);
```

### 3.7 Archivos backend afectados (commit `a9832d5`)

| Archivo | Cambio |
|---|---|
| `src/tenants/tenants-membership.service.ts` | `assertCanManageTenant` refactorizado — acepta `action` + `subject`, inyecta `CaslAbilityFactory`, reconstruye ability en target tenant |
| `src/tenants/tenants-membership.service.spec.ts` | Archivo nuevo — 8 casos de test que cubren super-admin bypass, no-membership, cross-tenant escalation, y action mapping |

---

## 4. Efecto colateral aceptado — Cashier pierde acceso a la lista de miembros

### 4.1 Qué pasa

Después del merge, un usuario con rol **Cashier únicamente** que llame `GET /admin/tenants/:id/members` recibe:

```json
{
  "statusCode": 403,
  "message": "INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT"
}
```

La razón es directa: el seed actual en `prisma/seed.ts:278-286` define los permisos del rol Cashier así:

```ts
// prisma/seed.ts:278-286
const cashierPermissionKeys: SeedPermissionKey[] = [
  permissionKey('Sale', 'create'),
  permissionKey('Sale', 'read'),
  permissionKey('Product', 'read'),
  permissionKey('Customer', 'read'),
  permissionKey('Brand', 'read'),
  permissionKey('Category', 'read'),
  permissionKey('GlobalPriceList', 'read'),
];
```

`TenantMembership` no está. En contraste, el Manager tiene `TenantMembership` completo en `prisma/seed.ts:271-274`:

```ts
// prisma/seed.ts:271-274
permissionKey('TenantMembership', 'create'),
permissionKey('TenantMembership', 'read'),
permissionKey('TenantMembership', 'update'),
permissionKey('TenantMembership', 'delete'),
```

Antes de BE-4, este gap no importaba porque `assertCanManageTenant` nunca verificaba permisos, solo membership. BE-4 lo expone.

### 4.2 Por qué es por diseño

Decisión #2059 (Engram observation `decision/cashier-tenant-membership-read`, registrada durante la fase de spec):

Gestionar miembros de un tenant es una función administrativa. El Cashier opera el punto de venta: crea ventas, lee productos, atiende clientes. No tiene función en recursos humanos ni en la configuración del tenant. La pantalla `/admin/sucursales/:id/miembros` es administración, no operación de POS.

Si un Cashier necesita ver quiénes son sus colegas por razones operativas (por ejemplo, para asociar una venta a un vendedor), eso es un caso de uso distinto que requiere un endpoint distinto, no el endpoint de admin de membership.

### 4.3 Implicancia para el frontend

- Si el menú "Gestionar miembros" se renderiza para usuarios Cashier, hay que ocultarlo. El chequeo es `can('read', 'TenantMembership')` con los permisos del usuario actual — Cashier lo tiene en `false`.

- Si actualmente no se muestra a Cashiers (lo cual es probable porque el mismo menú requiere acceso al módulo admin), no hay nada que hacer en UI.

- Si el frontend tiene algún flujo donde el Cashier navega a la lista de miembros aunque sea de forma indirecta, ese flujo rompe hoy. Revisar la navigation guard o los permisos de ruta para ese módulo.

### 4.4 Cómo revertir si el frontend reporta que rompe algo real

Es un cambio de una línea en `prisma/seed.ts`. Agregar en el array `cashierPermissionKeys`:

```ts
// prisma/seed.ts — dentro de cashierPermissionKeys[]
permissionKey('TenantMembership', 'read'),
```

Luego re-correr:

```bash
pnpm prisma db seed
```

No requiere migración de schema. Antes de hacer el cambio, confirmar con el equipo si el Cashier realmente necesita ver la lista o si hay un mejor endpoint para el caso de uso en cuestión.

---

## 5. Cómo el frontend chequea sus permisos para esconder/mostrar UI

### 5.1 Endpoint de permisos

`GET /auth/me/permissions` — ya existe desde antes de este SDD. Retorna el set de permisos del usuario en el tenant activo del JWT. Ver `docs/backend-requests/rbac-frontend-permissions-audit.md` para el shape completo de la respuesta.

### 5.2 Permisos relevantes para el módulo de miembros

Después de este SDD, los permisos que controlan qué puede hacer el usuario en el módulo de miembros son:

| Permiso | Elemento de UI que controla |
|---|---|
| `read:TenantMembership` | Mostrar/ocultar el listado de miembros y el acceso a la sección |
| `create:TenantMembership` | Mostrar/ocultar el botón "Agregar miembro" |
| `update:TenantMembership` | Mostrar/ocultar la acción "Cambiar rol" en cada fila |
| `delete:TenantMembership` | Mostrar/ocultar la acción "Quitar miembro" en cada fila |

### 5.3 Helper `can(action, subject)`

El frontend ya tiene (o debería tener) un helper que recibe el array de permisos del usuario y responde si puede hacer algo. Referencia: `docs/backend-requests/rbac-frontend-permissions-audit.md`.

```ts
// Uso esperado
if (!can('read', 'TenantMembership')) {
  // No renderizar la sección de miembros
}

if (!can('create', 'TenantMembership')) {
  // No renderizar el botón "Agregar miembro"
}
```

### 5.4 Limitación importante: permisos en tenant distinto al activo

El array de permisos retornado por `GET /auth/me/permissions` corresponde **al tenant activo del JWT actual**. Si el frontend tiene un picker que permite seleccionar un tenant diferente sin emitir un nuevo JWT, el chequeo client-side de permisos aplica solo al tenant del JWT, no al seleccionado en el picker.

En ese escenario, el backend bloquea correctamente vía `INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT`, pero el frontend puede mostrar controles que luego van a fallar. El manejo correcto es:

1. Cuando el usuario cambia de tenant activo, emitir nuevo JWT (re-login o token refresh con nuevo contexto).
2. O alternativamente, si el sistema permite operar en tenants ajenos sin re-login, tratar los 403 de membership como "permiso insuficiente en ese tenant" y actualizar la UI en consecuencia.

Hoy no existe endpoint para consultar permisos en un tenant arbitrario sin ser el tenant del JWT. Si se necesita esa funcionalidad, es un requerimiento nuevo.

---

## 6. Checklist de implementación para el frontend

En orden de prioridad:

- [ ] **1. Eliminar el endpoint muerto del cliente HTTP.** Buscar cualquier `PATCH /admin/users/:id/roles` o `PATCH /admin/users/${userId}/roles` en el código del frontend y eliminarlo.

- [ ] **2. Eliminar el componente `UserAssignRolesSlideover`** (o como se llame) que usaba ese endpoint. La funcionalidad real está en `POST /admin/tenants/:tenantId/members`.

- [ ] **3. Agregar `INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT` al interceptor de errores 403.** Sin este paso, el usuario ve un error genérico incomprensible cuando su rol no tiene permisos en el tenant target.

- [ ] **4. Verificar que la sección "Gestionar miembros" no se muestre a usuarios Cashier-only.** Chequear con `can('read', 'TenantMembership')` antes de renderizar el menú o la ruta.

- [ ] **5. (Recomendado) Agregar guards en cada acción de la tabla de miembros** usando `can(action, 'TenantMembership')` para ocultar botones de agregar/editar/eliminar según el rol del usuario actual.

- [ ] **6. Test manual cross-tenant.** Crear un usuario con Manager en Sucursal A y Cashier en Sucursal B. Autenticarse en contexto de Sucursal A. Intentar agregar un miembro a Sucursal B. Verificar que recibe 403 con `INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT`. Verificar que el mensaje en la UI es claro.

- [ ] **7. Si detectan que un Cashier necesita ver colegas** por un caso de uso legítimo, reportarlo a backend antes de modificar el seed — evaluar si el endpoint correcto para ese caso es un nuevo `/users/colleagues` o similar, no el endpoint de admin membership.

---

## 7. Lo que NO cambió

Importante para evitar confusión:

- **`GET /admin/tenants/:tenantId/members` sigue devolviendo el shape pobre** (solo IDs de memberships, sin `user.name` ni `role.name`). Eso es BE-2, que se ejecuta en el SDD siguiente (`tenant-members-api-enrichment`), pendiente de las 5 confirmaciones del frontend. Ver `docs/backend-requests/tenant-members-flow-response-and-revisions.md` sección 4 para el contrato revisado.

- **No hay endpoint de "usuarios elegibles"** para el picker de agregar miembro. Eso es BE-1, mismo SDD siguiente.

- **El seed de permisos no cambió** para el rol Manager ni para los demás roles. Manager sigue teniendo exactamente los mismos 26 permisos que tenía después de `rbac-coverage-completion`. La única diferencia de comportamiento es que ahora esos permisos **se verifican en el tenant de la operación**, no solo en el del JWT.

- **Ningún endpoint cambió su URL, su DTO de request ni el shape de su response.** Los 4 endpoints de membership (`POST`, `GET`, `PATCH`, `DELETE` sobre `/admin/tenants/:id/members`) tienen exactamente el mismo contrato que antes — solo cambiaron sus controles de autorización internos.

- **`PATCH /admin/users/:id`** (sin `/roles`) sigue existiendo. Solo se eliminó el sub-path `/:id/roles`. La edición de datos de usuario (`UpdateUserDto`) no se tocó.

---

## 8. Endpoints relacionados — estado post-merge

| Endpoint | Estado | Notas |
|---|---|---|
| `POST /admin/tenants/:id/members` | Reforzado por BE-4 | Requiere `create:TenantMembership` en el tenant de la URL |
| `GET /admin/tenants/:id/members` | Reforzado por BE-4 | Requiere `read:TenantMembership` en el tenant de la URL. Cashier sin acceso por decisión de diseño |
| `PATCH /admin/tenants/:id/members/:mid` | Reforzado por BE-4 | Requiere `update:TenantMembership` en el tenant de la URL |
| `DELETE /admin/tenants/:id/members/:mid` | Reforzado por BE-4 | Requiere `delete:TenantMembership` en el tenant de la URL |
| `PATCH /admin/users/:id/roles` | **Eliminado — 404** | Ruta inexistente desde `3c33301`. Todo código que la use falla hoy |

---

## 9. Referencias

- **Commits del SDD**: `3c33301` (BE-3), `a9832d5` (BE-4), merge `f54e26b`
- **Doc de contratos pendientes (BE-1/BE-2)**: `docs/backend-requests/tenant-members-flow-response-and-revisions.md`
- **Doc general de RBAC y permisos**: `docs/backend-requests/rbac-frontend-permissions-audit.md`
- **Q&A original del flow de members**: `docs/backend-requests/tenant-members-flow-frontend-qa.md`
- **Engram observations**: proposal #2054, spec #2056, design #2060, archive-report #2067, decision/cashier #2059

---

## 10. Changelog

| Campo | Valor |
|---|---|
| Fecha del documento | 2026-05-26 |
| SDD documentado | `tenant-rbac-hardening` |
| Commits | `3c33301` (BE-3), `a9832d5` (BE-4), merge `f54e26b` |
| HEAD de `main` post-merge | `f54e26b` |
| Engram observations | #2054, #2056, #2060, #2067, #2059 |
| Autor | Backend team |
