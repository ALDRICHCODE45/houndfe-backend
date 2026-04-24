# Busqueda de Catalogo POS — Contrato Tecnico Completo para Frontend

> Fuente de verdad: implementacion actual en backend (`src/sales/sales-catalog.controller.ts`, `src/sales/dto/search-pos-catalog.dto.ts`, `src/products/products.service.ts`, `DomainExceptionFilter`).

---

## 0) Objetivo de este documento

Este documento esta hecho para que frontend implemente la busqueda de productos del POS sin adivinar nada.

Incluye:

- que cambio respecto a la v1,
- que endpoint usar ahora,
- que query params mandar,
- que estructura devuelve,
- reglas de negocio reales del backend,
- errores esperables,
- flujo recomendado de UI.

---

## 1) Que cambio (resumen ejecutivo)

### Antes (v1)

Frontend usaba `GET /products` para buscar productos del POS.

Problemas:

- endpoint pensado para administracion, no para caja,
- no venian variantes completas listas para seleccionar,
- no venian precios por variante ya resueltos para POS,
- no venian imagenes optimizadas para picker de POS,
- no filtraba automaticamente `sellInPos=true`.

### Ahora (v1.1)

Se agrego endpoint dedicado:

```http
GET /sales/pos-catalog
```

Este endpoint:

- filtra solo productos habilitados para POS (`sellInPos=true`),
- devuelve producto + variantes + imagenes + precios + stock en una sola respuesta,
- expone contrato optimizado para el buscador/select de caja,
- usa permiso de ventas (`read:Sale`) en vez de permiso de catalogo admin.

---

## 2) Endpoint oficial para frontend POS

```http
GET /sales/pos-catalog
```

**Permiso**: `read:Sale`  
**Auth**: JWT obligatorio (`Authorization: Bearer <token>`)

---

## 3) Query params

| Parametro | Tipo | Requerido | Default | Validacion backend | Descripcion |
|---|---|---|---|---|---|
| `q` | `string` | No | - | max 100 chars | Busca en nombre/SKU/barcode de producto y tambien en nombre/SKU/barcode de variantes |
| `limit` | `number` | No | `25` | int, min 1, max 50 | Cantidad de items por pagina |
| `offset` | `number` | No | `0` | int, min 0 | Desplazamiento para paginacion |
| `categoryId` | `uuid` | No | - | UUID valido | Filtra por categoria |
| `brandId` | `uuid` | No | - | UUID valido | Filtra por marca |

### Ejemplos

```http
GET /sales/pos-catalog?q=aspirina
GET /sales/pos-catalog?q=ASP-500&limit=25&offset=0
GET /sales/pos-catalog?categoryId=<uuid>&brandId=<uuid>&limit=50
```

---

## 4) Response contract (exacto)

```ts
interface PosCatalogResponse {
  items: PosCatalogItem[];
  total: number;
  limit: number;
  offset: number;
}

interface PosCatalogItem {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit: string | null;
  hasVariants: boolean;
  useStock: boolean;
  category: { id: string; name: string } | null;
  brand: { id: string; name: string } | null;
  mainImage: string | null;
  images: string[];
  price: PosCatalogPrice | null;
  stock: PosCatalogStock | null;
  variants: PosCatalogVariant[];
}

interface PosCatalogVariant {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  mainImage: string | null;
  price: PosCatalogPrice | null;
  stock: PosCatalogStock | null;
}

interface PosCatalogPrice {
  priceCents: number;
  priceDecimal: number;
  priceListName: string; // hoy: "PUBLICO"
}

interface PosCatalogStock {
  quantity: number;
  minQuantity: number;
}
```

---

## 5) Ejemplo real de respuesta

```json
{
  "items": [
    {
      "id": "prod-1",
      "name": "Aspirina 500mg",
      "sku": "ASP-500",
      "barcode": "7501234567890",
      "unit": "UNIDAD",
      "hasVariants": false,
      "useStock": true,
      "category": { "id": "cat-1", "name": "Medicamentos" },
      "brand": { "id": "brand-1", "name": "Bayer" },
      "mainImage": "https://cdn/.../asp-main.jpg",
      "images": [
        "https://cdn/.../asp-main.jpg",
        "https://cdn/.../asp-2.jpg"
      ],
      "price": {
        "priceCents": 4998,
        "priceDecimal": 49.98,
        "priceListName": "PUBLICO"
      },
      "stock": {
        "quantity": 120,
        "minQuantity": 10
      },
      "variants": []
    },
    {
      "id": "prod-2",
      "name": "Camisa",
      "sku": "CAM-001",
      "barcode": null,
      "unit": "UNIDAD",
      "hasVariants": true,
      "useStock": true,
      "category": { "id": "cat-2", "name": "Ropa" },
      "brand": null,
      "mainImage": "https://cdn/.../camisa-main.jpg",
      "images": ["https://cdn/.../camisa-main.jpg"],
      "price": null,
      "stock": null,
      "variants": [
        {
          "id": "var-1",
          "name": "Roja M",
          "sku": "CAM-R-M",
          "barcode": "7509876543210",
          "mainImage": "https://cdn/.../camisa-roja.jpg",
          "price": {
            "priceCents": 29900,
            "priceDecimal": 299,
            "priceListName": "PUBLICO"
          },
          "stock": {
            "quantity": 5,
            "minQuantity": 2
          }
        }
      ]
    }
  ],
  "total": 42,
  "limit": 25,
  "offset": 0
}
```

