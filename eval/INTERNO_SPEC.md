# INTERNO_SPEC: Gold 200, underexposed 1.5-2.5 EV, indoor 3200-3500 K, Frontier AutoSetup default
Neutral ramp in L*a*b* D50, final scan (sRGB-ish, post-AutoSetup). ev = scene EV vs mid grey (18%).
"Normal" = same stock, correctly exposed, same lab, from eval/gold200_spec.json (itself an expert prior).
Confidence: H = datasheet/many consistent reports; M = several consistent anecdotes + physics; L = few/conflicting; VL = inferred.
EVIDENCE WARNING: Kodak PDF, Dehancer and image hosts were unreachable by fetch; only search snippets, forum summaries
and the repo spec were available. No measured Lab ramp of underexposed Gold 200 scans was found. All numbers are
ranges of plausibility, not measurements. Ranges below are deliberately wide; widen further if a real sample disagrees.
## 1. Grey ramp (L* ranges; a*/b* ranges in section 4/5 apply on top)
| ev | L* normal | L* interno | conf |
|----|-----------|-----------|------|
| -4 | 2-12 | 7-20 | L |
| -3 | 7-17 | 10-24 | L |
| -2 | 16-26 | 17-31 | L-M |
| -1 | 31-41 | 29-43 | M |
|  0 | 49-59 | 42-58 | M (AutoSetup lifts mid back up; residual dim 0-12 L*) |
| +1 | 66-76 | 57-72 | M |
| +2 | 80-88 | 69-84 | M-L |
Monotonic non-decreasing is mandatory. Highlights lose 4-12 L* at +2 (thin negative cannot reach white; no shoulder clipping).
## 2. Black level (L* of deepest shadow, ev -4 or below)
Range 8-20, centre ~12 (normal 3-14). Milky = floor lifted, not a flat grey: expect 5-12 L* higher than normal.
Confidence L-M. Basis: thin negative sits at base+fog density, AutoSetup lifts density 1.5-2.5 EV, scanner cannot go below Dmin
(Kodak E-7022 toe, qualitative only); Frontier reputed for a "deep black point" (substack Frontier vs Noritsu), which may
cap the milkiness at the low end (L* 8-10) for gentle cases. Use the full 8-20.
## 3. Shadow contrast dL*/dEV over -4..-2 (normal: 4-9.5 L*/EV)
Interno: 2.5-6.5 L*/EV, i.e. 0.4-0.8 of normal. Mid slope (-1..+1) 11-19 L*/EV (0.8-1.0 of normal, normal 14.5-20).
Toe-to-mid slope ratio is the signature: interno shadow/mid ratio 0.2-0.45 versus normal 0.3-0.5 (overlap; do not gate on it alone).
Confidence M for direction (compressed toe, flatter shadows: E-7022 toe + "contrast ... visible grain increase" in Dehancer snippets),
L for magnitudes. Contradiction to note: some reports say contrast looks higher because AutoSetup stretches; we weight the lifted-flat view.
## 4. Shadow hue/chroma (crossover) at ev -4..-2
Direction: green-to-cyan-teal most probable (a* negative, b* ~0 to slightly negative); alternatives magenta or brown/olive
(a* positive, b* positive) cannot be excluded: sources conflict (forum reports blue-green on Frontier scans, Fuji bias, a
green-cast theory from a thin-negative scanner-noise thread; "colors become noticeably unbalanced" under -1 EV per Dehancer snippet, no direction given).
Ranges at ev -3: a* -7..+1 (centre -2.5), b* -7..+5 (centre -1); chroma C*ab 2-9, centre ~4.5. Normal: |a*|<=3.8, |b*|<=7.
Hard criterion: shadow chroma <= 10 and hue drift vs mid grey within ±45 degrees of green/cyan (hue ~160-230) as "typical";
anything else is "atypical but allowed". Confidence: direction L (about 50-60 percent green/cyan), magnitude L-M.
## 5. Residual warm cast in the mids (ev -1..+1) after AutoSetup, ~3200-3500 K
a* +0.5..+6 (centre +2.5), b* +4..+17 (centre +9). Normal frame at ev 0: a* -1.5..3.5, b* -1..9. So extra b* of +0..+9.
Uncorrected tungsten on daylight film is ~b* +25..+40 (Kodak rates Gold 200 at ISO 50 with an 80A under 3200 K), so AutoSetup removes
roughly 50-80 percent; Frontier correction is partial and scene-dependent (warm-dominated rooms keep more).
Cast is weaker in shadows (b* shrinks toward 0 or negative at -4) and strongest at ev 0..+2. Confidence M for sign (warm), L for size.
## 6. Saturation drop
Mean chroma ratio versus normal (CC24 mean, normal target 0.98-1.14): 0.65-0.92, centre ~0.80; red/yellow channels
fall less (0.75-1.0), blue/green more (0.55-0.90). Confidence L-M (Dehancer and Photrio: "saturation/contrast trade-off", no numbers).
## 7. Grain visibility
Perceived grain amplitude x1.3-2.4 versus normal in mids; x1.5-3 in shadows (< ev -2); chroma-grain share rises.
Anchor: repo model 2^(0.5U) = 1.41-2.38 for U=1-2.5. Gold 200 base grain is fine; Frontier default sharpening/noise suppression is
mild so grain remains visible. Confidence M for direction (many reports), L for factor.
## Pass rule (suggested)
Score each trait in-range (1), within 25 percent of range width outside (0.5), else 0. Report unweighted mean; flag any VL/L trait
failures as "informational" not "fail" until a real scan ramp is measured.
## Sources
- Kodak E-7022 Gold 200 tech sheet (latitude -2/+3, 80A at 3200 K, toe qualitative): kodakprofessional.com/.../E7022%20Gold%20tech%20sheet.pdf (via search snippet only)
- Dehancer, Films at different exposures: Kodak Gold 200: dehancer.com/learn/articles/how-films-behave-at-different-exposures-kodak-gold-200 (snippet)
- The Art of Film Scanning: Frontier vs. Noritsu: jbflanc.substack.com/p/the-art-of-film-scanning-frontier (snippet)
- Photrio threads (photrio.com/forum/posts/2970001, 2970548); FredMiranda 1942522; l-camera-forum Ektar thin-negative green cast (other film, weak)
- Repo priors: eval/gold200_spec.json, eval/INTERNO.md. Numbers are expert estimates, not measurements.
