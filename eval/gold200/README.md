# Real Gold 200 reference (v4)

Data: [gold200-dataset](https://github.com/DhaliwalX/gold200-dataset) (CC BY-SA 4.0, release v1.0, 555 MB; not in this
repo). Three scenes shot on Kodak Gold 200 and on a Sony A7C II from about the same spot (handheld: framing and viewpoint
differ a little); the developed film scanned with the same camera over an RGB LED panel, one raw per LED (625 / 522 /
455 nm ±5), plus clear-base shots for the flat field. A narrowband RGB scan has no scanner look: it is the film's own
record, the reference for v4's neutral Gold 200.

    unzip gold200-dataset-*.zip -d DATA
    python3 eval/gold200/arw2dng.py DATA/.../digital/frame13-UPS02715.ARW WORK/frame13.dng   # and 17 (UPS02735), 18 (UPS02736)
    python3 eval/gold200/film_scan.py DATA/gold200-dataset-2026-10-14 WORK                    # WORK/T13.npy, T17, T18
    python3 eval/gold200/compare.py WORK                                                       # v4 vs film, WORK/compare.jpg

Needs `pip install rawpy` (LibRaw) for the ARW files. Results and what they changed: eval/V4.md.

## Other references (searched 2026-10-20; links not all verified, several hosts unreachable from the build box)
Nothing else public is a narrowband raw scan with digital pairs, a raw ColorChecker / step wedge on Gold 200, or measured
Status M densities; every "Gold 200 curve" online is a re-trace of Kodak E-7022. Leads, most useful first:
- pixls Play Raw "negadoctor snowy day" (Gold 200 NEF camera scans + an unexposed frame; white light, no pair):
  discuss.pixls.us/t/negadoctor-snowy-day/48581 — global checks only (mask, density range, toe).
- Photrio "Lucky C200 vs Kodak Gold 200 in 120" (raw uninverted scans of the same scenes, but normalised): comparison only.
- github.com/Entropy512/rgb_led_filmscan: an independent WebPlotDigitizer trace of E-7022 (density + sensitivity CSVs) and a
  per-channel exponent fit script: a check on our profile's red vs green mid curve (the open question in eval/V4.md).
- rom9's ColorPlus 200 step gradient (RawTherapee thread, discuss.pixls.us/t/any-interest-in-a-film-negative-feature-in-rt/12569):
  the only measured per-channel curve found, on the sibling stock.
- Unpublished, worth asking: Alchemy Color's ColorChecker SG raw on Gold 200; more frames of the gold200 dataset's roll.
What would settle the red-curve question: a Gold 200 roll with a ColorChecker + grey card, bracketed -3..+4 EV on a tripod next
to a digital camera, scanned like the gold200 dataset (one raw per LED + clear base).
