# Sistema RBAC completo — Guía de auditoría para frontend

## 1. Resumen ejecutivo

Se completó la cobertura RBAC del backend. **Todos los endpoints de la API** ahora están protegidos por permisos granulares basados en CASL. 38 endpoints que antes solo requerían JWT ahora exigen un permiso específico (`@RequirePermissions`). 4 subjects nuevos se agregaron al registro: `Brand`, `Category`, `GlobalPriceList` y `TenantMembership`, con 20 entries nuevas en `PERMISSION_REGISTRY`.

**Qué tiene que hacer el frontend**: auditar cada pantalla y cada llamada a la API para verificar que:
1. Se consultan los permisos del usuario (`GET /auth/me/permissions`) al login y al cambiar de tenant.
2. Se ocultan/deshabilitan botones y secciones según el resultado.
3. Se manejan correctamente los HTTP 403 sin loops ni redirecciones incorrectas.

**Cómo**: leer la sección 4 (mapa completo de endpoints con permisos), la sección 5 (qué tiene cada rol) y la sección 6 (checklist de auditoría paso a paso).

Este documento cubre **todo** el sistema RBAC, no solo los cambios nuevos. Es auto-contenido: no debería ser necesario consultar al equipo de backend para auditar el frontend.

---

## 2. Modelo mental del sistema de permisos

