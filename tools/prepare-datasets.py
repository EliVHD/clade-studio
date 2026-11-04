"""Reproduce reviewed tree extraction from locally supplied public downloads.

Usage: python3 tools/prepare-datasets.py /path/to/downloads
Input names: mammals.zip, primates.zip, kew-order.tree, kew-family.tree,
kew-species.tree. Only selected tree bytes are copied; no images/code/alignments.
No network access or external Python packages are used.
"""
import hashlib
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INPUT = Path(sys.argv[1])
OUTPUT = ROOT / 'data' / 'datasets'
OUTPUT.mkdir(parents=True, exist_ok=True)


def checked(data, digest):
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Input does not match the reviewed SHA256')
    return data


for archive, digest, entry, target, expected in [
    ('mammals.zip', 'd19945b1c19d9fa4430a8c132e68cfb512c17f0720dfad90ca8d707a8811a415',
     'Data_S3_globalRAxML_files/RAxML_bipartitions.result_FIN4_raw_rooted_wBoots_4098mam1out_OK.newick',
     'upham-2019.nwk', 'ce83e9ce7d255cd135c678a210bc4da9390c78da67ac46f35f66baa1233c6d4f'),
    ('primates.zip', '039e1c145ac81cba395bc28e0cb952cb9d9613d13eb40a5f2719d48826721633',
     'timetrees/372s-sA-AR-fig.tree', 'dos-reis-2018.nwk',
     '741fdf949b5a339cb9acb381f9277ae05167cd0ba3528ce666e9e15160ae9971'),
]:
    checked((INPUT / archive).read_bytes(), digest)
    with zipfile.ZipFile(INPUT / archive) as z:
        data = z.read(entry)
    if archive == 'primates.zip':
        match = re.fullmatch(rb'#NEXUS\s+BEGIN TREES;\s+UTREE 1 = (.*;)\s+END;\s*', data, re.S)
        if not match:
            raise ValueError('Unexpected NEXUS envelope; refuse to guess an extraction')
        data = match[1] + b'\n'
    (OUTPUT / target).write_bytes(checked(data, expected))

for level, digest in [
    ('order', '4338a16ff2599cad74f0c1be5d9bb1c821b015dbcb42330e3d85d1e1a14adcd0'),
    ('family', '1d520c07218df84df2858e349efc2c6f517253a0c63f2549257e657ccd84176e'),
    ('species', 'ff2cdf88a6f46da1f4155b36a4d9a96a838d415f9d609b8c8a284019f6e11b20'),
]:
    (OUTPUT / ('kew-4-' + level + '.nwk')).write_bytes(checked((INPUT / ('kew-' + level + '.tree')).read_bytes(), digest))
print('Reproduced five reviewed Newick assets. See data/datasets/audit.json for sources and reuse evidence.')
