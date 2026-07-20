/**
 * Jest mock for `yoga-layout` — used by WU2 snapshot tests.
 *
 * Why this exists:
 * `yoga-layout` v3.x is shipped as ESM-only and uses `import.meta.url`
 * to resolve its embedded WASM binary (see
 * `node_modules/yoga-layout/dist/binaries/yoga-wasm-base64-esm.js`).
 * Jest's CommonJS runtime cannot resolve `import.meta`, so any test
 * that ends up transitively requiring `@react-pdf/layout` (which
 * imports `yoga-layout/load`) fails at module load with
 * "Cannot use 'import.meta' outside a module".
 *
 * The mock exposes a Yoga-shaped object whose methods return safe
 * zero/identity values. Layout numbers won't match the real
 * engine, but:
 *   - The PDF binary is still a valid PDF (@react-pdf/renderer
 *     emits the structure even with zero-dimensioned layout
 *     output).
 *   - Snapshot tests assert `%PDF` magic bytes + non-empty buffer,
 *     NOT visual layout — so layout fidelity is out of scope for
 *     WU2's contract.
 *
 * Visual / runtime fidelity belongs to WU4 (`PdfGenerationService`
 * hits the real yoga-layout when running under Node) and WU5
 * (integration tests with the full dependency tree under NestJS).
 *
 * Mapped via `jest.config.js` → `moduleNameMapper['^yoga-layout$']`
 * and `^yoga-layout/load$`.
 *
 * Enum values are copied verbatim from
 * `node_modules/yoga-layout/dist/src/generated/YGEnums.js`
 * (the @generated file in the real package). Names matter: many
 * `@react-pdf/layout` paths read `Yoga.Align.FlexStart`,
 * `Yoga.Justify.SpaceBetween`, etc. — so the namespace objects
 * must exist on `Yoga` and contain the right values.
 */

'use strict';

const Align = /*#__PURE__*/ (() => {
  const o = {};
  o[o['Auto'] = 0] = 'Auto';
  o[o['FlexStart'] = 1] = 'FlexStart';
  o[o['Center'] = 2] = 'Center';
  o[o['FlexEnd'] = 3] = 'FlexEnd';
  o[o['Stretch'] = 4] = 'Stretch';
  o[o['Baseline'] = 5] = 'Baseline';
  o[o['SpaceBetween'] = 6] = 'SpaceBetween';
  o[o['SpaceAround'] = 7] = 'SpaceAround';
  o[o['SpaceEvenly'] = 8] = 'SpaceEvenly';
  return o;
})();

const Direction = /*#__PURE__*/ (() => {
  const o = {};
  o[o['Inherit'] = 0] = 'Inherit';
  o[o['LTR'] = 1] = 'LTR';
  o[o['RTL'] = 2] = 'RTL';
  return o;
})();

const Display = /*#__PURE__*/ (() => {
  const o = {};
  o[o['Flex'] = 0] = 'Flex';
  o[o['None'] = 1] = 'None';
  o[o['Contents'] = 2] = 'Contents';
  return o;
})();

const Edge = /*#__PURE__*/ (() => {
  const o = {};
  o[o['Left'] = 0] = 'Left';
  o[o['Top'] = 1] = 'Top';
  o[o['Right'] = 2] = 'Right';
  o[o['Bottom'] = 3] = 'Bottom';
  o[o['Start'] = 4] = 'Start';
  o[o['End'] = 5] = 'End';
  o[o['Horizontal'] = 6] = 'Horizontal';
  o[o['Vertical'] = 7] = 'Vertical';
  o[o['All'] = 8] = 'All';
  return o;
})();

const FlexDirection = /*#__PURE__*/ (() => {
  const o = {};
  o[o['Column'] = 0] = 'Column';
  o[o['ColumnReverse'] = 1] = 'ColumnReverse';
  o[o['Row'] = 2] = 'Row';
  o[o['RowReverse'] = 3] = 'RowReverse';
  return o;
})();

