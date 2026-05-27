import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EMPLOYEE_REPOSITORY } from './domain/employee.repository';
import { PrismaEmployeeRepository } from './infrastructure/prisma-employee.repository';
import { EmployeesService } from './application/employees.service';
import { EmployeeSalaryService } from './application/employee-salary.service';
import { EmployeePositionService } from './application/employee-position.service';
import { EmployeesController } from './employees.controller';
import { EmployeeSalaryController } from './employee-salary.controller';
import { EmployeePositionController } from './employee-position.controller';

@Module({
  imports: [AuthModule],
  controllers: [
    EmployeesController,
    EmployeeSalaryController,
    EmployeePositionController,
  ],
  providers: [
    EmployeesService,
    EmployeeSalaryService,
    EmployeePositionService,
    {
      provide: EMPLOYEE_REPOSITORY,
      useClass: PrismaEmployeeRepository,
    },
  ],
  exports: [EmployeesService],
})
export class EmployeesModule {}
