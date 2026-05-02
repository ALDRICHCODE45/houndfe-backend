import { IsString, IsNotEmpty, IsUUID } from 'class-validator';

export class SelectTenantDto {
  @IsString()
  @IsNotEmpty()
  tempToken: string;

  @IsUUID()
  tenantId: string;
}
