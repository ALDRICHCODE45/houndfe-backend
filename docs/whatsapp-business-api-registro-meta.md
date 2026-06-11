# Registro en la WhatsApp Business Platform (Cloud API) — Guía para HoundFe

> Última revisión: junio de 2026. Los procesos de Meta cambian con frecuencia;
> ante cualquier duda, la fuente de verdad son los enlaces oficiales de la sección 7.

---

## 1. Resumen

- **Lo que HoundFe usa hoy**: la _app_ WhatsApp Business (aplicación gratuita del teléfono).
  Sirve para responder manualmente, pero **no tiene API**: ningún programa puede leer ni
  enviar mensajes a través de ella.
- **Lo que el chatbot necesita**: la **WhatsApp Business Platform (Cloud API)**, el servicio
  de Meta que permite que un sistema (nuestro backend) reciba y envíe mensajes
  automáticamente mediante una API alojada por Meta.
- **Punto clave**: un mismo número **no puede estar al mismo tiempo** en la app y conectado
  directamente a la Cloud API (existe una excepción llamada "Coexistence", ver sección 2).
- **Buena noticia**: Meta proporciona un **número de prueba gratuito** que funciona desde el
  primer día, sin verificación ni trámites. **El desarrollo del bot puede empezar HOY**;
  los trámites de verificación corren en paralelo.

---

## 2. Qué se necesita antes de empezar

### Checklist previa

- [ ] Cuenta personal de Facebook del responsable (se usa solo para iniciar sesión).
- [ ] **Portafolio de negocio en Meta** (antes "Business Manager"): crear en
      https://business.facebook.com si no existe.
- [ ] Datos legales del negocio **tal como aparecen en los documentos oficiales**:
  - Razón social o nombre del régimen fiscal (debe coincidir exactamente).
  - Dirección fiscal.
  - Sitio web o página de Facebook del negocio.
- [ ] Documentos para la verificación (negocio en México; lista típica, confirmar en el
      Centro de Ayuda al momento del trámite):
  - Constancia de Situación Fiscal del SAT (CSF) — el documento más usado.
  - Acta constitutiva (si es persona moral).
  - Estado de cuenta bancario del negocio o recibo de servicios (comprobante de domicilio).
  - Los documentos deben estar **vigentes** y el nombre debe coincidir con el del portafolio.
- [ ] Decisión sobre el **número de teléfono** (ver abajo).
- [ ] Tarjeta de crédito/débito para asociar método de pago (los cobros llegan después,
      por mensajes de plantilla; recibir y responder dentro de la ventana de 24 h es gratis).

### Decisión clave: ¿qué número usar para el bot?

| Opción                                                     | Pros                                                                                                              | Contras                                                                                                                                                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Número nuevo dedicado** (recomendada)                 | Cero riesgo para el número actual; los clientes actuales siguen atendidos en la app; alta inmediata sin migración | Hay que comunicar el nuevo número a los clientes (o usarlo solo para el bot)                                                                                                                                                          |
| **B. Migrar el número actual a la Cloud API directa**      | Los clientes conservan el mismo número                                                                            | Hay que **eliminar la cuenta en la app** antes de registrar el número en la API; **se pierde el historial de chats** (exportar respaldo antes); el proceso es estresante si algo falla                                                |
| **C. "Coexistence"** (número actual en app + API a la vez) | Conserva número, app e historial; los mensajes de la API aparecen en la app y viceversa                           | En la práctica se contrata **a través de un partner (BSP)** como 360dialog; tiene limitaciones: hay que abrir la app al menos cada 13 días, la revisión del display name no es automática, y agrega un proveedor intermedio con costo |

**Recomendación para HoundFe**: **Opción A — número nuevo dedicado** para el bot
(puede ser una SIM nueva o un número fijo capaz de recibir una llamada de verificación).
El número actual sigue funcionando en la app para atención manual. Cuando el bot esté
maduro y probado, se puede evaluar migrar el número principal (Opción B) o Coexistence (C).

> ⚠️ **Riesgo de la Opción B**: al eliminar la cuenta de la app se pierde el historial de
> conversaciones de forma permanente. Antes de hacerlo: exportar los chats importantes
> (Ajustes → Chats → Exportar chat) y hacer copia de seguridad. La Cloud API **no** importa
> historial.

