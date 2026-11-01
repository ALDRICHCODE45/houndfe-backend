"""Parent only: stop the owned API job first; preserve proof and diagnostic files."""

import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

if not __debug__:
    raise RuntimeError('Optimized Python disables required guards')
run = Path(sys.argv[1]).resolve(strict=True)
assert run.parent == Path(__file__).resolve().parents[2] / '.tmp'
assert run.name.startswith('draft-runtime.') and run.stat().st_uid == os.getuid()
try:
    resource = json.loads((run / 'resources.json').read_text())
except ValueError:
    raise RuntimeError('Invalid owned-resource record') from None
assert re.fullmatch(r'draft-[a-f0-9]{16}', resource['owner'])
assert resource['name'] == 'editorial-coordination-' + resource['owner']
if (run / 'host-started.json').exists():
    started = json.loads((run / 'host-started.json').read_text())
    stopped = json.loads((run / 'host-stopped.json').read_text())
    assert started == stopped and stopped['owner'] == resource['owner']

def docker(*args):
    return subprocess.check_output(['docker', '--host', 'unix:///var/run/docker.sock', *args], text=True, timeout=30).strip()

if 'container' in resource:
    identifier = resource['container']
    assert re.fullmatch(r'[a-f0-9]{64}', identifier)
    observed = docker('inspect', identifier, '--format', '{{.Image}} {{.Name}} {{index .Config.Labels "editorial.owner"}}')
    assert observed == 'sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb /' + resource['name'] + ' ' + resource['owner']
    docker('rm', '--force', identifier)
    assert not docker('ps', '--all', '--quiet', '--no-trunc', '--filter', 'id=' + identifier)
assert re.fullmatch(r'[a-f0-9]{64}', resource['network'])
assert docker('network', 'inspect', resource['network'], '--format', '{{.Name}} {{index .Labels "editorial.owner"}}') == resource['name'] + ' ' + resource['owner']
docker('network', 'rm', resource['network'])
assert not docker('network', 'ls', '--quiet', '--no-trunc', '--filter', 'id=' + resource['network'])
for name in ['config.json', 'postgres.env', 'http-credentials.json', 'browser-credentials.json']:
    file = run / name
    if file.exists():
        info = file.lstat()
        assert stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
        file.unlink()
    assert not file.exists()
(run / 'retired.json').write_text(json.dumps({'owner': resource['owner'], 'retired': True}))
print('Owned container/network/credential files absent; proof retained')
