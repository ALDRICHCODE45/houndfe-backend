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
  key: 'hills-felino-adult-7',
  name: "Hill's Science Diet Felino Adult 7+ 1.58 kg",
  sku: 'SC-FOOD-008',
  category: 'Alimento para gato',
  brand: "Hill's",
  description:
    'Alimento seco para gatos sénior de 7 años o más, receta con pollo.',
  price: 649,
  mayoreo: 569,
  cost: 475,
  stock: 2,
  packaging: { weightG: 1700, lengthCm: 25, widthCm: 9, heightCm: 35 },
  images: [
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/14/Older_Cat_Jasmine_Close_Up.jpg/1280px-Older_Cat_Jasmine_Close_Up.jpg',
      'Older Cat Jasmine Close Up.jpg',
      'UnicornPrince',
      'CC BY-SA 4.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/07/An_old_tabby_cat_crouching_on_a_step.jpg/1280px-An_old_tabby_cat_crouching_on_a_step.jpg',
      'An old tabby cat crouching on a step.jpg',
      'Michael Palmer',
      'CC BY-SA 4.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/4/45/Grey_cat_eating.jpg/1280px-Grey_cat_eating.jpg',
      'Grey cat eating.jpg',
      'Öljylautta',
      'Public domain',
    ),
  ],
  editorial: {
    familyCode: 'food',
    commercialTitle:
      "Hill's Science Diet Felino Adult 7+, nutrición para gatos sénior con riñones y corazón sanos",
    description: [
      "Hill's Science Diet Felino Adult 7+ es un alimento completo para gatos de 7 años o más. A partir de esta edad el gato suele ser menos activo y sus órganos necesitan un cuidado especial; esta fórmula está pensada para que tu compañero mayor se mantenga ágil, con buen apetito y con energía para disfrutar su día.",
      'La receta tiene pollo como primer ingrediente y niveles controlados de fósforo y sodio que apoyan la salud de los riñones y del corazón. Su equilibrio de minerales ayuda a mantener un tracto urinario saludable, y sus antioxidantes clínicamente probados (vitaminas C y E) apoyan el sistema inmune. Aporta omega-3 y omega-6 para un pelaje suave y brillante.',
      'La croqueta es de tamaño moderado y fácil de masticar. No contiene colorantes, saborizantes ni conservadores artificiales.',
      'Modo de uso: un gato de 4 kg necesita aproximadamente 55 g al día; consulta la tabla del empaque y ajusta según su condición corporal. Divide la ración en dos o tres tomas y mantén agua fresca disponible en varios puntos de la casa.',
    ].join('\n\n'),
    values: [
      multi('animal.target', ['ani.dom.cat']),
      multi('life.stage', ['life.cat.senior']),
      single('food.format', 'food.format.kibble'),
      single('food.role', 'food.role.complete'),
      multi('food.process', ['food.process.extruded']),
      multi('food.texture', ['food.texture.dry', 'food.texture.crunchy']),
      single('pack.form', 'pack.form.bag'),
      single('pack.sale', 'pack.sale.single'),
      single('content.kind', 'content.kind.mass'),
      num('measure.net_mass', 1.58, 'kg'),
      text(
        'text.ingredients',
        'Pollo, harina de gluten de maíz, arroz integral, trigo integral, grasa animal, harina de pollo, maíz integral, proteína de hígado de pollo, aceite de soya, aceite de pescado, linaza, taurina, L-carnitina, vitaminas (incluye C y E), minerales, betacaroteno.',
      ),
      text('text.protein_origin', 'Pollo, harina de pollo e hígado de pollo.'),
      text(
        'text.composition',
        'Proteína cruda (mín.) 30 %, grasa cruda (mín.) 16 %, fibra cruda (máx.) 3 %, humedad (máx.) 8 %, fósforo 0.6 %, sodio 0.3 %, magnesio 0.08 %.',
      ),
      text(
        'text.instructions',
        'Gato de 4 kg: unos 55 g al día (tabla del empaque), en 2 o 3 tomas. Ajusta por condición corporal. Agua fresca siempre disponible.',
      ),
      text(
        'text.clinical_analysis',
        'Energía metabolizable aproximada: 4,050 kcal/kg. Fósforo y sodio controlados para gato sénior.',
      ),
    ],
    facts: [fact(null, 'Bolsa de 1.58 kg', [decl('contentMagnitude', 'mass')])],
  },
};
