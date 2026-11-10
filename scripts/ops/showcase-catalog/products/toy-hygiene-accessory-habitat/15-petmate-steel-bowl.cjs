'use strict';
const {
  bool,
  editorial,
  fact,
  fitIrrelevant,
  image,
  many,
  notElectrical,
  num,
  one,
  text,
} = require('./shared.cjs');

const sizes = [
  {
    key: 'S',
    capacity: 0.47,
    diameter: 15,
    animal: ['size.animal.miniature', 'size.animal.small'],
    price: 149,
    mayoreo: 129,
    stock: 48,
  },
  {
    key: 'M',
    capacity: 0.95,
    diameter: 19,
    animal: ['size.animal.medium'],
    price: 199,
    mayoreo: 173,
    stock: 26,
  },
  {
    key: 'L',
    capacity: 1.9,
    diameter: 24,
    animal: ['size.animal.large', 'size.animal.giant'],
    price: 269,
    mayoreo: 235,
    stock: 1,
  },
];

module.exports = {
  key: 'petmate-steel-bowl',
  name: 'Petmate plato de acero inoxidable con base antiderrapante',
  sku: 'SC-ACC-005',
  category: 'Comederos y bebederos',
  brand: 'Petmate',
  description:
    'Plato para agua o alimento de acero inoxidable con aro de goma. 0.47, 0.95 y 1.9 l.',
  price: 149,
  mayoreo: 129,
  cost: 82,
  variants: sizes.map((s) => ({
    key: s.key,
    name: `Talla ${s.key} (${s.capacity} l)`,
    sku: `SC-ACC-005-${s.key}`,
    price: s.price,
    mayoreo: s.mayoreo,
    stock: s.stock,
  })),
  packaging: { weightG: 350, lengthCm: 22, widthCm: 22, heightCm: 7 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/ce/Dog_bowls_1_2022-12-04.jpeg/1280px-Dog_bowls_1_2022-12-04.jpeg',
      'FASTILY / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:Dog_bowls_1_2022-12-04.jpeg',
    ),
    image(
      'https://upload.wikimedia.org/wikipedia/commons/f/f1/Large_Dog_food_bowl.jpg',
      'Ohiopetwatch / Wikimedia Commons',
      'CC BY-SA 3.0',
      'https://commons.wikimedia.org/wiki/File:Large_Dog_food_bowl.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ee/Male_Corgi-Dachshund_mix_drinking_water.JPG/1280px-Male_Corgi-Dachshund_mix_drinking_water.JPG',
      'BrokenSphere / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:Male_Corgi-Dachshund_mix_drinking_water.JPG',
    ),
  ],
  editorial: editorial({
    familyCode: 'accessory',
    commercialTitle:
      'Plato de acero inoxidable Petmate con base antiderrapante para agua o alimento, 0.47 a 1.9 l',
    description: [
      'El plato de acero inoxidable de Petmate es la opción más higiénica para el agua y el alimento de tu mascota. A diferencia del plástico, el acero no se raya, no guarda olores ni bacterias en su superficie y no provoca el acné de barbilla que algunos perros y gatos desarrollan con platos plásticos.',
      'Su base tiene un aro de goma que evita que el plato se deslice por el piso mientras tu mascota come o bebe, y protege el piso de rayones y ruido. El borde redondeado facilita levantarlo y limpiarlo.',
      'Elige la capacidad según el tamaño y la ración de tu mascota: 0.47 l (15 cm) para gatos y perros miniatura o pequeños, 0.95 l (19 cm) para perros medianos y 1.9 l (24 cm) para perros grandes y gigantes. Para el agua, considera una capacidad mayor que la ración diaria y cámbiala al menos una vez al día.',
      'Cuidados: retira el aro de goma y lava el plato a mano o en el lavavajillas. Lávalo a diario para mantenerlo libre de residuos.',
    ].join('\n\n'),
    values: [
      many('animal.target', ['ani.dom.dog', 'ani.dom.cat']),
      one('accessory.type', 'accessory.type.bowl'),
      many('accessory.feature', ['accessory.feature.nonslip']),
      many('material', ['material.rigid.stainless', 'material.base.rubber']),
      many('color.base', ['color.base.grey']),
      one('pack.form', 'pack.form.wrap'),
      one('pack.sale', 'pack.sale.single'),
      bool('feature.washable', true),
      bool('feature.reusable', true),
      text(
        'text.manufacturer_care',
        'Retirar el aro de goma y lavar a mano o en lavavajillas. Lavar a diario.',
      ),
      text(
        'text.instructions',
        'Elige la capacidad según la ración de tu mascota. Para agua, cámbiala al menos una vez al día y coloca el plato sobre una superficie plana.',
      ),
    ],
    declarations: [
      ...fitIrrelevant,
      fact(
        'capacityDeterminesChoice',
        true,
        'El tamaño se elige por la capacidad del plato.',
      ),
      fact(
        'relevantCapacityCodes',
        ['measure.capacity.container'],
        'El fabricante declara la capacidad por talla.',
      ),
      ...notElectrical,
    ],
    variants: sizes.map((s) => ({
      key: s.key,
      presentation: `Plato de acero ${s.capacity} l`,
      values: [
        one('size.label', `size.label.${s.key.toLowerCase()}`),
        many('size.animal', s.animal),
        num('measure.capacity.container', s.capacity, 'l'),
        num('measure.dimensions.external_diameter', s.diameter, 'cm'),
      ],
    })),
  }),
};
