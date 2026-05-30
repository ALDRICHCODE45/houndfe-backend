import type { PublicStockStatus } from '../../domain/types';

export interface PublicVariantAvailability {
  branchId: string;
  branchName: string;
  branchSlug: string;
  availability: PublicStockStatus;
  isSelected: boolean;
}

export interface PublicVariantDto {
  id: string;
  name: string;
  option: string | null;
  value: string | null;
  image: { url: string } | null;
  price: {
    priceCents: number | null;
    hidden: boolean;
  };
  availabilityByBranch: PublicVariantAvailability[];
}

export interface PublicCatalogProductDetail {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  category: { id: string; name: string } | null;
  brand: { name: string } | null;
  images: Array<{ id: string; url: string; isMain: boolean }>;
  price: {
    priceCents: number | null;
    hidden: boolean;
  };
  availability: PublicStockStatus;
  hasVariants: boolean;
  variants: PublicVariantDto[];
  rating: null;
  featuredLabel: null;
}
