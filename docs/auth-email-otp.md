# Activación del login con contraseña y OTP por correo

El acceso nuevo requiere **contraseña → OTP de correo → sesión**, también para
super-admin. Esta guía reemplaza el login por contraseña de
[multi-tenant-api.md](multi-tenant-api.md); la selección y el cambio de sucursal
conservan sus respuestas posteriores a la autenticación.

**Solo el dueño hace push y despliega.** Esta guía no ejecuta ni autoriza migraciones,
pruebas vivas o envíos. No hay flag de bypass OTP. La verificación local usa mocks;
no demuestra entrega en inbox ni concurrencia real de PostgreSQL.

## 1. Ruta rápida del dueño

1. Confirmar los prerrequisitos y revisar **todas** las migraciones pendientes.
2. Coordinar frontend y backend compatibles; retirar todas las réplicas anteriores.
3. Desplegar con el plan de migración y contingencia aprobado. Un fallo de migración
   impide el arranque; no intentar saltarlo para habilitar logins.
4. Ejecutar únicamente la aceptación manual mínima autorizada de la sección 7.
   La aceptación del proveedor no equivale a recepción en el inbox.

## 2. Prerrequisitos

| Área | Requisito antes de activar |
| --- | --- |
| PostgreSQL | Migración aditiva `20260926183000_login_email_otp`: desafíos y presupuestos persistentes. Preparar respaldo y revisar el conjunto de migraciones pendientes. |
| Prisma Client | Cliente generado con el esquema nuevo. El [Dockerfile](../Dockerfile) lo genera durante el build, antes de compilar. |
| Correo | `RESEND_API_KEY` válido y `MAIL_FROM` habilitado por el proveedor, en **todo `NODE_ENV`**, incluidos desarrollo y pruebas vivas. |
| Secretos | Conservar `JWT_SECRET` consistente entre todas las réplicas y la configuración existente de refresh. No se introduce otro secreto OTP ni se prescribe rotación. |
| Clientes | Frontend OTP y backend activado deben salir coordinados. Los usuarios necesitan acceso a su dirección de correo actual. |

La ruta `sensitive` del [mailer](../src/notifications/email/resend.mailer.ts)
falla cerrada si faltan proveedor o remitente; nunca usa el fallback de logs de
correos no sensibles. Que la validación Joi exija estas variables solo en producción
**no prueba** que otro entorno esté listo. No registrar códigos, HTML, contraseñas,
JWT ni secretos en tickets o evidencias. Confirmar configuración sin compartir valores.

## 3. Contrato HTTP v1

| Paso | Solicitud | Éxito |
| --- | --- | --- |
| Contraseña | `POST /auth/login` con el DTO existente `{email,password}` | HTTP 200, exclusivamente el sobre OTP de abajo. No devuelve usuario, tenants ni tokens. |
| Verificación | `POST /auth/login/otp/verify` con `{challengeId,code}` | HTTP 200, el `LoginResponse` existente, solo después de consumir el OTP. |
| Reenvío | `POST /auth/login/otp/resend` con `{challengeId}` | HTTP 200, reemplaza el sobre completo e invalida el handle/código anterior. |
| Selección | `POST /auth/select-tenant` con `{tempToken,tenantId}` | Conserva la respuesta de sesión; comprueba usuario activo y pertenencia a un tenant activo. |
| Registro | `POST /auth/register` con el DTO existente | HTTP 201, solo `{user}` creado. Luego debe hacerse login normal con contraseña y OTP. |

```json
{
  "requiresOtp": true,
  "challengeId": "<handle opaco de 43 caracteres>",
  "expiresIn": 600,
  "resendAfter": 60
}
```

Las duraciones son segundos. `code` es un **string de exactamente seis dígitos
ASCII**, por ejemplo `"000123"`; no enviar un número ni perder ceros iniciales.
El desafío vive diez minutos desde su activación tras el envío aceptado; el reenvío
requiere esperar al menos 60 segundos. Un nuevo login válido también reemplaza el
desafío, sujeto a los mismos presupuestos y cooldown.

