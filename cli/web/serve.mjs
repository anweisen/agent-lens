// --serve: a static directory on a loopback port for the duration of one run.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { UsageError } from './spec.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain',
  '.xml': 'application/xml', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};

export async function serveStatic(arg, spa) {
  const m = /^(.*?)(?::(\d+))?$/.exec(arg);
  const root = path.resolve(m[1]);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new UsageError(`--serve: ${root} is not a directory`);
  }
  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = path.join(root, path.normalize(rel));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const isFile = (f) => fs.existsSync(f) && fs.statSync(f).isFile();
    if (!isFile(file)) {
      if (isFile(path.join(file, 'index.html'))) file = path.join(file, 'index.html');
      else if (isFile(`${file}.html`)) file = `${file}.html`;
      else if (spa && !path.extname(file) && isFile(path.join(root, 'index.html'))) {
        file = path.join(root, 'index.html');
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new Error(`--serve: cannot listen on 127.0.0.1:${m[2] || 0}: ${e.message}`)));
    server.listen(Number(m[2] || 0), '127.0.0.1', resolve);
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
