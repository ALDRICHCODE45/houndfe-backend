import {
  PrismaClient,
  type ContractType,
  type EmployeeDocumentCategory,
  type EmployeeStatus,
  type IdentityDocumentType,
  type Permission,
  type Prisma,
  type TimeOffStatus,
  type TimeOffType,
  type WorkModality,
} from '@prisma/client';
import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { PERMISSION_REGISTRY } from '../src/auth/authorization/domain/permission';
import { ingestSatCatalog } from './seed-sat';

const prisma = new PrismaClient();

const BCRYPT_SALT_ROUNDS = 10;

const TENANTS = [
  { name: 'Sucursal Centro', slug: 'centro', isActive: true },
  { name: 'Sucursal Norte', slug: 'norte', isActive: true },
  { name: 'Sucursal Sur', slug: 'sur', isActive: true },
] as const;

const USERS = {
  superAdmin: {
    email: 'admin@houndfe.com',
    name: 'Super Admin',
    password: 'Admin123!',
  },
  manager: {
    email: 'manager@houndfe.com',
    name: 'Manager Centro',
    password: 'Manager123!',
  },
  cashier: {
    email: 'cashier@houndfe.com',
    name: 'Cajero Centro',
    password: 'Cashier123!',
  },
} as const;

type SeedPermissionKey = `${string}:${string}`;

function permissionKey(subject: string, action: string): SeedPermissionKey {
  return `${subject}:${action}`;
}

type SeedTenant = { id: string; name: string; slug: string };

type DemoSalaryHistorySeed = {
  amountCents: number;
  currency?: string;
  effectiveFrom: string;
  reason: string;
};

type DemoPositionHistorySeed = {
  position: string;
  department?: string;
  effectiveFrom: string;
  reason: string;
};

type DemoDocumentSeed = {
  category: EmployeeDocumentCategory;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt?: string;
  notes?: string;
};

type DemoTimeOffSeed = {
  type: TimeOffType;
  startDate: string;
  endDate: string;
  reason?: string;
  status: TimeOffStatus;
  reviewedAt?: string;
  reviewerNotes?: string;
};

type DemoEmergencyContactSeed = {
  name: string;
  relationship: string;
  phone: string;
  email?: string;
};

type DemoEmployeeSeed = {
  employeeNumber: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  nationalId?: string;
  nationalIdType?: IdentityDocumentType;
  street?: string;
  exteriorNumber?: string;
  interiorNumber?: string;
  zipCode?: string;
  neighborhood?: string;
  municipality?: string;
  city?: string;
  state?: string;
  hireDate: string;
  terminationDate?: string;
  terminationReason?: string;
  status?: EmployeeStatus;
  currentPosition?: string;
  currentDepartment?: string;
  currentSalaryCents?: number;
  currentSalaryCurrency?: string;
  currentResponsibilities?: string;
  currentSchedule?: string;
  contractType?: ContractType;
  workModality?: WorkModality;
  annualVacationDays?: number;
  managerNumber?: string;
  salaryHistory?: DemoSalaryHistorySeed[];
  positionHistory?: DemoPositionHistorySeed[];
  documents?: DemoDocumentSeed[];
  timeOff?: DemoTimeOffSeed[];
  emergencyContacts?: DemoEmergencyContactSeed[];
};

