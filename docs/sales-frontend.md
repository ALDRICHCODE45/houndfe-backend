# Modulo de Ventas POS (v1) — Contrato Tecnico Completo para Frontend

> Fuente de verdad: implementacion actual en backend (`src/sales/**`, `prisma/schema.prisma`, `DomainExceptionFilter`, modulos catalogo relacionados).

---

## 0) Objetivo de este documento

Este documento esta hecho para que frontend implemente **/POS/ventas** sin adivinar.

Incluye:

- por que esta modelado asi,
- que payload mandar,
- que devuelve cada endpoint,
- errores esperables,
- flujos de implementacion UI,
- edge cases reales del codigo actual.

> **Nota importante**: Este es el modulo v1. Se van a implementar mas funcionalidades en versiones futuras (ver seccion 10 al final).

---

## 1) Alcance funcional v1

El modulo de Ventas POS soporta la gestion de **borradores de venta** (drafts) para punto de venta:

### Lo que SI esta implementado

- Crear multiples ventas simultaneas (tabs)
- Buscar productos por nombre/SKU para agregar a la venta
- Agregar productos (con o sin variantes) a una venta
- Modificar cantidad de items
- Limpiar todos los items de una venta (trash)
- Cerrar/eliminar una tab de venta
- Precio congelado al momento de agregar (snapshot)
- Validacion de stock disponible (sin reserva)
- Proteccion RBAC completa (JWT + permisos por ruta)
- Ownership por usuario (cada venta pertenece al cajero que la creo)

### Lo que NO esta implementado (futuras versiones)

- Cobro/finalizacion de venta
- Metodos de pago
- Scanner de codigo de barras
- Agregar cliente a la venta
- Agregar vendedor
- Aplicar promociones
- Entrada manual de productos
- Recargas y servicios
- Pedidos
- Menu de 3 puntos (opciones avanzadas por item)
- Reserva de stock
- Tickets/impresion

---

## 2) Modelo de datos

### Sale (Venta borrador)

```typescript
interface Sale {
  id: string;           // UUID
  userId: string;       // UUID del cajero/usuario dueno
  status: 'DRAFT';      // v1 solo soporta DRAFT
  items: SaleItem[];    // lista de items en la venta
  createdAt: string;    // ISO 8601
  updatedAt: string;    // ISO 8601
}
```

### SaleItem (Item de venta)

```typescript
interface SaleItem {
  id: string;                    // UUID unico del item
  productId: string;             // UUID del producto
  variantId: string | null;      // UUID de la variante (null si no tiene)
  productName: string;           // nombre del producto (snapshot, NO cambia)
  variantName: string | null;    // nombre de la variante (snapshot, NO cambia)
  quantity: number;              // cantidad (entero >= 1)
  unitPriceCents: number;        // precio unitario en centavos (CONGELADO)
  unitPriceCurrency: string;     // moneda (siempre "MXN" en v1)
}
```

### Precio en centavos

El precio se maneja en **centavos** para evitar errores de punto flotante.

Para mostrar al usuario:

```typescript
// Ejemplo: unitPriceCents = 4998
const precioDisplay = (unitPriceCents / 100).toFixed(2);
// resultado: "49.98"

// Subtotal por item:
const subtotalItem = (item.unitPriceCents * item.quantity / 100).toFixed(2);

// Total de la venta:
const totalCents = sale.items.reduce(
  (sum, item) => sum + item.unitPriceCents * item.quantity,
  0
);
const totalDisplay = (totalCents / 100).toFixed(2);
```

---

## 3) Permisos RBAC

Todos los endpoints requieren **JWT valido** + **permisos de Sale**.

| Permiso | Descripcion | Endpoints que lo usan |
|---------|-------------|----------------------|
| `create:Sale` | Crear nueva venta borrador | `POST /sales/drafts` |
| `read:Sale` | Ver ventas del usuario | `GET /sales/drafts` |
| `update:Sale` | Agregar items, cambiar cantidad, limpiar | `POST /items`, `PATCH /items/:itemId`, `DELETE /items` |
| `delete:Sale` | Eliminar venta borrador (cerrar tab) | `DELETE /sales/drafts/:id` |
| `manage:Sale` | Acceso total a ventas | todos |

> Los permisos se seedean automaticamente al arrancar la API. Asegurate de asignar los permisos correspondientes al rol del cajero.

---

## 4) Endpoints

Base URL: `/sales/drafts`

Todos los endpoints requieren header: `Authorization: Bearer <jwt_token>`

---

### 4.1) Crear nueva venta borrador (abrir tab)

```
POST /sales/drafts
```

**Permiso**: `create:Sale`

**Body**: no requiere body (el userId se toma del JWT).

