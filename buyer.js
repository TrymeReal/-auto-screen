const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58'); // v6 butuh .default, v4/v5 jalan langsung

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_API = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_API = 'https://lite-api.jup.ag/swap/v1/swap';

// Buffer SOL yang gak boleh dipakai (buat fee + ATA rent + priority fee 'auto' yang bisa spike).
const FEE_BUFFER_SOL = 0.008;

function getConfig() {
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL;
  if (!privateKey) throw new Error('PRIVATE_KEY not set in environment');
  if (!rpcUrl) throw new Error('RPC_URL not set in environment');
  return { privateKey, rpcUrl };
}

let DRY_RUN = false;

function setDryRun(val) {
  DRY_RUN = val;
}

// Konfirmasi transaksi pakai format blockhash (yang lama deprecated + sering timeout).
// Return value confirmTransaction punya .value.err — kalau gak null, transaksi GAGAL on-chain.
async function confirmOrThrow(connection, txSignature) {
  const latest = await connection.getLatestBlockhash('confirmed');
  const conf = await connection.confirmTransaction({
    signature: txSignature,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }, 'confirmed');
  if (conf.value && conf.value.err) {
    throw new Error('Transaksi gagal on-chain: ' + JSON.stringify(conf.value.err) + ' | tx: ' + txSignature);
  }
  return conf;
}

// Baca jumlah token aktual yang masuk ke wallet (bukan estimasi quote).
// Ini yang bikin PNL akurat — slippage gak bikin angka meleset.
async function getTokenBalance(connection, ownerPubkey, mintAddress) {
  const resp = await connection.getParsedTokenAccountsByOwner(ownerPubkey, {
    mint: new PublicKey(mintAddress),
  });
  let total = 0;
  let decimals = 0;
  for (const acc of resp.value) {
    const info = acc.account.data.parsed.info.tokenAmount;
    total += Number(info.uiAmount);
    decimals = info.decimals;
  }
  return { uiAmount: total, decimals };
}

async function buyToken(mintAddress, amountSol, slippageBps) {
  if (DRY_RUN) {
    var mockTx = 'DRY_RUN_' + Date.now();
    var mockTokenAmount = (amountSol / 0.000001) * (1 + (Math.random() - 0.5) * 0.1);
    var mockPrice = amountSol / mockTokenAmount;
    console.log('[BUYER] DRY RUN: Would buy token ' + mintAddress + ' with ' + amountSol + ' SOL');
    return { txSignature: mockTx, entryPriceSol: mockPrice, tokenAmount: mockTokenAmount, tokenDecimals: 6 };
  }

  const { privateKey, rpcUrl } = getConfig();
  const connection = new Connection(rpcUrl, 'confirmed');
  const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));

  // Cek saldo cukup (amount + buffer fee). Kalau mepet, transaksi pasti gagal.
  const balanceLamports = await connection.getBalance(wallet.publicKey);
  const neededLamports = Math.floor((amountSol + FEE_BUFFER_SOL) * 1e9);
  if (balanceLamports < neededLamports) {
    throw new Error(
      'Saldo SOL kurang: butuh ~' + (amountSol + FEE_BUFFER_SOL) + ' SOL (termasuk buffer fee), '
      + 'cuma ada ' + (balanceLamports / 1e9).toFixed(4) + ' SOL'
    );
  }

  const lamports = Math.floor(amountSol * 1e9);

  const quoteParams = new URLSearchParams({
    inputMint: SOL_MINT,
    outputMint: mintAddress,
    amount: lamports.toString(),
    slippageBps: slippageBps.toString(),
  });

  const quoteRes = await fetch(`${JUPITER_QUOTE_API}?${quoteParams}`);
  if (!quoteRes.ok) {
    const text = await quoteRes.text();
    throw new Error(`Jupiter quote failed (${quoteRes.status}): ${text}`);
  }
  const quote = await quoteRes.json();

  // Saldo token SEBELUM beli (buat hitung selisih = jumlah real yang masuk)
  const before = await getTokenBalance(connection, wallet.publicKey, mintAddress);

  const swapRes = await fetch(JUPITER_SWAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  if (!swapRes.ok) {
    const text = await swapRes.text();
    throw new Error(`Jupiter swap failed (${swapRes.status}): ${text}`);
  }
  const { swapTransaction } = await swapRes.json();

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([wallet]);

  const txSignature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  // Cek transaksi BENERAN sukses, bukan cuma terkirim
  await confirmOrThrow(connection, txSignature);

  // Jumlah token AKTUAL = saldo sesudah - saldo sebelum (akurat setelah slippage)
  const after = await getTokenBalance(connection, wallet.publicKey, mintAddress);
  let tokenAmount = after.uiAmount - before.uiAmount;
  const outDecimals = after.decimals || before.decimals;

  // Fallback ke quote kalau balance belum ke-update (RPC lag), biar gak return 0
  if (!tokenAmount || tokenAmount <= 0) {
    const mintSupply = await connection.getTokenSupply(new PublicKey(mintAddress));
    const dec = mintSupply.value.decimals;
    tokenAmount = Number(quote.outAmount) / Math.pow(10, dec);
    const entryPriceSol = amountSol / tokenAmount;
    console.log('[BUYER] Bought (quote fallback) ' + tokenAmount + ' tokens | tx: ' + txSignature);
    return { txSignature, entryPriceSol, tokenAmount, tokenDecimals: dec };
  }

  const entryPriceSol = amountSol / tokenAmount;
  console.log('[BUYER] Bought ' + tokenAmount + ' tokens | tx: ' + txSignature + ' | entry ' + entryPriceSol + ' SOL/token');

  return { txSignature, entryPriceSol, tokenAmount, tokenDecimals: outDecimals };
}

