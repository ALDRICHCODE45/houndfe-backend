"""Parent-only disposable setup. No existing target or migration retry is accepted."""

import hashlib
import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

if not __debug__:
    raise RuntimeError('Optimized Python disables required guards')

ROOT = Path(__file__).resolve().parents[2]
RUN = Path(sys.argv[1]).resolve(strict=True)
assert RUN.parent == ROOT / '.tmp' and RUN.name.startswith('draft-runtime.')
assert RUN.stat().st_uid == os.getuid() and not list(RUN.iterdir())
os.umask(0o077)
IMAGE = 'sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb'
owner = 'draft-' + secrets.token_hex(8)
name = 'editorial-coordination-' + owner
schema = 'editorial_test_' + secrets.token_hex(8)
user = schema
database = schema
password = secrets.token_hex(24)
bootstrap_password = secrets.token_hex(24)

def save(name, value):
    (RUN / name).write_text(json.dumps(value, indent=2) + '\n')

def docker(*args, data=None):
    result = subprocess.run(
        ['docker', '--host', 'unix:///var/run/docker.sock', *args],
        input=data, capture_output=True, text=True, timeout=45,
    )
    if result.returncode:
        for secret in [password, bootstrap_password]:
            result.stderr = result.stderr.replace(secret, '[REDACTED]')
        (RUN / 'setup-error.txt').write_text(json.dumps({'exit': result.returncode, 'stderr': result.stderr}))
        raise RuntimeError('Docker setup failed; private diagnostic retained')
    return result.stdout.strip()

assert docker('image', 'inspect', IMAGE, '--format', '{{.Id}}') == IMAGE
network = docker('network', 'create', '--internal', '--label', 'editorial.owner=' + owner, name)
save('resources.json', {'owner': owner, 'network': network, 'name': name})
(RUN / 'postgres.env').write_text('POSTGRES_PASSWORD=' + bootstrap_password + '\n')
container = docker(
    'run', '--detach', '--pull', 'never', '--name', name,
    '--label', 'editorial.owner=' + owner, '--network', network,
    '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
    '--env-file', str(RUN / 'postgres.env'), IMAGE,
)
save('resources.json', {'owner': owner, 'network': network, 'name': name, 'container': container})
try:
    identity = json.loads(docker('inspect', container, '--format',
        '{"id":{{json .Id}},"image":{{json .Image}},"name":{{json .Name}},'
        '"owner":{{json (index .Config.Labels "editorial.owner")}},'
        '"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}},'
        '"tmpfs":{{json .HostConfig.Tmpfs}}}'))
except ValueError:
    raise RuntimeError('Invalid owned-container identity') from None
assert identity['id'] == container and identity['image'] == IMAGE
assert identity['name'] == '/' + name and identity['owner'] == owner
assert identity['tmpfs'] == {'/var/lib/postgresql/data': 'rw,noexec,nosuid,size=256m'}
assert all(mount['Type'] == 'tmpfs' for mount in identity['mounts'])
assert all(value is None for value in identity['ports'].values())
for _attempt in range(30):
    ready = subprocess.run(
        ['docker', '--host', 'unix:///var/run/docker.sock', 'exec', container,
         'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], capture_output=True, timeout=5,
    )
    if ready.returncode == 0:
        break
    time.sleep(1)
else:
    raise RuntimeError('Owned PostgreSQL readiness deadline exceeded')
docker('exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres',
       data=f'CREATE ROLE "{user}" LOGIN PASSWORD \'{password}\' NOSUPERUSER NOCREATEDB NOCREATEROLE;\n'
            f'CREATE DATABASE "{database}" OWNER "{user}";\n')
psql = ['exec', '-i', '-e', 'PGOPTIONS=-c search_path=' + schema, container,
        'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database]
docker(*psql, data=f'CREATE SCHEMA "{schema}" AUTHORIZATION "{user}";\n')
paths = sorted((ROOT / 'prisma/migrations').glob('*/migration.sql'))
assert len(paths) == 72
for path in paths:
    source = path.read_bytes()
    with (RUN / 'migrations.log').open('a') as log:
        log.write(f'{path.parent.name} {hashlib.sha256(source).hexdigest()} attempting\n')
    docker(*psql, data=source.decode())
    with (RUN / 'migrations.log').open('a') as log:
        log.write(f'{path.parent.name} {hashlib.sha256(source).hexdigest()} exit=0\n')
target = {
    'containerId': container,
    'imageId': IMAGE,
    'name': name,
    'owner': owner,
    'host': '127.0.0.1',
    'port': 0,  # Unbound: only the API-owned relay may supply a live loopback port.
    'database': database,
    'user': user,
}
save('config.json', {
    'binding': {'target': target, 'schema': schema, 'password': password},
    'pinned': target,
    'network': network,
    'jwt': secrets.token_hex(32),
    'refresh': secrets.token_hex(32),
    'fixturePassword': secrets.token_hex(24),
    'feOrigin': 'http://127.0.0.1:43179',
})
print(json.dumps({'setup': 'migrated', 'owner': owner, 'container': container}))
