require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const CFG = {
  minLp: Number(process.env.MIN_LP) || 15000,
  minVol: Number(process.env.MIN_VOL_5M) || 3000,
  maxRugScore: Number(process.env.MAX_RUG_SCORE) || 100,
  interval: Number(process.env.POLL_INTERVAL) || 60,
  healthInterval: Number(process.env.HEALTH_INTERVAL) || 3600,
  seenCleanupDays: Number(process.env.SEEN_CLEANUP_DAYS) || 7,
  tgToken: process.env.TG_TOKEN,
  tgChatId: process.env.TG_CHAT_ID,
  tgThreadId: Number(process.env.TG_THREAD_ID) || undefined,
  minBuyRatio: Number(process.env.MIN_BUY_RATIO) || 0,
};

if (!CFG.tgToken || !CFG.tgChatId) {
  console.error('Isi TG_TOKEN dan TG_CHAT_ID di .env');
  process.exit(1);
}

const TG_API = 'https://api.telegram.org/bot' + CFG.tgToken + '/sendMessage';
const SEEN_FILE = path.join(__dirname, 'seen.json');
const POSITIONS_FILE = path.join(__dirname, 'positions.json');
const LOG_FILE = path.join(__dirname, 'screen.log');
const TRACKING_LOG = path.join(__dirname, 'tracking_log.json');

const SEEN = new Map();
const TRACKED = new Map();
const TARGETS = [30, 50, 100, 200, 500];
let startTime = Date.now();
let totalNotified = 0;

function fmt(n) {
  if (!n || isNaN(n)) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return Number(n).toFixed(2);
}

function fmtPrice(n) {
  var v = Number(n);
  if (!v || isNaN(v)) return '0';
  if (v >= 1000) return (v / 1000).toFixed(2) + 'K';
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.0001) return v.toFixed(6);
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

function loadSeen() {
  try {
    const raw = fs.readFileSync(SEEN_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [ca, entry] of Object.entries(data.entries || {})) {
      SEEN.set(ca, entry);
    }
    log('Loaded ' + SEEN.size + ' seen tokens');
  } catch {
    log('No existing seen.json, starting fresh');
  }
}

function saveSeen() {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify({
      version: 2, savedAt: Date.now(), entries: Object.fromEntries(SEEN),
    }));
  } catch (e) {
    log('Failed to save seen.json: ' + e.message);
  }
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
    try { const r = fs.readFileSync(TRACKING_LOG, 'utf8'); data.push(...JSON.parse(r)); } catch {}
    data.push({ ...event, time: Date.now() });
    fs.writeFileSync(TRACKING_LOG, JSON.stringify(data));
  } catch {}
}

function loadPositions() {
  try {
    const raw = fs.readFileSync(POSITIONS_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [ca, entry] of Object.entries(data.entries || {})) {
      TRACKED.set(ca, entry);
    }
    log('Loaded ' + TRACKED.size + ' tracked positions');
  } catch {
    log('No existing positions.json, starting fresh');
  }
}

function savePositions() {
  try {
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify({
      version: 1, savedAt: Date.now(), entries: Object.fromEntries(TRACKED),
    }));
  } catch (e) {
    log('Failed to save positions.json: ' + e.message);
  }
}

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
      {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY || '' }
      }
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

function isMigratedDex(t) {
  var ex = t.exchange;
  return ex && ex !== 'pump';
}

function timeAgo(ts) {
  if (!ts) return '?';
  const diff = Date.now() - ts * 1000;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Baru saja';
  if (mins < 60) return mins + 'm';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'j';
  return Math.floor(hrs / 24) + 'h';
}

async function getRugCheck(ca) {
  try {
    const res = await getWithRetry('https://api.rugcheck.xyz/v1/tokens/' + ca + '/report', { timeout: 10000 });
    const d = res.data;
    const riskNames = (d.risks || []).map(r => r.name);
    const dangerFlags = riskNames.filter(n =>
      /mint|freeze|owner|creator|authority|supply|single|concentrat/i.test(n)
    );
    return {
      score: d.score || 0,
      riskLevel: d.riskLevel || '',
      risks: riskNames.join(', '),
      riskDetails: riskNames,
      tokenType: d.tokenType || 'unknown',
      deployPlatform: d.deployPlatform || '',
      creator: d.creator || d.owner || '?',
      topDangers: dangerFlags.slice(0, 3),
      rugged: d.rugged || false,
    };
  } catch { return { score: 999, riskLevel: '', risks: 'Fetch failed', creator: '?', topDangers: [], tokenType: '', rugged: false, deployPlatform: '' }; }
}

