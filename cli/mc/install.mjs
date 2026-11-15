// Downloads of the game: version metadata, client jar, libraries and assets from Mojang's official endpoints, the
// Fabric loader from Fabric's. Everything is verified against the published checksums and cached.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fetchRetry } from '../core/http.mjs';

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META = 'https://meta.fabricmc.net/v2/versions/loader';
const ASSET_HOST = 'https://resources.download.minecraft.net';

const OS = { name: 'linux', arch: process.arch === 'x64' ? 'x86_64' : process.arch };

function sha1File(file) {
  const hash = crypto.createHash('sha1');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

// A finished file is only ever created by rename, so an interrupted install leaves no half-written files behind.
async function download({ url, file, sha1, size }, verify) {
  if (fs.existsSync(file)) {
    const sizeOk = size === undefined || fs.statSync(file).size === size;
    if (sizeOk && (!verify || !sha1 || sha1File(file) === sha1)) return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.part`;
  try {
    const res = await fetchRetry(url);
    const hash = crypto.createHash('sha1');
    const body = Readable.fromWeb(res.body);
    body.on('data', chunk => hash.update(chunk));
    await pipeline(body, fs.createWriteStream(tmp));
    const actual = hash.digest('hex');
    if (sha1 && actual !== sha1) throw new Error(`sha1 mismatch for ${url}: expected ${sha1}, got ${actual}`);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return true;
}

async function downloadAll(items, { verify, label, log }) {
  let next = 0;
  let fetched = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      if (await download(item, verify)) fetched++;
      done++;
      if (log && done % 500 === 0) log(`${label}: ${done}/${items.length}`);
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
  if (log) log(`${label}: ${items.length} files, ${fetched} downloaded`);
}

async function cachedJson(url, file, sha1) {
  await download({ url, file, sha1 }, Boolean(sha1));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function rulesAllow(rules, features = {}) {
  if (!rules) return true;
  let allowed = false;
  for (const rule of rules) {
    let matches = true;
    if (rule.os?.name && rule.os.name !== OS.name) matches = false;
    if (rule.os?.arch && rule.os.arch !== OS.arch) matches = false;
    for (const [feature, wanted] of Object.entries(rule.features || {})) {
      if (Boolean(features[feature]) !== wanted) matches = false;
    }
    if (matches) allowed = rule.action === 'allow';
  }
  return allowed;
}

function mavenPath(name) {
  const [group, artifact, version, classifier] = name.split(':');
  const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${group.replaceAll('.', '/')}/${artifact}/${version}/${fileName}`;
}

// Mojang lists the aarch64 natives of some libraries without an arch rule.
function wrongArch(name) {
  const classifier = name.split(':')[3] || '';
  return OS.arch === 'x86_64' && /aarch_?64|arm64/.test(classifier);
}

export async function resolveVersion(config, { offline = false } = {}) {
  const versionDir = path.join(config.dirs.versions, config.minecraft);
  const versionFile = path.join(versionDir, `${config.minecraft}.json`);
  const fabricFile = path.join(versionDir, `fabric-loader-${config.fabricLoader}.json`);
  if (!offline || !fs.existsSync(versionFile) || !fs.existsSync(fabricFile)) {
    if (!fs.existsSync(versionFile)) {
      const manifest = await (await fetchRetry(MANIFEST_URL)).json();
      const entry = manifest.versions.find(version => version.id === config.minecraft);
      if (!entry) throw new Error(`unknown Minecraft version ${config.minecraft}`);
      await download({ url: entry.url, file: versionFile, sha1: entry.sha1 }, true);
    }
    await download({ url: `${FABRIC_META}/${config.minecraft}/${config.fabricLoader}/profile/json`, file: fabricFile });
  }
  const version = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
  const fabric = JSON.parse(fs.readFileSync(fabricFile, 'utf8'));

  const libraries = [];
  for (const library of fabric.libraries) {
    const rel = mavenPath(library.name);
    libraries.push({ name: library.name, url: library.url + rel, file: path.join(config.dirs.libraries, rel),
      sha1: library.sha1, size: library.size });
  }
  for (const library of version.libraries) {
    if (!rulesAllow(library.rules) || wrongArch(library.name)) continue;
    const artifact = library.downloads.artifact;
    libraries.push({ name: library.name, url: artifact.url, file: path.join(config.dirs.libraries, artifact.path),
      sha1: artifact.sha1, size: artifact.size });
  }
  const client = { url: version.downloads.client.url, sha1: version.downloads.client.sha1,
    size: version.downloads.client.size, file: path.join(versionDir, `${config.minecraft}.jar`) };
  return { version, fabric, libraries, client };
}

export async function install(config, { verify = false, log = console.log } = {}) {
  const resolved = await resolveVersion(config);
  const { version, libraries, client } = resolved;

  // Fabric meta gives no checksum for the loader jar itself, Maven does.
  for (const library of libraries) {
    if (library.sha1 || fs.existsSync(library.file)) continue;
    library.sha1 = (await (await fetchRetry(`${library.url}.sha1`)).text()).trim().split(/\s+/)[0];
  }
  await downloadAll([client, ...libraries], { verify, label: 'client and libraries', log });

  const index = version.assetIndex;
  const indexFile = path.join(config.dirs.assets, 'indexes', `${index.id}.json`);
  const assets = await cachedJson(index.url, indexFile, index.sha1);
  const objects = new Map();
  for (const { hash, size } of Object.values(assets.objects)) {
    const rel = `${hash.slice(0, 2)}/${hash}`;
    objects.set(hash, { url: `${ASSET_HOST}/${rel}`, file: path.join(config.dirs.assets, 'objects', rel), sha1: hash,
      size });
  }
  await downloadAll([...objects.values()], { verify, label: 'assets', log });
  return resolved;
}