---

## 6) Reglas de negocio reales (importantes)

1. **Solo `sellInPos=true`**
   - Si un producto no esta habilitado para POS, no aparece.

2. **Busqueda `q` es amplia**
   - Matchea nombre/SKU/barcode de producto.
   - Matchea nombre/SKU/barcode de variantes.

3. **Imagenes limitadas**
   - `images` viene con maximo 5 URLs.
   - Orden: `isMain desc`, `sortOrder asc`.
   - `mainImage` = imagen principal; si no hay main, usa la primera; si no hay ninguna, `null`.

4. **Precio en productos sin variantes**
   - `price` viene resuelto por lista default (PUBLICO).

5. **Precio en productos con variantes**
   - `price` del producto viene `null`.
   - El precio real esta en cada `variant.price`.

6. **Stock**
   - Si `useStock=false` => stock `null`.
   - Si producto sin variantes => stock en `item.stock`.
   - Si producto con variantes => stock en cada `variant.stock`.

---

## 7) Errores esperables

Formato general (`DomainExceptionFilter`):

```json
{
  "statusCode": 400,
  "error": "INVALID_ARGUMENT",
  "message": "...",
  "timestamp": "2026-04-23T18:00:00.000Z"
}
```

### Tabla de errores

| Caso | Status | Motivo |
|---|---|---|
| Sin token JWT | 401 | No autenticado |
| Sin permiso `read:Sale` | 403 | Usuario sin permiso para ventas |
| `limit` invalido (ej: 0 o >50) | 400 | Error de validacion DTO |
| `offset` invalido (ej: negativo) | 400 | Error de validacion DTO |
| `categoryId`/`brandId` invalido | 400 | UUID invalido |
| Error inesperado interno | 500 | Falla no controlada |

---

## 8) Flujo recomendado de frontend

### 8.1 Buscador de productos POS

1. Cuando abre POS, hacer primera carga:
   - `GET /sales/pos-catalog?limit=25&offset=0`
2. Al escribir en search input, usar debounce (ej. 250ms):
   - `GET /sales/pos-catalog?q=<texto>&limit=25&offset=0`
3. Mostrar tarjeta/item con:
   - nombre, SKU/barcode, `mainImage`, precio y stock.
4. Si `hasVariants=true`:
   - abrir selector de variantes usando `item.variants` (sin request extra).

### 8.2 Paginacion

- Boton “ver mas” o scroll infinito:
  - incrementar `offset` por `limit`.
  - mergear `items` nuevos.

### 8.3 Agregar item al draft

- Producto sin variante:
  - usar `productId` y `variantId = null`.
- Producto con variantes:
  - usuario elige variante y enviar `variantId`.

---

## 9) Migracion desde `GET /products`

Si hoy el POS usa `GET /products`, migrar a `GET /sales/pos-catalog`.

| Aspecto | `GET /products` (admin) | `GET /sales/pos-catalog` (POS) |
|---|---|---|
| Permiso | `read:Product` | `read:Sale` |
| Filtro POS | manual | automatico (`sellInPos=true`) |
| Variantes para selector | incompleto/no optimizado | incluidas con precio/stock |
| Imagenes | admin-centric | listas para picker POS |
| Uso recomendado | CRUD/tabla admin | buscador de caja |

---

## 10) Ejemplos cURL

```bash
# Basico
curl "http://localhost:3000/sales/pos-catalog" \
  -H "Authorization: Bearer $TOKEN"

# Busqueda por nombre
curl "http://localhost:3000/sales/pos-catalog?q=Aspirina" \
  -H "Authorization: Bearer $TOKEN"

# Busqueda por SKU
curl "http://localhost:3000/sales/pos-catalog?q=ASP-500" \
  -H "Authorization: Bearer $TOKEN"

# Con filtros + paginacion
curl "http://localhost:3000/sales/pos-catalog?categoryId=<uuid>&brandId=<uuid>&limit=50&offset=0" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 11) Checklist rapido para frontend

- [ ] Dejar de usar `GET /products` para buscador POS
- [ ] Usar `GET /sales/pos-catalog`
- [ ] Implementar debounce en `q`
- [ ] Soportar paginacion con `limit/offset`
- [ ] Renderizar `mainImage` con fallback visual si viene `null`
- [ ] Si `hasVariants=true`, usar `variants[]` para selector
- [ ] Tomar precio de `item.price` o `variant.price` segun corresponda
- [ ] Manejar errores 401/403/400 con mensajes de UI claros
