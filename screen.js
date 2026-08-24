require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  shouldSkipNewMigration,
  collectMigrationHardRiskReasons,
  shouldSkipMigrationHardRisk,
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
  // Batas umur BAWAH khusus mode MIGRATION (opsional). Default 0 = gak ada
  // batas bawah sama sekali, behavior lama (cuma max yang dicek).
  minAgeHoursMig:  Number(process.env.MIN_AGE_HOURS_MIG) || 0,

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

  // Gate berbasis skor RISK INDIVIDUAL RugCheck — KHUSUS mode MIGRATION.
  // RugCheck ngasih tiap risk item skor numerik sendiri (mis. "High holder
  // correlation" score:15, "Single holder ownership" score:8000) — beda
  // dari skor total gabungan. maxSingleRiskScore = 0 artinya: ADA SATU
  // risk aja yang skornya > 0 → skip, apapun namanya (gak match nama
  // string, jadi tetap jalan walau RugCheck reword nama risk-nya nanti).
  // RUGCHECK_RISK_GATE_ENABLED=false buat matiin gate ini kalau ternyata
  // kebanyakan token normal ikut kena (terlalu strict).
  rugCheckRiskGateEnabled: (process.env.RUGCHECK_RISK_GATE_ENABLED || 'true').trim().toLowerCase() !== 'false',
  maxSingleRiskScore:      Number(process.env.MAX_SINGLE_RISK_SCORE) || 0,
  // Skip otomatis kalau RugCheck vonis token ini pernah di-rug (d.rugged === true).
  skipIfRugged: (process.env.SKIP_IF_RUGGED || 'true').trim().toLowerCase() !== 'false',

  narrativeTopK:      Number(process.env.NARRATIVE_TOP_K)      || 3,
  narrativeMinCluster:Number(process.env.NARRATIVE_MIN_CLUSTER)|| 2,
  narrativeMinHeat:   Number(process.env.NARRATIVE_MIN_HEAT)   || 4,
  narrativeDynamic:   process.env.NARRATIVE_DYNAMIC_ENABLED !== 'false',

  // ─────────────────────────────────────────────
  //  CANDLE ENTRY (breakout / fullback) — KHUSUS MODE MIGRATION.
  //  Kalau ON, notif MIGRATION GAK LANGSUNG dikirim begitu lolos gate dasar,
  //  tapi nunggu pola candle dulu:
  //   - BREAKOUT: body candle hijau, jauh lebih panjang dari body candle
  //     sebelumnya (bukan cuma wick), DAN close-nya berhasil tembus di atas
  //     level resistance yang sebelumnya sudah gagal ditembus (rejection).
  //   - FULLBACK (pullback): sesudah tren naik, muncul candle body KECIL
  //     (warna apa saja, ekor besar/kecil gak masalah) — tanda momentum
  //     reda / market ancang-ancang balik arah, dipakai sbg titik entry
  //     retrace yang searah tren.
  //  SWING TIDAK TERPENGARUH SAMA SEKALI — tetap notif langsung seperti biasa.
  //  CATATAN: versi GitHub ini TIDAK pakai Birdeye/GeckoTerminal/DexPaprika
  //  — candle cuma diambil dari GMGN kline (behavior tier terakhir di lokal).
  // ─────────────────────────────────────────────
  migCandleEntryEnabled: isTruthyFlag(process.env.MIG_CANDLE_ENTRY_ENABLED),
  // Resolusi candle yang dipakai buat deteksi pola (kline GMGN).
  migCandleResolution: process.env.MIG_CANDLE_RESOLUTION || '5m',
  // Berapa banyak candle history diambil buat hitung avg body & cari level resistance.
  migCandleLookback:   Number(process.env.MIG_CANDLE_LOOKBACK) || 30,
  // BREAKOUT: body candle terakhir harus >= sekian x rata-rata body N candle sebelumnya.
  migBreakoutBodyMult: Number(process.env.MIG_BREAKOUT_BODY_MULT) || 1.8,
  // BREAKOUT: wick (ekor) atas+bawah candle breakout maksimal sekian % dari body-nya
  // (biar "ekor dikit gak masalah" tapi bukan body kecil ekor panjang).
  migBreakoutMaxWickPct: Number(process.env.MIG_BREAKOUT_MAX_WICK_PCT) || 40,
  // BREAKOUT: berapa candle ke belakang dicek buat nyari "level kuat yang gagal
  // ditembus" (resistance yang pernah ada rejection, bukan sekadar high tertinggi).
  migResistanceLookback: Number(process.env.MIG_RESISTANCE_LOOKBACK) || 20,
  // FULLBACK: body candle dianggap "kecil" kalau <= sekian x rata-rata body
  // candle sebelumnya.
  migFullbackBodyMax: Number(process.env.MIG_FULLBACK_BODY_MAX) || 0.6,
  // FULLBACK: minimal berapa candle naik (higher close berturut2 dominan)
  // sebelum candle kecil, biar valid dianggap "napas di tengah uptrend"
  // bukan cuma noise di awal.
  migFullbackMinUptrendCandles: Number(process.env.MIG_FULLBACK_MIN_UPTREND) || 3,
  // Timeout watchlist candle entry — kalau sampai sekian menit gak ada pola
  // breakout/fullback yang muncul, token di-drop dari watchlist (biar gak
  // numpuk nunggu selamanya). 0 = gak ada timeout (nunggu terus).
  migCandleWatchTimeoutMin: Number(process.env.MIG_CANDLE_WATCH_TIMEOUT_MIN) || 180,
  // Interval recheck watchlist candle-entry (breakout/fullback) MIGRATION,
  // detik. Candle butuh waktu terbentuk (beda sama cek harga tiap detik),
  // jadi default lebih longgar drpd fibEntryPollInterval.
  migCandleEntryPollInterval: Number(process.env.MIG_CANDLE_ENTRY_POLL_INTERVAL) || 30,

  // ─────────────────────────────────────────────
  //  FIB ENTRY — gate opsional sebelum notif MIGRATION. Kalau OFF (default)
  //  dan CFG.migCandleEntryEnabled juga OFF, notif tetap jalan seperti biasa
  //  (langsung notif di harga sekarang begitu lolos grading). Kalau ON,
  //  token yang lolos grading masuk watchlist dulu dan BARU notif begitu
  //  harga retrace ke level fib target — level fib dihitung ulang tiap
  //  cycle dari swing terbaru (dinamis, gak dikunci).
  //  KHUSUS MIGRATION (SWING tidak disentuh versi GitHub ini).
  // ─────────────────────────────────────────────
  fibEntryEnabled: isTruthyFlag(process.env.FIB_ENTRY_ENABLED),
  // 'fair' | 'support' | angka custom rasio retracement (mis. 0.65)
  fibEntryLevel:      process.env.FIB_ENTRY_LEVEL || 'fair',
  fibEntryTolerancePct: Number(process.env.FIB_ENTRY_TOLERANCE_PCT) || 2,
  // Mode yang pakai gate ini — CSV. Dikunci ke MIGRATION saja di versi GitHub ini.
  fibEntryModes: (process.env.FIB_ENTRY_MODES || 'MIGRATION')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
  // Interval khusus recheck watchlist fib-entry (PENDING_ENTRY), independen
  // dari POLL_INTERVAL (scan token baru).
  fibEntryPollInterval: Number(process.env.FIB_ENTRY_POLL_INTERVAL) || 15,

  // Fib Entry — auto-drop dari watchlist kalau harga udah tembus DI BAWAH
  // target entry (BELOW_ZONE) pas di-refresh checkPendingEntries(). Default
  // OFF biar behavior lama (nunggu terus) tetap jalan kalau env var ini
  // gak diisi.
  fibDropBelowZoneEnabled: isTruthyFlag(process.env.FIB_DROP_BELOW_ZONE_AFTER_REFRESH),
  fibDropBelowZonePct: Number(process.env.FIB_DROP_BELOW_ZONE_PCT) || 5,

  // Fib Entry — skip gate KHUSUS MODE MIGRATION (langsung fallback ke notif
  // normal, gated:false) kalau token masih terlalu "mentah". Default OFF (0).
  fibMinAgeMinutes:    Number(process.env.FIB_MIN_AGE_MINUTES)    || 0,
  fibMinLiquidityUsd:  Number(process.env.FIB_MIN_LIQUIDITY_USD)  || 0,
  fibMinMarketCapUsd:  Number(process.env.FIB_MIN_MARKET_CAP_USD) || 0,

  // Rasio "support" fib — default sesuai fib klasik: 0.500 pas swing bullish
  // (retrace dari high), 0.272 pas swing bearish (retrace dari low).
  fibSupportRatioBullish: Number(process.env.FIB_SUPPORT_RATIO_BULLISH) || 0.500,
  fibSupportRatioBearish: Number(process.env.FIB_SUPPORT_RATIO_BEARISH) || 0.272,

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
  // Toggle kirim Telegram. Default nyala (true). Set TG_ENABLED='false' di
  // workflow/env buat matiin sementara (misal lagi testing), tanpa ubah kode.
  tgEnabled:       process.env.TG_ENABLED !== 'false',
  tgToken:         process.env.TG_TOKEN,
  tgChatId:        process.env.TG_CHAT_ID,
  tgThreadId:      Number(process.env.TG_THREAD_ID)      || undefined,  // Swing 1D
  tgThreadMig:     Number(process.env.TG_THREAD_MIG)     || undefined,  // New Migration
  tgThreadEntry:   Number(process.env.TG_THREAD_ENTRY)   || undefined,  // Entry Signal
  tgThreadAuto:    Number(process.env.TG_THREAD_AUTO)    || undefined,  // Notif Candle/Fib Entry (simulasi buy)
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
const PENDING_ENTRY_FILE = path.join(__dirname, 'pending_entries.json');
const CANDLE_ENTRY_WATCH_FILE = path.join(__dirname, 'candle_entry_watch.json');
const LOG_FILE      = path.join(__dirname, 'screen.log');
const TRACKING_LOG  = path.join(__dirname, 'tracking_log.json');