const DEMO_EMPLOYEES: DemoEmployeeSeed[] = [
  {
    employeeNumber: 'EMP-001',
    firstName: 'María Fernanda',
    lastName: 'Rivera',
    email: 'maria.rivera@houndfe.com',
    phone: '+52 55 1000 0101',
    dateOfBirth: '1985-03-14',
    nationalId: 'RIMF850314MDFVVR02',
    nationalIdType: 'INE',
    street: 'Av. Insurgentes Sur',
    exteriorNumber: '1458',
    zipCode: '03100',
    neighborhood: 'Del Valle Centro',
    municipality: 'Benito Juárez',
    city: 'Ciudad de México',
    state: 'CDMX',
    hireDate: '2020-01-06',
    currentPosition: 'Directora General',
    currentDepartment: 'Dirección',
    currentSalaryCents: 12500000,
    currentResponsibilities: 'Dirección estratégica, expansión comercial y relación con socios clave.',
    currentSchedule: 'Lunes a viernes, 09:00-18:00',
    contractType: 'PERMANENT',
    workModality: 'HYBRID',
    annualVacationDays: 24,
    salaryHistory: [
      { amountCents: 9000000, effectiveFrom: '2020-01-06', reason: 'Paquete inicial de dirección' },
      { amountCents: 11000000, effectiveFrom: '2022-02-01', reason: 'Ajuste por expansión multi-sucursal' },
      { amountCents: 12500000, effectiveFrom: '2025-01-01', reason: 'Ajuste ejecutivo anual' },
    ],
    positionHistory: [
      { position: 'Gerente General', department: 'Dirección', effectiveFrom: '2020-01-06', reason: 'Alta inicial' },
      { position: 'Directora General', department: 'Dirección', effectiveFrom: '2022-02-01', reason: 'Promoción por crecimiento operativo' },
    ],
    documents: [
      {
        category: 'NDA',
        fileName: 'nda-maria-rivera.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 218000,
        notes: 'Acuerdo de confidencialidad para estrategia comercial.',
      },
    ],
    timeOff: [
      {
        type: 'VACATION',
        startDate: '2026-07-20',
        endDate: '2026-07-24',
        reason: 'Vacaciones familiares',
        status: 'APPROVED',
        reviewedAt: '2026-05-10',
        reviewerNotes: 'Aprobado por planeación anual.',
      },
    ],
    emergencyContacts: [
      { name: 'Alejandro Rivera', relationship: 'Hermano', phone: '+52 55 1000 9101', email: 'alejandro.rivera@example.com' },
    ],
  },
  {
    employeeNumber: 'EMP-002',
    firstName: 'Luis',
    lastName: 'Andrade',
    email: 'luis.andrade@houndfe.com',
    phone: '+52 55 1000 0102',
    dateOfBirth: '1988-09-22',
    nationalId: 'AALU880922HDFNNS04',
    nationalIdType: 'INE',
    street: 'Calle Xola',
    exteriorNumber: '512',
    zipCode: '03020',
    neighborhood: 'Narvarte',
    municipality: 'Benito Juárez',
    city: 'Ciudad de México',
    state: 'CDMX',
    hireDate: '2020-03-16',
    currentPosition: 'Director de Operaciones',
    currentDepartment: 'Operaciones',
    currentSalaryCents: 9500000,
    currentResponsibilities: 'Supervisión de tiendas, inventario, turnos y cumplimiento operativo.',
    currentSchedule: 'Lunes a viernes, 08:00-17:00',
    contractType: 'PERMANENT',
    workModality: 'ONSITE',
    annualVacationDays: 22,
    managerNumber: 'EMP-001',
    salaryHistory: [
      { amountCents: 7200000, effectiveFrom: '2020-03-16', reason: 'Alta como gerente regional' },
      { amountCents: 9500000, effectiveFrom: '2024-04-01', reason: 'Promoción a dirección de operaciones' },
    ],
    positionHistory: [
      { position: 'Gerente Regional', department: 'Operaciones', effectiveFrom: '2020-03-16', reason: 'Alta inicial' },
      { position: 'Director de Operaciones', department: 'Operaciones', effectiveFrom: '2024-04-01', reason: 'Promoción por apertura de sucursales' },
    ],
    timeOff: [
      {
        type: 'PERSONAL',
        startDate: '2026-06-05',
        endDate: '2026-06-05',
        reason: 'Trámite personal',
        status: 'PENDING',
      },
    ],
    emergencyContacts: [
      { name: 'Carolina Méndez', relationship: 'Esposa', phone: '+52 55 1000 9102' },
    ],
  },
  {
    employeeNumber: 'EMP-003',
    firstName: 'Ana Sofía',
    lastName: 'Morales',
    email: 'ana.morales@houndfe.com',
    phone: '+52 55 1000 0103',
    dateOfBirth: '1990-11-05',
    nationalId: 'MOAS901105MDFRNL09',
    nationalIdType: 'INE',
    hireDate: '2021-02-01',
    currentPosition: 'People & Culture Lead',
    currentDepartment: 'Recursos Humanos',
    currentSalaryCents: 7200000,
    currentResponsibilities: 'Contratación, onboarding, clima laboral y documentación laboral.',
    currentSchedule: 'Lunes a viernes, 09:00-18:00',
    contractType: 'PERMANENT',
    workModality: 'HYBRID',
    annualVacationDays: 20,
    managerNumber: 'EMP-001',
    documents: [
      {
        category: 'CERTIFICATE',
        fileName: 'certificacion-people-analytics-ana-morales.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 340000,
        expiresAt: '2027-03-31',
        notes: 'Certificación de People Analytics vigente.',
      },
    ],
    timeOff: [
      {
        type: 'VACATION',
        startDate: '2026-08-10',
        endDate: '2026-08-14',
        reason: 'Vacaciones programadas',
        status: 'PENDING',
      },
    ],
    emergencyContacts: [
      { name: 'Patricia Morales', relationship: 'Madre', phone: '+52 55 1000 9103', email: 'patricia.morales@example.com' },
    ],
  },
  {
    employeeNumber: 'EMP-004',
    firstName: 'Raúl',
    lastName: 'Castillo',
    email: 'raul.castillo@houndfe.com',
    phone: '+52 55 1000 0104',
    dateOfBirth: '1987-06-18',
    nationalId: 'CARL870618HDFSSL07',
    nationalIdType: 'INE',
    hireDate: '2021-04-12',
    currentPosition: 'Gerente de Finanzas',
    currentDepartment: 'Finanzas',
    currentSalaryCents: 7800000,
    currentResponsibilities: 'Presupuesto, control de gastos, pagos y reportes financieros.',
    currentSchedule: 'Lunes a viernes, 09:00-18:30',
    contractType: 'PERMANENT',
    workModality: 'HYBRID',
    annualVacationDays: 20,
    managerNumber: 'EMP-001',
    documents: [
      {
        category: 'EVALUATION',
        fileName: 'evaluacion-raul-castillo-2025.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 276000,
        notes: 'Evaluación anual 2025.',
      },
    ],
    emergencyContacts: [
      { name: 'Mariana Castillo', relationship: 'Hermana', phone: '+52 55 1000 9104' },
    ],
  },
  {
    employeeNumber: 'EMP-005',
    firstName: 'Camila',
    lastName: 'Torres',
    email: 'camila.torres@houndfe.com',
    phone: '+52 55 1000 0105',
    dateOfBirth: '1991-01-28',
    nationalId: 'TOCA910128MDFRRM05',
    nationalIdType: 'PASSPORT',
    hireDate: '2021-08-02',
    currentPosition: 'Technology Lead',
    currentDepartment: 'Tecnología',
    currentSalaryCents: 8500000,
    currentResponsibilities: 'Roadmap técnico, integraciones, soporte interno y seguridad operacional.',
    currentSchedule: 'Lunes a viernes, horario flexible',
    contractType: 'PERMANENT',
    workModality: 'REMOTE',
    annualVacationDays: 20,
    managerNumber: 'EMP-001',
    positionHistory: [
      { position: 'Ingeniera de Software', department: 'Tecnología', effectiveFrom: '2021-08-02', reason: 'Alta inicial' },
      { position: 'Technology Lead', department: 'Tecnología', effectiveFrom: '2024-01-15', reason: 'Liderazgo de plataforma interna' },
    ],
    salaryHistory: [
      { amountCents: 6200000, effectiveFrom: '2021-08-02', reason: 'Alta inicial' },
      { amountCents: 8500000, effectiveFrom: '2024-01-15', reason: 'Promoción a liderazgo técnico' },
    ],
    emergencyContacts: [
      { name: 'Santiago Torres', relationship: 'Padre', phone: '+52 55 1000 9105' },
    ],
  },
  {
    employeeNumber: 'EMP-006',
    firstName: 'Jorge',
    lastName: 'Medina',
    email: 'jorge.medina@houndfe.com',
    phone: '+52 55 1000 0106',
    dateOfBirth: '1989-12-02',
    nationalId: 'MEJO891202HDFDNR01',
    nationalIdType: 'INE',
    hireDate: '2022-01-10',
    currentPosition: 'Gerente de Sucursal Centro',
    currentDepartment: 'Tienda Centro',
    currentSalaryCents: 5500000,
    currentResponsibilities: 'Gestión de tienda, apertura/cierre, caja mayor y coordinación de piso.',
    currentSchedule: 'Lunes a sábado, 08:00-16:00',
    contractType: 'PERMANENT',
    workModality: 'ONSITE',
    annualVacationDays: 18,
    managerNumber: 'EMP-002',
    timeOff: [
      {
        type: 'VACATION',
        startDate: '2026-03-18',
        endDate: '2026-03-22',
        reason: 'Descanso anual',
        status: 'APPROVED',
        reviewedAt: '2026-02-20',
        reviewerNotes: 'Cubierto por supervisor de turno.',
      },
    ],
    emergencyContacts: [
      { name: 'Laura Hernández', relationship: 'Esposa', phone: '+52 55 1000 9106' },
    ],
  },
  {
    employeeNumber: 'EMP-007',
    firstName: 'Valeria',
    lastName: 'Pineda',
    email: 'valeria.pineda@houndfe.com',
    phone: '+52 55 1000 0107',
    dateOfBirth: '1992-05-19',
    nationalId: 'PIVL920519MDFNLD08',
    nationalIdType: 'INE',
    hireDate: '2022-03-07',
    currentPosition: 'Gerente de Almacén',
    currentDepartment: 'Almacén',
    currentSalaryCents: 5200000,
    currentResponsibilities: 'Recepción, conteos cíclicos, control de caducidades y surtido a tienda.',
    currentSchedule: 'Lunes a viernes, 07:00-16:00',
    contractType: 'PERMANENT',
    workModality: 'ONSITE',
    annualVacationDays: 18,
    managerNumber: 'EMP-002',
    emergencyContacts: [
      { name: 'Mónica Pineda', relationship: 'Madre', phone: '+52 55 1000 9107' },
    ],
  },
  {
    employeeNumber: 'EMP-008',
    firstName: 'Diego',
    lastName: 'Rojas',
    email: 'diego.rojas@houndfe.com',
    phone: '+52 55 1000 0108',
    dateOfBirth: '1994-02-11',
    nationalId: 'RODI940211HDFJSG03',
    nationalIdType: 'DRIVER_LICENSE',
    hireDate: '2022-05-23',
    currentPosition: 'Supervisor de Turno',
    currentDepartment: 'Tienda Centro',
    currentSalaryCents: 3800000,
    currentResponsibilities: 'Asignación de cajas, supervisión de piso y cierres parciales.',
    currentSchedule: 'Turno vespertino, 14:00-22:00',
    contractType: 'PERMANENT',
    workModality: 'ONSITE',
    annualVacationDays: 16,
    managerNumber: 'EMP-006',
    timeOff: [
      {
        type: 'PERSONAL',
        startDate: '2026-09-14',
        endDate: '2026-09-14',
        reason: 'Trámite familiar',
        status: 'PENDING',
      },
    ],
    emergencyContacts: [
      { name: 'Fernanda Rojas', relationship: 'Hermana', phone: '+52 55 1000 9108' },
    ],
  },
  {
    employeeNumber: 'EMP-009',
    firstName: 'Paula',
    lastName: 'Jiménez',
    email: 'paula.jimenez@houndfe.com',
    phone: '+52 55 1000 0109',
    dateOfBirth: '1993-07-30',
    nationalId: 'JIPA930730MDFMML06',
    nationalIdType: 'INE',
    hireDate: '2022-09-01',
    currentPosition: 'Química Farmacéutica',
    currentDepartment: 'Tienda Centro',
    currentSalaryCents: 4200000,
    currentResponsibilities: 'Dispensación responsable, asesoría de medicamentos y control sanitario.',
    currentSchedule: 'Lunes a sábado, 10:00-18:00',
    contractType: 'PERMANENT',
    workModality: 'ONSITE',
    annualVacationDays: 16,
    managerNumber: 'EMP-006',
    documents: [
      {
        category: 'CERTIFICATE',
        fileName: 'cedula-profesional-paula-jimenez.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 512000,
        expiresAt: '2028-12-31',
        notes: 'Cédula profesional y certificación sanitaria.',
      },
    ],
    timeOff: [
      {
        type: 'SICK',
        startDate: '2026-02-03',
        endDate: '2026-02-04',
        reason: 'Consulta médica y reposo indicado',
        status: 'APPROVED',
        reviewedAt: '2026-02-03',
        reviewerNotes: 'Justificante recibido.',
      },
    ],
    emergencyContacts: [
      { name: 'Elena Jiménez', relationship: 'Madre', phone: '+52 55 1000 9109' },
    ],
  },
  {
    employeeNumber: 'EMP-010',
    firstName: 'Sofía',
    lastName: 'Luna',
    email: 'sofia.luna@houndfe.com',
    phone: '+52 55 1000 0110',
    dateOfBirth: '1997-04-09',
    nationalId: 'LUSO970409MDFNNF01',
    nationalIdType: 'INE',
    hireDate: '2023-01-16',
    currentPosition: 'Cajera Senior',
    currentDepartment: 'Tienda Centro',
    currentSalaryCents: 2600000,
    currentResponsibilities: 'Atención en caja, devoluciones, arqueos y apoyo a nuevos cajeros.',
    currentSchedule: 'Turno matutino, 07:00-15:00',
    contractType: 'PERMANENT',
    workModality: 'ONSITE',
    annualVacationDays: 14,
    managerNumber: 'EMP-008',
    timeOff: [
      {
        type: 'VACATION',
        startDate: '2026-11-02',
        endDate: '2026-11-06',
        reason: 'Vacaciones planeadas',
        status: 'PENDING',
      },
    ],
    emergencyContacts: [
      { name: 'Ricardo Luna', relationship: 'Padre', phone: '+52 55 1000 9110' },
    ],
  },
  {
    employeeNumber: 'EMP-011',
    firstName: 'Mateo',
    lastName: 'Vargas',
    email: 'mateo.vargas@houndfe.com',
    phone: '+52 55 1000 0111',
    dateOfBirth: '2000-10-17',
    nationalId: 'VAMA001017HDFRRT02',
    nationalIdType: 'INE',
    hireDate: '2024-02-05',
    currentPosition: 'Cajero Junior',
    currentDepartment: 'Tienda Centro',
    currentSalaryCents: 2100000,
    currentResponsibilities: 'Caja, atención al cliente y reposición ligera de mostrador.',
    currentSchedule: 'Turno vespertino, 15:00-22:00',
    contractType: 'TEMPORARY',
    workModality: 'ONSITE',
    annualVacationDays: 10,
    managerNumber: 'EMP-008',
    documents: [
      {
        category: 'ID_DOCUMENT',
        fileName: 'ine-mateo-vargas.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 184000,
        notes: 'Identificación oficial digitalizada.',
      },
    ],
    emergencyContacts: [
      { name: 'Claudia Vargas', relationship: 'Madre', phone: '+52 55 1000 9111' },
    ],
  },
  {
    employeeNumber: 'EMP-012',
    firstName: 'Natalia',
    lastName: 'Cruz',
    email: 'natalia.cruz@houndfe.com',
    phone: '+52 55 1000 0112',
    dateOfBirth: '1996-08-21',
    nationalId: 'CRNA960821MDFRZT09',
    nationalIdType: 'INE',
    hireDate: '2023-03-13',
    currentPosition: 'Analista de Inventario',
    currentDepartment: 'Almacén',
    currentSalaryCents: 3400000,
    currentResponsibilities: 'Conteos cíclicos, diferencias de inventario y reportes de caducidad.',
    currentSchedule: 'Lunes a viernes, 08:00-17:00',
    contractType: 'PERMANENT',
    workModality: 'HYBRID',
    annualVacationDays: 14,
    managerNumber: 'EMP-007',
    emergencyContacts: [
      { name: 'Óscar Cruz', relationship: 'Esposo', phone: '+52 55 1000 9112' },
    ],
  },
  {
    employeeNumber: 'EMP-013',
    firstName: 'Emilio',
    lastName: 'Navarro',
    email: 'emilio.navarro@houndfe.com',
    phone: '+52 55 1000 0113',
    dateOfBirth: '1990-12-13',
    nationalId: 'NAEM901213HDFVVL04',
    nationalIdType: 'INE',
    hireDate: '2022-11-07',
    currentPosition: 'Especialista de Compras',
    currentDepartment: 'Almacén',
    currentSalaryCents: 4100000,
    currentResponsibilities: 'Negociación con proveedores, órdenes de compra y seguimiento de entregas.',
    currentSchedule: 'Lunes a viernes, 09:00-18:00',
    contractType: 'PERMANENT',
    workModality: 'HYBRID',
    annualVacationDays: 16,
    managerNumber: 'EMP-007',
    timeOff: [
      {
        type: 'UNPAID',
        startDate: '2026-05-29',
        endDate: '2026-05-30',
        reason: 'Asunto familiar no cubierto por vacaciones',
        status: 'REJECTED',
        reviewedAt: '2026-05-20',
        reviewerNotes: 'Fechas críticas de inventario mensual.',
      },
    ],
    emergencyContacts: [
      { name: 'Lucía Navarro', relationship: 'Hermana', phone: '+52 55 1000 9113' },
    ],
  },
  {
    employeeNumber: 'EMP-014',
    firstName: 'Renata',
    lastName: 'Salas',
    email: 'renata.salas@houndfe.com',
    phone: '+52 55 1000 0114',
    dateOfBirth: '1995-09-03',
    nationalId: 'SARR950903MDFLLN08',
    nationalIdType: 'INE',
    hireDate: '2023-06-05',
    currentPosition: 'Customer Experience Lead',
    currentDepartment: 'Atención al Cliente',
    currentSalaryCents: 4500000,
    currentResponsibilities: 'Escalaciones, estándares de atención y capacitación de experiencia cliente.',
    currentSchedule: 'Lunes a viernes, 10:00-19:00',
    contractType: 'PERMANENT',
    workModality: 'HYBRID',
    annualVacationDays: 14,
    managerNumber: 'EMP-002',
    emergencyContacts: [
      { name: 'Héctor Salas', relationship: 'Padre', phone: '+52 55 1000 9114' },
    ],
  },
  {
    employeeNumber: 'EMP-015',
    firstName: 'Bruno',
    lastName: 'Ortega',
    email: 'bruno.ortega@houndfe.com',
    phone: '+52 55 1000 0115',
    dateOfBirth: '1998-01-25',
    nationalId: 'OEBR980125HDFRTN05',
    nationalIdType: 'INE',
    hireDate: '2024-01-08',
    currentPosition: 'Especialista de Soporte Remoto',
    currentDepartment: 'Atención al Cliente',
    currentSalaryCents: 3100000,
    currentResponsibilities: 'Soporte por chat, seguimiento de tickets y coordinación con tienda.',
    currentSchedule: 'Remoto, 09:00-17:00',
    contractType: 'PERMANENT',
    workModality: 'REMOTE',
    annualVacationDays: 12,
    managerNumber: 'EMP-014',
    emergencyContacts: [
      { name: 'Andrea Ortega', relationship: 'Pareja', phone: '+52 55 1000 9115' },
    ],
  },
  {
    employeeNumber: 'EMP-016',
    firstName: 'Lucía',
    lastName: 'Herrera',
    email: 'lucia.herrera@houndfe.com',
    phone: '+52 55 1000 0116',
    dateOfBirth: '2003-04-12',
    nationalId: 'HELU030412MDFRRC07',
    nationalIdType: 'INE',
    hireDate: '2026-01-12',
    currentPosition: 'Practicante de Recursos Humanos',
    currentDepartment: 'Recursos Humanos',
    currentSalaryCents: 1400000,
    currentResponsibilities: 'Apoyo en expedientes, entrevistas iniciales y coordinación de onboarding.',
    currentSchedule: 'Lunes a viernes, 09:00-14:00',
    contractType: 'INTERNSHIP',
    workModality: 'HYBRID',
    annualVacationDays: 6,
    managerNumber: 'EMP-003',
    emergencyContacts: [
      { name: 'Gabriela Herrera', relationship: 'Madre', phone: '+52 55 1000 9116', email: 'gabriela.herrera@example.com' },
    ],
  },
  {
    employeeNumber: 'EMP-017',
    firstName: 'Iván',
    lastName: 'Robles',
    email: 'ivan.robles@houndfe.com',
    phone: '+52 55 1000 0117',
    dateOfBirth: '1994-06-27',
    nationalId: 'ROIV940627HDFBVN04',
    nationalIdType: 'PASSPORT',
    hireDate: '2025-02-03',
    currentPosition: 'Diseñador Freelance',
    currentDepartment: 'Tecnología',
    currentSalaryCents: 2800000,
    currentResponsibilities: 'Material gráfico para campañas internas, piezas de producto y soporte UX.',
    currentSchedule: 'Por proyecto, remoto',
    contractType: 'FREELANCE',
    workModality: 'REMOTE',
    annualVacationDays: 0,
    managerNumber: 'EMP-005',
    documents: [
      {
        category: 'OTHER',
        fileName: 'portafolio-ivan-robles.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 860000,
        notes: 'Portafolio de diseño usado durante contratación.',
      },
    ],
    emergencyContacts: [
      { name: 'Roberto Robles', relationship: 'Padre', phone: '+52 55 1000 9117' },
    ],
  },
  {
    employeeNumber: 'EMP-018',
    firstName: 'Daniela',
    lastName: 'Cordero',
    email: 'daniela.cordero@houndfe.com',
    phone: '+52 55 1000 0118',
    dateOfBirth: '1991-11-16',
    nationalId: 'CODA911116MDFRRL06',
    nationalIdType: 'INE',
    hireDate: '2022-07-18',
    status: 'ON_LEAVE',
    currentPosition: 'Asesora Clínica',
    currentDepartment: 'Tienda Centro',
    currentSalaryCents: 4700000,
    currentResponsibilities: 'Asesoría clínica, protocolos de atención y seguimiento a casos sensibles.',
    currentSchedule: 'Lunes a viernes, 08:00-16:00',
    contractType: 'PERMANENT',
    workModality: 'ONSITE',
    annualVacationDays: 16,
    managerNumber: 'EMP-006',
    documents: [
      {
        category: 'MEDICAL',
        fileName: 'incapacidad-daniela-cordero-2026.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 244000,
        expiresAt: '2026-06-15',
        notes: 'Documento médico sensible para licencia temporal.',
      },
    ],
    timeOff: [
      {
        type: 'SICK',
        startDate: '2026-05-20',
        endDate: '2026-06-15',
        reason: 'Licencia médica extendida',
        status: 'APPROVED',
        reviewedAt: '2026-05-19',
        reviewerNotes: 'Aprobado con justificante médico.',
      },
    ],
    emergencyContacts: [
      { name: 'Miguel Cordero', relationship: 'Esposo', phone: '+52 55 1000 9118' },
    ],
  },
  {
    employeeNumber: 'EMP-019',
    firstName: 'Óscar',
    lastName: 'Beltrán',
    email: 'oscar.beltran@houndfe.com',
    phone: '+52 55 1000 0119',
    dateOfBirth: '1996-03-08',
    nationalId: 'BEOO960308HDFLLS03',
    nationalIdType: 'INE',
    hireDate: '2021-10-04',
    terminationDate: '2025-12-15',
    terminationReason: 'Renuncia voluntaria por cambio de residencia.',
    status: 'TERMINATED',
    currentPosition: 'Cajero Senior',
    currentDepartment: 'Tienda Centro',
    currentSalaryCents: 2400000,
    currentResponsibilities: 'Histórico de caja y cierre de turno.',
    currentSchedule: 'Contrato finalizado',
    contractType: 'PERMANENT',
    workModality: 'ONSITE',
    annualVacationDays: 12,
    managerNumber: 'EMP-008',
    documents: [
      {
        category: 'OTHER',
        fileName: 'carta-renuncia-oscar-beltran.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 196000,
        notes: 'Carta de renuncia y cierre administrativo.',
      },
    ],
    emergencyContacts: [
      { name: 'Beatriz Beltrán', relationship: 'Madre', phone: '+52 55 1000 9119' },
    ],
  },
];

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function optionalDate(value?: string): Date | null {
  return value ? dateOnly(value) : null;
}

