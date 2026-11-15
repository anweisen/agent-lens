// doctor: one line per prerequisite. Reads only: starts nothing, contacts no daemon, refreshes no token.
// Each module contributes its own checks.
import { configSource, loadConfig } from './config.mjs';
import { paths } from './paths.mjs';

export async function runDoctor(argv, modules) {
  const results = [];
  const add = (level, name, text) => results.push({ level, name, text });
  let config;
  try {
    config = loadConfig();
    add('ok', 'config', `${configSource()}; cache ${paths.cache}; state ${paths.state}`);
  } catch (error) {
    add('FAIL', 'config', error.message);
  }
  if (config) for (const checks of modules) await checks(config, add);
  if (argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else for (const { level, name, text } of results) console.log(`${level.padEnd(4)} ${name.padEnd(8)} ${text}`);
  return results.some(result => result.level === 'FAIL') ? 1 : 0;
}
