import {
  DockerExecutor,
  executeEditorialDocker as docker,
  withEditorialPostgres,
} from './editorial-vocabulary-postgres';

const realProof =
  process.env.RUN_EDITORIAL_POSTGRES_PROOF === '1' ? describe : describe.skip;

realProof('S22 disposable PostgreSQL lifecycle (explicit opt-in)', () => {
  beforeAll(() => {
    docker(['version', '--format', '{{.Server.Version}}']);
  });

  it('executes real SQL and proves the owned container is absent on return', async () => {
    let owned = '';
    await withEditorialPostgres((db) => {
      owned = db.id;
      const [container] = JSON.parse(docker(['inspect', owned])) as {
        HostConfig: {
          NetworkMode: string;
          PortBindings: object;
          Tmpfs: object;
        };
        Mounts: { Type: string }[];
      }[];
      expect(container.HostConfig.NetworkMode).toBe('none');
      expect(container.HostConfig.PortBindings).toEqual({});
      expect(container.HostConfig.Tmpfs).toHaveProperty(
        '/var/lib/postgresql/data',
      );
      expect(container.Mounts.every((mount) => mount.Type === 'tmpfs')).toBe(
        true,
      );
      expect(
        db.sql(
          'CREATE TABLE proof (n integer); INSERT INTO proof VALUES (42); SELECT n FROM proof;',
        ),
      ).toContain('42');
      expect(db.sql('SHOW server_version;')).toMatch(/^16\./);
      return Promise.resolve();
    });
    expect(
      docker(['ps', '-aq', '--no-trunc', '--filter', `id=${owned}`]).trim(),
    ).toBe('');
    console.info(`S22 normal SQL: ${owned}; absent after cleanup`);
  }, 180000);

  it('removes the real container after a forced post-start setup failure', async () => {
    let owned = '';
    const failure = new Error('forced setup failure after real docker start');
    const execute: DockerExecutor = (args, input, timeout) => {
      const output = docker(args, input, timeout);
      if (args[0] === 'create') owned = output.trim();
      if (args[0] === 'start') throw failure;
      return output;
    };
    const use = jest.fn();
    await expect(withEditorialPostgres(use, execute)).rejects.toBe(failure);
    expect(use).not.toHaveBeenCalled();
    expect(owned).not.toBe('');
    expect(
      docker(['ps', '-aq', '--no-trunc', '--filter', `id=${owned}`]).trim(),
    ).toBe('');
    console.info(`S22 forced setup failure: ${owned}; absent after cleanup`);
  }, 180000);
});
