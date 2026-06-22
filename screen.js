require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const CFG = {
  // Mode New Migration (sama seperti sebelumnya)
  minLp:           Number(process.env.MIN_LP)           || 15000,
  minVol:          Number(process.env.MIN_VOL_5M)       || 5000,
  maxRugScore:     Number(process.env.MAX_RUG_SCORE)     || 100,
  minBuyRatio:     Number(process.env.MIN_BUY_RATIO)     || 0,

  // Mode Swing 1D — filter lebih ketat
  swingMinLp:      Number(process.env.SWING_MIN_LP)      || 30000,
  swingMinVol1h:   Number(process.env.SWING_MIN_VOL1H)   || 20000,
  swingMaxChange1h: Number(process.env.SWING_MAX_CHG1H)  || 15,   // tidak sedang pump >15% per jam
  swingMaxChange24h: Number(process.env.SWING_MAX_CHG24H)|| 50,   // belum pump >50% dalam 24h
  swingVolSpikeMin: Number(process.env.SWING_VOL_SPIKE)  || 2.0,  // volume spike vs estimasi avg
  swingMinHolders: Number(process.env.SWING_MIN_HOLDERS) || 500,
  swingMinAge:     Number(process.env.SWING_MIN_AGE_H)   || 24,   // token minimal 24 jam
  swingMaxAge:     Number(process.env.SWING_MAX_AGE_H)   || 720,  // max 30 hari (720 jam)

  // Umum
  interval:        Number(process.env.POLL_INTERVAL)     || 60,
  healthInterval:  Number(process.env.HEALTH_INTERVAL)   || 3600,
  seenCleanupDays: Number(process.env.SEEN_CLEANUP_DAYS) || 7,
  tgToken:         process.env.TG_TOKEN,
  tgChatId:        process.env.TG_CHAT_ID,
  tgThreadId:      Number(process.env.TG_THREAD_ID)      || undefined,
};

if (!CFG.tgToken || !CFG.tgChatId) {
  console.error('Isi TG_TOKEN dan TG_CHAT_ID di .env');
  process.exit(1);
}

const TG_API        = 'https://api.telegram.org/bot' + CFG.tgToken + '/sendMessage';
const SEEN_FILE     = path.join(__dirname, 'seen.json');
const POSITIONS_FILE= path.join(__dirname, 'positions.json');
const LOG_FILE      = path.join(__dirname, 'screen.log');
const TRACKING_LOG  = path.join(__dirname, 'tracking_log.json');

const SEEN    = new Map();
const TRACKED = new Map();
const TARGETS = [30, 50, 100, 200, 500];
let startTime = Date.now();
let totalNotified = 0;

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function fmt(n) {
  if (!n || isNaN(n)) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'K';
  return Number(n).toFixed(2);
}

function fmtPrice(n) {
  var v = Number(n);
  if (!v || isNaN(v)) return '0';
  if (v >= 1000)     return (v / 1000).toFixed(2) + 'K';
  if (v >= 1)        return v.toFixed(4);
  if (v >= 0.0001)   return v.toFixed(6);
  if (v >= 0.000001) return v.toFixed(8);
  return v.toFixed(10);
}

function timeNow() {
  return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
}

function log(msg) {
  const line = '[' + timeNow() + '] ' + msg;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function timeAgo(ts) {
  if (!ts) return '?';
  const diff = Date.now() - ts * 1000;
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'Baru saja';
  if (mins < 60) return mins + 'm';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return hrs + 'j';
  return Math.floor(hrs / 24) + 'h';
}

function tokenAgeHours(ts) {
  if (!ts) return 0;
  return (Date.now() - ts * 1000) / 3600000;
}

// ─────────────────────────────────────────────
//  PERSISTENCE
// ─────────────────────────────────────────────
function loadSeen() {
  try {
    const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    for (const [ca, entry] of Object.entries(data.entries || {})) SEEN.set(ca, entry);
    log('Loaded ' + SEEN.size + ' seen tokens');
  } catch { log('No existing seen.json, starting fresh'); }
}

function saveSeen() {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify({
      version: 2, savedAt: Date.now(), entries: Object.fromEntries(SEEN),
    }));
  } catch (e) { log('Failed to save seen.json: ' + e.message); }
}

function cleanupSeen() {
  const cutoff = Date.now() - CFG.seenCleanupDays * 86400000;
  let deleted = 0;
  for (const [ca, entry] of SEEN) {
    if (entry.firstSeen < cutoff) { SEEN.delete(ca); deleted++; }
  }
  if (deleted > 0) { log('Cleaned up ' + deleted + ' old entries'); saveSeen(); }
}

function logTrackingEvent(event) {
  try {
    const data = [];
    try { data.push(...JSON.parse(fs.readFileSync(TRACKING_LOG, 'utf8'))); } catch {}
    data.push({ ...event, time: Date.now() });
    fs.writeFileSync(TRACKING_LOG, JSON.stringify(data));
  } catch {}
}

function loadPositions() {
  try {
    const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
    for (const [ca, entry] of Object.entries(data.entries || {})) TRACKED.set(ca, entry);
    log('Loaded ' + TRACKED.size + ' tracked positions');
  } catch { log('No existing positions.json, starting fresh'); }
}

function savePositions() {
  try {
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify({
      version: 1, savedAt: Date.now(), entries: Object.fromEntries(TRACKED),
    }));
  } catch (e) { log('Failed to save positions.json: ' + e.message); }
}

// ─────────────────────────────────────────────
//  NETWORK
// ─────────────────────────────────────────────
async function getWithRetry(url, opts, retries) {
  const maxRetries = retries ?? 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await axios.get(url, { timeout: 10000, ...(opts || {}) });
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      await new Promise(r => setTimeout(r, (i + 1) * 1000));
    }
  }
}

