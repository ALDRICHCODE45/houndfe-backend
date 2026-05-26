# Respuesta backend — Revisión de requests BE-1, BE-2, BE-3, BE-4 (tenant members flow)

## 1. Resumen ejecutivo

El backend revisó las 4 propuestas del frontend (BE-1 a BE-4) para el flujo de miembros de tenant. Se acepta la necesidad detrás de cada una, pero se introducen cambios de contrato en BE-1 por razones de seguridad, y se promueve BE-4 de "opcional" a obligatorio porque la vulnerabilidad que corrige se amplifica con BE-1. Se planifican **dos SDDs separados** para ejecutar el trabajo en orden correcto.

| Item | Propuesta frontend | Veredicto backend | Detalle |
|---|---|---|---|
| BE-1 | `GET /admin/users?notInTenant=<id>` para listar elegibles | Rechazo contrato, acepto necesidad — contrapropongo `GET /admin/tenants/:tenantId/eligible-users` | Sección 3 |
| BE-2 | Incluir user + role + `createdAt` en response de members | Acepto con 2 modificaciones (migración Prisma + breaking change de shape) | Sección 4 |
| BE-3 | Eliminar `PATCH /admin/users/:id/roles` (código muerto) | Acepto tal cual (Option A: full deletion) | Sección 5 |
| BE-4 | Fix `assertCanManageTenant` para chequear permisos reales | Acepto y promuevo a obligatorio — debe ship ANTES que BE-1 | Sección 6 |

### 5 puntos que el frontend DEBE confirmar antes de que arranquemos SDD-2

1. Cambio de URL de BE-1: `eligible-users` bajo `/admin/tenants/:tenantId/` en vez de query param en `/admin/users`
2. Default `includeInactive=false` en eligible-users
3. Migración Prisma necesaria para `createdAt` en `TenantMembership`
4. Response shape de members cambia de array plano a `{ data: [...] }` (breaking change)
5. Search en eligible-users requiere mínimo 2 caracteres

Detalle completo en sección 7.

---

## 2. Plan de ejecución acordado por backend

### 2.1 Dos SDDs separados

El trabajo se divide en dos SDDs para desacoplar lo que es seguridad interna (no requiere coordinación) de lo que es contrato público (requiere confirmación del frontend).

| SDD | Nombre | Items | Requiere frontend | Estimación |
|---|---|---|---|---|
| SDD-1 | `tenant-rbac-hardening` | BE-3 + BE-4 | NO — arranca ya | ~120 líneas netas |
| SDD-2 | `tenant-members-api-enrichment` | BE-2 + BE-1 | SI — espera las 5 confirmaciones | ~250 líneas netas |

### 2.2 Orden de ejecución

SDD-1 ANTES de SDD-2. Razón: BE-1 introduce un endpoint nuevo (`eligible-users`) que internamente usa `assertCanManageTenant`. Si `assertCanManageTenant` sigue roto cuando BE-1 se mergea, el nuevo endpoint hereda el mismo bug de escalación cross-tenant, ampliando la superficie de ataque.

Secuencia:

```
SDD-1 (BE-3 + BE-4) → merge → SDD-2 (BE-2 + BE-1) → merge coordinado con frontend
```

### 2.3 Qué puede hacer el frontend mientras tanto

- **Ahora**: Empezar a sacar `UserAssignRolesSlideover` (FE-1) — el backend no va a romper nada antes de que terminen.
- **Después de confirmar los 5 puntos**: Preparar integración con el nuevo shape de members y el nuevo endpoint `eligible-users`.
- **NO puede empezar BE-1/BE-2** hasta confirmar los 5 puntos de la sección 7.

---

## 3. BE-1 — Revisión y contrato revisado

### 3.1 Problema confirmado

El endpoint `GET /admin/users` (`src/admin/admin-user.controller.ts:36-40`) solo soporta `page` y `limit` como query params. No existe filtro `notInTenant`, `search`, ni `isActive`. Confirmado en `src/admin/admin-user.service.ts:43-97`: el service no recibe ni procesa ninguno de estos parámetros.

