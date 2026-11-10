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

const keys = ['28g', '62g', '200g'];
const presentation = {
  '28g': 'Frasco de 28 g',
  '62g': 'Frasco de 62 g',
  '200g': 'Bote de 200 g',
};

module.exports = {
  key: 'tetramin-hojuelas-tropicales',
  name: 'TetraMin Hojuelas para Peces Tropicales',
  sku: 'SC-FOOD-009',
  category: 'Alimento para peces',
  brand: 'Tetra',
  description: 'Alimento en hojuelas para peces tropicales de agua dulce.',
  price: 119,
  mayoreo: 104,
  cost: 78,
  variants: [
    {
      key: '28g',
      name: '28 g',
      sku: 'SC-FOOD-009-28G',
      price: 119,
      mayoreo: 104,
      stock: 41,
    },
    {
      key: '62g',
      name: '62 g',
      sku: 'SC-FOOD-009-62G',
      price: 219,
      mayoreo: 192,
      stock: 15,
    },
    {
      key: '200g',
      name: '200 g',
      sku: 'SC-FOOD-009-200G',
      price: 529,
      mayoreo: 465,
      stock: 1,
    },
  ],
  packaging: { weightG: 90, lengthCm: 6, widthCm: 6, heightCm: 12 },
  images: [
    commons(
      'https://upload.wikimedia.org/wikipedia/commons/f/f0/Fischfutter-Flocken.JPG',
      'Fischfutter-Flocken.JPG',
      'Buchling',
      'CC BY-SA 3.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c0/Paracheirodon_innesi_group.jpg/1280px-Paracheirodon_innesi_group.jpg',
      'Paracheirodon innesi group.jpg',
      'Brandy Dopkins',
      'CC BY-SA 2.0',
    ),
    commons(
      'https://upload.wikimedia.org/wikipedia/commons/7/76/Aquarium_-_dried_food2.jpg',
      'Aquarium - dried food2.jpg',
      'Pinpin',
      'CC BY-SA 3.0',
    ),
  ],
  editorial: {
    familyCode: 'food',
    commercialTitle:
      'TetraMin hojuelas para peces tropicales, alimento diario completo que no enturbia el agua',
    description: [
      'TetraMin es el alimento en hojuelas más conocido para peces tropicales de agua dulce. Es un alimento completo para la alimentación diaria de guppys, platys, mollys, tetras neón y la mayoría de los peces de comunidad que comen en la superficie y en la zona media del acuario.',
      'Su fórmula BioActive combina más de 40 ingredientes seleccionados, entre ellos pescado, crustáceos y algas, con vitaminas y oligoelementos que apoyan la vitalidad, el sistema inmune y los colores intensos de tus peces. Las hojuelas son de alta digestibilidad, lo que reduce los residuos y ayuda a mantener el agua cristalina.',
      'Las hojuelas flotan al principio y se hunden poco a poco, de modo que alimentan tanto a los peces que comen en la superficie como a los que nadan a media agua. Puedes desmenuzarlas con los dedos para peces pequeños o alevines.',
      'Modo de uso: alimenta de 2 a 3 veces al día solo con la cantidad que tus peces consuman en unos 2 minutos. Retira el alimento sobrante para no deteriorar la calidad del agua. Mantén el envase bien cerrado, en un lugar fresco y seco.',
    ].join('\n\n'),
    values: perVariant(
      [
        multi('animal.target', [
          'ani.freshwater.guppy',
          'ani.freshwater.neon_tetra',
          'ani.freshwater_group.platies',
          'ani.freshwater_group.mollies',
          'ani.freshwater_group.swordtails',
        ]),
        multi('life.stage', ['life.aquatic.juvenile', 'life.aquatic.adult']),
        single('food.format', 'food.format.flake'),
        single('food.role', 'food.role.complete'),
        single('food.aquatic', 'food.aquatic.slow_sinking'),
        multi('food.texture', ['food.texture.dry']),
        single('pack.sale', 'pack.sale.single'),
        single('content.kind', 'content.kind.mass'),
        text(
          'text.ingredients',
          'Pescado y subproductos de pescado, cereales, levaduras, extractos de proteína vegetal, moluscos y crustáceos, aceites y grasas, algas, azúcares, minerales, vitaminas.',
        ),
        text(
          'text.protein_origin',
          'Pescado, moluscos y crustáceos; proteína vegetal complementaria.',
        ),
        text(
          'text.composition',
          'Proteína cruda (mín.) 46 %, grasa cruda (mín.) 11 %, fibra cruda (máx.) 3 %, humedad (máx.) 6 %, fósforo 1.5 %.',
        ),
        text(
          'text.instructions',
          'Alimenta 2 a 3 veces al día solo lo que consuman en unos 2 minutos. Retira el sobrante. Envase bien cerrado, en lugar fresco y seco.',
        ),
      ],
      keys,
      {
        '28g': [
          single('pack.form', 'pack.form.jar'),
          num('measure.net_mass', 28, 'g'),
        ],
        '62g': [
          single('pack.form', 'pack.form.jar'),
          num('measure.net_mass', 62, 'g'),
        ],
        '200g': [
          single('pack.form', 'pack.form.tub'),
          num('measure.net_mass', 200, 'g'),
        ],
      },
    ),
    facts: keys.map((key) =>
      fact(key, presentation[key], [decl('contentMagnitude', 'mass')]),
    ),
  },
};
