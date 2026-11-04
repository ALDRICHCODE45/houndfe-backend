# O3 intención de compra + O1 mapa de escritores — propuesta para readback FE/BE

**Estado: PROPUESTA, no implementada ni aprobada como API/esquema.** El readback FE no es aprobación API ni autorización de implementación. Proveedores, archivo/activación, costo informado y ubicación permanecen dentro del alcance funcional; se proponen representaciones, no su eliminación. No autoriza endpoints, migraciones, ejecución, despliegue ni efectos. Las seis decisiones de negocio de §8 están cerradas; rutas, DTOs, permisos y mecanismos nuevos de §2–§5 siguen siendo propuesta hasta acuerdo técnico FE/BE, no capacidades disponibles.

## 1. Secuencia y límites acordados

- O3 proveedores/órdenes de intención puede avanzar en paralelo con O1 diario de inventario, ajuste auditado y apertura. O2 lotes de variantes sigue a O1; O4 recepciones sigue a O1/O2/O3.
- O3 no recibe mercancía, reserva stock, paga, genera deuda ni valúa. Confirmar significa fijar intención documental, no recepción ni aceptación física. Cancelar intención tampoco revierte inventario ni dinero.
- O4 conserva el caso aceptado: 10 cajas pedidas, 6 aceptadas → +6, pendientes 4; siguientes 4 → +4, pendientes 0; reintento → cero duplicado. Son cajas vendibles, no conversión de unidades. **No es comportamiento de O3.**
- Dañados, vencidos o mercancía equivocada van a revisión separada; vencidos nunca se venden. Transferencias internas de la misma empresa no son compras; preservar aislamiento de tenant y ubicaciones.
- RBAC granular configurable por usuarios: sin roles fijos ni segunda aprobación obligatoria.
- No se eligen aquí política de apertura, valuación, reversos ni reglas comerciales pendientes.

## 2. Transporte O3 propuesto (todo nuevo)

Base relativa al prefijo API configurado. JWT + contexto de tenant + permisos; actor y tenant derivados del contexto autenticado, nunca del body. UUIDs y referencias siempre resueltos dentro del tenant. Una variante debe pertenecer al producto del mismo tenant. Sin permisos heredados de ventas.

**No reutilizar `/orders`:** es venta a cliente (`customerName`, `items`), no compra; ver `src/orders/dto/place-order.dto.ts:10–26`, `src/orders/orders.controller.ts:20–48` y decrementos de stock en `src/orders/orders.service.ts:91–96`.

| Operación propuesta | Body cerrado | Éxito propuesto |
| --- | --- | --- |
| `GET /procurement/suppliers?search=…&status=…&cursor=…&limit=…` | Sin body | `200 Page<Supplier>` |
| `POST /procurement/suppliers` | `SupplierInput` | `201 Supplier` |
| `GET /procurement/suppliers/:supplierId` | Sin body | `200 Supplier` |
| `PATCH /procurement/suppliers/:supplierId` | `{ expectedVersion, changes: SupplierPatch }` | `200 Supplier` |
| `GET /procurement/purchase-orders?cursor=…&limit=…` | Sin body | `200 Page<PurchaseOrder>` |
| `POST /procurement/purchase-orders` | `OrderInput` | `201 PurchaseOrder` en `DRAFT` |
| `GET /procurement/purchase-orders/:orderId` | Sin body | `200 PurchaseOrder` |
| `PUT /procurement/purchase-orders/:orderId/draft` | `{ expectedVersion, order: OrderInput }` | `200 PurchaseOrder` |
| `POST /procurement/purchase-orders/:orderId/confirm` | `ConfirmOrderInput` | `200 PurchaseOrder` |
| `POST /procurement/purchase-orders/:orderId/cancel` | `{ expectedVersion }` | `200 PurchaseOrder` |

Sin DELETE, recepción, pago, devolución, liquidación ni endpoint de stock en esta fase. Archivo/reactivación de proveedor usa PATCH con CAS; no borra historial ni cancela órdenes. `PUT draft` reemplaza exclusivamente contenido documental. El DTO siguiente admite borradores incompletos según la opción B aceptada por el usuario; confirmar exige completar y validar los datos. Esta decisión no aprueba las demás políticas ni el wire técnico.

### DTOs propuestos, no esquema aceptado

```ts
type SupplierInput = {
  displayName: string; termsText: string | null; status: 'ACTIVE' | 'ARCHIVED';
};
type SupplierPatch = Partial<SupplierInput>;
type InformedUnitCost = {
  amount: string | null; currency: string | null; unit: string | null;
  taxBasis: 'INCLUDES_TAX' | 'EXCLUDES_TAX' | null;
}; // Parcial en borrador; no costo de inventario ni cálculo fiscal
type Supplier = SupplierInput & {
  id: string; version: number; createdAt: string; updatedAt: string;
};
type OrderLine = {
  lineId: string; productId: string | null; variantId: string | null;
  orderedQuantity: number | null; informedUnitCost: InformedUnitCost | null;
};
type OrderInput = {
  supplierId: string | null; lines: OrderLine[]; note: string | null;
  location: { detail: string | null }; // Sucursal autenticada + detalle opcional aceptados
};
type ConfirmOrderInput = {
  expectedVersion: number; expectedSupplierVersion: number | null;
  expectedReferenceToken: string | null;
}; // Body cerrado: los tres campos son requeridos aunque dos admitan null; confirma guardado
// Cada línea confirmada tiene productId/orderedQuantity no nulos y costo completo:
type ConfirmedCost = { amount: string; currency: string; unit: string;
  taxBasis: 'INCLUDES_TAX' | 'EXCLUDES_TAX' };
type IssueCode = 'SUPPLIER_REQUIRED' | 'SUPPLIER_ARCHIVED' | 'LINES_REQUIRED'
  | 'PRODUCT_REQUIRED' | 'VARIANT_REQUIRED' | 'REFERENCE_UNAVAILABLE'
  | 'REFERENCE_INCOMPATIBLE' | 'UNIT_MISMATCH' | 'QUANTITY_REQUIRED'
  | 'COST_AMOUNT_REQUIRED' | 'COST_CURRENCY_REQUIRED' | 'COST_TAX_BASIS_REQUIRED'
  | 'COST_UNIT_REQUIRED' | 'STATE_CLOSED';
type PurchaseOrder = OrderInput & {
  id: string; version: number; status: 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
  supplierTermsSnapshot: null | {
    supplierId: string; supplierVersion: number;
    displayName: string; termsText: string | null;
  };
  supplierDisplaySnapshot: { id: string; displayName: string } | null;
  lineDisplaySnapshots: Array<{
    lineId: string; productName: string | null;
    variantName: string | null; unit: string | null;
  }>;
  locationSnapshot: { tenantId: string; tenantName: string; detail: string | null };
  validation: {
    canConfirm: boolean; referenceToken: string | null;
    supplierCurrentVersion: number | null;
    issues: Array<{ path: string; code: IssueCode }>;
  };
  createdAt: string; updatedAt: string;
};
type Page<T> = { items: T[]; nextCursor: string | null };
```