Para el picker de "agregar miembro existente a un tenant", hoy no hay endpoint adecuado. El workaround temporal (documentado en `docs/backend-requests/tenant-members-flow-frontend-qa.md`, sección 8, F1) requiere super-admin en contexto global y no escala.

### 3.2 Por qué rechazamos el contrato original

La propuesta del frontend es `GET /admin/users?notInTenant=<id>&search=...` con el guard chequeando permisos en el contexto del tenant del query param (no el del JWT).

Rechazamos este contrato por dos razones:

**Razón 1 — Query-param-driven auth es un antipatrón de seguridad.** Si aceptamos que un query param cambie el contexto de autorización de un endpoint, sentamos precedente para que cualquier endpoint del sistema pueda hacer lo mismo. El `PermissionsGuard` (`src/auth/authorization/guards/permissions.guard.ts:60-63`) construye la ability usando `user.tenantId` del JWT:

```ts
// src/auth/authorization/guards/permissions.guard.ts:60-63
const ability = await this.caslAbilityFactory.createForUser(user.userId, {
  tenantId: user.tenantId,
  isSuperAdmin: user.isSuperAdmin,
});
```

Agregar lógica que override este contexto desde un query param introduce una segunda fuente de verdad para el tenant, lo cual es difícil de auditar y fácil de explotar.

**Razón 2 — Rompe la convención de path-based tenant identification.** Todos los endpoints de tenant members usan el patrón `/admin/tenants/:tenantId/members`. El endpoint de users (`/admin/users`) es un recurso global. Agregar `notInTenant` a un recurso global crea ambigüedad semántica: el endpoint se convierte en "users filtrados por un tenant" sin estar bajo el path de ese tenant.

### 3.3 Contrato propuesto por backend

| Campo | Valor |
|---|---|
| **Method** | `GET` |
| **Path** | `/admin/tenants/:tenantId/eligible-users` |
| **Query params** | `search` (string, min 2 chars, trimmed), `page` (int, default 1), `limit` (int, default 20, max 100), `includeInactive` (boolean, default `false`) |
| **Auth** | JWT + `@RequirePermissions(['create', 'TenantMembership'])` |
| **Guard adicional** | `assertCanManageTenant(tenantId)` (post-BE-4: con action+subject check) |
| **Response** | `{ data: [{ id, email, name, isActive }], meta: { total, page, limit, totalPages } }` |

El endpoint vive bajo `/admin/tenants/:tenantId/` porque la operación es "listar users elegibles PARA ESTE TENANT" — el tenant es el recurso padre, no un filtro.

### 3.4 Validaciones agregadas que el frontend no pidió

| Validación | Razón |
|---|---|
| **`isActive: true` por default** | No deberías poder agregar un user soft-deleted como miembro. El frontend puede opt-in a ver inactivos con `?includeInactive=true` para flujos de admin recovery, pero el default los excluye. |
| **Search mínimo 2 caracteres** | Evitar queries sin filtro sobre toda la tabla `users`. Con 1 carácter, Prisma haría un `LIKE '%a%'` que devuelve prácticamente todos los registros. |
| **Search trim + case-insensitive** | `mode: 'insensitive'` en Prisma sobre `email` y `name`. Whitespace trimmeado antes de evaluar longitud. |

### 3.5 Query Prisma final propuesto

```ts
// Pseudo-implementación del service method
async findEligibleUsers(
  tenantId: string,
  options: { search: string; page: number; limit: number; includeInactive: boolean },
): Promise<{ data: EligibleUserDto[]; meta: PaginationMeta }> {
  await this.assertCanManageTenant(tenantId, 'create', 'TenantMembership');

  const searchTrimmed = options.search.trim();
  if (searchTrimmed.length < 2) {
    throw new BadRequestException('SEARCH_TOO_SHORT');
  }

  const where: Prisma.UserWhereInput = {
    // Excluir users que ya tienen membership en este tenant
    NOT: {
      tenantMemberships: { some: { tenantId } },
    },
    // Search case-insensitive en email y name
    OR: [
      { email: { contains: searchTrimmed, mode: 'insensitive' } },
      { name: { contains: searchTrimmed, mode: 'insensitive' } },
    ],
    // Filtro de activos (default: solo activos)
    ...(options.includeInactive ? {} : { isActive: true }),
  };

  const skip = (options.page - 1) * options.limit;

  const [users, total] = await Promise.all([
    this.prisma.user.findMany({
      where,
      select: { id: true, email: true, name: true, isActive: true },
      skip,
      take: options.limit,
      orderBy: { name: 'asc' },
    }),
    this.prisma.user.count({ where }),
  ]);

  return {
    data: users,
    meta: {
      total,
      page: options.page,
      limit: options.limit,
      totalPages: Math.ceil(total / options.limit),
    },
  };
}
```

