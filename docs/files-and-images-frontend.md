# Modulo de Archivos e Imagenes de Producto — Contrato Tecnico Completo para Frontend

> Fuente de verdad: implementacion actual en backend (`src/files/**`, `src/products/**`, `prisma/schema.prisma`, `DomainExceptionFilter`).

---

## 0) Objetivo de este documento

Este documento esta hecho para que frontend implemente **subida de imagenes de productos y variantes** sin adivinar.

Incluye:

- por que esta modelado asi,
- que payload mandar,
- que devuelve cada endpoint,
- errores esperables,
- flujos de implementacion UI,
- edge cases reales del codigo actual.

> **Nota importante**: El modulo de archivos (`FilesModule`) es generico y reutilizable. Hoy se usa para imagenes de productos/variantes, pero en el futuro se usara para facturas, recibos, etc.

---

## 1) Alcance funcional

### Lo que SI esta implementado

- Subir imagenes de producto (multipart, multiples)
- Subir imagenes de variante (multipart, multiples)
- Listar imagenes de un producto (incluye las de variantes)
- Establecer imagen principal por producto o por variante
- Eliminar imagen (borra el archivo remoto y el registro en DB)
- Agregar imagen por URL directa (compatibilidad legacy)
- Validacion de tipo MIME (solo imagenes: jpeg, png, webp, gif)
- Validacion de tamano de archivo (configurable, default 10 MB)
- Proteccion RBAC completa (JWT + permisos)
- Storage en DigitalOcean Spaces (S3-compatible)
- Modulo generico de archivos independiente (`/files`)

### Lo que NO esta implementado (futuras versiones)

- Recorte/redimensionado de imagenes
- Thumbnails automaticos
- Subida de archivos no-imagen (PDFs, facturas)
- Drag & drop para reordenar (solo `sortOrder` manual)
- Galeria de medios centralizada

---

## 2) Modelo de datos

### FileObject (Archivo almacenado)

```typescript
interface FileObject {
  id: string;              // UUID
  storageKey: string;      // ruta interna en Spaces, ej: "Product/<id>/<uuid>.jpg"
  url: string;             // URL publica CDN para mostrar la imagen
  mimeType: string;        // ej: "image/jpeg"
  sizeBytes: number;       // tamano en bytes
  ownerType: string | null; // "Product" | "ProductVariant" | null
  ownerId: string | null;  // UUID del owner o null
  uploadedBy: string | null; // UUID del usuario que subio
  createdAt: string;       // ISO 8601
}
```

### ProductImage (Imagen asociada a producto/variante)

```typescript
interface ProductImage {
  id: string;              // UUID
  productId: string;       // UUID del producto
  variantId: string | null; // UUID de la variante (null = imagen de producto)
  fileId: string | null;   // UUID del FileObject (null = imagen por URL legacy)
  url: string;             // URL de la imagen
  isMain: boolean;         // true si es la imagen principal
  sortOrder: number;       // orden de visualizacion
  createdAt: string;       // ISO 8601
}
```

> **Importante**: `fileId` es nullable. Si una imagen fue agregada por URL directa (sin subir archivo), `fileId` es `null`. Si fue subida via multipart, `fileId` apunta al `FileObject` asociado.

---

## 3) Decisiones de diseno (el porque)

### Por que un modulo de archivos separado?

El `FilesModule` es un bounded context independiente. No sabe nada de productos. Esto permite:

- Reutilizar la misma infraestructura para facturas, recibos, avatares, etc.
- Cambiar de proveedor (DigitalOcean → AWS → MinIO) solo tocando el adapter
- Testear sin acoplamiento al dominio de productos

### Por que `fileId` es nullable en ProductImage?

Para compatibilidad con el sistema legacy. Hoy se puede agregar una imagen por URL directa (`POST /products/:id/images` con JSON body). A futuro, todas las imagenes nuevas deberian subirse via multipart y tener `fileId`.

### Que pasa cuando eliminas una imagen?

Si la imagen tiene `fileId`, se borra **todo**: el registro `ProductImage`, el registro `FileObject`, y el archivo remoto en Spaces. Si no tiene `fileId` (solo URL), se borra solo el registro.

### Validaciones de archivo

Se validan **antes** de subir a Spaces:
- **Tipo MIME**: solo `image/jpeg`, `image/png`, `image/webp`, `image/gif`
- **Tamano**: maximo configurable via env `SPACES_UPLOAD_MAX_MB` (default 10 MB)

