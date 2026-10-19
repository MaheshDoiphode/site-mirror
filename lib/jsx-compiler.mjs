/**
 * DOM Cleaner, HTML-to-JSX AST Compiler, and Semantic Component Extractor.
 *
 * Parses captured HTML with Cheerio (`domhandler` AST), strips framework runtime
 * scripts/hydration artifacts, rewrites asset and navigation URLs, extracts
 * reusable semantic components (`Header`, `Footer`), and compiles DOM subtrees
 * directly into formatted, valid React / Next.js JSX without `dangerouslySetInnerHTML`.
 */
import * as cheerio from 'cheerio';
import path from 'node:path';
import { collectDomInventory, extractCssModulePrefix } from './css-splitter.mjs';

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Standard HTML & SVG attribute mapping to React camelCase
const JSX_ATTR_MAP = {
  class: 'className',
  for: 'htmlFor',
  tabindex: 'tabIndex',
  readonly: 'readOnly',
  maxlength: 'maxLength',
  minlength: 'minLength',
  cellpadding: 'cellPadding',
  cellspacing: 'cellSpacing',
  rowspan: 'rowSpan',
  colspan: 'colSpan',
  usemap: 'useMap',
  frameborder: 'frameBorder',
  contenteditable: 'contentEditable',
  crossorigin: 'crossOrigin',
  datetime: 'dateTime',
  enctype: 'encType',
  formaction: 'formAction',
  formenctype: 'formEncType',
  formmethod: 'formMethod',
  formnovalidate: 'formNoValidate',
  formtarget: 'formTarget',
  hreflang: 'hrefLang',
  inputmode: 'inputMode',
  novalidate: 'noValidate',
  playsinline: 'playsInline',
   referrerpolicy: 'referrerPolicy',
  referrerpolicy: 'referrerPolicy',
  srcdoc: 'srcDoc',
  srclang: 'srcLang',
  srcset: 'srcSet',
   imagesrcset: 'imageSrcSet',
  imagesizes: 'imageSizes',
  fetchpriority: 'fetchPriority',
  autocomplete: 'autoComplete',
  autofocus: 'autoFocus',
  autoplay: 'autoPlay',
  charset: 'charSet',
  accesskey: 'accessKey',
  allowfullscreen: 'allowFullScreen',
  // SVG attributes
  'accent-height': 'accentHeight',
  'alignment-baseline': 'alignmentBaseline',
  'arabic-form': 'arabicForm',
  'baseline-shift': 'baselineShift',
  'cap-height': 'capHeight',
  'clip-path': 'clipPath',
  'clip-rule': 'clipRule',
  'color-interpolation': 'colorInterpolation',
  'color-interpolation-filters': 'colorInterpolationFilters',
  'color-profile': 'colorProfile',
  'color-rendering': 'colorRendering',
  'dominant-baseline': 'dominantBaseline',
  'enable-background': 'enableBackground',
  'fill-opacity': 'fillOpacity',
  'fill-rule': 'fillRule',
  'flood-color': 'floodColor',
  'flood-opacity': 'floodOpacity',
  'font-family': 'fontFamily',
  'font-size': 'fontSize',
  'font-size-adjust': 'fontSizeAdjust',
  'font-stretch': 'fontStretch',
  'font-style': 'fontStyle',
  'font-variant': 'fontVariant',
  'font-weight': 'fontWeight',
  'glyph-name': 'glyphName',
  'glyph-orientation-horizontal': 'glyphOrientationHorizontal',
  'glyph-orientation-vertical': 'glyphOrientationVertical',
  'horiz-adv-x': 'horizAdvX',
  'horiz-origin-x': 'horizOriginX',
  'image-rendering': 'imageRendering',
  'letter-spacing': 'letterSpacing',
  'lighting-color': 'lightingColor',
  'marker-end': 'markerEnd',
  'marker-mid': 'markerMid',
  'marker-start': 'markerStart',
  'overline-position': 'overlinePosition',
  'overline-thickness': 'overlineThickness',
  'paint-order': 'paintOrder',
  'panose-1': 'panose1',
  'pointer-events': 'pointerEvents',
  'rendering-intent': 'renderingIntent',
  'shape-rendering': 'shapeRendering',
  'stop-color': 'stopColor',
  'stop-opacity': 'stopOpacity',
  'strikethrough-position': 'strikethroughPosition',
  'strikethrough-thickness': 'strikethroughThickness',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-miterlimit': 'strokeMiterlimit',
  'stroke-opacity': 'strokeOpacity',
  'stroke-width': 'strokeWidth',
  'text-anchor': 'textAnchor',
  'text-decoration': 'textDecoration',
  'text-rendering': 'textRendering',
  'underline-position': 'underlinePosition',
  'underline-thickness': 'underlineThickness',
  'unicode-bidi': 'unicodeBidi',
  'unicode-range': 'unicodeRange',
  'units-per-em': 'unitsPerEm',
  'v-alphabetic': 'vAlphabetic',
  'v-hanging': 'vHanging',
  'v-ideographic': 'vIdeographic',
  'v-mathematical': 'vMathematical',
  'vector-effect': 'vectorEffect',
  'vert-adv-y': 'vertAdvY',
  'vert-origin-x': 'vertOriginX',
  'vert-origin-y': 'vertOriginY',
  'word-spacing': 'wordSpacing',
  'writing-mode': 'writingMode',
  'x-height': 'xHeight',
  'xlink:actuate': 'xlinkActuate',
  'xlink:arcrole': 'xlinkArcrole',
  'xlink:href': 'xlinkHref',
  'xlink:role': 'xlinkRole',
  'xlink:show': 'xlinkShow',
  'xlink:title': 'xlinkTitle',
  'xlink:type': 'xlinkType',
  'xml:base': 'xmlBase',
  'xml:lang': 'xmlLang',
  'xml:space': 'xmlSpace',
  'xmlns:xlink': 'xmlnsXlink',
  viewbox: 'viewBox',
  preserveaspectratio: 'preserveAspectRatio',
  clippathunits: 'clipPathUnits',
  gradientunits: 'gradientUnits',
  gradienttransform: 'gradientTransform',
  patternunits: 'patternUnits',
  patterntransform: 'patternTransform',
  maskunits: 'maskUnits',
  maskcontentunits: 'maskContentUnits',
   filterunits: 'filterUnits',
  filterunits: 'filterUnits',
  primitiveunits: 'primitiveUnits',
  stddeviation: 'stdDeviation',
  basefrequency: 'baseFrequency',
  numoctaves: 'numOctaves',
  stitchtiles: 'stitchTiles',
  targetx: 'targetX',
  targety: 'targetY',
  kernelmatrix: 'kernelMatrix',
  surfacescale: 'surfaceScale',
  specularconstant: 'specularConstant',
  specularexponent: 'specularExponent',
  diffuseconstant: 'diffuseConstant',
  pointsatx: 'pointsAtX',
  pointsaty: 'pointsAtY',
  pointsatz: 'pointsAtZ',
  limitingconeangle: 'limitingConeAngle',
  tablevalues: 'tableValues',
  xchannelselector: 'xChannelSelector',
  ychannelselector: 'yChannelSelector',
  markerwidth: 'markerWidth',
  markerheight: 'markerHeight',
  markerunits: 'markerUnits',
  refx: 'refX',
  refy: 'refY',
  pathlength: 'pathLength',
   spreadmethod: 'spreadMethod',
  spreadmethod: 'spreadMethod',
};