- Read model unificado nullable para DRAFT/CANCELLED: CONFIRMED exige supplierId/supplierTermsSnapshot no nulos, 1–200 líneas con productId/cantidad no nulos, variante según padre y `ConfirmedCost` completo; cancelar borrador conserva sus nulls, cancelar confirmada conserva sus snapshots. Un snapshot de línea por lineId presente, nunca rellenar nombre/unidad ausentes. GET diagnostica salud actual sin modificar documento.
- IDs de proveedor/orden: UUID generados por servidor. `lineId`: UUID generado por FE, estable y único dentro de la orden. Una línea persistida conserva su identidad; completar selección pendiente desde null conserva lineId, pero reemplazar identidad vendible ya elegida crea otro lineId, no reasigna el anterior a una línea distinta. Una línea descartada antes de persistirse no exige tombstone ni registro histórico. La estrategia de conservación para líneas persistidas se definirá con el almacenamiento; no se prescribe un registro ilimitado. No es ID de movimiento, lote o recepción.
- Límites técnicos candidatos: versiones enteras positivas, fechas UTC ISO 8601; nombre no blanco ≤200 puntos de código, términos ≤4000, nota ≤2000, detalle de ubicación ≤500, máximo 200 líneas; PATCH no vacío. `null` borra texto opcional; omisión en PATCH conserva. Rechazar campos extra, sin recortes silenciosos. Cantidad completa propuesta: entero positivo seguro por presentación vendible, sin conversiones.
- Costo informado propuesto por línea: `amount` decimal canónico no negativo en string (regex propuesta `^(0|[1-9][0-9]{0,11})(\.[0-9]{1,4})?$`, sin exponente/coma), `currency` código ISO 4217 explícito de tres letras mayúsculas, `unit` código UnitOfMeasure existente de la presentación, validado por servidor contra Product.unit. No default MXN, centavos, costo catálogo ni costo cero si falta. `null` significa no informado, nunca cero. Precio por una caja vendible es por caja, no por contenido. Moneda/precisión son propuesta técnica; costo completo por línea al confirmar ya está aceptado. Base fiscal aceptada: pregunta «¿Cómo querés registrar el costo que cotiza el proveedor en la orden de compra?», opción exacta «Indicar si incluye impuestos (recomendado)», descripción «Guardar el importe por unidad y aclarar si incluye o excluye impuestos, según la cotización del proveedor.». `taxBasis` declara inclusión/exclusión, sin default, tasa, desglose ni cálculo fiscal inferido. Para guardar incompletos, cada campo del costo puede ser null; validar sintaxis de los presentes y consistencia de unidad cuando ya existe referencia válida de producto, sin inventar valores faltantes. `informedUnitCost: null` indica ausencia; `amount: '0'` es un importe explícito distinto de ausencia. Decisión humana: pregunta «¿Se puede confirmar una orden de compra sin tener el costo de todas sus líneas?», opción «Exigir costo en cada línea (recomendado)», descripción exacta «Para confirmar, cada línea debe tener importe, moneda y aclaración de impuestos. El borrador puede seguir incompleto.». Confirmar exige amount/currency/taxBasis presentes en cada línea y unidad compatible con la presentación seleccionada; nunca rellenar ausencias con cero o defaults. No calcular totales fiscales, tipo de cambio, valuación ni deuda; tampoco actualizar `purchase*CostCents`. Lecturas usan la unidad capturada, no Product.unit vigente. Si cambia la unidad antes de confirmar, comparar el fingerprint y exigir reconciliación explícita: nunca reinterpretar ni convertir silenciosamente el importe usando la nueva unidad.
- Guardar admite `productId: null` con `variantId: null`, o producto seleccionado con `variantId: null` aunque tenga variantes (selección pendiente). Referencias introducidas o sustituidas exigen existencia, PRODUCT y pertenencia al padre/tenant; no se acepta una referencia nueva incompatible por ser borrador. Referencias antes válidas e invalidadas después se conservan únicamente según la regla de baseline siguiente. Confirmar exige producto y, si tiene variantes, la variante correspondiente; sin variantes exige `variantId: null`. Decisión humana: «¿Qué debería poder incluir esta primera versión de órdenes de compra?» → «Solo mercancía física (recomendado)», descripción «Productos y sus presentaciones, con o sin control de existencias. Servicios y gastos se trabajan por separado.». Solo PRODUCT físico, sin exigir useStock=true; SERVICE excluido en selector y validación servidor. No garantiza existencias ni cambia datos operativos. `termsText` es texto documental, no regla financiera ejecutable.
- **Conservar las condiciones de cada compra y no reescribir historia es requisito aceptado** (readback FE: `docs/redesign/procurement-inventory-plan.md:258–266`). Congelarlas al confirmar es el mecanismo PROPUESTO, no un esquema aceptado: servidor captura nombre/términos y versión del proveedor bajo la misma transacción que confirma. El body no suministra el snapshot. Cambios posteriores al proveedor no reescriben la orden confirmada.
- Propuesta de listados nuevos: `limit` 1–100, por defecto 25; cursor opaco ligado a tenant/recurso/search/status, orden `(createdAt, id)` descendente. Sin snapshot entre páginas; cursor inválido → 400. Proveedor exige `status=ACTIVE|ARCHIVED|ALL`, sin exclusión silenciosa; `search` opcional por nombre, contains insensible a mayúsculas, trim, vacío sin filtro, máximo 200 caracteres. No habilita filtros genéricos.

