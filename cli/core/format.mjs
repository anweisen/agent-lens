// Compact text output for an agent: little noise, nothing a terminal cannot show.

// Control and private-use characters (custom font glyphs of a server pack) have no glyph in a terminal.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f-￰-￿]|[\u{f0000}-\u{10ffff}]/gu;
export const printable = text => text.replace(UNPRINTABLE, char => `\\u{${char.codePointAt(0).toString(16)}}`);

const isRect = value => value && typeof value === 'object' && Object.keys(value).length === 4
  && ['x', 'y', 'w', 'h'].every(key => typeof value[key] === 'number');

function inline(value) {
  if (value === null || value === undefined) return '-';
  if (isRect(value)) return `${value.x},${value.y} ${value.w}x${value.h}`;
  if (Array.isArray(value)) return value.every(item => typeof item !== 'object' || item === null)
    ? `[${value.join(', ')}]`
    : `[${value.map(inline).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `${key}=${inline(item)}`).join(' ')}}`;
  }
  if (typeof value !== 'string') return String(value);
  return /\s/.test(value) || printable(value) !== value ? printable(JSON.stringify(value)) : value;
}

// One "key: value" line per field, lists of objects one item per line, rects as "x,y WxH".
export function formatResult(result, indent = '') {
  if (result === null || typeof result !== 'object') return `${indent}${result}`;
  if (isRect(result) || Array.isArray(result)) return `${indent}${inline(result)}`;
  const lines = [];
  for (const [key, value] of Object.entries(result)) {
    const list = Array.isArray(value) && value.some(item => item && typeof item === 'object');
    const map = value && typeof value === 'object' && !Array.isArray(value) && !isRect(value)
      && Object.values(value).some(item => item && typeof item === 'object');
    if (list) {
      // empty inventory slots are noise
      const shown = key === 'slots' ? value.filter(item => item?.item) : value;
      const hidden = value.length - shown.length;
      lines.push(`${indent}${key}: ${value.length}${hidden ? ` (${hidden} empty not shown)` : ''}`);
      for (const item of shown) lines.push(`${indent}  ${inline(item)}`);
    } else if (map) {
      lines.push(`${indent}${key}:`);
      for (const [name, item] of Object.entries(value)) lines.push(`${indent}  ${name}: ${inline(item)}`);
    } else lines.push(`${indent}${key}: ${inline(value)}`);
  }
  return lines.join('\n');
}

export function printResult(result, json) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    const text = formatResult(result);
    console.log(text === '' ? 'ok' : text);
  }
}
