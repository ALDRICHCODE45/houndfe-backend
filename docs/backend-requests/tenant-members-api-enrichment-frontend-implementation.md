# Guia de implementacion frontend — SDD `tenant-members-api-enrichment`

> Este documento cubre **exclusivamente** los dos cambios mergeados el 26 de mayo de 2026
> (commits `2b24448` y `7ee5f7d`, merge `92da47b`). Para los cambios de seguridad anteriores
> (endpoint eliminado + permission enforcement cross-tenant) ver
> `docs/backend-requests/tenant-rbac-hardening-frontend-implementation.md`.

---

## 1. Resumen ejecutivo

### Que se mergeo

El SDD `tenant-members-api-enrichment` entro en `main` el **26 de mayo de 2026** (merge commit `92da47b`) con dos commits funcionales:

| Commit | Mensaje | Que hizo |
|---|---|---|
| `2b24448` | `feat(tenants): enrich member list with user, role and createdAt` | Enriquecio el response de GET members con user/role embebidos y campo createdAt (BE-2) |
| `7ee5f7d` | `feat(tenants): add eligible-users endpoint for member picker` | Nuevo endpoint para listar usuarios elegibles para agregar como miembros (BE-1) |

### Para el frontend: dos cambios que afectan su codigo hoy

1. **BREAKING**: `GET /admin/tenants/:tenantId/members` ahora devuelve `{ data: [...] }` en lugar de un array plano. Cualquier deserializacion que asuma array directo **se va a romper**. Los items dentro de `data` ahora incluyen `user` y `role` embebidos y un campo `createdAt`.

2. **NUEVO**: `GET /admin/tenants/:tenantId/eligible-users` existe para el picker de "Agregar miembro". Paginado, con search, filtro de inactivos, y gated por `create:TenantMembership` en el tenant target.

### Nota sobre la migracion Prisma

El backend corre la migracion via `pnpm prisma migrate deploy` en produccion. Si el frontend tiene una replica local del schema para desarrollo, correr `pnpm prisma migrate dev` para aplicar la migracion `20260526202414_add_tenant_membership_created_at`. Si solo consumen la API, no necesitan hacer nada con Prisma.

---

## 2. Cambio 1 — `GET /admin/tenants/:tenantId/members` enriquecido (BREAKING)

### 2.1 Que hacia antes

El handler de GET en `src/tenants/tenants-members.controller.ts` llamaba al metodo thin `findByTenant()` que retornaba un array plano de `TenantMembership` con solo `id`, `userId`, `tenantId`, `roleId` — sin ningun `include` de Prisma (`src/tenants/tenants-membership.service.ts:70-73`).

El cuerpo de la respuesta HTTP era directamente ese array:

```json
[
  { "id": "uuid", "userId": "uuid", "tenantId": "uuid", "roleId": "uuid" }
]
```

Por eso la UI mostraba "Rol desconocido" — el frontend solo recibia IDs sin resolver.

### 2.2 Que hace ahora

El handler de GET en `src/tenants/tenants-members.controller.ts:39-44` llama al nuevo metodo `findByTenantDetailed(tenantId)` y envuelve el resultado en `{ data }`:

```ts
// src/tenants/tenants-members.controller.ts:39-44
@Get()
@RequirePermissions(['read', 'TenantMembership'])
async findByTenant(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
  const data = await this.tenantsMembershipService.findByTenantDetailed(tenantId);
  return { data };
}
```

El metodo `findByTenantDetailed` en `src/tenants/tenants-membership.service.ts:75-87` hace un `findMany` con `include` de Prisma:

```ts
// src/tenants/tenants-membership.service.ts:75-87
async findByTenantDetailed(tenantId: string): Promise<TenantMembershipDetailedDto[]> {
  await this.assertCanManageTenant(tenantId, 'read', 'TenantMembership');
  return this.tenantPrisma.getClient().tenantMembership.findMany({
    where: { tenantId },
    include: {
      user: { select: { id: true, email: true, name: true, isActive: true } },
      role: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}
```

