'use strict';
const {
  editorial,
  fact,
  image,
  many,
  num,
  one,
  text,
} = require('./shared.cjs');

const presentations = [
  {
    key: '592ML',
    name: 'Botella 592 ml',
    volume: 592,
    unit: 'ml',
    form: 'pack.form.bottle',
    price: 389,
    mayoreo: 339,
    stock: 36,
  },
  {
    key: '3780ML',
    name: 'Galón 3.78 l',
    volume: 3.78,
    unit: 'l',
    form: 'pack.form.bottle',
    price: 1690,
    mayoreo: 1470,
    stock: 1,
  },
];

module.exports = {
  key: 'tropiclean-papaya-shampoo',
  name: 'TropiClean shampoo 2 en 1 papaya y coco para perro y gato',
  sku: 'SC-HIG-001',
  category: 'Baño y aseo',
  brand: 'TropiClean',
  description:
    'Shampoo con acondicionador de papaya y coco, sin jabón. 592 ml y galón.',
  price: 389,
  mayoreo: 339,
  cost: 228,
  variants: presentations.map((p) => ({
    key: p.key,
    name: p.name,
    sku: `SC-HIG-001-${p.key}`,
    price: p.price,
    mayoreo: p.mayoreo,
    stock: p.stock,
  })),
  packaging: { weightG: 700, lengthCm: 8, widthCm: 6, heightCm: 22 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/65/%D5%87%D5%A1%D5%B6_%D5%B7%D5%A1%D5%B4%D5%BA%D5%B8%D6%82%D5%B6_%D6%87_%D6%83%D5%A1%D6%83%D5%AF%D5%A1%D6%81%D5%B8%D6%82%D6%81%D5%AB%D5%B9.JPG/1280px-%D5%87%D5%A1%D5%B6_%D5%B7%D5%A1%D5%B4%D5%BA%D5%B8%D6%82%D5%B6_%D6%87_%D6%83%D5%A1%D6%83%D5%AF%D5%A1%D6%81%D5%B8%D6%82%D6%81%D5%AB%D5%B9.JPG',
      'Chaojoker / Wikimedia Commons',
      'CC BY-SA 3.0',
      'https://commons.wikimedia.org/wiki/File:%D5%87%D5%A1%D5%B6_%D5%B7%D5%A1%D5%B4%D5%BA%D5%B8%D6%82%D5%B6_%D6%87_%D6%83%D5%A1%D6%83%D5%AF%D5%A1%D6%81%D5%B8%D6%82%D6%81%D5%AB%D5%B9.JPG',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/15/A_shower_for_a_Cana_Corso.jpg/1280px-A_shower_for_a_Cana_Corso.jpg',
      'בר / Wikimedia Commons',
      'CC BY-SA 3.0',
      'https://commons.wikimedia.org/wiki/File:A_shower_for_a_Cana_Corso.jpg',
    ),
    image(
      'https://upload.wikimedia.org/wikipedia/commons/2/2f/Newly-bathe_Shih_Tzu.jpg',
      'Rurbanlife / Wikimedia Commons',
      'CC BY-SA 3.0',
      'https://commons.wikimedia.org/wiki/File:Newly-bathe_Shih_Tzu.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'hygiene',
    commercialTitle:
      'TropiClean Papaya y Coco: shampoo 2 en 1 con acondicionador para perro y gato',
    description: [
      'El shampoo 2 en 1 de TropiClean limpia y acondiciona en un solo paso. Su fórmula sin jabón, con extracto de papaya y coco, elimina la suciedad y el mal olor sin resecar la piel, y deja el pelo suave, brillante y fácil de cepillar. Es la opción práctica para baños en casa cuando quieres un buen resultado sin dar dos enjuagues.',
      'La papaya aporta enzimas naturales que ayudan a desprender la suciedad, mientras que el aceite de coco hidrata y reduce los nudos y el frizz, especialmente en pelajes medianos y largos. Su aroma tropical es suave y duradero, sin resultar invasivo.',
      'Es apto para perros y gatos a partir de las 12 semanas de edad y es compatible con tratamientos tópicos antipulgas cuando se respeta el tiempo indicado por el veterinario. La botella de 592 ml rinde varios baños de un perro mediano; el galón de 3.78 l es la presentación ideal para estéticas caninas, criaderos o casas con varias mascotas.',
      'Modo de uso: moja bien el pelaje con agua tibia, aplica el shampoo y masajea desde el cuello hacia la cola, evitando ojos y oídos. Deja actuar de 3 a 5 minutos y enjuaga por completo. Para uso externo; si aparece irritación, suspende el uso.',
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
      one('hygiene.type', 'hygiene.type.shampoo'),
      one('hygiene.form', 'hygiene.form.liquid'),
      one('hygiene.scent', 'hygiene.scent.scented'),
      many('material', ['material.rigid.plastic']),
      one('pack.sale', 'pack.sale.single'),
      one('content.kind', 'content.kind.volume'),
      text(
        'text.manufacturer_care',
        'Conservar bien cerrado, en un lugar fresco y lejos de la luz directa del sol. Mantener fuera del alcance de los niños.',
      ),
      text(
        'text.instructions',
        'Moja el pelaje con agua tibia, aplica y masajea evitando ojos y oídos, deja actuar de 3 a 5 minutos y enjuaga por completo. Uso externo, a partir de las 12 semanas de edad.',
      ),
    ],
    declarations: [
      fact('consumable', true, 'Es un producto que se consume con cada baño.'),
      fact(
        'animalApplied',
        true,
        'Se aplica directamente sobre el pelaje del perro o gato.',
      ),
      fact(
        'contentMagnitude',
        'volume',
        'El contenido se declara en mililitros o litros.',
      ),
    ],
    variants: presentations.map((p) => ({
      key: p.key,
      presentation: p.name,
      values: [
        one('pack.form', p.form),
        num('measure.net_volume', p.volume, p.unit),
      ],
    })),
  }),
};
