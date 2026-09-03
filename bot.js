require('dotenv').config();
const bs58 = require('bs58');
const TelegramBot = require('node-telegram-bot-api');
const {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
  setAuthority,
  AuthorityType,
} = require('@solana/spl-token');

const REQUIRED_ENV = [
  'BOT_TOKEN',
  'OWNER_CHAT_ID',
  'RPC_URL',
  'MINT_ADDRESS',
  'WALLET_SECRET_KEY',
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Environment variable ${key} belum diisi`);
    process.exit(1);
  }
}

const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID.toString();
const MINT_ADDRESS = new PublicKey(process.env.MINT_ADDRESS);

const connection = new Connection(process.env.RPC_URL, 'confirmed');

let secretKeyArray;
try {
  const raw = process.env.WALLET_SECRET_KEY.trim();
  secretKeyArray = raw.startsWith('[')
    ? Uint8Array.from(JSON.parse(raw))
    : bs58.decode(raw);
} catch (err) {
  console.error('[FATAL] WALLET_SECRET_KEY tidak valid.');
  process.exit(1);
}
const wallet = Keypair.fromSecretKey(secretKeyArray);

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const pendingConfirmation = new Map();
const CONFIRM_TIMEOUT_MS = 60 * 1000;

function isOwner(msg) {
  return msg.chat.id.toString() === OWNER_CHAT_ID;
}

function guard(msg) {
  if (!isOwner(msg)) {
    bot.sendMessage(msg.chat.id, 'Maaf, bot ini bersifat pribadi.');
    return false;
  }
  return true;
}

function formatAmount(rawAmount, decimals) {
  return (Number(rawAmount) / 10 ** decimals).toLocaleString('id-ID', {
    maximumFractionDigits: decimals,
  });
}

async function getMintInfo() {
  return getMint(connection, MINT_ADDRESS);
}

async function getOwnerTokenAccount() {
  return getOrCreateAssociatedTokenAccount(
    connection,
    wallet,
    MINT_ADDRESS,
    wallet.publicKey
  );
}

const HELP_TEXT = `*Perintah yang tersedia:*

/balance — cek saldo SOL & token
/info — info mint token (supply, desimal, otoritas)
/mint <jumlah> — cetak token baru ke wallet kamu
/transfer <alamat> <jumlah> — kirim token ke alamat lain
/lock — kunci otoritas mint selamanya (fixed supply, PERMANEN)
/cancel — batalkan konfirmasi yang sedang menunggu

Aksi berbahaya (mint besar, transfer, lock) akan meminta konfirmasi ketik *ya* sebelum dieksekusi.`;

bot.onText(/\/start/, (msg) => {
  if (!guard(msg)) return;
  bot.sendMessage(msg.chat.id, `Halo! Bot kontrol token Solana aktif.\n\n${HELP_TEXT}`, {
    parse_mode: 'Markdown',
  });
});

bot.onText(/\/help/, (msg) => {
  if (!guard(msg)) return;
  bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: 'Markdown' });
});

bot.onText(/\/balance/, async (msg) => {
  if (!guard(msg)) return;
  try {
    const solBalance = await connection.getBalance(wallet.publicKey);
    const mintInfo = await getMintInfo();
    const tokenAccount = await getOwnerTokenAccount();

    bot.sendMessage(
      msg.chat.id,
      `*Saldo Wallet*\n` +
        `SOL: ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n` +
        `Token: ${formatAmount(tokenAccount.amount, mintInfo.decimals)}\n\n` +
        `Alamat: \`${wallet.publicKey.toBase58()}\``,
      { parse_mode: 'Markdown' }
    );} catch (err) {
  console.error('Error balance:', err && err.stack ? err.stack : JSON.stringify(err));
  bot.sendMessage(msg.chat.id, `Gagal mengambil saldo: ${err.message}`);
}
  } catch (err) {
    bot.sendMessage(msg.chat.id, `Gagal mengambil saldo: ${err.message}`);
  }
});