**Response** `201 Created`:

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "userId": "user-uuid-aqui",
  "status": "DRAFT",
  "items": [],
  "createdAt": "2026-04-21T18:00:00.000Z",
  "updatedAt": "2026-04-21T18:00:00.000Z"
}
```

**Uso tipico**: cuando el usuario hace click en el boton "+" para abrir una nueva tab de venta.

---

### 4.2) Listar borradores del usuario (tabs abiertas)

```
GET /sales/drafts
```

**Permiso**: `read:Sale`

**Response** `200 OK`:

```json
[
  {
    "id": "a1b2c3d4-...",
    "userId": "user-uuid",
    "status": "DRAFT",
    "items": [
      {
        "id": "item-uuid-1",
        "productId": "prod-uuid",
        "variantId": null,
        "productName": "Lampara de mesa",
        "variantName": null,
        "quantity": 1,
        "unitPriceCents": 4998,
        "unitPriceCurrency": "MXN"
      }
    ],
    "createdAt": "2026-04-21T18:00:00.000Z",
    "updatedAt": "2026-04-21T18:01:00.000Z"
  },
  {
    "id": "b2c3d4e5-...",
    "userId": "user-uuid",
    "status": "DRAFT",
    "items": [],
    "createdAt": "2026-04-21T18:05:00.000Z",
    "updatedAt": "2026-04-21T18:05:00.000Z"
  }
]
```

**Uso tipico**: al cargar la pantalla POS, para restaurar las tabs abiertas del usuario. Los resultados vienen ordenados por `createdAt` descendente (mas reciente primero).

---

### 4.3) Agregar item a una venta

```
POST /sales/drafts/:id/items
```

**Permiso**: `update:Sale`

**Body**:

```json
{
  "productId": "uuid-del-producto",
  "variantId": "uuid-de-la-variante",
  "quantity": 2
}
```

| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `productId` | `string` (UUID) | SI | ID del producto a agregar |
| `variantId` | `string` (UUID) o `null` | NO | ID de la variante. **Obligatorio si el producto tiene variantes**. No enviar si el producto NO tiene variantes. |
| `quantity` | `number` (entero) | SI | Cantidad. Minimo 1. |

**Response** `200 OK`: devuelve la venta completa actualizada (mismo formato que `GET /sales/drafts/:id`).

#### Comportamiento de stacking (acumulacion)

Si agregas el mismo producto + variante que ya esta en la venta, **las cantidades se suman automaticamente**:

```
// Primer POST: productId="abc", quantity=2
// Item queda con quantity=2

// Segundo POST: productId="abc", quantity=3
// Item queda con quantity=5 (NO se crea un segundo item)
```

Si agregas el mismo producto pero **diferente variante**, se crea un item separado.

#### Validacion de stock

El backend valida que haya stock suficiente **antes** de agregar:

- Para stacking: valida `cantidad_existente + cantidad_nueva <= stock_disponible`
- Para items nuevos: valida `cantidad_solicitada <= stock_disponible`
- Si el producto no usa stock (`useStock = false`), siempre se permite.

> **Importante**: El stock NO se reserva. Solo se valida en el momento. Otro cajero podria vender el mismo producto en paralelo.

---

### 4.4) Cambiar cantidad de un item

```
PATCH /sales/drafts/:id/items/:itemId
```

**Permiso**: `update:Sale`

**Body**:

```json
{
  "quantity": 5
}
```

| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `quantity` | `number` (entero) | SI | Nueva cantidad. Minimo 1. |

**Response** `200 OK`: devuelve la venta completa actualizada.

> La nueva cantidad reemplaza la anterior (no es un delta, es el valor absoluto).

---

### 4.5) Limpiar todos los items (trash / vaciar venta)

```
DELETE /sales/drafts/:id/items
```

**Permiso**: `update:Sale`

**Body**: no requiere.

**Response** `200 OK`: devuelve la venta con `items: []`.

Es **idempotente**: si la venta ya estaba vacia, no da error.

**Uso tipico**: cuando el usuario presiona el boton de "trash" (icono basura) en la venta.

---

### 4.6) Eliminar venta borrador (cerrar tab)

```
DELETE /sales/drafts/:id
```

**Permiso**: `delete:Sale`

**Body**: no requiere.

**Response**: `204 No Content` (sin body).

> **Atencion**: esto es un borrado permanente. La venta y todos sus items se eliminan de la base de datos. Se recomienda mostrar un dialogo de confirmacion en la UI antes de ejecutar.

**Uso tipico**: cuando el usuario cierra una tab con la "X".

---

## 5) Errores esperables

Todos los errores siguen el formato estandar de `DomainExceptionFilter`:

```json
{
  "statusCode": 422,
  "message": "Insufficient stock for product abc-123. Available: 5, Requested: 10",
  "error": "Unprocessable Entity"
}
```

### Tabla de errores por endpoint

| Endpoint | Error | Status | Cuando ocurre |
|----------|-------|--------|---------------|
| Todos | `401 Unauthorized` | Sin JWT o JWT expirado |
| Todos | `403 Forbidden` | Usuario no tiene permiso de Sale |
| Todos con `:id` | `404 Not Found` | Venta no encontrada |
| Todos con `:id` | `422 Unprocessable Entity` | La venta no pertenece al usuario actual |
| `POST /items` | `404 Not Found` | Producto no encontrado |
| `POST /items` | `422 Unprocessable Entity` | Producto no habilitado para POS (`sellInPos = false`) |
| `POST /items` | `422 Unprocessable Entity` | Producto tiene variantes pero no se envio `variantId` |
| `POST /items` | `422 Unprocessable Entity` | Producto NO tiene variantes pero se envio `variantId` |
| `POST /items` | `404 Not Found` | Variante no encontrada o no pertenece al producto |
| `POST /items` | `422 Unprocessable Entity` | Stock insuficiente |
| `PATCH /items/:itemId` | `422 Unprocessable Entity` | Item no encontrado en la venta |
| `PATCH /items/:itemId` | `422 Unprocessable Entity` | Stock insuficiente para nueva cantidad |
| `POST /items`, `PATCH /items` | `400 Bad Request` | `quantity` menor a 1, `productId` faltante, etc. |

### Mensajes de error clave

```
"Product {id} is not enabled for POS sales"
"Product {id} has variants, you must specify a variant"
"Product {id} does not have variants"
"Insufficient stock for product {id}. Available: X, Requested: Y"
"User {userId} does not own this sale"
"Item {itemId} not found in sale"
```

---

## 6) Flujo de implementacion UI

### 6.1) Inicializacion de la pantalla POS

```
1. GET /sales/drafts
   -> Si hay borradores: renderizar tabs con sus items
   -> Si no hay borradores: POST /sales/drafts para crear la primera tab
