import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from 'baileys';
import pino from 'pino';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from './db.js';
import { answer } from './brain.js';
import { learnFromChats } from './learn.js';

const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';
const OWNER_PAUSE_HOURS = Number(process.env.OWNER_PAUSE_HOURS || 12);
const HANDOFF_PAUSE_HOURS = 6;
const MAX_REPLIES_PER_HOUR = 25;
const BATCH_WAIT_MS = 3500;
// Baileys logs every undecryptable status update / group message at error level. Those are harmless
// and would bury the useful lines, so only fatal problems are shown. Our own console.log lines cover the rest.
const logger = pino({ level: 'fatal' });

const sessions = new Map(); // businessId -> session state
const botSent = new Set(); // message ids sent by the bot, so they are not mistaken for the owner typing
const buffers = new Map(); // "bizId:jid" -> { texts, timer }
const replyLog = new Map(); // "bizId:jid" -> [timestamps]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizePhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  const cc = process.env.DEFAULT_COUNTRY_CODE || '234';
  if (d.startsWith('0')) d = cc + d.slice(1);
  if (d.length < 10 || d.length > 15) throw new Error('Enter the WhatsApp number with country code, e.g. 2347012345678');
  return d;
}

async function setStatus(businessId, status, number) {
  await pool.query('update businesses set wa_status=$2, wa_number=coalesce($3, wa_number) where id=$1', [businessId, status, number ?? null]);
}

export function getSessionInfo(businessId) {
  const s = sessions.get(businessId);
  return s ? { status: s.status, pairingCode: s.pairingCode, error: s.error || null } : null;
}

export async function connect(businessId, { phone, restored } = {}) {
  const dir = path.join(SESSIONS_DIR, String(businessId));
  const prev = sessions.get(businessId);
  if (prev?.status === 'connected' && !phone) return prev;
  if (prev?.sock) { prev.closing = true; try { prev.sock.end(undefined); } catch { /* already closed */ } }
  if (phone) await fs.rm(dir, { recursive: true, force: true }); // fresh pairing
  await fs.mkdir(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state, logger,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false, syncFullHistory: false, markOnlineOnConnect: false,
  });

  const s = {
    sock, status: 'connecting', pairingCode: null, error: null, phone: phone || null,
    requested: false, closing: false, retries: prev?.retries ?? 0,
    everOpened: Boolean(restored || (!phone && prev?.everOpened)),
  };
  sessions.set(businessId, s);

  sock.ev.on('creds.update', saveCreds);

  // Ask WhatsApp for the 8-character pairing code (once). Triggered by the first QR event, or after
  // 4 seconds if this version of the library does not emit one.
  const requestCode = async () => {
    if (!s.phone || s.requested || s.everOpened || state.creds.registered) return;
    s.requested = true;
    try {
      const code = await sock.requestPairingCode(s.phone);
      s.pairingCode = code.match(/.{1,4}/g).join('-');
      s.status = 'awaiting_code';
      await setStatus(businessId, 'awaiting_code');
      console.log('pairing code issued');
    } catch (e) {
      s.status = 'error'; s.error = e.message;
      console.error('pairing code failed:', e.message);
    }
  };
  if (s.phone) setTimeout(() => { if (sessions.get(businessId) === s) requestCode(); }, 4000);

  sock.ev.on('connection.update', async (u) => {
    if (sessions.get(businessId) !== s) return;
    const { connection, lastDisconnect, qr } = u;

    // The socket is ready for a pairing request once WhatsApp offers a QR.
    if (qr) requestCode();

    if (connection === 'open') {
      s.status = 'connected'; s.pairingCode = null; s.everOpened = true; s.retries = 0; s.error = null;
      const number = sock.user?.id?.split(':')[0].split('@')[0];
      await setStatus(businessId, 'connected', number);
    }

    if (connection === 'close') {
      if (s.closing) return;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        sessions.delete(businessId);
        await fs.rm(dir, { recursive: true, force: true });
        await setStatus(businessId, 'disconnected');
        return;
      }
      // Pairing never completed (code expired or wrong). Stop instead of looping.
      if (!s.everOpened && code !== DisconnectReason.restartRequired) {
        s.status = 'pairing_failed'; s.pairingCode = null;
        s.error = 'The code expired or was not entered. Request a new one.';
        await setStatus(businessId, 'disconnected');
        return;
      }
      s.status = 'reconnecting';
      await setStatus(businessId, 'reconnecting');
      const wait = code === DisconnectReason.restartRequired ? 500 : Math.min(30000, 2000 * 2 ** s.retries++);
      setTimeout(() => connect(businessId).catch((e) => console.error('reconnect failed', e.message)), wait);
    }
  });

  // When WhatsApp is linked, it sends recent chat history once. Keep the text of one-to-one chats so the bot
  // can learn how the owner talks to customers and remember earlier conversations with each customer.
  sock.ev.on('messaging-history.set', async ({ messages = [] }) => {
    try {
      const cutoff = Date.now() / 1000 - 180 * 86400;
      const rows = [];
      for (const m of messages) {
        const jid = m.key?.remoteJid;
        if (!jid || !(jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) || !m.key.id) continue;
        const text = extractText(m.message);
        const ts = Number(m.messageTimestamp || 0);
        if (!text || !(ts > cutoff)) continue;
        rows.push({ jid, role: m.key.fromMe ? 'owner' : 'customer', text: text.slice(0, 2000), at: new Date(ts * 1000).toISOString(), id: m.key.id });
      }
      let stored = 0;
      for (let i = 0; i < rows.length; i += 1000) {
        const part = rows.slice(i, i + 1000);
        const r = await pool.query(
          `insert into messages(business_id, chat_jid, role, text, created_at, source, wa_id)
           select $1, t.jid, t.role, t.text, t.at::timestamptz, 'history', t.id
           from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) as t(jid, role, text, at, id)
           on conflict do nothing`,
          [businessId, part.map((x) => x.jid), part.map((x) => x.role), part.map((x) => x.text), part.map((x) => x.at), part.map((x) => x.id)]);
        stored += r.rowCount;
      }
      console.log(`history sync: received ${messages.length}, stored ${stored} text messages from 1:1 chats`);
      if (stored > 0) {
        // History arrives in several parts: learn once, shortly after the last one.
        clearTimeout(s.learnTimer);
        s.learnTimer = setTimeout(() => learnFromChats(businessId).catch((e) => console.error('learn failed:', e.message)), 45_000);
      }
    } catch (e) { console.error('history sync error:', e.message); }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' = live message. 'append' = delivered while the server was restarting or reconnecting
    // (every redeploy!). Accept those too, but only if they are recent, so old history is never answered.
    if (type !== 'notify' && type !== 'append') return;
    for (const m of messages) {
      if (type === 'append') {
        const ageSec = Date.now() / 1000 - Number(m.messageTimestamp || 0);
        if (!(ageSec >= 0 && ageSec < 600)) continue;
      }
      try { await onMessage(businessId, s, m); } catch (e) { console.error('message error:', e.message); }
    }
  });

  return s;
}

