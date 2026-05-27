# Guía de implementación frontend — SDD `employees-module` (gestión de empleados)

> Módulo **NUEVO** completo mergeado a `main` el 27 de mayo de 2026 (commit `6623708`).
> No rompe nada existente — es 100% aditivo. 27 endpoints nuevos, 6 modelos nuevos, 6 CASL subjects nuevos.
> El módulo de empleados es **INDEPENDIENTE** del módulo de usuarios (`User`). No hay FK entre `Employee` y `User`.

---

## 1. Resumen ejecutivo

### Qué es este módulo

Un sistema de **HR / gestión de empleados** completo, totalmente separado del módulo de usuarios existente. `Employee` y `User` son entidades independientes — no comparten FK. Un `User` es alguien que se autentica en la plataforma; un `Employee` es un registro de RRHH con datos laborales, salariales, médicos y de contacto.

### Alcance

| Aspecto | Detalle |
|---|---|
| Sub-dominios | 6: Core, Salary, Position, Documents, Time-off, Emergency contacts + Org chart |
| Endpoints nuevos | 27 (ver secciones 4.1–4.6) |
| Modelos Prisma nuevos | 6: `Employee`, `EmployeeSalaryHistory`, `EmployeePositionHistory`, `EmployeeDocument`, `EmployeeTimeOff`, `EmployeeEmergencyContact` |
| Enums nuevos | 8: `ContractType`, `WorkModality`, `IdentityDocumentType`, `EmployeeStatus`, `EmployeeDocumentCategory`, `TimeOffType`, `TimeOffStatus` |
| CASL subjects nuevos | 6: `Employee`, `EmployeeSalary`, `EmployeeDocument`, `EmployeeTimeOff`, `EmployeeTimeOffMedical`, `EmployeeEmergencyContact` |
| Niveles de sensibilidad | 3 tiers (Standard, Financial, Medical) |
| Storage | DO Spaces via `FilesService` con MIME override per-call |
| Migraciones | 5 nuevas |
| Tests | 101 (13 suites) |

### CASL subjects para el frontend ability builder

El frontend **DEBE** registrar estos 6 subjects nuevos en el CASL ability builder:

```ts
'Employee'
'EmployeeSalary'
'EmployeeDocument'
'EmployeeTimeOff'
'EmployeeTimeOffMedical'
'EmployeeEmergencyContact'
```

Si usan `GET /auth/me/permissions`, los permisos de estos subjects van a aparecer en el array solo si el rol del usuario los tiene asignados.

---

## 2. Modelos de datos

### 2.1 Employee

| Campo | Tipo | Nullable | Descripción |
|---|---|---|---|
| `id` | `string` (UUID) | No | PK |
| `employeeNumber` | `string` | No | Número de empleado, único por tenant |
| `firstName` | `string` | No | Nombre |
| `lastName` | `string` | No | Apellido |
| `email` | `string` | Sí | Email personal (no es login) |
| `phone` | `string` | Sí | Teléfono |
| `dateOfBirth` | `string` (YYYY-MM-DD) | Sí | Fecha de nacimiento |
| `nationalId` | `string` | Sí | Documento de identidad |
| `nationalIdType` | `IdentityDocumentType` | Sí | Tipo: `INE`, `PASSPORT`, `DRIVER_LICENSE`, `MILITARY_ID`, `OTHER` |
| `photoFileId` | `string` (UUID) | Sí | ID del archivo de foto (FilesService) |
| `cvFileId` | `string` (UUID) | Sí | ID del archivo de CV (FilesService) |
| `street` | `string` | Sí | Calle |
| `exteriorNumber` | `string` | Sí | Número exterior |
| `interiorNumber` | `string` | Sí | Número interior |
| `zipCode` | `string` | Sí | Código postal |
| `neighborhood` | `string` | Sí | Colonia |
| `municipality` | `string` | Sí | Municipio |
| `city` | `string` | Sí | Ciudad |
| `state` | `string` | Sí | Estado |
| `hireDate` | `string` (YYYY-MM-DD) | No | Fecha de contratación |
| `terminationDate` | `string` (YYYY-MM-DD) | Sí | Fecha de baja |
| `terminationReason` | `string` | Sí | Motivo de baja |
| `status` | `EmployeeStatus` | No | `ACTIVE`, `ON_LEAVE`, `TERMINATED` |
| `currentPosition` | `string` | Sí | Puesto actual (denormalizado) |
| `currentDepartment` | `string` | Sí | Departamento actual (denormalizado) |
| `currentSalaryCents` | `number` | Sí | **SENSIBLE (Tier 2)** — Sueldo actual en centavos |
| `currentSalaryCurrency` | `string` | Sí | **SENSIBLE (Tier 2)** — Moneda (default `"MXN"`) |
| `currentResponsibilities` | `string` | Sí | Responsabilidades actuales |
| `currentSchedule` | `string` | Sí | Horario actual |
| `contractType` | `ContractType` | No | `PERMANENT`, `TEMPORARY`, `FREELANCE`, `INTERNSHIP` |
| `workModality` | `WorkModality` | No | `ONSITE`, `REMOTE`, `HYBRID` |
| `annualVacationDays` | `number` | No | Días de vacaciones anuales asignados |
| `managerId` | `string` (UUID) | Sí | Auto-referencia a otro `Employee` (jefe directo) |
| `createdAt` | `string` (ISO 8601) | No | Fecha de creación del registro |
| `updatedAt` | `string` (ISO 8601) | No | Última actualización |

### 2.2 EmployeeSalaryHistory (append-only)

| Campo | Tipo | Nullable | Descripción |
|---|---|---|---|
| `id` | `string` (UUID) | No | PK |
| `employeeId` | `string` (UUID) | No | FK a Employee |
| `amountCents` | `number` | No | Monto en centavos |
| `currency` | `string` | No | Código ISO 4217, default `"MXN"` |
| `effectiveFrom` | `string` (YYYY-MM-DD) | No | Fecha de vigencia |
| `reason` | `string` | No | Motivo del cambio |
| `recordedByUserId` | `string` (UUID) | Sí | User que registró el cambio |
| `createdAt` | `string` (ISO 8601) | No | Timestamp |

### 2.3 EmployeePositionHistory (append-only)