function fetchGmgnTrending() {
  try {
    const out = execSync(
      'npx gmgn-cli market trending --chain sol --interval 1h --limit 100 --raw',
      { encoding: 'utf8', timeout: 30000, env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY || '' } }
    );
    const d = JSON.parse(out);
    if (!d.data || !d.data.rank) return [];
    log('GMGN trending: ' + d.data.rank.length + ' tokens');
    return d.data.rank;
  } catch (e) {
    log('GMGN trending error: ' + e.message);
    return [];
  }
}

async function fetchGMGNKline(address, resolution, fromSec, toSec) {
  try {
    const host = process.env.GMGN_HOST || 'https://openapi.gmgn.ai';
    const ts   = Math.floor(Date.now() / 1000);
    const cid  = 'ax' + ts.toString(36) + Math.random().toString(36).slice(2, 10);
    const url  = host + '/v1/market/token_kline?chain=sol&address=' + address
               + '&resolution=' + resolution
               + '&from=' + Math.floor(fromSec)
               + '&to='   + Math.floor(toSec)
               + '&timestamp=' + ts + '&client_id=' + cid;
    const res  = await axios.get(url, {
      headers: { 'X-APIKEY': process.env.GMGN_API_KEY || '' },
      timeout: 10000,
    });
    return res.data?.list || null;
  } catch (e) {
    log('Kline error ' + address.slice(0, 8) + ': ' + e.message);
    return null;
  }
}

async function getRugCheck(ca) {
  try {
    const res = await getWithRetry('https://api.rugcheck.xyz/v1/tokens/' + ca + '/report', { timeout: 10000 });
    const d   = res.data;
    const riskNames = (d.risks || []).map(r => {
      const lv = r.level ? '[' + r.level.toUpperCase() + '] ' : '';
      return lv + r.name;
    });
    if (d.graphInsidersDetected > 0 && d.insiderNetworks && d.insiderNetworks.length > 0) {
      d.insiderNetworks.forEach(net => {
        const totalSupply = d.token?.supply ? Number(d.token.supply) : 0;
        const pct = totalSupply > 0 ? (net.tokenAmount / totalSupply) * 100 : 0;
        if (pct >= 10) {
          riskNames.push('[DANGER] Insider Analysis: ' + Math.round(net.tokenAmount / 1e6) + 'M tokens ('
            + pct.toFixed(0) + '% of supply) | ' + net.size + ' wallets');
        }
      });
    }
    return {
      score:           d.score || 0,
      scoreNormalised: d.score_normalised ?? -1,
      risks:           riskNames.join(', '),
      creator:         d.creator || d.owner || '?',
      topDangers:      riskNames.filter(n => /\[DANGER\]/i.test(n)).map(n => n.replace(/^\[DANGER\]\s*/i, '')),
      topWarns:        riskNames.filter(n => /\[WARN\]/i.test(n)).map(n => n.replace(/^\[WARN\]\s*/i, '')),
      tokenType:       d.tokenType || '',
      rugged:          d.rugged || false,
      deployPlatform:  d.deployPlatform || '',
    };
  } catch {
    return { score: 999, scoreNormalised: -1, risks: 'Fetch failed', creator: '?',
             topDangers: [], topWarns: [], tokenType: '', rugged: false, deployPlatform: '' };
  }
}

async function sendTelegram(msg, replyTo) {
  try {
    var payload = { chat_id: CFG.tgChatId, text: msg, parse_mode: 'HTML' };
    if (CFG.tgThreadId)  payload.message_thread_id  = CFG.tgThreadId;
    if (replyTo)         payload.reply_to_message_id = replyTo;
    var res = await axios.post(TG_API, payload, { timeout: 10000 });
    return res.data.result?.message_id || null;
  } catch (e) {
    const desc = e.response?.data?.description || e.message;
    log('TG error: ' + desc);
    return null;
  }
}

// ─────────────────────────────────────────────
//  KLASIFIKASI & SCORING
// ─────────────────────────────────────────────
function isMigratedDex(t) {
  return t.exchange && t.exchange !== 'pump';
}

function gradeToken(lp, vol, rugScore) {
  let score = 0;
  if (lp > 100000) score += 35; else if (lp > 50000) score += 25; else if (lp > 30000) score += 15;
  if (vol > 100000) score += 35; else if (vol > 50000) score += 25; else if (vol > 10000) score += 15;
  if (rugScore < 50) score += 30; else if (rugScore < 100) score += 20; else score -= 10;
  if (score >= 80) return 'GOLD';
  if (score >= 60) return 'POTENSIAL';
  return 'SKIP';
}

function calculateScore(t, rug) {
  var score = 0;
  var lp  = t.liquidity || 0;
  var vol = t.volume || 0;

  if (lp > 100000) score += 20; else if (lp > 50000) score += 15;
  else if (lp > 30000) score += 10; else if (lp > 15000) score += 5;

  if (vol > 200000) score += 20; else if (vol > 100000) score += 15;
  else if (vol > 50000) score += 10; else if (vol > 10000) score += 5;

  var totalTxn = (t.buys || 0) + (t.sells || 0);
  var buyRatio = totalTxn > 0 ? (t.buys / totalTxn) * 100 : 50;
  if (buyRatio >= 65) score += 10; else if (buyRatio >= 55) score += 7; else if (buyRatio >= 45) score += 3;

  var rs = rug.score || 999;
  if (rs < 20) score += 15; else if (rs < 50) score += 10; else if (rs < 100) score += 5; else score -= 10;

  if (t.renounced_mint === 1) score += 5;
  if (t.renounced_freeze_account === 1) score += 5;

  var burn = (t.burn_ratio || 0) * 100;
  if (burn >= 50) score += 5; else if (burn >= 20) score += 3; else if (burn >= 5) score += 1;

  var holders  = t.holder_count || 1;
  var botRatio = (t.bot_degen_count || 0) / holders;
  if (botRatio > 0.40) score -= 15; else if (botRatio > 0.25) score -= 10; else if (botRatio > 0.10) score -= 5;

  var bundler = (t.bundler_rate || 0) * 100;
  if (bundler > 30) score -= 10; else if (bundler > 20) score -= 7; else if (bundler > 10) score -= 3;

  var creatorHold = (t.dev_team_hold_rate || 0) * 100;
  if (creatorHold > 10) score -= 10; else if (creatorHold > 5) score -= 5;

  var top10 = (t.top_10_holder_rate || 0) * 100;
  if (top10 > 50) score -= 5; else if (top10 > 35) score -= 3;

  var smart = t.smart_degen_count || 0;
  if (smart >= 10) score += 5; else if (smart >= 5) score += 3; else if (smart >= 1) score += 1;

  return Math.min(100, Math.max(0, score));
}

