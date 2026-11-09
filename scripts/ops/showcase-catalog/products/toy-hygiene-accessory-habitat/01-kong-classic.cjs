'use strict';
const {
  editorial,
  fact,
  image,
  many,
  num,
  one,
  range,
  text,
} = require('./shared.cjs');

const sizes = [
  {
    key: 'S',
    label: 'Chico',
    height: 7,
    diameter: 4.5,
    mass: [2, 9],
    animal: 'size.animal.small',
    price: 219,
    mayoreo: 193,
    stock: 25,
    weight: 90,
  },
  {
    key: 'M',
    label: 'Mediano',
    height: 8.9,
    diameter: 5.7,
    mass: [7, 16],
    animal: 'size.animal.medium',
    price: 279,
    mayoreo: 245,
    stock: 3,
    weight: 150,
  },
  {
    key: 'L',
    label: 'Grande',
    height: 10.2,
    diameter: 6.6,
    mass: [13, 30],
    animal: 'size.animal.large',
    price: 339,
    mayoreo: 298,
    stock: 0,
    weight: 230,
  },
];

module.exports = {
  key: 'kong-classic',
  name: 'KONG Classic juguete mordedor rellenable para perro',
  sku: 'SC-TOY-001',
  category: 'Juguetes para perro',
  brand: 'KONG',
  description:
    'Mordedor de caucho natural rojo, rellenable con premios. Tallas S, M y L.',
  price: 219,
  mayoreo: 193,
  cost: 140,
  variants: sizes.map((s) => ({
    key: s.key,
    name: `Talla ${s.key} (${s.label})`,
    sku: `SC-TOY-001-${s.key}`,
    price: s.price,
    mayoreo: s.mayoreo,
    stock: s.stock,
  })),
  packaging: { weightG: 180, lengthCm: 12, widthCm: 9, heightCm: 9 },
  images: [
    image(
      'https://upload.wikimedia.org/wikipedia/commons/e/e7/Dog_with_red_kong.jpg',
      'Hawkins / Wikimedia Commons',
      'CC BY 2.0',
      'https://commons.wikimedia.org/wiki/File:Dog_with_red_kong.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/33/KONG_-_the_perfect_toy_for_a_dog_%2850750992992%29.jpg/1280px-KONG_-_the_perfect_toy_for_a_dog_%2850750992992%29.jpg',
      'Olgierd / Wikimedia Commons',
      'CC BY 2.0',
      'https://commons.wikimedia.org/wiki/File:KONG_-_the_perfect_toy_for_a_dog_(50750992992).jpg',
    ),
    image(
      'https://upload.wikimedia.org/wikipedia/commons/1/19/Dog_with_black_KONG_toy.jpg',
      'Ginny / Wikimedia Commons',
      'CC BY-SA 2.0',
      'https://commons.wikimedia.org/wiki/File:Dog_with_black_KONG_toy.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8a/Dog_enjoying_black_kong_toy.jpg/1280px-Dog_enjoying_black_kong_toy.jpg',
      'Tudor / Wikimedia Commons',
      'CC BY-SA 2.0',
      'https://commons.wikimedia.org/wiki/File:Dog_enjoying_black_kong_toy.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'toy',
    commercialTitle:
      'KONG Classic: mordedor de caucho natural rellenable para perro, tallas S, M y L',
    description: [
      'El KONG Classic es el juguete que los adiestradores y veterinarios recomiendan desde hace décadas para perros que necesitan morder, mantenerse ocupados o pasar tiempo solos sin aburrirse. Su forma de muñeco de nieve y el caucho natural rojo, firme pero elástico, lo hacen rebotar de manera impredecible, así que también funciona como juguete de lanzar y buscar.',
      'Su centro hueco se rellena con croquetas, premios, pasta para KONG o comida húmeda. Para tu perro se vuelve un reto: lame, mastica y gira el juguete para sacar cada bocado, lo que canaliza la energía, reduce la ansiedad por separación y ayuda a evitar que muerda muebles o zapatos. Si lo congelas ya relleno, el reto dura mucho más, ideal para días calurosos o para perros muy rápidos.',
      'Elige la talla según el peso de tu perro: S para perros de 2 a 9 kg, M para perros de 7 a 16 kg y L para perros de 13 a 30 kg. Si tu perro está entre dos tallas o es un masticador intenso, elige la talla mayor; el juguete debe ser más grande que su boca para que no pueda tragarlo.',
      'Cuidados: lávalo con agua tibia y jabón neutro o en la rejilla superior del lavavajillas. Revisa el juguete con regularidad y reemplázalo si presenta grietas o pedazos faltantes. Como con cualquier juguete, supervisa a tu perro las primeras veces que lo use.',
    ].join('\n\n'),
    values: [
      many('animal.target', ['ani.dom.dog']),
      many('life.stage', ['life.dog.adult']),
      many('toy.type', ['toy.type.chew', 'toy.type.dispenser']),
      many('toy.feature', [
        'toy.feature.refillable',
        'toy.feature.treat_dispensing',
      ]),
      many('material', ['material.base.rubber']),
      many('color.base', ['color.base.red']),
      one('pack.form', 'pack.form.wrap'),
      one('pack.sale', 'pack.sale.single'),
      text(
        'text.manufacturer_care',
        'Lavar con agua tibia y jabón neutro, o en la rejilla superior del lavavajillas. Reemplazar si presenta grietas o piezas faltantes.',
      ),
      text(
        'text.instructions',
        'Rellena el centro con croquetas, premios o pasta para KONG; para un reto mayor, congélalo relleno. Elige una talla más grande que la boca de tu perro y supervisa su uso.',
      ),
    ],
    declarations: [
      fact(
        'relevantDimensionCodes',
        {
          codes: ['measure.dimensions.external_height'],
          toyTypes: ['toy.type.chew', 'toy.type.dispenser'],
        },
        'La altura del juguete define la talla adecuada para el tamaño de la boca del perro.',
      ),
    ],
    variants: sizes.map((s) => ({
      key: s.key,
      presentation: `KONG Classic talla ${s.key}`,
      values: [
        one('size.label', `size.label.${s.key.toLowerCase()}`),
        many('size.animal', [s.animal]),
        num('measure.dimensions.external_height', s.height, 'cm'),
        num('measure.dimensions.external_diameter', s.diameter, 'cm'),
        range('measure.animal_mass', s.mass[0], s.mass[1], 'kg'),
      ],
    })),
  }),
};
