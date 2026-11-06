# Checklist del backend de producción para el lanzamiento del chatbot

Lista corta de lo que tiene que quedar listo en el backend de **producción** antes de probar el bot por WhatsApp. Nada de esto se ejecutó contra producción; cada paso lo corre el dueño.

Antes de empezar: el código de producción sale de GitHub `main` (Dokploy construye desde ahí). Hacé `git push origin main` desde el backend local; hoy el `main` local tiene commits que no están en GitHub.

## 1. Migraciones

El contenedor corre `npx prisma migrate deploy` solo al arrancar (`docker-entrypoint.sh`). No hay un paso aparte. Lo que sí hay que hacer **antes** del deploy:

1. **Backup de la base de producción.** Es la única vuelta atrás completa.
2. **Revisá la migración de inventario `20261104020000_inventory_journal_storage`.** Escribe datos (sube cantidades y crea movimientos `OPENING`) y falla si hay stock negativo. Seguí [inventory-journal-o1-rollout.md](inventory-journal-o1-rollout.md):
   - corré las consultas de pre-flight y resolvé cada fila;
   - durante el deploy no puede haber ventas ni cambios de stock: apagá el chatbot y no uses el POS, y que no queden corriendo la versión vieja y la nueva a la vez;
   - después corré los post-checks y dá los permisos nuevos (sección «Permissions» del runbook).
3. **Teléfonos de clientes (`20261018000100_normalize_customer_phone_digits`).** Deja los teléfonos solo con dígitos y no une duplicados. Antes corré el reporte de duplicados que trae el comentario de la migración.
4. Las demás migraciones nuevas (editorial, proveedores, compras, zonas, envíos, comprobantes) son aditivas o agregan valores a enums en migraciones separadas. No necesitan nada a mano.

Después del deploy: **resincronizá Inngest Cloud** con `https://api.houndfe.com/api/inngest`, así registra las funciones nuevas (correos de validación de zona y de comprobantes, purga de comprobantes).

## 2. Variables de entorno

Revisá que estén en Dokploy. Las marcadas con ★ son nuevas para este lanzamiento.

| Variable | Valor | Para qué |
| --- | --- | --- |
| `NODE_ENV` | `production` | Obligatoria. |
| `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET` | ya existentes | Obligatorias (JWT ≥ 32 caracteres). |
| `SPACES_ENDPOINT`, `SPACES_REGION`, `SPACES_BUCKET`, `SPACES_ACCESS_KEY_ID`, `SPACES_SECRET_ACCESS_KEY`, `SPACES_PUBLIC_BASE_URL` | ya existentes | DigitalOcean Spaces. Los comprobantes usan este bucket con permiso privado. |
| ★ `RECEIPTS_SPACES_BUCKET` | opcional | Solo si querés los comprobantes en un bucket privado aparte. Si no está, usan `SPACES_BUCKET` con ACL privada. |
| `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY` | de Inngest Cloud | Obligatorias en producción. `INNGEST_DEV` no debe estar o debe ser `false`. |
| `RESEND_API_KEY`, `MAIL_FROM`, `APP_WEB_URL` | ya existentes | Obligatorias en producción; los correos del staff las usan. |
| `CORS_ORIGINS` | dominio(s) del frontend | Si queda vacía, CORS queda abierto a cualquier origen. |
| ★ `SKYDROPX_CLIENT_ID`, `SKYDROPX_CLIENT_SECRET` | credenciales **de producción** de Skydropx | Sin las dos, no se cotiza por paquetería (CARRIER_ONLY da 503). No uses las del sandbox. |
| ★ `SKYDROPX_BASE_URL` | no la pongas | Por defecto es `https://api-pro.skydropx.com` (producción). El `sb-pro` del `.env` local es el sandbox. |
| ★ `SKYDROPX_QUOTE_DEADLINE_MS` | `30000` | Skydropx tarda unos 15 s en completar una cotización; el default (12 s) la corta. |
| ★ `SHIPPING_CARRIER_TIMEOUT_MS` | `35000` | Tiene que ser mayor que el anterior. |
| `PROMOTIONS_BUSINESS_TIMEZONE` | opcional | Default `America/Mexico_City`. |
| `SHIPPING_CREDIT_PER_UNIT_CENTS`, `SHIPPING_CREDIT_UNIT_PRICE_THRESHOLD_CENTS`, `SHIPPING_CREDIT_APPLIES_TO_SURCHARGE` | opcionales | Defaults 12000 / 50000 / `true`. El último está «por confirmar» con tu cliente. |