---

## 4) Permisos RBAC

| Permiso | Descripcion | Endpoints que lo usan |
|---------|-------------|----------------------|
| `create:File` | Subir archivos genericos | `POST /files` |
| `read:File` | Ver metadata de archivos | `GET /files/:id` |
| `delete:File` | Eliminar archivos genericos | `DELETE /files/:id` |
| `update:Product` | Subir/eliminar imagenes de producto | `POST /products/:id/images/upload`, `POST /products/:id/variants/:variantId/images/upload`, `POST /products/:id/images`, `PATCH /products/:id/images/:imageId/main`, `DELETE /products/:id/images/:imageId` |
| `read:Product` | Listar imagenes de producto | `GET /products/:id/images` |

> **Nota**: Para subir imagenes de producto/variante se necesita `update:Product`, NO `create:File`. Los endpoints de imagenes de producto viven dentro del contexto de productos.

---

## 5) Endpoints

Base URL: `http://localhost:3000` (o tu entorno)

Todos los endpoints requieren header: `Authorization: Bearer <jwt_token>`

---

### 5.1) Subir imagen de producto (★ NUEVO — multipart)

```
POST /products/:id/images/upload
```

**Permiso**: `update:Product`

**Content-Type**: `multipart/form-data`

**Parametros de ruta**:
| Parametro | Tipo | Requerido | Descripcion |
|-----------|------|-----------|-------------|
| `id` | UUID | SI | ID del producto |

**Body** (multipart form-data):
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `file` | File | SI | El archivo de imagen. El campo DEBE llamarse exactamente `file` |

**Response** `201 Created`:
```json
{
  "id": "a1b2c3d4-...",
  "fileId": "e5f6g7h8-...",
  "url": "https://tu-bucket.nyc3.cdn.digitaloceanspaces.com/Product/a1b2c3d4/i9j0k1l2.jpg",
  "isMain": false,
  "sortOrder": 0
}
```

**Uso tipico**: El usuario esta en la pantalla de editar producto y presiona "Anadir imagen" en la seccion de Imagenes. Frontend abre un file picker, el usuario selecciona una imagen, y frontend hace este request.

**Comportamiento**:
- `isMain` siempre es `false` al subir. Usar `PATCH .../main` para cambiarla despues
- `sortOrder` se autoincrementa (siguiente al mayor existente)
- La imagen se sube a Spaces con ruta `Product/<productId>/<uuid>.<ext>`

---

### 5.2) Subir imagen de variante (★ NUEVO — multipart)

```
POST /products/:id/variants/:variantId/images/upload
```

**Permiso**: `update:Product`

**Content-Type**: `multipart/form-data`

**Parametros de ruta**:
| Parametro | Tipo | Requerido | Descripcion |
|-----------|------|-----------|-------------|
| `id` | UUID | SI | ID del producto |
| `variantId` | UUID | SI | ID de la variante |

**Body** (multipart form-data):
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `file` | File | SI | El archivo de imagen. El campo DEBE llamarse exactamente `file` |

**Response** `201 Created`:
```json
{
  "id": "a1b2c3d4-...",
  "fileId": "e5f6g7h8-...",
  "url": "https://tu-bucket.nyc3.cdn.digitaloceanspaces.com/ProductVariant/x1y2z3/i9j0k1l2.png",
  "isMain": false,
  "sortOrder": 0,
  "variantId": "x1y2z3w4-..."
}
```

**Uso tipico**: En la tabla de variantes, el usuario hace click en el icono de imagen de una variante. Se abre un modal "Elegir fotos de [Producto] [Variante]". El usuario presiona "Anadir imagen" y selecciona un archivo.

**Comportamiento**:
- Valida que la variante pertenezca al producto (404 si no)
- `sortOrder` autoincrementa dentro del scope de esa variante
- La imagen se sube con ruta `ProductVariant/<variantId>/<uuid>.<ext>`

---

### 5.3) Agregar imagen por URL (legacy — JSON)

```
POST /products/:id/images
```

**Permiso**: `update:Product`

**Content-Type**: `application/json`

**Body**:
```json
{
  "url": "https://ejemplo.com/imagen.jpg",
  "isMain": false,
  "sortOrder": 0,
  "variantId": "uuid-opcional"
}
```

| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `url` | string (URL valida) | SI | URL de la imagen |
| `isMain` | boolean | NO | Marcar como imagen principal (default: false) |
| `sortOrder` | number | NO | Orden (default: 0) |
| `variantId` | string | NO | UUID de la variante (omitir para imagen de producto) |

