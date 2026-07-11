import {
  IsEnum,
  IsOptional,
  IsDateString,
  IsString,
  MaxLength,
} from 'class-validator';
import { EmployeeDocumentCategory } from '@prisma/client';

export class UploadEmployeeDocumentDto {
  @IsEnum(EmployeeDocumentCategory)
  category: EmployeeDocumentCategory;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
