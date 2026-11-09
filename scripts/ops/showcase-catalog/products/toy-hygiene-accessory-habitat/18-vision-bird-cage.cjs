'use strict';
const {
  bool,
  editorial,
  fact,
  image,
  many,
  notElectrical,
  num,
  one,
  text,
} = require('./shared.cjs');

const sizes = [
  {
    key: 'S01',
    name: 'Modelo S01 (chica)',
    dims: [47, 36, 51],
    price: 1899,
    mayoreo: 1659,
    stock: 5,
  },
  {
    key: 'M01',
    name: 'Modelo M01 (mediana)',
    dims: [61, 39, 58],
    price: 2599,
    mayoreo: 2269,
    stock: 0,
  },
];

module.exports = {
  key: 'vision-bird-cage',
  name: 'Vision jaula para aves pequeñas con perchas y comederos',
  sku: 'SC-HAB-002',
  category: 'Aves',
  brand: 'Vision',
  description:
    'Jaula para periquitos y canarios con base honda anti-tiradero, perchas y comederos. S01 y M01.',
  price: 1899,
  mayoreo: 1659,
  cost: 1120,
  variants: sizes.map((s) => ({
    key: s.key,
    name: `${s.name}, ${s.dims[0]} x ${s.dims[1]} x ${s.dims[2]} cm`,
    sku: `SC-HAB-002-${s.key}`,
    price: s.price,
    mayoreo: s.mayoreo,
    stock: s.stock,
  })),
  packaging: { weightG: 4200, lengthCm: 52, widthCm: 40, heightCm: 30 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/16/Budgerigars_in_a_cage.jpg/1280px-Budgerigars_in_a_cage.jpg',
      'Mordzinski / Wikimedia Commons',
      'CC BY-SA 3.0',
      'https://commons.wikimedia.org/wiki/File:Budgerigars_in_a_cage.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/90/Budgie_002.jpg/1280px-Budgie_002.jpg',
      'Solaris2006 / Wikimedia Commons',
      'CC BY-SA 3.0',
      'https://commons.wikimedia.org/wiki/File:Budgie_002.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f0/2_domesticated_budgerigars.jpg/1280px-2_domesticated_budgerigars.jpg',
      'PigeonJesus / Wikimedia Commons',
      'CC0',
      'https://commons.wikimedia.org/wiki/File:2_domesticated_budgerigars.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'habitat',
    commercialTitle:
      'Jaula Vision para periquitos, canarios y aves pequeñas: base honda anti-tiradero, perchas y comederos',
    description: [
      'La jaula Vision fue diseñada junto con veterinarios aviares para que tus aves vivan cómodas y tú limpies menos. Su base honda de plástico atrapa semillas, plumas y cáscaras dentro de la jaula, de modo que el piso alrededor queda limpio, y la parte superior de alambre se separa de la base con dos broches para lavarla por completo.',
      'Incluye perchas de diferentes grosores, que ejercitan las patas y evitan lesiones, y comederos y bebedero que se llenan desde afuera a través de puertas abatibles, sin tener que meter la mano ni dejar escapar a las aves. Los barrotes horizontales facilitan que trepen, y la puerta frontal amplia permite meter la mano para sacarlas o acariciarlas.',
      'El modelo S01 (47 x 36 x 51 cm) es adecuado para una pareja de periquitos australianos, canarios o diamantes mandarín; el modelo M01 (61 x 39 x 58 cm) da más espacio de vuelo para dos a cuatro aves pequeñas o para una ninfa.',
      'Coloca la jaula a la altura de tus ojos, lejos de corrientes de aire, de la cocina y del sol directo. Cambia el agua y retira las cáscaras a diario, y lava la base cada semana con agua y jabón neutro.',
    ].join('\n\n'),
    values: [
      many('animal.target', [
        'ani.bird_pet.budgerigar',
        'ani.bird_pet.canary',
        'ani.bird_pet.zebra_finch',
        'ani.bird_pet.cockatiel',
      ]),
      many('life.stage', ['life.bird.juvenile', 'life.bird.adult']),
      one('habitat.type', 'habitat.type.cage'),
      many('habitat.environment', ['habitat.environment.indoor']),
      many('habitat.component', [
        'habitat.component.perch',
        'habitat.component.feeder',
      ]),
      many('material', [
        'material.rigid.steel',
        'material.rigid.polypropylene',
      ]),
      many('color.base', ['color.base.white', 'color.base.blue']),
      one('pack.form', 'pack.form.box'),
      one('pack.sale', 'pack.sale.kit'),
      bool('feature.washable', true),
      text(
        'text.manufacturer_care',
        'Separar la parte superior de la base y lavar con agua y jabón neutro cada semana. Secar antes de volver a armar.',
      ),
      text(
        'text.instructions',
        'Coloca la jaula a la altura de los ojos, lejos de corrientes de aire, cocina y sol directo. Cambia el agua y retira las cáscaras todos los días.',
      ),
    ],
    declarations: [
      fact(
        'relevantDimensionCodes',
        {
          codes: [
            'measure.dimensions.external_length',
            'measure.dimensions.external_width',
            'measure.dimensions.external_height',
          ],
          toyTypes: [],
        },
        'Las medidas exteriores indican el espacio de vuelo y dónde cabe la jaula.',
      ),
      fact(
        'relevantCapacityCodes',
        [],
        'La jaula se elige por medidas, no por volumen.',
      ),
      ...notElectrical,
    ],
    variants: sizes.map((s) => ({
      key: s.key,
      presentation: `Jaula Vision ${s.name}`,
      values: [
        num('measure.dimensions.external_length', s.dims[0], 'cm'),
        num('measure.dimensions.external_width', s.dims[1], 'cm'),
        num('measure.dimensions.external_height', s.dims[2], 'cm'),
      ],
    })),
  }),
};
