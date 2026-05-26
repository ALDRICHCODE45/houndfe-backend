# Flujo de usuarios, membresías y tenants — Q&A para frontend

## 1. Resumen ejecutivo

El flujo de gestión de usuarios/miembros en `houndfe-backend` involucra **tres dominios acoplados** que generan confusión legítima en el frontend:

1. **Users** (`/admin/users`) — CRUD global de cuentas de usuario. Un User NO pertenece a un tenant directamente; el modelo `User` no tiene columna `tenantId`.
2. **TenantMembership** (`/admin/tenants/:tenantId/members`) — La relación entre un User y un Tenant, con un Role específico. Es la tabla join que define "este usuario trabaja en esta sucursal con este rol".
3. **Roles** — Son **per-tenant** (cada tenant tiene su propio set de roles), excepto el rol "Super Admin" que tiene `tenantId=null` (global).

**Endpoints vivos hoy:**

| Endpoint | Estado | Uso |
|---|---|---|
| `GET /admin/users` | Funcional | Lista users (scope depende del JWT) |
| `POST /admin/users` | Funcional | Crea User + Membership en el tenant del CLS |
| `GET /admin/users/:id` | Funcional | Detalle de user con roles en tenant actual |
| `PATCH /admin/users/:id` | Funcional | Actualiza nombre |
| `DELETE /admin/users/:id` | Funcional | Soft-delete (isActive=false) |
| `PATCH /admin/users/:id/roles` | MUERTO (throws en runtime) | No usar |
| `GET /admin/tenants/:tenantId/members` | Funcional, shape pobre | Lista memberships SIN datos de user/role |
| `POST /admin/tenants/:tenantId/members` | Funcional | Crea membership (user existente + role existente) |
| `PATCH /admin/tenants/:tenantId/members/:id` | Funcional | Cambia roleId de una membership |
| `DELETE /admin/tenants/:tenantId/members/:id` | Funcional | Elimina membership |
| `GET /admin/tenants/:tenantId/roles` | Funcional, solo super-admin | Lista roles del tenant |
| `GET /auth/me` | Funcional | Perfil + memberships con tenant summary |

**Qué falta:**

- `GET /admin/users?notInTenant=<id>` — No existe. Es necesario para el picker de "agregar miembro existente al tenant". Ver seccion 8.
- `GET /admin/tenants/:tenantId/members` no incluye `user.name`, `user.email`, ni `role.name` en la respuesta. El frontend recibe solo IDs. Esto requiere fix en el backend o N+1 de calls desde el frontend.
- `POST /admin/tenants/:tenantId/members` no soporta creacion inline de user. Son 2 calls separados hoy.

---

## 2. Mapa mental del modelo de datos

```
┌──────────────────────────────────────────────────────┐
│                    User (global)                     │
│  - id: UUID (PK)                                     │
│  - email: string (unique)                            │
│  - name: string                                      │
│  - isActive: boolean                                 │
│  - NO tiene tenantId                                 │
│  tabla: "users"                                      │
└──────────┬───────────────────────────────────────────┘
           │ 1:N
           ▼
┌──────────────────────────────────────────────────────┐
│            TenantMembership (join table)              │
│  - id: UUID (PK)                                     │
│  - userId: UUID (FK → User)                          │
│  - tenantId: UUID (FK → Tenant)                      │
│  - roleId: UUID (FK → Role)                          │
│  @@unique([userId, tenantId, roleId])                │
│  tabla: "tenant_memberships"                         │
└──────────┬─────────────────────┬─────────────────────┘
           │                     │
           ▼ N:1                 ▼ N:1
┌─────────────────────┐  ┌─────────────────────────────┐
│   Tenant            │  │   Role                       │
│  - id: UUID (PK)    │  │  - id: UUID (PK)             │
│  - name: string     │  │  - name: string              │
│  - slug: string     │  │  - tenantId: String? (FK)    │
│  - isActive: bool   │  │  - isSystem: boolean         │
│  tabla: "tenants"   │  │  @@unique([tenantId, name])  │
└─────────────────────┘  │  tabla: "roles"              │
                         └─────────────────────────────┘
```

### Cardinalidades

- Un **User** puede tener **N memberships** en **N tenants** con **N roles distintos**.
- Un **Tenant** tiene **N memberships** y **N roles** propios.
- Un **Role** pertenece a **un tenant** (`tenantId != null`) o es **global** (`tenantId = null`).
- La constraint `@@unique([userId, tenantId, roleId])` permite que un user tenga MULTIPLES roles en el MISMO tenant (ej: Manager + Cashier en Sucursal Centro, cada uno es una fila distinta de TenantMembership).

### Sobre `Role.tenantId` (la fuente de confusion)

Confirmado en `prisma/schema.prisma:796`:

```prisma
model Role {
  id          String   @id @default(uuid())
  name        String
  tenantId    String?                          // <-- NULLABLE
  // ...
  tenant      Tenant?  @relation(...)
  @@unique([tenantId, name])
  @@index([tenantId])
}
```

- `tenantId = null` → Rol global. Solo el "Super Admin" del seed usa esto (`prisma/seed.ts:188-189`).
- `tenantId = <uuid>` → Rol perteneciente a ese tenant. Manager y Cashier se crean PER-TENANT en el seed (`prisma/seed.ts:199-222`). Cada sucursal tiene su propio "Manager" y su propio "Cashier".

**Implicancia directa**: cuando el frontend pide roles para un dropdown de "asignar rol a un miembro", DEBE pedir `GET /admin/tenants/:tenantId/roles` y NO `GET /admin/roles`, porque el segundo devuelve roles de TODOS los tenants y el repo valida coincidencia tenant en el create (ver seccion 5, C2).

---

## 3. Respuestas — Bloque A (Scope de GET /admin/users)

### A1: Cuando un super-admin llama a `GET /admin/users`, ve TODOS los usuarios del sistema o solo los de su tenant?

**Respuesta corta**: Depende del JWT. Super-admin con `tenantId=null` ve TODOS. Super-admin con `tenantId=X` ve solo users con membership en X.

**Respuesta detallada**:

El metodo `AdminUserService.findAll()` en `src/admin/admin-user.service.ts:43-97` tiene un branch dual:

