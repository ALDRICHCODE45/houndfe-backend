'use strict';
const {
  editorial,
  fact,
  image,
  many,
  num,
  one,
  text,
} = require('./shared.cjs');

module.exports = {
  key: 'dog-brick-puzzle',
  name: 'Outward Hound Nina Ottosson Dog Brick rompecabezas para perro nivel 2',
  sku: 'SC-TOY-005',
  category: 'Juguetes para perro',
  brand: 'Outward Hound',
  description:
    'Rompecabezas dispensador de premios nivel intermedio, 32 x 32 cm.',
  price: 599,
  mayoreo: 525,
  cost: 360,
  stock: 0,
  packaging: { weightG: 750, lengthCm: 34, widthCm: 34, heightCm: 6 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a1/Blue_Slow_Feeder_Dog_Bowl_with_Raised_Studs_and_Ridges.jpg/1280px-Blue_Slow_Feeder_Dog_Bowl_with_Raised_Studs_and_Ridges.jpg',
      'ELTORO.VET / Wikimedia Commons',
      'CC0',
      'https://commons.wikimedia.org/wiki/File:Blue_Slow_Feeder_Dog_Bowl_with_Raised_Studs_and_Ridges.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/03/Gamelle_anti-glouton_-_1.jpg/1280px-Gamelle_anti-glouton_-_1.jpg',
      'Lionel Allorge / Wikimedia Commons',
      'CC BY-SA 3.0',
      'https://commons.wikimedia.org/wiki/File:Gamelle_anti-glouton_-_1.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/cc/Fawn_French_bulldog_chewing_a_green_toy.jpg/1280px-Fawn_French_bulldog_chewing_a_green_toy.jpg',
      'Maria Tsveshko / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:Fawn_French_bulldog_chewing_a_green_toy.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'toy',
    commercialTitle:
      'Nina Ottosson Dog Brick: rompecabezas interactivo con premios para perro, nivel 2 intermedio',
    description: [
      'El Dog Brick, diseñado por la sueca Nina Ottosson y fabricado por Outward Hound, convierte la hora del premio en un reto mental. El tablero esconde premios bajo bloques deslizantes y tapas abatibles: tu perro debe usar la nariz y las patas para descubrir cómo moverlos y ganarse cada recompensa.',
      'Quince minutos de juego mental cansan tanto como una caminata. Los rompecabezas ayudan a perros inquietos, a razas de trabajo que se aburren con facilidad, a perros que comen demasiado rápido y a perros mayores que necesitan mantenerse activos sin esfuerzo físico intenso.',
      'Es de nivel 2 (intermedio): ideal para perros que ya dominan juguetes sencillos o como segundo paso después de un rompecabezas de nivel 1. Los bloques son de plástico sin BPA, la base tiene topes antideslizantes y el tablero mide 32 x 32 cm, un tamaño cómodo para perros de cualquier talla.',
      'Cómo usarlo: muéstrale a tu perro dónde escondes los premios las primeras veces, felicítalo cada vez que acierte y retira el juguete al terminar; no es un mordedor y debe usarse siempre bajo supervisión. Lávalo a mano con agua tibia y jabón.',
    ].join('\n\n'),
    values: [
      many('animal.target', ['ani.dom.dog']),
      many('life.stage', [
        'life.dog.puppy',
        'life.dog.adult',
        'life.dog.senior',
      ]),
      many('toy.type', ['toy.type.puzzle', 'toy.type.dispenser']),
      many('toy.feature', [
        'toy.feature.treat_dispensing',
        'toy.feature.interactive',
      ]),
      many('material', ['material.rigid.plastic']),
      many('color.base', ['color.base.blue', 'color.base.white']),
      one('size.label', 'size.label.one_size'),
      many('size.animal', [
        'size.animal.small',
        'size.animal.medium',
        'size.animal.large',
      ]),
      num('measure.dimensions.external_length', 32, 'cm'),
      num('measure.dimensions.external_width', 32, 'cm'),
      num('measure.dimensions.external_height', 4.5, 'cm'),
      one('pack.form', 'pack.form.box'),
      one('pack.sale', 'pack.sale.single'),
      text(
        'text.manufacturer_care',
        'Lavar a mano con agua tibia y jabón neutro. No usar en lavavajillas.',
      ),
      text(
        'text.instructions',
        'Esconde premios bajo los bloques y enseña a tu perro a moverlos. Usar siempre bajo supervisión y retirar el juguete al terminar; no es un mordedor.',
      ),
    ],
    declarations: [
      fact(
        'relevantDimensionCodes',
        {
          codes: [
            'measure.dimensions.external_length',
            'measure.dimensions.external_width',
          ],
          toyTypes: ['toy.type.puzzle', 'toy.type.dispenser'],
        },
        'El largo y el ancho del tablero indican el espacio de juego.',
      ),
    ],
    presentation: 'Rompecabezas Dog Brick 32 x 32 cm',
  }),
};
