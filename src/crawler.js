import * as cheerio from 'cheerio';
import dns from 'node:dns/promises';
import net from 'node:net';
import { pool } from './db.js';

const PRIORITY = /(contact|about|price|pricing|plan|faq|shipping|deliver|return|refund|policy|service|product|book|order|hours|location)/i;
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|mp4|mp3|css|js|xml|json|docx?|xlsx?)(\?|$)/i;
// Many sites refuse requests that look like robots, so present as an ordinary phone browser.
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
// Sites built with JavaScript (React, Wix, Webflow, Lovable...) send an almost empty page. A "reader" service opens
// them in a real browser and returns the text. Free without a key (about 20 requests/minute); set JINA_API_KEY for more.
const READER = 'https://r.jina.ai/';
const MIN_DIRECT_TEXT = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Turns the reader service's markdown answer into { title, text, links }.
export function parseReader(md, url) {
  const title = (md.match(/^Title:\s*(.+)$/m)?.[1] || url).trim();
  const bodyStart = md.search(/^Markdown Content:\s*$/m);
  let body = bodyStart >= 0 ? md.slice(bodyStart).replace(/^Markdown Content:\s*\n?/, '') : md;
  const linkStart = body.search(/^(Links\/Buttons|Images):\s*$/m);
  const tail = linkStart >= 0 ? body.slice(linkStart) : '';
  if (linkStart >= 0) body = body.slice(0, linkStart);

  const links = new Set();
  for (const m of (body + '\n' + tail).matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) links.add(m[1]);
  for (const m of tail.matchAll(/^\s*[-*]?\s*(?:\[[^\]]*\]\()?(https?:\/\/[^)\s]+)/gm)) links.add(m[1]);

  const text = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')        // images
    .replace(/\[([^\]]*)\]\((?:https?:|tel:|mailto:)[^)]*\)/g, '$1') // links -> their text
    .replace(/^[ \t]*[*\-+][ \t]+/gm, '')          // bullet markers
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')          // heading markers
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text: text.slice(0, 20000), links: [...links] };
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

// Returns { html, finalUrl } or { fail } with a plain-language reason.
async function fetchDirect(url) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (!res.ok) return { fail: `the site answered HTTP ${res.status}` };
    if (!(res.headers.get('content-type') || '').includes('text/html')) return { fail: 'the address is not a normal web page' };
    return { html: (await res.text()).slice(0, 2_000_000), finalUrl: res.url };
  } catch (e) {
    return { fail: e.name === 'TimeoutError' ? 'the site took too long to answer' : `could not connect (${e.message})` };
  }
}

async function fetchViaReader(url) {
  const headers = { accept: 'text/plain', 'x-return-format': 'markdown', 'x-with-links-summary': 'true', 'x-timeout': '25' };
  if (process.env.JINA_API_KEY) headers.authorization = `Bearer ${process.env.JINA_API_KEY}`;
  const res = await fetch(READER + url, { headers, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`reader service answered HTTP ${res.status}`);
  return parseReader(await res.text(), url);
}

export async function crawlSite(startUrl, { maxPages = 30, maxReaderPages = 12, maxMs = 4 * 60_000 } = {}) {
  const start = await assertPublicUrl(startUrl);
  const deadline = Date.now() + maxMs;
  const queue = [normalize(start.toString(), start)];
  const seen = new Set(queue);
  const pages = [];
  const failures = [];
  let readerCalls = 0;
  let lastReader = 0;

  const enqueue = (href, base) => {
    const n = normalize(href, base);
    if (!n || seen.has(n) || !sameHost(new URL(n).hostname, start.hostname)) return;
    seen.add(n);
    PRIORITY.test(n) ? queue.unshift(n) : queue.push(n);
  };

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

  while (queue.length && pages.length < maxPages && Date.now() < deadline) {
    const url = queue.shift();
    let page = null;
    let weak = null; // thin text from a plain fetch, used if the reader cannot do better

    const direct = await fetchDirect(url);
    if (direct.html) {
      const sameFinal = sameHost(new URL(direct.finalUrl).hostname, start.hostname);
      if (sameFinal) {
        const { title, text } = extractPage(direct.html, url);
        const $ = cheerio.load(direct.html);
        $('a[href]').each((_, el) => enqueue($(el).attr('href'), url));
        if (text.length >= MIN_DIRECT_TEXT) page = { url, title, text };
        else if (text.length > 80) weak = { url, title, text };
      }
    } else if (failures.length < 3) {
      failures.push(`${url}: ${direct.fail}`);
    }

    // Empty shell (JavaScript site) or blocked: open it in a real browser through the reader service.
    if (!page && readerCalls < maxReaderPages && Date.now() < deadline) {
      if (!process.env.JINA_API_KEY) await sleep(Math.max(0, 3200 - (Date.now() - lastReader)));
      readerCalls++; lastReader = Date.now();
      try {
        const r = await fetchViaReader(url);
        r.links.forEach((l) => enqueue(l, url));
        if (r.text.length > 80) page = { url, title: r.title, text: r.text };
      } catch (e) {
        if (failures.length < 3) failures.push(`${url}: ${e.message}`);
      }
    }

    page = page || weak;
    if (page) pages.push(page);
  }
  return { pages, failures, readerCalls };
}

export async function crawlAndStore(businessId) {
  const { rows: [b] } = await pool.query('select website_url from businesses where id=$1', [businessId]);
  if (!b) throw new Error('Business not found');
  await pool.query("update businesses set crawl_status='crawling' where id=$1", [businessId]);
  try {
    const { pages, failures } = await crawlSite(b.website_url);
    if (!pages.length) {
      throw new Error(`Could not read this website (${failures[0] || 'no readable text found'}). Paste your business details into Owner notes instead.`);
    }
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
