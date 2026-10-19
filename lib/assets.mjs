/**
 * Asset Manager & CSS Processor
 *
 * Collects, deduplicates, downloads, and cleanly organizes all page assets
 * (images, SVGs, fonts, media, stylesheets) into a clean `assets/` hierarchy.
 * Fixes Next.js `/_next/image?url=...` collisions, resolves CSS `url(...)`
 * references, and supports both relative paths (for `file://` HTML mode) and
 * root-relative `/assets/...` paths (for React / Next.js public folder).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const FONT_EXTS = new Set(['.woff2', '.woff', '.ttf', '.otf', '.eot']);
const SVG_EXTS = new Set(['.svg']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.ico', '.bmp']);
const MEDIA_EXTS = new Set(['.mp4', '.webm', '.ogg', '.mp3', '.wav', '.m4a', '.mov']);

export function guessExtensionFromContentType(contentType = '') {
  const ct = contentType.toLowerCase().split(';')[0].trim();
  const map = {
    'text/css': '.css',
    'text/javascript': '.js',
    'application/javascript': '.js',
    'application/x-javascript': '.js',
    'application/json': '.json',
    'application/wasm': '.wasm',
    'image/svg+xml': '.svg',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'image/x-icon': '.ico',
    'image/vnd.microsoft.icon': '.ico',
    'font/woff2': '.woff2',
    'application/font-woff2': '.woff2',
    'font/woff': '.woff',
    'application/font-woff': '.woff',
    'font/ttf': '.ttf',
    'application/x-font-ttf': '.ttf',
    'font/otf': '.otf',
    'application/x-font-opentype': '.otf',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
  };
  return map[ct] || '';
}

/**
 * Unwraps Next.js / Vercel / Cloudflare image optimization URLs to recover
 * the underlying asset path and filename.
 * Example: /_next/image?url=https%3A%2F%2Fwww-cdn.anthropic.com%2F...%2Ffoo.webp&w=1920&q=75
 */
export function extractLogicalAssetInfo(rawUrlString, baseOrigin) {
  let parsed;
  try {
    const normalized = rawUrlString.startsWith('//') ? `https:${rawUrlString}` : rawUrlString;
    parsed = new URL(normalized, baseOrigin);
  } catch {
    return null;
  }

  let effectivePathname = parsed.pathname || '/';
  let widthHint = parsed.searchParams.get('w') || parsed.searchParams.get('width') || '';

  // Handle Next.js /_next/image?url=... or /_vercel/image?url=...
  if (
    (effectivePathname === '/_next/image' || effectivePathname === '/_vercel/image') &&
    parsed.searchParams.has('url')
  ) {
    const innerRaw = parsed.searchParams.get('url');
    try {
      const innerUrl = new URL(innerRaw, baseOrigin);
      effectivePathname = innerUrl.pathname || effectivePathname;
    } catch {
      effectivePathname = innerRaw;
    }
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(effectivePathname);
  } catch {
    decodedPath = effectivePathname;
  }

  let ext = path.posix.extname(decodedPath).toLowerCase();
  let baseName = path.posix.basename(decodedPath, ext || undefined);

  // Sanitize basename for cross-platform safety
  baseName = baseName
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!baseName || baseName === 'image' || baseName === 'index') {
    const hash = crypto.createHash('sha1').update(parsed.toString()).digest('hex').slice(0, 10);
    baseName = `asset-${hash}`;
  }

  // Truncate overly long names while keeping uniqueness
  if (baseName.length > 72) {
    const hash = crypto.createHash('sha1').update(baseName).digest('hex').slice(0, 8);
    baseName = `${baseName.slice(0, 56)}-${hash}`;
  }

  if (widthHint && /^\d+$/.test(widthHint) && !baseName.endsWith(`-${widthHint}w`)) {
    baseName = `${baseName}-${widthHint}w`;
  }

  return {
    fullUrl: parsed.toString(),
    parsedUrl: parsed,
    baseName,
    ext,
  };
}

export function classifyAssetSubdir(ext, contentType = '') {
  const lowerExt = (ext || '').toLowerCase();
  const ct = (contentType || '').toLowerCase();

  if (FONT_EXTS.has(lowerExt) || ct.includes('font/') || ct.includes('woff')) {
    return 'assets/fonts';
  }
  if (SVG_EXTS.has(lowerExt) || ct.includes('image/svg')) {
    return 'assets/svg';
  }
  if (IMAGE_EXTS.has(lowerExt) || ct.startsWith('image/')) {
    return 'assets/images';
  }
  if (MEDIA_EXTS.has(lowerExt) || ct.startsWith('video/') || ct.startsWith('audio/')) {
    return 'assets/media';
  }
  return 'assets/misc';
}

