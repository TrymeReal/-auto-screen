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

module.exports = {
  checkDevHoldRate,
  checkSniperRate,
  checkVolLpRatio,
  checkRugRatio,
  checkInsiderRate,
  checkPhishingRate,
  collectMigrationHardRiskReasons,
  checkBaseLiquidity,
  checkVol1h,
  checkSwaps5m,
  checkVol5m,
};