### Guardar, confirmar y leer: decisiones y evidencia

- **Opción B aceptada por el usuario:** pregunta «¿Cómo querés guardar las órdenes de compra mientras se están preparando?», selección exacta «Guardar incompletas y retomarlas (recomendado)», descripción «Permite guardar sin proveedor o con líneas pendientes. Confirmar exige completar y validar los datos.». Guardar admite `supplierId: null`, `lines: []`, `productId/orderedQuantity: null` y producto elegido con variante pendiente. Cantidades presentes siguen siendo enteros positivos seguros; referencias nuevas deben existir y pertenecer al tenant/padre. Las antes válidas que se invalidaron no se eliminan: se conservan con diagnóstico, sin habilitar confirmación. Snapshots de referencias ausentes son nulos; las presentes conservan sus etiquetas disponibles sin inventar variante/unidad. Confirmar exige proveedor, 1–200 líneas completas y referencias válidas conforme a políticas acordadas. No se habilita confirmar por haber guardado. Confirmar exige costo completo en cada línea (importe, moneda y aclaración de impuestos); ubicación ya decidida: sucursal autenticada con detalle opcional, tampoco obligatorio al confirmar; el costo parcial conserva campos presentes y nulls para los ausentes, incluso antes de seleccionar producto; no se descarta ni completa por inferencia. Unidad presente sin producto se conserva como declaración pendiente de compatibilidad; al seleccionar producto se valida contra su unidad, sin convertir el importe. Nombres enum/nullability son mecanismos técnicos propuestos para B, no permiso de confirmar costo incompleto.
- **Conservación segura propuesta:** baseline = último borrador guardado exitosamente por servidor, tenant-scope y CAS; nunca body rechazado, buffer FE ni recibo histórico. Mismo `supplierId` del baseline o mismo `lineId` y mismos IDs de presentación antes admitidos pueden conservarse aunque ahora falten, cambien a SERVICE o pierdan pertenencia; preservar IDs/últimas etiquetas/unidad y emitir diagnóstico, sin copiar esa excepción a otra línea/orden. Se permite editar nota/cantidad/costo parcial y otras líneas, retirar la línea o sustituirla explícitamente por una selección válida con otro lineId. No borrar ni cancelar automáticamente. No admitir nuevas referencias ajenas, SERVICE o variante de otro padre. Un cambio explícito de unidad del costo debe ser compatible con producto actual válido; conservar unidad anterior no la reinterpreta ni sanea el diagnóstico. Seleccionar producto con costo declarado previo exige compatibilidad o corrección explícita/null de la unidad, nunca conversión.
- **Proveedor archivado:** guardar el mismo `supplierId` ya persistido permite seguir editando el borrador, conservar etiquetas y emitir `SUPPLIER_ARCHIVED`; no es nueva selección. Adjuntar ese proveedor a otra orden, volver a elegirlo tras quitarlo/cambiarlo o introducirlo en alta se rechaza. Confirmación requiere proveedor activo, incluso si estaba elegido antes. Reactivación explícita con permiso y CAS; no cancelación/borrado, ni alteración de replay aplicado por archivo posterior.
- Lectura propuesta: GET/listado/mutación devuelven snapshots servidor de proveedor/producto/variante/unidad/ubicación, sin N+1 FE ni permisos de catálogo extra para leer orden. Referencias ausentes tienen snapshot nulo; referencias invalidadas conservan última etiqueta, no una inventada. Save refresca etiquetas solo de referencias válidas observadas; confirmar refresca y congela condiciones/etiquetas, nunca reescribe confirmadas/canceladas después de rename/archive. `validation` es diagnóstico de lectura, no permiso ni escritura: `canConfirm` exige DRAFT sin issues; paths JSON Pointer RFC 6901 (`/supplierId`, `/lines/0/informedUnitCost/amount`), índices de lines de ese mismo body/revisión (no lineId como índice), orden estable por path/code, sin IDs/datos de otro tenant. FE asocia cada índice al lineId de esa revisión, nunca a una lista reordenada. Estados cerrados siempre canConfirm=false; CANCELLED conserva nulls sin exigir shape CONFIRMED. `referenceToken` opaco, determinista para el mismo conjunto observado, captura IDs/pertenencia/tipo/unidad/configuración observados, no cantidades de stock, precios ni labels; null si no hay referencia completa válida. `supplierCurrentVersion` es salud mínima de la referencia, no términos vivos. GET no incrementa versión; confirmación vuelve a validar bajo locks. Un recibo conserva su diagnóstico histórico, no prueba estado actual.
- Tenant/ubicación real: `docs/multi-tenant-api.md:30–48` define Tenant = Sucursal; `src/tenants/domain/tenant.entity.ts:1–10` contiene nombre/dirección. El contexto viene del JWT (`src/shared/tenant/tenant-context.guard.ts:24–30`); Product tiene `tenantId` y `location: String?`, no una FK de almacén (`prisma/schema.prisma:523–535`). **Decisión humana aceptada:** pregunta «¿Cómo necesitás identificar el destino de una orden de compra en esta primera entrega?», opción exacta «Sucursal activa + detalle opcional (recomendado)», descripción «La compra corresponde a la sucursal donde trabajás; podés agregar una indicación interna sin crear almacenes separados.». Ubicación = sucursal autenticada del contexto + detalle textual opcional, también al confirmar. El servidor captura el snapshot; el body no elige tenant. No almacén/bin independiente, ID de otro tenant ni traslado; no inventar `locationId` ni reutilizar `Product.location` como catálogo.
- Elegibilidad observada, no regla de compras: Product usa `type`, `useStock`, `useLotsAndExpirations`, `hasVariants` y `unit`; Variant pertenece a Product (`prisma/schema.prisma:523–580,864–899`). No hay campos Product/Variant `archived` o `inventoryMode` en esos modelos; publicación/POS no equivalen a archivo. `src/products/products.service.ts:909–945,969–995,1225–1233` permite cambios de tipo/unidad/configuración y primera variante altera el padre. No mapear un `inventoryMode` FE como campo existente. La decisión humana ya excluye SERVICE; useStock=false no excluye PRODUCT físico. Validar las referencias nuevas/presentes en servidor además del filtro de selector, sin borrar borradores previos ni revalidar elegibilidad durante replay aplicado.
- Primera ejecución de save valida referencias nuevas/cambiadas y baseline retenido; confirmación exige referencias actuales válidas. Propuesta: `expectedReferenceToken` toma el token del GET/último save revisado por FE; servidor vuelve a calcularlo bajo locks. FE conserva expectedVersion, supplierCurrentVersion y referenceToken de una misma lectura explícita de la orden guardada. Un nuevo GET o ELIGIBILITY_CHANGED no refresca CAS/token ni confirma automáticamente: muestra cambios y requiere nueva confirmación deliberada. Read model/replay histórico no autoriza confirmar ni sustituye validation actual de GET. Tabla de token: actual null por incompletitud/invalidez → `409 ORDER_NOT_READY`, aunque antes fuera válido; actual no-null con esperado null/distinto → `409 ELIGIBILITY_CHANGED`; ambos iguales no-null → continuar validación de completitud (costo ausente todavía ORDER_NOT_READY). Nunca éxito por null===null; preservar buffer, sin conversión ni selección automática. Versión esperada de proveedor null en referencia completa → SUPPLIER_VERSION_CONFLICT; con proveedor ausente → ORDER_NOT_READY. El fingerprint por sí solo no evita TOCTOU: leer, comparar y confirmar requieren una frontera transaccional coherente y locks compatibles con los writers Product/Variant existentes, verificados antes de implementar. No se afirma que ese protocolo exista para O3; §4 concreta la propuesta de locks y su evidencia limitada. PRODUCT físico con o sin useStock ya es elegible; SERVICE no. La recuperación técnica conserva baseline/diagnósticos como arriba; no eliminar ni cancelar órdenes por inferencia. Archivo ya decidido: bloquear nueva selección y confirmación hasta reactivación autorizada, no bloquear conservar el mismo proveedor en borrador.

