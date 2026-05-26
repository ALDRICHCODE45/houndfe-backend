export interface EligibleUserDto {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
}

export interface PaginationMetaDto {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface EligibleUsersListDto {
  data: EligibleUserDto[];
  meta: PaginationMetaDto;
}
