// Some hosts (Hostinger's Express preset is one) run `npm install` and then start the entry file with
// no build step in between, so the API has to be compiled here. It is built when installing for
// production, or when apps/api/dist/server.js does not exist yet. A development install that already
// has a build does nothing.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

const production = process.env.NODE_ENV === 'production';
if (!production && existsSync(at('apps/api/dist/server.js'))) process.exit(0);

if (!existsSync(at('node_modules/typescript/bin/tsc'))) {
  process.stdout.write(
    'postinstall: TypeScript is not installed (dev dependencies were skipped), so the API was not built.\n',
  );
  process.exit(0);
}

process.stdout.write(
  production
    ? 'postinstall: building the API for production\n'
    : 'postinstall: apps/api/dist is missing, building the API\n',
);

const npm = process.env.npm_execpath;
const result = npm
  ? spawnSync(process.execPath, [npm, 'run', 'build'], { cwd: at(''), stdio: 'inherit' })
  : spawnSync('npm', ['run', 'build'], { cwd: at(''), stdio: 'inherit', shell: true });

process.exit(result.status ?? 1);
