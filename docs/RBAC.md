# HoundFE Backend — Auth & RBAC System

> Guia completa para integrar el frontend con el sistema de autenticacion y control de acceso basado en roles (RBAC).

## Tabla de Contenidos

1. [Arquitectura General](#1-arquitectura-general)
2. [Modelos de Datos](#2-modelos-de-datos)
3. [Flujo de Autenticacion (JWT)](#3-flujo-de-autenticacion-jwt)
4. [Endpoints de Autenticacion](#4-endpoints-de-autenticacion)
5. [Endpoints de Administracion de Usuarios](#5-endpoints-de-administracion-de-usuarios)
6. [Endpoints de Administracion de Roles](#6-endpoints-de-administracion-de-roles)
7. [Endpoints de Permisos](#7-endpoints-de-permisos)
8. [Sistema de Permisos (CASL)](#8-sistema-de-permisos-casl)
9. [Mapa de Permisos por Endpoint](#9-mapa-de-permisos-por-endpoint)
10. [Tipos TypeScript para el Frontend](#10-tipos-typescript-para-el-frontend)
11. [Manejo de Errores](#11-manejo-de-errores)
12. [Guia de Implementacion Frontend](#12-guia-de-implementacion-frontend)
13. [Datos de Prueba (Seed)](#13-datos-de-prueba-seed)

---

## 1. Arquitectura General

### Flujo de una peticion protegida

```
HTTP Request
  --> ValidationPipe (valida DTOs, rechaza campos desconocidos, retorna 400)
  --> JwtAuthGuard (valida Bearer token, extrae usuario)
  --> PermissionsGuard (verifica permisos CASL del usuario)
  --> Controller (ejecuta la logica)
  --> Respuesta JSON
```

### Reglas importantes para el frontend

- **Header de autenticacion:** `Authorization: Bearer <accessToken>`
- **Campos desconocidos son rechazados:** El backend usa `forbidNonWhitelisted: true`. Si envias un campo que no existe en el DTO, recibes un `400 Bad Request`.
- **Los tokens se envian en el body**, no en cookies (excepto el access token que va en el header).

---

## 2. Modelos de Datos

### Diagrama de relaciones

```
User ──┐                      ┌── Permission
       │  N:M via UserRole    │  N:M via RolePermission
       └──── Role ────────────┘
```

### User

| Campo       | Tipo      | Descripcion                               |
| ----------- | --------- | ----------------------------------------- |
| `id`        | `string`  | UUID                                      |
| `email`     | `string`  | Unico, normalizado a minusculas           |
| `name`      | `string`  | Nombre del usuario                        |
| `isActive`  | `boolean` | `true` por defecto. `false` = desactivado |
| `createdAt` | `string`  | ISO 8601 (ej: `2026-03-31T12:00:00.000Z`) |

> **Nota:** `hashedPassword` y `hashedRefreshToken` nunca se exponen en las respuestas.

### Role

| Campo         | Tipo      | Descripcion                                       |
| ------------- | --------- | ------------------------------------------------- |
| `id`          | `string`  | UUID                                              |
| `name`        | `string`  | Unico (ej: "Super Admin", "Vendedor")             |
| `description` | `string?` | Descripcion opcional                              |
| `isSystem`    | `boolean` | `true` = no se puede eliminar (ej: "Super Admin") |
| `permissions` | `array`   | Lista de permisos asignados al rol                |
| `createdAt`   | `string`  | ISO 8601                                          |
| `updatedAt`   | `string`  | ISO 8601                                          |

### Permission

| Campo         | Tipo      | Descripcion                                            |
| ------------- | --------- | ------------------------------------------------------ |
| `id`          | `string`  | UUID                                                   |
| `subject`     | `string`  | Entidad: `Product`, `Order`, `User`, `Role`, `all`     |
| `action`      | `string`  | Accion: `create`, `read`, `update`, `delete`, `manage` |
| `description` | `string?` | Descripcion legible                                    |

> **Los permisos son de solo lectura.** Se crean automaticamente al iniciar el servidor. No hay endpoints para crear/editar/eliminar permisos.

---

## 3. Flujo de Autenticacion (JWT)

### Tokens

| Token             | Expiracion | Almacenamiento                | Proposito               |
| ----------------- | ---------- | ----------------------------- | ----------------------- |
| **Access Token**  | 15 min     | Memoria / localStorage        | Autenticar cada request |
| **Refresh Token** | 7 dias     | localStorage / secure storage | Obtener nuevos tokens   |

### Ciclo de vida completo

```
1. LOGIN / REGISTER
   POST /auth/login { email, password }
   --> { accessToken, refreshToken, user }

2. PETICION AUTENTICADA
   GET /admin/users
   Header: Authorization: Bearer <accessToken>
   --> 200 OK con datos

3. TOKEN EXPIRADO (el access token vence cada 15 min)
   GET /admin/users
   Header: Authorization: Bearer <accessToken_expirado>
   --> 401 Unauthorized

4. REFRESH (obtener nuevos tokens)
   POST /auth/refresh { refreshToken }
   --> { accessToken (NUEVO), refreshToken (NUEVO) }
   IMPORTANTE: Guardar AMBOS tokens nuevos. El refresh token anterior queda invalidado.

5. LOGOUT
   POST /auth/logout
   Header: Authorization: Bearer <accessToken>
   --> El refresh token se invalida en el servidor.
   --> El access token sigue siendo valido hasta que expire (es stateless).
   --> El frontend debe borrar ambos tokens de su almacenamiento.
```

### Refresh Token Rotation

Cada vez que usas `POST /auth/refresh`, el servidor:

1. Verifica el refresh token actual
2. Genera un **NUEVO** par de tokens (access + refresh)
3. Invalida el refresh token anterior (lo reemplaza en la DB)
4. Retorna los nuevos tokens

**Si no guardas el nuevo refresh token, perderas acceso cuando el access token expire.**

---

## 4. Endpoints de Autenticacion

**Base URL:** `/auth`

### `POST /auth/register` — Registrar usuario

**Autenticacion:** Ninguna

```typescript
// Request body
{
  email: string; // Email valido
  password: string; // Minimo 8 caracteres
  name: string; // No vacio
}

// Response 201
{
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    name: string;
    isActive: boolean;
    createdAt: string;
  }
}
```

**Errores:** `409` si el email ya existe.

---

### `POST /auth/login` — Iniciar sesion

**Autenticacion:** Ninguna

```typescript
// Request body
{
  email: string;
  password: string;
}

// Response 200
{
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    name: string;
    isActive: boolean;
    createdAt: string;
  }
}
```

**Errores:** `401` si las credenciales son incorrectas o el usuario esta inactivo (el mensaje no revela cual fue el problema por seguridad).

---

### `POST /auth/refresh` — Renovar tokens

**Autenticacion:** Ninguna (el refresh token ES la credencial)

```typescript
// Request body
{
  refreshToken: string;
}

// Response 200
{
  accessToken: string; // NUEVO
  refreshToken: string; // NUEVO (guardar este, el anterior ya no sirve)
}
```

**Errores:** `401` si el token es invalido, expirado, o no coincide con el almacenado.

---

### `GET /auth/me` — Obtener usuario actual

**Autenticacion:** `Bearer <accessToken>`

```typescript
// Response 200
{
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  createdAt: string;
}
```

**Errores:** `401` si no hay token o es invalido.

---

### `POST /auth/logout` — Cerrar sesion

**Autenticacion:** `Bearer <accessToken>`

```typescript
// Response 200
{
  message: 'Logged out successfully';
}
```

**Efecto:** Invalida el refresh token en el servidor. El access token sigue valido hasta su expiracion.

---

## 5. Endpoints de Administracion de Usuarios

**Base URL:** `/admin/users`  
**Autenticacion:** Todos requieren `Bearer <accessToken>` + permisos RBAC.

### `GET /admin/users` — Listar usuarios (paginado)

**Permiso requerido:** `read:User`

```typescript
// Query params (opcionales)
?page=1&limit=20

// Response 200
{
  data: Array<{
    id: string;
    email: string;
    name: string;
    isActive: boolean;
    createdAt: string;
  }>;
  meta: {
    total: number;      // Total de registros
    page: number;       // Pagina actual
    limit: number;      // Items por pagina
    totalPages: number; // Total de paginas
  };
}
```

| Parametro | Tipo     | Default | Min | Max |
| --------- | -------- | ------- | --- | --- |
| `page`    | `number` | `1`     | 1   | -   |
| `limit`   | `number` | `20`    | 1   | 100 |

---

### `GET /admin/users/:id` — Obtener usuario con sus roles

**Permiso requerido:** `read:User`

```typescript
// Response 200
{
  user: {
    id: string;
    email: string;
    name: string;
    isActive: boolean;
    createdAt: string;
  }
  roles: Array<{
    id: string;
    name: string;
  }>;
}
```

**Errores:** `404` si el usuario no existe. El `:id` debe ser un UUID valido (si no, retorna `400`).

---

### `POST /admin/users` — Crear usuario

**Permiso requerido:** `create:User`

```typescript
// Request body
{
  email: string; // Email valido
  password: string; // Minimo 8 caracteres
  name: string; // No vacio
}

// Response 201
{
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  createdAt: string;
}
```

**Errores:** `409` si el email ya existe.

---

### `PATCH /admin/users/:id` — Actualizar usuario

**Permiso requerido:** `update:User`

```typescript
// Request body
{
  name: string; // Requerido, no vacio
}

// Response 200
{
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  createdAt: string;
}
```

> **Nota:** Actualmente solo se puede actualizar el `name`. El email y password no son editables desde este endpoint.

**Errores:** `404` si no existe.

---

### `PATCH /admin/users/:id/roles` — Asignar roles a un usuario

**Permiso requerido:** `update:User`

```typescript
// Request body
{
  roleIds: string[];  // Array de UUIDs de roles
}

// Response 200 (body vacio)
```

**Estrategia: REEMPLAZO TOTAL.** Este endpoint:

1. Elimina TODOS los roles actuales del usuario
2. Asigna los roles enviados en `roleIds`

```typescript
// Ejemplo: Asignar un solo rol
{ "roleIds": ["uuid-del-rol-vendedor"] }

// Ejemplo: Asignar multiples roles
{ "roleIds": ["uuid-rol-1", "uuid-rol-2"] }

// Ejemplo: Quitar TODOS los roles
{ "roleIds": [] }
```

**Errores:** `404` si el usuario o algun rol no existe.

---

### `DELETE /admin/users/:id` — Desactivar usuario

**Permiso requerido:** `delete:User`

```typescript
// Response 204 (sin body)
```

> **IMPORTANTE:** Este endpoint NO elimina el usuario. Hace un **soft delete** cambiando `isActive` a `false`. El usuario desactivado no puede hacer login.

**Errores:** `404` si no existe.

---

## 6. Endpoints de Administracion de Roles

**Base URL:** `/admin/roles`  
**Autenticacion:** Todos requieren `Bearer <accessToken>` + permisos RBAC.

### `GET /admin/roles` — Listar todos los roles

**Permiso requerido:** `read:Role`

```typescript
// Response 200
Array<{
  role: {
    id: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    permissions: Array<{
      subject: string;
      action: string;
      description: string;
    }>;
    createdAt: string;
    updatedAt: string;
  };
  userCount: number; // Cantidad de usuarios con este rol
}>;
```

---

### `GET /admin/roles/:id` — Obtener un rol con sus permisos

**Permiso requerido:** `read:Role`

```typescript
// Response 200
{
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: Array<{
    subject: string;
    action: string;
    description: string;
  }>;
  createdAt: string;
  updatedAt: string;
}
```

**Errores:** `404` si no existe.

---

### `POST /admin/roles` — Crear rol

**Permiso requerido:** `create:Role`

```typescript
// Request body
{
  name: string;           // Requerido, unico
  description?: string;   // Opcional
}

// Response 201 (misma forma que GET /admin/roles/:id)
{
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;       // siempre false para roles creados por API
  permissions: [];         // vacio al crear (asignar permisos despues)
  createdAt: string;
  updatedAt: string;
}
```

**Errores:** `409` si ya existe un rol con ese nombre.

---

### `PATCH /admin/roles/:id` — Actualizar rol

**Permiso requerido:** `update:Role`

```typescript
// Request body (todos opcionales)
{
  name?: string;
  description?: string;
}

// Response 200 (misma forma que GET /admin/roles/:id)
```

**Errores:** `404` si no existe. `409` si el nuevo nombre ya esta en uso.

---

### `PATCH /admin/roles/:id/permissions` — Asignar permisos a un rol

**Permiso requerido:** `update:Role`

```typescript
// Request body
{
  permissionIds: string[];  // Array de UUIDs de permisos
}

// Response 200 (body vacio)
```

**Estrategia: REEMPLAZO TOTAL.** Igual que la asignacion de roles a usuarios:

1. Elimina TODOS los permisos actuales del rol
2. Asigna los permisos enviados en `permissionIds`

```typescript
// Ejemplo: Asignar permisos de lectura a un rol
{
  "permissionIds": [
    "uuid-read-product",
    "uuid-read-order",
    "uuid-read-user"
  ]
}

// Ejemplo: Quitar TODOS los permisos
{ "permissionIds": [] }
```

**Errores:** `404` si el rol o algun permiso no existe.

---

### `DELETE /admin/roles/:id` — Eliminar rol

**Permiso requerido:** `delete:Role`

```typescript
// Response 204 (sin body)
```

> **IMPORTANTE:** Este es un **hard delete**. Elimina el rol y todas sus relaciones (RolePermission, UserRole) por CASCADE.

> **PROTECCION:** Los roles del sistema (`isSystem: true`, como "Super Admin") **NO se pueden eliminar**. Retorna `422`.

**Errores:** `404` si no existe. `422` si es un rol del sistema.

---

## 7. Endpoints de Permisos

**Base URL:** `/admin/permissions`  
**Autenticacion:** Requiere `Bearer <accessToken>` + permiso RBAC.

### `GET /admin/permissions` — Listar permisos agrupados por subject

**Permiso requerido:** `read:Role`

```typescript
// Response 200
{
  "all": [
    { "id": "uuid-1", "action": "manage", "description": "Full system access" }
  ],
  "Product": [
    { "id": "uuid-2", "action": "create", "description": "Create new products" },
    { "id": "uuid-3", "action": "read", "description": "View products" },
    { "id": "uuid-4", "action": "update", "description": "Update products" },
    { "id": "uuid-5", "action": "delete", "description": "Delete products" },
    { "id": "uuid-6", "action": "manage", "description": "Full product management" }
  ],
  "Order": [
    { "id": "uuid-7", "action": "create", "description": "Create new orders" },
    { "id": "uuid-8", "action": "read", "description": "View orders" },
    { "id": "uuid-9", "action": "update", "description": "Update orders" },
    { "id": "uuid-10", "action": "delete", "description": "Delete orders" },
    { "id": "uuid-11", "action": "manage", "description": "Full order management" }
  ],
  "User": [
    { "id": "uuid-12", "action": "create", "description": "Create new users" },
    { "id": "uuid-13", "action": "read", "description": "View users" },
    { "id": "uuid-14", "action": "update", "description": "Update users" },
    { "id": "uuid-15", "action": "delete", "description": "Delete users" },
    { "id": "uuid-16", "action": "manage", "description": "Full user management" }
  ],
  "Role": [
    { "id": "uuid-17", "action": "create", "description": "Create new roles" },
    { "id": "uuid-18", "action": "read", "description": "View roles" },
    { "id": "uuid-19", "action": "update", "description": "Update roles" },
    { "id": "uuid-20", "action": "delete", "description": "Delete roles" },
    { "id": "uuid-21", "action": "manage", "description": "Full role management" }
  ]
}
```

> **Este endpoint es esencial para el frontend.** Usalo para renderizar los checkboxes de permisos al crear/editar un rol. Los `id` de cada permiso son los que se envian en `PATCH /admin/roles/:id/permissions`.

---

## 8. Sistema de Permisos (CASL)

### Subjects (entidades protegidas)

| Subject   | Descripcion          |
| --------- | -------------------- |
| `Product` | Gestion de productos |
| `Order`   | Gestion de ordenes   |
| `User`    | Gestion de usuarios  |
| `Role`    | Gestion de roles     |
| `all`     | Todas las entidades  |

### Actions (acciones posibles)

| Action   | Descripcion                         |
| -------- | ----------------------------------- |
| `create` | Crear registros                     |
| `read`   | Ver/listar registros                |
| `update` | Editar registros                    |
| `delete` | Eliminar registros                  |
| `manage` | Todas las acciones sobre la entidad |

### Registro completo de permisos (21 permisos)

| #   | Subject   | Action   | Descripcion                     |
| --- | --------- | -------- | ------------------------------- |
| 1   | `all`     | `manage` | Acceso total al sistema         |
| 2   | `Product` | `create` | Crear productos                 |
| 3   | `Product` | `read`   | Ver productos                   |
| 4   | `Product` | `update` | Editar productos                |
| 5   | `Product` | `delete` | Eliminar productos              |
| 6   | `Product` | `manage` | Gestion total de productos      |
| 7   | `Order`   | `create` | Crear ordenes                   |
| 8   | `Order`   | `read`   | Ver ordenes                     |
| 9   | `Order`   | `update` | Editar ordenes                  |
| 10  | `Order`   | `delete` | Eliminar ordenes                |
| 11  | `Order`   | `manage` | Gestion total de ordenes        |
| 12  | `User`    | `create` | Crear usuarios                  |
| 13  | `User`    | `read`   | Ver usuarios                    |
| 14  | `User`    | `update` | Editar usuarios                 |
| 15  | `User`    | `delete` | Eliminar/desactivar usuarios    |
| 16  | `User`    | `manage` | Gestion total de usuarios       |
| 17  | `Role`    | `create` | Crear roles                     |
| 18  | `Role`    | `read`   | Ver roles y permisos            |
| 19  | `Role`    | `update` | Editar roles y asignar permisos |
| 20  | `Role`    | `delete` | Eliminar roles                  |
| 21  | `Role`    | `manage` | Gestion total de roles          |

### Semantica de `manage`

- `manage` sobre un subject especifico (ej: `manage:Product`) equivale a tener `create`, `read`, `update` y `delete` sobre ese subject.
- `manage` sobre `all` equivale a tener TODOS los permisos del sistema. Es el permiso de **Super Admin**.

### Como funciona la verificacion

```
1. El usuario hace una peticion con su access token
2. JwtAuthGuard extrae el userId del token
3. PermissionsGuard lee los permisos requeridos del endpoint (@RequirePermissions)
4. Consulta la DB: usuario -> roles -> permisos
5. Construye una "ability" de CASL con todos los permisos del usuario
6. Verifica cada permiso requerido con ability.can(action, subject)
7. Si TODOS los permisos pasan -> permite el acceso
8. Si ALGUNO falla -> retorna 403 Forbidden
```

---

## 9. Mapa de Permisos por Endpoint

Referencia rapida de que permiso necesita cada endpoint:

| Endpoint                             | Metodo | Permiso Requerido |
| ------------------------------------ | ------ | ----------------- |
| `POST /auth/register`                | POST   | Ninguno           |
| `POST /auth/login`                   | POST   | Ninguno           |
| `POST /auth/refresh`                 | POST   | Ninguno           |
| `GET /auth/me`                       | GET    | Solo JWT          |
| `POST /auth/logout`                  | POST   | Solo JWT          |
| `GET /admin/users`                   | GET    | `read:User`       |
| `GET /admin/users/:id`               | GET    | `read:User`       |
| `POST /admin/users`                  | POST   | `create:User`     |
| `PATCH /admin/users/:id`             | PATCH  | `update:User`     |
| `PATCH /admin/users/:id/roles`       | PATCH  | `update:User`     |
| `DELETE /admin/users/:id`            | DELETE | `delete:User`     |
| `GET /admin/roles`                   | GET    | `read:Role`       |
| `GET /admin/roles/:id`               | GET    | `read:Role`       |
| `POST /admin/roles`                  | POST   | `create:Role`     |
| `PATCH /admin/roles/:id`             | PATCH  | `update:Role`     |
| `PATCH /admin/roles/:id/permissions` | PATCH  | `update:Role`     |
| `DELETE /admin/roles/:id`            | DELETE | `delete:Role`     |
| `GET /admin/permissions`             | GET    | `read:Role`       |

---

## 10. Tipos TypeScript para el Frontend

Copia estos tipos en tu proyecto frontend para tipar las respuestas de la API:

```typescript
// ============================================
// Auth Types
// ============================================

interface UserResponse {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  createdAt: string; // ISO 8601
}

interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: UserResponse;
}

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

// ============================================
// Admin Types
// ============================================

interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

interface UserWithRoles {
  user: UserResponse;
  roles: Array<{
    id: string;
    name: string;
  }>;
}

interface PermissionResponse {
  subject: string;
  action: string;
  description: string;
}

interface RoleResponse {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: PermissionResponse[];
  createdAt: string;
  updatedAt: string;
}

interface RoleWithUserCount {
  role: RoleResponse;
  userCount: number;
}

interface PermissionGrouped {
  [subject: string]: Array<{
    id: string;
    action: string;
    description: string | null;
  }>;
}

// ============================================
// Request DTOs
// ============================================

interface LoginRequest {
  email: string;
  password: string;
}

interface RegisterRequest {
  email: string;
  password: string; // min 8 caracteres
  name: string;
}

interface RefreshTokenRequest {
  refreshToken: string;
}

interface CreateUserRequest {
  email: string;
  password: string; // min 8 caracteres
  name: string;
}

interface UpdateUserRequest {
  name: string;
}

interface AssignRolesRequest {
  roleIds: string[]; // UUIDs
}

interface CreateRoleRequest {
  name: string;
  description?: string;
}

interface UpdateRoleRequest {
  name?: string;
  description?: string;
}

interface AssignPermissionsRequest {
  permissionIds: string[]; // UUIDs
}

interface PaginationParams {
  page?: number; // default: 1, min: 1
  limit?: number; // default: 20, min: 1, max: 100
}

// ============================================
// Error Types
// ============================================

interface DomainErrorResponse {
  statusCode: number;
  error: string; // Codigo de error (ej: "ENTITY_NOT_FOUND")
  message: string; // Mensaje legible
  timestamp: string;
}

interface ValidationErrorResponse {
  statusCode: 400;
  message: string[]; // Array de errores de validacion
  error: 'Bad Request';
}
```

---

## 11. Manejo de Errores

### Codigos de error del dominio

| HTTP | Codigo de Error            | Cuando ocurre                             |
| ---- | -------------------------- | ----------------------------------------- |
| 400  | `Bad Request`              | Validacion del body falla o UUID invalido |
| 401  | `INVALID_CREDENTIALS`      | Email o password incorrectos              |
| 401  | `USER_INACTIVE`            | El usuario esta desactivado               |
| 401  | `INVALID_REFRESH_TOKEN`    | Refresh token invalido o expirado         |
| 401  | `Unauthorized`             | No se envio access token o es invalido    |
| 403  | `INSUFFICIENT_PERMISSIONS` | El usuario no tiene el permiso requerido  |
| 404  | `ENTITY_NOT_FOUND`         | El recurso solicitado no existe           |
| 409  | `ENTITY_ALREADY_EXISTS`    | Email o nombre de rol duplicado           |
| 422  | `SYSTEM_ROLE_PROTECTED`    | Intento de eliminar un rol del sistema    |

### Forma de las respuestas de error

**Error de dominio (401, 403, 404, 409, 422):**

```json
{
  "statusCode": 404,
  "error": "ENTITY_NOT_FOUND",
  "message": "User with id \"abc-123\" not found",
  "timestamp": "2026-03-31T12:00:00.000Z"
}
```

**Error de validacion (400):**

```json
{
  "statusCode": 400,
  "message": [
    "email must be an email",
    "password must be longer than or equal to 8 characters",
    "name should not be empty"
  ],
  "error": "Bad Request"
}
```

**Error por campo desconocido (400):**

```json
{
  "statusCode": 400,
  "message": ["property unknownField should not exist"],
  "error": "Bad Request"
}
```

**Error de UUID invalido (400):**

```json
{
  "statusCode": 400,
  "message": "Validation failed (uuid is expected)",
  "error": "Bad Request"
}
```

### Recomendacion para el frontend

```typescript
// Interceptor de errores sugerido
function handleApiError(error: AxiosError) {
  const status = error.response?.status;
  const data = error.response?.data;

  switch (status) {
    case 400:
      // Mostrar errores de validacion
      // data.message es un array de strings
      break;
    case 401:
      if (
        data.error === 'INVALID_REFRESH_TOKEN' ||
        data.message === 'Unauthorized'
      ) {
        // Token expirado o invalido -> redirigir a login
        // Intentar refresh primero si es un error de access token
      }
      break;
    case 403:
      // Sin permisos -> mostrar mensaje o redirigir
      break;
    case 404:
      // Recurso no encontrado
      break;
    case 409:
      // Duplicado (email o nombre de rol)
      break;
    case 422:
      // Regla de negocio violada (ej: eliminar rol del sistema)
      break;
  }
}
```

---

## 12. Guia de Implementacion Frontend

### 12.1 Flujo de Login

```
1. Usuario ingresa email y password
2. POST /auth/login { email, password }
3. Guardar accessToken y refreshToken (localStorage o store)
4. Guardar user en el estado global
5. Redirigir al dashboard
```

### 12.2 Interceptor de Autenticacion (Axios)

```typescript
// Agregar el token a cada peticion
api.interceptors.request.use((config) => {
  const token = getAccessToken(); // desde tu store/localStorage
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Manejar token expirado automaticamente
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        const refreshToken = getRefreshToken();
        const { data } = await axios.post('/auth/refresh', { refreshToken });

        // Guardar los NUEVOS tokens
        setAccessToken(data.accessToken);
        setRefreshToken(data.refreshToken);

        // Reintentar la peticion original con el nuevo token
        originalRequest.headers.Authorization = `Bearer ${data.accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        // Refresh fallo -> sesion expirada, ir a login
        clearTokens();
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  },
);
```

### 12.3 CRUD de Roles (flujo completo)

```
LISTAR ROLES:
  GET /admin/roles -> Array<{ role, userCount }>
  Mostrar tabla con nombre, descripcion, cantidad de usuarios, permisos

CREAR ROL:
  1. Mostrar formulario con name y description
  2. POST /admin/roles { name, description }
  3. Obtener el id del rol creado en la respuesta
  4. (Opcional) Asignar permisos inmediatamente:
     PATCH /admin/roles/:id/permissions { permissionIds: [...] }

VER/EDITAR ROL:
  1. GET /admin/roles/:id -> obtener rol con permisos actuales
  2. Mostrar formulario con datos editables
  3. PATCH /admin/roles/:id { name?, description? }

ASIGNAR PERMISOS A UN ROL:
  1. GET /admin/permissions -> obtener todos los permisos agrupados
  2. GET /admin/roles/:id -> obtener permisos actuales del rol
  3. Renderizar checkboxes agrupados por subject
  4. Pre-seleccionar los permisos que ya tiene el rol
  5. Al guardar: PATCH /admin/roles/:id/permissions { permissionIds: [...] }
     Enviar TODOS los IDs seleccionados (es reemplazo total)

ELIMINAR ROL:
  1. Confirmar con el usuario (mostrar userCount afectados)
  2. DELETE /admin/roles/:id
  3. Si es rol del sistema -> mostrar error 422 "No se puede eliminar"
```

### 12.4 CRUD de Usuarios (flujo completo)

```
LISTAR USUARIOS:
  GET /admin/users?page=1&limit=20 -> { data, meta }
  Implementar paginacion con meta.totalPages

CREAR USUARIO:
  1. Mostrar formulario: email, password, name
  2. POST /admin/users { email, password, name }
  3. (Opcional) Asignar roles inmediatamente:
     PATCH /admin/users/:id/roles { roleIds: [...] }

VER USUARIO CON ROLES:
  GET /admin/users/:id -> { user, roles }
  Mostrar datos del usuario y sus roles asignados

EDITAR USUARIO:
  PATCH /admin/users/:id { name }
  (Solo se puede editar el nombre actualmente)

ASIGNAR ROLES A UN USUARIO:
  1. GET /admin/roles -> obtener todos los roles disponibles
  2. GET /admin/users/:id -> obtener roles actuales del usuario
  3. Renderizar checkboxes o multi-select de roles
  4. Pre-seleccionar los roles que ya tiene
  5. Al guardar: PATCH /admin/users/:id/roles { roleIds: [...] }
     Enviar TODOS los IDs seleccionados (es reemplazo total)

DESACTIVAR USUARIO:
  1. Confirmar con el usuario
  2. DELETE /admin/users/:id
  3. El usuario queda con isActive: false (no se borra)
```

### 12.5 Proteccion de Rutas en el Frontend

Para proteger rutas en el frontend basandose en permisos, se recomienda:

```typescript
// 1. Despues del login, obtener los permisos del usuario
//    Opcion A: Decodificar el JWT (solo tiene userId y email, NO permisos)
//    Opcion B: Hacer GET /auth/me + consultar roles/permisos

// 2. Guardar permisos en el store global

// 3. Crear helper de verificacion
function userCan(action: string, subject: string): boolean {
  const permissions = getUserPermissions(); // desde tu store

  // Verificar permiso exacto
  if (permissions.some((p) => p.action === action && p.subject === subject))
    return true;

  // Verificar 'manage' sobre el subject
  if (permissions.some((p) => p.action === 'manage' && p.subject === subject))
    return true;

  // Verificar 'manage:all' (super admin)
  if (permissions.some((p) => p.action === 'manage' && p.subject === 'all'))
    return true;

  return false;
}

// 4. Usar en componentes y rutas
if (userCan('read', 'User')) {
  // mostrar menu de usuarios
}

if (userCan('create', 'Role')) {
  // mostrar boton "Crear Rol"
}
```

> **IMPORTANTE:** La proteccion en el frontend es solo cosmetic/UX. El backend SIEMPRE valida permisos. Si un usuario intenta acceder a un endpoint sin permisos, recibe `403` independientemente de lo que muestre el frontend.

---

## 13. Datos de Prueba (Seed)

### Ejecutar seed

```bash
pnpm exec prisma db seed
```

> **No uses `pnpx prisma`**, descarga Prisma 7.x del registry en vez de usar la version local. Siempre usa `pnpm exec prisma`.

### Usuario administrador por defecto

| Campo    | Valor              |
| -------- | ------------------ |
| Email    | `admin@hounfe.com` |
| Password | `Admin123!`        |
| Rol      | Super Admin        |
| Permiso  | `manage:all`       |

### Permisos auto-generados

Los 21 permisos se crean automaticamente cada vez que el servidor arranca (via `PermissionSeeder` en `OnApplicationBootstrap`). Es idempotente — se puede reiniciar el servidor sin problemas.

El rol "Super Admin" tambien se crea/actualiza automaticamente con el permiso `manage:all`.

---

## Resumen de Flujos Criticos

### Crear un rol con permisos (flujo completo)

```
1. GET /admin/permissions
   -> Obtener la lista de permisos agrupados (para mostrar checkboxes)

2. POST /admin/roles { name: "Vendedor", description: "Acceso a ventas" }
   -> Respuesta con { id: "nuevo-uuid", ... }

3. PATCH /admin/roles/nuevo-uuid/permissions { permissionIds: ["id-read-product", "id-create-order", "id-read-order"] }
   -> 200 OK (permisos asignados)
```

### Crear un usuario con rol (flujo completo)

```
1. GET /admin/roles
   -> Obtener roles disponibles (para mostrar selector)

2. POST /admin/users { email: "vendedor@hounfe.com", password: "Password1!", name: "Juan" }
   -> Respuesta con { id: "nuevo-uuid", ... }

3. PATCH /admin/users/nuevo-uuid/roles { roleIds: ["uuid-rol-vendedor"] }
   -> 200 OK (rol asignado)
```

### Verificar acceso de un usuario

```
1. POST /auth/login { email: "vendedor@hounfe.com", password: "Password1!" }
   -> { accessToken, refreshToken, user }

2. GET /admin/users (con Bearer token del vendedor)
   -> Si tiene permiso read:User -> 200 OK
   -> Si NO tiene permiso -> 403 INSUFFICIENT_PERMISSIONS
```