### Selectores mínimos: existente frente a nuevo

- **Existente:** `GET /products?search=…&page=1&limit=20` con `read:Product`; `search` nombre/SKU/barcode, usar `type=PRODUCT` según alcance físico aceptado, sin filtro que exija useStock=true; sin inventar `archived`/`inventoryMode` como filtros. Respuesta actual es array, no `Page`; variantes del producto elegido: `GET /products/:id/variants`, también `read:Product`. Evidencia: `src/products/dto/list-products-query.dto.ts:28–71`, controller:58–67,101–105, service:616–694,1242–1268; tenant aplicado por `src/shared/prisma/tenant-prisma.factory.ts:32–72`. Consultar variantes solo al elegir producto, no para reconstruir todas las órdenes.
- **Nuevo propuesto:** selector de proveedores usa search/status de §2 y `read:ProcurementSupplier`; no se encontró API de proveedor en las consultas acotadas previas. Sin búsqueda avanzada adicional. No usar `GET /admin/tenants` como selector ordinario de almacenes: exige `read:Tenant` y además super-admin en servicio (`src/tenants/tenants.controller.ts:40–44`, `src/tenants/tenants.service.ts:26–40`).

### Estados propuestos

| Desde | Comando | Hasta | Límite |
| --- | --- | --- | --- |
| Nuevo | Crear | `DRAFT` | Solo intención |
| `DRAFT` | Reemplazar borrador | `DRAFT` | CAS, sin efectos externos |
| `DRAFT` | Confirmar | `CONFIRMED` | Fija snapshot propuesto; no envía al proveedor |
| `DRAFT` / `CONFIRMED` | Cancelar | `CANCELLED` | Solo cierre documental |

`CONFIRMED` no admite edición; `CANCELLED` es terminal. No hay estado recibido/pagado ni reapertura. Repetir transición con otra clave no equivale a replay: estado no elegible → 409. Estas etiquetas y transiciones son propuestas técnicas para O3, no cambio de reglas comerciales aceptadas.

## 3. RBAC propuesto y autoridad existente

Convención existente: pares acción/sujeto y códigos `action:subject` (`src/auth/authorization/domain/permission.ts:17–74`; `docs/RBAC.md`, §2/§8). Por ejemplo, hoy se exige `update:Product` para editar producto/variante/lote (`src/products/products.controller.ts:70–80,108–119,193–213`). Eso **no** concede compras.

| Operación O3 | Nuevos permisos propuestos, NO existentes |
| --- | --- |
| Leer/listar proveedor | `read:ProcurementSupplier` |
| Crear proveedor | `create:ProcurementSupplier` |
| Editar/archivar/reactivar proveedor | `read:ProcurementSupplier` + `update:ProcurementSupplier` |
| Leer/listar orden | `read:ProcurementPurchaseOrder` |
| Crear orden | `create:ProcurementPurchaseOrder` + `read:ProcurementSupplier` + `read:Product` |
| Reemplazar borrador | `read:ProcurementPurchaseOrder` + `update:ProcurementPurchaseOrder` + `read:ProcurementSupplier` + `read:Product` |
| Confirmar | `read:ProcurementPurchaseOrder` + `read:ProcurementSupplier` + `read:Product` + `create:ProcurementOrderConfirmation` |
| Cancelar | `read:ProcurementPurchaseOrder` + `create:ProcurementOrderCancellation` |

