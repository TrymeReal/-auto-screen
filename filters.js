// ─────────────────────────────────────────────
//  NEW MIGRATION GATES — pure filter functions
// ─────────────────────────────────────────────
// GMGN percentages come as decimals (0.10 = 10%),
// but config thresholds are in whole percentages (10 = 10%).

function asPct(rate) {
  var n = Number(rate);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n : n * 100;
}

function toUnixMillis(value) {
  var n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n < 1e12 ? n * 1000 : n);
}

function toUnixSeconds(value) {
  var n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n >= 1e12 ? n / 1000 : n);
}

function getSwingKlinePlans(ageHours) {
  var intraday = [
    { resolution: '4h', label: '4H', intervalSec: 4 * 3600, lookbackSec: 7 * 86400 },
    { resolution: '1h', label: '1H', intervalSec: 3600, lookbackSec: 3 * 86400 },
  ];
  if (Number(ageHours) < 72) return intraday;
  return [
    { resolution: '1d', label: '1D', intervalSec: 86400, lookbackSec: 7 * 86400 },
    ...intraday,
  ];
}

function checkDevHoldRate(rate, maxDevHold) {
  if (rate == null) return { skip: false, reason: '' };
  var pct = asPct(rate);
  if (pct > maxDevHold) {
    return { skip: true, reason: 'Creator hold ' + pct.toFixed(0) + '% > ' + maxDevHold + '%' };
  }
  return { skip: false, reason: '' };
}

function checkPriceChange1h(change, maxChange) {
  if (change == null || maxChange == null) return { skip: false, reason: '' };
  var pct = Number(change);
  if (!Number.isFinite(pct)) return { skip: false, reason: '' };
  if (pct > maxChange) {
    return { skip: true, reason: 'Harga sudah naik ' + pct.toFixed(0) + '% dalam 1 jam (max ' + maxChange + '%)' };
  }
  return { skip: false, reason: '' };
}

function checkMinHolders(holderCount, minHolders) {
  if (holderCount == null || minHolders == null) return { skip: false, reason: '' };
  var count = Number(holderCount);
  if (!Number.isFinite(count)) return { skip: false, reason: '' };
  if (count < minHolders) {
    return { skip: true, reason: 'Holder terlalu sedikit (' + count + ' < ' + minHolders + ')' };
  }
  return { skip: false, reason: '' };
}

// Gate minimal jumlah KOL holder (renowned_count) — MANDIRI, tidak nempel
// di evaluateAppStyleMigration, supaya tetap jalan walau MIG_APP_FILTER_ENABLED
// = false (gate lain di app-style filter mati, tapi KOL tetap dicek).
// Fail-open kalau kolCount null (data tidak tersedia) — sama seperti
// checkMinHolders, data hilang tidak diam-diam mereject semua token.
function checkMinKolCount(kolCount, minKolCount) {
  if (kolCount == null || minKolCount == null) return { skip: false, reason: '' };
  var count = Number(kolCount);
  if (!Number.isFinite(count)) return { skip: false, reason: '' };
  if (count < minKolCount) {
    return { skip: true, reason: 'KOL holder terlalu sedikit (' + count + ' < ' + minKolCount + ')' };
  }
  return { skip: false, reason: '' };
}

function checkSniperRate(sniperRate, maxSniperPct) {
  if (sniperRate == null) return { skip: false, reason: '' };
  var pct = asPct(sniperRate);
  if (pct > maxSniperPct) {
    return { skip: true, reason: 'Sniper hold ' + pct.toFixed(0) + '% > ' + maxSniperPct + '%' };
  }
  return { skip: false, reason: '' };
}

function checkVolLpRatio(vol, lp, maxRatio) {
  if (!maxRatio || Number(maxRatio) <= 0) return { skip: false, reason: '' };
  var volume = Number(vol) || 0;
  var liquidity = Number(lp) || 0;
  if (liquidity <= 0) return { skip: false, reason: '' };
  var ratio = volume / liquidity;
  if (ratio > maxRatio) {
    return { skip: true, reason: 'Vol/LP ratio ' + ratio.toFixed(1) + 'x > ' + maxRatio + 'x (wash trading)' };
  }
  return { skip: false, reason: '' };
}

function checkRugRatio(rugRatio, maxScore) {
  if (rugRatio == null) {
    return { skip: true, reason: 'Rug ratio GMGN tidak tersedia (data hilang)' };
  }
  var score = asPct(rugRatio);
  if (score > maxScore) {
    return { skip: true, reason: 'Rug score ' + score.toFixed(0) + ' > ' + maxScore };
  }
  return { skip: false, reason: '' };
}

function checkInsiderRate(rate, maxInsiderPct) {
  if (!maxInsiderPct || Number(maxInsiderPct) <= 0) return { skip: false, reason: '' };
  if (rate == null) return { skip: false, reason: '' };
  var pct = asPct(rate);
  if (pct > maxInsiderPct) {
    return { skip: true, reason: 'Insider ' + pct.toFixed(0) + '% > ' + maxInsiderPct + '%' };
  }
  return { skip: false, reason: '' };
}

function nextConsecutiveConfirmation(previous, cycleId) {
  var currentCycle = Number(cycleId);
  var previousCycle = previous && Number(previous.lastCycle);
  var previousCount = previous && Number(previous.count);
  var isConsecutive = Number.isFinite(previousCycle) && previousCycle === currentCycle - 1;
  return {
    count: isConsecutive && Number.isFinite(previousCount) ? previousCount + 1 : 1,
    lastCycle: currentCycle,
  };
}

function checkPhishingRate(rate, maxPhishingPct) {
  if (rate == null) return { skip: false, reason: '' };
  var pct = asPct(rate);
  if (pct > maxPhishingPct) {
    return { skip: true, reason: 'Phishing ' + pct.toFixed(0) + '% > ' + maxPhishingPct + '%' };
  }
  return { skip: false, reason: '' };
}

// Cek minimal 1 social media terisi (Twitter/Telegram/Website). String kosong
// atau placeholder umum ('-', 'n/a', 'none') dianggap tidak ada.
function hasValidLink(v) {
  if (v == null) return false;
  var s = String(v).trim();
  if (s === '') return false;
  if (/^(-|n\/a|na|none|null)$/i.test(s)) return false;
  return true;
}

