// Local harness, not deployed: the three functions on /api/* plus the repo root as static files.
//   MOCK_MODEL=1 HUB_PASSCODE=test node server/dev.js        (port 8791, or PORT)
// REPORT_DATA_URL and REPORT_ENGINE_URL default to the repo's data.js and report.js.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import chat from './api/chat.js';
import needs from './api/needs.js';
import health from './api/health.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const ROUTES = { '/api/chat': chat, '/api/needs': needs, '/api/health': health };

export function createServer() {
  process.env.HUB_PASSCODE ||= 'test';
  process.env.REPORT_DATA_URL ||= path.join(ROOT, 'data.js');
  process.env.REPORT_ENGINE_URL ||= path.join(ROOT, 'report.js');
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const fn = ROUTES[url.pathname];
    if (fn) {
      return fn(req, res).catch((e) => {
        console.error('dev:', e);
        if (!res.headersSent) res.statusCode = 500;
        res.end('{"error":{"code":"upstream","message":"dev harness error"}}');
      });
    }
    const file = path.join(ROOT, url.pathname === '/' ? 'hub.html' : decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT + path.sep) || !existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    createReadStream(file).pipe(res);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8791;
  createServer().listen(port, () => console.log('Nova dev server on http://localhost:' + port, 'mock=' + (process.env.MOCK_MODEL === '1'), 'data=' + process.env.REPORT_DATA_URL, 'engine=' + process.env.REPORT_ENGINE_URL));
}