const BOOLEAN_ATTRS = new Set([
  'disabled', 'checked', 'readonly', 'required', 'multiple', 'hidden',
  'autofocus', 'autoplay', 'controls', 'loop', 'muted', 'default',
  'defer', 'async', 'novalidate', 'formnovalidate', 'open', 'reversed',
  'scoped', 'seamless', 'selected', 'itemscope', 'playsinline', 'allowfullscreen',
]);

/**
 * Cleans the raw HTML captured from Playwright:
 * - Removes framework runtime `<script>` tags, `<link rel="preload" as="script">`, `<next-route-announcer>`, etc.
 * - Removes hidden React Suspense / hydration artifacts (`<div hidden>`)
 * - Removes original `<link rel="stylesheet">` and `<style>` tags (since styles are consolidated)
 * - Downloads and rewrites all `<img>`, `<source>`, `<video>`, `<audio>`, `<image>` asset URLs
 */
export async function cleanAndRewritePageDom({
  rawHtml,
  pageUrl,
  startOrigin,
  assetStore,
  assetUrlFormatter,
  linkUrlFormatter,
}) {
  const $ = cheerio.load(rawHtml, { decodeEntities: false });

  // Extract metadata before stripping head elements
  const title = ($('title').first().text() || '').trim() || 'Mirrored Site';
  const description = ($('meta[name="description"]').attr('content') || '').trim();
  const themeColor = ($('meta[name="theme-color"]').attr('content') || '').trim();
  const htmlClass = ($('html').attr('class') || '').trim();
  const htmlStyle = ($('html').attr('style') || '').trim();
  const htmlLang = ($('html').attr('lang') || 'en').trim();
  const htmlDataTheme = ($('html').attr('data-theme') || '').trim();
  const bodyClass = ($('body').attr('class') || '').trim();
  const bodyStyle = ($('body').attr('style') || '').trim();

  // Collect inline <style> tags into assetStore before removing them
  let inlineIdx = 0;
  $('style').each((_, el) => {
    const cssText = $(el).html() || '';
    if (cssText.trim()) {
      inlineIdx++;
      assetStore.registerStylesheet(`${pageUrl.pathname}#inline-${inlineIdx}`, cssText);
    }
    $(el).remove();
  });

  // Remove all scripts, noscripts, preload links, and stylesheets (we link our consolidated CSS)
  $('script, noscript, next-route-announcer, template').remove();
  $('link[rel="stylesheet"], link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"], link[rel="dns-prefetch"], link[rel="preconnect"]').remove();

  // Remove empty hidden hydration placeholders like `<div hidden=""><!--$--><!--/$--></div>`
  $('div[hidden]').each((_, el) => {
    const text = $(el).text().trim();
    const children = $(el).children().length;
    if (!text && children === 0) {
      $(el).remove();
    }
  });

  // Remove cookie/consent banners that clutter reference clones
  $('#consent-banner, [data-testid="consent-banner"]').remove();

  // Rewrite asset URLs across all media elements
  const assetSelectors = [
    { selector: 'img', attr: 'src' },
    { selector: 'img', attr: 'srcset' },
    { selector: 'source', attr: 'src' },
    { selector: 'source', attr: 'srcset' },
    { selector: 'video', attr: 'src' },
    { selector: 'video', attr: 'poster' },
    { selector: 'audio', attr: 'src' },
    { selector: 'image', attr: 'href' },
    { selector: 'image', attr: 'xlink:href' },
    { selector: 'link[rel*="icon"]', attr: 'href' },
  ];

  for (const { selector, attr } of assetSelectors) {
    const elements = $(selector).toArray();
    for (const el of elements) {
      const val = $(el).attr(attr);
      if (!val) continue;

      if (attr === 'srcset') {
        const parts = val.split(',').map((s) => s.trim()).filter(Boolean);
        const rewrittenParts = [];
        let lastValidSrc = null;

        for (const part of parts) {
          const [rawUrl, ...descriptors] = part.split(/\s+/);
          if (!rawUrl) continue;
          const relPosix = await assetStore.ensureAssetDownloaded(rawUrl, pageUrl.toString());
          if (relPosix) {
            const formatted = assetUrlFormatter(relPosix);
            lastValidSrc = formatted;
            rewrittenParts.push(descriptors.length ? `${formatted} ${descriptors.join(' ')}` : formatted);
          }
        }

        if (rewrittenParts.length > 0) {
          $(el).attr(attr, rewrittenParts.join(', '));
          // Also ensure `src` points to a valid local image if `src` is a Next.js image URL
          if (selector === 'img' && lastValidSrc && (!$(el).attr('src') || $(el).attr('src').includes('_next/image'))) {
            $(el).attr('src', lastValidSrc);
          }
        } else {
          $(el).removeAttr(attr);
        }
      } else {
        const relPosix = await assetStore.ensureAssetDownloaded(val, pageUrl.toString());
        if (relPosix) {
          $(el).attr(attr, assetUrlFormatter(relPosix));
        }
      }
    }
  }

  // Rewrite inline style `url(...)` on elements BEFORE adding local `data-canvas-fallback` background images
  const styledEls = $('[style*="url("]').toArray();
  for (const el of styledEls) {
    const rawStyle = $(el).attr('style') || '';
    const rewrittenStyle = await assetStore.rewriteCssUrls(rawStyle, pageUrl.toString(), assetUrlFormatter);
    $(el).attr('style', rewrittenStyle);
  }

  // Materialize `<canvas data-canvas-snapshot="data:image/png;base64,...">` snapshots into `assets/images/`
  // and set them as `background-image` on the `<canvas>` so the bitmap is immediately visible before/without JS!
  const canvasEls = $('canvas[data-canvas-snapshot]').toArray();
  for (let i = 0; i < canvasEls.length; i++) {
    const el = canvasEls[i];
    const dataUrl = $(el).attr('data-canvas-snapshot') || '';
    const canvasId = $(el).attr('data-canvas-id') || `canvas-${i + 1}`;
    $(el).removeAttr('data-canvas-snapshot');
    $(el).removeAttr('data-canvas-id');

    const base64Prefix = 'data:image/png;base64,';
    if (dataUrl.startsWith(base64Prefix)) {
      const buf = Buffer.from(dataUrl.slice(base64Prefix.length), 'base64');
      const syntheticUrl = new URL(`/__canvas__/${pageUrl.pathname.replace(/\//g, '_')}_${canvasId}.png`, startOrigin).toString();
      const relPosix = assetStore.registerAsset(syntheticUrl, buf, 'image/png');
      if (relPosix) {
        const formattedUrl = assetUrlFormatter(relPosix);
        const existingStyle = ($(el).attr('style') || '').trim();
        const bgStyle = `background-image: url("${formattedUrl}"); background-size: 100% 100%; background-repeat: no-repeat;`;
        $(el).attr('style', existingStyle ? `${existingStyle}; ${bgStyle}` : bgStyle);
        $(el).attr('data-canvas-fallback', formattedUrl);
      }
    }
  }

  // Rewrite remote asset URLs inside preserved `data-mirror-widget-script` blocks so they load from local `assets/`
  const widgetHolders = $('[data-mirror-widget-script]').toArray();
  for (const holder of widgetHolders) {
    const encoded = $(holder).attr('data-mirror-widget-script') || '';
    if (!encoded) continue;
    try {
      let code = decodeURIComponent(encoded);
      // Match `'https://.../foo.webp'` or `ASSETS + 'foo.webp'`
      const assetsPrefixMatch = code.match(/var\s+ASSETS\s*=\s*['"](https?:\/\/[^'"]+)['"]/);
      if (assetsPrefixMatch) {
        const basePrefix = assetsPrefixMatch[1];
        const fileMatches = [...code.matchAll(/ASSETS\s*\+\s*['"]([^'"]+\.(?:webp|png|jpg|jpeg|svg|avif))['"]/gi)];
        for (const fm of fileMatches) {
          const fullRemoteUrl = basePrefix + fm[1];
          const relPosix = await assetStore.ensureAssetDownloaded(fullRemoteUrl, pageUrl.toString());
          if (relPosix) {
            const localUrl = assetUrlFormatter(relPosix);
            code = code.split(fm[0]).join(JSON.stringify(localUrl));
          }
        }
      }
      $(holder).attr('data-mirror-widget-script', encodeURIComponent(code));
    } catch {}
  }

  // Rewrite `<a href>` links
  $('a[href]').each((_, el) => {
    const rawHref = $(el).attr('href');
    if (!rawHref) return;
    const rewritten = linkUrlFormatter(rawHref, pageUrl);
    $(el).attr('href', rewritten);
  });

  return {
    $,
    metadata: {
      title,
      description,
      themeColor,
      htmlClass,
      htmlStyle,
      htmlLang,
      htmlDataTheme,
      bodyClass,
      bodyStyle,
    },
  };
}

