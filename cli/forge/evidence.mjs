// pr evidence: the before/after table of a pull request description, kept up to date in place. "Before" is
// uploaded once; a later run replaces only the "after" cell of the rows it has a new image for. Works on the two
// capture directories (or single files) directly: no compare step and no stitched image.
import fs from 'node:fs';
import path from 'node:path';

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isImage = name => /\.(png|gif|jpe?g|webp)$/i.test(name);

// The recording next to a waveform picture ("mc record"): <name>.mp4, else <name>.wav.
function mediaOf(image) {
  const stem = image.slice(0, -path.extname(image).length);
  return ['.mp4', '.wav'].map(extension => stem + extension).find(file => fs.existsSync(file)) ?? null;
}

// The text a capture showed, from the manifest "mc scene run" writes next to it: the hovered item's tooltip.
function textsOf(dir) {
  const manifest = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifest)) return {};
  const { captures = [] } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  return Object.fromEntries(captures.filter(capture => capture.hovered?.tooltip?.length)
    .map(capture => [capture.file, capture.hovered.tooltip.join('\n')]));
}

// A file or a directory of captures -> [{name, file, media, text}]; name is the capture name both sides share.
export function captures(input, side) {
  if (!fs.existsSync(input)) throw new Error(`${input} does not exist`);
  const isDir = fs.statSync(input).isDirectory();
  const texts = isDir ? textsOf(input) : textsOf(path.dirname(input));
  const files = isDir
    ? fs.readdirSync(input).filter(name => isImage(name) && !/\.(compare|diff)\.\w+$/.test(name)).sort()
      .map(name => path.join(input, name))
    : [input];
  if (!files.length) throw new Error(`${input} holds no image`);
  return files.map(file => {
    const stem = path.basename(file, path.extname(file));
    return { name: stem.replace(new RegExp(`\\.${side}(-\\d+)?$`), ''), file, media: mediaOf(file),
      text: texts[path.basename(file)] ?? null };
  });
}

export function uploadsOf(list, side) {
  return list.flatMap(({ name, file, media }) => [
    { file, name: `${name}.${side}${path.extname(file)}` },
    ...(media ? [{ file: media, name: `${name}.${side}${path.extname(media)}` }] : []),
  ]);
}

export function cellOf(label, capture, urls) {
  const { file, media } = capture;
  const link = media ? `<br>[${media.endsWith('.mp4') ? 'Video' : 'Audio'}](${urls[media]})` : '';
  return `![${label}](${urls[file]})${link}`;
}

const cellsOf = line => line.trim().split('|').slice(1, -1).map(cell => cell.trim());

// The rows of every table headed "| <before> | <after> |" (with or without a leading name column).
function findRows(lines, [beforeLabel, afterLabel]) {
  const header = new RegExp(`^\\|(\\s*[^|]*\\|)?\\s*${escapeRegex(beforeLabel)}\\s*\\|\\s*${escapeRegex(afterLabel)}\\s*\\|$`);
  const rows = [];
  for (let index = 0; index < lines.length - 1; index++) {
    if (!header.test(lines[index].trim()) || !/^\|[\s:|-]+\|$/.test(lines[index + 1].trim())) continue;
    const named = cellsOf(lines[index]).length === 3;
    for (let row = index + 2; row < lines.length && lines[row].trim().startsWith('|'); row++) {
      const cells = cellsOf(lines[row]);
      if (cells.length !== (named ? 3 : 2)) continue;
      const stored = /\/([^/()]+?)\.(?:before|after)(?:-\d+)?\.\w+\)/.exec(cells.at(-2) + cells.at(-1));
      const name = named ? cells[0].replace(/`/g, '').replace(/\s*\(identical\)$/, '') : stored
        && decodeURIComponent(stored[1]);
      rows.push({ line: row, name, cells });
    }
  }
  return rows;
}

// Which row each new "after" capture replaces: by name, or the only row for the only capture.
export function planUpdate(markdown, labels, afters) {
  const lines = markdown.split('\n');
  const rows = findRows(lines, labels);
  if (!rows.length) return null;
  const pairs = afters.length === 1 && rows.length === 1
    ? [[afters[0], rows[0]]]
    : afters.map(after => [after, rows.find(row => row.name === after.name)]);
  const missing = pairs.filter(([, row]) => !row).map(([after]) => after.name);
  if (missing.length) {
    throw new Error(`no table row for ${missing.join(', ')} (rows: ${rows.map(row => row.name ?? '?').join(', ')}); `
      + 'nothing was changed');
  }
  return { lines, pairs };
}

export function applyUpdate({ lines, pairs }, cellFor) {
  for (const [after, row] of pairs) {
    const cells = [...row.cells.slice(0, -1), cellFor(after)];
    if (cells.length === 3) cells[0] = cells[0].replace(/\s*\(identical\)$/, '');
    lines[row.line] = `| ${cells.join(' | ')} |`;
  }
  return lines.join('\n');
}

// A new table; one pair needs no name column.
export function newTable(labels, pairs, urls) {
  const [beforeLabel, afterLabel] = labels;
  if (pairs.length === 1) {
    const [{ before, after }] = pairs;
    return [`| ${beforeLabel} | ${afterLabel} |`, '|---|---|',
      `| ${cellOf(beforeLabel, before, urls)} | ${cellOf(afterLabel, after, urls)} |`].join('\n');
  }
  return [`| | ${beforeLabel} | ${afterLabel} |`, '|---|---|---|', ...pairs.map(({ before, after }) =>
    `| \`${after.name}\` | ${cellOf(beforeLabel, before, urls)} | ${cellOf(afterLabel, after, urls)} |`)].join('\n');
}

// Pairs whose two sides show the same thing: identical image bytes, or the same tooltip text. Either means "before"
// and "after" ran the same build (a stale jar, a checkout on the wrong branch), not that nothing changed.
export function unchangedPairs(pairs) {
  return pairs.filter(({ before, after }) =>
    (before.text !== null && before.text === after.text)
    || fs.readFileSync(before.file).equals(fs.readFileSync(after.file)))
    .map(({ after }) => after.name);
}

export function pairUp(befores, afters) {
  if (befores.length === 1 && afters.length === 1) return [{ before: befores[0], after: afters[0] }];
  const pairs = afters.map(after => ({ after, before: befores.find(before => before.name === after.name) }));
  const missing = pairs.filter(pair => !pair.before).map(pair => pair.after.name);
  if (missing.length) throw new Error(`no "before" capture named ${missing.join(', ')}`);
  return pairs;
}
