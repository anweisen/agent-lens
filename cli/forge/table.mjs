// The before/after markdown table of a compare directory. Knows nothing about forges: image links are local
// paths until a caller maps them to uploaded URLs.
import fs from 'node:fs';
import path from 'node:path';
import { APP } from '../core/paths.mjs';

// The recording next to a waveform picture ("mc record"): <name>.mp4, else <name>.wav.
function mediaOf(image) {
  const stem = image.slice(0, -path.extname(image).length);
  return ['.mp4', '.wav'].map(extension => stem + extension).find(file => fs.existsSync(file)) ?? null;
}

export function loadCompare(dir) {
  const file = path.join(dir, 'compare.json');
  if (!fs.existsSync(file)) {
    throw new Error(`${file} not found (run "${APP} mc scene compare" or "${APP} web compare" first)`);
  }
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pairs = report.pairs.filter(pair => !pair.error).map(pair => {
    const before = path.join(report.before, `${pair.name}.png`);
    const after = path.join(report.after, `${pair.name}.png`);
    return {
      name: pair.name,
      identical: Boolean(pair.identical),
      before,
      after,
      beforeMedia: mediaOf(before),
      afterMedia: mediaOf(after),
      composite: path.join(path.resolve(dir), pair.file || `${pair.name}.compare.png`),
    };
  });
  return { labels: report.labels || ['Vorher', 'Nachher'], pairs };
}

// urls: file path -> link target; a missing entry falls back to the local path.
export function renderTable(compare, { composite = false, onlyChanged = false, urls = {} } = {}) {
  const [beforeLabel, afterLabel] = compare.labels;
  const pairs = compare.pairs.filter(pair => !onlyChanged || !pair.identical);
  const link = (alt, file) => `![${alt}](${urls[file] ?? file})`;
  // sound cannot be embedded in a table: the recording is a link next to its waveform
  const media = file => (file ? `[${file.endsWith('.mp4') ? 'Video' : 'Audio'}](${urls[file] ?? file})` : '');
  const cell = (alt, image, file) => link(alt, image) + (file ? `<br>${media(file)}` : '');
  const title = pair => `\`${pair.name}\`${pair.identical ? ' (identical)' : ''}`;
  if (composite) {
    const alt = pair => `${pair.name}: ${beforeLabel} / ${afterLabel}`;
    const listen = pair => (pair.beforeMedia || pair.afterMedia
      ? `\n\n${beforeLabel}: ${media(pair.beforeMedia) || '-'} · ${afterLabel}: ${media(pair.afterMedia) || '-'}`
      : '');
    return pairs.map(pair => `**${title(pair)}**\n\n${link(alt(pair), pair.composite)}${listen(pair)}`)
      .join('\n\n') + '\n';
  }
  const rows = pairs.map(pair => `| ${title(pair)} | ${cell(beforeLabel, pair.before, pair.beforeMedia)} `
    + `| ${cell(afterLabel, pair.after, pair.afterMedia)} |`);
  return [`| | ${beforeLabel} | ${afterLabel} |`, '|---|---|---|', ...rows].join('\n') + '\n';
}

export function filesOf(compare, { composite, onlyChanged }) {
  const files = [];
  for (const pair of compare.pairs) {
    if (onlyChanged && pair.identical) continue;
    if (composite) files.push({ file: pair.composite, name: `${pair.name}.compare.png` });
    else {
      files.push({ file: pair.before, name: `${pair.name}.before.png` });
      files.push({ file: pair.after, name: `${pair.name}.after.png` });
    }
    for (const side of ['before', 'after']) {
      const file = pair[`${side}Media`];
      if (file) files.push({ file, name: `${pair.name}.${side}${path.extname(file)}` });
    }
  }
  return files;
}
