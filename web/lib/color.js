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
