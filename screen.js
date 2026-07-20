require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { buyToken, sellToken, setDryRun } = require('./buyer');
const { normalizeScreenMode, screenModeAllows } = require('./scan-mode');
const { normalizeEntryStrategy, requiresFibonacci } = require('./entry-strategy');
const { analyzeDevLaunchCluster } = require('./dev-cluster');
const {
  PendingFibZoneCache,
  evaluateFibZoneAtPrice,
  shouldDropBelowZoneAfterRefresh,
  validateFibZoneAgainstPrice,
} = require('./pending-fib-zone-cache');
const {
  shouldSkipNewMigration,
  checkBaseLiquidity,
  checkBaseAgeHours,
  checkVol1h,
  checkSwaps5m,
  checkVol5m,
  checkHasSocial,
  checkRugRatio,
  nextConsecutiveConfirmation,
  asPct,
  toUnixMillis,
  toUnixSeconds,
  getSwingKlinePlans,
  calculateRugcheckTopHoldersPct,
  getRankedRugcheckHolderPcts,
  checkIndividualTopHolders,
  mergeRugcheckReports,
  isPermanentRugcheckLock,
  isPermanentSafetyLock,
  getGmgnDevReputation,
  shouldSkipDevReputation,
  evaluateAppStyleMigration,
} = require('./filters');
// Sumber swing high/low untuk Fibonacci sekarang lewat zigzag pivot (bukan
// literal Math.max/min candle di window) — filter noise pakai threshold
// reversal % + jarak waktu minimal antar pivot, jadi swing yang kepilih
// beneran leg mayor, bukan wick sesaat.
//
// Chain fallback 4 lapis (semua pakai zigzag logic yang SAMA dari birdeye.js,
// cuma beda sumber candle) — begitu satu tier return null, langsung dicoba
// tier berikutnya di request yang sama, bukan nunggu cycle depan:
//   TIER 1: Birdeye       (butuh API key, cooldown otomatis kalau CU habis)
//   TIER 2: GeckoTerminal (gratis, tanpa key, rate limit ketat ~10-30/menit)
//   TIER 3: DexPaprika    (gratis, tanpa key, headroom lebih longgar 200K/bulan)
//   TIER 4: Vybe          (butuh API key, free tier 12rb kredit/bulan)
const { calculateFibFromBirdeye,       setLogger: setBirdeyeLogger }       = require('./birdeye');
const { calculateFibFromGeckoTerminal, setLogger: setGeckoTerminalLogger } = require('./geckoterminal');
const { calculateFibFromDexPaprika,    setLogger: setDexPaprikaLogger }    = require('./dexpaprika');
const { calculateFibFromVybe,          setLogger: setVybeLogger }          = require('./vybe');

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const CFG = {
  // ALL = New Migration + Swing + Signal, NEW = New Migration saja,
  // SWING = Swing 1D saja. Mode ini juga membatasi jalur AUTO BUY.
  screenMode: normalizeScreenMode(process.env.SCREEN_MODE),
  // New Migration V2 — base gates
  minVol1h:        Number(process.env.MIN_VOL_1H)        || 60000,
  minSwaps5m:      Number(process.env.MIN_SWAPS_5M)      || 50,
  minVol5m:        Number(process.env.MIN_VOL_5M)        || 5000,
  maxAgeHours:     Number(process.env.MAX_AGE_HOURS)     || 24,

  // Mode New Migration (sama seperti sebelumnya)
  // minLp dinaikkan dari 5000 -> 15000: LP $5K terlalu tipis untuk token
  // <24 jam, gampang di-drain sekali swap besar.
  minLp:           Number(process.env.MIN_LP)           || 15000,
  minVol:          Number(process.env.MIN_VOL_5M)       || 5000,
  // Sekarang pakai skala score_normalised RugCheck (0-100, makin RENDAH makin
  // aman). Default 30 = ambang batas kategori "Good" versi RugCheck.
  // Catatan: dulu field ini dibandingkan ke rug.score (raw score, skalanya bisa
  // ribuan/puluhan-ribu bahkan utk token legit) — jadi longgar tanpa disadari.
  maxRugScore:     Number(process.env.MAX_RUG_SCORE)     || 80,
  minBuyRatio:     Number(process.env.MIN_BUY_RATIO)     || 0,

  // New Migration extra gates
  // Sebelumnya nilai-nilai ini cuma dipajang di log startup, TIDAK PERNAH
  // benar-benar dipakai sebagai gate — shouldSkipNewMigration() cuma cek
  // LP/age/vol1h/swaps5m/vol5m. Sekarang sudah disambungkan lewat
  // collectMigrationHardRiskReasons() di filters.js, jadi gate ini AKTIF.
  //
  // maxBundlerPct: 25 -> 15, maxInsiderPct: 20 -> 10, maxCreatorTokens: 20 -> 6.
  // Kombinasi longgar sebelumnya (insider 20% + bundler 25% + top10 25%) bisa
  // meloloskan token yang supply-nya terkonsentrasi di grup terkoordinasi.
  maxBundlerPct:     Number(process.env.MAX_BUNDLER_PCT)     || 15,
  maxTop10Holders:   Number(process.env.MAX_TOP10_HOLDERS)   || 25,
  // Top10 holder % TERPISAH dari maxTop10Holders (yang sumbernya GMGN
  // t.top_10_holder_rate). Ini pakai data topHolders LANGSUNG dari RugCheck
  // API — independen dari risks[], karena RugCheck kadang tidak mengeluarkan
  // risk item "top 10 holders high ownership" walau angka top10-nya besar
  // (skor keseluruhan tetap bisa "Good"/rendah).
  maxTop10HoldersRugcheck: Number(process.env.MAX_TOP10_HOLDERS_RUGCHECK) || 25,
  // Gate top holder INDIVIDUAL (rank 1-4, dari data d.topHolders RugCheck
  // yang sama dengan maxTop10HoldersRugcheck di atas — sudah dikeluarkan
  // akun AMM/LOCKER, lalu diurutkan besar ke kecil). Ini TERPISAH dari
  // maxTop10HoldersRugcheck (yang jumlahin 10 holder sekaligus): token bisa
  // saja top10-nya di bawah threshold gabungan tapi satu wallet (holder #1)
  // sendirian pegang porsi besar — whale tunggal begini risikonya beda dari
  // sekadar "supply nyebar ke 10 wallet menengah".
  //
  // KHUSUS MODE MIGRATION (var SWING_MAX_HOLDER_x_PCT terpisah, lihat di
  // dekat swingMaxInsiderPct di bawah — supaya threshold-nya bisa beda
  // antara token baru migrasi <24j vs token swing yg lebih matang).
  //
  // Tiap rank punya threshold sendiri, di-set via .env. DEFAULT (kalau var
  // tidak di-set / kosong di .env): Holder#1 = 10%, Holder#2/#3/#4 = 3%.
  // Untuk MATIKAN pengecekan rank tertentu, set eksplisit ke string kosong
  // atau nilai non-angka (mis. MAX_HOLDER_4_PCT=) — TIDAK cukup cuma hapus
  // baris dari .env, karena baris yang hilang akan jatuh ke default di atas,
  // bukan ke OFF.
  //   MAX_HOLDER_1_PCT=10 (default) -> holder #1 > 10% => SKIP
  //   MAX_HOLDER_2_PCT=3  (default) -> holder #2 > 3%  => SKIP
  //   MAX_HOLDER_3_PCT=3  (default) -> holder #3 > 3%  => SKIP
  //   MAX_HOLDER_4_PCT=3  (default) -> holder #4 > 3%  => SKIP
  maxHolder1Pct: process.env.MAX_HOLDER_1_PCT !== undefined && process.env.MAX_HOLDER_1_PCT !== ''
    ? Number(process.env.MAX_HOLDER_1_PCT) : 10,
  maxHolder2Pct: process.env.MAX_HOLDER_2_PCT !== undefined && process.env.MAX_HOLDER_2_PCT !== ''
    ? Number(process.env.MAX_HOLDER_2_PCT) : 3,
  maxHolder3Pct: process.env.MAX_HOLDER_3_PCT !== undefined && process.env.MAX_HOLDER_3_PCT !== ''
    ? Number(process.env.MAX_HOLDER_3_PCT) : 3,
  maxHolder4Pct: process.env.MAX_HOLDER_4_PCT !== undefined && process.env.MAX_HOLDER_4_PCT !== ''
    ? Number(process.env.MAX_HOLDER_4_PCT) : 3,
  maxInsiderPct:     Number(process.env.MAX_INSIDER_PCT)     || 10,
  maxDevHold:        Number(process.env.MAX_DEV_HOLD)        || 10,
  maxPriceChange1h:  Number(process.env.MAX_PRICE_CHANGE_1H) || 20,
  minHoldersMig:     Number(process.env.MIN_HOLDERS_MIG)     || 100,
  maxSniperPct:      Number(process.env.MAX_SNIPER_PCT)      || 10,
  maxVolLpRatio:     Number(process.env.MAX_VOL_LP_RATIO)    || 15,
  // maxCreatorTokens: 20 -> 6. Dev yang sudah bikin 15-19 token sebelumnya
  // adalah pola serial creator yang jelas, bukan exception.
  maxCreatorTokens:  Number(process.env.MAX_CREATOR_TOKENS) || 6,
  // Kalau fetch created-tokens gagal (rate limit/network/exec error), default
  // behavior lama = tetap PASS (fail-open), karena serial-creator check bukan
  // satu-satunya lapisan proteksi. Set CREATOR_COUNT_FAIL_CLOSED=true di .env
  // kalau mau REJECT token saat data creator gagal diambil sama sekali.
  creatorCountFailClosed: process.env.CREATOR_COUNT_FAIL_CLOSED === 'true',
  devClusterFilterEnabled: process.env.DEV_CLUSTER_FILTER_ENABLED === 'true',
  devClusterFailClosed: process.env.DEV_CLUSTER_FAIL_CLOSED === 'true',
  // FIX: pola lama `Number(x) || default` salah kalau user SENGAJA mau set
  // 0 di .env — di JS, `0 || default` jatuh ke default karena 0 itu falsy,
  // jadi DEV_CLUSTER_MIN_WALLETS=0 / MAX_SUPPLY_PCT=0 / LAUNCH_WINDOW_SEC=0
  // dulu diam-diam BALIK ke angka default, bukan beneran jadi 0. Ini tidak
  // sama dengan mematikan filter (untuk itu pakai DEV_CLUSTER_FILTER_ENABLED
  // =false di atas), tapi tetap dibenerin supaya .env selalu dipatuhi persis
  // seperti yang ditulis. Sekarang pola-nya: kalau var kosong/tidak ada di
  // .env -> pakai default; kalau ADA isinya (termasuk "0") -> pakai apa
  // adanya dari .env.
  devClusterMinWallets: Math.max(1,
    process.env.DEV_CLUSTER_MIN_WALLETS !== undefined && process.env.DEV_CLUSTER_MIN_WALLETS !== ''
      ? Number(process.env.DEV_CLUSTER_MIN_WALLETS) : 3),
  devClusterMaxSupplyPct:
    process.env.DEV_CLUSTER_MAX_SUPPLY_PCT !== undefined && process.env.DEV_CLUSTER_MAX_SUPPLY_PCT !== ''
      ? Math.max(0, Number(process.env.DEV_CLUSTER_MAX_SUPPLY_PCT)) : 15,
  devClusterLaunchWindowSec:
    process.env.DEV_CLUSTER_LAUNCH_WINDOW_SEC !== undefined && process.env.DEV_CLUSTER_LAUNCH_WINDOW_SEC !== ''
      ? Math.max(0, Number(process.env.DEV_CLUSTER_LAUNCH_WINDOW_SEC)) : 120,
  // Baru: threshold TERPISAH dari maxRugScore (RugCheck API), khusus untuk
  // t.rug_ratio versi GMGN. Sebelumnya kode salah numpuk keduanya ke
  // cfg.maxRugScore yang sama — sekarang dipisah sesuai niat awal comment
  // di filters.js.
  // ─────────────────────────────────────────────
  //  DEV REPUTATION — getGmgnDevReputation() thresholds (filters.js)
  // ─────────────────────────────────────────────
  // 9 var ini sebelumnya ADA di .env tapi TIDAK DIBACA sama sekali oleh kode —
  // getGmgnDevReputation() di filters.js pakai angka hardcoded sendiri, jadi
  // ubah nilai .env dulu tidak ngefek apa-apa. Sekarang beneran disambungkan.
  // Nama env var TIDAK diganti (persis nama lama), yang dibenerin cuma cara
  // baca + skala persennya.
  //
  // DEV_REPUTATION_ENABLED — kode getGmgnDevReputation() lama tidak punya
  // saklar off sama sekali (selalu jalan tiap token lolos gate sebelumnya).
  // Default TETAP true supaya perilaku default tidak berubah dari sebelumnya;
  // set DEV_REPUTATION_ENABLED=false di .env kalau mau matikan gate ini sama
  // sekali (gate dev-reputation di-skip, token langsung lanjut ke gate
  // berikutnya, sama seperti waktu tokenInfo.dev.creator_address kosong).
  devReputationEnabled: process.env.DEV_REPUTATION_ENABLED === 'false' ? false : true,
  // DEV_REPUTATION_FAIL_CLOSED — kode lama: exec (fetch created-tokens ATAU
  // token security) gagal -> tetap balikin profile pakai default awal
  // ('token info fallback'), yang notabene TETAP DIEVALUASI status/score-nya
  // (bukan otomatis skip/reject, cuma datanya minim) -> secara perilaku ini
  // fail-OPEN (token tetap bisa lolos meski data dev gagal diambil). Default
  // FALSE supaya perilaku lama tidak berubah. Set =true kalau mau REJECT
  // token saat fetch dev-reputation gagal total (exec throw / raw kosong),
  // BUKAN saat data cuma sebagian (mis. security scan gagal per-token tetap
  // diam-diam skip sesuai comment asli di filters.js).
  devReputationFailClosed: process.env.DEV_REPUTATION_FAIL_CLOSED === 'true',
  devReputationMinSample: Number(process.env.DEV_REPUTATION_MIN_SAMPLE) || 10,
  // Env var ini dalam PERSEN (mis. 70 = 70%), BUKAN desimal. filters.js yang
  // membagi /100 secara internal sebelum dibandingkan ke profile.RugRate
  // (desimal 0-1). Sebelumnya .env berisi 80 padahal kode aslinya bandingin
  // RugRate >= 0.7 (=70%) — jadi nilai .env lama SALAH, dibenerin ke 70 di sini.
  devReputationMaxDeadFailedPct: Number(process.env.DEV_REPUTATION_MAX_DEAD_FAILED_PCT) || 70,
  devReputationMinInnerFail: Number(process.env.DEV_REPUTATION_MIN_INNER_FAIL) || 50,
  devReputationMinSerialLaunches: Number(process.env.DEV_REPUTATION_MIN_SERIAL_LAUNCHES) || 20,
  devReputationMaxScore: Number(process.env.DEV_REPUTATION_MAX_SCORE) || 15,
  // DEV_REPUTATION_CACHE_TTL_SEC — kode lama tidak nge-cache apa pun, tiap
  // token yang lolos gate sebelumnya selalu fetch ulang created-tokens +
  // security scan dari GMGN walau wallet creator-nya sama dengan token lain
  // di cycle yang sama/baru lewat. Default 0 = TIDAK ADA cache (perilaku lama
  // persis, tiap panggilan selalu fetch fresh). Set misalnya
  // DEV_REPUTATION_CACHE_TTL_SEC=600 kalau mau cache per-wallet 10 menit
  // (mengurangi beban ke GMGN CLI untuk dev yang sering nongol lagi).
  devReputationCacheTtlSec: Math.max(0, Number(process.env.DEV_REPUTATION_CACHE_TTL_SEC) || 0),
  // DEV_REPUTATION_SECURITY_SCAN_ENABLED — kode lama tidak punya saklar off,
  // security scan (3 token terakhir per dev) selalu jalan. Default TETAP true.
  devReputationSecurityScanEnabled: process.env.DEV_REPUTATION_SECURITY_SCAN_ENABLED === 'false' ? false : true,
  // DEV_REPUTATION_MIN_LOGO_REUSE — BUKAN bagian dari 9 var .env asli.
  // Ditambahkan atas permintaan eksplisit: dev yang pakai logo SAMA untuk
  // beberapa token berbeda adalah indikator kuat serial-scam (reskin token
  // lama jadi "baru"). Sebelumnya hardcode >= 2 di filters.js (reuse logo
  // minimal 2x baru dianggap indikasi), sekarang bisa diatur. Set ke 1 kalau
  // mau langsung sensitif di reuse pertama; naikkan kalau mau lebih toleran
  // (mis. dev yang wajar pakai template logo yang sama beberapa kali).
  // FIX (sama seperti DEV_CLUSTER_* di atas): pola lama `Number(x) || 2`
  // bikin DEV_REPUTATION_MIN_LOGO_REUSE=0 diam-diam balik ke default 2,
  // bukan beneran jadi 0. Sekarang: kalau var kosong/tidak ada -> default 2;
  // kalau ADA isinya (termasuk "0") -> pakai apa adanya dari .env.
  devReputationMinLogoReuse: Math.max(0,
    process.env.DEV_REPUTATION_MIN_LOGO_REUSE !== undefined && process.env.DEV_REPUTATION_MIN_LOGO_REUSE !== ''
      ? Number(process.env.DEV_REPUTATION_MIN_LOGO_REUSE) : 2),
  migAppFilterEnabled: process.env.MIG_APP_FILTER_ENABLED !== 'false',
  migMaxBuyTaxPct: Number(process.env.MIG_MAX_BUY_TAX_PCT) || 10,
  migMaxSellTaxPct: Number(process.env.MIG_MAX_SELL_TAX_PCT) || 10,
  migMaxBotDegenPct: Number(process.env.MIG_MAX_BOT_DEGEN_PCT) || 50,
  migMinSmartMoneyConfluence: Number(process.env.MIG_MIN_SMART_MONEY_CONFLUENCE) || 1,
  migMinConviction: Number(process.env.MIG_MIN_CONVICTION) || 0.6,
  migMinPriority: Number(process.env.MIG_MIN_PRIORITY) || 60,

  gmgnRugMaxRatio:   Number(process.env.GMGN_RUG_MAX_RATIO)  || 30,
  migGmgnRugConfirmScans: Math.max(1, Math.floor(Number(
    process.env.MIG_GMGN_RUG_CONFIRM_SCANS || process.env.GMGN_RUG_CONFIRM_SCANS
  ) || 2)),
  maxPhishingPct:    Number(process.env.MAX_PHISHING_PCT)    || 5,
  // Wajib minimal 1 social media (Twitter/Telegram/Website) supaya lolos.
  // Default OFF (false) supaya tidak tiba-tiba mengubah perilaku screening
  // yang sudah jalan — nyalakan lewat REQUIRE_SOCIAL=true di .env.
  requireSocial:     isTruthyFlag(process.env.REQUIRE_SOCIAL),
  // Wajib harga di dalam Fibonacci zone (Area Agresif utk MIG / Golden Zone
  // utk SWING) sebelum AUTO BUY dieksekusi. Default ON — set REQUIRE_FIB_ZONE=false
  // di .env kalau mau auto-buy tetap jalan walau harga di luar zona.
  requireFibZone:    process.env.REQUIRE_FIB_ZONE === 'false' ? false : true,
  migEntryStrategy: normalizeEntryStrategy(process.env.AUTO_BUY_MIG_ENTRY_STRATEGY, 'PREPUMP'),
  swingEntryStrategy: normalizeEntryStrategy(process.env.AUTO_BUY_SWING_ENTRY_STRATEGY, 'FIBONACCI'),
  // Gate anti-kemahalan khusus mode PREPUMP (New Migration). PREPUMP tidak
  // pakai Fibonacci zone sebagai gate (requiresFibonacci() balikin false),
  // jadi tanpa ini token bisa langsung dibeli walau harganya sudah naik jauh
  // dari saat pertama kali terdeteksi (kalah cepat dari sniper/bot lain).
  // Bandingkan harga saat ini vs harga referensi (harga pertama kali token
  // terlihat) — kalau kenaikannya > migMaxPumpPct%, JANGAN beli sekarang,
  // taruh di PENDING_FIB (dicek ulang tiap cycle, beli kalau retrace balik
  // ke bawah batas). Default 25% (tengah dari rentang 20-30% yang diminta).
  // Set MIG_MAX_PUMP_PCT= (kosong/non-angka) untuk MATIKAN gate ini.
  migMaxPumpPct: process.env.MIG_MAX_PUMP_PCT !== undefined && process.env.MIG_MAX_PUMP_PCT !== ''
    ? Number(process.env.MIG_MAX_PUMP_PCT) : 25,
  // Gate momentum 5 menit khusus PREPUMP — MELENGKAPI migMaxPumpPct di atas,
  // BUKAN gantiin. migMaxPumpPct nangkep pump yang kejadian SETELAH bot lihat
  // token (baseline = harga pas pertama kali kedeteksi, selalu 0% di percobaan
  // pertama -> gate itu nggak bisa nangkep token yang UDAH dipompa SEBELUM
  // bot sempat proses, misal karena sniper lain lebih cepat). Gate ini pakai
  // price_change_percent5m dari GMGN (data yang sudah ke-fetch, bukan API
  // tambahan) — kalau harga sudah naik >X% dalam 5 menit terakhir SEBELUM bot
  // lihat, token langsung di-SKIP (bukan ditunda ke PENDING_FIB, karena data
  // momentum 5m ini nggak murah buat di-refresh tiap cycle tanpa API tambahan
  // — beda dari harga spot yang sudah ada mekanisme DexScreener poll).
  // Set kosong/0 untuk MATIKAN gate ini.
  migMaxPriceChange5m: process.env.MIG_MAX_PRICE_CHANGE_5M !== undefined && process.env.MIG_MAX_PRICE_CHANGE_5M !== ''
    ? Number(process.env.MIG_MAX_PRICE_CHANGE_5M) : 15,

  // ─────────────────────────────────────────────
  //  FIBONACCI ZONE — master switch + per-tier switch
  // ─────────────────────────────────────────────
  // Master switch: kalau OFF, seluruh fitur fibonacci (zigzag 4-tier +
  // fallback literal max/min) di-skip total -> getFibonacciZone() langsung
  // balikin { available: false } tanpa nembak API sama sekali ke Birdeye/
  // GeckoTerminal/DexPaprika/Vybe. Default ON (fitur nyala kayak biasa).
  // Set FIB_ENABLED=false di .env kalau mau matiin fibonacci sepenuhnya
  // (gate REQUIRE_FIB_ZONE otomatis gak ngeblok krn fib emang gak dihitung —
  // lihat pengecekan CFG.requireFibZone && CFG.fibEnabled di titik gate).
  fibEnabled:        process.env.FIB_ENABLED === 'false' ? false : true,

  // Per-tier switch: matiin sumber tertentu aja tanpa matiin semuanya, mis.
  // FIB_TIER_VYBE=false kalau belum punya VYBE_API_KEY atau mau hemat kredit
  // bulanannya, sementara Birdeye/GeckoTerminal/DexPaprika tetap jalan.
  // Semua default ON (chain 4-tier penuh jalan spt sebelumnya).
  fibTierBirdeye:       process.env.FIB_TIER_BIRDEYE       === 'false' ? false : true,
  fibTierGeckoTerminal: process.env.FIB_TIER_GECKOTERMINAL === 'false' ? false : true,
  fibTierDexPaprika:    process.env.FIB_TIER_DEXPAPRIKA    === 'false' ? false : true,
  fibTierVybe:          process.env.FIB_TIER_VYBE          === 'false' ? false : true,

  // NOTE: config RUGCHECK_HARD_SKIP (rugcheckHardSkip) DIHAPUS — dulu
  // dideklarasikan di sini tapi TIDAK PERNAH dipakai sebagai gate di mana
  // pun (getRugCheck() dan semua pemanggilnya di MIG/SWING/PENDING_FIB tidak
  // pernah membaca CFG.rugcheckHardSkip). Komentarnya juga sudah tidak sesuai
  // implementasi asli (bilang "rawScore=1, score_normalised=1" padahal gate
  // yang benar-benar jalan pakai threshold maxRugScore/swingMaxRugScore).
  // Kalau .env kalian masih set RUGCHECK_HARD_SKIP, variabel itu sekarang
  // benar-benar tidak berpengaruh — dead config, bukan bug baru.
  // Batas rentang zona Fibonacci (retracement ratio, 0-1) yang dipakai buat
  // gate AUTO BUY. Default MIG 0.382-0.5 (Area Agresif — token baru migrasi,
  // belum sempat retrace dalam), default SWING 0.5-0.618 (Golden Zone —
  // token yang sudah lebih matang). Override lewat .env kalau mau ubah
  // lebar/posisi zona tanpa edit kode, mis. FIB_MIG_LO=0.236 FIB_MIG_HI=0.618.
  fibMigLo:          Number(process.env.FIB_MIG_LO)   || 0.382,
  fibMigHi:          Number(process.env.FIB_MIG_HI)   || 0.5,
  fibSwingLo:        Number(process.env.FIB_SWING_LO) || 0.5,
  fibSwingHi:        Number(process.env.FIB_SWING_HI) || 0.618,

  // Mode Swing 1D — filter lebih ketat
  swingMinLp:      Number(process.env.SWING_MIN_LP)      || 30000,
  swingMinVol1h:   Number(process.env.SWING_MIN_VOL1H)   || 20000,
  swingMaxChange1h: Number(process.env.SWING_MAX_CHG1H)  || 15,   // tidak sedang pump >15% per jam
  swingMaxChange24h: Number(process.env.SWING_MAX_CHG24H)|| 50,   // belum pump >50% dalam 24h
  swingVolSpikeMin: Number(process.env.SWING_VOL_SPIKE)  || 2.0,  // volume spike vs estimasi avg
  swingMinHolders: Number(process.env.SWING_MIN_HOLDERS) || 500,
  swingMinAge:     Number(process.env.SWING_MIN_AGE_H)   || 24,   // token minimal 24 jam
  swingMaxAge:     Number(process.env.SWING_MAX_AGE_H)   || 720,  // max 30 hari (720 jam)
  swingMinBuyRatio: Number(process.env.SWING_MIN_BUY_RATIO) || 50,
  // Cegah satu snapshot GMGN anomali meloloskan token. Nilai aman harus muncul
  // berturut-turut pada beberapa cycle sebelum Swing boleh lanjut.
  swingGmgnRugConfirmScans: Math.max(1, Math.floor(Number(
    process.env.SWING_GMGN_RUG_CONFIRM_SCANS || process.env.GMGN_RUG_CONFIRM_SCANS
  ) || 2)),
  // Lantai minimum progress candle aktif saat menormalisasi volume.
  // Berlaku untuk timeframe adaptif 1D/4H/1H.
  swingDayFractionFloor: Number(process.env.SWING_DAY_FRACTION_FLOOR) || 0.1,
  // Ambang posInRange (0-1) supaya dianggap "harga dekat support".
  swingSupportMaxRangePct: Number(process.env.SWING_SUPPORT_MAX_RANGE_PCT) || 0.45,
  // Ambang posInRange (0-1) supaya dianggap "harga sudah tinggi di range" (warning).
  swingWarnHighRangePct: Number(process.env.SWING_WARN_HIGH_RANGE_PCT) || 0.80,
  // Ambang rasio (range / swingLow) supaya dianggap "konsolidasi".
  swingMaxConsolidationRangeRatio: Number(process.env.SWING_MAX_CONSOLIDATION_RANGE_RATIO) || 0.80,
  // Threshold rug/insider TERPISAH dari Migration (CFG.maxRugScore/maxInsiderPct).
  // Swing sudah umur 24-168 jam & LP >= $50K, jadi standarnya boleh sedikit
  // lebih longgar daripada gate Migration yang dituning buat token <24 jam.
  swingMaxRugScore:   Number(process.env.SWING_MAX_RUG_SCORE)   || 40,
  swingMaxInsiderPct: Number(process.env.SWING_MAX_INSIDER_PCT) || 15,
  // Gate top holder INDIVIDUAL (rank 1-4) KHUSUS mode SWING — terpisah dari
  // MAX_HOLDER_1..4_PCT (mode MIGRATION) di atas, supaya threshold-nya bisa
  // di-set beda: token swing (umur 24-168j, LP lebih besar) biasanya wajar
  // punya distribusi holder yang beda dari token baru migrasi <24j.
  // Sama seperti versi MIG. DEFAULT (kalau var tidak di-set / kosong di
  // .env): Holder#1 = 5%, Holder#2/#3/#4 = 3%. Untuk MATIKAN pengecekan
  // rank tertentu, set eksplisit ke string kosong (mis. SWING_MAX_HOLDER_4_PCT=)
  // — TIDAK cukup cuma hapus baris dari .env, karena baris yang hilang akan
  // jatuh ke default di atas, bukan ke OFF.
  //   SWING_MAX_HOLDER_1_PCT=5 (default) -> holder #1 > 5% => SKIP
  //   SWING_MAX_HOLDER_2_PCT=3 (default) -> holder #2 > 3% => SKIP
  //   SWING_MAX_HOLDER_3_PCT=3 (default) -> holder #3 > 3% => SKIP
  //   SWING_MAX_HOLDER_4_PCT=3 (default) -> holder #4 > 3% => SKIP
  swingMaxHolder1Pct: process.env.SWING_MAX_HOLDER_1_PCT !== undefined && process.env.SWING_MAX_HOLDER_1_PCT !== ''
    ? Number(process.env.SWING_MAX_HOLDER_1_PCT) : 5,
  swingMaxHolder2Pct: process.env.SWING_MAX_HOLDER_2_PCT !== undefined && process.env.SWING_MAX_HOLDER_2_PCT !== ''
    ? Number(process.env.SWING_MAX_HOLDER_2_PCT) : 3,
  swingMaxHolder3Pct: process.env.SWING_MAX_HOLDER_3_PCT !== undefined && process.env.SWING_MAX_HOLDER_3_PCT !== ''
    ? Number(process.env.SWING_MAX_HOLDER_3_PCT) : 3,
  swingMaxHolder4Pct: process.env.SWING_MAX_HOLDER_4_PCT !== undefined && process.env.SWING_MAX_HOLDER_4_PCT !== ''
    ? Number(process.env.SWING_MAX_HOLDER_4_PCT) : 3,
  // Smart Money Signal
  signalEnabled:      isTruthyFlag(process.env.SIGNAL_ENABLED),
  tgThreadSignal:     Number(process.env.TG_THREAD_SIGNAL) || undefined,
  signalMinLiquidity: Number(process.env.SIGNAL_MIN_LIQ)   || 10000,
  signalMinHolders:   Number(process.env.SIGNAL_MIN_HOLDERS)|| 100,
  signalMaxMc:        Number(process.env.SIGNAL_MAX_MC)     || 300000,
  signalMaxTop10Rate: Number(process.env.SIGNAL_MAX_TOP10)  || 35,

  // Umum
  interval:        Number(process.env.POLL_INTERVAL)     || 60,
  autoSellInterval:Number(process.env.AUTO_SELL_POLL_INTERVAL) || Number(process.env.POLL_INTERVAL) || 60,
  pendingFibPriceInterval: Math.max(1, Number(process.env.PENDING_FIB_PRICE_POLL_INTERVAL) || 5),
  pendingFibRefreshInterval: Math.max(5, Number(process.env.PENDING_FIB_REFRESH_INTERVAL) || 60),
  fibDropBelowZoneAfterRefresh: process.env.FIB_DROP_BELOW_ZONE_AFTER_REFRESH === 'true',
  healthInterval:  Number(process.env.HEALTH_INTERVAL)   || 3600,
  seenCleanupDays: Number(process.env.SEEN_CLEANUP_DAYS) || 7,
  tgToken:         process.env.TG_TOKEN,
  tgChatId:        process.env.TG_CHAT_ID,
  tgThreadId:      Number(process.env.TG_THREAD_ID)      || undefined,  // Swing 1D
  tgThreadMig:     Number(process.env.TG_THREAD_MIG)     || undefined,  // New Migration
  tgThreadEntry:   Number(process.env.TG_THREAD_ENTRY)   || undefined,  // Entry Signal
  tgThreadAuto:    Number(process.env.TG_THREAD_AUTO)    || undefined,  // Autobuy notification
};