**Response** `201 Created`:
```json
{
  "id": "a1b2c3d4-...",
  "productId": "p1r2o3d4-...",
  "variantId": null,
  "fileId": null,
  "url": "https://ejemplo.com/imagen.jpg",
  "isMain": false,
  "sortOrder": 0,
  "createdAt": "2026-04-22T10:00:00.000Z"
}
```

> **Nota**: Este endpoint NO sube archivo. Solo guarda la URL en la base de datos. `fileId` sera `null`. Usar los endpoints multipart (5.1 y 5.2) para subir archivos reales.

---

### 5.4) Listar imagenes de producto

```
GET /products/:id/images
```

**Permiso**: `read:Product`

**Response** `200 OK`:
```json
[
  {
    "id": "img1-...",
    "productId": "prod1-...",
    "variantId": null,
    "fileId": "file1-...",
    "url": "https://tu-bucket.../Product/prod1/abc.jpg",
    "isMain": true,
    "sortOrder": 0,
    "createdAt": "2026-04-22T10:00:00.000Z"
  },
  {
    "id": "img2-...",
    "productId": "prod1-...",
    "variantId": "var1-...",
    "fileId": "file2-...",
    "url": "https://tu-bucket.../ProductVariant/var1/def.png",
    "isMain": false,
    "sortOrder": 0,
    "createdAt": "2026-04-22T10:01:00.000Z"
  }
]
```

**Ordenamiento**: primero las `isMain: true`, luego por `sortOrder` ascendente.

**Uso tipico**: Al cargar la pantalla de editar producto, hacer este request para mostrar la galeria de imagenes. Filtrar por `variantId === null` para imagenes del producto y por `variantId === <id>` para imagenes de cada variante.

---

### 5.5) Establecer imagen principal

```
PATCH /products/:id/images/:imageId/main
```

**Permiso**: `update:Product`

**Body**: no requiere body.

**Response** `200 OK`:
```json
{
  "id": "img1-...",
  "productId": "prod1-...",
  "variantId": null,
  "fileId": "file1-...",
  "url": "https://...",
  "isMain": true,
  "sortOrder": 0,
  "createdAt": "2026-04-22T10:00:00.000Z"
}
```

**Comportamiento**:
- Desactiva automaticamente la imagen principal anterior **dentro del mismo scope**:
  - Si la imagen es de producto (`variantId: null`), desactiva la main de producto
  - Si la imagen es de variante (`variantId: "x"`), desactiva la main de esa variante
- Solo puede haber UNA imagen `isMain: true` por scope

---

### 5.6) Eliminar imagen

```
DELETE /products/:id/images/:imageId
```

**Permiso**: `update:Product`

**Response** `204 No Content` (sin body).

**Comportamiento**:
- Elimina el registro `ProductImage`
- **Si tiene `fileId`**: tambien elimina el `FileObject` de la base de datos Y el archivo remoto de Spaces
- **Si NO tiene `fileId`** (URL legacy): solo elimina el registro

---

### 5.7) Subir archivo generico (modulo de archivos)

```
POST /files
```

**Permiso**: `create:File`

**Content-Type**: `multipart/form-data`

**Body** (multipart):
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `file` | File | SI | El archivo. Campo DEBE llamarse `file` |

**Response** `201 Created`:
```json
{
  "id": "f1l2e3-...",
  "storageKey": "orphan/a1b2c3d4.jpg",
  "url": "https://tu-bucket.../orphan/a1b2c3d4.jpg",
  "mimeType": "image/jpeg",
  "sizeBytes": 245760,
  "uploadedBy": "user-uuid-...",
  "createdAt": "2026-04-22T10:00:00.000Z"
}
```

> **Nota**: Este endpoint es generico. Al subir un archivo aqui, queda como "orphan" (sin dueño). Los endpoints de producto (5.1 y 5.2) son los que frontend deberia usar para imagenes de producto — estos manejan automaticamente la asociacion con el producto/variante.

---

### 5.8) Obtener metadata de archivo

```
GET /files/:id
```

**Permiso**: `read:File`