Después de verificar:
- Una sucursal activa: credenciales finales y `requiresTenantSelection:false`.
- Varias sucursales activas: `requiresTenantSelection:true`, tenants y `tempToken`
  por 300 segundos; todavía no hay sesión final.
- Super-admin: credenciales finales en contexto global, con tenant nulo.
- Sin sucursales activas y sin rol global: se rechaza la continuación; no se emite sesión.

El frontend conserva el desafío **solo en memoria** en login, no en almacenamiento
persistente ni en slots de tokens. No debe hidratar permisos ni navegar a rutas
protegidas antes de obtener credenciales finales. Una recarga reinicia desde contraseña.

## 4. Fallos y límites

| Respuesta | Significado y recuperación |
| --- | --- |
| 400 | DTO malformado o campos extra. Se mantiene el sobre de validación, sin `target` ni `value` que expongan datos enviados. |
| Error de contraseña | Conserva el comportamiento anterior; no crea OTP ni credenciales. |
| 401 `OTP_INVALID` | Genérico para código incorrecto, expirado, consumido, desconocido o presupuesto de verificación agotado. No distingue la causa. Reiniciar desde contraseña cuando corresponda; un resend 401 obliga a reiniciar. |
| 429 `OTP_RATE_LIMITED` | Incluye `retryAfter` en segundos y cabecera `Retry-After`. Esperar; un reenvío limitado conserva el desafío actual. |
| 503 `OTP_DELIVERY_UNAVAILABLE` | No hay desafío utilizable tras el fallo de entrega; un reenvío fallido invalida el anterior. Reiniciar desde contraseña. |
| Otro 503 genérico | Infraestructura de autenticación no disponible; no asumir emisión de sesión o entrega. |

Los sobres OTP conservan `statusCode`, `error`, `code` y `message`; el 429 además
incluye `retryAfter`. Ante timeout ambiguo de reenvío o respuesta de verificación
perdida, reiniciar desde contraseña. No hay garantía de idempotencia ni revocación
retroactiva de una sesión que pudiera haberse emitido antes de perder la respuesta.

Presupuestos persistentes por cuenta: cinco verificaciones y tres intentos de envío
por ventana de quince minutos. Rotar el desafío no reinicia esos presupuestos.
La protección complementaria admite 30 solicitudes de login/reenvío por origen y
60 verificaciones por origen en quince minutos; el password login también limita
30 solicitudes por email normalizado, incluso si no existe.

**Proxy compartido:** el origen es la dirección del socket; no se confía en cabeceras
reenviadas. Un proxy común puede compartir el presupuesto entre muchos usuarios.
No cambiar confianza de proxy ni resetear contadores como solución improvisada.

## 5. Vinculación de correo y compatibilidad

La reserva calcula el HMAC con el email exacto leído bajo el bloqueo del usuario;
ese mismo email es el destinatario. Antes de consumir, la verificación compara el
HMAC usando el email actual bajo bloqueo. Si cambió de A a B, el código enviado a A
falla con `OTP_INVALID`, no se consume y el intento sí cuenta. Esto también aplica
si el email cambia mientras el envío está en curso.

El MAC por sí solo es **vinculación al email actual**, no invalidación histórica
irreversible: ante un cambio directo fuera de la ruta administrativa, si vuelve
de B a A, el código puede coincidir nuevamente mientras sigan cumpliéndose TTL,
presupuestos, usuario activo y uso único. No existe infraestructura de versiones
históricas de email.

La [edición administrativa](admin-user-editing.md) agrega una garantía distinta:
al cambiar efectivamente el email mediante `PATCH /admin/users/:id`, marca los
OTP PENDING/ACTIVE como FAILED dentro de la misma transacción y bloqueo del
usuario. Un envío demorado no puede reactivarlos y volver de B a A por esa ruta
no los revive. El email sin cambios no invalida OTP; se conservan historial,
presupuestos y sesiones finales existentes.

