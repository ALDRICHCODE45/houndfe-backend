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

const scents = [
  {
    key: 'SIN-AROMA',
    name: 'Sin aroma',
    scent: 'hygiene.scent.unscented',
    stock: 52,
  },
  {
    key: 'LAVANDA',
    name: 'Aroma lavanda',
    scent: 'hygiene.scent.scented',
    stock: 0,
  },
];

module.exports = {
  key: 'earth-rated-poop-bags',
  name: 'Earth Rated bolsas para desechos de perro 120 bolsas (8 rollos)',
  sku: 'SC-HIG-004',
  category: 'Control de desechos',
  brand: 'Earth Rated',
  description:
    'Bolsas extra gruesas y a prueba de fugas, 8 rollos de 15 bolsas.',
  price: 239,
  mayoreo: 209,
  cost: 135,
  variants: scents.map((s) => ({
    key: s.key,
    name: s.name,
    sku: `SC-HIG-004-${s.key}`,
    price: 239,
    mayoreo: 209,
    stock: s.stock,
  })),
  packaging: { weightG: 320, lengthCm: 16, widthCm: 8, heightCm: 6 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/09/Portable_dog_waste_bag_dispenser%2C_Hillegersberg%2C_Rotterdam_%282022%29_01.jpg/1280px-Portable_dog_waste_bag_dispenser%2C_Hillegersberg%2C_Rotterdam_%282022%29_01.jpg',
      'Donald Trung Quoc Don / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:Portable_dog_waste_bag_dispenser,_Hillegersberg,_Rotterdam_(2022)_01.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/4/46/Portable_dog_waste_bag_dispenser%2C_Hillegersberg%2C_Rotterdam_%282022%29_02.jpg/1280px-Portable_dog_waste_bag_dispenser%2C_Hillegersberg%2C_Rotterdam_%282022%29_02.jpg',
      'Donald Trung Quoc Don / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:Portable_dog_waste_bag_dispenser,_Hillegersberg,_Rotterdam_(2022)_02.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a8/Dog_poop_bags_in_Geneva.jpg/1280px-Dog_poop_bags_in_Geneva.jpg',
      'Ypsilon from Finland / Wikimedia Commons',
      'CC0',
      'https://commons.wikimedia.org/wiki/File:Dog_poop_bags_in_Geneva.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'hygiene',
    commercialTitle:
      'Earth Rated: 120 bolsas extra gruesas para desechos de perro en 8 rollos, sin aroma o lavanda',
    description: [
      'Recoger lo que deja tu perro en el paseo es parte de ser un buen vecino, y con las bolsas Earth Rated es más fácil y limpio. Son extra gruesas y a prueba de fugas, con un tamaño generoso de 23 x 33 cm que cubre bien la mano y se anuda sin esfuerzo.',
      'Vienen en rollos de 15 bolsas con núcleo de cartón reciclado que caben en casi cualquier dispensador de correa. Una línea perforada te permite separar una sola bolsa a la vez, y el último tramo del rollo está marcado para avisarte que es momento de cambiarlo.',
      'Elige entre la versión sin aroma, para quien prefiere no añadir fragancias, o la versión con aroma a lavanda, que ayuda a disimular el olor mientras llegas al bote de basura. Cada paquete incluye 8 rollos, es decir, 120 bolsas, suficientes para cerca de dos meses con dos paseos diarios.',
      'Modo de uso: coloca el rollo en el dispensador, separa una bolsa por la perforación, recoge los desechos con la bolsa como guante, voltéala, anúdala y deposítala en un contenedor de basura. No la tires al inodoro.',
    ].join('\n\n'),
    values: [
      many('animal.target', ['ani.dom.dog']),
      one('hygiene.type', 'hygiene.type.bag'),
      one('hygiene.form', 'hygiene.form.bag'),
      many('material', ['material.rigid.polyethylene']),
      one('pack.form', 'pack.form.box'),
      one('pack.sale', 'pack.sale.multipack'),
      one('content.kind', 'content.kind.count'),
      num('measure.content_count', 120, 'piece'),
      num('measure.pack_count', 8, 'unit'),
      num('measure.dimensions.external_length', 33, 'cm'),
      num('measure.dimensions.external_width', 23, 'cm'),
      bool('feature.waterproof', true),
      bool('feature.reusable', false),
      text(
        'text.manufacturer_care',
        'Guardar en un lugar fresco y seco, lejos de la luz solar directa.',
      ),
      text(
        'text.instructions',
        'Separa una bolsa por la perforación, recoge los desechos usándola como guante, voltéala, anúdala y deposítala en un contenedor de basura. No tirar al inodoro.',
      ),
    ],
    declarations: [
      fact('consumable', true, 'Son bolsas desechables de un solo uso.'),
      fact(
        'animalApplied',
        true,
        'El empaque indica que son para desechos de perro.',
      ),
      fact(
        'contentMagnitude',
        'count',
        'El contenido se declara en número de bolsas.',
      ),
    ],
    variants: scents.map((s) => ({
      key: s.key,
      presentation: `Caja de 8 rollos, ${s.name.toLowerCase()}`,
      values: [one('hygiene.scent', s.scent)],
    })),
  }),
};