function checkHasSocial(token, requireSocial) {
  if (!requireSocial) return { skip: false, reason: '' };
  var t = token || {};
  var hasTwitter  = hasValidLink(t.twitter_username);
  var hasTelegram = hasValidLink(t.telegram);
  var hasWebsite  = hasValidLink(t.website);
  if (!hasTwitter && !hasTelegram && !hasWebsite) {
    return { skip: true, reason: 'Tidak ada social media (Twitter/Telegram/Website)' };
  }
  return { skip: false, reason: '' };
}

// Dipanggil tiap kali sebuah field hard-risk hilang (null/undefined) dari
// response GMGN. Sebelumnya field kosong diam-diam dianggap "0% risiko" alias
// otomatis lolos, tanpa jejak apapun di log. Sekarang minimal ada warning
// eksplisit lewat cfg.onMissingHardRiskData, jadi kalau API berubah field
// atau field ilang, itu keliatan — bukan silently pass tanpa jejak.
function warnMissingHardRiskField(fieldLabel, tokenAddress) {
  return fieldLabel + ' data hilang (token=' + (tokenAddress || '?') + ')';
}

function collectMigrationHardRiskReasons(token, cfg) {
  var t = token;
  var reasons = [];
  var missingDataWarnings = [];
  var addr = t && (t.address || t.token_address);

  if (t.bundler_rate == null) {
    missingDataWarnings.push(warnMissingHardRiskField('Bundler rate', addr));
  }
  var bundlerPct = asPct(t.bundler_rate || 0);
  if (bundlerPct > cfg.maxBundlerPct) {
    reasons.push('Bundler ' + bundlerPct.toFixed(0) + '% > ' + cfg.maxBundlerPct + '%');
  }

  if (t.top_10_holder_rate == null) {
    missingDataWarnings.push(warnMissingHardRiskField('Top10 holder rate', addr));
  }
  var top10 = asPct(t.top_10_holder_rate || 0);
  if (top10 > cfg.maxTop10Holders) {
    reasons.push('Top10 ' + top10.toFixed(0) + '% > ' + cfg.maxTop10Holders + '%');
  }

  if (t.dev_team_hold_rate == null) {
    missingDataWarnings.push(warnMissingHardRiskField('Dev hold rate', addr));
  }
  var devHold = checkDevHoldRate(t.dev_team_hold_rate, cfg.maxDevHold);
  if (devHold.skip) reasons.push(devHold.reason);

  if (t.top70_sniper_hold_rate == null) {
    missingDataWarnings.push(warnMissingHardRiskField('Sniper hold rate', addr));
  }
  var sniper = checkSniperRate(t.top70_sniper_hold_rate, cfg.maxSniperPct);
  if (sniper.skip) reasons.push(sniper.reason);

  var volLp = checkVolLpRatio(t.volume, t.liquidity, cfg.maxVolLpRatio);
  if (volLp.skip) reasons.push(volLp.reason);

  // t.rug_ratio (GMGN) pakai threshold TERPISAH dari cfg.maxRugScore, supaya
  // gak numpuk dengan skor RugCheck API asli (getRugCheck() di screen.js).
  // Dua sinyal beda sumber, dua threshold beda — sesuai niat awal comment ini,
  // sebelumnya kodenya masih salah pakai cfg.maxRugScore di sini juga.
  // rug_ratio SUDAH fail-closed dari awal (lihat checkRugRatio) — data hilang
  // di sini otomatis jadi reject reason, jadi gak perlu warning tambahan.
  var rug = checkRugRatio(t.rug_ratio, cfg.gmgnRugMaxRatio);
  if (rug.skip) reasons.push(rug.reason);

  if (t.suspected_insider_hold_rate == null) {
    missingDataWarnings.push(warnMissingHardRiskField('Insider hold rate', addr));
  }
  var insider = checkInsiderRate(t.suspected_insider_hold_rate, cfg.maxInsiderPct);
  if (insider.skip) reasons.push(insider.reason);

  var phishingRate =
    t.phishing_rate ??
    t.phishing_wallet_rate ??
    t.phishing_hold_rate ??
    t.phishing_holders_rate ??
    t.rat_trader_amount_rate ??
    t.entrapment_ratio;
  if (phishingRate == null) {
    missingDataWarnings.push(warnMissingHardRiskField('Phishing rate', addr));
  }
  var phishing = checkPhishingRate(phishingRate, cfg.maxPhishingPct);
  if (phishing.skip) reasons.push(phishing.reason);

  if (missingDataWarnings.length > 0 && cfg && typeof cfg.onMissingHardRiskData === 'function') {
    cfg.onMissingHardRiskData(missingDataWarnings, t);
  }

  return reasons;
}

function shouldSkipMigration(token, cfg) {
  var t = token || {};

  var totalTxn = Number(t.buys || 0) + Number(t.sells || 0);
  var buyPct = totalTxn > 0 ? (Number(t.buys || 0) / totalTxn) * 100 : 0;
  if (totalTxn > 0 && cfg && cfg.minBuyRatio != null && buyPct < cfg.minBuyRatio) {
    return { skip: true, reason: 'Buy ratio ' + buyPct.toFixed(0) + '% < ' + cfg.minBuyRatio + '%' };
  }

  if (cfg && cfg.minVol != null && (Number(t.volume) || 0) < cfg.minVol) {
    return { skip: true, reason: 'Volume $' + (Number(t.volume) || 0) + ' < $' + cfg.minVol };
  }

  if (cfg && cfg.minLp != null && (Number(t.liquidity) || 0) < cfg.minLp) {
    return { skip: true, reason: 'LP $' + (Number(t.liquidity) || 0) + ' < $' + cfg.minLp };
  }

  var reasons = collectMigrationHardRiskReasons(t, cfg || {});
  if (reasons.length > 0) return { skip: true, reason: reasons[0] };

  var priceChg = checkPriceChange1h(t.price_change_percent1h, cfg && cfg.maxPriceChange1h);
  if (priceChg.skip) return priceChg;

  var holders = checkMinHolders(t.holder_count, cfg && cfg.minHolders);
  if (holders.skip) return holders;

  return { skip: false, reason: '' };
}