Convención verificada: `RequirePermissions` + `PermissionsGuard` reconstruye CASL por principal/tenant (`src/auth/authorization/guards/permissions.guard.ts:64–104`); no reemplaza la comprobación transaccional de membresía/autoridad vigente ni valida referencias O3. Los sujetos separados permiten confirmar/cancelar sin editar; nombres nuevos a registrar solo tras aprobación. Asignación configurable, no concesión automática por roles llamados «comprador» o «administrador». No se copia la excepción editorial de permisos ni se redefine aquí `manage:all`; su tratamiento debe respetar la infraestructura RBAC vigente. Leer orden/listado/snapshots exige solo `read:ProcurementPurchaseOrder`, no lecturas adicionales de proveedor/Product. Mutaciones declaran arriba sus lecturas; servidor resuelve referencias, no FE. Antes de consultar recibo se revalida principal actual, tenant, membresía activa y permisos del comando; **no elegibilidad actual de referencias** para replay. Sin otro aprobador obligatorio; la clave sigue ligada al actor original, otro actor no recibe su replay.

## 4. CAS, idempotencia, errores y recuperación propuestos

- Todas las mutaciones requieren una sola cabecera `Idempotency-Key`, 1–200 caracteres, conservada sin trim; GET no la requiere. Respuestas `Cache-Control: no-store`.
- CAS de orden/proveedor por `expectedVersion`; alta inicia versión 1. Cada mutación exitosa incrementa una vez, nunca reutiliza versión. Confirmar compara además `expectedSupplierVersion` para no congelar términos cambiados mientras FE revisaba.
- **Protocolo transaccional propuesto, no helper O3 existente:** autoridad actual → transacción propia ReadCommitted → `lockCatalogLifecycle(tx, 'shared')` → Tenant tenant-scope `FOR SHARE` → gate idempotente transaccional → recibo. Revalidar autoridad actual dentro de esa frontera antes de entregar recibo; replay termina ahí, sin locks/validación de proveedor, orden DRAFT o referencias actuales. Gate propuesto: `pg_try_advisory_xact_lock` con hash estable del namespace completo y prefijo O3; ocupado → IN_FLIGHT. Colisiones solo causan contención conservadora, nunca identidad de recibo: unicidad y hash/body se comparan por namespace completo. No es infraestructura implementada ni lock permanente.
- **Solo primera aplicación save/confirm:** tras gate/recibo, lock orden `FOR UPDATE` (alta crea cabecera nueva) → proveedores implicados por ID ascendente `FOR UPDATE` → todos los Product referidos por ID ascendente `FOR UPDATE` → Variant por `(productId,id)` ascendente `FOR SHARE`, siempre tenant/padre calificados. Bloquear también referencias retenidas disponibles, después leer/comparar; fila faltante no se inventa ni se bloquea como existente. Releer borrador/CAS tras lock; CAS orden primero, estado DRAFT, si no hay proveedor al confirmar → ORDER_NOT_READY/SUPPLIER_REQUIRED, sin conflicto de versión inventado; si hay proveedor completo → CAS proveedor (esperado null da SUPPLIER_VERSION_CONFLICT), luego archivo; token actual null → ORDER_NOT_READY, actual no-null esperado null/distinto → ELIGIBILITY_CHANGED, y finalmente completitud restante. PATCH proveedor toma lifecycle/Tenant/gate/proveedor, **no** bloquea órdenes referenciantes; cancel solo lifecycle/Tenant/gate/orden y su transición, sin validar actividad/refs ni requerir permisos de catálogos. Save/confirm no toma locks al revés. Token actual válido y esperado desactualizado → ELIGIBILITY_CHANGED; token actual null → ORDER_NOT_READY. GET+reconciliación explícita, nunca adoptar nueva unidad/variante automáticamente.
- **Frontera de commit:** cambios proveedor/orden/snapshots, versión+1, auditoría documental actor/comando/fecha y recibo con HTTP/body original van en la misma transacción; cualquier fallo antes de commit revierte todo. CAS fallido/rechazo no crea nuevo baseline, snapshot, auditoría de éxito ni recibo aplicado. Retener IDs históricos sin FK que cascadee o impida eliminar producto operativo es requisito del almacenamiento O3 propuesto, no cambio de FK existente. No publicar outbox de stock/pago/CxP. Si no se sabe si hubo commit, recuperar con misma clave/body, no repetir intención nueva.
- Orden del comando: (1) validar identidad/contexto/autoridad actual y forma de clave/body; (2) buscar recibo tenant+actor+operación+ID objetivo (o colección en alta)+clave y comparar hash canónico del body completo, incluido CAS; (3) si ya aplicado, devolver **HTTP original (201/200) y body original**; (4) solo sin recibo aplicado, validar CAS/estado/referencias/proveedor y ejecutar atómicamente. Clave/body distintos → 409. Replay no exige proveedor aún activo, su versión actual, variante elegible ni estado `DRAFT`; no se rechaza por cambios posteriores a la aplicación.
- Recibo histórico no es estado actual: no restaura versión ni ejecuta efectos. Tras ack aplicado, GET refresca estado; si GET falla, conservar ack y mostrar «aplicado; actualización de lectura pendiente», **no fallo de guardado** ni volver a crear. No sobrescribir versión más reciente con replay histórico.
- `IDEMPOTENCY_KEY_IN_FLIGHT`/timeout: mostrar resultado pendiente y ofrecer recuperación explícita con la misma clave/body; sin autosend ni retries automáticos por defecto. GET puede ayudar a leer estado, pero no prueba qué comando se aplicó. Mientras una recuperación esté en curso, impedir disparos duplicados desde la misma UI. No prometer finalización ni espera infinita. No se propone una clave durable abandonada: el gate transaccional termina con la transacción. Si el resultado del commit es incierto, recuperar con el recibo durable y la misma clave/body; no inferir rollback por timeout ni prometer un plazo de resolución.
- `ORDER_VERSION_CONFLICT`: conservar buffer, GET orden, comparar y reconciliar deliberadamente; `SUPPLIER_VERSION_CONFLICT`: conservar buffer del proveedor u orden, GET proveedor y revisar términos/estado, además de orden si corresponde. Nunca refrescar CAS y reenviar/confirmar automáticamente. Nueva clave solo para intención reconciliada distinta, no para incertidumbre de transporte.
- Registro durable sin caducidad automática es recomendación contractual, no garantía actual. Propuesta sin fila IN_FLIGHT permanente: gate solo durante tx; contención/timeout de lock → IN_FLIGHT recuperable manualmente con misma clave/body; no lease, expiración o liberación administrativa prometidos. Retención/timeout efectivos deben verificarse antes de implementar. No inferir aplicación solo por 500/timeout.
- **Evidencia existente vs infraestructura nueva:** `lockCatalogLifecycle` exige preceder Tenant/Product/child (`src/catalog-editorial/infrastructure/prisma-catalog-lifecycle-gate.ts:3–17`); Product.update sigue lifecycle→Tenant SHARE→Product UPDATE (PS:803–821), add/update/remove Variant toman padre UPDATE antes de hijo (PS:1159–1173,1273–1296,1412–1441). PR:430–468 ordena Product por ID antes de variantes en cobros; O3 no llama helpers de stock. `TenantPrismaService.runInTransaction` soporta ReadCommitted explícito y rechaza aislamiento explícito dentro de tx ambiente (`src/shared/prisma/tenant-prisma.service.ts:84–137`): propuesta O3 dueña de tx, sin unirse silenciosamente a ambiente.
- Recibo editorial atómico y autoridad previa existen en `src/catalog-editorial/infrastructure/prisma-editorial-save-writer.ts:34–78,190–203`, pero su replay conserva/revalida referencias editoriales; **no copiar esa política a O3**. `acquireChargeIdempotency`/`markChargeIdempotencySucceeded` son específicos de ventas (`src/sales/infrastructure/prisma-sale.repository.ts:2260–2292`), no servicio O3 genérico ni garantía de recuperación. Namespace/gate/recibo/auditoría/diagnósticos/token O3 son infraestructura nueva propuesta.
- **Límite de evidencia:** no se verificó cobertura total de escritores ni compatibilidad de todo grafo de locks. Es brecha de análisis técnico antes de implementar, no nueva decisión de negocio ni autorización para modificar writers; Product.delete directo en PR:210–213 adquiere locks implícitos SQL, no el helper lifecycle. Pruebas de concurrencia/rollback/retención/timeouts de §5 son evidencia de implementación pendiente. No se garantiza ausencia de deadlocks: fallo detectado revierte y se recupera manualmente, nunca éxito parcial.

