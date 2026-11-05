/**
 * P4 S3 — one public attribute projected from the Published editorial
 * document by binding exposure (FACET and DETAIL only; INTERNAL never). Only
 * `known` values project. Labels are the vocabulary's es-MX labels; numbers
 * are raw (no locale formatting or unit conversion). Present only when the
 * tenant requires Published editorial (`catalogRequiresPublishedEditorial`).
 */
export interface PublicProductAttributeDto {
  /** Vocabulary definition code, e.g. `animal.target` (stable facet key). */
  code: string;
  /** Definition es-MX label, e.g. «Especie». */
  label: string;
  /** True for FACET exposure (future filters); false for DETAIL. */
  facet: boolean;
  /** Form section of the family, when the definition has one. */
  section: { code: string; label: string } | null;
  value: PublicAttributeValueDto;
  /** Ready-to-show es-MX text, e.g. «Perro, Gato», «1.5 kg», «Sí». */
  display: string;
}

export interface PublicAttributeOptionDto {
  code: string;
  label: string;
}

export interface PublicAttributeUnitDto {
  code: string;
  label: string;
}

export type PublicAttributeValueDto =
  | { type: 'text'; text: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'single'; option: PublicAttributeOptionDto }
  | { type: 'multi'; options: PublicAttributeOptionDto[] }
  | { type: 'number'; value: number; unit: PublicAttributeUnitDto | null }
  | {
      type: 'range';
      min: number;
      max: number;
      unit: PublicAttributeUnitDto;
    };