export class AssetStore {
  constructor({ startOrigin, userAgent }) {
    this.startOrigin = startOrigin;
    this.userAgent = userAgent;
    /** @type {Map<string, { url: string, relPosixPath: string, buffer: Buffer, contentType: string, subdir: string }>} */
    this.byUrl = new Map();
    /** @type {Map<string, string>} relPosixPath -> url */
    this.usedRelPaths = new Map();
    /** @type {Map<string, string>} cssUrl -> cssText */
    this.stylesheetsByUrl = new Map();
    /** @type {string[]} ordered stylesheet URLs or inline IDs */
    this.stylesheetOrder = [];
  }

  setStartOrigin(origin) {
    this.startOrigin = origin;
  }

  /**
   * Registers a captured binary asset (image, font, svg, media) and returns its
   * normalized relative POSIX path (e.g. `assets/images/photo.webp`).
   */
  registerAsset(rawUrlString, buffer, contentType = '') {
    const info = extractLogicalAssetInfo(rawUrlString, this.startOrigin);
    if (!info) return null;

    if (this.byUrl.has(info.fullUrl)) {
      return this.byUrl.get(info.fullUrl).relPosixPath;
    }

    let ext = info.ext || guessExtensionFromContentType(contentType);
    if (!ext && buffer && buffer.length >= 4) {
      ext = sniffBufferExtension(buffer);
    }
    if (!ext) ext = '.bin';

    const subdir = classifyAssetSubdir(ext, contentType);
    let candidateRel = path.posix.join(subdir, `${info.baseName}${ext}`);

    // Prevent filename collisions when two different URLs have the same basename
    if (this.usedRelPaths.has(candidateRel) && this.usedRelPaths.get(candidateRel) !== info.fullUrl) {
      const hash = crypto.createHash('sha1').update(info.fullUrl).digest('hex').slice(0, 8);
      candidateRel = path.posix.join(subdir, `${info.baseName}-${hash}${ext}`);
    }

    this.usedRelPaths.set(candidateRel, info.fullUrl);
    const entry = {
      url: info.fullUrl,
      relPosixPath: candidateRel,
      buffer,
      contentType,
      subdir,
    };
    this.byUrl.set(info.fullUrl, entry);
    return candidateRel;
  }

  /**
   * Registers a stylesheet's text along with its source URL so relative `url(...)`
   * references inside the CSS can be resolved accurately against the stylesheet's URL.
   */
  registerStylesheet(cssUrl, cssText) {
    if (!cssText || !cssText.trim()) return;
    if (!this.stylesheetsByUrl.has(cssUrl)) {
      this.stylesheetOrder.push(cssUrl);
    }
    this.stylesheetsByUrl.set(cssUrl, cssText);
  }