// ─────────────────────────────────────────────
//  SWING 1D — ANALISA PRE-PUMP
// ─────────────────────────────────────────────

/**
 * Ambil kline 1D (7 candle ke belakang) untuk analisa swing.
 * Return null jika gagal atau data tidak cukup.
 */
async function fetchSwingKlines(address) {
  await new Promise(r => setTimeout(r, 500));
  const nowSec  = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - 7 * 86400; // 7 hari
  return await fetchGMGNKline(address, '1d', fromSec, nowSec);
}

/**
 * Cek apakah token memenuhi kriteria swing pre-pump.
 * Return { pass: bool, reason: string, signals: [] }
 */
async function checkSwingSignal(t) {
  const ageH      = tokenAgeHours(t.creation_timestamp);
  const change1h  = Number(t.price_change_percent1h)  || 0;
  const change24h = Number(t.price_change_percent24h) || 0;
  const lp        = t.liquidity || 0;
  const vol1h     = t.volume    || 0;
  const holders   = t.holder_count || 0;

  // — Gate 1: usia token —
  if (ageH < CFG.swingMinAge)
    return { pass: false, reason: 'Terlalu baru (' + ageH.toFixed(0) + 'j < ' + CFG.swingMinAge + 'j)' };
  if (ageH > CFG.swingMaxAge)
    return { pass: false, reason: 'Terlalu tua (' + Math.floor(ageH / 24) + 'h > ' + (CFG.swingMaxAge / 24) + 'h)' };

  // — Gate 2: LP cukup untuk swing —
  if (lp < CFG.swingMinLp)
    return { pass: false, reason: 'LP terlalu kecil ($' + fmt(lp) + ')' };

  // — Gate 3: Belum terlanjur pump —
  if (change1h > CFG.swingMaxChange1h)
    return { pass: false, reason: 'Sudah pump 1h +' + change1h.toFixed(1) + '% (FOMO)' };
  if (change24h > CFG.swingMaxChange24h)
    return { pass: false, reason: 'Sudah pump 24h +' + change24h.toFixed(1) + '% (terlambat)' };

  // — Gate 4: Volume 1h minimal —
  if (vol1h < CFG.swingMinVol1h)
    return { pass: false, reason: 'Vol 1h terlalu kecil ($' + fmt(vol1h) + ')' };

  // — Gate 5: Holder cukup (likuiditas sosial) —
  if (holders > 0 && holders < CFG.swingMinHolders)
    return { pass: false, reason: 'Holder terlalu sedikit (' + holders + ')' };

  // — Analisa kline 1D untuk konfirmasi sinyal —
  const signals = [];
  const klines  = await fetchSwingKlines(t.address);

  if (klines && klines.length >= 3) {
    const closes  = klines.map(c => Number(c.close)).filter(v => v > 0);
    const volumes = klines.map(c => Number(c.volume)).filter(v => v > 0);
    const highs   = klines.map(c => Number(c.high)).filter(v => v > 0);
    const lows    = klines.map(c => Number(c.low)).filter(v => v > 0);

    const lastClose   = closes[closes.length - 1];
    const prevClose   = closes[closes.length - 2] || lastClose;
    const lastVol     = volumes[volumes.length - 1] || 0;
    const avgVol      = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(volumes.slice(0, -1).length, 1);
    const swingHigh   = Math.max(...highs);
    const swingLow    = Math.min(...lows);
    const priceRange  = swingHigh - swingLow;

    // Sinyal 1: Volume spike di hari ini vs rata-rata
    const volSpike = avgVol > 0 ? lastVol / avgVol : 1;
    if (volSpike >= CFG.swingVolSpikeMin) {
      signals.push('Vol spike ' + volSpike.toFixed(1) + 'x rata-rata 7h');
    } else {
      return { pass: false, reason: 'Tidak ada vol spike 1D (hanya ' + volSpike.toFixed(1) + 'x)' };
    }

    // Sinyal 2: Harga dekat support (belum terlalu jauh dari bawah)
    if (priceRange > 0) {
      const posInRange = (lastClose - swingLow) / priceRange; // 0=bawah, 1=atas
      if (posInRange <= 0.45) {
        signals.push('Harga dekat support (' + (posInRange * 100).toFixed(0) + '% dari range)');
      } else if (posInRange >= 0.80) {
        // Sudah terlalu tinggi di range
        signals.push('[WARN] Harga sudah tinggi di range (' + (posInRange * 100).toFixed(0) + '%)');
      }
    }

    // Sinyal 3: Harga candle terakhir naik (green candle) — konfirmasi awal
    if (lastClose > prevClose) {
      signals.push('Green candle 1D (' + ((lastClose / prevClose - 1) * 100).toFixed(1) + '%)');
    }

    // Sinyal 4: Konsolidasi — range harga 7 hari tidak lebih dari 80% dari low
    if (swingLow > 0 && priceRange / swingLow < 0.80) {
      signals.push('Konsolidasi 7h (range ' + (priceRange / swingLow * 100).toFixed(0) + '%)');
    }

  } else {
    // Kline tidak tersedia — fallback ke sinyal dasar dari data trending
    log('Kline 1D tidak tersedia untuk ' + t.symbol + ', fallback ke sinyal dasar');
    if (vol1h >= CFG.swingMinVol1h)
      signals.push('Vol 1h cukup $' + fmt(vol1h));
    if (change1h > 0 && change1h <= CFG.swingMaxChange1h)
      signals.push('Price naik ' + change1h.toFixed(1) + '% (1h, belum FOMO)');
    if (change24h < 0)
      signals.push('Pullback 24h ' + change24h.toFixed(1) + '% (potensi reversal)');
  }

  // Minimal 1 sinyal positif harus ada
  const positiveSignals = signals.filter(s => !s.startsWith('[WARN]'));
  if (positiveSignals.length === 0)
    return { pass: false, reason: 'Tidak ada sinyal pre-pump' };

  return { pass: true, signals };
}