/**
 * Parses an inline CSS style string (e.g. `"width: 100%; --site-header-height: 68px"`)
 * into a JSX object literal string (`{{ width: "100%", "--site-header-height": "68px" }}`).
 */
export function styleStringToJsxObjectLiteral(styleStr) {
  if (!styleStr || !styleStr.trim()) return null;

  // Split by `;` not inside parentheses or quotes
  const declarations = [];
  let current = '';
  let parenDepth = 0;
  let inQuote = null;

  for (let i = 0; i < styleStr.length; i++) {
    const ch = styleStr[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote && styleStr[i - 1] !== '\\') inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);

    if (ch === ';' && parenDepth === 0) {
      if (current.trim()) declarations.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) declarations.push(current.trim());

  const pairs = [];
  let hasCustomProperty = false;
  for (const decl of declarations) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx === -1) continue;
    const rawProp = decl.slice(0, colonIdx).trim();
    const rawVal = decl.slice(colonIdx + 1).trim();
    if (!rawProp || !rawVal) continue;

    let jsxKey;
    if (rawProp.startsWith('--')) {
      hasCustomProperty = true;
      jsxKey = JSON.stringify(rawProp);
    } else {
      const camel = rawProp
        .toLowerCase()
        .replace(/^-ms-/, 'ms-')
        .replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
      // Skip experimental CSS properties (`cornerShape`) that TypeScript's csstype rejects in React.CSSProperties
      if (camel === 'cornerShape') {
        continue;
      }
      if (camel.startsWith('webkit') || camel.startsWith('moz')) {
        hasCustomProperty = true;
      }
      jsxKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(camel) ? camel : JSON.stringify(camel);
    }

    pairs.push(`${jsxKey}: ${JSON.stringify(rawVal)}`);
  }

  if (pairs.length === 0) return null;
  if (hasCustomProperty) {
    return `{{ ${pairs.join(', ')} } as React.CSSProperties}`;
  }
  return `{{ ${pairs.join(', ')} }}`;
}