  /**
   * Fetches an asset on-demand if it wasn't already captured by Playwright's
   * response listener (e.g., fonts or background images referenced in CSS, or
   * unselected srcset entries).
   */
  async ensureAssetDownloaded(rawUrlString, refererOrigin = this.startOrigin) {
    if (!rawUrlString) return null;
    const trimmed = rawUrlString.trim();
    if (
      !trimmed ||
      trimmed.startsWith('data:') ||
      trimmed.startsWith('blob:') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('mailto:') ||
      trimmed.startsWith('tel:') ||
      trimmed.startsWith('javascript:')
    ) {
      return null;
    }

    const info = extractLogicalAssetInfo(trimmed, refererOrigin);
    if (!info) return null;

    if (this.byUrl.has(info.fullUrl)) {
      return this.byUrl.get(info.fullUrl).relPosixPath;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(info.fullUrl, {
          redirect: 'follow',
          headers: {
            'user-agent': this.userAgent || 'Mozilla/5.0',
            accept: '*/*',
          },
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const ct = res.headers.get('content-type') || '';
        if (ct.toLowerCase().includes('text/html')) return null;
        const arrayBuf = await res.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        return this.registerAsset(info.fullUrl, buf, ct);
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    }
  }

  /**
   * Processes all collected stylesheets, downloads any missing fonts/images
   * referenced via `url(...)`, rewrites `url(...)` paths, and returns a single
   * formatted CSS string.
   *
   * @param {(relPosixPath: string) => string} cssUrlFormatter
   *   Function that maps `assets/fonts/foo.woff2` to the path relative to the CSS file
   *   (e.g., `../assets/fonts/foo.woff2` in HTML mode or `/assets/fonts/foo.woff2` in React/Next mode).
   */
  async buildConsolidatedCss(cssUrlFormatter) {
    const chunks = [];

    for (const cssUrl of this.stylesheetOrder) {
      let cssText = this.stylesheetsByUrl.get(cssUrl) || '';
      if (!cssText.trim()) continue;

      const baseForResolution = cssUrl.startsWith('http') ? cssUrl : this.startOrigin;
      cssText = await this.rewriteCssUrls(cssText, baseForResolution, cssUrlFormatter);
      chunks.push(`/* Source: ${ sanitizeCommentUrl(cssUrl, this.startOrigin) } */\n${formatCssReadable(cssText)}`);
    }

    return chunks.join('\n\n');
  }

  async rewriteCssUrls(cssText, cssBaseUrl, cssUrlFormatter) {
    // Match url(...) not starting with data: or #
    const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    const matches = [...cssText.matchAll(urlRegex)];
    if (matches.length === 0) return cssText;

    const replacements = new Map();
    for (const m of matches) {
      const rawRef = m[2].trim();
      if (!rawRef || rawRef.startsWith('data:') || rawRef.startsWith('#') || rawRef.startsWith('blob:')) {
        continue;
      }
      if (replacements.has(rawRef)) continue;

      let resolvedUrl;
      try {
        resolvedUrl = new URL(rawRef, cssBaseUrl).toString();
      } catch {
        continue;
      }

      const relPosixPath = await this.ensureAssetDownloaded(resolvedUrl, cssBaseUrl);
      if (relPosixPath) {
        replacements.set(rawRef, cssUrlFormatter(relPosixPath));
      }
    }

    return cssText.replace(urlRegex, (fullMatch, quote, rawRef) => {
      const trimmed = rawRef.trim();
      if (replacements.has(trimmed)) {
        return `url("${replacements.get(trimmed)}")`;
      }
      return fullMatch;
    });
  }

  /**
   * Writes all collected binary assets to `targetBaseDir` (e.g. `outRoot` for HTML mode,
   * or `path.join(outRoot, 'public')` for React/Next.js mode).
   */
  async writeAssetsToDisk(targetBaseDir) {
    let written = 0;
    for (const entry of this.byUrl.values()) {
      const dest = path.join(targetBaseDir, ...entry.relPosixPath.split('/'));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, entry.buffer);
      written++;
    }
    return written;
  }
}

function sanitizeCommentUrl(urlStr, startOrigin) {
  if (!urlStr.startsWith('http')) return urlStr;
  try {
    const u = new URL(urlStr);
    if (u.origin === startOrigin) return u.pathname;
    return `${u.hostname}${u.pathname}`;
  } catch {
    return urlStr;
  }
}

function sniffBufferExtension(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return '.webp';
  }
  if (buf[0] === 0x77 && buf[1] === 0x4f && buf[2] === 0x46 && buf[3] === 0x32) return '.woff2';
  if (buf[0] === 0x77 && buf[1] === 0x4f && buf[2] === 0x46 && buf[3] === 0x46) return '.woff';
  const head = buf.subarray(0, 120).toString('utf8').trim();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return '.svg';
  return '';
}

/**
 * Formats minified CSS into clean, readable multi-line CSS while preserving
 * strings, `url(...)`, and calc/var expressions safely.
 */
export function formatCssReadable(css) {
  if (!css) return '';
  let out = '';
  let indent = 0;
  let inSingle = false;
  let inDouble = false;
  let inComment = false;
  let parenDepth = 0;

  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    const next = css[i + 1];

    if (inComment) {
      out += ch;
      if (ch === '*' && next === '/') {
        out += '/';
        i++;
        inComment = false;
        out += '\n' + '  '.repeat(indent);
      }
      continue;
    }

    if (!inSingle && !inDouble && ch === '/' && next === '*') {
      inComment = true;
      out += '/*';
      i++;
      continue;
    }

    if (ch === "'" && !inDouble && css[i - 1] !== '\\') {
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (ch === '"' && !inSingle && css[i - 1] !== '\\') {
      inDouble = !inDouble;
      out += ch;
      continue;
    }

    if (inSingle || inDouble) {
      out += ch;
      continue;
    }

    if (ch === '(') {
      parenDepth++;
      out += ch;
      continue;
    }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      out += ch;
      continue;
    }

    if (ch === '{' && parenDepth === 0) {
      indent++;
      out = out.trimEnd() + ' {\n' + '  '.repeat(indent);
      continue;
    }

    if (ch === '}' && parenDepth === 0) {
      indent = Math.max(0, indent - 1);
      out = out.trimEnd() + '\n' + '  '.repeat(indent) + '}\n' + (indent === 0 ? '\n' : '  '.repeat(indent));
      continue;
    }

    if (ch === ';' && parenDepth === 0) {
      out += ';\n' + '  '.repeat(indent);
      continue;
    }

    if ((ch === '\n' || ch === '\r') && parenDepth === 0) {
      while (i + 1 < css.length && (css[i + 1] === ' ' || css[i + 1] === '\t')) {
        i++;
      }
      continue;
    }

    out += ch;
  }

  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
