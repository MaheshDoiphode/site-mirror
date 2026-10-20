/**
 * Core mirroring logic.
 * Exports mirrorSite() for use by the CLI.
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { AssetStore } from './assets.mjs';
import {
  generateHtmlOutput,
  generateReactOutput,
  generateNextjsOutput,
} from './generators.mjs';

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
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.ico',
    '.css', '.js', '.mjs', '.map',
    '.json', '.xml', '.txt',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.pdf', '.zip', '.rar', '.7z',
    '.mp4', '.webm', '.mp3', '.wav',
  ]);
  if (skipExt.has(ext)) return true;

  // Never follow logout / sign-out links during crawling so authenticated sessions stay alive
  const pathAndSearch = `${url.pathname}${url.search}`.toLowerCase();
  if (/(?:^|\/|[-_?&=])(logout|log-out|signout|sign-out|endsession)(?:$|\/|[-_?&=])/i.test(pathAndSearch)) {
    return true;
  }

  return false;
}

function normalizeSameSite(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'none' || s === 'no_restriction') return 'None';
  return 'Lax';
}

function normalizeCookieObject(c, defaultUrl) {
  if (!c || typeof c !== 'object' || !c.name) return null;
  const cookie = {
    name: String(c.name).trim(),
    value: String(c.value ?? ''),
  };
  if (c.domain) {
    cookie.domain = String(c.domain).trim();
    cookie.path = String(c.path || '/');
  } else {
    cookie.url = String(c.url || defaultUrl);
  }
  if (typeof c.httpOnly === 'boolean') cookie.httpOnly = c.httpOnly;
  if (typeof c.secure === 'boolean') cookie.secure = c.secure;
  if (c.sameSite) cookie.sameSite = normalizeSameSite(c.sameSite);
  const exp = c.expires ?? c.expirationDate;
  if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) {
    cookie.expires = exp;
  }
  return cookie;
}

function parseRawCookieString(cookieStr, defaultUrl) {
  const cookies = [];
  for (const part of String(cookieStr || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (/^(path|domain|expires|max-age|secure|httponly|samesite)$/i.test(name)) continue;
    cookies.push({ name, value, url: defaultUrl });
  }
  return cookies;
}

/**
 * Loads an authentication session or cookies from:
 * - `authFile`: Playwright `storageState` JSON (`{ cookies, origins }`) or DevTools cookie array JSON
 * - `cookiesInput`: path to a cookies JSON file, or an inline `"name=val; name2=val2"` cookie string
 */
export async function loadSessionConfig({ authFile, cookiesInput, defaultUrl }) {
  let storageState = null;
  const extraCookies = [];

  if (authFile) {
    const resolvedAuth = path.resolve(authFile);
    const exists = await fs.access(resolvedAuth).then(() => true).catch(() => false);
    if (exists) {
      const raw = await fs.readFile(resolvedAuth, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const c of parsed) {
          const norm = normalizeCookieObject(c, defaultUrl);
          if (norm) extraCookies.push(norm);
        }
      } else if (parsed && typeof parsed === 'object') {
        const normCookies = Array.isArray(parsed.cookies)
          ? parsed.cookies.map((c) => normalizeCookieObject(c, defaultUrl)).filter(Boolean)
          : [];
        storageState = {
          cookies: normCookies,
          origins: Array.isArray(parsed.origins) ? parsed.origins : [],
        };
      }
    } else {
      console.warn(`  Warning: Auth file not found at ${resolvedAuth} (will create if --login is active)`);
    }
  }

  if (cookiesInput) {
    const resolvedCookiesPath = path.resolve(cookiesInput);
    const isFile = await fs
      .stat(resolvedCookiesPath)
      .then((s) => s.isFile())
      .catch(() => false);

    if (isFile) {
      const raw = await fs.readFile(resolvedCookiesPath, 'utf-8');
      try {
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : [];
        for (const c of list) {
          const norm = normalizeCookieObject(c, defaultUrl);
          if (norm) extraCookies.push(norm);
        }
      } catch {
        extraCookies.push(...parseRawCookieString(raw, defaultUrl));
      }
    } else {
      extraCookies.push(...parseRawCookieString(cookiesInput, defaultUrl));
    }
  }

  return { storageState, extraCookies };
}

