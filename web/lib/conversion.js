// Conversione su pellicola (v4): where this frame's light would have landed on a Gold 200 negative.
//
// The phone exposed for its own sensor (bright lens, stabiliser, multi-frame merge) and the DNG says how much
// light there was: EV100 of the scene from ExposureTime / FNumber / ISO, minus BaselineExposure (the DNG's own
// "show me this much brighter": the phone held back that much to protect the highlights). A film camera could not
// adapt the way a phone does: the negative gets the light its fixed aperture and shutter let through, so it is
// thin indoors and dense in the sun. The lab then prints it back to a normal brightness (engine
// `enlarger.print_exposure_compensation`), so what changes is the negative: grain, colour, toe and shoulder.
//
// No DOM: used by app.js and by the eval scripts.

export const FILM_ISO = 200;   // Kodak Gold 200, box speed

// The camera that "took" the frame (user choice, v4): a single-use camera. Typical spec of the class (Kodak FunSaver
// and similar): f/10, about 1/125 s, no exposure control. Unverified per model; the exact values move every frame by
// the same amount.
export const CAMERA = { fNumber: 10, shutter: 1 / 125 };

// Clamp of the film exposure offset in stops: beyond -6 the negative is base + fog, beyond +5 the scene is past
// Gold's useful latitude (Kodak E-7022 gives -2 / +3 for good results; the clamp only guards absurd EXIF).
const MIN_EV = -6, MAX_EV = 5;

/** Scene EV100 from a raw's shot data ({ exposureTime s, fNumber, iso, baseline EV }), or null when it is missing. */
export function sceneEv100({ exposureTime, fNumber, iso, baseline = 0 } = {}) {
  if (!(exposureTime > 0 && fNumber > 0 && iso > 0)) return null;
  return Math.log2((fNumber * fNumber) / exposureTime) - Math.log2(iso / 100) - baseline;
}

/** EV100 a camera needs to expose FILM_ISO film correctly. */
export const cameraEv100 = (camera = CAMERA) => Math.log2((camera.fNumber ** 2) / camera.shutter) - Math.log2(FILM_ISO / 100);

/**
 * Film exposure offset in stops (negative = thin, positive = dense) for a raw's shot data; 0 when the data is
 * missing (JPEGs and raws without EXIF are exposed "as metered").
 */
export function filmExposureEv(shot, camera = CAMERA) {
  const scene = sceneEv100(shot);
  if (scene === null) return 0;
  return Math.max(MIN_EV, Math.min(MAX_EV, scene - cameraEv100(camera)));
}
