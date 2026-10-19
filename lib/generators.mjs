/**
 * Output Generators for `html`, `react` (Vite + React + TypeScript `.tsx`), and `nextjs` (App Router + TypeScript `.tsx`).
 *
 * All 3 modes purge unused CSS rules and split active CSS into `globals.css` +
 * per-component stylesheets (`components/<Name>/<Name>.tsx` + `<Name>.css`).
 */
import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  cleanAndRewritePageDom,
  nodesToJsx,
  normalizeRoutePathname,
  extractPageComponents,
  routeToComponentName,
  computeRelativePathFromHtml,
  styleStringToJsxObjectLiteral,
  formatHtmlDocument,
} from './jsx-compiler.mjs';
import { collectDomInventory, splitAndPurgeCss } from './css-splitter.mjs';

async function writeTextFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

function cleanedPagesCountPrefix(totalPages, pagePrefix) {
  if (totalPages <= 1) return '';
  return pagePrefix || '';
}

function mergeInventories(inventories) {
  const classes = new Set();
  const ids = new Set();
  const tags = new Set();
  const modulePrefixes = new Set();

  for (const inv of inventories) {
    for (const c of inv.classes) classes.add(c);
    for (const id of inv.ids) ids.add(id);
    for (const t of inv.tags) tags.add(t);
    for (const p of inv.modulePrefixes) modulePrefixes.add(p);
  }

  return { classes, ids, tags, modulePrefixes };
}

/**
 * Maps a URL pathname to a relative HTML path inside `outRoot` for `html` mode.
 * In singlePage mode (or for the root/start page), the primary page is placed directly
 * at `index.html` so the user can immediately double-click `index.html` at the root!
 */
function htmlFileRelPosixForPage(pageUrl, index, isSinglePage) {
  if (isSinglePage || index === 0) {
    const p = normalizeRoutePathname(pageUrl.pathname);
    if (isSinglePage || p === '/') {
      return 'index.html';
    }
  }

  const norm = normalizeRoutePathname(pageUrl.pathname);
  if (norm === '/') return 'index.html';

  const clean = norm.slice(1);
  if (clean.endsWith('.html')) return clean;
  return `${clean}/index.html`;
}

/**
 * Generates Clean Vanilla HTML / CSS / JS (`--format html`)
 * Zero-server ready: works via double-click (`file://`) and any static server.
 * Purges dead CSS and splits component CSS into `css/globals.css` + `css/components/<Component>.css`.
 */