**Response** `200 OK`:
```json
{
  "id": "f1l2e3-...",
  "storageKey": "Product/prod1/a1b2c3d4.jpg",
  "url": "https://tu-bucket.../Product/prod1/a1b2c3d4.jpg",
  "mimeType": "image/jpeg",
  "sizeBytes": 245760,
  "ownerType": "Product",
  "ownerId": "prod1-...",
  "uploadedBy": "user-uuid-...",
  "createdAt": "2026-04-22T10:00:00.000Z"
}
```

---

### 5.9) Eliminar archivo generico

```
DELETE /files/:id
```

**Permiso**: `delete:File`

**Response** `204 No Content` (sin body).

**Comportamiento**: Elimina el registro de DB y el archivo remoto de Spaces.

---

## 6) Errores esperables

Formato estandar del `DomainExceptionFilter`:

```json
{
  "statusCode": 422,
  "error": "FILE_TOO_LARGE",
  "message": "File size exceeds maximum allowed: 10 MB",
  "timestamp": "2026-04-22T10:00:00.000Z"
}
```

### Errores de archivos

| Error | Status | Cuando ocurre |
|-------|--------|---------------|
| `FILE_TOO_LARGE` | `422` | El archivo supera el limite (default 10 MB) |
| `UNSUPPORTED_MEDIA_TYPE` | `400` | MIME type no permitido (no es jpeg/png/webp/gif) |
| `FILE_NOT_FOUND` | `404` | El archivo con ese ID no existe |
| `STORAGE_UPLOAD_FAILED` | `500` | Error al subir a DigitalOcean Spaces (error del proveedor) |

### Errores de productos/imagenes

| Error | Status | Cuando ocurre |
|-------|--------|---------------|
| `ENTITY_NOT_FOUND` (Product) | `404` | El producto con ese ID no existe |
| `ENTITY_NOT_FOUND` (Variant) | `404` | La variante no existe o no pertenece al producto |
| `ENTITY_NOT_FOUND` (ProductImage) | `404` | La imagen no existe o no pertenece al producto |
| `MAIN_IMAGE_CONFLICT` | `422` | Conflicto de constraint unico al marcar como principal |
| `VARIANT_PRODUCT_MISMATCH` | `422` | La variante no pertenece al producto (endpoint legacy) |

### Errores generales

| Error | Status | Cuando ocurre |
|-------|--------|---------------|
| — | `401` | Token JWT faltante o invalido |
| `INSUFFICIENT_PERMISSIONS` | `403` | El usuario no tiene el permiso requerido |
| — | `400` | UUID invalido en parametro de ruta |

---

## 7) Tipos MIME permitidos

Solo se permiten archivos de imagen. Si frontend quiere validar **antes** de enviar:

```typescript
const ALLOWED_MIME_TYPES = [
  'image/jpeg',   // .jpg, .jpeg
  'image/png',    // .png
  'image/webp',   // .webp
  'image/gif',    // .gif
];
```

Frontend puede usar el atributo `accept` en el input file:

```html
<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" />
```

---

## 8) Flujos de implementacion UI

### 8.1) Subir imagen de producto

1. Usuario esta en la pantalla de **editar producto**
2. En la seccion "Imagenes", presiona **"Anadir imagen"**
3. Se abre un file picker nativo (o un dropzone)
4. El usuario selecciona un archivo
5. Frontend valida localmente (tipo MIME + tamano < 10MB)
6. Frontend envia `POST /products/:id/images/upload` con `multipart/form-data`
7. Mostrar loader/spinner mientras sube
8. Al recibir `201`, agregar la imagen a la galeria usando la `url` del response
9. Si es la primera imagen, opcionalmente llamar a `PATCH .../main` para marcarla como principal

```typescript
// Ejemplo con fetch
const formData = new FormData();
formData.append('file', selectedFile); // 'file' es OBLIGATORIO como nombre del campo

const response = await fetch(`/products/${productId}/images/upload`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    // NO poner Content-Type — el browser lo pone automaticamente con boundary
  },
  body: formData,
});

const image = await response.json();
// image = { id, fileId, url, isMain, sortOrder }
```

### 8.2) Subir imagen de variante

1. Usuario esta en la seccion **Variantes** de editar producto
2. Hace click en el **icono de imagen** al lado del nombre de la variante
3. Se abre un **modal** "Elegir Fotos de [Producto] [Variante]"
4. El modal tiene un boton **"Anadir imagen"**
5. Flujo identico al 8.1 pero contra `POST /products/:id/variants/:variantId/images/upload`
6. Al recibir `201`, agregar la imagen al modal
7. El modal tiene botones "Cancelar" / "Guardar"