Envelope propuesto exacto `{ statusCode: number, error: string }`, sin driver ni datos ajenos; diagnósticos solo en `PurchaseOrder.validation`, no campos de error tácitos. Convención de envelope/no-store verificada en `src/catalog-editorial/http/editorial-http.filter.ts:6–39`, no reutilización del filtro: sus códigos/header editorial no son los de O3. UUID inválido/query/body extra/cabecera duplicada → 400; JWT/contexto/permiso se evalúan antes de exponer existencia. Rutas nuevas de §2 no reutilizan ventas ni permisos editoriales.

| HTTP / error propuesto | Caso |
| --- | --- |
| `400 MALFORMED` | UUID/body/header/cursor inválido, campo extra o referencia nueva incompatible del mismo tenant |
| `401 UNAUTHORIZED` | Autenticación ausente/inválida |
| `403 FORBIDDEN` | Sin permiso o membresía activa |
| `404 NOT_FOUND` | Recurso raíz o referencia nueva no disponible en tenant, incluido ID ajeno; retenida ausente usa diagnóstico, sin oráculo de existencia |
| `409 ORDER_VERSION_CONFLICT` | `expectedVersion` de orden desactualizado |
| `409 SUPPLIER_VERSION_CONFLICT` | CAS de PATCH proveedor o `expectedSupplierVersion` de confirmación desactualizado |
| `409 ELIGIBILITY_CHANGED` | Token actual no-null y esperado null/distinto; revisión explícita |
| `409 SUPPLIER_ARCHIVED` | Nueva selección o confirmación con archivado; conservar mismo proveedor en save sí se permite |
| `409 ORDER_NOT_READY` | Confirmación incompleta/referencias retenidas inválidas; GET muestra issues actuales |
| `409 STATE_CONFLICT` | Transición/edición no elegible |
| `409 IDEMPOTENCY_KEY_CONFLICT` | Misma clave, distinto body |
| `409 IDEMPOTENCY_KEY_IN_FLIGHT` | Comando todavía en curso |
| `500 INTERNAL_ERROR` | Fallo inesperado; no declarar éxito parcial |

## 5. Matriz de aceptación observable — pruebas futuras, NO ejecutadas

**Invariante en todas las filas:** CERO stock/reservas/diario de inventario/costos catálogo/valuación, CERO pagos/caja, CERO deuda/CxP ni eventos/envíos que los produzcan. Solo proveedor/orden/snapshots/auditoría documental/recibo propuestos; fiscalidad declarativa sin cálculo. `CONFIRMED` no significa recibido/pagado ni cantidad disponible.

