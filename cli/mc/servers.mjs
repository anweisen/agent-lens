// The production guard: a client only joins servers named in the config, each with an explicit host and port.
import { paths } from '../core/paths.mjs';

export function defaultAuth(config) {
  return config.offline ? 'offline' : 'microsoft';
}

// What the mod gets as its allow list: only the servers that fit the session of this client.
export function allowList(config, auth) {
  const servers = Object.values(config.servers).filter(server => server.auth === auth);
  return servers.map(server => `${server.host}:${server.port}`);
}

export const describeServers = config => Object.entries(config.servers)
  .map(([name, server]) => `${name} (${server.host}:${server.port}, ${server.auth})`);

// A configured name or an exact configured host:port. Never a bare host.
export function resolveServer(config, target) {
  const known = describeServers(config);
  const hint = known.length
    ? `Configured servers: ${known.join(', ')} (${paths.config}).`
    : `No servers are configured: add one under "servers" in ${paths.config}, `
      + 'for example {"servers": {"dev": {"host": "127.0.0.1", "port": 25565, "auth": "offline"}}}.';
  if (typeof target !== 'string' || !target) throw new Error(`connect needs a server name. ${hint}`);
  if (Object.hasOwn(config.servers, target)) return { name: target, ...config.servers[target] };
  for (const [name, server] of Object.entries(config.servers)) {
    if (target === `${server.host}:${server.port}`) return { name, ...server };
  }
  const why = target.includes(':')
    ? 'is not a configured server'
    : 'is neither a configured name nor host:port (a bare host is never accepted: SRV lookup could reach production)';
  throw new Error(`refused: "${target}" ${why}. ${hint}`);
}