### 3.6 Casos de prueba mínimos

| Caso | Input | Expected |
|---|---|---|
| Happy path — super-admin busca por email | `search=manager&page=1&limit=20` | Users con "manager" en email o name, excluidos los que ya son miembros del tenant |
| User ya es miembro del tenant | User A tiene membership en Tenant X | User A NO aparece en los resultados |
| User soft-deleted (default) | User B tiene `isActive=false` | User B NO aparece (default `includeInactive=false`) |
| User soft-deleted (opt-in) | `includeInactive=true` | User B SÍ aparece |
| Search demasiado corto | `search=a` | `400 SEARCH_TOO_SHORT` |
| Search vacío | `search=` (o sin param) | `400 SEARCH_TOO_SHORT` |
| Search con whitespace | `search=   m   ` | Trim → `"m"` → `400 SEARCH_TOO_SHORT` |
| Manager sin `create:TenantMembership` en target tenant | Manager con Cashier en Tenant B, logueado en A | `403 TENANT_ACCESS_DENIED` (post-BE-4) |
| Paginación | `page=2&limit=5` con 12 resultados | `data`: items 6-10, `meta.totalPages`: 3 |

### 3.7 Confirmación requerida del frontend

Ver sección 7, puntos 1, 2 y 5.

---

## 4. BE-2 — Revisión y modificaciones

### 4.1 Problema confirmado

El endpoint `GET /admin/tenants/:tenantId/members` devuelve un shape incompleto. El repo `PrismaTenantMembershipRepository.findByTenant()` en `src/tenants/infrastructure/prisma-tenant-membership.repository.ts:43-44` hace:

```ts
async findByTenant(tenantId: string): Promise<TenantMembership[]> {
  return this.prisma.tenantMembership.findMany({ where: { tenantId } });
}
```

Sin `include` de user ni de role. La entidad `TenantMembership` (`src/tenants/domain/tenant-membership.entity.ts:1-6`) es:

```ts
export interface TenantMembership {
  id: string;
  userId: string;
  tenantId: string;
  roleId: string;
}
```

El frontend recibe solo IDs — imposible renderizar una tabla de miembros sin N+1 calls.

### 4.2 Hallazgo crítico: `createdAt` no existe en el schema

Verificado en `prisma/schema.prisma:824-837`:

```prisma
model TenantMembership {
  id       String @id @default(uuid())
  userId   String
  tenantId String
  roleId   String

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  role   Role   @relation(fields: [roleId], references: [id], onDelete: Cascade)

  @@unique([userId, tenantId, roleId])
  @@index([tenantId])
  @@map("tenant_memberships")
}
```

No hay campo `createdAt` ni `updatedAt`. Agregar `createdAt DateTime @default(now())` requiere una migración Prisma. Las filas existentes recibirán el timestamp del momento en que se corra la migración — no la fecha real de creación de la membership. Esto es aceptable pero debe documentarse para el frontend (no mostrar "Miembro desde..." para memberships anteriores a la migración, o mostrar un label "aprox.").

### 4.3 Hallazgo crítico: wrapping en `{ data: [...] }` es breaking change

Hoy el endpoint devuelve un **array plano**:

```json
[
  { "id": "abc", "userId": "...", "tenantId": "...", "roleId": "..." }
]
```

La propuesta cambia esto a un **objeto con key `data`**:

```json
{
  "data": [
    { "id": "abc", "userId": "...", "tenantId": "...", "roleId": "...", "user": {...}, "role": {...}, "createdAt": "..." }
  ]
}
```

