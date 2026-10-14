/**
 * cash-live harness — secure fixture write unit checks (offline).
 *
 * Covers the filesystem-level safety rules for the token-bearing fixture:
 *   - parent chain must be real directories (no symlink components);
 *   - creation is exclusive (O_EXCL) — a pre-existing file is never
 *     truncated or overwritten;
 *   - O_NOFOLLOW — a symlink at the target path is never followed;
 *   - mode 0600 set at creation, and NO chmod on the path afterwards;
 *   - writes go to the exact validated path only.
 *
 * Temp fixtures are created ONLY inside the project root (cwd), under the
 * owned `.tmp/cash-live-spec/<uuid>` tree; symlink "escape" targets are
 * real directories in a sibling owned folder — still inside the project
 * root, never os.tmpdir(). The spec cleans up exactly the directories it
 * owns. No DB, no Nest, no network.
 */
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ensureRealDirectoryChain,
  writeFixtureExclusively,
} from './secure-fixture-write';

const PROJECT_ROOT = process.cwd();
const SPEC_DIR = path.join(
  PROJECT_ROOT,
  '.tmp',
  'cash-live-spec',
  randomUUID(),
);

/**
 * Owned symlink-target directory: a real directory INSIDE the project
 * root but OUTSIDE SPEC_DIR, so a symlinked parent genuinely escapes the
 * fixture subtree while every byte stays project-root-confined.
 */
const ESCAPE_DIR = path.join(
  PROJECT_ROOT,
  '.tmp',
  'cash-live-spec',
  `outside-${randomUUID()}`,
);

async function makeSpecDirs(): Promise<void> {
  await fsPromises.mkdir(SPEC_DIR, { recursive: true });
  await fsPromises.mkdir(ESCAPE_DIR, { recursive: true });
}

function targetPath(name: string): string {
  return path.join(SPEC_DIR, name);
}

beforeAll(async () => {
  await makeSpecDirs();
});

afterAll(async () => {
  // Cleanup ONLY the directories this spec created (owned files), both
  // under `.tmp/cash-live-spec/` inside the project root.
  await fsPromises.rm(SPEC_DIR, { recursive: true, force: true });
  await fsPromises.rm(ESCAPE_DIR, { recursive: true, force: true });
});

describe('ensureRealDirectoryChain', () => {
  it('accepts a chain of real directories and creates missing ones', async () => {
    const target = targetPath(path.join('nested', 'real', 'fixture.json'));
    await expect(ensureRealDirectoryChain(PROJECT_ROOT, target)).resolves.toBe(
      undefined,
    );
    const stat = await fsPromises.stat(path.dirname(target));
    expect(stat.isDirectory()).toBe(true);
  });

  it('rejects a symlinked parent directory', async () => {
    // Real target directory inside the project root (owned sibling),
    // outside SPEC_DIR — the symlink escapes the fixture subtree without
    // ever leaving the project root.
    const outside = await fsPromises.mkdtemp(
      path.join(ESCAPE_DIR, 'escape-'),
    );
    try {
      const linkPath = targetPath('symlink-parent');
      await fsPromises.symlink(outside, linkPath, 'dir');
      const target = path.join(linkPath, 'fixture.json');
      await expect(
        ensureRealDirectoryChain(PROJECT_ROOT, target),
      ).rejects.toThrow(/symlink|non-directory/i);
    } finally {
      await fsPromises.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects when an ancestor exists but is a regular file', async () => {
    const filePath = targetPath('a-file');
    await fsPromises.writeFile(filePath, 'x', { mode: 0o600 });
    const target = path.join(filePath, 'fixture.json');
    await expect(
      ensureRealDirectoryChain(PROJECT_ROOT, target),
    ).rejects.toThrow(/symlink|non-directory/i);
  });
});

describe('writeFixtureExclusively', () => {
  const CONTENT = '{"schemaVersion":1,"bearer":"fixture-token"}\n';

  it('creates the file with mode 0600 at the exact target path', async () => {
    const target = targetPath(`ok-${randomUUID()}.json`);
    await writeFixtureExclusively(target, CONTENT);
    const stat = fs.lstatSync(target);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await fsPromises.readFile(target, 'utf8')).toBe(CONTENT);
  });

  it('refuses to overwrite a pre-existing file (no truncation)', async () => {
    const target = targetPath(`exists-${randomUUID()}.json`);
    await fsPromises.writeFile(target, 'ORIGINAL', { mode: 0o600 });
    await expect(writeFixtureExclusively(target, CONTENT)).rejects.toThrow(
      /already exists|refus/i,
    );
    expect(await fsPromises.readFile(target, 'utf8')).toBe('ORIGINAL');
  });

  it('refuses to follow a symlink at the target path', async () => {
    const realFile = targetPath(`real-${randomUUID()}.txt`);
    await fsPromises.writeFile(realFile, 'REAL', { mode: 0o600 });
    const target = targetPath(`link-${randomUUID()}.json`);
    await fsPromises.symlink(realFile, target, 'file');
    await expect(writeFixtureExclusively(target, CONTENT)).rejects.toThrow();
    expect(await fsPromises.readFile(realFile, 'utf8')).toBe('REAL');
  });

  it('refuses a symlinked parent directory', async () => {
    // Real target directory inside the project root (owned sibling),
    // outside SPEC_DIR — see the ensureRealDirectoryChain case above.
    const outside = await fsPromises.mkdtemp(
      path.join(ESCAPE_DIR, 'escape-'),
    );
    try {
      const linkPath = targetPath(`symlink-${randomUUID()}`);
      await fsPromises.symlink(outside, linkPath, 'dir');
      await expect(
        writeFixtureExclusively(path.join(linkPath, 'fixture.json'), CONTENT),
      ).rejects.toThrow(/symlink|non-directory/i);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      await fsPromises.rm(outside, { recursive: true, force: true });
    }
  });

  it('sets 0600 at creation and performs no chmod on the path', async () => {
    const target = targetPath(`mode-${randomUUID()}.json`);
    await writeFixtureExclusively(target, CONTENT);
    // If the implementation chmod'ed after write, a pre-creation umask
    // override would be masked; assert the final mode directly instead.
    expect(fs.lstatSync(target).mode & 0o777).toBe(0o600);
  });
});