| Caso futuro | Resultado observable exigido |
| --- | --- |
| Guardar sin proveedor/líneas; costo parcial antes de elegir producto | 201/200 DRAFT, nulls/textos/importes conservados; canConfirm=false con issues exactos, sin completar por defecto |
| Confirmar costo parcial o cantidad/proveedor/variante pendientes con CAS/token observados | 409 ORDER_NOT_READY; GET señala cada campo faltante; ninguna escritura aplicada |
| Costo explícito '0', moneda/base completas y unidad de caja; detalle ubicación null | Confirmación válida si demás datos válidos; cero distinto de ausencia, sin conversión ni cálculo fiscal; tenant del JWT |
| PRODUCT con useStock true/false; SERVICE nuevo o variante de otro padre | Físicos admitidos; selección SERVICE/incompatible 400, referencia nueva ajena/inexistente 404, sin escritura |
| Referencia válida eliminada/cambia a SERVICE o unidad antes de confirmar | GET conserva IDs/labels/unidad previos con issues; confirmación bloqueada, sin reinterpretar costo |
| Editar nota/cantidad/costo compatible de línea invalidada retenida | Save 200 conserva identidad/diagnóstico; sustituir referencia exige selección válida y nuevo lineId; excepción no copiable a línea nueva |
| Body rechazado o CAS fallido seguido de intento de conservación | Rechazo no crea baseline; no conserva referencia que solo apareció en petición rechazada |
| Tenant ajeno/permisos revocados antes de replay | 404 sin oráculo o 403/401 según autoridad; no entrega recibo/datos ajenos ni escribe |
| CAS orden/proveedor obsoleto, token de referencias obsoleto | Códigos diferenciados de §4; buffer FE intacto, no CAS refresh/resubmit automático |
| Misma clave/body concurrente, o misma clave/body distinto | A lo sumo una aplicación; otra recuperación recibe original o IN_FLIGHT, distinto body 409; rollback no deja éxito parcial |
| Cambio Product/Variant o archivo proveedor concurrente con confirmación | Observación serializada coherente: confirmar contra estado válido observado o conflicto; no TOCTOU, no mezcla de unidades ni doble transición |
| Archivo tras elegir proveedor; mismo proveedor retenido en save | Orden/historial intactos, save permitido con SUPPLIER_ARCHIVED en issues; nueva selección y confirmación con CAS vigente 409 SUPPLIER_ARCHIVED (CAS obsoleto → SUPPLIER_VERSION_CONFLICT primero) |
| Reactivación sin permiso/CAS; reactivación autorizada | 403/conflicto sin cambio; con permiso+CAS proveedor ACTIVE, luego confirmación explícita con versión/token actuales |
| Renombrar/archivar después de confirmar; replay aplicado | GET conserva historia; replay HTTP/body originales pese a archivo/estado posterior, sin revalidar elegibilidad ni efectos |
| Timeout/IN_FLIGHT o GET falla tras ack | Recuperación manual misma clave/body, sin autosend; ack aplicado conservado si falla lectura, no «guardado fallido» |

**RED:** excepción: documentación pasiva, sin comportamiento ejecutable que hacer fallar. No se ejecutaron pruebas de negocio ni se afirma evidencia runtime.

## 6. O1 — matriz estática acotada de escritores y bypasses

Leyenda: PS = `src/products/products.service.ts`; PR = `src/products/infrastructure/prisma-product.repository.ts`; SS = `src/sales/sales.service.ts`. Las referencias son archivo:línea del árbol inspeccionado. «Bypass» significa camino alterno al futuro diario O1, no explotación demostrada. Atomicidad descrita por código, no prueba runtime.

| Escritor / evidencia | Autoridad y tenant observados | Atomicidad observada | Bypass / brecha O1 |
| --- | --- | --- | --- |
| Alta Product y variantes/lotes inline: PS:403–440,468–511 | `create:Product` en controller:51–56; tenantId explícito en altas | Bloque `tx` de creación; cantidades iniciales directas | No acredita apertura/procedencia de saldo ni diario común |
| PATCH Product: PS:803–821,994,1094; PR:104–143 | `update:Product`; lock Product con tenant; repositorio usa cliente tenant | Transacción ambiente + upsert; lock padre | Asigna cantidad absoluta; incluso save de agregado persiste cantidad. CAS/procedencia de ajuste no acreditados |
| Alta/PATCH Variant: PS:1159–1195,1225–1233,1273–1275,1341–1371 | `update:Product`; PATCH califica id/productId/tenantId | Transacción y gates del padre; `tx.variant.update` | Cantidad inicial/absoluta sin movimiento O1; primera variante pone cantidad del padre en 0; rearm no es auditoría |
| Borrado Variant: PS:1412–1441 | `delete:Product` en controller:122–133; tenant/padre explícitos | Tx y lock del padre, delete calificado | Elimina fila con cantidad; no demuestra reverso de diario O1 |
| Alta Lot: PS:1721–1772 | `update:Product`; padre leído por repo tenant; tenantId en create; rechaza variantes en 1742–1747 | Lectura/duplicado/create separados en método | Cantidad directa; sin recepción/apertura auditada; compatibilidad variante-lote pendiente |
| PATCH/borrado Lot: PS:1784–1814 | `update:Product`; Prisma base, busca id/productId; sin chequeo explícito tenant/padre autorizado en método | Lectura y update/delete separados; update por lotId | Revisar ownership padre/tenant y coordinación; preocupación estática, no prueba de exploit. Borrar lote elimina saldo sin reverso O1 demostrado |
| Cobro POS → decremento: SS:2861,3126; PR:286–425,430–468 | `update:Sale` en `src/sales/sales.controller.ts:263–277`; UPDATE con tenant y vínculo variante/padre | Exige tx ambiente; locks ordenados, decremento condicional, flip/outbox juntos | Outbox de alerta no es diario de inventario; no cubre apertura ni todos los writers |
| Confirmación bot → mismo decremento: SS:3608,3650,3830 | Entrada checkout con ServiceAuthGuard y scopes `customers:write`, `sales:create` en `src/chatbot-api/presentation/checkout.controller.ts:121–125`; SQL tenant en PR | `saleRepo.runInTransaction`; mismo writer de decremento | Revisar además otros adaptadores y propagación de tenant; no asumir cobertura universal por compartir helper |
| Cancelación Sale/restock: SS:3251–3338; PR:534–637 | `delete:Sale` en `src/sales/sales-query.controller.ts:134–142`; venta tenant-scope; restock SQL califica tenant/padre | Idempotencia de cancelación + tx; locks ordenados y rearm | Reposición Product/Variant, no lote de origen; no establece política futura de reversos/valuación |
| Compatibilidad `decreaseStock`/`increaseStock`: PS:2127–2140; PR:104–143 | Lectura repo tenant; helper sin permiso propio, depende del llamador | Lectura-modificación-save; save transaccional, sin lock/CAS cubriendo lectura en helper | Bypass de decremento condicional/outbox; riesgo de concurrencia a verificar |
| Venta cliente `/orders`: `src/orders/orders.service.ts:45–107`; cancel listener `src/orders/listeners/order-event.listener.ts:38–47` | Controller:20–21 JWT/tenant, sin PermissionsGuard visible; helper tenant depende de contexto, incluido listener | Bucle decrementa antes de guardar orden; reposición por evento separado; no tx conjunta visible | Auditar atomicidad, autoridad y contexto del evento; no reutilizar como compras |

