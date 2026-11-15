// Entry point: dispatch to the modules. mc and web do not know each other; what one needs from the other is
// handed in from here.
import { APP } from './core/paths.mjs';

const USAGE = `usage: ${APP} <group> <command> [options]

  mc      Minecraft client with the lens mod: start on demand, act, read the screen, capture regions, scenes
  web     browser screenshots of pages and page sections, measure, ARIA snapshot, compare
  pr      images into a pull request (OneDev, GitHub, Forgejo/Gitea), before/after markdown table
  doctor  check the prerequisites, one line per check

  ${APP} help <mc|web|pr>   commands of a group
Reference: docs/usage.md (mc), docs/usage-web.md (web), docs/forges.md (pr), docs/config.md (config file),
docs/api.md (HTTP API behind mc)
`;

const runWeb = async argv => (await import('./web/index.mjs')).runWeb(argv);
const runMc = async argv => (await import('./mc/index.mjs')).runMc(argv, { webCompare: runWeb });
const runPr = async argv => (await import('./forge/cli.mjs')).runPr(argv);

async function doctor(argv) {
  const [core, mc, web, forge] = await Promise.all([import('./core/doctor.mjs'), import('./mc/doctor.mjs'),
    import('./web/doctor.mjs'), import('./forge/doctor.mjs')]);
  return core.runDoctor(argv, [mc.mcChecks, web.webChecks, forge.forgeChecks]);
}

async function main() {
  const [group, ...rest] = process.argv.slice(2);
  if (group === 'mc') return runMc(rest);
  if (group === 'web') return runWeb(rest);
  if (group === 'pr') return runPr(rest);
  if (group === 'doctor') return doctor(rest);
  if (group === 'help' || group === '--help' || group === '-h') {
    if (rest[0] === 'mc') return runMc(['help']);
    if (rest[0] === 'web') return runWeb(['help']);
    if (rest[0] === 'pr') return runPr(['help']);
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(USAGE);
  return 2;
}

main().then(
  code => {
    process.exitCode = code;
  },
  error => {
    console.error(`${APP}: ${error.message}`);
    process.exitCode = 1;
  },
);
