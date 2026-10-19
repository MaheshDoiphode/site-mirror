/**
 * CSS Rule Parser, Dead-CSS Purger, and Component CSS Splitter
 *
 * Parses raw consolidated CSS into structured AST rules (preserving `@media`,
 * `@supports`, `@container`, `@font-face`, `@keyframes`), removes unused CSS
 * rules that don't match any element in the mirrored DOM, and routes component-specific
 * CSS rules into each component's co-located `<ComponentName>.css` file while
 * keeping `:root` tokens, `@font-face`, resets, and shared utility classes in `globals.css`.
 */
import { formatCssReadable } from './assets.mjs';

const STATE_CLASSES_TO_IGNORE = new Set([
  'active',
  'is-active',
  'is-open',
  'open',
  'is-selected',
  'selected',
  'is-visible',
  'visible',
  'is-inview',
  'isFirst',
  'disabled',
  'is-disabled',
  'focus',
  'focused',
  'hover',
  'checked',
  'current',
  'show',
  'hide',
  'hidden',
  'collapsed',
  'expanded',
  'loading',
  'loaded',
  'error',
  'valid',
  'invalid',
]);

/**
 * Splits a CSS stylesheet into top-level blocks (`{ prelude, body, raw }`).
 * Correctly handles strings, comments, parentheses, and nested curly braces.
 */
export function parseCssTopLevelBlocks(cssText) {
  const blocks = [];
  let i = 0;
  const len = cssText.length;

  let start = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let inSingle = false;
  let inDouble = false;
  let inComment = false;
  let braceOpenIdx = -1;

  while (i < len) {
    const ch = cssText[i];
    const next = cssText[i + 1];

    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (!inSingle && !inDouble && ch === '/' && next === '*') {
      inComment = true;
      i += 2;
      continue;
    }

    if (ch === "'" && !inDouble && cssText[i - 1] !== '\\') {
      inSingle = !inSingle;
      i++;
      continue;
    }

    if (ch === '"' && !inSingle && cssText[i - 1] !== '\\') {
      inDouble = !inDouble;
      i++;
      continue;
    }

    if (inSingle || inDouble) {
      i++;
      continue;
    }

    if (ch === '(') {
      parenDepth++;
      i++;
      continue;
    }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      i++;
      continue;
    }

    if (ch === '{' && parenDepth === 0) {
      if (braceDepth === 0) {
        braceOpenIdx = i;
      }
      braceDepth++;
      i++;
      continue;
    }

    if (ch === '}' && parenDepth === 0) {
      braceDepth = Math.max(0, braceDepth - 1);
      if (braceDepth === 0 && braceOpenIdx !== -1) {
        const prelude = stripComments(cssText.slice(start, braceOpenIdx)).trim();
        const body = cssText.slice(braceOpenIdx + 1, i).trim();
        blocks.push({
          type: prelude.startsWith('@') ? 'at-rule' : 'rule',
          prelude,
          body,
        });
        braceOpenIdx = -1;
        start = i + 1;
      }
      i++;
      continue;
    }

    // Handle statement at-rules like `@charset "...";` or `@import "...";`
    if (ch === ';' && braceDepth === 0 && parenDepth === 0) {
      const stmt = stripComments(cssText.slice(start, i + 1)).trim();
      if (stmt.startsWith('@')) {
        blocks.push({
          type: 'at-statement',
          prelude: stmt,
          body: '',
        });
      }
      start = i + 1;
    }

    i++;
  }

  return blocks;
}

function stripComments(str) {
  return str.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Splits a selector list by top-level commas (ignoring commas inside `:is(...)`, `:not(...)`, `[...]`).
 */
export function splitSelectorList(selectorText) {
  const parts = [];
  let current = '';
  let parenDepth = 0;
  let bracketDepth = 0;
  let inQuote = null;

  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote && selectorText[i - 1] !== '\\') inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);

    if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function unescapeCssIdentifier(ident) {
  return ident.replace(/\\(.)/g, '$1');
}

/**
 * Extracts classes, IDs, and tag names referenced by a single selector branch.
 * Note: Selectors inside `:not(...)` are negated exclusions (e.g. `.framer-styles-preset-x:not(.rich-text-wrapper)`)
 * and MUST NOT be treated as required classes/IDs/tags for the selector to match!
 */