function waitForEnterKey(promptMessage) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(promptMessage, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Opens an interactive Chromium browser window so the user can sign in to a dashboard
 * (supports 2FA, OAuth, CAPTCHAs, Passkeys, etc.), waits for the user to press Enter
 * in the terminal (or close the browser window), and saves the full session (`storageState`)
 * to disk.
 */
export async function runInteractiveLogin({
  url,
  saveAuthPath,
  cookiesInput,
  userAgent,
}) {
  const targetUrl = normalizePageUrl(url).toString();
  const targetOrigin = new URL(targetUrl).origin;
  const { storageState, extraCookies } = await loadSessionConfig({
    authFile: saveAuthPath,
    cookiesInput,
    defaultUrl: targetOrigin,
  });

  console.log('');
  console.log('Opening Chromium browser for interactive login...');
  console.log(`  URL: ${targetUrl}`);
  console.log('  1. Sign in to your account / dashboard in the opened browser window.');
  console.log('  2. Navigate to the dashboard page you want to mirror (if redirected).');
  console.log('  3. Come back here and press [Enter] when you are logged in and ready!');
  console.log('');

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const contextOptions = {
    userAgent,
    viewport: { width: 1440, height: 900 },
  };
  if (storageState) {
    contextOptions.storageState = storageState;
  }
  const context = await browser.newContext(contextOptions);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  if (extraCookies.length > 0) {
    await context.addCookies(extraCookies);
  }

  const page = await context.newPage();
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.warn(`  Initial navigation warning: ${e?.message || e}`);
  }

  await Promise.race([
    waitForEnterKey('Press [Enter] once you have finished signing in... '),
    new Promise((resolve) => page.on('close', resolve)),
  ]);

  let finalUrl = targetUrl;
  try {
    if (!page.isClosed()) {
      finalUrl = page.url() || targetUrl;
    }
  } catch {}

  const capturedState = await context.storageState();

  if (saveAuthPath) {
    const resolvedSave = path.resolve(saveAuthPath);
    await ensureDir(path.dirname(resolvedSave));
    await fs.writeFile(resolvedSave, JSON.stringify(capturedState, null, 2) + '\n', 'utf-8');
    console.log(`  ✓ Saved authenticated session (${capturedState.cookies.length} cookies) to ${resolvedSave}`);
  }

  try {
    await context.close();
  } catch {}
  try {
    await browser.close();
  } catch {}

  return { storageState: capturedState, finalUrl };
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

export async function mirrorSite({
  start,
  urls = [],
  out,
  format = 'html',
  maxPages,
  maxDepth,
  sameOriginOnly,
  seedSitemaps,
  singlePage,
  userAgent,
  login = false,
  authFile = '',
  cookies = '',
  waitFor = 0,
  waitForSelector = '',
}) {
  const normalizedFormat = String(format || 'html').toLowerCase().trim();
  const explicitUrlList = Array.isArray(urls)
    ? urls.map((u) => String(u || '').trim()).filter(Boolean)
    : [];
  const isExplicitUrlsMode = explicitUrlList.length > 0;

  let startUrl = normalizePageUrl(start || explicitUrlList[0]);
  let startOrigin = startUrl.origin;
  const outRoot = path.resolve(out);

  await ensureDir(outRoot);

  // 1. Load or interactively capture authentication session (cookies / storageState)
  let activeStorageState = null;
  let activeExtraCookies = [];

  if (login) {
    const loginResult = await runInteractiveLogin({
      url: startUrl.toString(),
      saveAuthPath: authFile || '',
      cookiesInput: cookies || '',
      userAgent,
    });
    activeStorageState = loginResult.storageState;
    // If the user logged in on `/login` and was redirected to `/dashboard`, start from where they landed!
    if (loginResult.finalUrl && !isExplicitUrlsMode) {
      try {
        const landed = normalizePageUrl(loginResult.finalUrl);
        if (landed.toString() !== startUrl.toString()) {
          console.log(`  → Starting crawl from post-login URL: ${landed.toString()}`);
          startUrl = landed;
          startOrigin = landed.origin;
        }
      } catch {}
    }
  } else if (authFile || cookies) {
    const loaded = await loadSessionConfig({
      authFile,
      cookiesInput: cookies,
      defaultUrl: startOrigin,
    });
    activeStorageState = loaded.storageState;
    activeExtraCookies = loaded.extraCookies;
  }

  const visitedPages = new Set();
  const enqueuedPages = new Set();
  const capturedPages = [];
  const assetStore = new AssetStore({ startOrigin, userAgent });

  const queue = [];
  const enqueue = (url, depth = 1) => {
    if (enqueuedPages.has(url) || visitedPages.has(url)) return;
    queue.push({ url, depth });
    enqueuedPages.add(url);
  };

  if (isExplicitUrlsMode) {
    for (const rawUrl of explicitUrlList) {
      try {
        const u = normalizePageUrl(
          /^https?:\/\//i.test(rawUrl) ? rawUrl : new URL(rawUrl, startOrigin).toString()
        );
        enqueue(u.toString(), 0);
      } catch {
        console.warn(`  Warning: Skipping invalid URL in --urls: "${rawUrl}"`);
      }
    }
  } else {
    enqueue(startUrl.toString(), 0);
  }

  if (seedSitemaps && !isExplicitUrlsMode) {
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

  const hasAuthSession = Boolean(login || authFile || cookies);
  const useHeadedBrowser = hasAuthSession;
  const launchBrowserInstance = async () =>
    chromium.launch({
      headless: !useHeadedBrowser,
      args: ['--disable-blink-features=AutomationControlled'],
    });

  const createConfiguredContext = async (browserInstance) => {
    const ctxOpts = {
      userAgent,
      viewport: { width: 1440, height: 900 },
    };
    if (activeStorageState) {
      ctxOpts.storageState = activeStorageState;
    }
    const ctx = await browserInstance.newContext(ctxOpts);
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    if (activeExtraCookies.length > 0) {
      await ctx.addCookies(activeExtraCookies);
    }
    try {
      assetStore.setCookies(await ctx.cookies());
    } catch {}
    return ctx;
  };

  let browser = await launchBrowserInstance();
  let context = await createConfiguredContext(browser);

  const relaunch = async (reason) => {
    try {
      console.warn(`Relaunching browser context: ${reason}`);
      await context?.close();
    } catch {}
    try {
      await browser?.close();
    } catch {}
    browser = await launchBrowserInstance();
    context = await createConfiguredContext(browser);
  };

  const unlimitedPages = isExplicitUrlsMode ? true : !maxPages || maxPages <= 0;
  const unlimitedDepth = !maxDepth || maxDepth <= 0;
  const totalQueuedTarget = isExplicitUrlsMode ? queue.length : maxPages;

  try {
    while (queue.length > 0 && (unlimitedPages || visitedPages.size < maxPages)) {
      const { url, depth } = queue.shift();
      if (visitedPages.has(url)) continue;
      if (!unlimitedDepth && depth > maxDepth) continue;

      const pageUrl = normalizePageUrl(url);
      if (sameOriginOnly && pageUrl.origin !== startOrigin) continue;

      visitedPages.add(pageUrl.toString());
      const progressMax = isExplicitUrlsMode
        ? String(totalQueuedTarget)
        : unlimitedPages
        ? '∞'
        : String(maxPages);
      console.log(`[${visitedPages.size}/${progressMax}] ${pageUrl.toString()}`);

      let page;
      try {
        page = await context.newPage();
      } catch (e) {
        await relaunch(e?.message || 'newPage failed');
        page = await context.newPage();
      }

      let pageAssetCount = 0;
      const pendingResponses = new Set();
      const inFlightApiRequests = new Set();

      const isTelemetryNoiseUrl = (u) =>
        /sentry|segment|intercom|datadog|amplitude|mixpanel|posthog|hotjar|clarity|google-analytics|googletagmanager|doubleclick|fullstory|logrocket|\/events\b|\/telemetry\b|\/heartbeat\b|\/ping\b/i.test(
          u
        );

      const onRequest = (req) => {
        const rt = req.resourceType();
        if (rt === 'fetch' || rt === 'xhr') {
          const u = req.url();
          if (!isTelemetryNoiseUrl(u)) {
            inFlightApiRequests.add(req);
          }
        }
      };

      const onRequestDone = (req) => {
        inFlightApiRequests.delete(req);
      };

      const onResponse = (response) => {
        const task = (async () => {
          try {
            const req = response.request();
            if (req.method() !== 'GET') return;
            if (!response.ok()) return;

            const resourceType = req.resourceType();
            const responseUrl = response.url();
            if (!responseUrl.startsWith('http://') && !responseUrl.startsWith('https://')) return;

            const ct = response.headers()['content-type'] || '';
            const ctLower = ct.toLowerCase();

            // Skip HTML documents, framework JS bundles, and JSON/XHR API calls
            if (
              resourceType === 'document' ||
              resourceType === 'script' ||
              resourceType === 'xhr' ||
              resourceType === 'fetch' ||
              ctLower.includes('text/html') ||
              ctLower.includes('javascript') ||
              ctLower.includes('application/json')
            ) {
              return;
            }

            // Capture stylesheets into AssetStore for consolidation & `url(...)` rewriting
            if (resourceType === 'stylesheet' || ctLower.includes('text/css')) {
              const text = await response.text();
              assetStore.registerStylesheet(responseUrl, text);
              pageAssetCount++;
              return;
            }

            // Capture visual & font assets (images, SVGs, fonts, video, audio)
            const isMediaOrFont =
              resourceType === 'image' ||
              resourceType === 'font' ||
              resourceType === 'media' ||
              ctLower.startsWith('image/') ||
              ctLower.startsWith('font/') ||
              ctLower.includes('woff') ||
              ctLower.startsWith('video/') ||
              ctLower.startsWith('audio/');

            if (!isMediaOrFont) return;

            const body = await response.body();
            const registered = assetStore.registerAsset(responseUrl, body, ct);
            if (registered) pageAssetCount++;
          } catch {
            // best effort
          }
        })();

        pendingResponses.add(task);
        task.finally(() => pendingResponses.delete(task));
      };

      page.on('request', onRequest);
      page.on('requestfinished', onRequestDone);
      page.on('requestfailed', onRequestDone);
      page.on('response', onResponse);

      try {
        try {
          await page.goto(pageUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
          const message = e?.message || String(e);
          if (message.includes('net::ERR_ABORTED') || message.includes('net::ERR_NETWORK_CHANGED') || message.includes('net::ERR_TIMED_OUT')) {
            await new Promise((r) => setTimeout(r, 800));
            await page.goto(pageUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
          } else {
            throw e;
          }
        }

        try {
          await page.waitForLoadState('networkidle', { timeout: 15000 });
        } catch {
          // long-lived connections are fine
        }

        // Wait if Cloudflare Turnstile / interstitial ("Waiting for ... to respond" or `input[name="cf-turnstile-response"]`) is completing
        try {
          const cfDeadline = Date.now() + 20000;
          while (Date.now() < cfDeadline) {
            const isInterstitial = await page.evaluate(() => {
              return Boolean(
                document.querySelector('input[name="cf-turnstile-response"], #challenge-running, #challenge-stage') ||
                  (document.title && /just a moment/i.test(document.title))
              );
            });
            if (!isInterstitial) break;
            await page.waitForTimeout(500);
          }
        } catch {}

        // Update startOrigin to match the actual origin after redirects (e.g., apple.com -> www.apple.com)
        if (visitedPages.size === 1) {
          const actualOrigin = new URL(page.url()).origin;
          if (actualOrigin !== startOrigin) {
            console.log(`  (followed redirect: ${startOrigin} → ${actualOrigin})`);
            startOrigin = actualOrigin;
            assetStore.setStartOrigin(actualOrigin);
          }
          try {
            assetStore.setCookies(await context.cookies());
          } catch {}
        }

        // Wait for async dashboard API calls (fetch/XHR), loading skeletons/spinners to disappear,
        // and DOM mutations to settle before scrolling!
        try {
          const apiDeadline = Date.now() + 12000;
          let quietSince = Date.now();
          while (Date.now() < apiDeadline) {
            if (inFlightApiRequests.size === 0) {
              if (Date.now() - quietSince >= 500) break;
            } else {
              quietSince = Date.now();
            }
            await page.waitForTimeout(120);
          }

          // Wait inside browser context for loading skeletons/spinners (`aria-busy`, `progressbar`, `skeleton`, `spinner`)
          // to clear and for DOM mutations to settle
          await page.evaluate(async () => {
            const isVisibleLoadingIndicator = (el) => {
              if (!el || !(el instanceof HTMLElement)) return false;
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                return false;
              }
              const r = el.getBoundingClientRect();
              return r.width > 4 && r.height > 4;
            };

            const hasActiveSkeletonOrSpinner = () => {
              const candidates = document.querySelectorAll(
                '[aria-busy="true"], [role="progressbar"], [data-loading="true"], [data-skeleton="true"], [data-testid*="skeleton" i], [data-testid*="loading" i], [class*="skeleton" i], [class*="shimmer" i], [class*="spinner" i], .animate-pulse'
              );
              for (const el of candidates) {
                if (isVisibleLoadingIndicator(el)) return true;
              }
              return false;
            };

            let lastMutationTime = Date.now();
            const obs = new MutationObserver(() => {
              lastMutationTime = Date.now();
            });
            if (document.body) {
              obs.observe(document.body, { childList: true, subtree: true, characterData: true });
            }

            const maxWait = 10000;
            const startWait = Date.now();
            while (Date.now() - startWait < maxWait) {
              const busy = hasActiveSkeletonOrSpinner();
              const domQuietFor = Date.now() - lastMutationTime;
              if (!busy && domQuietFor >= 450) {
                break;
              }
              await new Promise((r) => setTimeout(r, 150));
            }
            obs.disconnect();
          });

          if (waitForSelector) {
            await page.waitForSelector(waitForSelector, { timeout: 15000 }).catch(() => {});
          }
          if (waitFor && Number(waitFor) > 0) {
            await page.waitForTimeout(Number(waitFor));
          }
        } catch {}

        // Scroll both window and any scrollable internal dashboard containers (`overflow: auto | scroll`)
        // to trigger lazy-loaded images, charts, and intersection observers
        try {
          await page.evaluate(async () => {
            const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
            for (let y = 0; y < document.body.scrollHeight; y += step) {
              window.scrollTo(0, y);
              await new Promise((r) => setTimeout(r, 150));
            }
            window.scrollTo(0, document.body.scrollHeight);
            await new Promise((r) => setTimeout(r, 400));
            window.scrollTo(0, 0);

            // Also scroll any internal scrollable containers (common in SPAs/dashboards where body is overflow:hidden)
            const scrollables = Array.from(document.querySelectorAll('div, main, section')).filter((el) => {
              if (!(el instanceof HTMLElement)) return false;
              if (el.scrollHeight <= el.clientHeight + 80 || el.clientWidth < 300) return false;
              const oy = window.getComputedStyle(el).overflowY;
              return oy === 'auto' || oy === 'scroll';
            });
            for (const container of scrollables.slice(0, 3)) {
              for (let y = 0; y < container.scrollHeight; y += step) {
                container.scrollTop = y;
                await new Promise((r) => setTimeout(r, 150));
              }
              container.scrollTop = container.scrollHeight;
              await new Promise((r) => setTimeout(r, 450));
            }

            // Wait for any newly triggered `[data-skeleton="true"]` or loading spinners inside scrolled containers to resolve
            const startSettle = Date.now();
            while (Date.now() - startSettle < 6000) {
              const skels = document.querySelectorAll('[data-skeleton="true"], [aria-busy="true"], [data-loading="true"]');
              if (skels.length === 0) break;
              await new Promise((r) => setTimeout(r, 200));
            }

            for (const container of scrollables.slice(0, 3)) {
              container.scrollTop = 0;
            }
          });
        } catch {}

        try {
          await page.waitForTimeout(1500);
        } catch {}

        // Probe any `[data-framer-cursor]` elements by moving the mouse over each unique cursor ID so Framer mounts
        // its custom cursor variants and injects their CSS before we inline `#svg-templates` and capture CSSOM rules!
        try {
          const uniqueCursorIds = await page.evaluate(() => {
            const ids = new Set();
            document.querySelectorAll('[data-framer-cursor]').forEach((el) => {
              const id = el.getAttribute('data-framer-cursor');
              if (id) ids.add(id);
            });
            return [...ids];
          });

          if (uniqueCursorIds.length > 0) {
            const capturedCursorClones = [];
            for (const cid of uniqueCursorIds) {
              try {
                const loc = page.locator(`[data-framer-cursor="${cid}"]`).first();
                await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
                await page.waitForTimeout(100);
                const box = await loc.boundingBox();
                if (box) {
                  await page.mouse.move(
                    box.x + Math.min(24, Math.max(4, box.width / 2)),
                    box.y + Math.min(24, Math.max(4, box.height / 2))
                  );
                  await page.waitForTimeout(180);
                  const cursorHtml = await page.evaluate(() => {
                    const c = document.querySelector(
                      '#main > [class*="framer-pointer-events-none"][style*="position: fixed"], #main > [style*="contents"] > [class*="framer-pointer-events-none"][style*="position: fixed"]'
                    );
                    return c ? c.outerHTML : null;
                  });
                  if (cursorHtml) {
                    capturedCursorClones.push({ cid, cursorHtml });
                  }
                }
              } catch {}
            }

            await page.evaluate((clones) => {
              window.scrollTo(0, 0);
              // Remove Framer's active cursor node
              document
                .querySelectorAll(
                  '#main > [class*="framer-pointer-events-none"][style*="position: fixed"], #main > [style*="contents"] > [class*="framer-pointer-events-none"][style*="position: fixed"]'
                )
                .forEach((el) => el.remove());

              if (clones.length > 0) {
                let bank = document.getElementById('mirror-cursor-bank');
                if (!bank) {
                  bank = document.createElement('div');
                  bank.id = 'mirror-cursor-bank';
                  bank.setAttribute('aria-hidden', 'true');
                  document.body.appendChild(bank);
                }
                clones.forEach(({ cid, cursorHtml }, idx) => {
                  if (bank.querySelector(`[data-mirror-cursor-variant="${cid}"]`)) return;
                  const temp = document.createElement('div');
                  temp.innerHTML = cursorHtml;
                  const node = temp.firstElementChild;
                  if (node) {
                    node.setAttribute('data-mirror-cursor-variant', cid);
                    if (idx === 0) node.setAttribute('data-mirror-cursor-default', 'true');
                    node.style.opacity = '0';
                    node.style.display = 'none';
                    node.style.pointerEvents = 'none';
                    node.style.position = 'fixed';
                    node.style.top = '0px';
                    node.style.left = '0px';
                    node.style.zIndex = '99999';
                    bank.appendChild(node);
                  }
                });
              }
            }, capturedCursorClones);
          }
        } catch {}

        // Ensure Lottie animations have rendered their SVG and pre-populate lazy navigation dropdowns
        try {
          await page.evaluate(async () => {
            // 1. Wait up to 2s for any empty Lottie container to receive its <svg>
            const lottieEls = Array.from(
              document.querySelectorAll('[data-animation-type="lottie"], [class*="lottie"]')
            );
            if (lottieEls.some((el) => !el.querySelector('svg'))) {
              const deadline = Date.now() + 2000;
              while (Date.now() < deadline && lottieEls.some((el) => !el.querySelector('svg'))) {
                await new Promise((r) => setTimeout(r, 150));
              }
            }

            // 2. Capture scroll-driven SVG / Lottie state diffs inside the header/navbar
            //    While still scrolled at the bottom (or 400px down), snapshot the scrolled state of header SVGs,
            //    then scroll back to top (0, 0) and annotate any animated SVG `<g>` / `<path>` elements with
            //    `data-scroll-transform` and `data-scroll-opacity` so CSS transitions can replay the exact morph!
            window.scrollTo(0, 400);
            await new Promise((r) => setTimeout(r, 600));
            const headerLottieContainers = Array.from(
              document.querySelectorAll(
                'header [class*="lottie"], .nav_component [class*="lottie"], [data-animation-type="lottie"]'
              )
            );
            const scrolledStates = new Map();
            for (const container of headerLottieContainers) {
              const els = Array.from(container.querySelectorAll('svg g, svg path'));
              scrolledStates.set(
                container,
                els.map((el) => ({
                  transform: el.getAttribute('transform') || '',
                  opacity: el.getAttribute('opacity') || '',
                }))
              );
            }

            window.scrollTo(0, 0);
            await new Promise((r) => setTimeout(r, 650));

            for (const container of headerLottieContainers) {
              const scrolledList = scrolledStates.get(container);
              if (!scrolledList) continue;
              const els = Array.from(container.querySelectorAll('svg g, svg path'));
              let hasDiff = false;
              els.forEach((el, idx) => {
                const scrolled = scrolledList[idx];
                if (!scrolled) return;
                const topTransform = el.getAttribute('transform') || '';
                const topOpacity = el.getAttribute('opacity') || '';
                if (scrolled.transform && scrolled.transform !== topTransform) {
                  el.setAttribute('data-top-transform', topTransform);
                  el.setAttribute('data-scroll-transform', scrolled.transform);
                  hasDiff = true;
                }
                if (scrolled.opacity && scrolled.opacity !== topOpacity) {
                  el.setAttribute('data-top-opacity', topOpacity || '1');
                  el.setAttribute('data-scroll-opacity', scrolled.opacity);
                  hasDiff = true;
                }
              });
              if (hasDiff) {
                container.setAttribute('data-scroll-lottie', 'true');
              }
            }

            // 3. If any logo wrapper still has no visible SVG (or its SVG paths have fill-opacity="0"),
            //    inject the animated multi-group wordmark SVG (`ANTHROP\C` -> `A\`) so the logo and its scroll morph work offline.
            const logoLinks = Array.from(
              document.querySelectorAll(
                'a[aria-label*="Home" i], a.nav_logo_wrap, [class*="logoDesktop"], [class*="LogoWordmark"]'
              )
            );
            for (const el of logoLinks) {
              const svgs = Array.from(el.querySelectorAll('svg'));
              const hasVisiblePath = svgs.some((svg) =>
                Array.from(svg.querySelectorAll('path')).some((p) => {
                  const op = p.getAttribute('fill-opacity');
                  return op === null || Number(op) > 0;
                })
              );
              const lottieWrap = el.querySelector('[data-animation-type="lottie"], [class*="lottie"]');
              if (lottieWrap && !hasVisiblePath) {
                lottieWrap.setAttribute('data-scroll-lottie', 'true');
                lottieWrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 143 16" width="143" height="16" style="width:143px;height:16px;display:block" fill="currentColor"><g transform="matrix(1,0,0,1,0,0.27)" data-top-transform="matrix(1,0,0,1,0,0.27)" data-scroll-transform="matrix(1,0,0,1,0,0.27)"><path d="M5.825 9.078L7.935 3.642l2.11 5.436H5.825zM6.167 0L0 15.47h3.448l1.261-3.249h6.452l1.261 3.249h3.448L9.703 0H6.167z"/></g><g opacity="1" data-top-opacity="1" data-scroll-opacity="0" transform="matrix(1,0,0,1,18.3,0.27)" data-top-transform="matrix(1,0,0,1,18.3,0.27)" data-scroll-transform="matrix(1,0,0,1,4.31,0.27)"><path d="M10.716 10.829L3.756 0H0v15.47h3.204V4.641l6.96 10.829h3.756V0h-3.204v10.829z"/></g><g opacity="1" data-top-opacity="1" data-scroll-opacity="0" transform="matrix(1,0,0,1,34.87,0.27)" data-top-transform="matrix(1,0,0,1,34.87,0.27)" data-scroll-transform="matrix(1,0,0,1,4.45,0.27)"><path d="M0 2.984h5.193V15.47h3.314V2.984h5.193V0H0v2.984z"/></g><g opacity="1" data-top-opacity="1" data-scroll-opacity="0" transform="matrix(1,0,0,1,51.23,0.27)" data-top-transform="matrix(1,0,0,1,51.23,0.27)" data-scroll-transform="matrix(1,0,0,1,4.31,0.27)"><path d="M10.606 6.166H3.314V0H0v15.47h3.314V9.149h7.292v6.321h3.314V0h-3.314v6.166z"/></g><g opacity="1" data-top-opacity="1" data-scroll-opacity="0" transform="matrix(1,0,0,1,69.24,0.27)" data-top-transform="matrix(1,0,0,1,69.24,0.27)" data-scroll-transform="matrix(1,0,0,1,4.31,0.27)"><path d="M3.315 2.984h4.089c1.635 0 2.497.596 2.497 1.723 0 1.127-.862 1.724-2.497 1.724H3.315V2.984zm9.901 1.723C13.216 1.79 11.073 0 7.559 0H0v15.47h3.315V9.415h3.691l3.315 6.055h3.669l-3.671-6.517c1.843-.708 2.897-2.2 2.897-4.246z"/></g><g opacity="1" data-top-opacity="1" data-scroll-opacity="0" transform="matrix(1,0,0,1,84.99,0)" data-top-transform="matrix(1,0,0,1,84.99,0)" data-scroll-transform="matrix(1,0,0,1,3.62,0)"><path d="M7.622 12.906c-2.607 0-4.198-1.856-4.198-4.884 0-3.072 1.591-4.928 4.198-4.928 2.585 0 4.154 1.856 4.154 4.928 0 3.028-1.569 4.884-4.154 4.884zM7.622 0C3.159 0 0 3.315 0 8.022c0 4.663 3.159 7.978 7.622 7.978 4.441 0 7.578-3.315 7.578-7.978C15.2 3.315 12.063 0 7.622 0z"/></g><g opacity="1" data-top-opacity="1" data-scroll-opacity="0" transform="matrix(1,0,0,1,103.29,0.27)" data-top-transform="matrix(1,0,0,1,103.29,0.27)" data-scroll-transform="matrix(1,0,0,1,4.59,0.27)"><path d="M7.406 6.873H3.316V2.984h4.09c1.636 0 2.498.663 2.498 1.945 0 1.281-.862 1.944-2.498 1.944zM7.561 0H0v15.47h3.316V9.857h4.245c3.515 0 5.659-1.857 5.659-4.928C13.22 1.856 11.076 0 7.561 0z"/></g><g transform="matrix(1,0,0,1,117.83,0.27)" data-top-transform="matrix(1,0,0,1,117.83,0.27)" data-scroll-transform="matrix(1,0,0,1,12.98,0.27)"><path d="M0 0l6.168 15.47h3.382L3.382 0H0z"/></g><g opacity="1" data-top-opacity="1" data-scroll-opacity="0" transform="matrix(1,0,0,1,128.04,0)" data-top-transform="matrix(1,0,0,1,128.04,0)" data-scroll-transform="matrix(1,0,0,1,4.03,0)"><path d="M10.915 10.541c-.575 1.503-1.724 2.365-3.292 2.365-2.607 0-4.198-1.856-4.198-4.884 0-3.072 1.591-4.928 4.198-4.928 1.568 0 2.717.862 3.292 2.365h3.513C13.566 2.144 10.981 0 7.623 0 3.16 0 0 3.315 0 8.022c0 4.663 3.16 7.978 7.623 7.978 3.38 0 5.965-2.166 6.827-5.459h-3.535z"/></g></svg>`;
              }
            }

            // 3. Pre-populate React conditional header dropdowns (e.g. `button[aria-haspopup="menu"]`)
            const menuButtons = Array.from(
              document.querySelectorAll('header button[aria-haspopup="menu"], nav button[aria-haspopup="menu"]')
            );
            const capturedMenus = [];
            for (const btn of menuButtons) {
              const controlsId = btn.getAttribute('aria-controls');
              if (!controlsId) continue;
              btn.click();
              await new Promise((r) => setTimeout(r, 120));
              const dropdownEl = document.getElementById(controlsId);
              if (dropdownEl) {
                const clone = dropdownEl.cloneNode(true);
                clone.setAttribute('data-mirror-dropdown', 'true');
                clone.style.display = 'none';
                capturedMenus.push({ parent: btn.parentElement, clone });
              }
            }

            // Also check CTA dropdown trigger (e.g. `Try Claude` caret)
            const ctaTrigger = document.querySelector('header [class*="claudeCtaDropdownTrigger"]');
            if (ctaTrigger) {
              ctaTrigger.click();
              await new Promise((r) => setTimeout(r, 120));
              const ctaMenu = ctaTrigger.querySelector('[id*="dropdown"], [class*="Dropdown"]');
              if (ctaMenu) {
                const clone = ctaMenu.cloneNode(true);
                clone.setAttribute('data-mirror-dropdown', 'true');
                clone.style.display = 'none';
                capturedMenus.push({ parent: ctaTrigger, clone });
              }
            }

            // Close any open dropdown by clicking body
            document.body.click();
            await new Promise((r) => setTimeout(r, 80));

            // Re-attach captured dropdown clones in hidden state so CSS & offline JS/React can toggle them
            for (const { parent, clone } of capturedMenus) {
              if (parent && !parent.querySelector(`[id="${clone.id}"]`)) {
                parent.appendChild(clone);
              }
            }

            // 4. Scroll any `<canvas>` sections into view so intersection-observed canvas animations
            //    finish drawing their resting frame, and snapshot every non-empty `<canvas>` as a PNG data URL.
            const canvases = Array.from(document.querySelectorAll('canvas'));
            if (canvases.length > 0) {
              const canvasSections = new Set(
                canvases.map((c) => c.closest('section, header, [data-scroll]') || c)
              );
              for (const sec of canvasSections) {
                sec.scrollIntoView({ block: 'center' });
                await new Promise((r) => setTimeout(r, 2400));
              }
              window.scrollTo(0, 0);
              await new Promise((r) => setTimeout(r, 300));

              canvases.forEach((canvas, idx) => {
                if (canvas.width > 0 && canvas.height > 0) {
                  try {
                    const dataUrl = canvas.toDataURL('image/png');
                    if (dataUrl && dataUrl.startsWith('data:image/png;base64,') && dataUrl.length > 200) {
                      canvas.setAttribute('data-canvas-snapshot', dataUrl);
                      canvas.setAttribute('data-canvas-id', `canvas-${idx + 1}`);
                    }
                  } catch {
                    // tainted cross-origin canvas
                  }
                }
              });
            }

            // 5. Preserve self-contained interactive section scripts (e.g. `.u-embed-js script`, `.w-script script`)
            //    by encoding them on their parent container so `cleanAndRewritePageDom` doesn't strip them!
            const embedContainers = Array.from(
              document.querySelectorAll('.u-embed-js, .w-script')
            );
            for (const container of embedContainers) {
              const scripts = Array.from(container.querySelectorAll('script:not([src])'));
              const code = scripts.map((s) => s.textContent || '').join('\n').trim();
              if (code && (code.includes('canvas') || code.includes('getContext'))) {
                container.setAttribute('data-mirror-widget-script', encodeURIComponent(code));
              }
            }

            // 6. Preserve Framer's appear-animation definitions (`#__framer__appearAnimationsContent`),
            //    inline `#svg-templates` symbols referenced via `<use href="#svg-...">`,
            //    and remove editor/made-in-framer overlays (`#__framer-badge-container`, `#__framer-editorbar`).
            const framerAppearScript = document.getElementById('__framer__appearAnimationsContent');
            if (framerAppearScript && framerAppearScript.textContent) {
              const framerMain = document.getElementById('main') || document.body;
              framerMain.setAttribute(
                'data-framer-appear-map',
                encodeURIComponent(framerAppearScript.textContent.trim())
              );
            }
            const svgTemplates = document.getElementById('svg-templates');
            if (svgTemplates) {
              document.querySelectorAll('svg use[href^="#svg"], svg use[xlink\\:href^="#svg"]').forEach((useEl) => {
                const refId = (useEl.getAttribute('href') || useEl.getAttribute('xlink:href') || '').slice(1);
                if (!refId) return;
                const symbolEl = document.getElementById(refId);
                const parentSvg = useEl.closest('svg');
                if (symbolEl && parentSvg) {
                  const vb = symbolEl.getAttribute('viewBox');
                  if (vb && !parentSvg.getAttribute('viewBox')) {
                    parentSvg.setAttribute('viewBox', vb);
                  }
                  parentSvg.innerHTML = symbolEl.innerHTML;
                }
              });
              svgTemplates.remove();
            }
            document.querySelectorAll('#__framer-badge-container, #__framer-editorbar').forEach((el) => el.remove());
            document
              .querySelectorAll(
                '#main > [class*="framer-pointer-events-none"][style*="position: fixed"], #main > [style*="contents"] > [class*="framer-pointer-events-none"][style*="position: fixed"]'
              )
              .forEach((el) => el.remove());

            // 7. Ensure `<video src="...">` elements have `autoplay` / `preload="metadata"` so they display & play
            document.querySelectorAll('video').forEach((v) => {
              if (v.getAttribute('preload') === 'none') {
                v.setAttribute('preload', 'metadata');
              }
              if (v.hasAttribute('muted') && v.hasAttribute('loop')) {
                v.setAttribute('autoplay', '');
              }
            });
          });
        } catch {}

        // Wait for any in-flight asset responses to settle
        await Promise.allSettled([...pendingResponses]);

        // Also extract runtime CSSOM rules from inline/constructed stylesheets (CSS-in-JS) that don't have a `<style>` DOM node, or linked stylesheets that failed network capture. Note: linked stylesheets with `sheet.href` and inline `<style>` tags are already captured in exact DOM cascade order!
        try {
          const runtimeStyles = await page.evaluate(() => {
            const sheets = [];
            for (let i = 0; i < document.styleSheets.length; i++) {
              const sheet = document.styleSheets[i];
              // Linked stylesheets with href were already captured via network response
              if (sheet.href) continue;
              // Inline <style> elements with non-empty textContent are captured in exact DOM order by cleanAndRewritePageDom
              if (sheet.ownerNode && sheet.ownerNode.tagName === 'STYLE' && (sheet.ownerNode.textContent || '').trim().length > 0) {
                continue;
              }
              try {
                const rules = Array.from(sheet.cssRules || []).map((r) => r.cssText).join('\n');
                if (rules.trim()) {
                  sheets.push({ id: `runtime-style-${i}`, text: rules });
                }
              } catch {
                // cross-origin stylesheet without CORS
              }
            }
            return sheets;
          });
          for (const s of runtimeStyles) {
            assetStore.registerStylesheet(`${pageUrl.pathname}#${s.id}`, s.text);
          }
        } catch {}

        // Discover links if not in singlePage mode and not in explicit `--urls` mode
        if (!singlePage && !isExplicitUrlsMode) {
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

        const rawHtml = await page.content();
        capturedPages.push({
          pageUrl: new URL(page.url()),
          rawHtml,
        });
        console.log(`  → Captured page & ${pageAssetCount} assets/stylesheets`);
      } catch (e) {
        const message = e?.message || String(e);
        console.warn(`Failed: ${pageUrl.toString()} (${message})`);
        if (message.includes('Target page, context or browser has been closed')) {
          await relaunch('target closed during navigation');
        }
      } finally {
        page.off('request', onRequest);
        page.off('requestfinished', onRequestDone);
        page.off('requestfailed', onRequestDone);
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

  if (capturedPages.length === 0) {
    console.error('No pages were successfully captured.');
    return;
  }

  console.log(`\nGenerating ${normalizedFormat.toUpperCase()} project in ${outRoot}...`);

  let result;
  if (normalizedFormat === 'react') {
    result = await generateReactOutput({
      outRoot,
      pages: capturedPages,
      assetStore,
      startOrigin,
      singlePage,
    });
  } else if (normalizedFormat === 'nextjs' || normalizedFormat === 'next') {
    result = await generateNextjsOutput({
      outRoot,
      pages: capturedPages,
      assetStore,
      startOrigin,
      singlePage,
    });
  } else {
    result = await generateHtmlOutput({
      outRoot,
      pages: capturedPages,
      assetStore,
      startOrigin,
      singlePage,
    });
  }

  console.log('');
  console.log(`Done! Format: ${normalizedFormat.toUpperCase()}`);
  console.log(`  Pages generated: ${capturedPages.length}`);
  if (result.componentCount !== undefined) {
    console.log(`  Components:      ${result.componentCount} modular components (with co-located .css)`);
  }
  if (result.cssStats) {
    console.log(
      `  CSS optimized:   ${result.cssStats.keptRules} active rules kept (${result.cssStats.purgedRules} unused rules purged)`
    );
  }
  console.log(`  Assets saved:    ${result.writtenAssets}`);
  console.log(`  Output:          ${outRoot}`);

  if (normalizedFormat === 'html') {
    console.log(`\nTip: Open ${path.join(outRoot, 'index.html')} directly in your browser (no server needed!)`);
  } else {
    console.log(`\nTo run your ${normalizedFormat === 'react' ? 'React (Vite)' : 'Next.js'} app:`);
    console.log(`  cd "${outRoot}"`);
    console.log(`  npm install && npm run dev`);
    console.log(`  (or run: site-mirror serve "${outRoot}")`);
  }
}
