#!/usr/bin/env python3
"""Keeps the installed Liszt pinned in the Dock, once, and drops pins of any other copy.

A pin is a Liszt one when it has Liszt's bundle id or label, so a stray copy pinned from the build
output or an old checkout goes. The pin of the installed copy stays where it is; with none, one is
added at the end. A pin the Dock does not take for an app (file-type 41) is made again in its place:
the Dock shows the running app beside such a pin instead of on it. The Dock reads the change when
it restarts (killall Dock), which deploy.sh does.
"""
import plistlib
import subprocess
import sys

APP = '/Applications/Liszt.app'
BUNDLE_ID = 'local.liszt.terminal'
URL = 'file://' + APP + '/'

dock = plistlib.loads(subprocess.run(['defaults', 'export', 'com.apple.dock', '-'], check=True, capture_output=True).stdout)
apps = dock.get('persistent-apps', [])


def is_liszt(tile):
    data = tile.get('tile-data', {})
    return data.get('bundle-identifier') == BUNDLE_ID or data.get('file-label') == 'Liszt'


def is_installed(tile):
    return tile.get('tile-data', {}).get('file-data', {}).get('_CFURLString', '').rstrip('/') == URL.rstrip('/')


def new_tile():
    return {
        'tile-type': 'file-tile',
        'tile-data': {
            'file-data': {'_CFURLString': URL, '_CFURLStringType': 15},
            'file-label': 'Liszt',
            'bundle-identifier': BUNDLE_ID,
            'file-type': 41,
        },
    }


kept = []
removed = []
pinned = False
remade = False
for tile in apps:
    if not is_liszt(tile):
        kept.append(tile)
    elif is_installed(tile) and not pinned:
        if tile.get('tile-data', {}).get('file-type') == 41:
            kept.append(tile)
        else:
            kept.append(new_tile())
            remade = True
        pinned = True
    else:
        removed.append(tile.get('tile-data', {}).get('file-data', {}).get('_CFURLString', '?'))

if not pinned:
    kept.append(new_tile())

for url in removed:
    print(f'Dock: removed the pin of {url}')
print('Dock: pinned ' + APP if not pinned else 'Dock: pinned ' + APP + ' again, as an app' if remade else 'Dock: ' + APP + ' already pinned')
if removed or remade or not pinned:
    dock['persistent-apps'] = kept
    subprocess.run(['defaults', 'import', 'com.apple.dock', '-'], input=plistlib.dumps(dock), check=True)
sys.exit(0)
