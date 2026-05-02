import { IsUUID } from 'class-validator';

export class CreateMembershipDto {
  @IsUUID()
  userId!: string;

  @IsUUID()
  roleId!: string;
}
