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
  key: 'cat-feather-wand',
  name: 'Fancy Pets varita para gato con plumas y cascabel',
  sku: 'SC-TOY-004',
  category: 'Juguetes para gato',
  brand: 'Fancy Pets',
  description:
    'Varita flexible de 45 cm con cordón, plumas naturales y cascabel.',
  price: 129,
  mayoreo: 112,
  cost: 62,
  stock: 40,
  packaging: { weightG: 60, lengthCm: 50, widthCm: 8, heightCm: 3 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1f/Lenny_with_Da_Bird.JPG/1280px-Lenny_with_Da_Bird.JPG',
      'Reiny79 / Wikimedia Commons',
      'CC BY-SA 3.0',
      'https://commons.wikimedia.org/wiki/File:Lenny_with_Da_Bird.JPG',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/08/Tabby_kitten_playing_with_lure.jpg/1280px-Tabby_kitten_playing_with_lure.jpg',
      'Dcoetzee / Wikimedia Commons',
      'Public domain',
      'https://commons.wikimedia.org/wiki/File:Tabby_kitten_playing_with_lure.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/cd/Miyako_is_playing_with_a_fishing-rod_toy_%287756356192%29.jpg/1280px-Miyako_is_playing_with_a_fishing-rod_toy_%287756356192%29.jpg',
      'Takashi Hososhima from Tokyo, Japan / Wikimedia Commons',
      'CC BY-SA 2.0',
      'https://commons.wikimedia.org/wiki/File:Miyako_is_playing_with_a_fishing-rod_toy_(7756356192).jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c8/Black_and_white_kitten_biting_lure_from_back.jpg/1280px-Black_and_white_kitten_biting_lure_from_back.jpg',
      'Dcoetzee / Wikimedia Commons',
      'Public domain',
      'https://commons.wikimedia.org/wiki/File:Black_and_white_kitten_biting_lure_from_back.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'toy',
    commercialTitle:
      'Varita para gato Fancy Pets con plumas y cascabel: juego interactivo de caza',
    description: [
      'Pocas cosas despiertan tanto el instinto cazador de un gato como unas plumas que vuelan, se esconden y aparecen de nuevo. Esta varita de Fancy Pets combina una vara flexible de 45 cm, un cordón resistente y un señuelo de plumas con cascabel que imita el movimiento y el sonido de una presa.',
      'El juego con varita es la forma más completa de ejercitar a un gato de interior: salta, acecha, corre y atrapa, quemando energía acumulada y reduciendo conductas como morder manos o arañar muebles. Diez a quince minutos al día, idealmente antes de su comida, ayudan a mantener un peso sano y un gato más tranquilo por la noche.',
      'Funciona igual para gatitos curiosos que para gatos adultos y sénior; solo ajusta la intensidad. Mueve el señuelo lejos de su cuerpo, déjalo atrapar la presa de vez en cuando para que el juego sea satisfactorio y termina siempre con una captura.',
      'Importante: es un juguete interactivo para usar contigo. Guárdalo fuera del alcance del gato al terminar, porque el cordón y las plumas no deben quedar a su disposición sin supervisión.',
    ].join('\n\n'),
    values: [
      many('animal.target', ['ani.dom.cat']),
      many('life.stage', [
        'life.cat.kitten',
        'life.cat.adult',
        'life.cat.senior',
      ]),
      many('toy.type', ['toy.type.wand', 'toy.type.teaser']),
      many('toy.feature', ['toy.feature.bell', 'toy.feature.interactive']),
      many('material', ['material.rigid.plastic', 'material.base.nylon']),
      many('color.base', ['color.base.multicolor']),
      one('size.label', 'size.label.one_size'),
      num('measure.dimensions.external_length', 45, 'cm'),
      one('pack.form', 'pack.form.wrap'),
      one('pack.sale', 'pack.sale.single'),
      text(
        'text.manufacturer_care',
        'Limpiar la vara con un paño húmedo. No sumergir las plumas. Guardar fuera del alcance del gato.',
      ),
      text(
        'text.instructions',
        'Mueve el señuelo imitando a una presa y deja que tu gato lo atrape de vez en cuando. Usar siempre bajo supervisión; no dejar el cordón al alcance del gato al terminar.',
      ),
    ],
    declarations: [
      fact(
        'relevantDimensionCodes',
        {
          codes: ['measure.dimensions.external_length'],
          toyTypes: ['toy.type.wand', 'toy.type.teaser'],
        },
        'El largo de la vara define la distancia de juego.',
      ),
    ],
    presentation: 'Varita con plumas de 45 cm',
  }),
};
