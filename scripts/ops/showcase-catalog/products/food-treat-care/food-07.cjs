'use strict';
const {
  single,
  multi,
  num,
  text,
  decl,
  fact,
  commons,
} = require('./shared.cjs');

module.exports = {
  key: 'pedigree-adulto-lata-res',
  name: 'Pedigree Adulto Trozos de Res en Salsa Lata 375 g',
  sku: 'SC-FOOD-007',
  category: 'Alimento para perro',
  brand: 'Pedigree',
  description:
    'Alimento húmedo para perro adulto, trozos de res en salsa, lata 375 g.',
  price: 49,
  mayoreo: 43,
  cost: 33,
  stock: 0,
  packaging: { weightG: 430, lengthCm: 8, widthCm: 8, heightCm: 11 },
  images: [
    commons(
      'https://upload.wikimedia.org/wikipedia/commons/4/4f/Dog_Food_%28208810939%29.jpg',
      'Dog Food (208810939).jpg',
      'chrismetcalfTV',
      'CC BY 2.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e6/A_Labrador_Retriever_in_Aurora%2C_Colorado.jpg/1280px-A_Labrador_Retriever_in_Aurora%2C_Colorado.jpg',
      'A Labrador Retriever in Aurora, Colorado.jpg',
      'Muldoonsamuel',
      'CC0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d4/Labrador_Retriever_-_Yellow.JPG/1280px-Labrador_Retriever_-_Yellow.JPG',
      'Labrador Retriever - Yellow.JPG',
      'Skansken',
      'CC BY 3.0',
    ),
  ],
  editorial: {
    familyCode: 'food',
    commercialTitle:
      'Pedigree Adulto trozos de res en salsa, alimento húmedo en lata de 375 g',
    description: [
      'Pedigree Adulto Trozos de Res en Salsa es un alimento húmedo completo para perros adultos de todas las razas. Sus trozos jugosos de res en una salsa espesa son irresistibles y convierten cualquier comida en un momento especial, ya sea como alimento único o mezclado con croquetas.',
      'Cada lata aporta proteína de origen animal para mantener músculos fuertes, vitaminas y minerales esenciales para una vida activa, y una alta proporción de agua que ayuda a la hidratación diaria. La fórmula incluye omega-6 y zinc para una piel sana y un pelaje brillante.',
      'Mezclar una porción de alimento húmedo con el alimento seco hace la comida más apetecible para perros selectivos o mayores, y facilita que tomen más líquido.',
      'Modo de uso: un perro adulto de 10 kg necesita aproximadamente 2 latas al día como alimentación única; si lo combinas con croquetas, sustituye media lata por cada 40 g de alimento seco. Sirve a temperatura ambiente. Una vez abierta, tapa la lata, refrigérala y consúmela dentro de 48 horas.',
    ].join('\n\n'),
    values: [
      multi('animal.target', ['ani.dom.dog']),
      multi('life.stage', ['life.dog.adult']),
      multi('size.animal', [
        'size.animal.small',
        'size.animal.medium',
        'size.animal.large',
      ]),
      single('food.format', 'food.format.chunks'),
      single('food.role', 'food.role.complete'),
      multi('food.process', ['food.process.canned']),
      multi('food.texture', ['food.texture.moist', 'food.texture.soft']),
      single('pack.form', 'pack.form.can'),
      single('pack.sale', 'pack.sale.single'),
      single('content.kind', 'content.kind.mass'),
      num('measure.net_mass', 375, 'g'),
      text(
        'text.ingredients',
        'Carne y subproductos de res, subproductos de pollo, agua suficiente para el procesamiento, almidón de maíz, harina de trigo, sal, goma guar, colorante caramelo, cloruro de potasio, vitaminas y minerales.',
      ),
      text('text.protein_origin', 'Res y subproductos de pollo.'),
      text(
        'text.composition',
        'Proteína cruda (mín.) 7 %, grasa cruda (mín.) 4 %, fibra cruda (máx.) 1 %, humedad (máx.) 80 %.',
      ),
      text(
        'text.instructions',
        'Perro de 10 kg: unas 2 latas al día como alimentación única. Combinado: media lata sustituye unos 40 g de croqueta. Refrigera la lata abierta y consúmela en 48 horas.',
      ),
      text(
        'text.clinical_analysis',
        'Energía metabolizable aproximada: 330 kcal por lata.',
      ),
    ],
    facts: [fact(null, 'Lata de 375 g', [decl('contentMagnitude', 'mass')])],
  },
};
