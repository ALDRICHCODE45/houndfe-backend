'use strict';
const {
  capacityIrrelevant,
  editorial,
  fitIrrelevant,
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
    mass: [1, 15],
    animal: 'size.animal.small',
    color: 'color.base.red',
    price: 499,
    mayoreo: 435,
    stock: 30,
  },
  {
    key: 'M',
    mass: [5, 25],
    animal: 'size.animal.medium',
    color: 'color.base.blue',
    price: 599,
    mayoreo: 525,
    stock: 4,
  },
  {
    key: 'L',
    mass: [10, 50],
    animal: 'size.animal.large',
    color: 'color.base.black',
    price: 749,
    mayoreo: 655,
    stock: 9,
  },
];

module.exports = {
  key: 'flexi-new-classic-tape',
  name: 'Flexi New Classic correa retráctil de cinta 5 m para perro',
  sku: 'SC-ACC-003',
  category: 'Collares, correas y arneses',
  brand: 'Flexi',
  description:
    'Correa retráctil de cinta de 5 m con botón de freno. S hasta 15 kg, M hasta 25 kg, L hasta 50 kg.',
  price: 499,
  mayoreo: 435,
  cost: 290,
  variants: sizes.map((s) => ({
    key: s.key,
    name: `Talla ${s.key} (hasta ${s.mass[1]} kg)`,
    sku: `SC-ACC-003-${s.key}`,
    price: s.price,
    mayoreo: s.mayoreo,
    stock: s.stock,
  })),
  packaging: { weightG: 400, lengthCm: 20, widthCm: 14, heightCm: 6 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ac/KleineUndGrosseRollleine.jpg/1280px-KleineUndGrosseRollleine.jpg',
      'Weyershausen / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:KleineUndGrosseRollleine.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6e/ClassicNeon.jpg/1280px-ClassicNeon.jpg',
      'Weyershausen / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:ClassicNeon.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9d/SeilGurtRollleinen.jpg/1280px-SeilGurtRollleinen.jpg',
      'Weyershausen / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:SeilGurtRollleinen.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'accessory',
    commercialTitle:
      'Flexi New Classic: correa retráctil de cinta de 5 m con freno de un botón, tallas S, M y L',
    description: [
      'La New Classic de Flexi, fabricada en Alemania, es la correa retráctil más vendida del mundo. Le da a tu perro hasta 5 metros de libertad para olfatear y explorar, y a ti el control total con un sistema de freno de un botón: presionas para detener la cinta y deslizas el seguro para bloquearla a la longitud que quieras.',
      'La cinta plana es más visible y más resistente que el cordón, no se enreda con facilidad y no corta si roza la piel. El mecanismo interno de resorte recoge la cinta de forma suave y constante, y la empuñadura ergonómica se adapta a la mano incluso en paseos largos.',
      'Elige la talla según el peso de tu perro: S para perros de hasta 15 kg, M de hasta 25 kg y L de hasta 50 kg. Nunca uses una talla menor a la indicada, porque el freno y la cinta están calibrados para ese peso máximo.',
      'Recomendaciones: engánchala a un collar o arnés bien ajustado, mantén la cinta corta cerca de calles y otras personas, y no la sueltes nunca con la cinta extendida. Revisa la cinta con frecuencia y reemplaza la correa si está deshilachada. Limpia la carcasa con un paño húmedo.',
    ].join('\n\n'),
    values: [
      many('animal.target', ['ani.dom.dog']),
      many('life.stage', ['life.dog.adult', 'life.dog.senior']),
      one('accessory.type', 'accessory.type.leash'),
      many('accessory.closure', ['accessory.closure.snap']),
      many('accessory.feature', ['accessory.feature.portable']),
      many('material', ['material.base.nylon', 'material.rigid.abs']),
      one('pack.form', 'pack.form.box'),
      one('pack.sale', 'pack.sale.single'),
      num('measure.dimensions.external_length', 5, 'm'),
      text(
        'text.manufacturer_care',
        'Limpiar la carcasa con un paño húmedo; no sumergir el mecanismo en agua. Reemplazar si la cinta está deshilachada.',
      ),
      text(
        'text.instructions',
        'Elige la talla por el peso máximo de tu perro. Presiona el botón para frenar y desliza el seguro para bloquear. No sueltes la correa con la cinta extendida.',
      ),
    ],
    declarations: [...fitIrrelevant, ...capacityIrrelevant, ...notElectrical],
    variants: sizes.map((s) => ({
      key: s.key,
      presentation: `New Classic cinta 5 m talla ${s.key}`,
      values: [
        one('size.label', `size.label.${s.key.toLowerCase()}`),
        many('size.animal', [s.animal]),
        many('color.base', [s.color]),
        range('measure.animal_mass', s.mass[0], s.mass[1], 'kg'),
      ],
    })),
  }),
};
