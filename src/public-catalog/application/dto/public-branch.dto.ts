export interface PublicBranchDto {
  id: string;
  name: string;
  slug: string;
  address: string | null;
  phone: string | null;
  /** Public catalog v0 (S5): the bot's single WhatsApp number, or null. */
  whatsappNumber?: string | null;
}