const SEEN    = new Map();
const TRACKED = new Map();
// Watchlist token MIGRATION yang lolos grading tapi belum entry — dipakai
// kalau CFG.fibEntryEnabled true. Key = address, value = { symbol, name,
// grade, mode, address, addedAt, target, fibSource, ...zoneFields }.
const PENDING_ENTRY = new Map();
// Watchlist KHUSUS MIGRATION buat gate candle entry (breakout/fullback) —
// dipakai kalau CFG.migCandleEntryEnabled true. Terpisah dari PENDING_ENTRY
// (fib entry) karena logic re-check-nya beda (nunggu pola candle, bukan
// nunggu harga hit level angka tertentu).
const CANDLE_ENTRY_WATCH = new Map();
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

function loadPendingEntries() {
  try {
    const data = JSON.parse(fs.readFileSync(PENDING_ENTRY_FILE, 'utf8'));
    for (const [ca, entry] of Object.entries(data.entries || {})) PENDING_ENTRY.set(ca, entry);
    log('Loaded ' + PENDING_ENTRY.size + ' pending fib-entry');
  } catch { log('No existing pending_entries.json, starting fresh'); }
}

function savePendingEntries() {
  try {
    fs.writeFileSync(PENDING_ENTRY_FILE, JSON.stringify({
      version: 1, savedAt: Date.now(), entries: Object.fromEntries(PENDING_ENTRY),
    }));
  } catch (e) { log('Failed to save pending_entries.json: ' + e.message); }
}

// Persist watchlist candle-entry (breakout/fullback) KHUSUS MIGRATION —
// pola sama persis dengan loadPendingEntries/savePendingEntries di atas.
function loadCandleEntryWatch() {
  try {
    const data = JSON.parse(fs.readFileSync(CANDLE_ENTRY_WATCH_FILE, 'utf8'));
    for (const [ca, entry] of Object.entries(data.entries || {})) CANDLE_ENTRY_WATCH.set(ca, entry);
    log('Loaded ' + CANDLE_ENTRY_WATCH.size + ' pending candle-entry (MIGRATION)');
  } catch { log('No existing candle_entry_watch.json, starting fresh'); }
}

function saveCandleEntryWatch() {
  try {
    fs.writeFileSync(CANDLE_ENTRY_WATCH_FILE, JSON.stringify({
      version: 1, savedAt: Date.now(), entries: Object.fromEntries(CANDLE_ENTRY_WATCH),
    }));
  } catch (e) { log('Failed to save candle_entry_watch.json: ' + e.message); }
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
    { name: 'pending_entries.json', path: PENDING_ENTRY_FILE },
    { name: 'candle_entry_watch.json', path: CANDLE_ENTRY_WATCH_FILE },
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
    rug_ratio:          t.rug_ratio == null ? null : Number(t.rug_ratio),
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
      '--max-created ' + Math.round(CFG.maxAgeHours * 60) + 'm',  // umur < maxAgeHours jam
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
    if (list.length > 0) {
      log('[MIG DEBUG] raw field pertama: ' + JSON.stringify(Object.keys(list[0])));
      log('[MIG DEBUG] raw sample: ' + JSON.stringify(list[0]).slice(0, 1500));
    }
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
      rug_ratio:     d.rug_ratio == null ? null : Number(d.rug_ratio),
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

// Cache 90s + cooldown per address+resolution — dibutuhkan karena watchlist
// candle-entry & fib-entry bisa manggil fungsi ini berkali-kali per cycle
// (recheck tiap CFG.migCandleEntryPollInterval / CFG.fibEntryPollInterval
// detik), tanpa proteksi ini rawan kena rate-limit GMGN.
const GMGN_KLINE_CACHE_TTL_MS = 90 * 1000;
const GMGN_KLINE_COOLDOWN_MS  = 5 * 60 * 1000;
const gmgnKlineCache = new Map();
let gmgnKlineCooldownUntil = 0;
let gmgnKlineLoggedSkip = false;

function getGMGNKlineCached(key) {
  const hit = gmgnKlineCache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) { gmgnKlineCache.delete(key); return undefined; }
  return hit.data;
}
function setGMGNKlineCached(key, data) {
  gmgnKlineCache.set(key, { data, expiresAt: Date.now() + GMGN_KLINE_CACHE_TTL_MS });
}
function isGMGNKlineCoolingDown() {
  if (Date.now() >= gmgnKlineCooldownUntil) return false;
  if (!gmgnKlineLoggedSkip) {
    log('[GMGN KLINE] Cooldown aktif (rate-limit) — semua request di-skip sampai '
      + new Date(gmgnKlineCooldownUntil).toLocaleTimeString() + '.');
    gmgnKlineLoggedSkip = true;
  }
  return true;
}
function enterGMGNKlineCooldown() {
  gmgnKlineCooldownUntil = Date.now() + GMGN_KLINE_COOLDOWN_MS;
  gmgnKlineLoggedSkip    = false;
  log('[GMGN KLINE] Masuk cooldown: rate-limit — di-skip selama ' + Math.round(GMGN_KLINE_COOLDOWN_MS / 60000)
    + ' menit (sampai ' + new Date(gmgnKlineCooldownUntil).toLocaleTimeString() + ')');
}
function clearGMGNKlineCooldownIfNeeded() {
  if (gmgnKlineCooldownUntil > 0) {
    log('[GMGN KLINE] Pulih — request berhasil lagi, cooldown dihapus.');
    gmgnKlineCooldownUntil = 0;
    gmgnKlineLoggedSkip    = false;
  }
}

async function fetchGMGNKline(address, resolution, fromSec, toSec) {
  const cacheKey = address + ':' + resolution;
  const cached = getGMGNKlineCached(cacheKey);
  if (cached !== undefined) return cached;
  if (isGMGNKlineCoolingDown()) return null; // short-circuit — gak nembak API sama sekali

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

    clearGMGNKlineCooldownIfNeeded(); // request sukses -> kalau sebelumnya cooldown, berarti udah pulih

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

    setGMGNKlineCached(cacheKey, list);
    return list;
  } catch (e) {
    log('Kline error ' + address.slice(0, 8) + ': ' + e.message
      + (e.response?.status === 429 ? ' (rate limited)' : ''));
    if (e.response?.status === 429) enterGMGNKlineCooldown();
    setGMGNKlineCached(cacheKey, null);
    return null;
  }
}

// ─────────────────────────────────────────────
//  CANDLE ENTRY (breakout / fullback) — KHUSUS MODE MIGRATION.
//  Lihat CFG.migCandleEntryEnabled dkk untuk parameter. Fitur ini TIDAK
//  menyentuh SWING sama sekali.
//  CATATAN versi GitHub: candle CUMA diambil dari GMGN kline (gak ada
//  Birdeye/GeckoTerminal/DexPaprika di versi ini).
// ─────────────────────────────────────────────

// Normalisasi array candle mentah jadi bentuk { time, open, high, low,
// close }, urut lama->baru, dengan fallback open (proxy dari close candle
// sebelumnya) kalau sumbernya gak ngasih open.
function normalizeCandles(raw, address, sourceLabel) {
  if (!raw || raw.length < 3) return null;

  let usedOpenFallback = false;
  const candles = raw
    .map(c => ({
      time:  Number(c.time ?? c.timestamp ?? c.t ?? 0),
      open:  Number(c.open ?? c.o),
      high:  Number(c.high ?? c.h),
      low:   Number(c.low  ?? c.l),
      close: Number(c.close ?? c.c),
    }))
    .filter(c => c.close > 0 && c.high > 0 && c.low > 0)
    .sort((a, b) => a.time - b.time);

  for (let i = 0; i < candles.length; i++) {
    if (!(candles[i].open > 0)) {
      usedOpenFallback = true;
      candles[i].open = i > 0 ? candles[i - 1].close : candles[i].close;
    }
  }
  if (usedOpenFallback) {
    log('[MIG CANDLE] ' + address.slice(0, 8) + ' (' + sourceLabel + ') — field "open" gak tersedia, pakai fallback close-candle-sebelumnya sbg proxy open.');
  }

  return candles.length >= 3 ? candles : null;
}