```ts
// src/admin/admin-user.service.ts:50-71
const { tenantId, isSuperAdmin } = this.cls.get();

if (isSuperAdmin && tenantId === null) {
  // Branch 1: super-admin global → query DIRECTA a tabla users, sin filtro
  const [users, total] = await Promise.all([
    this.prisma.user.findMany({ skip, take: limit }),
    this.prisma.user.count(),
  ]);
  // ...retorna todos los users del sistema
}

// Branch 2: cualquier otro caso (incluye super-admin con tenantId=X)
const [memberships, total] = await Promise.all([
  tenantPrisma.tenantMembership.findMany({
    where: { tenantId: tenantId ?? undefined },
    include: { user: true },
    skip,
    take: limit,
  }),
  tenantPrisma.tenantMembership.count({
    where: { tenantId: tenantId ?? undefined },
  }),
]);
const users = memberships.map((m) => m.user);
```

El Branch 2 filtra por `tenantId` del CLS (extraido del JWT por `TenantContextGuard`). Si el super-admin hizo `switch-tenant` a "Sucursal Centro", su JWT tiene `tenantId=<centro-uuid>` y solo ve usuarios con membership en Centro.

**Gotcha**: en el Branch 2, la paginacion cuenta memberships, no users unicos. Si un user tiene 2 memberships en el mismo tenant (ej: Manager + Cashier), se contabiliza 2 veces. Esto es un bug menor del paginado.

**Implicancia para frontend**: Si necesitas "todos los users del sistema" (ej: para un picker de admin global), el super-admin debe estar en contexto global (`tenantId=null`, sin haber hecho switch-tenant). Si hizo switch, debe volver al contexto global via `POST /auth/switch-tenant { tenantId: null }`.

---

### A2: Un Manager con permiso `read:User` ve usuarios de todos los tenants o solo del suyo?

**Respuesta corta**: Solo los de su tenant. No rompe aislamiento.

**Respuesta detallada**:

Un Manager no puede ser `isSuperAdmin=true` (esa flag solo se setea en `auth.service.ts:188-193` cuando el user tiene el rol global "Super Admin" con `manage:all`). Entonces siempre cae en el Branch 2 de `findAll()` que filtra por `tenantId` del CLS.

El `tenantId` del CLS viene del JWT (`TenantContextGuard`, `src/shared/tenant/tenant-context.guard.ts:26`), que a su vez se genera en el login. Un Manager con membership solo en Tenant A siempre tendra `tenantId=A` en su JWT. Ergo, siempre vera solo users con membership en Tenant A.

**CASL validation**: ademas, `PermissionsGuard` construye la ability del user via `CaslAbilityFactory.createForUser()` (`src/auth/authorization/casl-ability.factory.ts:43-69`). Para un non-super-admin, busca la membership del user en el `tenantId` del JWT (`queryUserPermissions`, linea 125-138) y extrae los permisos de ESE rol. Si el Manager de Tenant A tiene `read:User`, solo funciona porque el guard lo aprueba, pero el SERVICE limita los datos a Tenant A.

**Implicancia para frontend**: El frontend no necesita hacer filtros adicionales. El backend ya aisle por tenant. Pero si un Manager con membership en 2 tenants (A y B) hace switch-tenant a B, vera users de B (no de A).

---

### A3: El User tiene un campo `tenantId` o la relacion es solo via TenantMembership?

**Respuesta corta**: NO tiene. La relacion es 100% via `TenantMembership`.

**Respuesta detallada**:

Confirmado en `prisma/schema.prisma:757-774`:

```prisma
model User {
  id                  String    @id
  email               String    @unique
  hashedPassword      String
  name                String
  isActive            Boolean   @default(true)
  hashedRefreshToken  String?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  tenantMemberships TenantMembership[]
  sales             Sale[] @relation("SaleCashier")
  salesAsSeller     Sale[] @relation("SaleSeller")
  salePayments      SalePayment[]
  saleComments      SaleComment[] @relation("SaleCommentAuthor")

  @@map("users")
}
```

No existe concepto de "tenant primario" ni "tenant de origen". Un User es una entidad global. Su presencia en un tenant se define exclusivamente por la existencia de al menos una fila en `tenant_memberships` con su `userId` y ese `tenantId`.

**Implicancia para frontend**: No hay un campo "tenant" en el shape de User. Para saber a que tenants pertenece un user, hay que consultar sus memberships (via `GET /admin/users/:id` que en el branch de non-super-admin ya incluye los roles filtrados por tenant, o via `GET /auth/me` que trae `memberships[]` con tenant summary).

---

### A4: Cuando se llama a `POST /admin/users`, se crea solo el User o tambien la membership?

**Respuesta corta**: Crea AMBOS: el User en la tabla global + una TenantMembership en el tenant del CLS (si `tenantId` no es null).

**Respuesta detallada**:

`AdminUserService.create()` en `src/admin/admin-user.service.ts:138-195`:

```ts
async create(dto: CreateUserDto): Promise<ReturnType<User['toResponse']>> {
  const { tenantId } = this.cls.get();
  const email = Email.create(dto.email);

  // 1. Busca si ya existe un user con ese email
  const existing = await this.prisma.user.findUnique({
    where: { email: email.value },
  });
  const userId = existing?.id ?? crypto.randomUUID();

  // 2. Valida que roleId exista
  if (!dto.roleId) {
    throw new EntityNotFoundError('Role', 'roleId');
  }
  const role = await this.roleRepo.findById(dto.roleId);
  if (!role) throw new EntityNotFoundError('Role', dto.roleId);

  // 3. Si el user NO existe, lo crea
  if (!existing) {
    const hashedPassword = await HashedPassword.fromPlain(dto.password);
    const user = User.create({ id: userId, email, hashedPassword, name: dto.name });
    await this.userRepo.save(user);
  }

  // 4. Si hay tenantId en el CLS, crea la membership
  if (tenantId) {
    const membershipExists = await tenantPrisma.tenantMembership.findFirst({
      where: { userId, tenantId, roleId: dto.roleId },
      select: { id: true },
    });
    if (membershipExists) {
      throw new EntityAlreadyExistsError(
        'TenantMembership',
        `${userId}:${tenantId}:${dto.roleId}`,
      );
    }
    await tenantPrisma.tenantMembership.create({
      data: { userId, tenantId, roleId: dto.roleId },
    });
  }

  return finalUser.toResponse();
}
```

**Casos especiales:**

| Escenario | Resultado |
|---|---|
| Email NO existe en BD | Crea User + Membership en tenant del CLS |
| Email YA existe + NO tiene membership con ese roleId en el tenant | NO crea user nuevo, SI crea membership nueva |
| Email YA existe + YA tiene membership con ese roleId en ese tenant | Tira `EntityAlreadyExistsError` (409) |
| Super-admin en contexto global (`tenantId=null`) | Crea User pero NO crea membership (paso 4 se skipea) |

**DTO requerido** (`src/admin/dto/create-user.dto.ts:9-23`):