async function sellToken(mintAddress, tokenAmount, tokenDecimals, slippageBps, dryRunEstimateSol) {
  if (DRY_RUN) {
    var mockTx = 'DRY_RUN_SELL_' + Date.now();
    console.log('[BUYER] DRY RUN: Would sell ' + tokenAmount + ' tokens of ' + mintAddress);
    return { txSignature: mockTx, solReceived: dryRunEstimateSol || 0 };
  }

  const { privateKey, rpcUrl } = getConfig();
  const connection = new Connection(rpcUrl, 'confirmed');
  const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));

  const amountSmallest = Math.floor(tokenAmount * Math.pow(10, tokenDecimals));

  const quoteParams = new URLSearchParams({
    inputMint: mintAddress,
    outputMint: SOL_MINT,
    amount: amountSmallest.toString(),
    slippageBps: slippageBps.toString(),
  });

  const quoteRes = await fetch(`${JUPITER_QUOTE_API}?${quoteParams}`);
  if (!quoteRes.ok) {
    const text = await quoteRes.text();
    throw new Error(`Jupiter sell quote failed (${quoteRes.status}): ${text}`);
  }
  const quote = await quoteRes.json();

  // Saldo SOL sebelum jual (buat hitung SOL real yang masuk)
  const solBefore = await connection.getBalance(wallet.publicKey);

  const swapRes = await fetch(JUPITER_SWAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  if (!swapRes.ok) {
    const text = await swapRes.text();
    throw new Error(`Jupiter sell swap failed (${swapRes.status}): ${text}`);
  }
  const { swapTransaction } = await swapRes.json();

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([wallet]);

  const txSignature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  await confirmOrThrow(connection, txSignature);

  // SOL real yang masuk = saldo sesudah - sebelum (estimasi quote bisa meleset karena slippage + fee)
  const solAfter = await connection.getBalance(wallet.publicKey);
  let solReceived = (solAfter - solBefore) / 1e9;
  if (!solReceived || solReceived <= 0) {
    solReceived = Number(quote.outAmount) / 1e9; // fallback quote kalau RPC lag
  }

  console.log('[BUYER] Sold ' + tokenAmount + ' tokens | tx: ' + txSignature + ' | got ' + solReceived + ' SOL');
  return { txSignature, solReceived };
}

module.exports = { buyToken, sellToken, setDryRun };
