// pr: put evidence images into a pull request of a configured forge.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../core/config.mjs';
import { APP } from '../core/paths.mjs';
import { openForge, providerTypes, uploadAll } from './index.mjs';
import {
  applyUpdate, captures, cellOf, identicalShots, newShots, newTable, pairUp, planUpdate, unchangedPairs, updateNewTable,
  uploadsOf,
} from './evidence.mjs';
import { filesOf, loadCompare, renderTable } from './table.mjs';

const HELP = `usage: ${APP} pr <command>

  table --compare <dir> [--composite] [--only-changed] [--urls <file.json>]
        markdown before/after table from a compare directory (compare.json of "mc scene compare" or
        "web compare"); image links are local paths unless --urls maps file paths to uploaded URLs
  resolve --repo <path> --pr <number>
        look the pull request up (read only): id, title, URL
  upload --repo <path> --pr <number> <files...>
        make the files linkable in the pull request, print one markdown image link per file
  upload --repo <path> --pr <number> --compare <dir> [--composite] [--only-changed]
        upload the before/after images of a compare directory, print the finished markdown table
  comment --repo <path> --pr <number> [--body-file <file.md>] [--compare <dir> ...]
        add a comment
  description --repo <path> --pr <number> [--body-file <file.md>] [--compare <dir> ...] [--append]
        replace the description, or append to the current one
        --compare on comment/description uploads the images and puts the table after the body text: the
        evidence lands in one command, right after the pull request is created

  evidence --repo <path> --pr <number> --after <file|dir> [--before <file|dir>] [--labels Vorher,Nachher]
        keep the before/after table of the description up to date: when it has one, only the "after" images
        are uploaded and only their cells are replaced ("before" stays as it is); when it has none, --before
        is needed and the table is appended. Takes capture files or "mc scene run" directories, pairs by
        file name; needs no compare step and no stitched image. Refuses a pair whose two sides have the same
        tooltip text (from the scene manifest) or identical image bytes, the sign of both sides running one build;
        --allow-unchanged for a change that is not in the text. On a rerun, --before only feeds this check,
        unless --replace-before: then both cells are replaced (a "before" that was itself wrong, e.g. cut off).
        The text compared is the screen title plus the tooltip
  evidence --repo <path> --pr <number> --new <file|dir> [--new <file|dir> ...] [--labels Neu]
        a new feature, where a "before" shows nothing: one or more shots (perspectives, states) in a "| Neu |"
        table (a name column first for several). A rerun replaces the rows of the same capture name and adds
        rows for new names; every other row stays. Refuses two shots with identical bytes (a state change that
        did not happen); --allow-unchanged when that is intended. Lives beside a before/after table of the
        same pull request: run evidence once per kind

  common: --forge <name>  a forge of the config ("forges"); optional when exactly one is configured
          --dry-run       print every write request (method, URL, headers without secrets, body) instead of
                          sending it; lookups (GET) still run
          --json          machine readable result
  Provider types: ${providerTypes().join(', ')}. --repo is owner/name (the project path for OneDev, which also
  takes --pr-id <global id>). Reference: docs/forges.md
`;

class UsageError extends Error {}

const OPTIONS = {
  forge: { type: 'string' }, repo: { type: 'string' }, project: { type: 'string' }, pr: { type: 'string' },
  'pr-id': { type: 'string' }, 'body-file': { type: 'string' }, compare: { type: 'string' }, urls: { type: 'string' },
  before: { type: 'string' }, after: { type: 'string' }, new: { type: 'string', multiple: true },
  labels: { type: 'string' },
  composite: { type: 'boolean' }, 'only-changed': { type: 'boolean' }, append: { type: 'boolean' },
  'dry-run': { type: 'boolean' }, json: { type: 'boolean' }, 'allow-unchanged': { type: 'boolean' }, 'replace-before': { type: 'boolean' },
};

function bodyFile(flags, command) {
  if (!flags['body-file']) {
    if (flags.compare) return '';
    throw new UsageError(`${command} needs --body-file <file.md> or --compare <dir>`);
  }
  return fs.readFileSync(flags['body-file'], 'utf8');
}

