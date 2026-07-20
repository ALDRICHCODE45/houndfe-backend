# POS — Generación de PDF de Recibo de Venta

> Backend autoritativo. El endpoint devuelve un stream binario PDF sin buffering.
> **Branch**: `main` (mergeado). Módulo `PdfGenerationModule`.
> **Librería**: `@react-pdf/renderer@^4.5.1` (React components → PDF, sin dependencia de navegador/Chrome).

---

## 0) Qué hace este endpoint

Genera un PDF imprimible del recibo de una venta CONFIRMADA. Dos formatos disponibles:

- **`receipt-a4`** (default) — hoja carta 210×297mm, recibo completo con todos los detalles.
- **`receipt-ticket`** — 80mm de ancho (térmico), compacto, altura variable según contenido.

El PDF incluye: encabezado del negocio (logo + nombre), metadatos de la venta (folio, fecha, cajero, vendedor), datos del cliente, tabla de productos con precios y descuentos, bloque de totales, métodos de pago, y pie con folio.

---

## 1) Quick path — cómo probarlo en 1 minuto

```bash
# Obtener un token JWT (igual que cualquier otro endpoint del POS)
TOKEN="Bearer eyJ..."

# PDF en A4 (default)
curl -H "Authorization: $TOKEN" \
  "http://localhost:3000/sales/{sale-id}/pdf?format=receipt-a4" \
  --output recibo-a4.pdf

# PDF en ticket térmico
curl -H "Authorization: $TOKEN" \
  "http://localhost:3000/sales/{sale-id}/pdf?format=receipt-ticket" \
  --output recibo-ticket.pdf

# Sin format → usa A4 por defecto
curl -H "Authorization: $TOKEN" \
  "http://localhost:3000/sales/{sale-id}/pdf" \
  --output recibo-default.pdf
```

---

## 2) Endpoint

### `GET /sales/:id/pdf`

Genera y streamea el PDF del recibo para una venta confirmada.

| Aspecto | Detalle |
|---|---|
| **URL** | `GET /sales/:id/pdf?format={receipt-a4\|receipt-ticket}` |
| **Method** | `GET` |
| **Auth** | JWT `Bearer <token>` |
| **Permiso requerido** | `read:Sale` (mismo permiso que leer el detalle de venta) |
| **Content-Type** | `application/pdf` |
| **Content-Disposition** | `attachment; filename="recibo-{folio}.pdf"` |
| **Body** | Stream binario PDF (NO es JSON) |
| **Tenant isolation** | ✅ El JWT lleva el tenant; solo devuelve ventas del tenant autenticado |

### Query params

| Parámetro | Tipo | Requerido | Default | Valores válidos |
|---|---|---|---|---|
| `format` | `string` | No | `receipt-a4` | `receipt-a4`, `receipt-ticket` |

### Headers requeridos

| Header | Valor |
|---|---|
| `Authorization` | `Bearer <jwt-token>` |

---

## 3) Contrato de respuesta

### Éxito — `200 OK`

```
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: attachment; filename="recibo-A-0001.pdf"

%PDF-1.4
...(contenido binario del PDF)...
%%EOF
```

**Importante**: El body es binario. NO es JSON. El frontend debe tratarlo como `blob` o `arraybuffer`.

El `Content-Disposition` usa el folio real de la venta (ej. `A-0001`), NO el UUID interno. Si la venta no tiene folio aún (solo posible en edge cases), el nombre de archivo usa el ID como fallback.

### Contenido del PDF

El recibo (formato A4) contiene estas secciones, en orden:

1. **Encabezado del negocio**: logo (CDN) + nombre "Houndé"
2. **Metadatos de la venta**: folio, fecha/hora de confirmación, cajero, vendedor
3. **Datos del cliente**: nombre del cliente, o "Público en General" si no tiene cliente asignado
4. **Tabla de productos**:
   - Nombre del producto
   - Variante (si aplica)
   - Cantidad
   - Precio unitario
   - Descuento aplicado (título + monto, si existe)
   - Subtotal por línea
5. **Totales**:
   - Subtotal
   - Descuentos
   - Total
   - Pagado
   - Deuda
   - Cambio
6. **Métodos de pago**: método, monto, referencia (si existe), timestamp

El ticket (80mm) contiene la misma información pero en formato compacto, optimizado para impresora térmica.

---

## 4) Errores

| Código | Código de error | Causa | Cuándo ocurre |
|---|---|---|---|
| `400` | `INVALID_FORMAT` | El query param `format` no es `receipt-a4` ni `receipt-ticket` | `?format=pdf` o `?format=factura` |
| `400` | `SALE_NOT_CONFIRMED` | La venta existe pero está en estado DRAFT | Intentar generar PDF de un borrador |
| `401` | — | Falta el header `Authorization` o el token es inválido/expirado | Sin token o token vencido |
| `403` | — | El usuario no tiene permiso `read:Sale` | Usuario sin acceso al módulo de ventas |
| `404` | — | La venta no existe, no pertenece al tenant del token, o está en DRAFT (filtro SQL) | ID inválido, cross-tenant, o borrador |
| `500` | `PDF_GENERATION_FAILED` | Fallo interno del renderizador PDF | Error de infraestructura (fuente no disponible, etc.) |

### Sobre el 404 en DRAFT

**Comportamiento real**: una venta DRAFT devuelve `404`, no `400`. Esto es porque el repositorio filtra `status: 'CONFIRMED'` a nivel SQL. Un DRAFT es indistinguible de "no existe" en la capa de datos. El guardia `SALE_NOT_CONFIRMED` (400) existe en el servicio pero solo se activa si el filtro SQL se afloja en el futuro.