Esto rompe cualquier deserialización frontend que espere un array directo. Es un cambio correcto (permite agregar `meta` para paginación sin otro breaking change) pero requiere release coordinado.

### 4.4 Response shape definitivo

```json
{
  "data": [
    {
      "id": "membership-uuid",
      "userId": "user-uuid",
      "tenantId": "tenant-uuid",
      "roleId": "role-uuid",
      "createdAt": "2026-05-25T14:30:00.000Z",
      "user": {
        "id": "user-uuid",
        "email": "manager@houndfe.com",
        "name": "Manager Centro",
        "isActive": true
      },
      "role": {
        "id": "role-uuid",
        "name": "Manager"
      }
    }
  ]
}
```

Notas:
- `user` incluye solo `id`, `email`, `name`, `isActive` — no password ni tokens.
- `role` incluye solo `id` y `name` — no permissions ni metadata.
- `createdAt` es ISO 8601 UTC.

### 4.5 Decisión sobre paginación

Se defiere la paginación. No se agrega `meta: { page, limit, totalPages, total }` en este SDD.

Justificación: el peor caso actual es ~200 memberships por tenant (dato del frontend). Con `include: { user: true, role: true }`, la query sigue siendo un solo `findMany` con 2 joins implícitos — performante para ese volumen. Si el frontend necesita paginación en el futuro, se puede agregar `meta` al shape sin breaking change (ya está wrapeado en `{ data: [...] }`).

### 4.6 Plan de domain layer

**Option A**: método nuevo en la interfaz del repositorio, no romper el existente.

El método actual `findByTenant(tenantId): Promise<TenantMembership[]>` se mantiene intacto (lo usa `assertCanManageTenant`, `update`, `remove`). Se agrega un método nuevo:

```ts
// En ITenantMembershipRepository (src/tenants/domain/tenant-membership.repository.ts)
findByTenantWithDetails(tenantId: string): Promise<TenantMembershipWithDetails[]>;
```

Donde `TenantMembershipWithDetails` extiende la entidad:

```ts
export interface TenantMembershipWithDetails {
  id: string;
  userId: string;
  tenantId: string;
  roleId: string;
  createdAt: Date;
  user: { id: string; email: string; name: string; isActive: boolean };
  role: { id: string; name: string };
}
```

El service `findByTenant()` pasa a usar el nuevo método para la respuesta HTTP, pero los checks internos (`update`, `remove`) siguen con el método original.

### 4.7 Migración Prisma

```prisma
// Cambio en schema.prisma
model TenantMembership {
  id        String   @id @default(uuid())
  userId    String
  tenantId  String
  roleId    String
  createdAt DateTime @default(now())  // <-- NUEVO

  // ...relaciones sin cambios
}
```

Migración:

```sql
ALTER TABLE "tenant_memberships" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
```

Todas las filas existentes recibirán `CURRENT_TIMESTAMP` del momento de la migración. El frontend debe tener esto en cuenta.

Para aplicar localmente:

```bash
pnpm prisma migrate dev --name add-created-at-to-tenant-membership
```

### 4.8 Confirmación requerida del frontend

Ver sección 7, puntos 3 y 4.

---

## 5. BE-3 — Aceptado tal cual

### 5.1 Confirmación de que es código muerto

El endpoint `PATCH /admin/users/:id/roles` llega hasta el repo y tira `Error` en runtime:

```ts
// src/auth/infrastructure/prisma-user.repository.ts:85-91
async assignRoles(userId: string, roleIds: string[]): Promise<void> {
  void userId;
  void roleIds;
  throw new Error(
    'assignRoles is deprecated. Use tenant membership assignment flow instead.',
  );
}
```

El request pasa JWT, `TenantContextGuard`, `PermissionsGuard`, DTO validation, service-level existence checks... y luego tira un `Error` genérico (no `HttpException`). NestJS lo convierte en `500 Internal Server Error`.

### 5.2 Lista exhaustiva de archivos a eliminar

