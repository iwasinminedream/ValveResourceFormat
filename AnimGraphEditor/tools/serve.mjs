/**
 * A static file server for local use: `npm run serve`, then open the URL.
 *
 * The editor is plain ES modules with no build step, but browsers refuse to
 * import modules from `file://`, so it has to be served over HTTP.
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT ?? 8173);

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
};

const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let path = join(ROOT, relative === '/' ? 'index.html' : relative);

    // Never serve anything outside the project directory.
    if (!path.startsWith(ROOT)) {
        response.writeHead(403).end('Forbidden');
        return;
    }

    try {
        if (statSync(path).isDirectory()) {
            path = join(path, 'index.html');
        }
    } catch {
        response.writeHead(404).end('Not found');
        return;
    }

    response.writeHead(200, {
        'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
    });
    createReadStream(path).pipe(response);
});

server.listen(PORT, () => {
    console.log(`AnimGraph 2 editor: http://localhost:${PORT}/`);
});