// Ambil candle buat deteksi pola breakout/fullback MIGRATION — versi
// GitHub cuma pakai GMGN kline (resolusi tetap dari CFG.migCandleResolution).
async function fetchMigCandles(address) {
  const nowSec = Math.floor(Date.now() / 1000);
  const resolution = CFG.migCandleResolution;
  const secPerCandle = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 }[resolution] || 300;
  const fromSec = nowSec - Math.ceil(CFG.migCandleLookback * secPerCandle * 1.5);
  const rawGmgn = await fetchGMGNKline(address, resolution, fromSec, nowSec);
  const gmgnCandles = normalizeCandles(rawGmgn, address, 'gmgn_' + resolution);
  if (gmgnCandles && gmgnCandles.length >= 3) {
    return gmgnCandles.slice(-CFG.migCandleLookback);
  }
  return null;
}

// Deteksi BREAKOUT: candle terakhir body hijau, body panjang secara relatif
// (>= migBreakoutBodyMult x rata-rata body candle2 sebelumnya), wick kecil
// (ekor total <= migBreakoutMaxWickPct% dari body), DAN close-nya berhasil
// tembus di atas level resistance yang sebelumnya sudah gagal ditembus.
function detectMigBreakout(candles) {
  if (!candles || candles.length < 5) return null;
  const last = candles[candles.length - 1];
  const history = candles.slice(0, -1);

  const bodies = history.map(c => Math.abs(c.close - c.open)).filter(b => b > 0);
  const avgBody = bodies.length > 0 ? bodies.reduce((a, b) => a + b, 0) / bodies.length : 0;
  if (!(avgBody > 0)) return null;

  const lastBody = last.close - last.open; // positif = hijau
  if (!(lastBody > 0)) return null; // wajib candle hijau

  const bodyRatio = lastBody / avgBody;
  if (bodyRatio < CFG.migBreakoutBodyMult) return null; // body belum cukup "besar"

  const upperWick = last.high - last.close;
  const lowerWick = last.open - last.low;
  const totalWick = Math.max(upperWick, 0) + Math.max(lowerWick, 0);
  const wickPct = (totalWick / lastBody) * 100;
  if (wickPct > CFG.migBreakoutMaxWickPct) return null; // ekor kepanjangan, bukan body kuat bersih

  const resWindow = history.slice(-CFG.migResistanceLookback);
  if (resWindow.length < 2) return null;
  const resistanceLevel = Math.max(...resWindow.map(c => c.high));

  // Wajib ada rejection sebelumnya: minimal 1 candle di window yang high-nya
  // dekat resistanceLevel (>=98%) tapi closing-nya balik di bawah level itu.
  const hadRejection = resWindow.some(c =>
    c.high >= resistanceLevel * 0.98 && c.close < resistanceLevel
  );
  if (!hadRejection) return null;

  if (!(last.close > resistanceLevel)) return null;

  return {
    type: 'BREAKOUT',
    resistanceLevel,
    bodyRatio,
    wickPct,
    closePrice: last.close,
  };
}

// Deteksi FULLBACK: sesudah tren naik (minimal migFullbackMinUptrendCandles
// candle dengan close lebih tinggi dari close sebelumnya, dominan naik),
// muncul candle body KECIL (<= migFullbackBodyMax x rata-rata body sebelumnya)
// — tanda momentum reda / market ancang-ancang balik arah, titik entry searah tren.
function detectMigFullback(candles) {
  if (!candles || candles.length < CFG.migFullbackMinUptrendCandles + 2) return null;
  const last = candles[candles.length - 1];
  const history = candles.slice(0, -1);

  const bodies = history.map(c => Math.abs(c.close - c.open)).filter(b => b > 0);
  const avgBody = bodies.length > 0 ? bodies.reduce((a, b) => a + b, 0) / bodies.length : 0;
  if (!(avgBody > 0)) return null;

  const lastBody = Math.abs(last.close - last.open);
  if (lastBody > avgBody * CFG.migFullbackBodyMax) return null; // body gak cukup kecil

  const trendWindow = history.slice(-CFG.migFullbackMinUptrendCandles);
  if (trendWindow.length < CFG.migFullbackMinUptrendCandles) return null;
  let higherCount = 0;
  for (let i = 1; i < trendWindow.length; i++) {
    if (trendWindow[i].close > trendWindow[i - 1].close) higherCount++;
  }
  const upRatio = higherCount / (trendWindow.length - 1);
  if (upRatio < 0.6) return null; // bukan uptrend yang cukup konsisten

  const trendStart = trendWindow[0].close;
  const trendEnd    = trendWindow[trendWindow.length - 1].close;
  if (!(trendEnd > trendStart)) return null;

  return {
    type: 'FULLBACK',
    lastBody,
    avgBody,
    trendGainPct: ((trendEnd - trendStart) / trendStart) * 100,
    closePrice: last.close,
  };
}

// Entry point: ambil candle terbaru & jalankan kedua detector. Breakout
// diprioritaskan kalau dua-duanya somehow kepenuhi bareng.
async function analyzeMigCandlePattern(address) {
  const candles = await fetchMigCandles(address);
  if (!candles) return { pattern: null, reason: 'candle_unavailable' };

  const breakout = detectMigBreakout(candles);
  if (breakout) return { pattern: breakout, reason: null };

  const fullback = detectMigFullback(candles);
  if (fullback) return { pattern: fullback, reason: null };

  return { pattern: null, reason: 'no_pattern_yet' };
}

// Gate notif MIGRATION berbasis pola candle (breakout/fullback). Kalau
// CFG.migCandleEntryEnabled OFF -> return {gated:false} (notif langsung,
// perilaku lama). Kalau ON: hitung pola, kalau ketemu -> gated:false
// (lolos, notif langsung terkirim). Kalau belum ketemu -> gated:true,
// caller simpan ke watchlist candle (CANDLE_ENTRY_WATCH), di-retry oleh
// runCandleEntryLoop().
async function gateNotifWithCandlePattern(t, grade) {
  if (!CFG.migCandleEntryEnabled) return { gated: false };
  if (grade === 'SKIP') return { gated: false };

  try {
    const result = await analyzeMigCandlePattern(t.address);
    if (result.pattern) {
      const p = result.pattern;
      if (p.type === 'BREAKOUT') {
        log('[MIG CANDLE] ' + t.symbol + ' — BREAKOUT terkonfirmasi: body ' + p.bodyRatio.toFixed(1)
          + 'x avg, wick ' + p.wickPct.toFixed(0) + '%, close $' + fmtPrice(p.closePrice)
          + ' > resistance $' + fmtPrice(p.resistanceLevel) + ' (level yg sblmnya gagal ditembus)');
      } else {
        log('[MIG CANDLE] ' + t.symbol + ' — FULLBACK terkonfirmasi: uptrend +' + p.trendGainPct.toFixed(1)
          + '%, candle kecil (body ' + fmt(p.lastBody) + ' vs avg ' + fmt(p.avgBody) + '), entry @ $' + fmtPrice(p.closePrice));
      }
      return { gated: false, pattern: p };
    }
    log('[MIG CANDLE] ' + t.symbol + ' — belum ada pola breakout/fullback (' + result.reason + '), masuk watchlist candle-entry');
    return { gated: true, reason: result.reason };
  } catch (e) {
    log('[MIG CANDLE] Error analisa candle ' + t.symbol + ': ' + e.message + ' — fallback lanjut notif spt biasa');
    return { gated: false };
  }
}

// Gate notif MIGRATION berbasis Fib Entry (retrace ke level fair/support).
// Kalau CFG.fibEntryEnabled OFF atau mode ini gak masuk CFG.fibEntryModes,
// return { gated: false } — caller lanjut notif seperti biasa. Kalau ON dan
// mode cocok: hitung fib zone + level target, kalau harga SEKARANG udah hit
// target -> gated:false juga (lolos, notif langsung). Kalau belum hit ->
// simpan ke PENDING_ENTRY, gated:true (di-retry oleh checkPendingEntries()).
async function gateNotifWithFib(t, grade, mode) {
  if (!CFG.fibEntryEnabled) return { gated: false };
  if (!CFG.fibEntryModes.includes(mode)) return { gated: false };
  if (grade === 'SKIP') return { gated: false };

  const price = Number(t.price);
  if (!(price > 0)) return { gated: false }; // gak ada harga valid, gak bisa dievaluasi -> lanjut spt biasa

  // Rawness gate — KHUSUS MODE MIGRATION.
  if (mode === 'MIGRATION') {
    const ageMin = tokenAgeHours(t.creation_timestamp) * 60;
    const lp     = Number(t.liquidity) || 0;
    const mc     = Number(t.market_cap) || 0;

    if (CFG.fibMinAgeMinutes > 0 && ageMin < CFG.fibMinAgeMinutes) {
      log('[FIB ENTRY] ' + t.symbol + ' (' + mode + ') — umur ' + ageMin.toFixed(1) + 'm < ' + CFG.fibMinAgeMinutes + 'm, chart blm cukup matang, skip fib gate -> notif biasa');
      return { gated: false };
    }
    if (CFG.fibMinLiquidityUsd > 0 && lp < CFG.fibMinLiquidityUsd) {
      log('[FIB ENTRY] ' + t.symbol + ' (' + mode + ') — LP $' + fmt(lp) + ' < $' + fmt(CFG.fibMinLiquidityUsd) + ', skip fib gate -> notif biasa');
      return { gated: false };
    }
    if (CFG.fibMinMarketCapUsd > 0 && mc < CFG.fibMinMarketCapUsd) {
      log('[FIB ENTRY] ' + t.symbol + ' (' + mode + ') — MC $' + fmt(mc) + ' < $' + fmt(CFG.fibMinMarketCapUsd) + ', skip fib gate -> notif biasa');
      return { gated: false };
    }
  }

  try {
    const f = await getFibonacciZone(t.address, t.price, t.price_change_percent1h, t.market_cap, t.history_highest_market_cap, mode);
    const target = getFibEntryTarget(f);
    const zoneFields = buildEntryZoneFields(f, target, price, CFG.fibEntryTolerancePct);
    if (isFibEntryHit(price, target, CFG.fibEntryTolerancePct)) {
      log('[FIB ENTRY] ' + t.symbol + ' (' + mode + ') — harga $' + fmtPrice(price) + ' udah hit target $' + fmtPrice(target) + ' (' + CFG.fibEntryLevel + '), notif langsung');
      return { gated: false };
    }
    log('[FIB ENTRY] ' + t.symbol + ' (' + mode + ') — harga $' + fmtPrice(price) + ' blm hit target $' + fmtPrice(target) + ' (' + CFG.fibEntryLevel + ', src:' + f.source + '), masuk watchlist');
    return { gated: true, target, fibSource: f.source, zoneFields };
  } catch (e) {
    log('[FIB ENTRY] Error hitung fib utk ' + t.symbol + ': ' + e.message + ' — fallback lanjut notif spt biasa');
    return { gated: false };
  }
}

