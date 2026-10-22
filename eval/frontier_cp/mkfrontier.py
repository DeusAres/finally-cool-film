"""web/app.js renderParams for the v4 Frontier at the slider defaults, WITHOUT V4_FRONTIER (the calibration fits that on top of
the v3 model), as sf-eval overrides. By hand: keep in step with app.js."""
import copy
def merge(d, s):
    for k, v in s.items():
        d[k] = merge(d.get(k, {}), v) if isinstance(v, dict) and isinstance(d.get(k), dict) else copy.deepcopy(v)
    return d
BASE = {
    "io": {"output_gamut_compress": {"algorithm": "off"}, "scan_film": True},
    "camera": {"auto_exposure": False, "film_format_mm": 35},
    "scanner": {"model": "frontier", "black_correction": False, "white_correction": False, "unsharp_mask": [0, 0],
                "hyper_tone": {"highlights": 0, "shadows": 0},
                "frontier": {"cmy": [0, 0, 0], "contrast": 0, "highlight": 0, "whites": 0, "black_lift": 0, "debug_contrast_mode": 3,
                             "model": {"saturation": 1.01, "saturation_blue": 0.15, "blue_hue_shift": 17, "green_hue_shift": 24, "saturation_warm": 0,
                                       "warm_hue_shift": 0, "cool_neutral_warm": 1.0, "highlight_neutral": 0.6, "balance_cmy": [0, 0.005, 0.02],
                                       "sensor_peak_nm": [650, 540, 450], "sensor_fwhm_nm": [40, 50, 40], "black_point": 0.012, "gradation_a": 6.2,
                                       "setup_toe_slope": [0.9, 1.0], "setup_neutral_ev": 1.5, "auto": {"k_col": 0.3, "neutral_sigma": 0.06}}}},
    "film_render": {"grain": {"active": False}, "halation": {"active": True, "halation_amount": 1, "scatter_spatial_scale": 0.5},
                    "dir_couplers": {"inhibition_samelayer": 1.0, "inhibition_interlayer": 1.0}, "layer_speed_ev": [0.75, 0, 0]},
}
def params(overrides=None): return merge(copy.deepcopy(BASE), overrides or {})