function mapAttrNameToJsx(attrName, tagName) {
  const lower = attrName.toLowerCase();
  if (lower.startsWith('data-') || lower.startsWith('aria-')) {
    return lower;
  }
  // Event handlers: strip inline string event handlers (`onclick="..."`) in JSX
  if (lower.startsWith('on')) {
    return null;
  }
  // Drop XML/XLink namespace declarations & non-standard Framer internal props that TypeScript React rejects
  if (
    lower === 'xlink' ||
    lower === 'xmlns:xlink' ||
    lower === 'xml:space' ||
    lower === 'xml:lang' ||
    lower.startsWith('_') ||
    lower === 'parentsize' ||
    lower === 'rotation' ||
    lower === 'shadows'
  ) {
    return null;
  }
  if (JSX_ATTR_MAP[attrName]) return JSX_ATTR_MAP[attrName];
  if (JSX_ATTR_MAP[lower]) return JSX_ATTR_MAP[lower];

  // Convert remaining hyphenated SVG/custom attributes to camelCase
  if (attrName.includes('-')) {
    return attrName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }
  if (attrName.includes(':')) {
    return attrName.replace(/:([a-z])/g, (_, c) => c.toUpperCase());
  }
  return attrName;
}

function escapeJsxText(text) {
  // Replace HTML entities commonly left in raw text and escape JSX special chars `{` `}` `<` `>`
  return text
    .replace(/&nbsp;/g, '\u00A0')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[{}<>]/g, (ch) => `{"${ch}"}`);
}

/**
 * Compiles a list of Cheerio / domhandler AST nodes into formatted JSX.
 *
 * @param {any[]} nodes
 * @param {object} options
 * @param {'react' | 'nextjs' | 'none'} [options.routerMode]
 * @param {Set<string>} [options.mirroredRoutes]
 * @param {number} [options.indentLevel]
 * @returns {{ jsx: string, usesRouterLink: boolean }}
 */