export async function disconnect(businessId) {
  const s = sessions.get(businessId);
  if (s?.sock) {
    s.closing = true;
    try { await s.sock.logout(); } catch { try { s.sock.end(undefined); } catch { /* ignore */ } }
  }
  sessions.delete(businessId);
  await fs.rm(path.join(SESSIONS_DIR, String(businessId)), { recursive: true, force: true });
  await setStatus(businessId, 'disconnected');
}

export async function restoreSessions() {
  const { rows } = await pool.query("select id from businesses where wa_status in ('connected','reconnecting')");
  for (const { id } of rows) {
    connect(id, { restored: true }).catch((e) => console.error(`restore ${id} failed:`, e.message));
    await sleep(1500);
  }
}

// ---------- message handling ----------

function extractText(msg) {
  if (!msg) return '';
  const m = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg;
  return (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '').trim();
}

function mediaKind(msg) {
  const m = msg?.ephemeralMessage?.message || msg?.viewOnceMessage?.message || msg || {};
  if (m.imageMessage) return 'an image';
  if (m.audioMessage) return 'a voice note';
  if (m.videoMessage) return 'a video';
  if (m.documentMessage) return 'a document';
  if (m.locationMessage) return 'a location';
  return null;
}

async function log(businessId, jid, role, text, waId = null) {
  await pool.query(
    'insert into messages(business_id,chat_jid,role,text,wa_id) values($1,$2,$3,$4,$5) on conflict do nothing',
    [businessId, jid, role, text, waId]);
}

async function pauseChat(businessId, jid, hours) {
  await pool.query(
    `insert into chat_state(business_id,chat_jid,paused_until) values($1,$2, now() + ($3 || ' hours')::interval)
     on conflict (business_id,chat_jid) do update set paused_until = excluded.paused_until`,
    [businessId, jid, String(hours)]);
}

async function resumeChat(businessId, jid) {
  await pool.query('delete from chat_state where business_id=$1 and chat_jid=$2', [businessId, jid]);
}

async function isPaused(businessId, jid) {
  const { rows } = await pool.query('select 1 from chat_state where business_id=$1 and chat_jid=$2 and paused_until > now()', [businessId, jid]);
  return rows.length > 0;
}

function underRateLimit(key) {
  const now = Date.now();
  const list = (replyLog.get(key) || []).filter((t) => now - t < 3600_000);
  if (list.length >= MAX_REPLIES_PER_HOUR) { replyLog.set(key, list); return false; }
  list.push(now); replyLog.set(key, list);
  return true;
}

