#!/usr/bin/env node
/**
 * Post-install script to ensure Playwright browsers are available.
 * Runs automatically after `npm install`.
 */
import { execSync } from 'node:child_process';

console.log('[webmirror] Checking Playwright browsers...');

try {
  execSync('npx playwright install chromium', { stdio: 'inherit' });
  console.log('[webmirror] Chromium browser ready.');
} catch (err) {
  console.warn('[webmirror] Could not auto-install Chromium. Run manually: npx playwright install chromium');
}
