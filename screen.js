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
    
    // PERBAIKAN: Handle undefined/null risks array dengan aman
    const risks = Array.isArray(d.risks) ? d.risks : [];
    const riskNames = risks.map(r => (r && r.name) ? String(r.name) : '').filter(Boolean);
    
    // PERBAIKAN: Handle danger flags dengan aman
    const dangerFlags = riskNames.filter(n =>
      /mint|freeze|owner|creator|authority|supply|single|concentrat/i.test(String(n))
    );
    
    return {
      score: d.score || 0,
      riskLevel: d.riskLevel || '',
      risks: riskNames.length > 0 ? riskNames.join(', ') : 'No risks detected',
      topDangers: dangerFlags.slice(0, 3),
      creator: d.creator || 'Unknown',
      tokenType: d.tokenType || '',
      deployPlatform: d.deployPlatform || '',
    };
  } catch (e) {
    log('RugCheck error for ' + ca + ': ' + e.message);
    return {
      score: 999,
      riskLevel: 'ERROR',
      risks: 'Failed to fetch',
      topDangers: [],
      creator: 'Unknown',
      tokenType: '',
      deployPlatform: '',
    };
  }
}

async function getDex24h(ca) {
  try {
    const res = await getWithRetry('https://api.dexscreener.com/latest/dex/tokens/' + ca, {});
    if (!res.data.pairs || res.data.pairs.length === 0) return null;
    const pair = res.data.pairs[0];
    return {
      vol24h: pair.volume && pair.volume.h24 ? Number(pair.volume.h24) : 0,
      dexName: pair.dexId ? pair.dexId.toUpperCase() : 'Unknown'
    };
  } catch {
    return null;
  }
}

async function getGmgnData(ca) {
  try {
    const out = execSync('npx gmgn-cli token info --chain sol --address ' + ca + ' --raw', {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY || '' }
    });
    return JSON.parse(out);
  } catch (e) {
    log('GMGN data error for ' + ca + ': ' + e.message);
    return null;
  }
}

function calculateScore(t, rug, grade) {
  var baseScore = Math.max(0, 100 - rug.score);
  var volumeScore = Math.min(30, (Number(t.volume || 0) / 50000) * 30);
  var liquidityScore = Math.min(20, (Number(t.liquidity || 0) / 100000) * 20);
  var holdersScore = Math.min(10, (Number(t.holder_count || 0) / 1000) * 10);
  var buyRatio = t.buys + t.sells > 0 ? (t.buys / (t.buys + t.sells)) * 100 : 0;
  var buyScore = Math.min(15, (buyRatio / 100) * 15);
  var ageScore = t.creation_timestamp ? Math.min(10, (((Date.now() / 1000) - t.creation_timestamp) / 86400) * 10) : 0;
  var total = baseScore + volumeScore + liquidityScore + holdersScore + buyScore + ageScore;
  return Math.round(Math.min(100, total));
}

async function calculateFibonacci(ca, currentPrice, change1h, mc, mcHigh) {
  try {
    const out = execSync('npx gmgn-cli kline --chain sol --address ' + ca + ' --interval 1h --limit 240 --raw', {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY || '' }
    });
    const kline = JSON.parse(out);
    if (kline.data && kline.data.klines && kline.data.klines.length > 0) {
      const klns = kline.data.klines;
      const closes = klns.map(k => Number(k.close));
      const high = Math.max(...closes);
      const low = Math.min(...closes);
      const range = high - low;
      const fib618 = high - range * 0.618;
      const fib382 = high - range * 0.382;
      return {
        source: 'kline',
        support: fib618,
        fair: fib382,
        resist: high,
        sl: low
      };
    }
  } catch {}
  
  var cp = Number(currentPrice) || 1;
  var sup = cp * 0.8;
  var res = cp * 1.5;
  var fir = (sup + res) / 2;
  var sll = cp * 0.5;
  return { source: 'estimate', support: sup, fair: fir, resist: res, sl: sll };
}

