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

module.exports = {
  key: 'petkin-dental-wipes',
  name: 'Petkin toallitas dentales sabor menta para perro y gato 40 piezas',
  sku: 'SC-HIG-005',
  category: 'Cuidado dental',
  brand: 'Petkin',
  description:
    'Toallitas texturizadas para limpiar dientes y encías, 40 piezas.',
  price: 229,
  mayoreo: 199,
  cost: 128,
  stock: 15,
  packaging: { weightG: 180, lengthCm: 16, widthCm: 10, heightCm: 4 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6a/MWD_takes_bite_out_of_dental_care_141219-F-QE361-055.jpg/1280px-MWD_takes_bite_out_of_dental_care_141219-F-QE361-055.jpg',
      'Staff Sgt. Joshua Turner / Wikimedia Commons',
      'Public domain',
      'https://commons.wikimedia.org/wiki/File:MWD_takes_bite_out_of_dental_care_141219-F-QE361-055.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/11/Staff_Sgt._Gregory_Johnson_removes_plaque_from_a_military_working_dog%E2%80%99s_teeth.jpg/1280px-Staff_Sgt._Gregory_Johnson_removes_plaque_from_a_military_working_dog%E2%80%99s_teeth.jpg',
      'US Air Force / Wikimedia Commons',
      'Public domain',
      'https://commons.wikimedia.org/wiki/File:Staff_Sgt._Gregory_Johnson_removes_plaque_from_a_military_working_dog%E2%80%99s_teeth.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'hygiene',
    commercialTitle:
      'Petkin toallitas dentales menta: limpieza diaria de dientes y encías para perro y gato, 40 piezas',
    description: [
      'No todos los perros y gatos aceptan un cepillo de dientes, pero casi todos toleran una toallita. Las toallitas dentales Petkin están hechas de tela texturizada que se coloca en el dedo y retira la placa y los restos de comida de dientes y encías con un masaje suave, sin necesidad de enjuague.',
      'Su fórmula sabor menta refresca el aliento y ayuda a mantener la boca limpia entre las limpiezas profesionales del veterinario. La limpieza diaria es la mejor forma de prevenir el sarro, el mal aliento y la inflamación de encías, problemas muy comunes a partir de los tres años de edad.',
      'Son aptas para perros y gatos de todas las edades y especialmente útiles para acostumbrar a cachorros y gatitos a que les manipulen la boca. El envase resellable conserva la humedad de las 40 toallitas hasta el final.',
      'Modo de uso: envuelve una toallita en tu dedo índice, levanta suavemente el labio y frota los dientes y la línea de la encía con movimientos circulares, poniendo atención en los colmillos y muelas. Usa una toallita por sesión y deséchala. Cierra bien el envase después de cada uso. No sustituye la revisión dental veterinaria.',
    ].join('\n\n'),
    values: [
      many('animal.target', ['ani.dom.dog', 'ani.dom.cat']),
      many('life.stage', [
        'life.dog.puppy',
        'life.dog.adult',
        'life.dog.senior',
        'life.cat.kitten',
        'life.cat.adult',
        'life.cat.senior',
      ]),
      one('hygiene.type', 'hygiene.type.wipes'),
      one('hygiene.form', 'hygiene.form.wipe'),
      one('hygiene.scent', 'hygiene.scent.scented'),
      one('pack.form', 'pack.form.pouch'),
      one('pack.sale', 'pack.sale.single'),
      one('content.kind', 'content.kind.count'),
      num('measure.content_count', 40, 'piece'),
      bool('feature.reusable', false),
      text(
        'text.manufacturer_care',
        'Cerrar bien el envase después de cada uso para conservar la humedad. Guardar a temperatura ambiente.',
      ),
      text(
        'text.instructions',
        'Envuelve una toallita en el dedo, frota dientes y encías con movimientos circulares y desecha la toallita. Uso diario; no sustituye la revisión dental veterinaria.',
      ),
    ],
    declarations: [
      fact('consumable', true, 'Son toallitas desechables de un solo uso.'),
      fact(
        'animalApplied',
        true,
        'Se aplican directamente en la boca del perro o gato.',
      ),
      fact(
        'contentMagnitude',
        'count',
        'El contenido se declara en número de toallitas.',
      ),
    ],
    presentation: 'Sobre resellable de 40 toallitas',
  }),
};
