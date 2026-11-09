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

const keys = ['2kg', '8kg', '20kg'];
const presentation = {
  '2kg': 'Bolsa de 2 kg',
  '8kg': 'Bolsa de 8 kg',
  '20kg': 'Saco de 20 kg',
};

module.exports = {
  key: 'nupec-cachorro-medianas-grandes',
  name: 'Nupec Cachorro Razas Medianas y Grandes',
  sku: 'SC-FOOD-001',
  category: 'Alimento para perro',
  brand: 'Nupec',
  description:
    'Alimento seco premium para cachorros de razas medianas y grandes.',
  price: 389,
  mayoreo: 342,
  cost: 285,
  variants: [
    {
      key: '2kg',
      name: '2 kg',
      sku: 'SC-FOOD-001-2KG',
      price: 389,
      mayoreo: 342,
      stock: 34,
    },
    {
      key: '8kg',
      name: '8 kg',
      sku: 'SC-FOOD-001-8KG',
      price: 1249,
      mayoreo: 1095,
      stock: 3,
    },
    {
      key: '20kg',
      name: '20 kg',
      sku: 'SC-FOOD-001-20KG',
      price: 2689,
      mayoreo: 2365,
      stock: 0,
    },
  ],
  packaging: { weightG: 2150, lengthCm: 32, widthCm: 10, heightCm: 45 },
  images: [
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f8/Golden_Retriever_Puppy_12weeks.JPG/1280px-Golden_Retriever_Puppy_12weeks.JPG',
      'Golden Retriever Puppy 12weeks.JPG',
      'Beatrice Milek',
      'CC BY 3.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f3/Labrador_Retriever_Chocolate_puppy_01.jpg/1280px-Labrador_Retriever_Chocolate_puppy_01.jpg',
      'Labrador Retriever Chocolate puppy 01.jpg',
      'Jacek Proszyk',
      'CC0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f7/Pile_of_Kibble_Dog_Food_%2851049786351%29.jpg/1280px-Pile_of_Kibble_Dog_Food_%2851049786351%29.jpg',
      'Pile of Kibble Dog Food (51049786351).jpg',
      'Megan Marrs',
      'CC BY 2.0',
    ),
  ],
  editorial: {
    familyCode: 'food',
    commercialTitle:
      'Nupec Cachorro Razas Medianas y Grandes, croqueta premium con DHA para un crecimiento fuerte',
    description: [
      'Nupec Cachorro Razas Medianas y Grandes es un alimento completo y balanceado, formulado en México por especialistas en nutrición animal, para acompañar a tu cachorro durante su etapa de mayor desarrollo. Su fórmula aporta la energía y la proteína de alta digestibilidad que necesita un perro que crecerá hasta convertirse en un adulto de 11 a 45 kg o más.',
      'La receta combina pollo y harina de pollo como fuente principal de proteína con arroz y avena, cereales de fácil digestión. Incluye DHA proveniente de aceite de pescado para el desarrollo cerebral y visual, calcio y fósforo en proporción controlada para un crecimiento óseo armónico, glucosamina y condroitina para cuidar las articulaciones desde temprana edad, y prebióticos (MOS y FOS) que favorecen una flora intestinal sana y heces firmes.',
      'La croqueta tiene un tamaño y una dureza pensados para la mandíbula de un cachorro de raza mediana o grande: lo invita a masticar, ayuda a limpiar los dientes y reduce el riesgo de que coma demasiado rápido. No contiene colorantes artificiales.',
      'Modo de uso: divide la ración diaria en tres o cuatro tomas hasta los seis meses y en dos tomas después. Sigue la tabla del empaque según el peso actual y el peso adulto esperado de tu cachorro, y ofrece siempre agua fresca y limpia. Haz el cambio de alimento de forma gradual durante 7 días mezclando el alimento anterior con Nupec.',
    ].join('\n\n'),
    values: perVariant(
      [
        multi('animal.target', ['ani.dom.dog']),
        multi('life.stage', ['life.dog.puppy']),
        multi('size.animal', [
          'size.animal.medium',
          'size.animal.large',
          'size.animal.giant',
        ]),
        single('food.format', 'food.format.kibble'),
        single('food.role', 'food.role.complete'),
        multi('food.process', ['food.process.extruded']),
        multi('food.texture', ['food.texture.dry', 'food.texture.crunchy']),
        single('pack.sale', 'pack.sale.single'),
        single('content.kind', 'content.kind.mass'),
        range('measure.animal_mass', 11, 45, 'kg'),
        text(
          'text.ingredients',
          'Pollo, harina de pollo, arroz, avena, grasa de pollo, pulpa de remolacha, aceite de pescado (fuente de DHA), huevo deshidratado, levadura de cerveza, glucosamina, sulfato de condroitina, mananooligosacáridos (MOS), fructooligosacáridos (FOS), vitaminas y minerales.',
        ),
        text(
          'text.protein_origin',
          'Pollo y harina de pollo como fuentes principales; huevo deshidratado como fuente complementaria.',
        ),
        text(
          'text.composition',
          'Proteína cruda (mín.) 30 %, grasa cruda (mín.) 18 %, fibra cruda (máx.) 3 %, humedad (máx.) 10 %, cenizas (máx.) 8 %, calcio 1.3 %, fósforo 1.0 %, DHA 0.1 %.',
        ),
        text(
          'text.instructions',
          'Divide la ración diaria en 3 o 4 tomas hasta los 6 meses y en 2 tomas después. Sigue la tabla del empaque según peso actual y peso adulto esperado. Cambio gradual en 7 días. Agua fresca siempre disponible.',
        ),
        text(
          'text.clinical_analysis',
          'Energía metabolizable aproximada: 3,900 kcal/kg. Relación calcio/fósforo 1.3:1.',
        ),
      ],
      keys,
      {
        '2kg': [
          single('pack.form', 'pack.form.bag'),
          num('measure.net_mass', 2, 'kg'),
        ],
        '8kg': [
          single('pack.form', 'pack.form.bag'),
          num('measure.net_mass', 8, 'kg'),
        ],
        '20kg': [
          single('pack.form', 'pack.form.sack'),
          num('measure.net_mass', 20, 'kg'),
        ],
      },
    ),
    facts: keys.map((key) =>
      fact(key, presentation[key], [decl('contentMagnitude', 'mass')]),
    ),
  },
};
