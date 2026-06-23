#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { execSync } = require('child_process');
const axios = require('axios');

const ca = process.argv[2];
if (!ca || ca.length < 30) { console.log('Usage: check <CA>'); process.exit(1); }

function p(txt, n = 12) {
  const em = (txt.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|\u200D|\uFE0F/g) || []).length;
  const pad = n - (txt.length - em);
  return txt + ' '.repeat(Math.max(0, pad));
}

function fmt(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return n.toFixed(2);
}

function timeAgo(ts) {
  if (!ts) return '?';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'Baru';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'j ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'h';
}

function pct(v) { return (v * 100).toFixed(2) + '%'; }
function pct1(v) { return (v * 100).toFixed(1) + '%'; }

const SEP = '\u2501'.repeat(56);

async function main() {
  console.log(SEP);
  console.log('   TOKEN ANALYSIS');
  console.log(SEP);

  // GMGN
  var gmgn = null;
  try {
    const env = { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY || '' };
    const out = execSync('gmgn-cli token info --chain sol --address ' + ca + ' --raw', {
      encoding: 'utf8', timeout: 15000, env, windowsHide: true,
    });
    gmgn = JSON.parse(out);
  } catch {}

  // DexScreener
  var dex = null;
  try {
    const r = await axios.get('https://api.dexscreener.com/latest/dex/tokens/' + ca, { timeout: 10000 });
    const pairs = r.data.pairs || [];
    dex = pairs.find(p => p.priceUsd) || pairs[0] || null;
  } catch {}

  // RugCheck
  var rug = null;
  try {
    const r = await axios.get('https://api.rugcheck.xyz/v1/tokens/' + ca + '/report', { timeout: 8000 });
    rug = r.data;
  } catch {}

  // ===== TOKEN INFO =====
  if (gmgn) {
    console.log('\nTOKEN');
    console.log(p('  Name') + ': ' + gmgn.name + ' (' + gmgn.symbol + ')');
    if (gmgn.creation_timestamp) console.log(p('  Age') + ': ' + timeAgo(gmgn.creation_timestamp * 1000));
    console.log(p('  Launchpad') + ': ' + (gmgn.launchpad || '-'));
    if (gmgn.link) {
      if (gmgn.link.twitter_username) console.log(p('  Twitter') + ': @' + gmgn.link.twitter_username);
      if (gmgn.link.telegram) console.log(p('  Telegram') + ': ' + gmgn.link.telegram);
      if (gmgn.link.website) console.log(p('  Website') + ': ' + gmgn.link.website);
    }
  } else {
    console.log('\nTOKEN');
    console.log(p('  CA') + ': ' + ca);
  }

  // ===== MARKET =====
  console.log('\nMARKET');
  const price = dex ? Number(dex.priceUsd || 0) : 0;
  const mcap = dex ? Number(dex.fdv || 0) : 0;
  const liq = dex ? Number(dex.liquidity?.usd || 0) : 0;
  const vol1h = dex ? Number(dex.volume?.h1 || 0) : 0;
  const vol24h = dex ? Number(dex.volume?.h24 || 0) : 0;
  const buys1h = dex ? (dex.txns?.h1?.buys || 0) : 0;
  const sells1h = dex ? (dex.txns?.h1?.sells || 0) : 0;

  console.log(p('  Price') + ': $' + price.toFixed(8));
  console.log(p('  MCap') + ': $' + fmt(mcap));
  if (gmgn && gmgn.history_highest_market_cap) console.log(p('  ATH MCap') + ': $' + fmt(Number(gmgn.history_highest_market_cap)));
  console.log(p('  Liquidity') + ': $' + fmt(liq));
  console.log(p('  Vol 1h') + ': $' + fmt(vol1h));
  console.log(p('  Vol 24h') + ': $' + fmt(vol24h));
  console.log(p('  Buy/Sell') + ': ' + buys1h + ' / ' + sells1h + ' (1h)');
  if (gmgn) console.log(p('  Holders') + ': ' + (gmgn.holder_count || 0).toLocaleString());

  // ===== SECURITY =====
  console.log('\nSECURITY');
  if (gmgn && gmgn.security) {
    const sec = gmgn.security;
    console.log(p('  Honeypot') + ': ' + (sec.is_honeypot ? 'YA' : 'TIDAK'));
    console.log(p('  Mint') + ': ' + (sec.renounced_mint ? 'YA' : 'TIDAK'));
    console.log(p('  Freeze') + ': ' + (sec.renounced_freeze_account ? 'YA' : 'TIDAK'));
    console.log(p('  Burn') + ': ' + ((sec.burn_ratio || 0) * 100).toFixed(0) + '%');
    if (sec.buy_tax != null && sec.sell_tax != null) console.log(p('  Tax') + ': Buy ' + sec.buy_tax + '% | Sell ' + sec.sell_tax + '%');
    console.log(p('  Alert') + ': ' + (sec.is_show_alert ? 'YA' : 'TIDAK'));
  }
  if (gmgn && gmgn.dev && gmgn.dev.fund_from) console.log(p('  Dev Fund') + ': ' + gmgn.dev.fund_from);

  // ===== RUGCHECK =====
  console.log('\nRUGCHECK');
  if (rug) {
    const riskNames = (rug.risks || []).map(r => {
      const lv = r.level ? '[' + r.level.toUpperCase() + '] ' : '';
      return lv + r.name;
    });
    const dangerFlags = riskNames.filter(n => /\[DANGER\]/i.test(n)).map(n => n.replace(/^\[DANGER\]\s*/i, ''));
    const warnFlags = riskNames.filter(n => /\[WARN\]/i.test(n)).map(n => n.replace(/^\[WARN\]\s*/i, ''));
    console.log(p('  Score') + ': ' + (rug.score || 0) + ' (' + riskNames.length + ' risks)');
    console.log(p('  Danger') + ': ' + (dangerFlags.length > 0 ? dangerFlags.join(' | ') : 'Tidak ada'));
    console.log(p('  Warning') + ': ' + (warnFlags.length > 0 ? warnFlags.join(' | ') : 'Tidak ada'));
  } else {
    console.log(p('  Score') + ': N/A');
    console.log(p('  Danger') + ': -');
    console.log(p('  Warning') + ': -');
  }

  // ===== DEX SCREENER =====
  console.log('\nDEX SCREENER');
  if (dex) {
    console.log(p('  DEX') + ': ' + (dex.dexId || '?'));
    console.log(p('  Price') + ': $' + Number(dex.priceUsd || 0).toFixed(8));
    console.log(p('  FDV/MCap') + ': $' + fmt(Number(dex.fdv || 0)));
    console.log(p('  Liq') + ': $' + fmt(Number(dex.liquidity?.usd || 0)));
    console.log(p('  Vol 24h') + ': $' + fmt(Number(dex.volume?.h24 || 0)));
    if (dex.priceChange) {
      if (dex.priceChange.h1 != null) console.log(p('  Chg 1h') + ': ' + dex.priceChange.h1.toFixed(2) + '%');
      if (dex.priceChange.h24 != null) console.log(p('  Chg 24h') + ': ' + dex.priceChange.h24.toFixed(2) + '%');
    }
    if (dex.txns && dex.txns.h24) console.log(p('  Txn 24h') + ': Buy ' + (dex.txns.h24.buys || 0) + ' | Sell ' + (dex.txns.h24.sells || 0));
    console.log(p('  Link') + ': ' + (dex.url || ''));
  }

  // ===== STAT (GMGN) =====
  if (gmgn && gmgn.stat) {
    const st = gmgn.stat;
    console.log('\nSTAT');
    console.log(p('  Top10') + ': ' + pct1(Number(st.top_10_holder_rate || 0)));
    console.log(p('  Bundler') + ': ' + pct(Number(st.top_bundler_trader_percentage || 0)) + ' (' + (gmgn.wallet_tags_stat?.bundler_wallets || 0) + ' wallet)');
    console.log(p('  Fresh') + ': ' + pct(Number(st.fresh_wallet_rate || 0)));
    console.log(p('  Bot/Degen') + ': ' + pct(Number(st.top_bot_degen_percentage || 0)));
    console.log(p('  Smart W') + ': ' + (gmgn.wallet_tags_stat?.smart_wallets || 0));
  }

  // ===== HOLDER (GMGN) =====
  if (gmgn) {
    console.log('\nHOLDER');
    console.log('  Tipe Wallet:');
    const wtt = gmgn.wallet_tags_stat || {};
    const holders = gmgn.holder_count || 0;
    const top10 = Number(gmgn.stat?.top_10_holder_rate || 0);
    const bundlerPct = Number(gmgn.stat?.top_bundler_trader_percentage || 0);
    const freshPct = Number(gmgn.stat?.fresh_wallet_rate || 0);
    const smartCount = wtt.smart_wallets || 0;
    const bundlerCount = wtt.bundler_wallets || 0;
    const freshCount = wtt.fresh_wallets || 0;
    const sniperCount = wtt.sniper_wallets || 0;
    const totalTagged = smartCount + bundlerCount + freshCount + sniperCount;
    
    // Simplified holder breakdown
    console.log('    ' + 'Top10     : ' + '~' + (top10 * 100).toFixed(2) + '%');
    console.log('    ' + 'Bundler   : ' + bundlerCount + ' wallet | ' + pct(bundlerPct));
    console.log('    ' + 'Fresh     : ' + freshCount + ' wallet | ' + pct(freshPct));
    console.log('    ' + 'Smart     : ' + smartCount + ' wallet');
    console.log('    ' + 'Sniper    : ' + sniperCount + ' wallet');
    console.log('    ' + 'Lainnya   : ' + (holders - totalTagged > 0 ? (holders - totalTagged).toLocaleString() : '0') + ' wallet');
  }

  console.log('\n' + SEP);
}

main().catch(e => console.log('Error: ' + e.message));
