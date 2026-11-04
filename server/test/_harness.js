// Starts the dev harness on a random port and returns a tiny client for the tests.
import { createServer } from '../dev.js';

export async function start() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    base,
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
    api: (p, o = {}) => fetch(base + p, {
      method: o.method || 'GET',
      headers: { 'content-type': 'application/json', 'x-hub-pass': o.pass === undefined ? 'test' : o.pass, 'x-forwarded-for': o.ip || '127.0.0.1' },
      body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body),
    }),
  };
}
