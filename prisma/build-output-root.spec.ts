import * as path from 'node:path';
import * as ts from 'typescript';

/**
 * The production image runs `node dist/main` (Dockerfile, `start:prod`), which
 * only exists while every file of the build program lives under `src/`. One
 * file importing from outside `src/` (for example a test helper reaching into
 * `prisma/`) moves the emitted root to `dist/src/main.js` and breaks the deploy.
 */
describe('production build output root', () => {
  it('compiles only files under src/, so the entry point stays dist/main.js', () => {
    const root = path.resolve(__dirname, '..');
    const configPath = path.join(root, 'tsconfig.build.json');
    const config = ts.getParsedCommandLineOfConfigFile(
      configPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(
            ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
          );
        },
      },
    );
    if (!config) throw new Error('tsconfig.build.json could not be parsed');
    const program = ts.createProgram({
      rootNames: config.fileNames,
      options: { ...config.options, noEmit: true },
    });
    const src = path.join(root, 'src') + path.sep;
    const outside = program
      .getSourceFiles()
      .map((file) => path.resolve(file.fileName))
      .filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`))
      .filter((file) => !file.startsWith(src))
      .map((file) => path.relative(root, file));
    expect(outside).toEqual([]);
  }, 120_000);
});
