// HTTP client of a forge provider: lookups always run, writes are printed instead of sent in a dry run.
// Credentials are added per request and never printed.
import { spawnSync } from 'node:child_process';
import { USER_AGENT, httpRequest } from '../core/http.mjs';

const SECRET_HEADERS = /^(authorization|cookie|private-token|x-.*-token)$/i;

// auth: {type: "none"} (a credential-injecting proxy, or a public read) | {type: "token-env", env, scheme?} |
// {type: "gh", hostname?} (asks the GitHub CLI at call time)
export function authHeaders(forge, defaultScheme = 'Bearer') {
  const auth = forge.auth ?? { type: 'none' };
  if (auth.type === 'none') return {};
  if (auth.type === 'token-env') {
    const token = auth.env && process.env[auth.env];
    if (!token) {
      throw new Error(`forge "${forge.name}": the environment variable ${auth.env ?? '(auth.env missing)'} is not set`);
    }
    return { Authorization: `${auth.scheme ?? defaultScheme} ${token}` };
  }
  if (auth.type === 'gh') {
    const args = ['auth', 'token', ...(auth.hostname ? ['--hostname', auth.hostname] : [])];
    const run = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
    const token = run.status === 0 ? run.stdout.trim() : '';
    if (!token) {
      throw new Error(`forge "${forge.name}": "gh auth token" gave no token (is gh installed and logged in?)`);
    }
    return { Authorization: `Bearer ${token}` };
  }
  throw new Error(`forge "${forge.name}": unknown auth type "${auth.type}" (none, token-env, gh)`);
}

function printRequest(method, url, headers, body, note) {
  console.log(`DRY RUN ${method} ${url}`);
  for (const [name, value] of Object.entries(headers)) {
    console.log(`  ${name}: ${SECRET_HEADERS.test(name) ? '<redacted>' : value}`);
  }
  if (typeof body === 'string') {
    const text = body.length > 1500 ? `${body.slice(0, 1500)} ... (${body.length} characters)` : body;
    console.log(`  body: ${text}`);
  } else if (body) console.log(`  body: ${body.size ?? body.length ?? '?'} bytes${note ? ` (${note})` : ''}`);
}

// base: API base URL; headers: sent with every request; auth: () => headers
export function createClient({ base, headers = {}, auth = () => ({}), dryRun = false }) {
  const root = base.replace(/\/+$/, '');
  const send = async (method, apiPath, extra = {}, body) => {
    const url = root + apiPath;
    const response = await httpRequest(url, {
      method, body, headers: { 'User-Agent': USER_AGENT, ...headers, ...extra, ...auth() },
    });
    return { ...response, url };
  };
  const parse = text => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  const fail = (method, response) => new Error(
    `${method} ${response.url}: HTTP ${response.status} ${response.text.slice(0, 300)}`);
  const withQuery = (apiPath, query) => (query ? `${apiPath}?${new URLSearchParams(query)}` : apiPath);
  return {
    base: root,
    dryRun,
    async get(apiPath, query) {
      const response = await send('GET', withQuery(apiPath, query));
      if (!response.ok) throw fail('GET', response);
      return parse(response.text);
    },
    // null instead of an error for 404
    async find(apiPath, query) {
      const response = await send('GET', withQuery(apiPath, query));
      if (response.status === 404) return null;
      if (!response.ok) throw fail('GET', response);
      return parse(response.text);
    },
    // body: a string (with contentType), a Buffer (with contentType) or a FormData. Returns null in a dry run.
    async write(method, apiPath, { json, body, contentType, note } = {}) {
      const payload = json !== undefined ? JSON.stringify(json) : body;
      const type = json !== undefined ? 'application/json' : contentType;
      const extra = type ? { 'Content-Type': type } : {};
      if (dryRun) {
        const shown = { 'User-Agent': USER_AGENT, ...headers, ...extra, ...auth() };
        if (payload instanceof FormData) {
          shown['Content-Type'] = 'multipart/form-data';
          const parts = [...payload.entries()]
            .map(([name, value]) => `${name}=${value.size ?? String(value).length} bytes`);
          printRequest(method, root + apiPath, shown, `form ${parts.join(', ')}${note ? ` (${note})` : ''}`);
        } else printRequest(method, root + apiPath, shown, payload, note);
        return null;
      }
      const response = await send(method, apiPath, extra, payload);
      if (!response.ok) throw fail(method, response);
      return parse(response.text);
    },
  };
}
