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

const keys = ['2kg', '6_8kg'];
const presentation = { '2kg': 'Bolsa de 2.04 kg', '6_8kg': 'Bolsa de 6.8 kg' };

module.exports = {
  key: 'hills-adult-7-small-bites',
  name: "Hill's Science Diet Adult 7+ Small Bites",
  sku: 'SC-FOOD-003',
  category: 'Alimento para perro',
  brand: "Hill's",
  description:
    'Alimento seco para perros sénior de 7 años o más, croqueta pequeña.',
  price: 729,
  mayoreo: 639,
  cost: 535,
  variants: [
    {
      key: '2kg',
      name: '2.04 kg',
      sku: 'SC-FOOD-003-2KG',
      price: 729,
      mayoreo: 639,
      stock: 18,
    },
    {
      key: '6_8kg',
      name: '6.8 kg',
      sku: 'SC-FOOD-003-6_8KG',
      price: 1899,
      mayoreo: 1669,
      stock: 0,
    },
  ],
  packaging: { weightG: 2200, lengthCm: 30, widthCm: 10, heightCm: 42 },
  images: [
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7b/Cute_Small_Senior_Mixed-Breed_Dog.jpg/1280px-Cute_Small_Senior_Mixed-Breed_Dog.jpg',
      'Cute Small Senior Mixed-Breed Dog.jpg',
      'Twawri',
      'CC0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/97/Dog_for_Senior_Dog_Food_Diet_Wikipedia_Page.jpg/1280px-Dog_for_Senior_Dog_Food_Diet_Wikipedia_Page.jpg',
      'Dog for Senior Dog Food Diet Wikipedia Page.jpg',
      'Leo_65',
      'CC0',
    ),
    commons(
      'https://upload.wikimedia.org/wikipedia/commons/2/21/Dog_Food_2_%286409002109%29.jpg',
      'Dog Food 2 (6409002109).jpg',
      'Sh4rp_i',
      'CC BY 2.0',
    ),
  ],
  editorial: {
    familyCode: 'food',
    commercialTitle:
      "Hill's Science Diet Adult 7+ Small Bites, croqueta pequeña para perros sénior activos",
    description: [
      "Hill's Science Diet Adult 7+ Small Bites es un alimento completo para perros de 7 años o más que prefieren una croqueta pequeña. Con la edad cambian el metabolismo, la energía y las articulaciones; esta fórmula, desarrollada por veterinarios y nutriólogos de Hill's, ayuda a que tu perro mayor se mantenga activo y con buena calidad de vida.",
      'Su receta tiene pollo como primer ingrediente y combina proteína de alta calidad para conservar la masa muscular con un nivel controlado de calorías. Aporta antioxidantes clínicamente probados (vitaminas C y E) para apoyar el sistema inmune, ácidos grasos omega-6 y vitamina E para una piel sana y un pelaje brillante, y niveles moderados de fósforo y sodio que cuidan el corazón y los riñones del perro sénior.',
      'La croqueta pequeña es fácil de masticar para razas chicas y medianas y para perros con dientes sensibles. Está elaborada con ingredientes naturales y sin colorantes ni saborizantes artificiales.',
      'Modo de uso: divide la ración diaria en dos tomas según el peso de tu perro (tabla del empaque). Si cambias de alimento, mezcla de forma gradual durante 7 días. Ofrece agua fresca en todo momento.',
    ].join('\n\n'),
    values: perVariant(
      [
        multi('animal.target', ['ani.dom.dog']),
        multi('life.stage', ['life.dog.senior']),
        multi('size.animal', [
          'size.animal.miniature',
          'size.animal.small',
          'size.animal.medium',
        ]),
        single('food.format', 'food.format.kibble'),
        single('food.role', 'food.role.complete'),
        multi('food.process', ['food.process.extruded']),
        multi('food.texture', ['food.texture.dry', 'food.texture.crunchy']),
        single('pack.form', 'pack.form.bag'),
        single('pack.sale', 'pack.sale.single'),
        single('content.kind', 'content.kind.mass'),
        range('measure.animal_mass', 2, 20, 'kg'),
        text(
          'text.ingredients',
          'Pollo, harina de gluten de trigo, cebada perlada, arroz integral, trigo integral, maíz integral, avena integral, harina de pollo, grasa de pollo, pulpa de remolacha, aceite de soya, sabor natural, linaza, vitaminas (incluye E y C), minerales, taurina, L-carnitina, betacaroteno.',
        ),
        text('text.protein_origin', 'Pollo y harina de pollo.'),
        text(
          'text.composition',
          'Proteína cruda (mín.) 15.5 %, grasa cruda (mín.) 10.5 %, fibra cruda (máx.) 4 %, humedad (máx.) 10 %, fósforo 0.5 %, sodio 0.2 %.',
        ),
        text(
          'text.instructions',
          'Divide la ración diaria en dos tomas según el peso de tu perro (tabla del empaque). Cambio gradual en 7 días. Agua fresca siempre disponible.',
        ),
        text(
          'text.clinical_analysis',
          'Energía metabolizable aproximada: 3,560 kcal/kg. Fósforo y sodio moderados para perro sénior.',
        ),
      ],
      keys,
      {
        '2kg': [num('measure.net_mass', 2.04, 'kg')],
        '6_8kg': [num('measure.net_mass', 6.8, 'kg')],
      },
    ),
    facts: keys.map((key) =>
      fact(key, presentation[key], [decl('contentMagnitude', 'mass')]),
    ),
  },
};
