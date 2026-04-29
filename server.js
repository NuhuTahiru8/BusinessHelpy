const http = require('http');
const { readFile, stat } = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT_DIR = __dirname;
const PORT = Number(process.env.PORT || 8000);

const users = {
  admin: { password: 'admin1234', brandname: 'I LOVE U' },
  staff: { password: 'staff1234', brandname: 'I LOVE U' },
};

const sessions = new Map();

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function getCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const parts = raw.split(';').map((p) => p.trim());
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

function setCookie(res, name, value, options = {}) {
  const attrs = [];
  attrs.push(`${name}=${encodeURIComponent(value)}`);
  attrs.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) attrs.push('HttpOnly');
  attrs.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (options.secure) attrs.push('Secure');
  if (options.maxAge != null) attrs.push(`Max-Age=${options.maxAge}`);
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sessionFromReq(req) {
  const sid = getCookie(req, 'bh_sid');
  if (!sid) return null;
  return sessions.get(sid) || null;
}

function requireSession(req, res) {
  const session = sessionFromReq(req);
  if (!session) {
    json(res, 401, { status: 'error', message: 'Not logged in' });
    return null;
  }
  return session;
}

async function sendViaArkesel({ apiKey, sender, message, recipients }) {
  const url = 'https://sms.arkesel.com/api/v2/sms/send';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sender, message, recipients }),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    return { ok: false, status: res.status, raw: text, parsed };
  }
  return { ok: true, status: res.status, raw: text, parsed };
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml; charset=utf-8';
  if (ext === '.ico') return 'image/x-icon';
  return 'application/octet-stream';
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.join(ROOT_DIR, safePath);

  try {
    const s = await stat(fullPath);
    if (!s.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const content = await readFile(fullPath);
    res.writeHead(200, {
      'Content-Type': guessContentType(fullPath),
      'Content-Length': content.length,
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    if (req.method === 'GET' && pathname === '/api/session') {
      const session = sessionFromReq(req);
      if (!session) return json(res, 200, { status: 'success', logged_in: false });
      return json(res, 200, {
        status: 'success',
        logged_in: true,
        username: session.username,
        brandname: session.brandname,
      });
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      const sid = getCookie(req, 'bh_sid');
      if (sid) sessions.delete(sid);
      clearCookie(res, 'bh_sid');
      return json(res, 200, { status: 'success' });
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      const body = await readJsonBody(req);
      if (body === null) return json(res, 400, { status: 'error', message: 'Invalid JSON' });

      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) {
        return json(res, 400, { status: 'error', message: 'Username and password are required' });
      }

      const user = users[username];
      if (!user || user.password !== password) {
        return json(res, 401, { status: 'error', message: 'Invalid login' });
      }

      const sid = crypto.randomUUID();
      sessions.set(sid, { username, brandname: user.brandname });

      setCookie(res, 'bh_sid', sid, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: false,
        path: '/',
      });

      return json(res, 200, {
        status: 'success',
        logged_in: true,
        username,
        brandname: user.brandname,
      });
    }

    if (req.method === 'POST' && pathname === '/api/send-sms') {
      const session = requireSession(req, res);
      if (!session) return;

      const body = await readJsonBody(req);
      if (body === null) return json(res, 400, { status: 'error', message: 'Invalid JSON' });

      const message = String(body.message || '').trim();
      const recipientRaw = String(body.recipientPhone || '').trim();

      if (!message || !recipientRaw) {
        return json(res, 400, { status: 'error', message: 'Please fill in all fields' });
      }

      const recipients = recipientRaw
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean);

      if (recipients.length === 0) {
        return json(res, 400, { status: 'error', message: 'Invalid phone number' });
      }

      for (const r of recipients) {
        if (!/^\+?[0-9]{8,15}$/.test(r)) {
          return json(res, 400, { status: 'error', message: 'Invalid phone number format' });
        }
      }

      const apiKey = process.env.ARKESEL_API_KEY;
      if (!apiKey) {
        return json(res, 500, { status: 'error', message: 'Missing ARKESEL_API_KEY on the server' });
      }

      const result = await sendViaArkesel({
        apiKey,
        sender: session.brandname,
        message,
        recipients,
      });

      if (!result.ok) {
        return json(res, 502, {
          status: 'error',
          message: 'Failed to send SMS',
          raw_response: result.raw,
        });
      }

      return json(res, 200, { status: 'success', arkesel: result.parsed || result.raw });
    }

    return json(res, 404, { status: 'error', message: 'Not found' });
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  process.stdout.write(`Server running on http://localhost:${PORT}/\n`);
});
