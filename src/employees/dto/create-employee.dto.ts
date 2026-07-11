import {
  IsString,
  IsOptional,
  IsEmail,
  IsEnum,
  IsDateString,
  IsInt,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ContractType,
  WorkModality,
  IdentityDocumentType,
} from '@prisma/client';

export class CreateEmployeeDto {
  @IsString()
  @MaxLength(50)
  employeeNumber: string;

  @IsString()
  @MaxLength(100)
  firstName: string;

  @IsString()
  @MaxLength(100)
  lastName: string;

  @IsDateString()
  hireDate: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  nationalId?: string;

  @IsOptional()
  @IsEnum(IdentityDocumentType)
  nationalIdType?: IdentityDocumentType;

  @IsOptional()
  @IsUUID()
  photoFileId?: string;

  @IsOptional()
  @IsUUID()
  cvFileId?: string;

  // Address
  @IsOptional()
  @IsString()
  @MaxLength(200)
  street?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  exteriorNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  interiorNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  zipCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  neighborhood?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  municipality?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  // Contract
  @IsOptional()
  @IsEnum(ContractType)
  contractType?: ContractType;

  @IsOptional()
  @IsEnum(WorkModality)
  workModality?: WorkModality;

  // Current
  @IsOptional()
  @IsString()
  @MaxLength(200)
  currentPosition?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  currentDepartment?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  currentSchedule?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  currentResponsibilities?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  annualVacationDays?: number;

  @IsOptional()
  @IsUUID()
  managerId?: string;
}