async function processTokens() {
  const tokens = fetchGmgnTrending();
  const now = Date.now();
  
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.address || !t.name || !t.symbol) continue;
    if (!isMigratedDex(t)) continue;
    if (Number(t.liquidity || 0) < CFG.minLp) continue;
    if (Number(t.volume_5m || 0) < CFG.minVol) continue;
    
    const seenEntry = SEEN.get(t.address);
    if (seenEntry && now - seenEntry.lastCheck < 300000) continue;
    
    const rug = await getRugCheck(t.address);
    if (rug.score > CFG.maxRugScore) {
      SEEN.set(t.address, { ...seenEntry, lastCheck: now, rugScore: rug.score });
      continue;
    }
    
    const dex24h = await getDex24h(t.address);
    const buyRatio = t.buys + t.sells > 0 ? (t.buys / (t.buys + t.sells)) * 100 : 0;
    if (buyRatio < CFG.minBuyRatio) continue;
    
    const grade = rug.score < 50 ? 'GOLD' : 'SILVER';
    
    let isNew = false;
    if (!seenEntry) {
      SEEN.set(t.address, {
        firstSeen: now,
        lastCheck: now,
        rugScore: rug.score,
        notified: false
      });
      isNew = true;
    } else {
      seenEntry.lastCheck = now;
      seenEntry.rugScore = rug.score;
    }
    
    if (!seenEntry || !seenEntry.notified) {
      const msg = await buildMessage(t, rug, grade, dex24h);
      try {
        await axios.post(TG_API, {
          chat_id: CFG.tgChatId,
          message_thread_id: CFG.tgThreadId,
          text: msg,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        }, { timeout: 10000 });
        totalNotified++;
        SEEN.get(t.address).notified = true;
        logTrackingEvent({ type: 'NOTIFIED', ca: t.address, symbol: t.symbol, rugScore: rug.score, grade: grade });
        log('✓ Sent: ' + t.symbol + ' (Rug: ' + rug.score + ', Grade: ' + grade + ')');
      } catch (e) {
        log('TG error for ' + t.symbol + ': ' + e.message);
      }
    }
    
    if (TRACKED.has(t.address)) {
      const tracked = TRACKED.get(t.address);
      const priceNow = Number(t.price || 0);
      for (let ti = 0; ti < TARGETS.length; ti++) {
        const tgt = TARGETS[ti];
        const pctGain = ((priceNow - tracked.entryPrice) / tracked.entryPrice) * 100;
        if (pctGain >= tgt && !tracked['hit_' + tgt]) {
          tracked['hit_' + tgt] = true;
          try {
            await axios.post(TG_API, {
              chat_id: CFG.tgChatId,
              message_thread_id: CFG.tgThreadId,
              text: '🎯 <b>' + t.symbol + '</b> hit <b>+' + tgt + '%</b> ($' + fmtPrice(priceNow) + ')',
              parse_mode: 'HTML'
            }, { timeout: 10000 });
            logTrackingEvent({ type: 'HIT_TARGET', ca: t.address, symbol: t.symbol, target: tgt, price: priceNow });
            log('🎯 Target hit: ' + t.symbol + ' +' + tgt + '%');
          } catch (e) {
            log('TG error for target ' + tgt + ' ' + t.symbol + ': ' + e.message);
          }
        }
      }
    }
  }
  
  saveSeen();
  savePositions();
}

function detectNarrative(name, symbol) {
  var s = (String(name) + ' ' + String(symbol)).toLowerCase();
  var cat = [];
  var tag = [];

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
  if (rug.topDangers && rug.topDangers.length > 0) {
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
  if (rug.riskLevel) msg += ' | ' + rug.riskLevel;
  if (rug.tokenType && rug.tokenType !== 'unknown' && rug.tokenType !== 'Unknown') msg += ' | ' + rug.tokenType;
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
