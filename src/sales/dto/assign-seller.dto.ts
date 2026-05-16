import { IsUUID } from 'class-validator';

export class AssignSellerDto {
  @IsUUID()
  sellerUserId!: string;
}