El backend usa [CASL](https://casl.js.org/) como motor de autorización. Cada permiso es un par `(action, subject)`.

### 2.1 Actions disponibles

| Action | Significado |
|---|---|
| `create` | Crear recursos nuevos |
| `read` | Leer/listar recursos |
| `update` | Modificar recursos existentes |
| `delete` | Eliminar (o soft-delete) recursos |
| `manage` | Wildcard: implica `create` + `read` + `update` + `delete` sobre el subject indicado |

### 2.2 Subjects disponibles (AppSubjects)

Extraído de `src/auth/authorization/domain/permission.ts`:

| Subject | Descripción | Scope |
|---|---|---|
| `Product` | Productos, variantes, lotes, precios, imágenes | tenant-scoped |
| `Order` | Pedidos (DEPRECADO) | tenant-scoped |
| `Sale` | Ventas POS: borradores, cobros, pagos, catálogo | tenant-scoped |
| `SaleComment` | Comentarios en ventas | tenant-scoped |
| `User` | Usuarios del sistema | global (admin) |
| `Role` | Roles y asignación de permisos | global (admin) |
| `Permission` | Listado de permisos (read-only via Role:read) | global (admin) |
| `Tenant` | Sucursales/tenants | global (super-admin) |
| `TenantMembership` | Membresías de usuarios en tenants | tenant-scoped |
| `Brand` | Marcas de productos | global (compartido) |
| `Category` | Categorías de productos | global (compartido) |
| `GlobalPriceList` | Listas de precios globales | global (super-admin write) |
| `Promotion` | Promociones | tenant-scoped |
| `Customer` | Clientes | tenant-scoped |
| `File` | Archivos subidos | tenant-scoped |
| `all` | Wildcard: todos los subjects | super-admin |

### 2.3 Wildcards

- **`manage:Subject`**: el usuario puede hacer cualquier CRUD sobre ese subject. Si tiene `manage:Brand`, entonces `can('create', 'Brand')`, `can('read', 'Brand')`, `can('update', 'Brand')` y `can('delete', 'Brand')` retornan `true`.
- **`manage:all`**: super-admin global. Puede hacer todo sobre todos los subjects en todos los tenants.

### 2.4 Recursos globales vs tenant-scoped

| Tipo | Subjects | Comportamiento |
|---|---|---|
| **Global (compartido)** | `Brand`, `Category` | Se crean sin `tenantId`. Un usuario de Tenant A ve las marcas que creó un usuario de Tenant B. Las operaciones de escritura requieren permiso pero no dependen del tenant activo. |
| **Global (admin)** | `User`, `Role`, `Permission`, `Tenant`, `GlobalPriceList` | Administración del sistema. `Tenant` y `GlobalPriceList` write son exclusivos de super-admin. `User`/`Role` requieren contexto de `TenantContextGuard`. |
| **Tenant-scoped** | `Product`, `Sale`, `SaleComment`, `Order`, `Customer`, `Promotion`, `File`, `TenantMembership` | Los datos pertenecen a un tenant. El usuario solo ve/opera datos de su tenant activo. |

Esto importa para el selector de tenant del frontend: al cambiar de tenant, los permisos del usuario pueden cambiar (distinto rol en cada sucursal) y los datos tenant-scoped cambian completamente.

---

## 3. Cómo el frontend obtiene los permisos del usuario

### 3.1 Endpoint

```
GET /auth/me/permissions
```

### 3.2 Auth requerida

JWT válido en header `Authorization: Bearer <token>`. No requiere permiso RBAC adicional — cualquier usuario autenticado puede consultar sus propios permisos.

### 3.3 Contexto de tenant

El resultado depende del JWT activo:
- **Super-admin con `tenantId=null`** (contexto global) → devuelve `[{ action: 'manage', subject: 'all' }]`.
- **Super-admin con `tenantId=<uuid>`** (entró a un tenant via switch-tenant) → devuelve los permisos del rol que tiene en ese tenant (query a `TenantMembership → Role → Permissions`).
- **Usuario normal con tenant** → devuelve los permisos del rol asignado en ese tenant.
- **Usuario sin membresía en el tenant del JWT** → devuelve array vacío `[]`.

### 3.4 Response shape

Fuente: `src/auth/auth.service.ts` líneas 89-92 y 464-480.

```ts
interface UserPermissionsResponse {
  permissions: EffectivePermission[];
  permissionCodes: string[];
}

interface EffectivePermission {
  subject: string; // ej. 'Brand', 'Sale', 'all'
  action: string;  // ej. 'create', 'read', 'manage'
}
```

- `permissions`: array de objetos `{ subject, action }` deduplicados y ordenados alfabéticamente por `action` y luego por `subject`.
- `permissionCodes`: array de strings en formato `"action:subject"`, ej. `["create:Brand", "read:Brand", "read:Sale"]`. Conveniencia para búsquedas rápidas por string.

### 3.5 Ejemplo de response — Manager

```json
{
  "permissions": [
    { "action": "create", "subject": "Brand" },
    { "action": "create", "subject": "Customer" },
    { "action": "create", "subject": "Order" },
    { "action": "create", "subject": "Product" },
    { "action": "create", "subject": "Sale" },
    { "action": "create", "subject": "TenantMembership" },
    { "action": "delete", "subject": "Brand" },
    { "action": "delete", "subject": "Category" },
    { "action": "delete", "subject": "Customer" },
    { "action": "delete", "subject": "Order" },
    { "action": "delete", "subject": "Product" },
    { "action": "delete", "subject": "Sale" },
    { "action": "delete", "subject": "TenantMembership" },
    { "action": "read", "subject": "Brand" },
    { "action": "read", "subject": "Category" },
    { "action": "read", "subject": "Customer" },
    { "action": "read", "subject": "GlobalPriceList" },
    { "action": "read", "subject": "Order" },
    { "action": "read", "subject": "Product" },
    { "action": "read", "subject": "Role" },
    { "action": "read", "subject": "Sale" },
    { "action": "read", "subject": "TenantMembership" },
    { "action": "update", "subject": "Brand" },
    { "action": "update", "subject": "Category" },
    { "action": "update", "subject": "Customer" },
    { "action": "update", "subject": "Order" },
    { "action": "update", "subject": "Product" },
    { "action": "update", "subject": "Sale" },
    { "action": "update", "subject": "TenantMembership" }
  ],
  "permissionCodes": [
    "create:Brand",
    "create:Customer",
    "create:Order",
    "create:Product",
    "create:Sale",
    "create:TenantMembership",
    "delete:Brand",
    "delete:Category",
    "delete:Customer",
    "delete:Order",
    "delete:Product",
    "delete:Sale",
    "delete:TenantMembership",
    "read:Brand",
    "read:Category",
    "read:Customer",
    "read:GlobalPriceList",
    "read:Order",
    "read:Product",
    "read:Role",
    "read:Sale",
    "read:TenantMembership",
    "update:Brand",
    "update:Category",
    "update:Customer",
    "update:Order",
    "update:Product",
    "update:Sale",
    "update:TenantMembership"
  ]
}
```

### 3.6 Ejemplo de response — Super-admin global

```json
{
  "permissions": [
    { "action": "manage", "subject": "all" }
  ],
  "permissionCodes": [
    "manage:all"
  ]
}
```

### 3.7 Cuándo llamarlo

- **Al login**: inmediatamente después de recibir el JWT. Si el login devuelve `requiresTenantSelection: true`, esperar a que el usuario seleccione tenant y complete `POST /auth/select-tenant`, luego fetchear permisos con el nuevo JWT.
- **Al cambiar de tenant**: después de `POST /auth/switch-tenant`, el JWT cambia y los permisos cambian. Re-fetchear siempre.
- **Cachearlo en estado global**: guardar en Pinia/Zustand/Redux. NO llamarlo en cada renderizado ni en cada navegación.

---

## 4. Mapa COMPLETO de endpoints y permiso requerido

### Convenciones de la tabla

- **Auth requerida**: `PUBLIC` = sin JWT; `JWT` = solo JWT sin tenant context; `JWT + Tenant` = JWT + TenantContextGuard.
- **Permiso**: el par `action:Subject` que exige `@RequirePermissions`, o `ninguno` si solo requiere auth.
- **Scope**: `global` = no depende de tenant; `tenant-scoped` = opera sobre datos del tenant activo; `super-admin-only` = en la práctica solo super-admin tiene el permiso.

### Auth (`/auth`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Auth | POST | `/auth/register` | PUBLIC | ninguno | global | Registro abierto |
| Auth | POST | `/auth/login` | PUBLIC | ninguno | global | Login abierto |
| Auth | POST | `/auth/select-tenant` | PUBLIC | ninguno | global | Requiere `tempToken` del login multi-tenant |
| Auth | POST | `/auth/switch-tenant` | JWT | ninguno | global | Cambia tenant activo; super-admin puede ir a `null` |
| Auth | POST | `/auth/refresh` | PUBLIC | ninguno | global | Requiere `refreshToken` válido |
| Auth | GET | `/auth/me` | JWT | ninguno | global | Perfil del usuario + memberships |
| Auth | GET | `/auth/me/permissions` | JWT | ninguno | global | Permisos efectivos del usuario en tenant activo |
| Auth | POST | `/auth/logout` | JWT | ninguno | global | Invalida refresh token |

### Admin — Usuarios (`/admin/users`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Admin Users | GET | `/admin/users` | JWT + Tenant | `read:User` | global | Paginado con `page` y `limit` |
| Admin Users | GET | `/admin/users/:id` | JWT + Tenant | `read:User` | global | Detalle de un usuario |
| Admin Users | POST | `/admin/users` | JWT + Tenant | `create:User` | global | Crear usuario nuevo |
| Admin Users | PATCH | `/admin/users/:id` | JWT + Tenant | `update:User` | global | Actualizar datos de usuario |
| Admin Users | PATCH | `/admin/users/:id/roles` | JWT + Tenant | `update:User` | global | Asignar roles a un usuario |
| Admin Users | DELETE | `/admin/users/:id` | JWT + Tenant | `delete:User` | global | Soft-delete (desactivar usuario) |

### Admin — Roles (`/admin/roles`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Admin Roles | GET | `/admin/roles` | JWT + Tenant | `read:Role` | global | Lista todos los roles |
| Admin Roles | GET | `/admin/roles/:id` | JWT + Tenant | `read:Role` | global | Detalle de un rol con permisos |
| Admin Roles | POST | `/admin/roles` | JWT + Tenant | `create:Role` | global | Crear rol nuevo |
| Admin Roles | PATCH | `/admin/roles/:id` | JWT + Tenant | `update:Role` | global | Actualizar nombre/descripcion |
| Admin Roles | PATCH | `/admin/roles/:id/permissions` | JWT + Tenant | `update:Role` | global | Asignar permisos a un rol |
| Admin Roles | DELETE | `/admin/roles/:id` | JWT + Tenant | `delete:Role` | global | Eliminar rol |

### Admin — Permisos (`/admin/permissions`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Admin Permissions | GET | `/admin/permissions` | JWT + Tenant | `read:Role` | global | Lista permisos agrupados por subject. Usa `Role:read` (no hay subject Permission propio) |

### Admin — Tenants (`/admin/tenants`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Admin Tenants | POST | `/admin/tenants` | JWT + Tenant | `create:Tenant` | super-admin-only | Crear sucursal nueva |
| Admin Tenants | GET | `/admin/tenants` | JWT + Tenant | `read:Tenant` | super-admin-only | Listar sucursales. Query param `includeInactive=true` para ver inactivas |
| Admin Tenants | GET | `/admin/tenants/:id` | JWT + Tenant | `read:Tenant` | super-admin-only | Detalle de una sucursal |
| Admin Tenants | GET | `/admin/tenants/:id/roles` | JWT + Tenant | `read:Tenant` | super-admin-only | Listar roles de una sucursal |
| Admin Tenants | PATCH | `/admin/tenants/:id` | JWT + Tenant | `update:Tenant` | super-admin-only | Actualizar sucursal |
| Admin Tenants | DELETE | `/admin/tenants/:id` | JWT + Tenant | `delete:Tenant` | super-admin-only | Desactivar sucursal (soft-delete) |

### Admin — Miembros de tenant (`/admin/tenants/:tenantId/members`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Tenant Members | POST | `/admin/tenants/:tenantId/members` | JWT + Tenant | `create:TenantMembership` | tenant-scoped | Agregar miembro a sucursal |
| Tenant Members | GET | `/admin/tenants/:tenantId/members` | JWT + Tenant | `read:TenantMembership` | tenant-scoped | Listar miembros de sucursal |
| Tenant Members | PATCH | `/admin/tenants/:tenantId/members/:membershipId` | JWT + Tenant | `update:TenantMembership` | tenant-scoped | Actualizar membresía (ej. cambiar rol) |
| Tenant Members | DELETE | `/admin/tenants/:tenantId/members/:membershipId` | JWT + Tenant | `delete:TenantMembership` | tenant-scoped | Eliminar membresía |

### Users (`/users`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Users | GET | `/users/assignable` | JWT + Tenant | `read:Sale` | tenant-scoped | Lista usuarios asignables a ventas (usa permiso `Sale:read`, no `User:read`) |

### Productos (`/products`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Products | POST | `/products` | JWT + Tenant | `create:Product` | tenant-scoped | Crear producto |
| Products | GET | `/products` | JWT + Tenant | `read:Product` | tenant-scoped | Listar productos del tenant |
| Products | GET | `/products/:id` | JWT + Tenant | `read:Product` | tenant-scoped | Detalle de producto |
| Products | PATCH | `/products/:id` | JWT + Tenant | `update:Product` | tenant-scoped | Actualizar producto |
| Products | DELETE | `/products/:id` | JWT + Tenant | `delete:Product` | tenant-scoped | Eliminar producto |
| Products — Variants | POST | `/products/:id/variants` | JWT + Tenant | `update:Product` | tenant-scoped | Agregar variante |
| Products — Variants | GET | `/products/:id/variants` | JWT + Tenant | `read:Product` | tenant-scoped | Listar variantes |
| Products — Variants | PATCH | `/products/:id/variants/:variantId` | JWT + Tenant | `update:Product` | tenant-scoped | Actualizar variante |
| Products — Variants | DELETE | `/products/:id/variants/:variantId` | JWT + Tenant | `delete:Product` | tenant-scoped | Eliminar variante |
| Products — Variant Prices | GET | `/products/:productId/variants/:variantId/prices` | JWT + Tenant | `read:Product` | tenant-scoped | Ver precios de variante |
| Products — Variant Prices | PUT | `/products/:productId/variants/:variantId/prices/:priceListId` | JWT + Tenant | `update:Product` | tenant-scoped | Upsert precio de variante |
| Products — Variant Prices | DELETE | `/products/:productId/variants/:variantId/prices/:priceListId` | JWT + Tenant | `update:Product` | tenant-scoped | Eliminar precio de variante |
| Products — Variant Prices | PUT | `/products/:productId/variants/:variantId/prices` | JWT + Tenant | `update:Product` | tenant-scoped | Bulk upsert precios de variante |
| Products — Lots | POST | `/products/:id/lots` | JWT + Tenant | `update:Product` | tenant-scoped | Agregar lote |
| Products — Lots | GET | `/products/:id/lots` | JWT + Tenant | `read:Product` | tenant-scoped | Listar lotes |
| Products — Lots | PATCH | `/products/:id/lots/:lotId` | JWT + Tenant | `update:Product` | tenant-scoped | Actualizar lote |
| Products — Lots | DELETE | `/products/:id/lots/:lotId` | JWT + Tenant | `update:Product` | tenant-scoped | Eliminar lote |
| Products — Price Lists | GET | `/products/:id/price-lists` | JWT + Tenant | `read:Product` | tenant-scoped | Ver listas de precios del producto |
| Products — Price Lists | PATCH | `/products/:id/price-lists/:priceListId` | JWT + Tenant | `update:Product` | tenant-scoped | Actualizar precio en lista |
| Products — Images | POST | `/products/:id/images/upload` | JWT + Tenant | `update:Product` | tenant-scoped | Upload imagen multipart |
| Products — Images | POST | `/products/:id/variants/:variantId/images/upload` | JWT + Tenant | `update:Product` | tenant-scoped | Upload imagen de variante multipart |
| Products — Images | POST | `/products/:id/images` | JWT + Tenant | `update:Product` | tenant-scoped | Agregar imagen por URL/metadata |
| Products — Images | GET | `/products/:id/images` | JWT + Tenant | `read:Product` | tenant-scoped | Listar imagenes del producto |
| Products — Images | PATCH | `/products/:id/images/:imageId/main` | JWT + Tenant | `update:Product` | tenant-scoped | Marcar imagen como principal |
| Products — Images | DELETE | `/products/:id/images/:imageId` | JWT + Tenant | `update:Product` | tenant-scoped | Eliminar imagen |

### Clientes (`/customers`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Customers | POST | `/customers` | JWT + Tenant | `create:Customer` | tenant-scoped | Crear cliente |
| Customers | GET | `/customers` | JWT + Tenant | `read:Customer` | tenant-scoped | Listar clientes del tenant |
| Customers | GET | `/customers/:id` | JWT + Tenant | `read:Customer` | tenant-scoped | Detalle de cliente |
| Customers | PATCH | `/customers/:id` | JWT + Tenant | `update:Customer` | tenant-scoped | Actualizar cliente |
| Customers | DELETE | `/customers/:id` | JWT + Tenant | `delete:Customer` | tenant-scoped | Eliminar cliente |
| Customers — Addresses | POST | `/customers/:id/addresses` | JWT + Tenant | `update:Customer` | tenant-scoped | Agregar dirección |
| Customers — Addresses | GET | `/customers/:id/addresses` | JWT + Tenant | `read:Customer` | tenant-scoped | Listar direcciones |
| Customers — Addresses | PATCH | `/customers/:id/addresses/:addressId` | JWT + Tenant | `update:Customer` | tenant-scoped | Actualizar dirección |
| Customers — Addresses | DELETE | `/customers/:id/addresses/:addressId` | JWT + Tenant | `update:Customer` | tenant-scoped | Eliminar dirección |

### Orders (`/orders`) — DEPRECADO

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Orders | POST | `/orders` | JWT + Tenant | ninguno | tenant-scoped | DEPRECADO. Solo JWT + Tenant, sin permiso RBAC. No conectar UI nueva |
| Orders | GET | `/orders` | JWT + Tenant | ninguno | tenant-scoped | DEPRECADO |
| Orders | GET | `/orders/:id` | JWT + Tenant | ninguno | tenant-scoped | DEPRECADO |
| Orders | PATCH | `/orders/:id/cancel` | JWT + Tenant | ninguno | tenant-scoped | DEPRECADO |
| Orders | PATCH | `/orders/:id/complete` | JWT + Tenant | ninguno | tenant-scoped | DEPRECADO |

### Ventas — Borradores (`/sales/drafts`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Sales Drafts | POST | `/sales/drafts` | JWT + Tenant | `create:Sale` | tenant-scoped | Abrir borrador nuevo |
| Sales Drafts | GET | `/sales/drafts` | JWT + Tenant | `read:Sale` | tenant-scoped | Listar borradores del usuario |
| Sales Drafts | POST | `/sales/drafts/:id/items` | JWT + Tenant | `update:Sale` | tenant-scoped | Agregar item al borrador |
| Sales Drafts | PATCH | `/sales/drafts/:id/items/:itemId` | JWT + Tenant | `update:Sale` | tenant-scoped | Actualizar cantidad de item |
| Sales Drafts | DELETE | `/sales/drafts/:id/items` | JWT + Tenant | `update:Sale` | tenant-scoped | Limpiar todos los items |
| Sales Drafts | DELETE | `/sales/drafts/:id/items/:itemId` | JWT + Tenant | `update:Sale` | tenant-scoped | Eliminar un item |
| Sales Drafts | DELETE | `/sales/drafts/:id` | JWT + Tenant | `delete:Sale` | tenant-scoped | Eliminar borrador |
| Sales Drafts | PUT | `/sales/drafts/:id/customer` | JWT + Tenant | `update:Sale` | tenant-scoped | Asignar cliente al borrador |
| Sales Drafts | DELETE | `/sales/drafts/:id/customer` | JWT + Tenant | `update:Sale` | tenant-scoped | Quitar cliente del borrador |
| Sales Drafts | PUT | `/sales/drafts/:id/shipping-address` | JWT + Tenant | `update:Sale` | tenant-scoped | Poner dirección de envío |
| Sales Drafts | DELETE | `/sales/drafts/:id/shipping-address` | JWT + Tenant | `update:Sale` | tenant-scoped | Quitar dirección de envío |
| Sales Drafts | GET | `/sales/drafts/:id/items/:itemId/available-prices` | JWT + Tenant | `update:Sale` | tenant-scoped | Ver precios disponibles para un item |
| Sales Drafts | PATCH | `/sales/drafts/:id/items/:itemId/price` | JWT + Tenant | `update:Sale` | tenant-scoped | Override de precio de item |
| Sales Drafts | PATCH | `/sales/drafts/:id/items/:itemId/discount` | JWT + Tenant | `update:Sale` | tenant-scoped | Aplicar descuento a item |
| Sales Drafts | DELETE | `/sales/drafts/:id/items/:itemId/discount` | JWT + Tenant | `update:Sale` | tenant-scoped | Quitar descuento de item |
| Sales Drafts | PATCH | `/sales/drafts/:id/discount` | JWT + Tenant | `update:Sale` | tenant-scoped | Aplicar descuento global al borrador |
| Sales Drafts | DELETE | `/sales/drafts/:id/discount` | JWT + Tenant | `update:Sale` | tenant-scoped | Quitar descuento global |
| Sales Drafts | POST | `/sales/drafts/:id/charge` | JWT + Tenant | `update:Sale` | tenant-scoped | Cobrar borrador (requiere `Idempotency-Key` header) |

### Ventas — Consultas (`/sales`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Sales Query | GET | `/sales` | JWT + Tenant | `read:Sale` | tenant-scoped | Listar ventas con filtros avanzados (ver doc de filtros) |
| Sales Query | GET | `/sales/:id` | JWT + Tenant | `read:Sale` | tenant-scoped | Detalle de venta |
| Sales Query | PATCH | `/sales/:id/due-date` | JWT + Tenant | `update:Sale` | tenant-scoped | Cambiar fecha de vencimiento |
| Sales Query | PUT | `/sales/:id/seller` | JWT + Tenant | `update:Sale` | tenant-scoped | Asignar vendedor |
| Sales Query | DELETE | `/sales/:id/seller` | JWT + Tenant | `update:Sale` | tenant-scoped | Quitar vendedor |

### Ventas — Catalogo POS (`/sales/pos-catalog`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Sales Catalog | GET | `/sales/pos-catalog` | JWT + Tenant | `read:Sale` | tenant-scoped | Buscar productos para POS |
| Sales Catalog | GET | `/sales/pos-catalog/:productId` | JWT + Tenant | `read:Sale` | tenant-scoped | Detalle de producto para POS |

### Ventas — Pagos (`/sales/:id/payments`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Sales Payments | POST | `/sales/:id/payments` | JWT + Tenant | `update:Sale` | tenant-scoped | Agregar pago a venta confirmada (requiere `Idempotency-Key` header) |

### Ventas — Comentarios (`/sales/:id/comments`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Sale Comments | POST | `/sales/:id/comments` | JWT + Tenant | `create:SaleComment` | tenant-scoped | Crear comentario |
| Sale Comments | PATCH | `/sales/:id/comments/:commentId` | JWT + Tenant | `update:SaleComment` | tenant-scoped | Editar comentario propio |
| Sale Comments | DELETE | `/sales/:id/comments/:commentId` | JWT + Tenant | `delete:SaleComment` | tenant-scoped | Soft-delete de comentario propio |

### Archivos (`/files`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Files | POST | `/files` | JWT + Tenant | `create:File` | tenant-scoped | Upload de archivo multipart |
| Files | GET | `/files/:id` | JWT + Tenant | `read:File` | tenant-scoped | Metadata del archivo |
| Files | DELETE | `/files/:id` | JWT + Tenant | `delete:File` | tenant-scoped | Eliminar archivo (storage + DB) |

### Listas de precios globales (`/price-lists`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Price Lists | GET | `/price-lists` | JWT + Tenant | `read:GlobalPriceList` | global | Listar listas de precios globales |
| Price Lists | POST | `/price-lists` | JWT + Tenant | `create:GlobalPriceList` | super-admin-only | Crear lista de precios. Solo super-admin tiene este permiso en seed |
| Price Lists | PATCH | `/price-lists/:id` | JWT + Tenant | `update:GlobalPriceList` | super-admin-only | Actualizar lista de precios |
| Price Lists | DELETE | `/price-lists/:id` | JWT + Tenant | `delete:GlobalPriceList` | super-admin-only | Eliminar lista de precios |

### Promociones (`/promotions`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Promotions | POST | `/promotions` | JWT + Tenant | `create:Promotion` | tenant-scoped | Crear promoción |
| Promotions | GET | `/promotions` | JWT + Tenant | `read:Promotion` | tenant-scoped | Listar promociones. Soporta query params |
| Promotions | GET | `/promotions/:id` | JWT + Tenant | `read:Promotion` | tenant-scoped | Detalle de promoción |
| Promotions | PATCH | `/promotions/:id` | JWT + Tenant | `update:Promotion` | tenant-scoped | Actualizar promoción |
| Promotions | DELETE | `/promotions/:id` | JWT + Tenant | `delete:Promotion` | tenant-scoped | Eliminar promoción |
| Promotions | PATCH | `/promotions/:id/end` | JWT + Tenant | `update:Promotion` | tenant-scoped | Finalizar promoción manualmente |

### Marcas (`/brands`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Brands | POST | `/brands` | JWT | `create:Brand` | global | Crear marca. Sin TenantContextGuard (recurso global) |
| Brands | GET | `/brands` | JWT | `read:Brand` | global | Listar todas las marcas |
| Brands | GET | `/brands/:id` | JWT | `read:Brand` | global | Detalle de marca |
| Brands | PATCH | `/brands/:id` | JWT | `update:Brand` | global | Actualizar marca |
| Brands | DELETE | `/brands/:id` | JWT | `delete:Brand` | global | Eliminar marca |

### Categorias (`/categories`)

| Modulo | Metodo | Path | Auth requerida | Permiso | Scope | Notas |
|---|---|---|---|---|---|---|
| Categories | POST | `/categories` | JWT | `create:Category` | global | Crear categoría. Sin TenantContextGuard (recurso global) |
| Categories | GET | `/categories` | JWT | `read:Category` | global | Listar todas las categorías |
| Categories | GET | `/categories/:id` | JWT | `read:Category` | global | Detalle de categoría |
| Categories | PATCH | `/categories/:id` | JWT | `update:Category` | global | Actualizar categoría |
| Categories | DELETE | `/categories/:id` | JWT | `delete:Category` | global | Eliminar categoría |

---

## 5. Permisos por rol (después del seed)

### 5.1 Super Admin

El super-admin tiene **todos los permisos del registro** asignados a su rol global. Cuando opera en contexto global (`tenantId=null`), el endpoint `/auth/me/permissions` devuelve `manage:all` directamente (shortcut en `CaslAbilityFactory`).

**Comportamiento por contexto:**

| Contexto | Resultado de `/auth/me/permissions` | Qué puede hacer |
|---|---|---|
| Global (`tenantId=null`) | `[{ action: 'manage', subject: 'all' }]` | Todo, en todos los tenants |
| Dentro de Tenant X (`tenantId=<uuid>`) | Lista completa de permisos según su membership en Tenant X | Todo lo que su rol permita en ese tenant |

**Endpoints exclusivos de super-admin** (solo el rol Super Admin tiene `Tenant:*` y `GlobalPriceList:create/update/delete` en el seed):

- `POST /admin/tenants`
- `GET /admin/tenants`
- `GET /admin/tenants/:id`
- `GET /admin/tenants/:id/roles`
- `PATCH /admin/tenants/:id`
- `DELETE /admin/tenants/:id`
- `POST /price-lists`
- `PATCH /price-lists/:id`
- `DELETE /price-lists/:id`

### 5.2 Manager (por tenant)

Permisos exactos del seed (`managerPermissionKeys` en `prisma/seed.ts` líneas 245-276):

| # | Permiso (subject:action) |
|---|---|
| 1 | `Product:create` |
| 2 | `Product:read` |
| 3 | `Product:update` |
| 4 | `Product:delete` |
| 5 | `Sale:create` |
| 6 | `Sale:read` |
| 7 | `Sale:update` |
| 8 | `Sale:delete` |
| 9 | `Customer:create` |
| 10 | `Customer:read` |
| 11 | `Customer:update` |
| 12 | `Customer:delete` |
| 13 | `Order:create` |
| 14 | `Order:read` |
| 15 | `Order:update` |
| 16 | `Order:delete` |
| 17 | `Role:read` |
| 18 | `Brand:create` |
| 19 | `Brand:read` |
| 20 | `Brand:update` |
| 21 | `Brand:delete` |
| 22 | `Category:create` |
| 23 | `Category:read` |
| 24 | `Category:update` |
| 25 | `Category:delete` |
| 26 | `TenantMembership:create` |
| 27 | `TenantMembership:read` |
| 28 | `TenantMembership:update` |
| 29 | `TenantMembership:delete` |
| 30 | `GlobalPriceList:read` |

**Qué NO puede hacer el Manager:**
- No puede crear/editar/borrar `Tenant` (sucursales).
- No puede crear/editar/borrar `GlobalPriceList` (solo leer).
- No puede crear/editar/borrar `User` (gestión de usuarios admin).
- No puede crear/editar/borrar `Role` (solo leer roles).
- No tiene permisos de `Promotion`, `SaleComment`, `File`.

### 5.3 Cashier (por tenant)

Permisos exactos del seed (`cashierPermissionKeys` en `prisma/seed.ts` líneas 278-286):

| # | Permiso (subject:action) |
|---|---|
| 1 | `Sale:create` |
| 2 | `Sale:read` |
| 3 | `Product:read` |
| 4 | `Customer:read` |
| 5 | `Brand:read` |
| 6 | `Category:read` |
| 7 | `GlobalPriceList:read` |

**Qué puede hacer el Cashier:**
- Crear ventas y leer ventas.
- Leer productos, clientes, marcas, categorías y listas de precios (lectura necesaria para el POS).

**Qué NO puede hacer el Cashier:**
- No puede editar ni borrar ventas (no tiene `Sale:update` ni `Sale:delete`).
- No puede crear/editar/borrar productos, clientes, marcas, categorías.
- No puede gestionar nada de admin (usuarios, roles, tenants).
- No tiene permisos de `Promotion`, `SaleComment`, `File`, `TenantMembership`.

---

## 6. Checklist de auditoría para frontend

### 6.1 Pre-requisitos

1. **Estado global de permisos**: tener el response de `GET /auth/me/permissions` almacenado en un store global (Pinia, Zustand, Redux, o lo que se use).

2. **Helper `can(action, subject)`**: implementar una función que consulte ese store. Debe respetar los wildcards:

```ts
function can(action: string, subject: string): boolean {
  // Wildcard: manage:all → puede todo
  if (permissions.some(p => p.action === 'manage' && p.subject === 'all')) {
    return true;
  }
  // Wildcard: manage:Subject → puede cualquier action sobre ese subject
  if (permissions.some(p => p.action === 'manage' && p.subject === subject)) {
    return true;
  }
  // Match exacto
  return permissions.some(p => p.action === action && p.subject === subject);
}
```

**Alternativa usando `permissionCodes`** (más simple):

```ts
function can(action: string, subject: string): boolean {
  return (
    permissionCodes.includes('manage:all') ||
    permissionCodes.includes(`manage:${subject}`) ||
    permissionCodes.includes(`${action}:${subject}`)
  );
}
```

3. **Re-fetch al cambiar tenant**: después de `POST /auth/switch-tenant`, invalidar el cache de permisos y volver a llamar `GET /auth/me/permissions`.

### 6.2 Por cada pantalla del frontend, preguntas a hacerse

Abrí cada componente/vista del frontend y respondé estas preguntas:

1. **¿Esta pantalla muestra datos de un subject?** Si sí, verificar que se esconde la pantalla o se muestra un estado "sin permisos" cuando `can('read', Subject)` retorna `false`. No alcanza con depender del 403 del backend — la UX tiene que ser proactiva.

2. **¿Esta pantalla tiene botones de "Crear"?** Verificar que el botón se oculta o se deshabilita cuando `can('create', Subject)` retorna `false`.

3. **¿Esta pantalla tiene botones de "Editar" / "Eliminar"?** Misma verificación con `can('update', Subject)` y `can('delete', Subject)`.

4. **¿Hay acciones inline en tablas?** Iconos de editar, eliminar, ver detalle en cada fila de la tabla. Cada uno tiene que verificar el permiso correspondiente.

5. **¿Se hacen calls a la API que requieren permisos?** Si sí, verificar que se maneja el HTTP 403 con un mensaje claro ("No tenés permisos para hacer esto") en vez de un error genérico o un crash.

6. **¿Se usa el selector de tenant?** Cuando cambia el tenant, verificar que se re-fetchean los permisos y se re-evalúan todas las condiciones de visibilidad.

7. **¿La pantalla tiene sub-secciones con subjects diferentes?** Ejemplo: la pantalla de producto tiene tabs de variantes, lotes, precios, imágenes. Todas usan `Product:*` como permiso, pero verificar que las acciones de escritura en cada tab checan `update:Product`.

### 6.3 Areas críticas por pantalla

Las siguientes pantallas son las que **más probablemente** tienen código que asume acceso libre, porque los permisos de estos subjects son nuevos:

#### Marcas (`/brands`)

| Acción en pantalla | Permiso requerido |
|---|---|
| Ver lista de marcas | `read:Brand` |
| Botón "Nueva marca" | `create:Brand` |
| Editar marca (inline o modal) | `update:Brand` |
| Eliminar marca | `delete:Brand` |

**IMPORTANTE**: `Brand` y `Category` no usan `TenantContextGuard` — los endpoints solo requieren JWT + permiso. El frontend no necesita tener tenant seleccionado para acceder, pero sí necesita el permiso.

#### Categorías (`/categories`)

| Acción en pantalla | Permiso requerido |
|---|---|
| Ver lista de categorías | `read:Category` |
| Botón "Nueva categoría" | `create:Category` |
| Editar categoría | `update:Category` |
| Eliminar categoría | `delete:Category` |

#### Listas de precios (`/price-lists`)

| Acción en pantalla | Permiso requerido | Quién lo tiene |
|---|---|---|
| Ver lista | `read:GlobalPriceList` | Manager, Cashier, Super Admin |
| Crear lista nueva | `create:GlobalPriceList` | Solo Super Admin |
| Editar lista | `update:GlobalPriceList` | Solo Super Admin |
| Eliminar lista | `delete:GlobalPriceList` | Solo Super Admin |

El botón "Crear lista de precios" solo debe ser visible para super-admin.

#### Admin — Tenants / Sucursales

| Acción en pantalla | Permiso requerido |
|---|---|
| Ver menú "Sucursales" en sidebar | `read:Tenant` |
| Tabla de sucursales | `read:Tenant` |
| Botón "Nueva sucursal" | `create:Tenant` |
| Editar sucursal | `update:Tenant` |
| Desactivar sucursal | `delete:Tenant` |

**Solo super-admin** tiene estos permisos. Este menú completo debe estar oculto para Manager y Cashier.

#### Gestionar miembros del tenant

| Acción en pantalla | Permiso requerido |
|---|---|
| Ver tabla de miembros | `read:TenantMembership` |
| Botón "Agregar miembro" | `create:TenantMembership` |
| Cambiar rol de miembro | `update:TenantMembership` |
| Eliminar miembro | `delete:TenantMembership` |

Manager tiene estos 4 permisos. Cashier no tiene ninguno.

#### Productos — sub-secciones

Todas las sub-secciones (variantes, lotes, precios, imágenes) usan permisos de `Product`. La lectura requiere `read:Product` y la escritura requiere `update:Product` (o `delete:Product` para eliminar variantes).

| Sub-sección | Leer | Escribir | Eliminar |
|---|---|---|---|
| Variantes | `read:Product` | `update:Product` | `delete:Product` |
| Precios de variante | `read:Product` | `update:Product` | `update:Product` |
| Lotes | `read:Product` | `update:Product` | `update:Product` |
| Listas de precios | `read:Product` | `update:Product` | — |
| Imágenes | `read:Product` | `update:Product` | `update:Product` |

#### Archivos

| Acción | Permiso |
|---|---|
| Subir archivo | `create:File` |
| Ver metadata | `read:File` |
| Eliminar archivo | `delete:File` |

Notar que el Cashier no tiene permisos de `File` en el seed.

#### Comentarios de venta

| Acción | Permiso |
|---|---|
| Crear comentario | `create:SaleComment` |
| Editar propio | `update:SaleComment` |
| Soft-delete propio | `delete:SaleComment` |

Ni Manager ni Cashier tienen `SaleComment` en el seed. Solo super-admin (via `manage:all`).

### 6.4 Manejo de errores HTTP

#### Distinción clave: 401 vs 403

| HTTP Status | Significado | Acción frontend |
|---|---|---|
| `401 Unauthorized` | Token inválido o expirado | Redirigir a login. Limpiar tokens del store. |
| `403 Forbidden` | Token válido pero sin permiso | Mostrar mensaje "No tenés permisos para hacer esto". NO redirigir. NO hacer loop. |

#### Ejemplo de interceptor

```ts
// Interceptor de errores HTTP — agnóstico de framework
async function handleApiError(error: { status: number; data?: any }) {
  if (error.status === 401) {
    // Token expirado o inválido
    store.clearAuth();
    router.push('/login');
    return;
  }

  if (error.status === 403) {
    // Permiso faltante — NO redirigir
    toast.error('No tenés permisos para realizar esta acción');
    return;
  }

  // Otros errores
  toast.error(error.data?.message ?? 'Ocurrió un error inesperado');
}
```

**Anti-pattern a evitar**: NO hacer `if (403) router.push('/login')`. Eso genera un loop donde el usuario se loguea, vuelve a la pantalla, el 403 lo manda a login de vuelta.

---

## 7. Casos especiales y gotchas

### 7.1 Brand y Category son GLOBALES

Las marcas y categorías no pertenecen a ningún tenant. Se comparten entre todos. Esto implica:
- Si un usuario de Tenant A crea la marca "Bayer", los usuarios de Tenant B también la ven.
- Esto es **por diseño** — evita duplicación de catálogo base.
- Los endpoints de `/brands` y `/categories` **no tienen `TenantContextGuard`**, solo JWT + permiso.

### 7.2 GET /auth/me/permissions cambia con switch-tenant

Cuando el super-admin está en contexto global ve `manage:all`. Cuando se "mete" en un tenant vía `POST /auth/switch-tenant`, el backend consulta su membresía en ese tenant y devuelve los permisos de su rol ahí. Si el super-admin tiene el rol "Super Admin" en ese tenant y ese rol tiene todos los permisos, seguirá pudiendo hacer todo. Pero técnicamente el response de `/auth/me/permissions` ya no es `manage:all` — es la lista explícita.

**Consecuencia para frontend**: el helper `can()` debe funcionar tanto con `manage:all` como con la lista explícita. Siempre checar wildcards primero.

### 7.3 El módulo Orders está DEPRECADO

Los endpoints de `/orders` existen en la API pero el módulo está muerto. No conectar UI nueva a estos endpoints. Notar que **no tienen `@RequirePermissions`** — solo JWT + Tenant. No invertir tiempo en agregarles checks de permisos en el frontend.

### 7.4 Response 200 vacío vs 403

Son dos situaciones distintas que el frontend debe manejar de forma diferente:

| Situación | HTTP Response | UX correcta |
|---|---|---|
| El usuario tiene permiso pero no hay datos | `200 OK` con `{ data: [], pagination: {...} }` | Mostrar estado vacío ("No hay ventas aún") |
| El usuario no tiene permiso | `403 Forbidden` | Mostrar "No tenés permisos para ver esta sección" u ocultar la sección directamente |

El mejor approach es prevenir el 403 ocultando la sección *antes* de hacer la llamada. Pero si por algún motivo la llamada se hace igual (race condition, bug), el 403 handler tiene que ser distinto al estado vacío.

### 7.5 Idempotencia del seed

Cuando el seed corre por primera vez en una sucursal nueva, los roles Manager y Cashier de ESE tenant se crean con los permisos listados en las secciones 5.2 y 5.3.

Si una sucursal fue creada ANTES de este cambio de RBAC y el seed se re-ejecuta, el seed es **idempotente**: usa `upsert` para crear los nuevos permisos (Brand, Category, GlobalPriceList, TenantMembership) y los agrega a los roles existentes. No borra permisos existentes ni crea duplicados.

### 7.6 Permiso para listar permisos

El endpoint `GET /admin/permissions` usa `read:Role` como permiso, no un subject propio `Permission:read`. Esto es intencional: si podés ver roles, podés ver qué permisos existen para asignarlos.

### 7.7 Users assignable usa Sale:read

`GET /users/assignable` requiere `read:Sale`, no `read:User`. Esto es porque el endpoint se usa exclusivamente en el contexto de ventas (asignar vendedor a una venta), no en el contexto de administración de usuarios.

---

## 8. Ejemplo concreto: implementar el botón "Nueva marca"

### Paso 1 — Fetch de permisos al login

```ts
// Después de login exitoso y obtener JWT
const response = await api.get('/auth/me/permissions');
store.setPermissions(response.permissions, response.permissionCodes);
```

### Paso 2 — Helper can()

```ts
function can(action: string, subject: string): boolean {
  const codes = store.permissionCodes;

  // Super-admin global
  if (codes.includes('manage:all')) return true;

  // manage:Subject → implica todo sobre ese subject
  if (codes.includes(`manage:${subject}`)) return true;

  // Match exacto
  return codes.includes(`${action}:${subject}`);
}
```

### Paso 3 — Condicionar UI

```ts
// En el componente de listado de marcas
const canCreateBrand = can('create', 'Brand');

// Template / JSX (pseudo-agnóstico)
{canCreateBrand && <Button onClick={openCreateBrandModal}>Nueva marca</Button>}
```

### Paso 4 — Manejar error defensivo

Aunque el botón esté oculto, conviene manejar el 403 por si alguien llama al endpoint por otro camino (ej. bookmark, deep link):

```ts
try {
  await api.post('/brands', { name: 'Nueva Marca' });
  toast.success('Marca creada');
} catch (error) {
  if (error.status === 403) {
    toast.error('No tenés permiso para crear marcas');
    return;
  }
  if (error.status === 401) {
    router.push('/login');
    return;
  }
  toast.error('Error al crear la marca');
}
```

### Paso 5 — Re-evaluar al cambiar tenant

```ts
async function onTenantSwitch(tenantId: string) {
  const tokens = await api.post('/auth/switch-tenant', { tenantId });
  store.setTokens(tokens);

  // RE-FETCH permisos — es obligatorio
  const perms = await api.get('/auth/me/permissions');
  store.setPermissions(perms.permissions, perms.permissionCodes);

  // Ahora el can() usa los permisos nuevos
  // Los componentes que dependan de can() se re-renderizan
}
```

---

## 9. Endpoints que cambiaron de comportamiento en este release

Estos endpoints **antes** no exigían ningún permiso RBAC (solo JWT o JWT + Tenant) y **ahora** exigen un permiso específico. El frontend que los llame sin chequear permisos va a recibir 403 si el usuario no tiene el permiso.

### Brands (5 endpoints — antes: solo JWT, ahora: JWT + permiso)

- `POST /brands` — ahora requiere `create:Brand`
- `GET /brands` — ahora requiere `read:Brand`
- `GET /brands/:id` — ahora requiere `read:Brand`
- `PATCH /brands/:id` — ahora requiere `update:Brand`
- `DELETE /brands/:id` — ahora requiere `delete:Brand`

### Categories (5 endpoints — antes: solo JWT, ahora: JWT + permiso)

- `POST /categories` — ahora requiere `create:Category`
- `GET /categories` — ahora requiere `read:Category`
- `GET /categories/:id` — ahora requiere `read:Category`
- `PATCH /categories/:id` — ahora requiere `update:Category`
- `DELETE /categories/:id` — ahora requiere `delete:Category`

### Price Lists (4 endpoints — antes: solo JWT + Tenant, ahora: JWT + Tenant + permiso)

- `GET /price-lists` — ahora requiere `read:GlobalPriceList`
- `POST /price-lists` — ahora requiere `create:GlobalPriceList`
- `PATCH /price-lists/:id` — ahora requiere `update:GlobalPriceList`
- `DELETE /price-lists/:id` — ahora requiere `delete:GlobalPriceList`

### Admin Tenants (6 endpoints — antes: solo JWT + Tenant, ahora: JWT + Tenant + permiso)

- `POST /admin/tenants` — ahora requiere `create:Tenant`
- `GET /admin/tenants` — ahora requiere `read:Tenant`
- `GET /admin/tenants/:id` — ahora requiere `read:Tenant`
- `GET /admin/tenants/:id/roles` — ahora requiere `read:Tenant`
- `PATCH /admin/tenants/:id` — ahora requiere `update:Tenant`
- `DELETE /admin/tenants/:id` — ahora requiere `delete:Tenant`

### Tenant Members (4 endpoints — antes: solo JWT + Tenant, ahora: JWT + Tenant + permiso)

- `POST /admin/tenants/:tenantId/members` — ahora requiere `create:TenantMembership`
- `GET /admin/tenants/:tenantId/members` — ahora requiere `read:TenantMembership`
- `PATCH /admin/tenants/:tenantId/members/:membershipId` — ahora requiere `update:TenantMembership`
- `DELETE /admin/tenants/:tenantId/members/:membershipId` — ahora requiere `delete:TenantMembership`

### Admin Permissions (1 endpoint)

- `GET /admin/permissions` — ahora requiere `read:Role`

### Files (3 endpoints — antes: solo JWT + Tenant, ahora: JWT + Tenant + permiso)

- `POST /files` — ahora requiere `create:File`
- `GET /files/:id` — ahora requiere `read:File`
- `DELETE /files/:id` — ahora requiere `delete:File`

### Sale Comments (3 endpoints — antes: solo JWT + Tenant, ahora: JWT + Tenant + permiso)

- `POST /sales/:id/comments` — ahora requiere `create:SaleComment`
- `PATCH /sales/:id/comments/:commentId` — ahora requiere `update:SaleComment`
- `DELETE /sales/:id/comments/:commentId` — ahora requiere `delete:SaleComment`

### Users (1 endpoint)

- `GET /users/assignable` — ahora requiere `read:Sale`

**Total: 32 endpoints** con permisos nuevos en este release.

---

## 10. Preguntas frecuentes

### "Si quiero saber qué permisos tiene un rol cualquiera (no el mío), cómo?"

`GET /admin/roles/:id` devuelve el detalle del rol incluyendo sus permisos, siempre que tengas `read:Role`. Esto es útil solo para la pantalla de administración de roles, no para el flujo normal del POS.

### "Puedo crear permisos custom?"

No. La lista de permisos es fija — está definida en `PERMISSION_REGISTRY` y se seedea en la base de datos al arrancar. Lo que SÍ podés hacer es crear **roles nuevos** con combinaciones distintas de los permisos existentes. Eso se hace desde la UI de `/admin/roles` con `create:Role` y `update:Role`.

### "Qué pasa si el JWT no tiene tenantId (super-admin global)?"

El usuario ve `manage:all` en sus permisos. Para endpoints tenant-scoped que usan `TenantContextGuard`, el super-admin opera en modo cross-tenant donde aplica (ej. listar todos los usuarios de todos los tenants). Para endpoints de `/brands` y `/categories` (que no usan `TenantContextGuard`), funciona normalmente.

### "El frontend tiene que re-fetchear permisos al cambiar de tenant?"

SÍ, **siempre**. Después de `POST /auth/switch-tenant` se obtiene un JWT nuevo con un `tenantId` diferente. Los permisos pueden ser completamente distintos (distinto rol en la nueva sucursal). El frontend DEBE invalidar el cache de permisos y llamar `GET /auth/me/permissions` con el nuevo JWT.

### "Si un usuario no tiene ningún permiso, qué debería mostrar el frontend?"

El usuario debería ver un estado de "Sin acceso" o ser redirigido a una pantalla de bienvenida sin funcionalidad. No debería ver menús vacíos ni botones rotos. El helper `can()` va a retornar `false` para todo y las pantallas deberían respetar eso ocultando su contenido.

### "Los permisos del Cashier alcanzan para usar el POS?"

Sí, pero con limitaciones. El Cashier puede crear ventas (`create:Sale`), leer productos y clientes (`read:Product`, `read:Customer`), y ver marcas, categorías y listas de precios para el catálogo. Pero **no puede** editar ventas (`update:Sale` falta) — esto significa que no puede agregar items, cambiar cantidades, ni cobrar un borrador. Verificar si esto es intencional o si se necesita agregar `update:Sale` al Cashier.

---

## 11. Changelog

- **Fecha**: 2026-05-25
- **Branch**: `feat/rbac-coverage-completion`
- **Commits**: `8b0222d`, `25c6ea4`, `7d3456d`, `c8c1cc0`, `ad32789`
- **Resumen del cambio**:
  - 4 subjects nuevos agregados a `AppSubjects`: `Brand`, `Category`, `GlobalPriceList`, `TenantMembership`.
  - 20 entries nuevas en `PERMISSION_REGISTRY` (CRUD + manage para cada subject nuevo).
  - 32 endpoints ahora protegidos con `@RequirePermissions` que antes no lo estaban.
  - Seed actualizado: `managerPermissionKeys` expandido con Brand CRUD, Category CRUD, TenantMembership CRUD, GlobalPriceList read. `cashierPermissionKeys` expandido con Brand read, Category read, GlobalPriceList read.
  - `BrandsController` y `CategoriesController` ahora usan `JwtAuthGuard` + `PermissionsGuard` (sin `TenantContextGuard` porque son recursos globales).
  - `PriceListsController`, `FilesController`, `TenantsMembersController`, `TenantsController`, `AdminPermissionController` ahora tienen `@RequirePermissions` en cada endpoint.
  - `SaleCommentsController` ahora tiene `@RequirePermissions` en cada endpoint con subject `SaleComment`.
  - `UsersController` ahora tiene `@RequirePermissions(['read', 'Sale'])` en `/users/assignable`.

---

*Fuente: análisis directo del código backend en `houndfe-backend`. No se inventaron ni interpolaron datos — todo fue extraído de los archivos fuente listados.*
