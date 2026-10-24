"""Constants of web/app.js for the eval scripts (one source of truth: no copies by hand).

app.js is a browser module, so it is not imported: the object literal of `const NAME = ...;` is cut out of the source by
bracket matching and evaluated by node. Only self-contained literals (numbers, strings, arrays, objects) are supported.
    from appconst import app_const
    V4_FRONTIER = app_const('V4_FRONTIER')"""
import json, os, re, subprocess
APP = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web', 'app.js')
_cache = {}
def _literal(src, name):
    m = re.search(rf'^const {name} = ', src, re.M)
    if not m:
        raise KeyError(f'{name}: no "const {name} = " in web/app.js')
    i, depth = m.end(), 0
    for j in range(i, len(src)):
        ch = src[j]
        if ch in '[{(':
            depth += 1
        elif ch in ']})':
            depth -= 1
        elif ch in ';,' and depth == 0:
            return src[i:j]
    raise ValueError(f'{name}: unterminated literal')
def app_const(name):
    if name not in _cache:
        lit = _literal(open(APP).read(), name)
        out = subprocess.run(['node', '-e', f'process.stdout.write(JSON.stringify({lit}))'], capture_output=True, text=True, check=True)
        _cache[name] = json.loads(out.stdout)
    return _cache[name]
