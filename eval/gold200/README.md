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
