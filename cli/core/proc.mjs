import fs from 'node:fs';
import path from 'node:path';

export function onPath(name) {
  const candidates = (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name));
  return candidates.find(file => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}
