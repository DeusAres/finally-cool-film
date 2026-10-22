"""X-Rite ColorChecker SG reference, Nov 2014+ edition, Lab D50 (zenodo.org/records/3245895)."""
import os, numpy as np
P = os.environ.get('SG_REF', 'ColorCheckerSG_After_Nov2014.txt')   # in the WORK directory, see README
_rows = [l.split('\t') for l in open(P).read().replace('\r', '').split('\nBEGIN_DATA\n')[1].split('\nEND_DATA')[0].strip().splitlines()]
REF = {r[0]: np.array(list(map(float, r[1:4]))) for r in _rows}