// ─────────────────────────────────────────────
//  FIBONACCI
// ─────────────────────────────────────────────
async function calculateFibonacci(address, price, changePct, mc, athMc, mode) {
  var p     = Number(price);
  if (!p || p <= 0) p = 0.0001;
  var floor = p * 0.1;

  // Untuk swing: pakai kline 1D (7 candle), lebih akurat
  const resolution = mode === 'SWING' ? '1d' : '1h';
  const lookback   = mode === 'SWING' ? 7 * 86400 : 86400;

  try {
    const nowSec  = Math.floor(Date.now() / 1000);
    const klines  = await fetchGMGNKline(address, resolution, nowSec - lookback, nowSec);
    if (klines && klines.length >= 3) {
      var highs      = klines.map(c => Number(c.high)).filter(v => v > 0);
      var lows       = klines.map(c => Number(c.low)).filter(v => v > 0);
      var swingHigh  = Math.max(...highs);
      var swingLow   = Math.min(...lows);
      if (swingHigh > swingLow) {
        var range = swingHigh - swingLow;
        log('Fib dari kline ' + resolution + ': H=' + swingHigh + ' L=' + swingLow);
        return {
          source: 'kline_' + resolution,
          swingHigh, swingLow,
          support: Math.max(swingHigh - range * 0.500, floor).toFixed(10),
          fair:    Math.max(swingHigh - range * 0.618, floor).toFixed(10),
          resist:  (swingHigh + range * 0.382).toFixed(10),
          sl:      Math.max(swingLow  - range * 0.272, floor * 0.5).toFixed(10),
        };
      }
    }
  } catch (e) { log('Kline fetch failed, fallback estimasi: ' + e.message); }

  // Fallback estimasi
  log('Fib fallback estimasi untuk ' + address);
  var h, l, priceIsHigh;
  if (athMc && mc && Number(athMc) > Number(mc)) {
    var ratio = Math.min(Number(athMc) / Number(mc), 20);
    h = p * ratio; l = p; priceIsHigh = false;
  } else {
    var ch = Number(changePct) || 0;
    if (ch > 0)      { h = p; l = p / (1 + ch / 100); priceIsHigh = true; }
    else if (ch < 0) { h = p / (1 + ch / 100); l = p; priceIsHigh = false; }
    else             { h = p * 1.2; l = p * 0.8; priceIsHigh = false; }
  }
  var range = h - l;
  if (range < p * 0.05) range = p * 0.1;
  if (priceIsHigh) {
    return {
      source: 'estimasi',
      swingHigh: h, swingLow: l,
      support: Math.max(h - range * 0.500, floor).toFixed(10),
      fair:    Math.max(h - range * 0.618, floor).toFixed(10),
      resist:  (h + range * 0.382).toFixed(10),
      sl:      Math.max(h - range * 1.272, floor * 0.5).toFixed(10),
    };
  } else {
    return {
      source: 'estimasi',
      swingHigh: h, swingLow: l,
      support: Math.max(l - range * 0.272, floor).toFixed(10),
      fair:    Math.max(l - range * 0.500, floor).toFixed(10),
      resist:  (l + range * 0.382).toFixed(10),
      sl:      Math.max(l - range * 0.618, floor * 0.5).toFixed(10),
    };
  }
}

// ─────────────────────────────────────────────
//  NARRATIVE DETECTION
// ─────────────────────────────────────────────
function detectNarrative(name, symbol) {
  var s = ((name || '') + ' ' + (symbol || '')).toLowerCase();
  var cat = [], tag = [];

  var animalKws = {dog:'🐕',cat:'🐱',frog:'🐸',pepe:'🐸',horse:'🐴',bird:'🐦',fish:'🐟',
    wolf:'🐺',bear:'🐻',bull:'🐂',dragon:'🐉',whale:'🐋',shark:'🦈',lion:'🦁',
    tiger:'🐯',panda:'🐼',snake:'🐍',rabbit:'🐇',turtle:'🐢',duck:'🦆',seal:'🦭',
    koala:'🐨',monkey:'🐵',gorilla:'🦍',hippo:'🦛',fox:'🦊',rat:'🐀',hamster:'🐹',
    owl:'🦉',eagle:'🦅',penguin:'🐧'};
  for (var kw in animalKws) { if (s.includes(kw)) { cat.push(animalKws[kw] + ' Animal'); tag.push(kw[0].toUpperCase() + kw.slice(1)); break; } }

  var celebKws = ['trump','musk','elon','kanye','biden','obama','hawk','pnut','taylor','kamala','vance','melania','barron'];
  for (var i = 0; i < celebKws.length; i++) { if (s.includes(celebKws[i])) { cat.push('🎭 Celebrity'); tag.push(celebKws[i][0].toUpperCase() + celebKws[i].slice(1)); break; } }

  var aiKws = ['ai','gpt','claude','agent','neural','deep','grok','chatbot','llm','tokenai','bot','predict'];
  for (var j = 0; j < aiKws.length; j++) { if (s.includes(aiKws[j]) && !cat.length) { cat.push('🤖 AI/Agent'); tag.push('AI'); break; } }

  var gameKws = ['game','play','guild','raid','arena','legends','gaming','rpg','pixel'];
  for (var k = 0; k < gameKws.length; k++) { if (s.includes(gameKws[k])) { cat.push('🎮 Gaming'); tag.push('Gaming'); break; } }

  var defiKws = ['swap','lend','borrow','stake','yield','vault','farm','defi','liquid'];
  for (var l = 0; l < defiKws.length; l++) { if (s.includes(defiKws[l])) { cat.push('🏛️ DeFi'); tag.push('DeFi'); break; } }

  var cultureKws = ['degen','based','wagmi','ngmi','fren','ser','dao','moon','lambo','wen','gm','chad','soy','normie'];
  for (var m = 0; m < cultureKws.length; m++) { if (s.includes(cultureKws[m]) && !cat.length) { cat.push('💎 Culture'); tag.push('Culture'); break; } }

  var infraKws = ['bridge','oracle','layer','protocol','infra','cross','inter'];
  for (var n = 0; n < infraKws.length; n++) { if (s.includes(infraKws[n])) { cat.push('🔧 Infra'); tag.push('Infra'); break; } }

  if (!cat.length) {
    var symDigits = (symbol || '').replace(/[^a-zA-Z]/g, '');
    if (symDigits !== (symbol || '')) { cat.push('🔄 Copycat'); tag.push('Copycat'); }
    else { cat.push('🔷 Meme'); tag.push('Meme'); }
  }
  return { category: cat[0] || '🔷 Meme', tag: tag[0] || '' };
}