La interfaz de respuesta esta definida en `src/tenants/dto/tenant-membership-detailed.dto.ts:1-9`:

```ts
// src/tenants/dto/tenant-membership-detailed.dto.ts:1-9
export interface TenantMembershipDetailedDto {
  id: string;
  userId: string;
  tenantId: string;
  roleId: string;
  createdAt: Date;
  user: { id: string; email: string; name: string; isActive: boolean };
  role: { id: string; name: string };
}
```

Nuevo campo `createdAt`: es `Date` en el domain entity (`src/tenants/domain/tenant-membership.entity.ts:6`), serializado como string ISO 8601 en el JSON de respuesta.

El orden es `createdAt: 'desc'` — miembros mas recientes primero.

### 2.3 Shape exacto de la respuesta

```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "userId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "tenantId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "roleId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "createdAt": "2026-05-26T20:24:00.000Z",
      "user": {
        "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        "email": "cajero@houndfe.com",
        "name": "Cajero Centro",
        "isActive": true
      },
      "role": {
        "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "name": "Cashier"
      }
    }
  ]
}
```

### 2.4 Sobre `createdAt` en filas pre-existentes

La migracion `prisma/migrations/20260526202414_add_tenant_membership_created_at/migration.sql:2` es:

```sql
ALTER TABLE "tenant_memberships" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
```

