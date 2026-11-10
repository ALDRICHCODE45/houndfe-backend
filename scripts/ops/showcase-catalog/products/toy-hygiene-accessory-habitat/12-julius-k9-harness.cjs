'use strict';
const {
  bool,
  capacityIrrelevant,
  editorial,
  fact,
  image,
  many,
  notElectrical,
  one,
  range,
  text,
} = require('./shared.cjs');

const sizes = [
  {
    key: 'S',
    maker: 'Mini',
    chest: [49, 67],
    mass: [7, 15],
    animal: 'size.animal.small',
    price: 1099,
    mayoreo: 959,
    stock: 12,
  },
  {
    key: 'M',
    maker: '0',
    chest: [58, 76],
    mass: [14, 25],
    animal: 'size.animal.medium',
    price: 1249,
    mayoreo: 1089,
    stock: 0,
  },
  {
    key: 'L',
    maker: '1',
    chest: [63, 85],
    mass: [23, 30],
    animal: 'size.animal.large',
    price: 1399,
    mayoreo: 1219,
    stock: 6,
  },
];

module.exports = {
  key: 'julius-k9-idc-harness',
  name: 'Julius-K9 IDC Powerharness arnés acolchado para perro',
  sku: 'SC-ACC-002',
  category: 'Collares, correas y arneses',
  brand: 'Julius-K9',
  description:
    'Arnés acolchado con asa, hebillas de cierre rápido y reflejantes. Tallas Mini, 0 y 1.',
  price: 1099,
  mayoreo: 959,
  cost: 640,
  variants: sizes.map((s) => ({
    key: s.key,
    name: `Talla ${s.key} (${s.maker}, pecho ${s.chest[0]}–${s.chest[1]} cm)`,
    sku: `SC-ACC-002-${s.key}`,
    price: s.price,
    mayoreo: s.mayoreo,
    stock: s.stock,
  })),
  packaging: { weightG: 450, lengthCm: 30, widthCm: 22, heightCm: 6 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/83/Dog_Harness.JPG/1280px-Dog_Harness.JPG',
      'Juppi / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:Dog_Harness.JPG',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bf/Dog_in_a_harness.jpg/1280px-Dog_in_a_harness.jpg',
      'Sobaki2016 / Wikimedia Commons',
      'CC0',
      'https://commons.wikimedia.org/wiki/File:Dog_in_a_harness.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/19/Beagle_on_a_walk_%28DSC01880%29.jpg/1280px-Beagle_on_a_walk_%28DSC01880%29.jpg',
      'Trougnouf / Wikimedia Commons',
      'CC BY 4.0',
      'https://commons.wikimedia.org/wiki/File:Beagle_on_a_walk_(DSC01880).jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'accessory',
    commercialTitle:
      'Julius-K9 IDC Powerharness: arnés acolchado con asa y cierre rápido para perro mediano y grande',
    description: [
      'El IDC Powerharness de Julius-K9 es el arnés que usan perros de trabajo, rescate y policía en todo el mundo, y es igual de práctico para el paseo diario. Distribuye la fuerza del jalón sobre el pecho y no sobre el cuello, lo que protege la tráquea y da más control a quien lleva la correa.',
      'Su interior está acolchado con tela transpirable que evita rozaduras, y el exterior es resistente al agua. En el lomo tiene un asa firme para ayudar a tu perro a subir escaleras o al auto, o para sujetarlo con rapidez. Las cintas reflejantes y las etiquetas laterales intercambiables lo hacen visible de noche.',
      'Se pone en segundos: pasa por la cabeza y se cierra con una sola hebilla de liberación rápida en el pecho. La talla se elige por el contorno del pecho, medido justo detrás de las patas delanteras: S (Mini) de 49 a 67 cm, M (talla 0) de 58 a 76 cm y L (talla 1) de 63 a 85 cm. Como guía de peso, Mini es para perros de 7 a 15 kg, la 0 de 14 a 25 kg y la 1 de 23 a 30 kg.',
      'Ajusta las cintas de modo que quepan dos dedos entre el arnés y el cuerpo. Lávalo a mano con agua tibia; no lo metas a la secadora.',
    ].join('\n\n'),
    values: [
      many('animal.target', ['ani.dom.dog']),
      many('life.stage', ['life.dog.adult', 'life.dog.senior']),
      one('accessory.type', 'accessory.type.harness'),
      many('accessory.closure', [
        'accessory.closure.quick_release',
        'accessory.closure.buckle',
      ]),
      many('accessory.feature', [
        'accessory.feature.adjustable',
        'accessory.feature.padded',
        'accessory.feature.reflective',
      ]),
      many('material', ['material.base.nylon', 'material.base.polyester']),
      many('color.base', ['color.base.black']),
      one('pack.form', 'pack.form.wrap'),
      one('pack.sale', 'pack.sale.single'),
      bool('feature.washable', true),
      bool('feature.waterproof', true),
      text(
        'text.manufacturer_care',
        'Lavar a mano con agua tibia y jabón neutro; secar al aire, lejos de fuentes de calor.',
      ),
      text(
        'text.instructions',
        'Mide el contorno del pecho justo detrás de las patas delanteras y elige la talla. Pasa el arnés por la cabeza, cierra la hebilla del pecho y ajusta dejando dos dedos de holgura.',
      ),
    ],
    declarations: [
      fact(
        'fitDeterminesChoice',
        true,
        'La talla se elige por el contorno del pecho.',
      ),
      fact(
        'relevantFitCodes',
        ['measure.fit.chest'],
        'El fabricante publica el rango de pecho por talla.',
      ),
      ...capacityIrrelevant,
      ...notElectrical,
    ],
    variants: sizes.map((s) => ({
      key: s.key,
      presentation: `IDC Powerharness talla ${s.maker}`,
      values: [
        one('size.label', `size.label.${s.key.toLowerCase()}`),
        many('size.animal', [s.animal]),
        range('measure.fit.chest', s.chest[0], s.chest[1], 'cm'),
        range('measure.animal_mass', s.mass[0], s.mass[1], 'kg'),
      ],
    })),
  }),
};