```typescript
const formData = new FormData();
formData.append('file', selectedFile);

const response = await fetch(
  `/products/${productId}/variants/${variantId}/images/upload`,
  {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData,
  }
);

const image = await response.json();
// image = { id, fileId, url, isMain, sortOrder, variantId }
```

### 8.3) Cargar galeria de imagenes existentes

1. Al abrir la pantalla de editar producto, hacer `GET /products/:id/images`
2. Filtrar las imagenes:
   - `variantId === null` → imagenes del producto (mostrar en seccion "Imagenes")
   - `variantId === <id>` → imagenes de esa variante (mostrar en el modal de variante)
3. La primera con `isMain: true` y `variantId: null` es la imagen principal del producto
4. Para cada variante, la primera con `isMain: true` y `variantId: <id>` es la principal de esa variante

```typescript
const response = await fetch(`/products/${productId}/images`, {
  headers: { 'Authorization': `Bearer ${token}` },
});
const images: ProductImage[] = await response.json();

// Imagenes de producto
const productImages = images.filter(img => img.variantId === null);

// Imagenes de una variante especifica
const variantImages = images.filter(img => img.variantId === variantId);
```

### 8.4) Eliminar imagen

1. El usuario hace click en el boton de eliminar (X o trash) sobre una imagen
2. Mostrar confirmacion: "Eliminar esta imagen?"
3. `DELETE /products/:id/images/:imageId`
4. Si `204` → remover la imagen de la galeria
5. Si la imagen eliminada era `isMain: true`, considerar marcar otra como principal

### 8.5) Marcar como imagen principal

1. El usuario hace click derecho / hover sobre una imagen y selecciona "Marcar como principal"
2. `PATCH /products/:id/images/:imageId/main`
3. Al recibir `200`, actualizar el estado local: `isMain = true` en esta imagen, `isMain = false` en la anterior principal (del mismo scope)

---

## 9) Edge cases criticos

### 9.1) El campo multipart DEBE llamarse `file`

El backend usa `FileInterceptor('file')`. Si envias el campo con otro nombre (como `image`, `photo`, etc.), **no se va a procesar** y vas a recibir un error porque `file` sera `undefined`.

```typescript
// ✅ CORRECTO
formData.append('file', selectedFile);

// ❌ INCORRECTO — no va a funcionar
formData.append('image', selectedFile);
formData.append('photo', selectedFile);
```

### 9.2) NO pongas Content-Type manualmente en multipart

```typescript
// ✅ CORRECTO — el browser genera el boundary automaticamente
headers: { 'Authorization': `Bearer ${token}` }

// ❌ INCORRECTO — esto rompe el boundary
headers: {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'multipart/form-data'  // NO HACER ESTO
}
```

### 9.3) Validacion de tamano

El limite default es **10 MB**. Si el usuario selecciona un archivo mas grande, el backend devuelve `422 FILE_TOO_LARGE`. Recomendacion: validar del lado del frontend antes de enviar:

```typescript
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

if (file.size > MAX_FILE_SIZE) {
  showError('La imagen no puede pesar mas de 10 MB');
  return;
}
```

### 9.4) Una sola imagen principal por scope

- Puede haber UNA imagen principal para el producto (donde `variantId: null`)
- Puede haber UNA imagen principal para CADA variante (donde `variantId: <id>`)
- Estos son scopes independientes — tener una main de variante no afecta la main del producto
- Al marcar como main via `PATCH .../main`, el backend desactiva automaticamente la anterior

### 9.5) Eliminar producto = eliminar archivos remotos

Cuando un producto se elimina (`DELETE /products/:id`), por cascade:
- Se eliminan todos los `ProductImage` (cascade de Prisma)
- Los `FileObject` asociados quedan con `fileId: null` (onDelete: SetNull)
- Los archivos remotos en Spaces **NO se eliminan automaticamente** — esto se limpiara en futuras versiones

### 9.6) Imagenes por URL vs imagenes subidas

| | Imagen por URL | Imagen subida |
|---|---|---|
| Endpoint | `POST /products/:id/images` (JSON) | `POST /products/:id/images/upload` (multipart) |
| `fileId` en response | `null` | UUID del FileObject |
| Al eliminar | Solo borra registro DB | Borra registro DB + archivo en Spaces |
| URL | La que pasaste | Generada por el backend (CDN de Spaces) |

---

## 10) Que cambio en productos (para frontend que ya tenia endpoints implementados)