export function nodesToJsx(nodes, options = {}) {
  const { routerMode = 'none', mirroredRoutes = new Set(), indentLevel = 2 } = options;
  let usesRouterLink = false;

  function renderNode(node, depth) {
    const pad = '  '.repeat(depth);

    if (node.type === 'comment') {
      return '';
    }

    if (node.type === 'text') {
      const raw = node.data || '';
      if (!raw.trim()) {
        return raw.includes(' ') ? ' ' : '';
      }
      // Collapse excessive internal newlines/indentation in text nodes
      const normalized = raw.replace(/\s+/g, ' ');
      return escapeJsxText(normalized);
    }

    if (node.type !== 'tag' && node.type !== 'style' && node.type !== 'script') {
      return '';
    }

    let tagName = node.name;
    if (!tagName) return '';

    const rawAttribs = node.attribs || {};
    const href = rawAttribs.href || '';
    const target = rawAttribs.target || '';

    // Determine whether an `<a>` tag should become a React Router `<Link to="...">` or Next `<Link href="...">`
    let isRouterLink = false;
    let displayTagName = tagName;
    if (
      tagName === 'a' &&
      routerMode !== 'none' &&
      href.startsWith('/') &&
      !href.startsWith('//') &&
      (!target || target === '_self')
    ) {
      const routePath = normalizeRoutePathname(href.split('?')[0].split('#')[0]);
      if (mirroredRoutes.size === 0 || mirroredRoutes.has(routePath)) {
        isRouterLink = true;
        usesRouterLink = true;
        displayTagName = 'Link';
      }
    }

    const attrParts = [];
    for (const [rawKey, rawVal] of Object.entries(rawAttribs)) {
      if (rawKey === 'style') {
        const styleObj = styleStringToJsxObjectLiteral(rawVal);
        if (styleObj) attrParts.push(`style=${styleObj}`);
        continue;
      }

      // Skip Next.js internal image hydration marker
      if (rawKey === 'data-nimg' || rawKey === 'data-precedence') continue;

      if (isRouterLink && rawKey === 'href') {
        if (routerMode === 'react') {
          attrParts.push(`to=${JSON.stringify(rawVal)}`);
        } else {
          attrParts.push(`href=${JSON.stringify(rawVal)}`);
        }
        continue;
      }

      // Convert `value` on uncontrolled `<input>` / `<textarea>` / `<select>` to `defaultValue`
      if (
        rawKey === 'value' &&
        (tagName === 'input' || tagName === 'textarea' || tagName === 'select') &&
        rawAttribs.type !== 'button' &&
        rawAttribs.type !== 'submit' &&
        rawAttribs.type !== 'reset'
      ) {
        attrParts.push(`defaultValue=${JSON.stringify(rawVal)}`);
        continue;
      }

      if (rawKey === 'checked' && tagName === 'input') {
        attrParts.push('defaultChecked');
        continue;
      }

      const jsxKey = mapAttrNameToJsx(rawKey, tagName);
      if (!jsxKey || !/^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/.test(jsxKey)) continue;

      if (BOOLEAN_ATTRS.has(rawKey.toLowerCase()) && (rawVal === '' || rawVal === rawKey)) {
        attrParts.push(jsxKey);
        continue;
      }

      // TypeScript React types expect numeric `tabIndex` (e.g. `tabIndex={0}`)
      if (jsxKey === 'tabIndex') {
        const num = Number(rawVal);
        if (!Number.isNaN(num)) {
          attrParts.push(`tabIndex={${num}}`);
          continue;
        }
      }

      const cleanVal = String(rawVal).replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (/["\n\r\\]/.test(cleanVal)) {
        attrParts.push(`${jsxKey}={${JSON.stringify(cleanVal)}}`);
      } else {
        attrParts.push(`${jsxKey}=${JSON.stringify(cleanVal)}`);
      }
    }

    const attrStr = attrParts.length ? ' ' + attrParts.join(' ') : '';
    const isVoid = !isRouterLink && VOID_ELEMENTS.has(tagName.toLowerCase());
    const children = (node.children || []).filter((c) => c.type !== 'comment');

    if (isVoid || children.length === 0) {
      return `${pad}<${displayTagName}${attrStr} />`;
    }

    // Check if children are purely single-line inline text
    if (children.length === 1 && children[0].type === 'text') {
      const rawText = children[0].data || '';
      if (!rawText.trim()) {
        if (rawText.includes(' ')) {
          return `${pad}<${displayTagName}${attrStr}>{" "}</${displayTagName}>`;
        }
        return `${pad}<${displayTagName}${attrStr} />`;
      }
      const textContent = escapeJsxText(rawText.replace(/\s+/g, ' ').trim());
      if (textContent.length <= 80 && !textContent.includes('\n')) {
        return `${pad}<${displayTagName}${attrStr}>${textContent}</${displayTagName}>`;
      }
    }

    const childPad = '  '.repeat(depth + 1);
    const renderedChildren = [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type === 'text') {
        const raw = child.data || '';
        if (!raw.trim()) {
          // Preserve space between two adjacent inline element siblings
          const prev = children[i - 1];
          const next = children[i + 1];
          if (raw.includes(' ') && prev && next && prev.type === 'tag' && next.type === 'tag') {
            renderedChildren.push(`${childPad}{" "}`);
          }
          continue;
        }
        const normalized = raw.replace(/\s+/g, ' ');
        const hasLeadSpace = /^\s/.test(normalized) && i > 0;
        const hasTrailSpace = /\s$/.test(normalized) && i < children.length - 1;
        const escaped = escapeJsxText(normalized.trim());
        const prefix = hasLeadSpace ? '{" "}' : '';
        const suffix = hasTrailSpace ? '{" "}' : '';
        renderedChildren.push(`${childPad}${prefix}${escaped}${suffix}`);
        continue;
      }
      const r = renderNode(child, depth + 1);
      if (r && r.trim()) {
        renderedChildren.push(r);
      }
    }

    if (renderedChildren.length === 0) {
      return `${pad}<${displayTagName}${attrStr} />`;
    }

    return `${pad}<${displayTagName}${attrStr}>\n${renderedChildren.join('\n')}\n${pad}</${displayTagName}>`;
  }

  const lines = [];
  for (const node of nodes) {
    const rendered = renderNode(node, indentLevel);
    if (rendered && rendered.trim()) {
      lines.push(node.type === 'text' ? `${'  '.repeat(indentLevel)}${rendered.trim()}` : rendered);
    }
  }

  return {
    jsx: lines.join('\n'),
    usesRouterLink,
  };
}

export function normalizeRoutePathname(pathname = '/') {
  if (!pathname || pathname === '/') return '/';
  const cleaned = pathname.replace(/\/+$/, '');
  return cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
}

