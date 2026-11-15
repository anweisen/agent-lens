// Forge providers. There is no shared API across forges, so a provider implements this small interface and
// nothing else in the tool knows which forge it talks to:
//
//   resolve({repo, number, id?})     -> pr: {id, repo, number, url, title, ...}   lookups only (GET)
//   uploadImage(pr, file, name)      -> {markdownUrl}     how an image becomes linkable in that pull request
//   uploadImages(pr, [{file, name}]) -> [{markdownUrl}]   optional: all files in one go (one commit)
//   comment(pr, markdown)            -> {url}
//   getDescription(pr)               -> markdown
//   setDescription(pr, markdown)     -> {url}
//
// A provider module exports create(forge, {dryRun}) and gets its config entry (plus `name`). Writes go through
// the client of ./http.mjs so that --dry-run prints them instead of sending them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { paths } from '../core/paths.mjs';

const PROVIDERS = {
  onedev: () => import('./onedev.mjs'),
  github: () => import('./github.mjs'),
  forgejo: () => import('./forgejo.mjs'),
  // Gitea has the same API for everything used here
  gitea: () => import('./forgejo.mjs'),
};

export const providerTypes = () => Object.keys(PROVIDERS);

// name: --forge; optional when exactly one forge is configured
export function pickForge(config, name) {
  const names = Object.keys(config.forges);
  const example = '{"forges": {"gh": {"type": "github", "auth": {"type": "gh"}}}}';
  if (!names.length) {
    throw new Error(`no forge is configured: add one under "forges" in ${paths.config}, for example ${example} `
      + `(types: ${providerTypes().join(', ')})`);
  }
  if (!name) {
    if (names.length > 1) throw new Error(`several forges are configured (${names.join(', ')}): pass --forge <name>`);
    [name] = names;
  }
  if (!Object.hasOwn(config.forges, name)) throw new Error(`unknown forge "${name}" (configured: ${names.join(', ')})`);
  const forge = { name, ...config.forges[name] };
  if (!PROVIDERS[forge.type]) {
    throw new Error(`forge "${name}": unknown type "${forge.type}" (${providerTypes().join(', ')})`);
  }
  return forge;
}

export async function openForge(config, name, { dryRun = false } = {}) {
  const forge = pickForge(config, name);
  const provider = (await PROVIDERS[forge.type]()).create(forge, { dryRun });
  return { forge, provider };
}

// Files with the same content (an unchanged before/after pair) are stored once and linked twice.
export async function uploadAll(provider, pr, files) {
  const first = new Map();
  const distinct = [];
  const slot = files.map(entry => {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(entry.file)).digest('hex');
    if (!first.has(hash)) {
      first.set(hash, distinct.length);
      distinct.push(entry);
    }
    return first.get(hash);
  });
  let results;
  if (provider.uploadImages) results = await provider.uploadImages(pr, distinct);
  else {
    results = [];
    for (const { file, name } of distinct) results.push(await provider.uploadImage(pr, file, name));
  }
  return slot.map(index => results[index]);
}