export function extractSelectorTokens(singleSelector) {
  // Remove attribute selectors `[...]` and negated `:not(...)` clauses before extracting required tokens
  let withoutNegated = singleSelector.replace(/\[[^\]]*\]/g, ' ');
  let prev;
  do {
    prev = withoutNegated;
    withoutNegated = withoutNegated.replace(/:not\([^()]*\)/gi, ' ');
  } while (withoutNegated !== prev);

  const classes = [];
  const ids = [];
  const tags = [];

  // Extract `.className` (handling escaped chars like `.m\:col-span-2`)
  const classRegex = /\.((?:\\[.:/[\]#!@$%^&*()+=,~'`";<>?\\]|[\w-])+)/g;
  let m;
  while ((m = classRegex.exec(withoutNegated)) !== null) {
    classes.push(unescapeCssIdentifier(m[1]));
  }

  // Extract `#idName`
  const idRegex = /#((?:\\[.:/[\]#!@$%^&*()+=,~'`";<>?\\]|[\w-])+)/g;
  while ((m = idRegex.exec(withoutNegated)) !== null) {
    ids.push(unescapeCssIdentifier(m[1]));
  }

  // Extract element tag names
  const stripped = withoutNegated
    .replace(classRegex, ' ')
    .replace(idRegex, ' ')
    .replace(/::?[a-zA-Z-]+(?:\([^)]*\))?/g, ' ')
    .replace(/[>+~*(),]/g, ' ');

  for (const token of stripped.split(/\s+/)) {
    const clean = token.trim().toLowerCase();
    if (clean && /^[a-z][a-z0-9-]*$/.test(clean)) {
      tags.push(clean);
    }
  }

  return { classes, ids, tags };
}

/**
 * Collects all classes, IDs, and tag names present in a Cheerio root or node array.
 */
export function collectDomInventory($, nodes) {
  const classes = new Set();
  const ids = new Set();
  const tags = new Set();
  const modulePrefixes = new Set();

  function walk(node) {
    if (!node) return;
    if (node.type === 'tag' || node.type === 'style' || node.type === 'script') {
      const tagName = (node.name || '').toLowerCase();
      if (tagName) tags.add(tagName);

      const attribs = node.attribs || {};
      if (attribs.class) {
        for (const cls of attribs.class.split(/\s+/)) {
          const trimmed = cls.trim();
          if (!trimmed) continue;
          classes.add(trimmed);
          const prefix = extractCssModulePrefix(trimmed);
          if (prefix) modulePrefixes.add(prefix);
        }
      }
      if (attribs.id) {
        ids.add(attribs.id.trim());
      }
    }
    if (node.children) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  if (Array.isArray(nodes)) {
    for (const n of nodes) walk(n);
  } else if ($ && typeof $.root === 'function') {
    walk($.root()[0]);
  }

  return { classes, ids, tags, modulePrefixes };
}

/**
 * Extracts a CSS Module component prefix if present, e.g.:
 * `SiteHeader-module-scss-module__zKj4Ca__header` -> `SiteHeader`
 * `HeroTwoColumn_root__a1b2c` -> `HeroTwoColumn`
 */
export function extractCssModulePrefix(className) {
  const scssMod = /^([A-Z][a-zA-Z0-9]+)-module(?:-scss)?(?:-module)?__/.exec(className);
  if (scssMod) return scssMod[1];

  const stdMod = /^([A-Z][a-zA-Z0-9]+)_[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]{4,}$/.exec(className);
  if (stdMod) return stdMod[1];

  return null;
}

/**
 * Determines whether a single selector branch is used by the page's DOM inventory.
 */
function isSelectorBranchUsed(singleSelector, globalInventory) {
  const trimmed = singleSelector.trim();
  if (!trimmed) return false;

  // Always keep `:root`, `html`, `body`, `*`, `[data-theme...]`, `@`
  if (
    trimmed.startsWith(':root') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('[data-theme') ||
    trimmed.startsWith('::') ||
    trimmed.startsWith(':-')
  ) {
    return true;
  }

  const { classes, ids, tags } = extractSelectorTokens(trimmed);

  // Check IDs: every ID in the selector must exist in the DOM
  for (const id of ids) {
    if (!globalInventory.ids.has(id)) return false;
  }

  // Check classes: every non-state class in the selector must exist in the DOM
  const meaningfulClasses = classes.filter((c) => !STATE_CLASSES_TO_IGNORE.has(c));
  for (const cls of meaningfulClasses) {
    if (!globalInventory.classes.has(cls)) {
      return false;
    }
  }

  // If the selector has no classes or IDs, check if its tag names exist in the DOM
  if (meaningfulClasses.length === 0 && ids.length === 0 && tags.length > 0) {
    for (const t of tags) {
      if (t === 'html' || t === 'body' || t === 'main' || t === 'article' || t === 'section') continue;
      if (!globalInventory.tags.has(t)) return false;
    }
  }

  return true;
}

/**
 * Decides which components (or `'global'`) own a selector.
 *
 * @param {string[]} activeSelectorBranches
 * @param {Array<{ name: string, inventory: { classes: Set<string>, ids: Set<string>, modulePrefixes: Set<string> }, primaryPrefixes: Set<string> }>} components
 * @param {Map<string, Set<string>>} classToComponentsMap
 * @returns {string[]} Array of owner names (`['global']` or `['HeroTwoColumn', 'HeroTwoColumn2']`)
 */
function resolveOwnersForSelectorBranches(activeSelectorBranches, components, classToComponentsMap) {
  const allClasses = [];
  const allIds = [];

  for (const branch of activeSelectorBranches) {
    if (branch.includes(':root') || branch.startsWith('[data-theme')) {
      return ['global'];
    }
    const { classes, ids } = extractSelectorTokens(branch);
    for (const c of classes) {
      if (!STATE_CLASSES_TO_IGNORE.has(c)) allClasses.push(c);
    }
    for (const id of ids) allIds.push(id);
  }

  // Pure element / attribute / pseudo selectors with no classes or IDs belong to `globals.css`
  if (allClasses.length === 0 && allIds.length === 0) {
    return ['global'];
  }

  // 1. Check if any class has a CSS Module prefix matching one or more components' primary prefix
  //    (e.g. `HeroTwoColumn-module-...` belongs to `HeroTwoColumn` and `HeroTwoColumn2`)
  const matchedPrefixes = new Set();
  const matchedByPrimaryPrefix = new Set();
  for (const cls of allClasses) {
    const prefix = extractCssModulePrefix(cls);
    if (prefix) {
      for (const comp of components) {
        if (comp.primaryPrefixes.has(prefix)) {
          matchedPrefixes.add(prefix);
          matchedByPrimaryPrefix.add(comp.name);
        }
      }
    }
  }
  if (matchedPrefixes.size === 1 && matchedByPrimaryPrefix.size >= 1) {
    return [...matchedByPrimaryPrefix];
  }

  // 2. Check which components actually use the MOST SPECIFIC (rightmost) class/ID in each branch.
  //    For example, in `.framer-v7O0O .framer-yblkb3 { ... }`, `.framer-v7O0O` is on the page wrapper
  //    while `.framer-yblkb3` is exclusively inside `HomeHeroStack`.
  const specificCandidateOwners = new Set();
  for (const branch of activeSelectorBranches) {
    const { classes: branchClasses, ids: branchIds } = extractSelectorTokens(branch);
    const meaningfulBranchClasses = branchClasses.filter((c) => !STATE_CLASSES_TO_IGNORE.has(c));
    const lastCls = meaningfulBranchClasses[meaningfulBranchClasses.length - 1];
    if (lastCls) {
      const owners = classToComponentsMap.get(lastCls);
      if (owners && owners.size > 0) {
        for (const o of owners) specificCandidateOwners.add(o);
        continue;
      }
    }
    const lastId = branchIds[branchIds.length - 1];
    if (lastId) {
      for (const comp of components) {
        if (comp.inventory.ids.has(lastId)) {
          specificCandidateOwners.add(comp.name);
        }
      }
    }
  }

  if (specificCandidateOwners.size === 1) {
    return [...specificCandidateOwners];
  }

  // 3. Fallback: check all classes/IDs in the selector
  const candidateOwners = new Set();
  for (const cls of allClasses) {
    const owners = classToComponentsMap.get(cls);
    if (owners) {
      for (const o of owners) candidateOwners.add(o);
    }
  }
  for (const id of allIds) {
    for (const comp of components) {
      if (comp.inventory.ids.has(id)) {
        candidateOwners.add(comp.name);
      }
    }
  }

  if (candidateOwners.size === 1) {
    return [...candidateOwners];
  }

  // Otherwise (shared utility across many components or on `<html>`/`<body>`), keep in `globals.css`
  return ['global'];
}

/**
 * Purges unused CSS and splits all active CSS rules across `globals.css` and
 * individual component `.css` files (`Navbar.css`, `HeroTwoColumn.css`, `Footer.css`, etc.).
 *
 * @param {object} params
 * @param {string} params.rawConsolidatedCss
 * @param {{ classes: Set<string>, ids: Set<string>, tags: Set<string> }} params.globalInventory
 * @param {Array<{ name: string, inventory: { classes: Set<string>, ids: Set<string>, modulePrefixes: Set<string> }, primaryPrefixes: Set<string> }>} params.components
 * @returns {{ globalCss: string, componentCssMap: Map<string, string>, stats: { totalRules: number, keptRules: number, purgedRules: number } }}
 */
export function splitAndPurgeCss({ rawConsolidatedCss, globalInventory, components }) {
  // Build lookup: className -> Set of component names that use it
  const classToComponentsMap = new Map();
  for (const comp of components) {
    for (const cls of comp.inventory.classes) {
      if (!classToComponentsMap.has(cls)) {
        classToComponentsMap.set(cls, new Set());
      }
      classToComponentsMap.get(cls).add(comp.name);
    }
  }

  const globalBuckets = [];
  const componentBuckets = new Map();
  for (const comp of components) {
    componentBuckets.set(comp.name, []);
  }

  let totalRules = 0;
  let keptRules = 0;
  let purgedRules = 0;

  function pushRuleToOwners(owners, cssString) {
    for (const owner of owners) {
      if (owner !== 'global' && componentBuckets.has(owner)) {
        componentBuckets.get(owner).push(cssString);
      } else {
        globalBuckets.push(cssString);
      }
    }
  }

  function processRuleBlock(prelude, body, wrapAtRulePrelude = null) {
    totalRules++;
    const branches = splitSelectorList(prelude);
    const activeBranches = branches.filter((b) => isSelectorBranchUsed(b, globalInventory));

    if (activeBranches.length === 0) {
      purgedRules++;
      return;
    }

    keptRules++;
    const filteredSelector = activeBranches.join(', ');
    const owners = resolveOwnersForSelectorBranches(activeBranches, components, classToComponentsMap);
    const ruleText = `${filteredSelector} {\n${body}\n}`;

    if (wrapAtRulePrelude) {
      pushRuleToOwners(owners, `${wrapAtRulePrelude} {\n${ruleText}\n}`);
    } else {
      pushRuleToOwners(owners, ruleText);
    }
  }

  const topBlocks = parseCssTopLevelBlocks(rawConsolidatedCss);

  for (const block of topBlocks) {
    if (block.type === 'at-statement') {
      globalBuckets.push(block.prelude);
      continue;
    }

    if (block.type === 'at-rule') {
      const lowerPrelude = block.prelude.toLowerCase();

      if (lowerPrelude.startsWith('@font-face') || lowerPrelude.startsWith('@keyframes') || lowerPrelude.startsWith('@-webkit-keyframes')) {
        keptRules++;
        totalRules++;
        globalBuckets.push(`${block.prelude} {\n${block.body}\n}`);
        continue;
      }

      if (
        lowerPrelude.startsWith('@media') ||
        lowerPrelude.startsWith('@supports') ||
        lowerPrelude.startsWith('@container') ||
        lowerPrelude.startsWith('@layer')
      ) {
        const innerBlocks = parseCssTopLevelBlocks(block.body);
        // Group kept inner rules by owner so a single `@media` block is emitted per owner
        const rulesByOwner = new Map();

        for (const inner of innerBlocks) {
          if (inner.type === 'rule') {
            totalRules++;
            const branches = splitSelectorList(inner.prelude);
            const activeBranches = branches.filter((b) => isSelectorBranchUsed(b, globalInventory));
            if (activeBranches.length === 0) {
              purgedRules++;
              continue;
            }
            keptRules++;
            const owners = resolveOwnersForSelectorBranches(activeBranches, components, classToComponentsMap);
            for (const owner of owners) {
              if (!rulesByOwner.has(owner)) rulesByOwner.set(owner, []);
              rulesByOwner.get(owner).push(`${activeBranches.join(', ')} {\n${inner.body}\n}`);
            }
          } else if (inner.type === 'at-rule') {
            // Nested @media / @supports
            globalBuckets.push(`${block.prelude} {\n${inner.prelude} {\n${inner.body}\n}\n}`);
          }
        }

        for (const [owner, ownerRules] of rulesByOwner.entries()) {
          if (ownerRules.length > 0) {
            pushRuleToOwners([owner], `${block.prelude} {\n${ownerRules.join('\n')}\n}`);
          }
        }
        continue;
      }

      // Any other at-rule
      globalBuckets.push(`${block.prelude} {\n${block.body}\n}`);
      continue;
    }

    // Standard style rule
    processRuleBlock(block.prelude, block.body, null);
  }

  const globalCss = formatCssReadable(globalBuckets.join('\n\n'));
  const componentCssMap = new Map();

  for (const [compName, rules] of componentBuckets.entries()) {
    const formatted = formatCssReadable(rules.join('\n\n'));
    componentCssMap.set(compName, formatted);
  }

  return {
    globalCss,
    componentCssMap,
    stats: {
      totalRules,
      keptRules,
      purgedRules,
    },
  };
}
