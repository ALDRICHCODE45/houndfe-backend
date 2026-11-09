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
  key: 'lamb-chop-plush',
  name: 'Multipet Lamb Chop peluche oveja con sonido para perro 25 cm',
  sku: 'SC-TOY-003',
  category: 'Juguetes para perro',
  brand: 'Multipet',
  description: 'Peluche de oveja Lamb Chop de 25 cm con chillador interno.',
  price: 259,
  mayoreo: 225,
  cost: 150,
  stock: 2,
  packaging: { weightG: 140, lengthCm: 27, widthCm: 14, heightCm: 9 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bb/Dog_with_Goofy_plush_toy.jpg/1280px-Dog_with_Goofy_plush_toy.jpg',
      'www.Pixel.la Free Stock Photos / Wikimedia Commons',
      'CC0',
      'https://commons.wikimedia.org/wiki/File:Dog_with_Goofy_plush_toy.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/60/Taro_the_Shiba_Inu_says_monkey_toy_is_MINE.jpg/1280px-Taro_the_Shiba_Inu_says_monkey_toy_is_MINE.jpg',
      'Taro the Shiba Inu / Wikimedia Commons',
      'CC BY 2.0',
      'https://commons.wikimedia.org/wiki/File:Taro_the_Shiba_Inu_says_monkey_toy_is_MINE.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6e/Gustavo_chewing_squeaky_toy_%28super_cute%29.jpg/1280px-Gustavo_chewing_squeaky_toy_%28super_cute%29.jpg',
      'Funkiestfarter / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:Gustavo_chewing_squeaky_toy_(super_cute).jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/80/Winston_the_Lion%2C_rope_toy_animal.jpg/1280px-Winston_the_Lion%2C_rope_toy_animal.jpg',
      'Tim Sheerman-Chase / Wikimedia Commons',
      'CC BY 2.0',
      'https://commons.wikimedia.org/wiki/File:Winston_the_Lion,_rope_toy_animal.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'toy',
    commercialTitle:
      'Lamb Chop de Multipet: peluche de oveja con chillador para perro, 25 cm',
    description: [
      'Lamb Chop es uno de los peluches para perro más queridos: una oveja suave, de tela tipo peluche, con la cara bordada y un chillador interno que suena cada vez que tu perro la aprieta. Es el juguete perfecto para cargar por la casa, acurrucarse en la siesta o jugar a la jala suave.',
      'Mide aproximadamente 25 cm, un tamaño cómodo para perros pequeños y medianos y para cachorros que empiezan a buscar un juguete propio. Los ojos y la nariz están bordados, sin piezas plásticas que puedan desprenderse.',
      'Es un juguete de compañía y juego suave, no un mordedor: si tu perro destroza peluches en minutos, elige mejor un juguete de caucho. Revisa las costuras con frecuencia y retíralo si el relleno o el chillador quedan expuestos.',
      'Cuidados: lávalo a mano con agua fría y jabón neutro y déjalo secar al aire. Supervisa siempre el juego.',
    ].join('\n\n'),
    values: [
      many('animal.target', ['ani.dom.dog']),
      many('life.stage', [
        'life.dog.puppy',
        'life.dog.adult',
        'life.dog.senior',
      ]),
      many('toy.type', ['toy.type.plush']),
      many('toy.feature', ['toy.feature.squeaker']),
      many('material', ['material.base.plush', 'material.base.polyester']),
      many('color.base', ['color.base.white', 'color.base.pink']),
      one('size.label', 'size.label.m'),
      many('size.animal', ['size.animal.small', 'size.animal.medium']),
      num('measure.dimensions.external_height', 25, 'cm'),
      one('pack.form', 'pack.form.wrap'),
      one('pack.sale', 'pack.sale.single'),
      text(
        'text.manufacturer_care',
        'Lavar a mano con agua fría y jabón neutro; secar al aire. Retirar si el relleno o el chillador quedan expuestos.',
      ),
      text(
        'text.instructions',
        'Juguete de compañía y juego suave, no apto como mordedor para perros destructores. Supervisa el juego y revisa las costuras con frecuencia.',
      ),
    ],
    declarations: [
      fact(
        'relevantDimensionCodes',
        {
          codes: ['measure.dimensions.external_height'],
          toyTypes: ['toy.type.plush'],
        },
        'El tamaño del peluche indica para qué perros es adecuado.',
      ),
    ],
    presentation: 'Peluche Lamb Chop de 25 cm',
  }),
};
