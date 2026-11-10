'use strict';
const {
  single,
  multi,
  num,
  text,
  decl,
  fact,
  careReview,
  commons,
} = require('./shared.cjs');

module.exports = {
  key: 'condrovet-force-ha',
  name: 'Condrovet Force HA 30 Tabletas',
  sku: 'SC-CARE-003',
  category: 'Salud y bienestar',
  brand: 'Condrovet',
  description:
    'Suplemento articular con glucosamina, condroitina y ácido hialurónico para perros y gatos.',
  price: 649,
  mayoreo: 569,
  cost: 455,
  stock: 3,
  packaging: { weightG: 80, lengthCm: 12, widthCm: 4, heightCm: 9 },
  images: [
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/94/Walking_With_An_Old_Dog_%282304357275%29.jpg/1280px-Walking_With_An_Old_Dog_%282304357275%29.jpg',
      'Walking With An Old Dog (2304357275).jpg',
      'Helgi Halldórsson from Reykjavík, Iceland',
      'CC BY-SA 2.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4f/43_Old_dog_-_senior_labrador_dog_with_collar_resting_on_sidewalk.jpg/1280px-43_Old_dog_-_senior_labrador_dog_with_collar_resting_on_sidewalk.jpg',
      '43 Old dog - senior labrador dog with collar resting on sidewalk.jpg',
      'Marek Ślusarczyk (Tupungato)',
      'CC BY 3.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/7/71/A_senior_mixed_breed_dog_%2851051357731%29.jpg/1280px-A_senior_mixed_breed_dog_%2851051357731%29.jpg',
      'A senior mixed breed dog (51051357731).jpg',
      'Reba Spike',
      'CC BY 2.0',
    ),
  ],
  editorial: {
    familyCode: 'care',
    commercialTitle:
      'Condrovet Force HA, suplemento articular con ácido hialurónico para perros y gatos, 30 tabletas',
    description: [
      'Condrovet Force HA es un suplemento nutricional para perros y gatos que apoya la salud de las articulaciones. Es útil en mascotas mayores, en razas grandes con tendencia a problemas de cadera y codo, en perros muy activos o deportistas, y durante la recuperación después de una lesión o cirugía articular, siempre como complemento de las indicaciones de tu médico veterinario.',
      'Cada tableta combina glucosamina y sulfato de condroitina, componentes naturales del cartílago, con ácido hialurónico, que forma parte del líquido sinovial que lubrica la articulación. Esta combinación ayuda a mantener la estructura del cartílago y la movilidad, para que tu mascota siga caminando, subiendo escaleras y jugando con más comodidad.',
      'Las tabletas son palatables y pueden darse enteras, partidas o mezcladas con el alimento. Los resultados suelen notarse después de 4 a 6 semanas de uso continuo.',
      'Modo de uso: 1 tableta por cada 10 kg de peso al día durante las primeras 6 semanas (fase de carga), y después la mitad de la dosis como mantenimiento, o según indique tu médico veterinario. Gatos y perros de menos de 5 kg: media tableta al día.',
    ].join('\n\n'),
    values: [
      multi('animal.target', ['ani.dom.dog', 'ani.dom.cat']),
      multi('life.stage', [
        'life.dog.adult',
        'life.dog.senior',
        'life.cat.adult',
        'life.cat.senior',
      ]),
      single('care.type', 'care.type.supplement'),
      single('care.form', 'care.form.tablet'),
      single('pack.form', 'pack.form.blister'),
      single('pack.sale', 'pack.sale.single'),
      single('content.kind', 'content.kind.count'),
      num('measure.content_count', 30, 'dose_unit'),
      text(
        'text.composition',
        'Cada tableta contiene: clorhidrato de glucosamina 500 mg, sulfato de condroitina 400 mg, ácido hialurónico 10 mg, excipiente palatable c.b.p. 1 tableta.',
      ),
      text(
        'text.concentration',
        'Glucosamina 500 mg, condroitina 400 mg y ácido hialurónico 10 mg por tableta.',
      ),
      text(
        'text.instructions',
        '1 tableta por cada 10 kg al día durante 6 semanas, luego media dosis de mantenimiento, o según el médico veterinario. Gatos y perros de menos de 5 kg: media tableta al día.',
      ),
      text(
        'text.regulatory_warnings',
        'Suplemento alimenticio de uso veterinario; no es un medicamento. Consulte al médico veterinario. Manténgase fuera del alcance de los niños.',
      ),
      text(
        'text.manufacturer_care',
        'Consérvese en lugar fresco y seco, a no más de 30 °C, protegido de la luz.',
      ),
    ],
    facts: [
      fact(
        null,
        'Caja con 30 tabletas en blíster',
        [
          decl('contentMagnitude', 'count'),
          decl('presentationKind', 'formulation'),
        ],
        careReview({
          intendedUse:
            'Suplementación nutricional para la salud articular de perros y gatos',
          basis:
            'Revisión de la etiqueta y del registro del producto veterinario',
          sourceRef: 'Etiqueta e instructivo del empaque',
          requirements: [
            {
              key: 'registro-senasica',
              description:
                'Registro SENASICA/SADER vigente para producto alimenticio o suplemento veterinario',
              basis: 'Número de registro impreso en el empaque',
            },
          ],
          warnings: [
            {
              key: 'no-medicamento',
              requirementKeys: ['registro-senasica'],
              text: 'Es un suplemento y no sustituye un tratamiento indicado por el médico veterinario.',
              handlingBasis: 'Se informa en mostrador al momento de la venta',
            },
          ],
        }),
      ),
    ],
  },
};
