import * as cheerio from 'cheerio';
import dns from 'node:dns/promises';
import net from 'node:net';
import { pool } from './db.js';

const PRIORITY = /(contact|about|price|pricing|plan|faq|shipping|deliver|return|refund|policy|service|product|book|order|hours|location)/i;
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|mp4|mp3|css|js|xml|json|docx?|xlsx?)(\?|$)/i;
const UA = 'Mozilla/5.0 (compatible; CareBotCrawler/1.0)';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

// Block the crawler from being pointed at internal network addresses.
export async function assertPublicUrl(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https URLs are allowed');
  if (u.hostname === 'localhost') throw new Error('That address is not allowed');
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('That address is not allowed');
  return u;
}

function normalize(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = '';
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (SKIP_EXT.test(u.pathname)) return null;
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch { return null; }
}

const sameHost = (a, b) => a.replace(/^www\./, '') === b.replace(/^www\./, '');

export function extractPage(html, url) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, template').remove();
  const title = ($('title').first().text() || $('h1').first().text() || url).replace(/\s+/g, ' ').trim();

  const contacts = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (/^(tel:|mailto:)/i.test(href) || /wa\.me|api\.whatsapp\.com/i.test(href)) contacts.add(href.replace(/^mailto:|^tel:/i, '').trim());
  });

  const seen = new Set();
  const lines = [];
  $('h1,h2,h3,h4,p,li,td,th,dt,dd,address,blockquote,figcaption').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t.length < 2 || seen.has(t)) return;
    seen.add(t);
    lines.push(t);
  });
  let text = lines.join('\n');
  if (text.length < 200) text = $('body').text().replace(/\s+/g, ' ').trim();
  if (contacts.size) text += `\nContact links on this page: ${[...contacts].slice(0, 8).join(', ')}`;
  return { title, text: text.slice(0, 20000) };
}

export function chunkText(text, title, size = 1100) {
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > size && cur) { chunks.push(cur); cur = ''; }
    if (line.length > size) {
      for (let i = 0; i < line.length; i += size) chunks.push(line.slice(i, i + size));
    } else {
      cur += (cur ? '\n' : '') + line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => `${title}\n${c}`);
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(12000),
    redirect: 'follow',
  });
  if (!res.ok) return null;
  if (!(res.headers.get('content-type') || '').includes('text/html')) return null;
  return { html: (await res.text()).slice(0, 2_000_000), finalUrl: res.url };
}

export async function crawlSite(startUrl, { maxPages = 30 } = {}) {
  const start = await assertPublicUrl(startUrl);
  const queue = [normalize(start.toString(), start)];
  const seen = new Set(queue);
  const pages = [];

  // Seed with the sitemap when there is one.
  try {
    const sm = await fetch(new URL('/sitemap.xml', start), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
    if (sm.ok) {
      const xml = await sm.text();
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
        const n = normalize(m[1], start);
        if (n && !n.endsWith('.xml') && sameHost(new URL(n).hostname, start.hostname) && !seen.has(n)) {
          seen.add(n);
          PRIORITY.test(n) ? queue.splice(1, 0, n) : queue.push(n);
        }
      }
    }
  } catch { /* no sitemap, fine */ }

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    try {
      const got = await fetchHtml(url);
      if (!got) continue;
      if (!sameHost(new URL(got.finalUrl).hostname, start.hostname)) continue;
      const { title, text } = extractPage(got.html, url);
      if (text.length > 80) pages.push({ url, title, text });

      const $ = cheerio.load(got.html);
      $('a[href]').each((_, el) => {
        const n = normalize($(el).attr('href'), url);
        if (!n || seen.has(n) || !sameHost(new URL(n).hostname, start.hostname)) return;
        seen.add(n);
        PRIORITY.test(n) ? queue.unshift(n) : queue.push(n);
      });
    } catch { /* skip page */ }
  }
  return pages;
}

export async function crawlAndStore(businessId) {
  const { rows: [b] } = await pool.query('select website_url from businesses where id=$1', [businessId]);
  if (!b) throw new Error('Business not found');
  await pool.query("update businesses set crawl_status='crawling' where id=$1", [businessId]);
  try {
    const pages = await crawlSite(b.website_url);
    if (!pages.length) throw new Error('No readable pages found. If the site is built with client-side JavaScript only, paste the details into Owner notes instead.');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('delete from chunks where business_id=$1', [businessId]);
      for (const p of pages) {
        for (const c of chunkText(p.text, p.title)) {
          await client.query('insert into chunks(business_id,url,title,content) values($1,$2,$3,$4)', [businessId, p.url, p.title, c]);
        }
      }
      await client.query("update businesses set crawl_status='ready', crawled_at=now(), pages_count=$2 where id=$1", [businessId, pages.length]);
      await client.query('commit');
    } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
    return pages.length;
  } catch (e) {
    await pool.query("update businesses set crawl_status=$2 where id=$1", [businessId, `failed: ${e.message}`.slice(0, 300)]);
    throw e;
  }
}
