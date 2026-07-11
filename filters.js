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
  if (rugRatio == null) return { skip: false, reason: '' };
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

function checkPhishingRate(rate, maxPhishingPct) {
  if (rate == null) return { skip: false, reason: '' };
  var pct = asPct(rate);
  if (pct > maxPhishingPct) {
    return { skip: true, reason: 'Phishing ' + pct.toFixed(0) + '% > ' + maxPhishingPct + '%' };
  }
  return { skip: false, reason: '' };
}

function collectMigrationHardRiskReasons(token, cfg) {
  var t = token;
  var reasons = [];

  var bundlerPct = asPct(t.bundler_rate || 0);
  if (bundlerPct > cfg.maxBundlerPct) {
    reasons.push('Bundler ' + bundlerPct.toFixed(0) + '% > ' + cfg.maxBundlerPct + '%');
  }

  var top10 = asPct(t.top_10_holder_rate || 0);
  if (top10 > cfg.maxTop10Holders) {
    reasons.push('Top10 ' + top10.toFixed(0) + '% > ' + cfg.maxTop10Holders + '%');
  }

  var devHold = checkDevHoldRate(t.dev_team_hold_rate, cfg.maxDevHold);
  if (devHold.skip) reasons.push(devHold.reason);

  var sniper = checkSniperRate(t.top70_sniper_hold_rate, cfg.maxSniperPct);
  if (sniper.skip) reasons.push(sniper.reason);

  var volLp = checkVolLpRatio(t.volume, t.liquidity, cfg.maxVolLpRatio);
  if (volLp.skip) reasons.push(volLp.reason);

  var rug = checkRugRatio(t.rug_ratio, cfg.maxRugScore);
  if (rug.skip) reasons.push(rug.reason);

  var insider = checkInsiderRate(t.suspected_insider_hold_rate, cfg.maxInsiderPct);
  if (insider.skip) reasons.push(insider.reason);

  var phishingRate =
    t.phishing_rate ??
    t.phishing_wallet_rate ??
    t.phishing_hold_rate ??
    t.phishing_holders_rate ??
    t.rat_trader_amount_rate ??
    t.entrapment_ratio;
  var phishing = checkPhishingRate(phishingRate, cfg.maxPhishingPct);
  if (phishing.skip) reasons.push(phishing.reason);

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

function fmtNum(n) {
  if (!n || isNaN(n)) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return Number(n).toFixed(0);
}

function shouldSkipNewMigration(token, tokenInfo, cfg) {
  var t = token || {};
  var info = tokenInfo || {};
  var price = info.price || {};

  var lp = checkBaseLiquidity(t.liquidity, cfg && cfg.minLp);
  if (lp.skip) return lp;

  var age = checkBaseAgeHours(t.creation_timestamp, cfg && cfg.maxAgeHours);
  if (age.skip) return age;

  var vol1h = checkVol1h(price.volume_1h, cfg && cfg.minVol1h);
  if (vol1h.skip) return vol1h;

  var swaps5m = checkSwaps5m(price.swaps_5m, cfg && cfg.minSwaps5m);
  if (swaps5m.skip) return swaps5m;

  var vol5m = checkVol5m(price.volume_5m, cfg && cfg.minVol5m);
  if (vol5m.skip) return vol5m;

  return { skip: false, reason: '' };
}

module.exports = {
  checkDevHoldRate,
  checkPriceChange1h,
  checkMinHolders,
  checkSniperRate,
  checkVolLpRatio,
  checkRugRatio,
  checkInsiderRate,
  checkPhishingRate,
  shouldSkipMigration,
  collectMigrationHardRiskReasons,
  shouldSkipMigrationHardRisk,
  checkBaseLiquidity,
  checkBaseAgeHours,
  checkVol1h,
  checkSwaps5m,
  checkVol5m,
  shouldSkipNewMigration,
};
