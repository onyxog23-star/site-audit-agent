// Site Audit Agent — server function (runs on Vercel, keys stay here)
// Flow: collect facts with code -> AI decides which extra pages to inspect
//       -> inspect them -> AI writes a plain-English report.

const UA = 'Mozilla/5.0 (compatible; SiteAuditAgent/1.0; +https://github.com/onyxog23-star)';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const MAX_EXTRA_PAGES = 3;
const MAX_LINKS_TO_CHECK = 15;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  // Optional lock so strangers can't spend your API quota
  if (process.env.ACCESS_CODE && body.code !== process.env.ACCESS_CODE) {
    return res.status(401).json({ error: 'Access code required', needsCode: true });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set in your environment variables.' });
  }

  let url;
  try { url = normalizeUrl(body.url); } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const steps = [];
  try {
    // 1. Start the slow speed test in the background
    const speedPromise = pageSpeed(url.href);

    // 2. Inspect the homepage + site-level files
    const home = await auditPage(url.href, { checkLinks: true });
    steps.push({ step: 'Inspected main page', detail: `${home.finalUrl} (${home.status}, ${home.loadMs} ms)` });
    if (home.error) throw new Error(`Could not open the website: ${home.error}`);

    const site = await siteChecks(new URL(home.finalUrl));
    steps.push({ step: 'Checked site files', detail: 'robots.txt, sitemap, HTTPS redirect' });

    // 3. Agent decision: which pages are worth a closer look?
    let picks = [];
    let planNote = '';
    if (home.internalLinks.length) {
      const plan = await askGemini(planPrompt(home));
      const allowed = new Set(home.internalLinks.map((l) => l.url));
      picks = (plan.pages || []).filter((p) => p && allowed.has(p.url)).slice(0, MAX_EXTRA_PAGES);
      planNote = plan.note || '';
      steps.push({
        step: 'Agent chose pages to inspect',
        detail: picks.length ? picks.map((p) => `${p.url} — ${p.reason}`).join('\n') : 'No extra pages needed',
      });
    }

    // 4. Inspect the chosen pages
    const extra = await Promise.all(
      picks.map(async (p) => ({ ...(await auditPage(p.url, { checkLinks: false })), reason: p.reason }))
    );
    if (extra.length) steps.push({ step: 'Inspected chosen pages', detail: `${extra.length} page(s)` });

    // 5. Wait for speed scores
    const speed = await speedPromise;
    steps.push({ step: 'Got Google PageSpeed scores', detail: speed.error ? `Unavailable: ${speed.error}` : 'Mobile test complete' });

    // 6. Agent writes the report
    const facts = { url: home.finalUrl, site, speed, home: slim(home), extraPages: extra.map(slim), agentNote: planNote };
    const report = await askGemini(reportPrompt(facts));
    steps.push({ step: 'Wrote report', detail: MODEL });

    return res.status(200).json({
      url: home.finalUrl,
      auditedAt: new Date().toISOString(),
      speed,
      home: slim(home),
      extraPages: extra.map(slim),
      site,
      steps,
      report,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Audit failed', steps });
  }
}

/* ---------------- helpers ---------------- */

function normalizeUrl(input) {
  if (!input || typeof input !== 'string') throw new Error('Please enter a website address.');
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  const h = u.hostname.toLowerCase();
  const privateHost =
    h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.includes(':') || !h.includes('.');
  if (privateHost) throw new Error('Please enter a public website address.');
  return u;
}

async function fetchT(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
  } finally {
    clearTimeout(t);
  }
}

function attrs(tagSource) {
  const out = {};
  const re = /([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tagSource))) out[m[1].toLowerCase()] = (m[3] ?? m[4] ?? m[5] ?? '').trim();
  return out;
}

