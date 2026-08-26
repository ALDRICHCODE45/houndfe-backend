# Custom Payment Methods — Nota para el equipo de houndfe-chatbot

**Fecha**: 2026-08-26
**Cambio backend**: `custom-payment-methods` (archivado en `openspec/changes/archive/2026-08-26-custom-payment-methods/`)
**Estado**: ✅ Verificado PASS, deployado en `main`
**Aplica a**: equipo `houndfe-chatbot` (WhatsApp bot y panel de revisor humano)

---

## TL;DR

El cambio **`custom-payment-methods` no afecta al bot.** El catálogo de métodos de cobro personalizados es **solo del POS** (`frontend-houndfe`). El bot sigue usando sus métodos fijos (transferencia + tarjeta) como hasta ahora — **no** consume `GET /sales/payment-methods`, **no** envía `paymentMethodId` en sus cobros, y **no** requiere ningún cambio de código ni de configuración.

---

## ¿Qué cambió exactamente?

El backend ahora ofrece un **catálogo de métodos de cobro por sucursal**, configurable desde el admin (`/admin/payment-methods`), que el POS usa como selector de método de cobro en el cierre de venta. Cada método tiene un nombre de marca (p. ej. "Mercado Pago"), una categoría base (`cash | card_credit | card_debit | transfer`), un subtítulo opcional, y un flag activo/inactivo.

Cuando el POS cobra **usando** un método del catálogo, el backend guarda un snapshot del nombre en `SalePayment.metadataJson.catalog` para que el recibo PDF y el detalle de venta muestren la marca visible al cliente. La categoría base persistida (`TRANSFER`, `CASH`, etc.) **no cambia**.

**Esto es 100% POS-side.** La proyección `GET /sales/payment-methods` está guardada por `read:Sale` (el permiso del POS), no por `read:PaymentMethod`. El catálogo vive en una tabla nueva (`payment_methods`) sin tocar nada del flujo del bot.

---

## ¿Qué NO cambió para el bot?

**Todo el path del bot sigue funcionando exactamente como antes.** Concretamente:

1. **Bot cobrando por WhatsApp** — sigue creando ventas con `method: "transfer"` (o el flujo de tarjeta que ya tengan). No envía `paymentMethodId` (no existe ese concepto del lado del bot). El `SalePayment` resultante NO tiene la key `catalog` en `metadataJson`.

2. **Revisor humano confirmando el pago** (`POST /sales/:id/payments` desde el panel del revisor) — sigue mandando `method: "transfer"` con `reference` y/o `metadataJson.origin = { kind: "bot", channel }`. El backend **no** agrega la key `catalog` en esta rama — la rama de revisor es explícitamente no-catalógica. Ver `src/sales/sales.service.ts` (la rama `authMode === "reviewer"` hard-codea `method: "transfer"` y estampa `origin`).

3. **Tabla de cuentas de transferencia** (`PaymentDetail` — CLABE, banco, beneficiario) — **no cambia**. El catálogo de `PaymentMethod` es un concepto distinto: las cuentas bancarias siguen configurándose desde `/admin/payment-details` (módulo aparte) y el bot las sigue leyendo desde su endpoint dedicado (`GET /chatbot-api/payment-details` con ServiceCredential). Las claves `reference` y `origin` siguen viviendo en `metadataJson` sin colisión con la nueva key `catalog`.

4. **Idempotencia del bot** — el hash de cargo y add-payment ahora **podría** incluir `paymentMethodId` en su cálculo, pero como el bot **nunca** manda ese campo, su hash queda **byte-idéntico** al de antes del cambio. Cualquier cobro del bot que ya esté en la DB o en tránsito se procesa exactamente igual.

5. **Reembolsos / cancelaciones** — `SaleRefund.method` sigue siendo el enum base (`CASH | CARD_CREDIT | CARD_DEBIT | TRANSFER | CREDIT`). No se introduce un valor `CUSTOM`. Cancelar una venta del bot sigue funcionando sin cambios.

---

## Tabla rápida: ¿qué hace cada quién?

| Superficie | Quién la consume | ¿Toca este cambio? |
| ---------- | ---------------- | ------------------- |
| `GET /admin/payment-methods` y `POST/PATCH/DELETE` | Backoffice (admin web) | ✅ Nuevo (admin CRUD) |
| `GET /sales/payment-methods` | POS (`frontend-houndfe`) | ✅ Nuevo (selector POS) |
| `POST /sales/drafts/:id/charge` con `paymentMethodId` | POS al cobrar | ✅ Nuevo (campo opcional, snapshot en `metadataJson.catalog`) |
| `POST /sales/:id/payments` con `paymentMethodId` | POS al cobrar confirmado / revisor humano | ✅ Nuevo en rama owner; **sin cambios** en rama reviewer |
| `POST /sales/:id/payments` (rama reviewer — bot) | Panel del revisor humano del bot | ❌ **Sin cambios** |
| `GET /chatbot-api/payment-details` | Bot (ServiceCredential) | ❌ **Sin cambios** |
| `POST /sales/:id/payments` con `metadataJson.origin` | Revisor humano del bot | ❌ **Sin cambios** (la key `origin` no colisiona con `catalog`) |

---

## ¿Tiene que hacer algo el equipo del bot?

**No.** No hay migración de datos del bot, no hay endpoints nuevos que el bot deba consumir, no hay permisos nuevos que el bot deba pedir, no hay cambios en el shape de las respuestas que el bot recibe del backend.

Si en el futuro el bot quisiera empezar a usar métodos personalizados del catálogo (p. ej. para mostrar "Mercado Pago" en lugar de "Transferencia" en el mensaje al cliente), sería un **cambio separado** que habría que diseñar — el bot hoy no está listo para eso y este PR no lo habilita.

---

## Preguntas / contacto

Si algo del lado del bot parece haberse comportado distinto después del deploy del 2026-08-26, verificar primero:

1. Que el payload del bot **no** esté incluyendo un campo `paymentMethodId` por accidente (debe omitirse por completo).
2. Que el payload del revisor humano siga siendo `method: "transfer"` con `reference` y/o `metadataJson.origin` (sin `paymentMethodId`).
3. Que la idempotency key del bot siga produciendo el mismo hash que antes (debería, porque no se envía `paymentMethodId`).

Para dudas técnicas, revisar `openspec/changes/archive/2026-08-26-custom-payment-methods/design.md` (decisiones D3, D5, D8, D11 son las que más interactúan con el path del bot — todas confirman que el path del bot queda intacto).
