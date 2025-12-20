#!/usr/bin/env node
/**
 * webmirror CLI
 *
 * Usage:
 *   webmirror init                  Interactive setup - creates webmirror.config.json
 *   webmirror run [options]         Run the mirror (reads config + CLI overrides)
 *   webmirror serve [port]          Serve the offline folder locally
 *
 * Options (for run):
 *   --start <url>         Start URL (required if not in config)
 *   --out <dir>           Output directory (default: ./offline)
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
import { execSync, spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = 'webmirror.config.json';

const defaultConfig = {
  start: '',
  out: './offline',
  maxPages: 0,
  maxDepth: 0,
  sameOriginOnly: true,
  seedSitemaps: false,
  singlePage: false,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
};

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
    } else if (key === '--out') {
      args.out = next;
      i++;
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
    } else if (key === '--userAgent') {
      args.userAgent = next;
      i++;
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
  console.log('Welcome to webmirror! Let\'s set up your config.');
  console.log('Press Enter to accept the default value shown in parentheses.');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const start = await prompt(rl, 'Website URL to mirror', 'https://example.com/');
    const out = await prompt(rl, 'Output directory', './offline');
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
    console.log('Run "webmirror run" to start mirroring!');
  } finally {
    rl.close();
  }
}

async function cmdRun(cwd, cliArgs) {
  const config = await loadConfig(cwd);
  const merged = { ...config, ...cliArgs };

  // Validate required fields
  if (!merged.start) {
    console.error('');
    console.error('Error: No start URL specified.');
    console.error('');
    console.error('You can either:');
    console.error('  1. Run "webmirror init" to create a config file');
    console.error('  2. Pass --start <url> directly, e.g.:');
    console.error('     webmirror run --start https://example.com/');
    console.error('     webmirror run --start https://example.com/page --singlePage');
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
  console.log(`  start:          ${merged.start}`);
  console.log(`  out:            ${merged.out}`);
  if (merged.singlePage) {
    console.log(`  mode:           SINGLE PAGE (no crawling)`);
  } else {
    console.log(`  maxPages:       ${merged.maxPages || 'unlimited'}`);
    console.log(`  maxDepth:       ${merged.maxDepth || 'unlimited'}`);
    console.log(`  seedSitemaps:   ${merged.seedSitemaps}`);
  }
  console.log(`  sameOriginOnly: ${merged.sameOriginOnly}`);
  console.log('');

  // Dynamically import the mirror lib
  const { mirrorSite } = await import('../lib/mirror.mjs');
  await mirrorSite({
    start: merged.start,
    out: path.resolve(cwd, merged.out),
    maxPages: merged.singlePage ? 1 : merged.maxPages,
    maxDepth: merged.singlePage ? 0 : merged.maxDepth,
    sameOriginOnly: merged.sameOriginOnly,
    seedSitemaps: merged.singlePage ? false : merged.seedSitemaps,
    singlePage: merged.singlePage,
    userAgent: merged.userAgent,
  });
}

async function cmdServe(cwd, port) {
  const outDir = path.join(cwd, 'offline');
  const exists = await fs
    .access(outDir)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    console.error(`No offline folder found at ${outDir}`);
    console.error('Run "webmirror run" first to download the site.');
    process.exit(1);
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
webmirror - Mirror websites for offline browsing

Usage:
  webmirror init               Interactive setup - creates webmirror.config.json
  webmirror run [options]      Mirror the website (reads config + CLI overrides)
  webmirror serve [port]       Serve the offline folder (default port: 8080)

Run options:
  --start <url>         Start URL (required if not in config)
  --out <dir>           Output directory (default: ./offline)
  --maxPages <n>        Max pages (0 = unlimited)
  --maxDepth <n>        Max depth (0 = unlimited)
  --seedSitemaps true   Seed from sitemap.xml
  --singlePage          Download only this page + all its assets (no crawling)

Examples:
  webmirror run --start https://example.com/page --singlePage
  webmirror init
  webmirror run
  webmirror serve 3000
`);
    return;
  }

  if (command === 'init') {
    await cmdInit(cwd);
  } else if (command === 'run') {
    const cliArgs = parseCliArgs(args.slice(1));
    await cmdRun(cwd, cliArgs);
  } else if (command === 'serve') {
    const port = args[1] || '8080';
    await cmdServe(cwd, port);
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