**Recomendación para el FE**: si el usuario hace clic en "Descargar PDF" desde una venta DRAFT, mostrá un mensaje tipo "Solo se puede generar PDF de ventas confirmadas" ANTES de llamar al endpoint. No dependas del código de error para distinguir DRAFT de "no existe".

### Tenant isolation

Un token del tenant A NUNCA puede acceder al PDF de una venta del tenant B. El endpoint devuelve `404` (no `403`) para no revelar si la venta existe en otro tenant. Esto es por diseño de seguridad — misma filosofía que el resto de endpoints de ventas.

---

## 5) Guía de implementación frontend

### Descargar el PDF (aproach recomendado)

```typescript
async function downloadSalePdf(saleId: string, format: 'receipt-a4' | 'receipt-ticket' = 'receipt-a4') {
  const token = getAuthToken(); // tu helper de auth

  const response = await fetch(`/api/sales/${saleId}/pdf?format=${format}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    // Manejar errores según el status code (ver tabla arriba)
    const error = await response.json().catch(() => ({ message: 'UNKNOWN_ERROR' }));
    throw new PdfGenerationError(response.status, error.message);
  }

  // Extraer el nombre de archivo del Content-Disposition header
  const disposition = response.headers.get('Content-Disposition');
  const filenameMatch = disposition?.match(/filename="(.+)"/);
  const filename = filenameMatch?.[1] ?? `recibo-${saleId}.pdf`;

  // Crear blob y disparar descarga
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
```

### Previsualizar en el navegador (alternativa)

```typescript
async function previewSalePdf(saleId: string, format: 'receipt-a4' | 'receipt-ticket' = 'receipt-a4') {
  const token = getAuthToken();
  const response = await fetch(`/api/sales/${saleId}/pdf?format=${format}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`PDF generation failed: ${response.status}`);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);

  // Abrir en nueva pestaña (el navegador renderiza PDFs nativamente)
  window.open(url, '_blank');
}
```

### Axios (si usan Axios en vez de fetch)

```typescript
import axios from 'axios';

async function downloadSalePdfAxios(saleId: string, format: string = 'receipt-a4') {
  const response = await axios.get(`/sales/${saleId}/pdf`, {
    params: { format },
    headers: { Authorization: `Bearer ${getAuthToken()}` },
    responseType: 'blob', // ← CRÍTICO: sin esto, Axios intenta parsear JSON
  });

  // El filename viene en Content-Disposition
  const disposition = response.headers['content-disposition'];
  const filename = disposition?.match(/filename="(.+)"/)?.[1] ?? `recibo-${saleId}.pdf`;

  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
```

### Puntos clave para el FE

1. **`responseType: 'blob'` es OBLIGATORIO** si usan Axios. Sin esto, Axios intenta parsear el PDF como JSON y rompe.
2. **No intenten parsear el body como JSON**. Es un binario. Solo los errores (`4xx`, `5xx`) devuelven JSON con `{ message: "..." }`.
3. **El filename viene del header `Content-Disposition`**, no hardcodeado. Usen el valor del header para nombrar el archivo descargado.
4. **No llamar para ventas DRAFT**. El endpoint devuelve 404. Validar `sale.status === 'CONFIRMED'` en el FE antes de habilitar el botón de descarga.
5. **El endpoint es rápido** (≤2 segundos para ventas de hasta 50 líneas). No necesita loading spinner con timeout largo.
6. **No hay paginación ni rate limiting especial** — mismo rate limit que el resto de endpoints de ventas.

---

## 6) UI/UX sugerido

```
┌─────────────────────────────────────────────┐
│  Venta #A-0001                    CONFIRMED  │
│  Cliente: Juan Pérez                         │
│  Total: $1,200.00                            │
│                                               │
│  [🖨️ Imprimir Recibo]  [📄 Descargar PDF]     │
│   ▼ A4 │ Ticket                               │
└─────────────────────────────────────────────┘
```

- El botón solo se habilita si `sale.status === 'CONFIRMED'`.
- Ofrecer un dropdown o toggle para elegir entre A4 y Ticket.
- "Descargar PDF" dispara el download automático.
- "Imprimir Recibo" puede abrir el PDF en nueva pestaña para que el usuario imprima desde el visor del navegador.

---

## 7) Extensibilidad futura

Este módulo (`PdfGenerationModule`) fue diseñado para ser extensible. En el futuro se agregarán:

- **Facturas fiscales** — `GET /sales/:id/pdf?format=invoice-a4` (requiere datos fiscales adicionales)
- **Reportes** — `GET /reports/sales/pdf?format=report-a4` (cierre de caja, resumen diario)
- **Cotizaciones** — `GET /quotes/:id/pdf?format=quote-a4`

El FE no tendrá que cambiar su lógica de consumo — mismo patrón: `GET`, query param `format`, respuesta binaria PDF con `Content-Disposition`.

---

## 8) Preguntas frecuentes

**P: ¿Por qué no devuelve un JSON con la URL del PDF?**
R: El PDF se genera on-demand y se streamea directamente. No se almacena en disco ni en S3 (MVP). Si en el futuro se necesita almacenar, se agregará un endpoint de descarga por URL.

**P: ¿El logo del negocio se puede cambiar?**
R: Actualmente el logo es el mismo para todas las sucursales (viene de un CDN compartido). En un futuro SDD se agregará branding por tenant/sucursal.

**P: ¿Puedo generar PDF de una venta de otro tenant si soy admin?**
R: No. El endpoint aplica tenant isolation a nivel SQL. Un admin del tenant A no puede acceder a ventas del tenant B.