| Archivo | Qué se elimina | Líneas aprox. |
|---|---|---|
| `src/admin/admin-user.controller.ts:61-68` | Método `assignRoles` + decorators | 8 |
| `src/admin/admin-user.controller.ts:28` | Import de `AssignRolesDto` | 1 |
| `src/admin/admin-user.service.ts:210-223` | Método `assignRoles` | 14 |
| `src/admin/admin-user.service.ts:29` | Import de `AssignRolesDto` | 1 |
| `src/admin/dto/assign-roles.dto.ts` | Archivo completo | 7 |
| `src/auth/domain/user.repository.ts:29` | Método `assignRoles` en interfaz `IUserRepository` | 1 |
| `src/auth/infrastructure/prisma-user.repository.ts:85-91` | Implementación `assignRoles` que tira `Error` | 7 |

### 5.3 Mock cleanup

En `src/auth/auth.service.spec.ts`, dos bloques de mock incluyen `assignRoles: jest.fn()`:

- Línea 42: primer mock de `IUserRepository`
- Línea 249: segundo mock de `IUserRepository`

Ambos se actualizan eliminando la línea `assignRoles: jest.fn()`.

### 5.4 Sin breaking changes para frontend

El frontend ya planea eliminar `UserAssignRolesSlideover` (FE-1). El endpoint devuelve 500 hoy — nadie lo consume exitosamente. Eliminarlo no rompe ningún flujo funcional.

### 5.5 No requiere confirmación

Backend procede en SDD-1. No hay impacto en contratos que el frontend consuma.

---

## 6. BE-4 — Aceptado y promovido a obligatorio

### 6.1 Confirmación del bug — trace completo

El bug está en `TenantsMembershipService.assertCanManageTenant()` (`src/tenants/tenants-membership.service.ts:24-36`):

```ts
private async assertCanManageTenant(tenantId: string): Promise<void> {
  const { isSuperAdmin, userId } = this.cls.get();
  if (isSuperAdmin) return;

  const memberships = await this.membershipRepo.findByUserAndTenant(
    userId,
    tenantId,
  );

  if (memberships.length === 0) {
    throw new ForbiddenException('TENANT_ACCESS_DENIED');
  }
}
```

Solo chequea **existencia** de membership, no **nivel de rol ni permisos efectivos**.

**Flujo de explotación concreto:**

| Step | Qué pasa | Resultado |
|---|---|---|
| User tiene: Manager en Tenant A, Cashier en Tenant B | — | — |
| JWT: `tenantId=A` (logueado en A) | — | — |
| Call: `POST /admin/tenants/B/members { userId: otro, roleId: manager_B }` | — | — |
| `TenantContextGuard`: CLS = `{ tenantId: A }` | PASA | No compara path vs JWT |
| `PermissionsGuard`: ability de Tenant A → Manager → tiene `create:TenantMembership` | PASA | Evalúa permisos en Tenant A, no en B |
| `assertCanManageTenant(B)`: user tiene membership en B (como Cashier) | PASA | Solo chequea existencia |
| **Resultado**: User con rol Cashier en B creó una membership en B | **BUG** | Escalación de privilegios |

La causa raíz: `PermissionsGuard` (`src/auth/authorization/guards/permissions.guard.ts:60-63`) construye la ability usando `user.tenantId` del JWT. Pero el `:tenantId` del path puede ser OTRO tenant. Y `assertCanManageTenant` no chequea los permisos en el tenant del path.

### 6.2 Por qué deja de ser "opcional"

BE-1 introduce `GET /admin/tenants/:tenantId/eligible-users`, un endpoint nuevo que llama `assertCanManageTenant(tenantId)`. Si BE-4 no se mergea antes:

- El endpoint nuevo hereda el mismo bug: cualquier user con membership (cualquier rol) en el target tenant puede listar eligible users.
- La superficie de ataque se AMPLÍA: antes el bug solo afectaba create/update/delete de memberships. Con BE-1, también afecta read de users elegibles.

Por eso BE-4 es prerequisito de BE-1, y SDD-1 (que contiene BE-4) se ejecuta primero.

### 6.3 Implementación propuesta: extender la firma de `assertCanManageTenant`

