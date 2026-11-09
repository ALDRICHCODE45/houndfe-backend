'use strict';
const {
  bool,
  editorial,
  fact,
  image,
  many,
  num,
  one,
  text,
} = require('./shared.cjs');

const packs = [
  {
    key: '30PZ',
    name: 'Paquete de 30 piezas',
    count: 30,
    price: 299,
    mayoreo: 262,
    stock: 28,
  },
  {
    key: '50PZ',
    name: 'Paquete de 50 piezas',
    count: 50,
    price: 459,
    mayoreo: 399,
    stock: 0,
  },
];

module.exports = {
  key: 'fancy-pets-training-pads',
  name: 'Fancy Pets tapetes entrenadores absorbentes para perro 60 x 60 cm',
  sku: 'SC-HIG-003',
  category: 'Control de desechos',
  brand: 'Fancy Pets',
  description:
    'Tapetes de 5 capas con gel absorbente y base impermeable, 60 x 60 cm.',
  price: 299,
  mayoreo: 262,
  cost: 172,
  variants: packs.map((p) => ({
    key: p.key,
    name: p.name,
    sku: `SC-HIG-003-${p.key}`,
    price: p.price,
    mayoreo: p.mayoreo,
    stock: p.stock,
  })),
  packaging: { weightG: 1500, lengthCm: 32, widthCm: 22, heightCm: 15 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/12/A_puppy_receiving_belly_rubs_for_peeing_on_a_puppy_pad.jpg/1280px-A_puppy_receiving_belly_rubs_for_peeing_on_a_puppy_pad.jpg',
      'arvind grover from New York City, USA / Wikimedia Commons',
      'CC BY-SA 2.0',
      'https://commons.wikimedia.org/wiki/File:A_puppy_receiving_belly_rubs_for_peeing_on_a_puppy_pad.jpg',
    ),
    image(
      'https://upload.wikimedia.org/wikipedia/commons/8/87/Two_puppies.jpg',
      'Bev Sykes from Davis, CA, USA / Wikimedia Commons',
      'CC BY 2.0',
      'https://commons.wikimedia.org/wiki/File:Two_puppies.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'hygiene',
    commercialTitle:
      'Tapetes entrenadores Fancy Pets 60 x 60 cm: 5 capas con gel superabsorbente y base impermeable',
    description: [
      'Los tapetes entrenadores de Fancy Pets son el aliado para enseñar a tu cachorro dónde hacer sus necesidades y para resolver los días en que tu perro no puede salir: perros pequeños en departamento, perros sénior, recuperación después de una cirugía o viajes largos.',
      'Cada tapete tiene cinco capas: una superficie de tela no tejida de secado rápido, dos capas de celulosa que distribuyen el líquido, un núcleo de gel superabsorbente que lo atrapa y lo convierte en gel, y una base de polietileno impermeable que protege el piso. Incluyen un atrayente que ayuda al cachorro a reconocer el lugar correcto.',
      'Miden 60 x 60 cm, un tamaño suficiente para perros pequeños y medianos, y tienen bordes sellados para evitar escurrimientos. El paquete de 30 piezas es ideal para empezar el entrenamiento; el de 50 piezas rinde más para uso diario.',
      'Modo de uso: coloca el tapete con la cara blanca hacia arriba en un lugar fijo, lejos de la cama y del plato de comida. Lleva a tu cachorro al tapete al despertar y después de comer, y felicítalo cuando lo use. Cambia el tapete en cuanto esté saturado. Es desechable, de un solo uso.',
    ].join('\n\n'),
    values: [
      many('animal.target', ['ani.dom.dog']),
      many('life.stage', [
        'life.dog.puppy',
        'life.dog.adult',
        'life.dog.senior',
      ]),
      one('hygiene.type', 'hygiene.type.pad'),
      one('hygiene.form', 'hygiene.form.pad'),
      one('hygiene.scent', 'hygiene.scent.unscented'),
      many('material', ['material.rigid.paper', 'material.rigid.polyethylene']),
      one('pack.form', 'pack.form.bag'),
      one('pack.sale', 'pack.sale.multipack'),
      one('content.kind', 'content.kind.count'),
      num('measure.dimensions.external_length', 60, 'cm'),
      num('measure.dimensions.external_width', 60, 'cm'),
      bool('feature.waterproof', true),
      bool('feature.reusable', false),
      text(
        'text.manufacturer_care',
        'Guardar en un lugar seco. Desechar el tapete usado con la basura; no tirar al inodoro.',
      ),
      text(
        'text.instructions',
        'Coloca el tapete con la cara blanca hacia arriba en un lugar fijo, lleva a tu cachorro después de comer y al despertar, y cámbialo en cuanto esté saturado.',
      ),
    ],
    declarations: [
      fact('consumable', true, 'Es un tapete desechable de un solo uso.'),
      fact(
        'animalApplied',
        true,
        'El empaque indica que el producto es para perros.',
      ),
      fact(
        'contentMagnitude',
        'count',
        'El contenido se declara en número de tapetes.',
      ),
    ],
    variants: packs.map((p) => ({
      key: p.key,
      presentation: p.name,
      values: [num('measure.content_count', p.count, 'piece')],
    })),
  }),
};
