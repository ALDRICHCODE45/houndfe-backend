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

const keys = ['4kg', '15kg'];
const presentation = { '4kg': 'Bolsa de 4 kg', '15kg': 'Saco de 15 kg' };

module.exports = {
  key: 'royal-canin-maxi-adult',
  name: 'Royal Canin Maxi Adult',
  sku: 'SC-FOOD-002',
  category: 'Alimento para perro',
  brand: 'Royal Canin',
  description:
    'Alimento seco para perros adultos de razas grandes (26 a 44 kg).',
  price: 1059,
  mayoreo: 929,
  cost: 780,
  variants: [
    {
      key: '4kg',
      name: '4 kg',
      sku: 'SC-FOOD-002-4KG',
      price: 1059,
      mayoreo: 929,
      stock: 22,
    },
    {
      key: '15kg',
      name: '15 kg',
      sku: 'SC-FOOD-002-15KG',
      price: 2949,
      mayoreo: 2595,
      stock: 12,
    },
  ],
  packaging: { weightG: 4200, lengthCm: 38, widthCm: 12, heightCm: 55 },
  images: [
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/4/46/German_Shepherd_Dog_1.JPG/1280px-German_Shepherd_Dog_1.JPG',
      'German Shepherd Dog 1.JPG',
      'Adallara',
      'CC BY-SA 4.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/90/Labrador_Retriever_portrait.jpg/1280px-Labrador_Retriever_portrait.jpg',
      'Labrador Retriever portrait.jpg',
      'Herwig Kavallar',
      'Public domain',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4b/Dog_Food_%281%29.jpg/1280px-Dog_Food_%281%29.jpg',
      'Dog Food (1).jpg',
      'Alisha Vargas',
      'CC BY 2.0',
    ),
  ],
  editorial: {
    familyCode: 'food',
    commercialTitle:
      'Royal Canin Maxi Adult, nutrición precisa para perros grandes de 15 meses a 5 años',
    description: [
      'Royal Canin Maxi Adult está diseñado para perros adultos de razas grandes, de 26 a 44 kg, desde los 15 meses hasta los 5 años. Los perros grandes tienen articulaciones que soportan mucho peso y un aparato digestivo sensible en proporción a su tamaño; esta fórmula responde a esas necesidades con nutrientes específicos y una croqueta adaptada a su mandíbula.',
      'Aporta proteínas de alta digestibilidad (L.I.P.) y fibras seleccionadas que ayudan a una buena digestión y heces más firmes. Contiene EPA y DHA de aceite de pescado, junto con glucosamina y condroitina, para apoyar la salud articular. Su complejo de antioxidantes (vitamina E y vitamina C, taurina y luteína) contribuye a las defensas naturales del organismo.',
      'La croqueta grande y de textura firme favorece la masticación y ayuda a que tu perro coma más despacio. El equilibrio de energía permite mantener su peso ideal con la ración adecuada.',
      'Modo de uso: ofrece la ración diaria en dos tomas. Consulta la tabla del empaque según el peso ideal y la actividad física de tu perro, y ajusta según su condición corporal. Mantén agua fresca disponible en todo momento.',
    ].join('\n\n'),
    values: perVariant(
      [
        multi('animal.target', ['ani.dom.dog']),
        multi('life.stage', ['life.dog.adult']),
        multi('size.animal', ['size.animal.large']),
        single('food.format', 'food.format.kibble'),
        single('food.role', 'food.role.complete'),
        multi('food.process', ['food.process.extruded']),
        multi('food.texture', ['food.texture.dry', 'food.texture.crunchy']),
        single('pack.sale', 'pack.sale.single'),
        single('content.kind', 'content.kind.mass'),
        range('measure.animal_mass', 26, 44, 'kg'),
        text(
          'text.ingredients',
          'Arroz, proteína deshidratada de aves, maíz, grasas animales, harina de maíz, gluten de trigo, proteína animal hidrolizada, pulpa de remolacha, aceite de pescado, aceite de soya, minerales, levaduras, fructooligosacáridos, glucosamina, sulfato de condroitina, extracto de caléndula, vitaminas.',
        ),
        text(
          'text.protein_origin',
          'Proteína deshidratada de aves y proteína animal hidrolizada.',
        ),
        text(
          'text.composition',
          'Proteína cruda (mín.) 26 %, grasa cruda (mín.) 17 %, fibra cruda (máx.) 1.3 %, humedad (máx.) 10 %, EPA+DHA 0.3 %.',
        ),
        text(
          'text.instructions',
          'Ofrece la ración diaria en dos tomas según el peso ideal y la actividad de tu perro (tabla del empaque). Agua fresca disponible siempre.',
        ),
        text(
          'text.clinical_analysis',
          'Energía metabolizable aproximada: 3,880 kcal/kg.',
        ),
      ],
      keys,
      {
        '4kg': [
          single('pack.form', 'pack.form.bag'),
          num('measure.net_mass', 4, 'kg'),
        ],
        '15kg': [
          single('pack.form', 'pack.form.sack'),
          num('measure.net_mass', 15, 'kg'),
        ],
      },
    ),
    facts: keys.map((key) =>
      fact(key, presentation[key], [decl('contentMagnitude', 'mass')]),
    ),
  },
};
