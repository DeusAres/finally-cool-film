import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
from appconst import app_const   # the app's constants (web/app.js), read, not copied
def params(settings=None, scanner=None, **film):
    p = {"settings": {"use_enlarger_lut": True, "use_scanner_lut": True},
         "io": {"input_color_space": "ITU-R BT.2020", "input_cctf_decoding": False, "output_color_space": "ITU-R BT.2020",
                "output_gamut_compress": {"algorithm": "off"}, "scan_film": True},
         "camera": {"auto_exposure": False, "film_format_mm": 35},
         "scanner": {"model": "narrowband", "narrowband": app_const('NARROWBAND'), "unsharp_mask": [0, 0]},
         "film_render": {"grain": {"active": False}, "dir_couplers": app_const('V4_DIR'),
                        "halation": {"active": True, "halation_amount": app_const('V4_FILM')['halation'], "scatter_spatial_scale": app_const('SCATTER_SCALE')},
                        **app_const('V4_STOCK')['film_render']}}
    for k, v in film.items(): p["film_render"][k] = v
    p["settings"].update(settings or {})
    p["scanner"].update(scanner or {})
    return p
if __name__ == '__main__':
    json.dump(params(**json.loads(sys.argv[2] if len(sys.argv) > 2 else '{}')), open(sys.argv[1], 'w'))
