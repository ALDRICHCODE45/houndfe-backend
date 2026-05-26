export interface TenantMembershipDetailedDto {
  id: string;
  userId: string;
  tenantId: string;
  roleId: string;
  createdAt: Date;
  user: { id: string; email: string; name: string; isActive: boolean };
  role: { id: string; name: string };
}
