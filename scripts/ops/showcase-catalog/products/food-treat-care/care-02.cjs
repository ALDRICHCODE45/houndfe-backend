'use strict';
const {
  single,
  multi,
  num,
  range,
  text,
  perVariant,
  decl,
  fact,
  careReview,
  commons,
} = require('./shared.cjs');

const keys = ['2_4kg', '4_10kg', '10_25kg', '25_50kg'];
const presentation = {
  '2_4kg': 'Caja con 1 tableta masticable (2 a 4 kg)',
  '4_10kg': 'Caja con 1 tableta masticable (4.1 a 10 kg)',
  '10_25kg': 'Caja con 1 tableta masticable (10.1 a 25 kg)',
  '25_50kg': 'Caja con 1 tableta masticable (25.1 a 50 kg)',
};
const dose = {
  '2_4kg': '11.3 mg',
  '4_10kg': '28.3 mg',
  '10_25kg': '68 mg',
  '25_50kg': '136 mg',
};
const review = careReview({
  intendedUse: 'Tratamiento y prevención de pulgas y garrapatas en perros',
  basis: 'Revisión de la etiqueta y del registro del producto veterinario',
  sourceRef: 'Etiqueta e instructivo del empaque',
  requirements: [
    {
      key: 'registro-senasica',
      description:
        'Registro SENASICA/SADER vigente para producto farmacéutico veterinario',
      basis: 'Número de registro impreso en el empaque',
    },
    {
      key: 'presentacion-por-peso',
      description:
        'La presentación vendida corresponde al rango de peso declarado en la caja',
      basis: 'Rango de peso impreso en la caja',
    },
  ],
  warnings: [
    {
      key: 'neurologico',
      requirementKeys: ['registro-senasica'],
      text: 'Usar con precaución en perros con antecedentes de convulsiones.',
      handlingBasis: 'Se informa en mostrador al momento de la venta',
    },
  ],
});