`BOT_SHIPPING_CHARGE_MAX_CENTS` no hace falta: el chatbot ya manda el envío por `quoteId` o pickup, no por el formato viejo.

## 3. Credencial del bot (ServiceCredential con los 12 scopes)

No hay endpoint ni pantalla para crearla, y el script de rotación del showcase se niega a correr contra producción. Se crea en dos pasos y el token **nunca** pasa por producción ni se imprime: en producción solo se guarda su hash.

**Paso A, en tu máquina** (desde la raíz del backend). Genera el token, lo guarda en un archivo que solo vos podés leer e imprime solo el hash:

```sh
node -e '
const c=require("crypto"),fs=require("fs");
const t="svc_"+c.randomBytes(32).toString("base64url");
fs.mkdirSync(".tmp",{recursive:true});
fs.writeFileSync(".tmp/prod-bot-token","SERVICE_KEY="+t+"\n",{mode:0o600});
console.log(c.createHash("sha256").update(t).digest("hex"));'
```

**Paso B, en la base de producción** (psql desde Dokploy). Pegá el hash del paso A y el slug de la sucursal del bot:

```sql
INSERT INTO "service_credentials" ("id","tenantId","name","hashedKey","scopes","isActive","rateLimit","createdAt")
SELECT gen_random_uuid()::text, t."id", 'chatbot-whatsapp', '<HASH_DEL_PASO_A>',
  ARRAY['catalog:read','customers:read','customers:write','human-decisions:ack','human-decisions:create','human-decisions:read','payment-details:read','pricing:evaluate','sales:create','sales:read','sales:write','shipping:quote'],
  true, 60, now()
FROM "Tenant" t WHERE t."slug" = '<SLUG_DE_LA_SUCURSAL>';
```

Tiene que decir `INSERT 0 1`. Después copiá la línea de `.tmp/prod-bot-token` al entorno del chatbot en producción (`SERVICE_KEY`) y borrá el archivo (`rm .tmp/prod-bot-token`).

Notas:
- El bot queda atado a esa sucursal. Si manda `x-branch-id`, tiene que ser el id de esa misma sucursal; si no, da 403.
- El checkout pide un `cashierUserId`: tiene que ser un usuario **miembro de esa sucursal** en producción (si no, 404 `CASHIER_NOT_FOUND`). Pasale ese id al chatbot.
- Para revocarla: `UPDATE "service_credentials" SET "isActive"=false, "revokedAt"=now() WHERE "name"='chatbot-whatsapp';`

## 4. Datos para cotizar y cobrar

Primero dale al rol que va a cargar esto los permisos que faltan. **Los permisos de roles solo vienen en el seed, no en las migraciones**, así que en producción el Manager no los tiene. Desde Roles, o con un usuario Super Admin (`manage:all`), que ya puede hacer todo:

- `manage:DeliveryZone` y `validate:DeliveryZone` (zonas y validaciones)
- `read:ShippingSettings` y `update:ShippingSettings` (cajas, origen, horario)
- `update:Product` (empaque)
- `update:NotificationConfig` (correos)
- `update:ReceiptEvidence` (revisar comprobantes; también filtra quién recibe ese correo)
- `create:PaymentDetail` (datos de transferencia)

