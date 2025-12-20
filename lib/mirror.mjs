/**
 * Core mirroring logic.
 * Exports mirrorSite() for use by the CLI.
 */
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function normalizePageUrl(urlString) {
  const u = new URL(urlString);
  u.hash = '';
  return u;
}

function shouldSkipLink(url) {
  const ext = path.posix.extname(url.pathname).toLowerCase();
  const skipExt = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
    '.css', '.js', '.mjs', '.map',
    '.json', '.xml', '.txt',
    '.woff', '.woff2', '.ttf', '.otf',
    '.pdf', '.zip', '.rar', '.7z',
    '.mp4', '.webm', '.mp3', '.wav',
  ]);
  return skipExt.has(ext);
}

function pageOutputPath(outRoot, pageUrl) {
  const pathname = decodeURIComponent(pageUrl.pathname || '/');
  let rel;

  if (pathname === '/' || pathname === '') {
    rel = 'index.html';
  } else if (pathname.endsWith('/')) {
    rel = path.posix.join(pathname, 'index.html').slice(1);
  } else {
    const ext = path.posix.extname(pathname);
    if (ext) rel = pathname.slice(1);
    else rel = path.posix.join(pathname, 'index.html').slice(1);
  }

  if (pageUrl.search) {
    const hash = crypto.createHash('sha1').update(pageUrl.search).digest('hex').slice(0, 8);
    const dir = path.posix.dirname(rel);
    const base = path.posix.basename(rel, '.html');
    rel = path.posix.join(dir === '.' ? '' : dir, `${base}__qs-${hash}.html`);
  }

  return path.join(outRoot, rel);
}

function guessExtension(contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('text/css')) return '.css';
  if (ct.includes('javascript')) return '.js';
  if (ct.includes('application/wasm')) return '.wasm';
  if (ct.includes('image/svg+xml')) return '.svg';
  if (ct.startsWith('image/')) return `.${ct.split('image/')[1].split(';')[0]}`;
  if (ct.includes('font/woff2')) return '.woff2';
  if (ct.includes('font/woff')) return '.woff';
  if (ct.includes('font/ttf')) return '.ttf';
  if (ct.includes('font/otf')) return '.otf';
  return '';
}

function assetOutputPath(outRoot, startOrigin, assetUrl, contentType) {
  const pathname = assetUrl.pathname || '/';
  const ext = path.posix.extname(pathname);

  if (assetUrl.origin === startOrigin) {
    const rel = pathname === '/' ? 'index' : pathname.slice(1);
    return path.join(outRoot, rel);
  }

  const hostRoot = path.posix.join('_external', assetUrl.hostname);
  let rel = pathname === '/' ? 'index' : pathname.slice(1);
  rel = path.posix.join(hostRoot, rel);

  if (assetUrl.search) {
    const hash = crypto.createHash('sha1').update(assetUrl.search).digest('hex').slice(0, 8);
    const dir = path.posix.dirname(rel);
    const base = path.posix.basename(rel, ext || '');
    const finalExt = ext || guessExtension(contentType) || '';
    rel = path.posix.join(dir === '.' ? '' : dir, `${base}__qs-${hash}${finalExt}`);
  } else if (!ext) {
    const guessed = guessExtension(contentType);
    if (guessed) rel = `${rel}${guessed}`;
  }

  return path.join(outRoot, rel);
}

