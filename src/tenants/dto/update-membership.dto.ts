import { IsUUID } from 'class-validator';

export class UpdateMembershipDto {
  @IsUUID()
  roleId!: string;
}
