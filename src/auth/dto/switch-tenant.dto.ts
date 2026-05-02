import { IsOptional, IsUUID } from 'class-validator';

export class SwitchTenantDto {
  @IsOptional()
  @IsUUID()
  tenantId?: string | null;
}
