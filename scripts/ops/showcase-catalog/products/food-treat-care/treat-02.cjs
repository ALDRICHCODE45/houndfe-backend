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
  key: 'milk-bone-original-mediana',
  name: 'Milk-Bone Galletas Original Medianas 680 g',
  sku: 'SC-TREAT-002',
  category: 'Premios y snacks',
  brand: 'Milk-Bone',
  description:
    'Galletas horneadas en forma de hueso para perros medianos, caja 680 g.',
  price: 169,
  mayoreo: 148,
  cost: 112,
  stock: 37,
  packaging: { weightG: 720, lengthCm: 20, widthCm: 7, heightCm: 28 },
  images: [
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/7/70/Milk_Bone_%28160088273%29.jpeg/1280px-Milk_Bone_%28160088273%29.jpeg',
      'Milk Bone (160088273).jpeg',
      'Abhimanyu Sirothia',
      'CC BY 3.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8c/Bone_Dog_Treats_%2851049786016%29.jpg/1280px-Bone_Dog_Treats_%2851049786016%29.jpg',
      'Bone Dog Treats (51049786016).jpg',
      'Megan Marrs',
      'CC BY 2.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/68/2008-06-28_Ruby_begging.jpg/1280px-2008-06-28_Ruby_begging.jpg',
      '2008-06-28 Ruby begging.jpg',
      'Ildar Sagdejev (Specious)',
      'CC BY-SA 3.0',
    ),
  ],
  editorial: {
    familyCode: 'treat',
    commercialTitle:
      'Milk-Bone Original galletas crujientes en forma de hueso para perros medianos, 680 g',
    description: [
      'Las galletas Milk-Bone Original son un clásico desde hace más de cien años. Horneadas hasta quedar crujientes y con su icónica forma de hueso, son el premio ideal para reforzar el buen comportamiento, acompañar el entrenamiento o simplemente consentir a tu perro varias veces al día.',
      'Están elaboradas con harina de trigo, leche y harina de carne, y enriquecidas con 12 vitaminas y minerales, incluido calcio. Su textura firme ayuda a limpiar los dientes y a reducir el sarro mientras tu perro mastica, y contribuye a un aliento más fresco.',
      'El tamaño mediano está pensado para perros de 9 a 23 kg. La caja de 680 g rinde para varias semanas de premios.',
      'Modo de uso: ofrece hasta 3 galletas al día a un perro mediano como premio, sin reemplazar su alimento. Ajusta la ración diaria de alimento para mantener su peso ideal. Supervisa a tu perro mientras come y mantén agua fresca disponible. Guarda la caja cerrada en un lugar fresco y seco.',
    ].join('\n\n'),
    values: [
      multi('animal.target', ['ani.dom.dog']),
      multi('life.stage', ['life.dog.adult']),
      multi('size.animal', ['size.animal.medium']),
      single('treat.form', 'treat.form.biscuit'),
      multi('treat.base', [
        'treat.base.cereal',
        'treat.base.dairy',
        'treat.base.meat',
      ]),
      multi('food.process', ['food.process.baked']),
      multi('food.texture', ['food.texture.dry', 'food.texture.crunchy']),
      single('pack.form', 'pack.form.box'),
      single('pack.sale', 'pack.sale.single'),
      single('content.kind', 'content.kind.mass'),
      num('measure.net_mass', 680, 'g'),
      text(
        'text.ingredients',
        'Harina de trigo, salvado de trigo, harina de carne y hueso, leche, grasa de res preservada con BHA, sal, germen de trigo, fosfato dicálcico, carbonato de calcio, vitaminas y minerales.',
      ),
      text('text.protein_origin', 'Harina de carne y hueso; leche.'),
      text(
        'text.composition',
        'Proteína cruda (mín.) 21 %, grasa cruda (mín.) 4.5 %, fibra cruda (máx.) 5 %, humedad (máx.) 12 %, calcio 1.2 %.',
      ),
      text(
        'text.instructions',
        'Hasta 3 galletas al día para un perro de 9 a 23 kg, como premio. Supervisa el consumo y ofrece agua fresca. Guarda en un lugar fresco y seco.',
      ),
      text(
        'text.clinical_analysis',
        'Energía aproximada: 40 kcal por galleta mediana.',
      ),
    ],
    facts: [fact(null, 'Caja de 680 g', [decl('contentMagnitude', 'mass')])],
  },
};