| Campo | Tipo | Nullable | Descripción |
|---|---|---|---|
| `id` | `string` (UUID) | No | PK |
| `employeeId` | `string` (UUID) | No | FK a Employee |
| `position` | `string` | No | Puesto nuevo |
| `department` | `string` | Sí | Departamento nuevo |
| `effectiveFrom` | `string` (YYYY-MM-DD) | No | Fecha de vigencia |
| `reason` | `string` | No | Motivo del cambio |
| `recordedByUserId` | `string` (UUID) | Sí | User que registró el cambio |
| `createdAt` | `string` (ISO 8601) | No | Timestamp |

### 2.4 EmployeeDocument

| Campo | Tipo | Nullable | Descripción |
|---|---|---|---|
| `id` | `string` (UUID) | No | PK |
| `employeeId` | `string` (UUID) | No | FK a Employee |
| `fileId` | `string` (UUID) | No | ID en FilesService |
| `category` | `EmployeeDocumentCategory` | No | `CONTRACT`, `NDA`, `EVALUATION`, `CERTIFICATE`, `WARNING`, `ID_DOCUMENT`, `CV`, `MEDICAL`, `OTHER` |
| `expiresAt` | `string` (YYYY-MM-DD) | Sí | Fecha de expiración |
| `notes` | `string` | Sí | Notas (max 500 chars). Usar como descripción del documento — no hay campo `title` (ver sección 10, desviación #1) |
| `uploadedByUserId` | `string` (UUID) | Sí | User que subió el doc |
| `createdAt` | `string` (ISO 8601) | No | Timestamp |

### 2.5 EmployeeTimeOff

| Campo | Tipo | Nullable | Descripción |
|---|---|---|---|
| `id` | `string` (UUID) | No | PK |
| `employeeId` | `string` (UUID) | No | FK a Employee |
| `type` | `TimeOffType` | No | `VACATION`, `SICK`, `PERSONAL`, `UNPAID` |
| `startDate` | `string` (YYYY-MM-DD) | No | Fecha inicio |
| `endDate` | `string` (YYYY-MM-DD) | No | Fecha fin (inclusive) |
| `reason` | `string` | Sí | **SENSIBLE (Tier 3, solo SICK)** — Motivo. En filas con `type: "SICK"`, viene como `null` si el caller no tiene `read:EmployeeTimeOffMedical` |
| `status` | `TimeOffStatus` | No | `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED` |
| `reviewerUserId` | `string` (UUID) | Sí | User que aprobó/rechazó |
| `reviewedAt` | `string` (ISO 8601) | Sí | Fecha de revisión |
| `reviewerNotes` | `string` | Sí | Notas del reviewer |
| `requestedByUserId` | `string` (UUID) | Sí | User que hizo la solicitud |
| `createdAt` | `string` (ISO 8601) | No | Timestamp |
| `updatedAt` | `string` (ISO 8601) | No | Última actualización |

### 2.6 EmployeeEmergencyContact

| Campo | Tipo | Nullable | Descripción |
|---|---|---|---|
| `id` | `string` (UUID) | No | PK |
| `employeeId` | `string` (UUID) | No | FK a Employee |
| `name` | `string` | No | Nombre completo del contacto |
| `relationship` | `string` | No | Parentesco (free text: "Esposa", "Padre", etc.) |
| `phone` | `string` | No | Teléfono |
| `email` | `string` | Sí | Email del contacto |
| `createdAt` | `string` (ISO 8601) | No | Timestamp |
| `updatedAt` | `string` (ISO 8601) | No | Última actualización |

---

## 3. Sistema de permisos (CASL)

### 3.1 Subjects y actions

| Subject | Actions | Tier | Descripción |
|---|---|---|---|
| `Employee` | `create`, `read`, `update`, `delete`, `manage` | Tier 1 — Standard | CRUD completo de empleados. `update` también cubre terminate/reactivate y position-history |
| `EmployeeSalary` | `create`, `read`, `manage` | Tier 2 — Financial | Datos de sueldo. Sin `read:EmployeeSalary`, los campos `currentSalaryCents` y `currentSalaryCurrency` se **OMITEN** del JSON |
| `EmployeeDocument` | `create`, `read`, `delete`, `manage` | Tier 1 — Standard | CRUD de documentos. No hay `update` — los documentos se reemplazan borrando + subiendo |
| `EmployeeTimeOff` | `create`, `read`, `update`, `delete`, `manage` | Tier 1 — Standard | Solicitudes de ausencia. `update` cubre review (aprobar/rechazar) y cancel |
| `EmployeeTimeOffMedical` | `read` | Tier 3 — Medical | Solo `read`. Sin este permiso, el `reason` de filas SICK llega como `null` |
| `EmployeeEmergencyContact` | `create`, `read`, `update`, `delete`, `manage` | Tier 1 — Standard | Contactos de emergencia |

### 3.2 Los 3 tiers de sensibilidad

| Tier | Permiso que lo controla | Qué se oculta | Cómo llega al frontend |
|---|---|---|---|
| **Tier 1 — Standard** | `read:Employee` | Nada — datos generales del empleado | Acceso normal al recurso |
| **Tier 2 — Financial** | `read:EmployeeSalary` | `currentSalaryCents` + `currentSalaryCurrency` | **OMITIDOS del JSON** (no null, directamente no existen en el objeto) |
| **Tier 3 — Medical** | `read:EmployeeTimeOffMedical` | `reason` en filas SICK | Llega como `null` (la key existe pero el valor es null) |

Importante para el frontend:

- **Tier 2** es `delete` del campo — si hacen `employee.currentSalaryCents` va a ser `undefined`, no `null`. Chequear con `'currentSalaryCents' in employee`.
- **Tier 3** es `null` del valor — `timeOff.reason` es `null` pero la key `reason` sí existe en el JSON.
- Para UI guards, usar `can('read', 'EmployeeSalary')` y `can('read', 'EmployeeTimeOffMedical')` para decidir si mostrar columnas/secciones.

---

## 4. Endpoints

Todos los endpoints usan:
- **Auth**: JWT obligatorio (`JwtAuthGuard`)
- **Multi-tenancy**: `TenantContextGuard` — el tenantId se extrae del JWT, NO se pasa como parámetro
- **Permisos**: `PermissionsGuard` + `@RequirePermissions`

Los path params UUID (`id`, `employeeId`, `docId`, `timeOffId`, `contactId`) son validados con `ParseUUIDPipe` — UUIDs malformados devuelven 400 automáticamente.

### 4.1 Empleados (core CRUD) — 8 endpoints

#### POST `/admin/employees` — Crear empleado

| Aspecto | Valor |
|---|---|
| Permiso | `create:Employee` |
| HTTP | 201 Created |
| Controller | `src/employees/employees.controller.ts:29-34` |

**Request body** (`CreateEmployeeDto`):

```json
{
  "employeeNumber": "EMP-001",
  "firstName": "Juan",
  "lastName": "García",
  "hireDate": "2026-01-15",
  "email": "juan@empresa.com",
  "phone": "+5215512345678",
  "dateOfBirth": "1990-03-20",
  "nationalId": "ABCD123456",
  "nationalIdType": "INE",
  "photoFileId": "uuid-del-archivo",
  "cvFileId": "uuid-del-archivo",
  "street": "Av. Reforma",
  "exteriorNumber": "222",
  "interiorNumber": "4B",
  "zipCode": "06600",
  "neighborhood": "Juárez",
  "municipality": "Cuauhtémoc",
  "city": "CDMX",
  "state": "CDMX",
  "contractType": "PERMANENT",
  "workModality": "HYBRID",
  "currentPosition": "Analista",
  "currentDepartment": "Finanzas",
  "currentSchedule": "L-V 9:00-18:00",
  "currentResponsibilities": "Análisis financiero",
  "annualVacationDays": 12,
  "managerId": "uuid-del-manager"
}
```

Campos obligatorios: `employeeNumber`, `firstName`, `lastName`, `hireDate`. Todo lo demás es opcional.

`employeeNumber` es único por tenant. Si se repite → 409 con `EMPLOYEE_NUMBER_CONFLICT`.

`photoFileId` y `cvFileId` son UUIDs de archivos previamente subidos vía FilesService.

`managerId` es el UUID de otro Employee del mismo tenant. Si no existe → 404 con `EMPLOYEE_NOT_FOUND`.

**Response**: Objeto `Employee` completo (ver modelo 2.1), sin campos salary si el caller no tiene `read:EmployeeSalary`.

---

#### GET `/admin/employees` — Listar empleados

| Aspecto | Valor |
|---|---|
| Permiso | `read:Employee` |
| HTTP | 200 OK |
| Controller | `src/employees/employees.controller.ts:36-40` |

**Query params**:

| Param | Tipo | Default | Descripción |
|---|---|---|---|
| `status` | `'active' \| 'terminated' \| 'all'` | `'active'` | Filtro por estado |
| `managerId` | `string` (UUID) | — | Filtrar por manager directo |
| `search` | `string` | — | Búsqueda en `firstName`, `lastName`, `employeeNumber` |
| `page` | `number` | `1` | Página (min 1) |
| `pageSize` | `number` | `20` | Items por página (min 1, max 100) |

**Response**:

```json
{
  "data": [
    { /* Employee */ }
  ],
  "total": 42,
  "page": 1,
  "limit": 20,
  "pageSize": 20
}
```

Los campos `currentSalaryCents` y `currentSalaryCurrency` se **OMITEN** de cada item si el caller no tiene `read:EmployeeSalary`.

---

#### GET `/admin/employees/:id` — Obtener empleado por ID

| Aspecto | Valor |
|---|---|
| Permiso | `read:Employee` |
| HTTP | 200 OK |
| Controller | `src/employees/employees.controller.ts:42-46` |

**Response**: Objeto `Employee` completo. Errores: `EMPLOYEE_NOT_FOUND` (404).

---

#### PATCH `/admin/employees/:id` — Actualizar empleado

| Aspecto | Valor |
|---|---|
| Permiso | `update:Employee` |
| HTTP | 200 OK |
| Controller | `src/employees/employees.controller.ts:48-55` |

**Request body** (`UpdateEmployeeDto`): Todos los campos de `CreateEmployeeDto` excepto `hireDate`, y todos opcionales (partial update).

Si se envía `managerId`, el backend valida que no se genere un ciclo en el organigrama (auto-referencia directa o indirecta). Errores posibles: `MANAGER_SELF_REFERENCE`, `MANAGER_CYCLE`.

Si se envía `employeeNumber` y ya existe en el tenant → `EMPLOYEE_NUMBER_CONFLICT`.

---

#### POST `/admin/employees/:id/terminate` — Dar de baja

| Aspecto | Valor |
|---|---|
| Permiso | `update:Employee` |
| HTTP | 200 OK |
| Controller | `src/employees/employees.controller.ts:57-64` |

**Request body** (`TerminateEmployeeDto`):

```json
{
  "terminationDate": "2026-05-27",
  "terminationReason": "Renuncia voluntaria"
}
```

Ambos campos son obligatorios. Si el empleado ya está `TERMINATED` → `EMPLOYEE_ALREADY_TERMINATED`.

---

#### POST `/admin/employees/:id/reactivate` — Reactivar

| Aspecto | Valor |
|---|---|
| Permiso | `update:Employee` |
| HTTP | 200 OK |
| Controller | `src/employees/employees.controller.ts:66-70` |

Sin body. Limpia `terminationDate` y `terminationReason`, cambia status a `ACTIVE`. Si no está `TERMINATED` → `EMPLOYEE_NOT_TERMINATED`.

---

#### GET `/admin/employees/:id/subordinates` — Subordinados directos

| Aspecto | Valor |
|---|---|
| Permiso | `read:Employee` |
| HTTP | 200 OK |
| Controller | `src/employees/employees.controller.ts:72-76` |

**Response**: Array de `Employee` (solo reportes directos, no recursivo). Con salary stripping aplicado.

---

#### GET `/admin/employees/:id/manager-chain` — Cadena de managers

| Aspecto | Valor |
|---|---|
| Permiso | `read:Employee` |
| HTTP | 200 OK |
| Controller | `src/employees/employees.controller.ts:78-82` |

**Response**: Array de `Employee`, desde el manager directo hasta el top. Max 50 niveles (defensive cap, ver `employees.service.ts:212`). Con salary stripping aplicado.

Útil para renderizar el path en un breadcrumb de organigrama: `[Manager directo, Manager del manager, ..., CEO]`.

---

### 4.2 Historial de sueldos — 2 endpoints

#### POST `/admin/employees/:employeeId/salary-history` — Registrar cambio de sueldo

| Aspecto | Valor |
|---|---|
| Permiso | `create:EmployeeSalary` |
| HTTP | 201 Created |
| Controller | `src/employees/employee-salary.controller.ts:25-38` |

**Request body** (`AddSalaryChangeDto`):

```json
{
  "amountCents": 4500000,
  "currency": "MXN",
  "effectiveFrom": "2026-06-01",
  "reason": "Aumento anual por desempeño"
}
```

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `amountCents` | `number` | Sí | Entero, min 1. En centavos (ej: $45,000.00 = 4500000) |
| `currency` | `string` | No | ISO 4217, exactamente 3 chars. Default `"MXN"` |
| `effectiveFrom` | `string` | Sí | Fecha ISO (YYYY-MM-DD) |
| `reason` | `string` | Sí | Motivo del cambio, min 1 char |

La operación es **append-only + atómica**: en una sola transacción crea la fila en `EmployeeSalaryHistory` y actualiza `currentSalaryCents` + `currentSalaryCurrency` en `Employee` (`employee-salary.service.ts:28-47`).

**Response**: Objeto `EmployeeSalaryHistory` creado.

---

#### GET `/admin/employees/:employeeId/salary-history` — Listar historial de sueldos

| Aspecto | Valor |
|---|---|
| Permiso | `read:EmployeeSalary` |
| HTTP | 200 OK |
| Controller | `src/employees/employee-salary.controller.ts:40-44` |

**Response**: Array de `EmployeeSalaryHistory`, ordenado por `effectiveFrom` desc (más reciente primero).

---

### 4.3 Historial de posiciones — 2 endpoints

#### POST `/admin/employees/:employeeId/position-history` — Registrar cambio de posición

| Aspecto | Valor |
|---|---|
| Permiso | `update:Employee` |
| HTTP | 201 Created |
| Controller | `src/employees/employee-position.controller.ts:25-38` |

**Request body** (`AddPositionChangeDto`):

```json
{
  "position": "Gerente de Finanzas",
  "department": "Finanzas",
  "effectiveFrom": "2026-06-01",
  "reason": "Promoción"
}
```

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `position` | `string` | Sí | Puesto nuevo, min 1 char |
| `department` | `string` | No | Departamento nuevo |
| `effectiveFrom` | `string` | Sí | Fecha ISO (YYYY-MM-DD) |
| `reason` | `string` | Sí | Motivo, min 1 char |

Operación **append-only + atómica**: crea fila en `EmployeePositionHistory` y actualiza `currentPosition` + `currentDepartment` en `Employee` (`employee-position.service.ts:27-46`).

El permiso es `update:Employee` (no `EmployeeSalary`), porque cambiar de posición es una operación sobre el empleado, no sobre datos salariales.

**Response**: Objeto `EmployeePositionHistory` creado.

---

#### GET `/admin/employees/:employeeId/position-history` — Listar historial de posiciones

| Aspecto | Valor |
|---|---|
| Permiso | `read:Employee` |
| HTTP | 200 OK |
| Controller | `src/employees/employee-position.controller.ts:40-44` |

**Response**: Array de `EmployeePositionHistory`, ordenado por `effectiveFrom` desc.

---

### 4.4 Documentos — 5 endpoints

**MIME types permitidos**: `application/pdf`, `application/msword` (DOC), `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (DOCX), `image/jpeg`, `image/png`, `image/webp`.

Cualquier otro MIME → error de validación de `FilesService`.

#### POST `/admin/employees/:employeeId/documents` — Upload de documento

| Aspecto | Valor |
|---|---|
| Permiso | `create:EmployeeDocument` |
| HTTP | 201 Created |
| Content-Type | `multipart/form-data` |
| Controller | `src/employees/employee-documents.controller.ts:33-54` |

**Form data fields**:

| Field | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `file` | `File` | Sí | El archivo binario |
| `category` | `EmployeeDocumentCategory` | Sí | `CONTRACT`, `NDA`, `EVALUATION`, `CERTIFICATE`, `WARNING`, `ID_DOCUMENT`, `CV`, `MEDICAL`, `OTHER` |
| `expiresAt` | `string` | No | Fecha ISO (YYYY-MM-DD) de expiración |
| `notes` | `string` | No | Notas descriptivas, max 500 chars. Usar como nombre/título del documento |

El `file` se manda como campo del multipart. Los campos `category`, `expiresAt`, `notes` van en el body del multipart (no como query params).

**Response**: Objeto `EmployeeDocument` creado (con `fileId` para futura descarga).

---

#### GET `/admin/employees/:employeeId/documents` — Listar documentos

| Aspecto | Valor |
|---|---|
| Permiso | `read:EmployeeDocument` |
| HTTP | 200 OK |
| Controller | `src/employees/employee-documents.controller.ts:59-66` |

**Query params**:

| Param | Tipo | Default | Descripción |
|---|---|---|---|
| `category` | `EmployeeDocumentCategory` | — | Filtrar por categoría |
| `expiringWithinDays` | `number` | — | Documentos que expiran dentro de N días |
| `page` | `number` | `1` | Página |
| `pageSize` | `number` | `20` | Items por página (max 100) |

**Response**:

```json
{
  "data": [{ /* EmployeeDocument */ }],
  "total": 5,
  "page": 1,
  "limit": 20
}
```

---

#### GET `/admin/employees/:employeeId/documents/:docId/download` — Info de descarga

| Aspecto | Valor |
|---|---|
| Permiso | `read:EmployeeDocument` |
| HTTP | 200 OK |
| Controller | `src/employees/employee-documents.controller.ts:71-78` |

**Response**:

```json
{
  "fileId": "uuid-del-archivo-en-files-service"
}
```

El frontend usa este `fileId` para llamar a `GET /files/:fileId` (o el endpoint equivalente de descarga de FilesService). No se devuelve una signed URL directamente — hay que hacer el segundo call.

---

#### DELETE `/admin/employees/:employeeId/documents/:docId` — Eliminar documento

| Aspecto | Valor |
|---|---|
| Permiso | `delete:EmployeeDocument` |
| HTTP | 204 No Content |
| Controller | `src/employees/employee-documents.controller.ts:83-91` |

Sin body. Borra primero el registro en DB, luego intenta borrar el blob en DO Spaces (best-effort — si falla el blob, se loguea pero no tira error al cliente).

---

#### GET `/admin/employees-documents/expiring` — Documentos próximos a vencer (tenant-wide)

| Aspecto | Valor |
|---|---|
| Permiso | `read:EmployeeDocument` |
| HTTP | 200 OK |
| Controller | `src/employees/employee-documents.controller.ts:96-101` |

**Query params**:

| Param | Tipo | Default | Descripción |
|---|---|---|---|
| `daysUntilExpiry` | `number` (string en URL, se parsea con `parseInt`) | `30` | Documentos que expiran dentro de N días |

**Response**: Array de `EmployeeDocument` (de TODOS los empleados del tenant), ordenado por `expiresAt` asc (los que expiran antes, primero).

Notar que la ruta es `/admin/employees-documents/expiring` (con guión, plural), NO bajo un `:employeeId` — es una vista global del tenant.

---

### 4.5 Ausencias / Time-off — 6 endpoints

#### POST `/admin/employees/:employeeId/time-off` — Solicitar ausencia

| Aspecto | Valor |
|---|---|
| Permiso | `create:EmployeeTimeOff` |
| HTTP | 201 Created |
| Controller | `src/employees/employee-time-off.controller.ts:30-43` |

**Request body** (`CreateTimeOffDto`):

```json
{
  "type": "VACATION",
  "startDate": "2026-07-01",
  "endDate": "2026-07-05",
  "reason": "Vacaciones de verano"
}
```

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `type` | `TimeOffType` | Sí | `VACATION`, `SICK`, `PERSONAL`, `UNPAID` |
| `startDate` | `string` | Sí | Fecha ISO (YYYY-MM-DD) |
| `endDate` | `string` | Sí | Fecha ISO (YYYY-MM-DD), inclusive. Debe ser >= startDate |
| `reason` | `string` | No | Motivo, max 500 chars |

Si `endDate < startDate` → `TIME_OFF_INVALID_DATE_RANGE`.

Se crea con `status: "PENDING"`. Requiere posterior aprobación vía review.

**Response**: Objeto `EmployeeTimeOff` creado.

---

#### GET `/admin/employees/:employeeId/time-off` — Listar ausencias del empleado

| Aspecto | Valor |
|---|---|
| Permiso | `read:EmployeeTimeOff` |
| HTTP | 200 OK |
| Controller | `src/employees/employee-time-off.controller.ts:46-54` |

**Query params**:

| Param | Tipo | Default | Descripción |
|---|---|---|---|
| `status` | `TimeOffStatus` | — | Filtrar: `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED` |
| `year` | `number` | — | Filtrar por año (2000-2100) |
| `page` | `number` | `1` | Página |
| `pageSize` | `number` | `20` | Items por página (max 100) |

**Response**:

```json
{
  "data": [{ /* EmployeeTimeOff, con reason stripped si SICK sin permiso médico */ }],
  "total": 10,
  "page": 1,
  "limit": 20
}
```

---

#### GET `/admin/employees/:employeeId/time-off/vacation-balance` — Balance de vacaciones

| Aspecto | Valor |
|---|---|
| Permiso | `read:EmployeeTimeOff` |
| HTTP | 200 OK |
| Controller | `src/employees/employee-time-off.controller.ts:57-64` |

**Query params**:

| Param | Tipo | Default | Descripción |
|---|---|---|---|
| `year` | `number` | Año actual (UTC) | Año calendario para el cálculo |

**Response**:

```json
{
  "year": 2026,
  "entitlement": 12,
  "used": 5,
  "pending": 3,
  "remaining": 7
}
```

| Campo | Cálculo |
|---|---|
| `entitlement` | `employee.annualVacationDays` |
| `used` | Total de días APPROVED + VACATION en el año |
| `pending` | Total de días PENDING + VACATION en el año |
| `remaining` | `entitlement - used` (no resta pending) |

Días se calculan como `(endDate - startDate) / 86400000 + 1` en UTC. Es un cálculo server-side, no persistido — ver sección 10, desviación #5.

---

#### POST `/admin/employees/:employeeId/time-off/:timeOffId/review` — Aprobar o rechazar

| Aspecto | Valor |
|---|---|
| Permiso | `update:EmployeeTimeOff` |
| HTTP | 200 OK |
| Controller | `src/employees/employee-time-off.controller.ts:67-82` |

**Request body** (`ReviewTimeOffDto`):

```json
{
  "decision": "APPROVED",
  "reviewerNotes": "Aprobado, buen timing"
}
```

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `decision` | `'APPROVED' \| 'REJECTED'` | Sí | Solo estos dos valores |
| `reviewerNotes` | `string` | No | Notas del reviewer, max 500 chars |

Solo funciona si el status actual es `PENDING`. Si no → `TIME_OFF_INVALID_TRANSITION`.

Guarda `reviewerUserId`, `reviewedAt` (timestamp del momento), y `reviewerNotes`.

---

#### POST `/admin/employees/:employeeId/time-off/:timeOffId/cancel` — Cancelar ausencia

| Aspecto | Valor |
|---|---|
| Permiso | `update:EmployeeTimeOff` |
| HTTP | 200 OK |
| Controller | `src/employees/employee-time-off.controller.ts:85-93` |

Sin body. Se puede cancelar si:
- Status es `PENDING` (siempre)
- Status es `APPROVED` Y `startDate` es futuro (todavía no empezó)

Cualquier otro caso → `TIME_OFF_INVALID_TRANSITION`.

---

#### GET `/admin/employees-time-off/pending-approvals` — Aprobaciones pendientes (manager view)

| Aspecto | Valor |
|---|---|
| Permiso | `read:EmployeeTimeOff` |
| HTTP | 200 OK |
| Controller | `src/employees/employee-time-off.controller.ts:96-101` |

**Query params**:

| Param | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `managerId` | `string` (UUID) | Sí | ID del Employee que es manager |

Ruta: `/admin/employees-time-off/pending-approvals` (con guión, NO bajo un `:employeeId`).

**Response**: Array de `EmployeeTimeOff` con `status: "PENDING"` de todos los subordinados directos del manager. Ordenado por `startDate` asc (los más próximos primero). Con medical reason stripping aplicado.

Si el manager no tiene subordinados → array vacío `[]`.

---

### 4.6 Contactos de emergencia — 4 endpoints

#### POST `/admin/employees/:employeeId/emergency-contacts` — Crear contacto

| Aspecto | Valor |
|---|---|
| Permiso | `create:EmployeeEmergencyContact` |
| HTTP | 201 Created |
| Controller | `src/employees/employee-emergency-contacts.controller.ts:31-39` |

**Request body** (`CreateEmergencyContactDto`):

```json
{
  "name": "María García",
  "relationship": "Esposa",
  "phone": "+5215598765432",
  "email": "maria@email.com"
}
```

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `name` | `string` | Sí | 1-120 chars |
| `relationship` | `string` | Sí | 1-60 chars, free text |
| `phone` | `string` | Sí | 1-40 chars |
| `email` | `string` | No | Email válido, max 255 chars |

---

#### GET `/admin/employees/:employeeId/emergency-contacts` — Listar contactos

| Aspecto | Valor |
|---|---|
| Permiso | `read:EmployeeEmergencyContact` |
| HTTP | 200 OK |
| Controller | `src/employees/employee-emergency-contacts.controller.ts:41-45` |

**Response**: Array de `EmployeeEmergencyContact`. No hay paginación — se espera un número pequeño de contactos por empleado.

No hay campo `isPrimary`. Convencionalmente, el primer contacto (por `createdAt` asc) se considera el primario — ver sección 10, desviación #3.

---

#### PATCH `/admin/employees/:employeeId/emergency-contacts/:contactId` — Actualizar contacto

| Aspecto | Valor |
|---|---|
| Permiso | `update:EmployeeEmergencyContact` |
| HTTP | 200 OK |
| Controller | `src/employees/employee-emergency-contacts.controller.ts:47-55` |

**Request body** (`UpdateEmergencyContactDto`): Todos los campos de create, todos opcionales (partial update).

---

#### DELETE `/admin/employees/:employeeId/emergency-contacts/:contactId` — Eliminar contacto

| Aspecto | Valor |
|---|---|
| Permiso | `delete:EmployeeEmergencyContact` |
| HTTP | 204 No Content |
| Controller | `src/employees/employee-emergency-contacts.controller.ts:57-65` |

Sin body. Si el contacto no existe o no pertenece al empleado → `EMERGENCY_CONTACT_NOT_FOUND`.

---

## 5. Flujos comunes (con ejemplos)

### 5.1 Crear empleado con foto y CV

Flujo en 3 pasos — no es un solo request:

```ts
// Paso 1: Subir la foto via FilesService (endpoint existente)
const photoRes = await api.post('/files/upload', photoFormData);
const photoFileId = photoRes.data.id;

// Paso 2: Subir el CV via FilesService
const cvRes = await api.post('/files/upload', cvFormData);
const cvFileId = cvRes.data.id;

// Paso 3: Crear el empleado con las referencias
const employee = await api.post('/admin/employees', {
  employeeNumber: 'EMP-042',
  firstName: 'Ana',
  lastName: 'López',
  hireDate: '2026-06-01',
  photoFileId,
  cvFileId,
  currentPosition: 'Diseñadora UX',
  currentDepartment: 'Producto',
  annualVacationDays: 15,
});
```

### 5.2 Cambio de sueldo

```ts
// Un solo POST — atómicamente crea historial y actualiza Employee.currentSalaryCents
await api.post(`/admin/employees/${employeeId}/salary-history`, {
  amountCents: 5000000, // $50,000.00 MXN
  currency: 'MXN',
  effectiveFrom: '2026-07-01',
  reason: 'Aumento por evaluación de desempeño',
});
```

### 5.3 Promoción / cambio de posición

```ts
// Un solo POST — atómicamente crea historial y actualiza Employee.currentPosition/Department
await api.post(`/admin/employees/${employeeId}/position-history`, {
  position: 'Lead de Diseño',
  department: 'Producto',
  effectiveFrom: '2026-07-01',
  reason: 'Promoción por desempeño excepcional',
});
```

### 5.4 Solicitud + aprobación de vacaciones

```ts
// Paso 1: El empleado (o su manager) solicita
const timeOff = await api.post(`/admin/employees/${employeeId}/time-off`, {
  type: 'VACATION',
  startDate: '2026-08-01',
  endDate: '2026-08-10',
  reason: 'Viaje familiar',
});
// timeOff.data.status === 'PENDING'

// Paso 2: El manager aprueba
await api.post(
  `/admin/employees/${employeeId}/time-off/${timeOff.data.id}/review`,
  { decision: 'APPROVED', reviewerNotes: 'Aprobado' },
);
```

### 5.5 Picker de manager (usar GET /admin/employees)

Para el dropdown de "Seleccionar manager" en el form de crear/editar empleado:

```ts
const { data: managers } = useQuery({
  queryKey: ['employees', 'active'],
  queryFn: () =>
    api.get<EmployeeListResponse>('/admin/employees', {
      params: { status: 'active', pageSize: 100 },
    }),
  select: (res) => res.data.data,
});

// Filtrar el empleado actual (no puede ser su propio manager)
const options = managers?.filter((m) => m.id !== currentEmployeeId) ?? [];
```

### 5.6 Dashboard de documentos próximos a vencer

```ts
const { data: expiring } = useQuery({
  queryKey: ['employee-docs', 'expiring', 60],
  queryFn: () =>
    api.get<EmployeeDocument[]>('/admin/employees-documents/expiring', {
      params: { daysUntilExpiry: 60 },
    }),
  select: (res) => res.data,
});

// Renderizar tabla con: employeeId, category, expiresAt, notes
// Incluir link a "Ver empleado" para cada fila
```

### 5.7 Upload de documento de empleado

```ts
const formData = new FormData();
formData.append('file', selectedFile); // File object del input
formData.append('category', 'CONTRACT');
formData.append('expiresAt', '2027-06-01');
formData.append('notes', 'Contrato renovación 2026-2027');

const doc = await api.post(
  `/admin/employees/${employeeId}/documents`,
  formData,
  { headers: { 'Content-Type': 'multipart/form-data' } },
);
// doc.data = EmployeeDocument con fileId para posterior descarga
```

---

## 6. Stripping de campos sensibles

### 6.1 Tier 2 — Financial (salary stripping)

**Implementación**: `src/employees/application/employees.service.ts:302-309`

```ts
stripSensitiveFields(response: any, ability?: AppAbility) {
  const result = { ...response };
  if (!ability || !ability.can('read', 'EmployeeSalary')) {
    delete result.currentSalaryCents;
    delete result.currentSalaryCurrency;
  }
  return result;
}
```

Llamado en: `findOne`, `findAll`, `findSubordinates`, `findManagerChain`.

**Para el frontend**: Sin `read:EmployeeSalary`, los campos `currentSalaryCents` y `currentSalaryCurrency` **NO EXISTEN** en el JSON de respuesta. No son null — están `delete`-ados del objeto.

```ts
// Chequeo correcto
if ('currentSalaryCents' in employee) {
  // El user tiene read:EmployeeSalary — mostrar sueldo
  formatCurrency(employee.currentSalaryCents, employee.currentSalaryCurrency);
} else {
  // No tiene permiso — ocultar columna/sección
}
```

### 6.2 Tier 3 — Medical (SICK reason stripping)

**Implementación**: `src/employees/application/employee-time-off.service.ts:222-231`

```ts
private stripMedicalReason(row: any, ability?: AppAbility): any {
  const copy = { ...row };
  if (
    copy.type === 'SICK' &&
    (!ability || !ability.can('read', 'EmployeeTimeOffMedical'))
  ) {
    copy.reason = null;
  }
  return copy;
}
```

Llamado en: `listForEmployee`, `listPendingApprovalsForManager`.

**Para el frontend**: En filas con `type: "SICK"`, el campo `reason` viene como `null` si el caller no tiene `read:EmployeeTimeOffMedical`. La key `reason` SÍ existe — solo el valor es null.

Nota: los controllers actuales NO pasan la `ability` al service (ver `employee-time-off.controller.ts:53` y `:100`). Esto significa que **actualmente el stripping SIEMPRE se aplica** para SICK reasons, independientemente del permiso del caller. Si esto cambia en el futuro, el frontend debería chequear `can('read', 'EmployeeTimeOffMedical')` para decidir si mostrar una columna de "Motivo médico".

---

## 7. Multi-tenancy

- **Nunca pasar `tenantId`** en los requests. Se extrae automáticamente del JWT vía `TenantContextGuard`.
- Todos los 6 modelos están registrados en `TENANT_SCOPED_MODELS` (`src/shared/tenant/tenant-scoped-models.constant.ts`).
- `employeeNumber` es único **por tenant**: dos tenants diferentes pueden tener un empleado con `employeeNumber: "EMP-001"` sin conflicto.
- Todas las queries están scoped por tenant de forma transparente vía `TenantPrismaService`.

---

## 8. Errores y códigos de dominio

Todos los errores de dominio pasan por `DomainExceptionFilter` y tienen este shape HTTP:

```json
{
  "statusCode": 400,
  "message": "Human-readable description",
  "error": "DOMAIN_ERROR_CODE"
}
```

**El código de dominio va en `error`, NO en `message`** (a diferencia de los errores de NestJS estándar donde el code va en `message`).

| Código de dominio | HTTP | Cuándo ocurre |
|---|---|---|
| `EMPLOYEE_NOT_FOUND` | 404 | Employee ID no existe en el tenant |
| `EMPLOYEE_NUMBER_CONFLICT` | 409 | `employeeNumber` duplicado en el mismo tenant |
| `MANAGER_CYCLE` | 400 | El managerId propuesto genera un ciclo en el organigrama |
| `MANAGER_SELF_REFERENCE` | 400 | Se intentó asignar al empleado como su propio manager |
| `EMPLOYEE_ALREADY_TERMINATED` | 400 | Se intentó terminar un empleado ya terminado |
| `EMPLOYEE_NOT_TERMINATED` | 400 | Se intentó reactivar un empleado que no está terminado |
| `TIME_OFF_NOT_FOUND` | 404 | TimeOff ID no existe o no pertenece al empleado |
| `TIME_OFF_INVALID_TRANSITION` | 400 | Transición de estado inválida (ej: aprobar un CANCELLED) |
| `TIME_OFF_INVALID_DATE_RANGE` | 400 | `endDate` anterior a `startDate` |
| `EMPLOYEE_DOCUMENT_NOT_FOUND` | 404 | Document ID no existe o no pertenece al empleado |
| `EMERGENCY_CONTACT_NOT_FOUND` | 404 | Contact ID no existe o no pertenece al empleado |

Errores genéricos de NestJS (no son domain errors):

| HTTP | Cuándo |
|---|---|
| 400 | Validación de class-validator (DTO malformado, UUID inválido, tipo de dato incorrecto) |
| 401 | Sin JWT o JWT expirado |
| 403 | Sin el permiso CASL requerido |

---

## 9. Migraciones aplicadas

Las siguientes 5 migraciones se ejecutan automáticamente vía `pnpm prisma migrate deploy` en producción. Si el frontend tiene una replica local del schema para desarrollo, correr `pnpm prisma migrate dev`.

| # | Migración | Qué crea |
|---|---|---|
| 1 | `20260527033813_add_employees_core` | Tabla `employees` + enums `EmployeeStatus`, `ContractType`, `WorkModality`, `IdentityDocumentType` + índices |
| 2 | `20260527042948_add_employee_history` | Tablas `employee_salary_history` + `employee_position_history` (append-only) |
| 3 | `20260527050123_add_employee_documents` | Tabla `employee_documents` + enum `EmployeeDocumentCategory` |
| 4 | `20260527053312_add_employee_time_off` | Tabla `employee_time_off` + enums `TimeOffType`, `TimeOffStatus` |
| 5 | `20260527060716_add_employee_emergency_contacts` | Tabla `employee_emergency_contacts` |

---

## 10. Desviaciones conocidas vs spec original

Estos son deltas intencionales entre la spec de diseño y la implementación final. Todos aceptados para v1.

### Desviación #1: EmployeeDocument sin campo `title`

La spec definía un campo `title: String` en `EmployeeDocument`. La implementación lo omite. Los documentos se identifican por `category` + nombre del archivo (que viene de FilesService).

**Para el frontend**: Usar `notes` como descripción/título del documento. Si necesitan mostrar un nombre, usar el nombre original del archivo vía FilesService.

### Desviación #2: EmployeeDocument sin campo `alertBeforeDays`

La spec definía `alertBeforeDays: Int? @default(30)` para umbrales de alerta per-documento. La implementación lo omite porque no hay cron de alertas en v1.

**Para el frontend**: Controlar el umbral desde el cliente usando el query param `expiringWithinDays` en `GET .../documents` o `daysUntilExpiry` en `GET /admin/employees-documents/expiring`. Hardcodear 30, 60, 90 días como opciones del filtro.

### Desviación #3: EmergencyContact sin campo `isPrimary`

La spec definía `isPrimary: Boolean @default(false)`. La implementación lo omite.

**Para el frontend**: Convención — el primer contacto (ordenado por `createdAt` asc) se considera primario. Marcar visualmente el primero de la lista como "Contacto principal" sin necesidad de un campo en el modelo.

### Desviación #4: TimeOffType usa `SICK` (no `SICK_LEAVE`), sin `OTHER`

La spec definía `TimeOffType { VACATION, SICK_LEAVE, PERSONAL, UNPAID, OTHER }`. La implementación usa `{ VACATION, SICK, PERSONAL, UNPAID }`.

**Para el frontend**: El enum es `SICK`, NO `SICK_LEAVE`. Usar este valor en todos los selects, filtros, y lógica de rendering. No existe `OTHER` — mapear los labels como:

```ts
const TIME_OFF_TYPE_LABELS: Record<string, string> = {
  VACATION: 'Vacaciones',
  SICK: 'Enfermedad',
  PERSONAL: 'Personal',
  UNPAID: 'Sin goce',
};
```

### Desviación #5: EmployeeTimeOff sin campo `days` persistido

La spec decía que `days` debía persistirse como `(endDate - startDate + 1)`. La implementación lo computa dinámicamente.

**Para el frontend**: Calcular los días en el cliente cuando se necesite mostrarlos:

```ts
function daysInclusive(startDate: string, endDate: string): number {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  return Math.round((end - start) / 86400000) + 1;
}
```

Usar UTC para evitar problemas de timezone. Las fechas vienen como `YYYY-MM-DD` (DATE, sin hora).

---

## 11. V2 backlog explícito

Lo siguiente **NO** está implementado y queda para futuras iteraciones. Si el frontend construye UI para alguna de estas features, no va a tener backend detrás todavía:

### Features de módulo

1. Onboarding/offboarding checklists
2. Performance reviews / evaluaciones de desempeño
3. Training/certification tracking
4. Asset assignment (asignación de equipo/herramientas)
5. Document expiration cron alerts (el query existe, la alerta automática no)
6. Country-specific fields (CURP, RFC, NSS, IMSS)
7. Department/Position master tables (hoy son strings libres)
8. Half-day time-off / ausencias por horas
9. Matrix org / múltiples managers
10. Employee ↔ User linkage (asociar un Employee con un User del sistema)
11. Auto-generación de `employeeNumber`

### Campos pendientes (de desviaciones)

12. `EmployeeDocument.title` — campo de título para documentos
13. `EmployeeDocument.alertBeforeDays` — umbral de alerta por documento
14. `EmployeeEmergencyContact.isPrimary` — designación explícita de contacto primario
15. `EmployeeTimeOff.days` — campo persistido para reporting
16. `TimeOffType.OTHER` — variante adicional de tipo de ausencia

### Mejoras de arquitectura

17. Repository ports separados por aggregate (hoy es 1 repo + Prisma directo)
18. Domain entity layer (hoy los services operan sobre tipos de Prisma)
19. Manager chain max depth 20 + flag `truncated` en respuesta
20. Per-aggregate repository DI symbols para testing más granular

---

## Tabla resumen de los 27 endpoints

| # | Método | Path | Permiso | Sección |
|---|---|---|---|---|
| 1 | POST | `/admin/employees` | `create:Employee` | 4.1 |
| 2 | GET | `/admin/employees` | `read:Employee` | 4.1 |
| 3 | GET | `/admin/employees/:id` | `read:Employee` | 4.1 |
| 4 | PATCH | `/admin/employees/:id` | `update:Employee` | 4.1 |
| 5 | POST | `/admin/employees/:id/terminate` | `update:Employee` | 4.1 |
| 6 | POST | `/admin/employees/:id/reactivate` | `update:Employee` | 4.1 |
| 7 | GET | `/admin/employees/:id/subordinates` | `read:Employee` | 4.1 |
| 8 | GET | `/admin/employees/:id/manager-chain` | `read:Employee` | 4.1 |
| 9 | POST | `/admin/employees/:employeeId/salary-history` | `create:EmployeeSalary` | 4.2 |
| 10 | GET | `/admin/employees/:employeeId/salary-history` | `read:EmployeeSalary` | 4.2 |
| 11 | POST | `/admin/employees/:employeeId/position-history` | `update:Employee` | 4.3 |
| 12 | GET | `/admin/employees/:employeeId/position-history` | `read:Employee` | 4.3 |
| 13 | POST | `/admin/employees/:employeeId/documents` | `create:EmployeeDocument` | 4.4 |
| 14 | GET | `/admin/employees/:employeeId/documents` | `read:EmployeeDocument` | 4.4 |
| 15 | GET | `/admin/employees/:employeeId/documents/:docId/download` | `read:EmployeeDocument` | 4.4 |
| 16 | DELETE | `/admin/employees/:employeeId/documents/:docId` | `delete:EmployeeDocument` | 4.4 |
| 17 | GET | `/admin/employees-documents/expiring` | `read:EmployeeDocument` | 4.4 |
| 18 | POST | `/admin/employees/:employeeId/time-off` | `create:EmployeeTimeOff` | 4.5 |
| 19 | GET | `/admin/employees/:employeeId/time-off` | `read:EmployeeTimeOff` | 4.5 |
| 20 | GET | `/admin/employees/:employeeId/time-off/vacation-balance` | `read:EmployeeTimeOff` | 4.5 |
| 21 | POST | `/admin/employees/:employeeId/time-off/:timeOffId/review` | `update:EmployeeTimeOff` | 4.5 |
| 22 | POST | `/admin/employees/:employeeId/time-off/:timeOffId/cancel` | `update:EmployeeTimeOff` | 4.5 |
| 23 | GET | `/admin/employees-time-off/pending-approvals` | `read:EmployeeTimeOff` | 4.5 |
| 24 | POST | `/admin/employees/:employeeId/emergency-contacts` | `create:EmployeeEmergencyContact` | 4.6 |
| 25 | GET | `/admin/employees/:employeeId/emergency-contacts` | `read:EmployeeEmergencyContact` | 4.6 |
| 26 | PATCH | `/admin/employees/:employeeId/emergency-contacts/:contactId` | `update:EmployeeEmergencyContact` | 4.6 |
| 27 | DELETE | `/admin/employees/:employeeId/emergency-contacts/:contactId` | `delete:EmployeeEmergencyContact` | 4.6 |

---

## Referencias

- **Commit del SDD**: `6623708` (merge a main)
- **Engram**: proposal #2137, spec #2138, design #2139, tasks #2140, apply-progress #2142, verify-report #2143, archive-report #2144
- **Tests**: 101 specs, 13 suites (`pnpm test -- src/employees src/files`)
- **Doc SDD anterior (miembros)**: `docs/backend-requests/tenant-members-api-enrichment-frontend-implementation.md`
- **RBAC y permisos**: `docs/backend-requests/rbac-frontend-permissions-audit.md`

---

## Changelog

| Campo | Valor |
|---|---|
| Fecha del documento | 2026-05-27 |
| SDD documentado | `employees-module` |
| Commit de merge | `6623708` |
| Engram observations | #2137, #2138, #2139, #2140, #2142, #2143, #2144 |
| Autor | Backend team |
