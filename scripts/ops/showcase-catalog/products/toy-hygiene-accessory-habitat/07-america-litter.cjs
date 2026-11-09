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
    key: '7KG',
    name: 'Bolsa 7 kg',
    mass: 7,
    price: 179,
    mayoreo: 156,
    stock: 64,
  },
  {
    key: '15KG',
    name: 'Bolsa 15 kg',
    mass: 15,
    price: 339,
    mayoreo: 295,
    stock: 4,
  },
];

module.exports = {
  key: 'america-litter-odor-seal',
  name: 'America Litter Ultra Odor Seal arena aglutinante para gato',
  sku: 'SC-HIG-002',
  category: 'Arena para gato',
  brand: 'America Litter',
  description:
    'Arena de bentonita aglutinante con control de olor. Bolsas de 7 y 15 kg.',
  price: 179,
  mayoreo: 156,
  cost: 104,
  variants: presentations.map((p) => ({
    key: p.key,
    name: p.name,
    sku: `SC-HIG-002-${p.key}`,
    price: p.price,
    mayoreo: p.mayoreo,
    stock: p.stock,
  })),
  packaging: { weightG: 7200, lengthCm: 45, widthCm: 30, heightCm: 10 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4d/Fresh_cat_litter_close_up.JPG/1280px-Fresh_cat_litter_close_up.JPG',
      'CambridgeBayWeather / Wikimedia Commons',
      'CC BY-SA 3.0',
      'https://commons.wikimedia.org/wiki/File:Fresh_cat_litter_close_up.JPG',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/5/50/Litter_box_1_2017-12-27.jpg/1280px-Litter_box_1_2017-12-27.jpg',
      'FASTILY / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:Litter_box_1_2017-12-27.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/81/Bentonite_bianca_uso_lettiera_per_gatti.jpg/1280px-Bentonite_bianca_uso_lettiera_per_gatti.jpg',
      'F Ceragioli / Wikimedia Commons',
      'CC0',
      'https://commons.wikimedia.org/wiki/File:Bentonite_bianca_uso_lettiera_per_gatti.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b0/Kitty_Litter_Texture.jpg/1280px-Kitty_Litter_Texture.jpg',
      'TaurusEmerald / Wikimedia Commons',
      'CC BY-SA 4.0',
      'https://commons.wikimedia.org/wiki/File:Kitty_Litter_Texture.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'hygiene',
    commercialTitle:
      'America Litter Ultra Odor Seal: arena aglutinante de bentonita para gato con sello de olor',
    description: [
      'America Litter Ultra Odor Seal es una arena sanitaria de bentonita sódica de grano fino que forma bolitas firmes al contacto con la orina. Así puedes retirar solo la parte usada con la pala y el resto del arenero permanece limpio y seco por más tiempo, lo que se traduce en menos cambios completos y mayor rendimiento por bolsa.',
      'Su tecnología de sellado atrapa el amoniaco dentro de cada grumo y neutraliza el olor desde el primer uso, sin necesidad de perfumes fuertes que a muchos gatos les desagradan. El grano fino es suave para las patitas y es el tipo de textura que la mayoría de los gatos acepta sin problema.',
      'Es apta para gatitos, adultos y gatos sénior, y funciona en areneros abiertos o cubiertos. La bolsa de 7 kg rinde aproximadamente un mes para un gato; la de 15 kg es la más conveniente para hogares con dos o más gatos.',
      'Modo de uso: llena el arenero con una capa de 7 a 10 cm. Retira los grumos y las heces a diario y añade arena nueva para mantener el nivel. Cambia todo el contenido y lava el arenero cada 3 a 4 semanas. No la tires al inodoro; deséchala con la basura.',
    ].join('\n\n'),
    values: [
      many('animal.target', ['ani.dom.cat']),
      many('life.stage', [
        'life.cat.kitten',
        'life.cat.adult',
        'life.cat.senior',
      ]),
      one('hygiene.type', 'hygiene.type.litter'),
      one('hygiene.form', 'hygiene.form.granule'),
      many('hygiene.litter', ['hygiene.litter.bentonite']),
      one('hygiene.scent', 'hygiene.scent.unscented'),
      one('pack.form', 'pack.form.bag'),
      one('pack.sale', 'pack.sale.single'),
      one('content.kind', 'content.kind.mass'),
      text(
        'text.manufacturer_care',
        'Guardar la bolsa cerrada en un lugar seco. No desechar en el inodoro.',
      ),
      text(
        'text.instructions',
        'Llena el arenero con 7 a 10 cm de arena, retira los grumos a diario, rellena el nivel y cambia todo el contenido cada 3 a 4 semanas.',
      ),
    ],
    declarations: [
      fact('consumable', true, 'La arena se consume y se repone con el uso.'),
      fact(
        'animalApplied',
        true,
        'El empaque indica que el producto es para gatos.',
      ),
      fact(
        'contentMagnitude',
        'mass',
        'El contenido se declara en kilogramos.',
      ),
    ],
    variants: presentations.map((p) => ({
      key: p.key,
      presentation: p.name,
      values: [num('measure.net_mass', p.mass, 'kg')],
    })),
  }),
};