const AUTO_BUY = {
  ENABLED:      process.env.AUTO_BUY_ENABLED === 'true' || false,
  DRY_RUN:      process.env.AUTO_BUY_DRY_RUN !== 'false',
  AMOUNT_SOL:   Number(process.env.AUTO_BUY_AMOUNT)     || 0.01,
  MAX_PER_CYCLE:Number(process.env.AUTO_BUY_MAX_PER)    || 3,
  SLIPPAGE_BPS: Number(process.env.AUTO_BUY_SLIPPAGE)   || 500,
  ONLY_GRADE:   process.env.AUTO_BUY_GRADE             || 'ALL',
};
setDryRun(AUTO_BUY.DRY_RUN);

// AUTO_SELL — eksekusi jual otomatis (cutloss & take-profit) untuk posisi
// yang BENAR-BENAR dibeli lewat AUTO_BUY (pos.autoBought === true).
// Posisi yang cuma "ditrack" buat notifikasi (swing/signal/migration tanpa
// autobuy) tidak akan pernah dijual otomatis lewat sini.
const AUTO_SELL = {
  ENABLED:            process.env.AUTO_SELL_ENABLED === 'true' || false,
  CUTLOSS_PCT:        Number(process.env.AUTO_SELL_CUTLOSS_PCT) || 30,
  TP_MODE:            (process.env.AUTO_SELL_TP_MODE || (process.env.AUTO_SELL_TP_PCT ? 'FIXED' : 'OFF')).toUpperCase(),
  TAKE_PROFIT_PCT:    Number(process.env.AUTO_SELL_TP_PCT || process.env.AUTO_SELL_FIXED_TP_PCT) || 0,
  TRAILING_START_PCT: Number(process.env.AUTO_SELL_TRAILING_START_PCT) || 0,
  TRAILING_DROP_PCT:  Number(process.env.AUTO_SELL_TRAILING_DROP_PCT) || 0,
  SLIPPAGE_BPS:       Number(process.env.AUTO_SELL_SLIPPAGE) || 500,
};

if (!CFG.tgToken || !CFG.tgChatId) {
  console.error('Isi TG_TOKEN dan TG_CHAT_ID di .env');
  process.exit(1);
}

console.log('DEBUG thread SWING=' + process.env.TG_THREAD_ID + ' MIG=' + process.env.TG_THREAD_MIG);

const TG_API        = 'https://api.telegram.org/bot' + CFG.tgToken + '/sendMessage';
const SEEN_FILE     = path.join(__dirname, 'seen.json');
const POSITIONS_FILE= path.join(__dirname, 'positions.json');
const PENDING_FIB_FILE = path.join(__dirname, 'pending_fib.json');
const LOG_FILE      = path.join(__dirname, 'screen.log');
const TRACKING_LOG  = path.join(__dirname, 'tracking_log.json');
// Tombstone list yang ditulis dashboard-server.js tiap kali token dihapus
// manual lewat dashboard. Dibaca di sini supaya proses ini (yang megang
// salinan posisi sendiri di TRACKED, in-memory) ikut buang entry itu dan
// gak nulis balik ke positions.json pas savePositions() jalan lagi.
const DELETED_MARKER_FILE = path.join(__dirname, 'deleted_positions.json');

const SEEN    = new Map();
const TRACKED = new Map();
// Token yang lolos semua gate lain tapi harganya masih di luar Fibonacci
// zone saat pertama kali discan — ditunggu di sini sampai retrace masuk
// zona (baru auto-buy dieksekusi) atau kadaluarsa (umur > CFG.maxAgeHours
// untuk MIG / CFG.swingMaxAge untuk SWING).
const PENDING_FIB = new Map();
const PENDING_FIB_ZONE_CACHE = new PendingFibZoneCache(CFG.pendingFibRefreshInterval * 1000);
const MIG_RUG_CONFIRM = new Map();
const SWING_RUG_CONFIRM = new Map();
const TARGETS = [30, 50, 100, 200, 500];
let startTime = Date.now();
let totalNotified = 0;
let screeningCycleId = 0;
let latestMigrationSnapshotByAddress = new Map();
let latestSwingSnapshotByAddress = new Map();
let pendingFibLoopRunning = false;

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

// Sebelumnya birdeye.js/geckoterminal.js/dexpaprika.js/vybe.js semuanya
// nulis lewat console.log/console.error polos, BUKAN log() di atas — jadi
// semua baris [BIRDEYE]/[GECKOTERMINAL]/[DEXPAPRIKA]/[VYBE] (candle fetch,
// fib OK/gagal, cooldown, dst) cuma nongol di stdout dan TIDAK PERNAH
// ke-append ke screen.log. Kalau screen.log dipakai sbg sumber cek log
// utama, ke-4 tier itu keliatan seolah gak pernah jalan sama sekali padahal
// sebenernya jalan (cuma lognya "ilang" krn gak masuk file). Wiring di bawah
// ini bikin ke-4 module pakai log() yang sama persis dgn punya screen.js,
// jadi semua baris candle/fib dari tier manapun konsisten masuk screen.log.
setBirdeyeLogger(log);
setGeckoTerminalLogger(log);
setDexPaprikaLogger(log);
setVybeLogger(log);

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

function loadDeletedMarkers() {
  try {
    const list = JSON.parse(fs.readFileSync(DELETED_MARKER_FILE, 'utf8'));
    return new Set(Array.isArray(list) ? list : []);
  } catch { return new Set(); }
}

// Buang dari TRACKED (in-memory) semua CA yang ada di tombstone list.
// Dipanggil sebelum load & sebelum tiap save, biar penghapusan manual lewat
// dashboard gak "kebalikin" oleh proses screen.js yang jalan terus-terusan.
function purgeDeletedFromTracked() {
  const deleted = loadDeletedMarkers();
  if (deleted.size === 0) return 0;
  let removed = 0;
  for (const ca of deleted) {
    if (TRACKED.delete(ca)) removed++;
  }
  return removed;
}

function loadPositions() {
  try {
    const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
    for (const [ca, entry] of Object.entries(data.entries || {})) TRACKED.set(ca, entry);
    const removed = purgeDeletedFromTracked();
    log('Loaded ' + TRACKED.size + ' tracked positions' + (removed > 0 ? ' (skipped ' + removed + ' tombstoned)' : ''));
  } catch { log('No existing positions.json, starting fresh'); }
}

function savePositions() {
  try {
    const removed = purgeDeletedFromTracked();
    if (removed > 0) log('[TOMBSTONE] Buang ' + removed + ' posisi yang dihapus manual lewat dashboard dari TRACKED');
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify({
      version: 1, savedAt: Date.now(), entries: Object.fromEntries(TRACKED),
    }));
  } catch (e) { log('Failed to save positions.json: ' + e.message); }
}

function loadPendingFib() {
  try {
    const data = JSON.parse(fs.readFileSync(PENDING_FIB_FILE, 'utf8'));
    for (const [ca, entry] of Object.entries(data.entries || {})) PENDING_FIB.set(ca, entry);
    log('Loaded ' + PENDING_FIB.size + ' pending fib-zone tokens');
  } catch { log('No existing pending_fib.json, starting fresh'); }
}