```ts
export class CreateUserDto {
  @IsEmail()      email: string;
  @IsString() @MinLength(8)  password: string;
  @IsString() @IsNotEmpty()  name: string;
  @IsUUID()       roleId: string;
}
```

`roleId` es obligatorio. Esto es relevante porque significa que no se puede crear un User "suelto" sin asignarle un rol (excepto super-admin global, donde igualmente se valida el roleId pero no se crea membership).

**GOTCHA CRITICO**: el `roleId` se valida contra `this.roleRepo.findById(dto.roleId)` (linea 153), que busca el rol en TODA la tabla `roles` sin filtrar por tenant. Pero la membership se crea con el `tenantId` del CLS. Si el frontend manda un `roleId` de otro tenant, la creacion del membership en Prisma puede fallar por la constraint FK o, peor, puede crearse una membership con un rol de otro tenant. SIN EMBARGO, a diferencia del endpoint de members (`POST /admin/tenants/:tenantId/members`), este endpoint de users NO valida `ROLE_TENANT_MISMATCH`. El repo de memberships (`prisma-tenant-membership.repository.ts:19-26`) si lo valida, pero `admin-user.service.ts` usa `tenantPrisma.tenantMembership.create()` directamente, salteando el repo. **Esto es un bug potencial**.

**Implicancia para frontend**: Al llamar `POST /admin/users`, el frontend DEBE enviar un `roleId` que pertenezca al tenant actual del usuario logueado. Idealmente, poblar el dropdown con `GET /admin/tenants/:tenantId/roles`.

---

## 4. Respuestas — Bloque B (Filtros y query params)

### B1: Que query params soporta `GET /admin/users` hoy?

**Respuesta corta**: Solo `page` y `limit`. No soporta busqueda, filtros, ni `notInTenant`.

**Respuesta detallada**:

El controller usa `PaginationQueryDto` (`src/admin/dto/pagination-query.dto.ts:4-17`):

```ts
export class PaginationQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number = 20;
}
```

Y el controller lo pasa directamente al service:

```ts
// src/admin/admin-user.controller.ts:38-39
findAll(@Query() query: PaginationQueryDto) {
  return this.adminUserService.findAll(query.page ?? 1, query.limit ?? 20);
}
```

**NO soporta**:
- `search` / `q` — no hay busqueda por nombre/email
- `notInTenant` — no existe forma de filtrar users que NO pertenecen a un tenant
- `tenantId` — no se puede forzar filtro por tenant desde query param (se toma del JWT)
- `isActive` — no hay filtro por estado
- `roleId` — no hay filtro por rol

**Implicancia para frontend**: Para implementar un picker de "usuarios elegibles para agregar a un tenant", HOY no hay endpoint adecuado. Ver seccion 8 (F1) para el workaround y la propuesta de endpoint nuevo.

---

### B2: Cual es el shape exacto de un item retornado por `GET /admin/tenants/:tenantId/members`?

**Respuesta corta**: Solo `{ id, userId, tenantId, roleId }`. NO incluye datos del user ni del rol.

**Respuesta detallada**:

El repo `PrismaTenantMembershipRepository.findByTenant()` en `src/tenants/infrastructure/prisma-tenant-membership.repository.ts:43-44`:

```ts
async findByTenant(tenantId: string): Promise<TenantMembership[]> {
  return this.prisma.tenantMembership.findMany({ where: { tenantId } });
}
```

No hay `include` de user ni de role. La entidad `TenantMembership` (`src/tenants/domain/tenant-membership.entity.ts:1-6`) es:

```ts
export interface TenantMembership {
  id: string;
  userId: string;
  tenantId: string;
  roleId: string;
}
```

**Response literal:**

```json
[
  {
    "id": "abc-123-def",
    "userId": "user-uuid-1",
    "tenantId": "tenant-uuid-1",
    "roleId": "role-uuid-1"
  },
  {
    "id": "abc-456-ghi",
    "userId": "user-uuid-2",
    "tenantId": "tenant-uuid-1",
    "roleId": "role-uuid-2"
  }
]
```

**NO incluye**: `user.email`, `user.name`, `user.isActive`, `role.name`, `role.id` (bueno, roleId ya esta, pero sin el name es inutil para mostrar).

**Implicancia para frontend**: Para mostrar una tabla de miembros con nombre, email y rol, el frontend tendria que hacer N+1 calls (`GET /admin/users/:id` por cada userId). Esto es claramente insuficiente y es un fix pendiente del backend: agregar `include` de `user` y `role` en el query. Mientras tanto, como workaround, el frontend puede:

1. Llamar `GET /admin/tenants/:tenantId/members` para obtener la lista de IDs
2. Llamar `GET /admin/users?page=1&limit=100` (en el contexto del mismo tenant) para obtener users con datos completos
3. Hacer el join en cliente

Pero esto es fragil e insostenible. **Se recomienda que el backend agregue el `include` al repo.**

---

### B3: Existe un endpoint para obtener usuarios "elegibles para ser miembros de un tenant"?

**Respuesta corta**: NO existe.

**Respuesta detallada**:

El frontend podria confundir `GET /users/assignable` con esta funcionalidad, pero son cosas completamente distintas:

`GET /users/assignable` (`src/users/users.controller.ts:14-17`):

```ts
@Get('assignable')
@RequirePermissions(['read', 'Sale'])
findAssignable(): Promise<AssignableUserDto[]> {
  return this.usersService.findAssignable();
}
```

Requiere permiso `read:Sale` (no `read:User`) y retorna users activos con membership en el tenant actual (`src/users/users.service.ts:9-22`):

```ts
async findAssignable(): Promise<AssignableUserDto[]> {
  const tenantId = this.tenantPrisma.getTenantId();
  return this.tenantPrisma.getClient().user.findMany({
    where: {
      isActive: true,
      tenantMemberships: { some: { tenantId } },
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}
```

Esto es para el dropdown "asignar vendedor a una venta", NO para "agregar miembro a un tenant". De hecho, hace lo OPUESTO de lo que necesita el picker de miembros: retorna users que YA estan en el tenant.

**Workaround temporal**: ver seccion 8, F1.

---

## 5. Respuestas — Bloque C (Semantica de POST /admin/tenants/:tenantId/members)

### C1: El POST de members acepta crear un user inline o solo linkea un user existente?

**Respuesta corta**: Solo linkea user existente. Acepta `{ userId, roleId }`. No soporta inline user creation.

**Respuesta detallada**:

`CreateMembershipDto` (`src/tenants/dto/create-membership.dto.ts:3-9`):

```ts
export class CreateMembershipDto {
  @IsUUID()  userId!: string;
  @IsUUID()  roleId!: string;
}
```

