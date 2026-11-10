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
  key: 'drontal-plus-perro-10kg',
  name: 'Drontal Plus Perro 10 kg Caja 2 Tabletas',
  sku: 'SC-CARE-001',
  category: 'Salud y bienestar',
  brand: 'Drontal',
  description:
    'Desparasitante interno de amplio espectro para perros, 2 tabletas sabor carne.',
  price: 219,
  mayoreo: 192,
  cost: 150,
  stock: 28,
  packaging: { weightG: 30, lengthCm: 10, widthCm: 2, heightCm: 7 },
  images: [
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0d/Close-up_of_a_veterinarian_examining_a_maltese_dog_with_a_stethoscope._%2851687314898%29.jpg/1280px-Close-up_of_a_veterinarian_examining_a_maltese_dog_with_a_stethoscope._%2851687314898%29.jpg',
      'Close-up of a veterinarian examining a maltese dog with a stethoscope. (51687314898).jpg',
      'Nenad Stojkovic',
      'CC BY 2.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/21/Medicine_Drug_Pills_on_Plate.png/1280px-Medicine_Drug_Pills_on_Plate.png',
      'Medicine Drug Pills on Plate.png',
      'epSos .de',
      'CC BY 2.0',
    ),
    commons(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2a/Dog_portrait_with_a_veterinarian_in_blue_uniform_holding_a_stethoscope_-_51647083727.jpg/1280px-Dog_portrait_with_a_veterinarian_in_blue_uniform_holding_a_stethoscope_-_51647083727.jpg',
      'Dog portrait with a veterinarian in blue uniform holding a stethoscope - 51647083727.jpg',
      'Nenad Stojkovic',
      'CC BY 2.0',
    ),
  ],
  editorial: {
    familyCode: 'care',
    commercialTitle:
      'Drontal Plus sabor carne, desparasitante interno de amplio espectro para perros, 2 tabletas',
    description: [
      'Drontal Plus es uno de los desparasitantes internos más usados por médicos veterinarios en México. En una sola toma actúa contra los principales parásitos intestinales del perro: nematodos (lombrices redondas como Toxocara y anquilostomas), tricocéfalos y cestodos (tenias, incluida Dipylidium caninum, transmitida por pulgas), además de Giardia.',
      'Su fórmula combina tres principios activos que se complementan: praziquantel, pamoato de pirantel y febantel. Las tabletas tienen sabor a carne, por lo que la mayoría de los perros las aceptan solas o escondidas en un premio, sin necesidad de ayuno previo.',
      'Desparasitar con regularidad protege la salud de tu perro y la de tu familia, porque algunos parásitos intestinales del perro pueden transmitirse a las personas. Cada tableta corresponde a 10 kg de peso corporal; la caja incluye 2 tabletas.',
      'Modo de uso: administra 1 tableta por cada 10 kg de peso en una sola toma, por vía oral. Puede usarse en cachorros desde las 2 semanas de edad y 2 kg de peso. Repite según el calendario que indique tu médico veterinario, en general cada 3 meses en adultos. Consulta a tu médico veterinario antes de usarlo en hembras gestantes.',
    ].join('\n\n'),
    values: [
      multi('animal.target', ['ani.dom.dog']),
      multi('life.stage', [
        'life.dog.puppy',
        'life.dog.adult',
        'life.dog.senior',
      ]),
      single('care.type', 'care.type.medicine'),
      single('care.form', 'care.form.tablet'),
      single('pack.form', 'pack.form.blister'),
      single('pack.sale', 'pack.sale.single'),
      single('content.kind', 'content.kind.count'),
      num('measure.content_count', 2, 'dose_unit'),
      text(
        'text.composition',
        'Cada tableta contiene: praziquantel 50 mg, pamoato de pirantel 144 mg, febantel 150 mg. Excipiente con sabor a carne c.b.p. 1 tableta.',
      ),
      text(
        'text.concentration',
        'Praziquantel 50 mg, pamoato de pirantel 144 mg y febantel 150 mg por tableta (dosis para 10 kg).',
      ),
      text(
        'text.instructions',
        '1 tableta por cada 10 kg de peso, dosis única por vía oral. Cachorros desde 2 semanas y 2 kg. Repetir según indicación del médico veterinario (en general cada 3 meses en adultos).',
      ),
      text(
        'text.regulatory_warnings',
        'Uso veterinario. Consulte al médico veterinario. No se use en hembras gestantes sin indicación veterinaria. Manténgase fuera del alcance de los niños. No administrar a cachorros menores de 2 semanas o de 2 kg.',
      ),
      text(
        'text.manufacturer_care',
        'Consérvese a temperatura ambiente (no más de 30 °C), en lugar seco y protegido de la luz. Mantener las tabletas en su blíster hasta el momento de usarlas.',
      ),
      text(
        'text.clinical_analysis',
        'Espectro: nematodos (Toxocara canis, Toxascaris leonina, Ancylostoma caninum, Uncinaria stenocephala, Trichuris vulpis), cestodos (Dipylidium caninum, Taenia spp., Echinococcus spp.) y Giardia.',
      ),
    ],
    facts: [
      fact(
        null,
        'Caja con 2 tabletas en blíster',
        [
          decl('contentMagnitude', 'count'),
          decl('presentationKind', 'formulation'),
        ],
        careReview({
          intendedUse: 'Desparasitación interna oral de perros',
          basis:
            'Revisión de la etiqueta y del registro del producto veterinario',
          sourceRef: 'Etiqueta e instructivo del empaque',
          requirements: [
            {
              key: 'registro-senasica',
              description:
                'Registro SENASICA/SADER vigente para producto farmacéutico veterinario',
              basis: 'Número de registro impreso en el empaque',
            },
            {
              key: 'venta-libre',
              description:
                'Producto de venta libre sin receta médica veterinaria',
              basis: 'Leyenda de venta del empaque',
            },
          ],
          warnings: [
            {
              key: 'gestantes',
              requirementKeys: ['registro-senasica'],
              text: 'No usar en hembras gestantes sin indicación veterinaria.',
              handlingBasis: 'Se informa en mostrador al momento de la venta',
            },
          ],
        }),
      ),
    ],
  },
};
