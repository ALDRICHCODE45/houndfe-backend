# Cargo de envío en ventas del bot (preparación, **no activado**)

Este branch prepara un cargo en centavos MXN, pero **POST `/chatbot-api/sales` rechaza cualquier `shipping` con `SHIPPING_CHARGE_UNAVAILABLE` (422)** antes de adquirir la clave de idempotencia o crear una venta. No se debe enviar el cargo todavía. Una venta sin `shipping` conserva su contrato anterior.

## Contrato previsto al activar

```json
{
  "shippingAddressId": "<dirección del cliente>",
  "shipping": {
    "chargeCents": 2500,
    "approvalId": "<requestId de aprobación humana>",
    "quoteId": "<ID opcional de cotización>"
  },
  "expectedTotalCents": 12500
}
```

El monto es positivo e íntegro en centavos MXN. El backend comprobará que la dirección exista en el tenant y pertenezca al cliente; `approvalId` no puede reutilizarse para otra venta del mismo tenant. El backend **confía en la afirmación del servicio bot autenticado**: no consulta ni comprueba por sí mismo la decisión humana. Antes de registrar la venta, el bot debe volver a comprobar que su aprobación corresponda al carrito, destino y cotización vigentes.

La promoción descuenta sólo mercancía. La conciliación será `subtotalCents − discountCents + shippingChargeCents = totalCents = debtCents` en ventas a crédito sin pagos. `expectedTotalCents` debe ser el total final, incluido envío. El hash de idempotencia incorpora cargo, aprobación y cotización; la configuración `BOT_SHIPPING_CHARGE_MAX_CENTS` carece de valor predeterminado y deberá establecerla el propietario, sin inventar un tope comercial.

**Pendiente antes de activar:** exponer el cargo por separado en detalle de venta, comprobante y PDF; aplicar el tope del propietario en la frontera de registro; probar el contrato de respuesta y el replay de idempotencia. Ni tests con mocks ni build ejecutan una migración en base de datos real.