Solo dos campos, ambos UUIDs existentes. Si el user no existe en la tabla `users`, Prisma tirara un FK constraint error (P2003) al intentar crear la membership.

**Implicancia para frontend**: Para agregar un nuevo usuario a un tenant, hoy son 2 pasos:

1. `POST /admin/users { email, password, name, roleId }` — crea el user Y la membership en el tenant del CLS
2. Si el user ya existe y queres agregarlo a OTRO tenant: `POST /admin/tenants/:tenantId/members { userId, roleId }`

No hay forma de hacer "crear user nuevo + membership" en una sola call al endpoint de members. El endpoint `POST /admin/users` es el unico que combina ambas acciones, pero crea la membership en el tenant del JWT del caller (no en un tenant arbitrario).

---

### C2: El backend valida que el roleId pertenezca al tenant del path?

**Respuesta corta**: SI. El repo valida `ROLE_TENANT_MISMATCH` y tira 400 si el rol no pertenece al tenant.

**Respuesta detallada**:

`PrismaTenantMembershipRepository.create()` en `src/tenants/infrastructure/prisma-tenant-membership.repository.ts:14-41`:

```ts
async create(data: { userId: string; tenantId: string; roleId: string }): Promise<TenantMembership> {
  // 1. Busca el rol y verifica que pertenece al tenant correcto
  const role = await this.prisma.role.findUnique({
    where: { id: data.roleId },
    select: { tenantId: true },
  });

  if (!role || role.tenantId !== data.tenantId) {
    throw new BadRequestException('ROLE_TENANT_MISMATCH');
  }

  // 2. Intenta crear la membership
  try {
    return await this.prisma.tenantMembership.create({ data });
  } catch (error) {
    if (/* P2002 unique constraint */) {
      throw new ConflictException('TENANT_MEMBERSHIP_EXISTS');
    }
    throw error;
  }
}
```

La validacion es estricta: `role.tenantId !== data.tenantId`. Esto significa:
- Un rol con `tenantId=null` (Super Admin global) NO puede usarse para crear una membership en un tenant especifico, porque `null !== "uuid-del-tenant"`.
- Un rol de Tenant A NO puede usarse para crear una membership en Tenant B.

Lo mismo aplica al update (`prisma-tenant-membership.repository.ts:60-83`):

```ts
async update(id: string, data: { roleId: string }): Promise<TenantMembership> {
  const current = await this.prisma.tenantMembership.findUnique({
    where: { id },
    select: { tenantId: true },
  });
  // ...
  const role = await this.prisma.role.findUnique({
    where: { id: data.roleId },
    select: { tenantId: true },
  });
  if (!role || role.tenantId !== current.tenantId) {
    throw new BadRequestException('ROLE_TENANT_MISMATCH');
  }
  return this.prisma.tenantMembership.update({ where: { id }, data });
}
```

**Implicancia para frontend**: Para el dropdown de roles en el slideover de crear/editar membership, DEBE usarse `GET /admin/tenants/:tenantId/roles` (no `GET /admin/roles`). Si el frontend usa `GET /admin/roles` sin filtrar, incluira roles de otros tenants que causaran `400 ROLE_TENANT_MISMATCH` al hacer POST/PATCH.

---

### C3: Que pasa si intento crear una membership duplicada (mismo userId + tenantId + roleId)?

**Respuesta corta**: Retorna `409 Conflict` con cuerpo `TENANT_MEMBERSHIP_EXISTS`.

**Respuesta detallada**:

La tabla tiene una constraint `@@unique([userId, tenantId, roleId])` (`prisma/schema.prisma:834`). Cuando Prisma intenta insertar un duplicado, tira un error `P2002` (unique constraint violation). El repo lo atrapa y lo convierte:

```ts
// src/tenants/infrastructure/prisma-tenant-membership.repository.ts:30-40
catch (error) {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  ) {
    throw new ConflictException('TENANT_MEMBERSHIP_EXISTS');
  }
  throw error;
}
```

**Nota importante**: La constraint es sobre la TERNA completa `(userId, tenantId, roleId)`. Esto permite que un mismo user tenga MULTIPLES memberships en el mismo tenant con DIFERENTES roles. Ejemplo: un user puede ser Manager Y Cashier en Sucursal Centro (2 filas en `tenant_memberships`). Esto es un design decision del sistema, no un bug.

Sin embargo, hay que considerar que `CaslAbilityFactory.queryUserPermissions()` (`src/auth/authorization/casl-ability.factory.ts:125-138`) usa `findFirst()`:

```ts
const membership = await this.prisma.tenantMembership.findFirst({
  where: { userId, tenantId },
  include: { role: { include: { permissions: { include: { permission: true } } } } },
});
```

Esto toma SOLO LA PRIMERA membership encontrada, ignorando las demas. Si un user tiene 2 roles en el mismo tenant, CASL solo evalua los permisos del primero que Prisma devuelve (no deterministico). **Esto es un bug conocido**: el usuario tendria permisos parciales.

**Implicancia para frontend**: Aunque el schema permite multiples roles por user+tenant, el sistema de permisos solo usa el primero. El frontend deberia mostrar todos los roles (via GET members), pero saber que el permiso efectivo viene de uno solo (el primero que Prisma devuelve). Se recomienda al frontend modelar la UI como "un user tiene UN rol por tenant" hasta que el backend resuelva este gap.

---

## 6. Respuestas — Bloque D (Permisos cruzados entre tenants)

### D1: Un super-admin puede gestionar memberships de cualquier tenant?

**Respuesta corta**: SI, sin restriccion.

**Respuesta detallada**:

`TenantsMembershipService.assertCanManageTenant()` (`src/tenants/tenants-membership.service.ts:24-36`):

```ts
private async assertCanManageTenant(tenantId: string): Promise<void> {
  const { isSuperAdmin, userId } = this.cls.get();
  if (isSuperAdmin) return;  // <-- bypass total

  const memberships = await this.membershipRepo.findByUserAndTenant(userId, tenantId);
  if (memberships.length === 0) {
    throw new ForbiddenException('TENANT_ACCESS_DENIED');
  }
}
```

Si `isSuperAdmin=true` (flag del JWT), se devuelve inmediatamente sin chequear nada mas. Esto es correcto por diseño: el super-admin tiene `manage:all` en CASL y acceso a cualquier tenant.

Ademas, `PermissionsGuard` construye la ability con `manage:all` para super-admin global (`casl-ability.factory.ts:49-51`):

```ts
if (context.isSuperAdmin && context.tenantId === null) {
  can('manage', 'all');
  return build();
}
```

