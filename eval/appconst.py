"""Constants of the app for the eval scripts (one source of truth: no copies by hand).

The look's tuned constants live in web/lib/look.js (since 4.45), a plain ES module: node imports it and prints the export.
Others are still in web/app.js, a browser module that cannot be imported: there the object literal of `const NAME = ...;` is cut
out of the source by bracket matching and evaluated by node (only self-contained literals: numbers, strings, arrays, objects).
    from appconst import app_const
    V4_FRONTIER = app_const('V4_FRONTIER')"""
import json, os, re, subprocess
WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web')
APP, LOOK = os.path.join(WEB, 'app.js'), os.path.join(WEB, 'lib', 'look.js')
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
        look = subprocess.run(['node', '--input-type=module', '-e', f'import * as m from {json.dumps("file://" + os.path.abspath(LOOK))};'
                               f' if ({json.dumps(name)} in m) process.stdout.write(JSON.stringify(m[{json.dumps(name)}]));'],
                              capture_output=True, text=True, check=True).stdout
        if not look:
            look = subprocess.run(['node', '-e', f'process.stdout.write(JSON.stringify({_literal(open(APP).read(), name)}))'],
                                  capture_output=True, text=True, check=True).stdout
        _cache[name] = json.loads(look)
    return _cache[name]
