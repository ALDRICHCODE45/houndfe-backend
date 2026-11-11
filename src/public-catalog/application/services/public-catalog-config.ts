import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Public catalog v0 — the two optional environment values the public routes
 * read (validated at boot by `env.validation.ts`). An unset or empty value is
 * absent: `null`.
 */
@Injectable()
export class PublicCatalogConfig {
  constructor(private readonly config: ConfigService) {}

  /** S5 — the bot's single WhatsApp number (E.164), or null. */
  botWhatsappNumber(): string | null {
    return this.read('PUBLIC_BOT_WHATSAPP');
  }

  /** S6 — storefront base URL without a trailing slash, or null. */
  storeUrl(): string | null {
    return this.read('PUBLIC_STORE_URL')?.replace(/\/+$/, '') ?? null;
  }

  private read(key: string): string | null {
    const value = this.config.get<string>(key);
    return typeof value === 'string' && value.trim() !== ''
      ? value.trim()
      : null;
  }
}