Para super-admin con `tenantId=X` (luego de switch-tenant), CASL busca los permisos de su membership en X. Pero `assertCanManageTenant` ya lo dejo pasar antes, asi que el check de CASL es redundante (y de todas formas el super-admin tiene membership en todos los tenants segun el seed, lineas 326-341).

---

### D2: Un Manager con membership en Tenant A puede gestionar memberships de Tenant B?

**Respuesta corta**: SI, si tiene CUALQUIER membership en Tenant B — incluso como Cashier. **Esto es un bug de seguridad**.

**Respuesta detallada**:

El flujo para `POST /admin/tenants/:tenantId_B/members` con un Manager de Tenant A:

1. **TenantContextGuard** (`src/shared/tenant/tenant-context.guard.ts:15-35`): Pobla CLS con los datos del JWT. Si el Manager tiene JWT con `tenantId=A`, el CLS tiene `tenantId=A`. **El guard NO compara el tenantId del JWT con el `:tenantId` del path**. No hay validacion cruzada path vs JWT en este guard.

2. **PermissionsGuard**: Construye la ability del user usando `tenantId=A` (del JWT/CLS). Busca la membership del user en Tenant A y extrae los permisos de ese rol. Si el Manager en Tenant A tiene `create:TenantMembership`, el guard lo aprueba.

3. **`assertCanManageTenant(tenantId_B)`**: Busca si el user tiene CUALQUIER membership en Tenant B. Si el Manager tambien es Cashier en Tenant B (tiene una fila en `tenant_memberships` con `userId=X, tenantId=B, roleId=cashier_B`), `memberships.length > 0` → pasa el check.

**El problema**: `assertCanManageTenant` solo chequea EXISTENCIA de membership, no NIVEL DE ROL. Un Cashier en Tenant B NO deberia poder crear memberships ahi (no tiene `create:TenantMembership`). Pero el check de CASL se hizo con las permissions de Tenant A (donde si es Manager con ese permiso), no de Tenant B.

**Escenario concreto de escalation**:

| Step | Que pasa |
|---|---|
| User tiene: Manager en Tenant A, Cashier en Tenant B | |
| JWT: `tenantId=A` (logueado en A) | |
| Call: `POST /admin/tenants/B/members { userId: otro, roleId: manager_B }` | |
| TenantContextGuard: CLS = `{ tenantId: A, userId: X }` | PASA |
| PermissionsGuard: ability de Tenant A → Manager → tiene `create:TenantMembership` | PASA |
| assertCanManageTenant(B): user tiene membership en B (como Cashier) | PASA |
| **Resultado**: User con rol Cashier en B puede crear memberships en B | **BUG** |

**Implicancia para frontend**: El frontend NO puede confiar en que las operaciones de members en un tenant ajeno se bloqueen correctamente. Hasta que el backend fixee esto (haciendo que `assertCanManageTenant` verifique que el user tiene `create:TenantMembership` en el tenant TARGET, no en el del JWT), el frontend deberia limitar la UI a operar solo sobre el tenant activo del JWT.

**Fix planeado**: Se necesita un SDD `assertCanManageTenant-permission-aware` que reemplace el check de mera existencia por un check de permisos en el tenant target.

---

### D3: El `TenantContextGuard` valida que el `tenantId` del JWT coincida con el `:tenantId` del path?

**Respuesta corta**: NO. No mira el path en absoluto.

**Respuesta detallada**:

`TenantContextGuard` (`src/shared/tenant/tenant-context.guard.ts:15-35`) solo hace:

1. Extrae `request.user` (seteado por `JwtAuthGuard`)
2. Pobla el CLS con `userId`, `tenantId`, `tenantSlug`, `isSuperAdmin` del JWT
3. Valida que exista `tenantId` o sea `isSuperAdmin`

```ts
canActivate(context: ExecutionContext): boolean {
  const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
  const user = request.user;
  if (!user) throw new UnauthorizedException('Authenticated user required');

  this.cls.set('userId', user.userId);
  this.cls.set('tenantId', user.tenantId);
  this.cls.set('tenantSlug', user.tenantSlug);
  this.cls.set('isSuperAdmin', user.isSuperAdmin);

  if (!user.tenantId && !user.isSuperAdmin) {
    throw new UnauthorizedException('Tenant context required');
  }
  return true;
}
```

No hay referencia a `request.params.tenantId`. El `:tenantId` del path se recibe como parametro del controller y se pasa al service, pero el guard solo sabe del JWT.

**Implicancia para frontend**: Esto refuerza el punto de D2. No hay capa que compare "el tenant del JWT del caller" con "el tenant del path al que esta accediendo". La proteccion depende 100% de `assertCanManageTenant()` en el service.

---

## 7. Respuestas — Bloque E (Role scope)

### E1: Los roles son globales o per-tenant?

**Respuesta corta**: Per-tenant, con una excepcion: el rol "Super Admin" es global (`tenantId=null`).

**Respuesta detallada**:

Schema confirmado en `prisma/schema.prisma:793-810`:

```prisma
model Role {
  id          String   @id @default(uuid())
  name        String
  tenantId    String?    // <-- nullable
  description String?
  isSystem    Boolean  @default(false)
  // ...
  @@unique([tenantId, name])  // mismo nombre permitido en distintos tenants
}
```

El seed (`prisma/seed.ts`) crea:

| Rol | `tenantId` | `isSystem` |
|---|---|---|
| Super Admin | `null` (global) | `true` |
| Manager (Centro) | `<centro-uuid>` | `false` |
| Manager (Norte) | `<norte-uuid>` | `false` |
| Manager (Sur) | `<sur-uuid>` | `false` |
| Cashier (Centro) | `<centro-uuid>` | `false` |
| Cashier (Norte) | `<norte-uuid>` | `false` |
| Cashier (Sur) | `<sur-uuid>` | `false` |

Cada tenant tiene sus propios roles "Manager" y "Cashier" con UUIDs distintos. No son el mismo registro compartido.

`GET /admin/tenants/:tenantId/roles` (`src/tenants/tenants.controller.ts:41-44` → `src/tenants/tenants.service.ts:64-79`):

```ts
async findRoles(id: string): Promise<{ data: Array<{ id: string; name: string }> }> {
  this.assertSuperAdmin();  // SOLO super-admin puede llamar este endpoint
  const tenant = await this.tenantRepo.findById(id);
  if (!tenant) throw new NotFoundException('TENANT_NOT_FOUND');

  const roles = await this.prisma.role.findMany({
    where: { tenantId: id },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  return { data: roles };
}
```