Después cargá, en este orden (todo con JWT de un usuario de esa sucursal):

| Qué | Endpoint | Cuerpo mínimo | ¿Hace falta? |
| --- | --- | --- | --- |
| Zonas | `PUT /delivery-zones/:zipCode` | `{"type":"FREE","etaDays":1,"state":"…","municipality":"…","neighborhood":"…"}`; SURCHARGE agrega `"surchargeCents"`; CARRIER_ONLY y DENIED van sin recargo ni ETA | Al menos una. Un CP sin zona da `PENDING` y abre una validación. |
| Origen de envío (también es la dirección de pickup) | `PUT /tenants/:tenantId/shipping-origin` | `{"addressLine1","neighborhood","municipality","state","postalCode","contactPhone"}` | Obligatorio para CARRIER_ONLY (si no, 422 `SHIPPING_ORIGIN_NOT_CONFIGURED`). Para pickup es recomendado: sin él, el bot muestra la dirección de la sucursal o ninguna. |
| Horario de la sucursal | `PUT /tenants/:tenantId/opening-hours` | `{"days":[…los 7 días con sus rangos…]}` | Recomendado: el bot lo muestra en pickup. |
| Cajas | `POST /tenants/:tenantId/shipping-boxes` | `{"name","innerLengthCm","innerWidthCm","innerHeightCm","weightG","maxContentWeightG"}` | Obligatorio para CARRIER_ONLY (si no, 422 `NO_SHIPPING_BOX_FITS`). Tiene que haber una caja donde entre el producto más grande que vendas por paquetería. |
| Empaque por producto | `PUT /products/:id/packaging` (o `/variants/:id/packaging`) | `{"weightG","lengthCm","widthCm","heightCm"}` | Obligatorio para CARRIER_ONLY, por cada producto que se envíe así (si no, 422 `PACKAGING_DATA_MISSING`). |
| Datos de transferencia | `POST /admin/payment-details` | banco, titular, CLABE… | Obligatorio para cobrar por transferencia (si no, el bot recibe 404). |

Para que un producto aparezca en el bot: `includeInOnlineCatalog = true`, que tenga precio en la lista de precios por defecto y, si tiene variantes, al menos una variante publicada (`catalogPublishMode` distinto de OFF).

Las zonas FREE y SURCHARGE funcionan solo con la zona. Pickup no necesita nada obligatorio.

## 5. Correo de validación de zona (y el de comprobantes)

Vienen apagados. Se activan con:

```http
PUT /notification-config
{
  "enabled": true,
  "recipientUserIds": ["<id del usuario que recibe>"],
  "enabledActions": ["DELIVERY_ZONE_VALIDATION_REQUESTED", "RECEIPT_REVIEW_REQUESTED"]
}
```

- **Reemplaza todo:** si ya tenías otras acciones activadas, incluilas en `enabledActions` o se apagan. Mirá antes con `GET /notification-config`.
- Los destinatarios tienen que ser usuarios de esa sucursal. Además, solo reciben el correo de zonas los que tienen `validate:DeliveryZone`, `manage:DeliveryZone` o `manage:all`; el de comprobantes, los que tienen `update:ReceiptEvidence` (o manage).
- Para que el correo salga hacen falta `RESEND_API_KEY`, `MAIL_FROM`, `APP_WEB_URL`, las claves de Inngest y Inngest Cloud resincronizado (sección 1).

## Prueba rápida después del deploy

Con el token del bot:

1. `GET /chatbot-api/catalog/search?q=<algo>` → 200 (sin token, 401).
2. `POST /chatbot-api/shipping/quotes` con un CP de una zona FREE → trae `quoteId`.
3. El mismo pedido con un CP CARRIER_ONLY → tarda unos 15 s y trae tarifas. Si da 503, revisá las variables de Skydropx.
4. Un CP sin zona → `PENDING`, y le llega el correo de validación al destinatario.