const Gutter = /*#__PURE__*/ (() => {
  const o = {};
  o[o['Column'] = 0] = 'Column';
  o[o['Row'] = 1] = 'Row';
  o[o['All'] = 2] = 'All';
  return o;
})();

const Justify = /*#__PURE__*/ (() => {
  const o = {};
  o[o['FlexStart'] = 0] = 'FlexStart';
  o[o['Center'] = 1] = 'Center';
  o[o['FlexEnd'] = 2] = 'FlexEnd';
  o[o['SpaceBetween'] = 3] = 'SpaceBetween';
  o[o['SpaceAround'] = 4] = 'SpaceAround';
  o[o['SpaceEvenly'] = 5] = 'SpaceEvenly';
  return o;
})();

const MeasureMode = /*#__PURE__*/ (() => {
  const o = {};
  o[o['Undefined'] = 0] = 'Undefined';
  o[o['Exactly'] = 1] = 'Exactly';
  o[o['AtMost'] = 2] = 'AtMost';
  return o;
})();

const Overflow = /*#__PURE__*/ (() => {
  const o = {};
  o[o['Visible'] = 0] = 'Visible';
  o[o['Hidden'] = 1] = 'Hidden';
  o[o['Scroll'] = 2] = 'Scroll';
  return o;
})();

const PositionType = /*#__PURE__*/ (() => {
  const o = {};
  o[o['Static'] = 0] = 'Static';
  o[o['Relative'] = 1] = 'Relative';
  o[o['Absolute'] = 2] = 'Absolute';
  return o;
})();

const Wrap = /*#__PURE__*/ (() => {
  const o = {};
  o[o['NoWrap'] = 0] = 'NoWrap';
  o[o['Wrap'] = 1] = 'Wrap';
  o[o['WrapReverse'] = 2] = 'WrapReverse';
  return o;
})();

const Unit = /*#__PURE__*/ (() => {
  const o = {};
  o[o['Undefined'] = 0] = 'Undefined';
  o[o['Point'] = 1] = 'Point';
  o[o['Percent'] = 2] = 'Percent';
  o[o['Auto'] = 3] = 'Auto';
  return o;
})();

/**
 * YogaNode — minimal stub. The real Yoga node has ~80 methods. We
 * implement only the ones `@react-pdf/layout` actually invokes on
 * the synchronous render path. Anything else is a no-op.
 */
class YogaNode {
  constructor() {
    this._children = [];
    this._parent = null;
  }

  // Tree ops
  insertChild(child, index) {
    if (index == null || index >= this._children.length) {
      this._children.push(child);
    } else {
      this._children.splice(index, 0, child);
    }
    child._parent = this;
  }
  removeChild(child) {
    const idx = this._children.indexOf(child);
    if (idx >= 0) {
      this._children.splice(idx, 1);
      child._parent = null;
    }
  }
  getChildCount() {
    return this._children.length;
  }
  getParent() {
    return this._parent;
  }
  getChild(idx) {
    return this._children[idx];
  }
  forEachChild(fn) {
    this._children.forEach(fn);
  }

  // Computed-layout reads — return zeros; @react-pdf falls back
  // to author-provided dimensions when these are 0.
  getComputedLeft() {
    return 0;
  }
  getComputedRight() {
    return 0;
  }
  getComputedTop() {
    return 0;
  }
  getComputedBottom() {
    return 0;
  }
  getComputedWidth() {
    return 0;
  }
  getComputedHeight() {
    return 0;
  }
  getComputedPadding(_edge) {
    return 0;
  }
  getComputedMargin(_edge) {
    return 0;
  }
  getComputedBorder(_edge) {
    return 0;
  }