El propósito interno del MAC cambia a `password-login-otp/v2`; los digests pendientes
anteriores fallan cerrados. Esto **no cambia el contrato HTTP v1** ni el claim firmado
`authProof:'password-email-otp-v1'` del token de selección, emitido solo tras OTP.
Los tokens de selección antiguos sin esa prueba se rechazan. Las sesiones finales
válidas existentes, refresh y switch siguen compatibles; no requieren agregar esa
prueba. Un token temporal no se acepta como sesión final ni como refresh.

## 6. Despliegue coordinado y rollback

El [entrypoint](../docker-entrypoint.sh) ejecuta `prisma migrate deploy` en **cada
inicio**, incluyendo reinicios, y aplica **todas las migraciones pendientes**, no
solo OTP. `set -e` bloquea el arranque si ese paso falla. No confundir construir la
imagen (genera el cliente) con iniciar el contenedor (migra la base).

El dueño debe revisar el backlog completo de migraciones y el respaldo antes del
primer arranque de la imagen nueva. Backend, frontend y correo listo forman una
sola activación operativa: **todas las réplicas de login solo con contraseña deben
salir de servicio**. Una mezcla permite evadir el paso OTP o produce respuestas
incompatibles. No activar parcialmente ni usar la falta de proveedor como modo demo.

**Rollback de aplicación no es rollback de base.** La migración es aditiva; conservar
las tablas y los presupuestos persistentes. No eliminar tablas de autenticación,
resetear presupuestos ni proponer migraciones destructivas para restaurar acceso.
Volver a una aplicación de password-only **restaura el bypass OTP**: no es un rollback
seguro equivalente. Ante un problema, detener la activación o mantener fuera de
servicio el login afectado y acordar con el dueño una corrección que preserve el
requisito OTP. Coordinar también el frontend; no introducir un flag de bypass.

## 7. Aceptación manual mínima del dueño

Solo en el entorno y con las cuentas de prueba que el dueño autorice; sin automatización
visual extensa ni exposición de códigos o credenciales en evidencias:

- [ ] Contraseña incorrecta no envía correo ni crea sesión. Contraseña correcta
  muestra el desafío sin permitir una ruta protegida; confirmar recepción real en inbox.
- [ ] Con OTP válido: una sucursal abre su sesión; varias ofrecen selector antes de
  abrirla; super-admin también exige OTP y luego entra en contexto global.
- [ ] Código incorrecto y expirado fallan genéricamente sin sesión. Un código ya
  consumido no puede crear otra sesión. Respetar presupuestos al preparar los casos.
- [ ] Tras el cooldown, reenviar reemplaza el desafío; el código anterior falla y
  el nuevo permite continuar. Un 429 conserva el desafío y muestra la espera.
- [ ] Recargar login reinicia desde contraseña; un timeout ambiguo o respuesta de
  verify perdida permite reiniciar sin tratar el desafío como credencial.
- [ ] Tras completar el flujo, comprobar acceso protegido, permisos y selección de
  tenant esperados; una sesión final anterior válida conserva refresh/switch.
- [ ] Registro devuelve usuario sin tokens; el usuario nuevo debe pasar por login
  con contraseña y OTP antes de acceder.

## 8. Evidencia y límites de verificación

Las pruebas unitarias usan mailer/SDK falsos y persistencia simulada; las pruebas de
vinculación de email combinan servicio, repositorio y HMAC reales con una transacción
falsa serializada. Cubren cambio de email antes del consumo, envío diferido, regreso
A→B→A, replay y compromiso del contador de intentos. No ejecutan SQL ni prueban el
scheduler de bloqueos de PostgreSQL.

Las validaciones locales se ejecutan sin red: once suites unitarias focalizadas,
compilación TypeScript sin emisión y lint de archivos afectados. No se ejecutaron
migraciones, generación de cliente, build, AppModule, servidor, proveedor ni pruebas
de UI/inbox en esta unidad. La aprobación de código y los resultados unitarios no
sustituyen la aceptación manual ni autorizan push o despliegue por un agente.
