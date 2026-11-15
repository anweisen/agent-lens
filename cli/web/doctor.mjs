// doctor checks of the web module. The daemon is not contacted: on some machines that would start it.
import fs from 'node:fs';
import path from 'node:path';
import { onPath } from '../core/proc.mjs';
import { PLAYWRIGHT_VERSION, dockerCommand } from './docker.mjs';

export async function webChecks(config, add) {
  const docker = onPath('docker');
  if (!docker) {
    add('warn', 'docker', 'docker not on PATH: the web module and "mc scene compare --pixel-diff" will not work');
    return;
  }
  const { env } = dockerCommand(config, []).opts;
  const host = env.DOCKER_HOST || 'the default socket';
  const certs = env.DOCKER_CERT_PATH;
  if (certs && !fs.existsSync(path.join(certs, 'cert.pem'))) {
    add('warn', 'docker', `${docker}, daemon ${host}, but no client certificate in ${certs}`);
    return;
  }
  const extra = config.web.docker.args.length ? `, args ${config.web.docker.args.join(' ')}` : '';
  add('ok', 'docker', `${docker}, daemon ${host}${certs ? `, certs ${certs}` : ''}${extra}; `
    + `mounts under ${config.web.mountRoots.join(', ')}; Playwright ${PLAYWRIGHT_VERSION}`);
}