// ─────────────────────────────────────────────
//  BUILD MESSAGE
// ─────────────────────────────────────────────
async function buildMsg(t, rug, grade, dex24h, mode, swingSignals) {
  var re = rug.score < 50 ? '✅' : rug.score < 100 ? '⚠️' : '🚨';
  var ve = t.volume > 100000 ? '🚀' : t.volume > 50000 ? '📈' : '📊';
  var le = t.liquidity > 100000 ? '🟢' : t.liquidity > 50000 ? '🟡' : '🔵';

  var ratio    = '?';
  var totalTxn = (t.buys || 0) + (t.sells || 0);
  if (totalTxn > 0) ratio = (t.buys / totalTxn * 100).toFixed(0) + '%';

  var age   = timeAgo(t.creation_timestamp);
  var chg1h = '';
  if (t.price_change_percent1h != null) {
    chg1h = t.price_change_percent1h > 0
      ? ' 📈 +' + Number(t.price_change_percent1h).toFixed(1) + '%'
      : ' 📉 '  + Number(t.price_change_percent1h).toFixed(1) + '%';
  }
  var chg24h = '';
  if (t.price_change_percent24h != null) {
    chg24h = t.price_change_percent24h > 0
      ? ' (+' + Number(t.price_change_percent24h).toFixed(1) + '% 24h)'
      : ' ('   + Number(t.price_change_percent24h).toFixed(1) + '% 24h)';
  }

  var linkParts = [];
  if (t.twitter_username) linkParts.push('<a href="' + t.twitter_username + '">Twitter</a>');
  if (t.website)          linkParts.push('<a href="' + t.website + '">Web</a>');
  if (t.telegram)         linkParts.push('<a href="' + t.telegram + '">TG</a>');

  var mi          = t.renounced_mint === 1 ? '✅' : '❌';
  var fr          = t.renounced_freeze_account === 1 ? '✅' : '❌';
  var hp          = t.is_honeypot === 1 ? '🚨' : '✅';
  var burnPct     = ((t.burn_ratio || 0) * 100).toFixed(1);
  var top10       = ((t.top_10_holder_rate || 0) * 100).toFixed(1);
  var bundlerPct  = ((t.bundler_rate || 0) * 100).toFixed(1);
  var snipers     = ((t.top70_sniper_hold_rate || 0) * 100).toFixed(1);
  var creatorHold = ((t.dev_team_hold_rate || 0) * 100).toFixed(1);
  var SEP         = '━━━━━━━━━━━━━━━━━━━━';

  var nar        = detectNarrative(t.name, t.symbol);
  var modeLabel  = mode === 'SWING' ? '🔄 Swing 1D' : '🆕 New Migration';
  var gradeEmoji = grade === 'GOLD' ? '🟢' : grade === 'POTENSIAL' ? '🟡' : '🔴';
  var riskLabel  = grade === 'GOLD' ? 'Grade A' : grade === 'POTENSIAL' ? 'Grade B' : 'Grade C';

  var msg = '';
  msg += gradeEmoji + ' <b>' + riskLabel + '</b> | ' + modeLabel + ' | ' + nar.category + '\n';
  msg += '<b>' + t.name + '</b> (<code>' + t.symbol + '</code>)\n';
  msg += SEP + '\n';
  msg += le + ' LP      : $' + fmt(t.liquidity) + '\n';
  msg += ve + ' Vol 1h  : $' + fmt(t.volume) + '\n';

  // Untuk swing: tampilkan Vol 24h juga jika tersedia
  if (mode === 'SWING' && dex24h && dex24h.vol24h > 0)
    msg += '📊 Vol 24h : $' + fmt(dex24h.vol24h) + '\n';

  var rugLabel   = rug.score < 50 ? 'Rendah' : rug.score < 100 ? 'Sedang' : 'Bahaya!';
  var riskLevel  = rug.scoreNormalised >= 0
    ? (rug.scoreNormalised <= 30 ? 'Good' : rug.scoreNormalised <= 60 ? 'Warning' : 'Danger') : '';
  msg += re + ' RugCheck: ' + rug.score + ' (' + rugLabel + ')';
  if (riskLevel) msg += ' | ' + riskLevel;
  if (rug.tokenType && !/unknown|deprecated/i.test(rug.tokenType)) msg += ' | ' + rug.tokenType;
  if (rug.deployPlatform && !/unknown/i.test(rug.deployPlatform)) msg += ' | ' + rug.deployPlatform;
  msg += '\n';
  if (rug.topDangers.length > 0) msg += '🚨 Danger  : ' + rug.topDangers.join(' | ') + '\n';
  if (rug.topWarns.length  > 0) msg += '⚠️ Warning : ' + rug.topWarns.join(' | ')  + '\n';
  msg += '💰 Harga   : $' + fmtPrice(t.price) + chg1h + chg24h + '\n';
  msg += '🔄 Buy/Sell: ' + (t.buys || 0) + '/' + (t.sells || 0) + ' (' + ratio + ' Buy)\n';
  msg += '📊 MC      : $' + fmt(t.market_cap) + '\n';
  if (dex24h && dex24h.dexName) msg += '🛡️ DEX     : ' + dex24h.dexName + '\n';
  msg += '⏱️ Age     : ' + age + '\n';
  msg += '👤 Creator : <code>' + rug.creator + '</code>\n';
  if (linkParts.length) msg += '🔗 Links   : ' + linkParts.join(' | ') + '\n';
  msg += SEP + '\n';

  // Swing signals khusus
  if (mode === 'SWING' && swingSignals && swingSignals.length > 0) {
    msg += '📡 <b>Sinyal Pre-Pump:</b>\n';
    swingSignals.forEach(s => { msg += '  • ' + s + '\n'; });
    msg += SEP + '\n';
  }

  msg += '🛡️ GMGN:\n';
  msg += '📋 Holders: ' + fmt(t.holder_count || 0) + '\n';
  msg += '🔍 Top10: ' + top10 + '%\n';
  msg += '🔗 Bundler: ' + bundlerPct + '%\n';
  msg += '🤖 Bots: ' + (t.bot_degen_count || 0) + '\n';
  msg += '🎯 Snipers: ' + snipers + '%\n';
  msg += '👤 Creator: ' + creatorHold + '%\n';
  msg += '♻️ Burn: ' + burnPct + '%\n';
  msg += 'Mint: ' + mi + ' | Freeze: ' + fr + ' | Honeypot: ' + hp + '\n';
  msg += 'Smart: ' + (t.smart_degen_count || 0) + ' | Sniper: ' + (t.sniper_count || 0) + ' | Bundler: ' + (t.renowned_count || 0) + '\n';
  msg += SEP + '\n';

  var f = await calculateFibonacci(t.address, t.price, t.price_change_percent1h, t.market_cap, t.history_highest_market_cap, mode);
  var fibLabel = f.source.startsWith('kline') ? 'dari candle ' + (mode === 'SWING' ? '1D' : '1h') : 'estimasi, cek chart';
  msg += '📊 Entry & Targets:\n';
  msg += '⏰ Entry   : $' + fmtPrice(t.price) + '\n';
  msg += '🎯 Target  : +30% → $' + fmtPrice(t.price * 1.3) + '\n';
  msg += '📊 Fib Level <i>(' + fibLabel + ')</i>:\n';
  msg += '🟢 Support : $' + fmtPrice(f.support) + '\n';
  msg += '⚖️  Fair    : $' + fmtPrice(f.fair) + '\n';
  msg += '🔴 Resist  : $' + fmtPrice(f.resist) + '\n';
  msg += '⛔ SL      : $' + fmtPrice(f.sl) + '\n';

  var dynScore = calculateScore(t, rug);
  msg += 'Score: ' + dynScore + '/100\n';

  // Auto-warnings
  var warnings = [];
  var currentPrice = Number(t.price);
  var supportPrice = Number(f.support);
  if (currentPrice > 0 && supportPrice > 0) {
    var pctAbove = ((currentPrice - supportPrice) / supportPrice) * 100;
    if (pctAbove > 100) warnings.push('📈 Harga ' + pctAbove.toFixed(0) + '% di atas Support — sangat rawan FOMO, tunggu pullback');
    else if (pctAbove > 50) warnings.push('📈 Harga ' + pctAbove.toFixed(0) + '% di atas Support — rawan FOMO');
  }
  if (Number(creatorHold) > 5)  warnings.push('👤 Creator hold ' + creatorHold + '% — rawan dump');
  if (Number(bundlerPct) > 20 && Number(top10) > 30) warnings.push('🔄 Bundler ' + bundlerPct + '% + Top10 ' + top10 + '% — rawan distribusi');
  if (Number(snipers) > 10)     warnings.push('🎯 Snipers ' + snipers + '% — rawan sniper activity');
  var holdCount = t.holder_count || 0;
  if (holdCount > 0 && (t.bot_degen_count / holdCount) > 0.05)
    warnings.push('🤖 Bots ' + (t.bot_degen_count / holdCount * 100).toFixed(1) + '% dari holders');
  if (t.volume && t.volume < CFG.minVol * 2)
    warnings.push('📊 Volume tipis ($' + fmt(t.volume) + ') — rawan manipulasi');
  warnings.forEach(w => { msg += '⚠️ ' + w + '\n'; });

  msg += SEP + '\n';
  msg += '<a href="https://dexscreener.com/solana/' + t.address + '">Buka Chart</a>';
  msg += ' | <a href="https://gmgn.ai/sol/token/' + t.address + '">GMGN</a>\n';
  msg += '<code>' + t.address + '</code>';

  return msg;
}

