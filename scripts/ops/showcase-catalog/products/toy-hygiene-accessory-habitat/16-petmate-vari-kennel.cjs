'use strict';
const {
  capacityIrrelevant,
  editorial,
  fitIrrelevant,
  image,
  many,
  notElectrical,
  num,
  one,
  range,
  text,
} = require('./shared.cjs');

const sizes = [
  {
    key: 'S',
    inches: 24,
    dims: [61, 41, 38],
    mass: [4.5, 9],
    animal: ['size.animal.small'],
    price: 1499,
    mayoreo: 1309,
    stock: 8,
  },
  {
    key: 'M',
    inches: 28,
    dims: [71, 52, 53],
    mass: [9, 14],
    animal: ['size.animal.medium'],
    price: 2399,
    mayoreo: 2095,
    stock: 3,
  },
  {
    key: 'L',
    inches: 32,
    dims: [81, 56, 61],
    mass: [14, 23],
    animal: ['size.animal.large'],
    price: 2999,
    mayoreo: 2615,
    stock: 0,
  },
];

module.exports = {
  key: 'petmate-ultra-vari-kennel',
  name: 'Petmate Ultra Vari Kennel transportadora rígida para perro y gato',
  sku: 'SC-ACC-006',
  category: 'Transportadoras',
  brand: 'Petmate',
  description:
    'Transportadora de plástico resistente con puerta de acero y ventilación en 360°. 24, 28 y 32 pulgadas.',
  price: 1499,
  mayoreo: 1309,
  cost: 880,
  variants: sizes.map((s) => ({
    key: s.key,
    name: `${s.inches}" (${s.dims[0]} x ${s.dims[1]} x ${s.dims[2]} cm)`,
    sku: `SC-ACC-006-${s.key}`,
    price: s.price,
    mayoreo: s.mayoreo,
    stock: s.stock,
  })),
  packaging: { weightG: 5200, lengthCm: 72, widthCm: 53, heightCm: 54 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d4/Dogtainers_Pet_Transport_Dog_Cage_Travel_Crate_Labrador_Puppy.jpg/1280px-Dogtainers_Pet_Transport_Dog_Cage_Travel_Crate_Labrador_Puppy.jpg',
      'Chachacha369 / Wikimedia Commons',
      'CC BY-SA 3.0',
      'https://commons.wikimedia.org/wiki/File:Dogtainers_Pet_Transport_Dog_Cage_Travel_Crate_Labrador_Puppy.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f4/Dogtainers_Pet_Transport_Clipper_Cat_Cage_Plastic_Travel_Crate_Labelled.jpg/1280px-Dogtainers_Pet_Transport_Clipper_Cat_Cage_Plastic_Travel_Crate_Labelled.jpg',
      'Chachacha369 / Wikimedia Commons',
      'CC BY-SA 3.0',
      'https://commons.wikimedia.org/wiki/File:Dogtainers_Pet_Transport_Clipper_Cat_Cage_Plastic_Travel_Crate_Labelled.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f7/Dog_In_Crate.jpg/1280px-Dog_In_Crate.jpg',
      'IsraeliEditor54 / Wikimedia Commons',
      'CC0',
      'https://commons.wikimedia.org/wiki/File:Dog_In_Crate.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'accessory',
    commercialTitle:
      'Petmate Ultra Vari Kennel: transportadora rígida con puerta de acero para viaje y visitas al veterinario',
    description: [
      'La Ultra Vari Kennel de Petmate es la transportadora rígida de referencia para viajes en auto, visitas al veterinario y como espacio seguro en casa. Su casco de plástico de alta resistencia, fabricado en Estados Unidos, protege a tu mascota de golpes y le da un refugio cerrado donde se siente tranquila.',
      'Tiene ventilación en los cuatro costados para una circulación de aire constante, puerta de rejilla de acero galvanizado con cierre de presión que se abre con una mano, y las dos mitades se unen con tuercas de mariposa que se aprietan sin herramientas. La manija superior permite cargarla con comodidad y los canales integrados sirven para asegurarla con el cinturón del auto.',
      'Elige la talla de modo que tu mascota pueda ponerse de pie, darse la vuelta y acostarse estirada: 24" (61 x 41 x 38 cm) para mascotas de 4.5 a 9 kg, 28" (71 x 52 x 53 cm) de 9 a 14 kg y 32" (81 x 56 x 61 cm) de 14 a 23 kg. Muchas aerolíneas aceptan este modelo para viaje en bodega; confirma los requisitos con tu aerolínea antes de volar.',
      'Para acostumbrar a tu mascota, deja la transportadora abierta en casa con una manta y algunos premios dentro. Límpiala con agua y jabón neutro; las mitades se separan para guardarla o lavarla a fondo.',
    ].join('\n\n'),
    values: [
      many('animal.target', ['ani.dom.dog', 'ani.dom.cat']),
      one('accessory.type', 'accessory.type.carrier'),
      many('accessory.closure', [
        'accessory.closure.screw',
        'accessory.closure.snap',
      ]),
      many('material', ['material.rigid.plastic', 'material.rigid.steel']),
      many('color.base', ['color.base.grey', 'color.base.black']),
      one('pack.form', 'pack.form.box'),
      one('pack.sale', 'pack.sale.single'),
      text(
        'text.manufacturer_care',
        'Limpiar con agua tibia y jabón neutro; separar las mitades para una limpieza profunda. Secar antes de volver a usar.',
      ),
      text(
        'text.instructions',
        'Elige una talla donde tu mascota pueda pararse, girar y acostarse estirada. Aprieta las tuercas de mariposa, cierra la puerta hasta oír el clic y asegúrala con el cinturón en el auto.',
      ),
    ],
    declarations: [...fitIrrelevant, ...capacityIrrelevant, ...notElectrical],
    variants: sizes.map((s) => ({
      key: s.key,
      presentation: `Ultra Vari Kennel ${s.inches} pulgadas`,
      values: [
        one('size.label', `size.label.${s.key.toLowerCase()}`),
        many('size.animal', s.animal),
        num('measure.dimensions.external_length', s.dims[0], 'cm'),
        num('measure.dimensions.external_width', s.dims[1], 'cm'),
        num('measure.dimensions.external_height', s.dims[2], 'cm'),
        range('measure.animal_mass', s.mass[0], s.mass[1], 'kg'),
      ],
    })),
  }),
};
