# Guía de datos de demostración (dev)

Esta guía te dice **qué dato de ejemplo mirar y con qué usuario** para ver cómo funciona cada feature, sin crear roles, usuarios ni datos a mano. Todo lo que aparece acá sale del seed base (`prisma/seed.ts`) y del seed de demostración (`scripts/dev-showcase/`). Cuando una feature no tiene datos sembrados, lo dice: «no hay datos de ejemplo».

Solo para bases locales o de desarrollo. Los detalles técnicos de cada módulo están en el [README › Demo data (dev showcase)](../README.md#demo-data-dev-showcase).

## 1. Cómo (re)crear los datos

```bash
pnpm prisma migrate deploy   # base migrada
pnpm seed                    # seed base: sucursales, usuarios, productos, empleados
pnpm build                   # el showcase usa la API real desde dist/
pnpm seed:showcase           # datos de demostración; se puede correr de nuevo
```

- `pnpm seed:showcase` levanta su propia API en un puerto libre (no usa la del `:3003`) y corre los módulos en orden: `org` → `catalog` → `commerce` → `ops` → `shipping` → `address-status`. Al terminar imprime un resumen JSON por módulo.
- Es idempotente: una segunda corrida no crea nada nuevo y no borra lo que editaste desde el frontend. Las fechas son relativas a hoy, así que una corrida otro día mueve la historia hacia adelante.
- Se niega a correr con `NODE_ENV=production` o contra una base que no sea local (`localhost`, `127.0.0.1`, `::1`, `postgres`, `db`). `SHOWCASE_ALLOW=1` solo para una base remota descartable.
- Para mirar los datos, levantá el servidor de desarrollo (en dev usamos el puerto `:3003`) y entrá con los usuarios de la sección 2.
- Casi todo vive en **Sucursal Centro** (slug `centro`).

## 2. Usuarios por rol y sucursal

En desarrollo (`NODE_ENV=development`) el login no pide el código OTP por correo.

| Email | Contraseña | Sucursal | Rol | Qué puede hacer |
| --- | --- | --- | --- | --- |
| `admin@houndfe.com` | `Admin123!` | Centro, Norte y Sur | Super Admin | Todo; cambia de sucursal. |
| `manager@houndfe.com` | `Manager123!` | Centro | Manager (Gerente) | Inventario, compras, rutas, cotizaciones, promociones, supervisión de caja, zonas y ajustes de envío, decisiones humanas. Es el usuario con el que el showcase crea casi todo. |
| `cashier@houndfe.com` | `Cashier123!` | Centro | Cashier (Cajero) | Ventas en POS, sesiones de caja, cobros y entregas de custodia. |
| `repartidor@houndfe.com` | `Demo123!` | Centro | repartidor | Solo lee y actualiza rutas de entrega (no las crea ni las borra). |
| `vendedor@houndfe.com` | `Demo123!` | Centro | Vendedor | Solo lectura de catálogo, clientes y ventas; **sin permisos de inventario** (las pantallas de inventario responden 403). |
| `gerente.norte@houndfe.com` | `Demo123!` | Norte | Manager | Una segunda sucursal. |
| `cajero.norte@houndfe.com` | `Demo123!` | Norte | Cashier | Una segunda sucursal. |

Sucursal Sur solo tiene al super admin.

**De dónde salen las contraseñas y cuál gana.** No hay ningún email repetido entre los dos seeds, así que nunca compiten por el mismo usuario:

- `admin`, `manager` y `cashier` vienen de `prisma/seed.ts`. **`pnpm seed` vuelve a escribir su contraseña en cada corrida** (upsert), así que para ellos siempre gana la de `prisma/seed.ts`. El showcase no los toca.
- Los otros cuatro los crea el módulo `org` con `SHOWCASE_DEMO_PASSWORD` o, si no está definida, `Demo123!` (`scripts/dev-showcase/org.cjs`). Un usuario que ya existe **conserva** su contraseña; para volver a ponerle la de demo: `SHOWCASE_RESET_PASSWORDS=1 pnpm seed:showcase` (el resumen lista los emails, nunca la contraseña).

## 3. Qué querés ver → con qué usuario → dónde → qué deberías observar

Los endpoints son de la API; la pantalla del frontend que los consume es la de la misma sección.

| Qué querés ver | Usuario | Dónde / dato de ejemplo | Qué deberías observar |
| --- | --- | --- | --- |
| Catálogo | `manager` | `GET /products`. 38 productos de `catalog`; el de kardex es «Alimento Premium para Perro Adulto 15 kg». | Stock alto, bajo y en 0; lotes vencidos, por vencer en menos de 7 días y vigentes; variantes (una en 0); productos sin control de stock; servicios; con y sin imagen; un nombre de 98 caracteres; 8 categorías y 4 listas de precios. |
| Catálogo público | sin login | `GET /public/catalog/centro/products` | El catálogo de Centro está publicado (lista por defecto y, si existe, «Mayoreo»), con los estados «Disponible», «Pocas piezas» y «Agotado». |
| POS y ventas | `cashier` / `manager` | `GET /sales`. ~57 ventas de los últimos 28 días (`commerce`). | Pago en efectivo, tarjeta, transferencia y mixto; crédito, parcial y vencido; canceladas con reembolsos pendientes y parcialmente liquidados; entregadas y pendientes de entrega; «Público en general». |
| Caja: sesiones y cierre | `cashier` (operar), `manager` (supervisar) | `GET /cash-registers`, `GET /cash-sessions`, `GET /cash-handovers`. Cajas «Caja Principal», «Caja Mostrador 2», «Caja Express» (activas), «Caja Bodega (en desuso)» y «Caja Reparto foráneo» (inactivas). | Una sesión abierta hoy en Caja Principal; sesiones cerradas (Mostrador 2 hace 12 días con faltante, hace 4 días cuadrada; Principal hace 8 días; Bodega hace 21 días); Caja Express con corte enviado y entrega de custodia pendiente. |
| Promociones (POS) | `manager` | `GET /promotions`. 12 promociones de `commerce`, p. ej. «Semana de la mascota: 15% de descuento», «Compra $1,500 y ahorra $150», «Llévate 3 y paga 2 en alimento húmedo». | Cada tipo (PRODUCT_DISCOUNT, ORDER_DISCOUNT, BUY_X_GET_Y, ADVANCED) activa, programada y terminada; automáticas y manuales; una solo para clientes registrados; dos con tope de unidades (una casi agotada). |
| Promociones del bot (`botEligible`), días de la semana | — | **No hay datos de ejemplo.** El seed no marca ninguna promoción como `botEligible` ni carga días de la semana; las vigencias son solo `startDate`/`endDate`. | Para probarlo, marcá una promoción como apta para el bot desde el frontend. |
| `PROMO_RE_QUOTE` | — | **No hay datos de ejemplo.** Es la respuesta `409` del checkout del bot cuando el `expectedTotalCents` enviado no coincide con el total que recalcula el servidor (`src/chatbot-api/application/chatbot-api.service.ts`). Se reproduce llamando al checkout con la credencial del bot. | El cuerpo trae los totales para que el bot vuelva a cotizar. |
| Clientes y direcciones | `manager` | `GET /customers`, `GET /customers/:id/addresses`. 20 clientes de `commerce` (p. ej. «Ana Sofía Ramírez Lozano») y 8 de entregas de `ops`. | Varias direcciones, saldos pendientes, un nombre muy largo («María Guadalupe de los Ángeles …»), una empresa con datos de facturación. |
| Aviso de dirección cambiada / eliminada (`sourceStatus`) | `manager` | Cliente «Irene Domínguez Ochoa» (`address-status`). `GET /sales?customerId=<id>` o `GET /sales/:id`. El resumen del seed imprime `address-status.sales` con el folio de cada venta. | Tres ventas a domicilio: la de «Calle Pilares 415» muestra `sourceStatus: "UNCHANGED"`; la de «Calle Xola 1220» `CHANGED` con `changedFields: ["street"]` (la dirección del cliente ahora dice «Calle Uxmal», el snapshot de la venta conserva «Calle Xola»); la de «Calle Dakota 95» `DELETED` con `id: null` (la dirección se borró). El resto de las ventas a domicilio sembradas salen `UNCHANGED`. Detalle: [sale-shipping-snapshot-reads.md](sale-shipping-snapshot-reads.md). |
| Rutas de reparto | `manager` (crear), `repartidor` (operar) | `GET /delivery-routes`. Notas: «Ruta de la tarde: Narvarte y Del Valle» (DRAFT), «Ruta matutina: Roma, Condesa, Nápoles y Escandón» (ACTIVE), «Ruta de ayer: Coyoacán y Mixcoac» (COMPLETED), «Ruta cancelada: la camioneta entró a taller» (CANCELLED). Repartidor: Luis Hernández. | La activa tiene una parada entregada, una saltada («Nadie abrió en el domicilio; se reprograma»), la actual y pendientes. |
| Ventas elegibles para ruta | `manager` | `GET /delivery-routes/eligible-sales` | Las ventas a domicilio pendientes que no están en una ruta (p. ej. `showcase-ops:entrega-pendiente-1/2` y las tres de Irene), con su `shippingAddress` y `sourceStatus`. |
| Zonas de envío | `manager` | `GET /delivery-zones`, `GET /delivery-zones/:zipCode` (`shipping`) | FREE: 03100 (mismo día), 03020 y 03810 (1 día). SURCHARGE: 06700 ($45, 2 días), 04000 ($69, 2 días), 11000 ($89, 3 días, aprobada desde una validación). CARRIER_ONLY: 16000, 14000. DENIED: 12000. 03300 FREE pero **desactivada** (el bot la trata como CP desconocido). |
| Validaciones de zona pendientes | `manager` | `GET /delivery-zone-validations`, `GET /delivery-zone-validations/:id` | PENDING: 03900 (CRITICAL), 06600 (WARNING, 2 solicitantes) y 04510 (OK); 11000 RESOLVED. La urgencia depende de la hora del último mensaje del cliente; una corrida otro día la reajusta. Sin correo: el seed no escribe el outbox. |
| Cajas, origen, horario y empaque | `manager` | `GET /tenants/:tenantId/shipping-boxes`, `…/shipping-origin`, `…/opening-hours`, `GET /products/:id/packaging` | Cajas «Caja chica» (30×20×15 cm, 5 kg), «Caja mediana» (45×35×30 cm, 20 kg) y «Caja grande» (70×45×25 cm interior, 900 g, 40 kg). Origen Av. Insurgentes Sur 1458, 03100. Lun–vie 09:00–14:00 y 16:00–19:30, sáb 09:00–14:00, dom cerrado. Empaque en 6 productos (incluye las croquetas de 18 kg: 18000 g, 68×43×12 cm, que solo caben en la «Caja grande») y la variante «Grande» del «Arnés Acolchado para Paseo». |
| Cotizaciones Skydropx (sandbox) | credencial del bot | `POST /chatbot-api/shipping/quotes` con un CP CARRIER_ONLY (16000 o 14000) y, p. ej., las croquetas de 18 kg. Ver sección 5. | `zoneStatus: "CARRIER_ONLY"` con la opción más barata. Con 03100 sale FREE, con 06700 SURCHARGE, con 12000 DENIED y con un CP sin zona PENDING (sin llamar al transportista). Tarda ~15 s en sandbox. |
| Comprobantes de transferencia | credencial del bot | **No hay datos de ejemplo.** Los sube el bot con `POST /chatbot-api/sales/:saleId/receipts` ([transfer-receipts.md](transfer-receipts.md)). | — |
| Decisiones humanas (reposición / caducidad) | `manager` | `GET /human-decisions` (`ops`) | RESTOCK pendientes (hace 3 h y 30 h), aprobada (reposición en 5 días) y rechazada; EXPIRATION pendiente (hace 8 h), aprobada y rechazada. |
| Compras, proveedores e inventario | `manager` | `GET /procurement/suppliers`, `GET /procurement/purchase-orders`, `GET /inventory/movements` | 5 proveedores (uno archivado: «Acuarios y Peceras del Norte»); 11 órdenes de compra con 0, 1, 2 y 4 avisos, confirmadas y canceladas; el kardex del producto de 15 kg con más de 30 movimientos. |
| Notificaciones y correos | `manager` / `admin` | `GET /notification-config` | Activadas para `manager` y `admin`, con LOW_STOCK, TIME_OFF_REQUESTED, DELIVERY_NEXT_STOP y PROMOTION_EXPIRING encendidas; PROMOTION_NEAR_CAPACITY y DELIVERY_THANK_YOU apagadas. **No hay correos de ejemplo:** el seed configura esto al final para no enviar ninguno. |
| Editorial de catálogo | `admin` | **No hay datos de ejemplo.** El seed no escribe documentos editoriales. Cuatro productos de Centro tienen documentos viejos (pre-V2) que se reparan con `editorial-repair.cjs` (ver README). | — |

## 4. Credencial del bot (chatbot)

- El bot se autentica con `Authorization: Bearer svc_…` en las rutas `/chatbot-api/*`. El token debe empezar con `svc_`.
- En la base **solo se guarda el hash**: `service_credentials.hashedKey` es el SHA-256 en hex del token (`ServiceAuthGuard`). El token en claro no se puede recuperar desde la base; si se pierde, se rota.
- Cada credencial pertenece a una sucursal (`tenantId`) y tiene `scopes` exactos (sin comodines): `catalog:read`, `customers:read`, `customers:write`, `sales:create`, `sales:read`, `sales:write`, `pricing:evaluate`, `payment-details:read`, `human-decisions:create`, `human-decisions:read`, `human-decisions:ack`, `shipping:quote`. Una cabecera `x-branch-id` distinta de su sucursal da 403. Tiene límite de peticiones por minuto (`rateLimit`, 60 por defecto).
- El seed **no crea** credenciales. En dev hay una creada a mano para las pruebas E2E del bot.

**Rotarla sin imprimir el token:**

```bash
# 1. Ver qué haría (no escribe nada)
node scripts/dev-showcase/rotate-bot-credential.cjs --name "<nombre de la credencial>"
# 2. Rotar
node scripts/dev-showcase/rotate-bot-credential.cjs --name "<nombre de la credencial>" --apply
```

- Crea una credencial nueva con los mismos scopes y límite, llamada `<nombre> (rotada AAAA-MM-DD)`, y revoca la anterior (`isActive: false`, `revokedAt`) en la misma transacción.
- Escribe el token nuevo en `.tmp/chatbot-service-token` con permisos `0600` (`.tmp/` está en `.gitignore`). Por consola solo muestra nombres, ids, scopes y la ruta del archivo.
- Opciones: `--tenant <slug>` (por defecto `centro`) y `--out <archivo>`. Tiene la misma protección de base local que el showcase.
- Después copiá el token del archivo a la configuración del bot sin pegarlo en chats ni commits, y borrá el archivo cuando ya no lo necesites.

## 5. Skydropx en sandbox

- Solo las zonas CARRIER_ONLY llaman al transportista; FREE, SURCHARGE, DENIED y PENDING no.
- Para que una cotización CARRIER_ONLY se pueda empacar hace falta empaque en los productos, una caja donde quepan y el origen de la sucursal. El seed deja las tres cosas (sección 3).
- Credenciales: `SKYDROPX_CLIENT_ID` y `SKYDROPX_CLIENT_SECRET` en el `.env` del backend (nunca en esta guía ni en commits), y `SKYDROPX_BASE_URL=https://sb-pro.skydropx.com` para sandbox.
- El sandbox tarda **~15 s** en completar una cotización, más que los valores por defecto (`SKYDROPX_QUOTE_DEADLINE_MS=12000`, `SHIPPING_CARRIER_TIMEOUT_MS=15000`). En dev usá:

  ```bash
  SKYDROPX_QUOTE_DEADLINE_MS=30000
  SHIPPING_CARRIER_TIMEOUT_MS=35000
  ```

  El adaptador limita el plazo a `SHIPPING_CARRIER_TIMEOUT_MS − 500`, por eso el timeout del transportista va por encima del plazo. El cliente que llama (el bot o tu `curl`) necesita un timeout mayor que `SHIPPING_CARRIER_TIMEOUT_MS`.
- Si no responde a tiempo y no hay otro transportista, la respuesta es `503 SHIPPING_QUOTE_UNAVAILABLE`. Detalle: [shipping-quotes.md](shipping-quotes.md) y [chatbot-checkout-shipping.md](chatbot-checkout-shipping.md).
