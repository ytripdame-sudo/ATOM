#!/usr/bin/env node
/**
 * Dev-only static server so the extension's pages can be opened in a normal
 * tab (the panel falls back to a clearly-labelled preview transport there).
 * It is not part of the shipped extension.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../extension/', import.meta.url)));
const requested = Number(process.env.PORT);
const port = Number.isInteger(requested) && requested > 0 ? requested : 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://local').pathname);

  if (pathname === '/' || pathname === '') {
    response.writeHead(302, { location: '/sidepanel/' });
    response.end();
    return;
  }

  try {
    const target = resolve(join(root, pathname));
    if (target !== root && !target.startsWith(root + sep)) throw new Error('outside root');

    const info = await stat(target).catch(() => null);
    const file = info?.isDirectory() ? join(target, 'index.html') : target;
    const body = await readFile(file);

    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const bound = address && typeof address === 'object' ? address.port : port;
  console.log(`ATOM preview  http://127.0.0.1:${bound}/sidepanel/   http://127.0.0.1:${bound}/newtab/`);
});