module.exports = {
  key: 'nexgard-tableta-masticable',
  name: 'NexGard Antipulgas y Garrapatas Tableta Masticable',
  sku: 'SC-CARE-002',
  category: 'Salud y bienestar',
  brand: 'NexGard',
  description:
    'Tableta masticable antipulgas y garrapatas para perro, protección por un mes.',
  price: 369,
  mayoreo: 325,
  cost: 255,
  variants: [
    {
      key: '2_4kg',
      name: '2 a 4 kg',
      sku: 'SC-CARE-002-S',
      price: 369,
      mayoreo: 325,
      stock: 14,
    },
    {
      key: '4_10kg',
      name: '4.1 a 10 kg',
      sku: 'SC-CARE-002-M',
      price: 389,
      mayoreo: 342,
      stock: 25,
    },
    {
      key: '10_25kg',
      name: '10.1 a 25 kg',
      sku: 'SC-CARE-002-L',
      price: 429,
      mayoreo: 378,
      stock: 3,
    },
    {
      key: '25_50kg',
      name: '25.1 a 50 kg',
      sku: 'SC-CARE-002-XL',
      price: 479,
      mayoreo: 421,
      stock: 0,
    },
  ],
  packaging: { weightG: 25, lengthCm: 9, widthCm: 2, heightCm: 7 },
  images: [
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6a/BeagleScratching.jpg/1280px-BeagleScratching.jpg',
      'BeagleScratching.jpg',
      'Rlevse',
      'Public domain',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bb/Brown_Dog_Tick._Rhipicephalus_sanguineus_-_Flickr_-_gailhampshire_%281%29.jpg/1280px-Brown_Dog_Tick._Rhipicephalus_sanguineus_-_Flickr_-_gailhampshire_%281%29.jpg',
      'Brown Dog Tick. Rhipicephalus sanguineus - Flickr - gailhampshire (1).jpg',
      'gailhampshire from Cradley, Malvern, U.K',
      'CC BY 2.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/07/Gun_dog_running_on_grass.JPG/1280px-Gun_dog_running_on_grass.JPG',
      'Gun dog running on grass.JPG',
      'Editor abcdef',
      'CC0',
    ),
  ],
  editorial: {
    familyCode: 'care',
    commercialTitle:
      'NexGard tableta masticable antipulgas y garrapatas para perro, protección de un mes',
    description: [
      'NexGard es una tableta masticable con sabor a carne de res que protege a tu perro contra pulgas y garrapatas durante un mes completo. Es la forma más sencilla de mantenerlo libre de parásitos externos: sin pipetas, sin baños y sin esperar a que se seque antes de salir a pasear o de abrazarlo.',
      'Su principio activo, afoxolaner, empieza a eliminar pulgas en las primeras 8 horas y garrapatas dentro de 48 horas, antes de que las pulgas puedan poner huevos. Es eficaz contra la garrapata café del perro (Rhipicephalus sanguineus), la más común en México, y ayuda a controlar la dermatitis alérgica por picadura de pulga.',
      'Como se administra por boca, la protección no se pierde con el agua, el baño ni la natación. La mayoría de los perros la comen como si fuera un premio. Elige la presentación según el peso actual de tu perro.',
      'Modo de uso: administra 1 tableta al mes por vía oral, con o sin alimento, eligiendo la presentación que corresponda al peso de tu perro. Apta para perros desde las 8 semanas de edad y 2 kg de peso. Para mantener la protección durante todo el año, repite cada 30 días.',
    ].join('\n\n'),
    values: perVariant(
      [
        multi('animal.target', ['ani.dom.dog']),
        multi('life.stage', [
          'life.dog.puppy',
          'life.dog.adult',
          'life.dog.senior',
        ]),
        single('care.type', 'care.type.medicine'),
        single('care.form', 'care.form.tablet'),
        single('pack.form', 'pack.form.box'),
        single('pack.sale', 'pack.sale.single'),
        single('content.kind', 'content.kind.count'),
        num('measure.content_count', 1, 'dose_unit'),
        text(
          'text.composition',
          'Afoxolaner. Excipientes con sabor a carne de res c.b.p. 1 tableta masticable.',
        ),
        text(
          'text.instructions',
          '1 tableta al mes por vía oral, con o sin alimento, según el peso del perro. Desde 8 semanas de edad y 2 kg. Repetir cada 30 días.',
        ),
        text(
          'text.regulatory_warnings',
          'Uso veterinario. Consulte al médico veterinario. Usar con precaución en perros con antecedentes de convulsiones. No usar en otras especies. Manténgase fuera del alcance de los niños.',
        ),
        text(
          'text.manufacturer_care',
          'Consérvese por debajo de 30 °C en su empaque original.',
        ),
        text(
          'text.clinical_analysis',
          'Pulgas: inicio de acción en 8 horas. Garrapatas (Rhipicephalus sanguineus, Dermacentor variabilis, Amblyomma americanum): eliminación en 48 horas. Duración: 30 días.',
        ),
      ],
      keys,
      {
        '2_4kg': [
          range('measure.animal_mass', 2, 4, 'kg'),
          text(
            'text.concentration',
            `Afoxolaner ${dose['2_4kg']} por tableta.`,
          ),
        ],
        '4_10kg': [
          range('measure.animal_mass', 4.1, 10, 'kg'),
          text(
            'text.concentration',
            `Afoxolaner ${dose['4_10kg']} por tableta.`,
          ),
        ],
        '10_25kg': [
          range('measure.animal_mass', 10.1, 25, 'kg'),
          text(
            'text.concentration',
            `Afoxolaner ${dose['10_25kg']} por tableta.`,
          ),
        ],
        '25_50kg': [
          range('measure.animal_mass', 25.1, 50, 'kg'),
          text(
            'text.concentration',
            `Afoxolaner ${dose['25_50kg']} por tableta.`,
          ),
        ],
      },
    ),
    facts: keys.map((key) =>
      fact(
        key,
        presentation[key],
        [
          decl('contentMagnitude', 'count'),
          decl('presentationKind', 'formulation'),
        ],
        review,
      ),
    ),
  },
};
