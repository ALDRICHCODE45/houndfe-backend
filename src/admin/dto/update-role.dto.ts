import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class UpdateRoleDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;
}
