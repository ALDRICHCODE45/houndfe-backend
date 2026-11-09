'use strict';
const {
  single,
  multi,
  num,
  text,
  perVariant,
  decl,
  fact,
  commons,
} = require('./shared.cjs');

const keys = ['sobre', 'caja12'];
const presentation = {
  sobre: 'Sobre de 85 g',
  caja12: 'Caja con 12 sobres de 85 g',
};

module.exports = {
  key: 'whiskas-gatitos-pollo-sobre',
  name: 'Whiskas Gatitos Pollo en Salsa Sobre 85 g',
  sku: 'SC-FOOD-006',
  category: 'Alimento para gato',
  brand: 'Whiskas',
  description:
    'Alimento húmedo para gatitos de 2 a 12 meses, trozos de pollo en salsa.',
  price: 18,
  mayoreo: 16,
  cost: 12.5,
  variants: [
    {
      key: 'sobre',
      name: 'Sobre 85 g',
      sku: 'SC-FOOD-006-SOBRE',
      price: 18,
      mayoreo: 16,
      stock: 80,
    },
    {
      key: 'caja12',
      name: 'Caja 12 sobres',
      sku: 'SC-FOOD-006-CAJA12',
      price: 199,
      mayoreo: 175,
      stock: 4,
    },
  ],
  packaging: { weightG: 95, lengthCm: 9, widthCm: 2, heightCm: 13 },
  images: [
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5c/Kitten_Pair_Eating_01.jpg/1280px-Kitten_Pair_Eating_01.jpg',
      'Kitten Pair Eating 01.jpg',
      'Achat1999',
      'CC BY-SA 4.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bb/Kitten_eating_%283338962011%29.jpg/1280px-Kitten_eating_%283338962011%29.jpg',
      'Kitten eating (3338962011).jpg',
      'Kevin Dooley from Chandler, AZ, USA',
      'CC BY 2.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/38/2024-02-04_Callie_and_Holiday_eat_wet_cat_food.png/1280px-2024-02-04_Callie_and_Holiday_eat_wet_cat_food.png',
      '2024-02-04 Callie and Holiday eat wet cat food.png',
      'Kitten Academy',
      'CC BY 3.0',
    ),
  ],
  editorial: {
    familyCode: 'food',
    commercialTitle:
      'Whiskas Gatitos trozos de pollo en salsa, alimento húmedo para gatitos de 2 a 12 meses',
    description: [
      'Whiskas Gatitos Pollo en Salsa es un alimento húmedo completo para gatitos de 2 a 12 meses. Sus trozos tiernos de pollo bañados en salsa son fáciles de comer para dientes en desarrollo y tienen el sabor y el aroma que los gatitos buscan desde sus primeras comidas sólidas.',
      'Aporta proteína de calidad para el crecimiento muscular, DHA para el desarrollo cerebral, calcio y vitamina D para huesos y dientes fuertes, y taurina para la salud del corazón y la vista. Su alto contenido de humedad (alrededor del 80 %) ayuda a que tu gatito se mantenga bien hidratado, algo importante para la salud de sus vías urinarias.',
      'Puedes darlo solo o combinarlo con alimento seco para gatitos. El sobre individual es práctico para una comida; la caja de 12 sobres rinde casi dos semanas para un gatito.',
      'Modo de uso: sirve a temperatura ambiente. Un gatito de 2 a 4 meses necesita de 3 a 4 sobres al día como alimentación única, repartidos en varias tomas; si lo combinas con alimento seco, reduce la cantidad según la tabla del empaque. Refrigera el sobrante tapado y consúmelo dentro de 24 horas.',
    ].join('\n\n'),
    values: perVariant(
      [
        multi('animal.target', ['ani.dom.cat']),
        multi('life.stage', ['life.cat.kitten']),
        single('food.format', 'food.format.chunks'),
        single('food.role', 'food.role.complete'),
        multi('food.process', ['food.process.canned']),
        multi('food.texture', ['food.texture.moist', 'food.texture.soft']),
        single('content.kind', 'content.kind.mass'),
        text(
          'text.ingredients',
          'Pollo y subproductos de pollo, agua, almidón de maíz, aceite de pescado (fuente de DHA), minerales, goma guar, taurina, vitaminas (incluye D3 y E).',
        ),
        text('text.protein_origin', 'Pollo y subproductos de pollo.'),
        text(
          'text.composition',
          'Proteína cruda (mín.) 8 %, grasa cruda (mín.) 4 %, fibra cruda (máx.) 1 %, humedad (máx.) 82 %, cenizas (máx.) 2.5 %.',
        ),
        text(
          'text.instructions',
          'Servir a temperatura ambiente. Alimentación única: 3 a 4 sobres al día para un gatito de 2 a 4 meses, en varias tomas. Refrigera el sobrante tapado y consúmelo en 24 horas.',
        ),
        text(
          'text.clinical_analysis',
          'Energía metabolizable aproximada: 85 kcal por sobre.',
        ),
      ],
      keys,
      {
        sobre: [
          single('pack.form', 'pack.form.pouch'),
          single('pack.sale', 'pack.sale.single'),
          num('measure.net_mass', 85, 'g'),
        ],
        caja12: [
          single('pack.form', 'pack.form.box'),
          single('pack.sale', 'pack.sale.multipack'),
          num('measure.net_mass', 1020, 'g'),
          num('measure.pack_count', 12, 'unit'),
        ],
      },
    ),
    facts: keys.map((key) =>
      fact(key, presentation[key], [decl('contentMagnitude', 'mass')]),
    ),
  },
};