function slugifyFilePart(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function upsertUser(
  tx: Prisma.TransactionClient,
  user: { email: string; name: string; password: string },
) {
  const hashedPassword = await bcrypt.hash(user.password, BCRYPT_SALT_ROUNDS);

  return tx.user.upsert({
    where: { email: user.email },
    update: { name: user.name, hashedPassword, isActive: true },
    create: {
      id: randomUUID(),
      email: user.email,
      hashedPassword,
      name: user.name,
      isActive: true,
    },
  });
}

async function upsertProductByTenantAndName(
  tx: Prisma.TransactionClient,
  payload: {
    tenantId: string;
    name: string;
    categoryId: string;
    brandId: string;
    sku: string;
    barcode: string;
  },
) {
  const existing = await tx.product.findFirst({
    where: { tenantId: payload.tenantId, name: payload.name },
    select: { id: true },
  });

  if (existing) {
    return tx.product.update({
      where: { id: existing.id },
      data: {
        categoryId: payload.categoryId,
        brandId: payload.brandId,
        sku: payload.sku,
        barcode: payload.barcode,
      },
    });
  }

  return tx.product.create({
    data: {
      name: payload.name,
      tenantId: payload.tenantId,
      categoryId: payload.categoryId,
      brandId: payload.brandId,
      sku: payload.sku,
      barcode: payload.barcode,
    },
  });
}

async function upsertCustomerByTenantAndEmail(
  tx: Prisma.TransactionClient,
  payload: {
    tenantId: string;
    firstName: string;
    lastName: string;
    email: string;
    phoneCountryCode: string;
    phone: string;
  },
) {
  const existing = await tx.customer.findFirst({
    where: { tenantId: payload.tenantId, email: payload.email },
    select: { id: true },
  });

  if (existing) {
    return tx.customer.update({
      where: { id: existing.id },
      data: {
        firstName: payload.firstName,
        lastName: payload.lastName,
        phoneCountryCode: payload.phoneCountryCode,
        phone: payload.phone,
      },
    });
  }

  return tx.customer.create({
    data: {
      tenantId: payload.tenantId,
      firstName: payload.firstName,
      lastName: payload.lastName,
      email: payload.email,
      phoneCountryCode: payload.phoneCountryCode,
      phone: payload.phone,
    },
  });
}

async function upsertEmployeeByNumber(
  tx: Prisma.TransactionClient,
  tenantId: string,
  seed: DemoEmployeeSeed,
) {
  const employeeData = {
    firstName: seed.firstName,
    lastName: seed.lastName,
    email: seed.email ?? null,
    phone: seed.phone ?? null,
    dateOfBirth: optionalDate(seed.dateOfBirth),
    nationalId: seed.nationalId ?? null,
    nationalIdType: seed.nationalIdType ?? null,
    photoFileId: null,
    cvFileId: null,
    street: seed.street ?? null,
    exteriorNumber: seed.exteriorNumber ?? null,
    interiorNumber: seed.interiorNumber ?? null,
    zipCode: seed.zipCode ?? null,
    neighborhood: seed.neighborhood ?? null,
    municipality: seed.municipality ?? null,
    city: seed.city ?? null,
    state: seed.state ?? null,
    hireDate: dateOnly(seed.hireDate),
    terminationDate: optionalDate(seed.terminationDate),
    terminationReason: seed.terminationReason ?? null,
    status: seed.status ?? 'ACTIVE',
    currentPosition: seed.currentPosition ?? null,
    currentDepartment: seed.currentDepartment ?? null,
    currentSalaryCents: seed.currentSalaryCents ?? null,
    currentSalaryCurrency: seed.currentSalaryCurrency ?? 'MXN',
    currentResponsibilities: seed.currentResponsibilities ?? null,
    currentSchedule: seed.currentSchedule ?? null,
    contractType: seed.contractType ?? 'PERMANENT',
    workModality: seed.workModality ?? 'ONSITE',
    annualVacationDays: seed.annualVacationDays ?? 0,
  } satisfies Omit<Prisma.EmployeeUncheckedCreateInput, 'id' | 'tenantId' | 'employeeNumber'>;

  return tx.employee.upsert({
    where: {
      tenantId_employeeNumber: {
        tenantId,
        employeeNumber: seed.employeeNumber,
      },
    },
    update: employeeData,
    create: {
      ...employeeData,
      tenantId,
      employeeNumber: seed.employeeNumber,
    },
  });
}

async function upsertDemoFileObject(
  tx: Prisma.TransactionClient,
  payload: {
    tenant: SeedTenant;
    employeeId: string;
    employeeNumber: string;
    document: DemoDocumentSeed;
    uploadedByUserId?: string;
  },
) {
  const safeFileName = slugifyFilePart(payload.document.fileName);
  const storageKey = `demo/${payload.tenant.slug}/employees/${payload.employeeNumber}/${safeFileName}`;
  const url = `https://demo-assets.houndfe.local/${storageKey}`;

  return tx.fileObject.upsert({
    where: { storageKey },
    update: {
      url,
      mimeType: payload.document.mimeType,
      sizeBytes: payload.document.sizeBytes,
      ownerType: 'EmployeeDocument',
      ownerId: payload.employeeId,
      uploadedBy: payload.uploadedByUserId ?? null,
      tenantId: payload.tenant.id,
    },
    create: {
      storageKey,
      url,
      mimeType: payload.document.mimeType,
      sizeBytes: payload.document.sizeBytes,
      ownerType: 'EmployeeDocument',
      ownerId: payload.employeeId,
      uploadedBy: payload.uploadedByUserId ?? null,
      tenantId: payload.tenant.id,
    },
  });
}

function defaultContractDocument(seed: DemoEmployeeSeed): DemoDocumentSeed {
  const expiresAt = seed.contractType === 'TEMPORARY' ? '2026-12-31' : undefined;

  return {
    category: 'CONTRACT',
    fileName: `${seed.employeeNumber.toLowerCase()}-contrato-laboral.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 210000,
    expiresAt,
    notes: `Contrato laboral demo de ${seed.firstName} ${seed.lastName}.`,
  };
}

function defaultEmergencyContact(seed: DemoEmployeeSeed): DemoEmergencyContactSeed {
  return {
    name: `${seed.firstName} Contacto`,
    relationship: seed.contractType === 'INTERNSHIP' ? 'Tutor' : 'Contacto familiar',
    phone: '+52 55 1000 9999',
  };
}

async function replaceEmployeeRelatedDemoData(
  tx: Prisma.TransactionClient,
  payload: {
    tenant: SeedTenant;
    employee: { id: string; employeeNumber: string };
    seed: DemoEmployeeSeed;
    recordedByUserId?: string;
  },
) {
  const { employee, seed, tenant, recordedByUserId } = payload;

  await tx.employeeSalaryHistory.deleteMany({ where: { employeeId: employee.id } });
  await tx.employeePositionHistory.deleteMany({ where: { employeeId: employee.id } });
  await tx.employeeDocument.deleteMany({ where: { employeeId: employee.id } });
  await tx.employeeTimeOff.deleteMany({ where: { employeeId: employee.id } });
  await tx.employeeEmergencyContact.deleteMany({ where: { employeeId: employee.id } });

  const salaryHistory =
    seed.salaryHistory ??
    (seed.currentSalaryCents
      ? [
          {
            amountCents: seed.currentSalaryCents,
            currency: seed.currentSalaryCurrency ?? 'MXN',
            effectiveFrom: seed.hireDate,
            reason: 'Alta inicial',
          },
        ]
      : []);

  if (salaryHistory.length > 0) {
    await tx.employeeSalaryHistory.createMany({
      data: salaryHistory.map((entry) => ({
        employeeId: employee.id,
        amountCents: entry.amountCents,
        currency: entry.currency ?? seed.currentSalaryCurrency ?? 'MXN',
        effectiveFrom: dateOnly(entry.effectiveFrom),
        reason: entry.reason,
        recordedByUserId: recordedByUserId ?? null,
        tenantId: tenant.id,
      })),
    });
  }

  const positionHistory =
    seed.positionHistory ??
    (seed.currentPosition
      ? [
          {
            position: seed.currentPosition,
            department: seed.currentDepartment,
            effectiveFrom: seed.hireDate,
            reason: 'Alta inicial',
          },
        ]
      : []);

  if (positionHistory.length > 0) {
    await tx.employeePositionHistory.createMany({
      data: positionHistory.map((entry) => ({
        employeeId: employee.id,
        position: entry.position,
        department: entry.department ?? null,
        effectiveFrom: dateOnly(entry.effectiveFrom),
        reason: entry.reason,
        recordedByUserId: recordedByUserId ?? null,
        tenantId: tenant.id,
      })),
    });
  }

  const documents = [defaultContractDocument(seed), ...(seed.documents ?? [])];
  for (const document of documents) {
    const file = await upsertDemoFileObject(tx, {
      tenant,
      employeeId: employee.id,
      employeeNumber: employee.employeeNumber,
      document,
      uploadedByUserId: recordedByUserId,
    });

    await tx.employeeDocument.create({
      data: {
        employeeId: employee.id,
        fileId: file.id,
        category: document.category,
        expiresAt: optionalDate(document.expiresAt),
        notes: document.notes ?? null,
        uploadedByUserId: recordedByUserId ?? null,
        tenantId: tenant.id,
      },
    });
  }

  if (seed.timeOff?.length) {
    await tx.employeeTimeOff.createMany({
      data: seed.timeOff.map((entry) => ({
        employeeId: employee.id,
        type: entry.type,
        startDate: dateOnly(entry.startDate),
        endDate: dateOnly(entry.endDate),
        reason: entry.reason ?? null,
        status: entry.status,
        reviewerUserId: entry.status === 'PENDING' ? null : recordedByUserId ?? null,
        reviewedAt: optionalDate(entry.reviewedAt),
        reviewerNotes: entry.reviewerNotes ?? null,
        requestedByUserId: recordedByUserId ?? null,
        tenantId: tenant.id,
      })),
    });
  }

  const emergencyContacts = seed.emergencyContacts?.length
    ? seed.emergencyContacts
    : [defaultEmergencyContact(seed)];

  await tx.employeeEmergencyContact.createMany({
    data: emergencyContacts.map((contact) => ({
      employeeId: employee.id,
      name: contact.name,
      relationship: contact.relationship,
      phone: contact.phone,
      email: contact.email ?? null,
      tenantId: tenant.id,
    })),
  });
}

async function seedCentroEmployees(
  tx: Prisma.TransactionClient,
  tenant: SeedTenant,
  recordedByUserId?: string,
) {
  const employeeByNumber = new Map<string, { id: string; employeeNumber: string }>();

  for (const seed of DEMO_EMPLOYEES) {
    const employee = await upsertEmployeeByNumber(tx, tenant.id, seed);
    employeeByNumber.set(seed.employeeNumber, {
      id: employee.id,
      employeeNumber: employee.employeeNumber,
    });
  }

  if (recordedByUserId) {
    await tx.employee.updateMany({
      where: { tenantId: tenant.id, userId: recordedByUserId },
      data: { userId: null },
    });
  }

  for (const seed of DEMO_EMPLOYEES) {
    const employee = employeeByNumber.get(seed.employeeNumber);
    if (!employee) {
      throw new Error(`Seed employee ${seed.employeeNumber} was not created`);
    }

    const managerId = seed.managerNumber
      ? employeeByNumber.get(seed.managerNumber)?.id
      : null;

    if (seed.managerNumber && !managerId) {
      throw new Error(
        `Seed employee ${seed.employeeNumber} references missing manager ${seed.managerNumber}`,
      );
    }

    await tx.employee.update({
      where: { id: employee.id },
      data: {
        managerId,
        userId:
          seed.employeeNumber === 'EMP-006' ? recordedByUserId ?? null : undefined,
      },
    });

    await replaceEmployeeRelatedDemoData(tx, {
      tenant,
      employee,
      seed,
      recordedByUserId,
    });
  }
}

async function main() {
  console.log('Seeding multi-tenant database...\n');

  await prisma.$transaction(async (tx) => {
    const allPermissionDefinitions = [...PERMISSION_REGISTRY];

    const permissions = new Map<SeedPermissionKey, Permission>();

    for (const definition of allPermissionDefinitions) {
      const permission = await tx.permission.upsert({
        where: {
          subject_action: {
            subject: definition.subject,
            action: definition.action,
          },
        },
        update: { description: definition.description },
        create: {
          subject: definition.subject,
          action: definition.action,
          description: definition.description,
        },
      });

      permissions.set(permissionKey(definition.subject, definition.action), permission);
    }

    const tenants = new Map<string, { id: string; name: string; slug: string }>();
    for (const tenantSeed of TENANTS) {
      const tenant = await tx.tenant.upsert({
        where: { slug: tenantSeed.slug },
        update: { name: tenantSeed.name, isActive: tenantSeed.isActive },
        create: tenantSeed,
      });
      tenants.set(tenant.slug, tenant);
    }

    const existingSuperAdminRole = await tx.role.findFirst({
      where: { tenantId: null, name: 'Super Admin' },
      select: { id: true },
    });

    const superAdminRole = existingSuperAdminRole
      ? await tx.role.update({
          where: { id: existingSuperAdminRole.id },
          data: { description: 'Global super-admin role', isSystem: true },
        })
      : await tx.role.create({
          data: {
            name: 'Super Admin',
            tenantId: null,
            description: 'Global super-admin role',
            isSystem: true,
          },
        });

    const managerRoleByTenant = new Map<string, { id: string }>();
    const cashierRoleByTenant = new Map<string, { id: string }>();

    for (const tenant of tenants.values()) {
      const managerRole = await tx.role.upsert({
        where: { tenantId_name: { tenantId: tenant.id, name: 'Manager' } },
        update: { description: `Manager role for ${tenant.name}`, isSystem: false },
        create: {
          tenantId: tenant.id,
          name: 'Manager',
          description: `Manager role for ${tenant.name}`,
          isSystem: false,
        },
      });

      const cashierRole = await tx.role.upsert({
        where: { tenantId_name: { tenantId: tenant.id, name: 'Cashier' } },
        update: { description: `Cashier role for ${tenant.name}`, isSystem: false },
        create: {
          tenantId: tenant.id,
          name: 'Cashier',
          description: `Cashier role for ${tenant.name}`,
          isSystem: false,
        },
      });

      managerRoleByTenant.set(tenant.slug, managerRole);
      cashierRoleByTenant.set(tenant.slug, cashierRole);
    }

    const superAdminUser = await upsertUser(tx, USERS.superAdmin);
    const managerUser = await upsertUser(tx, USERS.manager);
    const cashierUser = await upsertUser(tx, USERS.cashier);

    for (const permission of permissions.values()) {
      await tx.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: superAdminRole.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: superAdminRole.id,
          permissionId: permission.id,
        },
      });
    }

    const managerPermissionKeys: SeedPermissionKey[] = [
      permissionKey('Product', 'create'),
      permissionKey('Product', 'read'),
      permissionKey('Product', 'update'),
      permissionKey('Product', 'delete'),
      permissionKey('Sale', 'create'),
      permissionKey('Sale', 'read'),
      permissionKey('Sale', 'update'),
      permissionKey('Sale', 'delete'),
      permissionKey('Customer', 'create'),
      permissionKey('Customer', 'read'),
      permissionKey('Customer', 'update'),
      permissionKey('Customer', 'delete'),
      permissionKey('Order', 'create'),
      permissionKey('Order', 'read'),
      permissionKey('Order', 'update'),
      permissionKey('Order', 'delete'),
      permissionKey('Role', 'read'),
      permissionKey('Brand', 'create'),
      permissionKey('Brand', 'read'),
      permissionKey('Brand', 'update'),
      permissionKey('Brand', 'delete'),
      permissionKey('Category', 'create'),
      permissionKey('Category', 'read'),
      permissionKey('Category', 'update'),
      permissionKey('Category', 'delete'),
      permissionKey('TenantMembership', 'create'),
      permissionKey('TenantMembership', 'read'),
      permissionKey('TenantMembership', 'update'),
      permissionKey('TenantMembership', 'delete'),
      permissionKey('File', 'create'),
      permissionKey('File', 'read'),
      permissionKey('File', 'delete'),
      permissionKey('Employee', 'create'),
      permissionKey('Employee', 'read'),
      permissionKey('Employee', 'update'),
      permissionKey('Employee', 'delete'),
      permissionKey('EmployeeSalary', 'create'),
      permissionKey('EmployeeSalary', 'read'),
      permissionKey('EmployeeDocument', 'create'),
      permissionKey('EmployeeDocument', 'read'),
      permissionKey('EmployeeDocument', 'delete'),
      permissionKey('EmployeeTimeOff', 'create'),
      permissionKey('EmployeeTimeOff', 'read'),
      permissionKey('EmployeeTimeOff', 'update'),
      permissionKey('EmployeeTimeOff', 'delete'),
      permissionKey('EmployeeTimeOffMedical', 'read'),
      permissionKey('EmployeeEmergencyContact', 'create'),
      permissionKey('EmployeeEmergencyContact', 'read'),
      permissionKey('EmployeeEmergencyContact', 'update'),
      permissionKey('EmployeeEmergencyContact', 'delete'),
      permissionKey('GlobalPriceList', 'read'),
    ];

    const cashierPermissionKeys: SeedPermissionKey[] = [
      permissionKey('Sale', 'create'),
      permissionKey('Sale', 'read'),
      permissionKey('Product', 'read'),
      permissionKey('Customer', 'read'),
      permissionKey('Brand', 'read'),
      permissionKey('Category', 'read'),
      permissionKey('GlobalPriceList', 'read'),
    ];

    for (const managerRole of managerRoleByTenant.values()) {
      for (const managerPermissionKey of managerPermissionKeys) {
        const permission = permissions.get(managerPermissionKey);
        if (!permission) {
          continue;
        }
        await tx.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: managerRole.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: { roleId: managerRole.id, permissionId: permission.id },
        });
      }
    }

    for (const cashierRole of cashierRoleByTenant.values()) {
      for (const cashierPermissionKey of cashierPermissionKeys) {
        const permission = permissions.get(cashierPermissionKey);
        if (!permission) {
          continue;
        }
        await tx.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: cashierRole.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: { roleId: cashierRole.id, permissionId: permission.id },
        });
      }
    }

    for (const tenant of tenants.values()) {
      await tx.tenantMembership.upsert({
        where: {
          userId_tenantId_roleId: {
            userId: superAdminUser.id,
            tenantId: tenant.id,
            roleId: superAdminRole.id,
          },
        },
        update: {},
        create: {
          userId: superAdminUser.id,
          tenantId: tenant.id,
          roleId: superAdminRole.id,
        },
      });
    }

    const centroTenant = tenants.get('centro');
    const centroManagerRole = managerRoleByTenant.get('centro');
    const centroCashierRole = cashierRoleByTenant.get('centro');

    if (!centroTenant || !centroManagerRole || !centroCashierRole) {
      throw new Error('Centro tenant or roles were not created during seed');
    }

    await tx.tenantMembership.upsert({
      where: {
        userId_tenantId_roleId: {
          userId: managerUser.id,
          tenantId: centroTenant.id,
          roleId: centroManagerRole.id,
        },
      },
      update: {},
      create: {
        userId: managerUser.id,
        tenantId: centroTenant.id,
        roleId: centroManagerRole.id,
      },
    });

    await tx.tenantMembership.upsert({
      where: {
        userId_tenantId_roleId: {
          userId: cashierUser.id,
          tenantId: centroTenant.id,
          roleId: centroCashierRole.id,
        },
      },
      update: {},
      create: {
        userId: cashierUser.id,
        tenantId: centroTenant.id,
        roleId: centroCashierRole.id,
      },
    });

    const category = await tx.category.upsert({
      where: { name: 'General' },
      update: {},
      create: { name: 'General' },
    });

    const brand = await tx.brand.upsert({
      where: { name: 'Sin Marca' },
      update: {},
      create: { name: 'Sin Marca' },
    });

    const publicoList = await tx.globalPriceList.upsert({
      where: { name: 'PUBLICO' },
      update: { isDefault: true },
      create: {
        name: 'PUBLICO',
        isDefault: true,
      },
    });

    const paracetamol = await upsertProductByTenantAndName(tx, {
      tenantId: centroTenant.id,
      name: 'Paracetamol 500mg',
      categoryId: category.id,
      brandId: brand.id,
      sku: 'CENTRO-PARACETAMOL-500',
      barcode: '7501234567890',
    });

    const ibuprofeno = await upsertProductByTenantAndName(tx, {
      tenantId: centroTenant.id,
      name: 'Ibuprofeno 400mg',
      categoryId: category.id,
      brandId: brand.id,
      sku: 'CENTRO-IBUPROFENO-400',
      barcode: '7501234567891',
    });

    // Initialize PriceList matrix: each product × each global price list × tenant
    for (const product of [paracetamol, ibuprofeno]) {
      const existing = await tx.priceList.findFirst({
        where: {
          productId: product.id,
          globalPriceListId: publicoList.id,
          tenantId: centroTenant.id,
        },
      });
      if (!existing) {
        await tx.priceList.create({
          data: {
            productId: product.id,
            globalPriceListId: publicoList.id,
            priceCents: 0,
            tenantId: centroTenant.id,
          },
        });
      }
    }

    await upsertCustomerByTenantAndEmail(tx, {
      tenantId: centroTenant.id,
      firstName: 'Cliente',
      lastName: 'Centro',
      email: 'cliente.centro@houndfe.com',
      phoneCountryCode: '+52',
      phone: '5512345678',
    });

    await seedCentroEmployees(tx, centroTenant, managerUser.id);
  });

  // National reference data — runs OUTSIDE the tenant transaction because
  // the SAT catalog is non-tenant (base Prisma client) and must survive
  // tenant-specific rollback. Idempotent via createMany skipDuplicates.
  const satResult = await ingestSatCatalog(prisma);
  console.log(
    `\nSAT catalog ingest: ${satResult.totalWritten} rows from ${satResult.source} (${satResult.batches} batches)`,
  );

  console.log('\n--- Multi-tenant seed completed ---');
  console.log(`Super Admin: ${USERS.superAdmin.email} / ${USERS.superAdmin.password}`);
  console.log(`Manager:     ${USERS.manager.email} / ${USERS.manager.password}`);
  console.log(`Cashier:     ${USERS.cashier.email} / ${USERS.cashier.password}`);
  console.log(`Demo employees: ${DEMO_EMPLOYEES.length} records for Sucursal Centro`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
