/**
 * Modern font resolver for the quotation redesign pilot.
 *
 * react-pdf 4.x throws at render time when a registered font weight cannot
 * be fetched ("Failed to fetch font from …") — it does NOT silently fall
 * back to Helvetica. `Font.register` itself is synchronous and only stores
 * descriptors, so a bare `try/catch` around `Font.register` cannot detect a
 * broken/unreachable font source until the first render, when it is too late.
 *
 * To honor the "fall back to Helvetica if the remote font fails" contract we
 * pre-flight one Inter weight at module boot:
 *   - Probe reachable → register the full Inter family and resolve to 'Inter'.
 *   - Probe unreachable → resolve to 'Helvetica' and skip registration.
 *
 * Templates read the resolved family via `getModernFontFamily()` at render
 * time (lazy), so a boot-time outage never hard-fails a quotation PDF.
 */
import { Font } from '@react-pdf/renderer';
import { PDF_INTER_FONT_REGISTRY } from '../../pdf-generation.constants';

export type ModernFontFamily = 'Inter' | 'Helvetica';

const FALLBACK_FAMILY: ModernFontFamily = 'Helvetica';

let resolvedFamily: ModernFontFamily | null = null;

/** Family modern templates should bind to. Defaults to Helvetica pre-boot. */
export function getModernFontFamily(): ModernFontFamily {
  return resolvedFamily ?? FALLBACK_FAMILY;
}

/**
 * Register the Inter family (static weights) after a best-effort CDN
 * pre-flight. Never throws: any failure resolves to Helvetica so the boot
 * path and every subsequent render keep working.
 */
export async function registerModernFont(): Promise<ModernFontFamily> {
  try {
    const probe = await fetch(PDF_INTER_FONT_REGISTRY.fonts[0].src);
    if (!probe.ok) {
      throw new Error(`font probe returned HTTP ${probe.status}`);
    }
    // Consume the body so the socket is released back to the pool.
    await probe.arrayBuffer();
    Font.register(
      PDF_INTER_FONT_REGISTRY as unknown as Parameters<
        typeof Font.register
      >[0],
    );
    resolvedFamily = 'Inter';
  } catch {
    resolvedFamily = FALLBACK_FAMILY;
  }
  return resolvedFamily;
}
