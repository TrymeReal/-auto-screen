require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
// screen_github.js TIDAK melakukan transaksi on-chain beneran (tidak butuh wallet/RPC/private key).
// buyToken/sellToken di sini SELALU simulasi — dipakai cuma buat kalkulasi
// notifikasi (Area Entri / Target Tercapai / Stop Track) berdasarkan filter & harga,
// sama seperti screen_sync.js versi DRY_RUN. Eksekusi transaksi beneran cuma ada di screen_sync.js (lokal).
function setDryRun() { /* no-op — versi GitHub selalu simulasi */ }
async function buyToken() {
  return { success: true, txSignature: null, simulated: true };
}
async function sellToken(ca, tokenAmount, tokenDecimals, slippageBps, estValueUsd) {
  return { success: true, txSignature: null, solReceived: null, simulated: true };
}
// screen_github.js tidak punya birdeye.js (BIRDEYE_API_KEY tidak dipakai di versi ini).
// Selalu return null → kode otomatis fallback ke GMGN kline (sudah ada try/catch + fallback bawaan).
async function calculateFibFromBirdeye() { return null; }
const {
  collectMigrationHardRiskReasons,
  checkBaseLiquidity,
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
  minSwaps5m:      Number(process.env.MIN_SWAPS_5M)      || 40,
  minVol5m:        Number(process.env.MIN_VOL_5M)        || 5000,
  // Mode New Migration (sama seperti sebelumnya)
  minLp:           Number(process.env.MIN_LP)           || 15000,
  minVol:          Number(process.env.MIN_VOL_5M)       || 5000,
  maxRugScore:     Number(process.env.MAX_RUG_SCORE)     || 100,
  // GMGN dedicated rug_ratio (dari `gmgn-cli token security` / field rug_ratio yang udah kebawa
  // di trenches & trending). Skala 0-1 (0.25 = 25%). Default 0.30 = skip kalau rug_ratio > 30%.
  gmgnRugMaxRatio: process.env.GMGN_RUG_MAX_RATIO !== undefined ? Number(process.env.GMGN_RUG_MAX_RATIO) : 0.30,

  // New Migration extra gates
  maxBundlerPct:     Number(process.env.MAX_BUNDLER_PCT)     || 15,
  maxTop10Holders:   Number(process.env.MAX_TOP10_HOLDERS)   || 25,
  maxInsiderPct:     Number(process.env.MAX_INSIDER_PCT)     || 20,
  maxDevHold:        Number(process.env.MAX_DEV_HOLD)        || 10,
  maxSniperPct:      Number(process.env.MAX_SNIPER_PCT)      || 10,
  maxVolLpRatio:     Number(process.env.MAX_VOL_LP_RATIO)    || 15,
  maxCreatorTokens:  Number(process.env.MAX_CREATOR_TOKENS) || 20,
  // TIGHT mode MIGRATION — env-configurable fib zone & momentum
  migTightFibUpper:        Number(process.env.AUTO_BUY_MIG_TIGHT_FIB_UPPER)    || 0.5,
  migTightFibLower:        Number(process.env.AUTO_BUY_MIG_TIGHT_FIB_LOWER)    || 0.786,
  migTightMinBuyRatio:     Number(process.env.AUTO_BUY_MIG_TIGHT_MIN_BUY_RATIO)|| 51,
  migTightRequireMomentum: process.env.AUTO_BUY_MIG_TIGHT_REQUIRE_MOMENTUM !== 'false',
  // Fibonacci — Birdeye zigzag major swing (% reversal minimal biar dianggap "major")
  fibZigzagThresholdMig:   Number(process.env.FIB_ZIGZAG_THRESHOLD_MIG)   || 35,
  fibZigzagThresholdSwing: Number(process.env.FIB_ZIGZAG_THRESHOLD_SWING) || 12,

  // Mode Swing 1D — filter lebih ketat
  swingMinLp:      Number(process.env.SWING_MIN_LP)      || 30000,
  swingMinVol24h:  Number(process.env.SWING_MIN_VOL24H)  || 450000,
  swingMaxChange1h: Number(process.env.SWING_MAX_CHG1H)  || 15,   // tidak sedang pump >15% per jam
  swingMaxChange24h: Number(process.env.SWING_MAX_CHG24H)|| 50,   // belum pump >50% dalam 24h
  swingVolSpikeMin: Number(process.env.SWING_VOL_SPIKE)  || 2.0,  // volume spike vs estimasi avg
  swingMinHolders: Number(process.env.SWING_MIN_HOLDERS) || 500,
  swingMinAge:     Number(process.env.SWING_MIN_AGE_H)   || 24,   // token minimal 24 jam
  // New Migration — jeda kecil setelah migrasi ke DEX, biar data LP/vol sempet settle
  // (BUKAN filter kualitas seperti swingMinAge, cuma buffer data — jadi satuannya menit)
  migMinAgeMin:    Number(process.env.MIG_MIN_AGE_MIN)    || 2,    // menit
  // New Migration — batas umur MAKSIMAL, biar token yang udah gak "fresh"
  // (momentum awal migrasi udah lewat) gak ikut masuk kandidat.
  migMaxAgeH:      Number(process.env.MIG_MAX_AGE_H)      || 24,   // jam

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
  autoBuyWaitEntryMaxMin: Number(process.env.AUTO_BUY_WAIT_ENTRY_MAX_MIN) || 30,
  tgToken:         process.env.TG_TOKEN,
  tgChatId:        process.env.TG_CHAT_ID,
  telegramNotificationsEnabled: process.env.TELEGRAM_NOTIFICATIONS_ENABLED !== 'false',
  tgThreadId:      Number(process.env.TG_THREAD_ID)      || undefined,  // Swing 1D
  tgThreadMig:     Number(process.env.TG_THREAD_MIG)     || undefined,  // New Migration
  tgThreadEntry:   Number(process.env.TG_THREAD_ENTRY)   || undefined,  // Entry Signal
  tgThreadAuto:    Number(process.env.TG_THREAD_AUTO)    || undefined,  // Autobuy / Autosell
};

const AUTO_BUY = {
  ENABLED:      process.env.AUTO_BUY_ENABLED === 'true' || false,
  DRY_RUN:      process.env.AUTO_BUY_DRY_RUN !== 'false',
  AMOUNT_SOL:   Number(process.env.AUTO_BUY_AMOUNT)     || 0.01,
  MAX_PER_CYCLE:Number(process.env.AUTO_BUY_MAX_PER)    || 3,
  SLIPPAGE_BPS: Number(process.env.AUTO_BUY_SLIPPAGE)   || 500,
  ONLY_GRADE:   process.env.AUTO_BUY_GRADE             || 'ALL',
  MODES:        process.env.AUTO_BUY_MODES             || 'SWING',
  MIG_ENTRY_MODE: normalizeMigEntryMode(process.env.AUTO_BUY_MIG_ENTRY_MODE),
};
setDryRun(AUTO_BUY.DRY_RUN);

const AUTO_SELL_TP_MODE = normalizeEnvChoice(process.env.AUTO_SELL_TP_MODE, ['FIXED', 'TRAILING', 'OFF'], 'FIXED');

const AUTO_SELL = {
  ENABLED:     process.env.AUTO_SELL_ENABLED !== 'false',
  TP_MODE: AUTO_SELL_TP_MODE,
  TRAILING_ENABLED: AUTO_SELL_TP_MODE === 'TRAILING',
  FIXED_TP_ENABLED: AUTO_SELL_TP_MODE === 'FIXED',
  FIXED_TP_PCT: Number(process.env.AUTO_SELL_FIXED_TP_PCT ?? process.env.AUTO_SELL_SIGNAL_TP_PCT) || 30,
  CUTLOSS_PCT: Number(process.env.AUTO_SELL_CUTLOSS_PCT) || 50,
  TRAILING_START_PCT: Number(process.env.AUTO_SELL_TRAILING_START_PCT || process.env.AUTO_SELL_TP_PCT) || 30,
  TRAILING_DROP_PCT:  Number(process.env.AUTO_SELL_TRAILING_DROP_PCT) || 15,
  SLIPPAGE_BPS:Number(process.env.AUTO_SELL_SLIPPAGE)   || 500,
};

function formatAutoSellPlan() {
  if (!AUTO_SELL.ENABLED) return 'AutoSell: OFF';
  var tpPlan = AUTO_SELL.TP_MODE === 'FIXED'
    ? 'Fixed TP +' + AUTO_SELL.FIXED_TP_PCT + '%'
    : AUTO_SELL.TP_MODE === 'TRAILING'
      ? 'Trailing start +' + AUTO_SELL.TRAILING_START_PCT + '% drop ' + AUTO_SELL.TRAILING_DROP_PCT + '%'
      : 'TP OFF';
  return 'AutoSell: ' + tpPlan + ' | Cutloss -' + AUTO_SELL.CUTLOSS_PCT + '%';
}

const NOTIF_ONLY_AUTO = process.env.NOTIF_ONLY_AUTO !== 'false';

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
let boughtThisCycle = 0;
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

// GMGN rug_ratio (0-1) → persen dibulatkan. rug_ratio dipakai apa adanya dari
// field GMGN (trenches/trending/token security), bukan dihitung ulang.
function gmgnRugPct(t) {
  return Math.round((Number(t && t.rug_ratio) || 0) * 100);
}