// ─────────────────────────────────────────────
//  MAIN PROCESSING LOOP
// ─────────────────────────────────────────────
async function processTokens() {
  log('========== SCREENING ==========');
  var tokens = fetchGmgnTrending();
  if (tokens.length === 0) { log('No tokens from GMGN'); return; }

  var newMigration = [];
  var swingCandidates = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.address) continue;

    const alreadySeen = SEEN.has(t.address);
    const isDex       = isMigratedDex(t);
    const ageH        = tokenAgeHours(t.creation_timestamp);

    if (!isDex) {
      log('SKIP ' + (t.symbol || '?') + ' (still ' + (t.exchange || 'pump') + ')');
      continue;
    }

    // Mode 1: New Migration — token baru (< swingMinAge jam) yang belum pernah dilihat
    if (!alreadySeen && ageH < CFG.swingMinAge) {
      newMigration.push(t);
      continue;
    }

    // Mode 2: Swing 1D — token yang sudah lebih tua, cek pre-pump signal
    // Guard tambahan: jika token sudah pernah masuk SEEN (via migration),
    // pastikan sudah berlalu minimal swingMinAge jam sejak pertama kali dilihat.
    // Ini mencegah token yang baru 16j lolos ke swing hanya karena sudah ada di SEEN.
    if (ageH >= CFG.swingMinAge && ageH <= CFG.swingMaxAge) {
      const seenEntry = SEEN.get(t.address);

      // Jangan re-notify swing yang sudah pernah dinotif sebagai swing
      if (seenEntry && seenEntry.swingNotified) continue;

      // Jika token pernah masuk SEEN sebelumnya, verifikasi usia SEEN juga sudah cukup.
      // Ini guard terhadap celah: token masuk SEEN jam ke-16, lalu siklus berikutnya
      // ageH sudah ≥ 24 dari creation_timestamp tapi belum cukup lama di SEEN.
      if (seenEntry && seenEntry.seenAt) {
        const seenAgeH = (Date.now() - seenEntry.seenAt) / 3600000;
        if (seenAgeH < CFG.swingMinAge) {
          log('SKIP [SWING] ' + (t.symbol || '?') + ' — sudah di SEEN tapi baru ' + seenAgeH.toFixed(1) + 'j (< ' + CFG.swingMinAge + 'j)');
          continue;
        }
      }

      swingCandidates.push(t);
    }
  }

  log('New Migration candidates: ' + newMigration.length);
  log('Swing 1D candidates: ' + swingCandidates.length);

  // — Proses New Migration —
  for (let i = 0; i < newMigration.length; i++) {
    const t = newMigration[i];
    const totalTxn = (t.buys || 0) + (t.sells || 0);
    if (totalTxn > 0) {
      const buyPct = (t.buys / totalTxn) * 100;
      if (buyPct < CFG.minBuyRatio) { log('SKIP [MIG] ' + t.symbol + ' (Buy ' + buyPct.toFixed(0) + '%)'); continue; }
    }
    if (t.volume < CFG.minVol)    { log('SKIP [MIG] ' + t.symbol + ' (Vol $' + t.volume + ')'); continue; }
    if (t.liquidity < CFG.minLp)  { log('SKIP [MIG] ' + t.symbol + ' (LP $' + t.liquidity + ')'); continue; }

    SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'migration' });

    try {
      const rug = await getRugCheck(t.address);
      if (rug.score > CFG.maxRugScore) { log('SKIP [MIG] ' + t.symbol + ' (Rug ' + rug.score + ')'); continue; }
      if (rug.risks.toLowerCase().includes('insider analysis')) { log('SKIP [MIG] ' + t.symbol + ' (Insider ≥10%)'); continue; }

      const grade = gradeToken(t.liquidity, t.volume, rug.score);
      if (grade === 'SKIP') { log('SKIP [MIG] ' + t.symbol); continue; }

      log('[MIG] ' + grade + ' ' + t.symbol + ' (LP:$' + t.liquidity + ' Vol:$' + t.volume + ' Rug:' + rug.score + ')');
      const msgId = await sendTelegram(await buildMsg(t, rug, grade, null, 'MIGRATION', null));
      totalNotified++;

      if (t.price && Number(t.price) > 0) {
        TRACKED.set(t.address, {
          symbol: t.symbol, name: t.name, grade, mode: 'MIGRATION',
          entryPrice: Number(t.price), entryAt: Date.now(), nextTargetIdx: 0, msgId,
        });
        log('Tracked [MIG] ' + t.symbol + ' @ $' + t.price);
      }
    } catch (e) { log('Error [MIG] ' + t.symbol + ': ' + e.message); }
  }

  // — Proses Swing 1D —
  for (let i = 0; i < swingCandidates.length; i++) {
    const t = swingCandidates[i];

    log('[SWING] Cek ' + t.symbol + ' (age ' + tokenAgeHours(t.creation_timestamp).toFixed(0) + 'j)');
    const swingResult = await checkSwingSignal(t);

    if (!swingResult.pass) {
      log('SKIP [SWING] ' + t.symbol + ': ' + swingResult.reason);
      continue;
    }

    log('[SWING] PASS ' + t.symbol + ' — signals: ' + swingResult.signals.join(', '));

    try {
      const rug = await getRugCheck(t.address);
      if (rug.score > CFG.maxRugScore) { log('SKIP [SWING] ' + t.symbol + ' (Rug ' + rug.score + ')'); continue; }
      if (rug.risks.toLowerCase().includes('insider analysis')) { log('SKIP [SWING] ' + t.symbol + ' (Insider)'); continue; }

      const grade = gradeToken(t.liquidity, t.volume, rug.score);
      if (grade === 'SKIP') { log('SKIP [SWING] ' + t.symbol + ' (Grade SKIP)'); continue; }

      // Mark sudah dinotif sebagai swing (update SEEN entry)
      const existingEntry = SEEN.get(t.address) || { firstSeen: Date.now(), seenAt: Date.now() };
      SEEN.set(t.address, { ...existingEntry, swingNotified: Date.now(), mode: 'swing' });

      log('[SWING] ' + grade + ' ' + t.symbol + ' — Kirim notif');
      const msgId = await sendTelegram(await buildMsg(t, rug, grade, null, 'SWING', swingResult.signals));
      totalNotified++;

      if (t.price && Number(t.price) > 0 && !TRACKED.has(t.address)) {
        TRACKED.set(t.address, {
          symbol: t.symbol, name: t.name, grade, mode: 'SWING',
          entryPrice: Number(t.price), entryAt: Date.now(), nextTargetIdx: 0, msgId,
        });
        log('Tracked [SWING] ' + t.symbol + ' @ $' + t.price);
      }
    } catch (e) { log('Error [SWING] ' + t.symbol + ': ' + e.message); }
  }

  saveSeen();
  savePositions();
  cleanupSeen();

  if (TRACKED.size > 0) {
    await checkTrackedPositions(tokens);
    savePositions();
  }
  log('Cycle done. Total notified: ' + totalNotified);
}