function savePendingFib() {
  try {
    fs.writeFileSync(PENDING_FIB_FILE, JSON.stringify({
      version: 1, savedAt: Date.now(), entries: Object.fromEntries(PENDING_FIB),
    }));
  } catch (e) { log('Failed to save pending_fib.json: ' + e.message); }
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
async function getWithRetry(url, opts, retries, diagnosticLabel) {
  const maxRetries = retries ?? 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await axios.get(url, { timeout: 10000, ...(opts || {}) });
      if (diagnosticLabel) {
        log('[' + diagnosticLabel + '] attempt=' + (i + 1) + '/' + maxRetries
          + ' status=' + response.status);
      }
      return response;
    } catch (e) {
      const status = e.response?.status;

      if (diagnosticLabel) {
        log('[' + diagnosticLabel + '] attempt=' + (i + 1) + '/' + maxRetries
          + ' status=' + (status || 'NETWORK_ERROR')
          + ' code=' + (e.code || 'N/A')
          + ' message=' + String(e.message || 'unknown error'));
      }

      // 404 = resource memang belum ada (mis. token baru migrasi belum
      // ke-index RugCheck). Ini biasanya tidak akan berubah dalam hitungan
      // detik, jadi retry cuma buang waktu — langsung throw ke pemanggil
      // supaya fallback (score: 999) dieksekusi lebih cepat.
      if (status === 404) throw e;

      if (i === maxRetries - 1) throw e;

      if (status === 429) {
        // Rate limited — hormati header Retry-After kalau server kasih,
        // kalau tidak pakai backoff lebih panjang & eksponensial (bukan
        // linear 1-2-3 detik) supaya tidak menembak makin kencang ke
        // server yang sedang menolak.
        const retryAfterHeader = Number(e.response?.headers?.['retry-after']);
        const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader * 1000
          : Math.min(2000 * Math.pow(2, i), 15000); // 2s, 4s, 8s... cap 15s
        if (diagnosticLabel) log('[' + diagnosticLabel + '] retryInMs=' + retryAfterMs);
        await new Promise(r => setTimeout(r, retryAfterMs));
      } else {
        // Error lain (timeout, 5xx, network) — backoff linear seperti semula.
        const retryDelayMs = (i + 1) * 1000;
        if (diagnosticLabel) log('[' + diagnosticLabel + '] retryInMs=' + retryDelayMs);
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
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
//
// creation_timestamp di sini SENGAJA diisi dari `complete_timestamp` (waktu token
// completed/migrasi ke DEX), BUKAN dari `created_timestamp` (waktu token dibuat
// di launchpad awal, mis. Pump.fun). Sudah diverifikasi lewat sample data live
// GMGN (--type completed): keduanya sering BEDA jauh untuk token dari
// pump_mayhem/Pump.fun (selisih `complete_cost_time` bisa puluhan ribu detik,
// mis. ~11 jam), meski utk token dari meteora_virtual_curve sering sama persis.
// Semua gate umur (MAX_AGE_HOURS dkk) di New Migration jadi berbasis "berapa
// lama sejak token ini nongol di DEX", bukan "berapa lama sejak token dibuat".
function normalizeTrench(t) {
  const supply = Number(t.total_supply) || 0;
  const mc     = Number(t.usd_market_cap) || 0;
  return Object.assign({}, t, {
    price:              supply > 0 ? mc / supply : 0,
    market_cap:         mc,
    creation_timestamp: t.complete_timestamp || t.created_timestamp,
    volume:             Number(t.volume_1h) || Number(t.volume_24h) || 0,
    buys:               t.buys_24h,
    sells:              t.sells_24h,
    bundler_rate:       t.bundler_trader_amount_rate,
    // GMGN dedicated rug_ratio (dari `gmgn-cli token security` / field rug_ratio yang udah kebawa
    // di trenches & trending). Skala 0-1 (0.20 = 20%).
    rug_ratio:                Number(t.rug_ratio) || 0,
    suspected_insider_hold_rate: Number(t.suspected_insider_hold_rate) || 0,
    renounced_mint:           isTruthyFlag(t.renounced_mint) ? 1 : 0,
    renounced_freeze_account: isTruthyFlag(t.renounced_freeze_account) ? 1 : 0,
  });
}

// Sumber khusus New Migration: token yang sudah graduate ke DEX (`completed`).
// CLI sudah unwrap `.data`, jadi kategori ada di root (d.completed).
//
// CATATAN PENTING (belum terverifikasi): flag `--max-created` di bawah ini
// adalah filter SERVER-SIDE milik GMGN sendiri, dan kemungkinan besar dia
// menyaring berdasarkan `created_timestamp` (waktu token dibuat di launchpad
// awal), BUKAN `complete_timestamp` (waktu migrasi/completed ke DEX) — karena
// namanya "max-created", bukan "max-completed"/"max-age-completed". Kalau
// benar begitu, filter server ini bisa saja MEMBUANG token yang lama migrasi
// (created_timestamp sudah lewat batas) padahal complete_timestamp-nya baru
// saja terjadi — sebelum sempat sampai ke normalizeTrench() di bawah, yang
// artinya perbaikan `creation_timestamp = complete_timestamp` di
// normalizeTrench() TIDAK BERLAKU untuk token yang sudah kesaring di sini.
// Kalau mau MAX_AGE_HOURS/SWING_MIN_AGE_H benar-benar konsisten berbasis
// waktu migrasi dari hulu ke hilir, --max-created ini idealnya dihapus/
// dilonggarkan, lalu penyaringan umur dilakukan manual di sisi client
// menggunakan creation_timestamp (yang sudah pakai complete_timestamp).
function fetchGmgnTrenches() {
  try {
    const args = [
      'market trenches',
      '--chain sol',
      '--type completed',
      '--limit 50',
      '--min-smart-degen-count 1',
      '--sort-by smart_degen_count',
      '--max-created ' + Math.round(CFG.swingMinAge * 60) + 'm',  // umur < swingMinAge jam
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

const DEV_CLUSTER_CACHE = new Map();
function checkDevLaunchCluster(address, tokenInfo) {
  if (!CFG.devClusterFilterEnabled) return { reject: false, disabled: true, reason: 'disabled' };
  const cacheKey = String(address || '');
  const cached = DEV_CLUSTER_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) return cached.value;

  try {
    const out = execSync(
      'npx gmgn-cli token holders --chain sol --address ' + address + ' --tag dev --limit 50 --raw',
      { encoding: 'utf8', timeout: 20000, env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY || '' } }
    );
    const value = analyzeDevLaunchCluster(JSON.parse(out), tokenInfo, {
      minWallets: CFG.devClusterMinWallets,
      maxSupplyPct: CFG.devClusterMaxSupplyPct,
      launchWindowSec: CFG.devClusterLaunchWindowSec,
      // Sama seperti migCfg.onMissingHardRiskData di bawah: sebelumnya field
      // hilang (supply gagal baca, buy_amount_cur kosong per-wallet) diam-diam
      // tidak menghasilkan jejak apa pun. Sekarang di-log eksplisit sebagai
      // WARNING supaya kelihatan kalau GMGN API berubah/field ilang.
      onMissingHardRiskData: function (warnings) {
        log('[DEV CLUSTER][DATA MISSING] ' + (address || '').slice(0, 8) + ' -> ' + warnings.join(' | '));
      },
    });
    DEV_CLUSTER_CACHE.set(cacheKey, { fetchedAt: Date.now(), value });
    return value;
  } catch (error) {
    const value = {
      reject: CFG.devClusterFailClosed,
      unavailable: true,
      walletCount: 0,
      historicalBuyPct: 0,
      reason: 'scan cluster gagal: ' + (error?.message || 'unknown error'),
    };
    DEV_CLUSTER_CACHE.set(cacheKey, { fetchedAt: Date.now(), value });
    return value;
  }
}

// Cache per-wallet creator (bukan per-token) — dev yang sama bisa nongol
// lewat token berbeda dalam cycle yang sama/berdekatan, jadi key-nya
// dev.creator_address, bukan address token. TTL diatur lewat
// CFG.devReputationCacheTtlSec (default 0 = cache mati, selalu fetch fresh,
// identik perilaku lama sebelum cache ini ada).
const DEV_REPUTATION_CACHE = new Map();

// Wrapper getGmgnDevReputation() yang menambahkan: (1) gate ON/OFF lewat
// CFG.devReputationEnabled, (2) cache TTL per-wallet, (3) cabang fail-closed
// eksplisit kalau exec gagal TOTAL (created-tokens fetch throw atau return
// kosong -> getGmgnDevReputation tidak sempat membentuk profile apa pun dari
// GMGN sama sekali). Dipanggil dari titik gate MIG, menggantikan pemanggilan
// langsung getGmgnDevReputation(tokenInfo, execFn).
//
// PENTING soal fail-closed: getGmgnDevReputation() di filters.js sendiri
// TIDAK PERNAH throw kalau exec gagal — try/catch terluarnya (eOuter) sudah
// menelan error itu dan tetap balikin profile berisi default awal ('token
// info fallback', Score=50, Status dihitung dari situ). Jadi wrapper ini
// tidak bisa "menangkap" kegagalan exec dari getGmgnDevReputation secara
// langsung. Sebagai gantinya, fail-closed di sini dideteksi dari HASIL
// profile: profile.DataSource === 'token info fallback' berarti fetch
// created-tokens ke GMGN gagal/kosong (baris DataSource cuma diisi
// 'GMGN created-tokens' kalau raw JSON berhasil diparse) — itu sinyal yang
// sama dengan "exec gagal total" yang dimaksud DEV_REPUTATION_FAIL_CLOSED.
function checkDevReputation(tokenInfo, execFn) {
  if (!CFG.devReputationEnabled) {
    return { checked: false, disabled: true, profile: null, reject: false, reason: '' };
  }

  var dev = tokenInfo && tokenInfo.dev;
  var wallet = dev && dev.creator_address ? String(dev.creator_address) : null;

  if (wallet && CFG.devReputationCacheTtlSec > 0) {
    var cached = DEV_REPUTATION_CACHE.get(wallet);
    if (cached && Date.now() - cached.fetchedAt < CFG.devReputationCacheTtlSec * 1000) {
      return cached.value;
    }
  }

  var devRepCfg = {
    minSample: CFG.devReputationMinSample,
    maxDeadFailedPct: CFG.devReputationMaxDeadFailedPct,
    minInnerFail: CFG.devReputationMinInnerFail,
    minSerialLaunches: CFG.devReputationMinSerialLaunches,
    maxScore: CFG.devReputationMaxScore,
    securityScanEnabled: CFG.devReputationSecurityScanEnabled,
    minLogoReuse: CFG.devReputationMinLogoReuse,
  };

  var profile = getGmgnDevReputation(tokenInfo, execFn, devRepCfg);

  var result;
  if (!profile) {
    // creator_address tidak ada sama sekali -> bukan kegagalan exec, gate ini
    // memang tidak bisa dievaluasi. PASS apa adanya (bukan reject), sama
    // seperti perilaku sebelum wrapper ini ada.
    result = { checked: true, disabled: false, profile: null, reject: false, reason: '' };
  } else if (profile.DataSource === 'token info fallback' && CFG.devReputationFailClosed) {
    // Fetch created-tokens ke GMGN gagal/kosong DAN fail-closed dinyalakan ->
    // REJECT, jangan lanjut evaluasi Status dari data minim/default.
    result = {
      checked: true,
      disabled: false,
      profile: profile,
      reject: true,
      reason: 'Dev reputation fail-closed (fetch created-tokens gagal, DEV_REPUTATION_FAIL_CLOSED=true)',
    };
  } else {
    var skipResult = shouldSkipDevReputation(profile);
    result = { checked: true, disabled: false, profile: profile, reject: skipResult.skip, reason: skipResult.reason };
  }

  if (wallet && CFG.devReputationCacheTtlSec > 0) {
    DEV_REPUTATION_CACHE.set(wallet, { fetchedAt: Date.now(), value: result });
  }

  return result;
}

function logDevLaunchCluster(mode, symbol, result) {
  if (result?.disabled) return;
  log('[' + mode + '][DEV CLUSTER] ' + symbol
    + ' wallets=' + Number(result?.walletCount || 0)
    + ' historicalBuy=' + Number(result?.historicalBuyPct || 0).toFixed(1) + '%'
    + (result?.unavailable ? ' unavailable' : '')
    + (result?.supplyUnavailable ? ' supplyUnavailable' : '')
    + (result?.reject ? ' -> REJECT' : ' -> PASS'));
}

// Cek status "Dex Paid" langsung dari field yang sudah tersedia di data
// trenches/trending (t) — tidak perlu network call tambahan sama sekali.
// Field ini didokumentasikan resmi di gmgn-skills SKILL.md (Dexscreener
// Marketing section):
//   dexscr_ad           — Dexscreener ad placed (1 = yes)
//   dexscr_update_link  — Social links updated on Dexscreener (1 = yes)
//   dexscr_trending_bar — Paid for Dexscreener trending bar (1 = yes)
//   dexscr_boost_fee    — Dexscreener boost amount paid (0 = none)
// Token dianggap "paid dex" kalau salah satu dari keempatnya aktif.
function isPaidDex(t) {
  if (!t) return false;
  var ad          = isTruthyFlag(t.dexscr_ad);
  var updateLink  = isTruthyFlag(t.dexscr_update_link);
  var trendingBar = isTruthyFlag(t.dexscr_trending_bar);
  var boostFee    = Number(t.dexscr_boost_fee) > 0;
  return ad || updateLink || trendingBar || boostFee;
}

function fetchCreatorTokens(walletAddress) {
  if (!walletAddress || walletAddress === '?' || walletAddress.length < 30) return null;
  try {
    var out = execSync(
      'npx gmgn-cli portfolio created-tokens --chain sol --wallet ' + walletAddress + ' --raw',
      { encoding: 'utf8', timeout: 10000, env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY || '' } }
    );
    return JSON.parse(out);
  } catch (e) {
    log('[CREATOR COUNT] created-tokens gagal ' + walletAddress.slice(0, 8) + ': ' + e.message);
    return null;
  }
}

// FIX: sebelumnya kalau fetchCreatorTokens() gagal (network/rate-limit/exec
// error), fungsi ini balikin 0 — artinya "creator ini bikin 0 token" dan
// otomatis LOLOS gate serial-creator, padahal yang sebenarnya terjadi adalah
// "gagal cek", bukan "creator bersih". Serial creator adalah salah satu
// sinyal scam terkuat, jadi silent-pass di sini cukup berisiko.
//
// Sekarang fungsi ini balikin { count, unavailable }. unavailable=true berarti
// fetch gagal — bukan berarti count-nya valid 0. Caller (CFG.creatorCountFailClosed,
// default false biar behavior lama tetap jadi default eksplisit, bukan diam-diam)
// yang menentukan mau REJECT atau tetap PASS kalau data gagal diambil, mirip
// pola devClusterFailClosed yang sudah ada.
function getCreatorTokenCount(walletAddress) {
  var response = fetchCreatorTokens(walletAddress);
  if (!response) return { count: 0, unavailable: true };
  var body = response && response.data ? response.data : response;
  if (Array.isArray(body)) return { count: body.length, unavailable: false };
  if (Array.isArray(body.tokens)) return { count: body.tokens.length, unavailable: false };
  return { count: Number(body.open_count) || 0, unavailable: false };
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
      rug_ratio:     (d.rug_ratio === null || d.rug_ratio === undefined || d.rug_ratio === '')
        ? null
        : Number(d.rug_ratio),
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

// ─────────────────────────────────────────────
//  GMGN KLINE — cache + cooldown 429 + throttle antar-request
// ─────────────────────────────────────────────
// Sebelumnya fetchGMGNKline() polos: tanpa cache, tanpa cooldown setelah 429,
// tanpa jeda antar-request. Waktu processTokens() loop token SWING (bisa 20+
// token/cycle, masing2 sampai 3 kandidat resolusi lewat fetchSwingKlines),
// semua request kline ditembak nyaris beruntun — begitu GMGN balikin 429 di
// request pertama/kedua, sisa token di cycle yang sama tetap dicoba satu-satu
// dan ikut kena, karena tidak ada mekanisme yang "sadar" endpoint ini lagi
// di-limit. Tiga lapis fix di bawah, semangatnya sama seperti 4 tier fib lain
// (Birdeye/GeckoTerminal/DexPaprika/Vybe) dan rugCheckThrottle() di atas:
//
//  1) GMGN_KLINE_CACHE — key address+resolution (SENGAJA tidak ikutkan
//     from/to, karena nowSec selalu beda tiap panggilan — kalau ikut jadi
//     key, cache ini tidak akan pernah hit). TTL 90 detik: candle 1H/4H/1D
//     tidak berubah cukup material dalam window sesingkat itu buat mengubah
//     hasil zigzag, jadi aman di-reuse. Hanya hasil SUKSES (termasuk kalau
//     candle-nya sedikit/kosong secara legit) yang di-cache — error/exception
//     TIDAK di-cache, supaya panggilan berikutnya tetap boleh coba lagi.
//  2) Cooldown global — begitu SATU request kline balik 429, SEMUA request
//     kline GMGN berikutnya (address apa pun) otomatis di-skip (return null
//     tanpa nembak network) selama GMGN_KLINE_COOLDOWN_SEC detik. Rate limit
//     GMGN ini sifatnya per API-key/endpoint, bukan per-token — begitu satu
//     token kena, token lain di cycle yang sama nyaris pasti ikut kena, jadi
//     percuma terus dicoba satu-satu per-token.
//  3) gmgnKlineThrottle() — jaga jarak minimal GMGN_KLINE_MIN_INTERVAL_MS
//     antar tiap request kline yang BENERAN nembak network (cache hit /
//     cooldown skip tidak kena jeda ini), pola identik rugCheckThrottle().
const GMGN_KLINE_CACHE_TTL_SEC   = Number(process.env.GMGN_KLINE_CACHE_TTL_SEC)   || 90;
const GMGN_KLINE_COOLDOWN_SEC    = Number(process.env.GMGN_KLINE_COOLDOWN_SEC)    || 180;
const GMGN_KLINE_MIN_INTERVAL_MS = Number(process.env.GMGN_KLINE_MIN_INTERVAL_MS) || 400;

const GMGN_KLINE_CACHE = new Map(); // key: 'address|resolution' -> { fetchedAt, value }
let _gmgnKlineCooldownUntil = 0;    // Date.now() ms saat cooldown berakhir; 0 = tidak cooldown
let _lastGmgnKlineCallAt    = 0;

async function gmgnKlineThrottle() {
  const wait = _lastGmgnKlineCallAt + GMGN_KLINE_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastGmgnKlineCallAt = Date.now();
}

async function fetchGMGNKline(address, resolution, fromSec, toSec) {
  const cacheKey = address + '|' + resolution;
  const cached   = GMGN_KLINE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < GMGN_KLINE_CACHE_TTL_SEC * 1000) {
    return cached.value;
  }

  if (Date.now() < _gmgnKlineCooldownUntil) {
    const remainSec = Math.ceil((_gmgnKlineCooldownUntil - Date.now()) / 1000);
    log('[GMGN KLINE][COOLDOWN] skip ' + address.slice(0, 8) + ' [' + resolution + '] — sisa ' + remainSec + 's');
    return null;
  }

  try {
    await gmgnKlineThrottle();

    const host = process.env.GMGN_HOST || 'https://openapi.gmgn.ai';
    const ts   = Math.floor(Date.now() / 1000);
    const cid  = 'ax' + ts.toString(36) + Math.random().toString(36).slice(2, 10);
    const url  = host + '/v1/market/token_kline?chain=sol&address=' + address
               + '&resolution=' + resolution
               + '&from=' + toUnixMillis(fromSec)
               + '&to='   + toUnixMillis(toSec)
               + '&timestamp=' + ts + '&client_id=' + cid;
    const res  = await axios.get(url, {
      headers: { 'X-APIKEY': process.env.GMGN_API_KEY || '' },
      timeout: 10000,
    });

    // Dulu cuma coba res.data.list — kalau API-nya bungkus payload di level
    // "data" (kayak endpoint trending: d.data.rank), .list bakal selalu
    // undefined dan fungsi ini diam-diam balik null tanpa error sama sekali.
    // Coba dua kemungkinan struktur sekaligus:
    const list = res.data?.list ?? res.data?.data?.list ?? null;

    if (!list || list.length < 3) {
      log('[DEBUG KLINE] ' + address.slice(0, 8)
        + ' [' + resolution + '] — list: ' + (list ? list.length + ' candle' : 'null')
        + ' | raw: ' + JSON.stringify(res.data).slice(0, 400));
    }

    GMGN_KLINE_CACHE.set(cacheKey, { fetchedAt: Date.now(), value: list });
    return list;
  } catch (e) {
    const status = e.response?.status;
    if (status === 429) {
      _gmgnKlineCooldownUntil = Date.now() + GMGN_KLINE_COOLDOWN_SEC * 1000;
      log('[GMGN KLINE][429] Rate limited — cooldown ' + GMGN_KLINE_COOLDOWN_SEC
        + 's diaktifkan, semua request kline GMGN berikutnya di-skip sampai '
        + new Date(_gmgnKlineCooldownUntil).toISOString());
    }
    log('Kline error ' + address.slice(0, 8) + ': ' + e.message);
    return null;
  }
}

// Birdeye OHLCV — sumber candle UTAMA untuk Fibonacci sekarang. GMGN kline
// (fetchGMGNKline di atas) selama ini SELALU balik 0 candle untuk token yang
// baru migrasi/masih muda (lihat log [DEBUG KLINE] ... list: 0 candle di
// screen.log), jadi Fibonacci gak pernah bisa dihitung dari data asli.
// Birdeye API punya endpoint OHLCV yang jauh lebih reliable untuk Solana.
// Resolution Birdeye pakai kode menit: '1', '5', '15', '60', '240', '1D'.
async function fetchBirdeyeKline(address, resolution, fromSec, toSec) {
  const apiKey = process.env.BIRDEYE_API_KEY || '';
  if (!apiKey) {
    if (!fetchBirdeyeKline._warnedNoKey) {
      log('[BIRDEYE] BIRDEYE_API_KEY kosong di .env — Fibonacci akan selalu fallback ke sinyal dasar');
      fetchBirdeyeKline._warnedNoKey = true;
    }
    return null; // tidak dikonfigurasi -> caller fallback ke sinyal dasar
  }
  try {
    const url = 'https://public-api.birdeye.so/defi/ohlcv'
              + '?address=' + address
              + '&type=' + resolution
              + '&time_from=' + Math.floor(fromSec)
              + '&time_to=' + Math.floor(toSec);
    const res = await axios.get(url, {
      headers: {
        'X-API-KEY': apiKey,
        'x-chain': 'solana',
        'accept': 'application/json',
      },
      timeout: 10000,
    });

    const items = res.data?.data?.items ?? null;
    if (!items || items.length < 3) {
      log('[DEBUG BIRDEYE KLINE] ' + address.slice(0, 8)
        + ' — items: ' + (items ? items.length + ' candle' : 'null')
        + ' | raw: ' + JSON.stringify(res.data).slice(0, 400));
      return null;
    }

    log('[BIRDEYE KLINE OK] ' + address.slice(0, 8) + ' — ' + items.length + ' candle (' + resolution + ')');

    // Normalisasi ke bentuk yang sama dipakai fetchGMGNKline: {time, open, high, low, close, volume}
    return items.map(c => ({
      time:   Number(c.unixTime ?? c.time ?? 0),
      open:   Number(c.o ?? c.open),
      high:   Number(c.h ?? c.high),
      low:    Number(c.l ?? c.low),
      close:  Number(c.c ?? c.close),
      volume: Number(c.v ?? c.volume) || 0,
    }));
  } catch (e) {
    log('Birdeye kline error ' + address.slice(0, 8) + ': ' + e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
//  FIBONACCI ZONE — Birdeye candle only
// ─────────────────────────────────────────────
// mode: 'SWING' -> Golden Zone 0.5 - 0.618 dari swing high/low terakhir
//       'MIG'    -> Area agresif 0.382 - 0.5 (New Migration, belum sempat
//                   retrace dalam, jadi zona entry lebih dangkal)
//
// Retracement dihitung dari SWING HIGH turun ke SWING LOW (asumsi uptrend:
// harga baru saja naik dari low ke high, kita tunggu pullback masuk zona
// sebelum entry). fib(r) = swingHigh - (swingHigh - swingLow) * r
const FIB_ZONES = {
  SWING: { lo: CFG.fibSwingLo, hi: CFG.fibSwingHi, label: 'Golden Zone' },
  MIG:   { lo: CFG.fibMigLo,   hi: CFG.fibMigHi,   label: 'Area Agresif' },
};

// mode 'SWING'/'MIG' di sini dipetakan ke mode masing2 sumber: SWING -> 'SWING'
// (candle 1H, 7 hari), MIG -> 'MIG' (candle 5m, 24 jam) — lihat calculateFibFromBirdeye()
// dkk. calcFn adalah salah satu dari calculateFibFromBirdeye/GeckoTerminal/
// DexPaprika/Vybe — semuanya punya signature & bentuk return yang identik,
// jadi fungsi ini generik dan dipakai ulang buat ke-4 tier zigzag.
async function getFibonacciZoneFromZigzag(calcFn, address, currentPrice, mode) {
  const zone = FIB_ZONES[mode] || FIB_ZONES.SWING;
  const price = Number(currentPrice) || 0;

  // floor dipakai tiap sumber buat clamp support/sl biar gak sampai negatif/0
  // di token yang udah anjlok jauh. Pakai 10% dari harga sekarang sbg lantai
  // kasar — cukup buat clamp, gak mempengaruhi hasil kalau range wajar.
  const floor = price > 0 ? price * 0.1 : 0;
  const fibMode = mode === 'SWING' ? 'SWING' : 'MIG';

  const fib = await calcFn(address, fibMode, floor, {
    fibZigzagThresholdSwing: 12,
    fibZigzagThresholdMig: 20,
  });

  if (!fib) return null; // caller lanjut ke tier berikutnya

  const { swingHigh, swingLow } = fib;
  const range = swingHigh - swingLow;
  if (!(range > 0)) return null;

  const plausibility = validateFibZoneAgainstPrice(fib, price);
  if (!plausibility.valid) {
    log('[FIB] Reject ' + String(fib.source || 'unknown') + ' ' + address.slice(0, 8)
      + ' (' + plausibility.reason + ' | harga $' + fmtPrice(price)
      + ' swing $' + fmtPrice(swingLow) + '-$' + fmtPrice(swingHigh) + ')');
    return null;
  }

  // Semua sumber (birdeye/geckoterminal/dexpaprika/vybe) selalu hitung
  // retracement dari swingHigh turun (lihat komentar di calculateFibFromBirdeye)
  // baik leg bullish maupun bearish, jadi zoneTop/zoneBottom di sini tetap
  // konsisten dgn definisi FIB_ZONES lama terlepas dari tier mana yg dipakai.
  const zoneTop    = swingHigh - range * zone.lo;
  const zoneBottom = swingHigh - range * zone.hi;
  const inZone     = price >= zoneBottom && price <= zoneTop;
  const posInRange = ((price - swingLow) / range) * 100;

  return {
    available: true,
    mode,
    label: zone.label,
    source: fib.source, // mis. 'birdeye_1H_bullish', 'geckoterminal_1H_bullish', dst.
    swingHigh,
    swingLow,
    zoneTop,
    zoneBottom,
    inZone,
    posInRange,
    support: Number(fib.support),
    fair:    Number(fib.fair),
    resist:  Number(fib.resist),
    sl:      Number(fib.sl),
  };
}

// Urutan tier zigzag, dicoba berurutan dalam SATU request yang sama sampai
// salah satu berhasil. Tiap entry sudah punya cooldown/cache internal
// masing2 (lihat birdeye.js/geckoterminal.js/dexpaprika.js/vybe.js), jadi
// chain ini cuma orkestrasi urutan coba, bukan retry/backoff sendiri.
// cfgKey nunjuk ke CFG.fibTier* masing2 — dipakai buat skip tier yang
// dimatiin lewat .env (FIB_TIER_BIRDEYE/GECKOTERMINAL/DEXPAPRIKA/VYBE=false).
const FIB_ZIGZAG_TIERS = [
  { name: 'birdeye',       fn: calculateFibFromBirdeye,       cfgKey: 'fibTierBirdeye' },
  { name: 'geckoterminal', fn: calculateFibFromGeckoTerminal, cfgKey: 'fibTierGeckoTerminal' },
  { name: 'dexpaprika',    fn: calculateFibFromDexPaprika,    cfgKey: 'fibTierDexPaprika' },
  { name: 'vybe',          fn: calculateFibFromVybe,          cfgKey: 'fibTierVybe' },
];

async function getFibonacciZone(address, currentPrice, mode) {
  // MASTER SWITCH — kalau fibEnabled OFF, seluruh fitur (zigzag 4-tier +
  // fallback literal max/min di bawah) di-skip total, gak ada request API
  // sama sekali. Dipakai kalau mau matiin fibonacci sepenuhnya dari .env.
  if (!CFG.fibEnabled) {
    return { available: false, reason: 'Fibonacci dimatikan (FIB_ENABLED=false)' };
  }

  // TIER 1-4 — zigzag pivot, coba berurutan: Birdeye -> GeckoTerminal ->
  // DexPaprika -> Vybe. Begitu salah satu sukses, langsung dipakai & sisanya
  // di-skip (gak nembak semua tier tiap kali, biar hemat quota/rate-limit).
  // Tier yang dimatiin lewat CFG.fibTier* di-skip tanpa nyentuh API-nya
  // sama sekali (bukan cuma di-catch sbg gagal).
  // Tiap tier gagal secara independen (network error, quota habis, dll) di-
  // catch per-tier biar 1 tier error gak nge-block chain ke tier berikutnya.
  for (const tier of FIB_ZIGZAG_TIERS) {
    if (CFG[tier.cfgKey] === false) continue; // tier dimatiin manual via .env
    try {
      const zz = await getFibonacciZoneFromZigzag(tier.fn, address, currentPrice, mode);
      if (zz) return zz;
    } catch (e) {
      log('[FIB] Zigzag error (' + tier.name + ') ' + address.slice(0, 8) + ': ' + e.message);
    }
  }

  // TIER 5 — fallback lama: literal Math.max/min candle di window (Birdeye
  // kline). Dipakai kalau ke-4 sumber zigzag di atas semuanya gagal deteksi
  // swing (mis. data kurang / gak ada reversal yg penuhi threshold di semua
  // sumber) supaya fib tetap ada drpd langsung nyerah.
  //
  // Multi-timeframe, coba resolusi pertama dulu lalu fallback ke resolusi
  // kedua kalau candle-nya belum cukup (>=3) — pola sama kayak
  // getSwingKlinePlans() (coarser dulu baru finer / lebih presisi dulu baru
  // yang lebih longgar datanya):
  //   MIG   -> 1m dulu (candle paling presisi, token masih sangat muda),
  //            fallback 5m kalau histori 1m belum cukup.
  //   SWING -> 4H dulu (macro trend), fallback 1H kalau histori 4H kurang.
  const FALLBACK_KLINE_PLANS = {
    MIG: [
      { resolution: '1m', label: '1m', lookbackSec: 3 * 3600 },
      { resolution: '5m', label: '5m', lookbackSec: 12 * 3600 },
    ],
    SWING: [
      { resolution: '4H', label: '4H', lookbackSec: 7 * 86400 },
      { resolution: '1H', label: '1H', lookbackSec: 3 * 86400 },
    ],
  };

  const zone = FIB_ZONES[mode] || FIB_ZONES.SWING;
  const plans = FALLBACK_KLINE_PLANS[mode] || FALLBACK_KLINE_PLANS.SWING;
  const nowSec = Math.floor(Date.now() / 1000);

  let klines = null;
  let usedPlan = null;
  for (const plan of plans) {
    const list = await fetchBirdeyeKline(address, plan.resolution, nowSec - plan.lookbackSec, nowSec);
    if (list && list.length >= 3) {
      klines = list;
      usedPlan = plan;
      break;
    }
    log('[FIB][FALLBACK] ' + plan.label + ' belum cukup candle, coba timeframe berikutnya');
  }

  if (!klines) {
    return { available: false, reason: 'Birdeye kline tidak tersedia (semua timeframe fallback gagal)' };
  }

  const highs = klines.map(c => c.high).filter(v => v > 0);
  const lows  = klines.map(c => c.low).filter(v => v > 0);
  if (highs.length < 3 || lows.length < 3) {
    return { available: false, reason: 'Candle tidak valid setelah cleanup' };
  }

  const swingHigh = Math.max(...highs);
  const swingLow  = Math.min(...lows);
  const range      = swingHigh - swingLow;
  if (range <= 0) {
    return { available: false, reason: 'Swing high/low tidak valid (range 0)' };
  }

  const zoneTop    = swingHigh - range * zone.lo; // rasio lebih kecil = lebih dekat swing high
  const zoneBottom = swingHigh - range * zone.hi;
  const price       = Number(currentPrice) || 0;
  const inZone       = price >= zoneBottom && price <= zoneTop;
  const posInRange   = ((price - swingLow) / range) * 100; // 0% = swing low, 100% = swing high

  return {
    available: true,
    mode,
    label: zone.label,
    source: 'fallback_maxmin_' + usedPlan.label,
    swingHigh,
    swingLow,
    zoneTop,
    zoneBottom,
    inZone,
    posInRange,
    // Level tambahan buat dipajang di pesan: support/fair (dalam zona) & SL (di bawah swing low)
    support: zoneBottom,
    fair:    zoneTop,
    resist:  swingHigh + range * 0.382,
    sl:      Math.max(swingLow - range * 0.272, swingLow * 0.5),
  };
}

// Throttle antar-panggilan RugCheck: jaga jarak minimal antar request supaya
// tidak burst ketika processTokens() loop banyak token dalam satu cycle.
// Ini murni jeda waktu, tidak mengubah token mana yang lolos/skip.
let _lastRugCheckCallAt = 0;
const RUGCHECK_MIN_INTERVAL_MS = Number(process.env.RUGCHECK_MIN_INTERVAL_MS) || 300;
async function rugCheckThrottle() {
  const wait = _lastRugCheckCallAt + RUGCHECK_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRugCheckCallAt = Date.now();
}

async function getRugCheck(ca, insiderThreshold) {
  try {
    await rugCheckThrottle();
    const reportUrl = 'https://api.rugcheck.xyz/v1/tokens/' + ca + '/report';
    const summaryUrl = reportUrl + '/summary';
    const res = await getWithRetry(
      reportUrl,
      { timeout: 10000 },
      undefined,
      'RUGCHECK_DIAG'
    );
    await rugCheckThrottle();
    const summaryRes = await getWithRetry(
      summaryUrl,
      { timeout: 10000 },
      undefined,
      'RUGCHECK_SUMMARY_DIAG'
    );
    const d = mergeRugcheckReports(res.data, summaryRes.data);
    const risksFieldPresent = Object.prototype.hasOwnProperty.call(d || {}, 'risks');
    const risksIsArray = Array.isArray(d?.risks);
    const diagnosticRiskNames = risksIsArray
      ? d.risks.map(r => String(r?.name || '(unnamed)'))
      : [];
    log('[RUGCHECK_DIAG] ca=' + ca
      + ' payloadType=' + (d === null ? 'null' : Array.isArray(d) ? 'array' : typeof d)
      + ' risksPresent=' + risksFieldPresent
      + ' risksType=' + (d?.risks === null ? 'null' : Array.isArray(d?.risks) ? 'array' : typeof d?.risks)
      + ' riskCount=' + (risksIsArray ? d.risks.length : 'N/A')
      + ' riskNames=' + JSON.stringify(diagnosticRiskNames)
      + ' rawScore=' + String(d?.score)
      + ' normalizedScore=' + String(d?.score_normalised)
      + ' sources=report+summary'
      + ' topHoldersCount=' + (Array.isArray(d?.topHolders) ? d.topHolders.length : 'N/A'));
    const riskNames = (d.risks || []).map(r => {
      const lv = r.level ? '[' + r.level.toUpperCase() + '] ' : '';
      return lv + r.name;
    });
    // FIX: dulu pakai MAX per-network (network individual terbesar), jadi
    // insider yang tersebar di beberapa network kecil (mis. 6%+4%=10% total)
    // bisa lolos karena masing-masing di bawah threshold. Sekarang di-SUM
    // semua network — sesuai angka gabungan yang ditampilkan di web
    // rugcheck.xyz ("X tokens sent between insiders (Y% of supply)").
    let totalInsiderPct = 0;
    const insThreshold = insiderThreshold || 10;
    if (d.graphInsidersDetected > 0 && d.insiderNetworks && d.insiderNetworks.length > 0) {
      const totalSupply = d.token?.supply ? Number(d.token.supply) : 0;
      d.insiderNetworks.forEach(net => {
        const pct = totalSupply > 0 ? (net.tokenAmount / totalSupply) * 100 : 0;
        totalInsiderPct += pct;
        if (pct >= insThreshold) {
          riskNames.push('[DANGER] Insider Analysis: ' + Math.round(net.tokenAmount / 1e6) + 'M tokens ('
            + pct.toFixed(0) + '% of supply) | ' + net.size + ' wallets');
        }
      });
    }
    const topDangers = riskNames.filter(n => /\[DANGER\]/i.test(n)).map(n => n.replace(/^\[DANGER\]\s*/i, ''));
    const topWarns   = riskNames.filter(n => /\[WARN\]/i.test(n)).map(n => n.replace(/^\[WARN\]\s*/i, ''));

    // NOTE: dulu di sini ada HARD_SKIP_RISK_NAMES/hardSkipHits (daftar nama
    // risk spesifik) dan dangerCount, keduanya dihitung tapi TIDAK PERNAH
    // dibaca di mana pun setelah di-return — dead code. Gate hard-skip yang
    // BENAR-BENAR berlaku adalah rug.risksArr.length > 0 di titik pemanggilan
    // (MIG/SWING/PENDING_FIB): begitu risks[] berisi apa pun, apa pun levelnya
    // (warn/danger) dan apa pun namanya, token langsung skip — jadi otomatis
    // sudah mencakup (dan lebih ketat dari) daftar nama spesifik itu. Sudah
    // dihapus supaya tidak ada dua "sumber kebenaran" untuk hal yang sama.

    // FIX: dulu top10 holder cuma ketangkep KALAU RugCheck kebetulan
    // mengeluarkan risk item bernama "top 10 holders high ownership" di
    // d.risks[]. Kalau skor keseluruhan "Good", risk itu sering nggak
    // muncul walau angka top-holder-nya tetap tinggi (contoh nyata: token
    // dengan score_normalised=1 "Good" tapi top10 holder = 44.72%, risks[]
    // kosong sama sekali). Sekarang dihitung LANGSUNG dari d.topHolders
    // (field numerik, independen dari ada/tidaknya risk item), supaya gate
    // top10 selalu jalan terlepas dari apa yang RugCheck putuskan untuk
    // di-flag di risks[].
    //
    // FIX #2 (bug Kairos): d.topHolders.slice(0,10) dulu ikut menghitung
    // akun AMM/pool (mis. Pump Fun AMM) sebagai "holder", jadi angkanya
    // ke-inflate (34.47% padahal holder asli cuma 21.42%, sisanya 14.63%
    // punya AMM). Sekarang akun AMM & LOCKER dikeluarkan dulu berdasarkan
    // d.knownAccounts SEBELUM ambil 10 holder terbesar. CREATOR tetap
    // dihitung karena dia tetap wallet yang bisa dump.
    const top10PctRugcheck = calculateRugcheckTopHoldersPct(d.topHolders, d.knownAccounts);
    // Pct per-rank individual (holder #1, #2, #3, #4) dari sumber data yang
    // SAMA dengan top10PctRugcheck di atas (sudah exclude AMM/LOCKER, sudah
    // sorted besar->kecil) — dipakai gate MAX_HOLDER_1..4_PCT.
    const rankedHolderPcts = getRankedRugcheckHolderPcts(d.topHolders, d.knownAccounts);
    // DIAGNOSTIC: log holder RAW (sebelum exclude AMM/LOCKER) vs hasil FILTERED
    // (rankedHolderPcts, yang dipakai gate) berdampingan — supaya kelihatan
    // persis wallet mana yang ter-exclude dan kenapa (type AMM/LOCKER dari
    // d.knownAccounts), khusus kalau ranking #1 RAW beda jauh dari #1 FILTERED
    // (indikasi exclude AMM lagi motong angka besar).
    if (Array.isArray(d.topHolders) && d.topHolders.length > 0) {
      const rawSorted = d.topHolders.slice()
        .sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0));
      const rawTop1 = Number(rawSorted[0]?.pct) || 0;
      const filteredTop1 = Number(rankedHolderPcts[0]) || 0;
      if (Math.abs(rawTop1 - filteredTop1) > 0.5) {
        const known = d.knownAccounts || {};
        const excludedWallets = rawSorted.filter(h => {
          const info = known[h.owner] || known[h.address];
          return info && ['AMM', 'LOCKER'].includes(String(info.type || '').toUpperCase());
        }).map(h => {
          const info = known[h.owner] || known[h.address];
          const addr = String(h.owner || h.address || '?');
          return addr.slice(0, 6) + '...' + ' pct=' + Number(h.pct || 0).toFixed(2) + '% type=' + info.type + ' name=' + (info.name || '?');
        });
        log('[HOLDER_DIAG] ca=' + ca + ' rawTop1=' + rawTop1.toFixed(2) + '% filteredTop1=' + filteredTop1.toFixed(2)
          + '% excluded=[' + excludedWallets.join(' | ') + ']');
      }
    }

    return {
      // FIX: dulu pakai d.score (raw, skala tidak konsisten — bisa ribuan).
      // Sekarang pakai d.score_normalised (skala 0-100, sama seperti yang
      // ditampilkan di web rugcheck.xyz). Fallback ke d.score kalau field
      // tidak ada di response (mis. API berubah).
      score:              d.score_normalised ?? d.score ?? 0,
      rawScore:           d.score ?? 0,
      risks:              riskNames.join(', '),
      risksArr:           d.risks || [],
      creator:            d.creator || d.owner || '?',
      topDangers:         topDangers,
      topWarns:           topWarns,
      tokenType:          d.tokenType || '',
      rugged:             d.rugged || false,
      deployPlatform:     d.deployPlatform || '',
      // Total insider (SUM semua network, bukan max satu network — lihat
      // komentar FIX di atas).
      insiderPct:         totalInsiderPct,
      // Top-10 holder % LANGSUNG dari RugCheck (independen dari risks[]).
      top10PctRugcheck:   top10PctRugcheck,
      // Pct per-rank individual holder #1-#4 (array, sorted besar->kecil),
      // dipakai gate MAX_HOLDER_1..4_PCT.
      rankedHolderPcts:   rankedHolderPcts,
    };
  } catch {
    return { score: 999, rawScore: 0, risks: 'Fetch failed', risksArr: [], creator: '?',
             topDangers: [], topWarns: [], tokenType: '', rugged: false,
             deployPlatform: '', insiderPct: 0, top10PctRugcheck: 0, rankedHolderPcts: [] };
  }
}

const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED !== 'false';

async function sendTelegram(msg, replyTo, threadId) {
  if (!TELEGRAM_ENABLED) {
    log('[TG SKIP] TELEGRAM_ENABLED=false, pesan tidak dikirim: ' + msg.slice(0, 60).replace(/\n/g, ' ') + '...');
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




// ─────────────────────────────────────────────
//  KLASIFIKASI & SCORING
// ─────────────────────────────────────────────
function isMigratedDex(t) {
  return t.exchange && t.exchange !== 'pump';
}

// Gate anti-kemahalan khusus mode PREPUMP (New Migration). PREPUMP tidak
// pakai Fibonacci zone sebagai gate harga, jadi tanpa ini bot bisa beli
// token yang harganya sudah dipompa duluan oleh sniper/bot lain sebelum
// sempat terdeteksi & dieksekusi.
//
// Bandingkan currentPrice terhadap refPrice (harga pertama kali token
// terlihat, disimpan di SEEN[addr].prepumpRefPrice). Kalau kenaikannya
// (dalam %) > maxPumpPct -> block (jangan beli sekarang).
//
// maxPumpPct <= 0 (atau bukan angka valid) -> gate MATI total (active:false),
// dianggap sebagai "fitur di-nonaktifkan lewat .env" (MIG_MAX_PUMP_PCT=).
// Gate momentum 5 menit khusus PREPUMP — lihat komentar CFG.migMaxPriceChange5m
// untuk kenapa gate ini perlu, terpisah dari checkPrepumpPriceGate() di atas.
//
// change5mPct: persentase perubahan harga 5 menit terakhir DARI SUMBER DATA
// (GMGN price_change_percent5m), BUKAN dihitung dari refPrice bot sendiri.
// Ini nangkep pump yang udah kejadian SEBELUM bot sempat lihat token-nya.
//
// maxChange5mPct <= 0 -> gate MATI (active:false).
function checkRecentMomentumGate(change5mPct, maxChange5mPct) {
  if (!(Number(maxChange5mPct) > 0)) return { active: false, block: false, pct: null, reason: null };
  // Fail-open: field ini kadang null/tidak ada dari GMGN (token super baru
  // belum punya histori 5 menit) — jangan block kalau datanya nggak ada,
  // biar gate lain yang jadi penentu.
  if (change5mPct == null || !Number.isFinite(Number(change5mPct))) {
    return { active: true, block: false, pct: null, reason: 'data price_change_percent5m tidak tersedia' };
  }
  var pct = Number(change5mPct);
  var block = pct > Number(maxChange5mPct);
  return {
    active: true,
    block: block,
    pct: pct,
    reason: block
      ? 'harga sudah naik +' + pct.toFixed(1) + '% dalam 5 menit terakhir (batas ' + maxChange5mPct + '%) — kemungkinan sudah dipompa sebelum sempat terdeteksi'
      : null,
  };
}

function checkPrepumpPriceGate(currentPrice, refPrice, maxPumpPct) {
  if (!(Number(maxPumpPct) > 0)) return { active: false, block: false, pumpPct: null, reason: null };
  // Fail-open: kalau salah satu harga tidak valid (data belum sempat
  // kesimpan / API gagal), jangan block — biarkan gate lain yang jadi
  // penentu, supaya bug harga tidak diam-diam mengunci semua token PREPUMP.
  if (!(Number(refPrice) > 0) || !(Number(currentPrice) > 0)) {
    return { active: true, block: false, pumpPct: null, reason: 'harga referensi/current tidak tersedia' };
  }
  var pumpPct = ((Number(currentPrice) - Number(refPrice)) / Number(refPrice)) * 100;
  var block = pumpPct > Number(maxPumpPct);
  return {
    active: true,
    block: block,
    pumpPct: pumpPct,
    reason: block
      ? 'harga sudah naik +' + pumpPct.toFixed(1) + '% dari referensi $' + fmtPrice(refPrice)
        + ' (batas ' + maxPumpPct + '%)'
      : null,
  };
}

function gradeToken(lp, vol, rugScore) {
  let score = 0;
  if (lp > 100000) score += 35; else if (lp > 50000) score += 25; else if (lp > 30000) score += 15;
  if (vol > 100000) score += 35; else if (vol > 50000) score += 25; else if (vol > 10000) score += 15;
  if (rugScore < 50) score += 30; else if (rugScore < 100) score += 20; else score -= 10;
  if (score >= 90) return 'PLATINUM';
  if (score >= 75) return 'GOLD';
  if (score >= 60) return 'SILVER';
  return 'SKIP';
}

function getGradeMeta(grade) {
  if (grade === 'PLATINUM') return { emoji: '💎', riskLabel: 'Grade A' };
  if (grade === 'GOLD') return { emoji: '🥇', riskLabel: 'Grade B' };
  if (grade === 'SILVER') return { emoji: '🥈', riskLabel: 'Grade C' };
  return { emoji: '🔴', riskLabel: 'Grade D' };
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
//  SWING MULTI-TIMEFRAME — ANALISA PRE-PUMP
// ─────────────────────────────────────────────

/**
 * Token <72 jam: 4H -> 1H. Token lebih tua: 1D -> 4H -> 1H.
 * Return candle valid pertama; null jika semua timeframe belum tersedia.
 */
async function fetchSwingKlines(address, ageHours) {
  await new Promise(r => setTimeout(r, 500));
  const nowSec = Math.floor(Date.now() / 1000);
  const plans = getSwingKlinePlans(ageHours);

  for (const plan of plans) {
    const list = await fetchGMGNKline(
      address,
      plan.resolution,
      nowSec - plan.lookbackSec,
      nowSec
    );
    const candles = (list || [])
      .map(c => ({
        time:   toUnixSeconds(c.time ?? c.timestamp ?? c.t ?? 0),
        close:  Number(c.close),
        high:   Number(c.high),
        low:    Number(c.low),
        volume: Number(c.volume) || 0,
      }))
      .filter(c => c.time > 0 && c.close > 0 && c.high > 0 && c.low > 0)
      .sort((a, b) => a.time - b.time);

    if (candles.length >= 3) {
      log('[SWING][KLINE] ' + plan.label + ' tersedia (' + candles.length + ' candle)');
      return { candles, ...plan };
    }
    log('[SWING][KLINE] ' + plan.label + ' belum cukup (' + candles.length + ' candle valid), coba timeframe berikutnya');
  }
  return null;
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
  // Fail-safe: kalau data holder_count tidak tersedia dari API, anggap TIDAK
  // lolos (bukan di-skip diam-diam). Lebih aman treat "data tidak ada" sebagai
  // gagal daripada asumsikan token lolos gate ini tanpa verifikasi.
  if (holders === null) {
    log('[SWING] ' + (t.symbol || '?') + ': holder_count tidak tersedia dari API, gate holder GAGAL (fail-safe)');
    return { pass: false, reason: 'Data holder tidak tersedia dari API (fail-safe)' };
  }
  if (holders < CFG.swingMinHolders)
    return { pass: false, reason: 'Holder terlalu sedikit (' + holders + ')' };

  // — Gate wajib minimal 1 social media (Twitter/Telegram/Website) —
  const socialCheck = checkHasSocial(t, CFG.requireSocial);
  if (socialCheck.skip) return { pass: false, reason: socialCheck.reason };

  // — Gate 6: Buy ratio minimal (override via SWING_MIN_BUY_RATIO di .env) —
  const totalTxn = (t.buys || 0) + (t.sells || 0);
  const buyRatio = totalTxn > 0 ? (t.buys / totalTxn) * 100 : 0;
  if (totalTxn > 0 && buyRatio < CFG.swingMinBuyRatio)
    return { pass: false, reason: 'Buy ratio lemah (' + buyRatio.toFixed(0) + '% buy < ' + CFG.swingMinBuyRatio + '%)' };

  // — Analisa Kline adaptif untuk konfirmasi sinyal —
  const klineData = await fetchSwingKlines(t.address, ageH);
  if (!klineData) {
    log('[SWING][KLINE] WAIT ' + t.symbol + ' — 1D/4H/1H belum tersedia, scan ulang cycle berikutnya');
    return { pass: false, reason: 'Kline 1D/4H/1H belum tersedia (WAIT, akan scan ulang)' };
  }

  const signals = [];
  const candles = klineData.candles;
  const klineLabel = klineData.label;
  const candleIntervalSec = klineData.intervalSec;
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const histVols = candles.slice(0, -1).map(c => c.volume).filter(v => v > 0);
  const avgVol = histVols.length > 0 ? histVols.reduce((a, b) => a + b, 0) / histVols.length : 0;

  // Candle terakhir bisa belum closed. Normalisasi sesuai panjang timeframe
  // terpilih: 1D=86400s, 4H=14400s, 1H=3600s.
  const nowSec = Math.floor(Date.now() / 1000);
  const candleElapsedSec = Math.max(nowSec - lastCandle.time, 0);
  const candleFraction = Math.min(
    Math.max(candleElapsedSec / candleIntervalSec, CFG.swingDayFractionFloor),
    1
  );
  const normLastVol = lastCandle.volume / candleFraction;

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const swingHigh = Math.max(...highs);
  const swingLow = Math.min(...lows);
  const priceRange = swingHigh - swingLow;

  // Volume spike tetap gate wajib pada timeframe yang berhasil dibaca.
  const volSpike = avgVol > 0 ? normLastVol / avgVol : 1;
  if (volSpike < CFG.swingVolSpikeMin) {
    return { pass: false, reason: 'Tidak ada vol spike ' + klineLabel + ' (hanya '
      + volSpike.toFixed(1) + 'x, candle baru ' + (candleFraction * 100).toFixed(0) + '% jalan)' };
  }
  signals.push('Vol spike ' + klineLabel + ' ' + volSpike.toFixed(1)
    + 'x rata-rata (normalized, candle ' + (candleFraction * 100).toFixed(0) + '% jalan)');

  if (priceRange > 0) {
    const posInRange = (lastCandle.close - swingLow) / priceRange;
    if (posInRange <= CFG.swingSupportMaxRangePct) {
      signals.push('Harga dekat support (' + (posInRange * 100).toFixed(0) + '% dari range)');
    } else if (posInRange >= CFG.swingWarnHighRangePct) {
      signals.push('[WARN] Harga sudah tinggi di range (' + (posInRange * 100).toFixed(0) + '%)');
    }
  }

  if (lastCandle.close > prevCandle.close) {
    signals.push('Green candle ' + klineLabel + ' ('
      + ((lastCandle.close / prevCandle.close - 1) * 100).toFixed(1) + '%)');
  }

  if (swingLow > 0 && priceRange / swingLow < CFG.swingMaxConsolidationRangeRatio) {
    signals.push('Konsolidasi ' + klineLabel + ' (range '
      + (priceRange / swingLow * 100).toFixed(0) + '%)');
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
          support: Math.max(swingHigh - range * 0.500, floor).toFixed(10),
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

// ─────────────────────────────────────────────
//  BUILD MESSAGE
// ─────────────────────────────────────────────
async function buildMsg(t, rug, grade, dex24h, mode, swingSignals, fibZone) {
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
  var gradeMeta  = getGradeMeta(grade);
  var gradeEmoji = gradeMeta.emoji;
  var riskLabel  = gradeMeta.riskLabel;

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
  msg += re + ' RugCheck: ' + rug.score + ' (' + rugLabel + ')';
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

  // Fibonacci zone — Golden Zone (Swing) atau Area Agresif (Migration).
  // Bukan gate keras: kalau di luar zona tetap tampil, cuma dikasih [WARNING].
  if (fibZone && fibZone.available) {
    var fibHeader = '📐 <b>Fibonacci ' + fibZone.label + ':</b>';
    if (!fibZone.inZone) fibHeader += ' ⚠️ [WARNING di luar zona]';
    msg += fibHeader + '\n';
    msg += '  • Posisi harga: ' + fibZone.posInRange.toFixed(0) + '% dari range (Low-High)\n';
    msg += '  • Zona target : $' + fmtPrice(fibZone.zoneBottom) + ' – $' + fmtPrice(fibZone.zoneTop) + '\n';
    msg += '  • Support     : $' + fmtPrice(fibZone.support) + '\n';
    msg += '  • Resist      : $' + fmtPrice(fibZone.resist) + '\n';
    msg += '  • Stop Loss   : $' + fmtPrice(fibZone.sl) + '\n';
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

  var dynScore = calculateScore(t, rug);
  msg += 'Score: ' + dynScore + '/100\n';

  // Auto-warnings
  var warnings = [];
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
  var re = t.rug_ratio == null ? '❓' : (asPct(t.rug_ratio) < 50 ? '✅' : '🚨');
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
  msg += re + ' Rug     : ' + (t.rug_ratio == null ? 'N/A' : Math.round(asPct(t.rug_ratio))) + '\n';
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
  const cycleId = ++screeningCycleId;
  for (const [address, state] of MIG_RUG_CONFIRM) {
    if (!state || state.lastCycle < cycleId - 1) MIG_RUG_CONFIRM.delete(address);
  }
  for (const [address, state] of SWING_RUG_CONFIRM) {
    if (!state || state.lastCycle < cycleId - 1) SWING_RUG_CONFIRM.delete(address);
  }
  log('========== SCREENING ==========');
  // Dua sumber terpisah: trenches `completed` untuk New Migration, trending untuk Swing 1D.
  var migrationTokens = screenModeAllows(CFG.screenMode, 'NEW') ? fetchGmgnTrenches() : [];
  var swingTokens     = screenModeAllows(CFG.screenMode, 'SWING') ? fetchGmgnTrending() : [];
  latestMigrationSnapshotByAddress = new Map(
    migrationTokens.filter(t => t.address).map(t => [t.address, t])
  );
  latestSwingSnapshotByAddress = new Map(
    swingTokens.filter(t => t.address).map(t => [t.address, t])
  );

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
      if (isPermanentSafetyLock(seenEntry)) continue;

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
  var signalTokens = CFG.screenMode === 'ALL' && CFG.signalEnabled ? fetchGmgnSignal() : [];
  var signalCandidates = normalizeSignal(signalTokens);
  // Skip token yg udah pernah dilihat (dari mode manapun)
  var uniqueSignal = [];
  for (var i = 0; i < signalCandidates.length; i++) {
    if (!SEEN.has(signalCandidates[i].address)) uniqueSignal.push(signalCandidates[i]);
  }

  log('New Migration candidates: ' + newMigration.length);
  log('Swing 1D candidates: ' + swingCandidates.length);
  log('Signal candidates: ' + uniqueSignal.length);

  let buyCount = 0;

  // — Proses New Migration V2 (6 base gates only) —
  for (let i = 0; i < newMigration.length; i++) {
    const t = newMigration[i];
    var migGmgnRugScore = (t.rug_ratio == null || t.rug_ratio === '')
      ? 'N/A'
      : asPct(t.rug_ratio).toFixed(1) + '%';
    log('[MIG][GMGN Rug] Cek ' + t.symbol + ' (score=' + migGmgnRugScore + ', max=' + CFG.gmgnRugMaxRatio + '%)');
    var migGmgnCheck = checkRugRatio(t.rug_ratio, CFG.gmgnRugMaxRatio);
    if (migGmgnCheck.skip) {
      MIG_RUG_CONFIRM.delete(t.address);
      log('SKIP [MIG][GMGN Rug] ' + t.symbol + ' (' + migGmgnCheck.reason + ')');
      continue;
    }

    var migRugConfirmation = nextConsecutiveConfirmation(MIG_RUG_CONFIRM.get(t.address), cycleId);
    MIG_RUG_CONFIRM.set(t.address, migRugConfirmation);
    if (migRugConfirmation.count < CFG.migGmgnRugConfirmScans) {
      log('[MIG][GMGN Rug] WAIT ' + t.symbol + ' (konfirmasi '
        + migRugConfirmation.count + '/' + CFG.migGmgnRugConfirmScans + ' scan berturut-turut)');
      continue;
    }
    MIG_RUG_CONFIRM.delete(t.address);

    // NOTE: fetch ini dipakai bareng utk banyak keperluan (vol1h, holder_count,
    // data dev reputation, dst) — BUKAN eksklusif untuk gate dev cluster. Jadi
    // baris log ini tetap muncul walau DEV_CLUSTER_FILTER_ENABLED=false; itu
    // normal, bukan tanda gate dev-cluster masih aktif. Gate dev-cluster yang
    // sebenarnya (checkDevLaunchCluster di bawah) langsung skip proses &
    // TIDAK menghasilkan baris log [DEV CLUSTER] sama sekali kalau di-OFF-kan.
    log('[MIG] Fetch info ' + t.symbol + ' (data umum token, dipakai banyak gate — bukan cuma dev cluster)...');
    const tokenInfo = fetchTokenInfo(t.address);
    if (!tokenInfo) {
      log('SKIP [MIG] ' + t.symbol + ' (Gagal fetch token info)');
      continue;
    }

    var migDevCluster = checkDevLaunchCluster(t.address, tokenInfo);
    logDevLaunchCluster('MIG', t.symbol, migDevCluster);
    if (migDevCluster.reject) {
      log('SKIP [MIG][DEV CLUSTER] ' + t.symbol + ' (' + migDevCluster.reason + ')');
      SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'migration', lockedReason: 'dev_cluster' });
      continue;
    }

    // BUGFIX: data trenches (t) TIDAK PERNAH punya field social media maupun
    // holder_count — field-field itu hanya ada di respons fetchTokenInfo():
    // twitter_username/website/telegram ada di tokenInfo.link.*, holder_count
    // ada di tokenInfo.holder_count (root). Sebelumnya checkHasSocial() dan
    // checkMinHolders() membaca dari `t`, yang selalu undefined utk field ini,
    // jadi SEMUA token New Migration ke-skip walau sosmed/holder-nya lengkap
    // (contoh nyata: HOME token, twitter_username "pumpfunishome" ada di
    // tokenInfo.link tapi t.twitter_username selalu undefined).
    if (tokenInfo.link) {
      t.twitter_username = tokenInfo.link.twitter_username || t.twitter_username;
      t.website          = tokenInfo.link.website          || t.website;
      t.telegram         = tokenInfo.link.telegram         || t.telegram;
    }
    if (tokenInfo.holder_count != null) {
      t.holder_count = tokenInfo.holder_count;
    }

    // Gunakan filter baru untuk cek LP, age, vol1h, swaps5m, vol5m, plus gate
    // hard-risk (bundler/top10/devhold/sniper/volLp/rugRatio/phishing),
    // price change 1h, min holders, dan wajib social media.
    // PENTING: migCfg sebelumnya cuma bawa 5 field, jadi semua gate baru di
    // shouldSkipNewMigration() menerima cfg.xxx === undefined dan otomatis
    // tidak pernah aktif meski kode filternya sudah benar. Sekarang semua
    // field CFG yang relevan disertakan.
    var migCfg = {
      minLp:            CFG.minLp,
      maxAgeHours:      CFG.maxAgeHours,
      minVol1h:         CFG.minVol1h,
      minSwaps5m:       CFG.minSwaps5m,
      minVol5m:         CFG.minVol5m,
      maxBundlerPct:    CFG.maxBundlerPct,
      maxTop10Holders:  CFG.maxTop10Holders,
      maxDevHold:       CFG.maxDevHold,
      maxSniperPct:     CFG.maxSniperPct,
      maxVolLpRatio:    CFG.maxVolLpRatio,
      gmgnRugMaxRatio:  CFG.gmgnRugMaxRatio,
      maxInsiderPct:    CFG.maxInsiderPct,
      maxPhishingPct:   CFG.maxPhishingPct,
      maxPriceChange1h: CFG.maxPriceChange1h,
      minHoldersMig:    CFG.minHoldersMig,
      requireSocial:    CFG.requireSocial,
      maxCreatorTokens: CFG.maxCreatorTokens,
      // Fix: sebelumnya field hard-risk yang null/undefined dari GMGN (bundler,
      // top10, devHold, sniper, insider, phishing) diam-diam dianggap "0% risk"
      // tanpa jejak log. Sekarang tiap field kosong di-log sebagai WARNING,
      // supaya kelihatan kalau API berubah/field ilang — bukan silently pass.
      onMissingHardRiskData: function (warnings) {
        log('[MIG][DATA MISSING] ' + t.symbol + ' -> ' + warnings.join(' | '));
      },
    };
    var migResult = shouldSkipNewMigration(t, tokenInfo, migCfg);
    if (migResult.skip) {
      log('SKIP [MIG] ' + t.symbol + ' (' + migResult.reason + ')');
      continue;
    }

    // — Gate buy ratio (MIN_BUY_RATIO, default 0 = gate off) —
    // Sebelumnya CFG.minBuyRatio didefinisikan tapi tidak pernah dicek di mana pun.
    if (CFG.minBuyRatio > 0) {
      var migTotalTxn = (t.buys || 0) + (t.sells || 0);
      var migBuyRatio = migTotalTxn > 0 ? (t.buys / migTotalTxn) * 100 : 0;
      if (migTotalTxn > 0 && migBuyRatio < CFG.minBuyRatio) {
        log('SKIP [MIG] ' + t.symbol + ' (Buy ratio ' + migBuyRatio.toFixed(0) + '% < ' + CFG.minBuyRatio + '%)');
        continue;
      }
    }

    // Cek paid DEX langsung dari field dexscr_* di data trenches (tanpa network call)
    var paidDex = isPaidDex(t);
    if (!paidDex) {
      log('SKIP [MIG] ' + t.symbol + ' (Belum paid DEX)');
      continue;
    }

    // RugCheck — filter identik dengan Swing 1D
    log('[MIG][RugCheck.xyz] Cek ' + t.symbol + '...');
    const rug = await getRugCheck(t.address, CFG.maxInsiderPct);
    // HARD SKIP:
    // - FIX: gate rawScore DIHAPUS. d.score (raw) dari RugCheck API skalanya
    //   TIDAK konsisten 0-100 — bisa ribuan/puluhan-ribu bahkan untuk token
    //   legit (contoh nyata publik: token besar dengan raw score >18000
    //   padahal secara normalized "Good"). Membandingkan rawScore ke ceiling
    //   kecil (dulu hardcoded 1) salah kalibrasi total dan bisa mereject
    //   token yang aman hanya karena API kebetulan mengembalikan raw score
    //   besar untuk token itu — tidak mencerminkan risiko sebenarnya.
    // - score_normalised (skala resmi 0-100 versi rugcheck.xyz, SEMAKIN
    //   RENDAH SEMAKIN AMAN) dibandingkan ke CFG.maxRugScore dari .env
    //   (MAX_RUG_SCORE), BUKAN hardcoded 1 seperti sebelumnya. Threshold di
    //   .env sekarang benar-benar dipakai.
    // - risks array harus kosong (Tidak ada) — TIDAK DIUBAH, tetap paling ketat.
    // Selain itu: langsung skip, tanpa pengecualian.
    if (rug.score > CFG.maxRugScore) {
      log('SKIP [MIG][RugCheck.xyz] ' + t.symbol + ' (score_normalised=' + rug.score + ', max=' + CFG.maxRugScore + ')');
      SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'migration', lockedReason: 'rug_score_normalised' });
      continue;
    }
    if (rug.risksArr.length > 0) {
      log('SKIP [MIG][RugCheck.xyz] ' + t.symbol + ' (ada ' + rug.risksArr.length + ' risks: ' + rug.risks + ')');
      SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'migration', lockedReason: 'rug_risks_present' });
      continue;
    }
    if (rug.insiderPct > CFG.maxInsiderPct) {
      log('SKIP [MIG][RugCheck.xyz] ' + t.symbol + ' (Insider ' + rug.insiderPct.toFixed(0) + '% > ' + CFG.maxInsiderPct + '%)');
      continue;
    }
    // Gate top10 holder LANGSUNG dari RugCheck (d.topHolders), terpisah dari
    // risks[] — supaya tetap ketangkep walau RugCheck tidak mengeluarkan
    // risk item "top 10 holders high ownership" untuk token ini.
    if (rug.top10PctRugcheck > CFG.maxTop10HoldersRugcheck) {
      log('SKIP [MIG][RugCheck.xyz] ' + t.symbol + ' (Top10 ' + rug.top10PctRugcheck.toFixed(1) + '% > ' + CFG.maxTop10HoldersRugcheck + '%)');
      continue;
    }
    // Gate holder INDIVIDUAL (rank 1-4, terpisah dari top10 gabungan di
    // atas) — lihat komentar MAX_HOLDER_1..4_PCT di CFG. Rank yang tidak
    // di-set di .env otomatis di-skip dari pengecekan.
    var indivHolderMig = checkIndividualTopHolders(rug.rankedHolderPcts, {
      holder1: CFG.maxHolder1Pct, holder2: CFG.maxHolder2Pct,
      holder3: CFG.maxHolder3Pct, holder4: CFG.maxHolder4Pct,
    });
    if (indivHolderMig.skip) {
      log('SKIP [MIG][RugCheck.xyz] ' + t.symbol + ' (' + indivHolderMig.reason + ')');
      continue;
    }

    // — Gate dev reputation (ganti total gate lama "jumlah token creator >
    // maxCreatorTokens"). Porting penuh dari Get-GmgnDevReputation (profile
    // PS1) lewat getGmgnDevReputation() di filters.js — Survival, InnerCount,
    // AthMc, LogoReuse, SecurityBad, Exited, Cto, RugRate, dan skor/status/
    // confidence gabungan, bukan cuma hitung jumlah launch mentah seperti
    // sebelumnya. tokenInfo di sini adalah sumber yang sama persis dengan
    // $info di PS1 (fetchTokenInfo() = `gmgn-cli token info --raw`), jadi
    // tokenInfo.dev.* identik dengan $info.dev.* PS1 tanpa perlu mapping ulang.
    //
    // Keputusan skip (bukan bagian dari PS1, PS1 murni tool tampilan manual):
    // skip HANYA kalau Status = 'BAD REPUTATION' atau 'HIGH RISK', sesuai pola
    // warna merah di gmgn() PS1. Status lain (NEW DEV/DATA MINIM, MIXED/
    // UNKNOWN, GOOD HISTORY) tetap lolos gate ini.
    //
    // Kalau tokenInfo.dev.creator_address tidak ada, getGmgnDevReputation()
    // balikin null (persis PS1 `return $null`) — diperlakukan sebagai "data
    // dev tidak tersedia", PASS gate ini apa adanya (bukan reject), karena
    // tanpa creator_address gate ini secara definisi tidak bisa dievaluasi
    // sama sekali (beda dari kasus fetch created-tokens gagal di dalam
    // getGmgnDevReputation, yang tetap balikin profile dgn DataSource
    // 'token info fallback' dan tetap dievaluasi/di-skip seperlunya).
    //
    // checkDevReputation() (definisi di atas, dekat DEV_REPUTATION_CACHE)
    // membungkus getGmgnDevReputation()+shouldSkipDevReputation() dengan:
    // saklar CFG.devReputationEnabled, cache TTL per-wallet
    // (CFG.devReputationCacheTtlSec), dan cabang fail-closed eksplisit
    // (CFG.devReputationFailClosed) untuk kasus DataSource='token info
    // fallback' di atas. Threshold skor/status (minSample, maxDeadFailedPct,
    // dst) dioper sebagai cfg ke getGmgnDevReputation() dari CFG.devReputation*
    // (baca 9 env var DEV_REPUTATION_*).
    log('[MIG] Cek dev reputation ' + t.symbol + '...');
    var devRepExecFn = function (cmd) {
      return execSync(cmd, {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY || '' },
      });
    };
    var devRepCheck = checkDevReputation(tokenInfo, devRepExecFn);
    if (devRepCheck.disabled) {
      log('[MIG][DEV REP] ' + t.symbol + ' -> disabled (DEV_REPUTATION_ENABLED=false)');
    } else if (devRepCheck.profile) {
      var devRep = devRepCheck.profile;
      log('[MIG][DEV REP] ' + t.symbol + ' -> Score=' + devRep.Score + '/100 Status=' + devRep.Status
        + ' Confidence=' + devRep.Confidence
        + (devRep.DataSource === 'token info fallback' ? ' DataSource=fallback' : '')
        + (devRep.Reasons.length > 0 ? ' Reasons=[' + devRep.Reasons.join('; ') + ']' : ''));
      if (devRepCheck.reject) {
        log('SKIP [MIG] ' + t.symbol + ' (' + devRepCheck.reason + ')');
        continue;
      }
    } else {
      log('[MIG][DEV REP] ' + t.symbol + ' -> N/A (creator_address tidak tersedia di token info)');
    }

    if (CFG.migAppFilterEnabled) {
      var appStyle = evaluateAppStyleMigration(t, tokenInfo,
        devRepCheck.profile && Number.isFinite(Number(devRepCheck.profile.Eval)) ? Number(devRepCheck.profile.Eval) : 0.5, {
          maxBuyTaxPct: CFG.migMaxBuyTaxPct, maxSellTaxPct: CFG.migMaxSellTaxPct,
          maxBotDegenPct: CFG.migMaxBotDegenPct, minSmartMoneyConfluence: CFG.migMinSmartMoneyConfluence,
          maxCreatorTokens: CFG.maxCreatorTokens, momentumReject1h: -0.12, momentumReject5m: -0.06,
          buyRatioReject: 0.42, buyRatioPass: 0.50, minConviction: CFG.migMinConviction,
          minPriority: CFG.migMinPriority,
        });
      log('[MIG][APP FILTER] ' + t.symbol + ' -> verdict=' + (appStyle.verdict || 'gate')
        + ' conviction=' + (appStyle.conviction == null ? 'N/A' : appStyle.conviction)
        + ' priority=' + (appStyle.priority == null ? 'N/A' : appStyle.priority));
      if (appStyle.skip) {
        log('SKIP [MIG][APP FILTER] ' + t.symbol + ' (' + appStyle.reason + ')');
        continue;
      }
    }

    var vol1h = Number(tokenInfo?.price?.volume_1h) || t.volume || 0;
    // Update t.volume dengan volume_1h dari token info (untuk notifikasi)
    t.volume = vol1h;

    // Gate momentum 5 menit (lihat komentar CFG.migMaxPriceChange5m) — cek
    // SEBELUM grade/prepumpRefPrice, karena ini hard-skip (bukan pending),
    // jadi ditaruh sejajar dengan gate risk lain yang juga langsung `continue`.
    if (CFG.migEntryStrategy === 'PREPUMP') {
      var change5m = tokenInfo?.price?.price_change_percent5m != null
        ? tokenInfo.price.price_change_percent5m
        : t.price_change_percent5m;
      var momentumGate = checkRecentMomentumGate(change5m, CFG.migMaxPriceChange5m);
      if (momentumGate.block) {
        log('SKIP [MIG][MOMENTUM 5M] ' + t.symbol + ' (' + momentumGate.reason + ')');
        continue;
      }
    }

    const grade = gradeToken(t.liquidity, t.volume, rug.score);
    if (grade === 'SKIP') {
      log('SKIP [MIG] ' + t.symbol + ' (Grade SKIP — LP/Vol terlalu kecil)');
      continue;
    }

    // Harga referensi PREPUMP: dipakai gate anti-kemahalan di bawah (lihat
    // checkPrepumpPriceGate). Diambil dari harga saat token INI PERTAMA KALI
    // kesimpan (bukan overwrite tiap cycle), supaya tetap jadi acuan "harga
    // sebelum kepompong" walau bot baru sempat cek beberapa cycle kemudian.
    const existingMigSeen = SEEN.get(t.address);
    const prepumpRefPrice = existingMigSeen && existingMigSeen.prepumpRefPrice > 0
      ? existingMigSeen.prepumpRefPrice
      : (Number(t.price) > 0 ? Number(t.price) : null);
    SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'migration', prepumpRefPrice });

    // — Fibonacci Area Agresif (0.382-0.5) — dari candle Birdeye (candle 15m,
    // 6 jam terakhir, karena token migrasi baru belum punya histori panjang).
    // Sama seperti Swing: bukan gate keras, cuma nambah label [WARNING] di
    // pesan kalau harga entry ada di luar area ini.
    const migUsesFib = requiresFibonacci(CFG.migEntryStrategy, CFG.requireFibZone);
    const fibZone = migUsesFib
      ? await getFibonacciZone(t.address, t.price, 'MIG')
      : { available: false, inZone: true, reason: 'MIG entry strategy ' + CFG.migEntryStrategy };
    if (fibZone.available) {
      if (fibZone.inZone) {
        log('[MIG] ' + t.symbol + ' — di Area Agresif (' + fibZone.posInRange.toFixed(0) + '% dari range)');
      } else {
        log('[MIG] ' + t.symbol + ' — [WARNING] di luar Area Agresif (' + fibZone.posInRange.toFixed(0) + '% dari range)');
      }
    } else {
      log('[MIG] ' + t.symbol + ' — Fib zone tidak tersedia (' + fibZone.reason + ')');
    }

    log('[MIG] ' + grade + ' ' + t.symbol + ' (LP:$' + fmt(t.liquidity) + ' Vol1h:$' + fmt(vol1h) + ' GMGN Rug:' + migGmgnRugScore + ' RugCheck.xyz:' + rug.score + ' Insider:' + rug.insiderPct.toFixed(0) + '% Paid:✅)');
    // Notif "kandidat lolos" DIMATIKAN (hanya notif AUTOBUY/AUTOSELL/CUTLOSS
    // yang dikirim). Tracking tetap jalan (msgId null, gak ada pesan buat direply).
    var msgId = null;

    if (t.price && Number(t.price) > 0) {
      TRACKED.set(t.address, {
        symbol: t.symbol, name: t.name, grade, mode: 'MIGRATION',
        entryPrice: Number(t.price), entryAt: Date.now(), nextTargetIdx: 0, msgId,
        threadId: CFG.tgThreadMig,
      });
      log('Tracked [MIG] ' + t.symbol + ' @ $' + t.price);
    }

    // — AUTO BUY —
    if (AUTO_BUY.ENABLED && buyCount < AUTO_BUY.MAX_PER_CYCLE) {
      log('[AUTOBUY] Checking ' + t.symbol + ' (grade=' + grade + ')');
      // Gate anti-kemahalan PREPUMP: khusus berlaku kalau strategi PREPUMP.
      // FIX: sebelumnya pakai `migUsesFib` (turunan dari requiresFibonacci =
      // requireFibZone && strategy==='FIBONACCI') sebagai penentu, padahal
      // itu bisa jadi false juga saat strategy='FIBONACCI' tapi
      // REQUIRE_FIB_ZONE=false — bikin gate pump% ini salah nyala buat
      // strategi FIBONACCI, dan nggak sinkron sama pengecekan yang sama di
      // processPendingFib() (yang emang langsung cek string strategi).
      // Sekarang dua-duanya konsisten: cek CFG.migEntryStrategy langsung.
      const prepumpGate = CFG.migEntryStrategy === 'PREPUMP'
        ? checkPrepumpPriceGate(Number(t.price), prepumpRefPrice, CFG.migMaxPumpPct)
        : { active: false, block: false, pumpPct: null, reason: null };
      if (prepumpGate.active) {
        log('[AUTOBUY][PUMP GATE] ' + t.symbol + ' — ref $' + fmtPrice(prepumpRefPrice)
          + ' vs now $' + fmtPrice(t.price)
          + (prepumpGate.pumpPct != null ? ' (' + prepumpGate.pumpPct.toFixed(1) + '%)' : '')
          + ' -> ' + (prepumpGate.block ? 'BLOCK' : 'OK'));
      }
      // Gate Fibonacci: kalau harga di luar Area Agresif (atau data fib tidak
      // tersedia) dan requireFibZone aktif (default ON), JANGAN beli sekarang
      // tapi simpan ke PENDING_FIB supaya dicek ulang tiap cycle — begitu
      // harga retrace masuk zona, auto-buy baru dieksekusi (lihat
      // processPendingFib()). Kalau requireFibZone di-set false, beli langsung
      // seperti biasa tanpa nunggu.
      if ((migUsesFib && (!fibZone.available || !fibZone.inZone)) || prepumpGate.block) {
        if (prepumpGate.block) {
          log('[AUTOBUY] PENDING ' + t.symbol + ' — ' + prepumpGate.reason + ', ditunggu sampai retrace di bawah batas');
        } else {
          log('[AUTOBUY] PENDING ' + t.symbol + ' — di luar Fibonacci zone, ditunggu sampai retrace masuk zona');
        }
        if (fibZone.available) PENDING_FIB_ZONE_CACHE.set('MIG:' + t.address, fibZone);
        if (!PENDING_FIB.has(t.address)) {
          PENDING_FIB.set(t.address, {
            symbol: t.symbol, name: t.name, grade, mode: 'MIGRATION',
            firstSeenAt: Date.now(), creationTimestamp: t.creation_timestamp || null,
            prepumpRefPrice: prepumpRefPrice,
          });
        }
        updatePendingFibPosition(t.address, Number(t.price), fibZone);
      } else {
      const targetGrades = AUTO_BUY.ONLY_GRADE.split(',').map(g => g.trim());
      if (targetGrades.includes(grade) || AUTO_BUY.ONLY_GRADE === 'ALL') {
        try {
          log('[AUTOBUY] Buying ' + t.symbol + ' (' + AUTO_BUY.AMOUNT_SOL + ' SOL)...');
          const result = await buyToken(t.address, AUTO_BUY.AMOUNT_SOL, AUTO_BUY.SLIPPAGE_BPS);
          buyCount++;

          // Update TRACKED dengan data transaksi
          const pos = TRACKED.get(t.address);
          if (pos) {
            pos.entryPriceSol = result.entryPriceSol;
            pos.txSignature   = result.txSignature;
            pos.tokenAmount   = result.tokenAmount;
            pos.tokenDecimals = result.tokenDecimals || 6;
            pos.amountSol     = AUTO_BUY.AMOUNT_SOL;
            pos.bought        = true;
            // autoBought hanya true kalau BENERAN beli on-chain, bukan dry-run
            // quote. Kalau ini gak dibedakan, AUTOSELL bisa nyoba jual posisi
            // yang gak pernah beneran ada di wallet.
            pos.autoBought    = !AUTO_BUY.DRY_RUN;
            pos.sold          = false;
            pos.sellAttempts  = 0;
            TRACKED.set(t.address, pos);
          }

          log('[AUTOBUY] Bought ' + t.symbol + ' | tx: ' + result.txSignature);
          logTrackingEvent({
            type: AUTO_BUY.DRY_RUN ? 'AUTOBUY_DRY_RUN' : 'AUTOBUY',
            ca: t.address,
            symbol: t.symbol,
            name: t.name,
            grade,
            mode: 'MIGRATION',
            amountSol: AUTO_BUY.AMOUNT_SOL,
            entryPrice: Number(t.price) || 0,
            entryPriceUsd: Number(t.price) || 0,
            entryPriceSol: result.entryPriceSol || 0,
            tokenAmount: result.tokenAmount || 0,
            tokenDecimals: result.tokenDecimals || 6,
            txSignature: result.txSignature || '',
            bought: true,
          });

          var gradeEmoji = getGradeMeta(grade).emoji;
          // Tx line disembunyikan di notif (dry run & real sama-sama tanpa link).
          // Tinggal uncomment baris di bawah kalau link Solscan mau ditampilkan lagi.
          var buyTxLine = '';
          // var buyTxLine = AUTO_BUY.DRY_RUN
          //   ? ''
          //   : '🔗 Tx: <a href="https://solscan.io/tx/' + result.txSignature + '">' + result.txSignature.slice(0, 12) + '...</a>\n';
          var fibLine = '';
          if (fibZone && fibZone.available) {
            fibLine = '📐 Fib     : ' + fibZone.posInRange.toFixed(0) + '% dari range'
              + (fibZone.inZone ? ' (di ' + fibZone.label + ' ✅)' : ' (⚠️ luar ' + fibZone.label + ')') + '\n';
          } else if (CFG.migEntryStrategy === 'PREPUMP') {
            fibLine = '🚦 Entry   : PREPUMP signal ✅\n';
          }
          var buyMsg = '🛒 <b>AUTOBUY</b> | ' + gradeEmoji + ' ' + grade + ' | 🆕 New Migration\n'
            + '<b>' + t.name + '</b> (<code>' + t.symbol + '</code>)\n'
            + '━━━━━━━━━━━━━━━━━━━━\n'
            + '💰 Amount  : ' + AUTO_BUY.AMOUNT_SOL + ' SOL\n'
            + '📊 Slippage: ' + (AUTO_BUY.SLIPPAGE_BPS / 100) + '%\n'
            + '🏷️ Entry   : $' + fmtPrice(t.price) + '\n'
            + fibLine
            + '💎 Got     : ' + fmt(result.tokenAmount) + ' tokens\n'
            + buyTxLine
            + '<a href="https://dexscreener.com/solana/' + t.address + '">Chart</a>'
            + ' | <a href="https://gmgn.ai/sol/token/' + t.address + '">GMGN</a>';
          var buyMsgId = await sendTelegram(buyMsg, null, CFG.tgThreadAuto);
          if (pos && buyMsgId) {
            pos.msgId = buyMsgId;
            pos.threadId = CFG.tgThreadAuto;
            TRACKED.set(t.address, pos);
          }
        } catch (err) {
          log('[AUTOBUY] Failed ' + t.symbol + ': ' + err.message);
          var failMsg = '❌ <b>AUTOBUY FAILED</b> | 🆕 New Migration\n'
            + '<b>' + t.name + '</b> (<code>' + t.symbol + '</code>)\n'
            + '━━━━━━━━━━━━━━━━━━━━\n'
            + '⚠️ Error: ' + err.message + '\n'
            + '<code>' + t.address + '</code>';
          await sendTelegram(failMsg, null, CFG.tgThreadAuto);
        }
      }
      }
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

    // Gate GMGN lebih dulu supaya rug_ratio tinggi atau data hilang tidak
    // lanjut ke RugCheck/API lain dan tidak pernah masuk jalur AUTO BUY.
    const swingGmgnRugScore = (t.rug_ratio == null || t.rug_ratio === '')
      ? 'N/A'
      : asPct(t.rug_ratio).toFixed(1) + '%';
    log('[SWING][GMGN Rug] Cek ' + t.symbol + ' (score=' + swingGmgnRugScore + ', max=' + CFG.gmgnRugMaxRatio + '%)');
    const gmgnRugCheck = checkRugRatio(t.rug_ratio, CFG.gmgnRugMaxRatio);
    if (gmgnRugCheck.skip) {
      SWING_RUG_CONFIRM.delete(t.address);
      log('SKIP [SWING][GMGN Rug] ' + t.symbol + ' (' + gmgnRugCheck.reason + ')');
      continue;
    }

    const rugConfirmation = nextConsecutiveConfirmation(SWING_RUG_CONFIRM.get(t.address), cycleId);
    SWING_RUG_CONFIRM.set(t.address, rugConfirmation);
    if (rugConfirmation.count < CFG.swingGmgnRugConfirmScans) {
      log('[SWING][GMGN Rug] WAIT ' + t.symbol + ' (konfirmasi '
        + rugConfirmation.count + '/' + CFG.swingGmgnRugConfirmScans + ' scan berturut-turut)');
      continue;
    }
    SWING_RUG_CONFIRM.delete(t.address);

    try {
      log('[SWING][RugCheck.xyz] Cek ' + t.symbol + '...');
      const rug = await getRugCheck(t.address, CFG.swingMaxInsiderPct);
      // HARD SKIP:
      // - FIX: gate rawScore DIHAPUS (lihat penjelasan lengkap di gate MIG —
      //   skala raw score RugCheck API tidak konsisten 0-100, bisa ribuan
      //   bahkan untuk token legit, jadi ceiling kecil salah kalibrasi).
      // - score_normalised (skala 0-100 resmi rugcheck.xyz) dibandingkan ke
      //   CFG.swingMaxRugScore dari .env (SWING_MAX_RUG_SCORE), BUKAN
      //   hardcoded 1 seperti sebelumnya.
      // - risks array harus kosong (Tidak ada) — TIDAK DIUBAH.
      // Selain itu: langsung skip, tanpa pengecualian.
      if (rug.score > CFG.swingMaxRugScore) {
        log('SKIP [SWING][RugCheck.xyz] ' + t.symbol + ' (score_normalised=' + rug.score + ', max=' + CFG.swingMaxRugScore + ')');
        SEEN.set(t.address, { firstSeen: SEEN.get(t.address)?.firstSeen || Date.now(), seenAt: Date.now(), mode: 'swing', lockedReason: 'rug_score_normalised' });
        continue;
      }
      if (rug.risksArr.length > 0) {
        log('SKIP [SWING][RugCheck.xyz] ' + t.symbol + ' (ada ' + rug.risksArr.length + ' risks: ' + rug.risks + ')');
        SEEN.set(t.address, {
          firstSeen: SEEN.get(t.address)?.firstSeen || Date.now(),
          seenAt: Date.now(),
          mode: 'swing',
          lockedReason: 'rug_risks_present',
        });
        continue;
      }
      // FIX: gate insider (swingMaxInsiderPct) sebelumnya cuma diteruskan ke
      // getRugCheck() sebagai insiderThreshold (dipakai buat tag [DANGER] di
      // log internal saja), tapi rug.insiderPct TIDAK PERNAH dibandingkan ke
      // CFG.swingMaxInsiderPct sebagai gate skip di jalur SWING — beda dari
      // jalur MIG yang sudah punya gate ini (lihat rug.insiderPct >
      // CFG.maxInsiderPct di atas). Sekarang disamakan.
      if (rug.insiderPct > CFG.swingMaxInsiderPct) {
        log('SKIP [SWING][RugCheck.xyz] ' + t.symbol + ' (Insider ' + rug.insiderPct.toFixed(0) + '% > ' + CFG.swingMaxInsiderPct + '%)');
        continue;
      }
      // Gate top10 holder LANGSUNG dari RugCheck (d.topHolders), sama seperti
      // di mode MIG — independen dari risks[], supaya tetap ketangkep walau
      // RugCheck tidak mengeluarkan risk item "top 10 holders high ownership".
      if (rug.top10PctRugcheck > CFG.maxTop10HoldersRugcheck) {
        log('SKIP [SWING][RugCheck.xyz] ' + t.symbol + ' (Top10 ' + rug.top10PctRugcheck.toFixed(1) + '% > ' + CFG.maxTop10HoldersRugcheck + '%)');
        continue;
      }
      // Gate holder INDIVIDUAL (rank 1-4) — pakai threshold KHUSUS SWING
      // (SWING_MAX_HOLDER_1..4_PCT), terpisah dari threshold MIG.
      var indivHolderSwing = checkIndividualTopHolders(rug.rankedHolderPcts, {
        holder1: CFG.swingMaxHolder1Pct, holder2: CFG.swingMaxHolder2Pct,
        holder3: CFG.swingMaxHolder3Pct, holder4: CFG.swingMaxHolder4Pct,
      });
      if (indivHolderSwing.skip) {
        log('SKIP [SWING][RugCheck.xyz] ' + t.symbol + ' (' + indivHolderSwing.reason + ')');
        continue;
      }

      var swingTokenInfo = CFG.devClusterFilterEnabled ? fetchTokenInfo(t.address) : null;
      var swingDevCluster = checkDevLaunchCluster(t.address, swingTokenInfo);
      logDevLaunchCluster('SWING', t.symbol, swingDevCluster);
      if (swingDevCluster.reject) {
        log('SKIP [SWING][DEV CLUSTER] ' + t.symbol + ' (' + swingDevCluster.reason + ')');
        SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'swing', lockedReason: 'dev_cluster' });
        continue;
      }
      const grade = gradeToken(t.liquidity, t.volume, rug.score);
      if (grade === 'SKIP') { log('SKIP [SWING] ' + t.symbol + ' (Grade SKIP)'); continue; }

      // — Fibonacci Golden Zone (0.5-0.618) — dari candle Birdeye. Tidak
      // jadi gate keras: kalau harga di luar zona, token tetap lolos tapi
      // pesan Telegram-nya dikasih label [WARNING] biar entry-nya sadar
      // resikonya (masuk di luar area retracement favorit).
      const fibZone = await getFibonacciZone(t.address, t.price, 'SWING');
      if (fibZone.available) {
        if (fibZone.inZone) {
          log('[SWING] ' + t.symbol + ' — di Golden Zone (' + fibZone.posInRange.toFixed(0) + '% dari range)');
        } else {
          log('[SWING] ' + t.symbol + ' — [WARNING] di luar Golden Zone (' + fibZone.posInRange.toFixed(0) + '% dari range)');
        }
      } else {
        log('[SWING] ' + t.symbol + ' — Fib zone tidak tersedia (' + fibZone.reason + ')');
      }

      // Mark sudah dinotif sebagai swing (update SEEN entry)
      const existingEntry = SEEN.get(t.address) || { firstSeen: Date.now(), seenAt: Date.now() };
      SEEN.set(t.address, { ...existingEntry, swingNotified: Date.now(), mode: 'swing' });

      log('[SWING] ' + grade + ' ' + t.symbol + ' — lolos screening | GMGN Rug:' + swingGmgnRugScore + ' | RugCheck.xyz:' + rug.score);
      // Notif "kandidat lolos" DIMATIKAN (hanya notif AUTOBUY/AUTOSELL/CUTLOSS
      // yang dikirim). Tracking tetap jalan (msgId null, gak ada pesan buat direply).
      var msgId = null;

      if (t.price && Number(t.price) > 0 && !TRACKED.has(t.address)) {
        TRACKED.set(t.address, {
          symbol: t.symbol, name: t.name, grade, mode: 'SWING',
          entryPrice: Number(t.price), entryAt: Date.now(), nextTargetIdx: 0, msgId,
          threadId: CFG.tgThreadId,
        });
        log('Tracked [SWING] ' + t.symbol + ' @ $' + t.price);
      }

      if (AUTO_BUY.ENABLED && buyCount < AUTO_BUY.MAX_PER_CYCLE) {
        log('[AUTOBUY][SWING] Checking ' + t.symbol + ' (grade=' + grade + ')');
        // Sama seperti New Migration: kalau di luar zona, tunggu di PENDING_FIB
        // sampai retrace masuk zona, bukan langsung dibuang.
        const swingUsesFib = requiresFibonacci(CFG.swingEntryStrategy, CFG.requireFibZone);
        if (swingUsesFib && (!fibZone.available || !fibZone.inZone)) {
          log('[AUTOBUY][SWING] PENDING ' + t.symbol + ' — di luar Fibonacci zone, ditunggu sampai retrace masuk zona');
          if (fibZone.available) PENDING_FIB_ZONE_CACHE.set('SWING:' + t.address, fibZone);
          if (!PENDING_FIB.has(t.address)) {
            PENDING_FIB.set(t.address, {
              symbol: t.symbol, name: t.name, grade, mode: 'SWING',
              firstSeenAt: Date.now(), creationTimestamp: t.creation_timestamp || null,
            });
          }
          updatePendingFibPosition(t.address, Number(t.price), fibZone);
        } else {
        const targetGrades = AUTO_BUY.ONLY_GRADE.split(',').map(g => g.trim());
        if (targetGrades.includes(grade) || AUTO_BUY.ONLY_GRADE === 'ALL') {
          try {
            log('[AUTOBUY][SWING] Buying ' + t.symbol + ' (' + AUTO_BUY.AMOUNT_SOL + ' SOL)...');
            const result = await buyToken(t.address, AUTO_BUY.AMOUNT_SOL, AUTO_BUY.SLIPPAGE_BPS);
            buyCount++;

            const pos = TRACKED.get(t.address);
            if (pos) {
              pos.entryPriceSol = result.entryPriceSol;
              pos.txSignature   = result.txSignature;
              pos.tokenAmount   = result.tokenAmount;
              pos.tokenDecimals = result.tokenDecimals || 6;
              pos.amountSol     = AUTO_BUY.AMOUNT_SOL;
              pos.bought        = true;
              // Sama seperti New Migration: jangan tandai autoBought kalau
              // ini cuma dry-run quote, biar AUTOSELL gak nyoba jual posisi
              // yang gak pernah beneran ada di wallet.
              pos.autoBought    = !AUTO_BUY.DRY_RUN;
              pos.sold          = false;
              pos.sellAttempts  = 0;
              TRACKED.set(t.address, pos);
            }

            log('[AUTOBUY][SWING] Bought ' + t.symbol + ' | tx: ' + result.txSignature);
            logTrackingEvent({
              type: AUTO_BUY.DRY_RUN ? 'AUTOBUY_DRY_RUN' : 'AUTOBUY',
              ca: t.address,
              symbol: t.symbol,
              name: t.name,
              grade,
              mode: 'SWING',
              amountSol: AUTO_BUY.AMOUNT_SOL,
              entryPrice: Number(t.price) || 0,
              entryPriceUsd: Number(t.price) || 0,
              entryPriceSol: result.entryPriceSol || 0,
              tokenAmount: result.tokenAmount || 0,
              tokenDecimals: result.tokenDecimals || 6,
              txSignature: result.txSignature || '',
              bought: true,
            });

            var gradeEmoji = getGradeMeta(grade).emoji;
            // Tx line disembunyikan di notif (dry run & real sama-sama tanpa link).
            // Tinggal uncomment baris di bawah kalau link Solscan mau ditampilkan lagi.
            var buyTxLine = '';
            // var buyTxLine = AUTO_BUY.DRY_RUN
            //   ? ''
            //   : '🔗 Tx: <a href="https://solscan.io/tx/' + result.txSignature + '">' + result.txSignature.slice(0, 12) + '...</a>\n';
            var fibLine = '';
            if (fibZone && fibZone.available) {
              fibLine = '📐 Fib     : ' + fibZone.posInRange.toFixed(0) + '% dari range'
                + (fibZone.inZone ? ' (di ' + fibZone.label + ' ✅)' : ' (⚠️ luar ' + fibZone.label + ')') + '\n';
            }
            var buyMsg = '🛒 <b>AUTOBUY</b> | ' + gradeEmoji + ' ' + grade + ' | 🔄 Swing 1D\n'
              + '<b>' + t.name + '</b> (<code>' + t.symbol + '</code>)\n'
              + '━━━━━━━━━━━━━━━━━━━━\n'
              + '💰 Amount  : ' + AUTO_BUY.AMOUNT_SOL + ' SOL\n'
              + '📊 Slippage: ' + (AUTO_BUY.SLIPPAGE_BPS / 100) + '%\n'
              + '🏷️ Entry   : $' + fmtPrice(t.price) + '\n'
              + fibLine
              + '💎 Got     : ' + fmt(result.tokenAmount) + ' tokens\n'
              + buyTxLine
              + '<a href="https://dexscreener.com/solana/' + t.address + '">Chart</a>'
              + ' | <a href="https://gmgn.ai/sol/token/' + t.address + '">GMGN</a>';
            var buyMsgId = await sendTelegram(buyMsg, null, CFG.tgThreadAuto);
            if (pos && buyMsgId) {
              pos.msgId = buyMsgId;
              pos.threadId = CFG.tgThreadAuto;
              TRACKED.set(t.address, pos);
            }
          } catch (err) {
            log('[AUTOBUY][SWING] Failed ' + t.symbol + ': ' + err.message);
            var failMsg = '❌ <b>AUTOBUY FAILED</b> | 🔄 Swing 1D\n'
              + '<b>' + t.name + '</b> (<code>' + t.symbol + '</code>)\n'
              + '━━━━━━━━━━━━━━━━━━━━\n'
              + '⚠️ Error: ' + err.message + '\n'
              + '<code>' + t.address + '</code>';
            await sendTelegram(failMsg, null, CFG.tgThreadAuto);
          }
        }
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
    // Gate 7: rug ratio (GMGN) — pakai checkRugRatio() + gmgnRugMaxRatio, BUKAN
    // maxRugScore (itu ambang RugCheck API, sumber & skala beda). Data hilang
    // (null) di-skip sebagai risiko, bukan diloloskan diam-diam.
    var signalGmgnRugScore = (t.rug_ratio == null || t.rug_ratio === '')
      ? 'N/A'
      : asPct(t.rug_ratio).toFixed(1) + '%';
    log('[SIGNAL][GMGN Rug] Cek ' + t.symbol + ' (score=' + signalGmgnRugScore + ', max=' + CFG.gmgnRugMaxRatio + '%)');
    var rugCheck = checkRugRatio(t.rug_ratio, CFG.gmgnRugMaxRatio);
    if (rugCheck.skip) {
      log('SKIP [SIGNAL][GMGN Rug] ' + t.symbol + ' (' + rugCheck.reason + ')');
      SEEN.set(t.address, { firstSeen: Date.now(), seenAt: Date.now(), mode: 'signal', lockedReason: 'rug_score' });
      continue;
    }
    var rugScore = Math.round(asPct(t.rug_ratio));
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

    log('[SIGNAL] ' + t.symbol + ' (LP:$' + fmt(t.liquidity) + ' Holders:' + t.holder_count + ' GMGN Rug:' + rugScore + '%)');
    // Notif "kandidat lolos" DIMATIKAN (hanya notif AUTOBUY/AUTOSELL/CUTLOSS
    // yang dikirim). Delay rate-limit juga dihapus krn gak ada lagi yg dikirim.
    var msgId = null;

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
    await checkTrackedPositions(migrationTokens.concat(swingTokens), { autoSell: false, passiveTrack: true });
    savePositions();
  }

  log('Cycle done. Total notified: ' + totalNotified);
}

// ─────────────────────────────────────────────
//  PENDING FIB — tunggu retrace masuk Fibonacci zone
// ─────────────────────────────────────────────
// Dipanggil loop khusus harga pending. Zona Fib di-refresh lebih lambat dan
// dipakai ulang untuk poll harga cepat supaya sentuhan retrace singkat tidak
// kelewat tanpa membanjiri API candle.
// discan, ambil harga terkini + hitung ulang fib zone:
//  - Kalau sekarang inZone -> eksekusi AUTO BUY, keluarkan dari PENDING_FIB.
//  - Kalau umur token sudah lewat batas (maxAgeHours utk MIG / swingMaxAge
//    utk SWING) -> buang dari watchlist (kadaluarsa, gak pernah retrace).
//  - Selain itu -> tetap ditunggu di cycle berikutnya.
function updatePendingFibPosition(address, currentPrice, fibZone) {
  var pos = TRACKED.get(address);
  if (!pos) return;

  pos.autoBuyStatus = 'WAIT_ENTRY';
  pos.pendingCurrentPrice = Number(currentPrice) || 0;

  if (!fibZone || !fibZone.available) {
    pos.autoBuyReason = 'Menunggu data zona Fibonacci';
    pos.entryZoneState = 'UNAVAILABLE';
    TRACKED.set(address, pos);
    return;
  }

  var zoneBottom = Number(fibZone.zoneBottom) || 0;
  var zoneTop = Number(fibZone.zoneTop) || 0;
  var priceNow = Number(currentPrice) || 0;
  var range = Number(fibZone.swingHigh) - Number(fibZone.swingLow);
  var state = fibZone.inZone ? 'IN_ZONE' : priceNow < zoneBottom ? 'BELOW_ZONE' : 'ABOVE_ZONE';
  var distancePct = 0;
  if (state === 'BELOW_ZONE' && priceNow > 0) distancePct = ((zoneBottom / priceNow) - 1) * 100;
  if (state === 'ABOVE_ZONE' && priceNow > 0) distancePct = (1 - (zoneTop / priceNow)) * 100;

  pos.entryZoneLow = zoneBottom;
  pos.entryZoneHigh = zoneTop;
  pos.entryZoneLabel = fibZone.label || 'Fib';
  pos.entryZoneState = state;
  pos.entryDistancePct = Math.max(0, distancePct);
  pos.fibPositionPct = Number(fibZone.posInRange) || 0;
  pos.fibZoneStartPct = range > 0
    ? ((zoneBottom - Number(fibZone.swingLow)) / range) * 100
    : 0;
  pos.fibZoneEndPct = range > 0
    ? ((zoneTop - Number(fibZone.swingLow)) / range) * 100
    : 0;
  pos.autoBuyReason = state === 'IN_ZONE'
    ? 'Harga masuk zona entry'
    : state === 'BELOW_ZONE'
      ? 'Harga di bawah zona entry'
      : 'Harga di atas zona entry';
  TRACKED.set(address, pos);
}

async function processPendingFib(migrationSnapshotByAddress, swingSnapshotByAddress) {
  var toRemove = [];
  for (const [address, entry] of PENDING_FIB) {
    var pendingEntryMode = entry.mode === 'SWING' ? 'SWING' : 'NEW';
    if (!screenModeAllows(CFG.screenMode, pendingEntryMode)) {
      log('[PENDING_FIB] DROP ' + entry.symbol + ' — mode ' + pendingEntryMode + ' nonaktif (SCREEN_MODE=' + CFG.screenMode + ')');
      PENDING_FIB.delete(address);
      PENDING_FIB_ZONE_CACHE.delete('MIG:' + address);
      PENDING_FIB_ZONE_CACHE.delete('SWING:' + address);
    }
  }
  // Mulai semua request harga sekaligus. Kalau dibuat serial di dalam loop,
  // satu timeout 8 detik per token bisa mengubah poll 5 detik jadi puluhan
  // detik saat watchlist pending membesar.
  var pendingPricePromises = new Map(
    Array.from(PENDING_FIB, ([address, entry]) => [address, (async () => {
      try {
        var ds = await axios.get('https://api.dexscreener.com/latest/dex/tokens/' + address, { timeout: 8000 });
        var pairs = ds.data.pairs || [];
        var best = pairs.find(p => p.priceUsd) || pairs[0] || null;
        return best && best.priceUsd ? Number(best.priceUsd) : null;
      } catch (e) {
        log('[PENDING_FIB] Gagal ambil harga ' + entry.symbol + ': ' + e.message);
        return null;
      }
    })()])
  );

  for (const [address, entry] of PENDING_FIB) {
    if (buyCountGlobalGuard()) break; // safety, lihat catatan di bawah

    var ageH = tokenAgeHours(entry.creationTimestamp);
    var maxAge = entry.mode === 'SWING' ? CFG.swingMaxAge : CFG.maxAgeHours;
    if (entry.creationTimestamp && ageH > maxAge) {
      log('[PENDING_FIB] ' + entry.symbol + ' kadaluarsa (umur ' + ageH.toFixed(1) + 'j > ' + maxAge + 'j), stop nunggu');
      toRemove.push(address);
      continue;
    }

    // Semua pending wajib pakai snapshot GMGN terbaru dari sumber mode masing-masing.
    // Data hilang: tahan buy. Score naik: buang pending dan track-only.
    var pendingMode = entry.mode === 'SWING' ? 'SWING' : 'MIG';
    var pendingSnapshotMap = pendingMode === 'SWING'
      ? swingSnapshotByAddress
      : migrationSnapshotByAddress;
    var currentGmgn = pendingSnapshotMap && pendingSnapshotMap.get(address);
    if (!currentGmgn && pendingMode === 'MIG' && swingSnapshotByAddress) {
      currentGmgn = swingSnapshotByAddress.get(address);
    }
    if (!currentGmgn) {
      log('[PENDING_FIB][' + pendingMode + '][GMGN Rug] BLOCK ' + entry.symbol
        + ' (data terbaru tidak tersedia)');
      continue;
    }
    var pendingGmgnScore = (currentGmgn.rug_ratio == null || currentGmgn.rug_ratio === '')
      ? 'N/A'
      : asPct(currentGmgn.rug_ratio).toFixed(1) + '%';
    var pendingGmgnCheck = checkRugRatio(currentGmgn.rug_ratio, CFG.gmgnRugMaxRatio);
    log('[PENDING_FIB][' + pendingMode + '][GMGN Rug] Cek ' + entry.symbol
      + ' (score=' + pendingGmgnScore + ', max=' + CFG.gmgnRugMaxRatio + '%)');
    if (pendingGmgnCheck.skip) {
      log('[PENDING_FIB][' + pendingMode + '][GMGN Rug] DROP ' + entry.symbol
        + ' (' + pendingGmgnCheck.reason + ')');
      toRemove.push(address);
      var pendingPosition = TRACKED.get(address);
      if (pendingPosition && !pendingPosition.bought) TRACKED.delete(address);
      continue;
    }

    // Harga DexScreener sudah dimulai paralel di awal fungsi.
    var currentPrice = await pendingPricePromises.get(address);
    if (!currentPrice || currentPrice <= 0) continue;

    var fibMode = entry.mode === 'SWING' ? 'SWING' : 'MIG';
    var pendingStrategy = fibMode === 'SWING' ? CFG.swingEntryStrategy : CFG.migEntryStrategy;
    var pendingUsesFib = requiresFibonacci(pendingStrategy, CFG.requireFibZone);
    var fibZone;
    if (!pendingUsesFib) {
      fibZone = { available: false, inZone: true, posInRange: 0, label: pendingStrategy };
      log('[PENDING_FIB] ' + entry.symbol + ' lanjut tanpa Fib (strategy=' + pendingStrategy + ')');
    } else try {
      var fibCacheKey = fibMode + ':' + address;
      // FIX: sebelumnya pakai .get() biasa (refresh murni berdasarkan TTL).
      // Kalau harga jatuh ABOVE_ZONE -> BELOW_ZONE di dalam jendela TTL yang
      // sama, token nyangkut nunjukin zona lama (dari saat masih di atas)
      // sampai TTL berikutnya habis, karena shouldDropBelowZoneAfterRefresh
      // cuma pernah trigger saat refreshed===true. getForceRefreshIfBelow
      // paksa refresh begitu evaluasi thd cache lama nunjukkin below-zone,
      // supaya status & keputusan drop selalu pakai swing high/low terkini.
      var cachedFib = await PENDING_FIB_ZONE_CACHE.getForceRefreshIfBelow(
        fibCacheKey,
        currentPrice,
        () => getFibonacciZone(address, currentPrice, fibMode)
      );
      fibZone = evaluateFibZoneAtPrice(cachedFib.zone, currentPrice);
      if (cachedFib.refreshed && fibZone && fibZone.available) {
        log('[PENDING_FIB] Refresh zona ' + entry.symbol
          + ' $' + fmtPrice(fibZone.zoneBottom) + '-$' + fmtPrice(fibZone.zoneTop));
      }
    } catch (e) {
      log('[PENDING_FIB] Fib error ' + entry.symbol + ': ' + e.message);
      continue;
    }

    if (pendingUsesFib) updatePendingFibPosition(address, currentPrice, fibZone);

    if (pendingUsesFib && shouldDropBelowZoneAfterRefresh(
      CFG.fibDropBelowZoneAfterRefresh,
      cachedFib.refreshed,
      fibZone,
      currentPrice
    )) {
      log('[PENDING_FIB] DROP ' + entry.symbol
        + ' (setelah refresh harga $' + fmtPrice(currentPrice)
        + ' tetap BELOW_ZONE, batas bawah $' + fmtPrice(fibZone.zoneBottom) + ')');
      toRemove.push(address);
      var belowZonePosition = TRACKED.get(address);
      if (belowZonePosition && !belowZonePosition.bought) TRACKED.delete(address);
      // FIX: drop karena BELOW_ZONE itu bukan hard-skip (bukan rug/risk/insider
      // yang memang harus dikunci permanen) — cuma soal harga belum masuk area.
      // Sebelumnya token ini tetap terkunci selamanya via swingNotified di SEEN.
      //
      // FIX #2 (bug lanjutan): awalnya cuma swingNotified yang dihapus dari
      // entry SEEN (partial revive), tapi seenAt yang basi (dari kapan token
      // PERTAMA kali ketemu, bisa udah lama) tetap ketinggalan. Gate lain di
      // klasifikasi Swing (baris ~1770) baca seenAt itu dan mikir token ini
      // "baru aja ketemu, belum genap 24 jam" -> token malah kena throttle
      // swingMinAge (24 jam) SEBELUM sempat balik discan, padahal niatnya
      // langsung bisa discan ulang cycle berikutnya. Fix: hapus TOTAL entry
      // SEEN (bukan partial edit) supaya token dianggap benar-benar fresh,
      // tanpa sisa field basi yang memicu gate lain secara tidak sengaja.
      // Token yang memang hard-skip (rug score, risks, dll) TETAP terkunci
      // karena SEEN.set dengan lockedReason di gate lain tidak disentuh oleh
      // perubahan ini — hanya entry TANPA lockedReason yang dihapus di sini.
      var belowZoneSeen = SEEN.get(address);
      if (belowZoneSeen && belowZoneSeen.swingNotified && !belowZoneSeen.lockedReason) {
        SEEN.delete(address);
        log('[PENDING_FIB] ' + entry.symbol + ' dibuka lagi utk di-scan ulang cycle berikutnya (bukan hard-skip)');
      }
      continue;
    }

    if (pendingUsesFib && (!fibZone || !fibZone.available || !fibZone.inZone)) {
      var pendingFibStatus = fibZone && fibZone.available
        ? 'harga $' + fmtPrice(currentPrice)
          + ' | zona $' + fmtPrice(fibZone.zoneBottom) + '-$' + fmtPrice(fibZone.zoneTop)
          + ' | posisi ' + fibZone.posInRange.toFixed(0) + '%'
        : 'fib N/A';
      log('[PENDING_FIB] ' + entry.symbol + ' masih di luar zona (' + pendingFibStatus + '), lanjut tunggu');
      continue;
    }

    // Re-check gate anti-kemahalan PREPUMP (paralel dengan gate fib di atas).
    // Cuma berlaku untuk entry mode MIG dengan strategi PREPUMP (fibMode
    // 'SWING' atau strategi lain tidak kena, sesuai desain awal migMaxPumpPct
    // khusus New Migration). Kalau harga masih di atas batas -> tetap
    // nunggu di PENDING_FIB, dicek lagi cycle berikutnya. Kalau sudah
    // retrace di bawah batas -> lanjut ke eksekusi beli di bawah.
    if (fibMode === 'MIG' && pendingStrategy === 'PREPUMP') {
      var pendingPrepumpGate = checkPrepumpPriceGate(currentPrice, entry.prepumpRefPrice, CFG.migMaxPumpPct);
      if (pendingPrepumpGate.block) {
        log('[PENDING_FIB][PUMP GATE] ' + entry.symbol + ' — ' + pendingPrepumpGate.reason + ', lanjut tunggu retrace');
        continue;
      }
    }

    // Sudah masuk zona — eksekusi AUTO BUY sekarang, kalau AUTO_BUY masih aktif.
    if (!AUTO_BUY.ENABLED) { toRemove.push(address); continue; }
    log('[PENDING_FIB][RugCheck.xyz] Recheck final ' + entry.symbol + ' sebelum buy...');
    var pendingRug = await getRugCheck(
      address,
      entry.mode === 'SWING' ? CFG.swingMaxInsiderPct : CFG.maxInsiderPct
    );
    // FIX: gate rawScore DIHAPUS (skala tidak konsisten, lihat gate MIG/SWING).
    // score_normalised sekarang dibandingkan ke threshold yang sesuai mode
    // (swingMaxRugScore utk SWING, maxRugScore utk MIGRATION), bukan hardcoded 1.
    var pendingRugMaxScore = entry.mode === 'SWING' ? CFG.swingMaxRugScore : CFG.maxRugScore;
    // FIX: recheck final ini dulu cuma menggate score_normalised & risks[].
    // Gate insiderPct (swingMaxInsiderPct/maxInsiderPct) dan top10PctRugcheck
    // (maxTop10HoldersRugcheck) — yang keduanya SUDAH dipakai di screening
    // awal MIG/SWING — tidak pernah dicek ulang di sini, padahal ini titik
    // paling kritis (tepat sebelum eksekusi AUTO BUY, setelah token nunggu
    // masuk Fibonacci zone, jadi datanya bisa sudah basi/berubah). Sekarang
    // disamakan supaya token yang insider/top10-nya berubah jadi buruk saat
    // menunggu tetap ke-drop sebelum benar-benar dibeli.
    var pendingInsiderMaxPct = entry.mode === 'SWING' ? CFG.swingMaxInsiderPct : CFG.maxInsiderPct;
    // Recheck final juga menggate holder individual (rank 1-4), sama seperti
    // top10PctRugcheck di atas — supaya token yang whale-nya membesar saat
    // menunggu Fibonacci zone tetap ke-drop sebelum benar-benar dibeli.
    // Threshold dipilih sesuai mode entry (SWING pakai SWING_MAX_HOLDER_x_PCT,
    // MIGRATION pakai MAX_HOLDER_x_PCT), sama seperti pendingInsiderMaxPct.
    var pendingIndivHolder = checkIndividualTopHolders(pendingRug.rankedHolderPcts,
      entry.mode === 'SWING'
        ? { holder1: CFG.swingMaxHolder1Pct, holder2: CFG.swingMaxHolder2Pct,
            holder3: CFG.swingMaxHolder3Pct, holder4: CFG.swingMaxHolder4Pct }
        : { holder1: CFG.maxHolder1Pct, holder2: CFG.maxHolder2Pct,
            holder3: CFG.maxHolder3Pct, holder4: CFG.maxHolder4Pct }
    );
    if (pendingRug.score > pendingRugMaxScore || pendingRug.risksArr.length > 0
        || pendingRug.insiderPct > pendingInsiderMaxPct
        || pendingRug.top10PctRugcheck > CFG.maxTop10HoldersRugcheck
        || pendingIndivHolder.skip) {
      var pendingRugReason = pendingRug.risksArr.length > 0
        ? 'ada ' + pendingRug.risksArr.length + ' risks: ' + pendingRug.risks
        : pendingRug.score > pendingRugMaxScore
          ? 'score_normalised ' + pendingRug.score + ' melewati ' + pendingRugMaxScore
          : pendingRug.insiderPct > pendingInsiderMaxPct
            ? 'Insider ' + pendingRug.insiderPct.toFixed(0) + '% > ' + pendingInsiderMaxPct + '%'
            : pendingRug.top10PctRugcheck > CFG.maxTop10HoldersRugcheck
              ? 'Top10 ' + pendingRug.top10PctRugcheck.toFixed(1) + '% > ' + CFG.maxTop10HoldersRugcheck + '%'
              : pendingIndivHolder.reason;
      log('[PENDING_FIB][RugCheck.xyz] HARD DROP ' + entry.symbol
        + ' (' + pendingRugReason + ')');
      SEEN.set(address, {
        firstSeen: SEEN.get(address)?.firstSeen || entry.firstSeenAt || Date.now(),
        seenAt: Date.now(),
        mode: entry.mode === 'SWING' ? 'swing' : 'migration',
        lockedReason: pendingRug.risksArr.length > 0 ? 'rug_risks_present' : 'rug_score',
      });
      toRemove.push(address);
      var rugRejectedPosition = TRACKED.get(address);
      if (rugRejectedPosition && !rugRejectedPosition.bought) TRACKED.delete(address);
      continue;
    }
    var pendingTokenInfo = CFG.devClusterFilterEnabled
      ? fetchTokenInfo(address)
      : null;
    var pendingDevCluster = checkDevLaunchCluster(address, pendingTokenInfo);
    logDevLaunchCluster('PENDING_FIB', entry.symbol, pendingDevCluster);
    if (pendingDevCluster.reject) {
      log('[PENDING_FIB][DEV CLUSTER] HARD DROP ' + entry.symbol + ' (' + pendingDevCluster.reason + ')');
      SEEN.set(address, {
        firstSeen: SEEN.get(address)?.firstSeen || entry.firstSeenAt || Date.now(),
        seenAt: Date.now(),
        mode: entry.mode === 'SWING' ? 'swing' : 'migration',
        lockedReason: 'dev_cluster',
      });
      toRemove.push(address);
      var clusterRejectedPosition = TRACKED.get(address);
      if (clusterRejectedPosition && !clusterRejectedPosition.bought) TRACKED.delete(address);
      continue;
    }
    log('[PENDING_FIB] ' + entry.symbol
      + (pendingUsesFib ? ' masuk zona (' + fibZone.posInRange.toFixed(0) + '%)' : ' lolos PREPUMP entry')
      + ' — eksekusi AUTO BUY');
    try {
      const result = await buyToken(address, AUTO_BUY.AMOUNT_SOL, AUTO_BUY.SLIPPAGE_BPS);
      logTrackingEvent({
        type: AUTO_BUY.DRY_RUN ? 'AUTOBUY_DRY_RUN' : 'AUTOBUY',
        ca: address, symbol: entry.symbol, name: entry.name, grade: entry.grade, mode: entry.mode,
        amountSol: AUTO_BUY.AMOUNT_SOL, entryPrice: currentPrice, entryPriceUsd: currentPrice,
        entryPriceSol: result.entryPriceSol || 0, tokenAmount: result.tokenAmount || 0,
        tokenDecimals: result.tokenDecimals || 6, txSignature: result.txSignature || '', bought: true,
        fromPendingFib: true,
      });

      TRACKED.set(address, {
        symbol: entry.symbol, name: entry.name, grade: entry.grade, mode: entry.mode,
        entryPrice: currentPrice, entryAt: Date.now(), nextTargetIdx: 0,
        entryPriceSol: result.entryPriceSol, txSignature: result.txSignature,
        tokenAmount: result.tokenAmount, tokenDecimals: result.tokenDecimals || 6,
        amountSol: AUTO_BUY.AMOUNT_SOL, bought: true, autoBought: !AUTO_BUY.DRY_RUN,
        sold: false, sellAttempts: 0,
        threadId: CFG.tgThreadAuto,
      });

      var gradeEmoji = getGradeMeta(entry.grade).emoji;
      var modeLabel  = entry.mode === 'SWING' ? '🔄 Swing 1D' : '🆕 New Migration';
      var entryStrategyLine = pendingUsesFib
        ? '📐 Fib     : ' + fibZone.posInRange.toFixed(0) + '% dari range (di ' + fibZone.label + ' ✅, retrace)\n'
        : '🚦 Entry   : PREPUMP signal ✅\n';
      var buyMsg = '🛒 <b>AUTOBUY (retrace)</b> | ' + gradeEmoji + ' ' + entry.grade + ' | ' + modeLabel + '\n'
        + '<b>' + entry.name + '</b> (<code>' + entry.symbol + '</code>)\n'
        + '━━━━━━━━━━━━━━━━━━━━\n'
        + '💰 Amount  : ' + AUTO_BUY.AMOUNT_SOL + ' SOL\n'
        + '📊 Slippage: ' + (AUTO_BUY.SLIPPAGE_BPS / 100) + '%\n'
        + '🏷️ Entry   : $' + fmtPrice(currentPrice) + '\n'
        + entryStrategyLine
        + '💎 Got     : ' + fmt(result.tokenAmount) + ' tokens\n'
        + '<a href="https://dexscreener.com/solana/' + address + '">Chart</a>'
        + ' | <a href="https://gmgn.ai/sol/token/' + address + '">GMGN</a>';
      var buyMsgId = await sendTelegram(buyMsg, null, CFG.tgThreadAuto);
      var pos = TRACKED.get(address);
      if (pos && buyMsgId) { pos.msgId = buyMsgId; TRACKED.set(address, pos); }
    } catch (err) {
      log('[PENDING_FIB] AUTOBUY gagal ' + entry.symbol + ': ' + err.message);
      // Tidak di-remove — dicoba lagi cycle berikutnya selama masih dalam umur.
      continue;
    }
    toRemove.push(address);
  }
  toRemove.forEach(a => {
    PENDING_FIB.delete(a);
    PENDING_FIB_ZONE_CACHE.delete('MIG:' + a);
    PENDING_FIB_ZONE_CACHE.delete('SWING:' + a);
  });
}

// Placeholder no-op guard (tidak membatasi apa pun saat ini) — disiapkan
// supaya gampang ditambah limit "max buy per cycle" gabungan MIG+SWING+PENDING
// kalau suatu saat diperlukan. Saat ini PENDING_FIB tidak dibatasi buyCount
// cycle utama karena dieksekusi setelah loop MIG/SWING selesai.
function buyCountGlobalGuard() { return false; }

// ─────────────────────────────────────────────
//  POSITION TRACKING
// ─────────────────────────────────────────────
async function checkTrackedPositions(trendingTokens, options) {
  options = options || {};
  var allowAutoSell = options.autoSell !== false;
  var allowPassiveTrack = options.passiveTrack !== false;
  var priceMap = {};
  trendingTokens.forEach(tt => { if (tt.address && tt.price) priceMap[tt.address] = Number(tt.price); });

  // Ambil harga fallback dari DexScreener secara PARALEL untuk semua posisi
  // yang belum ada di priceMap. Sebelumnya ini di-fetch satu-satu di dalam
  // loop (sequential await), jadi kalau ada 8 posisi tertrack, total delay
  // bisa berkali-kali lipat dari timeout per-request — bikin reaksi cutloss
  // jauh lebih lambat dari interval polling yang di-set (mis. 5 detik jadi
  // efektif berjalan puluhan detik kalau banyak posisi).
  var needsFallback = [];
  for (const [ca] of TRACKED) {
    if (!priceMap[ca]) needsFallback.push(ca);
  }
  if (needsFallback.length > 0) {
    var fallbackResults = await Promise.all(needsFallback.map(async (ca) => {
      try {
        var ds = await axios.get('https://api.dexscreener.com/latest/dex/tokens/' + ca, { timeout: 8000 });
        var pairs = ds.data.pairs || [];
        var best  = pairs.find(p => p.priceUsd) || pairs[0] || null;
        return { ca, price: best && best.priceUsd ? Number(best.priceUsd) : null };
      } catch {
        return { ca, price: null };
      }
    }));
    fallbackResults.forEach(r => { if (r.price) priceMap[r.ca] = r.price; });
  }

  var toRemove = [];
  for (const [ca, pos] of TRACKED) {
    var currentPrice = priceMap[ca];

    if (!currentPrice || currentPrice <= 0) continue;

    var gain = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    var modeLabel = pos.mode === 'SWING' ? '🔄 Swing' : '🆕 Mig';

    // ── AUTO SELL: CUTLOSS & TAKE PROFIT ──
    // Jalan untuk semua posisi yang sudah "dibeli" (pos.bought === true),
    // baik dry-run (quote only, lewat sellToken() jalur DRY_RUN) maupun
    // real on-chain (pos.autoBought === true). Ini sengaja dipisah dari
    // autoBought supaya dry-run juga tersimulasi lengkap sampai sell &
    // dapat notif P&L, bukan cuma diam sampai stop-track >80%.
    // Posisi yang cuma ditrack untuk notif (swing/signal tanpa autobuy
    // sama sekali, pos.bought tetap false) tidak pernah dijual di sini.
    if (allowAutoSell && AUTO_SELL.ENABLED && pos.bought && !pos.sold && pos.tokenAmount) {
      pos.highestGainPct = Math.max(Number(pos.highestGainPct) || gain, gain);
      var shouldCutloss = gain <= -AUTO_SELL.CUTLOSS_PCT;
      var shouldTPFixed = AUTO_SELL.TP_MODE === 'FIXED'
        && AUTO_SELL.TAKE_PROFIT_PCT > 0
        && gain >= AUTO_SELL.TAKE_PROFIT_PCT;
      var trailingArmed = AUTO_SELL.TP_MODE === 'TRAILING'
        && AUTO_SELL.TRAILING_START_PCT > 0
        && AUTO_SELL.TRAILING_DROP_PCT > 0
        && pos.highestGainPct >= AUTO_SELL.TRAILING_START_PCT;
      var shouldTPTrailing = trailingArmed
        && gain <= (pos.highestGainPct - AUTO_SELL.TRAILING_DROP_PCT);
      var shouldTP = shouldTPFixed || shouldTPTrailing;

      if (shouldCutloss || shouldTP) {
        var sellReason  = shouldCutloss ? 'CUTLOSS' : 'TAKE_PROFIT';
        var sellEmoji   = shouldCutloss ? '🔴' : '🟢';
        var sellLabel   = shouldCutloss ? 'CUT LOSS' : (shouldTPTrailing ? 'TRAILING TAKE PROFIT' : 'TAKE PROFIT');
        try {
          log('[AUTOSELL] ' + sellReason + ' triggered for ' + pos.symbol + ' (gain ' + gain.toFixed(1) + '%)');
          var sellResult = await sellToken(ca, pos.tokenAmount, pos.tokenDecimals || 6, AUTO_SELL.SLIPPAGE_BPS);

          pos.sold = true;
          logTrackingEvent({
            type: 'AUTOSELL_' + sellReason, ca, ...pos, currentPrice,
            gain: gain.toFixed(1), txSignature: sellResult.txSignature,
          });

          // Tx line disembunyikan di notif (dry run & real sama-sama tanpa link).
          // Tinggal uncomment baris di bawah kalau link Solscan mau ditampilkan lagi.
          var sellTxLine = '';
          // var sellTxLine = AUTO_BUY.DRY_RUN
          //   ? ''
          //   : '🔗 Tx: <a href="https://solscan.io/tx/' + sellResult.txSignature + '">' + sellResult.txSignature.slice(0, 12) + '...</a>';
          var modalSol = Number(pos.amountSol) || 0;
          // Diterima & P&L SOL dihitung dari Gain % (modal x (1 + gain/100)),
          // BUKAN dari sellResult.solReceived (hasil quote riil yang kena
          // price impact/slippage). Sengaja disamakan dgn angka Gain supaya
          // notif konsisten & gak membingungkan — pembeda dry-run vs real
          // udah ada sendiri di dashboard (field autoBought), jadi notif
          // Telegram ini gak perlu nampilin dua definisi nominal berbeda.
          var solReceivedNum = modalSol > 0 ? modalSol * (1 + gain / 100) : null;
          var pnlSolLine = (modalSol > 0 && solReceivedNum !== null)
            ? '📈 P&L SOL : ' + (solReceivedNum >= modalSol ? '+' : '') + (solReceivedNum - modalSol).toFixed(4) + ' SOL\n'
            : '';
          var sellMsg = sellEmoji + ' <b>AUTOSELL - ' + sellLabel + '</b> | ' + modeLabel + '\n'
            + '<b>' + pos.name + '</b> (<code>' + pos.symbol + '</code>)\n'
            + '━━━━━━━━━━━━━━━━━━━━\n'
            + '📊 Gain    : ' + (gain >= 0 ? '+' : '') + gain.toFixed(1) + '%\n'
            + '🏷️ Entry   : $' + pos.entryPrice.toFixed(10) + '\n'
            + '💰 Exit    : $' + currentPrice.toFixed(10) + '\n'
            + '💵 Modal   : ' + (modalSol > 0 ? modalSol.toFixed(4) : '?') + ' SOL\n'
            + '🪙 Diterima: ' + (solReceivedNum !== null ? solReceivedNum.toFixed(4) : '?') + ' SOL\n'
            + pnlSolLine
            + sellTxLine
            + '<a href="https://dexscreener.com/solana/' + ca + '">Chart</a>'
            + ' | <a href="https://gmgn.ai/sol/token/' + ca + '">GMGN</a>';
          await sendTelegram(sellMsg, pos.msgId || null, CFG.tgThreadAuto);

          toRemove.push(ca);
          continue;
        } catch (err) {
          if (err && err.code === 'MANUAL_SELL_DETECTED') {
            pos.sold = true;
            log('[AUTOSELL] MANUAL SELL detected for ' + pos.symbol + ' (' + sellReason + '): ' + err.message);
            logTrackingEvent({
              type: 'AUTOSELL_MANUAL_SOLD',
              ca,
              ...pos,
              currentPrice,
              gain: gain.toFixed(1),
              reason: sellReason,
              note: err.message,
            });
            var manualSellMsg = 'INFO <b>AUTOSELL STOPPED</b> | ' + pos.symbol + '\n'
              + 'Posisi terdeteksi sudah dijual manual, jadi bot tidak akan coba sell lagi.\n'
              + 'Reason trigger: ' + sellLabel + '\n'
              + 'Gain saat ini: ' + gain.toFixed(1) + '%\n'
              + '<code>' + ca + '</code>';
            await sendTelegram(manualSellMsg, pos.msgId || null, CFG.tgThreadAuto);
            toRemove.push(ca);
            continue;
          }

          pos.sellAttempts = (pos.sellAttempts || 0) + 1;
          log('[AUTOSELL] FAILED ' + pos.symbol + ' (' + sellReason + '): ' + err.message + ' [percobaan ' + pos.sellAttempts + ']');
          var failSellMsg = '⚠️ <b>AUTOSELL FAILED</b> (' + sellLabel + ') | ' + pos.symbol + '\n'
            + 'Error: ' + err.message + '\n'
            + 'Gain saat ini: ' + gain.toFixed(1) + '% — akan dicoba lagi siklus berikutnya (percobaan ke-' + pos.sellAttempts + ')\n'
            + '<code>' + ca + '</code>';
          await sendTelegram(failSellMsg, pos.msgId || null, CFG.tgThreadAuto);
          // Sengaja TIDAK continue/toRemove — posisi tetap ditrack & dicoba
          // lagi siklus berikutnya selama belum berhasil terjual.
        }
      }
    }

    // Posisi yang benar2 dipegang (autoBought & belum sold) jangan di-stop-track
    // di -80% biar tetap dicoba dijual otomatis walau sudah anjlok parah.
    if (!allowPassiveTrack) continue;

    if (gain <= -80 && !(pos.autoBought && !pos.sold)) {
      var wasProfit   = (pos.nextTargetIdx || 0) > 0;
      var stopLabel   = wasProfit ? '📉 Stop Track (Was Profit)' : '🗑️ Stop Track';
      var stopType    = wasProfit ? 'STOP_TRACK_WAS_PROFIT' : 'STOP_TRACK';
      log(pos.symbol + ' dropped >80%, stop tracking' + (wasProfit ? ' [was profit]' : ''));
      logTrackingEvent({ type: stopType, ca, ...pos, currentPrice, gain: gain.toFixed(1) });
      toRemove.push(ca);
      // Notif Stop Track DIMATIKAN (hanya notif AUTOBUY/AUTOSELL/CUTLOSS yang
      // dikirim). Logic stop-tracking (toRemove) tetap jalan seperti biasa.
      continue;
    }

    if (AUTO_SELL.ENABLED && pos.autoBought) continue;

    var highestIdx = -1;
    for (var ti = 0; ti < TARGETS.length; ti++) {
      if (gain >= TARGETS[ti]) highestIdx = ti;
    }
    if (highestIdx >= 0 && highestIdx >= pos.nextTargetIdx) {
      var target = TARGETS[highestIdx];
      var emoji  = target >= 100 ? '🚀' : target >= 50 ? '📈' : '⬆️';
      log(pos.symbol + ' hit target +' + target + '%');
      logTrackingEvent({ type: 'TERCAPAI', ca, ...pos, currentPrice, target, gain: gain.toFixed(1) });
      // Notif Target Tercapai DIMATIKAN (hanya notif AUTOBUY/AUTOSELL/CUTLOSS
      // yang dikirim). nextTargetIdx tetap diupdate spy gak "notif" ulang tiap
      // cycle di target yg sama (walau sekarang gak ada yg dikirim, state ini
      // masih dipakai logTrackingEvent & histori tracking).
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

async function runAutoSellLoop() {
  try {
    if (TRACKED.size > 0) {
      await checkTrackedPositions([], { autoSell: true, passiveTrack: false });
      savePositions();
    }
  } catch (e) {
    log('AUTOSELL LOOP FATAL: ' + e.message);
  }
  setTimeout(runAutoSellLoop, CFG.autoSellInterval * 1000);
}

async function runPendingFibLoop() {
  if (pendingFibLoopRunning) {
    setTimeout(runPendingFibLoop, CFG.pendingFibPriceInterval * 1000);
    return;
  }

  pendingFibLoopRunning = true;
  try {
    if (PENDING_FIB.size > 0) {
      await processPendingFib(latestMigrationSnapshotByAddress, latestSwingSnapshotByAddress);
      savePendingFib();
      savePositions();
    }
  } catch (e) {
    log('PENDING FIB LOOP FATAL: ' + e.message);
  } finally {
    pendingFibLoopRunning = false;
    setTimeout(runPendingFibLoop, CFG.pendingFibPriceInterval * 1000);
  }
}

process.on('SIGINT',  () => { log('Saving...'); saveSeen(); process.exit(0); });
process.on('SIGTERM', () => { log('Saving...'); saveSeen(); process.exit(0); });

log('');
log('╔══════════════════════════════════════╗');
log('║   AUTO SCREENING v6 — TRIPLE MODE   ║');
log('╚══════════════════════════════════════╝');
log('');
log('[ Screen Mode ] ' + CFG.screenMode + ' (SCREEN_MODE=ALL|NEW|SWING)');
log('[ Mode 1: New Migration ]');
log('  LP > $' + CFG.minLp.toLocaleString() + ' | Vol > $' + CFG.minVol.toLocaleString());
log('  GMGN Rug <= ' + CFG.gmgnRugMaxRatio + '% | Konfirmasi: '
  + CFG.migGmgnRugConfirmScans + ' scan berturut-turut | RugCheck.xyz score_normalised <= ' + CFG.maxRugScore);
log('  Insider < ' + CFG.maxInsiderPct + '% [RugCheck.xyz] | Grade SKIP otomatis dibuang');
log('  Bundler < ' + CFG.maxBundlerPct + '% | Top10 < ' + CFG.maxTop10Holders + '%');
log('  Holder Individual: '
  + ['Holder#1<' + (CFG.maxHolder1Pct != null ? CFG.maxHolder1Pct + '%' : 'OFF'),
     'Holder#2<' + (CFG.maxHolder2Pct != null ? CFG.maxHolder2Pct + '%' : 'OFF'),
     'Holder#3<' + (CFG.maxHolder3Pct != null ? CFG.maxHolder3Pct + '%' : 'OFF'),
     'Holder#4<' + (CFG.maxHolder4Pct != null ? CFG.maxHolder4Pct + '%' : 'OFF')].join(' | '));
log('  CreatorHold < ' + CFG.maxDevHold + '% | PriceChg1h < ' + CFG.maxPriceChange1h + '%');
log('  Holders > ' + CFG.minHoldersMig + ' | Sniper < ' + CFG.maxSniperPct + '% | Vol/LP < ' + CFG.maxVolLpRatio + 'x');
log('  Creator tokens < ' + CFG.maxCreatorTokens + ' (serial creator check)');
log('  Dev Launch Cluster: ' + (CFG.devClusterFilterEnabled ? 'ON' : 'OFF')
  + (CFG.devClusterFilterEnabled
      ? ' | wallets>=' + CFG.devClusterMinWallets
        + ' historicalBuy>=' + CFG.devClusterMaxSupplyPct + '%'
        + ' launchWindow<=' + CFG.devClusterLaunchWindowSec + 's'
        + ' | fetch fail=' + (CFG.devClusterFailClosed ? 'REJECT' : 'PASS')
      : ' (DEV_CLUSTER_FILTER_ENABLED=false)'));
log('  Wajib social media: ' + (CFG.requireSocial ? 'ON (Twitter/TG/Website)' : 'OFF'));
log('  Fib Zone Wajib: ' + (CFG.requireFibZone ? 'ON' : 'OFF')
  + ' | MIG Area Agresif: ' + CFG.fibMigLo + '-' + CFG.fibMigHi
  + ' | SWING Golden Zone: ' + CFG.fibSwingLo + '-' + CFG.fibSwingHi);
log('  Fibonacci Feature: ' + (CFG.fibEnabled ? 'ON' : 'OFF (FIB_ENABLED=false — semua tier di-skip)')
  + (CFG.fibEnabled
      ? ' | Tier aktif: '
        + [
            CFG.fibTierBirdeye       ? 'Birdeye'       : null,
            CFG.fibTierGeckoTerminal ? 'GeckoTerminal' : null,
            CFG.fibTierDexPaprika    ? 'DexPaprika'    : null,
            CFG.fibTierVybe          ? 'Vybe'          : null,
          ].filter(Boolean).join(' > ') || '(semua tier OFF, langsung fallback max/min)'
      : ''));
log('[ Mode 2: Swing 1D Pre-Pump ]');
log('  LP > $' + CFG.swingMinLp.toLocaleString() + ' | Vol1h > $' + CFG.swingMinVol1h.toLocaleString());
log('  Max pump 1h: ' + CFG.swingMaxChange1h + '% | Max pump 24h: ' + CFG.swingMaxChange24h + '%');
log('  Vol spike min: ' + CFG.swingVolSpikeMin + 'x | Holders min: ' + CFG.swingMinHolders);
log('  Kline: umur <72j pakai 4H > 1H | umur >=72j pakai 1D > 4H > 1H | semua kosong = WAIT');
log('  GMGN Rug <= ' + CFG.gmgnRugMaxRatio + '% | Konfirmasi: '
  + CFG.swingGmgnRugConfirmScans + ' scan berturut-turut | RugCheck.xyz score_normalised <= ' + CFG.swingMaxRugScore);
log('  Holder Individual: '
  + ['Holder#1<' + (CFG.swingMaxHolder1Pct != null ? CFG.swingMaxHolder1Pct + '%' : 'OFF'),
     'Holder#2<' + (CFG.swingMaxHolder2Pct != null ? CFG.swingMaxHolder2Pct + '%' : 'OFF'),
     'Holder#3<' + (CFG.swingMaxHolder3Pct != null ? CFG.swingMaxHolder3Pct + '%' : 'OFF'),
     'Holder#4<' + (CFG.swingMaxHolder4Pct != null ? CFG.swingMaxHolder4Pct + '%' : 'OFF')].join(' | '));
log('  Age: ' + CFG.swingMinAge + 'j – ' + CFG.swingMaxAge + 'j');
if (CFG.signalEnabled) {
  log('[ Mode 3: Smart Money Signal ]');
  log('  LP > $' + CFG.signalMinLiquidity.toLocaleString() + ' | Holders > ' + CFG.signalMinHolders);
  log('  Top10 < ' + CFG.signalMaxTop10Rate + '% | MC trig < $' + fmt(CFG.signalMaxMc));
  log('  SM count > 0 | Bot < 50% | Creator token < ' + CFG.maxCreatorTokens);
}
log('');
log('[ Auto Buy ]  Enabled: ' + AUTO_BUY.ENABLED + ' | DryRun: ' + AUTO_BUY.DRY_RUN
  + ' | Amount: ' + AUTO_BUY.AMOUNT_SOL + ' SOL | MaxPerCycle: ' + AUTO_BUY.MAX_PER_CYCLE
  + ' | Grade: ' + AUTO_BUY.ONLY_GRADE);
log('[ Entry Strategy ] MIG=' + CFG.migEntryStrategy + ' | SWING=' + CFG.swingEntryStrategy
  + ' | RequireFib=' + CFG.requireFibZone);
log('[ PREPUMP Anti-Kemahalan ] ' + (CFG.migMaxPumpPct > 0
  ? 'ON — skip beli kalau harga naik >' + CFG.migMaxPumpPct + '% dari referensi (MIG_MAX_PUMP_PCT)'
  : 'OFF (MIG_MAX_PUMP_PCT kosong/0)'));
log('[ PREPUMP Momentum 5m ] ' + (CFG.migMaxPriceChange5m > 0
  ? 'ON — skip kalau harga sudah naik >' + CFG.migMaxPriceChange5m + '% dalam 5 menit terakhir (MIG_MAX_PRICE_CHANGE_5M)'
  : 'OFF (MIG_MAX_PRICE_CHANGE_5M kosong/0)'));
var autoSellSummary = 'OFF';
if (AUTO_SELL.TP_MODE === 'FIXED' && AUTO_SELL.TAKE_PROFIT_PCT > 0) {
  autoSellSummary = 'FIXED +' + AUTO_SELL.TAKE_PROFIT_PCT + '%';
} else if (AUTO_SELL.TP_MODE === 'TRAILING' && AUTO_SELL.TRAILING_START_PCT > 0 && AUTO_SELL.TRAILING_DROP_PCT > 0) {
  autoSellSummary = 'TRAILING start +' + AUTO_SELL.TRAILING_START_PCT + '% drop ' + AUTO_SELL.TRAILING_DROP_PCT + '%';
}
log('[ Auto Sell ] Enabled: ' + AUTO_SELL.ENABLED + ' | CutLoss: -' + AUTO_SELL.CUTLOSS_PCT + '%'
  + ' | TakeProfit: ' + autoSellSummary);
log('Interval: ' + CFG.interval + 's');
log('AutoSell Poll: ' + CFG.autoSellInterval + 's');
log('Pending Fib Price Poll: ' + CFG.pendingFibPriceInterval + 's'
  + ' | Zone Refresh: ' + CFG.pendingFibRefreshInterval + 's');
log('Pending Fib Drop Below Zone: ' + (CFG.fibDropBelowZoneAfterRefresh ? 'ON' : 'OFF')
  + ' (FIB_DROP_BELOW_ZONE_AFTER_REFRESH)');
log('');

loadSeen();
loadPositions();
loadPendingFib();

if (process.env.CI === 'true') {
  processTokens().then(() => process.exit(0));
} else {
  runLoop();
  runAutoSellLoop();
  runPendingFibLoop();
  setInterval(doHealthCheck, CFG.healthInterval * 1000);
  setTimeout(() => pushJSONToGitHub(), 60 * 1000); // push pertama setelah 1 menit
  setInterval(() => pushJSONToGitHub(), 10 * 60 * 1000); // push tiap 10 menit
}
