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
import { EmployeesController } from './employees.controller';
import { EmployeeSalaryController } from './employee-salary.controller';
import { EmployeePositionController } from './employee-position.controller';
import { EmployeeDocumentsController } from './employee-documents.controller';

@Module({
  imports: [AuthModule, FilesModule],
  controllers: [
    EmployeesController,
    EmployeeSalaryController,
    EmployeePositionController,
    EmployeeDocumentsController,
  ],
  providers: [
    EmployeesService,
    EmployeeSalaryService,
    EmployeePositionService,
    EmployeeDocumentsService,
    EmployeeTimeOffService,
    {
      provide: EMPLOYEE_REPOSITORY,
      useClass: PrismaEmployeeRepository,
    },
  ],
  exports: [EmployeesService],
})
export class EmployeesModule {}