bot.onText(/\/info/, async (msg) => {
  if (!guard(msg)) return;
  try {
    const mintInfo = await getMintInfo();
    bot.sendMessage(
      msg.chat.id,
      `*Info Token*\n` +
        `Mint: \`${MINT_ADDRESS.toBase58()}\`\n` +
        `Desimal: ${mintInfo.decimals}\n` +
        `Total Supply: ${formatAmount(mintInfo.supply, mintInfo.decimals)}\n` +
        `Otoritas Mint: ${mintInfo.mintAuthority ? mintInfo.mintAuthority.toBase58() : 'Sudah dikunci (fixed supply)'}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    bot.sendMessage(msg.chat.id, `Gagal mengambil info token: ${err.message}`);
  }
});

bot.onText(/\/mint (.+)/, async (msg, match) => {
  if (!guard(msg)) return;
  const amountInput = parseFloat(match[1]);
  if (isNaN(amountInput) || amountInput <= 0) {
    return bot.sendMessage(msg.chat.id, 'Jumlah tidak valid. Contoh: /mint 1000');
  }

  pendingConfirmation.set(msg.chat.id, {
    action: 'mint',
    params: { amount: amountInput },
    expiresAt: Date.now() + CONFIRM_TIMEOUT_MS,
  });

  bot.sendMessage(
    msg.chat.id,
    `Kamu akan mencetak *${amountInput.toLocaleString('id-ID')}* token baru.\n` +
      `Ketik *ya* untuk konfirmasi (berlaku 60 detik), atau /cancel untuk batal.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/transfer (\S+) (.+)/, async (msg, match) => {
  if (!guard(msg)) return;
  const destAddress = match[1];
  const amountInput = parseFloat(match[2]);

  let destPubkey;
  try {
    destPubkey = new PublicKey(destAddress);
  } catch {
    return bot.sendMessage(msg.chat.id, 'Alamat tujuan tidak valid.');
  }
  if (isNaN(amountInput) || amountInput <= 0) {
    return bot.sendMessage(msg.chat.id, 'Jumlah tidak valid. Contoh: /transfer <alamat> 100');
  }

  pendingConfirmation.set(msg.chat.id, {
    action: 'transfer',
    params: { destAddress, amount: amountInput },
    expiresAt: Date.now() + CONFIRM_TIMEOUT_MS,
  });

  bot.sendMessage(
    msg.chat.id,
    `Kamu akan mengirim *${amountInput.toLocaleString('id-ID')}* token ke:\n\`${destAddress}\`\n\n` +
      `Ketik *ya* untuk konfirmasi (berlaku 60 detik), atau /cancel untuk batal.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/lock/, (msg) => {
  if (!guard(msg)) return;

  pendingConfirmation.set(msg.chat.id, {
    action: 'lock',
    params: {},
    expiresAt: Date.now() + CONFIRM_TIMEOUT_MS,
  });

  bot.sendMessage(
    msg.chat.id,
    `⚠️ Ini akan *mengunci otoritas mint token secara PERMANEN*.\n\n` +
      `Ketik *ya* untuk konfirmasi (berlaku 60 detik), atau /cancel untuk batal.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/cancel/, (msg) => {
  if (!guard(msg)) return;
  pendingConfirmation.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, 'Aksi dibatalkan.');
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!isOwner(msg)) return;
  if (msg.text.trim().toLowerCase() !== 'ya') return;

  const pending = pendingConfirmation.get(msg.chat.id);
  if (!pending) {
    return bot.sendMessage(msg.chat.id, 'Tidak ada aksi yang menunggu konfirmasi.');
  }
  if (Date.now() > pending.expiresAt) {
    pendingConfirmation.delete(msg.chat.id);
    return bot.sendMessage(msg.chat.id, 'Waktu konfirmasi sudah habis, ulangi perintahnya.');
  }
  pendingConfirmation.delete(msg.chat.id);

  try {
    if (pending.action === 'mint') {
      const mintInfo = await getMintInfo();
      const tokenAccount = await getOwnerTokenAccount();
      const rawAmount = BigInt(Math.round(pending.params.amount * 10 ** mintInfo.decimals));

      const sig = await mintTo(
        connection,
        wallet,
        MINT_ADDRESS,
        tokenAccount.address,
        wallet,
        rawAmount
      );
      bot.sendMessage(msg.chat.id, `✅ Berhasil mint token.\nTx: https://solscan.io/tx/${sig}`);
    }

    if (pending.action === 'transfer') {
      const mintInfo = await getMintInfo();
      const sourceAccount = await getOwnerTokenAccount();
      const destPubkey = new PublicKey(pending.params.destAddress);
      const destAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        wallet,
        MINT_ADDRESS,
        destPubkey
      );
      const rawAmount = BigInt(Math.round(pending.params.amount * 10 ** mintInfo.decimals));

      const sig = await transfer(
        connection,
        wallet,
        sourceAccount.address,
        destAccount.address,
        wallet,
        rawAmount
      );
      bot.sendMessage(msg.chat.id, `✅ Berhasil transfer token.\nTx: https://solscan.io/tx/${sig}`);
    }

    if (pending.action === 'lock') {
      const sig = await setAuthority(
        connection,
        wallet,
        MINT_ADDRESS,
        wallet,
        AuthorityType.MintTokens,
        null
      );
      bot.sendMessage(
        msg.chat.id,
        `✅ Otoritas mint sudah dikunci permanen.\nTx: https://solscan.io/tx/${sig}`
      );
    }
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ Aksi gagal: ${err.message}`);
  }
});

console.log('Bot Telegram Solana berjalan...');
