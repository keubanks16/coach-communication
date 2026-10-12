import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
function run(args, capture = false) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root, stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Cloudflare command failed: ${args.slice(0, 3).join(' ')}`);
  return result.stdout;
}

export function selectDatabase(databases, name) {
  if (!Array.isArray(databases)) throw new Error('Unexpected D1 database list.');
  const matching = databases.filter(database => database.name === name);
  if (matching.length > 1) throw new Error('More than one D1 database has this name; configure database_id explicitly.');
  const database = matching[0];
  if (database && !/^[a-f0-9-]{36}$/i.test(database.uuid)) throw new Error('Cloudflare returned an invalid D1 database identifier.');
  return database;
}

export function deploy() {
  const config = JSON.parse(readFileSync(new URL('../wrangler.json', import.meta.url), 'utf8'));
  const binding = config.d1_databases.find(database => database.binding === 'DB');
  if (!binding) throw new Error('wrangler.json needs a DB binding.');
  if (!binding.database_id) {
    let database = selectDatabase(JSON.parse(run(['d1', 'list', '--json'], true)), binding.database_name);
    if (!database) {
      run(['d1', 'create', binding.database_name, '--no-update-config']);
      database = selectDatabase(JSON.parse(run(['d1', 'list', '--json'], true)), binding.database_name);
    }
    if (!database) throw new Error('D1 provisioning did not return the expected database.');
    binding.database_id = database.uuid;
  }
  // Resolve the actual account's database ID without committing account data or credentials.
  // This also avoids relying on auto-provisioning to write database_id before migrations.
  writeFileSync(new URL('../wrangler.resolved.json', import.meta.url), JSON.stringify(config, null, 2));
  run(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', 'wrangler.resolved.json']);
  run(['deploy', '--config', 'wrangler.resolved.json']);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { deploy(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