/**
 * Extracts shared `<header>` (`Navbar`), `<footer>` (`Footer`), and semantic `<section>`
 * components from a page DOM so React/Next.js projects have modular
 * `components/<Name>/<Name>.tsx` + `<Name>.css` folders.
 */
const GENERIC_SECTION_PREFIXES = new Set([
  'LandingPageSection',
  'PageSection',
  'Section',
  'Container',
  'Wrapper',
  'Layout',
  'Grid',
  'Icon',
  'Button',
  'ButtonTextLink',
]);

function toPascalCaseIdentifier(raw) {
  const cleaned = String(raw || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  if (!cleaned) return 'SectionBlock';
  return /^[0-9]/.test(cleaned) ? `Section${cleaned}` : cleaned;
}

function inferComponentNameFromSectionNode($, sectionEl, fallbackIndex, pageNamePrefix = '') {
  const inv = collectDomInventory($, [sectionEl]);
  const specificPrefixes = [...inv.modulePrefixes].filter((p) => !GENERIC_SECTION_PREFIXES.has(p));

  if (specificPrefixes.length > 0) {
    return {
      baseName: toPascalCaseIdentifier(specificPrefixes[0]),
      primaryPrefixes: new Set(specificPrefixes),
      inventory: inv,
    };
  }

  // Check aria-label, data-framer-name, id, or first heading inside the section
  const $sec = $(sectionEl);
  const framerNameAttr = ($sec.attr('data-framer-name') || '').trim();
  if (framerNameAttr && !/^(default|desktop|mobile|tablet|variant\s*\d*)$/i.test(framerNameAttr)) {
    return {
      baseName: `${pageNamePrefix || ''}${toPascalCaseIdentifier(framerNameAttr)}`,
      primaryPrefixes: new Set(inv.modulePrefixes),
      inventory: inv,
    };
  }

  const idAttr = $sec.attr('id') || $sec.attr('aria-label') || '';
  if (idAttr && !/^(main|content|main-content|hero)$/i.test(idAttr.trim())) {
    return {
      baseName: toPascalCaseIdentifier(idAttr),
      primaryPrefixes: new Set(inv.modulePrefixes),
      inventory: inv,
    };
  }

  // Check Webflow / BEM style root class (e.g. `hero_wrap`, `g_section_wrap`)
  const rootClass = ($sec.attr('class') || '').split(/\s+/).filter(Boolean)[0] || '';
  if (rootClass && /hero/i.test(rootClass)) {
    return {
      baseName: `${pageNamePrefix || ''}HeroSection`,
      primaryPrefixes: new Set(inv.modulePrefixes),
      inventory: inv,
    };
  }

  const headingText = $sec.find('h1, h2, h3').first().text().trim();
  if (headingText && headingText.length <= 36) {
    return {
      baseName: toPascalCaseIdentifier(headingText),
      primaryPrefixes: new Set(inv.modulePrefixes),
      inventory: inv,
    };
  }

  return {
    baseName: `${pageNamePrefix || ''}Section${fallbackIndex}`,
    primaryPrefixes: new Set(inv.modulePrefixes),
    inventory: inv,
  };
}

/**
 * Decomposes a cleaned page DOM (`$`) into:
 * - `navbarComponent`: `{ name: 'Navbar', nodes, inventory, primaryPrefixes }` (if site header/nav present)
 * - `footerComponent`: `{ name: 'Footer', nodes, inventory, primaryPrefixes }` (if `<footer>` present)
 * - `sectionComponents`: array of `{ name, nodes, inventory, primaryPrefixes }`
 * - `pageWrapper`: `{ mainAttrs, hasArticleWrapper, fallbackBodyNodes }`
 */
export function extractPageComponents($, usedNames = new Set(['Navbar', 'Footer']), pageNamePrefix = '') {
  const body = $('body');

  // 1. Identify the site-level Navbar (must NOT be a `<header>` inside `<main>` or a `.hero_wrap`)
  let headerNodes = [];
  const topHeader = body
    .find('> header, > div:not(.page_wrap) > header')
    .filter((_, el) => {
      const cls = ($(el).attr('class') || '').toLowerCase();
      const id = ($(el).attr('id') || '').toLowerCase();
      return !cls.includes('hero') && id !== 'main' && $(el).closest('main').length === 0;
    })
    .first();

  if (topHeader.length) {
    headerNodes = [topHeader[0]];
    topHeader.remove();
  } else {
    // Check for Webflow / div-based navbar containers (e.g. `.nav_component`, which may sit inside `<main class="page_wrap">`)
    const navDivs = body
      .find('.nav_component, > nav, > div > nav, > main > nav')
      .filter((_, el) => $(el).closest('footer, section, header').length === 0)
      .toArray();
    if (navDivs.length > 0) {
      headerNodes = navDivs;
      for (const n of navDivs) $(n).remove();
    }
  }

  const footerEl = body.find('> footer, > div > footer, > main > footer').first();

  let navbarComponent = null;
  let footerComponent = null;

  if (headerNodes.length > 0) {
    const inv = collectDomInventory($, headerNodes);
    navbarComponent = {
      name: 'Navbar',
      nodes: headerNodes,
      inventory: inv,
      primaryPrefixes: new Set(inv.modulePrefixes),
    };
  }

  if (footerEl.length) {
    const node = footerEl[0];
    const inv = collectDomInventory($, [node]);
    footerComponent = {
      name: 'Footer',
      nodes: [node],
      inventory: inv,
      primaryPrefixes: new Set(inv.modulePrefixes),
    };
    footerEl.remove();
  }

  // 2. Look for top-level content section blocks inside `<main>`, `<main> > <article>`, Framer `#main > [data-framer-root]`, or `<body>`
  let mainEl = body.find('> main, > div > main').first();
  const framerMainEl = !mainEl.length ? body.find('> #main').first() : $();
  const framerPageRoot = framerMainEl.length
    ? framerMainEl
        .find('[data-framer-root], > div[class*="framer-"], > div[style*="contents"] > div[class*="framer-"]')
        .first()
    : $();

  // Extract `#mirror-cursor-bank` (custom cursor variants) so it can be attached to `Navbar`
  const cursorBankEl = body.find('#mirror-cursor-bank').first();
  let cursorBankNodes = [];
  if (cursorBankEl.length) {
    cursorBankNodes = [cursorBankEl[0]];
    cursorBankEl.remove();
  }

  // Also check Framer Navbar / Footer if no semantic `<header>` / `<footer>` was found
  if (!navbarComponent && framerPageRoot.length) {
    const framerNav = framerPageRoot.children('[data-framer-name="Navbar"], [data-framer-name="Header"], [data-framer-name="Nav"]').first();
    if (framerNav.length) {
      const node = framerNav[0];
      const inv = collectDomInventory($, [node, ...cursorBankNodes]);
      navbarComponent = {
        name: 'Navbar',
        nodes: [node, ...cursorBankNodes],
        inventory: inv,
        primaryPrefixes: new Set(inv.modulePrefixes),
      };
      cursorBankNodes = [];
      framerNav.remove();
    }
  } else if (navbarComponent && cursorBankNodes.length > 0) {
    navbarComponent.nodes.push(...cursorBankNodes);
    const extraInv = collectDomInventory($, cursorBankNodes);
    for (const c of extraInv.classes) navbarComponent.inventory.classes.add(c);
    for (const id of extraInv.ids) navbarComponent.inventory.ids.add(id);
    for (const t of extraInv.tags) navbarComponent.inventory.tags.add(t);
    cursorBankNodes = [];
  }

  if (!footerComponent && framerPageRoot.length) {
    const framerFoot = framerPageRoot.children('[data-framer-name="Footer"]').first();
    if (framerFoot.length) {
      const node = framerFoot[0];
      const inv = collectDomInventory($, [node]);
      footerComponent = {
        name: 'Footer',
        nodes: [node],
        inventory: inv,
        primaryPrefixes: new Set(inv.modulePrefixes),
      };
      framerFoot.remove();
    }
  }

  let sectionContainer = mainEl.length
    ? mainEl
    : framerPageRoot.length
    ? framerPageRoot
    : body;
  let hasArticleWrapper = false;
  let articleClass = '';
  let wrapperTag = mainEl.length ? 'main' : framerMainEl.length ? 'div' : 'main';
  let innerWrapperClass = framerPageRoot.length ? framerPageRoot.attr('class') || '' : '';
  let innerWrapperStyle = framerPageRoot.length ? framerPageRoot.attr('style') || '' : '';
  let innerWrapperCursor = framerPageRoot.length ? framerPageRoot.attr('data-framer-cursor') || '' : '';
  let framerAppearMap = framerMainEl.length ? framerMainEl.attr('data-framer-appear-map') || '' : '';

  if (mainEl.length) {
    const directChildren = mainEl.children().toArray();
    if (directChildren.length === 1 && directChildren[0].name === 'article') {
      hasArticleWrapper = true;
      articleClass = $(directChildren[0]).attr('class') || '';
      sectionContainer = $(directChildren[0]);
    }
  }

  // Include `<section>`, hero `<header>` inside main, content block `<div class="*section*">`, and Framer page root children
  const hasSemanticSection = sectionContainer.children('section').length > 0;
  const isFramerContainer = framerPageRoot.length > 0;
  const directSections = hasSemanticSection
    ? sectionContainer
        .children()
        .filter((_, el) => {
          const tag = (el.name || '').toLowerCase();
          if (tag === 'section' || tag === 'header' || tag === 'article') return true;
          if (tag === 'div') {
            const cls = ($(el).attr('class') || '').toLowerCase();
            // Skip purely decorative/spacer/modal divs with no headings or text
            if (cls.includes('modal') || cls.includes('spacer')) return false;
            return $(el).find('h1, h2, h3, h4, p, a, article, ul').length > 0;
          }
          return false;
        })
        .toArray()
    : isFramerContainer
    ? sectionContainer
        .children()
        .filter((_, el) => {
          const $el = $(el);
          if ($el.attr('data-framer-name')) return true;
          // Also keep non-empty background/grid/content containers inside Framer page root
          return $el.children().length > 0 || Boolean($el.text().trim());
        })
        .toArray()
    : [];
  const sectionComponents = [];

  if (directSections.length >= 1) {
    directSections.forEach((secNode, idx) => {
      const { baseName, primaryPrefixes, inventory } = inferComponentNameFromSectionNode(
        $,
        secNode,
        idx + 1,
        pageNamePrefix
      );
      let finalName = baseName;
      if (usedNames.has(finalName) && pageNamePrefix && !finalName.startsWith(pageNamePrefix)) {
        finalName = `${pageNamePrefix}${baseName}`;
      }
      let counter = 2;
      while (usedNames.has(finalName)) {
        finalName = `${baseName}${counter++}`;
      }
      usedNames.add(finalName);

      sectionComponents.push({
        name: finalName,
        nodes: [secNode],
        inventory,
        primaryPrefixes,
      });
    });
  }

  const mainId = mainEl.length
    ? mainEl.attr('id') || 'main-content'
    : framerMainEl.length
    ? framerMainEl.attr('id') || 'main'
    : 'main-content';
  const mainClass = mainEl.length
    ? mainEl.attr('class') || ''
    : framerMainEl.length
    ? framerMainEl.attr('class') || ''
    : '';

  const fallbackBodyNodes = body.contents().toArray().filter((n) => {
    if (n.type === 'comment') return false;
    if (n.type === 'text' && !n.data?.trim()) return false;
    return true;
  });

  return {
    navbarComponent,
    footerComponent,
    sectionComponents,
    pageWrapper: {
      hasMain: mainEl.length > 0 || framerMainEl.length > 0,
      wrapperTag,
      mainId,
      mainClass,
      innerWrapperClass,
      innerWrapperStyle,
      innerWrapperCursor,
      framerAppearMap,
      hasArticleWrapper,
      articleClass,
      fallbackBodyNodes,
    },
  };
}

/**
 * Converts a route pathname like `/` or `/research/team/alignment` into a
 * PascalCase React component name (`HomePage`, `ResearchTeamAlignmentPage`).
 */
export function routeToComponentName(routePath) {
  const norm = normalizeRoutePathname(routePath);
  if (norm === '/') return 'HomePage';

  const parts = norm
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join('')
    )
    .filter(Boolean);

  const base = parts.join('') || 'Mirrored';
  const validPrefix = /^[0-9]/.test(base) ? `Page${base}` : base;
  return validPrefix.endsWith('Page') ? validPrefix : `${validPrefix}Page`;
}

