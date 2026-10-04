// Colour constants shared by decoding (common.js) and the lens stage (lens.js).

export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export const linearToSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);

/** 8-bit sRGB / Display P3 code value → linear light. */
export const LIN8 = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));

// Linear Display P3 → linear Rec.2020 (both D65), derived from the primaries.
export const P3_TO_REC2020 = [
  [0.75383303, 0.19859737, 0.0475696],
  [0.04574385, 0.94177722, 0.01247893],
  [-0.00121034, 0.01760172, 0.98360862],
];

// Linear Rec.2020 → linear Display P3 (the film chain's output space → the screen's).
export const REC2020_TO_P3 = [
  [1.3435783, -0.2821797, -0.0613986],
  [-0.0652975, 1.0757879, -0.0104905],
  [0.0028218, -0.0195985, 1.0167767],
];
