# Confirmaciones backend — SDD-2 `tenant-members-api-enrichment`

Respuesta a las 5 preguntas de confirmacion del frontend (seccion 7 de `tenant-members-flow-response-and-revisions.md`) mas investigacion sobre el acceso del Cashier.

---

## 1. Resumen ejecutivo

### Las 5 confirmaciones

| # | Pregunta | Veredicto | Nota |
|---|---|---|---|
| P1 | URL nueva: `GET /admin/tenants/:tenantId/eligible-users` | CONFIRMADO | Alineado con voto del frontend. Razon ya documentada en seccion 3 del doc anterior |
| P2 | Default `includeInactive=false` | CONFIRMADO con opt-in | Param `?includeInactive=true` disponible desde el dia 1 |
| P3 | Migracion Prisma: `createdAt` aproximado en rows existentes | CONFIRMADO | Frontend decide UX para rows pre-migracion |
| P4 | Coordinacion de merge | Merge cuando este listo, frontend prepara en paralelo | Doc de implementacion post-merge incluido |
| P5 | Search minimo 2 caracteres | CONFIRMADO | Trim + case-insensitive en `email` + `name`. < 2 chars devuelve 400 |

### Hallazgo sobre el Cashier

Se investigo si el Cashier necesita acceso a `GET /admin/tenants/:id/members`. Conclusion: **NO lo necesita**. Ya existe `GET /users/assignable` (`src/users/users.controller.ts:14-18`) que cubre el caso de uso operativo (dropdowns de "asignar vendedor") con permiso `read:Sale` que el Cashier tiene. No se requiere cambio de seed. La decision #2059 queda firme.

### Proximo paso

El backend arranca SDD-2 `tenant-members-api-enrichment` ahora. El frontend puede preparar su lado en paralelo (seccion 5).

---

## 2. Respuestas a las 5 preguntas

### 2.1 P1 — URL del endpoint de eligible users

**Pregunta del frontend**: Confirman que el endpoint sera `GET /admin/tenants/:tenantId/eligible-users` en vez de `GET /admin/users?notInTenant=<id>`?

**Respuesta**: CONFIRMADO.

El frontend voto a favor de la URL propuesta por el backend. Las razones tecnicas ya estan documentadas en `docs/backend-requests/tenant-members-flow-response-and-revisions.md`, seccion 3.2: query-param-driven auth es un antipatron de seguridad y rompe la convencion de path-based tenant identification.

**Implicancia para el frontend**: Toda referencia al picker de "agregar miembro" debe apuntar a `/admin/tenants/:tenantId/eligible-users`, no a `/admin/users` con query params.

---

### 2.2 P2 — Default `includeInactive=false`

**Pregunta del frontend**: El default excluye users inactivos. Hay algun caso real donde necesiten verlos en el picker?

**Respuesta**: CONFIRMADO con opt-in.

El default es `includeInactive=false`. El endpoint soportara `?includeInactive=true` como opt-in desde el dia 1. Razon: es barato de agregar ahora, caro de agregar despues si el response shape necesita cambiar para acomodar la distincion activo/inactivo.

**Implicancia para el frontend**: El picker de eligible users va a devolver solo users activos por default. Si en el futuro necesitan un flujo de "recuperar usuario inactivo", el param ya esta disponible — solo tienen que pasarlo.

---

### 2.3 P3 — Migracion Prisma: `createdAt` aproximado

**Pregunta del frontend**: Se agrega `createdAt DateTime @default(now())` a `TenantMembership`. Las rows existentes reciben el timestamp de la migracion. Confirman?

**Respuesta**: CONFIRMADO.

La migracion es:

```sql
ALTER TABLE "tenant_memberships" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
```

Las filas existentes recibiran `CURRENT_TIMESTAMP` del momento en que se corra la migracion — no la fecha real de creacion. La migracion es reversible (drop column) si se necesita.

**Implicancia para el frontend**: La decision de UX (mostrar "aprox.", ocultar para rows antiguas, o mostrar sin distincion) queda del lado del frontend. El backend entrega el campo tal cual.

**Nota operativa**: Cuando bajen el branch despues del merge, van a tener que correr:

```bash
pnpm prisma migrate dev
```

La migracion es idempotente y rapida. No hay downtime.

---

### 2.4 P4 — Coordinacion de merge

**Pregunta del frontend**: Cuando quieren que mergeemos? Merge ya o esperamos a una fecha?