async function fetchGMGNKline(address, resolution = '1h', fromMs, toMs) {
  try {
    const host = process.env.GMGN_HOST || 'https://openapi.gmgn.ai';
    const ts = Math.floor(Date.now() / 1000);
    const cid = 'ax' + ts.toString(36) + Math.random().toString(36).slice(2, 10);
    const url = host + '/v1/market/token_kline?chain=sol&address=' + address + '&resolution=' + resolution + '&from=' + Math.floor(fromMs) + '&to=' + Math.floor(toMs) + '&timestamp=' + ts + '&client_id=' + cid;
    const res = await axios.get(url, {
      headers: { 'X-APIKEY': process.env.GMGN_API_KEY || '' },
      timeout: 10000,
    });
    return res.data?.list || null;
  } catch {
    return null;
  }
}

async function sendTelegram(msg, replyTo) {
  try {
    var payload = { chat_id: CFG.tgChatId, text: msg, parse_mode: 'HTML' };
    if (CFG.tgThreadId) payload.message_thread_id = CFG.tgThreadId;
    if (replyTo) payload.reply_to_message_id = replyTo;
    var res = await axios.post(TG_API, payload, { timeout: 10000 });
    return res.data.result?.message_id || null;
  } catch (e) {
    var desc = '';
    if (e.response && e.response.data && e.response.data.description) desc = e.response.data.description;
    else desc = e.message;
    log('TG error: ' + desc);
    return null;
  }
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

// Hitung Fibonacci dari candle OHLCV nyata (kline GMGN)
// Fallback ke estimasi jika kline tidak tersedia
async function calculateFibonacci(address, price, changePct, mc, athMc) {
  var p = Number(price);
  if (!p || p <= 0) p = 0.0001;
  var floor = p * 0.1;

  // Coba ambil kline nyata dari GMGN (24 candle 1h ke belakang)
  try {
    var toMs = Date.now() / 1000;
    var fromMs = toMs - 86400; // 24 jam
    var klines = await fetchGMGNKline(address, '1h', fromMs, toMs);
    if (klines && klines.length >= 3) {
      var highs = klines.map(c => Number(c.high)).filter(v => v > 0);
      var lows  = klines.map(c => Number(c.low)).filter(v => v > 0);
      var swingHigh = Math.max(...highs);
      var swingLow  = Math.min(...lows);
      if (swingHigh > swingLow && swingHigh > 0) {
        var range = swingHigh - swingLow;
        log('Fib dari kline nyata: H=' + swingHigh + ' L=' + swingLow + ' (' + klines.length + ' candle)');
        return {
          source: 'kline',
          swingHigh: swingHigh,
          swingLow: swingLow,
          support:  Math.max(swingHigh - range * 0.500, floor).toFixed(10),
          fair:     Math.max(swingHigh - range * 0.618, floor).toFixed(10),
          resist:   (swingHigh + range * 0.382).toFixed(10),
          sl:       Math.max(swingLow  - range * 0.272, floor * 0.5).toFixed(10),
        };
      }
    }
  } catch (e) {
    log('Kline fetch failed, fallback estimasi: ' + e.message);
  }

  // Fallback: estimasi dari % change & ATH MC (perilaku lama, diberi label jelas)
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

// Score dinamis 0-100 berdasarkan kondisi token nyata
function calculateScore(t, rug, grade) {
  var score = 0;

  // LP (max 20)
  var lp = t.liquidity || 0;
  if (lp > 100000) score += 20;
  else if (lp > 50000) score += 15;
  else if (lp > 30000) score += 10;
  else if (lp > 15000) score += 5;

  // Volume 1h (max 20)
  var vol = t.volume || 0;
  if (vol > 200000) score += 20;
  else if (vol > 100000) score += 15;
  else if (vol > 50000) score += 10;
  else if (vol > 10000) score += 5;

  // Buy ratio (max 10)
  var totalTxn = (t.buys || 0) + (t.sells || 0);
  var buyRatio = totalTxn > 0 ? (t.buys / totalTxn) * 100 : 50;
  if (buyRatio >= 65) score += 10;
  else if (buyRatio >= 55) score += 7;
  else if (buyRatio >= 45) score += 3;

  // RugCheck score (max 15)
  var rs = rug.score || 999;
  if (rs < 20) score += 15;
  else if (rs < 50) score += 10;
  else if (rs < 100) score += 5;
  else score -= 10;

  // Mint & Freeze renounced (max 10)
  if (t.renounced_mint === 1) score += 5;
  if (t.renounced_freeze_account === 1) score += 5;

  // Burn (max 5)
  var burn = (t.burn_ratio || 0) * 100;
  if (burn >= 50) score += 5;
  else if (burn >= 20) score += 3;
  else if (burn >= 5) score += 1;

  // Bot ratio — penalti (max -15)
  var holders = t.holder_count || 1;
  var botRatio = (t.bot_degen_count || 0) / holders;
  if (botRatio > 0.40) score -= 15;
  else if (botRatio > 0.25) score -= 10;
  else if (botRatio > 0.10) score -= 5;

  // Bundler — penalti (max -10)
  var bundler = (t.bundler_rate || 0) * 100;
  if (bundler > 30) score -= 10;
  else if (bundler > 20) score -= 7;
  else if (bundler > 10) score -= 3;

  // Creator hold — penalti (max -10)
  var creatorHold = (t.dev_team_hold_rate || 0) * 100;
  if (creatorHold > 10) score -= 10;
  else if (creatorHold > 5) score -= 5;

  // Top10 concentration — penalti (max -5)
  var top10 = (t.top_10_holder_rate || 0) * 100;
  if (top10 > 50) score -= 5;
  else if (top10 > 35) score -= 3;

  // Smart degen bonus (max 5)
  var smart = t.smart_degen_count || 0;
  if (smart >= 10) score += 5;
  else if (smart >= 5) score += 3;
  else if (smart >= 1) score += 1;

  return Math.min(100, Math.max(0, score));
}

async function processTokens() {
  log('========== SCREENING ==========');
  var tokens = fetchGmgnTrending();
  if (tokens.length === 0) { log('No tokens from GMGN'); return; }

  var dexTokens = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.address || SEEN.has(t.address)) continue;
    if (!isMigratedDex(t)) { log('SKIP ' + (t.symbol || '?') + ' (still ' + (t.exchange || 'pump') + ')'); continue; }
    dexTokens.push(t);
  }

  log('DEX migrated & unseen: ' + dexTokens.length);

  for (let i = 0; i < dexTokens.length; i++) {
    const t = dexTokens[i];
    const totalTxn = t.buys + t.sells;
    if (totalTxn > 0) {
      const buyPct = (t.buys / totalTxn) * 100;
      if (buyPct < CFG.minBuyRatio) { log('SKIP ' + t.symbol + ' (Buy ' + buyPct.toFixed(0) + '% < ' + CFG.minBuyRatio + '%)'); continue; }
    }
    if (t.volume < CFG.minVol) { log('SKIP ' + t.symbol + ' (Vol $' + t.volume + ')'); continue; }
    if (t.liquidity < CFG.minLp) { log('SKIP ' + t.symbol + ' (LP $' + t.liquidity + ')'); continue; }

    SEEN.set(t.address, { firstSeen: Date.now() });

    log('RugCheck: ' + t.symbol + ' (' + t.address + ')');
    try {
      const rug = await getRugCheck(t.address);
      if (rug.score > CFG.maxRugScore) {
        log('SKIP ' + t.symbol + ' (Rug ' + rug.score + ')');
        continue;
      }
      const grade = gradeToken(t.liquidity, t.volume, rug.score);
      if (grade === 'SKIP') {
        log('SKIP ' + t.symbol);
        continue;
      }
      log(grade + ' ' + t.symbol + ' (LP: $' + t.liquidity + ', Vol: $' + t.volume + ', Rug: ' + rug.score + ')');

      var msgId = await sendTelegram(await buildMessage(t, rug, grade, null));
      totalNotified++;
      if (grade !== 'SKIP' && t.price && Number(t.price) > 0) {
        TRACKED.set(t.address, {
          symbol: t.symbol,
          name: t.name,
          grade: grade,
          entryPrice: Number(t.price),
          entryAt: Date.now(),
          nextTargetIdx: 0,
          msgId: msgId,
        });
        log('Tracked ' + t.symbol + ' @ $' + t.price);
      }
    } catch (e) {
      log('RugCheck error for ' + t.symbol + ': ' + e.message);
    }
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

async function checkTrackedPositions(trendingTokens) {
  var priceMap = {};
  for (let i = 0; i < trendingTokens.length; i++) {
    var tt = trendingTokens[i];
    if (tt.address && tt.price) priceMap[tt.address] = Number(tt.price);
  }

  var toRemove = [];
  for (const [ca, pos] of TRACKED) {
    var currentPrice = priceMap[ca];

    if (!currentPrice) {
      try {
        var ds = await axios.get('https://api.dexscreener.com/latest/dex/tokens/' + ca, { timeout: 8000 });
        var pairs = ds.data.pairs || [];
        var best = pairs.find(p => p.priceUsd) || pairs[0] || null;
        if (best && best.priceUsd) currentPrice = Number(best.priceUsd);
      } catch {}
    }

    if (!currentPrice || currentPrice <= 0) continue;

    var gain = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

    if (gain <= -80) {
      log(pos.symbol + ' dropped >80%, removing tracking');
      logTrackingEvent({ type: 'STOP_TRACK', symbol: pos.symbol, name: pos.name, grade: pos.grade, entryPrice: pos.entryPrice, currentPrice: currentPrice, gain: gain.toFixed(1) });
      toRemove.push(ca);
      var gradeEmoji = pos.grade === 'GOLD' ? '🟢' : '🔴';
      var riskLabel = pos.grade === 'GOLD' ? 'Grade A' : 'Grade B';
      await sendTelegram(
        gradeEmoji + ' 🗑️ ' + riskLabel + ' | <b>Stop Track</b> | ' + pos.name + ' (<code>' + pos.symbol + '</code>)\n' +
        'Drop >80% dari entry $' + pos.entryPrice.toFixed(10) + ' → $' + currentPrice.toFixed(10),
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
      var emoji = target >= 100 ? '🚀' : target >= 50 ? '📈' : '⬆️';
      log(pos.symbol + ' hit target +' + target + '%');
      logTrackingEvent({ type: 'TERCAPAI', symbol: pos.symbol, name: pos.name, grade: pos.grade, entryPrice: pos.entryPrice, currentPrice: currentPrice, target: target, gain: gain.toFixed(1) });
      var gradeEmoji = pos.grade === 'GOLD' ? '🟢' : '🔴';
      var riskLabel = pos.grade === 'GOLD' ? 'Grade A' : 'Grade B';
      await sendTelegram(
        gradeEmoji + ' ' + riskLabel + ' | ' + emoji + ' <b>Target +' + target + '% Tercapai!</b>\n' +
        '<b>' + pos.name + '</b> (<code>' + pos.symbol + '</code>)\n' +
        'Entry: $' + pos.entryPrice.toFixed(10) + '\n' +
        'Sekarang: $' + currentPrice.toFixed(10) + '\n' +
        'Gain: <b>+' + gain.toFixed(1) + '%</b>\n' +
        '<a href="https://dexscreener.com/solana/' + ca + '">Buka Chart</a> | <a href="https://gmgn.ai/sol/token/' + ca + '">GMGN</a>',
        pos.msgId
      );
      pos.nextTargetIdx = highestIdx + 1;
      savePositions();
    }
  }

  for (var i = 0; i < toRemove.length; i++) {
    TRACKED.delete(toRemove[i]);
  }
  if (toRemove.length > 0) savePositions();
}

function detectNarrative(name, symbol) {
  var s = ((name || '') + ' ' + (symbol || '')).toLowerCase();
  var cat = [], tag = [];

  var animalKws = {dog: '🐕', cat: '🐱', frog: '🐸', pepe: '🐸', horse: '🐴', bird: '🐦', fish: '🐟', wolf: '🐺', bear: '🐻', bull: '🐂', dragon: '🐉', whale: '🐋', shark: '🦈', lion: '🦁', tiger: '🐯', panda: '🐼', snake: '🐍', rabbit: '🐇', turtle: '🐢', duck: '🦆', seal: '🦭', koala: '🐨', monkey: '🐵', gorilla: '🦍', hippo: '🦛', fox: '🦊', rat: '🐀', hamster: '🐹', owl: '🦉', eagle: '🦅', penguin: '🐧'};
  for (var kw in animalKws) { if (s.includes(kw)) { cat.push(animalKws[kw] + ' Animal'); tag.push(kw.charAt(0).toUpperCase() + kw.slice(1)); break; } }

  var celebKws = ['trump', 'musk', 'elon', 'kanye', 'biden', 'obama', 'hawk', 'pnut', 'taylor', 'kamala', 'vance', 'melania', 'barron'];
  for (var i = 0; i < celebKws.length; i++) { if (s.includes(celebKws[i])) { cat.push('🎭 Celebrity'); tag.push(celebKws[i].charAt(0).toUpperCase() + celebKws[i].slice(1)); break; } }

  var aiKws = ['ai', 'gpt', 'claude', 'agent', 'neural', 'deep', 'grok', 'chatbot', 'llm', 'tokenai', 'bot', 'predict'];
  for (var j = 0; j < aiKws.length; j++) { if (s.includes(aiKws[j]) && !cat.length) { cat.push('🤖 AI/Agent'); tag.push('AI'); break; } }

  var gameKws = ['game', 'play', 'guild', 'raid', 'arena', 'legends', 'gaming', 'rpg', 'pixel'];
  for (var k = 0; k < gameKws.length; k++) { if (s.includes(gameKws[k])) { cat.push('🎮 Gaming'); tag.push('Gaming'); break; } }

  var defiKws = ['swap', 'lend', 'borrow', 'stake', 'yield', 'vault', 'farm', 'defi', 'liquid'];
  for (var l = 0; l < defiKws.length; l++) { if (s.includes(defiKws[l])) { cat.push('🏛️ DeFi'); tag.push('DeFi'); break; } }

  var cultureKws = ['degen', 'based', 'wagmi', 'ngmi', 'fren', 'ser', 'dao', 'moon', 'lambo', 'wen', 'gm', 'chad', 'soy', 'normie'];
  for (var m = 0; m < cultureKws.length; m++) { if (s.includes(cultureKws[m]) && !cat.length) { cat.push('💎 Culture'); tag.push('Culture'); break; } }

  var infraKws = ['bridge', 'oracle', 'layer', 'protocol', 'infra', 'cross', 'inter'];
  for (var n = 0; n < infraKws.length; n++) { if (s.includes(infraKws[n])) { cat.push('🔧 Infra'); tag.push('Infra'); break; } }

  if (!cat.length) {
    var symDigits = (symbol || '').replace(/[^a-zA-Z]/g, '');
    if (symDigits !== (symbol || '')) { cat.push('🔄 Copycat'); tag.push('Copycat'); }
    else { cat.push('🔷 Meme'); tag.push('Meme'); }
  }

  return { category: cat[0] || '🔷 Meme', tag: tag[0] || '' };
}

async function buildMsg(t, rug, grade, dex24h) {
  var re, ve, le;
  if (rug.score < 50) re = '\u2705'; else if (rug.score < 100) re = '\u26a0\ufe0f'; else re = '\ud83d\udea8';
  if (t.volume > 100000) ve = '\ud83d\ude80'; else if (t.volume > 50000) ve = '\ud83d\udcc8'; else ve = '\ud83d\udcca';
  if (t.liquidity > 100000) le = '\ud83d\udfe2'; else if (t.liquidity > 50000) le = '\ud83d\udfe1'; else le = '\ud83d\udd35';

  var ratio = '?';
  var totalTxn = t.buys + t.sells;
  if (totalTxn > 0) ratio = (t.buys / totalTxn * 100).toFixed(0) + '%';

  var age = timeAgo(t.creation_timestamp);

  var chg1h = '';
  if (t.price_change_percent1h != null) {
    if (t.price_change_percent1h > 0) chg1h = ' \ud83d\udcc8 +' + Number(t.price_change_percent1h).toFixed(1) + '%';
    else chg1h = ' \ud83d\udcc9 ' + Number(t.price_change_percent1h).toFixed(1) + '%';
  }

  var linkParts = [];
  if (t.twitter_username) linkParts.push(' <a href="' + t.twitter_username + '">Twitter</a>');
  if (t.website) linkParts.push(' <a href="' + t.website + '">Web</a>');
  if (t.telegram) linkParts.push(' <a href="' + t.telegram + '">TG</a>');
  var linkList = linkParts.join(' | ');

  var dangerText = '';
  if (rug.topDangers.length > 0) {
    dangerText = '\n\u26a0\ufe0f Dangers: ' + rug.topDangers.join(', ');
  }

  var mi = t.renounced_mint === 1 ? '\u2705' : '\u274c';
  var fr = t.renounced_freeze_account === 1 ? '\u2705' : '\u274c';
  var hp = t.is_honeypot === 1 ? '\ud83d\udea8' : '\u2705';
  var burnPct = (t.burn_ratio * 100).toFixed(1);
  var top10 = (t.top_10_holder_rate * 100).toFixed(1);
  var bundler = (t.bundler_rate * 100).toFixed(1);
  var snipers = (t.top70_sniper_hold_rate * 100).toFixed(1);
  var creatorHold = (t.dev_team_hold_rate * 100).toFixed(1);

  var SEP = '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501';

  var nar = detectNarrative(t.name, t.symbol);
  var gradeEmoji = grade === 'GOLD' ? '🟢' : '🔴';
  var riskLabel = grade === 'GOLD' ? 'Grade A' : 'Grade B';
  var msg = '';
  msg += gradeEmoji + ' <b>' + riskLabel + '</b> | ' + nar.category + ' | ' + t.name + ' (<code>' + t.symbol + '</code>)\n';
  msg += SEP + '\n';
  msg += le + ' LP      : $' + fmt(t.liquidity) + '\n';
  msg += ve + ' Vol 1h  : $' + fmt(t.volume) + '\n';
  var rugLabel = rug.score < 50 ? 'Rendah' : rug.score < 100 ? 'Sedang' : 'Bahaya!';
  msg += re + ' RugCheck: ' + rug.score + ' (' + rugLabel + ')';
  if (rug.riskDetails && rug.riskDetails.length > 0) msg += ' | Anomali: ' + rug.riskDetails.join(', ');
  if (rug.riskLevel) msg += ' | ' + rug.riskLevel;
  if (rug.tokenType && rug.tokenType !== 'unknown') msg += ' | ' + rug.tokenType;
  if (rug.deployPlatform) msg += ' | ' + rug.deployPlatform;
  msg += '\n';
  msg += '\ud83d\udcb0 Harga   : $' + fmtPrice(t.price) + chg1h + '\n';
  msg += '\ud83d\udd04 Buy/Sell: ' + t.buys + '/' + t.sells + ' (' + ratio + ' Buy)\n';
  msg += '\ud83d\udcca MC      : $' + fmt(t.market_cap) + '\n';
  if (dex24h && dex24h.vol24h > 0) msg += '\ud83d\udcca Vol 24h : $' + fmt(dex24h.vol24h) + '\n';
  if (dex24h && dex24h.dexName) msg += '\ud83d\udee1\ufe0f DEX     : ' + dex24h.dexName + '\n';
  msg += '\u23f1\ufe0f Age     : ' + age + '\n';
  msg += '\ud83d\udc64 Creator : <code>' + rug.creator + '</code>' + dangerText + '\n';
  if (linkList) {
    msg += '\ud83d\udd17 Links   : ' + linkList + '\n';
  }
  msg += SEP + '\n';

  msg += '\ud83d\udee1\ufe0f GMGN:\n';
  msg += '\ud83d\udccb Holders: ' + fmt(t.holder_count || 0) + '\n';
  msg += '\ud83d\udd0d Top10: ' + top10 + '%\n';
  msg += '\ud83d\udd17 Bundler: ' + bundler + '%\n';
  msg += '\ud83e\udd16 Bots: ' + (t.bot_degen_count || 0) + '\n';
  msg += '\ud83c\udfaf Snipers: ' + snipers + '%\n';
  msg += '\ud83d\udc64 Creator: ' + creatorHold + '%\n';
  msg += '\u267b\ufe0f Burn: ' + burnPct + '%\n';
  msg += 'Mint: ' + mi + ' | Freeze: ' + fr + ' | Honeypot: ' + hp + '\n';
  msg += 'Smart: ' + (t.smart_degen_count || 0) + ' | Sniper: ' + (t.sniper_count || 0) + ' | Bundler: ' + (t.renowned_count || 0) + '\n';
  msg += SEP + '\n';

  var f = await calculateFibonacci(t.address, t.price, t.price_change_percent1h, t.market_cap, t.history_highest_market_cap);
  var fibLabel = f.source === 'kline' ? 'dari candle nyata' : 'estimasi, cek chart';
  msg += '\ud83d\udcca Entry & Targets:\n';
  msg += '\u23f0 Entry   : $' + fmtPrice(t.price) + '\n';
  msg += '\ud83c\udfaf Target  : +30% → $' + fmtPrice(t.price * 1.3) + '\n';
  msg += '\ud83d\udcca Fib Level <i>(' + fibLabel + ')</i>:\n';
  msg += '\ud83d\udfe2 Support : $' + fmtPrice(f.support) + '\n';
  msg += '\u2696\ufe0f  Fair    : $' + fmtPrice(f.fair) + '\n';
  msg += '\ud83d\udd34 Resist  : $' + fmtPrice(f.resist) + '\n';
  msg += '\u26d4 SL      : $' + fmtPrice(f.sl) + '\n';
  var dynScore = calculateScore(t, rug, grade);
  msg += 'Score: ' + dynScore + '/100\n';

  var warnings = [];
  var currentPrice = Number(t.price);
  var supportPrice = Number(f.support);
  var slPrice = Number(f.sl);
  if (currentPrice > 0 && supportPrice > 0) {
    var pctAbove = ((currentPrice - supportPrice) / supportPrice) * 100;
    if (pctAbove > 100) warnings.push('📈 Harga ' + pctAbove.toFixed(0) + '% di atas Support — sangat rawan FOMO, tunggu pullback');
    else if (pctAbove > 50) warnings.push('📈 Harga ' + pctAbove.toFixed(0) + '% di atas Support — rawan FOMO');
  }
  if (Number(creatorHold) > 5) warnings.push('👤 Creator hold ' + creatorHold + '% — rawan dump');
  if (Number(bundler) > 20 && Number(top10) > 30) warnings.push('🔄 Bundler ' + bundler + '% + Top10 ' + top10 + '% — rawan distribusi');
  if (Number(snipers) > 10) warnings.push('🎯 Snipers ' + snipers + '% — rawan sniper activity');
  var holders = t.holder_count || 0;
  if (holders > 0 && (t.bot_degen_count / holders) > 0.05) warnings.push('🤖 Bots ' + t.bot_degen_count + ' (' + (t.bot_degen_count / holders * 100).toFixed(1) + '%) dari ' + fmt(holders) + ' holders — rawan bot');
  if (t.volume && t.volume < CFG.minVol * 2) warnings.push('📊 Volume tipis ($' + fmt(t.volume) + ') — rawan manipulasi');
  for (var wi = 0; wi < warnings.length; wi++) {
    msg += '\u26a0\ufe0f ' + warnings[wi] + '\n';
  }

  msg += SEP + '\n';

  msg += '<a href="https://dexscreener.com/solana/' + t.address + '">Buka Chart</a> | <a href="https://gmgn.ai/sol/token/' + t.address + '">GMGN</a>\n';
  msg += '<code>' + t.address + '</code>';

  return msg;
}

async function buildMessage(t, rug, grade, dex24h) {
  return buildMsg(t, rug, grade, dex24h);
}

function doHealthCheck() {
  var u = Math.floor((Date.now() - startTime) / 1000);
  var h = Math.floor(u / 3600);
  var m = Math.floor((u % 3600) / 60);
  var s = u % 60;
  log('[HEALTH] ' + h + 'h ' + m + 'm ' + s + 's | Seen: ' + SEEN.size + ' | Notified: ' + totalNotified);
}

async function runLoop() {
  try { await processTokens(); } catch (e) { log('FATAL: ' + e.message); }
  setTimeout(runLoop, CFG.interval * 1000);
}

function shutdown(signal) { log('Saving...'); saveSeen(); process.exit(0); }
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log('');
log('╔══════════════════════════════════╗');
log('║   AUTO SCREENING v5 (GMGN)      ║');
log('╚══════════════════════════════════╝');
log('');
log('Source: GMGN Market Trending (100 token/1h, DEX only)');
log('Filter: LP > $' + CFG.minLp.toLocaleString() + ' | Vol > $' + CFG.minVol.toLocaleString() + ' | Rug < ' + CFG.maxRugScore + ' | Buy > ' + CFG.minBuyRatio + '%');
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