async function sendText(sock, jid, text) {
  const id = '3EB0' + crypto.randomBytes(9).toString('hex').toUpperCase();
  botSent.add(id);
  setTimeout(() => botSent.delete(id), 120_000);
  try {
    await sock.presenceSubscribe(jid).catch(() => {});
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(Math.min(6000, 800 + text.length * 30)); // human-like typing delay
    await sock.sendPresenceUpdate('paused', jid);
  } catch { /* presence is cosmetic */ }
  await sock.sendMessage(jid, { text }, { messageId: id });
}

async function onMessage(businessId, s, m) {
  const jid = m.key.remoteJid;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;

  if (!m.message) {
    // WhatsApp delivered an envelope we could not decrypt (it asks the sender's phone to resend).
    console.log(`empty message, probably undecryptable: chat=${jid.split('@')[1]} fromMe=${!!m.key.fromMe} stub=${m.messageStubType ?? '-'}`);
    return;
  }

  // The owner typing from their own phone.
  if (m.key.fromMe) {
    if (botSent.delete(m.key.id)) return;
    const text = extractText(m.message);
    if (!text) return;
    if (/^!bot\s+on$/i.test(text)) { await resumeChat(businessId, jid); return; }
    if (/^!bot\s+off$/i.test(text)) { await pauseChat(businessId, jid, 24 * 365); return; }
    await log(businessId, jid, 'owner', text, m.key.id);
    await pauseChat(businessId, jid, OWNER_PAUSE_HOURS);
    return;
  }

  let text = extractText(m.message);
  if (!text) {
    const kind = mediaKind(m.message);
    if (!kind) { // stickers, reactions, protocol messages
      console.log(`ignored message with no text: chat=${jid.split('@')[1]} types=${Object.keys(m.message).join(',')}`);
      return;
    }
    text = `[The customer sent ${kind}]`;
  }

  const { rows: [b] } = await pool.query('select * from businesses where id=$1', [businessId]);
  if (!b) return;
  await log(businessId, jid, 'customer', text, m.key.id);
  const paused = await isPaused(businessId, jid);
  console.log(`incoming chat=${jid.split('@')[1]} len=${text.length} bot_enabled=${b.bot_enabled} paused=${paused}`);
  if (!b.bot_enabled || paused) return;

  // Customers often send several short messages in a row: wait a moment and answer them together.
  const key = `${businessId}:${jid}`;
  const buf = buffers.get(key) || { name: m.pushName || '' };
  clearTimeout(buf.timer);
  buf.name = m.pushName || buf.name;
  buf.timer = setTimeout(() => {
    buffers.delete(key);
    respond(businessId, s, jid, buf.name).catch((e) => console.error('respond error:', e.message));
  }, BATCH_WAIT_MS);
  buffers.set(key, buf);
}

async function respond(businessId, s, jid, customerName) {
  if (sessions.get(businessId) !== s || s.status !== 'connected') return;
  const { rows: [b] } = await pool.query('select * from businesses where id=$1', [businessId]);
  if (!b?.bot_enabled || (await isPaused(businessId, jid))) return;
  if (!underRateLimit(`${businessId}:${jid}`)) return;

  const { rows } = await pool.query(
    'select role, text from messages where business_id=$1 and chat_jid=$2 order by id desc limit 14', [businessId, jid]);
  const history = rows.reverse();

  const result = await answer(b, history);
  console.log(`answer confidence=${result.confidence} needs_human=${result.needs_human} reason=${result.reason || '-'}`);
  await sendText(s.sock, jid, result.reply);
  console.log('reply sent');
  await log(businessId, jid, 'bot', result.reply);

  if (result.needs_human) {
    // A technical AI failure should not silence the bot in this chat; a real handover should.
    const aiFault = /^AI error/.test(result.reason || '');
    if (!aiFault) await pauseChat(businessId, jid, HANDOFF_PAUSE_HOURS);
    const lastCustomer = [...history].reverse().find((h) => h.role === 'customer')?.text || '';
    const number = jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null;
    const ownerJid = `${s.sock.user.id.split(':')[0].split('@')[0]}@s.whatsapp.net`;
    const note =
      `🔔 A customer needs you\n` +
      `${customerName ? `Name: ${customerName}\n` : ''}${number ? `Chat: wa.me/${number}\n` : ''}` +
      `Reason: ${result.reason || 'needs a human'}\nTheir last message: "${lastCustomer.slice(0, 200)}"\n\n` +
      `The bot is paused in that chat for ${HANDOFF_PAUSE_HOURS}h. Reply to them yourself. Send "!bot on" in that chat to switch the bot back on.`;
    const id = '3EB0' + crypto.randomBytes(9).toString('hex').toUpperCase();
    botSent.add(id);
    await s.sock.sendMessage(ownerJid, { text: note }, { messageId: id }).catch((e) => console.error('owner notify failed:', e.message));
  }
}