**Respuesta**: "Merge cuando este listo, frontend prepara en paralelo."

El backend mergea SDD-2 a `main` sin esperar una fecha especifica. El frontend prepara su lado en paralelo. El backend va a:

1. Anunciar el merge en el archive report de SDD-2
2. Documentar el commit SHA exacto y el comando de migracion en una guia de implementacion frontend (mismo patron que `docs/backend-requests/tenant-rbac-hardening-frontend-implementation.md`)
3. NO pushear a remoto — el deploy a produccion se coordina cuando el frontend este listo

**Implicancia para el frontend**: No hay presion de timeline. Pueden preparar la integracion antes del merge (basandose en los contratos documentados) y activarla cuando el merge este en `main`.

---

### 2.5 P5 — Search minimo 2 caracteres

**Pregunta del frontend**: El search requiere minimo 2 caracteres. Confirman?

**Respuesta**: CONFIRMADO.

Comportamiento:
- Minimo 2 caracteres despues de `trim()`
- Case-insensitive en campos `email` y `name`
- Debajo de 2 chars: `400` con codigo `SEARCH_QUERY_TOO_SHORT`
- Whitespace puro: se trimmea → queda vacio → `400`

**Implicancia para el frontend**: Implementar debounce + validacion client-side para evitar calls innecesarios. Ejemplo:

```ts
// En el componente del picker
const debouncedSearch = useDebounce(searchInput, 300);
const enabled = debouncedSearch.trim().length >= 2;
const { data } = useQuery({
  queryKey: ['eligible', tenantId, debouncedSearch],
  queryFn: () => api.get(`/admin/tenants/${tenantId}/eligible-users`, {
    params: { search: debouncedSearch },
  }),
  enabled, // no llamar si < 2 chars
});
```

Esto evita que el frontend mande requests que van a devolver 400.

---

## 3. Sobre el Cashier — investigacion con evidencia

### 3.1 La pregunta original del frontend

El frontend pregunto si el Cashier tiene una razon legitima para acceder a `GET /admin/tenants/:id/members`, dado que con la decision #2059 (`tenant-rbac-hardening`) el Cashier pierde acceso a ese endpoint (requiere `read:TenantMembership`, que el Cashier no tiene).

### 3.2 Lo que investigo el backend

Se reviso:
- El seed de permisos del Cashier en `prisma/seed.ts:278-286`
- El endpoint `GET /users/assignable` en `src/users/users.controller.ts:14-18`
- El service que lo implementa en `src/users/users.service.ts:9-21`
- El DTO de respuesta en `src/users/dto/assignable-user.dto.ts:1-4`

### 3.3 El endpoint alternativo: `GET /users/assignable`

Este endpoint ya existe y cubre el caso de uso operativo del Cashier:

```ts
// src/users/users.controller.ts:14-18
@Get('assignable')
@RequirePermissions(['read', 'Sale'])
findAssignable(): Promise<AssignableUserDto[]> {
  return this.usersService.findAssignable();
}
```

Servicio:

```ts
// src/users/users.service.ts:9-21
async findAssignable(): Promise<AssignableUserDto[]> {
  const tenantId = this.tenantPrisma.getTenantId();
  return this.tenantPrisma.getClient().user.findMany({
    where: {
      isActive: true,
      tenantMemberships: { some: { tenantId } },
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}
```

Caracteristicas:
- **Permiso requerido**: `read:Sale` — el Cashier lo tiene (`prisma/seed.ts:280`)
- **Response**: `{ id: string, name: string }[]` — plano, suficiente para dropdowns
- **Filtro automatico**: `isActive: true` — solo users activos
- **Scope**: Usa `TenantPrismaService` para scopear al tenant del JWT
- **Proposito**: Listar users del tenant para dropdowns operativos ("asignar vendedor", etc.)

### 3.4 Comparacion entre los dos endpoints

| Aspecto | `/admin/tenants/:id/members` | `/users/assignable` |
|---|---|---|
| Proposito | Administracion de membresías (roles, alta/baja) | Listado de users del tenant para dropdowns operativos |
| Permiso | `read:TenantMembership` | `read:Sale` |
| Quien accede | Manager, Super-admin | Manager, Cashier, Super-admin |
| Response shape | `TenantMembership[]` (con role) — se enriquece en SDD-2 | `{ id, name }[]` plano |
| Filtra inactivos | No (se devuelven todos) | Si (`isActive: true` automatico) |
| Scoped por tenant del JWT | Si | Si (via `TenantPrismaService`) |
| Caso de uso | Tabla de admin de miembros, gestion de roles | Dropdown de "asignar vendedor" en venta |

