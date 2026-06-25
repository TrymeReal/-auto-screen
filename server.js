const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── CONFIG ───────────────────────────────────────────
const GITHUB_USER   = process.env.GITHUB_USER   || 'TrymeReal';
const GITHUB_REPO   = process.env.GITHUB_REPO   || '-auto-screen';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const POLL_MS       = parseInt(process.env.POLL_MS) || 30000; // 30 detik
const PORT          = process.env.PORT || 3131;
// ──────────────────────────────────────────────────────

const FILES = ['positions.json', 'tracking_log.json', 'seen.json'];
const SSE_CLIENTS = new Set();
let lastData = null;

// ─── FETCH DARI GITHUB RAW ────────────────────────────
function fetchFromGitHub(filename) {
  return new Promise((resolve) => {
    // Tambah ?t= biar bypass CDN cache GitHub
    const url = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${filename}?t=${Date.now()}`;
    https.get(url, (res) => {
      // Ikuti redirect (301/302)
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, (r2) => {
          let body = '';
          r2.on('data', chunk => body += chunk);
          r2.on('end', () => {
            try { resolve(JSON.parse(body)); } catch { resolve(null); }
          });
        }).on('error', () => resolve(null));
        return;
      }
      if (res.statusCode !== 200) {
        console.warn('[GitHub] ' + filename + ' → HTTP ' + res.statusCode);
        resolve(null);
        return;
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) {
          console.warn('[GitHub] Parse error ' + filename + ':', e.message);
          resolve(null);
        }
      });
    }).on('error', (e) => {
      console.warn('[GitHub] Fetch error ' + filename + ':', e.message);
      resolve(null);
    });
  });
}

async function getAllData() {
  const [positions, tracking, seen] = await Promise.all([
    fetchFromGitHub('positions.json'),
    fetchFromGitHub('tracking_log.json'),
    fetchFromGitHub('seen.json'),
  ]);
  return { positions, tracking, seen, ts: Date.now() };
}

// ─── BROADCAST KE SSE CLIENTS ────────────────────────
function broadcast(data) {
  const payload = 'data: ' + JSON.stringify(data) + '\n\n';
  for (const res of SSE_CLIENTS) {
    try { res.write(payload); } catch { SSE_CLIENTS.delete(res); }
  }
}

// ─── POLLING LOOP ─────────────────────────────────────
async function poll() {
  const t = new Date().toLocaleTimeString('id-ID');
  try {
    console.log('[' + t + '] Polling GitHub...');
    const data = await getAllData();
    lastData = data;
    if (SSE_CLIENTS.size > 0) broadcast(data);
    const ok = [data.positions, data.tracking, data.seen].filter(Boolean).length;
    console.log('[' + t + '] OK (' + ok + '/3 file ditemukan, ' + SSE_CLIENTS.size + ' client aktif)');
  } catch (e) {
    console.error('[' + t + '] Poll error:', e.message);
  }
}

// Jalankan langsung, lalu ulangi setiap POLL_MS
poll();
setInterval(poll, POLL_MS);

// ─── HTTP SERVER ──────────────────────────────────────
const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', '*');

  // SSE endpoint
  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    SSE_CLIENTS.add(res);
    console.log('[SSE] Client connect (' + SSE_CLIENTS.size + ' aktif)');

    // Kirim data terakhir langsung (atau fetch baru kalau belum ada)
    const initial = lastData || await getAllData();
    if (!lastData) lastData = initial;
    res.write('data: ' + JSON.stringify(initial) + '\n\n');

    // Keepalive ping tiap 25s
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
    }, 25000);

    req.on('close', () => {
      SSE_CLIENTS.delete(res);
      clearInterval(ping);
      console.log('[SSE] Client disconnect (' + SSE_CLIENTS.size + ' aktif)');
    });
    return;
  }

  // Manual fetch endpoint
  if (url === '/data') {
    const data = lastData || await getAllData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // Serve dashboard HTML
  if (url === '/' || url === '/dashboard') {
    try {
      const html = fs.readFileSync(DASHBOARD_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('dashboard.html tidak ditemukan di: ' + DASHBOARD_FILE);
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   AUTO SCREEN DASHBOARD — SERVER AKTIF      ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('  Buka browser → http://localhost:' + PORT);
  console.log('');
  console.log('  Sumber data GitHub:');
  console.log('  https://raw.githubusercontent.com/' + GITHUB_USER + '/' + GITHUB_REPO + '/' + GITHUB_BRANCH + '/');
  console.log('');
  console.log('  Poll interval : ' + (POLL_MS / 1000) + ' detik');
  console.log('');
  console.log('  Override env  :');
  console.log('  set GITHUB_USER=username');
  console.log('  set GITHUB_REPO=nama-repo');
  console.log('  set POLL_MS=15000');
  console.log('');
  console.log('  Tekan Ctrl+C untuk stop');
  console.log('');
});