function rewriteAbsoluteSameOriginUrls(html, startOrigin) {
  const $ = cheerio.load(html);
  const attrs = [
    { selector: 'a', attr: 'href' },
    { selector: 'link', attr: 'href' },
    { selector: 'script', attr: 'src' },
    { selector: 'img', attr: 'src' },
    { selector: 'source', attr: 'src' },
    { selector: 'source', attr: 'srcset' },
    { selector: 'img', attr: 'srcset' },
    { selector: 'video', attr: 'src' },
    { selector: 'video', attr: 'poster' },
    { selector: 'audio', attr: 'src' },
    { selector: 'form', attr: 'action' },
  ];

  for (const { selector, attr } of attrs) {
    $(selector).each((_, el) => {
      const value = $(el).attr(attr);
      if (!value) return;
      if (value.startsWith('mailto:') || value.startsWith('tel:') || value.startsWith('javascript:')) return;

      // Handle srcset specially (comma-separated list of URLs)
      if (attr === 'srcset') {
        const parts = value.split(',').map((part) => {
          const trimmed = part.trim();
          const [url, descriptor] = trimmed.split(/\s+/);
          try {
            const normalized = url.startsWith('//') ? `https:${url}` : url;
            const u = new URL(normalized, startOrigin);
            
            // Rewrite both same-origin and cross-origin to relative paths
            if (u.origin === startOrigin) {
              return descriptor ? `${u.pathname}${u.search} ${descriptor}` : u.pathname + u.search;
            } else {
              // Cross-origin: rewrite to _external/hostname/path
              const externalPath = `/_external/${u.hostname}${u.pathname}${u.search}`;
              return descriptor ? `${externalPath} ${descriptor}` : externalPath;
            }
          } catch {}
          return trimmed;
        });
        $(el).attr(attr, parts.join(', '));
        return;
      }

      try {
        const normalized = value.startsWith('//') ? `https:${value}` : value;
        const u = new URL(normalized, startOrigin);
        
        if (u.origin === startOrigin) {
          // Same-origin: use root-relative path
          $(el).attr(attr, `${u.pathname}${u.search}${u.hash}`);
        } else {
          // Cross-origin: rewrite to _external/hostname/path
          const externalPath = `/_external/${u.hostname}${u.pathname}${u.search}${u.hash}`;
          $(el).attr(attr, externalPath);
        }
      } catch {
        // ignore
      }
    });
  }

  return $.html();
}

function injectOfflineFullNavigation(html) {
  const $ = cheerio.load(html);
  const script = `\n<script>(function(){function a(e){for(;e&&e!==document.body;){if(e.tagName==='A')return e;e=e.parentElement}return null}document.addEventListener('click',function(e){if(e.defaultPrevented)return;if(e.button!==0)return;if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;var t=a(e.target);if(!t)return;var h=t.getAttribute('href');if(!h||h.startsWith('#'))return;if(h.startsWith('http://')||h.startsWith('https://')||h.startsWith('mailto:')||h.startsWith('tel:'))return;var tg=t.getAttribute('target');if(tg&&tg!=='_self')return;e.preventDefault();window.location.href=h;},true);})();</script>\n`;
  if ($('body').length) $('body').append(script);
  else $.root().append(script);
  return $.html();
}

async function writeFileSafe(filePath, bufferOrString) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, bufferOrString);
}

