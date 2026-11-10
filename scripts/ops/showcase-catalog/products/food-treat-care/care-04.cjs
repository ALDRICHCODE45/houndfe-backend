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
  key: 'epi-otic-advanced-118ml',
  name: 'Epi-Otic Advanced Limpiador Ótico 118 ml',
  sku: 'SC-CARE-004',
  category: 'Salud y bienestar',
  brand: 'Virbac',
  description:
    'Limpiador de oídos para perros y gatos, frasco con aplicador de 118 ml.',
  price: 459,
  mayoreo: 402,
  cost: 315,
  stock: 19,
  packaging: { weightG: 160, lengthCm: 5, widthCm: 5, heightCm: 15 },
  images: [
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/85/Ear_examination_of_a_white_dog_in_Newark%2C_New_Jersey.jpg/1280px-Ear_examination_of_a_white_dog_in_Newark%2C_New_Jersey.jpg',
      'Ear examination of a white dog in Newark, New Jersey.jpg',
      'Veterinarian Pet Alliance',
      'CC BY 4.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/f/ff/Pepper_the_Jack_Russell_Terrier_has_expressive_ears.jpg/1280px-Pepper_the_Jack_Russell_Terrier_has_expressive_ears.jpg',
      'Pepper the Jack Russell Terrier has expressive ears.jpg',
      'Boichico',
      'CC BY-SA 3.0',
    ),
    commons(
      'https://upload.wikimedia.org/wikipedia/commons/7/76/Greyhound_brindle_pattern_with_ear_up.jpg',
      'Greyhound brindle pattern with ear up.jpg',
      'L. Bower',
      'CC0',
    ),
  ],
  editorial: {
    familyCode: 'care',
    commercialTitle:
      'Epi-Otic Advanced, limpiador ótico de pH neutro para perros y gatos, 118 ml',
    description: [
      'Epi-Otic Advanced de Virbac es un limpiador de oídos para perros y gatos que elimina la cera, la suciedad y los residuos del conducto auditivo sin irritar. Mantener los oídos limpios es especialmente importante en razas de orejas caídas o con mucho pelo en el conducto, como cocker spaniel, basset hound, poodle o golden retriever, y en mascotas que nadan o se bañan con frecuencia.',
      'Su fórmula de pH neutro, libre de alcohol y de clorhexidina, disuelve el cerumen gracias a agentes surfactantes suaves, y su tecnología antiadherente ayuda a que las bacterias y levaduras no se fijen a la piel del oído. También neutraliza el mal olor y contiene ingredientes que secan el conducto después de la limpieza.',
      'El frasco incluye una boquilla aplicadora que facilita dosificar el líquido dentro del oído de forma higiénica. Es adecuado para la limpieza de rutina y como apoyo en la higiene del oído durante un tratamiento indicado por el médico veterinario.',
      'Modo de uso: llena el conducto auditivo con el limpiador, masajea suavemente la base de la oreja durante 20 a 30 segundos y deja que tu mascota sacuda la cabeza. Retira el exceso con un algodón o una gasa, nunca con hisopos dentro del conducto. Uso de rutina: 1 o 2 veces por semana, o según indique tu médico veterinario.',
    ].join('\n\n'),
    values: [
      multi('animal.target', ['ani.dom.dog', 'ani.dom.cat']),
      multi('life.stage', [
        'life.dog.puppy',
        'life.dog.adult',
        'life.dog.senior',
        'life.cat.kitten',
        'life.cat.adult',
        'life.cat.senior',
      ]),
      single('care.type', 'care.type.grooming'),
      single('care.form', 'care.form.solution'),
      single('care.device', 'care.device.applicator'),
      single('pack.form', 'pack.form.bottle'),
      single('pack.sale', 'pack.sale.single'),
      single('content.kind', 'content.kind.volume'),
      num('measure.net_volume', 118, 'ml'),
      num('measure.dimensions.external_height', 15, 'cm'),
      num('measure.dimensions.external_diameter', 4.5, 'cm'),
      text(
        'text.composition',
        'Agua purificada, propilenglicol, ácido salicílico, docusato de sodio, monosacáridos (D-manosa, D-galactosa, L-ramnosa), lactato de sodio, fragancia. Sin alcohol ni clorhexidina.',
      ),
      text(
        'text.concentration',
        'Ácido salicílico 0.1 %; pH neutro (7.0 aproximadamente).',
      ),
      text(
        'text.instructions',
        'Llenar el conducto, masajear la base de la oreja 20 a 30 segundos, dejar que sacuda la cabeza y retirar el exceso con algodón. Rutina: 1 o 2 veces por semana o según el médico veterinario.',
      ),
      text(
        'text.regulatory_warnings',
        'Uso externo veterinario. No usar si el tímpano está perforado. Evite el contacto con los ojos. Manténgase fuera del alcance de los niños.',
      ),
      text(
        'text.manufacturer_care',
        'Consérvese a temperatura ambiente, con el frasco bien cerrado. No congelar.',
      ),
    ],
    facts: [
      fact(
        null,
        'Frasco de 118 ml con boquilla aplicadora',
        [
          decl('contentMagnitude', 'volume'),
          decl('presentationKind', 'formulation'),
        ],
        careReview({
          intendedUse: 'Limpieza externa de oídos de perros y gatos',
          basis:
            'Revisión de la etiqueta y del registro del producto veterinario',
          sourceRef: 'Etiqueta e instructivo del empaque',
          requirements: [
            {
              key: 'registro-senasica',
              description:
                'Registro SENASICA/SADER vigente para producto de uso externo veterinario',
              basis: 'Número de registro impreso en el empaque',
            },
          ],
          warnings: [
            {
              key: 'timpano',
              requirementKeys: ['registro-senasica'],
              text: 'No usar si el tímpano está perforado.',
              handlingBasis: 'Se informa en mostrador al momento de la venta',
            },
          ],
        }),
      ),
    ],
  },
};