async function getRugCheck(ca, insiderThreshold) {
  try {
    const res = await getWithRetry('https://api.rugcheck.xyz/v1/tokens/' + ca + '/report', { timeout: 10000 });
    const d   = res.data;

    // rawRisks: simpan tiap item risk apa adanya (name, level, score
    // numerik). RugCheck ngasih skor per-risk sendiri-sendiri (mis. score
    // 15 utk "High holder correlation", score 8000 utk "Single holder
    // ownership") — beda dari d.score yang cuma total gabungan. Dipakai
    // buat gate MIGRATION berbasis ANGKA, bukan cocok-cocokan nama.
    const rawRisks = (d.risks || []).map(r => ({
      name:  r.name || '(unnamed risk)',
      level: r.level || '',
      score: Number(r.score) || 0,
    }));

    const riskNames = rawRisks.map(r => {
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

    // Risk individual dengan skor tertinggi — dasar gate MIGRATION "skip
    // kalau ADA SATU risk aja yang skornya > threshold". Kalau semua risk
    // skornya 0, highestRiskScore = 0 dan gate ini gak nge-skip apapun.
    let highestRiskScore = 0;
    let highestRiskName  = '';
    rawRisks.forEach(r => {
      if (r.score > highestRiskScore) {
        highestRiskScore = r.score;
        highestRiskName  = r.name;
      }
    });

    return {
      score:            d.score || 0,
      scoreNormalised:  d.score_normalised ?? -1,
      risks:            riskNames.join(', '),
      highestRiskScore: highestRiskScore,
      highestRiskName:  highestRiskName,
      creator:          d.creator || d.owner || '?',
      topDangers:       riskNames.filter(n => /\[DANGER\]/i.test(n)).map(n => n.replace(/^\[DANGER\]\s*/i, '')),
      topWarns:         riskNames.filter(n => /\[WARN\]/i.test(n)).map(n => n.replace(/^\[WARN\]\s*/i, '')),
      tokenType:        d.tokenType || '',
      rugged:           d.rugged || false,
      deployPlatform:   d.deployPlatform || '',
      insiderPct:       maxInsiderPct,
    };
  } catch {
    return { score: 999, scoreNormalised: -1, risks: 'Fetch failed', highestRiskScore: 0, highestRiskName: '',
             creator: '?', topDangers: [], topWarns: [], tokenType: '', rugged: false, deployPlatform: '',
             insiderPct: 0 };
  }
}

async function sendTelegram(msg, replyTo, threadId) {
  if (!CFG.tgEnabled) {
    log('[TG SKIPPED - disabled] ' + msg.replace(/<[^>]+>/g, '').slice(0, 80));
    return null;
  }
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

// Label tampilan grade buat notif Telegram. GOLD (skor tertinggi) tampil
// sebagai PLATINUM, POTENSIAL (skor menengah) tampil sebagai GOLD.
function gradeMeta(grade) {
  if (grade === 'GOLD') return { emoji: '🥇', label: 'PLATINUM' };
  if (grade === 'POTENSIAL') return { emoji: '🥈', label: 'GOLD' };
  return { emoji: '🥉', label: 'SILVER' };
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
          support: Math.max(swingHigh - range * CFG.fibSupportRatioBullish, floor).toFixed(10),
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
      support: Math.max(h - range * CFG.fibSupportRatioBullish, floor).toFixed(10),
      fair:    Math.max(h - range * 0.618, floor).toFixed(10),
      resist:  (h + range * 0.382).toFixed(10),
      sl:      Math.max(h - range * 1.272, floor * 0.5).toFixed(10),
    };
  } else {
    return {
      source: 'estimasi',
      swingHigh: h, swingLow: l,
      support: Math.max(l - range * CFG.fibSupportRatioBearish, floor).toFixed(10),
      fair:    Math.max(l - range * 0.500, floor).toFixed(10),
      resist:  (l + range * 0.382).toFixed(10),
      sl:      Math.max(l - range * 0.618, floor * 0.5).toFixed(10),
    };
  }
}

// Nama lama dipertahankan sbg alias, biar konsisten penamaan dgn versi
// lokal (getFibonacciZone) — sama-sama cuma pakai GMGN kline (Tier 4) +
// estimasi (Tier 5) di versi GitHub ini, tanpa Birdeye/GeckoTerminal/DexPaprika.
async function getFibonacciZone(address, price, changePct, mc, athMc, mode) {
  return calculateFibonacci(address, price, changePct, mc, athMc, mode);
}

// ─────────────────────────────────────────────
//  FIB ENTRY — level target beli (simulasi), dihitung dari zona fib (f) yang
//  sudah didapat dari getFibonacciZone(). CFG.fibEntryLevel bisa:
//    'fair'    -> f.fair
//    'support' -> f.support
//    angka (mis. 0.65) -> retracement custom dari swingHigh: swingHigh - range*angka
function getFibEntryTarget(f) {
  var level = String(CFG.fibEntryLevel).trim().toLowerCase();
  if (level === 'fair')    return Number(f.fair);
  if (level === 'support') return Number(f.support);
  var ratio = Number(CFG.fibEntryLevel);
  if (!isNaN(ratio) && f.swingHigh > f.swingLow) {
    var range = f.swingHigh - f.swingLow;
    return f.swingHigh - range * ratio;
  }
  log('[FIB ENTRY] FIB_ENTRY_LEVEL="' + CFG.fibEntryLevel + '" gak valid, fallback ke fair');
  return Number(f.fair);
}

// Cek apakah harga sekarang sudah "hit" level target (dalam toleransi %).
// Hit kalau harga sekarang ada DI DALAM range [target-toleransi, target+toleransi].
function isFibEntryHit(currentPrice, target, tolerancePct) {
  if (!(currentPrice > 0) || !(target > 0)) return false;
  var upperBound = target * (1 + tolerancePct / 100);
  var lowerBound = target * (1 - tolerancePct / 100);
  return currentPrice <= upperBound && currentPrice >= lowerBound;
}

// Bangun field zona entry (buat dashboard/notif) — f = hasil
// getFibonacciZone(), target = hasil getFibEntryTarget(f), currentPrice =
// harga token sekarang.
function buildEntryZoneFields(f, target, currentPrice, tolerancePct) {
  var upperBound = target * (1 + tolerancePct / 100);
  var lowerBound = target * (1 - tolerancePct / 100);
  var entryZoneLow  = target;
  var entryZoneHigh = target;

  var distancePct = ((currentPrice - target) / target) * 100;

  var state;
  if (currentPrice > upperBound) state = 'ABOVE_ZONE';       // masih di atas target, nunggu turun
  else if (currentPrice >= lowerBound) state = 'IN_ZONE';     // pas di dalam toleransi zona
  else state = 'BELOW_ZONE';                                  // udah tembus di bawah target

  var range = f.swingHigh - f.swingLow;
  var fibPositionPct  = range > 0 ? Math.max(0, Math.min(100, ((currentPrice - f.swingLow) / range) * 100)) : 50;
  var fibZoneStartPct = range > 0 ? Math.max(0, Math.min(100, ((target - f.swingLow) / range) * 100)) : 50;
  var fibZoneEndPct   = fibZoneStartPct;

  return {
    entryZoneLow, entryZoneHigh, entryZoneLabel: true,
    entryDistancePct: distancePct,
    entryZoneState: state,
    fibPositionPct, fibZoneStartPct, fibZoneEndPct,
    pendingCurrentPrice: currentPrice,
  };
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
  var compactText = normalizeNarrativeText(text).replace(/\s+/g, '');
  for (var i = 0; i < keywords.length; i++) {
    var kw = normalizeNarrativeText(keywords[i]);
    if (!kw) continue;
    var re = new RegExp('\\b' + escapeNarrativeRegex(kw) + '\\b');
    if (re.test(text)) return keywords[i];
    var compactKw = kw.replace(/\s+/g, '');
    if (compactKw.length >= 4 && compactText.includes(compactKw)) return keywords[i];
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
    { label: 'KOL/Celebrity', keywords: ['ansem', 'mitch', 'murad', 'musk', 'elon', 'trump', 'kanye', 'cz', 'vitalik', 'saylor', 'taylor', 'powell'] },
    { label: 'Animal', keywords: ['dog', 'cat', 'catwif', 'catwifhat', 'dogwif', 'wifhat', 'frog', 'pepe', 'wif', 'bonk', 'bull', 'bear', 'shark', 'whale', 'monkey', 'ape', 'penguin', 'duck', 'rat', 'goat', 'cow', 'pig', 'horse', 'lion', 'tiger', 'rabbit', 'bunny', 'hamster', 'chicken', 'shrimp', 'crab', 'fish', 'bird', 'panda'] },
    { label: 'AI/Agent', keywords: ['ai', 'agent', 'gpt', 'grok', 'claude', 'bot', 'robot', 'neural', 'agi', 'llm'] },
    { label: 'Gaming', keywords: ['game', 'gaming', 'pixel', 'minecraft', 'roblox', 'pokemon', 'arcade', 'arena', 'rpg', 'xbox', 'playstation', 'gta', 'rust', 'valorant'] },
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

function narrativeHeatScore(t) {
  var liquidity = Number(t.liquidity) || 0;
  var volume = Number(t.volume) || Number(t.volume_1h) || Number(t.volume_24h) || 0;
  var smart = Number(t.smart_degen_count || t.smart_degen_count_24h || t.smart_degen_count_6h) || 0;
  var tx = (Number(t.buys) || 0) + (Number(t.sells) || 0);
  return 1
    + Math.min(4, Math.log10(liquidity + 1) / 1.5)
    + Math.min(4, Math.log10(volume + 1) / 1.5)
    + Math.min(3, smart * 0.5)
    + Math.min(2, tx / 250);
}

function buildNewMigrationNarrativePulse(tokens) {
  var map = new Map();
  var scanned = 0;
  var matched = 0;

  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (!t || !t.address) continue;
    if (!isMigratedDex(t)) continue;
    if (tokenAgeHours(t.creation_timestamp) >= CFG.maxAgeHours) continue;
    scanned++;

    var gate = checkNewMigrationNarrative(t);
    if (gate.skip || !gate.category) continue;
    matched++;

    var current = map.get(gate.category) || {
      label: gate.category,
      count: 0,
      heat: 0,
      examples: []
    };
    current.count++;
    current.heat += narrativeHeatScore(t);
    if (current.examples.length < 3) current.examples.push(t.symbol || t.name || '?');
    map.set(gate.category, current);
  }

  var ranked = Array.from(map.values()).sort(function(a, b) {
    return b.count - a.count || b.heat - a.heat;
  });
  var hot = ranked.filter(function(item) {
    return item.count >= CFG.narrativeMinCluster || item.heat >= CFG.narrativeMinHeat;
  }).slice(0, CFG.narrativeTopK);
  var hotLabels = new Set(hot.map(function(item) { return item.label; }));
  var summary = hot.length
    ? hot.map(function(item) {
        return item.label + ' x' + item.count + ' heat ' + item.heat.toFixed(1) + ' [' + item.examples.join(', ') + ']';
      }).join(' | ')
    : 'belum ada cluster dominan';

  return {
    scanned: scanned,
    matched: matched,
    ranked: ranked,
    hot: hot,
    hotLabels: hotLabels,
    summary: summary
  };
}

function applyDynamicNarrativeGate(gate, pulse) {
  if (gate.skip || !CFG.narrativeDynamic) return gate;
  if (!pulse || pulse.hotLabels.size === 0) {
    return {
      skip: false,
      reason: gate.reason + ' | belum ada cluster hot, pakai narasi kuat',
      category: gate.category,
      keyword: gate.keyword
    };
  }
  if (!pulse.hotLabels.has(gate.category)) {
    return {
      skip: true,
      reason: 'Narasi belum hot: ' + gate.category + ' (' + gate.keyword + '). Hot: ' + pulse.summary
    };
  }
  return {
    skip: false,
    reason: gate.reason + ' | HOT Dex cluster: ' + pulse.summary,
    category: gate.category,
    keyword: gate.keyword
  };
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
  var migrationNarrativePulse = buildNewMigrationNarrativePulse(migrationTokens);

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
  log('New Migration narrative pulse: scanned ' + migrationNarrativePulse.scanned + ' | matched ' + migrationNarrativePulse.matched + ' | hot ' + migrationNarrativePulse.summary);
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

    // normalizeTrench() menghitung price = usd_market_cap / total_supply, tapi
    // API "market trenches" sering gak ngisi usd_market_cap (jadi price/MC = 0).
    // tokenInfo (API "token info", per-address, lebih lengkap) biasanya punya
    // harga & MC asli — pakai itu buat isi ulang kalau hasil trenches kosong.
    if (!t.price || Number(t.price) <= 0) {
      var tiPrice = tokenInfo?.price?.price ?? tokenInfo?.price?.usd ?? tokenInfo?.price?.value
                    ?? tokenInfo?.token?.price ?? tokenInfo?.price;
      var tiPriceNum = Number(tiPrice);
      if (tiPriceNum > 0) {
        log('[MIG] ' + t.symbol + ' price 0 dari trenches, pakai tokenInfo: $' + tiPriceNum);
        t.price = tiPriceNum;
      } else {
        log('[MIG DEBUG] ' + t.symbol + ' price tetap 0 — tokenInfo.price: ' + JSON.stringify(tokenInfo?.price));
      }
    }
    if (!t.market_cap || Number(t.market_cap) <= 0) {
      var tiMc = tokenInfo?.price?.market_cap ?? tokenInfo?.token?.market_cap ?? tokenInfo?.market_cap;
      if (Number(tiMc) > 0) t.market_cap = Number(tiMc);
    }

    // FIX Vol/LP ratio meledak palsu: t.volume dari normalizeTrench() fallback
    // ke volume_24h kalau volume_1h trenches kosong (sering terjadi, sama kayak
    // t.price). volume_24h jauh lebih besar drpd volume_1h, jadi kalau ke-pakai
    // buat Vol/LP ratio (gate risk di bawah), rasio bisa meledak 80-400x dan
    // token normal ke-skip dengan alasan "wash trading" yang keliru. Timpa
    // t.volume dengan volume_1h dari tokenInfo (lebih akurat/real-time) SEBELUM
    // gate risk dipanggil, bukan sesudahnya.
    var vol1hReal = Number(tokenInfo?.price?.volume_1h);
    if (vol1hReal > 0) {
      t.volume = vol1hReal;
    }

    // Filter narasi dimatikan — semua token lanjut ke gate berikutnya tanpa cek narasi
    var narrativeGate = { skip: false, reason: 'Narrative filter dimatikan' };
    log('[MIG] Narasi SKIP-CHECK ' + t.symbol + ' (' + narrativeGate.reason + ')');

    var migCfg = {
      minLp:        CFG.minLp,
      maxAgeHours:  CFG.maxAgeHours,
      minVol1h:     CFG.minVol1h,
      minSwaps5m:   CFG.minSwaps5m,
      minVol5m:     CFG.minVol5m,
    };

    var lpGate = checkBaseLiquidity(t.liquidity, CFG.minLp);
    if (lpGate.skip) {
      log('SKIP [MIG] ' + t.symbol + ' (' + lpGate.reason + ')');
      continue;
    }

    // Umur < maxAgeHours sudah dijamin server (--max-created di GMGN CLI),
    // tapi tetap dicek manual di sini sbg pengaman. Ditambah cek MIN umur
    // (MIN_AGE_HOURS_MIG) — token yang KEBARU (misal baru migrasi < X menit)
    // di-skip dulu kalau mau nunggu token agak "settle".
    var ageHMig = tokenAgeHours(t.creation_timestamp);
    var ageGate = { skip: false, reason: '' };
    if (ageHMig < CFG.minAgeHoursMig) {
      ageGate = { skip: true, reason: 'Terlalu baru (' + ageHMig.toFixed(2) + 'j < ' + CFG.minAgeHoursMig + 'j)' };
    } else if (ageHMig >= CFG.maxAgeHours) {
      ageGate = { skip: true, reason: 'Terlalu tua (' + ageHMig.toFixed(2) + 'j >= ' + CFG.maxAgeHours + 'j)' };
    }
    if (ageGate.skip) {
      log('SKIP [MIG] ' + t.symbol + ' (' + ageGate.reason + ')');
      continue;
    }

    var momentumGate = shouldSkipNewMigration(t, tokenInfo, migCfg);
    if (momentumGate.skip) {
      log('[MIG] WARN ' + t.symbol + ' (' + momentumGate.reason + ') — narasi cocok, lanjut cek risk');
    }

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
    var gmgnRiskGate = shouldSkipMigrationHardRisk(t, migCfgStrict);
    if (gmgnRiskGate.skip) {
      log('SKIP [MIG] ' + t.symbol + ' (GMGN risk: ' + gmgnRiskGate.reason + ')');
      continue;
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
        log('SKIP [MIG] ' + t.symbol + ' (No Social) [Score:' + socialScore + '/4]');
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

    // Rug score — 100% dari GMGN (rug_ratio), bukan RugCheck. Sudah nempel
    // di objek t sejak fetchGmgnTrenches()/normalizeTrench(), jadi gak perlu
    // request tambahan. Skala GMGN 0-1, dikonversi ke 0-100 biar konsisten
    // sama threshold CFG.maxRugScore/CFG.maxInsiderPct yang sudah ada.
    if (t.rug_ratio == null) {
      log('SKIP [MIG] ' + t.symbol + ' (Rug ratio GMGN tidak tersedia (data hilang))');
      continue; // TIDAK di-lock ke SEEN — data belum tersedia, coba lagi siklus berikutnya
    }
    var gmgnRugScore   = Number(t.rug_ratio) * 100;
    var gmgnInsiderPct = (Number(t.suspected_insider_hold_rate) || 0) * 100;
    if (gmgnRugScore > CFG.maxRugScore) {
      log('SKIP [MIG] ' + t.symbol + ' (Rug ' + gmgnRugScore.toFixed(0) + ' > ' + CFG.maxRugScore + ')');
      SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'migration', lockedReason: 'rug_score' });
      continue;
    }
    if (gmgnInsiderPct > CFG.maxInsiderPct) {
      log('SKIP [MIG] ' + t.symbol + ' (Insider ' + gmgnInsiderPct.toFixed(0) + '% > ' + CFG.maxInsiderPct + '%)');
      continue;
    }

    // Cek RugCheck asli JUGA di mode Migration — sebelumnya cuma mode
    // SWING yang manggil ini, MIGRATION cuma andalin rug_ratio GMGN yang
    // metodologinya beda dan bisa melewatkan risk yang RugCheck tangkap.
    // Dipanggil setelah gate GMGN lolos, biar gak nambah API call buat
    // token yang udah keskip duluan.
    const rcMig = await getRugCheck(t.address, CFG.maxInsiderPct);
    if (CFG.skipIfRugged && rcMig.rugged) {
      log('SKIP [MIG] ' + t.symbol + ' (RugCheck: pernah dinyatakan rugged)');
      continue;
    }
    // Gate per-risk individual — skip kalau ADA SATU risk RugCheck aja
    // yang skornya > CFG.maxSingleRiskScore, terlepas dari skor GMGN.
    // Ini nangkep kasus token lolos gate GMGN padahal RugCheck nemu risk
    // spesifik (mis. High holder correlation) yang gak kecek kalau cuma
    // andalin rug_ratio GMGN.
    if (CFG.rugCheckRiskGateEnabled && rcMig.highestRiskScore > CFG.maxSingleRiskScore) {
      log('SKIP [MIG] ' + t.symbol + ' (RugCheck risk "' + rcMig.highestRiskName
        + '" score ' + rcMig.highestRiskScore + ' > ' + CFG.maxSingleRiskScore + ')');
      continue;
    }

    // Objek "rug" — skor utama tetap GMGN (gmgnRugScore, dipakai buat
    // grading/threshold lama, gak diubah biar behavior grading tetap sama).
    // Field RugCheck-only sekarang diisi dari rcMig (sebelumnya dikosongkan
    // karena RugCheck emang gak pernah dipanggil di mode ini).
    const rug = {
      score: gmgnRugScore,
      insiderPct: gmgnInsiderPct,
      scoreNormalised: rcMig.scoreNormalised,
      tokenType: rcMig.tokenType,
      deployPlatform: rcMig.deployPlatform,
      topDangers: rcMig.topDangers,
      topWarns: rcMig.topWarns,
      creator: t.creator_address || t.dev?.creator_address || rcMig.creator || '?',
    };

    // t.volume sudah di-normalisasi ke volume_1h di atas (sebelum gate risk),
    // jadi di sini tinggal pakai langsung — nggak perlu overwrite lagi.
    var vol1h = t.volume || 0;
    const grade = gradeToken(t.liquidity, t.volume, gmgnRugScore);
    SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'migration' });
    if (grade === 'SKIP') {
      log('SKIP [MIG] ' + t.symbol + ' (Grade SKIP — LP/Vol kecil)');
      continue;
    }

    log('[MIG] ' + grade + ' ' + t.symbol + ' (LP:$' + fmt(t.liquidity) + ' Vol1h:$' + fmt(vol1h) + ' Rug(GMGN):' + rug.score.toFixed(0) + ' Insider:' + rug.insiderPct.toFixed(0) + '% Paid:' + (paidDex ? '✅' : '⚠️') + ' Social:' + (dexInfo ? socialScore + '/4' : '?/4') + ')');

    // Fallback harga: `t.price` dari normalizeTrench() dihitung manual
    // (usd_market_cap / total_supply) dan sering jadi 0 kalau total_supply
    // gak ke-isi dari trenches API — bukan berarti gak ada harga sama sekali.
    // tokenInfo (dari fetchTokenInfo, sudah kepakai di atas buat volume_1h)
    // biasanya punya harga aktual di tokenInfo.price.price / .usd.
    var entryPriceRaw = (t.price && Number(t.price) > 0)
      ? t.price
      : (tokenInfo?.price?.price ?? tokenInfo?.price?.usd ?? tokenInfo?.price?.value);
    var entryPriceNum = Number(entryPriceRaw);
    if (entryPriceNum > 0) t.price = entryPriceNum; // biar gate (candle/fib) baca harga yg sama dgn yg dipakai track

    // Entry gate KHUSUS MIGRATION — notif (simulasi buy) TIDAK langsung
    // dikirim begitu lolos gate dasar di atas, tapi nunggu titik entry dulu:
    //  - CFG.migCandleEntryEnabled ON  -> pakai gate pola candle (breakout/
    //    fullback). Ini MENGGANTIKAN fib entry khusus di MIGRATION saja.
    //  - CFG.migCandleEntryEnabled OFF -> tetap fib entry (CFG.fibEntryEnabled).
    // Kalau dua-duanya OFF -> notif langsung seperti biasa (perilaku lama).
    let migGate;
    if (CFG.migCandleEntryEnabled) {
      migGate = await gateNotifWithCandlePattern(t, grade);
    } else {
      migGate = await gateNotifWithFib(t, grade, 'MIGRATION');
    }

    if (migGate.gated) {
      if (CFG.migCandleEntryEnabled) {
        // Watchlist candle-entry: simpan snapshot minimal yang dibutuhkan buat
        // re-trigger notif nanti begitu breakout/fullback terdeteksi.
        CANDLE_ENTRY_WATCH.set(t.address, {
          symbol: t.symbol, name: t.name, grade, mode: 'MIGRATION',
          address: t.address, addedAt: Date.now(), lastCheckedAt: Date.now(),
          reason: migGate.reason || 'no_pattern_yet',
          rugSnapshot: rug,
        });
        saveCandleEntryWatch();
        const posMigC = TRACKED.get(t.address) || {};
        TRACKED.set(t.address, Object.assign({}, posMigC, {
          symbol: t.symbol, name: t.name, grade, mode: 'MIGRATION',
          autoBuyStatus: 'WAIT_CANDLE',
          autoBuyReason: 'Nunggu pola candle breakout/fullback (' + (migGate.reason || 'no_pattern_yet') + ')',
        }));
        savePositions();
        log('[MIG] ' + t.symbol + ' masuk watchlist candle-entry, notif ditunda sampai pola kebentuk');
      } else {
        PENDING_ENTRY.set(t.address, {
          symbol: t.symbol, name: t.name, grade, mode: 'MIGRATION',
          address: t.address, addedAt: Date.now(),
          target: migGate.target, fibSource: migGate.fibSource,
          rugSnapshot: rug,
          ...migGate.zoneFields,
        });
        savePendingEntries();
        const posMig = TRACKED.get(t.address) || {};
        TRACKED.set(t.address, Object.assign({}, posMig, {
          symbol: t.symbol, name: t.name, grade, mode: 'MIGRATION',
          autoBuyStatus: 'WAIT_ENTRY',
          autoBuyReason: 'Nunggu retrace ke level ' + CFG.fibEntryLevel,
          ...migGate.zoneFields,
        }));
        savePositions();
        log('[MIG] ' + t.symbol + ' masuk watchlist fib-entry, notif ditunda sampai harga hit target');
      }
      continue; // JANGAN kirim notif sekarang — nunggu trigger dari watchlist loop
    }

    // Gate lolos (langsung, atau pattern/hit sudah kebentuk saat gate dicek) — kirim notif sekarang.
    const fullMsg = await buildMsg(t, rug, grade, null, 'MIGRATION', null);
    const msgId   = await sendTelegram(fullMsg, null, CFG.tgThreadMig);
    await sendRadarBridge(t, 'MIGRATION', {
      grade,
      rugScore: rug.score,
      insiderPct: rug.insiderPct,
      socialScore: dexInfo ? socialScore : undefined
    });
    totalNotified++;

    if (entryPriceNum > 0) {
      TRACKED.set(t.address, {
        symbol: t.symbol, name: t.name, grade, mode: 'MIGRATION',
        entryPrice: entryPriceNum, entryAt: Date.now(), nextTargetIdx: 0, msgId,
        threadId: CFG.tgThreadMig,
      });
      log('Tracked [MIG] ' + t.symbol + ' @ $' + entryPriceNum);
    } else {
      log('WARN [MIG] ' + t.symbol + ' TIDAK di-track — price gak valid. t.price=' + JSON.stringify(t.price) + ' tokenInfo.price=' + JSON.stringify(tokenInfo?.price));
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
    if (t.rug_ratio == null) {
      log('SKIP [SIGNAL] ' + t.symbol + ' (Rug ratio GMGN tidak tersedia (data hilang))');
      continue; // TIDAK di-lock ke SEEN — data belum tersedia, coba lagi siklus berikutnya
    }
    var rugScore = Math.round(Number(t.rug_ratio) * 100);
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
//  FIB ENTRY WATCHLIST — recheck PENDING_ENTRY tiap CFG.fibEntryPollInterval
//  detik (lihat runFibEntryLoop), independen dari scan token baru. Begitu
//  harga hit target fib -> kirim notif Telegram (simulasi buy) + track posisi.
// ─────────────────────────────────────────────
async function checkPendingEntries() {
  if (PENDING_ENTRY.size === 0) return;

  for (const [ca, pend] of PENDING_ENTRY) {
    var currentPrice = null;
    try {
      var ds = await axios.get('https://api.dexscreener.com/latest/dex/tokens/' + ca, { timeout: 8000 });
      var pairs = ds.data.pairs || [];
      var best  = pairs.find(p => p.priceUsd) || pairs[0] || null;
      if (best && best.priceUsd) currentPrice = Number(best.priceUsd);
    } catch (e) {
      log('[FIB ENTRY] Gagal fetch harga ' + pend.symbol + ': ' + e.message);
      continue;
    }
    if (!currentPrice || currentPrice <= 0) continue;

    var f;
    try {
      f = await getFibonacciZone(ca, currentPrice, null, null, null, pend.mode);
    } catch (e) {
      log('[FIB ENTRY] Gagal hitung fib ulang ' + pend.symbol + ': ' + e.message);
      continue;
    }
    var target = getFibEntryTarget(f);
    var zoneFields = buildEntryZoneFields(f, target, currentPrice, CFG.fibEntryTolerancePct);

    if (!isFibEntryHit(currentPrice, target, CFG.fibEntryTolerancePct)) {
      // BELOW_ZONE = harga udah tembus di bawah target (dump/breakdown).
      // Langsung DROP saat itu juga, gak nunggu breakdown makin dalam.
      if (CFG.fibDropBelowZoneEnabled && zoneFields.entryZoneState === 'BELOW_ZONE') {
        var belowPct = ((Number(target) - currentPrice) / Number(target) * 100).toFixed(1);
        log('[FIB ENTRY] ' + pend.symbol + ' (' + pend.mode + ') — DROP dari watchlist, harga $'
          + fmtPrice(currentPrice) + ' udah ' + belowPct + '% di bawah target $' + fmtPrice(target)
          + ' (breakdown, langsung skip — nunggu zigzag/swing baru)');
        PENDING_ENTRY.delete(ca);
        savePendingEntries();
        const posDrop = TRACKED.get(ca) || {};
        TRACKED.set(ca, Object.assign({}, posDrop, {
          autoBuyStatus: 'ENTRY_INVALIDATED',
          autoBuyReason: 'Support breakdown ' + belowPct + '% di bawah target — entry dibatalkan otomatis',
          ...zoneFields,
        }));
        savePositions();
        continue;
      }
      // Belum hit — update target di watchlist (level fib dinamis, ngikutin swing baru)
      pend.target = target;
      pend.fibSource = f.source;
      pend.lastCheckedAt = Date.now();
      Object.assign(pend, zoneFields);
      PENDING_ENTRY.set(ca, pend);
      const posPend = TRACKED.get(ca) || {};
      TRACKED.set(ca, Object.assign({}, posPend, {
        autoBuyStatus: 'WAIT_ENTRY',
        autoBuyReason: 'Nunggu retrace ke level ' + CFG.fibEntryLevel,
        ...zoneFields,
      }));
      continue;
    }

    log('[FIB ENTRY] ' + pend.symbol + ' (' + pend.mode + ') — harga $' + fmtPrice(currentPrice) + ' HIT target $' + fmtPrice(target) + ' (src:' + f.source + '), kirim notif');

    var gmFib = gradeMeta(pend.grade);
    var buyMsgIdFib = await sendTelegram(
      '🎯 <b>ENTRY SIGNAL</b> | ' + gmFib.emoji + ' ' + gmFib.label + ' | 🆕 New Migration (Fib Entry)\n'
      + pend.name + ' (<code>' + pend.symbol + '</code>)\n'
      + '━━━━━━━━━━━━━━━━━━━━\n'
      + '🏷️ Entry   : $' + fmtPrice(currentPrice) + ' (target $' + fmtPrice(target) + ', ' + CFG.fibEntryLevel + ')\n'
      + '<a href="https://dexscreener.com/solana/' + ca + '">Chart</a>'
      + ' | <a href="https://gmgn.ai/sol/token/' + ca + '">GMGN</a>',
      null,
      CFG.tgThreadAuto || CFG.tgThreadMig
    );
    totalNotified++;

    TRACKED.set(ca, {
      symbol: pend.symbol, name: pend.name, grade: pend.grade, mode: pend.mode,
      entryPrice: currentPrice, entryAt: Date.now(), nextTargetIdx: 0, msgId: buyMsgIdFib,
      threadId: CFG.tgThreadAuto || CFG.tgThreadMig,
      autoBuyStatus: 'ENTERED',
      fibEntry: true, fibEntrySource: f.source, fibEntryTarget: target,
    });
    savePositions();
    logTrackingEvent({
      type: 'ENTRY_SIGNAL',
      mode: pend.mode,
      ca, symbol: pend.symbol, name: pend.name,
      entryPriceUsd: currentPrice,
      fibEntry: true, fibSource: f.source, fibTarget: target,
    });
    PENDING_ENTRY.delete(ca);
    savePendingEntries();
  }
}

// ─────────────────────────────────────────────
//  CANDLE ENTRY WATCHLIST — recheck CANDLE_ENTRY_WATCH tiap
//  CFG.migCandleEntryPollInterval detik (lihat runCandleEntryLoop), nunggu
//  pola breakout/fullback kebentuk. Begitu kebentuk -> kirim notif Telegram
//  (simulasi buy) + track posisi. KHUSUS MIGRATION.
// ─────────────────────────────────────────────
async function checkCandleEntryWatch() {
  if (CANDLE_ENTRY_WATCH.size === 0) return;

  for (const [ca, watch] of CANDLE_ENTRY_WATCH) {
    // Timeout opsional — kalau kelamaan gak ada pola sama sekali, drop.
    if (CFG.migCandleWatchTimeoutMin > 0) {
      const ageMin = (Date.now() - (watch.addedAt || Date.now())) / 60000;
      if (ageMin > CFG.migCandleWatchTimeoutMin) {
        log('[MIG CANDLE] ' + watch.symbol + ' — timeout ' + CFG.migCandleWatchTimeoutMin + 'm tanpa pola breakout/fullback, drop dari watchlist');
        CANDLE_ENTRY_WATCH.delete(ca);
        saveCandleEntryWatch();
        const posTimeout = TRACKED.get(ca) || {};
        TRACKED.set(ca, Object.assign({}, posTimeout, {
          autoBuyStatus: 'ENTRY_TIMEOUT',
          autoBuyReason: 'Timeout ' + CFG.migCandleWatchTimeoutMin + 'm — gak ada pola breakout/fullback',
        }));
        savePositions();
        continue;
      }
    }

    let result;
    try {
      result = await analyzeMigCandlePattern(ca);
    } catch (e) {
      log('[MIG CANDLE] Gagal analisa ulang ' + watch.symbol + ': ' + e.message);
      continue;
    }

    if (!result.pattern) {
      watch.lastCheckedAt = Date.now();
      watch.reason = result.reason;
      CANDLE_ENTRY_WATCH.set(ca, watch);
      continue; // belum ada pola, tetap di watchlist, coba lagi cycle berikutnya
    }

    const p = result.pattern;
    if (p.type === 'BREAKOUT') {
      log('[MIG CANDLE] ' + watch.symbol + ' — BREAKOUT terkonfirmasi (watchlist): body ' + p.bodyRatio.toFixed(1)
        + 'x avg, close $' + fmtPrice(p.closePrice) + ' > resistance $' + fmtPrice(p.resistanceLevel) + ', kirim notif');
    } else {
      log('[MIG CANDLE] ' + watch.symbol + ' — FULLBACK terkonfirmasi (watchlist): uptrend +' + p.trendGainPct.toFixed(1)
        + '%, entry @ $' + fmtPrice(p.closePrice) + ', kirim notif');
    }

    var gmCandle = gradeMeta(watch.grade);
    var patternLabel = p.type === 'BREAKOUT' ? '🚀 Breakout' : '↩️ Fullback';
    var buyMsgIdCandle = await sendTelegram(
      '🎯 <b>ENTRY SIGNAL</b> | ' + gmCandle.emoji + ' ' + gmCandle.label + ' | 🆕 New Migration (' + patternLabel + ')\n'
      + watch.name + ' (<code>' + watch.symbol + '</code>)\n'
      + '━━━━━━━━━━━━━━━━━━━━\n'
      + '🏷️ Entry   : $' + fmtPrice(p.closePrice) + '\n'
      + '<a href="https://dexscreener.com/solana/' + ca + '">Chart</a>'
      + ' | <a href="https://gmgn.ai/sol/token/' + ca + '">GMGN</a>',
      null,
      CFG.tgThreadAuto || CFG.tgThreadMig
    );
    totalNotified++;

    TRACKED.set(ca, {
      symbol: watch.symbol, name: watch.name, grade: watch.grade, mode: 'MIGRATION',
      entryPrice: p.closePrice, entryAt: Date.now(), nextTargetIdx: 0, msgId: buyMsgIdCandle,
      threadId: CFG.tgThreadAuto || CFG.tgThreadMig,
      autoBuyStatus: 'ENTERED',
      candleEntry: true, candleEntryType: p.type,
    });
    savePositions();
    logTrackingEvent({
      type: 'ENTRY_SIGNAL',
      mode: 'MIGRATION',
      ca, symbol: watch.symbol, name: watch.name,
      entryPriceUsd: p.closePrice,
      candleEntry: true, candleEntryType: p.type,
    });
    CANDLE_ENTRY_WATCH.delete(ca);
    saveCandleEntryWatch();
  }
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

    if (gain <= -50) {
      var wasProfit   = (pos.nextTargetIdx || 0) > 0;
      var stopLabel   = wasProfit ? '📉 Stop Track (Was Profit)' : '🗑️ Stop Track';
      var stopType    = wasProfit ? 'STOP_TRACK_WAS_PROFIT' : 'STOP_TRACK';
      log(pos.symbol + ' dropped >50%, stop tracking' + (wasProfit ? ' [was profit]' : ''));
      logTrackingEvent({ type: stopType, ...pos, currentPrice, gain: gain.toFixed(1) });
      toRemove.push(ca);
      var gradeEmoji = pos.grade === 'GOLD' ? '🟢' : pos.grade === 'POTENSIAL' ? '🟡' : '🔴';
      var riskLabel  = pos.grade === 'GOLD' ? 'Grade A' : pos.grade === 'POTENSIAL' ? 'Grade B' : 'Grade C';
      var safeThread = pos.threadId || (pos.mode === 'SWING' ? CFG.tgThreadId : CFG.tgThreadMig);
      await sendTelegram(
        gradeEmoji + ' ' + riskLabel + ' | ' + modeLabel + ' | <b>' + stopLabel + '</b> | '
        + pos.name + ' (<code>' + pos.symbol + '</code>)\n'
        + 'Drop >50% dari entry $' + pos.entryPrice.toFixed(10) + ' → $' + currentPrice.toFixed(10),
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

// ─────────────────────────────────────────────
//  FIB ENTRY LOOP — independen dari scan token baru (runLoop). Recheck
//  watchlist PENDING_ENTRY tiap CFG.fibEntryPollInterval detik.
// ─────────────────────────────────────────────
var fibEntryRunning = false;
async function runFibEntryLoop() {
  if (fibEntryRunning) {
    setTimeout(runFibEntryLoop, CFG.fibEntryPollInterval * 1000);
    return;
  }
  fibEntryRunning = true;
  try {
    if (PENDING_ENTRY.size > 0) {
      await checkPendingEntries();
    }
  } catch (e) {
    log('[FIB ENTRY LOOP] FATAL: ' + (e && e.message ? e.message : String(e)));
  } finally {
    fibEntryRunning = false;
    setTimeout(runFibEntryLoop, CFG.fibEntryPollInterval * 1000);
  }
}

// ─────────────────────────────────────────────
//  CANDLE ENTRY LOOP — KHUSUS MIGRATION, independen dari runLoop/
//  runFibEntryLoop. Recheck watchlist CANDLE_ENTRY_WATCH tiap
//  CFG.migCandleEntryPollInterval detik. No-op kalau migCandleEntryEnabled OFF.
// ─────────────────────────────────────────────
var candleEntryRunning = false;
async function runCandleEntryLoop() {
  if (!CFG.migCandleEntryEnabled) return; // fitur OFF, gak perlu loop jalan sama sekali
  if (candleEntryRunning) {
    setTimeout(runCandleEntryLoop, CFG.migCandleEntryPollInterval * 1000);
    return;
  }
  candleEntryRunning = true;
  try {
    if (CANDLE_ENTRY_WATCH.size > 0) {
      await checkCandleEntryWatch();
    }
  } catch (e) {
    log('[MIG CANDLE LOOP] FATAL: ' + (e && e.message ? e.message : String(e)));
  } finally {
    candleEntryRunning = false;
    setTimeout(runCandleEntryLoop, CFG.migCandleEntryPollInterval * 1000);
  }
}

process.on('SIGINT',  () => { log('Saving...'); saveSeen(); process.exit(0); });
process.on('SIGTERM', () => { log('Saving...'); saveSeen(); process.exit(0); });

log('');
log('╔══════════════════════════════════════╗');
log('║   AUTO SCREENING v6 — TRIPLE MODE   ║');
log('╚══════════════════════════════════════╝');
log('');
log('[ Mode 1: New Migration ]');
log('  LP > $' + CFG.minLp.toLocaleString() + ' | Rug < ' + CFG.maxRugScore + ' [RugCheck API]');
log('  Insider < ' + CFG.maxInsiderPct + '% [RugCheck API] | Narasi cocok tetap lanjut walau GMGN risk/momentum/grade lemah');
log('  GMGN risk warning: Bundler > ' + CFG.maxBundlerPct + '% | Top10 > ' + CFG.maxTop10Holders + '% | CreatorHold > ' + CFG.maxDevHold + '%');
log('  GMGN risk warning: Sniper > ' + CFG.maxSniperPct + '% | Vol/LP > ' + CFG.maxVolLpRatio + 'x');
log('  Momentum warning: Vol1h < $' + CFG.minVol1h.toLocaleString() + ' | Txns5m < ' + CFG.minSwaps5m + ' | Vol5m < $' + CFG.minVol5m.toLocaleString());
log('  Creator tokens < ' + CFG.maxCreatorTokens + ' (serial creator check)');
log('  Entry gate: ' + (CFG.migCandleEntryEnabled
  ? '🕯️ Candle Pattern (breakout/fullback) — sumber candle: GMGN kline'
  : (CFG.fibEntryEnabled && CFG.fibEntryModes.includes('MIGRATION') ? '📐 Fib Entry (fair/support retrace)' : '⚡ Langsung (no gate)')));
if (CFG.migCandleEntryEnabled) {
  log('    Resolusi: ' + CFG.migCandleResolution + ' | Lookback: ' + CFG.migCandleLookback + ' candle');
  log('    Breakout: body >= ' + CFG.migBreakoutBodyMult + 'x avg, wick <= ' + CFG.migBreakoutMaxWickPct + '%, tembus resistance (lookback ' + CFG.migResistanceLookback + ')');
  log('    Fullback: body <= ' + CFG.migFullbackBodyMax + 'x avg, min uptrend ' + CFG.migFullbackMinUptrendCandles + ' candle');
  log('    Watchlist timeout: ' + (CFG.migCandleWatchTimeoutMin > 0 ? CFG.migCandleWatchTimeoutMin + 'm' : 'tidak ada'));
}
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
log('Interval: ' + CFG.interval + 's'
  + (CFG.fibEntryEnabled ? ' | Interval fib-entry: ' + CFG.fibEntryPollInterval + 's' : '')
  + (CFG.migCandleEntryEnabled ? ' | Interval candle-entry: ' + CFG.migCandleEntryPollInterval + 's' : ''));
log('');

loadSeen();
loadPositions();
loadPendingEntries();
loadCandleEntryWatch();

if (process.env.CI === 'true') {
  processTokens().then(() => process.exit(0));
} else {
  runLoop();
  runFibEntryLoop(); // loop terpisah recheck watchlist fib-entry, lihat CFG.fibEntryPollInterval
  runCandleEntryLoop(); // loop terpisah recheck watchlist candle-entry MIGRATION (no-op kalau migCandleEntryEnabled OFF)
  setInterval(doHealthCheck, CFG.healthInterval * 1000);
  setTimeout(() => pushJSONToGitHub(), 60 * 1000); // push pertama setelah 1 menit
  setInterval(() => pushJSONToGitHub(), 10 * 60 * 1000); // push tiap 10 menit
}
