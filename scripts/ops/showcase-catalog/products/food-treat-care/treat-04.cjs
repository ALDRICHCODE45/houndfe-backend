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

const keys = ['4tubos', '20tubos'];
const presentation = {
  '4tubos': 'Paquete con 4 tubos de 14 g',
  '20tubos': 'Bolsa con 20 tubos de 14 g',
};

module.exports = {
  key: 'churu-atun-gato',
  name: 'Inaba Churu Atún Premio Cremoso para Gato',
  sku: 'SC-TREAT-004',
  category: 'Premios y snacks',
  brand: 'Inaba Churu',
  description: 'Premio cremoso para lamer, sabor atún, tubos de 14 g.',
  price: 79,
  mayoreo: 69,
  cost: 52,
  variants: [
    {
      key: '4tubos',
      name: '4 tubos',
      sku: 'SC-TREAT-004-4T',
      price: 79,
      mayoreo: 69,
      stock: 72,
    },
    {
      key: '20tubos',
      name: '20 tubos',
      sku: 'SC-TREAT-004-20T',
      price: 349,
      mayoreo: 305,
      stock: 6,
    },
  ],
  packaging: { weightG: 70, lengthCm: 11, widthCm: 2, heightCm: 17 },
  images: [
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d7/Calico_Cat_intensely_licking_a_push_up_snack.png/1280px-Calico_Cat_intensely_licking_a_push_up_snack.png',
      'Calico Cat intensely licking a push up snack.png',
      'TechnoKittyCat',
      'CC0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/5/59/Licking_his_chops.jpg/1280px-Licking_his_chops.jpg',
      'Licking his chops.jpg',
      'Giovaaans',
      'CC BY-SA 4.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b2/Tabby_cat_licking.jpg/1280px-Tabby_cat_licking.jpg',
      'Tabby cat licking.jpg',
      'RussianA',
      'CC BY 3.0',
    ),
  ],
  editorial: {
    familyCode: 'treat',
    commercialTitle:
      'Inaba Churu atún, premio cremoso para lamer que hidrata y consiente a tu gato',
    description: [
      'Inaba Churu es el premio cremoso para gatos que se volvió favorito en todo el mundo. Cada tubo contiene un puré suave de atún que tu gato puede lamer directamente desde el empaque, convirtiendo el momento del premio en una interacción cercana entre ustedes.',
      'Está hecho con atún real, sin conservadores artificiales ni colorantes, y con un alto contenido de humedad (alrededor del 91 %), lo que ayuda a sumar líquidos a la dieta de gatos que beben poca agua. Es bajo en calorías, aproximadamente 6 kcal por tubo, y contiene té verde y vitamina E.',
      'Su textura lo hace muy útil más allá del premio: sirve para dar pastillas escondidas, para motivar el apetito de gatos convalecientes o mayores, como topping sobre el alimento seco y como apoyo en el cepillado o el corte de uñas.',
      'Modo de uso: ofrece hasta 4 tubos al día directamente del empaque, en un plato o sobre su alimento habitual. Es un premio complementario y no sustituye la alimentación completa. Una vez abierto, consúmelo en el momento. Mantén agua fresca disponible.',
    ].join('\n\n'),
    values: perVariant(
      [
        multi('animal.target', ['ani.dom.cat']),
        multi('life.stage', [
          'life.cat.kitten',
          'life.cat.adult',
          'life.cat.senior',
        ]),
        single('treat.form', 'treat.form.lickable'),
        multi('treat.base', ['treat.base.fish']),
        multi('food.texture', ['food.texture.moist', 'food.texture.soft']),
        single('content.kind', 'content.kind.mass'),
        text(
          'text.ingredients',
          'Atún, extracto de atún, goma guar, extracto de té verde, vitamina E, taurina.',
        ),
        text('text.protein_origin', 'Atún.'),
        text(
          'text.composition',
          'Proteína cruda (mín.) 7 %, grasa cruda (mín.) 0.2 %, fibra cruda (máx.) 0.3 %, humedad (máx.) 91 %.',
        ),
        text(
          'text.instructions',
          'Hasta 4 tubos al día, directo del empaque, en plato o sobre el alimento. Premio complementario. Consumir al abrir. Agua fresca disponible.',
        ),
        text(
          'text.clinical_analysis',
          'Energía aproximada: 6 kcal por tubo de 14 g.',
        ),
      ],
      keys,
      {
        '4tubos': [
          single('pack.form', 'pack.form.wrap'),
          single('pack.sale', 'pack.sale.multipack'),
          num('measure.net_mass', 56, 'g'),
          num('measure.pack_count', 4, 'unit'),
        ],
        '20tubos': [
          single('pack.form', 'pack.form.bag'),
          single('pack.sale', 'pack.sale.multipack'),
          num('measure.net_mass', 280, 'g'),
          num('measure.pack_count', 20, 'unit'),
        ],
      },
    ),
    facts: keys.map((key) =>
      fact(key, presentation[key], [decl('contentMagnitude', 'mass')]),
    ),
  },
};