/**
 * Computes the relative POSIX path from one HTML file inside `outRoot` to a target
 * relative POSIX path inside `outRoot`. Always starts with `./` or `../`.
 */
export function computeRelativePathFromHtml(htmlRelPosix, targetRelPosix) {
  const fromDir = path.posix.dirname(htmlRelPosix);
  let rel = path.posix.relative(fromDir === '.' ? '' : fromDir, targetRelPosix);
  if (!rel.startsWith('.')) {
    rel = `./${rel}`;
  }
  return rel;
}

/**
 * Serializes a Cheerio document (`$`) into clean, readable, properly indented HTML.
 */
export function formatHtmlDocument($) {
  const INLINE_TAGS = new Set(['span', 'a', 'strong', 'em', 'b', 'i', 'small', 'time', 'code', 'label']);

  function renderHtmlNode(node, depth) {
    const pad = '  '.repeat(depth);

    if (node.type === 'directive') {
      return '';
    }
    if (node.type === 'comment') {
      return '';
    }
    if (node.type === 'text') {
      const raw = node.data || '';
      if (!raw.trim()) return '';
      return raw.replace(/\s+/g, ' ').trim();
    }
    if (node.type !== 'tag' && node.type !== 'style' && node.type !== 'script') {
      return '';
    }

    const tag = node.name;
    const attribs = node.attribs || {};
    const attrList = [];
    for (const [k, v] of Object.entries(attribs)) {
      if (k === 'data-nimg' || k === 'data-precedence') continue;
      if (v === '' && BOOLEAN_ATTRS.has(k.toLowerCase())) {
        attrList.push(k);
      } else {
        attrList.push(`${k}="${String(v).replace(/"/g, '&quot;')}"`);
      }
    }
    const attrStr = attrList.length ? ' ' + attrList.join(' ') : '';

    if (VOID_ELEMENTS.has(tag.toLowerCase())) {
      return `${pad}<${tag}${attrStr} />`;
    }

    const children = (node.children || []).filter((c) => {
      if (c.type === 'comment' || c.type === 'directive') return false;
      if (c.type === 'text' && !c.data?.trim()) {
        // Preserve single space inside inline elements (e.g. `<span class="animate-space"> </span>`)
        return INLINE_TAGS.has(tag) && (c.data || '').includes(' ');
      }
      return true;
    });

    if (children.length === 0) {
      return `${pad}<${tag}${attrStr}></${tag}>`;
    }

    if (children.length === 1 && children[0].type === 'text') {
      const rawText = children[0].data || '';
      if (!rawText.trim() && rawText.includes(' ')) {
        return `${pad}<${tag}${attrStr}> </${tag}>`;
      }
      const text = renderHtmlNode(children[0], 0);
      if (text.length <= 100 || INLINE_TAGS.has(tag)) {
        return `${pad}<${tag}${attrStr}>${text}</${tag}>`;
      }
    }

    const childLines = children
      .map((c) => {
        if (c.type === 'text') {
          const t = renderHtmlNode(c, 0);
          return t ? `${'  '.repeat(depth + 1)}${t}` : '';
        }
        return renderHtmlNode(c, depth + 1);
      })
      .filter(Boolean);

    return `${pad}<${tag}${attrStr}>\n${childLines.join('\n')}\n${pad}</${tag}>`;
  }

  const rootNodes = $.root().contents().toArray();
  const lines = rootNodes.map((n) => renderHtmlNode(n, 0)).filter(Boolean);
  return `<!DOCTYPE html>\n${lines.join('\n')}\n`;
}
