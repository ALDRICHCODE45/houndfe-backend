/**
 * cash-live harness — secure, exclusive fixture write.
 *
 * Filesystem-level safety for the token-bearing fixture file:
 *   1. `ensureRealDirectoryChain` — every ancestor between the repository
 *      root and the fixture's parent directory is validated with `lstat`
 *      to be a REAL directory (never a symlink); missing directories are
 *      created one segment at a time and re-verified after creation,
 *      closing most of the TOCTOU window (exclusive creation + non-symlink
 *      parent validation).
 *   2. `writeFixtureExclusively` — opens the target with
 *      O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW and mode 0600 in a single
 *      syscall, so:
 *        - a pre-existing file is NEVER truncated or overwritten;
 *        - a symlink at the target path is NEVER followed;
 *        - owner-only permissions are set AT CREATION (no chmod on the
 *          path after the token bytes exist).
 *   3. The content is written through the already-open file handle; the
 *      path is used exactly as validated (no re-resolution, no defaults).
 */
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

/** Validate/create the real directory chain for the fixture's parent. */
export async function ensureRealDirectoryChain(
  rootDir: string,
  targetPath: string,
): Promise<void> {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  const parentDir = path.dirname(target);

  const relative = path.relative(root, parentDir);
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Fixture parent must stay inside the repository root');
  }

  // Build the ancestor chain from just inside the root down to the parent.
  const segments = relative.split(path.sep);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      // lstat: a symlink component must fail even if its target is a dir.
      stat = await fsPromises.lstat(current);
    } catch {
      // Missing segment — create it, then re-verify (TOCTOU narrowing).
      await fsPromises.mkdir(current, 0o700);
      stat = await fsPromises.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Fixture parent chain contains a symlink or non-directory: rejected`,
      );
    }
  }
}

/** Exclusive, no-follow, 0600-at-creation write of the fixture content. */
export async function writeFixtureExclusively(
  targetPath: string,
  content: string,
): Promise<void> {
  // The parent chain was validated by the caller via ensureRealDirectoryChain
  // (or is already real); re-validate defensively right before creation.
  await ensureRealDirectoryChain(process.cwd(), targetPath);

  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW;

  let handle: fsPromises.FileHandle;
  try {
    handle = await fsPromises.open(targetPath, flags, 0o600);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'EEXIST') {
      throw new Error(
        'Fixture file already exists — refusing to overwrite (delete it explicitly before rerunning)',
      );
    }
    if (code === 'ELOOP') {
      throw new Error('Fixture target is a symlink — refusing to follow');
    }
    throw new Error('Fixture creation failed (exclusive open rejected)');
  }

  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}
