// Run locally with:  node dev-server.js   then open http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';

if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const { default: handler } = await import('./api/audit.js');

http.createServer(async (req, res) => {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  if (req.url.startsWith('/api/audit')) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    req.body = raw;
    return handler(req, res);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync('index.html'));
}).listen(3000, () => console.log('Site Audit Agent running at http://localhost:3000'));