Firma actual:

```ts
private async assertCanManageTenant(tenantId: string): Promise<void>
```

Firma propuesta:

```ts
private async assertCanManageTenant(
  tenantId: string,
  action: AppActions,
  subject: AppSubjects,
): Promise<void>
```

Implementación:

```ts
private async assertCanManageTenant(
  tenantId: string,
  action: AppActions,
  subject: AppSubjects,
): Promise<void> {
  const { isSuperAdmin, userId } = this.cls.get();
  if (isSuperAdmin) return; // Super-admin bypass preservado

  // Reconstruir ability en el contexto del TARGET tenant (no del JWT)
  const ability = await this.caslAbilityFactory.createForUser(userId, {
    tenantId,
    isSuperAdmin: false,
  });

  if (!ability.can(action, subject)) {
    throw new ForbiddenException('TENANT_ACCESS_DENIED');
  }
}
```

Esto usa `CaslAbilityFactory.createForUser()` (`src/auth/authorization/casl-ability.factory.ts:43-69`) con el `tenantId` del PATH (target), no del JWT. Así se evalúan los permisos del rol que el user tiene en ESE tenant, no en el del JWT.

### 6.4 Nueva dependencia: inyectar `CaslAbilityFactory`

`TenantsMembershipService` actualmente inyecta:
- `ITenantMembershipRepository` (via `TENANT_MEMBERSHIP_REPOSITORY`)
- `ClsService<TenantClsStore>`

Se agrega:
- `CaslAbilityFactory`

```ts
// src/tenants/tenants-membership.service.ts — constructor actualizado
constructor(
  @Inject(TENANT_MEMBERSHIP_REPOSITORY)
  private readonly membershipRepo: ITenantMembershipRepository,
  private readonly cls: ClsService<TenantClsStore>,
  private readonly caslAbilityFactory: CaslAbilityFactory, // <-- NUEVO
) {}
```

`CaslAbilityFactory` ya es `@Injectable()` y está registrado en `AuthModule`. Solo hay que asegurarse de que `TenantsModule` importe `AuthModule` o que `CaslAbilityFactory` se exporte globalmente.

### 6.5 Cambio por método

| Método | Call actual | Call post-BE-4 |
|---|---|---|
| `create(tenantId, dto)` | `assertCanManageTenant(tenantId)` | `assertCanManageTenant(tenantId, 'create', 'TenantMembership')` |
| `findByTenant(tenantId)` | `assertCanManageTenant(tenantId)` | `assertCanManageTenant(tenantId, 'read', 'TenantMembership')` |
| `update(tenantId, id, dto)` | `assertCanManageTenant(tenantId)` | `assertCanManageTenant(tenantId, 'update', 'TenantMembership')` |
| `remove(tenantId, id)` | `assertCanManageTenant(tenantId)` | `assertCanManageTenant(tenantId, 'delete', 'TenantMembership')` |

### 6.6 Backward compatibility note

Después de este fix, un user que es Manager en Tenant A y Cashier en Tenant B **pierde la capacidad de gestionar memberships en Tenant B** (si Cashier no tiene `create:TenantMembership` / `update:TenantMembership` / etc.).

Hoy puede hacerlo "por accidente" — el check solo verificaba existencia de membership, y los permisos se evaluaban contra el tenant del JWT (A, donde sí es Manager).

Este cambio es **correcto** — el comportamiento anterior era un bug de seguridad. Pero el frontend debe saber que:
- Listar miembros (`findByTenant`) ahora exige `read:TenantMembership` en el target tenant.
- Si el Cashier del seed no tiene `read:TenantMembership`, un Cashier no podrá ver la lista de miembros. Verificar contra el seed y los permisos del rol Cashier en `docs/backend-requests/rbac-frontend-permissions-audit.md`.

### 6.7 Performance

El fix agrega 1 query extra por operación: `CaslAbilityFactory.queryUserPermissions()` (`src/auth/authorization/casl-ability.factory.ts:119-146`) hace un `findFirst` a `tenant_memberships` con `include` de role → permissions.

