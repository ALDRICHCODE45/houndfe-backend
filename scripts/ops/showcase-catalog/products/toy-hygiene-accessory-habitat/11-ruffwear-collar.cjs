'use strict';
const {
  bool,
  capacityIrrelevant,
  editorial,
  fact,
  image,
  many,
  notElectrical,
  num,
  one,
  range,
  text,
} = require('./shared.cjs');

const sizes = [
  {
    key: 'S',
    neck: [28, 36],
    width: 1.9,
    animal: 'size.animal.small',
    stock: 18,
  },
  {
    key: 'M',
    neck: [36, 51],
    width: 2.5,
    animal: 'size.animal.medium',
    stock: 22,
  },
  {
    key: 'L',
    neck: [51, 66],
    width: 2.5,
    animal: 'size.animal.large',
    stock: 3,
  },
];

module.exports = {
  key: 'ruffwear-front-range-collar',
  name: 'Ruffwear Front Range collar reflejante ajustable para perro',
  sku: 'SC-ACC-001',
  category: 'Collares, correas y arneses',
  brand: 'Ruffwear',
  description:
    'Collar de cinta de nylon con hebilla de liberación rápida y anillo de aluminio. S, M, L.',
  price: 649,
  mayoreo: 565,
  cost: 380,
  variants: sizes.map((s) => ({
    key: s.key,
    name: `Talla ${s.key} (cuello ${s.neck[0]}–${s.neck[1]} cm)`,
    sku: `SC-ACC-001-${s.key}`,
    price: 649,
    mayoreo: 565,
    stock: s.stock,
  })),
  packaging: { weightG: 120, lengthCm: 20, widthCm: 10, heightCm: 4 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/14/Beagle_dog_-_red_1.jpg/1280px-Beagle_dog_-_red_1.jpg',
      'Sciencia58 / Wikimedia Commons',
      'CC0',
      'https://commons.wikimedia.org/wiki/File:Beagle_dog_-_red_1.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e6/Paco_Large_Dog_Collars_%284321127788%29.jpg/1280px-Paco_Large_Dog_Collars_%284321127788%29.jpg',
      'Fido Factor from USA / Wikimedia Commons',
      'CC BY-SA 2.0',
      'https://commons.wikimedia.org/wiki/File:Paco_Large_Dog_Collars_(4321127788).jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/81/Hund_-_brindle.jpg/1280px-Hund_-_brindle.jpg',
      'Sciencia58 / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:Hund_-_brindle.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'accessory',
    commercialTitle:
      'Ruffwear Front Range: collar reflejante ajustable con broche de liberación rápida, tallas S, M y L',
    description: [
      'El collar Front Range de Ruffwear está hecho para el uso diario y para las aventuras de fin de semana. Su cinta de nylon tubular es suave al tacto, no irrita el cuello y resiste el agua, el lodo y el uso intenso sin deshilacharse.',
      'Tiene costuras reflejantes en ambos bordes para que tu perro sea visible para los autos en los paseos al amanecer o de noche. El broche de liberación rápida se abre con una mano, y el anillo en V de aluminio para la correa queda separado del aro para la placa de identificación, así las placas no chocan con el mosquetón.',
      'Elige la talla midiendo el contorno del cuello de tu perro con una cinta flexible, en la parte donde normalmente lleva el collar: S para cuellos de 28 a 36 cm, M de 36 a 51 cm y L de 51 a 66 cm. Ajústalo de modo que quepan dos dedos entre el collar y el cuello.',
      'Cuidados: lávalo a mano con agua tibia y jabón suave y déjalo secar al aire. Revisa el broche y las costuras periódicamente. Para perros que jalan mucho, combina el collar con un arnés para el paseo.',
    ].join('\n\n'),
    values: [
      many('animal.target', ['ani.dom.dog']),
      many('life.stage', ['life.dog.adult', 'life.dog.senior']),
      one('accessory.type', 'accessory.type.collar'),
      many('accessory.closure', ['accessory.closure.quick_release']),
      many('accessory.feature', [
        'accessory.feature.adjustable',
        'accessory.feature.reflective',
      ]),
      many('material', ['material.base.nylon', 'material.rigid.aluminium']),
      many('color.base', ['color.base.blue']),
      one('pack.form', 'pack.form.wrap'),
      one('pack.sale', 'pack.sale.single'),
      bool('feature.washable', true),
      bool('feature.waterproof', false),
      text(
        'text.manufacturer_care',
        'Lavar a mano con agua tibia y jabón suave; secar al aire. No usar secadora.',
      ),
      text(
        'text.instructions',
        'Mide el contorno del cuello y elige la talla. Ajusta de modo que quepan dos dedos entre el collar y el cuello; revisa el ajuste cada semana en cachorros en crecimiento.',
      ),
    ],
    declarations: [
      fact(
        'fitDeterminesChoice',
        true,
        'La talla se elige por el contorno del cuello.',
      ),
      fact(
        'relevantFitCodes',
        ['measure.fit.neck'],
        'El fabricante publica el rango de cuello por talla.',
      ),
      ...capacityIrrelevant,
      ...notElectrical,
    ],
    variants: sizes.map((s) => ({
      key: s.key,
      presentation: `Collar Front Range talla ${s.key}`,
      values: [
        one('size.label', `size.label.${s.key.toLowerCase()}`),
        many('size.animal', [s.animal]),
        range('measure.fit.neck', s.neck[0], s.neck[1], 'cm'),
        num('measure.dimensions.external_width', s.width, 'cm'),
      ],
    })),
  }),
};
