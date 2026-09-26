# Cargo de envío en ventas del bot (MVP A)

**Estado:** implementado en `feat/bot-sale-shipping-charge`, no publicado. En esta rama permanece **apagado por defecto**: `POST /chatbot-api/sales` rechaza `shipping` con `SHIPPING_CHARGE_UNAVAILABLE` (422) antes de reservar la clave de idempotencia si el propietario no configuró `BOT_SHIPPING_CHARGE_MAX_CENTS`. No inventamos tope comercial. Las ventas sin `shipping` conservan su contrato anterior.

## Configurar y llamar

El propietario debe definir `BOT_SHIPPING_CHARGE_MAX_CENTS` como entero positivo ≤ 2 147 483 647 (centavos MXN). Valores ausentes desactivan el cargo; valores inválidos impiden el arranque. Con configuración válida, el bot autenticado (`sales:create`) puede enviar:

```json
{
  "shippingAddressId": "<UUID de dirección del cliente>",
  "shipping": {
    "chargeCents": 2500,
    "approvalId": "<requestId de aprobación humana>",
    "quoteId": "<ID opcional de cotización>"
  },
  "expectedTotalCents": 12500
}
```

Este fragmento se añade al cuerpo existente (`cashierUserId`, `customerId`, `items`); también requiere `X-Idempotency-Key`. El monto es positivo e íntegro en centavos MXN, ≤ tope configurado. `expectedTotalCents` es **obligatorio sólo cuando se envía `shipping`**: si falta, devuelve 422 `SHIPPING_EXPECTED_TOTAL_REQUIRED` antes de reservar idempotencia. Sigue siendo opcional en ventas sin cargo. Un envío gratis (`chargeCents: 0`) no está soportado/auditado en este MVP y debe fallar cerrado, no representarse como una aprobación persistida al omitir `shipping`. El backend comprueba que la dirección exista en el tenant y pertenezca al cliente. `approvalId` no puede reutilizarse en otra venta del **mismo tenant** (409 `SHIPPING_APPROVAL_ALREADY_USED`). El hash de idempotencia incluye cargo, aprobación y cotización, además de los campos de mercancía existentes; una misma clave con distinto contenido da 409 `IDEMPOTENCY_KEY_CONFLICT`.

El backend **confía en la afirmación del servicio bot autenticado** de que hubo aprobación humana: no consulta ni verifica la decisión ni la vigencia de carrito/destino/cotización por sí mismo. Antes de crear la venta, el bot debe vincular la aprobación a esos datos y volver a comprobar su frescura. No enviar monto ni aprobación desde un cliente no confiable.

## Conciliación y lectura

La promoción descuenta **sólo mercancía**: `subtotalCents − discountCents + shippingChargeCents = totalCents`. En venta a crédito sin pagos, `debtCents = totalCents`. `expectedTotalCents` compara contra el total **incluido** envío (diferencia: 409 `PROMO_RE_QUOTE`). La respuesta `POST /chatbot-api/sales`, su replay y `sale.confirmed` incluyen `shippingChargeCents`; respuesta y detalle incluyen subtotal, descuento, total y deuda. El detalle de venta muestra cargo positivo por separado; los PDF A4 y ticket agregan una fila «Envío» entre descuento y deuda. Para ventas antiguas/POS sin cargo, se omiten los campos/filas opcionales de envío.

## Evidencia y límite

Pruebas unitarias cubren validación, gate, re-cotización, promociones, stock, idempotencia, persistencia y los dos formatos PDF. Se validó el esquema Prisma y compiló el backend. **No se ejecutó la migración de envío ni una venta real contra DB/proveedor para este trabajo**; eso requiere una verificación controlada aparte antes del despliegue. Ningún commit de este branch se fusionó, empujó o desplegó.
