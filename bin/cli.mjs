#!/usr/bin/env node
/**
 * site-mirror CLI
 *
 * Usage:
 *   site-mirror init                  Interactive setup - creates site-mirror.config.json
 *   site-mirror run [options]         Run the mirror (reads config + CLI overrides)
 *   site-mirror serve [dir] [port]    Serve the output folder locally (HTML, React, or Next.js)
 *
 * Options (for run):
 *   --start <url>         Start URL (required if not in config)
 *   --out <dir>           Output directory (default: ./offline)
 *   --format <type>       Output format: html | react | nextjs (default: html)
 *   --maxPages <n>        Max pages to crawl (0 = unlimited)
 *   --maxDepth <n>        Max link depth (0 = unlimited)
 *   --sameOriginOnly      Only crawl same-origin pages (default: true)
 *   --seedSitemaps        Seed URLs from sitemap.xml (default: false)
 *   --singlePage          Download only this one page + all its assets (no crawling)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = 'site-mirror.config.json';
const VALID_FORMATS = new Set(['html', 'react', 'nextjs', 'next']);

const defaultConfig = {
  start: '',
  urls: [],
  out: './offline',
  format: 'html',
  maxPages: 0,
  maxDepth: 0,
  sameOriginOnly: true,
  seedSitemaps: false,
  singlePage: false,
  login: false,
  auth: '',
  cookies: '',
  waitFor: 0,
  waitForSelector: '',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
};

function parseUrlsString(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => parseUrlsString(item));
  }
  // Normalize MSYS2 / Git Bash Windows path conversion (e.g. `C:/Program Files/Git/home` -> `/home`)
  const cleaned = String(raw).replace(/[A-Za-z]:\/Program Files\/Git(?=\/)/gi, '');
  return cleaned
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeFormat(fmt) {
  const lower = String(fmt || 'html').toLowerCase().trim();
  if (lower === 'next') return 'nextjs';
  if (VALID_FORMATS.has(lower)) return lower;
  return null;
}

async function loadConfig(cwd) {
  const configPath = path.join(cwd, CONFIG_FILE);
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    return { ...defaultConfig, ...JSON.parse(raw) };
  } catch {
    return { ...defaultConfig };
  }
}

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];

    if (key === '--start') {
      args.start = next;
      i++;
    } else if (key === '--urls' || key === '--url-list') {
      const collected = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        collected.push(argv[++i]);
      }
      args.urls = [...(args.urls || []), ...parseUrlsString(collected)];
    } else if (key === '--out' || key === '-o') {
      args.out = next;
      i++;
    } else if (key === '--format' || key === '-f') {
      args.format = next;
      i++;
    } else if (key === '--react') {
      args.format = 'react';
    } else if (key === '--nextjs' || key === '--next') {
      args.format = 'nextjs';
    } else if (key === '--html') {
      args.format = 'html';
    } else if (key === '--maxPages') {
      args.maxPages = Number(next);
      i++;
    } else if (key === '--maxDepth') {
      args.maxDepth = Number(next);
      i++;
    } else if (key === '--sameOriginOnly') {
      args.sameOriginOnly = next !== 'false' && next !== '0';
      i++;
    } else if (key === '--seedSitemaps') {
      args.seedSitemaps = next === 'true' || next === '1' || next === 'yes';
      i++;
    } else if (key === '--singlePage') {
      args.singlePage = true;
    } else if (key === '--login' || key === '--interactive-login') {
      args.login = true;
      if (next && !next.startsWith('-')) {
        if (/^https?:\/\//i.test(next)) {
          if (!args.start) args.start = next;
          i++;
        } else if (next.endsWith('.json')) {
          args.auth = next;
          i++;
        } else if (next === 'true' || next === 'false') {
          args.login = next === 'true';
          i++;
        }
      }
    } else if (key === '--auth' || key === '--save') {
      if (next && !next.startsWith('-')) {
        args.auth = next;
        i++;
      } else {
        args.auth = 'auth.json';
      }
    } else if (key === '--cookies' || key === '--cookie') {
      args.cookies = next;
      i++;
    } else if (key === '--waitFor' || key === '--wait') {
      args.waitFor = Number(next) || 0;
      i++;
    } else if (key === '--waitForSelector' || key === '--selector') {
      args.waitForSelector = next;
      i++;
    } else if (key === '--userAgent') {
      args.userAgent = next;
      i++;
    } else if (!key.startsWith('-') && /^https?:\/\//i.test(key) && !args.start) {
      args.start = key;
    }
  }
  return args;
}

async function prompt(rl, question, defaultValue) {
  return new Promise((resolve) => {
    const hint = defaultValue !== undefined ? ` (${defaultValue})` : '';
    rl.question(`${question}${hint}: `, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed === '' && defaultValue !== undefined ? defaultValue : trimmed);
    });
  });
}

async function cmdInit(cwd) {
  const configPath = path.join(cwd, CONFIG_FILE);
  const exists = await fs
    .access(configPath)
    .then(() => true)
    .catch(() => false);

  if (exists) {
    console.log(`Config already exists: ${configPath}`);
    console.log('Delete it first if you want to reinitialize.');
    return;
  }

  console.log('');
  console.log("Welcome to site-mirror! Let's set up your config.");
  console.log('Press Enter to accept the default value shown in parentheses.');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const start = await prompt(rl, 'Website URL to mirror', 'https://example.com/');
    const out = await prompt(rl, 'Output directory', './offline');
    const rawFormat = await prompt(rl, 'Export format (html / react / nextjs)', 'html');
    const format = normalizeFormat(rawFormat) || 'html';
    const singlePageStr = await prompt(rl, 'Single page only? (yes/no)', 'no');
    const singlePage = singlePageStr === 'yes' || singlePageStr === 'y' || singlePageStr === 'true';

    let maxPages = 0;
    let maxDepth = 0;
    let seedSitemaps = false;

    if (!singlePage) {
      const maxPagesStr = await prompt(rl, 'Max pages to crawl (0 = unlimited)', '200');
      maxPages = parseInt(maxPagesStr, 10) || 0;

      const maxDepthStr = await prompt(rl, 'Max link depth (0 = unlimited)', '6');
      maxDepth = parseInt(maxDepthStr, 10) || 0;

      const seedStr = await prompt(rl, 'Seed from sitemap.xml? (yes/no)', 'no');
      seedSitemaps = seedStr === 'yes' || seedStr === 'y' || seedStr === 'true';
    }

    const config = {
      start,
      out,
      format,
      singlePage,
      maxPages,
      maxDepth,
      sameOriginOnly: true,
      seedSitemaps,
    };

    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log('');
    console.log(`Created ${CONFIG_FILE}`);
    console.log('');
    console.log('Run "site-mirror run" to start mirroring!');
  } finally {
    rl.close();
  }
}

async function cmdRun(cwd, cliArgs) {
  const config = await loadConfig(cwd);
  const merged = { ...config, ...cliArgs };

  const format = normalizeFormat(merged.format);
  if (!format) {
    console.error(`Error: Invalid format "${merged.format}". Supported formats: html, react, nextjs`);
    process.exit(1);
  }
  merged.format = format;

  const explicitUrls = parseUrlsString(merged.urls);
  if (explicitUrls.length > 0 && !merged.start) {
    merged.start = explicitUrls[0];
  }

  // Validate required fields
  if (!merged.start && explicitUrls.length === 0) {
    console.error('');
    console.error('Error: No start URL or --urls list specified.');
    console.error('');
    console.error('You can either:');
    console.error('  1. Run "site-mirror init" to create a config file');
    console.error('  2. Pass --start <url> or --urls "<url1>,<url2>", e.g.:');
    console.error('     site-mirror run --start https://example.com/ --format html');
    console.error('     site-mirror run --urls "https://example.com/home,https://example.com/agents" --format react');
    console.error('     site-mirror run --start https://example.com/ --format nextjs');
    console.error('');
    process.exit(1);
  }

  // Validate URL format
  try {
    new URL(merged.start);
  } catch {
    console.error('');
    console.error(`Error: Invalid URL "${merged.start}"`);
    console.error('Please provide a valid URL starting with http:// or https://');
    console.error('');
    process.exit(1);
  }

  console.log('');
  console.log('Configuration:');
  if (explicitUrls.length > 0) {
    console.log(`  urls:           ${explicitUrls.length} specific pages (${explicitUrls[0]}${explicitUrls.length > 1 ? ` + ${explicitUrls.length - 1} more` : ''})`);
  } else {
    console.log(`  start:          ${merged.start}`);
  }
  console.log(`  out:            ${merged.out}`);
  console.log(`  format:         ${merged.format.toUpperCase()}`);
  if (explicitUrls.length > 0) {
    console.log(`  mode:           MULTI-PAGE CHERRY-PICK (${explicitUrls.length} URLs into 1 unified app)`);
  } else if (merged.singlePage) {
    console.log(`  mode:           SINGLE PAGE (no crawling)`);
  } else {
    console.log(`  maxPages:       ${merged.maxPages || 'unlimited'}`);
    console.log(`  maxDepth:       ${merged.maxDepth || 'unlimited'}`);
    console.log(`  seedSitemaps:   ${merged.seedSitemaps}`);
  }
  console.log(`  sameOriginOnly: ${merged.sameOriginOnly}`);
  if (merged.login) {
    console.log(`  login:          INTERACTIVE BROWSER LOGIN`);
  }
  if (merged.auth) {
    console.log(`  auth:           ${merged.auth}`);
  }
  if (merged.cookies) {
    console.log(`  cookies:        ${merged.cookies}`);
  }
  if (merged.waitFor) {
    console.log(`  waitFor:        ${merged.waitFor}ms`);
  }
  if (merged.waitForSelector) {
    console.log(`  waitForSelector:${merged.waitForSelector}`);
  }
  console.log('');

  // Dynamically import the mirror lib
  const { mirrorSite } = await import('../lib/mirror.mjs');
  await mirrorSite({
    start: merged.start,
    urls: explicitUrls,
    out: path.resolve(cwd, merged.out),
    format: merged.format,
    maxPages: explicitUrls.length > 0 ? explicitUrls.length : merged.singlePage ? 1 : merged.maxPages,
    maxDepth: explicitUrls.length > 0 || merged.singlePage ? 0 : merged.maxDepth,
    sameOriginOnly: merged.sameOriginOnly,
    seedSitemaps: explicitUrls.length > 0 || merged.singlePage ? false : merged.seedSitemaps,
    singlePage: merged.singlePage,
    userAgent: merged.userAgent,
    login: Boolean(merged.login),
    authFile: merged.auth ? path.resolve(cwd, merged.auth) : '',
    cookies: merged.cookies || '',
    waitFor: Number(merged.waitFor) || 0,
    waitForSelector: merged.waitForSelector || '',
  });
}

async function cmdLogin(cwd, cliArgs) {
  const config = await loadConfig(cwd);
  const merged = { ...config, ...cliArgs };

  if (!merged.start) {
    console.error('');
    console.error('Error: No login URL specified.');
    console.error('Usage: site-mirror login --start https://app.example.com/login --auth auth.json');
    console.error('');
    process.exit(1);
  }

  try {
    new URL(merged.start);
  } catch {
    console.error(`Error: Invalid URL "${merged.start}"`);
    process.exit(1);
  }

  const saveAuthPath = path.resolve(cwd, merged.auth || 'auth.json');
  const { runInteractiveLogin } = await import('../lib/mirror.mjs');
  await runInteractiveLogin({
    url: merged.start,
    saveAuthPath,
    cookiesInput: merged.cookies || '',
    userAgent: merged.userAgent,
  });

  console.log('');
  console.log('You can now mirror authenticated pages using:');
  console.log(`  site-mirror run --start "${merged.start}" --auth "${merged.auth || 'auth.json'}" --format react`);
  console.log('');
}

async function cmdServe(cwd, explicitDir, port) {
  let outDir = null;

  if (explicitDir) {
    const resolved = path.resolve(cwd, explicitDir);
    const exists = await fs.access(resolved).then(() => true).catch(() => false);
    if (exists) {
      outDir = resolved;
    } else {
      console.error(`Directory not found: ${resolved}`);
      process.exit(1);
    }
  } else {
    const config = await loadConfig(cwd);
    const configOut = config.out ? path.resolve(cwd, config.out) : null;
    const defaultOut = path.join(cwd, 'offline');

    if (configOut) {
      const configExists = await fs.access(configOut).then(() => true).catch(() => false);
      if (configExists) outDir = configOut;
    }

    if (!outDir) {
      const defaultExists = await fs.access(defaultOut).then(() => true).catch(() => false);
      if (defaultExists) outDir = defaultOut;
    }

    if (!outDir) {
      const indexExists = await fs.access(path.join(cwd, 'index.html')).then(() => true).catch(() => false);
      if (indexExists) outDir = cwd;
    }

    if (!outDir) {
      console.error('No output folder found.');
      console.error('');
      console.error('Tried:');
      if (configOut) console.error(`  - ${configOut} (from config)`);
      console.error(`  - ${defaultOut} (default)`);
      console.error(`  - ${cwd} (current directory)`);
      console.error('');
      console.error('Run "site-mirror run" first to download the site.');
      process.exit(1);
    }
  }

  // Detect if outDir is a React (Vite) or Next.js project with a package.json
  const pkgJsonPath = path.join(outDir, 'package.json');
  const hasPkgJson = await fs.access(pkgJsonPath).then(() => true).catch(() => false);

  if (hasPkgJson) {
    const nodeModulesPath = path.join(outDir, 'node_modules');
    const hasNodeModules = await fs.access(nodeModulesPath).then(() => true).catch(() => false);
    if (!hasNodeModules) {
      console.log(`Installing dependencies in ${outDir}...`);
      execSync('npm install', { cwd: outDir, stdio: 'inherit' });
    }
    console.log(`Starting development server in ${outDir} on port ${port}...`);
    try {
      execSync(`npm run dev -- --port ${port}`, { cwd: outDir, stdio: 'inherit' });
    } catch {
      // User closed with Ctrl+C
    }
    return;
  }

  console.log(`Serving ${outDir} on http://localhost:${port}/`);
  try {
    execSync(`npx http-server "${outDir}" -p ${port} -c-1`, { stdio: 'inherit' });
  } catch {
    // User closed with Ctrl+C
  }
}

async function main() {
  const cwd = process.cwd();
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(`
site-mirror - Mirror websites into clean HTML/CSS/JS, React (Vite), or Next.js projects

Usage:
  site-mirror init               Interactive setup - creates site-mirror.config.json
  site-mirror login [options]    Open browser to sign in and save session (auth.json)
  site-mirror run [options]      Mirror the website (reads config + CLI overrides)
  site-mirror serve [dir] [port] Serve the output folder (default port: 8080)

Run options:
  --start <url>             Start URL (required if --urls not used and not in config)
  --urls "<u1> <u2> ..."    Cherry-pick specific URLs into one unified app (space/comma separated)
  --out <dir>               Output directory (default: ./offline)
  --format <type>           Output format: html | react | nextjs (default: html)
  --react                   Shorthand for --format react
  --nextjs                  Shorthand for --format nextjs
  --html                    Shorthand for --format html
  --login                   Open browser window to sign in interactively before mirroring
  --auth <file>             Load/save authenticated session file (e.g. auth.json)
  --cookies <val|file>      Pass cookies (file path or "name=value; name2=value2")
  --waitFor <ms>            Extra wait time (ms) per page for slow async API/chart data
  --waitForSelector <css>   Wait for a specific CSS selector to appear before capturing
  --maxPages <n>            Max pages (0 = unlimited)
  --maxDepth <n>            Max depth (0 = unlimited)
  --seedSitemaps true       Seed from sitemap.xml
  --singlePage              Download only this page + all its assets (no crawling)

Serve options:
  [dir]                 Directory to serve (auto-detects HTML, React, or Next.js)
  [port]                Port number (default: 8080)

Examples:
  site-mirror run --start https://www.anthropic.com/research --singlePage --format html
  site-mirror run --urls "https://platform.openai.com/home https://platform.openai.com/agents https://platform.openai.com/usage?startDate=2026-01-01&endDate=2026-01-31" --login --format react
  site-mirror login --start https://app.example.com/login --auth auth.json
  site-mirror run --start https://app.example.com/dashboard --auth auth.json --format nextjs
  site-mirror run --start https://app.example.com/dashboard --cookies "session_id=xyz123" --format react
  site-mirror serve ./anthropic-research 3000
`);
    return;
  }

  if (command === 'init') {
    await cmdInit(cwd);
  } else if (command === 'login' || command === 'auth') {
    const cliArgs = parseCliArgs(args.slice(1));
    await cmdLogin(cwd, cliArgs);
  } else if (command === 'run') {
    const cliArgs = parseCliArgs(args.slice(1));
    await cmdRun(cwd, cliArgs);
  } else if (command === 'serve') {
    // Parse serve arguments: serve [dir] [port]
    // If arg looks like a number, it's the port; otherwise it's the directory
    let explicitDir = null;
    let port = '8080';
    
    if (args[1]) {
      if (/^\d+$/.test(args[1])) {
        // First arg is a port number
        port = args[1];
      } else {
        // First arg is a directory
        explicitDir = args[1];
        if (args[2] && /^\d+$/.test(args[2])) {
          port = args[2];
        }
      }
    }
    
    await cmdServe(cwd, explicitDir, port);
  } else {
    // Assume it's run with options directly (no subcommand)
    const cliArgs = parseCliArgs(args);
    await cmdRun(cwd, cliArgs);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
