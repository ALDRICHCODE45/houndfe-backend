// Ops › showcase catalog › product data (contract: engine/core.cjs header and
// odd/tasks/prod-showcase-catalog.md L5). Concatenates the content files that
// exist; a missing file contributes nothing.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PARTS = ['./food-treat-care.cjs', './toy-hygiene-accessory-habitat.cjs'];

module.exports = PARTS.flatMap((part) =>
  fs.existsSync(path.join(__dirname, part)) ? require(part) : [],
);