Las membresías creadas **antes** de este merge tienen `createdAt` con el timestamp del momento en que se corrio la migracion, no la fecha original de creacion de la membership. Esto fue aceptado como tradeoff conocido (confirmaciones #2071, P3).

Recomendacion de UX: mostrar "aprox." al lado de fechas para membresías viejas, o directamente no mostrar la fecha si confunde. La decision es del frontend — el backend entrega el campo tal cual.

### 2.5 Que tiene que cambiar el frontend

1. **Deserializer**: `response.data` ahora es un objeto `{ data: [...] }`, no un array. Donde antes se hacia `response.data.map(...)`, ahora hay que hacer `response.data.data.map(...)` o destructurar: `const { data: members } = response.data`.

2. **TanStack Query / SWR**: Si usan un `select` para transformar la data, ajustar para extraer `.data` del envelope antes de pasar a los componentes.

3. **Renderizado de tabla**: Ya no hace falta hacer N+1 calls para resolver `user.name` ni `role.name` — vienen embebidos. Cada item tiene `membership.user.name`, `membership.user.email`, `membership.user.isActive` y `membership.role.name` directo.

4. **Componente "Rol desconocido"**: El componente que mostraba "Rol desconocido" puede ahora usar `membership.role.name` directamente. Eliminar el fallback y el codigo zombie.

5. **Campo `createdAt`**: Disponible como string ISO 8601 en el JSON. Si necesitan un objeto `Date`, parsear con `new Date(membership.createdAt)`.

### 2.6 Ejemplo de migracion del codigo frontend

```ts
// ANTES (deserializer)
const memberships = await api.get<Membership[]>(
  `/admin/tenants/${tenantId}/members`,
);
// memberships.data era el array directo

// DESPUES
const response = await api.get<{ data: MembershipDetailed[] }>(
  `/admin/tenants/${tenantId}/members`,
);
const members = response.data.data;
// members es ahora el array

// Alternativa con destructure
const { data: { data: members } } = await api.get<{ data: MembershipDetailed[] }>(
  `/admin/tenants/${tenantId}/members`,
);

// Tipo TypeScript a usar en el frontend (espejo del DTO backend)
interface MembershipDetailed {
  id: string;
  userId: string;
  tenantId: string;
  roleId: string;
  createdAt: string; // ISO 8601 en JSON, parsear con new Date() si necesitan Date
  user: {
    id: string;
    email: string;
    name: string;
    isActive: boolean;
  };
  role: {
    id: string;
    name: string;
  };
}
```

Con TanStack Query:

```ts
// ANTES
const { data: memberships } = useQuery({
  queryKey: ['members', tenantId],
  queryFn: () => api.get<Membership[]>(`/admin/tenants/${tenantId}/members`),
  select: (res) => res.data, // res.data era el array
});

// DESPUES
const { data: memberships } = useQuery({
  queryKey: ['members', tenantId],
  queryFn: () =>
    api.get<{ data: MembershipDetailed[] }>(
      `/admin/tenants/${tenantId}/members`,
    ),
  select: (res) => res.data.data, // res.data es { data: [...] }, extraer el array
});
```

### 2.7 Archivos backend afectados (commit `2b24448`)

| Archivo | Cambio |
|---|---|
| `prisma/schema.prisma:824-838` | `createdAt DateTime @default(now())` agregado a `TenantMembership` |
| `prisma/migrations/20260526202414_add_tenant_membership_created_at/migration.sql` | Migracion: `ALTER TABLE ... ADD COLUMN "createdAt"` |
| `src/tenants/domain/tenant-membership.entity.ts:1-7` | `createdAt: Date` agregado a la interfaz |
| `src/tenants/tenants-membership.service.ts:75-87` | Nuevo metodo `findByTenantDetailed` con Prisma include |
| `src/tenants/tenants-members.controller.ts:39-44` | Handler GET actualizado: llama `findByTenantDetailed`, wrappea en `{ data }` |
| `src/tenants/dto/tenant-membership-detailed.dto.ts` | Archivo nuevo — interfaz de respuesta detallada |

---

## 3. Cambio 2 — Nuevo endpoint `GET /admin/tenants/:tenantId/eligible-users`

### 3.1 Para que sirve

Listar usuarios de la plataforma que pueden ser agregados como miembros del tenant — es decir, users que **no** son ya miembros del tenant target. El caso de uso principal es el picker de "Agregar miembro".

Este endpoint reemplaza cualquier workaround anterior que el frontend tenia que hacer (forzar switch-tenant + `GET /admin/users` con filtros, o construir la lista de elegibles client-side).

### 3.2 Contrato del endpoint

| Aspecto | Valor |
|---|---|
| Metodo/Path | `GET /admin/tenants/:tenantId/eligible-users` |
| Auth | JWT obligatorio (`JwtAuthGuard`) |
| Permiso | `create:TenantMembership` en el tenant target |
| Service-level | `assertCanManageTenant(tenantId, 'create', 'TenantMembership')` (defensa en profundidad, `src/tenants/tenants-membership.service.ts:93`) |
| Scope | tenant-scoped |
| Controller | `TenantsController` (`src/tenants/tenants.controller.ts:53-60`) — decision #2103 |

Sobre la decision de ruta (#2103): el endpoint esta montado en `TenantsController` (base `/admin/tenants`) y no en `TenantsMembersController` (base `/admin/tenants/:tenantId/members`) porque el path `/admin/tenants/:tenantId/eligible-users` no puede expresarse bajo la base path del controller de members sin romper rutas existentes o generar conflictos de UUID matching.

### 3.3 Query params

| Param | Tipo | Default | Validacion | Descripcion |
|---|---|---|---|---|
| `search` | `string` | — (opcional) | Trim automatico via `@Transform`. Si `trim().length === 1` → 400. Si `trim() === ''` → no aplica filtro | Filtro case-insensitive sobre `email` OR `name` |
| `page` | `number` | `1` | `@IsInt()`, `@Min(1)` | Pagina actual |
| `limit` | `number` | `20` | `@IsInt()`, `@Min(1)`, `@Max(100)` | Items por pagina |
| `includeInactive` | `boolean` | `false` | `@IsBoolean()`, `@Type(() => Boolean)` | Si `true`, incluye users con `isActive=false` |

DTO completo en `src/tenants/dto/list-eligible-users-query.dto.ts:1-27`. El `@Transform` en linea 7 trimmea el `search` antes de que llegue al service.

### 3.4 Validacion de `search` con minimo 2 caracteres

El service en `src/tenants/tenants-membership.service.ts:97-99` valida:

```ts
// src/tenants/tenants-membership.service.ts:97-99
if (search !== undefined && search.length === 1) {
  throw new BadRequestException('SEARCH_QUERY_TOO_SHORT');
}
```

Comportamiento:

| Input de `search` | Valor despues de trim | Resultado |
|---|---|---|
| No enviado / `undefined` | — | Sin filtro. Devuelve todos los elegibles paginados |
| `""` (string vacio) | `""` | `search.length === 0` → sin filtro (no entra en la condicion `=== 1`) |
| `"  j  "` | `"j"` | `search.length === 1` → 400 `SEARCH_QUERY_TOO_SHORT` |
| `"ju"` | `"ju"` | `search.length >= 2` → filtra case-insensitive en `email` OR `name` |
| `"Juan Garcia"` | `"Juan Garcia"` | Filtra case-insensitive en `email` OR `name` |

El filtro se aplica en `src/tenants/tenants-membership.service.ts:104-111`:

```ts
// src/tenants/tenants-membership.service.ts:104-111
...(search && search.length >= 2
  ? {
      OR: [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ],
    }
  : {}),
```

Recomendacion al frontend: implementar debounce (300ms o similar) + chequeo client-side de `enabled: trimmed.length === 0 || trimmed.length >= 2` antes de disparar la query. Esto evita requests que van a devolver 400 y mejora la UX.

### 3.5 Filtro de inactivos

Default `includeInactive=false` → solo retorna users con `isActive: true`.

Implementado en `src/tenants/tenants-membership.service.ts:101-102`:

```ts
// src/tenants/tenants-membership.service.ts:101-102
const where: Prisma.UserWhereInput = {
  ...(includeInactive ? {} : { isActive: true }),
```

Para casos de recovery admin donde necesiten agregar un usuario inactivo al tenant, pasar `?includeInactive=true`. En el picker normal del dia a dia, no pasar el param (o pasar `false`).

### 3.6 Paginacion

- `page` (default `1`, min `1`): pagina actual.
- `limit` (default `20`, min `1`, max `100`): items por pagina.

Si `limit > 100` → 400 por validacion de DTO (`@Max(100)` en `src/tenants/dto/list-eligible-users-query.dto.ts:20`). No se silencia ni se capea — es un error de validacion explicito.

Skip/take en `src/tenants/tenants-membership.service.ts:114`:

```ts
const skip = (page - 1) * limit;
```

`meta` se calcula en `src/tenants/tenants-membership.service.ts:127-134`:

```ts
meta: {
  total,
  page,
  limit,
  totalPages: Math.ceil(total / limit),
},
```

El `total` se obtiene con un `count()` paralelo al `findMany` (`src/tenants/tenants-membership.service.ts:116-125`).

### 3.7 Shape exacto de la respuesta

```json
{
  "data": [
    {
      "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "email": "juan@example.com",
      "name": "Juan Garcia",
      "isActive": true
    }
  ],
  "meta": {
    "total": 42,
    "page": 1,
    "limit": 20,
    "totalPages": 3
  }
}
```

Definido en `src/tenants/dto/eligible-users-list.dto.ts:1-18`. Cada item tiene `id`, `email`, `name`, `isActive` — nada mas. No se expone password hash, createdAt, ni roles.

### 3.8 Errores posibles

| HTTP | `message` | Cuando ocurre |
|---|---|---|
| 400 | `SEARCH_QUERY_TOO_SHORT` | `search` con exactamente 1 char despues de trim (`src/tenants/tenants-membership.service.ts:97-99`) |
| 400 | Varios (class-validator) | `limit > 100`, `page < 1`, tipos invalidos en query params |
| 401 | (generico de NestJS) | Sin JWT |
| 403 | `TENANT_ACCESS_DENIED` | User sin membership en el tenant target Y no es super-admin (`src/tenants/tenants-membership.service.ts:51-53`) |
| 403 | `INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT` | User es miembro del tenant pero su rol no tiene `create:TenantMembership` (`src/tenants/tenants-membership.service.ts:60-62`) |

Recordatorio: el shape del body de 4xx de NestJS es `{ statusCode, message, error }`. El codigo especifico va en `message`, no en `error`. El campo `error` siempre dice el nombre generico del status HTTP (ej: `"Bad Request"`, `"Forbidden"`). Leer `response.data.message` para distinguir entre codigos.

### 3.9 Que tiene que hacer el frontend

1. **Reemplazar cualquier workaround anterior** del picker "Agregar miembro" por una integracion directa con `GET /admin/tenants/:tenantId/eligible-users`.

2. **Implementar debounce + min 2 chars** antes de disparar la query. Si `trimmed.length === 1`, no hacer el request — el backend va a devolver 400. Si `trimmed.length === 0`, el request es valido (devuelve todos los elegibles sin filtro de busqueda).

3. **Manejar paginacion**: el default de 20 items esta bien para un picker. Opcionalmente exponer "ver mas" o scroll infinito si el listado de elegibles es grande.

4. **Ocultar el boton "Agregar miembro"** si el rol en el tenant del JWT no incluye `create:TenantMembership`. Chequeo client-side via `GET /auth/me/permissions` (ya documentado en `docs/backend-requests/rbac-frontend-permissions-audit.md`). Esto evita que el usuario abra el picker y reciba 403 al intentar buscar elegibles.

5. **Manejar errores 403 diferenciados**: `TENANT_ACCESS_DENIED` vs `INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT` (ya implementado desde SDD-1, pero verificar que el interceptor cubra este endpoint tambien).

### 3.10 Ejemplo de integracion del picker

```ts
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

// Hook para debounce (o usar el de su libreria preferida)
function useDebounce(value: string, delay: number): string {
  const [debouncedValue, setDebouncedValue] = useState(value);
  // implementacion estandar con useEffect + setTimeout
  return debouncedValue;
}

// En el componente del picker
function MemberPicker({ tenantId }: { tenantId: string }) {
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebounce(searchInput, 300);
  const trimmed = debouncedSearch.trim();

  // Habilitar query cuando: sin filtro (0 chars) O filtro valido (2+ chars)
  const enabled = trimmed.length === 0 || trimmed.length >= 2;

  const { data, isLoading, error } = useQuery({
    queryKey: ['eligible-users', tenantId, trimmed],
    queryFn: () =>
      apiClient.get<EligibleUsersList>(
        `/admin/tenants/${tenantId}/eligible-users`,
        { params: { search: trimmed || undefined, page: 1, limit: 20 } },
      ),
    enabled,
    select: (res) => res.data, // extraer { data, meta } del envelope de axios
  });

  // data.data = array de usuarios elegibles
  // data.meta = { total, page, limit, totalPages }
}

// Tipos TypeScript (espejo de los DTOs backend)
interface EligibleUser {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
}

interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface EligibleUsersList {
  data: EligibleUser[];
  meta: PaginationMeta;
}
```

### 3.11 Archivos backend que implementan esto (commit `7ee5f7d`)

| Archivo | Cambio |
|---|---|
| `src/tenants/tenants.controller.ts:53-60` | Nuevo handler `findEligibleUsers` con `@RequirePermissions(['create', 'TenantMembership'])` |
| `src/tenants/tenants-membership.service.ts:89-136` | Nuevo metodo `findEligibleUsers` con search, pagination, filtro de inactivos |
| `src/tenants/dto/list-eligible-users-query.dto.ts` | Archivo nuevo — query DTO con validacion class-validator |
| `src/tenants/dto/eligible-users-list.dto.ts` | Archivo nuevo — interfaces de respuesta |

---

## 4. Migracion Prisma del lado backend (no afecta al frontend directamente)

### 4.1 Que hace la migracion

`prisma/migrations/20260526202414_add_tenant_membership_created_at/migration.sql:2`:

```sql
ALTER TABLE "tenant_memberships" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
```

Agrega la columna `createdAt` a la tabla `tenant_memberships` con default `CURRENT_TIMESTAMP`.

El modelo Prisma actualizado esta en `prisma/schema.prisma:824-838`:

```prisma
model TenantMembership {
  id        String   @id @default(uuid())
  userId    String
  tenantId  String
  roleId    String
  createdAt DateTime @default(now())

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  role   Role   @relation(fields: [roleId], references: [id], onDelete: Cascade)

  @@unique([userId, tenantId, roleId])
  @@index([tenantId])
  @@map("tenant_memberships")
}
```

### 4.2 Timestamp de filas existentes

Las filas existentes obtuvieron `CURRENT_TIMESTAMP` del momento en que se corrio la migracion — no la fecha real de creacion de cada membership. No hay forma de recuperar la fecha original porque el campo no existia antes.

### 4.3 Relevancia para el frontend

Solo el backend corre la migracion. El frontend **no** necesita hacer nada con Prisma. Esta seccion esta aca solo para que el frontend entienda por que `createdAt` puede tener valores "raros" (varias membresías con exactamente el mismo timestamp) en membresías que ya existian antes del merge.

---

## 5. Comportamientos heredados de SDD-1 que siguen vigentes

Los siguientes comportamientos del SDD anterior (`tenant-rbac-hardening`) no cambiaron con este merge:

- **Cashier-only NO puede ver `GET /admin/tenants/:id/members`** → 403 con `INSUFFICIENT_PERMISSIONS_IN_TARGET_TENANT`. El Cashier no tiene `read:TenantMembership` en el seed (decision #2059). Para dropdowns operativos (asignar vendedor, etc.) usar `GET /users/assignable` (`src/users/users.controller.ts:14-18`) que requiere `read:Sale` — permiso que el Cashier si tiene.

- **Permission enforcement en target tenant**: si un user es Manager en Sucursal A y Cashier en Sucursal B, al intentar operar en B (incluyendo el nuevo `eligible-users`) recibe 403 porque su rol en B no tiene los permisos necesarios. La defensa es `assertCanManageTenant` en `src/tenants/tenants-membership.service.ts:37-63`.

- **Endpoint `PATCH /admin/users/:id/roles` sigue eliminado** → 404. La funcionalidad de asignar roles esta en `POST /admin/tenants/:tenantId/members`.

---

## 6. Checklist de implementacion para el frontend

En orden de prioridad:

- [ ] **1. Actualizar el deserializer de `GET /admin/tenants/:tenantId/members`** para extraer `data` del envelope. BREAKING — sin esto, la pantalla de miembros queda rota. Donde antes era `response.data` (array), ahora es `response.data.data` (array dentro de objeto).

- [ ] **2. Actualizar el componente de la tabla de miembros** para usar `user.name`, `user.email`, `role.name`, `user.isActive` directos del response. Ya no se necesitan calls separados para resolver nombres.

- [ ] **3. Eliminar el codigo zombie de "Rol desconocido"** — el fallback ya no es necesario porque `role.name` viene en cada item.

- [ ] **4. Decidir UX para `createdAt`**: mostrar siempre, mostrar con "aprox." para fechas iguales al timestamp de migracion, u ocultar en filas viejas. El backend no distingue entre fechas reales y las de la migracion — todas son `DateTime`.

- [ ] **5. Implementar el picker "Agregar miembro"** contra `GET /admin/tenants/:tenantId/eligible-users` con debounce (300ms) + min 2 chars. Ver ejemplo en seccion 3.10.

- [ ] **6. Agregar manejo de `SEARCH_QUERY_TOO_SHORT`** en el interceptor de errores 400. No deberia ocurrir si el chequeo client-side esta bien (`enabled: trimmed.length >= 2`), pero defensa en profundidad.

- [ ] **7. Confirmar que el boton "Agregar miembro" solo se muestra** cuando el user tiene `create:TenantMembership` en el tenant activo. Chequear con `can('create', 'TenantMembership')` via `GET /auth/me/permissions`.

- [ ] **8. Probar manualmente**: agregar un miembro nuevo desde el picker, verificar que despues aparece en la tabla con todos los campos populados (`user.name`, `user.email`, `role.name`, `createdAt`).

- [ ] **9. Eliminar cualquier workaround previo** para el picker de miembros — los que requerian switch-tenant, llamadas a `/admin/users` con filtros, o resolucion client-side de IDs.

---

## 7. Lo que NO cambio en este SDD

Importante para evitar confusion:

- **Endpoints de auth, sales, products, etc.** — ningun cambio.

- **`POST /admin/tenants/:tenantId/members`** (crear membership) — no cambio. Sigue requiriendo `{ userId, roleId }` en el body. NO crea un user inline; el user tiene que existir previamente en la plataforma.

- **`PATCH /admin/tenants/:tenantId/members/:membershipId`** (cambiar rol) — no cambio.

- **`DELETE /admin/tenants/:tenantId/members/:membershipId`** — no cambio.

- **Permisos del Cashier no se modificaron** — sigue sin `TenantMembership:read`. El Cashier no puede acceder a ninguno de los endpoints documentados en este archivo.

- **`GET /users/assignable`** (`src/users/users.controller.ts:14-18`) — no cambio. Sigue siendo la opcion para el Cashier en dropdowns operativos (asignar vendedor, etc.). Requiere `read:Sale`.

---

## 8. Tabla de endpoints relevantes despues de este merge

| Endpoint | Estado | Quien lo usa |
|---|---|---|
| `GET /admin/tenants/:id/members` | **Modificado**: shape `{ data: [...] }` con user/role/createdAt embebidos | Manager, Super-admin |
| `GET /admin/tenants/:id/eligible-users` | **NUEVO**: listado paginado de usuarios elegibles para agregar | Manager (con `create:TenantMembership`), Super-admin |
| `POST /admin/tenants/:id/members` | Sin cambios | Manager, Super-admin |
| `PATCH /admin/tenants/:id/members/:mid` | Sin cambios | Manager, Super-admin |
| `DELETE /admin/tenants/:id/members/:mid` | Sin cambios | Manager, Super-admin |
| `GET /users/assignable` | Sin cambios (pre-existente) | Manager, Cashier, Super-admin |

---

## 9. Referencias

- **Commits del SDD**: `2b24448` (BE-2), `7ee5f7d` (BE-1), merge `92da47b`
- **Engram**: proposal #2098, spec #2099, design #2100, archive #2106
- **Decision de ruta**: #2103 — eligible-users en `TenantsController`
- **Confirmaciones previas del frontend**: `docs/backend-requests/tenant-members-api-enrichment-confirmations.md`
- **Doc SDD anterior (BE-3 + BE-4)**: `docs/backend-requests/tenant-rbac-hardening-frontend-implementation.md`
- **RBAC y permisos para UI**: `docs/backend-requests/rbac-frontend-permissions-audit.md`

---

## 10. Changelog

| Campo | Valor |
|---|---|
| Fecha del documento | 2026-05-26 |
| SDD documentado | `tenant-members-api-enrichment` |
| Commits | `2b24448` (BE-2), `7ee5f7d` (BE-1), merge `92da47b` |
| Engram observations referenciadas | #2098, #2099, #2100, #2106, #2103, #2059 |
| HEAD de `main` post-merge | `92da47b` |
| Autor | Backend team |