### 10.1) Nuevos endpoints

| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| `POST` | `/products/:id/images/upload` | ★ NUEVO — Subir imagen de producto (multipart) |
| `POST` | `/products/:id/variants/:variantId/images/upload` | ★ NUEVO — Subir imagen de variante (multipart) |

### 10.2) Cambios en endpoints existentes

**`GET /products/:id/images`** — Ahora cada imagen puede tener `fileId`:
```typescript
// Antes (solo URL)
{ id, productId, variantId, url, isMain, sortOrder, createdAt }

// Ahora (con fileId)
{ id, productId, variantId, fileId, url, isMain, sortOrder, createdAt }
//                          ^^^^^^ NUEVO — puede ser string | null
```

**`DELETE /products/:id/images/:imageId`** — Mismo endpoint, pero ahora:
- Si la imagen tiene `fileId`, **tambien borra el archivo de Spaces** (antes solo borraba el registro)

**`POST /products/:id/images`** (JSON/URL) — Sigue funcionando igual, sin cambios.

### 10.3) Nuevo campo en ProductImage

```typescript
// Nuevo campo en todas las respuestas que incluyen ProductImage
fileId: string | null  // UUID del FileObject asociado, o null si es por URL
```

Este campo aparece en:
- `GET /products/:id/images` (cada item del array)
- `POST /products/:id/images` (response)
- `PATCH /products/:id/images/:imageId/main` (response)

### 10.4) Modelo de datos (Prisma) — lo que cambio

```
ProductImage
  + fileId    String?  @unique    // FK a FileObject, nullable, 1-a-1

FileObject (tabla nueva: "files")
  id, storageKey, url, mimeType, sizeBytes, ownerType, ownerId, uploadedBy, createdAt, updatedAt
```

---

## 11) Ejemplos completos con cURL

### Subir imagen de producto

```bash
curl -X POST http://localhost:3000/products/PRODUCT_UUID/images/upload \
  -H "Authorization: Bearer JWT_TOKEN" \
  -F "file=@/ruta/a/imagen.jpg"
```

### Subir imagen de variante

```bash
curl -X POST http://localhost:3000/products/PRODUCT_UUID/variants/VARIANT_UUID/images/upload \
  -H "Authorization: Bearer JWT_TOKEN" \
  -F "file=@/ruta/a/imagen.png"
```

### Listar imagenes

```bash
curl http://localhost:3000/products/PRODUCT_UUID/images \
  -H "Authorization: Bearer JWT_TOKEN"
```

### Marcar como principal

```bash
curl -X PATCH http://localhost:3000/products/PRODUCT_UUID/images/IMAGE_UUID/main \
  -H "Authorization: Bearer JWT_TOKEN"
```

### Eliminar imagen

```bash
curl -X DELETE http://localhost:3000/products/PRODUCT_UUID/images/IMAGE_UUID \
  -H "Authorization: Bearer JWT_TOKEN"
```

### Agregar imagen por URL (legacy)

```bash
curl -X POST http://localhost:3000/products/PRODUCT_UUID/images \
  -H "Authorization: Bearer JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://ejemplo.com/imagen.jpg", "isMain": false}'
```

---

## 12) Resumen rapido de endpoints

| Metodo | Ruta | Permiso | Body | Status | Descripcion |
|--------|------|---------|------|--------|-------------|
| `POST` | `/products/:id/images/upload` | `update:Product` | multipart (`file`) | `201` | Subir imagen de producto |
| `POST` | `/products/:id/variants/:variantId/images/upload` | `update:Product` | multipart (`file`) | `201` | Subir imagen de variante |
| `POST` | `/products/:id/images` | `update:Product` | JSON (`url`, `isMain?`, `sortOrder?`, `variantId?`) | `201` | Agregar imagen por URL |
| `GET` | `/products/:id/images` | `read:Product` | — | `200` | Listar imagenes del producto |
| `PATCH` | `/products/:id/images/:imageId/main` | `update:Product` | — | `200` | Marcar como imagen principal |
| `DELETE` | `/products/:id/images/:imageId` | `update:Product` | — | `204` | Eliminar imagen |
| `POST` | `/files` | `create:File` | multipart (`file`) | `201` | Subir archivo generico |
| `GET` | `/files/:id` | `read:File` | — | `200` | Obtener metadata de archivo |
| `DELETE` | `/files/:id` | `delete:File` | — | `204` | Eliminar archivo generico |