---

## 3. Paso a paso del registro

### Fase 0 — Desarrollar desde HOY con el número de prueba (sin trámites)

1. Entrar a https://developers.facebook.com con la cuenta de Facebook → "Mis apps" →
   **Crear app** → tipo **Business**.
2. En el panel de la app, sección "Agregar productos", elegir **WhatsApp** → "Configurar".
   Vincular (o crear) el portafolio de negocio cuando lo pida.
3. Meta asigna automáticamente un **número de prueba** (test number) y un token temporal.
   Desde la pestaña **API Setup** ya se pueden enviar mensajes.
4. Limitación del número de prueba: solo puede enviar a una lista de hasta **5 números
   destinatarios verificados** (se agregan con un código por WhatsApp). Suficiente para
   desarrollar todo el bot: webhooks, flujos, respuestas, integración con el backend.
5. Configurar el **webhook** (URL del backend + verify token) en la pestaña
   Configuration → Webhooks, y suscribirse al campo `messages`.

✅ **Con esto el desarrollador ya no está bloqueado.** Todo lo que sigue es trámite
administrativo y puede avanzar en paralelo.

### Fase 1 — Verificación del negocio (la dueña/el dueño, en paralelo)

1. Entrar a https://business.facebook.com → **Configuración del negocio** →
   **Centro de seguridad** → **Verificación del negocio** → "Iniciar verificación".
2. Capturar datos legales (deben coincidir EXACTAMENTE con los documentos).
3. Subir documentos (CSF del SAT, comprobante de domicilio, etc.).
4. Confirmar el control del negocio (correo del dominio del negocio, teléfono o documento
   adicional, según lo que ofrezca el flujo).
5. Esperar la revisión de Meta y atender cualquier solicitud de información adicional.

### Fase 2 — Alta del número real

