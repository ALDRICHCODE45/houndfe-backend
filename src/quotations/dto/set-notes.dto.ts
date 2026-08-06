import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SetQuotationNotesDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  customerNotes?: string | null;
}