2. Mostrar tab activa con sus items
3. Calcular subtotal/total en frontend:
   total = sum(item.unitPriceCents * item.quantity) / 100
```

### 6.2) Abrir nueva tab

```
1. Usuario click en "+"
2. POST /sales/drafts
3. Agregar nueva tab con la venta vacia
4. Cambiar tab activa a la nueva
```

### 6.3) Buscar y agregar producto (sin variantes)

```
1. Usuario escribe en el input de busqueda
2. Hacer busqueda contra endpoint de productos existente (filtrar sellInPos=true)
3. Usuario selecciona producto sin variantes
4. POST /sales/drafts/:id/items
   body: { productId: "...", quantity: 1 }
5. Actualizar vista con la respuesta (venta completa)
```

### 6.4) Buscar y agregar producto (con variantes)

```
1. Usuario escribe en el input de busqueda
2. Resultado muestra "X unidades en Y variantes"
3. Usuario click en el producto
4. Mostrar selector de variantes del producto
5. Usuario selecciona una variante
6. POST /sales/drafts/:id/items
   body: { productId: "...", variantId: "...", quantity: 1 }
7. Actualizar vista con la respuesta
```

### 6.5) Cambiar cantidad de un item

```
1. Usuario modifica el input de cantidad del item
2. PATCH /sales/drafts/:id/items/:itemId
   body: { quantity: nuevaCantidad }
3. Actualizar vista con la respuesta
4. Si error de stock: mostrar mensaje y revertir a cantidad anterior
```

### 6.6) Limpiar venta (trash)

```
1. Usuario click en icono basura
2. Mostrar confirmacion: "Quitar todos los productos?"
3. Si confirma: DELETE /sales/drafts/:id/items
4. Actualizar vista (venta vacia)
```

### 6.7) Cerrar tab

```
1. Usuario click en "X" de la tab
2. Mostrar confirmacion: "Cerrar esta venta?"
3. Si confirma: DELETE /sales/drafts/:id
4. Remover tab
5. Si era la unica tab: POST /sales/drafts para crear una nueva
```

---

## 7) Edge cases criticos

### 7.1) Precio congelado

El precio se captura al momento de agregar el item y **NO se actualiza** si el precio del producto cambia en el catalogo despues. Esto es intencional: el cajero ve el precio que tenia el producto cuando lo agrego a la venta.

### 7.2) Stock sin reserva

El stock se valida pero NO se reserva. Escenario posible:

```
Cajero A: agrega producto (stock=5, pide 3) -> OK, item agregado
Cajero B: agrega mismo producto (stock=5, pide 4) -> OK, item agregado
// Ambos pasaron validacion porque el stock no se reservo
// El stock real se descontara cuando se implemente el cobro (v2)
```

Esto es el comportamiento esperado para v1. El stock se descontara al momento del cobro en una version futura.

### 7.3) Stacking vs items separados

```
// Mismo producto, SIN variante -> STACK (suma cantidades)
POST items { productId: "abc", quantity: 2 }  // item qty=2
POST items { productId: "abc", quantity: 3 }  // item qty=5 (mismo item)