### 3.5 Conclusion

El Cashier **NO necesita** `GET /admin/tenants/:id/members`. Su unico caso de uso para ver "otros usuarios del tenant" es el dropdown operativo de asignar vendedor (u operaciones similares de `Sale`), y para eso ya existe `/users/assignable` con el permiso correcto.

La decision #2059 queda firme:
- Cashier pierde acceso a `GET /admin/tenants/:id/members` — **INTENCIONAL**
- Cashier mantiene acceso a `GET /users/assignable` — **SIN CAMBIOS**
- No se requiere cambio de seed ni de permisos

### 3.6 Recomendacion al frontend

Si tienen un dropdown de "asignar vendedor" o similar usado por el Cashier, debe consumir `GET /users/assignable`, **no** el endpoint admin de members.

Verificar en su codebase que ninguna pantalla accesible por Cashier este llamando a `/admin/tenants/:id/members`. Si lo encuentran, migrarlo a `/users/assignable`.

---

## 4. Proximos pasos del backend (SDD-2)

### 4.1 Arranque inmediato

El backend arranca SDD-2 `tenant-members-api-enrichment` ahora con las 5 confirmaciones recibidas. No hay bloqueantes pendientes.

### 4.2 Items del SDD

| Item | Descripcion | Contrato |
|---|---|---|
| BE-2 | Enriquecer shape de `GET /admin/tenants/:id/members` con `user`, `role`, `createdAt` | `{ data: [{ id, userId, tenantId, roleId, createdAt, user: {...}, role: {...} }] }` |
| BE-1 | Nuevo endpoint `GET /admin/tenants/:tenantId/eligible-users` | Query params: `search`, `page`, `limit`, `includeInactive`. Response: `{ data: [...], meta: {...} }` |

### 4.3 Entregable post-merge

Al cerrar SDD-2, el backend va a generar un doc de implementacion frontend siguiendo el mismo patron que `docs/backend-requests/tenant-rbac-hardening-frontend-implementation.md`. Incluira:
- Commit SHA del merge
- Comando de migracion
- Response shapes exactos con ejemplos
- Breaking changes y como adaptar la deserializacion
- Lista de endpoints afectados

### 4.4 Deploy

El backend NO va a pushear a remoto. El deploy a produccion se coordina cuando el frontend confirme que esta listo.

---

## 5. Lo que el frontend puede empezar a preparar mientras tanto

1. **Refactor del picker "agregar miembro"**: Preparar la integracion con `GET /admin/tenants/:tenantId/eligible-users`. El contrato ya esta definido en `docs/backend-requests/tenant-members-flow-response-and-revisions.md`, seccion 3.3.

2. **Adaptar el deserializer del response de members**: El response de `GET /admin/tenants/:id/members` cambia de array plano a `{ data: [...] }` con `user` y `role` embebidos. Actualizar tipos y logica de parsing.

3. **Decidir UX para `createdAt` aproximado**: Las rows pre-migracion van a tener `createdAt` con el timestamp de la migracion. Opciones: mostrar "aprox.", ocultar para rows antiguas, o mostrar sin distincion.

4. **Implementar debounce + min 2 chars en el search del picker**: Ver ejemplo de codigo en seccion 2.5.

5. **Auditar pantallas de Cashier**: Confirmar que ninguna pantalla accesible por Cashier consuma `/admin/tenants/:id/members`. Si lo hace, migrar a `/users/assignable`.

---

## 6. Referencias

| Referencia | Ubicacion |
|---|---|
| Doc con las 5 preguntas originales | `docs/backend-requests/tenant-members-flow-response-and-revisions.md`, seccion 7 |
| Guia post-merge del SDD anterior | `docs/backend-requests/tenant-rbac-hardening-frontend-implementation.md` |
| Endpoint alternativo para Cashier | `src/users/users.controller.ts:14-18`, `src/users/users.service.ts:9-21` |
| DTO de response del endpoint alternativo | `src/users/dto/assignable-user.dto.ts:1-4` |
| Permisos del Cashier en seed | `prisma/seed.ts:278-286` |
| Decision locked | Engram observation #2059 |

---

## Changelog

| Fecha | Descripcion |
|---|---|
| 2026-05-26 | Creacion. Confirmacion de las 5 preguntas + investigacion Cashier con evidencia de codigo. |
