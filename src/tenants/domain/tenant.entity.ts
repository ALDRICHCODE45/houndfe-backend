export interface Tenant {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  address: string | null;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
}
