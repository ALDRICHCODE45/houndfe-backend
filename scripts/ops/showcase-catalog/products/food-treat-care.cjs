'use strict';
// Showcase products for the food, treat and care editorial families (L5 contract).
module.exports = [
  'food-01',
  'food-02',
  'food-03',
  'food-04',
  'food-05',
  'food-06',
  'food-07',
  'food-08',
  'food-09',
  'treat-01',
  'treat-02',
  'treat-03',
  'treat-04',
  'care-01',
  'care-02',
  'care-03',
  'care-04',
].map((file) => require(`./food-treat-care/${file}.cjs`));
