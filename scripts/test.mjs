import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const compile = spawnSync(
  process.execPath,
  [
    'node_modules/typescript/bin/tsc',
    'src/browser-tools.ts',
    'src/card-tools.ts',
    'src/client.ts',
    '--outDir',
    '.test-build',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
    '--lib',
    'ES2022,DOM,DOM.Iterable',
    '--skipLibCheck',
  ],
  { stdio: 'inherit' },
);
if (compile.status !== 0) process.exit(compile.status ?? 1);
const tests = readdirSync('tests')
  .filter((x) => x.endsWith('.test.mjs'))
  .map((x) => 'tests/' + x);
const result = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--test', ...tests],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
