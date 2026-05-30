import type { PublicStockStatus } from '../../domain/types';

export interface PublicCatalogProductCard {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  category: { id: string; name: string } | null;
  brand: { name: string } | null;
  image: { url: string } | null;
  price: {
    fromPriceCents: number | null;
    priceCents: number | null;
    hidden: boolean;
  };
  availability: PublicStockStatus;
  hasVariants: boolean;
  rating: null;
  featuredLabel: null;
}
