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
    key: 'M',
    name: 'Mediana 6.4 cm (paquete de 2)',
    diameter: 6.4,
    count: 2,
    sale: 'pack.sale.multipack',
    animal: ['size.animal.small', 'size.animal.medium'],
    mass: [5, 27],
    price: 229,
    mayoreo: 199,
    stock: 42,
  },
  {
    key: 'L',
    name: 'Grande 7.3 cm (1 pieza)',
    diameter: 7.3,
    count: 1,
    sale: 'pack.sale.single',
    animal: ['size.animal.large', 'size.animal.giant'],
    mass: [27, 45],
    price: 189,
    mayoreo: 165,
    stock: 2,
  },
];

module.exports = {
  key: 'chuckit-ultra-ball',
  name: 'Chuckit! Ultra Ball pelota de caucho que rebota y flota',
  sku: 'SC-TOY-002',
  category: 'Juguetes para perro',
  brand: 'Chuckit!',
  description:
    'Pelota de caucho de alto rebote, flota en agua. Compatible con lanzador Chuckit!.',
  price: 229,
  mayoreo: 199,
  cost: 128,
  variants: sizes.map((s) => ({
    key: s.key,
    name: s.name,
    sku: `SC-TOY-002-${s.key}`,
    price: s.price,
    mayoreo: s.mayoreo,
    stock: s.stock,
  })),
  packaging: { weightG: 220, lengthCm: 15, widthCm: 8, heightCm: 8 },
  images: [
    image(
      'https://upload.wikimedia.org/wikipedia/commons/8/87/Dog_with_dog_ball_launcher.jpg',
      'Richard Thomas / Wikimedia Commons',
      'CC BY 2.0',
      'https://commons.wikimedia.org/wiki/File:Dog_with_dog_ball_launcher.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/f/fd/Labrador_Retriever_with_orange_ball.jpg/1280px-Labrador_Retriever_with_orange_ball.jpg',
      'TamasCristina / Wikimedia Commons',
      'Public domain',
      'https://commons.wikimedia.org/wiki/File:Labrador_Retriever_with_orange_ball.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/22/Ball_launcher_ball_throwing_in_the_snow.jpg/1280px-Ball_launcher_ball_throwing_in_the_snow.jpg',
      'Gord Webster / Wikimedia Commons',
      'CC BY-SA 2.0',
      'https://commons.wikimedia.org/wiki/File:Ball_launcher_ball_throwing_in_the_snow.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'toy',
    commercialTitle:
      'Chuckit! Ultra Ball: pelota de caucho de alto rebote que flota, para juegos de buscar',
    description: [
      'La Ultra Ball de Chuckit! está pensada para perros que viven para correr detrás de una pelota. Su caucho natural de pared gruesa rebota alto y de forma impredecible, resiste mordidas mucho mejor que una pelota de tenis y no tiene fieltro que se deshilache o que desgaste los dientes con el tiempo.',
      'Flota en el agua, así que es la compañera ideal para la alberca, el lago o la playa, y su color naranja con azul de alta visibilidad la hace fácil de encontrar en el pasto. La superficie lisa se limpia en segundos: basta enjuagarla para quitar tierra, arena o saliva.',
      'Cada talla encaja en el lanzador Chuckit! correspondiente, que te permite lanzarla más lejos sin agacharte ni tocar la pelota babeada. La mediana (6.4 cm) se vende en paquete de dos y es adecuada para perros pequeños y medianos; la grande (7.3 cm) se vende por pieza y es para razas grandes y gigantes. Elige siempre una pelota que tu perro no pueda meter completa en la boca.',
      'Juega bajo supervisión y retira la pelota si presenta cortes o pedazos desprendidos. Después de nadar, sécala antes de guardarla.',
    ].join('\n\n'),
    values: [
      many('animal.target', ['ani.dom.dog']),
      many('life.stage', ['life.dog.adult']),
      many('toy.type', ['toy.type.ball', 'toy.type.floating']),
      many('material', ['material.base.rubber']),
      many('color.base', ['color.base.orange', 'color.base.blue']),
      one('pack.form', 'pack.form.wrap'),
      one('content.kind', 'content.kind.count'),
      text(
        'text.manufacturer_care',
        'Enjuagar con agua y jabón neutro y dejar secar. Retirar si presenta cortes o pedazos desprendidos.',
      ),
      text(
        'text.instructions',
        'Lánzala con la mano o con el lanzador Chuckit! de la talla correspondiente. Elige una talla que tu perro no pueda meter completa en la boca y supervisa el juego.',
      ),
    ],
    declarations: [
      fact(
        'relevantDimensionCodes',
        {
          codes: ['measure.dimensions.external_diameter'],
          toyTypes: ['toy.type.ball', 'toy.type.floating'],
        },
        'El diámetro define la talla y la compatibilidad con el lanzador.',
      ),
      fact(
        'contentMagnitude',
        'count',
        'El empaque indica el número de pelotas.',
      ),
    ],
    variants: sizes.map((s) => ({
      key: s.key,
      presentation: `Ultra Ball ${s.name}`,
      values: [
        one('size.label', `size.label.${s.key.toLowerCase()}`),
        many('size.animal', s.animal),
        one('pack.sale', s.sale),
        num('measure.content_count', s.count, 'piece'),
        num('measure.dimensions.external_diameter', s.diameter, 'cm'),
        range('measure.animal_mass', s.mass[0], s.mass[1], 'kg'),
      ],
    })),
  }),
};
