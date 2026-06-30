require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  shouldSkipNewMigration,
  shouldSkipMigration,
  checkBaseLiquidity,
  checkBaseAgeHours,
  checkVol1h,
  checkSwaps5m,
  checkVol5m,
} = require('./filters');

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const CFG = {
  // New Migration V2 — base gates
  minVol1h:        Number(process.env.MIN_VOL_1H)        || 60000,
  minSwaps5m:      Number(process.env.MIN_SWAPS_5M)      || 50,
  minVol5m:        Number(process.env.MIN_VOL_5M)        || 5000,
  maxAgeHours:     Number(process.env.MAX_AGE_HOURS)     || 24,

  // Mode New Migration (sama seperti sebelumnya)
  minLp:           Number(process.env.MIN_LP)           || 5000,
  minVol:          Number(process.env.MIN_VOL_5M)       || 5000,
  maxRugScore:     Number(process.env.MAX_RUG_SCORE)     || 100,
  minBuyRatio:     Number(process.env.MIN_BUY_RATIO)     || 0,

  // New Migration extra gates
  maxBundlerPct:     Number(process.env.MAX_BUNDLER_PCT)     || 25,
  maxTop10Holders:   Number(process.env.MAX_TOP10_HOLDERS)   || 25,
  maxInsiderPct:     Number(process.env.MAX_INSIDER_PCT)     || 20,
  maxDevHold:        Number(process.env.MAX_DEV_HOLD)        || 10,
  maxPriceChange1h:  Number(process.env.MAX_PRICE_CHANGE_1H) || 20,
  minHoldersMig:     Number(process.env.MIN_HOLDERS_MIG)     || 100,
  maxSniperPct:      Number(process.env.MAX_SNIPER_PCT)      || 10,
  maxVolLpRatio:     Number(process.env.MAX_VOL_LP_RATIO)    || 15,
  maxCreatorTokens:  Number(process.env.MAX_CREATOR_TOKENS) || 20,

  // Mode Swing 1D — filter lebih ketat
  swingMinLp:      Number(process.env.SWING_MIN_LP)      || 30000,
  swingMinVol1h:   Number(process.env.SWING_MIN_VOL1H)   || 20000,
  swingMaxChange1h: Number(process.env.SWING_MAX_CHG1H)  || 15,   // tidak sedang pump >15% per jam
  swingMaxChange24h: Number(process.env.SWING_MAX_CHG24H)|| 50,   // belum pump >50% dalam 24h
  swingVolSpikeMin: Number(process.env.SWING_VOL_SPIKE)  || 2.0,  // volume spike vs estimasi avg
  swingMinHolders: Number(process.env.SWING_MIN_HOLDERS) || 500,
  swingMinAge:     Number(process.env.SWING_MIN_AGE_H)   || 24,   // token minimal 24 jam
  swingMaxAge:     Number(process.env.SWING_MAX_AGE_H)   || 720,  // max 30 hari (720 jam)

  // Smart Money Signal
  signalEnabled:      isTruthyFlag(process.env.SIGNAL_ENABLED),
  tgThreadSignal:     Number(process.env.TG_THREAD_SIGNAL) || undefined,
  signalMinLiquidity: Number(process.env.SIGNAL_MIN_LIQ)   || 10000,
  signalMinHolders:   Number(process.env.SIGNAL_MIN_HOLDERS)|| 100,
  signalMaxMc:        Number(process.env.SIGNAL_MAX_MC)     || 300000,
  signalMaxTop10Rate: Number(process.env.SIGNAL_MAX_TOP10)  || 35,

  // Umum
  interval:        Number(process.env.POLL_INTERVAL)     || 60,
  healthInterval:  Number(process.env.HEALTH_INTERVAL)   || 3600,
  seenCleanupDays: Number(process.env.SEEN_CLEANUP_DAYS) || 7,
  tgToken:         process.env.TG_TOKEN,
  tgChatId:        process.env.TG_CHAT_ID,
  tgThreadId:      Number(process.env.TG_THREAD_ID)      || undefined,  // Swing 1D
  tgThreadMig:     Number(process.env.TG_THREAD_MIG)     || undefined,  // New Migration
  tgThreadEntry:   Number(process.env.TG_THREAD_ENTRY)   || undefined,  // Entry Signal
  radarBridgeUrl:  process.env.RADAR_BRIDGE_URL,
  radarBridgeSecret: process.env.RADAR_BRIDGE_SECRET,
};

if (!CFG.tgToken || !CFG.tgChatId) {
  console.error('Isi TG_TOKEN dan TG_CHAT_ID di .env');
  process.exit(1);
}

console.log('DEBUG thread SWING=' + process.env.TG_THREAD_ID + ' MIG=' + process.env.TG_THREAD_MIG);

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
  return Math.floor(hrs / 24) + 'd';
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
//  AUTO PUSH JSON KE GITHUB
// ─────────────────────────────────────────────
async function pushFileToGitHub(filename, content) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (!token) return;
  const encoded = Buffer.from(content).toString('base64');
  const url = `https://api.github.com/repos/TrymeReal/-auto-screen/contents/${filename}`;
  try {
    // Cek SHA file yang ada (diperlukan untuk update)
    let sha = null;
    try {
      const res = await axios.get(url, { headers: { Authorization: `token ${token}` }, timeout: 5000 });
      sha = res.data.sha;
    } catch {}
    await axios.put(url, {
      message: 'chore: update data [skip ci]',
      content: encoded,
      ...(sha ? { sha } : {}),
    }, { headers: { Authorization: `token ${token}` }, timeout: 10000 });
    log('[GitHub] ' + filename + ' pushed');
  } catch (e) {
    log('[GitHub] Failed to push ' + filename + ': ' + (e.response?.data?.message || e.message));
  }
}