function shouldSkipMigrationHardRisk(token, cfg) {
  var reasons = collectMigrationHardRiskReasons(token || {}, cfg || {});
  if (reasons.length > 0) return { skip: true, reason: reasons[0] };
  return { skip: false, reason: '' };
}

// ─────────────────────────────────────────────
//  NEW MIGRATION V2 — base gates
// ─────────────────────────────────────────────

function checkBaseLiquidity(lp, minLp) {
  var val = Number(lp) || 0;
  if (val < minLp) {
    return { skip: true, reason: 'LP $' + fmtNum(val) + ' < $' + minLp };
  }
  return { skip: false, reason: '' };
}

function checkBaseAgeHours(creationTimestamp, maxHours) {
  if (!creationTimestamp) {
    return { skip: true, reason: 'Tidak ada data creation time' };
  }
  if (maxHours == null || Number(maxHours) <= 0) {
    return { skip: false, reason: '' };
  }
  var ageHours = (Date.now() - Number(creationTimestamp) * 1000) / 3600000;
  if (!Number.isFinite(ageHours)) {
    return { skip: true, reason: 'Tidak ada data creation time' };
  }
  if (ageHours >= maxHours) {
    return { skip: true, reason: 'Token sudah ' + ageHours.toFixed(0) + 'j (max ' + maxHours + 'j)' };
  }
  return { skip: false, reason: '' };
}

function checkVol1h(vol1h, minVol1h) {
  var vol = Number(vol1h) || 0;
  if (vol < minVol1h) {
    return { skip: true, reason: 'Vol 1h $' + fmtNum(vol) + ' < $' + minVol1h };
  }
  return { skip: false, reason: '' };
}

function checkSwaps5m(swaps5m, minSwaps) {
  var swaps = Number(swaps5m) || 0;
  if (swaps < minSwaps) {
    return { skip: true, reason: 'Txns 5m ' + swaps + ' < ' + minSwaps };
  }
  return { skip: false, reason: '' };
}

function checkVol5m(vol5m, minVol5m) {
  var vol = Number(vol5m) || 0;
  if (vol < minVol5m) {
    return { skip: true, reason: 'Vol 5m $' + fmtNum(vol) + ' < $' + minVol5m };
  }
  return { skip: false, reason: '' };
}

function shouldSkipNewMigration(token, tokenInfo, cfg) {
  var t = token || {};
  var info = tokenInfo || {};
  var price = info.price || {};
  var c = cfg || {};

  var lp = checkBaseLiquidity(t.liquidity, c.minLp);
  if (lp.skip) return lp;

  var age = checkBaseAgeHours(t.creation_timestamp, c.maxAgeHours);
  if (age.skip) return age;

  var vol1h = checkVol1h(price.volume_1h, c.minVol1h);
  if (vol1h.skip) return vol1h;

  var swaps5m = checkSwaps5m(price.swaps_5m, c.minSwaps5m);
  if (swaps5m.skip) return swaps5m;

  var vol5m = checkVol5m(price.volume_5m, c.minVol5m);
  if (vol5m.skip) return vol5m;

  // — Gate yang sebelumnya cuma di-log ke console tapi tidak pernah benar-benar
  // menyaring token (maxBundlerPct, maxTop10Holders, maxDevHold, maxSniperPct,
  // maxVolLpRatio, maxInsiderPct via rug_ratio GMGN, phishing). Sekarang
  // benar-benar dijalankan lewat collectMigrationHardRiskReasons(). —
  var hardRisk = collectMigrationHardRiskReasons(t, c);
  if (hardRisk.length > 0) return { skip: true, reason: hardRisk[0] };

  // — Gate price change 1h (maxPriceChange1h) — sebelumnya juga cuma di-log —
  var priceChg = checkPriceChange1h(t.price_change_percent1h, c.maxPriceChange1h);
  if (priceChg.skip) return priceChg;

  // — Gate holder minimum (minHoldersMig) — sebelumnya juga cuma di-log —
  var holders = checkMinHolders(t.holder_count, c.minHoldersMig);
  if (holders.skip) return holders;

  // — Gate minimal KOL holder (minKolCount) — mandiri, selalu jalan terlepas
  // dari MIG_APP_FILTER_ENABLED —
  var kolRaw = t.renowned_count;
  var kolCheck = checkMinKolCount(kolRaw, c.minKolCount);
  if (kolCheck.skip) return kolCheck;

  // — Gate wajib minimal 1 social media (Twitter/Telegram/Website) —
  var social = checkHasSocial(t, c.requireSocial);
  if (social.skip) return social;

  return { skip: false, reason: '' };
}

function fmtNum(n) {
  if (!n || isNaN(n)) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return Number(n).toFixed(0);
}

// FIX (bug Kairos): d.topHolders.slice(0, 10).sum(pct) di screen.js dulu
// ikut menghitung akun AMM/pool (mis. Pump Fun AMM) sebagai "holder" biasa,
// jadi persentase top-10 ke-inflate. Contoh nyata: bot baca 34.47%, padahal
// 14.63% dari situ punya akun Pump Fun AMM — holder asli cuma ~21.42%.
// Fix: keluarkan akun bertipe AMM/LOCKER (berdasarkan d.knownAccounts dari
// response RugCheck) SEBELUM ambil 10 holder terbesar. CREATOR tetap ikut
// dihitung — dia tetap wallet yang bisa dump.
//
// knownAccounts dari RugCheck di-key by wallet OWNER address, formatnya:
//   { [ownerAddress]: { name: 'Pump Fun AMM', type: 'AMM' }, ... }
// Fallback ke h.address kalau suatu saat entry-nya di-key by token account
// address, bukan owner.
function calculateRugcheckTopHoldersPct(topHolders, knownAccounts) {
  if (!Array.isArray(topHolders)) return 0;

  const known = knownAccounts || {};
  const EXCLUDED_TYPES = new Set(['AMM', 'LOCKER']);

  const filtered = topHolders.filter(h => {
    const info = known[h.owner] || known[h.address];
    if (!info) return true; // holder biasa, tidak ada di knownAccounts
    return !EXCLUDED_TYPES.has(String(info.type || '').toUpperCase());
  });

  return filtered
    .slice() // jangan mutate array asli
    .sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0))
    .slice(0, 10)
    .reduce((sum, h) => sum + (Number(h.pct) || 0), 0);
}

