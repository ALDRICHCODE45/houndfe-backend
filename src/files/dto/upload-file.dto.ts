import { IsOptional, IsString } from 'class-validator';

export class UploadFileDto {
  @IsOptional()
  @IsString()
  ownerType?: string;

  @IsOptional()
  @IsString()
  ownerId?: string;
}
