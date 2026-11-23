// Local dev server. Serves the repo and wraps game.html in the same document skeleton
// the Artifact host adds at publish time, so the page behaves identically in both places.
//   node serve.mjs [port]        then open http://localhost:8080/
//   http://localhost:8080/?mock  adds a BroadcastChannel stand-in for the co-op room (two tabs = two pilots)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 8080);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const skeleton = (body, extraHead = '') =>
  `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>` +
  `:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}` +
  `img{max-width:100%}[hidden]{display:none!important}</style>${extraHead}</head><body>${body}</body></html>`;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p === '/') {
    const body = fs.readFileSync(path.join(root, 'game.html'), 'utf8');
    const head = url.searchParams.has('mock') ? '<script src="dev/mock-claude.js"></script>' : '';
    res.writeHead(200, { 'content-type': types['.html'], 'cache-control': 'no-store' });
    return res.end(skeleton(body, head));
  }
  const file = path.join(root, path.normalize(p));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`BREAKWATER dev server: http://localhost:${port}/`));
