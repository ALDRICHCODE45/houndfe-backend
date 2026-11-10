'use strict';
const {
  bool,
  editorial,
  fact,
  image,
  many,
  num,
  one,
  range,
  text,
} = require('./shared.cjs');

module.exports = {
  key: 'aqueon-led-aquarium-kit',
  name: 'Aqueon kit de acuario LED 37.8 l (10 galones) con filtro y calentador',
  sku: 'SC-HAB-001',
  category: 'Acuarios',
  brand: 'Aqueon',
  description:
    'Acuario de vidrio de 37.8 l con tapa LED, filtro QuietFlow, calentador preajustado y termómetro.',
  price: 2499,
  mayoreo: 2185,
  cost: 1480,
  stock: 3,
  packaging: { weightG: 9500, lengthCm: 56, widthCm: 31, heightCm: 38 },
  images: [
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2d/The_fish_tank_as_environment_for_freshwater_goldfish.jpg/1280px-The_fish_tank_as_environment_for_freshwater_goldfish.jpg',
      'AJ Gray / Wikimedia Commons',
      'CC0',
      'https://commons.wikimedia.org/wiki/File:The_fish_tank_as_environment_for_freshwater_goldfish.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9f/12-Liter-Aquarium.jpg/1280px-12-Liter-Aquarium.jpg',
      'VivienneHarper / Wikimedia Commons',
      'CC BY-SA 3.0',
      'https://commons.wikimedia.org/wiki/File:12-Liter-Aquarium.jpg',
    ),
    image(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/63/Aquarium-Tank.jpg/1280px-Aquarium-Tank.jpg',
      'JohnstonDJ / Wikimedia Commons',
      'CC BY-SA 3.0',
      'https://commons.wikimedia.org/wiki/File:Aquarium-Tank.jpg',
    ),
  ],
  editorial: editorial({
    familyCode: 'habitat',
    commercialTitle:
      'Kit de acuario Aqueon LED de 37.8 litros: vidrio, tapa con luz LED, filtro y calentador incluidos',
    description: [
      'El kit de acuario LED de Aqueon reúne en una sola caja todo lo que necesitas para empezar con peces tropicales de agua dulce. Incluye el acuario de vidrio de 37.8 litros (10 galones), tapa de perfil bajo con iluminación LED de luz blanca, filtro de mochila QuietFlow con cartucho, calentador sumergible preajustado, termómetro, red, alimento de muestra y acondicionador de agua.',
      'La iluminación LED consume muy poca energía y realza los colores de los peces y las plantas sin calentar el agua. El filtro QuietFlow trabaja en silencio con filtración mecánica, química y biológica, y su indicador te avisa cuando es momento de cambiar el cartucho. El calentador mantiene el agua entre 25 y 26 °C, la temperatura ideal para la mayoría de los peces tropicales comunitarios.',
      'Con 51 x 27 x 32 cm, cabe en un escritorio o mueble firme y es el tamaño recomendado para principiantes: suficiente volumen para que el agua se mantenga estable, pero fácil de mantener. Es ideal para guppys, platys, mollys, tetras neón, corydoras o un betta con compañeros pacíficos.',
      'Antes de agregar peces, instala el equipo, llena con agua tratada con el acondicionador y deja funcionar el filtro y el calentador al menos 24 horas; introduce los peces de forma gradual. Cambia del 10 al 15 % del agua cada semana y nunca laves el cartucho con agua de la llave. Desconecta el equipo antes de meter las manos al agua.',
    ].join('\n\n'),
    values: [
      many('animal.target', [
        'ani.freshwater.guppy',
        'ani.freshwater.neon_tetra',
        'ani.freshwater_group.platies',
        'ani.freshwater_group.mollies',
        'ani.freshwater_group.corydoras',
        'ani.freshwater_group.bettas',
      ]),
      many('life.stage', ['life.aquatic.juvenile', 'life.aquatic.adult']),
      one('habitat.type', 'habitat.type.aquarium'),
      many('habitat.environment', [
        'habitat.environment.freshwater',
        'habitat.environment.indoor',
      ]),
      many('habitat.component', [
        'habitat.component.filtration',
        'habitat.component.lighting',
        'habitat.component.thermometer',
      ]),
      many('material', ['material.rigid.glass', 'material.rigid.plastic']),
      many('color.base', ['color.base.black', 'color.base.transparent']),
      one('pack.form', 'pack.form.box'),
      one('pack.sale', 'pack.sale.kit'),
      num('measure.dimensions.external_length', 51, 'cm'),
      num('measure.dimensions.external_width', 27, 'cm'),
      num('measure.dimensions.external_height', 32, 'cm'),
      num('measure.capacity.habitat_usable_volume', 37.8, 'l'),
      num('measure.equipment.power', 50, 'W'),
      num('measure.equipment.voltage', 120, 'V'),
      num('measure.equipment.frequency', 60, 'Hz'),
      num('measure.equipment.flow', 280, 'l/h'),
      range('measure.equipment.temperature', 25, 26, '°C'),
      bool('feature.waterproof', true),
      text(
        'text.manufacturer_care',
        'Cambiar del 10 al 15 % del agua cada semana y el cartucho del filtro cada 4 semanas. Limpiar el vidrio con esponja para acuario; no usar detergentes.',
      ),
      text(
        'text.instructions',
        'Instala el equipo, llena con agua tratada y deja funcionar filtro y calentador 24 horas antes de agregar peces. Desconecta el equipo eléctrico antes de meter las manos al agua.',
      ),
    ],
    declarations: [
      fact(
        'relevantDimensionCodes',
        {
          codes: [
            'measure.dimensions.external_length',
            'measure.dimensions.external_width',
            'measure.dimensions.external_height',
          ],
          toyTypes: [],
        },
        'Las medidas exteriores definen dónde se puede colocar el acuario.',
      ),
      fact(
        'relevantCapacityCodes',
        ['measure.capacity.habitat_usable_volume'],
        'El volumen de agua decide cuántos peces puede alojar.',
      ),
      fact(
        'electricalApplies',
        true,
        'Incluye filtro, calentador e iluminación eléctricos.',
      ),
      fact(
        'relevantEquipmentCodes',
        [
          'measure.equipment.power',
          'measure.equipment.voltage',
          'measure.equipment.frequency',
          'measure.equipment.flow',
          'measure.equipment.temperature',
        ],
        'El fabricante declara potencia del calentador, alimentación, caudal del filtro y temperatura.',
      ),
    ],
    presentation: 'Kit de acuario de 37.8 l',
  }),
};