export async function generateHtmlOutput({
  outRoot,
  pages,
  assetStore,
  startOrigin,
  singlePage,
}) {
  const routeToHtmlRel = new Map();
  pages.forEach((p, idx) => {
    const route = normalizeRoutePathname(p.pageUrl.pathname);
    const rel = htmlFileRelPosixForPage(p.pageUrl, idx, singlePage);
    routeToHtmlRel.set(route, rel);
  });

  const processedPages = [];
  const allPageInventories = [];
  const allExtractedComponents = [];
  const usedComponentNames = new Set(['Navbar', 'Footer']);

  for (let i = 0; i < pages.length; i++) {
    const { pageUrl, rawHtml } = pages[i];
    const htmlRelPosix = htmlFileRelPosixForPage(pageUrl, i, singlePage);

    const { $ } = await cleanAndRewritePageDom({
      rawHtml,
      pageUrl,
      startOrigin,
      assetStore,
      assetUrlFormatter: (assetRelPosix) => computeRelativePathFromHtml(htmlRelPosix, assetRelPosix),
      linkUrlFormatter: (rawHref, currentUrl) => {
        if (
          !rawHref ||
          rawHref.startsWith('#') ||
          rawHref.startsWith('mailto:') ||
          rawHref.startsWith('tel:') ||
          rawHref.startsWith('javascript:')
        ) {
          return rawHref;
        }
        try {
          const normalized = rawHref.startsWith('//') ? `https:${rawHref}` : rawHref;
          const u = new URL(normalized, currentUrl.toString());
          if (u.origin === startOrigin) {
            const targetRoute = normalizeRoutePathname(u.pathname);
            if (routeToHtmlRel.has(targetRoute)) {
              const targetHtmlRel = routeToHtmlRel.get(targetRoute);
              return computeRelativePathFromHtml(htmlRelPosix, targetHtmlRel) + (u.hash || '');
            }
            return u.toString();
          }
          return u.toString();
        } catch {
          return rawHref;
        }
      },
    });

    allPageInventories.push(collectDomInventory($));

    const { pagePrefix, extracted } = {
      pagePrefix: routeToComponentName(pageUrl.pathname).replace(/Page$/, ''),
      extracted: extractPageComponents(
        cheerio.load($.html(), { decodeEntities: false }),
        usedComponentNames,
        cleanedPagesCountPrefix(pages.length, routeToComponentName(pageUrl.pathname).replace(/Page$/, ''))
      ),
    };
    const existingNavbar = allExtractedComponents.find((c) => c.name === 'Navbar');
    if (!existingNavbar && extracted.navbarComponent) {
      allExtractedComponents.push(extracted.navbarComponent);
    } else if (existingNavbar && extracted.navbarComponent) {
      existingNavbar.inventory = mergeInventories([existingNavbar.inventory, extracted.navbarComponent.inventory]);
      for (const p of extracted.navbarComponent.primaryPrefixes) existingNavbar.primaryPrefixes.add(p);
    }
    for (const sec of extracted.sectionComponents) allExtractedComponents.push(sec);
    const existingFooter = allExtractedComponents.find((c) => c.name === 'Footer');
    if (!existingFooter && extracted.footerComponent) {
      allExtractedComponents.push(extracted.footerComponent);
    } else if (existingFooter && extracted.footerComponent) {
      existingFooter.inventory = mergeInventories([existingFooter.inventory, extracted.footerComponent.inventory]);
      for (const p of extracted.footerComponent.primaryPrefixes) existingFooter.primaryPrefixes.add(p);
    }

    processedPages.push({ $, htmlRelPosix });
  }

  // Build consolidated CSS (paths relative to `css/` or `css/components/`)
  const rawConsolidatedCss = await assetStore.buildConsolidatedCss((assetRelPosix) => `../${assetRelPosix}`);
  const globalInventory = mergeInventories(allPageInventories);
  const { globalCss, componentCssMap, stats } = splitAndPurgeCss({
    rawConsolidatedCss,
    globalInventory,
    components: allExtractedComponents,
  });

  const scrollLottieTransitionCss = `
/* Scroll-driven header SVG / Lottie transition rules */
.mirror-navbar-root {
  position: sticky;
  top: 0;
  z-index: 9999;
}
[data-scroll-lottie="true"] [data-scroll-transform],
[data-scroll-lottie="true"] [data-scroll-opacity] {
  transition: transform 0.42s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.32s cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform, opacity;
}
`;

  await writeTextFile(path.join(outRoot, 'css', 'globals.css'), globalCss + '\n' + scrollLottieTransitionCss);

  const writtenComponentCssFiles = [];
  for (const [compName, cssText] of componentCssMap.entries()) {
    if (!cssText.trim()) continue;
    // Inside `css/components/<Name>.css`, asset paths `../assets/...` need one extra `../`
    const adjustedCss = cssText.replace(/url\("\.\.\/assets\//g, 'url("../../assets/');
    const relPosix = `css/components/${compName}.css`;
    await writeTextFile(path.join(outRoot, 'css', 'components', `${compName}.css`), adjustedCss + '\n');
    writtenComponentCssFiles.push({ compName, relPosix });
  }

  // Write clean helper JS (`js/main.js`)
  const helperJs = `/**
 * Mirrored Site Interactive Helper
 * Provides lightweight UI enhancements (scroll-driven Lottie/SVG header animations, dropdown menus, search filtering)
 * without requiring the original framework runtime bundles.
 */
document.addEventListener('DOMContentLoaded', () => {
  // 1. Live search filtering inside publication / table lists
  const searchInputs = document.querySelectorAll('input[type="text"][placeholder*="Search" i], input[type="search"]');
  searchInputs.forEach((input) => {
    input.addEventListener('input', (e) => {
      const query = (e.target.value || '').toLowerCase().trim();
      const section = input.closest('section') || document;
      const items = section.querySelectorAll('ul > li');
      items.forEach((li) => {
        const text = (li.textContent || '').toLowerCase();
        li.style.display = !query || text.includes(query) ? '' : 'none';
      });
    });
  });

  // 2. Scroll-driven header SVG / Lottie morph (e.g. ANTHROP\\C -> A\\ on scroll)
  let lastScrolledState = null;
  function syncScrollAnimations() {
    const isScrolled = window.scrollY > 24;
    if (isScrolled === lastScrolledState) return;
    lastScrolledState = isScrolled;

    document.querySelectorAll('[data-scroll-lottie="true"]').forEach((container) => {
      container.querySelectorAll('[data-scroll-transform]').forEach((el) => {
        const nextTransform = isScrolled
          ? el.getAttribute('data-scroll-transform')
          : el.getAttribute('data-top-transform');
        if (nextTransform) {
          el.setAttribute('transform', nextTransform);
          el.style.transform = nextTransform;
        }
      });
      container.querySelectorAll('[data-scroll-opacity]').forEach((el) => {
        const nextOpacity = isScrolled
          ? el.getAttribute('data-scroll-opacity')
          : el.getAttribute('data-top-opacity');
        if (nextOpacity !== null) {
          el.setAttribute('opacity', nextOpacity);
          el.style.opacity = nextOpacity;
        }
      });
    });
  }
  window.addEventListener('scroll', syncScrollAnimations, { passive: true });
  syncScrollAnimations();

  // 3. Interactive header dropdowns (both ARIA menu buttons & Webflow .w-dropdown)
  function closeAllDropdowns(exceptEl) {
    document.querySelectorAll('[data-mirror-dropdown="true"]').forEach((menu) => {
      if (menu !== exceptEl) menu.style.display = 'none';
    });
    document.querySelectorAll('button[aria-haspopup="menu"]').forEach((btn) => {
      const target = btn.getAttribute('aria-controls') ? document.getElementById(btn.getAttribute('aria-controls')) : null;
      if (target !== exceptEl) btn.setAttribute('aria-expanded', 'false');
    });
    document.querySelectorAll('.w-dropdown-toggle.w--open, .w-dropdown-list.w--open').forEach((el) => {
      if (!exceptEl || !el.closest('.w-dropdown')?.contains(exceptEl)) {
        el.classList.remove('w--open');
        if (el.classList.contains('w-dropdown-list')) el.style.display = '';
      }
    });
  }

  document.addEventListener('click', (e) => {
    const menuBtn = e.target.closest('button[aria-haspopup="menu"], [class*="claudeCtaDropdownTrigger"]');
    if (menuBtn) {
      e.stopPropagation();
      const controlsId = menuBtn.getAttribute('aria-controls');
      const menu = (controlsId && document.getElementById(controlsId)) ||
        menuBtn.parentElement?.querySelector('[data-mirror-dropdown="true"], [id*="dropdown"]');
      if (menu) {
        const isOpen = menu.style.display !== 'none' && menu.style.display !== '';
        closeAllDropdowns(menu);
        menu.style.display = isOpen ? 'none' : 'block';
        menuBtn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
        return;
      }
    }

    const wfToggle = e.target.closest('.w-dropdown-toggle');
    if (wfToggle) {
      e.stopPropagation();
      const wrap = wfToggle.closest('.w-dropdown');
      const list = wrap?.querySelector('.w-dropdown-list');
      if (list) {
        const isOpen = list.classList.contains('w--open');
        closeAllDropdowns(list);
        wfToggle.classList.toggle('w--open', !isOpen);
        list.classList.toggle('w--open', !isOpen);
        list.style.display = !isOpen ? 'block' : '';
        return;
      }
    }

    if (!e.target.closest('[data-mirror-dropdown="true"], .w-dropdown-list')) {
      closeAllDropdowns(null);
    }
  });

  // 4. Hydrate <canvas data-canvas-fallback="..."> elements and run any preserved section widget scripts
  document.querySelectorAll('canvas[data-canvas-fallback]').forEach((canvas) => {
    const src = canvas.getAttribute('data-canvas-fallback');
    if (!src) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = src;
  });

  document.querySelectorAll('[data-mirror-widget-script]').forEach((holder) => {
    if (holder.getAttribute('data-widget-initialized') === 'true') return;
    holder.setAttribute('data-widget-initialized', 'true');
    try {
      const rawCode = decodeURIComponent(holder.getAttribute('data-mirror-widget-script') || '');
      if (!rawCode) return;
      // Reset any pre-rendered .moo-sq/.moo-line/.moo-screen elements so the widget engine can initialize cleanly
      const sec = holder.closest('section');
      if (sec && sec.classList.contains('vaquita-cta_section')) {
        sec.querySelectorAll('.moo-sq, .moo-line, .moo-screen').forEach((n) => n.remove());
        const title = sec.querySelector('.big-cta_title');
        if (title && title.querySelector('.moo-src')) {
          title.innerHTML = '<span class="wordmark">:Claude:</span> Haiku 5.5';
        }
      }
      const fn = new Function(rawCode);
      fn();
    } catch {}
  });

  // 5. Replay Framer appear animations (from data-framer-appear-map) and enable draggable Framer stickers
  function buildFramerTransform(state, template) {
    if (!state) return '';
    const parts = [];
    if (state.x || state.y) parts.push(\`translate(\${state.x || 0}px, \${state.y || 0}px)\`);
    if (state.scale !== undefined && state.scale !== 1) parts.push(\`scale(\${state.scale})\`);
    if (state.rotate) parts.push(\`rotate(\${state.rotate}deg)\`);
    if (state.rotateX) parts.push(\`rotateX(\${state.rotateX}deg)\`);
    if (state.rotateY) parts.push(\`rotateY(\${state.rotateY}deg)\`);
    if (state.skewX) parts.push(\`skewX(\${state.skewX}deg)\`);
    if (state.skewY) parts.push(\`skewY(\${state.skewY}deg)\`);
    const animStr = parts.join(' ');
    if (template && template.includes('__Appear_Animation_Transform__')) {
      return template.replace('__Appear_Animation_Transform__', animStr).trim();
    }
    return animStr || 'none';
  }

  const appearHolder = document.querySelector('[data-framer-appear-map]');
  if (appearHolder) {
    try {
      const map = JSON.parse(decodeURIComponent(appearHolder.getAttribute('data-framer-appear-map') || '{}'));
      document.querySelectorAll('[data-framer-appear-id]').forEach((el) => {
        const id = el.getAttribute('data-framer-appear-id');
        const entry = id && map[id] && map[id].default;
        if (!entry || !entry.initial || !entry.animate) return;
        const t = entry.animate.transition || {};
        const dur = t.duration || 0.4;
        const delay = t.delay || 0;
        const ease = t.type === 'spring'
          ? 'cubic-bezier(0.34, 1.56, 0.64, 1)'
          : Array.isArray(t.ease)
          ? \`cubic-bezier(\${t.ease.join(',')})\`
          : 'cubic-bezier(0.22, 1, 0.36, 1)';
        const finalOpacity = entry.animate.opacity !== undefined ? String(entry.animate.opacity) : '1';
        const finalTransform = buildFramerTransform(entry.animate, entry.transformTemplate);
        el.style.transition = 'none';
        if (entry.initial.opacity !== undefined) el.style.opacity = String(entry.initial.opacity);
        el.style.transform = buildFramerTransform(entry.initial, entry.transformTemplate);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            el.style.transition = \`opacity \${dur}s \${ease} \${delay}s, transform \${dur}s \${ease} \${delay}s\`;
            el.style.opacity = finalOpacity;
            el.style.transform = finalTransform;
          });
        });
      });
    } catch {}
  }

  // Enable interactive drag on Framer sticker elements (touch-action: none; user-select: none)
  document.querySelectorAll('[data-framer-name][style*="touch-action: none"], [data-framer-name][style*="touch-action:none"]').forEach((sticker) => {
    if (sticker.getAttribute('data-drag-bound') === 'true') return;
    sticker.setAttribute('data-drag-bound', 'true');
    sticker.style.cursor = 'grab';
    let dragging = false;
    let startX = 0, startY = 0, offsetX = 0, offsetY = 0;
    sticker.addEventListener('pointerdown', (e) => {
      dragging = true;
      startX = e.clientX - offsetX;
      startY = e.clientY - offsetY;
      sticker.style.cursor = 'grabbing';
      sticker.style.transition = 'none';
      sticker.style.zIndex = '50';
      sticker.setPointerCapture?.(e.pointerId);
    });
    sticker.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      offsetX = e.clientX - startX;
      offsetY = e.clientY - startY;
      sticker.style.transform = \`translate(\${offsetX}px, \${offsetY}px) scale(1.06)\`;
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      sticker.style.cursor = 'grab';
      sticker.style.transition = 'transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)';
      sticker.style.transform = \`translate(\${offsetX}px, \${offsetY}px) scale(1)\`;
    };
    sticker.addEventListener('pointerup', endDrag);
    sticker.addEventListener('pointercancel', endDrag);
  });

  // 6. Custom Mouse Cursor follower (#mirror-cursor-bank + [data-framer-cursor])
  const cursorBank = document.getElementById('mirror-cursor-bank');
  if (cursorBank) {
    const variants = Array.from(cursorBank.querySelectorAll('[data-mirror-cursor-variant]'));
    const defaultVariant =
      cursorBank.querySelector('[data-mirror-cursor-default="true"]') || variants[0] || null;

    if (variants.length > 0 && window.matchMedia('(pointer: fine)').matches) {
      const handleCursorMove = (e) => {
        const target = e.target && e.target.closest ? e.target : null;
        const cursorZone = target ? target.closest('[data-framer-cursor]') : null;
        const cid = cursorZone ? cursorZone.getAttribute('data-framer-cursor') : null;
        const activeEl =
          (cid && cursorBank.querySelector(\`[data-mirror-cursor-variant="\${cid}"]\`)) || defaultVariant;

        variants.forEach((v) => {
          if (v === activeEl) {
            v.style.display = '';
            v.style.opacity = '1';
            v.style.transform = \`translate(-50%, -50%) translate3d(\${e.clientX}px, \${e.clientY}px, 0px)\`;
            const isCardLink = Boolean(target && target.closest('a[href*="/"], a[href*=".html"]'));
            const isRecommend = v.classList.contains('framer-v-rsy4vm');
            if (v.classList.contains('framer-16c1ymk')) {
              v.style.overflow = isCardLink || isRecommend ? 'visible' : 'clip';
            }
          } else {
            v.style.opacity = '0';
            v.style.display = 'none';
          }
        });
      };

      window.addEventListener('pointermove', handleCursorMove, { passive: true });
      document.addEventListener('mouseleave', () => {
        variants.forEach((v) => {
          v.style.opacity = '0';
          v.style.display = 'none';
        });
      });
    }
  }
});
`;
  await writeTextFile(path.join(outRoot, 'js', 'main.js'), helperJs);

  for (const { $, htmlRelPosix } of processedPages) {
    const globalsHref = computeRelativePathFromHtml(htmlRelPosix, 'css/globals.css');
    $('head').append(`<link rel="stylesheet" href="${globalsHref}" />`);

    for (const { relPosix } of writtenComponentCssFiles) {
      const compCssHref = computeRelativePathFromHtml(htmlRelPosix, relPosix);
      $('head').append(`<link rel="stylesheet" href="${compCssHref}" />`);
    }

    const jsSrc = computeRelativePathFromHtml(htmlRelPosix, 'js/main.js');
    $('body').append(`<script src="${jsSrc}" defer></script>`);

    const finalHtml = formatHtmlDocument($);
    const destPath = path.join(outRoot, ...htmlRelPosix.split('/'));
    await writeTextFile(destPath, finalHtml);
  }

  const writtenAssets = await assetStore.writeAssetsToDisk(outRoot);
  return {
    writtenAssets,
    componentCount: writtenComponentCssFiles.length,
    cssStats: stats,
  };
}

/**
 * Shared helper for React and Next.js:
 * Cleans pages, extracts modular components (`Navbar`, `Footer`, and page `<section>` components),
 * purges dead CSS, and splits active CSS into `globals.css` + co-located `<Component>.css`.
 */
async function prepareComponentizedPages({
  pages,
  assetStore,
  startOrigin,
  mirroredRoutes,
}) {
  const cleanedPages = [];
  const allPageInventories = [];

  for (const p of pages) {
    const { $, metadata } = await cleanAndRewritePageDom({
      rawHtml: p.rawHtml,
      pageUrl: p.pageUrl,
      startOrigin,
      assetStore,
      assetUrlFormatter: (assetRelPosix) => `/${assetRelPosix}`,
      linkUrlFormatter: (rawHref, currentUrl) => {
        if (
          !rawHref ||
          rawHref.startsWith('#') ||
          rawHref.startsWith('mailto:') ||
          rawHref.startsWith('tel:') ||
          rawHref.startsWith('javascript:')
        ) {
          return rawHref;
        }
        try {
          const normalized = rawHref.startsWith('//') ? `https:${rawHref}` : rawHref;
          const u = new URL(normalized, currentUrl.toString());
          if (u.origin === startOrigin) {
            const route = normalizeRoutePathname(u.pathname);
            if (mirroredRoutes.has(route)) {
              return `${route}${u.search}${u.hash}`;
            }
            return u.toString();
          }
          return u.toString();
        } catch {
          return rawHref;
        }
      },
    });

    allPageInventories.push(collectDomInventory($));
    cleanedPages.push({ pageUrl: p.pageUrl, $, metadata });
  }

  const globalInventory = mergeInventories(allPageInventories);
  const usedComponentNames = new Set(['Navbar', 'Footer']);

  let sharedNavbar = null;
  let sharedFooter = null;
  const pageDecompositions = [];
  const allComponentsForCss = [];

  for (let i = 0; i < cleanedPages.length; i++) {
    const item = cleanedPages[i];
    const pagePrefix = routeToComponentName(item.pageUrl.pathname).replace(/Page$/, '');
    const extracted = extractPageComponents(
      item.$,
      usedComponentNames,
      cleanedPagesCountPrefix(cleanedPages.length, pagePrefix)
    );

    if (!sharedNavbar && extracted.navbarComponent) {
      sharedNavbar = extracted.navbarComponent;
      sharedNavbar.wrapperClass = extracted.pageWrapper.innerWrapperClass || '';
      allComponentsForCss.push(sharedNavbar);
    } else if (sharedNavbar && extracted.navbarComponent) {
      // Prefer a semantic `<header>` Navbar over a `.nav_component` div if encountered on a subpage,
      // and always merge inventory + prefixes so both navbar variants retain their CSS!
      sharedNavbar.inventory = mergeInventories([sharedNavbar.inventory, extracted.navbarComponent.inventory]);
      for (const p of extracted.navbarComponent.primaryPrefixes) {
        sharedNavbar.primaryPrefixes.add(p);
      }
      const currentIsHeaderTag = sharedNavbar.nodes[0]?.name === 'header';
      const nextIsHeaderTag = extracted.navbarComponent.nodes[0]?.name === 'header';
      if (!currentIsHeaderTag && nextIsHeaderTag) {
        sharedNavbar.nodes = extracted.navbarComponent.nodes;
        sharedNavbar.wrapperClass = extracted.pageWrapper.innerWrapperClass || '';
      }
    }

    if (!sharedFooter && extracted.footerComponent) {
      sharedFooter = extracted.footerComponent;
      sharedFooter.wrapperClass = extracted.pageWrapper.innerWrapperClass || '';
      allComponentsForCss.push(sharedFooter);
    } else if (sharedFooter && extracted.footerComponent) {
      sharedFooter.inventory = mergeInventories([sharedFooter.inventory, extracted.footerComponent.inventory]);
      for (const p of extracted.footerComponent.primaryPrefixes) {
        sharedFooter.primaryPrefixes.add(p);
      }
    }

    for (const sec of extracted.sectionComponents) {
      allComponentsForCss.push(sec);
    }

    pageDecompositions.push({
      pageUrl: item.pageUrl,
      metadata: item.metadata,
      sectionComponents: extracted.sectionComponents,
      pageWrapper: extracted.pageWrapper,
    });
  }

  // Merge htmlClass, htmlStyle, bodyClass, bodyStyle across all pages so font variables and layout tokens from every crawled page are active
  const mergedHtmlClasses = new Set();
  const mergedHtmlStyles = new Set();
  const mergedBodyClasses = new Set();
  const mergedBodyStyles = new Set();

  for (const cp of cleanedPages) {
    if (cp.metadata.htmlClass) {
      for (const c of cp.metadata.htmlClass.split(/\s+/)) if (c) mergedHtmlClasses.add(c);
    }
    if (cp.metadata.htmlStyle) {
      for (const s of cp.metadata.htmlStyle.split(';')) if (s.trim()) mergedHtmlStyles.add(s.trim());
    }
    if (cp.metadata.bodyClass) {
      for (const c of cp.metadata.bodyClass.split(/\s+/)) if (c) mergedBodyClasses.add(c);
    }
    if (cp.metadata.bodyStyle) {
      for (const s of cp.metadata.bodyStyle.split(';')) if (s.trim()) mergedBodyStyles.add(s.trim());
    }
  }

  if (pageDecompositions.length > 0) {
    pageDecompositions[0].metadata.htmlClass = [...mergedHtmlClasses].join(' ');
    pageDecompositions[0].metadata.htmlStyle = [...mergedHtmlStyles].join('; ');
    pageDecompositions[0].metadata.bodyClass = [...mergedBodyClasses].join(' ');
    pageDecompositions[0].metadata.bodyStyle = [...mergedBodyStyles].join('; ');
  }

  const rawConsolidatedCss = await assetStore.buildConsolidatedCss((assetRelPosix) => `/${assetRelPosix}`);
  const { globalCss, componentCssMap, stats } = splitAndPurgeCss({
    rawConsolidatedCss,
    globalInventory,
    components: allComponentsForCss,
  });

  return {
    sharedNavbar,
    sharedFooter,
    pageDecompositions,
    allComponents: allComponentsForCss,
    globalCss,
    componentCssMap,
    cssStats: stats,
  };
}

/**
 * Writes each component to `src/components/<Name>/<Name>.tsx` and `src/components/<Name>/<Name>.css`.
 */
async function writeModularComponents({
  outRoot,
  allComponents,
  componentCssMap,
  routerMode,
  mirroredRoutes,
}) {
  for (const comp of allComponents) {
    const compDir = path.join(outRoot, 'src', 'components', comp.name);
    const cssContent = (componentCssMap.get(comp.name) || '').trim();

    const { jsx, usesRouterLink } = nodesToJsx(comp.nodes, {
      routerMode,
      mirroredRoutes,
      indentLevel: comp.nodes.length > 1 || comp.name === 'Navbar' ? 3 : 2,
    });

    const isInteractiveNavbar = comp.name === 'Navbar';
    const hasCanvasOrWidget =
      !isInteractiveNavbar &&
      (jsx.includes('<canvas') || jsx.includes('data-mirror-widget-script'));
    const needsClientEffect = isInteractiveNavbar || hasCanvasOrWidget;

    const imports = [];
    if (needsClientEffect && routerMode === 'nextjs') {
      imports.push(`'use client';\n`);
    }
    if (needsClientEffect) {
      imports.push(`import { useEffect, useRef } from 'react';`);
    }
    if (jsx.includes('React.CSSProperties')) {
      imports.push(`import type React from 'react';`);
    }
    if (usesRouterLink) {
      if (routerMode === 'react') {
        imports.push(`import { Link } from 'react-router-dom';`);
      } else if (routerMode === 'nextjs') {
        imports.push(`import Link from 'next/link';`);
      }
    }
    imports.push(`import './${comp.name}.css';`);

    let tsxCode;
    if (isInteractiveNavbar) {
      tsxCode = `${imports.join('\n')}

export default function ${comp.name}() {
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = navRef.current;
    if (!root) return;

    const closeAll = (exceptEl: Element | null) => {
      root.querySelectorAll<HTMLElement>('[data-mirror-dropdown="true"]').forEach((menu) => {
        if (menu !== exceptEl) menu.style.display = 'none';
      });
      root.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]').forEach((btn) => {
        const cid = btn.getAttribute('aria-controls');
        const target = cid ? document.getElementById(cid) : null;
        if (target !== exceptEl) btn.setAttribute('aria-expanded', 'false');
      });
      root.querySelectorAll<HTMLElement>('.w-dropdown-toggle.w--open, .w-dropdown-list.w--open').forEach((el) => {
        if (!exceptEl || !el.closest('.w-dropdown')?.contains(exceptEl)) {
          el.classList.remove('w--open');
          if (el.classList.contains('w-dropdown-list')) el.style.display = '';
        }
      });
    };

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const menuBtn = target.closest<HTMLElement>('button[aria-haspopup="menu"], [class*="claudeCtaDropdownTrigger"]');
      if (menuBtn && root.contains(menuBtn)) {
        e.stopPropagation();
        const cid = menuBtn.getAttribute('aria-controls');
        const menu = (cid ? document.getElementById(cid) : null) ||
          menuBtn.parentElement?.querySelector<HTMLElement>('[data-mirror-dropdown="true"], [id*="dropdown"]');
        if (menu) {
          const isOpen = menu.style.display !== 'none' && menu.style.display !== '';
          closeAll(menu);
          menu.style.display = isOpen ? 'none' : 'block';
          menuBtn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
          return;
        }
      }

      const wfToggle = target.closest<HTMLElement>('.w-dropdown-toggle');
      if (wfToggle && root.contains(wfToggle)) {
        e.stopPropagation();
        const wrap = wfToggle.closest('.w-dropdown');
        const list = wrap?.querySelector<HTMLElement>('.w-dropdown-list');
        if (list) {
          const isOpen = list.classList.contains('w--open');
          closeAll(list);
          wfToggle.classList.toggle('w--open', !isOpen);
          list.classList.toggle('w--open', !isOpen);
          list.style.display = !isOpen ? 'block' : '';
          return;
        }
      }

      if (!target.closest('[data-mirror-dropdown="true"], .w-dropdown-list')) {
        closeAll(null);
      }

      // Smooth scroll when clicking an anchor link with a #hash on the same page (e.g. /#work)
      const anchor = target.closest<HTMLAnchorElement>('a[href*="#"]');
      if (anchor) {
        const rawHref = anchor.getAttribute('href') || '';
        const hashIdx = rawHref.indexOf('#');
        if (hashIdx !== -1) {
          const hashId = rawHref.slice(hashIdx + 1);
          const targetEl = hashId ? document.getElementById(hashId) : null;
          if (targetEl) {
            setTimeout(() => targetEl.scrollIntoView({ behavior: 'smooth' }), 30);
          }
        }
      }
    };

    // Scroll-driven header SVG / Lottie morph (e.g. ANTHROP\\C -> A\\ on scroll)
    let lastScrolledState: boolean | null = null;
    const handleScroll = () => {
      const isScrolled = window.scrollY > 24;
      if (isScrolled === lastScrolledState) return;
      lastScrolledState = isScrolled;

      root.querySelectorAll<HTMLElement>('[data-scroll-lottie="true"]').forEach((container) => {
        container.querySelectorAll<SVGElement>('[data-scroll-transform]').forEach((el) => {
          const nextTransform = isScrolled
            ? el.getAttribute('data-scroll-transform')
            : el.getAttribute('data-top-transform');
          if (nextTransform) {
            el.setAttribute('transform', nextTransform);
            el.style.transform = nextTransform;
          }
        });
        container.querySelectorAll<SVGElement>('[data-scroll-opacity]').forEach((el) => {
          const nextOpacity = isScrolled
            ? el.getAttribute('data-scroll-opacity')
            : el.getAttribute('data-top-opacity');
          if (nextOpacity !== null) {
            el.setAttribute('opacity', nextOpacity);
            el.style.opacity = nextOpacity;
          }
        });
      });
    };

    document.addEventListener('click', handleClick);
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    // 5. Replay Framer appear animations (data-framer-appear-map) & bind draggable Framer stickers
    const buildFramerTransform = (state: Record<string, any> | undefined, template?: string) => {
      if (!state) return '';
      const parts: string[] = [];
      if (state.x || state.y) parts.push(\`translate(\${state.x || 0}px, \${state.y || 0}px)\`);
      if (state.scale !== undefined && state.scale !== 1) parts.push(\`scale(\${state.scale})\`);
      if (state.rotate) parts.push(\`rotate(\${state.rotate}deg)\`);
      if (state.rotateX) parts.push(\`rotateX(\${state.rotateX}deg)\`);
      if (state.rotateY) parts.push(\`rotateY(\${state.rotateY}deg)\`);
      if (state.skewX) parts.push(\`skewX(\${state.skewX}deg)\`);
      if (state.skewY) parts.push(\`skewY(\${state.skewY}deg)\`);
      const animStr = parts.join(' ');
      if (template && template.includes('__Appear_Animation_Transform__')) {
        return template.replace('__Appear_Animation_Transform__', animStr).trim();
      }
      return animStr || 'none';
    };

    let appearHolderScrolled = false;
    const initFramerInteractions = () => {
      // Sync active Navbar item highlight (framer-v-1i0z1kh vs framer-v-irdafi) on route change
      const curPath = window.location.pathname.replace(/\\/+$/, '') || '/';
      const curHash = window.location.hash || '';
      root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
        const pill = a.querySelector<HTMLElement>('.framer-SmDFt');
        const textWrap = a.querySelector<HTMLElement>('.framer-1r82meg');
        if (!pill || !textWrap) return;
        const rawHref = a.getAttribute('href') || '';
        const [hrefPathRaw, hrefHashRaw] = rawHref.split('#');
        const hrefPath = (hrefPathRaw || '/').replace(/\\/+$/, '') || '/';
        const hrefHash = hrefHashRaw ? \`#\${hrefHashRaw}\` : '';
        const isSelected = hrefHash
          ? curPath === hrefPath && curHash === hrefHash
          : curPath === hrefPath && !curHash;
        if (isSelected) {
          a.setAttribute('data-framer-page-link-current', 'true');
          pill.classList.remove('framer-v-irdafi');
          pill.classList.add('framer-v-1i0z1kh');
          pill.setAttribute('data-framer-name', 'Selected');
          textWrap.style.setProperty(
            '--extracted-r6o4lv',
            'var(--token-76c6d1b1-5fc7-42aa-9874-dbfda4135fa2, rgb(250, 249, 247))'
          );
        } else {
          a.removeAttribute('data-framer-page-link-current');
          pill.classList.remove('framer-v-1i0z1kh');
          pill.classList.add('framer-v-irdafi');
          pill.setAttribute('data-framer-name', 'Default');
          textWrap.style.setProperty(
            '--extracted-r6o4lv',
            'var(--token-3e95da8c-588c-40f4-8bc4-3d35bff130c0, rgb(102, 102, 102))'
          );
        }
      });

      // Smooth scroll to hash target (e.g. /#work) when present
      if (window.location.hash) {
        const targetEl = document.getElementById(window.location.hash.slice(1));
        if (targetEl && !appearHolderScrolled) {
          appearHolderScrolled = true;
          setTimeout(() => targetEl.scrollIntoView({ behavior: 'smooth' }), 60);
        }
      } else {
        appearHolderScrolled = false;
      }

      const appearHolder = document.querySelector<HTMLElement>('[data-framer-appear-map]');
      if (appearHolder && appearHolder.getAttribute('data-appear-ran') !== 'true') {
        appearHolder.setAttribute('data-appear-ran', 'true');
        try {
          const map = JSON.parse(decodeURIComponent(appearHolder.getAttribute('data-framer-appear-map') || '{}'));
          document.querySelectorAll<HTMLElement>('[data-framer-appear-id]').forEach((el) => {
            const id = el.getAttribute('data-framer-appear-id');
            const entry = id && map[id] && map[id].default;
            if (!entry || !entry.initial || !entry.animate) return;
            const t = entry.animate.transition || {};
            const dur = t.duration || 0.4;
            const delay = t.delay || 0;
            const ease = t.type === 'spring'
              ? 'cubic-bezier(0.34, 1.56, 0.64, 1)'
              : Array.isArray(t.ease)
              ? \`cubic-bezier(\${t.ease.join(',')})\`
              : 'cubic-bezier(0.22, 1, 0.36, 1)';
            const finalOpacity = entry.animate.opacity !== undefined ? String(entry.animate.opacity) : '1';
            const finalTransform = buildFramerTransform(entry.animate, entry.transformTemplate);
            el.style.transition = 'none';
            if (entry.initial.opacity !== undefined) el.style.opacity = String(entry.initial.opacity);
            el.style.transform = buildFramerTransform(entry.initial, entry.transformTemplate);
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                el.style.transition = \`opacity \${dur}s \${ease} \${delay}s, transform \${dur}s \${ease} \${delay}s\`;
                el.style.opacity = finalOpacity;
                el.style.transform = finalTransform;
              });
            });
          });
        } catch {}
      }

      document
        .querySelectorAll<HTMLElement>('[data-framer-name][style*="touch-action: none"], [data-framer-name][style*="touch-action:none"]')
        .forEach((sticker) => {
          if (sticker.getAttribute('data-drag-bound') === 'true') return;
          sticker.setAttribute('data-drag-bound', 'true');
          sticker.style.cursor = 'grab';
          let dragging = false;
          let startX = 0, startY = 0, offsetX = 0, offsetY = 0;
          sticker.addEventListener('pointerdown', (e: PointerEvent) => {
            dragging = true;
            startX = e.clientX - offsetX;
            startY = e.clientY - offsetY;
            sticker.style.cursor = 'grabbing';
            sticker.style.transition = 'none';
            sticker.style.zIndex = '50';
            sticker.setPointerCapture?.(e.pointerId);
          });
          sticker.addEventListener('pointermove', (e: PointerEvent) => {
            if (!dragging) return;
            offsetX = e.clientX - startX;
            offsetY = e.clientY - startY;
            sticker.style.transform = \`translate(\${offsetX}px, \${offsetY}px) scale(1.06)\`;
          });
          const endDrag = () => {
            if (!dragging) return;
            dragging = false;
            sticker.style.cursor = 'grab';
            sticker.style.transition = 'transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)';
            sticker.style.transform = \`translate(\${offsetX}px, \${offsetY}px) scale(1)\`;
          };
          sticker.addEventListener('pointerup', endDrag);
          sticker.addEventListener('pointercancel', endDrag);
        });
    };

    initFramerInteractions();
    const observer = new MutationObserver(() => initFramerInteractions());
    observer.observe(document.body, { childList: true, subtree: true });

    // Custom Mouse Cursor follower (#mirror-cursor-bank + [data-framer-cursor])
    const cursorBank = document.getElementById('mirror-cursor-bank');
    const variants = cursorBank
      ? Array.from(cursorBank.querySelectorAll<HTMLElement>('[data-mirror-cursor-variant]'))
      : [];
    const defaultVariant =
      (cursorBank && cursorBank.querySelector<HTMLElement>('[data-mirror-cursor-default="true"]')) ||
      variants[0] ||
      null;

    const handleCursorMove = (e: PointerEvent) => {
      if (!cursorBank || variants.length === 0) return;
      const target = e.target instanceof Element ? e.target : null;
      const cursorZone = target ? target.closest('[data-framer-cursor]') : null;
      const cid = cursorZone ? cursorZone.getAttribute('data-framer-cursor') : null;
      const activeEl =
        (cid && cursorBank.querySelector<HTMLElement>(\`[data-mirror-cursor-variant="\${cid}"]\`)) ||
        defaultVariant;

      variants.forEach((v) => {
        if (v === activeEl) {
          v.style.display = '';
          v.style.opacity = '1';
          v.style.transform = \`translate(-50%, -50%) translate3d(\${e.clientX}px, \${e.clientY}px, 0px)\`;
          const isCardLink = Boolean(target && target.closest('a[href]'));
          const isRecommend = v.classList.contains('framer-v-rsy4vm');
          if (v.classList.contains('framer-16c1ymk')) {
            v.style.overflow = isCardLink || isRecommend ? 'visible' : 'clip';
          }
        } else {
          v.style.opacity = '0';
          v.style.display = 'none';
        }
      });
    };

    const handleCursorLeave = () => {
      variants.forEach((v) => {
        v.style.opacity = '0';
        v.style.display = 'none';
      });
    };

    if (variants.length > 0 && window.matchMedia('(pointer: fine)').matches) {
      window.addEventListener('pointermove', handleCursorMove, { passive: true });
      document.addEventListener('mouseleave', handleCursorLeave);
    }

    return () => {
      document.removeEventListener('click', handleClick);
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('pointermove', handleCursorMove);
      document.removeEventListener('mouseleave', handleCursorLeave);
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={navRef} className=${JSON.stringify(['mirror-navbar-root', comp.wrapperClass].filter(Boolean).join(' '))} style={${comp.wrapperClass ? `{ minHeight: 'auto', display: 'contents' }` : `{}`}}>
${jsx}
    </div>
  );
}
`;
    } else if (hasCanvasOrWidget) {
      const { jsx: widgetJsx } = nodesToJsx(comp.nodes, {
        routerMode,
        mirroredRoutes,
        indentLevel: 3,
      });
      tsxCode = `${imports.join('\n')}

export default function ${comp.name}() {
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = sectionRef.current;
    if (!root) return;

    // 1. Draw captured high-DPI canvas bitmaps onto <canvas data-canvas-fallback="...">
    root.querySelectorAll<HTMLCanvasElement>('canvas[data-canvas-fallback]').forEach((canvas) => {
      const src = canvas.getAttribute('data-canvas-fallback');
      if (!src) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      img.src = src;
    });

    // 2. Run any self-contained canvas/widget script preserved from the original section
    root.querySelectorAll<HTMLElement>('[data-mirror-widget-script]').forEach((holder) => {
      if (holder.getAttribute('data-widget-initialized') === 'true') return;
      holder.setAttribute('data-widget-initialized', 'true');
      try {
        const rawCode = decodeURIComponent(holder.getAttribute('data-mirror-widget-script') || '');
        if (!rawCode) return;
        const sec = holder.closest('section');
        if (sec && sec.classList.contains('vaquita-cta_section')) {
          sec.querySelectorAll('.moo-sq, .moo-line, .moo-screen').forEach((n) => n.remove());
          const title = sec.querySelector('.big-cta_title');
          if (title && title.querySelector('.moo-src')) {
            title.innerHTML = '<span class="wordmark">:Claude:</span> Haiku 5.5';
          }
        }
        const fn = new Function(rawCode);
        fn();
      } catch {}
    });
  }, []);

  return (
    <div ref={sectionRef} className="mirror-canvas-section">
${widgetJsx}
    </div>
  );
}
`;
    } else {
      const bodyJsx = comp.wrapperClass
        ? `    <div className=${JSON.stringify(comp.wrapperClass)} style={{ minHeight: 'auto', display: 'contents' }}>\n${jsx}\n    </div>`
        : comp.nodes.length > 1
        ? `    <>\n${jsx}\n    </>`
        : jsx;
      tsxCode = `${imports.join('\n')}\n\nexport default function ${comp.name}() {\n  return (\n${bodyJsx}\n  );\n}\n`;
    }
    const navbarExtraCss = isInteractiveNavbar
      ? `\n/* Sticky header wrapper & scroll-driven SVG / Lottie transition rules */\n.mirror-navbar-root {\n  position: sticky;\n  top: 0;\n  z-index: 9999;\n}\n[data-scroll-lottie="true"] [data-scroll-transform],\n[data-scroll-lottie="true"] [data-scroll-opacity] {\n  transition: transform 0.42s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.32s cubic-bezier(0.22, 1, 0.36, 1);\n  will-change: transform, opacity;\n}\n`
      : '';
    const cssFileContent = cssContent
      ? `/* ${comp.name} component styles */\n${cssContent}${navbarExtraCss}\n`
      : `/* ${comp.name} component styles */${navbarExtraCss}\n`;

    await writeTextFile(path.join(compDir, `${comp.name}.tsx`), tsxCode);
    await writeTextFile(path.join(compDir, `${comp.name}.css`), cssFileContent);
  }
}

/**
 * Generates a complete Vite + React + TypeScript (`.tsx`) SPA (`--format react`).
 */
export async function generateReactOutput({
  outRoot,
  pages,
  assetStore,
  startOrigin,
  singlePage,
}) {
  const mirroredRoutes = new Set(pages.map((p) => normalizeRoutePathname(p.pageUrl.pathname)));
  if (singlePage && pages.length === 1) {
    mirroredRoutes.add('/');
  }

  const {
    sharedNavbar,
    sharedFooter,
    pageDecompositions,
    allComponents,
    globalCss,
    componentCssMap,
    cssStats,
  } = await prepareComponentizedPages({
    pages,
    assetStore,
    startOrigin,
    mirroredRoutes,
  });

  // 1. Write `src/styles/globals.css`
  await writeTextFile(path.join(outRoot, 'src', 'styles', 'globals.css'), globalCss + '\n');

  // 2. Write all modular components (`src/components/<Name>/<Name>.tsx` + `<Name>.css`)
  await writeModularComponents({
    outRoot,
    allComponents,
    componentCssMap,
    routerMode: 'react',
    mirroredRoutes,
  });

  // 3. Write page components (`src/pages/<PageName>.tsx`)
  const routeEntries = [];
  const usedPageNames = new Set();

  for (let i = 0; i < pageDecompositions.length; i++) {
    const pageDec = pageDecompositions[i];
    const routePath = normalizeRoutePathname(pageDec.pageUrl.pathname);

    let pageCompName = routeToComponentName(routePath);
    if (usedPageNames.has(pageCompName)) {
      pageCompName = `${pageCompName}${i + 1}`;
    }
    usedPageNames.add(pageCompName);

    let pageCode;
    if (pageDec.sectionComponents.length > 0) {
      const secImports = pageDec.sectionComponents.map(
        (sec) => `import ${sec.name} from '../components/${sec.name}/${sec.name}';`
      );
      const hasInnerWrap = Boolean(pageDec.pageWrapper.innerWrapperClass);
      if (hasInnerWrap && sharedNavbar && !pageDec.sectionComponents.some((s) => s.name === 'Navbar')) {
        secImports.push(`import Navbar from '../components/Navbar/Navbar';`);
      }
      if (hasInnerWrap && sharedFooter && !pageDec.sectionComponents.some((s) => s.name === 'Footer')) {
        secImports.push(`import Footer from '../components/Footer/Footer';`);
      }
      const tagIndent = pageDec.pageWrapper.hasArticleWrapper || hasInnerWrap ? '        ' : '      ';
      const secTagList = pageDec.sectionComponents.map((sec) => `${tagIndent}<${sec.name} />`);
      if (hasInnerWrap && sharedFooter) {
        secTagList.push(`${tagIndent}<Footer />`);
      }
      if (hasInnerWrap && sharedNavbar) {
        secTagList.push(`${tagIndent}<Navbar />`);
      }
      const secTags = secTagList.join('\n');

      const wTag = pageDec.pageWrapper.wrapperTag || 'main';
      const mainIdAttr = pageDec.pageWrapper.mainId ? ` id=${JSON.stringify(pageDec.pageWrapper.mainId)}` : '';
      const mainClassAttr = pageDec.pageWrapper.mainClass
        ? ` className=${JSON.stringify(pageDec.pageWrapper.mainClass)}`
        : '';
      const appearMapAttr = pageDec.pageWrapper.framerAppearMap
        ? ` data-framer-appear-map=${JSON.stringify(pageDec.pageWrapper.framerAppearMap)}`
        : '';
      const articleClassAttr = pageDec.pageWrapper.articleClass
        ? ` className=${JSON.stringify(pageDec.pageWrapper.articleClass)}`
        : '';
      const innerStyleObj = styleStringToJsxObjectLiteral(pageDec.pageWrapper.innerWrapperStyle);
      const innerStyleAttr = innerStyleObj ? ` style=${innerStyleObj}` : '';
      const innerCursorAttr = pageDec.pageWrapper.innerWrapperCursor
        ? ` data-framer-cursor=${JSON.stringify(pageDec.pageWrapper.innerWrapperCursor)}`
        : '';

      let innerBody = secTags;
      if (pageDec.pageWrapper.hasArticleWrapper) {
        innerBody = `      <article${articleClassAttr}>\n${secTags}\n      </article>`;
      } else if (hasInnerWrap) {
        innerBody = `      <div data-framer-root="" className=${JSON.stringify(pageDec.pageWrapper.innerWrapperClass)}${innerCursorAttr}${innerStyleAttr}>\n${secTags}\n      </div>`;
      }

      pageCode = `${secImports.join('\n')}

export default function ${pageCompName}() {
  return (
    <${wTag}${mainIdAttr}${mainClassAttr}${appearMapAttr}>
${innerBody}
    </${wTag}>
  );
}
`;
    } else {
      const { jsx, usesRouterLink } = nodesToJsx(pageDec.pageWrapper.fallbackBodyNodes, {
        routerMode: 'react',
        mirroredRoutes,
        indentLevel: 3,
      });
      const fbImports = [];
      if (jsx.includes('React.CSSProperties')) fbImports.push(`import type React from 'react';`);
      if (usesRouterLink) fbImports.push(`import { Link } from 'react-router-dom';`);
      const linkImport = fbImports.length ? fbImports.join('\n') + '\n\n' : '';
      pageCode = `${linkImport}export default function ${pageCompName}() {
  return (
    <>
${jsx || '      <main />'}
    </>
  );
}
`;
    }

    await writeTextFile(path.join(outRoot, 'src', 'pages', `${pageCompName}.tsx`), pageCode);
    routeEntries.push({ routePath, compName: pageCompName });
  }

  // 4. Write `src/App.tsx`
  const anyInnerWrap = pageDecompositions.some((p) => Boolean(p.pageWrapper.innerWrapperClass));
  const appImports = [`import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';`];
  if (sharedNavbar && !anyInnerWrap) appImports.push(`import Navbar from './components/Navbar/Navbar';`);
  if (sharedFooter && !anyInnerWrap) appImports.push(`import Footer from './components/Footer/Footer';`);
  for (const r of routeEntries) {
    appImports.push(`import ${r.compName} from './pages/${r.compName}';`);
  }

  const routeElements = routeEntries.map(
    (r) => `        <Route path=${JSON.stringify(r.routePath)} element={<${r.compName} />} />`
  );
  const hasRootRoute = routeEntries.some((r) => r.routePath === '/');
  if (!hasRootRoute && routeEntries.length > 0) {
    routeElements.unshift(`        <Route path="/" element={<${routeEntries[0].compName} />} />`);
  }
  if (routeEntries.length > 0) {
    routeElements.push(`        <Route path="*" element={<Navigate to="/" replace />} />`);
  }

  const appCode = `${appImports.join('\n')}

export default function App() {
  return (
    <BrowserRouter>
${sharedNavbar && !anyInnerWrap ? '      <Navbar />\n' : ''}      <Routes>
${routeElements.join('\n')}
      </Routes>
${sharedFooter && !anyInnerWrap ? '      <Footer />\n' : ''}    </BrowserRouter>
  );
}
`;
  await writeTextFile(path.join(outRoot, 'src', 'App.tsx'), appCode);

  // 5. Write `src/main.tsx` and `src/vite-env.d.ts`
  const mainCode = `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;
  await writeTextFile(path.join(outRoot, 'src', 'main.tsx'), mainCode);
  await writeTextFile(path.join(outRoot, 'src', 'vite-env.d.ts'), `/// <reference types="vite/client" />\n`);

  // 6. Write `index.html`, `tsconfig.json`, `vite.config.ts`, `package.json`
  const meta = pageDecompositions[0].metadata;
  const htmlAttrs = [
    `lang="${escapeAttr(meta.htmlLang || 'en')}"`,
    meta.htmlClass ? `class="${escapeAttr(meta.htmlClass)}"` : '',
    meta.htmlStyle ? `style="${escapeAttr(meta.htmlStyle)}"` : '',
    meta.htmlDataTheme ? `data-theme="${escapeAttr(meta.htmlDataTheme)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const bodyAttrs = [
    meta.bodyClass ? `class="${escapeAttr(meta.bodyClass)}"` : '',
    meta.bodyStyle ? `style="${escapeAttr(meta.bodyStyle)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const indexHtml = `<!DOCTYPE html>
<html ${htmlAttrs}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(meta.title)}</title>
${meta.description ? `    <meta name="description" content="${escapeAttr(meta.description)}" />\n` : ''}  </head>
  <body${bodyAttrs ? ' ' + bodyAttrs : ''}>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
  await writeTextFile(path.join(outRoot, 'index.html'), indexHtml);

  const tsConfig = {
    compilerOptions: {
      target: 'ES2020',
      useDefineForClassFields: true,
      lib: ['ES2020', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      skipLibCheck: true,
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      isolatedModules: true,
      moduleDetection: 'force',
      noEmit: true,
      jsx: 'react-jsx',
      strict: false,
    },
    include: ['src'],
  };
  await writeTextFile(path.join(outRoot, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2) + '\n');

  const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    open: false,
  },
});
`;
  await writeTextFile(path.join(outRoot, 'vite.config.ts'), viteConfig);

  const pkgName = sanitizePkgName(path.basename(outRoot));
  const pkgJson = {
    name: pkgName,
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview',
    },
    dependencies: {
      react: '^18.3.1',
      'react-dom': '^18.3.1',
      'react-router-dom': '^6.28.0',
    },
    devDependencies: {
      '@types/react': '^18.3.12',
      '@types/react-dom': '^18.3.1',
      '@vitejs/plugin-react': '^4.3.4',
      typescript: '^5.6.3',
      vite: '^6.0.0',
    },
  };
  await writeTextFile(path.join(outRoot, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n');

  const writtenAssets = await assetStore.writeAssetsToDisk(path.join(outRoot, 'public'));
  return {
    writtenAssets,
    componentCount: allComponents.length,
    cssStats,
  };
}

/**
 * Generates a complete Next.js App Router + TypeScript (`.tsx`) project (`--format nextjs`).
 */
export async function generateNextjsOutput({
  outRoot,
  pages,
  assetStore,
  startOrigin,
  singlePage,
}) {
  const mirroredRoutes = new Set(pages.map((p) => normalizeRoutePathname(p.pageUrl.pathname)));
  if (singlePage && pages.length === 1) {
    mirroredRoutes.add('/');
  }

  const {
    sharedNavbar,
    sharedFooter,
    pageDecompositions,
    allComponents,
    globalCss,
    componentCssMap,
    cssStats,
  } = await prepareComponentizedPages({
    pages,
    assetStore,
    startOrigin,
    mirroredRoutes,
  });

  // 1. Write `src/app/globals.css`
  await writeTextFile(path.join(outRoot, 'src', 'app', 'globals.css'), globalCss + '\n');

  // 2. Write all modular components (`src/components/<Name>/<Name>.tsx` + `<Name>.css`)
  await writeModularComponents({
    outRoot,
    allComponents,
    componentCssMap,
    routerMode: 'nextjs',
    mirroredRoutes,
  });

  // 3. Write `src/app/layout.tsx`
  const meta = pageDecompositions[0].metadata;
  const htmlStyleObj = styleStringToJsxObjectLiteral(meta.htmlStyle);
  const bodyStyleObj = styleStringToJsxObjectLiteral(meta.bodyStyle);

  const htmlProps = [
    `lang=${JSON.stringify(meta.htmlLang || 'en')}`,
    meta.htmlClass ? `className=${JSON.stringify(meta.htmlClass)}` : '',
    htmlStyleObj ? `style=${htmlStyleObj}` : '',
    meta.htmlDataTheme ? `data-theme=${JSON.stringify(meta.htmlDataTheme)}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const bodyProps = [
    meta.bodyClass ? `className=${JSON.stringify(meta.bodyClass)}` : '',
    bodyStyleObj ? `style=${bodyStyleObj}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const anyInnerWrap = pageDecompositions.some((p) => Boolean(p.pageWrapper.innerWrapperClass));
  const layoutImports = [
    `import type React from 'react';`,
    `import './globals.css';`,
  ];
  if (sharedNavbar && !anyInnerWrap) layoutImports.push(`import Navbar from '../components/Navbar/Navbar';`);
  if (sharedFooter && !anyInnerWrap) layoutImports.push(`import Footer from '../components/Footer/Footer';`);

  const layoutCode = `${layoutImports.join('\n')}

export const metadata = {
  title: ${JSON.stringify(meta.title)},
  description: ${JSON.stringify(meta.description || '')},
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html ${htmlProps}>
      <body${bodyProps ? ' ' + bodyProps : ''}>
${sharedNavbar && !anyInnerWrap ? '        <Navbar />\n' : ''}        {children}
${sharedFooter && !anyInnerWrap ? '        <Footer />\n' : ''}      </body>
    </html>
  );
}
`;
  await writeTextFile(path.join(outRoot, 'src', 'app', 'layout.tsx'), layoutCode);

  // 4. Write `src/app/.../page.tsx` for each route
  for (let i = 0; i < pageDecompositions.length; i++) {
    const pageDec = pageDecompositions[i];
    const routePath = normalizeRoutePathname(pageDec.pageUrl.pathname);
    const compName = routeToComponentName(routePath);

    const routeSegments = routePath === '/' ? [] : routePath.slice(1).split('/');
    const depthFromApp = routeSegments.length;
    const relToComponents = '../'.repeat(depthFromApp + 1) + 'components';

    let pageCode;
    if (pageDec.sectionComponents.length > 0) {
      const secImports = pageDec.sectionComponents.map(
        (sec) => `import ${sec.name} from '${relToComponents}/${sec.name}/${sec.name}';`
      );
      const hasInnerWrap = Boolean(pageDec.pageWrapper.innerWrapperClass);
      if (hasInnerWrap && sharedNavbar && !pageDec.sectionComponents.some((s) => s.name === 'Navbar')) {
        secImports.push(`import Navbar from '${relToComponents}/Navbar/Navbar';`);
      }
      if (hasInnerWrap && sharedFooter && !pageDec.sectionComponents.some((s) => s.name === 'Footer')) {
        secImports.push(`import Footer from '${relToComponents}/Footer/Footer';`);
      }
      const tagIndent = pageDec.pageWrapper.hasArticleWrapper || hasInnerWrap ? '        ' : '      ';
      const secTagList = pageDec.sectionComponents.map((sec) => `${tagIndent}<${sec.name} />`);
      if (hasInnerWrap && sharedFooter) {
        secTagList.push(`${tagIndent}<Footer />`);
      }
      if (hasInnerWrap && sharedNavbar) {
        secTagList.push(`${tagIndent}<Navbar />`);
      }
      const secTags = secTagList.join('\n');

      const wTag = pageDec.pageWrapper.wrapperTag || 'main';
      const mainIdAttr = pageDec.pageWrapper.mainId ? ` id=${JSON.stringify(pageDec.pageWrapper.mainId)}` : '';
      const mainClassAttr = pageDec.pageWrapper.mainClass
        ? ` className=${JSON.stringify(pageDec.pageWrapper.mainClass)}`
        : '';
      const appearMapAttr = pageDec.pageWrapper.framerAppearMap
        ? ` data-framer-appear-map=${JSON.stringify(pageDec.pageWrapper.framerAppearMap)}`
        : '';
      const articleClassAttr = pageDec.pageWrapper.articleClass
        ? ` className=${JSON.stringify(pageDec.pageWrapper.articleClass)}`
        : '';
      const innerStyleObj = styleStringToJsxObjectLiteral(pageDec.pageWrapper.innerWrapperStyle);
      const innerStyleAttr = innerStyleObj ? ` style=${innerStyleObj}` : '';
      const innerCursorAttr = pageDec.pageWrapper.innerWrapperCursor
        ? ` data-framer-cursor=${JSON.stringify(pageDec.pageWrapper.innerWrapperCursor)}`
        : '';

      let innerBody = secTags;
      if (pageDec.pageWrapper.hasArticleWrapper) {
        innerBody = `      <article${articleClassAttr}>\n${secTags}\n      </article>`;
      } else if (hasInnerWrap) {
        innerBody = `      <div data-framer-root="" className=${JSON.stringify(pageDec.pageWrapper.innerWrapperClass)}${innerCursorAttr}${innerStyleAttr}>\n${secTags}\n      </div>`;
      }

      pageCode = `${secImports.join('\n')}

export default function ${compName}() {
  return (
    <${wTag}${mainIdAttr}${mainClassAttr}${appearMapAttr}>
${innerBody}
    </${wTag}>
  );
}
`;
    } else {
      const { jsx, usesRouterLink } = nodesToJsx(pageDec.pageWrapper.fallbackBodyNodes, {
        routerMode: 'nextjs',
        mirroredRoutes,
        indentLevel: 3,
      });
      const fbImports = [];
      if (jsx.includes('React.CSSProperties')) fbImports.push(`import type React from 'react';`);
      if (usesRouterLink) fbImports.push(`import Link from 'next/link';`);
      const linkImport = fbImports.length ? fbImports.join('\n') + '\n\n' : '';
      pageCode = `${linkImport}export default function ${compName}() {
  return (
    <>
${jsx || '      <main />'}
    </>
  );
}
`;
    }

    const pageFilePath = path.join(outRoot, 'src', 'app', ...routeSegments, 'page.tsx');
    await writeTextFile(pageFilePath, pageCode);

    if (i === 0 && routePath !== '/') {
      const rootPageCode = `export { default } from '.${routePath}/page';\n`;
      await writeTextFile(path.join(outRoot, 'src', 'app', 'page.tsx'), rootPageCode);
    }
  }

  // 5. Write `tsconfig.json`, `next.config.mjs`, `package.json`
  const tsConfig = {
    compilerOptions: {
      target: 'ES2017',
      lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true,
      skipLibCheck: true,
      strict: false,
      noEmit: true,
      esModuleInterop: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: 'preserve',
      incremental: true,
      plugins: [{ name: 'next' }],
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
    exclude: ['node_modules'],
  };
  await writeTextFile(path.join(outRoot, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2) + '\n');

  const nextConfig = `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
`;
  await writeTextFile(path.join(outRoot, 'next.config.mjs'), nextConfig);

  const pkgName = sanitizePkgName(path.basename(outRoot));
  const pkgJson = {
    name: pkgName,
    version: '0.1.0',
    private: true,
    scripts: {
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
    },
    dependencies: {
      next: '^15.1.0',
      react: '^18.3.1',
      'react-dom': '^18.3.1',
    },
    devDependencies: {
      '@types/node': '^22.0.0',
      '@types/react': '^18.3.12',
      '@types/react-dom': '^18.3.1',
      typescript: '^5.6.3',
    },
  };
  await writeTextFile(path.join(outRoot, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n');

  const writtenAssets = await assetStore.writeAssetsToDisk(path.join(outRoot, 'public'));
  return {
    writtenAssets,
    componentCount: allComponents.length,
    cssStats,
  };
}

function sanitizePkgName(name) {
  return (
    (name || 'mirrored-site')
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'mirrored-site'
  );
}

function escapeHtml(str = '') {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str = '') {
  return escapeHtml(str).replace(/"/g, '&quot;');
}