function parseSitemapLocs(xmlText) {
  const locs = [];
  const re = /<loc>([^<]+)<\/loc>/gi;
  let m;
  while ((m = re.exec(xmlText)) !== null) {
    const loc = m[1].trim();
    if (loc) locs.push(loc);
  }
  return locs;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeoutMs = 20000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'offline-mirror/1.0' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverSitemapUrls(startOrigin) {
  const urls = new Set();

  try {
    const robots = await fetchText(`${startOrigin}/robots.txt`);
    for (const line of robots.split(/\r?\n/)) {
      const m = /^sitemap:\s*(.+)$/i.exec(line.trim());
      if (m?.[1]) urls.add(m[1].trim());
    }
  } catch {
    // ignore
  }

  urls.add(`${startOrigin}/sitemap.xml`);
  return [...urls];
}

async function seedFromSitemaps({ startOrigin, enqueue }) {
  const sitemapUrls = await discoverSitemapUrls(startOrigin);
  const seenSitemaps = new Set();
  const queue = [...sitemapUrls];

  while (queue.length) {
    const sitemapUrl = queue.shift();
    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    console.log(`Sitemap: ${sitemapUrl}`);

    let xml;
    try {
      xml = await fetchText(sitemapUrl);
    } catch (e) {
      console.log(`  (skipped: ${e?.message || 'fetch failed'})`);
      continue;
    }

    let count = 0;
    for (const loc of parseSitemapLocs(xml)) {
      let u;
      try {
        u = new URL(loc);
      } catch {
        continue;
      }

      if (u.pathname.endsWith('.xml') && u.origin === startOrigin && /sitemap/i.test(u.pathname)) {
        queue.push(u.toString());
        continue;
      }

      if (u.origin !== startOrigin) continue;
      u.hash = '';
      enqueue(u.toString());
      count++;
    }
    console.log(`  (found ${count} URLs)`);
  }
}

export async function mirrorSite({ start, out, maxPages, maxDepth, sameOriginOnly, seedSitemaps, singlePage, userAgent }) {
  const startUrl = normalizePageUrl(start);
  let startOrigin = startUrl.origin;
  const outRoot = path.resolve(out);

  await ensureDir(outRoot);

  const visitedPages = new Set();
  const enqueuedPages = new Set();
  const savedAssets = new Set();

  const queue = [{ url: startUrl.toString(), depth: 0 }];
  enqueuedPages.add(startUrl.toString());

  const enqueue = (url, depth = 1) => {
    if (enqueuedPages.has(url) || visitedPages.has(url)) return;
    queue.push({ url, depth });
    enqueuedPages.add(url);
  };

  if (seedSitemaps) {
    console.log('Seeding from sitemap/robots...');
    try {
      await seedFromSitemaps({
        startOrigin,
        enqueue: (url) => {
          try {
            const u = normalizePageUrl(url);
            if (sameOriginOnly && u.origin !== startOrigin) return;
            if (shouldSkipLink(u)) return;
            enqueue(u.toString(), 1);
          } catch {
            // ignore
          }
        },
      });
    } catch (e) {
      console.warn(`Sitemap seeding failed: ${e?.message || e}`);
    }
    console.log(`Seeding complete. Queue size: ${queue.length}`);
  }

  let browser = await chromium.launch({ headless: true });
  let context = await browser.newContext({ userAgent });

  const relaunch = async (reason) => {
    try {
      console.warn(`Relaunching browser context: ${reason}`);
      await context?.close();
    } catch {}
    try {
      await browser?.close();
    } catch {}
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ userAgent });
  };

  const unlimitedPages = !maxPages || maxPages <= 0;
  const unlimitedDepth = !maxDepth || maxDepth <= 0;

  try {
    while (queue.length > 0 && (unlimitedPages || visitedPages.size < maxPages)) {
      const { url, depth } = queue.shift();
      if (visitedPages.has(url)) continue;
      if (!unlimitedDepth && depth > maxDepth) continue;

      const pageUrl = normalizePageUrl(url);
      if (sameOriginOnly && pageUrl.origin !== startOrigin) continue;

      visitedPages.add(pageUrl.toString());
      const progressMax = unlimitedPages ? '∞' : String(maxPages);
      console.log(`[${visitedPages.size}/${progressMax}] ${pageUrl.toString()}`);

      let page;
      try {
        page = await context.newPage();
      } catch (e) {
        await relaunch(e?.message || 'newPage failed');
        page = await context.newPage();
      }

      let assetCount = 0;
      const onResponse = async (response) => {
        try {
          const req = response.request();
          if (req.method() !== 'GET') return;

          const resourceType = req.resourceType();
          const responseUrl = response.url();
          if (!responseUrl.startsWith('http://') && !responseUrl.startsWith('https://')) return;

          const assetUrl = new URL(responseUrl);
          const ct = response.headers()['content-type'] || '';
          const ctLower = ct.toLowerCase();

          // Skip actual HTML documents
          if (resourceType === 'document') return;
          if (ctLower.includes('text/html')) return;

          // Allow all static assets regardless of how they were loaded (XHR, fetch, etc.)
          const isStatic =
            resourceType === 'stylesheet' ||
            resourceType === 'script' ||
            resourceType === 'image' ||
            resourceType === 'font' ||
            resourceType === 'media' ||
            resourceType === 'other' ||
            ctLower.includes('text/css') ||
            ctLower.includes('javascript') ||
            ctLower.includes('json') ||
            ctLower.startsWith('image/') ||
            ctLower.startsWith('font/') ||
            ctLower.startsWith('video/') ||
            ctLower.startsWith('audio/') ||
            ctLower.includes('woff') ||
            ctLower.includes('wasm') ||
            ctLower.includes('octet-stream');

          if (!isStatic) return;

          const key = assetUrl.toString();
          if (savedAssets.has(key)) return;

          const body = await response.body();
          // Use the page's current origin (after redirects) instead of the initial startOrigin
          const currentOrigin = new URL(page.url()).origin;
          const filePath = assetOutputPath(outRoot, currentOrigin, assetUrl, ct);
          await writeFileSafe(filePath, body);
          savedAssets.add(key);
          assetCount++;
        } catch {
          // best effort
        }
      };

      page.on('response', onResponse);

      try {
        try {
          await page.goto(pageUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
          const message = e?.message || String(e);
          if (message.includes('net::ERR_ABORTED')) {
            await page.goto(pageUrl.toString(), { waitUntil: 'load', timeout: 60000 });
          } else {
            throw e;
          }
        }

        try {
          await page.waitForLoadState('networkidle', { timeout: 20000 });
        } catch {
          // long-lived connections are fine
        }

        // Update startOrigin to match the actual origin after redirects (e.g., apple.com -> www.apple.com)
        if (visitedPages.size === 0) {
          const actualOrigin = new URL(page.url()).origin;
          if (actualOrigin !== startOrigin) {
            console.log(`  (followed redirect: ${startOrigin} → ${actualOrigin})`);
            startOrigin = actualOrigin;
          }
        }

        // Scroll to trigger lazy-loaded content
        try {
          await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight / 2);
          });
          await page.waitForTimeout(1000);
          await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
          });
          await page.waitForTimeout(1000);
          await page.evaluate(() => {
            window.scrollTo(0, 0);
          });
        } catch {}

        try {
          await page.waitForTimeout(3000); // Increased from 1500ms to 3000ms for dynamic content
        } catch {}

        // Skip link discovery in single-page mode
        if (!singlePage) {
          const rawLinks = await page.$$eval('a[href]', (els) =>
            els.map((e) => e.getAttribute('href')).filter(Boolean)
          );

          for (const href of rawLinks) {
            if (!href || href.startsWith('#')) continue;
            if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;

            let linkUrl;
            try {
              linkUrl = new URL(href, pageUrl.toString());
            } catch {
              continue;
            }

            if (sameOriginOnly && linkUrl.origin !== startOrigin) continue;
            linkUrl.hash = '';
            if (shouldSkipLink(linkUrl)) continue;

            const normalized = linkUrl.toString();
            if (!enqueuedPages.has(normalized) && !visitedPages.has(normalized)) {
              enqueue(normalized, depth + 1);
            }
          }
        }

        let html = await page.content();
        html = rewriteAbsoluteSameOriginUrls(html, startOrigin);
        html = injectOfflineFullNavigation(html);

        const htmlPath = pageOutputPath(outRoot, pageUrl);
        await writeFileSafe(htmlPath, html);
        console.log(`  → Saved ${assetCount} assets`);
      } catch (e) {
        const message = e?.message || String(e);
        console.warn(`Failed: ${pageUrl.toString()} (${message})`);
        if (message.includes('Target page, context or browser has been closed')) {
          await relaunch('target closed during navigation');
        }
      } finally {
        page.off('response', onResponse);
        try {
          await page.close();
        } catch {}
      }
    }
  } finally {
    try {
      await context.close();
    } catch {}
    try {
      await browser.close();
    } catch {}
  }

  // In single-page mode, create a root index.html that redirects to the actual page
  if (singlePage && visitedPages.size === 1) {
    const actualPageUrl = [...visitedPages][0];
    const pageUrlObj = new URL(actualPageUrl);
    const pagePath = pageUrlObj.pathname;
    
    // Only create redirect if the page isn't at root already
    if (pagePath !== '/' && pagePath !== '') {
      const redirectPath = pagePath.endsWith('/') ? pagePath : pagePath + '/';
      const rootIndexPath = path.join(outRoot, 'index.html');
      
      // Check if root index.html already exists (don't overwrite)
      const rootExists = await fs.access(rootIndexPath).then(() => true).catch(() => false);
      if (!rootExists) {
        const redirectHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=${redirectPath}">
  <script>window.location.href = "${redirectPath}";</script>
  <title>Redirecting...</title>
</head>
<body>
  <p>Redirecting to <a href="${redirectPath}">${redirectPath}</a>...</p>
</body>
</html>`;
        await writeFileSafe(rootIndexPath, redirectHtml);
        console.log(`Created root redirect → ${redirectPath}`);
      }
    }
  }

  console.log('');
  console.log(`Done. Pages saved: ${visitedPages.size}, Assets saved: ${savedAssets.size}`);
  console.log(`Output: ${outRoot}`);
}
