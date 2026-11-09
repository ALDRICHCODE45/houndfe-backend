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
    key: '45X45X45',
    dims: [45, 45, 45],
    volume: 91,
    price: 3299,
    mayoreo: 2879,
    stock: 2,
  },
  {
    key: '45X45X60',
    dims: [45, 45, 60],
    volume: 121,
    price: 3799,
    mayoreo: 3315,
    stock: 6,
  },
  {
    key: '60X45X60',
    dims: [60, 45, 60],
    volume: 162,
    price: 4599,
    mayoreo: 4015,
    stock: 0,
  },
];

module.exports = {
  key: 'exo-terra-glass-terrarium',
  name: 'Exo Terra terrario de vidrio con puertas frontales para reptiles',
  sku: 'SC-HAB-003',
  category: 'Terrarios y reptiles',
  brand: 'Exo Terra',
  description:
    'Terrario de vidrio con doble puerta frontal, tapa de malla y fondo texturizado. 3 medidas.',
  price: 3299,
  mayoreo: 2879,
  cost: 1950,
  variants: sizes.map((s) => ({
    key: s.key,
    name: `${s.dims[0]} x ${s.dims[1]} x ${s.dims[2]} cm`,
    sku: `SC-HAB-003-${s.key}`,
    price: s.price,
    mayoreo: s.mayoreo,
    stock: s.stock,
  })),
  packaging: { weightG: 16000, lengthCm: 52, widthCm: 50, heightCm: 52 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/67/Exo-terrarium.JPG/1280px-Exo-terrarium.JPG',
      'Pogrebnoj-Alexandroff / Wikimedia Commons',
      'CC BY 3.0',
      'https://commons.wikimedia.org/wiki/File:Exo-terrarium.JPG',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/cb/Empty_terrarium.jpg/1280px-Empty_terrarium.jpg',
      '3steph14 / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:Empty_terrarium.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4d/Leopardgekko_Luna.jpg/1280px-Leopardgekko_Luna.jpg',
      'Lugraff / Wikimedia Commons',
      'CC0',
      'https://commons.wikimedia.org/wiki/File:Leopardgekko_Luna.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'habitat',
    commercialTitle:
      'Terrario de vidrio Exo Terra con doble puerta frontal y tapa de malla, para geckos y reptiles pequeños',
    description: [
      'El terrario de vidrio de Exo Terra es el hábitat que eligen criadores y aficionados para geckos, anolis, pequeñas serpientes, ranas e invertebrados. Sus puertas frontales dobles se abren de manera independiente, así puedes alimentar o limpiar sin asustar al animal desde arriba, que es como lo atacaría un depredador, y un seguro especial evita que se escape.',
      'La tapa de malla metálica permite la entrada de luz UVB e infrarroja y deja espacio para colocar lámparas y calentadores. Un sistema de ventilación con entrada frontal inferior y salida superior mantiene el aire en circulación y evita que el vidrio se empañe. Incluye un fondo texturizado de espuma que imita la roca y da al animal superficie extra para trepar.',
      'La base elevada deja espacio para un calentador de sustrato y tiene orificios cerrables para pasar cables y tubos. Elige la medida según el animal: 45 x 45 x 45 cm para un gecko leopardo o anolis, 45 x 45 x 60 cm para especies que trepan como el gecko crestado, y 60 x 45 x 60 cm para un dragón barbudo juvenil o un grupo pequeño.',
      'El terrario no incluye equipo eléctrico, sustrato ni decoración: agrégalos según los requerimientos de la especie. Límpialo con un desinfectante apto para reptiles y enjuaga bien antes de volver a colocar al animal.',
    ].join('\n\n'),
    values: [
      many('animal.target', [
        'ani.lizard.leopard_gecko',
        'ani.lizard.crested_gecko',
        'ani.lizard_group.anoles',
        'ani.lizard_group.bearded_dragons',
        'ani.snake.corn_snake',
      ]),
      many('life.stage', ['life.reptile.juvenile', 'life.reptile.adult']),
      one('habitat.type', 'habitat.type.terrarium'),
      many('habitat.environment', [
        'habitat.environment.terrestrial',
        'habitat.environment.arboreal',
        'habitat.environment.indoor',
      ]),
      many('material', ['material.rigid.glass', 'material.rigid.steel']),
      many('color.base', ['color.base.black', 'color.base.transparent']),
      one('pack.form', 'pack.form.box'),
      one('pack.sale', 'pack.sale.single'),
      bool('feature.washable', true),
      text(
        'text.manufacturer_care',
        'Limpiar el vidrio y la base con desinfectante apto para reptiles y enjuagar bien. No usar limpiadores con amoniaco.',
      ),
      text(
        'text.instructions',
        'Colócalo sobre una superficie firme y nivelada. Agrega sustrato, iluminación y calefacción según la especie y verifica temperatura y humedad antes de introducir al animal.',
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
        'Las medidas exteriores definen el espacio del animal y dónde se coloca el terrario.',
      ),
      fact(
        'relevantCapacityCodes',
        ['measure.capacity.habitat_usable_volume'],
        'El fabricante declara el volumen interior.',
      ),
      ...notElectrical,
    ],
    variants: sizes.map((s) => ({
      key: s.key,
      presentation: `Terrario ${s.dims[0]} x ${s.dims[1]} x ${s.dims[2]} cm`,
      values: [
        num('measure.dimensions.external_length', s.dims[0], 'cm'),
        num('measure.dimensions.external_width', s.dims[1], 'cm'),
        num('measure.dimensions.external_height', s.dims[2], 'cm'),
        num('measure.capacity.habitat_usable_volume', s.volume, 'l'),
      ],
    })),
  }),
};