Cobertura: lectura estática de estos caminos y consultas CodeGraph de `Supplier`, `PurchaseOrder`, `StockJournal` sin resultados, más callers de decrement/restock/compatibilidad. No se afirma ausencia universal de compras/diario ni inventario exhaustivo de importadores, jobs, SQL, borrados, triggers u otros adaptadores. No se ejecutaron servicios, DB, tests ni checkout. Antes de O1 se necesita completar inventario de writers y evidencia negativa contra bypasses.

## 7. Brechas preservadas y coordinación editorial separada

- G3: autoridad única de stock, procedencia de apertura, compatibilidad/bypass y ownership padre-lote. O1 debe cerrar cobertura, no solo añadir otro writer.
- G4: temporalidad, fechas desconocidas, empates, devoluciones, incidentes y sobreentrega; G5: evento de deuda/conciliación; G6: valuación; G7: fondeo. No se resuelven aquí ni bloquean O3 estrictamente intent-only.
- El texto FE «Publicación pendiente de habilitación del backend.» corresponde a **P1 editorial**, no a O3. Evidencia: `src/catalog-editorial/http/editorial-write.controller.ts:171–188` llama `core.publish`; `src/catalog-editorial/infrastructure/prisma-catalog-editorial.ts:308–340` lee definiciones versión 1 y valida contexto, mientras initialize usa el writer actual en controller:143–166. Coordinar reemplazo de esa integración; no crear segundo contrato editorial ni afirmar habilitación.
- S88, texto exacto (`odd/tasks/editorial-production-vocabulary.md:9`): "Agregar «Es solo equipamiento» con fuente, fecha y justificación. Para aplicar la excepción debe ser verdadera y conservar las justificaciones de no pertinencia de dimensiones y capacidad. Las demás validaciones siguen vigentes."
- S89, texto exacto (`odd/tasks/editorial-production-vocabulary.md:10`): "Exigir la misma magnitud conocida en cada variante ofrecida, o en la presentación única si no hay variantes. Sin agregación ni herencia. Si no hay ninguna presentación ofrecida, no dar esta comparación por cumplida: mantener el borrador sin publicar."
- Son decisiones aceptadas, no preguntas nuevas. P1 aún requiere integración y evidencia del borrador actual: admisión/R/care, autoridad y tenant, CAS/replay/rollback y conservación de operación. C3.3 sigue separado: catálogo público Published-only y elegibilidad viva de facetas públicas aguas abajo. Ni P1 ni C3.3 son prerrequisito de O3.
- Omisiones detectadas por FE en la versión anterior: activo/archivado, costo informado y ubicación explícita **no están rechazados ni pueden recortarse silenciosamente**. §2 ahora propone representaciones y señala límites de cobertura; aplazarlas requiere decisión humana de alcance. Costo informado no equivale a valuación ni deuda. O1 sigue siendo matriz estática no exhaustiva: no autoriza diario paralelo ni arreglo de ownership sin reproducción y alcance separados.

## 8. Seis decisiones de negocio cerradas; readback técnico pendiente

Cerradas, sin volver a preguntar: (1) borradores incompletos B; (2) sucursal autenticada + detalle opcional incluso al confirmar; (3) inclusión/exclusión de impuestos explícita; (4) costo completo importe/moneda/base por cada línea confirmada; (5) solo PRODUCT físico con/sin useStock, no SERVICE/gastos; (6) proveedor archivado requiere reactivación. Las cinco primeras conservan preguntas/opciones/descripciones exactas en §2.

**Sexta decisión, texto exacto:** pregunta «Si se archiva un proveedor que tiene órdenes en borrador, ¿qué debería ocurrir?», opción «Reactivar antes de confirmar (recomendado)», descripción «Conserva borradores e historial, pero bloquea nuevas selecciones y confirmaciones hasta que alguien con permiso lo reactive.». No autoriza cancelación/borrado ni altera replay de operación ya aplicada. Conservar condiciones históricas por compra también permanece aceptado, no es pregunta nueva.

Readback FE de shapes/conservación/recuperación alineado (seq30); precisiones incorporadas: lectura única de revisión/CAS/token, tabla null/completitud, RFC6901 y conservación sin reinterpretación. No certifica SQL/locks ni pruebas; no es aprobación de implementación. Lista de acuerdos técnicos, no nuevas preguntas humanas:
1. ¿Coinciden DTO nullable B/ConfirmOrderInput, nulls parciales del costo, unidad declarada/capturada, `validation` con paths/códigos/token, y etiquetas históricas sin lecturas adicionales de catálogos?
2. ¿Coinciden rutas/errores/permisos de §2–§4 y conservación únicamente desde baseline guardado exitoso, distinguiendo retener mismo proveedor archivado de seleccionarlo de nuevo, sin autosaneamiento de referencias?
3. ¿Coinciden orden de autoridad/recibo/locks/CAS y recuperación manual misma clave/body, ack conservado si GET falla, más matriz futura de §5? Cobertura de writers/grafo de locks y pruebas reales son brechas técnicas explícitas, no negocio por decidir.

Síntesis técnica propuesta 1–5: representación exacta/diagnósticos; rutas/errores/RBAC; conservación segura de referencias; transacción/CAS/replay compatible con evidencia acotada; aceptación observable. Ninguna decisión comercial nueva detectada dentro de este alcance. Acordar mecanismos con FE; después alcance de implementación y evidencia separados, sin stock/pagos/CxP/publicación.
