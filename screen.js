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
      risks: riskNames.join(', '),
      creator: d.creator || d.owner || '?',
      topDangers: dangerFlags.slice(0, 3),
      tokenType: d.tokenType || '',
      rugged: d.rugged || false,
      deployPlatform: d.deployPlatform || '',
    };
  } catch { return { score: 999, risks: 'Fetch failed', creator: '?', topDangers: [], tokenType: '', rugged: false, deployPlatform: '' }; }
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

function calculateFibFromKline(candles, currentPrice) {
  if (!candles || candles.length < 6) return null;
  var closes = candles.map(function(c) { return Number(c.close); }).filter(function(v) { return v > 0; });
  if (closes.length < 6) return null;
  var sorted = closes.slice().sort(function(a, b) { return a - b; });
  var trimIdx = Math.max(1, Math.floor(sorted.length * 0.15));
  var trimmed = sorted.slice(trimIdx, sorted.length - trimIdx);
  var swingHigh = trimmed[trimmed.length - 1];
  var swingLow = trimmed[0];
  var range = swingHigh - swingLow;
  if (range <= 0 || isNaN(range)) return null;
  var midpoint = (swingHigh + swingLow) / 2;
  var aboveMid = currentPrice >= midpoint;
  var floor = currentPrice * 0.1;
  if (aboveMid) {
    return {
      support: Math.max(swingHigh - range * 0.618, floor).toFixed(10),
      fair: Math.max(swingHigh - range * 0.382, floor).toFixed(10),
      resist: (swingHigh + range * 0.382).toFixed(10),
      sl: Math.max(swingHigh - range * 1.272, floor * 0.5).toFixed(10),
      source: 'kline',
    };
  }
  return {
    support: Math.max(swingLow - range * 0.272, floor).toFixed(10),
    fair: Math.max(swingLow + range * 0.382, floor).toFixed(10),
    resist: (swingLow + range * 0.618).toFixed(10),
    sl: Math.max(swingLow - range * 0.618, floor * 0.5).toFixed(10),
    source: 'kline',
  };
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

function calculateFibonacci(price, changePct, mc, athMc) {
  var p = Number(price);
  if (!p || p <= 0) p = 0.0001;
  var h, l, priceIsHigh;
  if (athMc && mc && Number(athMc) > Number(mc)) {
    var ratio = Math.min(Number(athMc) / Number(mc), 20);
    h = p * ratio;
    l = p;
    priceIsHigh = false;
  } else {
    var ch = Number(changePct) || 0;
    if (ch > 0) { h = p; l = p / (1 + ch / 100); priceIsHigh = true; }
    else if (ch < 0) { h = p / (1 + ch / 100); l = p; priceIsHigh = false; }
    else { h = p * 1.2; l = p * 0.8; priceIsHigh = false; }
  }
  var range = h - l;
  if (range < p * 0.05) range = p * 0.1;
  var floor = p * 0.1;
  if (priceIsHigh) {
    return {
      support: Math.max(h - range * 0.618, floor).toFixed(10),
      fair: Math.max(h - range * 0.5, floor).toFixed(10),
      resist: (h + range * 0.382).toFixed(10),
      sl: Math.max(h - range * 1.272, floor * 0.5).toFixed(10),
    };
  } else {
    return {
      support: Math.max(l - range * 0.272, floor).toFixed(10),
      fair: Math.max(l - range * 0.5, floor).toFixed(10),
      resist: (l + range * 0.382).toFixed(10),
      sl: Math.max(l - range * 0.618, floor * 0.5).toFixed(10),
    };
  }
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

      var fibData = null;
      if (grade === 'GOLD' && t.price && Number(t.price) > 0) {
        var now = Date.now();
        var kline = await fetchGMGNKline(t.address, '1h', now - 86400000, now);
        if (kline) {
          fibData = calculateFibFromKline(kline, Number(t.price));
        }
      }
      if (!fibData) {
        log('Fib fallback (GMGN) for ' + t.symbol);
      }

      var msgId = await sendTelegram(buildMessage(t, rug, grade, null, fibData));
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
      toRemove.push(ca);
      var gradeEmoji = pos.grade === 'GOLD' ? '🟢' : '🔴';
      var riskLabel = pos.grade === 'GOLD' ? 'Low Risk' : 'High Risk';
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
      var gradeEmoji = pos.grade === 'GOLD' ? '🟢' : '🔴';
      var riskLabel = pos.grade === 'GOLD' ? 'Low Risk' : 'High Risk';
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

function buildMsg(t, rug, grade, dex24h, fibData) {
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
  var riskLabel = grade === 'GOLD' ? 'Low Risk' : 'High Risk';
  var msg = '';
  msg += gradeEmoji + ' <b>' + riskLabel + '</b> | ' + nar.category + ' | ' + t.name + ' (<code>' + t.symbol + '</code>)\n';
  msg += SEP + '\n';
  msg += le + ' LP      : $' + fmt(t.liquidity) + '\n';
  msg += ve + ' Vol 1h  : $' + fmt(t.volume) + '\n';
  var rugLabel = rug.score < 50 ? 'Rendah' : rug.score < 100 ? 'Sedang' : 'Bahaya!';
  msg += re + ' RugCheck: ' + rug.score + ' (' + rugLabel + ')';
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

  var f;
  if (fibData) {
    f = fibData;
  } else {
    f = calculateFibonacci(t.price, t.price_change_percent1h, t.market_cap, t.history_highest_market_cap);
  }
  var fibLabel = fibData && fibData.source === 'kline' ? 'Fib Level (Kline 24h)' : 'Est. Fib Level';
  msg += '\ud83d\udcca ' + fibLabel + ':\n';
  msg += '\ud83d\udfe2 Support: $' + fmtPrice(f.support) + ' (referensi, cek chart)\n';
  msg += 'Score: ' + (grade === 'GOLD' ? 85 : 70) + '/100\n';

  var warnings = [];
  var currentPrice = Number(t.price);
  var supportPrice = Number(f.support);
  if (currentPrice > 0 && supportPrice > 0) {
    var pctAbove = ((currentPrice - supportPrice) / supportPrice) * 100;
    if (pctAbove > 50) warnings.push('📈 Harga ' + pctAbove.toFixed(0) + '% di atas Support — rawan FOMO');
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

function buildMessage(t, rug, grade, dex24h, fibData) {
  return buildMsg(t, rug, grade, dex24h, fibData);
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
log('║   AUTO SCREENING v4 (GMGN)      ║');
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
