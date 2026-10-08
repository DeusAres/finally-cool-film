# Frontier SP-3000 negative-to-positive model

HONESTY NOTE: I could not obtain any measured SP-3000 data. Searches found no public Fuji spectral or processing documentation; direct page fetches (Schlueter blog, Harman Phoenix PDF, Optik blog) failed with network errors, so their content was NOT read. Almost everything below is inferred or guessed. Tags: documented / measured / inferred / guessed. Parameters live in `frontier_model.json`.

## Sources actually seen (search snippets only)
- Fujifilm SP500 spec page (LED light source, area CCD with pixel shifting): https://www.fujifilm.com/us/en/business/photofinishing/digital-lab-solutions/frontier-sp500/specifications (documented for SP500; SP-3000 same family, inferred)
- Generic patents on film-type detection / density tables per RGB: US7149004, US7164511, US6714324, US5041866 (generic, not tied to SP-3000)
- Fuji LED current balancing per colour (patent snippet, unverified for SP-3000)
- Photrio SP3000 threads; Harman Phoenix doc: workflow "scan as reversal, invert later" (indicates film-type setting changes processing)

## Pipeline
1. Light + sensor: LED RGB illumination, area CCD. Proxy = Status M-like Gaussians: R 650/45, G 545/50, B 445/50 nm (peak/FWHM). Arrays 380-780 @5 nm in JSON. Guessed; low confidence. Real LED peaks and CCD response unknown.
2. Density: T_c = integral(Tfilm*S_c)/integral(S_c); D_c=-log10 T_c; subtract per-channel Dmin from unexposed rebate (inferred, medium confidence; floor Tmin 0.0005).
3. Film-type setup: D'_c = slope_c*Dn_c + offset_c, fitted on a grey ramp so grey is neutral at mid-scale (G slope=1). Real machines likely use per-channel LUTs per stock, so neutral along the scale is plausible but unconfirmed. Defaults are identity; fit per stock in the simulator.
4. AutoSetup (guessed structure): masked, trimmed-mean large-area transmission density per channel (LATD); colour shift = k_col*(ref - LATD_c), density shift = k_den*(target - mean_G); clamps 0.30 density / 0.15 colour; global strength 0.7; highlight/shadow percentile (99/1) hooks default off. All numbers guessed.
5. Gradation: normalise x = (D_ref_white - D')/range_density to 0..1 (range about 2.0 logD); sigmoid contrast a=4.2, midpoint 0.5, soft shoulder from y=0.82 (sh=1.6), black 0.02, white 0.98. Nine control points in JSON. Guessed from the commonly described "contrasty, firm blacks" look.
6. Colour: saturation 1.12 about luma, identity matrix, no hue rotation, output sRGB. Guessed. (Frontier look reported as vivid/warm, anecdotal.)
7. User controls (guessed mapping): Density, C, M, Y keys integer steps +-20, about 0.01 logD per key; Contrast and Saturation +-10 steps at 4% each. Real machine has these controls (inferred from general knowledge); units and step sizes unverified.

## Least certain
- LED/CCD spectra (guessed Status M proxy).
- AutoSetup gains and clamps (pure guess).
- Tone curve and saturation (guessed look, not measured).

## Next steps to raise confidence
Scan a Kodak/Fuji IT8 or grey step wedge on a real SP-3000, record raw RGB vs known transmittance; read Fuji service manual / minilabhelp forum.