// VERSI A -- RAW, TIDAK exclude AMM/LOCKER. Semua wallet di topHolders ikut
// di-ranking apa adanya (termasuk yang ke-label AMM/LOCKER oleh RugCheck),
// karena label type itu sendiri berasal dari RugCheck dan bisa saja tidak
// akurat / bisa dimanfaatkan dev untuk menyamarkan wallet asli sebagai
// "locker" atau "pool". Kalau Holder#1 raw > threshold, gate ini anggap itu
// tetap risiko konsentrasi supply nyata, apapun label yang menempel.
//
// Dipakai untuk gate "single wallet terlalu besar" yang independen dari
// gate top10 gabungan: token bisa saja top10-nya di bawah threshold tapi
// holder #1 sendirian pegang porsi besar (whale tunggal, risiko dump
// berbeda dari sekadar "supply nyebar ke 10 wallet menengah").
function getRankedRugcheckHolderPcts(topHolders, knownAccounts) {
  if (!Array.isArray(topHolders)) return [];

  return topHolders
    .slice()
    .sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0))
    .map(h => Number(h.pct) || 0);
}

// Gate top holder INDIVIDUAL (rank 1-4), bukan gabungan top10.
// limits = { holder1, holder2, holder3, holder4 } — masing-masing dalam
// PERSEN (mis. 15 = 15%). Kalau sebuah limit null/undefined, rank itu
// TIDAK dicek sama sekali (di-skip dari pengecekan). Fungsi ini sendiri
// tidak tahu soal default angka — itu diatur di screen.js (CFG.maxHolder*Pct
// / CFG.swingMaxHolder*Pct), yang defaultnya SUDAH angka aktif (bukan null)
// kalau var .env tidak di-set. limit jadi null di sini hanya kalau user
// sengaja set .env ke string kosong (mis. MAX_HOLDER_4_PCT=), yang berarti
// "matikan rank ini" secara eksplisit.
// Kembalikan reason string pada skip pertama yang match (rank 1 dicek duluan),
// atau { skip: false } kalau semua rank yang AKTIF lolos / datanya tidak cukup.
function checkIndividualTopHolders(rankedPcts, limits) {
  const l = limits || {};
  const ranks = [
    { idx: 0, label: 'Holder#1', limit: l.holder1 },
    { idx: 1, label: 'Holder#2', limit: l.holder2 },
    { idx: 2, label: 'Holder#3', limit: l.holder3 },
    { idx: 3, label: 'Holder#4', limit: l.holder4 },
  ];

  for (const r of ranks) {
    if (r.limit == null || !Number.isFinite(Number(r.limit))) continue; // rank ini di-skip (tidak diset di .env)
    const pct = Number(rankedPcts[r.idx]) || 0;
    if (pct > Number(r.limit)) {
      return { skip: true, reason: r.label + ' ' + pct.toFixed(1) + '% > ' + r.limit + '%' };
    }
  }
  return { skip: false, reason: '' };
}

