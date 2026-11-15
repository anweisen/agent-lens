// Free-form flag parsing for commands whose flags are passed through to an API.

// switches: they take the next argument only when it is "true" or "false", so "type --clear new text" works
const BOOLEANS = new Set(['clear', 'none', 'shift', 'ctrl', 'double', 'reset', 'hide-hud', 'hide-hand', 'hide-player',
  'hold-hud', 'steady-player', 'item-name', 'toasts', 'text-cursor', 'chat', 'create', 'create-flat', 'create-creative',
  'deterministic', 'from-now', 'enable', 'json', 'restart', 'force', 'no-start', 'keep-going', 'pixel-diff',
  'only-changed', 'composite', 'dry-run', 'append', 'fit', 'brief', 'no-screen']);

export const camel = text => text.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());

// strings: keys that are never auto-typed ("42" stays a string)
export function typed(key, raw, strings = new Set()) {
  if (raw === true || strings.has(key)) return raw;
  if (key === 'labels') return raw.split(',').map(label => label.trim());
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?)+$/.test(raw)) return raw.split(',').map(Number);
  if (/^[[{]/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`--${key}: not valid JSON: ${raw}`);
    }
  }
  return raw;
}

// "--flag value", "--flag=value"; a flag followed by another flag or by nothing is boolean true.
export function splitArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const split = arg.indexOf('=');
    if (split > 0) flags[arg.slice(2, split)] = arg.slice(split + 1);
    else if (BOOLEANS.has(arg.slice(2))) {
      flags[arg.slice(2)] = /^(true|false)$/.test(argv[i + 1] ?? '') ? argv[++i] : true;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[arg.slice(2)] = argv[++i];
    else flags[arg.slice(2)] = true;
  }
  return { flags, positionals };
}
