// Runs worker/worker.js locally on Node for testing: node tests/worker-server.mjs [port]
import http from 'node:http';
import worker from '../worker/worker.js';
const port = Number(process.argv[2] || 8787);
http.createServer(async (req, res) => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const r = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log('relay on', port));
