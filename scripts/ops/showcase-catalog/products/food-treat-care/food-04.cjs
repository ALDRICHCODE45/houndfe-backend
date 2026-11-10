'use strict';
const {
  single,
  multi,
  num,
  range,
  text,
  perVariant,
  decl,
  fact,
  commons,
} = require('./shared.cjs');

const keys = ['1kg', '3kg', '7_5kg'];
const presentation = {
  '1kg': 'Bolsa de 1 kg',
  '3kg': 'Bolsa de 3 kg',
  '7_5kg': 'Bolsa de 7.5 kg',
};

module.exports = {
  key: 'pro-plan-adulto-razas-pequenas',
  name: 'Pro Plan Adulto Razas Pequeñas',
  sku: 'SC-FOOD-004',
  category: 'Alimento para perro',
  brand: 'Purina Pro Plan',
  description:
    'Alimento seco para perros adultos de razas pequeñas y miniatura.',
  price: 279,
  mayoreo: 245,
  cost: 199,
  variants: [
    {
      key: '1kg',
      name: '1 kg',
      sku: 'SC-FOOD-004-1KG',
      price: 279,
      mayoreo: 245,
      stock: 65,
    },
    {
      key: '3kg',
      name: '3 kg',
      sku: 'SC-FOOD-004-3KG',
      price: 719,
      mayoreo: 632,
      stock: 27,
    },
    {
      key: '7_5kg',
      name: '7.5 kg',
      sku: 'SC-FOOD-004-7_5KG',
      price: 1529,
      mayoreo: 1345,
      stock: 2,
    },
  ],
  packaging: { weightG: 1100, lengthCm: 24, widthCm: 8, heightCm: 34 },
  images: [
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7c/Chiot_Norwich_terrier.jpg/1280px-Chiot_Norwich_terrier.jpg',
      'Chiot Norwich terrier.jpg',
      'Gamma Corvi',
      'CC BY-SA 4.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2b/Biewer_Yorkshire_Terrier_2.jpg/1280px-Biewer_Yorkshire_Terrier_2.jpg',
      'Biewer Yorkshire Terrier 2.jpg',
      'Sciencia58',
      'CC0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/7/71/Dog_food_in_a_bowl.jpg/1280px-Dog_food_in_a_bowl.jpg',
      'Dog food in a bowl.jpg',
      'James Redekop',
      'CC BY-SA 2.0',
    ),
  ],
  editorial: {
    familyCode: 'food',
    commercialTitle:
      'Pro Plan Adulto Razas Pequeñas con OptiHealth, pollo y arroz para perros de hasta 10 kg',
    description: [
      'Purina Pro Plan Adulto Razas Pequeñas es un alimento completo para perros adultos de razas miniatura y pequeñas, de 1 a 10 kg. Los perros chicos tienen un metabolismo más acelerado y necesitan más energía por kilo de peso corporal que un perro grande; esta fórmula concentra los nutrientes en una ración pequeña para cubrir esa demanda.',
      'Contiene pollo como ingrediente principal y el sistema OptiHealth, que combina proteínas de alta calidad, antioxidantes y prebióticos naturales para fortalecer las defensas y mantener una digestión saludable. Aporta ácidos grasos omega-3 y omega-6 para la piel y el pelaje, y vitamina A para el cuidado de la vista.',
      'La croqueta es pequeña, densa y crujiente, adecuada para hocicos chicos, y su textura ayuda a reducir la acumulación de sarro durante la masticación.',
      'Modo de uso: ofrece la ración diaria dividida en dos tomas según el peso de tu perro (tabla del empaque). Ajusta según la actividad física y la condición corporal. Agua fresca siempre disponible.',
    ].join('\n\n'),
    values: perVariant(
      [
        multi('animal.target', ['ani.dom.dog']),
        multi('life.stage', ['life.dog.adult']),
        multi('size.animal', ['size.animal.miniature', 'size.animal.small']),
        single('food.format', 'food.format.kibble'),
        single('food.role', 'food.role.complete'),
        multi('food.process', ['food.process.extruded']),
        multi('food.texture', ['food.texture.dry', 'food.texture.crunchy']),
        single('pack.form', 'pack.form.bag'),
        single('pack.sale', 'pack.sale.single'),
        single('content.kind', 'content.kind.mass'),
        range('measure.animal_mass', 1, 10, 'kg'),
        text(
          'text.ingredients',
          'Pollo, arroz, harina de subproductos de pollo, gluten de maíz, trigo entero, grasa animal preservada con tocoferoles mixtos, pulpa de remolacha, raíz de achicoria (prebiótico), aceite de pescado, minerales, vitaminas.',
        ),
        text('text.protein_origin', 'Pollo y harina de subproductos de pollo.'),
        text(
          'text.composition',
          'Proteína cruda (mín.) 29 %, grasa cruda (mín.) 17 %, fibra cruda (máx.) 3 %, humedad (máx.) 12 %.',
        ),
        text(
          'text.instructions',
          'Ración diaria en dos tomas según el peso (tabla del empaque). Ajusta por actividad y condición corporal. Agua fresca siempre disponible.',
        ),
        text(
          'text.clinical_analysis',
          'Energía metabolizable aproximada: 4,100 kcal/kg.',
        ),
      ],
      keys,
      {
        '1kg': [num('measure.net_mass', 1, 'kg')],
        '3kg': [num('measure.net_mass', 3, 'kg')],
        '7_5kg': [num('measure.net_mass', 7.5, 'kg')],
      },
    ),
    facts: keys.map((key) =>
      fact(key, presentation[key], [decl('contentMagnitude', 'mass')]),
    ),
  },
};