// Mismo producto, DIFERENTE variante -> items separados
POST items { productId: "abc", variantId: "v1", quantity: 2 }  // item 1
POST items { productId: "abc", variantId: "v2", quantity: 3 }  // item 2

// Mismo producto + misma variante -> STACK
POST items { productId: "abc", variantId: "v1", quantity: 2 }  // item qty=2
POST items { productId: "abc", variantId: "v1", quantity: 1 }  // item qty=3
```

### 7.4) Ownership estricto

Un usuario solo puede ver y modificar sus propias ventas. Si por alguna razon el frontend intenta acceder a la venta de otro usuario, recibira un error `422`.

### 7.5) Clear idempotente

Limpiar una venta que ya esta vacia no da error. La operacion es segura de ejecutar multiples veces.

### 7.6) Tabs sin limite

No hay limite de tabs/borradores por usuario. El frontend puede implementar un limite visual si lo desea, pero el backend no lo restringe.

---

## 8) Ejemplos completos con cURL

### Crear venta

```bash
curl -X POST http://localhost:3000/sales/drafts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"
```

### Listar tabs del usuario

```bash
curl http://localhost:3000/sales/drafts \
  -H "Authorization: Bearer $TOKEN"
```

### Agregar producto sin variante

```bash
curl -X POST http://localhost:3000/sales/drafts/SALE_ID/items \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "prod-uuid",
    "quantity": 2
  }'
```

### Agregar producto con variante

```bash
curl -X POST http://localhost:3000/sales/drafts/SALE_ID/items \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "prod-uuid",
    "variantId": "variant-uuid",
    "quantity": 1
  }'
```

### Cambiar cantidad

```bash
curl -X PATCH http://localhost:3000/sales/drafts/SALE_ID/items/ITEM_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "quantity": 5
  }'
```

### Limpiar venta (trash)

```bash
curl -X DELETE http://localhost:3000/sales/drafts/SALE_ID/items \
  -H "Authorization: Bearer $TOKEN"
```

### Cerrar tab

```bash
curl -X DELETE http://localhost:3000/sales/drafts/SALE_ID \
  -H "Authorization: Bearer $TOKEN"
```

---

## 9) Resumen rapido de endpoints

| Metodo | Ruta | Permiso | Body | Response | Descripcion |
|--------|------|---------|------|----------|-------------|
| `POST` | `/sales/drafts` | `create:Sale` | - | `201` Sale | Abrir nueva tab |
| `GET` | `/sales/drafts` | `read:Sale` | - | `200` Sale[] | Listar tabs del usuario |
| `POST` | `/sales/drafts/:id/items` | `update:Sale` | `AddItemDto` | `200` Sale | Agregar item |
| `PATCH` | `/sales/drafts/:id/items/:itemId` | `update:Sale` | `UpdateQtyDto` | `200` Sale | Cambiar cantidad |
| `DELETE` | `/sales/drafts/:id/items` | `update:Sale` | - | `200` Sale | Limpiar venta (trash) |
| `DELETE` | `/sales/drafts/:id` | `delete:Sale` | - | `204` - | Cerrar tab |

---

## 10) Roadmap: lo que viene en proximas versiones

Las siguientes funcionalidades se implementaran de forma incremental en versiones futuras. El diseno actual del backend esta preparado para extenderlas sin romper lo existente:

### v2 (prioridad alta)
- **Cobro/finalizacion de venta**: estado `COMPLETED`, registro de metodo de pago, descuento de stock real
- **Agregar cliente a la venta**: asociar un cliente registrado a la venta para facturacion
- **Agregar vendedor**: asignar vendedor diferente al cajero para comisiones

### v3 (prioridad media)
- **Aplicar promociones**: integracion con el modulo de promociones existente
- **Scanner de codigo de barras**: busqueda rapida por barcode
- **Tickets/impresion**: generacion de ticket de venta

### v4 (prioridad baja)
- **Pedidos**: flujo de pedidos separado del flujo de ventas
- **Entrada manual de productos**: venta de items que no estan en catalogo
- **Recargas y servicios**: productos especiales
- **Menu de 3 puntos**: opciones avanzadas por item (notas, descuento individual, etc.)
- **Reserva de stock**: bloquear stock para ventas en progreso

> Cada version se implementara sin afectar la funcionalidad existente. Los endpoints actuales seguiran funcionando igual.
