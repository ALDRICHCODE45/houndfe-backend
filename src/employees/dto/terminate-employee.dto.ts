import { IsDateString, IsString, MinLength } from 'class-validator';

export class TerminateEmployeeDto {
  @IsDateString()
  terminationDate: string;

  @IsString()
  @MinLength(1)
  terminationReason: string;
}