**GOTCHA**: Este endpoint requiere super-admin (`this.assertSuperAdmin()`, linea 67). Un Manager NO puede listar los roles de su propio tenant via este endpoint. Esto es un problema para el frontend si un Manager necesita poblar un dropdown de roles.

**Alternativa**: `GET /admin/roles` (`src/admin/admin-role.controller.ts:34-38`) no requiere super-admin, solo `read:Role`. Pero lista roles segun el contexto del JWT:

```ts
// src/admin/admin-role.service.ts:50-52
const { tenantId, isSuperAdmin } = this.cls.get();
const where = isSuperAdmin && tenantId === null ? {} : { tenantId };
```

Un Manager con `tenantId=X` vera solo los roles de Tenant X via `GET /admin/roles`, lo cual ES correcto para poblar el dropdown. La diferencia es que `GET /admin/tenants/:tenantId/roles` filtra por un tenant ARBITRARIO (solo super-admin), mientras que `GET /admin/roles` filtra por el tenant del JWT.

---

### E2: Que endpoint usar para el dropdown de roles en el MembershipUpsertSlideover?

**Respuesta corta**: Depende del caller.
- **Super-admin**: puede usar `GET /admin/tenants/:tenantId/roles` para obtener roles del tenant target (sin importar su JWT)
- **Manager**: debe usar `GET /admin/roles` que filtra automaticamente por el tenant de su JWT

**Respuesta detallada**:

Para el MembershipUpsertSlideover (crear o editar membership), el frontend necesita un dropdown de roles validos para ese tenant. Dado que `ROLE_TENANT_MISMATCH` valida coincidencia exacta de `role.tenantId` con el `tenantId` de la membership:

1. Si el caller es **super-admin** gestionando un tenant distinto al de su JWT: usar `GET /admin/tenants/:tenantId/roles`. Este endpoint filtra por el tenant target y devuelve `{ data: [{ id, name }] }`.

2. Si el caller es **Manager** (solo puede operar en su propio tenant): usar `GET /admin/roles`. El service filtra por `tenantId` del CLS (que es el del JWT). Devuelve un array de roles con metadata completa (permissions, userCount).

**Recomendacion**: El frontend deberia usar `GET /admin/roles` como default (funciona para ambos perfiles) y reservar `GET /admin/tenants/:tenantId/roles` solo cuando el super-admin opera en un tenant al que no hizo switch.

**Shape de `GET /admin/roles`:**

```json
[
  {
    "role": {
      "id": "role-uuid",
      "name": "Manager",
      "description": "Manager role for Sucursal Centro",
      "isSystem": false,
      "permissions": [
        { "subject": "Product", "action": "create", "description": "..." }
      ],
      "createdAt": "2026-01-01T...",
      "updatedAt": "2026-01-01T..."
    },
    "userCount": 3
  }
]
```

**Shape de `GET /admin/tenants/:tenantId/roles`:**

```json
{
  "data": [
    { "id": "role-uuid", "name": "Manager" },
    { "id": "role-uuid", "name": "Cashier" }
  ]
}
```

---

## 8. Respuestas — Bloque F (Endpoints faltantes)

### F1: Existe un endpoint para obtener usuarios elegibles (que NO estan en un tenant)?

**Respuesta corta**: NO existe. Se propone `GET /admin/users?notInTenant=<uuid>`.

**Respuesta detallada**:

No hay ningun endpoint que filtre users por "no tiene membership en tenant X". La alternativa mas viable es extender el endpoint existente `GET /admin/users`.

#### Propuesta de contrato

| Campo | Valor |
|---|---|
| **Path** | `GET /admin/users` |
| **Nuevo query param** | `notInTenant` (UUID, opcional) |
| **Semantica** | Filtra users que NO tienen ninguna fila en `tenant_memberships` con ese `tenantId` |
| **Combinable con** | `page`, `limit` (existentes); `search` (nuevo, recomendado agregar junto) |
| **Auth** | JWT + `read:User` (misma que hoy) |
| **Guard extra** | Si `notInTenant` esta presente, validar que el caller tenga `create:TenantMembership` o sea super-admin |
| **Response shape** | Igual al actual (array de `User.toResponse()` + paginacion) |

**Query Prisma sugerido**:

```ts
// where clause cuando notInTenant esta presente
const where = {
  NOT: {
    tenantMemberships: {
      some: { tenantId: notInTenantId },
    },
  },
};
```

**Estado**: Pendiente de implementacion.

#### Workaround temporal (sin cambios al backend)

Para que el frontend pueda avanzar HOY:

1. `GET /admin/users?page=1&limit=100` — obtener todos los users visibles (super-admin en contexto global los ve todos)
2. `GET /admin/tenants/:tenantId/members` — obtener las memberships actuales del tenant target
3. En cliente: filtrar users del paso 1 excluyendo los `userId` obtenidos en paso 2

**Limitaciones del workaround**:
- Si hay >100 users, la paginacion del paso 1 corta los resultados. Hay que iterar paginas.
- No hay busqueda server-side (no existe param `search` ni `q` en `GET /admin/users`).
- Lento para >500 users.
- Requiere super-admin en contexto global para el paso 1 (un Manager solo ve users de su tenant, que son los que YA tienen membership — exactamente los que queres excluir).

**Conclusion**: El workaround es viable solo para super-admins y bases de datos pequenas. El endpoint `notInTenant` es necesario para una UX real.

---

### F2: Cual es el shape exacto de `GET /auth/me`? Incluye tenant name?

**Respuesta corta**: SI. Incluye `tenant` (el activo) y `memberships[]` con `{ id, name, slug }` de cada tenant.

**Respuesta detallada**:

`AuthService.getProfile()` en `src/auth/auth.service.ts:423-462`:

```ts
async getProfile(
  userId: string,
  tenantId?: string | null,
): Promise<{
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  tenant: TenantSummary | null;
  memberships: TenantSummary[];
}> {
  const user = await this.userRepo.findById(userId);
  if (!user) throw new EntityNotFoundError('User', userId);

  const memberships = await this.prisma.tenantMembership.findMany({
    where: { userId },
    include: { tenant: true },
  });

  const activeMemberships = memberships
    .filter((membership) => membership.tenant.isActive)
    .map((membership) => ({
      id: membership.tenant.id,
      name: membership.tenant.name,
      slug: membership.tenant.slug,
    }));

  const currentTenant =
    tenantId == null
      ? null
      : (activeMemberships.find((m) => m.id === tenantId) ?? null);

  return {
    ...user.toResponse(),
    tenant: currentTenant,
    memberships: activeMemberships,
  };
}
```

