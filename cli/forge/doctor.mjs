// doctor checks of the forge module: what is configured and whether its credentials can be found. No request.
import { onPath } from '../core/proc.mjs';
import { providerTypes } from './index.mjs';

export async function forgeChecks(config, add) {
  const entries = Object.entries(config.forges);
  if (!entries.length) {
    add('ok', 'forges', 'none configured ("pr table" works without one)');
    return;
  }
  for (const [name, forge] of entries) {
    const auth = forge.auth ?? { type: 'none' };
    const where = forge.api ?? 'default API';
    if (!providerTypes().includes(forge.type)) add('FAIL', 'forge', `${name}: unknown type "${forge.type}"`);
    else if (auth.type === 'token-env' && !process.env[auth.env]) {
      add('warn', 'forge', `${name} (${forge.type}, ${where}): the environment variable ${auth.env} is not set`);
    } else if (auth.type === 'gh' && !onPath('gh')) {
      add('warn', 'forge', `${name} (${forge.type}, ${where}): auth "gh" but gh is not on PATH`);
    } else add('ok', 'forge', `${name} (${forge.type}, ${where}), auth ${auth.type}`);
  }
}