// ─────────────────────────────────────────────
//  POSITION TRACKING
// ─────────────────────────────────────────────
async function checkTrackedPositions(trendingTokens) {
  var priceMap = {};
  trendingTokens.forEach(tt => { if (tt.address && tt.price) priceMap[tt.address] = Number(tt.price); });

  var toRemove = [];
  for (const [ca, pos] of TRACKED) {
    var currentPrice = priceMap[ca];

    if (!currentPrice) {
      try {
        var ds = await axios.get('https://api.dexscreener.com/latest/dex/tokens/' + ca, { timeout: 8000 });
        var pairs = ds.data.pairs || [];
        var best  = pairs.find(p => p.priceUsd) || pairs[0] || null;
        if (best && best.priceUsd) currentPrice = Number(best.priceUsd);
      } catch {}
    }

    if (!currentPrice || currentPrice <= 0) continue;

    var gain = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    var modeLabel = pos.mode === 'SWING' ? '🔄 Swing' : '🆕 Mig';

    if (gain <= -80) {
      log(pos.symbol + ' dropped >80%, stop tracking');
      logTrackingEvent({ type: 'STOP_TRACK', ...pos, currentPrice, gain: gain.toFixed(1) });
      toRemove.push(ca);
      var gradeEmoji = pos.grade === 'GOLD' ? '🟢' : pos.grade === 'POTENSIAL' ? '🟡' : '🔴';
      var riskLabel  = pos.grade === 'GOLD' ? 'Grade A' : 'Grade B';
      await sendTelegram(
        gradeEmoji + ' 🗑️ ' + riskLabel + ' | ' + modeLabel + ' | <b>Stop Track</b> | '
        + pos.name + ' (<code>' + pos.symbol + '</code>)\n'
        + 'Drop >80% dari entry $' + pos.entryPrice.toFixed(10) + ' → $' + currentPrice.toFixed(10),
        pos.msgId
      );
      continue;
    }

    var highestIdx = -1;
    for (var ti = 0; ti < TARGETS.length; ti++) {
      if (gain >= TARGETS[ti]) highestIdx = ti;
    }
    if (highestIdx >= 0 && highestIdx >= pos.nextTargetIdx) {
      var target = TARGETS[highestIdx];
      var emoji  = target >= 100 ? '🚀' : target >= 50 ? '📈' : '⬆️';
      log(pos.symbol + ' hit target +' + target + '%');
      logTrackingEvent({ type: 'TERCAPAI', ...pos, currentPrice, target, gain: gain.toFixed(1) });
      var gradeEmoji = pos.grade === 'GOLD' ? '🟢' : pos.grade === 'POTENSIAL' ? '🟡' : '🔴';
      var riskLabel  = pos.grade === 'GOLD' ? 'Grade A' : 'Grade B';
      await sendTelegram(
        gradeEmoji + ' ' + riskLabel + ' | ' + modeLabel + ' | ' + emoji + ' <b>Target +' + target + '% Tercapai!</b>\n'
        + '<b>' + pos.name + '</b> (<code>' + pos.symbol + '</code>)\n'
        + 'Entry: $' + pos.entryPrice.toFixed(10) + '\n'
        + 'Sekarang: $' + currentPrice.toFixed(10) + '\n'
        + 'Gain: <b>+' + gain.toFixed(1) + '%</b>\n'
        + '<a href="https://dexscreener.com/solana/' + ca + '">Buka Chart</a>'
        + ' | <a href="https://gmgn.ai/sol/token/' + ca + '">GMGN</a>',
        pos.msgId
      );
      pos.nextTargetIdx = highestIdx + 1;
      savePositions();
    }
  }

  toRemove.forEach(ca => TRACKED.delete(ca));
  if (toRemove.length > 0) savePositions();
}

