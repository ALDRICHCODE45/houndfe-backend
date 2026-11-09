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

const keys = ['1_5kg', '8kg'];
const presentation = { '1_5kg': 'Bolsa de 1.5 kg', '8kg': 'Bolsa de 8 kg' };

module.exports = {
  key: 'cat-chow-adultos-delimix',
  name: 'Cat Chow Adultos Delimix',
  sku: 'SC-FOOD-005',
  category: 'Alimento para gato',
  brand: 'Purina Cat Chow',
  description:
    'Alimento seco para gatos adultos, mezcla de croquetas sabor pollo, pescado y carne.',
  price: 239,
  mayoreo: 210,
  cost: 168,
  variants: [
    {
      key: '1_5kg',
      name: '1.5 kg',
      sku: 'SC-FOOD-005-1_5KG',
      price: 239,
      mayoreo: 210,
      stock: 48,
    },
    {
      key: '8kg',
      name: '8 kg',
      sku: 'SC-FOOD-005-8KG',
      price: 1049,
      mayoreo: 925,
      stock: 9,
    },
  ],
  packaging: { weightG: 1600, lengthCm: 25, widthCm: 9, heightCm: 36 },
  images: [
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/26/Dry_cat_food_01.jpg/1280px-Dry_cat_food_01.jpg',
      'Dry cat food 01.jpg',
      'Anne Jea.',
      'CC BY-SA 4.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/02/Dry_cat_food_03_ft._Remus.jpg/1280px-Dry_cat_food_03_ft._Remus.jpg',
      'Dry cat food 03 ft. Remus.jpg',
      'Anne Jea.',
      'CC BY-SA 4.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9f/Stray_garden_cat_eating_%27Cat_food%27.JPG/1280px-Stray_garden_cat_eating_%27Cat_food%27.JPG',
      "Stray garden cat eating 'Cat food'.JPG",
      'Rudolph.A.furtado',
      'CC0',
    ),
  ],
  editorial: {
    familyCode: 'food',
    commercialTitle:
      'Cat Chow Adultos Delimix, croquetas sabor pollo, pescado y carne para gatos de 1 a 7 años',
    description: [
      'Purina Cat Chow Adultos Delimix es un alimento completo y balanceado para gatos adultos de 1 a 7 años. Su mezcla de croquetas con sabores a pollo, pescado y carne mantiene el interés de los gatos más exigentes día tras día, sin necesidad de cambiar de alimento.',
      'La fórmula aporta proteína de alta calidad para músculos fuertes, taurina para la salud del corazón y de la vista, y un equilibrio de minerales que ayuda a mantener un pH urinario saludable. Contiene fibra natural que contribuye a reducir la formación de bolas de pelo y antioxidantes (vitaminas E y A, zinc y selenio) para apoyar las defensas.',
      'Las croquetas tienen distintas formas y texturas crujientes que estimulan la masticación y ayudan a limpiar los dientes. Es ideal para gatos de interior y exterior con actividad moderada.',
      'Modo de uso: sirve la ración diaria recomendada en el empaque según el peso de tu gato; puedes dejarla disponible a lo largo del día o dividirla en dos o tres tomas. Asegúrate de que siempre tenga agua fresca, de preferencia en una fuente o en varios bebederos.',
    ].join('\n\n'),
    values: perVariant(
      [
        multi('animal.target', ['ani.dom.cat']),
        multi('life.stage', ['life.cat.adult']),
        single('food.format', 'food.format.kibble'),
        single('food.role', 'food.role.complete'),
        multi('food.process', ['food.process.extruded']),
        multi('food.texture', ['food.texture.dry', 'food.texture.crunchy']),
        single('pack.form', 'pack.form.bag'),
        single('pack.sale', 'pack.sale.single'),
        single('content.kind', 'content.kind.mass'),
        text(
          'text.ingredients',
          'Harina de subproductos de pollo, maíz amarillo, arroz, gluten de maíz, grasa animal preservada con tocoferoles mixtos, harina de pescado, harina de carne de res, saborizantes naturales, fibra de soya, cloruro de potasio, taurina, vitaminas, minerales.',
        ),
        text(
          'text.protein_origin',
          'Subproductos de pollo, pescado y carne de res.',
        ),
        text(
          'text.composition',
          'Proteína cruda (mín.) 30 %, grasa cruda (mín.) 11 %, fibra cruda (máx.) 3.5 %, humedad (máx.) 12 %, taurina (mín.) 0.1 %.',
        ),
        text(
          'text.instructions',
          'Ración diaria según el peso del gato (tabla del empaque), libre acceso o en 2 a 3 tomas. Agua fresca siempre disponible.',
        ),
        text(
          'text.clinical_analysis',
          'Energía metabolizable aproximada: 3,700 kcal/kg. Formulado para pH urinario de 6.0 a 6.5.',
        ),
      ],
      keys,
      {
        '1_5kg': [num('measure.net_mass', 1.5, 'kg')],
        '8kg': [num('measure.net_mass', 8, 'kg')],
      },
    ),
    facts: keys.map((key) =>
      fact(key, presentation[key], [decl('contentMagnitude', 'mass')]),
    ),
  },
};