async function pushJSONToGitHub() {
  log('[GitHub] Pushing JSON files...');
  const files = [
    { name: 'seen.json', path: SEEN_FILE },
    { name: 'positions.json', path: POSITIONS_FILE },
    { name: 'tracking_log.json', path: TRACKING_LOG },
  ];
  for (const f of files) {
    try {
      const content = fs.readFileSync(f.path, 'utf8');
      await pushFileToGitHub(f.name, content);
    } catch { log('[GitHub] ' + f.name + ' not found, skip'); }
  }
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

// Terima berbagai bentuk "ya": true, 1, "1", "true", "yes".
function isTruthyFlag(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
}

// Normalisasi item trenches → nama field yang dipakai sisa kode (sama spt trending).
// Trenches tak punya `price`/`market_cap` langsung; diturunkan dari market cap / supply.
function normalizeTrench(t) {
  const supply = Number(t.total_supply) || 0;
  const mc     = Number(t.usd_market_cap) || 0;
  return Object.assign({}, t, {
    price:              supply > 0 ? mc / supply : 0,
    market_cap:         mc,
    creation_timestamp: t.created_timestamp,
    volume:             Number(t.volume_1h) || Number(t.volume_24h) || 0,
    buys:               t.buys_24h,
    sells:              t.sells_24h,
    bundler_rate:       t.bundler_trader_amount_rate,
    rug_ratio:          Number(t.rug_ratio) || 0,
    suspected_insider_hold_rate: Number(t.suspected_insider_hold_rate) || 0,
    renounced_mint:           isTruthyFlag(t.renounced_mint) ? 1 : 0,
    renounced_freeze_account: isTruthyFlag(t.renounced_freeze_account) ? 1 : 0,
  });
}

// Sumber khusus New Migration: token yang sudah graduate ke DEX (`completed`).
// CLI sudah unwrap `.data`, jadi kategori ada di root (d.completed).
function fetchGmgnTrenches() {
  try {
    const args = [
      'market trenches',
      '--chain sol',
      '--type completed',
      '--limit 50',
      '--min-smart-degen-count 1',
      '--sort-by smart_degen_count',
      '--max-created ' + Math.round(CFG.swingMinAge * 60) + 'm',  // umur < swingMinAge jam
      '--min-liquidity ' + CFG.minLp,
      '--raw',
    ].join(' ');
    const out = execSync('npx gmgn-cli ' + args, {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY || '' },
    });
    const d = JSON.parse(out);
    // Utamakan d.completed (CLI sudah unwrap). Fallback d.data.completed kalau masih terbungkus.
    const root = (d && d.completed) ? d : (d && d.data) ? d.data : {};
    const list = root.completed || [];
    log('GMGN trenches completed: ' + list.length + ' tokens');
    return list.map(normalizeTrench);
  } catch (e) {
    log('GMGN trenches error: ' + e.message);
    return [];
  }
}

function fetchTokenInfo(address) {
  try {
    const out = execSync(
      'npx gmgn-cli token info --chain sol --address ' + address + ' --raw',
      { encoding: 'utf8', timeout: 15000, env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY || '' } }
    );
    const d = JSON.parse(out);
    return d;
  } catch (e) {
    log('Token info error ' + (address || '').slice(0, 8) + ': ' + e.message);
    return null;
  }
}

async function fetchPaidDex(address) {
  try {
    const res = await getWithRetry('https://api.dexscreener.com/latest/dex/tokens/' + address, { timeout: 8000 }, 2);
    const pairs = res.data?.pairs;
    if (!pairs || pairs.length === 0) return false;
    var hasBoost = false;
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      if (p.boosts && Number(p.boosts.active) > 0) { hasBoost = true; break; }
      if (p.labels && Array.isArray(p.labels) && p.labels.length > 0) hasBoost = true;
    }
    return hasBoost;
  } catch (e) {
    log('DEX Screener error ' + (address || '').slice(0, 8) + ': ' + e.message);
    return false;
  }
}

async function fetchDexInfo(address) {
  try {
    const res = await axios.get(
      'https://api.dexscreener.com/latest/dex/tokens/' + address,
      { timeout: 8000 }
    );

    const pair = res.data?.pairs?.[0];
    if (!pair) return null;

    return {
      hasImage:    !!pair.info?.imageUrl,
      hasWebsite:  (pair.info?.websites || []).length > 0,
      hasTwitter:  (pair.info?.socials || []).some(s => s.type === 'twitter'),
      hasTelegram: (pair.info?.socials || []).some(s => s.type === 'telegram'),
    };
  } catch {
    return null;
  }
}

function getCreatorTokenCount(walletAddress) {
  if (!walletAddress || walletAddress === '?' || walletAddress.length < 30) return 0;
  try {
    var out = execSync(
      'npx gmgn-cli portfolio created-tokens --chain sol --wallet ' + walletAddress + ' --raw',
      { encoding: 'utf8', timeout: 10000, env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY || '' } }
    );
    var data = JSON.parse(out);
    var tokens = Array.isArray(data) ? data : (data.data || []);
    return tokens.length;
  } catch (e) {
    return 0;
  }
}

function fetchGmgnSignal() {
  try {
    const out = execSync(
      'npx gmgn-cli market signal --chain sol --signal-type 12 --raw',
      { encoding: 'utf8', timeout: 30000, env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY || '' } }
    );
    const d = JSON.parse(out);
    if (!Array.isArray(d) || d.length === 0) return [];
    log('GMGN signal: ' + d.length + ' events');
    return d;
  } catch (e) {
    log('GMGN signal error: ' + e.message);
    return [];
  }
}

function normalizeSignal(signals) {
  var grouped = new Map();
  for (var i = 0; i < signals.length; i++) {
    var s = signals[i];
    if (!s.token_address || !s.data) continue;
    var existing = grouped.get(s.token_address);
    if (!existing || s.trigger_at > existing.trigger_at) {
      grouped.set(s.token_address, s);
    }
  }
  var result = [];
  for (var s of grouped.values()) {
    var d = s.data;
    var supply = Number(d.total_supply) || 0;
    var mc = Number(s.market_cap) || Number(d.usd_market_cap) || 0;
    result.push({
      address:       d.address,
      symbol:        d.symbol,
      name:          d.name,
      exchange:      d.exchange || '',
      price:         supply > 0 ? mc / supply : 0,
      market_cap:    mc,
      liquidity:     Number(d.liquidity) || 0,
      volume:        Number(d.volume_1h) || 0,
      holder_count:  Number(d.holder_count) || 0,
      top_10_holder_rate: Number(d.top_10_holder_rate) || 0,
      rug_ratio:     Number(d.rug_ratio) || 0,
      creator:       d.creator || '',
      trigger_mc:    Number(s.trigger_mc) || 0,
      trigger_at:    Number(s.trigger_at) || 0,
      signal_times:  Number(s.signal_times) || 0,
      smart_degen_wallets: d.smart_degen_wallets || [],
      smart_degen_count: Number(d.smart_degen_count) || 0,
      bot_degen_rate: Number(d.bot_degen_rate) || 0,
      bot_degen_count: Number(d.bot_degen_count) || 0,
      suspected_insider_hold_rate: Number(d.suspected_insider_hold_rate) || 0,
      bundler_rate:  Number(d.bundler_trader_amount_rate) || 0,
      sniper_count:  Number(d.sniper_count) || 0,
      dev_team_hold_rate: Number(d.dev_team_hold_rate) || 0,
      creator_created_count: Number(d.creator_created_count) || 0,
    });
  }
  return result;
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

    // Dulu cuma coba res.data.list — kalau API-nya bungkus payload di level
    // "data" (kayak endpoint trending: d.data.rank), .list bakal selalu
    // undefined dan fungsi ini diam-diam balik null tanpa error sama sekali.
    // Coba dua kemungkinan struktur sekaligus:
    const list = res.data?.list ?? res.data?.data?.list ?? null;

    if (!list || list.length < 3) {
      log('[DEBUG KLINE] ' + address.slice(0, 8)
        + ' — list: ' + (list ? list.length + ' candle' : 'null')
        + ' | raw: ' + JSON.stringify(res.data).slice(0, 400));
    }

    return list;
  } catch (e) {
    log('Kline error ' + address.slice(0, 8) + ': ' + e.message);
    return null;
  }
}