async function run(command, flags, positionals) {
  const options = { composite: Boolean(flags.composite), onlyChanged: Boolean(flags['only-changed']) };
  if (command === 'table') {
    if (!flags.compare) throw new UsageError('table needs --compare <dir>');
    const urls = flags.urls ? JSON.parse(fs.readFileSync(flags.urls, 'utf8')) : {};
    process.stdout.write(renderTable(loadCompare(flags.compare), { ...options, urls: urls.urls ?? urls }));
    return 0;
  }
  if (!['resolve', 'upload', 'comment', 'description', 'evidence'].includes(command)) {
    throw new UsageError(`unknown command "pr ${command}" (table, resolve, upload, comment, description, evidence)`);
  }
  if (flags.pr && !/^\d+$/.test(flags.pr)) throw new UsageError('--pr expects the pull request number');

  // everything that can fail without the forge is checked before the first request
  let compare = null;
  let files = [];
  let markdown = null;
  let afters = null;
  let befores = null;
  let shots = null;
  if (command === 'evidence' && flags.new) {
    if (flags.before || flags.after) throw new UsageError('--new is for a feature with no "before": no --before/--after');
    shots = newShots(flags.new);
    const same = identicalShots(shots);
    if (same.length && !flags['allow-unchanged']) {
      throw new UsageError(`identical shots: ${same.join(', ')}. Two states that look the same mean the state change `
        + 'did not happen; --allow-unchanged when that is intended');
    }
  } else if (command === 'evidence') {
    if (!flags.after) throw new UsageError('evidence needs --after <file|dir> (or --new <file|dir> for a new feature)');
    afters = captures(flags.after, 'after');
    befores = flags.before ? captures(flags.before, 'before') : null;
  } else if (command !== 'resolve') {
    compare = flags.compare ? loadCompare(flags.compare) : null;
    files = compare ? filesOf(compare, options) : [];
    if (command === 'upload') {
      if (!compare) files = positionals.map(file => ({ file, name: path.basename(file) }));
      if (!files.length) throw new UsageError('upload needs files or --compare <dir>');
    } else markdown = bodyFile(flags, command);
    for (const { file } of files) if (!fs.existsSync(file)) throw new UsageError(`${file} does not exist`);
  }

  const dryRun = Boolean(flags['dry-run']);
  const { forge, provider } = await openForge(loadConfig(), flags.forge, { dryRun });
  const pr = await provider.resolve({ repo: flags.repo ?? flags.project, number: flags.pr, id: flags['pr-id'] });
  const print = (result, text) => console.log(
    flags.json ? JSON.stringify({ forge: forge.name, dryRun, ...result }, null, 2) : text);

  if (markdown !== null && compare) {
    const uploaded = await uploadAll(provider, pr, files);
    const urls = Object.fromEntries(files.map(({ file }, index) => [file, uploaded[index].markdownUrl]));
    markdown = [markdown.trimEnd(), renderTable(compare, { ...options, urls })].filter(Boolean).join('\n\n');
  }

  switch (command) {
    case 'resolve': {
      const { description, ...shown } = pr;
      const line = `${forge.name} (${forge.type}) ${pr.repo}#${pr.number}  id ${pr.id}  ${pr.title ?? ''}`;
      print({ pr: shown }, `${line}\n${pr.url ?? ''}`.trimEnd());
      return 0;
    }
    case 'upload': {
      const uploaded = await uploadAll(provider, pr, files);
      const urls = Object.fromEntries(files.map(({ file }, index) => [file, uploaded[index].markdownUrl]));
      if (flags.json) print({ pullRequest: pr.number, urls });
      else if (compare) process.stdout.write(renderTable(compare, { ...options, urls }));
      else {
        for (const { file, name } of files) {
          const image = /\.(png|gif|jpe?g|webp)$/i.test(name);
          console.log(`${image ? '!' : ''}[${image ? name.replace(/\.[^.]+$/, '') : name}](${urls[file]})`);
        }
      }
      return 0;
    }
    case 'evidence': {
      if (shots) {
        const [label, ...extra] = (flags.labels ?? 'Neu').split(',').map(name => name.trim());
        if (extra.length) throw new UsageError('--labels with --new takes one name: New');
        const files = uploadsOf(shots, 'new');
        const uploaded = await uploadAll(provider, pr, files);
        const urls = Object.fromEntries(files.map(({ file }, index) => [file, uploaded[index].markdownUrl]));
        const update = updateNewTable(await provider.getDescription(pr), label, shots,
          shot => cellOf(`${label}: ${shot.name}`, shot, urls));
        const result = await provider.setDescription(pr, update.markdown);
        const what = [update.added.length && `added ${update.added.join(', ')}`,
          update.replaced.length && `replaced ${update.replaced.join(', ')}`].filter(Boolean).join('; ');
        if (!dryRun) {
          print({ mode: 'new', added: update.added, replaced: update.replaced, urls, description: result },
            `${label}: ${what}${result.url ? `: ${result.url}` : ''}`);
        }
        return 0;
      }
      const labels = (flags.labels ?? 'Vorher,Nachher').split(',').map(label => label.trim());
      if (labels.length !== 2) throw new UsageError('--labels takes two names: Before,After');
      const current = await provider.getDescription(pr);
      const plan = planUpdate(current, labels, afters);
      if (!plan && !befores) {
        throw new UsageError(`the description has no "| ${labels[0]} | ${labels[1]} |" table yet: pass --before <file|dir>`);
      }
      const pairs = plan ? null : pairUp(befores, afters);
      // On a rerun --before is optional and only feeds this check.
      const checked = pairs ?? (befores ? pairUp(befores, afters) : []);
      const unchanged = unchangedPairs(checked);
      if (unchanged.length && !flags['allow-unchanged']) {
        throw new UsageError(`before and after show the same for ${unchanged.join(', ')} (same tooltip text or `
          + 'identical image): both sides most likely ran the same build. Check which build each side ran; '
          + '--allow-unchanged when the change is not in the text (an icon, a colour)');
      }
      const replaceBefore = Boolean(plan && flags['replace-before']);
      if (flags['replace-before'] && !befores) throw new UsageError('--replace-before needs --before');
      const beforeOf = replaceBefore ? new Map(checked.map(pair => [pair.after.name, pair.before])) : null;
      const files = plan ? [...(replaceBefore ? uploadsOf(checked.map(pair => pair.before), 'before') : []),
        ...uploadsOf(afters, 'after')]
        : [...uploadsOf(pairs.map(pair => pair.before), 'before'), ...uploadsOf(pairs.map(pair => pair.after), 'after')];
      const uploaded = await uploadAll(provider, pr, files);
      const urls = Object.fromEntries(files.map(({ file }, index) => [file, uploaded[index].markdownUrl]));
      const markdown = plan
        ? applyUpdate(plan, after => cellOf(labels[1], after, urls),
          replaceBefore ? after => cellOf(labels[0], beforeOf.get(after.name), urls) : null)
        : [current.trimEnd(), newTable(labels, pairs, urls)].filter(Boolean).join('\n\n');
      const result = await provider.setDescription(pr, markdown);
      const names = afters.map(after => after.name).join(', ');
      const what = plan
        ? (replaceBefore ? `${labels[0]} and ${labels[1]} replaced for ${names}`
          : `${labels[1]} replaced for ${names}; ${labels[0]} kept`
            + (befores ? ' (--before ignored: the table already has it, --replace-before to replace it)' : ''))
        : `table added for ${names}`;
      if (!dryRun) {
        print({ mode: plan ? 'after-replaced' : 'table-added', captures: afters.map(after => after.name), urls,
          description: result }, `${what}${result.url ? `: ${result.url}` : ''}`);
      }
      return 0;
    }
    case 'comment': {
      const result = await provider.comment(pr, markdown);
      if (!dryRun) print({ comment: result }, `comment created${result.url ? `: ${result.url}` : ''}`);
      return 0;
    }
    case 'description': {
      const current = flags.append ? (await provider.getDescription(pr)).trimEnd() : '';
      const result = await provider.setDescription(pr, current ? `${current}\n\n${markdown}` : markdown);
      if (!dryRun) print({ description: result }, `description updated${result.url ? `: ${result.url}` : ''}`);
      return 0;
    }
  }
  return 2;
}

export async function runPr(argv) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) {
    console.log(HELP);
    return 0;
  }
  try {
    const { values: flags, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
    return await run(positionals[0], flags, positionals.slice(1));
  } catch (error) {
    console.error(`${APP} pr: ${error.message}`);
    return error instanceof UsageError || error.code?.startsWith?.('ERR_PARSE_ARGS') ? 2 : 1;
  }
}
