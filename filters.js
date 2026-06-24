// ─────────────────────────────────────────────
//  NEW MIGRATION GATES — pure filter functions
// ─────────────────────────────────────────────
// GMGN percentages come as decimals (0.10 = 10%),
// but config thresholds are in whole percentages (10 = 10%).

function checkDevHoldRate(rate, maxDevHold) {
  if (rate == null) return { skip: false, reason: '' };
  var pct = Number(rate) * 100;
  if (pct > maxDevHold) {
    return { skip: true, reason: 'Creator hold ' + pct.toFixed(0) + '% > ' + maxDevHold + '%' };
  }
  return { skip: false, reason: '' };
}

function checkPriceChange1h(change, maxChange) {
  if (change == null) return { skip: false, reason: '' };
  var pct = Number(change);
  if (pct > maxChange) {
    return { skip: true, reason: 'Harga sudah naik ' + pct.toFixed(0) + '% dalam 1 jam (max ' + maxChange + '%)' };
  }
  return { skip: false, reason: '' };
}

function checkMinHolders(holderCount, minHolders) {
  if (holderCount == null) return { skip: false, reason: '' };
  var count = Number(holderCount);
  if (count < minHolders) {
    return { skip: true, reason: 'Holder terlalu sedikit (' + count + ' < ' + minHolders + ')' };
  }
  return { skip: false, reason: '' };
}

function checkSniperRate(sniperRate, maxSniperPct) {
  if (sniperRate == null) return { skip: false, reason: '' };
  var pct = Number(sniperRate) * 100;
  if (pct > maxSniperPct) {
    return { skip: true, reason: 'Sniper hold ' + pct.toFixed(0) + '% > ' + maxSniperPct + '%' };
  }
  return { skip: false, reason: '' };
}

// Combined gate: checks ALL migration filters in sequence.
// Returns first failing gate, or { skip: false } if all pass.
function shouldSkipMigration(token, cfg) {
  var t = token;

  var buyPct = 0;
  var totalTxn = (t.buys || 0) + (t.sells || 0);
  if (totalTxn > 0) buyPct = (t.buys / totalTxn) * 100;
  if (totalTxn > 0 && buyPct < cfg.minBuyRatio) {
    return { skip: true, reason: 'Buy ratio ' + buyPct.toFixed(0) + '% < ' + cfg.minBuyRatio + '%' };
  }

  if ((t.volume || 0) < cfg.minVol) {
    return { skip: true, reason: 'Volume $' + (t.volume || 0) + ' < $' + cfg.minVol };
  }

  if ((t.liquidity || 0) < cfg.minLp) {
    return { skip: true, reason: 'LP $' + (t.liquidity || 0) + ' < $' + cfg.minLp };
  }

  var bundlerPct = (t.bundler_rate || 0) * 100;
  if (bundlerPct > cfg.maxBundlerPct) {
    return { skip: true, reason: 'Bundler ' + bundlerPct.toFixed(0) + '% > ' + cfg.maxBundlerPct + '%' };
  }

  var top10 = (t.top_10_holder_rate || 0) * 100;
  if (top10 > cfg.maxTop10Holders) {
    return { skip: true, reason: 'Top10 ' + top10.toFixed(0) + '% > ' + cfg.maxTop10Holders + '%' };
  }

  var devHold = checkDevHoldRate(t.dev_team_hold_rate, cfg.maxDevHold);
  if (devHold.skip) return devHold;

  var priceChg = checkPriceChange1h(t.price_change_percent1h, cfg.maxPriceChange1h);
  if (priceChg.skip) return priceChg;

  var holders = checkMinHolders(t.holder_count, cfg.minHolders);
  if (holders.skip) return holders;

  var sniper = checkSniperRate(t.top70_sniper_hold_rate, cfg.maxSniperPct);
  if (sniper.skip) return sniper;

  var volLp = checkVolLpRatio(t.volume, t.liquidity, cfg.maxVolLpRatio);
  if (volLp.skip) return volLp;

  return { skip: false, reason: '' };
}

function checkVolLpRatio(vol, lp, maxRatio) {
  var volume = Number(vol) || 0;
  var liquidity = Number(lp) || 0;
  if (liquidity <= 0) return { skip: false, reason: '' };
  var ratio = volume / liquidity;
  if (ratio > maxRatio) {
    return { skip: true, reason: 'Vol/LP ratio ' + ratio.toFixed(1) + 'x > ' + maxRatio + 'x (wash trading)' };
  }
  return { skip: false, reason: '' };
}

module.exports = {
  checkDevHoldRate,
  checkPriceChange1h,
  checkMinHolders,
  checkSniperRate,
  checkVolLpRatio,
  shouldSkipMigration,
};