Donde `TenantSummary` (`src/auth/auth.service.ts:55-59`) es:

```ts
export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
}
```

**Response literal para un Manager en Sucursal Centro**:

```json
{
  "id": "user-uuid",
  "email": "manager@houndfe.com",
  "name": "Manager Centro",
  "isActive": true,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "tenant": {
    "id": "centro-uuid",
    "name": "Sucursal Centro",
    "slug": "centro"
  },
  "memberships": [
    {
      "id": "centro-uuid",
      "name": "Sucursal Centro",
      "slug": "centro"
    }
  ]
}
```

**Response para super-admin en contexto global** (`tenantId=null`):

```json
{
  "id": "user-uuid",
  "email": "admin@houndfe.com",
  "name": "Super Admin",
  "isActive": true,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "tenant": null,
  "memberships": [
    { "id": "centro-uuid", "name": "Sucursal Centro", "slug": "centro" },
    { "id": "norte-uuid", "name": "Sucursal Norte", "slug": "norte" },
    { "id": "sur-uuid", "name": "Sucursal Sur", "slug": "sur" }
  ]
}
```

**Para mostrar "Sucursal Centro" en el header**: leer `response.tenant.name`. Si `tenant` es `null` (super-admin global), mostrar "Contexto Global" o similar. La lista de `memberships` sirve para el dropdown de switch-tenant.

**GOTCHA**: `memberships` solo incluye tenants activos (`isActive=true`). Si un tenant se desactiva, desaparece del array pero el user sigue teniendo la fila en `tenant_memberships`. Esto es correcto: el frontend no deberia mostrar tenants inactivos.

**GOTCHA 2**: `memberships` NO incluye el nombre del ROL del user en cada tenant. Solo tiene datos del Tenant (id, name, slug). Si el frontend necesita mostrar "Sucursal Centro (Manager)" en el selector, tiene que hacer una call extra para obtener el rol. Este dato no esta disponible en `GET /auth/me`.

---

## 9. Respuestas — Bloque G (Confirmaciones varias)

### G1: `PATCH /admin/users/:id/roles` funciona o esta muerto?

**Respuesta corta**: MUERTO. Tira `Error` en runtime.

**Respuesta detallada**:

El controller lo rutea normalmente (`src/admin/admin-user.controller.ts:61-68`):

```ts
@Patch(':id/roles')
@RequirePermissions(['update', 'User'])
assignRoles(
  @Param('id', ParseUUIDPipe) id: string,
  @Body() dto: AssignRolesDto,
) {
  return this.adminUserService.assignRoles(id, dto);
}
```

El DTO espera `{ roleIds: string[] }` (`src/admin/dto/assign-roles.dto.ts:3-7`):

```ts
export class AssignRolesDto {
  @IsArray()
  @IsUUID('4', { each: true })
  roleIds: string[];
}
```

El service valida user y roles, y luego delega al repo (`src/admin/admin-user.service.ts:210-223`):

```ts
async assignRoles(userId: string, dto: AssignRolesDto): Promise<void> {
  const user = await this.userRepo.findById(userId);
  if (!user) throw new EntityNotFoundError('User', userId);

  for (const roleId of dto.roleIds) {
    const role = await this.roleRepo.findById(roleId);
    if (!role) throw new EntityNotFoundError('Role', roleId);
  }

  await this.userRepo.assignRoles(userId, dto.roleIds);
}
```

Pero el repo TIRA:

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

**Resultado en runtime**: El request pasa validacion de JWT, TenantContext, CASL permissions, DTO validation, service-level user/role existence checks... y luego tira un `Error` generico sin ser un `HttpException`. NestJS lo convierte en un `500 Internal Server Error`.

**Implicancia para frontend**: NO usar este endpoint. Cualquier llamada resulta en 500. El frontend NO deberia tener un boton, formulario o call que apunte a `PATCH /admin/users/:id/roles`.

---

### G2: Cual es la diferencia entre `PATCH /admin/users/:id/roles` y `PATCH /admin/tenants/:tenantId/members/:membershipId`?

**Respuesta corta**: El primero esta muerto (500). El segundo funciona y cambia el `roleId` de una membership especifica.

**Respuesta detallada**:

| Aspecto | `PATCH /admin/users/:id/roles` | `PATCH /admin/tenants/:tenantId/members/:membershipId` |
|---|---|---|
| **Estado** | MUERTO (throws en runtime) | Funcional |
| **Semantica original** | "Reemplazar TODOS los roles del user" (REPLACE strategy) | "Cambiar el rol de UNA membership" |
| **DTO** | `{ roleIds: string[] }` (array) | `{ roleId: string }` (singular) |
| **Scope** | Ambiguo: no dice de que tenant | Explicito: `tenantId` en el path |
| **Validacion de tenant** | No valida que los roles pertenezcan al tenant | Valida `ROLE_TENANT_MISMATCH` via repo |
| **Resultado** | 500 Internal Server Error | 200 con la membership actualizada |

**Recomendacion**: El frontend debe usar EXCLUSIVAMENTE `PATCH /admin/tenants/:tenantId/members/:membershipId` para cambiar roles. El endpoint de users/roles deberia eliminarse o reimplementarse en un SDD futuro.

`PATCH /admin/tenants/:tenantId/members/:membershipId` flow (`src/tenants/tenants-membership.service.ts:48-57`):

```ts
async update(tenantId: string, membershipId: string, dto: UpdateMembershipDto) {
  await this.assertCanManageTenant(tenantId);
  const tenantMemberships = await this.membershipRepo.findByTenant(tenantId);
  const exists = tenantMemberships.some((m) => m.id === membershipId);
  if (!exists) throw new NotFoundException('TENANT_MEMBERSHIP_NOT_FOUND');
  return this.membershipRepo.update(membershipId, dto);
}
```

El repo luego valida `ROLE_TENANT_MISMATCH` como se documenta en C2.

---

## 10. Resumen de acciones para el frontend

### 10.1 Acciones inmediatas (sin esperar nada del backend)

