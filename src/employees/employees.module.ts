import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { EMPLOYEE_REPOSITORY } from './domain/employee.repository';
import { PrismaEmployeeRepository } from './infrastructure/prisma-employee.repository';
import { EmployeesService } from './application/employees.service';
import { EmployeeSalaryService } from './application/employee-salary.service';
import { EmployeePositionService } from './application/employee-position.service';
import { EmployeeDocumentsService } from './application/employee-documents.service';
import { EmployeeTimeOffService } from './application/employee-time-off.service';
import { EmployeeEmergencyContactsService } from './application/employee-emergency-contacts.service';
import { EmployeesController } from './employees.controller';
import { EmployeeSalaryController } from './employee-salary.controller';
import { EmployeePositionController } from './employee-position.controller';
import { EmployeeDocumentsController } from './employee-documents.controller';
import { EmployeeTimeOffController } from './employee-time-off.controller';
import { EmployeeEmergencyContactsController } from './employee-emergency-contacts.controller';
import { OutboxModule } from '../shared/outbox/outbox.module';
import { NotificationConfigModule } from '../notification-config/notification-config.module';
import {
  BatchDeleteModule,
  BatchDeleteOrchestrator,
} from '../shared/batch-delete';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { BatchDeletableService } from '../shared/batch-delete/batch-delete.types';

@Module({
  imports: [
    AuthModule,
    FilesModule,
    // Slice 4 — provides OutboxWriterService + the
    // NOTIFICATION_CONFIG_REPOSITORY token used by the gated emit in
    // `EmployeeTimeOffService.request()`.
    OutboxModule,
    NotificationConfigModule,
    // Slice — wires `BatchDeleteGuard` + `CaslAbilityFactory` for the
    // `POST /admin/employees/batch-delete` route. Mirrors the Promotions
    // pilot pattern from `batch-delete` SDD change.
    BatchDeleteModule.forFeature(),
  ],
  controllers: [
    EmployeesController,
    EmployeeSalaryController,
    EmployeePositionController,
    EmployeeDocumentsController,
    EmployeeTimeOffController,
    EmployeeEmergencyContactsController,
  ],
  providers: [
    EmployeesService,
    EmployeeSalaryService,
    EmployeePositionService,
    EmployeeDocumentsService,
    EmployeeTimeOffService,
    EmployeeEmergencyContactsService,
    {
      provide: EMPLOYEE_REPOSITORY,
      useClass: PrismaEmployeeRepository,
    },
    {
      // Build the orchestrator subclass that wires TenantPrismaService
      // + EmployeesService (the BatchDeletableService for employees).
      // The factory returns a new concrete orchestrator instance for
      // each injection request — the orchestrator is stateless so
      // sharing across requests is safe.
      provide: BatchDeleteOrchestrator,
      useFactory: (
        tenantPrisma: TenantPrismaService,
        service: BatchDeletableService,
      ): BatchDeleteOrchestrator =>
        new (class extends BatchDeleteOrchestrator {
          constructor() {
            super(tenantPrisma, service);
          }
        })(),
      inject: [TenantPrismaService, EmployeesService],
    },
  ],
  exports: [EmployeesService],
})
export class EmployeesModule {}
