# Activación y rollback del correo de agradecimiento de entrega (DTE)

> **Estado**: pipeline implementado en la rama local `feat/delivery-thank-you-activation-guide`, **dormido y desactivado**. La migración solo se aplicó a PostgreSQL **aislado de pruebas** (`127.0.0.1:5433`), nunca a desarrollo ni producción. No hubo correo real, proveedor, Inngest Cloud ni despliegue.
>
> **Qué es este documento**: condiciones que un **dueño** debe aprobar y verificar **antes** de una activación futura. **No** es una orden de ejecución: no apliques la migración, no habilites la acción ni envíes correo a partir de esta guía sin aprobación explícita del dueño.

## 1. Quick path (solo con aprobación del dueño)

1. Inspecciona filas `delivery.thank_you.notify` `PENDING`/`FAILED` y reintentos Inngest en vuelo (§9).
2. Aplica la migración aprobada al entorno objetivo antes del código, con plan de reversión (§4–5).
3. Despliega la cadena entera como una unidad coordinada: exclusión genérica + claim/routing dedicado + productor + sender/registrar. Base y aplicación no comparten una transacción distribuida.
4. Ejecuta una prueba viva controlada y aprobada: boot de AppModule + Inngest + Resend + inbox.
5. Habilita `DELIVERY_THANK_YOU` por `PUT /notification-config` **solo** si 1–4 están verdes.
6. Monitorea y deja listo el rollback (§10).

## 2. Estado actual (resumen)

| Área                              | Estado verificado en esta rama                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Código                            | Productor transaccional, claim dedicado, dispatcher con `await`, handler Inngest, sender y registrar presentes     |
| Acción `DELIVERY_THANK_YOU`       | Registrada, **deshabilitada por defecto**, sin filas sembradas; solo se enciende por `PUT`                         |
| Migración                         | Aplicada **solo** en PostgreSQL aislado de pruebas; no en desarrollo/producción                                    |
| Envío real                        | **No probado**: AppModule arrancó solo offline con puertos simulados; sin boot vivo, Inngest Cloud, Resend o inbox |
| `recipients` / `recipientUserIds` | Lista **staff**; **nunca** el correo del cliente                                                                   |

## 3. Disparador y productor

- Solo un check-in de ruta que en su **intento ganador** observe el stop `PENDING` y lo pase a `COMPLETED`; incluye el **último** stop.
- En la **misma transacción**: flip del stop + `Sale.deliveryStatus = DELIVERED` + fila outbox **ids-only** `{tenantId, saleId, routeId, stopId}`, publicada después de la fila next-stop existente.
- `DELIVERED` por defecto de POS **no** alcanza: una venta de mostrador sin stop de ruta completado no dispara.
- **No** publican: un check-in duplicado (stop ya `COMPLETED`), una cancelación que gana la carrera, o un intento perdedor por snapshot viejo.

## 4. Migración (append-only)

- `prisma/migrations/20260924162000_delivery_thank_you_action/migration.sql` es un único `ALTER TYPE "NotificationActionKey" ADD VALUE IF NOT EXISTS 'DELIVERY_THANK_YOU';`.
- PostgreSQL **no** permite borrar un valor de enum in situ: no hay down-migration automática. Si se revierte el resto, el valor **permanece**.
- Valor sin filas sembradas y sin sender activo = inerte.

## 5. Cadena de código coordinada

Estas piezas de **código** se despliegan **juntas**, nunca por partes (la migración se aplica antes; no hay atomicidad distribuida):

- **DTE-5a** — el poller genérico excluye `delivery.thank_you.notify`; las filas quedan `PENDING` en lugar de fire-and-forget o mal ruteadas.
- **DTE-5b** — claim dedicado que reclama next-stop **y** thank-you con routing fail-closed y `await` antes de marcar `PUBLISHED`.
- **DTE-6a** — productor transaccional en el check-in.
- **Sender/registrar** — composición y registro de la función Inngest.
- **Preservar** el comportamiento next-stop.

Revertir una pieza suelta rompe el mapeo `eventType → ruta Inngest`; ver §10.

## 6. Gate en el envío (sender)

Antes de enviar, el sender re-lee y prueba, en este orden:

- master `enabled` y `enabledActions` con `DELIVERY_THANK_YOU` presentes (re-gate al momento del envío).
- stop exacto `COMPLETED` con `checkedInAt` **y** `completedAt` no nulos, y tenant/route/stop/sale coincidentes.
- venta persistida `CONFIRMED` + `DELIVERED`.
- correo del cliente resuelto **en el envío** (tenant + sale).
- Envía **solo** al correo del cliente; `recipients` del config **jamás** es destinatario.

## 7. Contrato frontend

- `GET` responde `recipients`; `PUT` recibe `recipientUserIds` y es **reemplazo total**.
- Al togglear, reenvía **solo las claves actualmente habilitadas** (no las seis): enviar todas enciende las que el tenant tenía apagadas.
- `DELIVERY_THANK_YOU` llega apagada; la UI no debe insinuar que activarla ya envió correo.
- **HTTP 2xx ≠ correo entregado**: la entrega es asíncrona por outbox + Inngest.

## 8. Semántica outbox / Inngest

- Estados: `PENDING → PUBLISHED`; un fallo reintenta con backoff y pasa a `FAILED` al agotar el presupuesto.
- El `event.id` de Inngest es estable por `${tenantId}:${saleId}:${stopId}` y permite deduplicar replays **dentro de la ventana que admita Inngest**; no es una garantía permanente.
- **Sin garantía exactly-once**: un crash después de la aceptación del proveedor y antes del checkpoint puede reenviar.

## 9. Gate seguro de activación

1. Antes de habilitar, inspecciona filas thank-you `PENDING`/`FAILED` preexistentes y reintentos Inngest en vuelo.
2. Si existen, **detén** la habilitación y derívalas a una disposición autorizada. El poller reclama automáticamente filas `PENDING` vencidas y puede haber reintentos Inngest: **no** reproduzcas ni borres filas manualmente, ni supongas que habilitar impedirá envíos de eventos antiguos.
3. Deshabilitar acción/master bloquea **intentos futuros** del sender; **no** puede recuperar un correo ya enviado.

## 10. Rollback

- Mantén thank-you **excluido** del poller genérico.
- **No** reviertas el dispatcher seguro de forma aislada mientras existan filas thank-you: primero su disposición autorizada.
- El valor del enum PostgreSQL **queda** (no hay down in situ).
- Fuera de alcance: cualquier cambio en el comportamiento next-stop.

## 11. Evidencia local y límites

Medido en esta rama (no re-ejecutado en esta unidad de documentación):

- `42/42` unit focados de servicio + dispatcher (DTE-6a).
- `12/12` integración real PostgreSQL aislada del check-in (DTE-6b2).
- `11/11` sender contra base con mailer falso (DTE-6c).
- `9/9` guardas offline de la base de test (DTE-6b1).
- `1/1` boot offline de AppModule con Prisma, pollers, Inngest.send y mailer aislados: un único registro `delivery-thank-you-notify`, sin DB/send/mail durante el arranque.
- `build` limpio.

**No** cubierto: boot vivo con puertos reales, interleaving concurrente real, Inngest Cloud, Resend ni inbox real. El boot offline no autoriza activación. Estas pruebas requieren autorización explícita del dueño.

## 12. Próximo paso

Decisión del dueño: aprobar una prueba viva controlada (§1) o mantener la acción apagada. Hasta entonces, no aplicar migración, no habilitar la acción y no enviar correo.
