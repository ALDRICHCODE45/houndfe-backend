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

@Module({
  imports: [
    AuthModule,
    FilesModule,
    // Slice 4 — provides OutboxWriterService + the
    // NOTIFICATION_CONFIG_REPOSITORY token used by the gated emit in
    // `EmployeeTimeOffService.request()`.
    OutboxModule,
    NotificationConfigModule,
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
  ],
  exports: [EmployeesService],
})
export class EmployeesModule {}
