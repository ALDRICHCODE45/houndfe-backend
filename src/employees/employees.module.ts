import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EMPLOYEE_REPOSITORY } from './domain/employee.repository';
import { PrismaEmployeeRepository } from './infrastructure/prisma-employee.repository';
import { EmployeesService } from './application/employees.service';
import { EmployeesController } from './employees.controller';

@Module({
  imports: [AuthModule],
  controllers: [EmployeesController],
  providers: [
    EmployeesService,
    {
      provide: EMPLOYEE_REPOSITORY,
      useClass: PrismaEmployeeRepository,
    },
  ],
  exports: [EmployeesService],
})
export class EmployeesModule {}
