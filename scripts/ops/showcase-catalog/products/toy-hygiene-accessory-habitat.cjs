// Ops › showcase catalog › toys, hygiene, accessories and habitats (L5 shape,
// odd/tasks/prod-showcase-catalog.md). One file per product under
// ./toy-hygiene-accessory-habitat/; image credits are listed in
// docs/ops/showcase-catalog-credits-toy-hygiene-accessory-habitat.md.
'use strict';

const PRODUCTS = [
  '01-kong-classic',
  '02-chuckit-ultra-ball',
  '03-lamb-chop-plush',
  '04-cat-feather-wand',
  '05-dog-brick-puzzle',
  '06-tropiclean-shampoo',
  '07-america-litter',
  '08-fancy-pets-pads',
  '09-earth-rated-bags',
  '10-petkin-dental-wipes',
  '11-ruffwear-collar',
  '12-julius-k9-harness',
  '13-flexi-leash',
  '14-sheri-calming-bed',
  '15-petmate-steel-bowl',
  '16-petmate-vari-kennel',
  '17-aqueon-aquarium-kit',
  '18-vision-bird-cage',
  '19-exo-terra-terrarium',
];

module.exports = PRODUCTS.map((file) =>
  require(`./toy-hygiene-accessory-habitat/${file}.cjs`),
);
