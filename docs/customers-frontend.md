# Customers — Contrato para el Frontend

> Documento operativo del módulo `customers` para el equipo de frontend del POS.
> Cubre modelo de datos, endpoints, payloads y errores. Última actualización: 2026-05-15.

## Tabla de contenido

1. [Modelo de datos](#1-modelo-de-datos)
2. [Convenciones generales](#2-convenciones-generales)
3. [Endpoints de Customer (CRUD)](#3-endpoints-de-customer-crud)
4. [Endpoints de Direcciones (CustomerAddress)](#4-endpoints-de-direcciones-customeraddress)
5. [Errores y códigos HTTP](#5-errores-y-códigos-http)
6. [Permisos (RBAC)](#6-permisos-rbac)
7. [Integración con ventas POS](#7-integración-con-ventas-pos)

---

## 1) Modelo de datos

### 1.1) Customer

Un Customer pertenece a un tenant. Solo `firstName` es obligatorio — todo lo demás es opcional. Esto permite cargar clientes con datos mínimos en caja y completarlos después.

```ts
type Customer = {
  id: string;                       // UUID
  firstName: string;                // requerido
  lastName: string | null;
  phoneCountryCode: string | null;  // ej. "+52"
  phone: string | null;
  email: string | null;
  comments: string | null;
  globalPriceListId: string | null; // lista de precios automática asignada en ventas
  globalPriceList: { id: string; name: string } | null;

  // ── Bloque fiscal/billing (todo opcional) ──
  businessName: string | null;
  rfc: string | null;               // RFC mexicano
  fiscalRegime: string | null;      // código SAT, ver §1.3
  fiscalZipCode: string | null;
  billingStreet: string | null;
  billingExteriorNumber: string | null;
  billingInteriorNumber: string | null;
  billingZipCode: string | null;
  billingNeighborhood: string | null;
  billingMunicipality: string | null;
  billingCity: string | null;
  billingState: string | null;      // uno de MEXICAN_STATES (§1.4)

  addresses: CustomerAddress[];     // direcciones físicas (ver §1.2)

  createdAt: string;                // ISO
  updatedAt: string;
}
```

**Aclaraciones importantes:**

- **Billing vs Addresses son cosas DISTINTAS.** El bloque `billing*` es la dirección **fiscal** (CFDI). Vive aplanada en el propio Customer. Es **una sola** por cliente.
- Las `addresses[]` son **direcciones físicas de envío/entrega** (CustomerAddress). Un cliente puede tener **N direcciones** (0, 1 o muchas).
- No hay etiqueta (`label`), no hay `isDefault`, no hay billing vs shipping a nivel de dirección — todas las direcciones de `addresses[]` son funcionalmente iguales y se usan como direcciones de envío.

### 1.2) CustomerAddress

```ts
type CustomerAddress = {
  id: string;                      // UUID
  customerId: string;
  street: string;                  // requerido
  exteriorNumber: string | null;
  interiorNumber: string | null;
  zipCode: string | null;
  neighborhood: string | null;     // colonia
  municipality: string | null;     // municipio/alcaldía
  city: string | null;
  state: string | null;            // uno de MEXICAN_STATES (§1.4)
  createdAt: string;
  updatedAt: string;
}
```

### 1.3) Regímenes fiscales válidos

Códigos del SAT permitidos en `fiscalRegime`:

```
601, 603, 605, 606, 607, 608, 609, 610, 611, 612, 614, 615, 616,
620, 621, 622, 623, 624, 625, 626, 628, 629, 630
```

Si el front muestra un selector, mostrar el código + descripción. Solo se acepta el código (string de 3 chars).

### 1.4) Estados mexicanos válidos

Para `billingState` y `addresses[].state`:

```
Aguascalientes, Baja California, Baja California Sur, Campeche, Chiapas,
Chihuahua, Ciudad de México, Coahuila, Colima, Durango, Estado de México,
Guanajuato, Guerrero, Hidalgo, Jalisco, Michoacán, Morelos, Nayarit,
Nuevo León, Oaxaca, Puebla, Querétaro, Quintana Roo, San Luis Potosí,
Sinaloa, Sonora, Tabasco, Tamaulipas, Tlaxcala, Veracruz, Yucatán, Zacatecas
```

Cualquier otro valor → `400 Bad Request` por validación.

### 1.5) "Público en General"

**No es una entidad.** Es la **ausencia** de cliente en una venta (`sale.customerId === null`). El frontend lo muestra como label, no debe crearse un Customer con ese nombre.

---

## 2) Convenciones generales

- **Base URL**: `$API_URL` (según ambiente).
- **Auth**: todos los endpoints requieren `Authorization: Bearer <jwt>`.
- **Multi-tenant**: el `tenantId` se infiere del JWT. Clientes/direcciones de otro tenant responden **404** (indistinguible de "no existe").
- **Trimming**: el backend hace `.trim()` automático en todos los strings y normaliza emails a lowercase y RFC a uppercase. El frontend no necesita pre-procesar.
- **Cascadas**: borrar un Customer elimina en cascada sus addresses y referencias.
- **Strings vacíos**: enviar `""` en campos opcionales es equivalente a `null` (se persiste como `null`).

---

## 3) Endpoints de Customer (CRUD)

Base: `/customers`

### 3.1) `POST /customers` — Crear cliente

Crea un cliente. Permite incluir direcciones iniciales en el mismo request de forma atómica (transacción).

**Headers**: `Authorization`, `Content-Type: application/json`
**Permiso**: `create,Customer`

**Body** (todos los campos opcionales salvo `firstName`):

```json
{
  "firstName": "Ada",
  "lastName": "Lovelace",
  "phoneCountryCode": "+52",
  "phone": "5512345678",
  "email": "ada@example.com",
  "comments": "Cliente VIP",
  "globalPriceListId": "uuid-de-lista-de-precios",

  "businessName": "Lovelace SA de CV",
  "rfc": "LOVA800101AAA",
  "fiscalRegime": "612",
  "fiscalZipCode": "64000",
  "billingStreet": "Av. Reforma",
  "billingExteriorNumber": "100",
  "billingInteriorNumber": "5B",
  "billingZipCode": "64000",
  "billingNeighborhood": "Centro",
  "billingMunicipality": "Monterrey",
  "billingCity": "Monterrey",
  "billingState": "Nuevo León",

  "addresses": [
    {
      "street": "Calle Falsa",
      "exteriorNumber": "123",
      "interiorNumber": "A",
      "zipCode": "64000",
      "neighborhood": "Del Valle",
      "municipality": "Monterrey",
      "city": "Monterrey",
      "state": "Nuevo León"
    }
  ]
}
```

**Respuesta `201 Created`**: el Customer completo (igual shape que §3.3).

**Errores**: `400` por validación (RFC inválido, estado no listado, régimen fiscal no listado, email mal formado, longitudes excedidas).

---

### 3.2) `GET /customers` — Listar todos los clientes

Devuelve **TODOS** los clientes del tenant, con sus direcciones inline y la lista de precios global asociada. **No hay paginación ni búsqueda server-side** — la búsqueda actual del dialog "Añadir Cliente" se hace client-side.

> ⚠️ Si en el futuro el catálogo de clientes crece mucho, vamos a tener que agregar `?search=&page=&pageSize=`. Por ahora, fetch único + filtro local en el frontend.

**Permiso**: `read,Customer`

**Respuesta `200`**:

```json
[
  {
    "id": "f9d2f368-10be-4f4b-a3cc-0e67735f7f26",
    "firstName": "Ada",
    "lastName": "Lovelace",
    "phoneCountryCode": "+52",
    "phone": "5512345678",
    "email": "ada@example.com",
    "comments": null,
    "globalPriceListId": null,
    "globalPriceList": null,
    "businessName": null,
    "rfc": null,
    "fiscalRegime": null,
    "fiscalZipCode": null,
    "billingStreet": null,
    "billingExteriorNumber": null,
    "billingInteriorNumber": null,
    "billingZipCode": null,
    "billingNeighborhood": null,
    "billingMunicipality": null,
    "billingCity": null,
    "billingState": null,
    "addresses": [
      {
        "id": "8f311d31-131f-449a-8a15-6a3257b0d865",
        "customerId": "f9d2f368-10be-4f4b-a3cc-0e67735f7f26",
        "street": "Calle Falsa",
        "exteriorNumber": "123",
        "interiorNumber": null,
        "zipCode": "64000",
        "neighborhood": "Del Valle",
        "municipality": "Monterrey",
        "city": "Monterrey",
        "state": "Nuevo León",
        "createdAt": "2026-05-15T10:00:00.000Z",
        "updatedAt": "2026-05-15T10:00:00.000Z"
      }
    ],
    "createdAt": "2026-05-15T10:00:00.000Z",
    "updatedAt": "2026-05-15T10:00:00.000Z"
  }
]
```

Orden: por `createdAt DESC` (más recientes primero). Direcciones internas: por `createdAt ASC`.

---

### 3.3) `GET /customers/:id` — Detalle de un cliente

**Permiso**: `read,Customer`

**Respuesta `200`**: mismo shape de un item del array de §3.2.

**Errores**: `404 Customer not found` si no existe o pertenece a otro tenant.

---

### 3.4) `PATCH /customers/:id` — Actualizar datos del cliente

Actualización parcial. Solo se modifican los campos enviados. Enviar `null` o `""` en un campo opcional lo limpia.

**Permiso**: `update,Customer`

**Body**: subset de los campos de §3.1 (sin `addresses` — las direcciones se manejan por sus propios endpoints, §4).

**Respuesta `200`**: el Customer completo actualizado.

**Errores**: `404`, `400` por validación, `422` si se borra `firstName` (firstName es requerido siempre).

---

### 3.5) `DELETE /customers/:id` — Borrar cliente

**Permiso**: `delete,Customer`

**Respuesta `204 No Content`**.

> ⚠️ **Importante**: borrar un Customer pone en `null` el `customerId` de todas las ventas históricas que lo referenciaban (`ON DELETE SET NULL`). El historial se conserva pero pierde el nombre del cliente. **Hay un follow-up planeado** para snapshottear el nombre+dirección al confirmar la venta — hasta entonces, advertir en UI antes de borrar.

---

## 4) Endpoints de Direcciones (CustomerAddress)

Base: `/customers/:id/addresses`

> Las direcciones también vienen inline en `GET /customers/:id` (campo `addresses`). Estos endpoints son para manipularlas individualmente.

### 4.1) `POST /customers/:id/addresses` — Agregar dirección

**Permiso**: `update,Customer`

**Body** (solo `street` es requerido):

```json
{
  "street": "Av. Insurgentes Sur",
  "exteriorNumber": "1500",
  "interiorNumber": "PH",
  "zipCode": "03100",
  "neighborhood": "Del Valle",
  "municipality": "Benito Juárez",
  "city": "Ciudad de México",
  "state": "Ciudad de México"
}
```

**Respuesta `201`**: la CustomerAddress creada.

---

### 4.2) `GET /customers/:id/addresses` — Listar direcciones del cliente

**Permiso**: `read,Customer`

**Respuesta `200`**: array de CustomerAddress, ordenado por `createdAt ASC`.

> Para evitar dobles fetches, ya tenés `addresses[]` dentro de `GET /customers/:id`. Usar este endpoint solo si necesitás refrescar SOLO las direcciones.

---

### 4.3) `PATCH /customers/:id/addresses/:addressId` — Actualizar dirección

**Permiso**: `update,Customer`

**Body**: subset de los campos de §4.1.

**Respuesta `200`**: la CustomerAddress actualizada.

**Errores**: `404` si el address no existe o no pertenece al cliente.

---

### 4.4) `DELETE /customers/:id/addresses/:addressId` — Borrar dirección

**Permiso**: `update,Customer`

**Respuesta `204 No Content`**.

> ⚠️ Si una venta en draft o histórica tenía esta dirección como `shippingAddress`, queda con `shippingAddressId: null` (`ON DELETE SET NULL`).

---

## 5) Errores y códigos HTTP

| HTTP | Código | Cuándo |
|---|---|---|
| 400 | (mensaje class-validator) | Campos inválidos: estado no listado, RFC mal formado, email inválido, longitud excedida, régimen fiscal no listado |
| 401 | Unauthorized | JWT ausente o inválido |
| 403 | Forbidden | Token válido pero sin permiso CASL requerido (ver §6) |
| 404 | `Customer not found` / `CustomerAddress not found` | No existe, o pertenece a otro tenant |
| 422 | `firstName is required` | Trim de firstName quedó vacío en update |

No hay condiciones de carrera relevantes en este módulo — no hay locks ni idempotencia (cada operación es CRUD directo).

---

## 6) Permisos (RBAC)

Todos los endpoints requieren un permiso CASL `[action, 'Customer']`:

| Acción | Endpoints |
|---|---|
| `create,Customer` | `POST /customers` |
| `read,Customer` | `GET /customers`, `GET /customers/:id`, `GET /customers/:id/addresses` |
| `update,Customer` | `PATCH /customers/:id`, todos los endpoints de addresses (POST/PATCH/DELETE) |
| `delete,Customer` | `DELETE /customers/:id` |

> Detalle completo del modelo RBAC en `docs/RBAC.md`.

---

## 7) Integración con ventas POS

Para asignar un cliente (y opcionalmente una dirección) a una venta en estado DRAFT, **NO se usan los endpoints de este módulo**. Se usan los endpoints específicos del módulo de ventas:

```
PUT    /sales/drafts/:id/customer
DELETE /sales/drafts/:id/customer
PUT    /sales/drafts/:id/shipping-address
DELETE /sales/drafts/:id/shipping-address
```

**Contrato completo, payloads, errores y reglas funcionales**: ver `docs/sales-pos-charge-frontend.md` **§2.5 "Asignar cliente y dirección al draft"**.

Flujo típico del dialog "Añadir Cliente":

1. Frontend hace `GET /customers` al abrir el dialog (cachea localmente).
2. Filtrado client-side por nombre/teléfono/email mientras el usuario tipea.
3. Usuario selecciona un cliente → frontend hace `PUT /sales/drafts/:id/customer` con `{ customerId }`.
4. (Opcional) Usuario selecciona una dirección de envío → `PUT /sales/drafts/:id/shipping-address` con `{ shippingAddressId }`.
5. (Opcional) Si el usuario quiere agregar un cliente nuevo desde el dialog: `POST /customers` (con o sin `addresses[]` inline) → luego `PUT /sales/drafts/:id/customer`.
6. (Opcional) Si quiere agregar una dirección nueva al cliente ya asignado: `POST /customers/:customerId/addresses` → luego `PUT /sales/drafts/:id/shipping-address`.

**Regla importante**: cuando se cambia el cliente de una venta (PUT /customer con un `customerId` distinto), la dirección de envío previa se **borra automáticamente** porque pertenecía al cliente anterior. Si el frontend quiere mantener una dirección, debe re-enviarla explícitamente en el body del PUT.

---

## Anexo: Archivos relacionados para revisar

| Archivo | Qué contiene |
|---|---|
| `docs/customers-frontend.md` | **Este documento** — modelo, endpoints CRUD de clientes y direcciones |
| `docs/sales-pos-charge-frontend.md` §2.5 | Endpoints para asignar cliente/dirección a una venta en DRAFT |
| `docs/sales-pos-charge-frontend.md` §3.7 | Regla de cliente para pago a crédito/parcial |
| `docs/RBAC.md` | Modelo completo de permisos CASL |
| `docs/multi-tenant-api.md` | Cómo funciona el tenancy y el JWT |
| `docs/sales-frontend.md` | Documento general del módulo de ventas |
