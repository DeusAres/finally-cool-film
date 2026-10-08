# Gold 200 / Frontier SP-3000 acceptance spec (gold200_spec.json)

Honesty note: no published numeric Gold 200 ColorChecker scan was found, and the E-7022 curves are graphs only (not machine-read).
All numbers are expert priors from E-7022 qualitative data, Frontier descriptions, Gold-vs-Portra/Ultramax reviews and lab experience.
Tolerances are deliberately wide; do not read them as measurements.

## Grey ramp (tone curve) - confidence: MED shape, LOW absolute level
- Trait: S-curve with Frontier-style deep black point and strong shoulder. 0 EV ~L*54 (+-5), mid slope ~17 L*/EV (higher than plain sRGB ~15), toe slope ~7, shoulder slope ~5, black L* 3-14, white L* 93-99.5.
- Evidence: Frontier described as punchy with deep blacks at the cost of shadow detail (Frontier-vs-Noritsu article); Gold has narrow shadow latitude (-2 EV) and generous highlights (+3 EV) per E-7022 and reviews.
- Absolute mid level depends on AutoSetup density correction: LOW.

## Grey colour cast - confidence: LOW-MED
- Trait: warm mid axis (a* ~+1, b* ~+4..+5), shadows near neutral to slightly cool/cyan-green (b* ~-1..+1), highlights warm (b* ~+4..+5). Cast stability in mids: max deviation 0-4.
- Evidence: Gold reviews report warm yellow bias; Frontier adds warmth. AutoSetup could neutralise a synthetic chart, hence b* range of +-5.

## Skin (patches 1,2) - confidence: MED
- Trait: chroma x1.06-1.10, hue shifted +3..+4 deg toward golden-yellow; lightened slightly vs neutral curve. Skin hue mean 43-54 deg.
- Evidence: "golden" skin on Frontier; Gold has "good skin tones", more saturated than Portra. Sibling-stock evidence (Portra comparison) widens the range.

## Reds / oranges / yellows (7, 9, 12, 15, 16) - confidence: MED
- Trait: chroma x1.10-1.15, reds drift toward orange (+4..+5 deg), yellows slightly toward orange-gold (-3 deg).
- Evidence: reviews cite punchy reds and "yellows shining"; Frontier amplifies saturation. Magnitudes are priors: widest tolerance on ratio (+-0.12).

## Greens / foliage (4, 11, 14, 6) - confidence: LOW-MED
- Trait: greens warmed toward yellow (-8 deg), chroma ~1.0 (green patch 14 slightly below 1), foliage hue 102-118 deg.
- Evidence: "blues and greens become slightly warmer" (reviews); Gold greens are typically yellowish rather than emerald. No measurement.

## Blues / sky (3, 5, 8, 13, 18) - confidence: LOW
- Trait: sky slightly less saturated (x0.95) and shifted toward cyan/teal (-6 deg, hue 245-262); blue patches x0.98, purple-blues less purple.
- Evidence: anecdotal "teal-ish skies on Frontier scans"; Gold's blue layer bias. Treat as weak; tolerances wide (tol 11).

## Purples / magentas (10, 17) - confidence: LOW
- Trait: near-neutral chroma change, magenta nudged toward red (+5 deg). Pure prior.

## Global metrics
- mean_chroma_ratio 0.98-1.14 (Gold above Portra, below Ultramax; MED). Slope/black/white ranges follow the grey block.

## Weights: grey 0.35, cc24 0.40, global 0.25.

## Five traits a viewer notices first
1. Overall warm/golden cast: yellow-ish mid-greys and skin.
2. Punchy contrast with deep blacks and hard-ish shoulder (Frontier gradation).
3. Saturated warm colours: red, orange, yellow pop (chroma ~x1.1-1.15).
4. Greens shifted yellow, not emerald; muted, slightly teal skies.
5. Golden-leaning (not pink) skin tones, quick shadow falloff.

## Sources
- Kodak E-7022 tech sheet: https://www.kodakprofessional.com/sites/default/files/wysiwyg/pro/resources/E7022%20Gold%20tech%20sheet.pdf
- https://jbflanc.substack.com/p/the-art-of-film-scanning-frontier
- https://50mmf2.com/writings/kodak-gold-200-review
- https://analoguewonderland.co.uk/blogs/film-photography-blog/kodak-ultramax-vs-kodak-gold
- ColorChecker D50 Lab: BabelColor / X-Rite (post-2014).