  // Layout input setters — accept (value) or (value, unit). Real
  // engine has split methods per unit; we collapse to one no-op.
  setPosition() {}
  setPositionPercent() {}
  setMargin() {}
  setMarginPercent() {}
  setMarginAuto() {}
  setPadding() {}
  setPaddingPercent() {}
  setBorder() {}
  setWidth() {}
  setWidthPercent() {}
  setWidthAuto() {}
  setHeight() {}
  setHeightPercent() {}
  setHeightAuto() {}
  setMinWidth() {}
  setMinWidthPercent() {}
  setMinHeight() {}
  setMinHeightPercent() {}
  setMaxWidth() {}
  setMaxWidthPercent() {}
  setMaxHeight() {}
  setMaxHeightPercent() {}
  setFlexBasis() {}
  setFlexBasisPercent() {}
  setFlexBasisAuto() {}
  setFlex() {}
  setFlexGrow() {}
  setFlexShrink() {}
  setFlexDirection() {}
  setFlexWrap() {}
  setJustifyContent() {}
  setAlignItems() {}
  setAlignSelf() {}
  setAlignContent() {}
  setAspectRatio() {}
  setPositionType() {}
  setOverflow() {}
  setDisplay() {}
  setGap() {}
  setGapRow() {}
  setGapColumn() {}
  setDirection() {}

  // Measure / dirtied callbacks — accept and discard.
  setMeasureFunc(_fn) {}
  unsetMeasureFunc() {}
  setDirtiedFunc(_fn) {}

  // Lifecycle — no-op (real engine frees WASM-allocated memory).
  free() {}
  freeRecursive() {}
  markDirty() {}

  // Calculate layout — no-op; computed reads already return zeros.
  calculateLayout(
    _width = NaN,
    _height = NaN,
    _direction = Direction.LTR,
  ) {}
}

class YogaConfig {
  static create() {
    return new YogaConfig();
  }
  static destroy(_config) {}
  setExperimentalFeatureEnabled(_name, _enabled) {}
  setPointScaleFactor(_factor) {}
  setUseWebDefaults(_use) {}
  free() {
    YogaConfig.destroy(this);
  }
}

/**
 * YogaNode static factory methods.
 *
 * The real yoga-layout exposes three static factories on `Node`:
 *   - `Node.createDefault()` — bare node with default config.
 *   - `Node.createWithConfig(config)` — node bound to a config.
 *   - `Node.create(config?)` — dispatcher that picks one of the
 *     above based on whether `config` is supplied.
 *
 * `@react-pdf/layout` calls `create(config?)` directly, so all
 * three must exist (and the dispatcher must call the right one).
 */
Object.assign(YogaNode, {
  createDefault() {
    return new YogaNode();
  },
  createWithConfig(_config) {
    // The mock ignores the config — there are no scale factors
    // or experimental features that affect layout in our snapshot
    // tests. Returning a fresh node is enough.
    return new YogaNode();
  },
  create(config) {
    return config ? YogaNode.createWithConfig(config) : YogaNode.createDefault();
  },
  destroy(_node) {
    // No-op: our mock has no WASM-allocated memory to free.
  },
});

/**
 * `Yoga` namespace object — mirrors the shape that
 * `import * as Yoga from 'yoga-layout'` (and the post-load default
 * export) exposes. Must include BOTH:
 *   - Namespace objects (`Yoga.Align`, `Yoga.Wrap`, etc.) — used by
 *     `@react-pdf/layout` for `Yoga.Align.FlexStart`-style reads.
 *   - Flat enum values (`Yoga.FlexStart`, `Yoga.LTR`, etc.) — used
 *     by some callers; harmless to expose alongside.
 */
const Yoga = {
  Config: YogaConfig,
  Node: YogaNode,
  Align,
  Direction,
  Display,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Overflow,
  PositionType,
  Wrap,
  Unit,
  // Flat enum spread for callers that read `Yoga.Hidden` etc.
  ...Align,
  ...Direction,
  ...Display,
  ...Edge,
  ...FlexDirection,
  ...Gutter,
  ...Justify,
  ...MeasureMode,
  ...Overflow,
  ...PositionType,
  ...Wrap,
  ...Unit,
};

/**
 * Async loader — `loadYoga()` is awaited by @react-pdf/layout at
 * first render. Returning a resolved promise is enough because the
 * mock Yoga instance has zero state to initialize.
 */
const loadYoga = async () => Yoga;

module.exports = Yoga;
module.exports.loadYoga = loadYoga;
module.exports.default = Yoga;