// Cek gate GMGN rug_ratio. Return { skip, reason, pct } — dipakai di 3 mode
// (Migration, Swing, Signal) biar konsisten.
function checkGmgnRug(t, maxRatio) {
  var pct = gmgnRugPct(t);
  var ratio = Number(t && t.rug_ratio) || 0;
  if (ratio > maxRatio) {
    return { skip: true, pct: pct, reason: 'GMGN Rug ' + pct + '% > ' + Math.round(maxRatio * 100) + '%' };
  }
  return { skip: false, pct: pct, reason: '' };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

function normalizeEnvChoice(value, allowed, fallback) {
  var normalized = String(value || fallback || '').trim().toUpperCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeMigEntryMode(value) {
  var normalized = String(value || 'TIGHT').trim().toUpperCase();
  if (normalized === 'SIGNAL') return 'LOOSE';
  if (normalized === 'FIB') return 'TIGHT';
  return ['LOOSE', 'TIGHT'].includes(normalized) ? normalized : 'TIGHT';
}

function isLooseMigEntryMode(value) {
  var normalized = String(value || '').trim().toUpperCase();
  return normalized === 'LOOSE' || normalized === 'SIGNAL';
}

function firstNumber() {
  for (var i = 0; i < arguments.length; i++) {
    var n = Number(arguments[i]);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  return 0;
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
    // Waktu migrasi/graduate ke DEX (BUKAN waktu token dibuat di bonding curve).
    // Dipakai khusus utk filter umur "New Migration" (migMinAgeMin/migMaxAgeH).
    migration_timestamp: t.open_timestamp || t.complete_timestamp || t.created_timestamp,
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
  // GANTI: sebelumnya raw HTTP langsung ke openapi.gmgn.ai dengan client_id
  // buatan sendiri ('ax' + base36 timestamp + random) — GMGN mewajibkan
  // client_id berformat UUID buat anti-replay di endpoint /v1/market/*.
  // Format lama gak match, jadi request "diterima" (code:0, message:success)
  // tapi list-nya selalu kosong. Sekarang lewat gmgn-cli resmi, sama kayak
  // fetchGmgnTrenches/fetchTokenInfo/fetchGmgnSignal yang udah terbukti jalan.
  try {
    const args = [
      'market kline',
      '--chain sol',
      '--address ' + address,
      '--resolution ' + resolution,
      '--from ' + Math.floor(fromSec),
      '--to ' + Math.floor(toSec),
      '--raw',
    ].join(' ');
    const out = execSync('npx gmgn-cli ' + args, {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY || '' },
    });
    const d = JSON.parse(out);

    // Dok resmi gmgn-cli bilang --raw balikin { list: [...] }. Tetap defensif
    // jaga-jaga kalau ternyata array langsung atau ke-bungkus .data.list —
    // sama kayak defensifnya fetchGmgnTrenches/birdeye.js.
    const list = Array.isArray(d) ? d : (d?.list ?? d?.data?.list ?? null);

    if (!list || list.length < 3) {
      log('[DEBUG KLINE] ' + address.slice(0, 8)
        + ' — list: ' + (list ? list.length + ' candle' : 'null')
        + ' | raw: ' + out.slice(0, 400));
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
  if (!CFG.telegramNotificationsEnabled) {
    log('[TG muted] ' + String(msg || '').split('\n')[0]);
    return null;
  }
  try {
    var payload = { chat_id: CFG.tgChatId, text: msg, parse_mode: 'HTML' };
    if (threadId !== undefined && threadId !== null && !Number.isNaN(threadId)) {
      payload.message_thread_id = threadId;
    }
    if (replyTo) payload.reply_to_message_id = replyTo;
    var res = await axios.post(TG_API, payload, { timeout: 10000 });
    return res.data.result?.message_id || null;
  } catch (e) {
    const desc = e.response?.data?.description || e.message;
    log('TG error: ' + desc);
    return null;
  }
}

// ─────────────────────────────────────────────
//  AUTO BUY
// ─────────────────────────────────────────────
function getFibDiscountZone(fib) {
  if (!fib) return null;
  var high = Number(fib.swingHigh);
  var low = Number(fib.swingLow);
  if (!high || !low || high <= low) return null;

  var range = high - low;
  var source = String(fib.source || '').toLowerCase();

  if (source.includes('_bullish')) {
    var level618 = high - range * 0.618;
    var level786 = high - range * 0.786;
    return {
      direction: 'bullish',
      level618,
      level786,
      lower: Math.min(level618, level786),
      upper: Math.max(level618, level786),
    };
  } else if (source.includes('_bearish')) {
    return { direction: 'bearish', unsupported: true };
  } else {
    return null;
  }
}

function getFibZone(fib, upperLevel, lowerLevel) {
  if (!fib) return null;
  var high = Number(fib.swingHigh);
  var low = Number(fib.swingLow);
  if (!high || !low || high <= low) return null;

  var range = high - low;
  var source = String(fib.source || '').toLowerCase();
  if (source.includes('_bearish')) return { direction: 'bearish', unsupported: true };
  if (!source.includes('_bullish')) return null;

  var upperPrice = high - range * upperLevel;
  var lowerPrice = high - range * lowerLevel;
  return {
    direction: 'bullish',
    upperLevel,
    lowerLevel,
    upperPrice,
    lowerPrice,
    lower: Math.min(upperPrice, lowerPrice),
    upper: Math.max(upperPrice, lowerPrice),
  };
}

function fibLevelLabel(level) {
  return Number(level).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function makeFibLevel(level, price) {
  return {
    label: 'fib' + fibLevelLabel(level),
    price: price,
  };
}

function getMigrationMomentum(t) {
  var vol5m = Number(t.volume_5m || 0);
  var swaps5m = Number(t.swaps_5m || 0);
  var buys5m = Number(t.buys_5m || 0);
  var sells5m = Number(t.sells_5m || 0);
  var total5m = buys5m + sells5m;
  var buyRatio5m = total5m > 0 ? (buys5m / total5m) * 100 : 0;

  var volStrong = vol5m >= CFG.minVol5m;
  var swapsStrong = swaps5m >= CFG.minSwaps5m;
  var buyPressureStrong = total5m > 0 && buyRatio5m >= CFG.migTightMinBuyRatio;

  return {
    vol5m,
    swaps5m,
    buys5m,
    sells5m,
    buyRatio5m,
    passMomentum: volStrong && swapsStrong && buyPressureStrong,
    reason: 'Vol5m $' + fmt(vol5m) + ' | Txns5m ' + swaps5m + ' | Buy ' + buyRatio5m.toFixed(0) + '%',
  };
}

function buildAutoBuyDecision(entryGate, status, reason) {
  var decision = {
    bought: false,
    autoBuyStatus: status,
    autoBuyReason: reason || '',
    autoBuyCheckedAt: Date.now(),
  };
  if (entryGate) {
    decision.entryZoneLow = entryGate.entryLow || null;
    decision.entryZoneHigh = entryGate.entryHigh || null;
    decision.entryZoneLabel = entryGate.entryZoneLabel || null;
    decision.fibSource = entryGate.fib?.source || 'unknown';
    decision.fib50 = entryGate.fib50 || null;
    decision.fib618 = entryGate.fib618 || null;
    decision.fib786 = entryGate.fib786 || null;
    decision.fibLevels = entryGate.fibLevels || null;
    decision.entryMode = entryGate.entryMode || null;
    decision.momentum = entryGate.momentum || null;
  }
  return decision;
}

function classifyAutoBuyEntryStatus(entryGate) {
  var reason = String(entryGate?.reason || '').toLowerCase();
  if (reason.includes('sudah di bawah') || reason.includes('breakdown')) return 'INVALID_ENTRY';
  if (reason.includes('bearish') || reason.includes('tidak valid') || reason.includes('harga token tidak valid')) return 'SKIP_ENTRY';
  return 'WAIT_ENTRY';
}

function mergeAutoBuyResult(pos, result) {
  if (!pos || !result) return;

  if (['WAIT_ENTRY', 'WAIT_CYCLE'].includes(result.autoBuyStatus)) {
    var startedAt = Number(pos.waitEntryStartedAt || pos.entryAt || Date.now());
    result.waitEntryStartedAt = startedAt;
    result.waitEntryUntil = Number(pos.waitEntryUntil || (startedAt + CFG.autoBuyWaitEntryMaxMin * 60000));
  }

  Object.assign(pos, result);

  if (result.bought || ['INVALID_ENTRY', 'SKIP_ENTRY', 'BUY_ERROR', 'EXPIRED'].includes(result.autoBuyStatus)) {
    delete pos.waitEntryStartedAt;
    delete pos.waitEntryUntil;
  }
}

function isTerminalAutoBuyStatus(status) {
  return ['BOUGHT', 'INVALID_ENTRY', 'EXPIRED'].includes(String(status || '').toUpperCase());
}

function isRetryableAutoBuyStatus(status) {
  return ['WAIT_ENTRY', 'WAIT_CYCLE'].includes(String(status || '').toUpperCase());
}

function buildAutoBuyRetryToken(ca, pos, currentPrice) {
  var tokenInfo = fetchTokenInfo(ca) || {};
  var root = tokenInfo.data || tokenInfo.token || tokenInfo;
  var priceInfo = tokenInfo.price || root.price || {};
  var mode = String(pos.mode || '').toUpperCase();
  var vol1h = firstNumber(priceInfo.volume_1h, priceInfo.vol_1h, priceInfo.volume1h, root.volume_1h, pos.volume_1h);
  var vol24h = firstNumber(priceInfo.volume_24h, priceInfo.vol_24h, priceInfo.volume24h, root.volume_24h, pos.volume_24h);

  return {
    address: ca,
    symbol: pos.symbol,
    name: pos.name,
    grade: pos.grade,
    mode: pos.mode,
    price: firstNumber(priceInfo.price_usd, priceInfo.priceUsd, priceInfo.price, root.price_usd, root.price, currentPrice),
    price_change_percent1h: firstNumber(priceInfo.price_change_percent1h, priceInfo.price_change_1h, priceInfo.change_1h, root.price_change_percent1h, pos.price_change_percent1h),
    market_cap: firstNumber(priceInfo.market_cap, priceInfo.usd_market_cap, root.market_cap, root.usd_market_cap, pos.market_cap),
    history_highest_market_cap: firstNumber(priceInfo.history_highest_market_cap, root.history_highest_market_cap, pos.history_highest_market_cap),
    liquidity: firstNumber(priceInfo.liquidity, root.liquidity, pos.liquidity),
    volume: mode === 'SWING' ? firstNumber(vol24h, pos.volume) : firstNumber(vol1h, pos.volume),
    volume_1h: vol1h,
    volume_24h: vol24h,
    volume_5m: firstNumber(priceInfo.volume_5m, priceInfo.vol_5m, priceInfo.volume5m, root.volume_5m, pos.volume_5m),
    swaps_5m: firstNumber(priceInfo.swaps_5m, priceInfo.txns_5m, priceInfo.transactions_5m, root.swaps_5m, pos.swaps_5m),
    buys_5m: firstNumber(priceInfo.buys_5m, priceInfo.buy_5m, priceInfo.buy_txns_5m, root.buys_5m, pos.buys_5m),
    sells_5m: firstNumber(priceInfo.sells_5m, priceInfo.sell_5m, priceInfo.sell_txns_5m, root.sells_5m, pos.sells_5m),
  };
}

async function retryPendingAutoBuy(ca, pos, currentPrice) {
  if (!AUTO_BUY.ENABLED || pos.bought) return false;

  var mode = String(pos.mode || '').toUpperCase();
  if (!['MIGRATION', 'SWING'].includes(mode)) return false;
  if (isTerminalAutoBuyStatus(pos.autoBuyStatus)) return false;
  if (!isRetryableAutoBuyStatus(pos.autoBuyStatus)) return false;

  var now = Date.now();
  var startedAt = Number(pos.waitEntryStartedAt || pos.entryAt || now);
  var waitUntil = Number(pos.waitEntryUntil || (startedAt + CFG.autoBuyWaitEntryMaxMin * 60000));
  if (now > waitUntil) {
    mergeAutoBuyResult(pos, {
      bought: false,
      autoBuyStatus: 'EXPIRED',
      autoBuyReason: 'wait entry expired > ' + CFG.autoBuyWaitEntryMaxMin + ' menit',
      autoBuyCheckedAt: now,
    });
    log('[AUTOBUY] WAIT_ENTRY expired ' + pos.symbol + ' (> ' + CFG.autoBuyWaitEntryMaxMin + ' menit)');
    return true;
  }

  var t = buildAutoBuyRetryToken(ca, pos, currentPrice);
  log('[AUTOBUY] Recheck WAIT_ENTRY ' + mode + ' ' + pos.symbol + ' @ $' + fmtPrice(t.price));
  var buyResult = await tryAutoBuy(ca, t, mode, pos.grade || 'POTENSIAL');
  mergeAutoBuyResult(pos, buyResult);
  return !!buyResult;
}

async function checkAutoBuyEntryZone(t, mode) {
  var price = Number(t.price);
  if (!price || price <= 0) {
    return { pass: false, reason: 'harga token tidak valid' };
  }

  var fib = await calculateFibonacci(t.address, price, t.price_change_percent1h, t.market_cap, t.history_highest_market_cap, mode);
  var modeKey = String(mode || '').toUpperCase();

  if (modeKey === 'MIGRATION') {
    var fibUpper = CFG.migTightFibUpper;   // default 0.5
    var fibLower = CFG.migTightFibLower;   // default 0.786
    var midPoint = (fibUpper + fibLower) / 2;
    var fibUpperLabel = fibUpper.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    var fibLowerLabel = fibLower.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    var midPointLabel = midPoint.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    var aggressiveZone = getFibZone(fib, fibUpper, midPoint);
    var normalZone = getFibZone(fib, midPoint, fibLower);
    var fullZone = getFibZone(fib, fibUpper, fibLower);
    var momentum = getMigrationMomentum(t);
    var migrationFibLevels = fullZone && aggressiveZone && normalZone && !fullZone.unsupported && !aggressiveZone.unsupported && !normalZone.unsupported
      ? [
          makeFibLevel(fibUpper, fullZone.upperPrice),
          makeFibLevel(midPoint, aggressiveZone.lowerPrice),
          makeFibLevel(fibLower, fullZone.lowerPrice),
        ]
      : null;

    if (AUTO_BUY.MIG_ENTRY_MODE === 'LOOSE') {
      var hasValidFibZone = fullZone && !fullZone.unsupported;
      return {
        pass: true,
        entryMode: 'LOOSE',
        reason: 'AUTO_BUY_MIG_ENTRY_MODE=LOOSE; longgar, buy langsung di harga signal $' + fmtPrice(price) + ', fib hanya info',
        fib,
        fair: hasValidFibZone ? fullZone.upperPrice : price,
        maxEntry: price,
        entryLow: hasValidFibZone ? fullZone.lower : null,
        entryHigh: hasValidFibZone ? fullZone.upper : null,
        entryZoneLabel: hasValidFibZone ? 'info ' + fibUpperLabel + '-' + fibLowerLabel : 'signal price',
        fib50: hasValidFibZone ? fullZone.upperPrice : null,
        fib618: hasValidFibZone && fibLowerLabel === '0.618' ? fullZone.lowerPrice : null,
        fib786: hasValidFibZone && fibLowerLabel === '0.786' ? fullZone.lowerPrice : null,
        fibLevels: migrationFibLevels,
        momentum,
      };
    }

    if (fullZone && fullZone.unsupported) {
      return {
        pass: false,
        reason: 'fib masih bearish; zona entry migration jadi resistance, skip auto-buy',
        fib,
      };
    }
    if (!fullZone || !aggressiveZone || !normalZone) {
      return { pass: false, reason: 'zona fib migration ' + fibUpperLabel + '-' + fibLowerLabel + ' tidak valid', fib };
    }

    if (price > fullZone.upper) {
      return {
        pass: false,
        reason: 'price $' + fmtPrice(price) + ' masih di atas fib' + fibUpperLabel + ' (upper $' + fmtPrice(fullZone.upper) + '), no chase',
        fib,
        fair: fullZone.upperPrice,
        maxEntry: fullZone.upper,
        entryLow: fullZone.lower,
        entryHigh: fullZone.upper,
        entryZoneLabel: 'watch ' + fibUpperLabel + '-' + fibLowerLabel,
        fib50: fullZone.upperPrice,
        fib618: fibLowerLabel === '0.618' ? fullZone.lowerPrice : null,
        fib786: fibLowerLabel === '0.786' ? fullZone.lowerPrice : null,
        fibLevels: migrationFibLevels,
        momentum,
      };
    }
    if (price < fullZone.lower) {
      return {
        pass: false,
        reason: 'price $' + fmtPrice(price) + ' sudah di bawah fib' + fibLowerLabel + ' (lower $' + fmtPrice(fullZone.lower) + ', rawan breakdown)',
        fib,
        fair: fullZone.upperPrice,
        maxEntry: fullZone.upper,
        entryLow: fullZone.lower,
        entryHigh: fullZone.upper,
        entryZoneLabel: 'watch ' + fibUpperLabel + '-' + fibLowerLabel,
        fib50: fullZone.upperPrice,
        fib618: fibLowerLabel === '0.618' ? fullZone.lowerPrice : null,
        fib786: fibLowerLabel === '0.786' ? fullZone.lowerPrice : null,
        fibLevels: migrationFibLevels,
        momentum,
      };
    }
    if (price >= aggressiveZone.lower && price <= aggressiveZone.upper) {
      if (CFG.migTightRequireMomentum && !momentum.passMomentum) {
        return {
          pass: false,
          reason: 'price masuk area agresif fib' + fibUpperLabel + '-' + midPointLabel + ' tapi momentum belum cukup (' + momentum.reason + ')',
          fib,
          fair: fullZone.upperPrice,
          maxEntry: aggressiveZone.upper,
          entryLow: aggressiveZone.lower,
          entryHigh: aggressiveZone.upper,
          entryZoneLabel: 'aggressive ' + fibUpperLabel + '-' + midPointLabel,
          fib50: fullZone.upperPrice,
          fib618: fibLowerLabel === '0.618' ? fullZone.lowerPrice : null,
          fib786: fibLowerLabel === '0.786' ? fullZone.lowerPrice : null,
          fibLevels: migrationFibLevels,
          momentum,
        };
      }
      return {
        pass: true,
        reason: 'price $' + fmtPrice(price) + ' di area agresif fib' + fibUpperLabel + '-' + midPointLabel + (CFG.migTightRequireMomentum ? ' dengan momentum kuat (' + momentum.reason + ')' : ' (momentum check off)'),
        fib,
        fair: fullZone.upperPrice,
        maxEntry: aggressiveZone.upper,
        entryLow: aggressiveZone.lower,
        entryHigh: aggressiveZone.upper,
        entryZoneLabel: 'aggressive ' + fibUpperLabel + '-' + midPointLabel,
        fib50: fullZone.upperPrice,
        fib618: fibLowerLabel === '0.618' ? fullZone.lowerPrice : null,
        fib786: fibLowerLabel === '0.786' ? fullZone.lowerPrice : null,
        fibLevels: migrationFibLevels,
        momentum,
      };
    }
    if (CFG.migTightRequireMomentum && !momentum.passMomentum) {
      return {
        pass: false,
        reason: 'price masuk area normal fib' + midPointLabel + '-' + fibLowerLabel + ' tapi momentum belum cukup (' + momentum.reason + ')',
        fib,
        fair: fullZone.upperPrice,
        maxEntry: fullZone.upper,
        entryLow: normalZone.lower,
        entryHigh: normalZone.upper,
        entryZoneLabel: 'normal ' + midPointLabel + '-' + fibLowerLabel,
        fib50: fullZone.upperPrice,
        fib618: fibLowerLabel === '0.618' ? normalZone.lowerPrice : null,
        fib786: fibLowerLabel === '0.786' ? normalZone.lowerPrice : null,
        fibLevels: migrationFibLevels,
        momentum,
      };
    }
    return {
      pass: true,
      reason: 'price $' + fmtPrice(price) + ' di area normal fib' + midPointLabel + '-' + fibLowerLabel + (CFG.migTightRequireMomentum ? ' dengan momentum kuat (' + momentum.reason + ')' : ' (momentum check off)'),
      fib,
      fair: fullZone.upperPrice,
      maxEntry: fullZone.upper,
      entryLow: normalZone.lower,
      entryHigh: normalZone.upper,
      entryZoneLabel: 'normal ' + midPointLabel + '-' + fibLowerLabel,
      fib50: fullZone.upperPrice,
      fib618: fibLowerLabel === '0.618' ? normalZone.lowerPrice : null,
      fib786: fibLowerLabel === '0.786' ? normalZone.lowerPrice : null,
      fibLevels: migrationFibLevels,
      momentum,
    };
  }

  if (modeKey === 'SWING') {
    var zone = getFibDiscountZone(fib);
    if (zone && zone.unsupported) {
      return {
        pass: false,
        reason: 'fib masih bearish; area 0.618-0.786 jadi resistance, skip auto-buy',
        fib,
      };
    }
    if (!zone) {
      return { pass: false, reason: 'zona diskon fib 0.618-0.786 tidak valid', fib };
    }
    if (price > zone.upper) {
      return {
        pass: false,
        reason: 'price $' + fmtPrice(price) + ' masih di atas zona diskon 0.618-0.786 (upper $' + fmtPrice(zone.upper) + ')',
        fib,
        fair: zone.level618,
        maxEntry: zone.upper,
        entryLow: zone.lower,
        entryHigh: zone.upper,
        fib618: zone.level618,
        fib786: zone.level786,
      };
    }
    if (price < zone.lower) {
      return {
        pass: false,
        reason: 'price $' + fmtPrice(price) + ' sudah di bawah 0.786 (lower $' + fmtPrice(zone.lower) + ', rawan breakdown)',
        fib,
        fair: zone.level618,
        maxEntry: zone.upper,
        entryLow: zone.lower,
        entryHigh: zone.upper,
        fib618: zone.level618,
        fib786: zone.level786,
      };
    }
    return {
      pass: true,
      reason: 'price $' + fmtPrice(price) + ' di zona diskon 0.618-0.786 ($' + fmtPrice(zone.lower) + ' - $' + fmtPrice(zone.upper) + ')',
      fib,
      fair: zone.level618,
      maxEntry: zone.upper,
      entryLow: zone.lower,
      entryHigh: zone.upper,
      fib618: zone.level618,
      fib786: zone.level786,
    };
  }

  return { pass: false, reason: 'mode auto-buy tidak didukung: ' + modeKey, fib };
}

async function tryAutoBuy(ca, t, mode, grade) {
  if (!AUTO_BUY.ENABLED) {
    return buildAutoBuyDecision(null, 'OFF', 'AUTO_BUY_ENABLED=false');
  }
  if (boughtThisCycle >= AUTO_BUY.MAX_PER_CYCLE) {
    log('[AUTOBUY] Max per cycle (' + AUTO_BUY.MAX_PER_CYCLE + ') tercapai, skip ' + t.symbol);
    return buildAutoBuyDecision(null, 'WAIT_CYCLE', 'Max per cycle (' + AUTO_BUY.MAX_PER_CYCLE + ') tercapai');
  }
  var modes = AUTO_BUY.MODES.split(',').map(function(m) { return m.trim().toUpperCase(); });
  if (!modes.includes(mode.toUpperCase())) {
    return buildAutoBuyDecision(null, 'SKIP_MODE', 'Mode ' + mode + ' tidak ada di AUTO_BUY_MODES');
  }
  if (AUTO_BUY.ONLY_GRADE !== 'ALL' && grade !== AUTO_BUY.ONLY_GRADE) {
    return buildAutoBuyDecision(null, 'SKIP_GRADE', 'Grade ' + grade + ' tidak cocok dengan AUTO_BUY_GRADE=' + AUTO_BUY.ONLY_GRADE);
  }
  if (TRACKED.has(ca) && TRACKED.get(ca).bought) return null;

  var entryGate = null;
  try {
    entryGate = await checkAutoBuyEntryZone(t, mode);
    var fibSource = entryGate.fib?.source || 'unknown';
    var fibMeta = 'via ' + fibSource + ' | fair $' + fmtPrice(entryGate.fair) + ' | max $' + fmtPrice(entryGate.maxEntry);
    if (entryGate.entryLow && entryGate.entryHigh) {
      fibMeta = 'via ' + fibSource;
      if (entryGate.entryZoneLabel) fibMeta += ' | ' + entryGate.entryZoneLabel;
      if (Array.isArray(entryGate.fibLevels) && entryGate.fibLevels.length > 0) {
        entryGate.fibLevels.forEach(function(level) {
          fibMeta += ' | ' + level.label + ' $' + fmtPrice(level.price);
        });
      } else {
        if (entryGate.fib50) fibMeta += ' | fib0.5 $' + fmtPrice(entryGate.fib50);
        if (entryGate.fib618) fibMeta += ' | fib0.618 $' + fmtPrice(entryGate.fib618);
        if (entryGate.fib786) fibMeta += ' | fib0.786 $' + fmtPrice(entryGate.fib786);
      }
      fibMeta += ' | zone $' + fmtPrice(entryGate.entryLow) + '-' + fmtPrice(entryGate.entryHigh);
    }
    if (!entryGate.pass) {
      var waitStatus = classifyAutoBuyEntryStatus(entryGate);
      log('[AUTOBUY] ' + waitStatus + ' ' + mode + ' ' + t.symbol + ' (' + fibMeta + ' | entry zone: ' + entryGate.reason + ')');
      var skipDecision = buildAutoBuyDecision(entryGate, waitStatus, entryGate.reason);
      logTrackingEvent({
        type: waitStatus === 'WAIT_ENTRY' ? 'AUTOBUY_WAIT_ENTRY' : 'AUTOBUY_SKIP',
        ca, name: t.name, symbol: t.symbol, mode, grade,
        autoBuyStatus: skipDecision.autoBuyStatus,
        autoBuyReason: skipDecision.autoBuyReason,
        entryZoneLow: skipDecision.entryZoneLow,
        entryZoneHigh: skipDecision.entryZoneHigh,
        entryZoneLabel: skipDecision.entryZoneLabel,
        fibSource: skipDecision.fibSource,
        fibLevels: skipDecision.fibLevels,
        momentum: skipDecision.momentum,
      });
      return skipDecision;
    }
    log('[AUTOBUY] Entry zone OK ' + t.symbol + ' (' + fibMeta + ' | ' + entryGate.reason + ')');

    log('[AUTOBUY] Eksekusi buy ' + t.symbol + ' ' + AUTO_BUY.AMOUNT_SOL + ' SOL' + (AUTO_BUY.DRY_RUN ? ' [DRY RUN]' : ''));
    var result = await buyToken(ca, AUTO_BUY.AMOUNT_SOL, AUTO_BUY.SLIPPAGE_BPS);
    boughtThisCycle++;

    var entryPriceUsd = Number(t.price) || 0;
    var entryZoneLabel = entryGate.entryZoneLabel || '0.618-0.786';
    var entryZoneText = entryGate.entryLow && entryGate.entryHigh
      ? '$' + fmtPrice(entryGate.entryLow) + ' - $' + fmtPrice(entryGate.entryHigh) + ' (' + entryZoneLabel + ')'
      : '-';

    var buyMsg =
      '🟢 AUTO BUY\n' +
      '<b>' + t.name + '</b> (<code>' + t.symbol + '</code>)\n' +
      'Mode: ' + mode + ' | Grade: ' + grade + '\n' +
      'Amount: <b>' + AUTO_BUY.AMOUNT_SOL + ' SOL</b>\n' +
      formatAutoSellPlan() + '\n' +
      'Price USD: $' + fmtPrice(entryPriceUsd) + '\n' +
      'Zona Fib: ' + entryZoneText + '\n' +
      'Fib: ' + fibSource + '\n' +
      'Swap Entry: ' + result.entryPriceSol.toFixed(10) + ' SOL/token\n' +
      'Tokens: ' + result.tokenAmount.toFixed(2) + '\n' +
      (AUTO_BUY.DRY_RUN ? '' : 'TX: <code>' + result.txSignature + '</code>\n') +
      '<a href="https://dexscreener.com/solana/' + ca + '">Chart</a>' +
      ' | <a href="https://gmgn.ai/sol/token/' + ca + '">GMGN</a>';

    var autoBuyMsgId = await sendTelegram(buyMsg, null, CFG.tgThreadAuto);
    log('[AUTOBUY] ✓ ' + t.symbol + ' @ ' + result.entryPriceSol.toFixed(10) + ' SOL/token');

    logTrackingEvent({
      type: AUTO_BUY.DRY_RUN ? 'AUTOBUY_DRY_RUN' : 'AUTOBUY',
      ca, name: t.name, symbol: t.symbol, mode, grade,
      entryPrice: result.entryPriceSol,
      entryPriceUsd,
      entryPriceSol: result.entryPriceSol,
      entryZoneLow: entryGate.entryLow || null,
      entryZoneHigh: entryGate.entryHigh || null,
      entryZoneLabel,
      entryMode: entryGate.entryMode || (String(mode || '').toUpperCase() === 'MIGRATION' ? AUTO_BUY.MIG_ENTRY_MODE : 'TIGHT'),
      fibSource,
      momentum: entryGate.momentum || null,
      amountSol: AUTO_BUY.AMOUNT_SOL,
      tokenAmount: result.tokenAmount,
      txBuy: result.txSignature,
    });

    return {
      bought: true,
      autoBuyMsgId: autoBuyMsgId,
      tokenAmount: result.tokenAmount,
      tokenDecimals: result.tokenDecimals,
      entryPrice: entryPriceUsd,
      entryPriceSol: result.entryPriceSol,
      entryPriceUsd,
      entryZoneLow: entryGate.entryLow || null,
      entryZoneHigh: entryGate.entryHigh || null,
      entryZoneLabel,
      entryMode: entryGate.entryMode || (String(mode || '').toUpperCase() === 'MIGRATION' ? AUTO_BUY.MIG_ENTRY_MODE : 'TIGHT'),
      fibSource,
      momentum: entryGate.momentum || null,
      amountSol: AUTO_BUY.AMOUNT_SOL,
      txBuy: result.txSignature,
      peak: Number(t.price) || result.entryPriceSol,
      trailingActive: false,
      autoBuyStatus: 'BOUGHT',
      autoBuyReason: entryGate.reason,
      autoBuyCheckedAt: Date.now(),
    };
  } catch (e) {
    log('[AUTOBUY] Error ' + t.symbol + ': ' + e.message);
    await sendTelegram(
      '⚠️ AUTO BUY GAGAL\n' +
      '<b>' + t.name + '</b> (<code>' + t.symbol + '</code>)\n' +
      'Mode: ' + mode + ' | Grade: ' + grade + '\n' +
      'Amount: ' + AUTO_BUY.AMOUNT_SOL + ' SOL\n' +
      'Error: <code>' + esc(e.message) + '</code>\n' +
      '<a href="https://dexscreener.com/solana/' + ca + '">Chart</a>',
      null, CFG.tgThreadAuto
    );
    return buildAutoBuyDecision(entryGate, 'BUY_ERROR', e.message);
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
  const vol1h     = Number(t.volume_1h ?? t.volume1h ?? t.volume1H ?? t.vol1h ?? t.volume ?? 0) || 0;
  let vol24h       = Number(t.volume_24h ?? t.volume24h ?? t.volume24H ?? t.vol24h ?? 0) || 0;
  let tokenInfo    = null;
  // Bedakan "data holder gak tersedia" (null) vs "beneran 0 holder" — sebelumnya
  // dua-duanya numpuk jadi 0 dan gate holder jadi silently bypass tiap kali API
  // gak ngirim field ini.
  const holders   = (typeof t.holder_count === 'number') ? t.holder_count : null;

  // — Gate 1: usia token —
  if (ageH < CFG.swingMinAge)
    return { pass: false, reason: 'Terlalu baru (' + ageH.toFixed(0) + 'j < ' + CFG.swingMinAge + 'j)' };

  // — Gate 2: LP cukup untuk swing —
  if (lp < CFG.swingMinLp)
    return { pass: false, reason: 'LP terlalu kecil ($' + fmt(lp) + ')' };

  // — Gate 3: Belum terlanjur pump —
  if (change1h > CFG.swingMaxChange1h)
    return { pass: false, reason: 'Sudah pump 1h +' + change1h.toFixed(1) + '% (FOMO)' };
  if (change24h > CFG.swingMaxChange24h)
    return { pass: false, reason: 'Sudah pump 24h +' + change24h.toFixed(1) + '% (terlambat)' };

  if (!vol24h && t.address) {
    tokenInfo = fetchTokenInfo(t.address);
    vol24h = Number(tokenInfo?.price?.volume_24h ?? tokenInfo?.volume_24h ?? 0) || 0;
  }

  // — Gate 4: Volume 24h minimal —
  if (vol24h < CFG.swingMinVol24h)
    return { pass: false, reason: 'Vol 24h terlalu kecil ($' + fmt(vol24h) + ')' };
  t.volume_1h = vol1h;
  t.volume_24h = vol24h;
  t.volume = vol24h;

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
  const signals = ['Vol 24h kuat $' + fmt(vol24h)];
  const klines  = await fetchSwingKlines(t.address);
  let allowAutoBuy = true;

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
      allowAutoBuy = false;
      log('Kline 1D kurang valid setelah cleanup untuk ' + t.symbol + ', fallback ke sinyal dasar');
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
      const nowSec = Math.floor(Date.now() / 1000);
      // lastCandle.time dari GMGN kline ternyata ms, bukan detik (nowSec - time
      // jadi minus raksasa -> clamp ke 0 -> dayFraction selalu ngunci di floor
      // 0.1 -> "hari baru 10% jalan" 100% kejadian, gak pernah ada variasi).
      // Deteksi unit by magnitude: timestamp detik jaman sekarang ~1.7-2 miliar,
      // versi ms-nya ~1000x lebih gede (>1e12) — jauh lebih aman drpd asumsi
      // satu arah, krn kalau GMGN ganti balik ke detik kode ini tetep bener.
      const lastCandleSec = lastCandle.time > 1e12 ? Math.floor(lastCandle.time / 1000) : lastCandle.time;
      const dayElapsedSec = lastCandleSec ? Math.max(nowSec - lastCandleSec, 0) : 86400;
      const dayFraction   = Math.min(Math.max(dayElapsedSec / 86400, 0.1), 1); // floor 10% biar gak diekstrapolasi gila-gilaan pas hari baru mulai
      const normLastVol   = lastCandle.volume / dayFraction;

      const highs       = candles.map(c => c.high);
      const lows         = candles.map(c => c.low);
      const swingHigh   = Math.max(...highs);
      const swingLow    = Math.min(...lows);
      const priceRange  = swingHigh - swingLow;

      // Sinyal 1: Volume hari ini (ternormalisasi) dibanding rata-rata candle sebelumnya.
      // Ini konfirmasi tambahan, bukan hard gate. Hard gate volume untuk Swing
      // pakai Vol 24h di atas.
      const volSpike = avgVol > 0 ? normLastVol / avgVol : 1;
      if (volSpike >= CFG.swingVolSpikeMin) {
        signals.push('Vol spike ' + volSpike.toFixed(1) + 'x rata-rata (normalized, hari ' + (dayFraction * 100).toFixed(0) + '% jalan)');
      } else {
        signals.push('[WARN] Vol spike 1D rendah (' + volSpike.toFixed(1) + 'x, hari ' + (dayFraction * 100).toFixed(0) + '% jalan)');
      }

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
    allowAutoBuy = false;
    log('Kline 1D tidak tersedia untuk ' + t.symbol + ', fallback ke sinyal dasar');
    if (change1h > 0 && change1h <= CFG.swingMaxChange1h)
      signals.push('Price naik ' + change1h.toFixed(1) + '% (1h, belum FOMO)');
    if (change24h < 0)
      signals.push('Pullback 24h ' + change24h.toFixed(1) + '% (potensi reversal)');
  }

  // Minimal 1 sinyal positif harus ada
  const positiveSignals = signals.filter(s => !s.startsWith('[WARN]'));
  if (positiveSignals.length === 0)
    return { pass: false, reason: 'Tidak ada sinyal pre-pump' };

  return { pass: true, signals, allowAutoBuy };
}

// ─────────────────────────────────────────────
//  FIBONACCI
// ─────────────────────────────────────────────
async function calculateFibonacci(address, price, changePct, mc, athMc, mode) {
  var p     = Number(price);
  if (!p || p <= 0) p = 0.0001;
  var floor = p * 0.1;

  // ── TIER 1: Birdeye — major swing pivot (zigzag, paling akurat) ──
  // Beda dari tier GMGN di bawah: gak ambil literal max/min candle di seluruh
  // window, tapi cari titik balik (reversal) yang signifikan, dan pakai leg
  // PALING BARU aja — jadi gak kebawa swing high/low yang udah basi.
  try {
    var fibBirdeye = await calculateFibFromBirdeye(address, mode, floor, CFG);
    if (fibBirdeye) return fibBirdeye;
  } catch (e) { log('Birdeye fib gagal, fallback ke GMGN kline: ' + e.message); }

  // Untuk swing: pakai kline 1D (7 candle), lebih akurat
  const resolution = mode === 'SWING' ? '1d' : '1h';
  const lookback   = mode === 'SWING' ? 7 * 86400 : 86400;

  try {
    const nowSec  = Math.floor(Date.now() / 1000);
    const klines  = await fetchGMGNKline(address, resolution, nowSec - lookback, nowSec);
    if (klines && klines.length >= 3) {
      var candles = klines
        .map((c, index) => ({
          index,
          time: Number(c.time ?? c.timestamp ?? c.t ?? 0),
          high: Number(c.high),
          low: Number(c.low),
        }))
        .filter(c => c.high > 0 && c.low > 0)
        .sort((a, b) => {
          if (a.time > 0 && b.time > 0) return a.time - b.time;
          return a.index - b.index;
        })
        .map((c, order) => ({ ...c, order }));
      var swingHighCandle = candles.reduce((best, c) => !best || c.high > best.high ? c : best, null);
      var swingLowCandle  = candles.reduce((best, c) => !best || c.low < best.low ? c : best, null);
      var swingHigh       = swingHighCandle ? swingHighCandle.high : 0;
      var swingLow        = swingLowCandle ? swingLowCandle.low : 0;
      if (swingHigh > swingLow) {
        var range = swingHigh - swingLow;
        var isBullish = swingLowCandle.order < swingHighCandle.order;
        var direction = isBullish ? 'bullish' : 'bearish';
        log('Fib dari kline ' + resolution + ' (' + direction + '): H=' + swingHigh + ' L=' + swingLow);
        if (isBullish) {
          return {
            source: 'kline_' + resolution + '_' + direction,
            swingHigh, swingLow,
            support: Math.max(swingHigh - range * 0.500, floor).toFixed(10),
            fair:    Math.max(swingHigh - range * 0.618, floor).toFixed(10),
            resist:  (swingHigh + range * 0.382).toFixed(10),
            sl:      Math.max(swingLow  - range * 0.272, floor * 0.5).toFixed(10),
          };
        }
        return {
          source: 'kline_' + resolution + '_' + direction,
          swingHigh, swingLow,
          support: Math.max(swingLow - range * 0.272, floor).toFixed(10),
          fair:    Math.max(swingLow + range * 0.382, floor).toFixed(10),
          resist:  (swingLow + range * 0.618).toFixed(10),
          sl:      Math.max(swingLow - range * 0.382, floor * 0.5).toFixed(10),
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
      source: 'estimasi_bullish',
      swingHigh: h, swingLow: l,
      support: Math.max(h - range * 0.500, floor).toFixed(10),
      fair:    Math.max(h - range * 0.618, floor).toFixed(10),
      resist:  (h + range * 0.382).toFixed(10),
      sl:      Math.max(h - range * 1.272, floor * 0.5).toFixed(10),
    };
  } else {
    return {
      source: 'estimasi_bearish',
      swingHigh: h, swingLow: l,
      support: Math.max(l - range * 0.272, floor).toFixed(10),
      fair:    Math.max(l - range * 0.500, floor).toFixed(10),
      resist:  (l + range * 0.382).toFixed(10),
      sl:      Math.max(l - range * 0.618, floor * 0.5).toFixed(10),
    };
  }
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
  var modeLabel  = mode === 'SWING' ? '🔄 Swing 1D' : '🆕 New Migration';
  var gradeEmoji = grade === 'GOLD' ? '🟢' : grade === 'POTENSIAL' ? '🟡' : '🔴';
  var riskLabel  = grade === 'GOLD' ? 'Grade A' : grade === 'POTENSIAL' ? 'Grade B' : 'Grade C';

  var msg = '';
  msg += gradeEmoji + ' <b>' + riskLabel + '</b> | ' + modeLabel + '\n';
  msg += '<b>' + t.name + '</b> (<code>' + t.symbol + '</code>)\n';
  msg += SEP + '\n';
  msg += le + ' LP      : $' + fmt(t.liquidity) + '\n';
  msg += ve + (mode === 'SWING' ? ' Vol 24h : $' : ' Vol 1h  : $') + fmt(t.volume) + '\n';

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

  var gmgnRugPctVal = gmgnRugPct(t);
  var gmgnRugEmoji  = gmgnRugPctVal > Math.round(CFG.gmgnRugMaxRatio * 100) ? '🚨' : gmgnRugPctVal > 15 ? '⚠️' : '✅';
  msg += '🛡️ GMGN:\n';
  msg += gmgnRugEmoji + ' GMGN Rug : ' + gmgnRugPctVal + '%\n';
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
  var fibDirection = f.source.includes('_bullish') ? ' bullish' : f.source.includes('_bearish') ? ' bearish' : '';
  var fibLabel = f.source.startsWith('birdeye') ? 'major swing Birdeye' + fibDirection
    : f.source.startsWith('kline') ? 'dari candle ' + (mode === 'SWING' ? '1D' : '1h') + fibDirection
    : 'estimasi, cek chart';
  msg += '📊 Entry & Targets:\n';
  msg += '⏰ Entry   : $' + fmtPrice(t.price) + '\n';
  msg += '🎯 Target  : +30% → $' + fmtPrice(t.price * 1.3) + '\n';
  msg += '📊 Fib Level <i>(' + fibLabel + ')</i>:\n';
  msg += '🟢 Support : $' + fmtPrice(f.support) + '\n';
  msg += '⚖️  Fair    : $' + fmtPrice(f.fair) + '\n';
  if (mode === 'MIGRATION') {
    var migFibUpper = CFG.migTightFibUpper;
    var migFibLower = CFG.migTightFibLower;
    var migMidPoint = (migFibUpper + migFibLower) / 2;
    var migFibUpperLabel = migFibUpper.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    var migFibLowerLabel = migFibLower.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    var migMidLabel = migMidPoint.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    var migAggressiveZone = getFibZone(f, migFibUpper, migMidPoint);
    var migNormalZone = getFibZone(f, migMidPoint, migFibLower);
    if (migAggressiveZone && !migAggressiveZone.unsupported) {
      msg += '⚡ Agresif : $' + fmtPrice(migAggressiveZone.lower) + ' - $' + fmtPrice(migAggressiveZone.upper) + ' (' + migFibUpperLabel + '-' + migMidLabel + ')\n';
    }
    if (migNormalZone && !migNormalZone.unsupported) {
      msg += '🛒 Normal  : $' + fmtPrice(migNormalZone.lower) + ' - $' + fmtPrice(migNormalZone.upper) + ' (' + migMidLabel + '-' + migFibLowerLabel + ')\n';
    }
  } else if (mode === 'SWING') {
    var discountZone = getFibDiscountZone(f);
    if (discountZone && !discountZone.unsupported) {
      msg += '🛒 Diskon  : $' + fmtPrice(discountZone.lower) + ' - $' + fmtPrice(discountZone.upper) + ' (0.618-0.786)\n';
    }
  }
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
  var signalRugPct = gmgnRugPct(t);
  var re = signalRugPct > Math.round(CFG.gmgnRugMaxRatio * 100) ? '🚨' : signalRugPct > 15 ? '⚠️' : '✅';
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
  msg += re + ' GMGN Rug : ' + signalRugPct + '%\n';
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
  boughtThisCycle = 0;
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

    // Jeda kecil setelah migrasi — bukan filter kualitas, cuma kasih waktu
    // data LP/vol dari API settle dulu biar gak baca angka yang belum akurat.
    // PAKAI migration_timestamp (waktu migrasi ke DEX), BUKAN creation_timestamp
    // (waktu token dibuat di bonding curve) — token bisa nongkrong lama di pump.fun
    // sebelum migrasi, jadi umur sejak migrasi harus dihitung terpisah dari umur sejak mint.
    const ageMigMin = tokenAgeHours(t.migration_timestamp) * 60;
    if (ageMigMin < CFG.migMinAgeMin) {
      log('SKIP [MIGRATION] ' + (t.symbol || '?') + ' — baru migrasi ' + ageMigMin.toFixed(1) + 'm (< ' + CFG.migMinAgeMin + 'm, tunggu data settle)');
      continue;
    }

    // Batas umur maksimal — token yang migrasinya udah lewat dari X jam
    // dianggap sudah tidak "fresh" lagi, momentum awal migrasi sudah lewat.
    const ageMigH = ageMigMin / 60;
    if (ageMigH > CFG.migMaxAgeH) {
      log('SKIP [MIGRATION] ' + (t.symbol || '?') + ' — migrasi sudah ' + ageMigH.toFixed(1) + 'j (> ' + CFG.migMaxAgeH + 'j, tidak fresh lagi)');
      continue;
    }

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
    if (ageH >= CFG.swingMinAge) {
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

  // — Proses New Migration —
  for (let i = 0; i < newMigration.length; i++) {
    const t = newMigration[i];

    // Fetch token info untuk data 5m/1h
    log('[MIG] Fetch info ' + t.symbol + '...');
    const tokenInfo = fetchTokenInfo(t.address);
    if (!tokenInfo) {
      log('SKIP [MIG] ' + t.symbol + ' (Gagal fetch token info)');
      continue;
    }
    var migCfg = {
      minLp:        CFG.minLp,
      minVol1h:     CFG.minVol1h,
      minSwaps5m:   CFG.minSwaps5m,
      minVol5m:     CFG.minVol5m,
    };

    var lpGate = checkBaseLiquidity(t.liquidity, CFG.minLp);
    if (lpGate.skip) {
      log('SKIP [MIG] ' + t.symbol + ' (' + lpGate.reason + ')');
      continue;
    }

    var priceInfo = tokenInfo.price || {};
    var vol1hGate = checkVol1h(priceInfo.volume_1h, migCfg.minVol1h);
    if (vol1hGate.skip) {
      log('SKIP [MIG] ' + t.symbol + ' (' + vol1hGate.reason + ')');
      continue;
    }

    var swaps5mGate = checkSwaps5m(priceInfo.swaps_5m, migCfg.minSwaps5m);
    if (swaps5mGate.skip) {
      log('SKIP [MIG] ' + t.symbol + ' (' + swaps5mGate.reason + ')');
      continue;
    }

    var vol5mGate = checkVol5m(priceInfo.volume_5m, migCfg.minVol5m);
    if (vol5mGate.skip) {
      log('SKIP [MIG] ' + t.symbol + ' (' + vol5mGate.reason + ')');
      continue;
    }

    t.volume_5m = Number(priceInfo.volume_5m || priceInfo.vol_5m || priceInfo.volume5m || 0);
    t.swaps_5m = Number(priceInfo.swaps_5m || priceInfo.txns_5m || priceInfo.transactions_5m || 0);
    t.buys_5m = Number(priceInfo.buys_5m || priceInfo.buy_5m || priceInfo.buy_txns_5m || 0);
    t.sells_5m = Number(priceInfo.sells_5m || priceInfo.sell_5m || priceInfo.sell_txns_5m || 0);

    var holderHardSkipReasons = [];
    var bundlerPct = Number(t.bundler_rate || 0) * 100;
    if (bundlerPct > CFG.maxBundlerPct) {
      holderHardSkipReasons.push('Bundler ' + bundlerPct.toFixed(0) + '% > ' + CFG.maxBundlerPct + '%');
    }
    var top10Pct = Number(t.top_10_holder_rate || 0) * 100;
    if (top10Pct > CFG.maxTop10Holders) {
      holderHardSkipReasons.push('Top10 ' + top10Pct.toFixed(0) + '% > ' + CFG.maxTop10Holders + '%');
    }
    if (holderHardSkipReasons.length > 0) {
      log('SKIP [MIG] ' + t.symbol + ' (GMGN holder hard skip: ' + holderHardSkipReasons.join(' | ') + ')');
      continue;
    }

    // GMGN dedicated rug_ratio — cek duluan sebelum RugCheck biar hemat API call
    // kalau udah keburu jelas rug tinggi dari GMGN sendiri.
    var gmgnRugGate = checkGmgnRug(t, CFG.gmgnRugMaxRatio);
    log('[MIG] GMGN Rug ' + t.symbol + ': ' + gmgnRugGate.pct + '%');
    if (gmgnRugGate.skip) {
      log('SKIP [MIG] ' + t.symbol + ' (' + gmgnRugGate.reason + ')');
      SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'migration', lockedReason: 'gmgn_rug_ratio' });
      continue;
    }

    var migCfgStrict = {
      maxBundlerPct:    CFG.maxBundlerPct,
      maxTop10Holders:  CFG.maxTop10Holders,
      maxDevHold:       CFG.maxDevHold,
      maxSniperPct:     CFG.maxSniperPct,
      maxVolLpRatio:    CFG.maxVolLpRatio,
      maxRugScore:      CFG.maxRugScore,
      maxInsiderPct:    CFG.maxInsiderPct,
    };

    var gmgnRiskReasons = collectMigrationHardRiskReasons(t, migCfgStrict);
    if (gmgnRiskReasons.length > 0) {
      log('[MIG] WARN ' + t.symbol + ' (GMGN risk: ' + gmgnRiskReasons.join(' | ') + ') — lanjut RugCheck');
    }

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
        log('SKIP [MIG] ' + t.symbol + ' (No Social - butuh minimal 1 social: Twitter/Website/Telegram) [Score:' + socialScore + '/4]');
        continue;
      }
    } else {
      log('[MIG] ' + t.symbol + ' — DexScreener belum index, gate sosial di-skip (Social:?/4)');
    }

    // Cek paid DEX via DEX Screener API
    log('[MIG] Cek paid DEX ' + t.symbol + '...');
    var paidDex = await fetchPaidDex(t.address);
    if (!paidDex) {
      log('[MIG] WARN ' + t.symbol + ' (Belum paid DEX - lanjut)');
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
    SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'migration' });
    if (grade === 'SKIP') { log('SKIP [MIG] ' + t.symbol + ' (Grade SKIP — LP/Vol kecil)'); continue; }

    log('[MIG] ' + grade + ' ' + t.symbol + ' (LP:$' + fmt(t.liquidity) + ' Vol1h:$' + fmt(vol1h) + ' Rug:' + rug.score + ' Insider:' + rug.insiderPct.toFixed(0) + '% Paid:' + (paidDex ? '✅' : '⚠️') + ' Social:' + (dexInfo ? socialScore + '/4' : '?/4') + ')');
    let msgId = null;
    if (!NOTIF_ONLY_AUTO) {
      const fullMsg = await buildMsg(t, rug, grade, null, 'MIGRATION', null);
      msgId = await sendTelegram(fullMsg, null, CFG.tgThreadMig);
    }
    if (!NOTIF_ONLY_AUTO) totalNotified++;

    if (t.price && Number(t.price) > 0) {
      TRACKED.set(t.address, {
        symbol: t.symbol, name: t.name, grade, mode: 'MIGRATION',
        entryPrice: Number(t.price), entryAt: Date.now(), nextTargetIdx: 0, msgId,
        threadId: CFG.tgThreadMig,
      });
      log('Tracked [MIG] ' + t.symbol + ' @ $' + t.price);
      // AUTO BUY
      var buyResult = await tryAutoBuy(t.address, t, 'MIGRATION', grade);
      mergeAutoBuyResult(TRACKED.get(t.address), buyResult);
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
      var gmgnRugGateSwing = checkGmgnRug(t, CFG.gmgnRugMaxRatio);
      log('[SWING] GMGN Rug ' + t.symbol + ': ' + gmgnRugGateSwing.pct + '%');
      if (gmgnRugGateSwing.skip) {
        log('SKIP [SWING] ' + t.symbol + ' (' + gmgnRugGateSwing.reason + ')');
        SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'swing', lockedReason: 'gmgn_rug_ratio' });
        continue;
      }

      const rug = await getRugCheck(t.address, CFG.maxInsiderPct);
      if (rug.score > CFG.maxRugScore) { log('SKIP [SWING] ' + t.symbol + ' (Rug ' + rug.score + ')'); continue; }
      if (rug.insiderPct > CFG.maxInsiderPct) { log('SKIP [SWING] ' + t.symbol + ' (Insider ' + rug.insiderPct.toFixed(0) + '%)'); continue; }

      const grade = gradeToken(t.liquidity, t.volume, rug.score);
      if (grade === 'SKIP') { log('SKIP [SWING] ' + t.symbol + ' (Grade SKIP)'); continue; }

      // Mark sudah dinotif sebagai swing (update SEEN entry)
      const existingEntry = SEEN.get(t.address) || { firstSeen: Date.now(), seenAt: Date.now() };
      SEEN.set(t.address, { ...existingEntry, swingNotified: Date.now(), mode: 'swing' });

      log('[SWING] ' + grade + ' ' + t.symbol + ' — Kirim notif');
      let msgId = null;
      if (!NOTIF_ONLY_AUTO) {
        const fullMsg = await buildMsg(t, rug, grade, null, 'SWING', swingResult.signals);
        msgId = await sendTelegram(fullMsg, null, CFG.tgThreadId);
      }
      if (!NOTIF_ONLY_AUTO) totalNotified++;

      if (t.price && Number(t.price) > 0 && !TRACKED.has(t.address)) {
        TRACKED.set(t.address, {
          symbol: t.symbol, name: t.name, grade, mode: 'SWING',
          entryPrice: Number(t.price), entryAt: Date.now(), nextTargetIdx: 0, msgId,
          threadId: CFG.tgThreadId,
        });
        log('Tracked [SWING] ' + t.symbol + ' @ $' + t.price);
        // AUTO BUY
        if (swingResult.allowAutoBuy) {
          var buyResult = await tryAutoBuy(t.address, t, 'SWING', grade);
          mergeAutoBuyResult(TRACKED.get(t.address), buyResult);
        } else {
          log('[AUTOBUY] Skip SWING ' + t.symbol + ' (kline 1D tidak valid, notif only)');
        }
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
    // Gate 7: GMGN rug_ratio (dedicated threshold, bukan nebeng maxRugScore RugCheck)
    var gmgnRugGateSignal = checkGmgnRug(t, CFG.gmgnRugMaxRatio);
    log('[SIGNAL] GMGN Rug ' + t.symbol + ': ' + gmgnRugGateSignal.pct + '%');
    if (gmgnRugGateSignal.skip) {
      log('SKIP [SIGNAL] ' + t.symbol + ' (' + gmgnRugGateSignal.reason + ')');
      SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'signal', lockedReason: 'gmgn_rug_ratio' });
      continue;
    }
    var rugScore = gmgnRugGateSignal.pct;
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
    var msgId = null;
    if (!NOTIF_ONLY_AUTO) {
      var fullMsg = buildSignalMsg(t);
      msgId = await sendTelegram(fullMsg, null, CFG.tgThreadSignal);
    }
    if (!NOTIF_ONLY_AUTO) totalNotified++;
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
function isManualSellDetected(e) {
  return e && e.code === 'MANUAL_SELL_DETECTED';
}

async function notifyManualSellDetected(ca, pos, currentPrice, gain, triggerLabel, err) {
  var walletTokenBalance = Number(err.walletTokenBalance || 0);
  log('[AUTOSELL] Manual sell detected ' + pos.symbol + ' via ' + triggerLabel + ' - stop tracking');
  logTrackingEvent({
    type: 'MANUAL_SELL_DETECTED',
    trigger: triggerLabel,
    ca, ...pos,
    currentPrice,
    gain: Number(gain.toFixed(1)),
    walletTokenBalance,
  });

  await sendTelegram(
    'INFO: POSISI SUDAH SELL MANUAL\n' +
    '<b>' + pos.name + '</b> (<code>' + pos.symbol + '</code>)\n' +
    'Trigger bot: ' + triggerLabel + '\n' +
    'Entry: $' + pos.entryPrice.toFixed(10) + '\n' +
    'Sekarang: $' + currentPrice.toFixed(10) + '\n' +
    (gain >= 0 ? 'Gain: +' : 'Loss: ') + gain.toFixed(1) + '%\n' +
    'Token di wallet: ' + walletTokenBalance + '\n' +
    'Bot stop tracking posisi ini supaya tidak spam error sell.\n' +
    '<a href="https://dexscreener.com/solana/' + ca + '">Chart</a>',
    pos.autoBuyMsgId || null, CFG.tgThreadAuto
  );
}

function isFixedTpSellPosition(pos) {
  return String(pos.mode || '').toUpperCase() === 'MIGRATION'
    && isLooseMigEntryMode(pos.entryMode || AUTO_BUY.MIG_ENTRY_MODE);
}

async function sellFixedTpPosition(ca, pos, currentPrice, gain, target) {
  log('[AUTOSELL] Fixed TP ' + pos.symbol + ' +' + target + '% (' + gain.toFixed(1) + '%)');
  var sellResult = await sellToken(ca, pos.tokenAmount, pos.tokenDecimals, AUTO_SELL.SLIPPAGE_BPS, pos.tokenAmount * currentPrice);
  var solIn = pos.amountSol || AUTO_BUY.AMOUNT_SOL;
  var solOut = AUTO_BUY.DRY_RUN ? solIn * (1 + gain / 100) : (sellResult.solReceived || 0);
  var solPnl = solOut - solIn;

  await sendTelegram(
    '✅ AUTO SELL — FIXED TP\n' +
    '<b>' + esc(pos.name) + '</b> (<code>' + esc(pos.symbol) + '</code>)\n' +
    'Target: +' + target + '%\n' +
    'Entry: $' + fmtPrice(pos.entryPrice) + '\n' +
    'Exit: $' + fmtPrice(currentPrice) + '\n' +
    'Gain: <b>+' + gain.toFixed(1) + '%</b>\n' +
    'SOL Keluar: ' + solIn.toFixed(4) + ' → Dapat: ' + solOut.toFixed(4) + ' SOL\n' +
    'PNL: <b>' + (solPnl >= 0 ? '+' : '') + solPnl.toFixed(4) + ' SOL</b>\n' +
    'Status: sell semua, stop tracking\n' +
    (AUTO_BUY.DRY_RUN ? '' : 'TX: <code>' + sellResult.txSignature + '</code>\n') +
    '<a href="https://dexscreener.com/solana/' + ca + '">Chart</a>',
    pos.autoBuyMsgId || null, CFG.tgThreadAuto
  );

  logTrackingEvent({
    type: AUTO_BUY.DRY_RUN ? 'AUTOSELL_FIXED_TP_DRY_RUN' : 'AUTOSELL_FIXED_TP',
    ca, ...pos, currentPrice, target, gain: Number(gain.toFixed(1)), solPnl,
    txSell: sellResult.txSignature,
  });
}

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

    if (!pos.bought) {
      var autoBuyChanged = await retryPendingAutoBuy(ca, pos, currentPrice);
      if (autoBuyChanged) savePositions();
      continue;
    }

    var gain = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

    // ── AUTO SELL: Cutloss ──
    if (pos.bought && AUTO_SELL.ENABLED && gain <= -(AUTO_SELL.CUTLOSS_PCT)) {
      log('[AUTOSELL] Cutloss ' + pos.symbol + ' (' + gain.toFixed(1) + '%)');
      try {
        var sellResult = await sellToken(ca, pos.tokenAmount, pos.tokenDecimals, AUTO_SELL.SLIPPAGE_BPS, pos.tokenAmount * currentPrice);
        var solIn    = pos.amountSol || AUTO_BUY.AMOUNT_SOL;
        var solOut   = AUTO_BUY.DRY_RUN ? solIn * (1 + gain / 100) : (sellResult.solReceived || 0);
        var solPnl   = solOut - solIn;
        await sendTelegram(
          '🔴 AUTO SELL — CUTLOSS\n' +
          '<b>' + pos.name + '</b> (<code>' + pos.symbol + '</code>)\n' +
          'Entry: $' + pos.entryPrice.toFixed(10) + '\n' +
          'Exit: $' + currentPrice.toFixed(10) + '\n' +
          'Loss: <b>' + gain.toFixed(1) + '%</b>\n' +
          'SOL Keluar: ' + solIn.toFixed(4) + ' → Dapat: ' + solOut.toFixed(4) + ' SOL\n' +
          'PNL: <b>' + (solPnl >= 0 ? '+' : '') + solPnl.toFixed(4) + ' SOL</b>\n' +
          (AUTO_BUY.DRY_RUN ? '' : 'TX: <code>' + sellResult.txSignature + '</code>\n') +
          '<a href="https://dexscreener.com/solana/' + ca + '">Chart</a>',
          pos.autoBuyMsgId || null, CFG.tgThreadAuto
        );
        logTrackingEvent({
          type: AUTO_BUY.DRY_RUN ? 'AUTOSELL_CL_DRY_RUN' : 'CUT_LOSS',
          ca, ...pos, currentPrice, gain: Number(gain.toFixed(1)), solPnl,
        });
        toRemove.push(ca);
      } catch (e) {
        if (isManualSellDetected(e)) {
          await notifyManualSellDetected(ca, pos, currentPrice, gain, 'CUTLOSS', e);
          toRemove.push(ca);
          savePositions();
          continue;
        }
        log('[AUTOSELL] Error cutloss ' + pos.symbol + ': ' + e.message + ' — posisi TETAP di-track, akan dicoba jual lagi cycle berikutnya');
        pos.sellFailCount = (pos.sellFailCount || 0) + 1;
        if (pos.sellFailCount >= 5) {
          log('[AUTOSELL] ' + pos.symbol + ' gagal jual 5x berturut-turut — cek manual! Tetap di-track tapi butuh perhatian.');
        }
        await sendTelegram(
          '⚠️ GAGAL JUAL — CUTLOSS\n' +
          '<b>' + pos.name + '</b> (<code>' + pos.symbol + '</code>)\n' +
          'Loss: ' + gain.toFixed(1) + '% | Percobaan gagal: ' + pos.sellFailCount + 'x\n' +
          'Error: <code>' + esc(e.message) + '</code>\n' +
          (pos.sellFailCount >= 5 ? '🔴 Sudah gagal 5x berturut-turut, cek manual!\n' : '') +
          '<a href="https://dexscreener.com/solana/' + ca + '">Chart</a>',
          pos.autoBuyMsgId || null, CFG.tgThreadAuto
        );
        savePositions();
      }
      continue;
    }

    // ── AUTO SELL: Fixed TP sekali (non-trailing) ──
    if (pos.bought && AUTO_SELL.ENABLED && AUTO_SELL.FIXED_TP_ENABLED && isFixedTpSellPosition(pos) && gain >= AUTO_SELL.FIXED_TP_PCT) {
      try {
        await sellFixedTpPosition(ca, pos, currentPrice, gain, AUTO_SELL.FIXED_TP_PCT);
        toRemove.push(ca);
      } catch (e) {
        if (isManualSellDetected(e)) {
          await notifyManualSellDetected(ca, pos, currentPrice, gain, 'FIXED TP', e);
          toRemove.push(ca);
          savePositions();
          continue;
        }
        log('[AUTOSELL] Error fixed TP ' + pos.symbol + ': ' + e.message + ' — posisi TETAP di-track, akan dicoba jual lagi cycle berikutnya');
        pos.sellFailCount = (pos.sellFailCount || 0) + 1;
        await sendTelegram(
          '⚠️ GAGAL JUAL — FIXED TP\n' +
          '<b>' + esc(pos.name) + '</b> (<code>' + esc(pos.symbol) + '</code>)\n' +
          'Target: +' + AUTO_SELL.FIXED_TP_PCT + '% | Gain: +' + gain.toFixed(1) + '% | Percobaan gagal: ' + pos.sellFailCount + 'x\n' +
          'Error: <code>' + esc(e.message) + '</code>\n' +
          '<a href="https://dexscreener.com/solana/' + ca + '">Chart</a>',
          pos.autoBuyMsgId || null, CFG.tgThreadAuto
        );
        savePositions();
      }
      continue;
    }

    // ── AUTO SELL: Trailing TP ──
    if (pos.bought && AUTO_SELL.ENABLED && AUTO_SELL.TRAILING_ENABLED && (pos.trailingActive || gain >= AUTO_SELL.TRAILING_START_PCT)) {
      if (!pos.trailingActive) {
        pos.trailingActive = true;
        pos.peak = currentPrice;
        log('[AUTOSELL] Trailing aktif ' + pos.symbol + ' peak $' + currentPrice.toFixed(10));
        savePositions();
      } else if (currentPrice > pos.peak) {
        pos.peak = currentPrice;
        savePositions();
      }
      var dropFromPeak = ((currentPrice - pos.peak) / pos.peak) * 100;
      if (dropFromPeak <= -(AUTO_SELL.TRAILING_DROP_PCT)) {
        log('[AUTOSELL] Trailing TP ' + pos.symbol + ' (drop ' + dropFromPeak.toFixed(1) + '% dari peak)');
        try {
          var sellResult = await sellToken(ca, pos.tokenAmount, pos.tokenDecimals, AUTO_SELL.SLIPPAGE_BPS, pos.tokenAmount * currentPrice);
          var peakGain = ((pos.peak - pos.entryPrice) / pos.entryPrice) * 100;
          var solIn    = pos.amountSol || AUTO_BUY.AMOUNT_SOL;
          var solOut   = AUTO_BUY.DRY_RUN ? solIn * (1 + gain / 100) : (sellResult.solReceived || 0);
          var solPnl   = solOut - solIn;
          await sendTelegram(
            '✅ AUTO SELL — TRAILING TP\n' +
            '<b>' + pos.name + '</b> (<code>' + pos.symbol + '</code>)\n' +
            'Entry: $' + pos.entryPrice.toFixed(10) + '\n' +
            'Peak: $' + pos.peak.toFixed(10) + ' (+' + peakGain.toFixed(1) + '%)\n' +
            'Exit: $' + currentPrice.toFixed(10) + ' (+' + gain.toFixed(1) + '%)\n' +
            'SOL Keluar: ' + solIn.toFixed(4) + ' → Dapat: ' + solOut.toFixed(4) + ' SOL\n' +
            'PNL: <b>+' + solPnl.toFixed(4) + ' SOL</b>\n' +
            (AUTO_BUY.DRY_RUN ? '' : 'TX: <code>' + sellResult.txSignature + '</code>\n') +
            '<a href="https://dexscreener.com/solana/' + ca + '">Chart</a>',
            pos.autoBuyMsgId || null, CFG.tgThreadAuto
          );
          logTrackingEvent({
            type: AUTO_BUY.DRY_RUN ? 'AUTOSELL_TP_DRY_RUN' : 'AUTOSELL_TP',
            ca, ...pos, currentPrice, gain: Number(gain.toFixed(1)), peakGain: Number(peakGain.toFixed(1)), solPnl,
          });
          toRemove.push(ca);
        } catch (e) {
          if (isManualSellDetected(e)) {
            await notifyManualSellDetected(ca, pos, currentPrice, gain, 'TRAILING TP', e);
            toRemove.push(ca);
            savePositions();
            continue;
          }
          log('[AUTOSELL] Error trailing ' + pos.symbol + ': ' + e.message + ' — posisi TETAP di-track, akan dicoba jual lagi cycle berikutnya');
          pos.sellFailCount = (pos.sellFailCount || 0) + 1;
          if (pos.sellFailCount >= 5) {
            log('[AUTOSELL] ' + pos.symbol + ' gagal jual 5x berturut-turut — cek manual! Tetap di-track tapi butuh perhatian.');
          }
          await sendTelegram(
            '⚠️ GAGAL JUAL — TRAILING TP\n' +
            '<b>' + pos.name + '</b> (<code>' + pos.symbol + '</code>)\n' +
            'Gain saat ini: +' + gain.toFixed(1) + '% | Percobaan gagal: ' + pos.sellFailCount + 'x\n' +
            'Error: <code>' + esc(e.message) + '</code>\n' +
            (pos.sellFailCount >= 5 ? '🔴 Sudah gagal 5x berturut-turut, cek manual!\n' : '') +
            '<a href="https://dexscreener.com/solana/' + ca + '">Chart</a>',
            pos.autoBuyMsgId || null, CFG.tgThreadAuto
          );
          savePositions();
        }
        continue;
      }
    }

    if (gain <= -80) {
      var wasProfit   = (pos.nextTargetIdx || 0) > 0;
      var stopType    = wasProfit ? 'STOP_TRACK_WAS_PROFIT' : 'STOP_TRACK';
      log(pos.symbol + ' dropped >80%, stop tracking' + (wasProfit ? ' [was profit]' : ''));
      logTrackingEvent({ type: stopType, ...pos, currentPrice, gain: gain.toFixed(1) });
      toRemove.push(ca);
      continue;
    }

    if (pos.bought) {
      var highestIdx = -1;
      for (var ti = 0; ti < TARGETS.length; ti++) {
        if (gain >= TARGETS[ti]) highestIdx = ti;
      }
      if (highestIdx >= 0 && highestIdx >= pos.nextTargetIdx) {
        var target = TARGETS[highestIdx];
        log(pos.symbol + ' hit target +' + target + '%');
        logTrackingEvent({ type: 'TERCAPAI', ...pos, currentPrice, target, gain: gain.toFixed(1) });
        var targetEmoji = target >= 100 ? '🚀' : target >= 50 ? '📈' : '🎯';
        var modeLabel = pos.mode === 'SWING' ? 'Swing' : 'New Migration';
        var gradeEmoji = pos.grade === 'GOLD' ? '🟢' : pos.grade === 'POTENSIAL' ? '🟡' : '🔴';
        var riskLabel = pos.grade === 'GOLD' ? 'Grade A' : pos.grade === 'POTENSIAL' ? 'Grade B' : 'Grade C';
        var targetThread = pos.autoBuyMsgId
          ? CFG.tgThreadAuto
          : (pos.threadId || (pos.mode === 'SWING' ? CFG.tgThreadId : CFG.tgThreadMig));

        // Estimasi profit SOL — hanya tersedia kalau posisi ini hasil autobuy (punya amountSol & tokenAmount)
        // Format disamakan dengan notif Trailing TP / Cutloss: baris "SOL Keluar → Dapat" + baris "PNL" terpisah
        var profitLine = '';
        if (pos.amountSol && pos.tokenAmount) {
          var solIn  = pos.amountSol;
          var solOut = solIn * (1 + gain / 100); // estimasi searah dgn gain%, sama seperti dry-run di trailing TP
          var solPnl = solOut - solIn;
          profitLine = 'SOL Keluar: ' + solIn.toFixed(4) + ' → Dapat: ' + solOut.toFixed(4) + ' SOL\n' +
                       'PNL: <b>+' + solPnl.toFixed(4) + ' SOL</b>\n';
        }

        await sendTelegram(
          gradeEmoji + ' ' + riskLabel + ' | ' + modeLabel + ' | ' + targetEmoji + ' <b>TP' + (highestIdx + 1) + ' +' + target + '% Tercapai</b>\n' +
          '<b>' + esc(pos.name) + '</b> (<code>' + esc(pos.symbol) + '</code>)\n' +
          'Entry: $' + fmtPrice(pos.entryPrice) + '\n' +
          'Sekarang: $' + fmtPrice(currentPrice) + '\n' +
          'Gain: <b>+' + gain.toFixed(1) + '%</b>\n' +
          profitLine +
          'Status: tracking target, bukan auto sell\n' +
          '<a href="https://dexscreener.com/solana/' + ca + '">Chart</a>' +
          ' | <a href="https://gmgn.ai/sol/token/' + ca + '">GMGN</a>',
          pos.autoBuyMsgId || pos.msgId || null,
          targetThread
        );
        pos.nextTargetIdx = highestIdx + 1;
        savePositions();
      }
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
log('  LP >= $' + CFG.minLp.toLocaleString() + ' | Rug <= ' + CFG.maxRugScore + ' [RugCheck API]');
log('  GMGN Rug <= ' + Math.round(CFG.gmgnRugMaxRatio * 100) + '% [gmgn-cli rug_ratio, cek sebelum RugCheck]');
log('  Age: max ' + CFG.migMaxAgeH + 'j (jeda settle data ' + CFG.migMinAgeMin + 'm)');
log('  Insider < ' + CFG.maxInsiderPct + '% [RugCheck API]');
log('  GMGN holder hard skip: Bundler > ' + CFG.maxBundlerPct + '% | Top10 > ' + CFG.maxTop10Holders + '%');
log('  GMGN risk warning: CreatorHold > ' + CFG.maxDevHold + '% | Sniper > ' + CFG.maxSniperPct + '% | Vol/LP > ' + CFG.maxVolLpRatio + 'x');
log('  Momentum hard skip: Vol1h < $' + CFG.minVol1h.toLocaleString() + ' | Txns5m < ' + CFG.minSwaps5m + ' | Vol5m < $' + CFG.minVol5m.toLocaleString());
log('  Creator tokens < ' + CFG.maxCreatorTokens + ' (serial creator check)');
log('  (GMGN Rug gate <= ' + Math.round(CFG.gmgnRugMaxRatio * 100) + '% berlaku juga di Swing & Signal)');
log('[ Auto-Buy MIGRATION Entry ]');
log('  Entry mode: ' + AUTO_BUY.MIG_ENTRY_MODE);
if (AUTO_BUY.MIG_ENTRY_MODE === 'TIGHT') {
  var _u = CFG.migTightFibUpper.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  var _l = CFG.migTightFibLower.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  var _m = ((CFG.migTightFibUpper + CFG.migTightFibLower) / 2).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  log('  Fib zone: ' + _u + ' (aggressive ' + _u + '-' + _m + ' | normal ' + _m + '-' + _l + ')');
  log('  Momentum check: ' + (CFG.migTightRequireMomentum ? 'ON (min buy ratio ' + CFG.migTightMinBuyRatio + '%)' : 'OFF (buy hanya berdasarkan zona Fib)'));
}
log('[ Mode 2: Swing 1D Pre-Pump ]');
log('  LP >= $' + CFG.swingMinLp.toLocaleString() + ' | Vol24h >= $' + CFG.swingMinVol24h.toLocaleString());
log('  Max pump 1h: ' + CFG.swingMaxChange1h + '% | Max pump 24h: ' + CFG.swingMaxChange24h + '%');
log('  Vol spike signal: ' + CFG.swingVolSpikeMin + 'x | Holders min: ' + CFG.swingMinHolders);
log('  Age: >= ' + CFG.swingMinAge + 'j');
log('[ Auto Sell ]');
log('  Master: ' + (AUTO_SELL.ENABLED ? 'ON' : 'OFF') + ' | TP Mode: ' + AUTO_SELL.TP_MODE + ' | Cutloss: -' + AUTO_SELL.CUTLOSS_PCT + '%');
log('  Fixed TP: +' + AUTO_SELL.FIXED_TP_PCT + '% | Trailing: start +' + AUTO_SELL.TRAILING_START_PCT + '% drop ' + AUTO_SELL.TRAILING_DROP_PCT + '%');
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