function tags(html, name) {
  const re = new RegExp(`<${name}\\b([^>]*)>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(attrs(m[1]));
  return out;
}

function textOf(s) {
  return decode(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

export function analyseHtml(html, pageUrl) {
  const base = new URL(pageUrl);
  const metas = tags(html, 'meta');
  const meta = (key) => {
    const m = metas.find((a) => (a.name || a.property || '').toLowerCase() === key);
    return m ? m.content || '' : null;
  };
  const linksTags = tags(html, 'link');
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const htmlTag = html.match(/<html\b([^>]*)>/i);
  const headings = (lvl) => [...html.matchAll(new RegExp(`<h${lvl}\\b[^>]*>([\\s\\S]*?)<\\/h${lvl}>`, 'gi'))].map((m) => textOf(m[1])).filter(Boolean);

  const imgs = tags(html, 'img');
  const missingAlt = imgs.filter((a) => !('alt' in a));

  const internal = new Map();
  const external = new Set();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const a = attrs(m[1]);
    const href = a.href;
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let u;
    try { u = new URL(decode(href), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    u.hash = '';
    if (u.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '')) {
      if (!internal.has(u.href)) internal.set(u.href, textOf(m[2]).slice(0, 60));
    } else external.add(u.href);
  }

  const bodyText = textOf(html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' '));

  return {
    title: titleMatch ? textOf(titleMatch[1]) : null,
    metaDescription: meta('description'),
    viewport: meta('viewport'),
    robotsMeta: meta('robots'),
    ogTitle: meta('og:title'),
    ogImage: meta('og:image'),
    canonical: (linksTags.find((l) => (l.rel || '').toLowerCase() === 'canonical') || {}).href || null,
    favicon: linksTags.some((l) => /icon/i.test(l.rel || '')),
    lang: htmlTag ? attrs(htmlTag[1]).lang || null : null,
    h1: headings(1),
    h2Count: headings(2).length,
    images: imgs.length,
    imagesMissingAlt: missingAlt.length,
    missingAltExamples: missingAlt.slice(0, 5).map((a) => a.src || '(no src)'),
    structuredData: /application\/ld\+json/i.test(html),
    mixedContent: base.protocol === 'https:' && /(src|href)=["']http:\/\/(?!www\.w3\.org)/i.test(html),
    wordCount: bodyText ? bodyText.split(' ').length : 0,
    internalLinks: [...internal].map(([url, text]) => ({ url, text })),
    externalLinks: [...external],
  };
}

async function auditPage(url, { checkLinks }) {
  const started = Date.now();
  let r, html;
  try {
    r = await fetchT(url, { redirect: 'follow' }, 15000);
    html = await r.text();
  } catch (e) {
    return { url, finalUrl: url, status: 0, error: e.name === 'AbortError' ? 'Timed out' : e.message, loadMs: Date.now() - started, internalLinks: [] };
  }
  const page = {
    url,
    finalUrl: r.url || url,
    status: r.status,
    loadMs: Date.now() - started,
    sizeKb: Math.round(Buffer.byteLength(html) / 1024),
    https: (r.url || url).startsWith('https://'),
    ...analyseHtml(html, r.url || url),
  };
  page.issues = findIssues(page);
  if (checkLinks) page.brokenLinks = await checkLinksFor(page);
  return page;
}

function findIssues(p) {
  const issues = [];
  const add = (severity, text) => issues.push({ severity, text });
  if (p.status >= 400) add('high', `Page returns HTTP ${p.status}`);
  if (!p.https) add('high', 'Page is not served over HTTPS');
  if (!p.title) add('high', 'Missing page title');
  else if (p.title.length < 15 || p.title.length > 65) add('medium', `Title length is ${p.title.length} characters (aim for 15–65)`);
  if (!p.metaDescription) add('medium', 'Missing meta description');
  else if (p.metaDescription.length < 70 || p.metaDescription.length > 160) add('low', `Meta description is ${p.metaDescription.length} characters (aim for 70–160)`);
  if (p.h1.length === 0) add('medium', 'No H1 heading');
  if (p.h1.length > 1) add('low', `${p.h1.length} H1 headings (usually one is best)`);
  if (!p.viewport) add('high', 'No mobile viewport tag — page may not scale on phones');
  if (p.imagesMissingAlt) add('medium', `${p.imagesMissingAlt} of ${p.images} images have no alt text`);
  if (!p.lang) add('low', 'No lang attribute on <html>');
  if (!p.canonical) add('low', 'No canonical URL');
  if (!p.ogImage) add('low', 'No social share image (og:image)');
  if (!p.structuredData) add('low', 'No structured data (schema.org)');
  if (p.mixedContent) add('medium', 'Loads some files over insecure http://');
  if (p.robotsMeta && /noindex/i.test(p.robotsMeta)) add('high', 'Page is set to noindex — Google will not list it');
  if (p.wordCount < 150) add('low', `Very little text on the page (${p.wordCount} words)`);
  if (p.sizeKb > 500) add('low', `HTML is large (${p.sizeKb} KB)`);
  return issues;
}

async function checkLinksFor(page) {
  const list = [...page.internalLinks.map((l) => l.url), ...page.externalLinks].slice(0, MAX_LINKS_TO_CHECK);
  const results = await Promise.all(
    list.map(async (u) => {
      try {
        let r = await fetchT(u, { method: 'HEAD', redirect: 'follow' }, 7000);
        if (r.status === 405 || r.status === 403 || r.status === 501) r = await fetchT(u, { method: 'GET', redirect: 'follow' }, 7000);
        return { url: u, status: r.status };
      } catch {
        return { url: u, status: 0 };
      }
    })
  );
  return { checked: list.length, broken: results.filter((x) => x.status === 0 || x.status >= 400) };
}

async function siteChecks(base) {
  const origin = base.origin;
  const out = { robotsTxt: false, sitemap: false, httpRedirectsToHttps: null };
  try {
    const r = await fetchT(origin + '/robots.txt', {}, 7000);
    const t = r.ok ? await r.text() : '';
    out.robotsTxt = r.ok && t.length > 0;
    const sm = t.match(/^\s*sitemap:\s*(\S+)/im);
    out.sitemapUrl = sm ? sm[1] : origin + '/sitemap.xml';
    out.blocksEverything = /user-agent:\s*\*[\s\S]*?disallow:\s*\/\s*$/im.test(t);
  } catch { out.sitemapUrl = origin + '/sitemap.xml'; }
  try {
    const r = await fetchT(out.sitemapUrl, {}, 7000);
    out.sitemap = r.ok;
  } catch {}
  if (base.protocol === 'https:') {
    try {
      const r = await fetchT('http://' + base.host + '/', { redirect: 'manual' }, 7000);
      const loc = r.headers.get('location') || '';
      out.httpRedirectsToHttps = r.status >= 300 && r.status < 400 && loc.startsWith('https://');
    } catch {}
  }
  return out;
}

async function pageSpeed(url) {
  const p = new URLSearchParams({ url, strategy: 'mobile' });
  ['performance', 'accessibility', 'best-practices', 'seo'].forEach((c) => p.append('category', c));
  if (process.env.PAGESPEED_API_KEY) p.set('key', process.env.PAGESPEED_API_KEY);
  try {
    const r = await fetchT('https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + p, {}, 45000);
    const d = await r.json();
    if (!r.ok) return { error: d.error?.message || `HTTP ${r.status}` };
    const lh = d.lighthouseResult;
    const cat = lh.categories;
    const score = (k) => (cat[k] ? Math.round(cat[k].score * 100) : null);
    const a = lh.audits;
    const val = (k) => a[k]?.displayValue || null;
    const opportunities = Object.values(a)
      .filter((x) => x.details?.type === 'opportunity' && x.score !== null && x.score < 0.9)
      .sort((x, y) => (y.details.overallSavingsMs || 0) - (x.details.overallSavingsMs || 0))
      .slice(0, 6)
      .map((x) => ({ title: x.title, saving: x.displayValue || '' }));
    return {
      scores: { performance: score('performance'), accessibility: score('accessibility'), bestPractices: score('best-practices'), seo: score('seo') },
      metrics: {
        firstContentfulPaint: val('first-contentful-paint'),
        largestContentfulPaint: val('largest-contentful-paint'),
        totalBlockingTime: val('total-blocking-time'),
        cumulativeLayoutShift: val('cumulative-layout-shift'),
        speedIndex: val('speed-index'),
      },
      opportunities,
    };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'PageSpeed timed out' : e.message };
  }
}

function slim(p) {
  if (!p) return p;
  const { internalLinks, externalLinks, ...rest } = p;
  return { ...rest, internalLinkCount: internalLinks?.length || 0, externalLinkCount: externalLinks?.length || 0 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askGemini(prompt) {
  // Busy/overloaded errors (429, 500, 503) are usually temporary: wait and retry.
  // Optionally fall back to a second model set in GEMINI_FALLBACK_MODEL.
  const models = [MODEL, process.env.GEMINI_FALLBACK_MODEL].filter(Boolean);
  const attempts = [...models.map((m) => [m, 0]), [MODEL, 2500], [models[models.length - 1], 5000]];
  let lastError;
  for (const [model, wait] of attempts) {
    if (wait) await sleep(wait);
    let r, d;
    try {
      r = await fetchT(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
          }),
        },
        25000
      );
      d = await r.json().catch(() => ({}));
    } catch (e) {
      lastError = e.name === 'AbortError' ? 'AI took too long to answer' : e.message;
      continue;
    }
    if (r.ok) return parseGemini(d);
    lastError = d.error?.message || `HTTP ${r.status}`;
    if (![429, 500, 503].includes(r.status)) break; // real error (bad key, bad model): stop
  }
  throw new Error(`AI error: ${lastError}`);
}

function parseGemini(d) {
  const text = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  try {
    return JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
  } catch {
    throw new Error('AI returned an unreadable answer. Try again.');
  }
}

function planPrompt(home) {
  return `You are a website audit agent. You have inspected the homepage of ${home.finalUrl}.
Homepage issues found by automated checks: ${JSON.stringify(home.issues)}
Broken links found: ${JSON.stringify(home.brokenLinks?.broken || [])}

Here are the internal links on the homepage (url + link text):
${JSON.stringify(home.internalLinks.slice(0, 60))}

Choose up to ${MAX_EXTRA_PAGES} pages that matter most for the business and deserve a closer look —
for example contact, services/products, pricing, booking or about pages, and any page that looked broken.
Only choose URLs from the list above. Skip legal pages, login pages and files.

Reply with JSON only:
{"pages":[{"url":"...","reason":"short reason"}],"note":"one sentence on what you noticed about the site"}`;
}

function reportPrompt(facts) {
  return `You are a website audit agent writing a report for a small-business owner who is not technical.
Use ONLY the facts below. Do not invent numbers or problems. If a fact is missing (e.g. speed test failed), say it could not be measured.

FACTS:
${JSON.stringify(facts).slice(0, 60000)}

Reply with JSON only, in this exact shape:
{
  "overallScore": <0-100 integer, your honest overall judgement>,
  "grade": "A" | "B" | "C" | "D" | "F",
  "summary": "2–3 plain sentences: how the site is doing and the single most important thing to fix",
  "topFixes": [
    {"title": "short action, e.g. 'Add a meta description'", "why": "one sentence on why it matters to the business",
     "how": "one or two concrete sentences on how to fix it", "impact": "High" | "Medium" | "Low",
     "effort": "Quick win" | "Moderate" | "Larger project", "category": "SEO" | "Speed" | "Technical" | "Accessibility" | "Content"}
  ],
  "sections": [
    {"name": "SEO" | "Speed" | "Mobile & Technical" | "Accessibility" | "Content", "status": "good" | "ok" | "poor", "findings": ["short finding", "..."]}
  ],
  "strengths": ["things the site already does well (max 4)"],
  "pagesReviewed": [{"url": "...", "verdict": "one sentence"}]
}
Give exactly 5 topFixes ordered by impact, then effort. Keep language simple and specific.`;
}
