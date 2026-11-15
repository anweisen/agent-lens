// Microsoft login for the client through a prismarine-auth token cache. Tokens only ever live in that cache and in
// the java command line of the started client. The cache can be the tool's own or one shared with another program
// (config account.cacheDir, cacheKey, authflow), which then has to use the same Authflow arguments.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePinned } from '../core/npm.mjs';
import { APP } from '../core/paths.mjs';

const PIN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json');

export class LoginRequired extends Error {}

// Same hash as prismarine-auth's createHash: the cache files are named <hash>_<kind>-cache.json.
function cacheFiles(config) {
  const { cacheDir, cacheKey } = config.account;
  const hash = crypto.createHash('sha1').update(cacheKey ?? '', 'binary').digest('hex').slice(0, 6);
  const file = kind => path.join(cacheDir, `${hash}_${kind}-cache.json`);
  const flow = config.account.authflow.flow || 'live';
  return { msa: file(flow), xbl: file('xbl'), mca: file('mca') };
}

// Reads the cache files only: no request, no refresh, no token leaves this function.
export function cacheStatus(config) {
  const files = cacheFiles(config);
  const read = file => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  const msa = read(files.msa);
  const mca = read(files.mca);
  const mcaExpires = mca?.mca ? mca.mca.obtainedOn + mca.mca.expires_in * 1000 : 0;
  return {
    dir: config.account.cacheDir,
    present: Boolean(msa),
    hasRefreshToken: Boolean(msa?.token?.refresh_token),
    minecraftTokenValid: mcaExpires > Date.now(),
    minecraftTokenExpires: mcaExpires ? new Date(mcaExpires).toISOString() : null,
  };
}

function loginHint(config) {
  const who = config.account.name ? ` as ${config.account.name}` : '';
  return `Run "${APP} mc login" and sign in${who} with the printed code.`;
}

// authTitle is the name of a prismarine-auth title ("MinecraftNintendoSwitch", "MinecraftJava") or a client id.
function authflowOptions(config, Titles) {
  const { flow = 'live', authTitle = 'MinecraftNintendoSwitch', deviceType = 'Nintendo' } = config.account.authflow;
  return { flow, authTitle: Titles[authTitle] ?? authTitle, deviceType };
}

export async function getSession(config, { interactive = false, onCode } = {}) {
  const status = cacheStatus(config);
  if (!interactive && !status.hasRefreshToken) {
    throw new LoginRequired(`no Microsoft login in ${status.dir}. ${loginHint(config)}`);
  }
  const dir = ensurePinned({ pinFile: PIN_FILE, name: 'prismarine-auth', dir: config.dirs.node });
  const { Authflow, Titles } = createRequire(path.join(dir, 'package.json'))('prismarine-auth');
  fs.mkdirSync(config.account.cacheDir, { recursive: true, mode: 0o700 });
  const flow = new Authflow(config.account.cacheKey, config.account.cacheDir, authflowOptions(config, Titles), onCode);

  if (!interactive) {
    const required = new LoginRequired(
      `the cached Microsoft login in ${status.dir} cannot be refreshed. ${loginHint(config)}`);
    // Backstop: prismarine-auth falls back to a device code login on its own when a refresh fails.
    flow.msa.authDeviceCode = async () => {
      throw required;
    };
    if (!(await flow.mca.verifyTokens()) && !(await flow.msa.verifyTokens())) throw required;
  }

  let result;
  try {
    result = await flow.getMinecraftJavaToken({ fetchProfile: true });
  } catch (error) {
    if (error instanceof LoginRequired) throw error;
    throw new Error(`Microsoft login failed: ${error.message}`);
  }
  const profile = result.profile;
  if (!result.token || !profile?.id || !profile?.name) {
    throw new Error('Microsoft login worked but no Minecraft profile came back (does the account own the game?)');
  }
  const expected = config.account.name;
  if (expected && profile.name.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`the login cache holds account "${profile.name}", expected "${expected}" (config account.name)`);
  }
  return { accessToken: result.token, uuid: profile.id.replaceAll('-', ''), name: profile.name };
}