1. En WhatsApp Manager (o desde el panel de la app: WhatsApp → API Setup → "Add phone
   number"): capturar el número nuevo, el **display name** (nombre visible: "HoundFe")
   y la categoría del negocio.
2. Verificar el número por **SMS o llamada** (si es fijo, elegir llamada).
   El número **no debe tener una cuenta de WhatsApp activa**; si la tiene, eliminarla
   primero desde la app (Ajustes → Cuenta → Eliminar cuenta).
3. Meta revisa el **display name** (debe corresponder al nombre real del negocio; sin
   mayúsculas raras, sin emojis, sin palabras genéricas tipo "Ofertas").
4. Agregar **método de pago** en WhatsApp Manager para poder enviar plantillas en producción.
5. Generar un **token permanente** (System User en Business Settings → crear usuario de
   sistema → asignar la app y el activo de WhatsApp → generar token con permisos
   `whatsapp_business_messaging` y `whatsapp_business_management`). El token temporal del
   panel expira en 24 h; no usarlo en producción.
6. Cambiar la configuración del backend del número de prueba al número real
   (phone number ID + token permanente). El código no cambia.

---

## 4. Tiempos estimados y dependencias

| Paso                                | Tiempo típico                                               | ¿Bloquea qué?                                                                  |
| ----------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Crear app + número de prueba        | **1 hora, mismo día**                                       | Nada — desbloquea el desarrollo completo                                       |
| Verificación del negocio            | De 2 a 14 días hábiles (a veces más si rechazan documentos) | Escalar mensajería, badge oficial, límites altos; **no bloquea el desarrollo** |
| Alta y verificación del número real | Minutos (SMS/llamada)                                       | Pruebas con clientes reales                                                    |
| Aprobación del display name         | Horas a ~2 días                                             | Envío en producción con nombre visible                                         |
| Aprobación de plantillas de mensaje | Minutos a horas por plantilla                               | Solo mensajes iniciados por el negocio fuera de la ventana de 24 h             |

Notas:

- Sin verificación del negocio, Meta permite operar con **límites reducidos**
  (históricamente ~250 conversaciones iniciadas por el negocio al día por número
  — _verificar el límite vigente en los docs oficiales_). Para un bot que **responde**
  a clientes (mensajes entrantes), ese límite casi no estorba al inicio.
- La verificación es **requisito para escalar** (1K/10K/100K conversaciones diarias)
  y para funciones avanzadas.

---

## 5. Costos

Modelo vigente (desde julio de 2025, confirmado en documentación de partners de Meta):
**precio por mensaje de plantilla**, ya no por conversación.

- **Gratis**:
  - Todos los mensajes que el cliente envía al negocio.
  - Las respuestas de formato libre (texto, imágenes, etc.) dentro de la **ventana de
    servicio de 24 horas** que abre cada mensaje del cliente.
  - Mensajes de plantilla tipo _utility_ enviados **dentro** de una ventana de 24 h abierta.
  - Ventana de 72 h gratis si el cliente llega por un anuncio "Click to WhatsApp".
- **Con costo** (por mensaje, según categoría de la plantilla): _Marketing_, _Authentication_
  y _Utility_ fuera de ventana.

Cifras aproximadas para México (⚠️ **verificar contra la tabla oficial**, cambian por país
y por actualización de tarifas): Marketing ≈ 0.04 USD, Authentication ≈ 0.02 USD,
Utility ≈ 0.01 USD o menos, por mensaje.

**Implicación para HoundFe**: un bot que responde dudas de clientes (ellos escriben primero)
opera casi **gratis**. Los costos aparecen al enviar campañas o notificaciones salientes.

Dónde verificar precios vigentes:

- https://developers.facebook.com/docs/whatsapp/pricing
- https://business.whatsapp.com/products/platform-pricing (descarga de tarifas por país)

---

## 6. Errores comunes y cómo evitarlos

- **Registrar el número actual en la API sin respaldo** → se pierde el historial de chats.
  Decidir primero (sección 2); si se migra, exportar chats antes de eliminar la cuenta.
- **Nombre legal que no coincide con los documentos** → rechazo de la verificación.
  Copiar la razón social tal cual aparece en la CSF del SAT.
- **Display name "creativo"** ("HoundFe 🐶 Ofertas") → rechazo. Usar el nombre real: "HoundFe".
- **Usar el token temporal en producción** → el bot deja de funcionar a las 24 h.
  Crear System User con token permanente desde el inicio.
- **Esperar la verificación para empezar a programar** → semanas perdidas.
  El número de prueba funciona desde el día uno.
- **Olvidar el método de pago** → las plantillas no se envían aunque todo esté aprobado.
- **Webhook sin HTTPS válido o sin responder el reto de verificación** → Meta no entrega
  mensajes. El endpoint debe responder el `hub.challenge` en el GET de verificación.
- **Categoría de plantilla mal elegida** → Meta la recategoriza (p. ej. de _utility_ a
  _marketing_, más cara) o la rechaza. Redactar plantillas transaccionales sin texto
  promocional.

### ¿Y los BSP (Twilio, 360dialog)?

Son intermediarios autorizados que dan acceso a la misma API con capa propia (y cobro
adicional por mensaje o suscripción). Útiles si se quiere soporte gestionado, onboarding
asistido o Coexistence. Para un desarrollador que puede leer la documentación de Meta,
**la Cloud API directa es suficiente y más barata**: se paga solo la tarifa de Meta.
Recomendación: **empezar directo con Meta**; un BSP se puede adoptar después si hiciera falta.

---

## 7. Recursos

### Enlaces oficiales

- Inicio rápido Cloud API: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
- Números de teléfono: https://developers.facebook.com/docs/whatsapp/phone-numbers
- Migrar número de la app a la API: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started/migrate-existing-whatsapp-number-to-a-business-account
- Coexistence / onboarding de usuarios de la app: https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users
- Verificación del negocio: https://www.facebook.com/business/help/2058515294227817
- Precios: https://developers.facebook.com/docs/whatsapp/pricing
- Display name: https://www.facebook.com/business/help/338047025165344
- WhatsApp Manager: https://business.facebook.com/wa/manage/

> Nota: las páginas de developers.facebook.com requieren sesión iniciada en algunos casos.

### Búsquedas recomendadas en YouTube (los enlaces a videos caducan; buscar por término)

- "WhatsApp Cloud API setup 2026 español"
- "WhatsApp Business Platform verificación de negocio México"
- "Migrar WhatsApp Business app a Cloud API"
- "WhatsApp Cloud API webhook tutorial"
- "Meta business verification documents Mexico"

Filtrar por fecha de publicación (últimos 6–12 meses): la interfaz de Meta cambia seguido.