| Accion | Endpoint | Detalle |
|---|---|---|
| Dropdown de roles en MembershipUpsertSlideover | `GET /admin/roles` (Manager) o `GET /admin/tenants/:tenantId/roles` (super-admin) | Ver seccion 7, E2. Usar el que corresponda al perfil del caller |
| Listar miembros del tenant | `GET /admin/tenants/:tenantId/members` | ATENCION: shape pobre (solo IDs). Ver B2 para workaround |
| Crear membership (user existente) | `POST /admin/tenants/:tenantId/members { userId, roleId }` | Valida ROLE_TENANT_MISMATCH. 409 si duplicado |
| Editar rol de membership | `PATCH /admin/tenants/:tenantId/members/:membershipId { roleId }` | Valida ROLE_TENANT_MISMATCH en update tambien |
| Eliminar membership | `DELETE /admin/tenants/:tenantId/members/:membershipId` | 204 No Content |
| Nombre del tenant activo en header | `GET /auth/me` → `response.tenant.name` | `null` si super-admin global |
| Dropdown de switch-tenant | `GET /auth/me` → `response.memberships[]` | Array de `{ id, name, slug }` |
| Cambiar tenant activo | `POST /auth/switch-tenant { tenantId }` | Devuelve nuevos tokens JWT |
| NO usar `PATCH /admin/users/:id/roles` | -- | MUERTO. Tira 500. Eliminar cualquier referencia en el frontend |

### 10.2 Workaround temporal hasta endpoint nuevo

**Picker "Agregar miembro existente" (user ya existe en el sistema pero no en este tenant)**:

```
// Paso 1: Obtener todos los users (solo funciona como super-admin en contexto global)
GET /admin/users?page=1&limit=100

// Paso 2: Obtener miembros actuales del tenant
GET /admin/tenants/:tenantId/members

// Paso 3: En cliente, filtrar
const existingUserIds = new Set(members.map(m => m.userId));
const eligibleUsers = allUsers.data.filter(u => !existingUserIds.has(u.id));
```

Limitaciones: solo super-admin, no escala, sin busqueda server-side. Ver F1.

**"Crear nuevo user + linkear a tenant"** (user no existe):

```
// Paso 1: Crear el user (tambien crea membership en el tenant del JWT)
POST /admin/users { email, password, name, roleId }

// Si necesitas agregarle a OTRO tenant (distinto al del JWT):
// Paso 2: Crear membership adicional
POST /admin/tenants/:otroTenantId/members { userId: <id-del-paso-1>, roleId: <role-del-otro-tenant> }
```

### 10.3 Esperando del backend

| Pendiente | Prioridad | Estado |
|---|---|---|
| `GET /admin/users?notInTenant=<uuid>` (picker de elegibles) | ALTA | Propuesto en F1. Sin implementar |
| Fix shape de `GET /admin/tenants/:tenantId/members` (incluir user.name/email, role.name) | ALTA | Sin issue creado. El frontend esta ciegos sin esto |
| `POST /admin/tenants/:tenantId/members` con creacion inline de user | MEDIA | Futuro SDD `tenant-member-management-unification` |
| Remocion o reimplementacion de `PATCH /admin/users/:id/roles` | BAJA | Codigo muerto, no afecta funcionalidad |
| Fix `assertCanManageTenant` para chequear permisos en tenant target | ALTA | Bug de cross-tenant escalation (D2) |
| Fix `CaslAbilityFactory.queryUserPermissions()` para soportar multiples memberships por user+tenant | MEDIA | Usa `findFirst` que ignora roles adicionales (C3) |

---

## 11. Riesgos conocidos y deuda tecnica

### 11.1 Cross-tenant escalation via `assertCanManageTenant` (CRITICO)

Un Manager en Tenant A con membership de Cashier en Tenant B puede crear/editar/eliminar memberships en Tenant B usando los permisos de su rol en Tenant A. `assertCanManageTenant` solo chequea existencia de membership, no nivel de rol ni permisos efectivos. Ver seccion 6, D2.

**Mitigacion frontend**: Limitar la UI a operar solo sobre el tenant activo del JWT. No mostrar controles de gestion de memberships para tenants a los que el user no ha hecho switch.

### 11.2 `GET /admin/tenants/:tenantId/members` retorna shape incompleto

El endpoint devuelve solo IDs (`id, userId, tenantId, roleId`) sin datos de user ni rol. Esto hace imposible renderizar una tabla de miembros sin calls adicionales. Fix: agregar `include: { user: true, role: true }` en el repo.

### 11.3 `PATCH /admin/users/:id/roles` — codigo muerto que llega a 500

El endpoint esta ruteado, tiene guards, tiene DTO validation, pero el repo tira `Error` en runtime. Cualquier cliente que lo llame obtiene 500 sin explicacion util. Deberia eliminarse la ruta o reimplementarse.

### 11.4 `POST /admin/users` no valida `ROLE_TENANT_MISMATCH`

A diferencia del endpoint de members, `AdminUserService.create()` crea la membership directamente via `tenantPrisma.tenantMembership.create()` sin pasar por el repo que valida coincidencia de `role.tenantId` con el tenant de la membership. Es posible crear memberships con roles de otro tenant via este endpoint.

### 11.5 User sin membership no puede loguearse

`AuthService.login()` en `src/auth/auth.service.ts:246` tira `ForbiddenException('User does not belong to an active tenant')` si el user no tiene ninguna membership activa. Si un admin crea un User en contexto global (`tenantId=null`, sin membership), ese user no puede loguearse. El frontend deberia advertir de esto al admin: "Este usuario no podra iniciar sesion hasta que se lo asigne a al menos un tenant."

### 11.6 CASL `queryUserPermissions` usa `findFirst` (una sola membership)

`CaslAbilityFactory.queryUserPermissions()` (`src/auth/authorization/casl-ability.factory.ts:125-138`) busca la PRIMERA membership del user en el tenant. Si el user tiene multiples roles en el mismo tenant (ej: Manager + Cashier), solo se evaluan los permisos de un rol (el que Prisma devuelve primero, orden no deterministico). Permisos del segundo rol se pierden.

### 11.7 `GET /admin/tenants/:tenantId/roles` requiere super-admin

`TenantsService.findRoles()` llama `this.assertSuperAdmin()` (`src/tenants/tenants.service.ts:67`). Un Manager que necesite poblar un dropdown de roles no puede usar este endpoint. Debe usar `GET /admin/roles` en su lugar (que filtra por tenant del JWT).

---

## 12. Changelog del documento

| Fecha | Descripcion |
|---|---|
| 2026-05-25 | Creacion inicial. Snapshot basado en branch `feat/rbac-coverage-completion` |

**Branch de origen de las preguntas**: `feat/rbac-coverage-completion`

**Documentos relacionados**:
- `docs/backend-requests/rbac-frontend-permissions-audit.md` — Sistema RBAC completo, mapa de endpoints a permisos
- `docs/backend-requests/sales-list-multiselect-filters-and-ranges-response.md` — Referencia de estilo

---

**Nota**: Este documento fue generado en base al snapshot del codigo en la branch `feat/rbac-coverage-completion`. Cualquier merge posterior puede cambiar comportamientos — verificar contra `main` despues del merge.