function mergeRugcheckReports(report, summary) {
  const full = report && typeof report === 'object' ? report : {};
  const brief = summary && typeof summary === 'object' ? summary : {};
  const risksByName = new Map();

  for (const risk of [...(Array.isArray(full.risks) ? full.risks : []), ...(Array.isArray(brief.risks) ? brief.risks : [])]) {
    const name = String(risk?.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const previous = risksByName.get(key);
    if (!previous || Number(risk?.score || 0) > Number(previous?.score || 0)) risksByName.set(key, risk);
  }

  return {
    ...brief,
    ...full,
    score: Math.max(Number(full.score) || 0, Number(brief.score) || 0),
    score_normalised: Math.max(Number(full.score_normalised) || 0, Number(brief.score_normalised) || 0),
    risks: Array.from(risksByName.values()),
  };
}

function isPermanentRugcheckLock(seenEntry) {
  return String(seenEntry?.lockedReason || '').startsWith('rug_');
}

function isPermanentSafetyLock(seenEntry) {
  return isPermanentRugcheckLock(seenEntry) || String(seenEntry?.lockedReason || '') === 'dev_cluster';
}

// ─────────────────────────────────────────────
//  DEV REPUTATION — ported from PowerShell Get-GmgnDevReputation
// ─────────────────────────────────────────────
// Porting 1:1 dari `Get-GmgnDevReputation` (profile PS1, versi "PATCHED +
// fallback timestamp"). Sumber input SAMA PERSIS dengan yang dipakai screen.js
// untuk MIG mode: tokenInfo di sini = $info di PS1, keduanya hasil parse
// langsung `gmgn-cli token info --chain sol --address <ca> --raw` tanpa
// transformasi apapun (lihat fetchTokenInfo() di screen.js). Jadi
// tokenInfo.dev.* di JS = $info.dev.* di PS1, field-per-field identik.
//
// PS1 murni tool tampilan manual (gmgn $ca -> print doang, tidak ada
// reject/skip). Di sini fungsi ini TETAP murni menghasilkan profile object
// (skor + status), TIDAK memutuskan skip sendiri -- keputusan skip/pass ada
// di caller (screen.js), lihat shouldSkipDevReputation() di bawah.

// Porting `ConvertTo-GmgnFiniteNumber($value, [double]$default = 0.0)`.
function convertToGmgnFiniteNumber(value, defaultVal) {
  var def = defaultVal == null ? 0.0 : defaultVal;
  if (value == null || (typeof value === 'string' && value.trim() === '')) return def;
  var n = Number(value);
  if (!Number.isFinite(n)) return def;
  return n;
}

// Porting `Test-GmgnTrue($value)`.
function testGmgnTrue(value) {
  if (typeof value === 'boolean') return value;
  var text = String(value == null ? '' : value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
}

// Default cfg dev-reputation — dipakai kalau caller tidak mengoper cfg sama
// sekali (mis. pemanggilan lama/test lain), supaya fungsi ini tidak pernah
// crash karena cfg.xxx undefined. screen.js akan mengoper cfg.devReputation*
// dari CFG (baca .env), TIDAK memakai default di bawah ini secara diam-diam
// — lihat CFG.devReputation di screen.js untuk nilai default .env yang
// sesungguhnya dipakai kalau env var tidak diisi.
var DEV_REPUTATION_DEFAULT_CFG = {
  minSample: 10,           // DEV_REPUTATION_MIN_SAMPLE — breakpoint Confidence HIGH
  maxDeadFailedPct: 70,    // DEV_REPUTATION_MAX_DEAD_FAILED_PCT — dalam skala PERSEN (0-100), bukan desimal
  minInnerFail: 50,        // DEV_REPUTATION_MIN_INNER_FAIL
  minSerialLaunches: 20,   // DEV_REPUTATION_MIN_SERIAL_LAUNCHES
  maxScore: 15,            // DEV_REPUTATION_MAX_SCORE — breakpoint BAD REPUTATION
  securityScanEnabled: true, // DEV_REPUTATION_SECURITY_SCAN_ENABLED — kode asli tidak punya saklar, jadi selalu true
  // DEV_REPUTATION_MIN_LOGO_REUSE — BUKAN bagian dari 9 var asli, ditambahkan
  // belakangan atas permintaan eksplisit. Sebelumnya hardcode >= 2 di dua
  // tempat (reason text + hardRisk flag), sekarang satu sumber lewat cfg ini.
  // Dipakai sebagai PERBANDINGAN >= (default 2 = reuse logo minimal 2x baru
  // dianggap indikasi). TIDAK mengubah formula skor (reskin penalty di
  // formula tetap pakai (LogoReuse-1)/4.0 mentah, itu bobot skor kontinu,
  // beda dari threshold on/off reason & hardRisk ini).
  minLogoReuse: 2,
};

// Porting badan utama `Get-GmgnDevReputation($info)`.
// tokenInfo: hasil fetchTokenInfo() (= $info di PS1). Harus punya tokenInfo.dev.
// execFn: fungsi exec sinkron dengan tanda tangan (cmd) -> stdout string, timeout
//   dan error ditangani oleh caller lewat try/catch (samakan pola execSync di
//   screen.js). Di-inject supaya filters.js tetap tidak punya dependency
//   langsung ke child_process (semua fungsi lain di file ini pure).
// cfg (opsional): { minSample, maxDeadFailedPct, minInnerFail, minSerialLaunches,
//   maxScore, securityScanEnabled, minLogoReuse }. maxDeadFailedPct dalam PERSEN
//   (mis. 70 = 70%), bukan desimal — fungsi ini yang membagi /100 secara
//   internal supaya perbandingan ke RugRate (desimal 0-1) tetap benar. Field
//   yang tidak diisi jatuh ke DEV_REPUTATION_DEFAULT_CFG di atas.
//
// PENTING: formula skor (bobot 0.25/0.55/0.3/0.15, athTrack, threshold
// liquidity mati $4000, ATH-crash 0.05, status boundary Score<35/<60, sample
// floor <3) SENGAJA TIDAK dibuat configurable di sini — itu di luar 9 nama
// variabel yang sudah ada padanan .env-nya. Kalau itu juga mau dibikin
// configurable, itu perubahan terpisah.
// Return: profile object (lihat shape di bawah) atau null kalau
//   tokenInfo.dev.creator_address tidak ada (persis kondisi PS1 `return $null`).
function getGmgnDevReputation(tokenInfo, execFn, cfg) {
  var c = Object.assign({}, DEV_REPUTATION_DEFAULT_CFG, cfg || {});
  var info = tokenInfo || {};
  var dev = info.dev;
  if (!dev || !dev.creator_address) return null;

  var wallet = String(dev.creator_address);
  var profile = {
    Wallet: wallet,
    Score: 50,
    Status: 'UNKNOWN',
    Confidence: 'LOW',
    Analyzed: 0,
    Alive: 0,
    Rugged: 0,
    RugRate: null,
    Survival: null,
    GraduationRate: null,
    InnerCount: 0,
    Launches: Math.trunc(convertToGmgnFiniteNumber(dev.creator_open_count, 0.0)),
    AthMc: dev.ath_token_info ? convertToGmgnFiniteNumber(dev.ath_token_info.ath_mc, 0.0) : 0.0,
    LogoReuse: 0,
    LogoDataAvailable: false,
    SecurityBad: 0,
    SecuritySeen: 0,
    Exited: false,
    Cto: testGmgnTrue(dev.cto_flag),
    Reasons: [],
    DataSource: 'token info fallback',
  };

  var status = dev.creator_token_status == null ? '' : String(dev.creator_token_status);
  var balance = convertToGmgnFiniteNumber(dev.creator_token_balance, 0.0);
  profile.Exited = balance <= 0 && status === 'sell';

  try {
    var raw = execFn(
      'npx gmgn-cli portfolio created-tokens --chain sol --wallet ' + wallet + ' --raw'
    );
    if (raw) {
      var response = JSON.parse(raw);
      var body = response && response.data ? response.data : response;
      var tokens = [];
      if (body && Array.isArray(body.tokens)) tokens = body.tokens.slice();
      else if (Array.isArray(body)) tokens = body.slice();
      else if (Array.isArray(response)) tokens = response.slice();

      profile.DataSource = 'GMGN created-tokens';
      var innerC = convertToGmgnFiniteNumber(body ? body.inner_count : null, 0.0);
      var openC = convertToGmgnFiniteNumber(body ? body.open_count : null, 0.0);
      if (body && (body.inner_count != null || body.open_count != null)) {
        profile.Launches = Math.trunc(innerC + openC);
      }
      if (body && body.inner_count != null) profile.InnerCount = Math.trunc(innerC);
      if (body && body.creator_ath_info && body.creator_ath_info.ath_mc) {
        profile.AthMc = convertToGmgnFiniteNumber(body.creator_ath_info.ath_mc, 0.0);
      }

      if (tokens.length > 0) {
        var dead = tokens.filter(function (tk) {
          var liq = convertToGmgnFiniteNumber(tk.pool_liquidity, 0.0);
          var tokAthMc = convertToGmgnFiniteNumber(tk.token_ath_mc, 0.0);
          var tokCurMc = convertToGmgnFiniteNumber(tk.market_cap, 0.0);
          return liq < 4000 || (tokAthMc > 0 && tokCurMc / tokAthMc < 0.05);
        }).length;
        profile.Analyzed = tokens.length;
        profile.Alive = tokens.length - dead;
        profile.Rugged = dead;
        profile.RugRate = profile.Rugged / tokens.length;
        profile.Survival = profile.Alive / tokens.length;

        var graduated = tokens.filter(function (tk) { return testGmgnTrue(tk.is_open); }).length;
        profile.GraduationRate = graduated / tokens.length;

        var logos = tokens.map(function (tk) { return tk.logo; }).filter(function (l) { return l; });
        if (logos.length > 0) {
          var uniqueLogos = new Set(logos).size;
          profile.LogoReuse = Math.max(0, logos.length - uniqueLogos);
          profile.LogoDataAvailable = true;
        }

        var recent = tokens
          .slice()
          .sort(function (a, b) {
            var ta = a.create_timestamp != null ? convertToGmgnFiniteNumber(a.create_timestamp, 0.0)
              : a.created_timestamp != null ? convertToGmgnFiniteNumber(a.created_timestamp, 0.0) : 0;
            var tb = b.create_timestamp != null ? convertToGmgnFiniteNumber(b.create_timestamp, 0.0)
              : b.created_timestamp != null ? convertToGmgnFiniteNumber(b.created_timestamp, 0.0) : 0;
            return tb - ta; // descending
          })
          .slice(0, 3);

        // DEV_REPUTATION_SECURITY_SCAN_ENABLED — kode asli tidak punya saklar
        // (selalu jalan), sekarang bisa dimatikan lewat cfg.securityScanEnabled.
        // Kalau dimatikan: profile.SecuritySeen/SecurityBad tetap 0 (default
        // awal), jadi cabang skor `if (profile.SecuritySeen > 0)` di bawah
        // otomatis di-skip juga — perilakunya sama seperti dev ini tidak
        // pernah discan, bukan "dianggap aman" secara eksplisit.
        if (c.securityScanEnabled) {
          for (var i = 0; i < recent.length; i++) {
            var token = recent[i];
            var tokenAddress = token.token_address ? token.token_address : token.address;
            if (!tokenAddress) continue;
            try {
              var secOut = execFn('npx gmgn-cli token security --chain sol --address ' + tokenAddress);
              var tokenSec = JSON.parse(secOut);
              profile.SecuritySeen++;
              if (
                tokenSec.is_honeypot === true ||
                tokenSec.renounced_mint !== true ||
                tokenSec.renounced_freeze_account !== true
              ) {
                profile.SecurityBad++;
              }
            } catch (eSec) {
              // sesuai PS1: try/catch kosong, gagal per-token diabaikan diam-diam
            }
          }
        }
      } else if (body && body.open_ratio != null) {
        var ratio = convertToGmgnFiniteNumber(body.open_ratio, 0.0);
        if (ratio > 1) ratio = ratio / 100;
        profile.GraduationRate = Math.max(0.0, Math.min(1.0, ratio));
        profile.Survival = profile.GraduationRate;
        profile.RugRate = 1.0 - profile.Survival;
      }
    }
  } catch (eOuter) {
    // sesuai PS1: try/catch terluar kosong, gagal fetch created-tokens diabaikan
    // diam-diam -> profile jatuh ke default awal ('token info fallback')
  }

  var athTrack = (Math.log10(Math.max(1.0, profile.AthMc)) - 5.0) / 2.0;
  athTrack = Math.max(0.0, Math.min(1.0, athTrack));

  var score;
  if (profile.Survival != null) {
    score = 0.25 + 0.55 * profile.Survival;
    var innerPenalty = (profile.InnerCount - c.minInnerFail) / 950.0;
    innerPenalty = Math.max(0.0, Math.min(1.0, innerPenalty));
    score -= 0.3 * innerPenalty;
    score += 0.15 * athTrack * profile.Survival;
  } else {
    var serial = (profile.Launches - c.minSerialLaunches) / 180.0;
    serial = Math.max(0.0, Math.min(1.0, serial));
    score = 0.3 + 0.55 * athTrack * (1 - 0.7 * serial) - 0.2 * serial;
  }

  if (profile.SecuritySeen > 0) {
    score -= 0.35 * (profile.SecurityBad / profile.SecuritySeen);
  }
  if (profile.LogoDataAvailable) {
    var reskin = (profile.LogoReuse - 1) / 4.0;
    reskin = Math.max(0.0, Math.min(1.0, reskin));
    score -= 0.2 * reskin;
  }
  if (profile.Exited) score -= 0.1;
  if (profile.Cto) score += 0.05;
  if (!Number.isFinite(score)) {
    score = profile.Survival != null ? 0.25 + 0.55 * profile.Survival : 0.5;
  }
  score = Math.max(0.0, Math.min(1.0, score));
  profile.Score = Math.round(score * 100);

  // maxDeadFailedPct di cfg dalam skala PERSEN (mis. 70 = 70%), sedangkan
  // profile.RugRate desimal (0-1) — dibagi /100 di titik pembandingan ini
  // supaya "70" di .env beneran berarti 70%, bukan 7000%.
  var maxDeadFailedRatio = c.maxDeadFailedPct / 100;

  var reasons = [];
  if (profile.RugRate != null && profile.RugRate >= maxDeadFailedRatio) reasons.push('dead/failed rate tinggi');
  if (profile.InnerCount > c.minInnerFail) reasons.push('internal market gagal ' + profile.InnerCount + 'x');
  if (profile.SecurityBad > 0) reasons.push('token lama tidak aman ' + profile.SecurityBad + '/' + profile.SecuritySeen);
  if (profile.LogoDataAvailable && profile.LogoReuse >= c.minLogoReuse) reasons.push('reskin/logo reuse ' + profile.LogoReuse + 'x');
  if (profile.Launches > c.minSerialLaunches) reasons.push('serial creator ' + profile.Launches + ' launch');
  if (profile.Exited) reasons.push('dev sudah exit token ini');
  profile.Reasons = reasons;

  var sampleSize = profile.Analyzed > 0 ? profile.Analyzed : profile.Launches;
  profile.Confidence = sampleSize >= c.minSample ? 'HIGH' : sampleSize >= 3 ? 'MEDIUM' : 'LOW';

  var hardRisk =
    profile.SecurityBad > 0 ||
    (profile.RugRate != null && profile.RugRate >= maxDeadFailedRatio) ||
    profile.InnerCount > c.minInnerFail ||
    (profile.LogoDataAvailable && profile.LogoReuse >= c.minLogoReuse);

  if (sampleSize < 3 && !hardRisk) {
    profile.Status = 'NEW DEV / DATA MINIM';
  } else if (profile.Score < c.maxScore) {
    profile.Status = 'BAD REPUTATION';
  } else if (profile.Score < 35 || hardRisk) {
    profile.Status = 'HIGH RISK';
  } else if (profile.Score < 60) {
    profile.Status = 'MIXED/UNKNOWN';
  } else {
    profile.Status = 'GOOD HISTORY';
  }

  return profile;
}

// Gate untuk MIG mode: skip token kalau Status = 'BAD REPUTATION' atau
// 'HIGH RISK' (pola sama seperti PS1 -- devColor merah untuk kedua status
// itu). Bukan bagian dari PS1 (PS1 gak punya skip), tapi keputusan skip
// eksplisit sesuai jawaban: "Skip kalau Status = BAD REPUTATION/HIGH RISK".
function shouldSkipDevReputation(profile) {
  if (!profile) return { skip: false, reason: '' };
  if (profile.Status === 'BAD REPUTATION' || profile.Status === 'HIGH RISK') {
    return {
      skip: true,
      reason: 'Dev reputation ' + profile.Status + ' (score=' + profile.Score + '/100, confidence=' + profile.Confidence + ')',
    };
  }
  return { skip: false, reason: '' };
}

// ─────────────────────────────────────────────
//  APP-STYLE MIGRATION FILTER (soft-score gate, MIG mode)
// ─────────────────────────────────────────────
// SEBELUMNYA: fungsi ini di-import di screen.js (`const { ..., evaluateAppStyleMigration }
// = require('./filters')`) tapi TIDAK PERNAH didefinisikan di file ini maupun di-export.
// Akibatnya evaluateAppStyleMigration di screen.js selalu `undefined`, dan begitu ada
// token New Migration yang lolos sampai ke gate ini (MIG_APP_FILTER_ENABLED default ON),
// screen.js crash "evaluateAppStyleMigration is not a function" — loop MIG TIDAK dibungkus
// try/catch per-token, jadi exception ini nembus sampai keluar processTokens() dan
// menghentikan SISA cycle (termasuk Swing 1D & Signal yang jalan setelah loop MIG).
//
// Implementasi di bawah ini BARU ditulis sekarang (bukan restore kode lama yang hilang —
// fungsi ini memang belum pernah ada), disusun mengikuti kontrak pemanggilan yang sudah
// ada di screen.js baris ~2329-2344: parameter opts (maxBuyTaxPct, maxSellTaxPct,
// maxBotDegenPct, minSmartMoneyConfluence, maxCreatorTokens, momentumReject1h,
// momentumReject5m, buyRatioReject, buyRatioPass, minConviction, minPriority) dan bentuk
// return { skip, reason, verdict, conviction, priority }.
//
// CATATAN PENTING (perlu diverifikasi manual terhadap output nyata `gmgn-cli token info
// --raw`): field buy_tax/sell_tax/bot_degen_rate/smart_degen_count DIASUMSIKAN ada di
// tokenInfo (atau token trenches `t`) dengan nama-nama umum GMGN. Kalau field itu ternyata
// tidak ada / beda nama di response asli, sub-check terkait otomatis fail-open (di-skip,
// tidak menolak token) — sama seperti pola fail-open di checkDevHoldRate/checkSniperRate
// dkk di atas — supaya data hilang tidak diam-diam mereject semua token, tapi juga tidak
// bikin gate ini "buta". Kalau nanti ternyata field-nya memang ada dengan nama beda, tinggal
// sesuaikan bagian pembacaan field (bagian atas fungsi), logika skip/scoring-nya tidak perlu
// diubah.
//
// momentumReject1h/momentumReject5m/buyRatioReject/buyRatioPass di opts memakai skala
// DESIMAL (mis. -0.12 = -12%, 0.5 = 50%) — beda dari kebanyakan gate lain di file ini yang
// pakai skala PERSEN. Konversi dilakukan di dalam fungsi ini supaya pemanggil di screen.js
// tidak perlu berubah.
function evaluateAppStyleMigration(token, tokenInfo, devEvalScore, opts) {
  var t = token || {};
  var info = tokenInfo || {};
  var price = info.price || {};
  var o = opts || {};
  var reasons = [];

  // — Buy/Sell tax (kalau field tidak ada di tokenInfo, skip sub-check ini, fail-open) —
  var buyTaxPct = info.buy_tax != null ? asPct(info.buy_tax) : null;
  if (buyTaxPct != null && o.maxBuyTaxPct != null && buyTaxPct > o.maxBuyTaxPct) {
    reasons.push('Buy tax ' + buyTaxPct.toFixed(1) + '% > ' + o.maxBuyTaxPct + '%');
  }
  var sellTaxPct = info.sell_tax != null ? asPct(info.sell_tax) : null;
  if (sellTaxPct != null && o.maxSellTaxPct != null && sellTaxPct > o.maxSellTaxPct) {
    reasons.push('Sell tax ' + sellTaxPct.toFixed(1) + '% > ' + o.maxSellTaxPct + '%');
  }

  // — Bot degen rate (fail-open kalau data tidak tersedia untuk token MIG) —
  var botRaw = t.bot_degen_rate != null ? t.bot_degen_rate : info.bot_degen_rate;
  var botPct = botRaw != null ? asPct(botRaw) : null;
  if (botPct != null && o.maxBotDegenPct != null && botPct > o.maxBotDegenPct) {
    reasons.push('Bot degen ' + botPct.toFixed(1) + '% > ' + o.maxBotDegenPct + '%');
  }

  // — Smart money confluence (fail-open kalau data tidak tersedia) —
  var smRaw = t.smart_degen_count != null ? t.smart_degen_count : info.smart_degen_count;
  var smCount = smRaw != null ? Number(smRaw) : null;
  if (smCount != null && o.minSmartMoneyConfluence != null && smCount < o.minSmartMoneyConfluence) {
    reasons.push('Smart money wallet ' + smCount + ' < ' + o.minSmartMoneyConfluence);
  }

  // — Serial creator (maxCreatorTokens), sumber sama dengan getGmgnDevReputation —
  var creatorTokens = info.dev && info.dev.creator_open_count != null
    ? Number(info.dev.creator_open_count) : null;
  if (creatorTokens != null && o.maxCreatorTokens != null && creatorTokens > o.maxCreatorTokens) {
    reasons.push('Creator sudah launch ' + creatorTokens + ' token > ' + o.maxCreatorTokens);
  }

  // — Momentum reject 1h/5m — t.price_change_percent1h dkk sudah dalam skala PERSEN
  // (sama seperti dipakai checkPriceChange1h), dikonversi ke desimal di sini supaya
  // sebanding dengan opts.momentumReject1h/5m yang desimal.
  var chg1hPct = t.price_change_percent1h != null ? Number(t.price_change_percent1h)
    : (price.price_change_percent1h != null ? Number(price.price_change_percent1h) : null);
  var chg1hDec = (chg1hPct != null && Number.isFinite(chg1hPct)) ? chg1hPct / 100 : null;
  if (chg1hDec != null && o.momentumReject1h != null && chg1hDec < o.momentumReject1h) {
    reasons.push('Momentum 1h ' + chg1hPct.toFixed(1) + '% (reject < ' + (o.momentumReject1h * 100).toFixed(0) + '%)');
  }

  var chg5mPct = price.price_change_percent5m != null ? Number(price.price_change_percent5m)
    : (t.price_change_percent5m != null ? Number(t.price_change_percent5m) : null);
  var chg5mDec = (chg5mPct != null && Number.isFinite(chg5mPct)) ? chg5mPct / 100 : null;
  if (chg5mDec != null && o.momentumReject5m != null && chg5mDec < o.momentumReject5m) {
    reasons.push('Momentum 5m ' + chg5mPct.toFixed(1) + '% (reject < ' + (o.momentumReject5m * 100).toFixed(0) + '%)');
  }

  // — Buy ratio keras: di bawah buyRatioReject langsung tolak. Antara buyRatioReject
  // dan buyRatioPass tidak ditolak tapi menurunkan conviction (lihat scoring di bawah) —
  var totalTxn = Number(t.buys || 0) + Number(t.sells || 0);
  var buyRatioDec = totalTxn > 0 ? Number(t.buys || 0) / totalTxn : null;
  if (buyRatioDec != null && o.buyRatioReject != null && buyRatioDec < o.buyRatioReject) {
    reasons.push('Buy ratio ' + (buyRatioDec * 100).toFixed(0) + '% < ' + (o.buyRatioReject * 100).toFixed(0) + '%');
  }

  if (reasons.length > 0) {
    return { skip: true, reason: reasons[0], verdict: 'REJECT', conviction: 0, priority: 0 };
  }

  // — Scoring: gabungkan dev reputation (devEvalScore, 0-1) dengan sinyal momentum/buy
  // ratio/smart money/bot jadi satu skor conviction (0-1) -> priority (0-100). Ini soft
  // score, BUKAN gate keras (gate keras sudah selesai di atas) —
  var conviction = Number.isFinite(devEvalScore) ? devEvalScore : 0.5;
  var buyRatioPassThreshold = o.buyRatioPass != null ? o.buyRatioPass : 0.5;
  if (buyRatioDec != null) {
    conviction += buyRatioDec >= buyRatioPassThreshold ? 0.15 : -0.05;
  }
  if (chg1hDec != null && chg1hDec > 0) {
    conviction += Math.min(chg1hDec, 0.2) * 0.5;
  }
  if (smCount != null) {
    conviction += Math.min(smCount, 5) * 0.03;
  }
  if (botPct != null) {
    conviction -= (Math.min(botPct, 50) / 100) * 0.3;
  }
  conviction = Math.max(0, Math.min(1, conviction));
  var priority = Math.round(conviction * 100);

  var minConviction = o.minConviction != null ? o.minConviction : 0;
  var minPriority = o.minPriority != null ? o.minPriority : 0;
  if (conviction < minConviction) {
    return {
      skip: true, reason: 'Conviction ' + conviction.toFixed(2) + ' < ' + minConviction,
      verdict: 'LOW_CONVICTION', conviction, priority,
    };
  }
  if (priority < minPriority) {
    return {
      skip: true, reason: 'Priority ' + priority + ' < ' + minPriority,
      verdict: 'LOW_PRIORITY', conviction, priority,
    };
  }

  return { skip: false, reason: '', verdict: 'PASS', conviction, priority };
}

module.exports = {
  asPct,
  toUnixMillis,
  toUnixSeconds,
  getSwingKlinePlans,
  checkDevHoldRate,
  checkPriceChange1h,
  checkMinHolders,
  checkMinKolCount,
  checkSniperRate,
  checkVolLpRatio,
  checkRugRatio,
  nextConsecutiveConfirmation,
  checkInsiderRate,
  checkPhishingRate,
  checkHasSocial,
  shouldSkipMigration,
  collectMigrationHardRiskReasons,
  shouldSkipMigrationHardRisk,
  checkBaseAgeHours,
  checkBaseLiquidity,
  checkVol1h,
  checkSwaps5m,
  checkVol5m,
  shouldSkipNewMigration,
  calculateRugcheckTopHoldersPct,
  getRankedRugcheckHolderPcts,
  checkIndividualTopHolders,
  mergeRugcheckReports,
  isPermanentRugcheckLock,
  isPermanentSafetyLock,
  convertToGmgnFiniteNumber,
  testGmgnTrue,
  getGmgnDevReputation,
  shouldSkipDevReputation,
  evaluateAppStyleMigration,
};
