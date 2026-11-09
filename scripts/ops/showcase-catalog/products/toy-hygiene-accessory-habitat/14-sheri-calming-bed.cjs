'use strict';
const {
  bool,
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
    diameter: 58,
    height: 18,
    mass: [1, 11],
    animal: ['size.animal.miniature', 'size.animal.small'],
    price: 899,
    mayoreo: 785,
    stock: 7,
  },
  {
    key: 'M',
    diameter: 76,
    height: 20,
    mass: [11, 20],
    animal: ['size.animal.medium'],
    price: 1199,
    mayoreo: 1045,
    stock: 2,
  },
  {
    key: 'L',
    diameter: 91,
    height: 23,
    mass: [20, 45],
    animal: ['size.animal.large'],
    price: 1599,
    mayoreo: 1395,
    stock: 0,
  },
];

module.exports = {
  key: 'sheri-calming-donut-bed',
  name: 'Best Friends by Sheri cama dona antiestrés para perro y gato',
  sku: 'SC-ACC-004',
  category: 'Camas y descanso',
  brand: 'Best Friends by Sheri',
  description:
    'Cama redonda de pelo sintético con borde elevado, lavable a máquina. S, M y L.',
  price: 899,
  mayoreo: 785,
  cost: 520,
  variants: sizes.map((s) => ({
    key: s.key,
    name: `Talla ${s.key} (${s.diameter} cm)`,
    sku: `SC-ACC-004-${s.key}`,
    price: s.price,
    mayoreo: s.mayoreo,
    stock: s.stock,
  })),
  packaging: { weightG: 1800, lengthCm: 60, widthCm: 40, heightCm: 25 },
  images: [
    image(
      'https://upload.wikimedia.org/wikipedia/commons/f/f4/Dog_sleeping_in_a_dog_bed.JPG',
      'Tomwsulcer / Wikimedia Commons',
      'CC0',
      'https://commons.wikimedia.org/wiki/File:Dog_sleeping_in_a_dog_bed.JPG',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bd/Small_dog_in_doggy_bed.jpg/1280px-Small_dog_in_doggy_bed.jpg',
      'KarinaHolosko / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:Small_dog_in_doggy_bed.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/93/Jackshund_in_dog_bed.jpg/1280px-Jackshund_in_dog_bed.jpg',
      'D Eaketts / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:Jackshund_in_dog_bed.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'accessory',
    commercialTitle:
      'Cama dona antiestrés Best Friends by Sheri: pelo sintético suave y borde elevado, tallas S, M y L',
    description: [
      'La cama dona de Best Friends by Sheri se volvió famosa por una razón sencilla: los perros y gatos se acurrucan en ella y se quedan dormidos. Su forma redonda con borde elevado imita la sensación de dormir enroscado junto a su madre o a la camada, lo que da seguridad y ayuda a relajarse a mascotas nerviosas o con ansiedad.',
      'Está forrada de pelo sintético suave y esponjoso, y el borde relleno funciona como almohada para apoyar la cabeza y el cuello, algo que agradecen especialmente los perros mayores o con molestias articulares. La base es resistente al agua y a la suciedad, y no se desliza sobre pisos lisos.',
      'Elige la talla según el tamaño de tu mascota acostada: S de 58 cm para gatos y perros de hasta 11 kg, M de 76 cm para perros de 11 a 20 kg y L de 91 cm para perros de 20 a 45 kg. Si a tu perro le gusta estirarse al dormir, elige una talla más.',
      'Cuidados: es lavable a máquina completa, en ciclo delicado con agua fría, y se seca en secadora a temperatura baja. Sacúdela y esponja el relleno después de lavarla para que recupere su volumen.',
    ].join('\n\n'),
    values: [
      many('animal.target', ['ani.dom.dog', 'ani.dom.cat']),
      many('life.stage', [
        'life.dog.puppy',
        'life.dog.adult',
        'life.dog.senior',
        'life.cat.adult',
        'life.cat.senior',
      ]),
      one('accessory.type', 'accessory.type.bed'),
      many('accessory.feature', [
        'accessory.feature.padded',
        'accessory.feature.nonslip',
      ]),
      many('material', ['material.base.polyester', 'material.base.plush']),
      many('color.base', ['color.base.beige']),
      one('pack.form', 'pack.form.bag'),
      one('pack.sale', 'pack.sale.single'),
      bool('feature.washable', true),
      bool('feature.waterproof', false),
      text(
        'text.manufacturer_care',
        'Lavar a máquina en ciclo delicado con agua fría; secar en secadora a temperatura baja. Esponjar el relleno después de lavar.',
      ),
      text(
        'text.instructions',
        'Elige la talla midiendo a tu mascota acostada. Colócala en un lugar tranquilo y sin corrientes de aire para que la adopte como su espacio de descanso.',
      ),
    ],
    declarations: [...fitIrrelevant, ...capacityIrrelevant, ...notElectrical],
    variants: sizes.map((s) => ({
      key: s.key,
      presentation: `Cama dona talla ${s.key}, ${s.diameter} cm`,
      values: [
        one('size.label', `size.label.${s.key.toLowerCase()}`),
        many('size.animal', s.animal),
        num('measure.dimensions.external_diameter', s.diameter, 'cm'),
        num('measure.dimensions.external_height', s.height, 'cm'),
        range('measure.animal_mass', s.mass[0], s.mass[1], 'kg'),
      ],
    })),
  }),
};