Impacto: una query Prisma adicional con 2 joins implícitos. Para el volumen actual (pocos tenants, pocos roles), es despreciable. No se agrega cache por ahora — si escala, se puede cachear la ability por `(userId, tenantId)` con TTL corto.

### 6.8 No requiere confirmación

Backend procede en SDD-1. El cambio de firma de `assertCanManageTenant` es interno — no cambia ningún contrato HTTP.

---

## 7. Las 5 cosas que el frontend DEBE confirmar antes de arrancar SDD-2

### 7.1 Cambio de contrato BE-1

**Pregunta**: El endpoint de eligible users será `GET /admin/tenants/:tenantId/eligible-users` en vez de `GET /admin/users?notInTenant=<id>`. Mismos datos, distinta URL. Confirmás?

| Si dicen sí | Si dicen no | Default si no contestan en 3 días hábiles |
|---|---|---|
| Backend implementa con la URL propuesta. Frontend ajusta la integración al path nuevo. | Backend necesita una alternativa que no sea query-param-driven auth. Se discute. | Se asume SÍ. |

### 7.2 Default `includeInactive=false` en eligible-users

**Pregunta**: Por default, el endpoint excluye users con `isActive=false`. Hay algún caso real en el frontend donde necesiten ver inactivos en el picker de eligible?

| Si dicen sí (necesitan ver inactivos) | Si dicen no (default ok) | Default si no contestan en 3 días hábiles |
|---|---|---|
| Se mantiene `includeInactive=true` como opt-in y el frontend lo envía cuando necesite. El default sigue siendo `false`. | Backend implementa con `includeInactive=false` sin exponer el param en esta iteración (se agrega después si hace falta). | Se asume NO — se implementa con default `false` y el param `includeInactive` disponible pero no requerido. |

### 7.3 Migración Prisma para `createdAt` en TenantMembership

**Pregunta**: Se agrega `createdAt DateTime @default(now())` a `TenantMembership`. Cuando bajen la branch, van a tener que correr `pnpm prisma migrate dev`. Las memberships existentes recibirán la fecha de la migración (no la fecha real de creación). Confirmás?

| Si dicen sí | Si dicen no | Default si no contestan en 3 días hábiles |
|---|---|---|
| Backend agrega el campo y genera la migración. Frontend sabe que `createdAt` en memberships pre-existentes es aproximado. | Se difiere `createdAt` y se entrega el response enrichment sin ese campo. | Se asume SÍ. |

### 7.4 Shape de members cambia de array a `{ data: [...] }`

**Pregunta**: El response de `GET /admin/tenants/:tenantId/members` cambia de un array plano a `{ data: [...] }`. Es un breaking change controlado. Cuándo quieren que lo mergeemos para coordinar con su release?

| Si dicen "merge ya" | Si dicen "esperar hasta X" | Default si no contestan en 3 días hábiles |
|---|---|---|
| Backend mergea apenas esté listo. Frontend actualiza su deserialización en el mismo sprint. | Backend mergea en la fecha acordada. Frontend prepara la actualización para ese momento. | Se asume "merge cuando SDD-2 esté ready" — el frontend tiene responsabilidad de estar preparado. |

### 7.5 Search mínimo 2 caracteres en eligible-users

**Pregunta**: El search en `eligible-users` requiere mínimo 2 caracteres. Si mandan menos, devuelve `400 SEARCH_TOO_SHORT`. Confirmás? Si no, qué mínimo prefieren?

| Si dicen sí | Si dicen no (quieren otro mínimo) | Default si no contestan en 3 días hábiles |
|---|---|---|
| Backend implementa con mínimo 2. | Backend ajusta al mínimo que propongan (1 o 3). Si piden 0, hay que discutir performance. | Se asume SÍ — mínimo 2. |

---

## 8. Gotchas que el frontend no preguntó pero debería saber

### 8.1 BE-4 cambia comportamiento de TODOS los métodos de members

El fix de `assertCanManageTenant` no solo afecta `create`. Los 4 métodos del service (`create`, `findByTenant`, `update`, `remove`) pasan por `assertCanManageTenant`. Después de BE-4, **todos** van a chequear permisos específicos en el target tenant.

