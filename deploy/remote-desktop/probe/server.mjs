import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(process.env.RD_PROBE_CONFIG, 'utf8'));
let current = null;
const events = [];
const server = http.createServer(async (req, res) => {
  if (req.headers.host !== '127.0.0.1:18765') { res.writeHead(403).end(); return; }
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Cache-Control', 'no-store');
  if (!url.pathname.startsWith('/api/')) {
    const file = ({ '/': 'sender.html', '/sender.js': 'sender.js' })[url.pathname];
    if (!file) { res.writeHead(404).end(); return; }
    if (file === 'sender.html') res.setHeader('Set-Cookie', `rd_probe=${config.accessKey}; HttpOnly; SameSite=Strict; Path=/`);
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : 'text/javascript');
    res.end(fs.readFileSync(path.join(root, file))); return;
  }
  const cookieAuth = req.headers.cookie?.split('; ').includes(`rd_probe=${config.accessKey}`) && (!req.headers.origin || req.headers.origin === 'http://127.0.0.1:18765');
  if (req.headers.authorization !== `Bearer ${config.accessKey}` && !cookieAuth) { res.writeHead(401).end(); return; }
  res.setHeader('Content-Type', 'application/json');
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 128 * 1024) throw new Error('Payload limit'); }
    const payload = body ? JSON.parse(body) : null;
    if (req.method === 'GET' && url.pathname === '/api/config') res.end(JSON.stringify({ iceServers: config.iceServers }));
    else if (req.method === 'POST' && url.pathname === '/api/offer') { current = { ...payload, iceServers: config.receiverIceServers || config.iceServers }; res.end('{}'); }
    else if (req.method === 'GET' && url.pathname === '/api/receiver') res.end(JSON.stringify(current || {}));
    else if (req.method === 'GET' && url.pathname === '/api/answer') res.end(JSON.stringify(current && url.searchParams.get('runId') === current.runId ? current.answer || {} : {}));
    else if (req.method === 'POST' && url.pathname === '/api/event') {
      if (payload.type === 'answer') { if (current && payload.runId === current.runId) current.answer = payload.answer; }
      else { events.push({ at: new Date().toISOString(), ...payload }); if (events.length > 500) events.shift(); fs.appendFileSync(config.evidenceFile, JSON.stringify(events.at(-1)) + '\n', { mode: 0o600 }); }
      res.end('{}');
    } else if (req.method === 'GET' && url.pathname === '/api/events') res.end(JSON.stringify(events));
    else res.writeHead(404).end('{}');
  } catch { res.writeHead(400).end(JSON.stringify({ error: 'Invalid probe request' })); }
});
server.listen(18765, '127.0.0.1', () => process.stdout.write('Probe signaling listening on loopback:18765\n'));
