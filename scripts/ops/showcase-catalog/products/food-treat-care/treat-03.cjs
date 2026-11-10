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
  key: 'orijen-premios-liofilizados-pollo',
  name: 'Orijen Premios Liofilizados Pollo de Granja 42.5 g',
  sku: 'SC-TREAT-003',
  category: 'Premios y snacks',
  brand: 'Orijen',
  description: 'Premios liofilizados de pollo para perro, bolsa 42.5 g.',
  price: 289,
  mayoreo: 255,
  cost: 205,
  stock: 0,
  packaging: { weightG: 70, lengthCm: 13, widthCm: 4, heightCm: 20 },
  images: [
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/61/Dog_Treats_%2851049057473%29.jpg/1280px-Dog_Treats_%2851049057473%29.jpg',
      'Dog Treats (51049057473).jpg',
      'Megan Marrs',
      'CC BY 2.0',
    ),
    commons(
      'https://upload.wikimedia.org/wikipedia/commons/b/b7/Dog_with_treat.jpg',
      'Dog with treat.jpg',
      'pbump (Flickr)',
      'CC BY-SA 2.0',
    ),
  ],
  editorial: {
    familyCode: 'treat',
    commercialTitle:
      'Orijen premios liofilizados de pollo de granja, 100 % proteína animal para perros',
    description: [
      'Los premios Orijen Pollo de Granja se elaboran con carne, órganos y cartílago de pollo criado en libertad, liofilizados en crudo para conservar el sabor, el aroma y los nutrientes de la carne fresca. Tienen un solo ingrediente animal y no llevan cereales, conservadores artificiales ni rellenos.',
      'La liofilización retira el agua a baja temperatura sin cocinar la carne, de modo que cada pieza conserva su proteína natural y queda ligera y crujiente por fuera. Su intensidad de sabor los hace ideales como premio de alto valor para entrenamiento, sesiones de socialización o para motivar a perros selectivos.',
      'Las piezas son fáciles de partir con los dedos en trozos más pequeños, lo que te permite usarlas con perros de cualquier tamaño y alargar el contenido de la bolsa.',
      'Modo de uso: ofrece las piezas como premio, sin sustituir la alimentación diaria; para un perro de 10 kg, hasta 4 piezas al día. Puedes servirlos secos o rehidratados con un poco de agua tibia. Mantén agua fresca disponible. Cierra bien la bolsa después de cada uso y guárdala en un lugar fresco y seco.',
    ].join('\n\n'),
    values: [
      multi('animal.target', ['ani.dom.dog']),
      multi('life.stage', [
        'life.dog.puppy',
        'life.dog.adult',
        'life.dog.senior',
      ]),
      multi('size.animal', [
        'size.animal.miniature',
        'size.animal.small',
        'size.animal.medium',
        'size.animal.large',
        'size.animal.giant',
      ]),
      single('treat.form', 'treat.form.dried_piece'),
      multi('treat.base', ['treat.base.meat']),
      multi('food.process', ['food.process.freeze_dried']),
      multi('food.texture', ['food.texture.dry', 'food.texture.crunchy']),
      single('pack.form', 'pack.form.pouch'),
      single('pack.sale', 'pack.sale.single'),
      single('content.kind', 'content.kind.mass'),
      num('measure.net_mass', 42.5, 'g'),
      text(
        'text.ingredients',
        'Pollo (carne, hígado, corazón y cartílago), tocoferoles mixtos (conservador natural).',
      ),
      text(
        'text.protein_origin',
        'Pollo criado en libertad: carne, órganos y cartílago.',
      ),
      text(
        'text.composition',
        'Proteína cruda (mín.) 60 %, grasa cruda (mín.) 22 %, fibra cruda (máx.) 2 %, humedad (máx.) 8 %.',
      ),
      text(
        'text.instructions',
        'Premio de alto valor, sin sustituir el alimento. Perro de 10 kg: hasta 4 piezas al día. Se sirven secos o rehidratados. Cierra bien la bolsa.',
      ),
      text('text.clinical_analysis', 'Energía aproximada: 4.5 kcal por pieza.'),
    ],
    facts: [
      fact(null, 'Bolsa resellable de 42.5 g', [
        decl('contentMagnitude', 'mass'),
      ]),
    ],
  },
};