async function getRugCheck(ca, insiderThreshold) {
  try {
    const res = await getWithRetry('https://api.rugcheck.xyz/v1/tokens/' + ca + '/report', { timeout: 10000 });
    const d   = res.data;
    const riskNames = (d.risks || []).map(r => {
      const lv = r.level ? '[' + r.level.toUpperCase() + '] ' : '';
      return lv + r.name;
    });
    let maxInsiderPct = 0;
    const insThreshold = insiderThreshold || 10;
    if (d.graphInsidersDetected > 0 && d.insiderNetworks && d.insiderNetworks.length > 0) {
      d.insiderNetworks.forEach(net => {
        const totalSupply = d.token?.supply ? Number(d.token.supply) : 0;
        const pct = totalSupply > 0 ? (net.tokenAmount / totalSupply) * 100 : 0;
        if (pct > maxInsiderPct) maxInsiderPct = pct;
        if (pct >= insThreshold) {
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
      insiderPct:      maxInsiderPct,
    };
  } catch {
    return { score: 999, scoreNormalised: -1, risks: 'Fetch failed', creator: '?',
             topDangers: [], topWarns: [], tokenType: '', rugged: false, deployPlatform: '',
             insiderPct: 0 };
  }
}

async function sendTelegram(msg, replyTo, threadId) {
  try {
    var resolvedThread = threadId !== undefined ? threadId : null;
    var payload = { chat_id: CFG.tgChatId, text: msg, parse_mode: 'HTML' };
    if (resolvedThread)  payload.message_thread_id  = resolvedThread;
    if (replyTo)         payload.reply_to_message_id = replyTo;
    var res = await axios.post(TG_API, payload, { timeout: 10000 });
    return res.data.result?.message_id || null;
  } catch (e) {
    const desc = e.response?.data?.description || e.message;
    log('TG error: ' + desc);
    return null;
  }
}

async function sendRadarBridge(t, mode, extra = {}) {
  if (!CFG.radarBridgeUrl || !CFG.radarBridgeSecret) {
    log('[BRIDGE] Skip ' + mode + ' — RADAR_BRIDGE_URL/RADAR_BRIDGE_SECRET belum diset');
    return null;
  }

  if (!t || !t.address) {
    log('[BRIDGE] Skip ' + mode + ' — CA kosong');
    return null;
  }

  const top10 = t.top_10_holder_rate != null
    ? Number(t.top_10_holder_rate) * 100
    : t.stat?.top_10_holder_rate != null
      ? Number(t.stat.top_10_holder_rate) * 100
      : undefined;
  const bundlerPct = t.top_bundler_trader_percentage != null
    ? Number(t.top_bundler_trader_percentage) * 100
    : t.bundler_rate != null
      ? Number(t.bundler_rate) * 100
      : undefined;

  const payload = {
    source: 'auto-screen',
    mode,
    ca: t.address,
    symbol: t.symbol,
    name: t.name,
    grade: extra.grade,
    rugScore: extra.rugScore,
    insiderPct: extra.insiderPct,
    holders: t.holder_count,
    top10,
    bundlerPct,
    smartWallets: t.smart_degen_count || (t.smart_degen_wallets || []).length || undefined,
    socialScore: extra.socialScore,
    liquidity: t.liquidity,
    volume: t.volume,
    price: t.price
  };

  try {
    const res = await axios.post(CFG.radarBridgeUrl, payload, {
      timeout: 15000,
      headers: {
        'content-type': 'application/json',
        'x-radar-bridge-secret': CFG.radarBridgeSecret
      }
    });
    const data = res.data || {};
    const eligible = data.validation?.eligible ? 'YES' : 'NO';
    const sent = data.telegram?.sent || 0;
    const reasons = (data.validation?.reasons || []).join(' | ');
    log('[BRIDGE] ' + mode + ' ' + (t.symbol || '?') + ' eligible=' + eligible + ' sent=' + sent + (reasons ? ' — ' + reasons : ''));
    return data;
  } catch (e) {
    const desc = e.response?.data?.detail || e.response?.data?.error || e.message;
    log('[BRIDGE] Error ' + mode + ' ' + (t.symbol || '?') + ': ' + desc);
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
  // Bedakan "data holder gak tersedia" (null) vs "beneran 0 holder" — sebelumnya
  // dua-duanya numpuk jadi 0 dan gate holder jadi silently bypass tiap kali API
  // gak ngirim field ini.
  const holders   = (typeof t.holder_count === 'number') ? t.holder_count : null;

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
  if (holders !== null && holders < CFG.swingMinHolders)
    return { pass: false, reason: 'Holder terlalu sedikit (' + holders + ')' };
  if (holders === null)
    log('[SWING] ' + (t.symbol || '?') + ': holder_count tidak tersedia dari API, gate holder di-skip');

  // — Gate 6: Buy ratio minimal 50% —
  const totalTxn = (t.buys || 0) + (t.sells || 0);
  const buyRatio = totalTxn > 0 ? (t.buys / totalTxn) * 100 : 0;
  if (totalTxn > 0 && buyRatio < 50)
    return { pass: false, reason: 'Buy ratio lemah (' + buyRatio.toFixed(0) + '% buy)' };

  // — Analisa kline 1D untuk konfirmasi sinyal —
  const signals = [];
  const klines  = await fetchSwingKlines(t.address);

  if (klines && klines.length >= 3) {
    // PENTING: dulu close/volume/high/low difilter terpisah-pisah (.filter(v=>v>0)
    // masing-masing array) — kalau satu candle datanya bolong di salah satu field,
    // array jadi geser dan index gak nyambung lagi (closes[i] bisa beda hari sama
    // volumes[i]). Sekarang digabung jadi satu objek per candle dulu, baru di-filter
    // sebagai satu kesatuan, dan di-sort by time supaya gak asumsi urutan dari API
    // (kalau API ternyata ngirim terbaru-duluan, sort ini yang nyelametin logikanya).
    const candles = klines
      .map(c => ({
        time:   Number(c.time ?? c.timestamp ?? c.t ?? 0),
        close:  Number(c.close),
        high:   Number(c.high),
        low:    Number(c.low),
        volume: Number(c.volume) || 0,
      }))
      .filter(c => c.close > 0 && c.high > 0 && c.low > 0)
      .sort((a, b) => a.time - b.time);

    if (!candles.some(c => c.time > 0)) {
      log('[SWING] WARNING ' + (t.symbol || '?') + ': kline gak ada field time, urutan candle gak bisa divalidasi — cek manual response GMGN kline');
    }

    if (candles.length < 3) {
      log('Kline 1D kurang valid setelah cleanup untuk ' + t.symbol + ', fallback ke sinyal dasar');
      if (vol1h >= CFG.swingMinVol1h)
        signals.push('Vol 1h cukup $' + fmt(vol1h));
      if (change1h > 0 && change1h <= CFG.swingMaxChange1h)
        signals.push('Price naik ' + change1h.toFixed(1) + '% (1h, belum FOMO)');
      if (change24h < 0)
        signals.push('Pullback 24h ' + change24h.toFixed(1) + '% (potensi reversal)');
    } else {
      const lastCandle = candles[candles.length - 1];
      const prevCandle = candles[candles.length - 2];
      const histVols   = candles.slice(0, -1).map(c => c.volume).filter(v => v > 0);
      const avgVol      = histVols.length > 0 ? histVols.reduce((a, b) => a + b, 0) / histVols.length : 0;

      // Candle hari ini biasanya belum closed (masih real-time) — volumenya cuma
      // ngitung dari jam 00:00 sampai sekarang, bukan sehari penuh. Kalau gak
      // dinormalisasi, hasilnya tergantung jam berapa script jalan: kepagian bisa
      // ke-skip walau lagi beneran ada momentum, kemaleman bisa keliatan "spike"
      // padahal cuma akumulasi volume semalaman.
      const nowSec        = Math.floor(Date.now() / 1000);
      const dayElapsedSec = lastCandle.time ? Math.max(nowSec - lastCandle.time, 0) : 86400;
      const dayFraction   = Math.min(Math.max(dayElapsedSec / 86400, 0.1), 1); // floor 10% biar gak diekstrapolasi gila-gilaan pas hari baru mulai
      const normLastVol   = lastCandle.volume / dayFraction;

      const highs       = candles.map(c => c.high);
      const lows         = candles.map(c => c.low);
      const swingHigh   = Math.max(...highs);
      const swingLow    = Math.min(...lows);
      const priceRange  = swingHigh - swingLow;

      // Sinyal 1 (GATE wajib, bukan opsional): Volume hari ini (ternormalisasi)
      // harus spike vs rata-rata candle sebelumnya. Kalau gak ada spike, langsung
      // gagal — jadi sinyal 2/3/4 di bawah itu cuma konfirmasi tambahan, bukan
      // pengganti gate ini.
      const volSpike = avgVol > 0 ? normLastVol / avgVol : 1;
      if (volSpike < CFG.swingVolSpikeMin) {
        return { pass: false, reason: 'Tidak ada vol spike 1D (hanya ' + volSpike.toFixed(1) + 'x, hari baru ' + (dayFraction * 100).toFixed(0) + '% jalan)' };
      }
      signals.push('Vol spike ' + volSpike.toFixed(1) + 'x rata-rata (normalized, hari ' + (dayFraction * 100).toFixed(0) + '% jalan)');

      // Sinyal 2: Harga dekat support (belum terlalu jauh dari bawah)
      if (priceRange > 0) {
        const posInRange = (lastCandle.close - swingLow) / priceRange; // 0=bawah, 1=atas
        if (posInRange <= 0.45) {
          signals.push('Harga dekat support (' + (posInRange * 100).toFixed(0) + '% dari range)');
        } else if (posInRange >= 0.80) {
          // Sudah terlalu tinggi di range
          signals.push('[WARN] Harga sudah tinggi di range (' + (posInRange * 100).toFixed(0) + '%)');
        }
      }

      // Sinyal 3: Harga candle terakhir naik (green candle) — konfirmasi awal
      if (lastCandle.close > prevCandle.close) {
        signals.push('Green candle 1D (' + ((lastCandle.close / prevCandle.close - 1) * 100).toFixed(1) + '%)');
      }

      // Sinyal 4: Konsolidasi — range harga gak lebih dari 80% dari low
      if (swingLow > 0 && priceRange / swingLow < 0.80) {
        signals.push('Konsolidasi (range ' + (priceRange / swingLow * 100).toFixed(0) + '%)');
      }
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

function normalizeNarrativeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_\-./]+/g, ' ')
    .replace(/[^a-z0-9\s$]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeNarrativeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasNarrativeKeyword(text, keywords) {
  // Word-boundary match (bukan substring polos) biar 'ai' gak nyangkut di 'chain'/'claim',
  // 'test' gak nyangkut di 'fastest'/'contest', dst. \b juga aman buat ticker '$AI'.
  for (var i = 0; i < keywords.length; i++) {
    var kw = normalizeNarrativeText(keywords[i]);
    if (!kw) continue;
    var re = new RegExp('\\b' + escapeNarrativeRegex(kw) + '\\b');
    if (re.test(text)) return keywords[i];
  }
  return '';
}

function checkNewMigrationNarrative(t) {
  var name = String(t.name || '');
  var symbol = String(t.symbol || '');
  var text = normalizeNarrativeText(name + ' ' + symbol);
  var compact = normalizeNarrativeText(name + symbol).replace(/\s+/g, '');
  var generic = ['official token', 'official coin', 'new token', 'new coin', 'test', 'testing', 'token coin', 'sol token', 'pump token'];
  var buckets = [
    { label: 'KOL/Celebrity', keywords: ['ansem', 'mitch', 'murad', 'musk', 'elon', 'trump', 'kanye', 'cz', 'vitalik', 'saylor', 'taylor'] },
    { label: 'Animal', keywords: ['dog', 'cat', 'frog', 'pepe', 'wif', 'bonk', 'bull', 'bear', 'shark', 'whale', 'monkey', 'penguin', 'duck', 'rat'] },
    { label: 'AI/Agent', keywords: ['ai', 'agent', 'gpt', 'grok', 'claude', 'bot', 'robot', 'neural', 'agi', 'llm'] },
    { label: 'Gaming', keywords: ['game', 'gaming', 'pixel', 'minecraft', 'roblox', 'pokemon', 'arcade', 'arena', 'rpg'] },
    { label: 'Solana meta', keywords: ['pumpfun', 'pump fun', 'pump', 'bonk', 'jup', 'raydium', 'moonshot', 'letsbonk', 'bags'] },
    { label: 'Culture meme', keywords: ['chad', 'sigma', 'wojak', 'npc', 'based', 'fren', 'gm', 'wagmi', 'degen', 'moon', 'wen'] },
    { label: 'Brainrot', keywords: ['tung', 'sahur', 'tralalero', 'tralala', 'bombardiro', 'crocodilo', 'capuchino', 'chimpanzini', 'ballerina', 'brainrot'] },
    { label: 'Anime/Asia', keywords: ['anime', 'waifu', 'neko', 'manga', 'vtuber', 'senpai', 'kawaii', 'japan', 'china', 'korea'] },
    { label: 'Tech/Brand', keywords: ['tesla', 'apple', 'google', 'meta', 'nvidia', 'openai', 'xai', 'spacex', 'iphone'] },
  ];

  var genericHit = hasNarrativeKeyword(text, generic);
  if (genericHit) return { skip: true, reason: 'Narasi generic: ' + genericHit };
  if (/[0-9]{4,}/.test(symbol) || /[0-9]{5,}/.test(name)) return { skip: true, reason: 'Angka random di symbol/name' };
  if (compact.length >= 12 && !/[aeiou]/.test(compact)) return { skip: true, reason: 'Symbol/name susah dibaca' };

  for (var i = 0; i < buckets.length; i++) {
    var hit = hasNarrativeKeyword(text, buckets[i].keywords);
    if (hit) return { skip: false, reason: buckets[i].label + ': ' + hit, category: buckets[i].label, keyword: hit };
  }

  return { skip: true, reason: 'Narasi tidak cocok' };
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
  msg += '📋 Holders : ' + fmt(t.holder_count || 0) + '\n';
  msg += '🔍 Top10   : ' + top10 + '%\n';
  msg += '🔗 Bundler : ' + bundlerPct + '%\n';
  msg += '🤖 Bots    : ' + (t.bot_degen_count || 0) + '\n';
  msg += '🎯 Snipers : ' + snipers + '%\n';
  msg += '👤 Creator : ' + creatorHold + '%\n';
  msg += '♻️ Burn    : ' + burnPct + '%\n';
  // Mint/Freeze/Honeypot tidak ditampilkan: di sumber trenches field renounce
  // selalu kosong (tampil ❌) → misleading. Patokan keamanan pakai RugCheck.
  msg += '💎 Smart   : ' + (t.smart_degen_count || 0) + '\n';
  msg += '🌟 KOL     : ' + (t.renowned_count || 0) + '\n';
  msg += '🎯 Sniper# : ' + (t.sniper_count || 0) + '\n';
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

function buildSignalMsg(t) {
  var SEP = '━━━━━━━━━━━━━━━━━━━━';
  var re = (t.rug_ratio || 0) * 100 < 50 ? '✅' : '🚨';
  var le = t.liquidity > 50000 ? '🟢' : t.liquidity > 10000 ? '🟡' : '🔵';
  var smWallets = t.smart_degen_wallets || [];
  var totalSol = smWallets.reduce(function(a, b) { return a + (b.buy_amount || 0); }, 0);
  var avgSol = smWallets.length > 0 ? (totalSol / smWallets.length).toFixed(1) : '0';
  var msg = '';
  msg += '🔔 <b>SMART MONEY SIGNAL</b>\n';
  msg += '<b>' + (t.name || t.symbol) + '</b> (<code>' + t.symbol + '</code>)\n';
  msg += SEP + '\n';
  msg += le + ' LP      : $' + fmt(t.liquidity) + '\n';
  msg += '💎 SM Buy  : ' + smWallets.length + ' wallets (total ' + totalSol.toFixed(0) + ' SOL, rata2 ' + avgSol + ' SOL)\n';
  msg += '📊 MC trig : $' + fmt(t.trigger_mc) + '\n';
  msg += '📊 MC skrg : $' + fmt(t.market_cap) + '\n';
  msg += re + ' Rug     : ' + Math.round((t.rug_ratio || 0) * 100) + '\n';
  msg += '👥 Holders : ' + (t.holder_count || 0) + ' | 🤖 Bot ' + ((t.bot_degen_rate || 0) * 100).toFixed(0) + '%\n';
  msg += '🔍 Top10   : ' + ((t.top_10_holder_rate || 0) * 100).toFixed(1) + '%\n';
  msg += SEP + '\n';
  msg += '<a href="https://dexscreener.com/solana/' + t.address + '">Chart</a>';
  msg += ' | <a href="https://gmgn.ai/sol/token/' + t.address + '">GMGN</a>\n';
  msg += '<code>' + t.address + '</code>';
  return msg;
}

// ─────────────────────────────────────────────
//  MAIN PROCESSING LOOP
// ─────────────────────────────────────────────
async function processTokens() {
  log('========== SCREENING ==========');
  // Dua sumber terpisah: trenches `completed` untuk New Migration, trending untuk Swing 1D.
  var migrationTokens = fetchGmgnTrenches();
  var swingTokens     = fetchGmgnTrending();

  var newMigration = [];
  var swingCandidates = [];

  // — Klasifikasi New Migration (sumber: trenches completed) —
  for (let i = 0; i < migrationTokens.length; i++) {
    const t = migrationTokens[i];
    if (!t.address) continue;
    if (SEEN.has(t.address)) continue;          // belum pernah dilihat
    if (!isMigratedDex(t)) continue;            // pastikan sudah di DEX (bukan masih pump)
    // umur < maxAgeHours sudah dijamin server (--max-created), cek lagi sbg pengaman
    if (tokenAgeHours(t.creation_timestamp) >= CFG.maxAgeHours) continue;
    newMigration.push(t);
  }

  // — Klasifikasi Swing 1D (sumber: trending) —
  for (let i = 0; i < swingTokens.length; i++) {
    const t = swingTokens[i];
    if (!t.address) continue;

    const isDex = isMigratedDex(t);
    const ageH  = tokenAgeHours(t.creation_timestamp);

    if (!isDex) {
      log('SKIP ' + (t.symbol || '?') + ' (still ' + (t.exchange || 'pump') + ')');
      continue;
    }

    // Token yang sudah lebih tua (≥ swingMinAge), cek pre-pump signal.
    if (ageH >= CFG.swingMinAge && ageH <= CFG.swingMaxAge) {
      const seenEntry = SEEN.get(t.address);

      // Jangan re-notify swing yang sudah pernah dinotif sebagai swing
      if (seenEntry && seenEntry.swingNotified) continue;

      // Jika token pernah masuk SEEN sebelumnya, verifikasi usia SEEN juga sudah cukup.
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

  // — Smart Money Signal (sumber: signal endpoint) —
  var signalTokens = CFG.signalEnabled ? fetchGmgnSignal() : [];
  var signalCandidates = normalizeSignal(signalTokens);
  // Skip token yg udah pernah dilihat (dari mode manapun)
  var uniqueSignal = [];
  for (var i = 0; i < signalCandidates.length; i++) {
    if (!SEEN.has(signalCandidates[i].address)) uniqueSignal.push(signalCandidates[i]);
  }

  log('New Migration candidates: ' + newMigration.length);
  log('Swing 1D candidates: ' + swingCandidates.length);
  log('Signal candidates: ' + uniqueSignal.length);

  // — Proses New Migration V2 (6 base gates only) —
  for (let i = 0; i < newMigration.length; i++) {
    const t = newMigration[i];

    // Fetch token info untuk data 5m/1h
    log('[MIG] Fetch info ' + t.symbol + '...');
    const tokenInfo = fetchTokenInfo(t.address);
    if (!tokenInfo) {
      log('SKIP [MIG] ' + t.symbol + ' (Gagal fetch token info)');
      continue;
    }

    // Gunakan filter baru untuk cek LP, age, vol1h, swaps5m, vol5m
    var migCfg = {
      minLp:        CFG.minLp,
      maxAgeHours:  CFG.maxAgeHours,
      minVol1h:     CFG.minVol1h,
      minSwaps5m:   CFG.minSwaps5m,
      minVol5m:     CFG.minVol5m,
    };
    var migResult = shouldSkipNewMigration(t, tokenInfo, migCfg);
    if (migResult.skip) {
      log('SKIP [MIG] ' + t.symbol + ' (' + migResult.reason + ')');
      continue;
    }

    // Filter ketat (bundler/top10/devhold/priceChg/holders/sniper/volLP) — sebelumnya
    // disiapin di CFG tapi gak pernah dipanggil. Dipasang di sini sebelum narrative
    // check biar token yang gagal ke-skip lebih awal (hemat call RugCheck/DexScreener).
    var migCfgStrict = {
      minBuyRatio:      CFG.minBuyRatio,
      minVol:           CFG.minVol,
      minLp:            CFG.minLp,
      maxBundlerPct:    CFG.maxBundlerPct,
      maxTop10Holders:  CFG.maxTop10Holders,
      maxDevHold:       CFG.maxDevHold,
      maxPriceChange1h: CFG.maxPriceChange1h,
      minHolders:       CFG.minHoldersMig,
      maxSniperPct:     CFG.maxSniperPct,
      maxVolLpRatio:    CFG.maxVolLpRatio,
      maxRugScore:      CFG.maxRugScore,
      maxInsiderPct:    CFG.maxInsiderPct,
    };
    var migResultStrict = shouldSkipMigration(t, migCfgStrict);
    if (migResultStrict.skip) {
      log('SKIP [MIG] ' + t.symbol + ' (' + migResultStrict.reason + ')');
      continue;
    }

    var narrativeGate = checkNewMigrationNarrative(t);
    if (narrativeGate.skip) {
      log('SKIP [MIG] ' + t.symbol + ' (' + narrativeGate.reason + ')');
      continue;
    }
    log('[MIG] Narasi OK ' + t.symbol + ' (' + narrativeGate.reason + ')');

    // Gate: Social Score via DEX Screener (wajib min 1: Twitter/Website/Telegram).
    // Kalau DexScreener belum index token (dexInfo null) — itu masalah timing data,
    // BUKAN bukti token tanpa sosial — jadi token tetap diloloskan biar gak
    // kehilangan entry fresh. Gate sosial hanya menghukum token yang DATANYA ADA
    // tapi beneran 0 sosial.
    log('[MIG] Cek Social Score ' + t.symbol + '...');
    const dexInfo = await fetchDexInfo(t.address);

    let socialScore = 0;
    if (dexInfo) {
      if (dexInfo.hasImage)    socialScore++;
      if (dexInfo.hasWebsite)  socialScore++;
      if (dexInfo.hasTwitter)  socialScore++;
      if (dexInfo.hasTelegram) socialScore++;

      if (!(dexInfo.hasTwitter || dexInfo.hasWebsite || dexInfo.hasTelegram)) {
        log('SKIP [MIG] ' + t.symbol + ' (No Social — butuh min 1: Twitter/Website/TG) [Score:' + socialScore + '/4]');
        continue;
      }
    } else {
      log('[MIG] ' + t.symbol + ' — DexScreener belum index, gate sosial di-skip (Social:?/4)');
    }

    // Cek paid DEX via DEX Screener API
    log('[MIG] Cek paid DEX ' + t.symbol + '...');
    var paidDex = await fetchPaidDex(t.address);
    if (!paidDex) {
      log('SKIP [MIG] ' + t.symbol + ' (Belum paid DEX)');
      continue;
    }

    // RugCheck — filter identik dengan Swing 1D
    log('[MIG] Cek RugCheck ' + t.symbol + '...');
    const rug = await getRugCheck(t.address, CFG.maxInsiderPct);
    if (rug.score > CFG.maxRugScore) {
      log('SKIP [MIG] ' + t.symbol + ' (Rug ' + rug.score + ' > ' + CFG.maxRugScore + ')');
      SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'migration', lockedReason: 'rug_score' });
      continue;
    }
    if (rug.insiderPct > CFG.maxInsiderPct) {
      log('SKIP [MIG] ' + t.symbol + ' (Insider ' + rug.insiderPct.toFixed(0) + '% > ' + CFG.maxInsiderPct + '%)');
      continue;
    }

    var vol1h = Number(tokenInfo?.price?.volume_1h) || t.volume || 0;
    // Update t.volume dengan volume_1h dari token info (untuk notifikasi)
    t.volume = vol1h;
    const grade = gradeToken(t.liquidity, t.volume, rug.score);
    if (grade === 'SKIP') {
      log('SKIP [MIG] ' + t.symbol + ' (Grade SKIP — LP/Vol terlalu kecil)');
      continue;
    }

    SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'migration' });

    log('[MIG] ' + grade + ' ' + t.symbol + ' (LP:$' + fmt(t.liquidity) + ' Vol1h:$' + fmt(vol1h) + ' Rug:' + rug.score + ' Insider:' + rug.insiderPct.toFixed(0) + '% Paid:✅ Social:' + (dexInfo ? socialScore + '/4' : '?/4') + ')');
    const fullMsg = await buildMsg(t, rug, grade, null, 'MIGRATION', null);
    const msgId   = await sendTelegram(fullMsg, null, CFG.tgThreadMig);
    await sendRadarBridge(t, 'MIGRATION', {
      grade,
      rugScore: rug.score,
      insiderPct: rug.insiderPct,
      socialScore: dexInfo ? socialScore : undefined
    });
    totalNotified++;

    if (t.price && Number(t.price) > 0) {
      TRACKED.set(t.address, {
        symbol: t.symbol, name: t.name, grade, mode: 'MIGRATION',
        entryPrice: Number(t.price), entryAt: Date.now(), nextTargetIdx: 0, msgId,
        threadId: CFG.tgThreadMig,
      });
      log('Tracked [MIG] ' + t.symbol + ' @ $' + t.price);
    }
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
      const rug = await getRugCheck(t.address, CFG.maxInsiderPct);
      if (rug.score > CFG.maxRugScore) { log('SKIP [SWING] ' + t.symbol + ' (Rug ' + rug.score + ')'); continue; }
      if (rug.insiderPct > CFG.maxInsiderPct) { log('SKIP [SWING] ' + t.symbol + ' (Insider ' + rug.insiderPct.toFixed(0) + '%)'); continue; }

      const grade = gradeToken(t.liquidity, t.volume, rug.score);
      if (grade === 'SKIP') { log('SKIP [SWING] ' + t.symbol + ' (Grade SKIP)'); continue; }

      // Mark sudah dinotif sebagai swing (update SEEN entry)
      const existingEntry = SEEN.get(t.address) || { firstSeen: Date.now(), seenAt: Date.now() };
      SEEN.set(t.address, { ...existingEntry, swingNotified: Date.now(), mode: 'swing' });

      log('[SWING] ' + grade + ' ' + t.symbol + ' — Kirim notif');
      const fullMsg = await buildMsg(t, rug, grade, null, 'SWING', swingResult.signals);
      const msgId   = await sendTelegram(fullMsg, null, CFG.tgThreadId);
      await sendRadarBridge(t, 'SWING', {
        grade,
        rugScore: rug.score,
        insiderPct: rug.insiderPct
      });
      totalNotified++;

      if (t.price && Number(t.price) > 0 && !TRACKED.has(t.address)) {
        TRACKED.set(t.address, {
          symbol: t.symbol, name: t.name, grade, mode: 'SWING',
          entryPrice: Number(t.price), entryAt: Date.now(), nextTargetIdx: 0, msgId,
          threadId: CFG.tgThreadId,
        });
        log('Tracked [SWING] ' + t.symbol + ' @ $' + t.price);
      }
    } catch (e) { log('Error [SWING] ' + t.symbol + ': ' + e.message); }
  }

  // — Proses Smart Money Signal —
  for (var i = 0; i < uniqueSignal.length; i++) {
    var t = uniqueSignal[i];
    if (!t.address) continue;

    // Gate 1: SM masih pegang — cek awal karena paling sering kena
    if (t.smart_degen_count < 1) {
      log('SKIP [SIGNAL] ' + t.symbol + ' (SM udah gak pegang — count 0)');
      continue;
    }
    // Gate 3: trigger_mc (cegah token udah pump)
    if (t.trigger_mc > CFG.signalMaxMc) {
      log('SKIP [SIGNAL] ' + t.symbol + ' (MC trig $' + fmt(t.trigger_mc) + ' > $' + fmt(CFG.signalMaxMc) + ')');
      continue;
    }
    // Gate 4: liquidity
    if (t.liquidity < CFG.signalMinLiquidity) {
      log('SKIP [SIGNAL] ' + t.symbol + ' (LP $' + fmt(t.liquidity) + ' < $' + fmt(CFG.signalMinLiquidity) + ')');
      continue;
    }
    // Gate 5: holder count
    if (t.holder_count < CFG.signalMinHolders) {
      log('SKIP [SIGNAL] ' + t.symbol + ' (Holders ' + t.holder_count + ' < ' + CFG.signalMinHolders + ')');
      continue;
    }
    // Gate 6: top10 holder
    var top10Pct = (t.top_10_holder_rate || 0) * 100;
    if (top10Pct > CFG.signalMaxTop10Rate) {
      log('SKIP [SIGNAL] ' + t.symbol + ' (Top10 ' + top10Pct.toFixed(1) + '% > ' + CFG.signalMaxTop10Rate + '%)');
      continue;
    }
    // Gate 7: rug ratio
    var rugScore = Math.round((t.rug_ratio || 0) * 100);
    if (rugScore > CFG.maxRugScore) {
      log('SKIP [SIGNAL] ' + t.symbol + ' (Rug ' + rugScore + ')');
      SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'signal', lockedReason: 'rug_score' });
      continue;
    }
    // Gate 8: bot degen rate
    var botPct = (t.bot_degen_rate || 0) * 100;
    if (botPct > 50) {
      log('SKIP [SIGNAL] ' + t.symbol + ' (Bot ' + botPct.toFixed(1) + '% dari holders > 50%)');
      continue;
    }
    // Gate 9: serial creator
    if (t.creator_created_count > CFG.maxCreatorTokens) {
      log('SKIP [SIGNAL] ' + t.symbol + ' (Creator bikin ' + t.creator_created_count + ' token > ' + CFG.maxCreatorTokens + ')');
      continue;
    }

    SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'signal' });

    log('[SIGNAL] ' + t.symbol + ' (LP:$' + fmt(t.liquidity) + ' Holders:' + t.holder_count + ' Rug:' + rugScore + ')');
    var fullMsg = buildSignalMsg(t);
    var msgId = await sendTelegram(fullMsg, null, CFG.tgThreadSignal);
    await sendRadarBridge(t, 'SMART_MONEY', {
      grade: 'SIGNAL',
      rugScore,
      insiderPct: (t.suspected_insider_hold_rate || 0) * 100
    });
    totalNotified++;
    // Delay 1.5s antar notif signal biar gak kena TG rate limit
    await new Promise(r => setTimeout(r, 1500));

    if (t.price && Number(t.price) > 0) {
      TRACKED.set(t.address, {
        symbol: t.symbol, name: t.name, grade: 'SIGNAL', mode: 'SIGNAL',
        entryPrice: Number(t.price), entryAt: Date.now(), nextTargetIdx: 0, msgId,
        threadId: CFG.tgThreadSignal,
      });
      log('Tracked [SIGNAL] ' + t.symbol + ' @ $' + t.price);
    }
  }

  saveSeen();
  savePositions();
  cleanupSeen();

  if (TRACKED.size > 0) {
    await checkTrackedPositions(migrationTokens.concat(swingTokens));
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
      var wasProfit   = (pos.nextTargetIdx || 0) > 0;
      var stopLabel   = wasProfit ? '📉 Stop Track (Was Profit)' : '🗑️ Stop Track';
      var stopType    = wasProfit ? 'STOP_TRACK_WAS_PROFIT' : 'STOP_TRACK';
      log(pos.symbol + ' dropped >80%, stop tracking' + (wasProfit ? ' [was profit]' : ''));
      logTrackingEvent({ type: stopType, ...pos, currentPrice, gain: gain.toFixed(1) });
      toRemove.push(ca);
      var gradeEmoji = pos.grade === 'GOLD' ? '🟢' : pos.grade === 'POTENSIAL' ? '🟡' : '🔴';
      var riskLabel  = pos.grade === 'GOLD' ? 'Grade A' : pos.grade === 'POTENSIAL' ? 'Grade B' : 'Grade C';
      var safeThread = pos.threadId || (pos.mode === 'SWING' ? CFG.tgThreadId : CFG.tgThreadMig);
      await sendTelegram(
        gradeEmoji + ' ' + riskLabel + ' | ' + modeLabel + ' | <b>' + stopLabel + '</b> | '
        + pos.name + ' (<code>' + pos.symbol + '</code>)\n'
        + 'Drop >80% dari entry $' + pos.entryPrice.toFixed(10) + ' → $' + currentPrice.toFixed(10),
        pos.msgId,
        safeThread
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
      var riskLabel  = pos.grade === 'GOLD' ? 'Grade A' : pos.grade === 'POTENSIAL' ? 'Grade B' : 'Grade C';
      var safeThread = pos.threadId || (pos.mode === 'SWING' ? CFG.tgThreadId : CFG.tgThreadMig);
      await sendTelegram(
        gradeEmoji + ' ' + riskLabel + ' | ' + modeLabel + ' | ' + emoji + ' <b>Target +' + target + '% Tercapai!</b>\n'
        + '<b>' + pos.name + '</b> (<code>' + pos.symbol + '</code>)\n'
        + 'Entry: $' + pos.entryPrice.toFixed(10) + '\n'
        + 'Sekarang: $' + currentPrice.toFixed(10) + '\n'
        + 'Gain: <b>+' + gain.toFixed(1) + '%</b>\n'
        + '<a href="https://dexscreener.com/solana/' + ca + '">Buka Chart</a>'
        + ' | <a href="https://gmgn.ai/sol/token/' + ca + '">GMGN</a>',
        pos.msgId,
        safeThread
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
log('║   AUTO SCREENING v6 — TRIPLE MODE   ║');
log('╚══════════════════════════════════════╝');
log('');
log('[ Mode 1: New Migration ]');
log('  LP > $' + CFG.minLp.toLocaleString() + ' | Vol > $' + CFG.minVol.toLocaleString() + ' | Rug < ' + CFG.maxRugScore + ' [RugCheck API]');
log('  Insider < ' + CFG.maxInsiderPct + '% [RugCheck API] | Grade SKIP otomatis dibuang');
log('  Bundler < ' + CFG.maxBundlerPct + '% | Top10 < ' + CFG.maxTop10Holders + '% (display GMGN)');
log('  CreatorHold < ' + CFG.maxDevHold + '% | PriceChg1h < ' + CFG.maxPriceChange1h + '%');
log('  Holders > ' + CFG.minHoldersMig + ' | Sniper < ' + CFG.maxSniperPct + '% | Vol/LP < ' + CFG.maxVolLpRatio + 'x');
log('  Creator tokens < ' + CFG.maxCreatorTokens + ' (serial creator check)');
log('[ Mode 2: Swing 1D Pre-Pump ]');
log('  LP > $' + CFG.swingMinLp.toLocaleString() + ' | Vol1h > $' + CFG.swingMinVol1h.toLocaleString());
log('  Max pump 1h: ' + CFG.swingMaxChange1h + '% | Max pump 24h: ' + CFG.swingMaxChange24h + '%');
log('  Vol spike min: ' + CFG.swingVolSpikeMin + 'x | Holders min: ' + CFG.swingMinHolders);
log('  Age: ' + CFG.swingMinAge + 'j – ' + CFG.swingMaxAge + 'j');
if (CFG.signalEnabled) {
  log('[ Mode 3: Smart Money Signal ]');
  log('  LP > $' + CFG.signalMinLiquidity.toLocaleString() + ' | Holders > ' + CFG.signalMinHolders);
  log('  Top10 < ' + CFG.signalMaxTop10Rate + '% | MC trig < $' + fmt(CFG.signalMaxMc));
  log('  SM count > 0 | Bot < 50% | Creator token < ' + CFG.maxCreatorTokens);
}
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
  setTimeout(() => pushJSONToGitHub(), 60 * 1000); // push pertama setelah 1 menit
  setInterval(() => pushJSONToGitHub(), 10 * 60 * 1000); // push tiap 10 menit
}
