import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, migrate } from './db.js';
import { crawlAndStore, assertPublicUrl } from './crawler.js';
import { answer } from './brain.js';
import { learnFromChats, autoLearnAll } from './learn.js';
import { connect, disconnect, getSessionInfo, normalizePhone, restoreSessions } from './whatsapp.js';

// WhatsApp's encryption library prints a multi-line stack for every undecryptable message
// (old sessions, status updates, groups). That drowns the real logs, so drop only those lines.
const NOISE = /^(Session error|Failed to decrypt message|Closing open session|Closing session|Removing old closed session|Opening session)|libsignal|Bad MAC/;
const origError = console.error.bind(console);
console.error = (...args) => { if (!NOISE.test(String(args[0]))) origError(...args); };
const origInfo = console.info.bind(console);
console.info = (...args) => { if (!NOISE.test(String(args[0]))) origInfo(...args); };

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 12) { console.error('Set ADMIN_TOKEN (12+ characters) in the environment.'); process.exit(1); }

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
app.use('/api', (req, res, next) => (safeEqual(req.get('x-admin-token') || '', ADMIN_TOKEN) ? next() : res.status(401).json({ error: 'Wrong admin token' })));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: e.message }));
const getBiz = async (id) => (await pool.query('select * from businesses where id=$1', [id])).rows[0];

app.get('/api/businesses', wrap(async (_req, res) => {
  res.json((await pool.query('select * from businesses order by id')).rows);
}));

app.post('/api/businesses', wrap(async (req, res) => {
  const { name, website_url } = req.body;
  if (!name?.trim() || !website_url?.trim()) throw new Error('Name and website URL are required');
  const url = (await assertPublicUrl(/^https?:\/\//i.test(website_url) ? website_url : `https://${website_url}`)).toString();
  const { rows: [b] } = await pool.query('insert into businesses(name, website_url) values($1,$2) returning *', [name.trim(), url]);
  crawlAndStore(b.id).catch((e) => console.error('crawl failed:', e.message));
  res.json(b);
}));

app.patch('/api/businesses/:id', wrap(async (req, res) => {
  const allowed = ['name', 'website_url', 'tone', 'notes', 'handoff_message', 'bot_enabled', 'learned'];
  const keys = Object.keys(req.body).filter((k) => allowed.includes(k));
  if (!keys.length) throw new Error('Nothing to update');
  if (keys.includes('website_url')) await assertPublicUrl(req.body.website_url);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
  const { rows: [b] } = await pool.query(`update businesses set ${sets} where id=$1 returning *`, [req.params.id, ...keys.map((k) => req.body[k])]);
  if (!b) throw new Error('Business not found');
  res.json(b);
}));

app.post('/api/businesses/:id/crawl', wrap(async (req, res) => {
  if (!(await getBiz(req.params.id))) throw new Error('Business not found');
  crawlAndStore(Number(req.params.id)).catch((e) => console.error('crawl failed:', e.message));
  res.json({ started: true });
}));

app.post('/api/businesses/:id/whatsapp/pair', wrap(async (req, res) => {
  if (!(await getBiz(req.params.id))) throw new Error('Business not found');
  const phone = normalizePhone(req.body.phone);
  await connect(Number(req.params.id), { phone });
  res.json({ started: true });
}));

app.get('/api/businesses/:id/whatsapp/status', wrap(async (req, res) => {
  const b = await getBiz(req.params.id);
  if (!b) throw new Error('Business not found');
  const live = getSessionInfo(Number(req.params.id));
  res.json({ status: live?.status || b.wa_status, pairingCode: live?.pairingCode || null, error: live?.error || null, number: b.wa_number });
}));

app.post('/api/businesses/:id/whatsapp/disconnect', wrap(async (req, res) => {
  await disconnect(Number(req.params.id));
  res.json({ ok: true });
}));

app.post('/api/businesses/:id/learn', wrap(async (req, res) => {
  const b = await getBiz(req.params.id);
  if (!b) throw new Error('Business not found');
  if (b.learn_status === 'learning') throw new Error('Already learning, please wait a minute');
  learnFromChats(Number(req.params.id)).catch((e) => console.error('learn failed:', e.message));
  res.json({ started: true });
}));

app.get('/api/businesses/:id/stats', wrap(async (req, res) => {
  const { rows: [r] } = await pool.query(
    `select count(*)::int as total,
            count(*) filter (where role='owner')::int as owner,
            count(*) filter (where role='customer')::int as customer,
            count(*) filter (where source='history')::int as history,
            count(distinct chat_jid)::int as chats
     from messages where business_id=$1`, [req.params.id]);
  res.json(r);
}));

app.get('/api/businesses/:id/messages', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'select chat_jid, role, text, created_at from messages where business_id=$1 order by id desc limit 100', [req.params.id]);
  res.json(rows);
}));

// Playground: talk to the bot without WhatsApp. The browser keeps the history.
app.post('/api/businesses/:id/test', wrap(async (req, res) => {
  const b = await getBiz(req.params.id);
  if (!b) throw new Error('Business not found');
  const history = (req.body.history || []).slice(-14).map((m) => ({ role: m.role === 'customer' ? 'customer' : 'bot', text: String(m.text).slice(0, 2000) }));
  res.json(await answer(b, history));
}));

const port = Number(process.env.PORT || 3000);
await migrate();
// A restart in the middle of a job would leave it stuck on "working" forever.
await pool.query("update businesses set learn_status='never' where learn_status='learning'");
await pool.query("update businesses set crawl_status='failed: interrupted by a restart, press Re-read website' where crawl_status='crawling'");
app.listen(port, () => console.log(`Care bot dashboard on :${port}`));
restoreSessions().catch((e) => console.error('restore failed:', e.message));
// Refresh what the bot has learned from the owner's chats every few hours when there are new replies.
setInterval(() => autoLearnAll().catch((e) => console.error('auto-learn failed:', e.message)), 6 * 3600_000);
