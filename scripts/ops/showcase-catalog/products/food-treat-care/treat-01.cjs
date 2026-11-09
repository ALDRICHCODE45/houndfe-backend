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

const keys = ['7pzas', '28pzas'];
const presentation = {
  '7pzas': 'Bolsa con 7 piezas (180 g)',
  '28pzas': 'Bolsa con 28 piezas (720 g)',
};

module.exports = {
  key: 'dentastix-razas-medianas',
  name: 'Pedigree Dentastix Razas Medianas',
  sku: 'SC-TREAT-001',
  category: 'Premios y snacks',
  brand: 'Pedigree',
  description: 'Barras dentales para perros de razas medianas (10 a 25 kg).',
  price: 89,
  mayoreo: 78,
  cost: 59,
  variants: [
    {
      key: '7pzas',
      name: '7 piezas',
      sku: 'SC-TREAT-001-7PZ',
      price: 89,
      mayoreo: 78,
      stock: 56,
    },
    {
      key: '28pzas',
      name: '28 piezas',
      sku: 'SC-TREAT-001-28PZ',
      price: 299,
      mayoreo: 263,
      stock: 0,
    },
  ],
  packaging: { weightG: 200, lengthCm: 15, widthCm: 4, heightCm: 24 },
  images: [
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/f/fd/Golden_Retriever_Chewing_A_Stick.jpg/1280px-Golden_Retriever_Chewing_A_Stick.jpg',
      'Golden Retriever Chewing A Stick.jpg',
      'Cheetyuh',
      'CC0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/37/Dog_Mouth_Close-up.jpg/1280px-Dog_Mouth_Close-up.jpg',
      'Dog Mouth Close-up.jpg',
      'Achat1999',
      'CC BY-SA 4.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f9/Jasper_begs_for_a_treat_-_Flickr_-_frank.shepherd.jpg/1280px-Jasper_begs_for_a_treat_-_Flickr_-_frank.shepherd.jpg',
      'Jasper begs for a treat - Flickr - frank.shepherd.jpg',
      'Frank Shepherd',
      'CC BY-SA 2.0',
    ),
  ],
  editorial: {
    familyCode: 'treat',
    commercialTitle:
      'Pedigree Dentastix Razas Medianas, barras dentales diarias que reducen el sarro hasta 80 %',
    description: [
      'Pedigree Dentastix Razas Medianas son premios dentales diarios para perros adultos de 10 a 25 kg. Su forma en X y su textura masticable están diseñadas para llegar hasta los dientes del fondo, donde se acumula más sarro, y limpiarlos mientras tu perro disfruta de un premio que le encanta.',
      'Usadas a diario, las barras Dentastix ayudan a reducir la acumulación de sarro hasta en un 80 %, gracias a la acción mecánica de la masticación y a ingredientes activos como el tripolifosfato de sodio y el sulfato de zinc. También ayudan a mantener un aliento más fresco. Son bajas en grasa y no contienen azúcar añadida.',
      'Una barra al día es la forma más sencilla de sumar la higiene dental a la rutina de tu perro, complementando el cepillado y las revisiones veterinarias.',
      'Modo de uso: ofrece 1 barra al día a perros mayores de 4 meses de entre 10 y 25 kg. No es apta para cachorros menores de 4 meses ni para perros de menos de 10 kg. Supervisa a tu perro mientras la come y asegúrate de que tenga agua fresca disponible. Considera las calorías dentro de su ración diaria.',
    ].join('\n\n'),
    values: perVariant(
      [
        multi('animal.target', ['ani.dom.dog']),
        multi('life.stage', ['life.dog.adult']),
        multi('size.animal', ['size.animal.medium']),
        single('treat.form', 'treat.form.stick'),
        multi('treat.base', ['treat.base.cereal', 'treat.base.meat']),
        multi('food.process', ['food.process.extruded']),
        multi('food.texture', ['food.texture.soft']),
        single('pack.form', 'pack.form.bag'),
        single('content.kind', 'content.kind.count'),
        range('measure.animal_mass', 10, 25, 'kg'),
        text(
          'text.ingredients',
          'Harina de arroz, almidón de trigo, glicerina, gelatina, goma arábiga, sabor a carne de res, fosfato de calcio, sal, tripolifosfato de sodio, celulosa en polvo, sulfato de zinc, extracto de té verde, vitaminas y minerales.',
        ),
        text('text.protein_origin', 'Gelatina y sabor natural a carne de res.'),
        text(
          'text.composition',
          'Proteína cruda (mín.) 8 %, grasa cruda (mín.) 1.5 %, fibra cruda (máx.) 3 %, humedad (máx.) 18 %.',
        ),
        text(
          'text.instructions',
          '1 barra al día para perros de 10 a 25 kg mayores de 4 meses. No apta para perros de menos de 10 kg. Supervisa el consumo y ofrece agua fresca.',
        ),
        text(
          'text.clinical_analysis',
          'Energía aproximada: 77 kcal por barra.',
        ),
      ],
      keys,
      {
        '7pzas': [
          single('pack.sale', 'pack.sale.single'),
          num('measure.content_count', 7, 'piece'),
          num('measure.net_mass', 180, 'g'),
        ],
        '28pzas': [
          single('pack.sale', 'pack.sale.multipack'),
          num('measure.content_count', 28, 'piece'),
          num('measure.net_mass', 720, 'g'),
        ],
      },
    ),
    facts: keys.map((key) =>
      fact(key, presentation[key], [decl('contentMagnitude', 'count')]),
    ),
  },
};