Esto significa que `GET /admin/tenants/:tenantId/members` (listado) ahora exige `read:TenantMembership` en el target tenant. Hoy cualquier user con membership (cualquier rol) en ese tenant puede listar. Después de BE-4, necesita el permiso explícito.

### 8.2 Usuarios cross-tenant pierden acceso "accidental"

Escenario concreto: User es Manager en Tenant A y Cashier en Tenant B. Hoy, logueado en A, puede gestionar memberships de B porque `assertCanManageTenant(B)` solo chequea existencia. Después de BE-4, la ability se reconstruye en el contexto de B → el user tiene permisos de Cashier en B → si Cashier no tiene `create:TenantMembership`, no puede crear memberships en B.

Esto es correcto pero puede sorprender al frontend si hay flujos que dependen de ese acceso "accidental".

### 8.3 Verificar permisos del rol Cashier para listado de miembros

Si el rol Cashier no tiene `read:TenantMembership` en el seed/permisos actuales, después de BE-4 un Cashier no podrá ver la lista de miembros de su propio tenant. Verificar contra el registro de permisos en `docs/backend-requests/rbac-frontend-permissions-audit.md`, sección 5.

---

## 9. Próximos pasos

| Acción | Quién | Cuándo | Dependencia |
|---|---|---|---|
| Arrancar SDD-1 (`tenant-rbac-hardening`: BE-3 + BE-4) | Backend | HOY | Ninguna — no espera respuesta |
| Refactorear `UserAssignRolesSlideover` (FE-1) | Frontend | Cuando quieran | Ninguna — backend no rompe antes |
| Confirmar los 5 puntos de la sección 7 | Frontend | ASAP | Bloquea SDD-2 |
| Arrancar SDD-2 (`tenant-members-api-enrichment`: BE-2 + BE-1) | Backend | Después de confirmación | Las 5 confirmaciones |
| Actualizar deserialización de members (array → `{ data }`) | Frontend | Coordinado con merge de SDD-2 | SDD-2 mergeado |
| Integrar `eligible-users` endpoint | Frontend | Después de merge de SDD-2 | SDD-2 mergeado |

**No puede empezar**: frontend NO puede empezar integración de BE-1/BE-2 hasta confirmar los 5 puntos y que SDD-2 se mergee.

**Sí puede empezar**: frontend puede arrancar FE-1 (sacar `UserAssignRolesSlideover`) ya. Backend no va a romper el endpoint antes de que terminen (el endpoint ya está roto con 500 — sacarlo no cambia nada funcional).

---

## 10. Referencias

| Referencia | Ubicación |
|---|---|
| Q&A original | `docs/backend-requests/tenant-members-flow-frontend-qa.md` |
| Sistema RBAC completo | `docs/backend-requests/rbac-frontend-permissions-audit.md` |
| Schema actual de `TenantMembership` | `prisma/schema.prisma:824-837` |
| Bug en `assertCanManageTenant` | `src/tenants/tenants-membership.service.ts:24-36` |
| `findByTenant` sin includes | `src/tenants/infrastructure/prisma-tenant-membership.repository.ts:43-44` |
| `PermissionsGuard` construye ability con JWT tenant | `src/auth/authorization/guards/permissions.guard.ts:60-63` |
| `CaslAbilityFactory.queryUserPermissions` usa `findFirst` | `src/auth/authorization/casl-ability.factory.ts:125-138` |
| `assignRoles` throws en runtime | `src/auth/infrastructure/prisma-user.repository.ts:85-91` |
| Controller dead endpoint | `src/admin/admin-user.controller.ts:61-68` |
| Service dead method | `src/admin/admin-user.service.ts:210-223` |
| DTO a eliminar | `src/admin/dto/assign-roles.dto.ts` |
| Mock cleanup | `src/auth/auth.service.spec.ts:42, 249` |
| Interface method a eliminar | `src/auth/domain/user.repository.ts:29` |

---

## Changelog

| Fecha | Descripción |
|---|---|
| 2026-05-25 | Creación inicial. Respuesta a requests BE-1, BE-2, BE-3, BE-4 del frontend. |
