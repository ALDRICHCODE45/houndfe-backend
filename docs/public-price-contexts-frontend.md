# Selector público de contextos de precios

El catálogo público puede descubrir las listas de precios **vinculadas al catálogo de un tenant** antes de pedir productos. La ruta no requiere JWT y no consulta productos ni inventa una selección.

## Integración rápida

```http
GET /public/catalog/:tenantSlug/price-contexts
```

**200 OK**: array JSON directo, sin envoltorio `items`/`data`:

```json
[
  {
    "priceListId": "11111111-1111-4111-8111-111111111111",
    "name": "General",
    "isCatalogDefault": true
  },
  {
    "priceListId": "22222222-2222-4222-8222-222222222222",
    "name": "Mayorista",
    "isCatalogDefault": false
  }
]
```

Cada entrada tiene **sólo** esas tres claves. `priceListId` es el ID de `GlobalPriceList`, no el ID del binding. Nunca se devuelven listas globales privadas/no vinculadas, datos del tenant, precios, stock o elegibilidad por producto. `name` es único globalmente en el esquema actual; **usá el ID como clave**, no el nombre.

## Estados y orden

| Caso                                        | Resultado                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant activo y publicado, con bindings     | 200 array; default primero, restantes por `name` ascendente según colación de PostgreSQL y, a igualdad de nombre, `priceListId` ascendente. |
| Tenant activo y publicado, sin bindings     | 200 `[]`.                                                                                                                                   |
| Tenant inexistente, inactivo o no publicado | 404 genérico `Not Found`; no se consulta el listado.                                                                                        |

El índice único parcial en `tenant_catalog_price_lists` garantiza **como máximo un** `isCatalogDefault: true` por tenant. Los settings válidos de un catálogo publicado requieren uno, pero ante datos anómalos puede haber cero: **no elijas automáticamente el primer elemento**. Mostrá selección explícita o estado indisponible. La ruta anuncia opciones del tenant, no garantiza que todos los productos tengan precio en todas ellas.

Respuestas exitosas: `Cache-Control: public, max-age=60`; límite `public-browse` de 60 solicitudes/minuto. Al cambiar de tenant, invalidá las opciones/selección cacheadas. Ante un cambio administrativo podrían permanecer opciones cacheadas hasta 60 segundos; el servidor vuelve a validar el contexto en cada lectura de productos.

## Selección para listado y detalle existentes

- `GET /public/catalog/:tenantSlug/products` y `GET /public/catalog/:tenantSlug/products/:productId` reciben **a lo sumo un** `priceListId` opcional por request. Sin query, usan el default del catálogo; con query, usan sólo ese ID. No hay fallback a otra lista ni combinación de listas.
- Un UUID válido privado, desvinculado, de otro tenant o inexistente devuelve el **mismo 404** `PRICE_CONTEXT_NOT_AVAILABLE`; UUID malformado devuelve 400 de validación. No uses el error para enumerar listas.
- El listado/detalle puede devolver ausencia/404 para un producto particular aunque la lista figure en la enumeración. Al cambiar de lista, invalidá listado y detalle y solicitá ambos de nuevo con **el mismo ID**. No conserves precios del contexto anterior.
- Carrito/validación queda fuera de esta entrega frontend. La ruta no altera precios, stock ni productos.

## QA mínima

1. Tenant publicado: default primero; opciones restantes por nombre; respuesta sin campos extra.
2. Lista global sin binding y lista de otro tenant: nunca aparecen.
3. Sin bindings: `[]`; sin default: no seleccionar la primera lista por conjetura.
4. Slug desconocido/inactivo/no publicado: 404; selección explícita inválida en listado y detalle: 404 sin fallback.
5. Cambiar tenant/contexto: invalidar opciones y lecturas previas; distinguir 400 de UUID malformado.