// ─────────────────────────────────────────────
//  HEALTH & RUN LOOP
// ─────────────────────────────────────────────
function doHealthCheck() {
  var u = Math.floor((Date.now() - startTime) / 1000);
  var h = Math.floor(u / 3600);
  var m = Math.floor((u % 3600) / 60);
  var s = u % 60;
  log('[HEALTH] ' + h + 'h ' + m + 'm ' + s + 's | Seen: ' + SEEN.size + ' | Notified: ' + totalNotified + ' | Tracked: ' + TRACKED.size);
}

async function runLoop() {
  try { await processTokens(); } catch (e) { log('FATAL: ' + e.message); }
  setTimeout(runLoop, CFG.interval * 1000);
}

process.on('SIGINT',  () => { log('Saving...'); saveSeen(); process.exit(0); });
process.on('SIGTERM', () => { log('Saving...'); saveSeen(); process.exit(0); });

log('');
log('╔══════════════════════════════════════╗');
log('║   AUTO SCREENING v6 — DUAL MODE     ║');
log('╚══════════════════════════════════════╝');
log('');
log('[ Mode 1: New Migration ]');
log('  LP > $' + CFG.minLp.toLocaleString() + ' | Vol > $' + CFG.minVol.toLocaleString() + ' | Rug < ' + CFG.maxRugScore);
log('[ Mode 2: Swing 1D Pre-Pump ]');
log('  LP > $' + CFG.swingMinLp.toLocaleString() + ' | Vol1h > $' + CFG.swingMinVol1h.toLocaleString());
log('  Max pump 1h: ' + CFG.swingMaxChange1h + '% | Max pump 24h: ' + CFG.swingMaxChange24h + '%');
log('  Vol spike min: ' + CFG.swingVolSpikeMin + 'x | Holders min: ' + CFG.swingMinHolders);
log('  Age: ' + CFG.swingMinAge + 'j – ' + CFG.swingMaxAge + 'j');
log('');
log('Interval: ' + CFG.interval + 's');
log('');

loadSeen();
loadPositions();

if (process.env.CI === 'true') {
  processTokens().then(() => process.exit(0));
} else {
  runLoop();
  setInterval(doHealthCheck, CFG.healthInterval * 1000);
}
