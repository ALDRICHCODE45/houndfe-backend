// Ops › showcase catalog › engine fixture: three products that exercise every
// engine path (simple food, accessory with two variants, care with a care
// review) for `--fixture` runs on the dev DB. Same contract as products/.
'use strict';

const commons = (file) => `https://commons.wikimedia.org/wiki/File:${file}`;
const CARE_EVIDENCE = [
  { sourceRef: 'Etiqueta del empaque', verifiedOn: '2026-11-09' },
];

module.exports = [
  {
    key: 'fx-croqueta-adulto',
    name: 'Croqueta Campo Verde Adulto Pollo y Arroz 4 kg',
    sku: 'SC-FX-CROQ-4KG',
    category: 'Alimento para perro',
    brand: 'Campo Verde',
    description:
      'Alimento completo para perro adulto con pollo y arroz, en bolsa resellable de 4 kg.',
    price: 489,
    mayoreo: 439,
    cost: 320,
    iva: 'IVA_0',
    stock: 25,
    packaging: { weightG: 4150, lengthCm: 45, widthCm: 30, heightCm: 10 },
    images: [
      {
        url: 'https://upload.wikimedia.org/wikipedia/commons/f/f7/Pile_of_Kibble_Dog_Food_%2851049786351%29.jpg',
        credit: 'Megan Marrs',
        license: 'CC BY 2.0',
        sourcePage: commons('Pile_of_Kibble_Dog_Food_(51049786351).jpg'),
      },
      {
        url: 'https://upload.wikimedia.org/wikipedia/commons/4/4b/Dog_Food_%281%29.jpg',
        credit: 'Alisha Vargas',
        license: 'CC BY 2.0',
        sourcePage: commons('Dog_Food_(1).jpg'),
      },
    ],
    editorial: {
      familyCode: 'food',
      commercialTitle: 'Croqueta para perro adulto pollo y arroz 4 kg',
      description:
        'Croqueta crujiente formulada para perros adultos de todas las razas. Pollo como primera proteína, arroz de fácil digestión y una mezcla de vitaminas y minerales para el día a día.',
      values: [
        {
          code: 'animal.target',
          variantKey: null,
          payload: { type: 'multi', value: ['ani.dom.dog'] },
        },
        {
          code: 'life.stage',
          variantKey: null,
          payload: { type: 'multi', value: ['life.dog.adult'] },
        },
        {
          code: 'size.animal',
          variantKey: null,
          payload: {
            type: 'multi',
            value: [
              'size.animal.small',
              'size.animal.medium',
              'size.animal.large',
            ],
          },
        },
        {
          code: 'food.format',
          variantKey: null,
          payload: { type: 'single', value: 'food.format.kibble' },
        },
        {
          code: 'food.role',
          variantKey: null,
          payload: { type: 'single', value: 'food.role.complete' },
        },
        {
          code: 'food.texture',
          variantKey: null,
          payload: {
            type: 'multi',
            value: ['food.texture.dry', 'food.texture.crunchy'],
          },
        },
        {
          code: 'pack.form',
          variantKey: null,
          payload: { type: 'single', value: 'pack.form.bag' },
        },
        {
          code: 'measure.net_mass',
          variantKey: null,
          payload: { type: 'number', value: 4, unit: 'kg' },
        },
        {
          code: 'text.ingredients',
          variantKey: null,
          payload: {
            type: 'text',
            value:
              'Pollo deshidratado, arroz, maíz, grasa de pollo, pulpa de remolacha, vitaminas y minerales.',
          },
        },
      ],
      facts: [
        {
          variantKey: null,
          presentation: 'Bolsa 4 kg',
          declarations: [
            {
              key: 'contentMagnitude',
              state: 'known',
              value: 'mass',
              basis: 'El empaque declara el peso neto.',
            },
          ],
        },
      ],
    },
  },
  {
    key: 'fx-collar-cuero',
    name: 'Collar de Cuero Artesanal Ajustable',
    sku: 'SC-FX-COLLAR',
    category: 'Accesorios',
    brand: 'Talabartería Norte',
    description: 'Collar de cuero curtido con hebilla metálica, en dos tallas.',
    price: 349,
    mayoreo: 299,
    cost: 180,
    packaging: { weightG: 180, lengthCm: 25, widthCm: 12, heightCm: 4 },
    variants: [
      {
        key: 'm',
        name: 'Mediano',
        sku: 'SC-FX-COLLAR-M',
        price: 349,
        mayoreo: 299,
        stock: 3,
      },
      {
        key: 'l',
        name: 'Grande',
        sku: 'SC-FX-COLLAR-L',
        price: 389,
        mayoreo: 335,
        stock: 0,
      },
    ],
    images: [
      {
        url: 'https://upload.wikimedia.org/wikipedia/commons/2/22/Leather_dog_collar_made_by_Les_cuirs_d%27Agathe_%28DSC06406%29.jpg',
        credit: "Trougnouf (Benoit Brummer), Les cuirs d'Agathe",
        license: 'CC BY 4.0',
        sourcePage: commons(
          'Leather_dog_collar_made_by_Les_cuirs_d%27Agathe_(DSC06406).jpg',
        ),
      },
    ],
    editorial: {
      familyCode: 'accessory',
      commercialTitle: 'Collar de cuero ajustable para perro',
      description:
        'Collar de cuero curtido al vegetal, cosido a mano, con hebilla de acero y argolla para placa. Se ajusta en cinco posiciones.',
      values: ['m', 'l'].flatMap((variantKey) => [
        {
          code: 'animal.target',
          variantKey,
          payload: { type: 'multi', value: ['ani.dom.dog'] },
        },
        {
          code: 'accessory.type',
          variantKey,
          payload: { type: 'single', value: 'accessory.type.collar' },
        },
        {
          code: 'color.base',
          variantKey,
          payload: { type: 'multi', value: ['color.base.brown'] },
        },
        {
          code: 'accessory.closure',
          variantKey,
          payload: { type: 'multi', value: ['accessory.closure.buckle'] },
        },
        {
          code: 'accessory.feature',
          variantKey,
          payload: { type: 'multi', value: ['accessory.feature.adjustable'] },
        },
        {
          code: 'size.label',
          variantKey,
          payload: {
            type: 'single',
            value: variantKey === 'm' ? 'size.label.m' : 'size.label.l',
          },
        },
        {
          code: 'size.animal',
          variantKey,
          payload: {
            type: 'multi',
            value: [
              variantKey === 'm' ? 'size.animal.medium' : 'size.animal.large',
            ],
          },
        },
        {
          code: 'measure.fit.neck',
          variantKey,
          payload:
            variantKey === 'm'
              ? { type: 'range', min: 32, max: 42, unit: 'cm' }
              : { type: 'range', min: 40, max: 52, unit: 'cm' },
        },
      ]),
      facts: ['m', 'l'].map((variantKey) => ({
        variantKey,
        presentation: variantKey === 'm' ? 'Mediano' : 'Grande',
        declarations: [
          {
            key: 'fitDeterminesChoice',
            state: 'known',
            value: true,
            basis: 'La talla depende del cuello.',
          },
          {
            key: 'relevantFitCodes',
            state: 'known',
            value: ['measure.fit.neck'],
            basis: 'Se mide el contorno del cuello.',
          },
        ],
      })),
    },
  },
  {
    key: 'fx-shampoo-avena',
    name: 'Shampoo de Avena Coloidal para Perro 500 ml',
    sku: 'SC-FX-SHAMPOO-500',
    category: 'Higiene y cuidado',
    brand: 'Bosque Claro',
    description: 'Shampoo suave de avena coloidal para baño frecuente.',
    price: 199,
    mayoreo: 169,
    cost: 110,
    stock: 12,
    packaging: { weightG: 560, lengthCm: 21, widthCm: 7, heightCm: 6 },
    images: [
      {
        url: 'https://upload.wikimedia.org/wikipedia/commons/d/de/Shingoli_shampoo_Tick_n_flea_front.jpg',
        credit: 'Shingoli',
        license: 'CC BY-SA 4.0',
        sourcePage: commons('Shingoli_shampoo_Tick_n_flea_front.jpg'),
      },
    ],
    editorial: {
      familyCode: 'care',
      commercialTitle: 'Shampoo de avena para perro 500 ml',
      description:
        'Limpia sin resecar la piel. La avena coloidal calma la comezón y deja el pelo suave. Apto para baño semanal.',
      values: [
        {
          code: 'animal.target',
          variantKey: null,
          payload: { type: 'multi', value: ['ani.dom.dog'] },
        },
        {
          code: 'care.type',
          variantKey: null,
          payload: { type: 'single', value: 'care.type.grooming' },
        },
        {
          code: 'care.form',
          variantKey: null,
          payload: { type: 'single', value: 'care.form.solution' },
        },
        {
          code: 'pack.form',
          variantKey: null,
          payload: { type: 'single', value: 'pack.form.bottle' },
        },
        {
          code: 'measure.net_volume',
          variantKey: null,
          payload: { type: 'number', value: 500, unit: 'ml' },
        },
        {
          code: 'text.instructions',
          variantKey: null,
          payload: {
            type: 'text',
            value:
              'Moja el pelo, aplica, masajea 3 minutos y enjuaga con abundante agua.',
          },
        },
      ],
      facts: [
        {
          variantKey: null,
          presentation: 'Botella 500 ml',
          declarations: [
            {
              key: 'contentMagnitude',
              state: 'known',
              value: 'volume',
              basis: 'El empaque declara el volumen.',
            },
            {
              key: 'presentationKind',
              state: 'known',
              value: 'formulation',
              basis: 'Es un líquido para aplicar.',
            },
          ],
          careReview: {
            state: 'prepared',
            jurisdiction: 'MX',
            intendedUse: 'Baño de perros',
            determination: 'identified',
            evidence: CARE_EVIDENCE,
            basis: 'Revisión de la etiqueta',
            requirements: [
              {
                key: 'r1',
                description: 'Uso externo en perros',
                disposition: 'satisfied',
                evidence: CARE_EVIDENCE,
                basis: 'Indicado en el empaque',
              },
            ],
            warnings: [
              {
                key: 'w1',
                requirementKeys: ['r1'],
                text: 'Evitar el contacto con los ojos',
                disclosure: 'private_only',
                evidence: CARE_EVIDENCE,
                handlingBasis: 'Se explica en mostrador',
              },
            ],
          },
        },
      ],
    },
  },
];
