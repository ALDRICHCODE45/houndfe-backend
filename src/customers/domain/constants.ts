/** 32 estados de México */
export const MEXICAN_STATES = [
  'Aguascalientes',
  'Baja California',
  'Baja California Sur',
  'Campeche',
  'Chiapas',
  'Chihuahua',
  'Ciudad de México',
  'Coahuila',
  'Colima',
  'Durango',
  'Estado de México',
  'Guanajuato',
  'Guerrero',
  'Hidalgo',
  'Jalisco',
  'Michoacán',
  'Morelos',
  'Nayarit',
  'Nuevo León',
  'Oaxaca',
  'Puebla',
  'Querétaro',
  'Quintana Roo',
  'San Luis Potosí',
  'Sinaloa',
  'Sonora',
  'Tabasco',
  'Tamaulipas',
  'Tlaxcala',
  'Veracruz',
  'Yucatán',
  'Zacatecas',
] as const;

export type MexicanState = (typeof MEXICAN_STATES)[number];

/** Regímenes fiscales del SAT */
export const FISCAL_REGIMES = [
  '601', // General de Ley Personas Morales
  '603', // Personas Morales con Fines no Lucrativos
  '605', // Sueldos y Salarios e Ingresos Asimilados a Salarios
  '606', // Arrendamiento
  '607', // Régimen de Enajenación o Adquisición de Bienes
  '608', // Demás ingresos
  '609', // Consolidación
  '610', // Residentes en el Extranjero sin Establecimiento Permanente en México
  '611', // Ingresos por Dividendos (socios y accionistas)
  '612', // Personas Físicas con Actividades Empresariales y Profesionales
  '614', // Ingresos por intereses
  '615', // Régimen de los ingresos por obtención de premios
  '616', // Sin obligaciones fiscales
  '620', // Sociedades Cooperativas de Producción que optan por diferir sus ingresos
  '621', // Incorporación Fiscal
  '622', // Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras
  '623', // Opcional para Grupos de Sociedades
  '624', // Coordinados
  '625', // Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas
  '626', // Régimen Simplificado de Confianza
  '628', // Hidrocarburos
  '629', // De los Regímenes Fiscales Preferentes y de las Empresas Multinacionales
  '630', // Enajenación de acciones en bolsa de valores
] as const;

export type FiscalRegime = (typeof FISCAL_REGIMES)[number];
