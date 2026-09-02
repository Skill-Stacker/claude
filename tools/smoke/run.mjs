#!/usr/bin/env node
// tools/smoke/run.mjs: starts the real server in-process against a temp
// base dir, wires the fake routes from mock-routes.mjs, drives the page
// with headless Chromium, and asserts the flows called out in the task.
// Exits non-zero on any failure. Screenshots land in tools/smoke/out/.

import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { startServer } from '../../app/server.js';
import { findFreePort } from '../../app/lib/security.js';
import { wireMocks } from './mock-routes.mjs';

const WAIT = 15000;
const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, 'out');
mkdirSync(OUT_DIR, { recursive: true });

const CHROMIUM_FALLBACKS = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
];

function log(...args) {
  console.log('[smoke]', ...args);
}

async function launchChromium() {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    log('default chromium.launch() failed, trying a known browser path:', err.message);
    for (const executablePath of CHROMIUM_FALLBACKS) {
      if (!existsSync(executablePath)) continue;
      try {
        return await chromium.launch({ headless: true, executablePath });
      } catch (fallbackErr) {
        log('launch with', executablePath, 'also failed:', fallbackErr.message);
      }
    }
    throw err;
  }
}

async function main() {
  const baseDir = mkdtempSync(join(tmpdir(), 'stickos-smoke-'));
  const port = await findFreePort(47390, 30);
  const app = await startServer({ baseDir, port });
  wireMocks(app);
  log('server ready at', app.origin);

  const browser = await launchChromium();
  const consoleErrors = [];
  const pageErrors = [];
  let shot = 0;
  async function screenshot(page, name) {
    shot += 1;
    await page.screenshot({ path: join(OUT_DIR, String(shot).padStart(2, '0') + '-' + name + '.png') });
  }

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    page.setDefaultTimeout(WAIT);
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const url = (msg.location() && msg.location().url) || '';
      // lamp.js and voice.js belong to a different module of this build and
      // do not exist yet; index.html's own try/catch around their dynamic
      // import handles that gracefully, but the browser still logs the
      // failed fetch itself as a console error. That is expected at this
      // milestone, not a real page error, so it is not counted here.
      if (url.endsWith('/lamp.js') || url.endsWith('/voice.js') || url.endsWith('/favicon.ico')) return;
      consoleErrors.push(msg.text() + (url ? ' (' + url + ')' : ''));
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    log('loading the page');
    await page.goto(app.origin + '/', { waitUntil: 'load' });

    log('checking the boot overlay appears');
    await page.locator('#boot').waitFor({ state: 'visible', timeout: WAIT });
    await screenshot(page, 'boot');

    // The mock's first attempt deliberately fails on the model step, the
    // same way app/lib/firstrun.js can on real flaky hardware, so this
    // exercises the 'failed' phase and its Try Again button before the
    // retry walks probing and starting through to ready.
    log('checking the boot overlay shows the failure and offers Try Again');
    const retryBtn = page.locator('#bootRetryBtn');
    await retryBtn.waitFor({ state: 'visible', timeout: WAIT });
    await screenshot(page, 'boot-failed');
    await retryBtn.click();

    log('checking the boot overlay hides after the retry succeeds');
    await page.locator('#boot').waitFor({ state: 'hidden', timeout: WAIT });

    log('checking the desktop and the Scout window render');
    await page.locator('#desktop').waitFor({ state: 'visible', timeout: WAIT });
    await page.locator('#win-chat').waitFor({ state: 'visible', timeout: WAIT });
    await screenshot(page, 'desktop');

    log('creating and selecting a profile');
    const profileOverlay = page.locator('.profile-overlay');
    await profileOverlay.waitFor({ state: 'visible', timeout: WAIT });
    await profileOverlay.locator('.profile-new input').fill('Smoke Test Family');
    await profileOverlay.getByRole('button', { name: 'Add' }).click();
    await profileOverlay.waitFor({ state: 'hidden', timeout: WAIT });
    await page.locator('#profileChip').waitFor({ state: 'visible', timeout: WAIT });
    await screenshot(page, 'profile');

    log('asking a plain question');
    const chatWin = page.locator('#win-chat');
    const chatInput = chatWin.locator('textarea');
    const sendBtn = chatWin.getByRole('button', { name: 'Send', exact: true });
    await chatInput.fill('What is the capital of France?');
    await sendBtn.click();
    await chatWin.locator('.msg.ai', { hasText: 'You said' }).first().waitFor({ state: 'visible', timeout: WAIT });

    log('checking a source chip rendered');
    await chatWin.locator('.source-chip').first().waitFor({ state: 'visible', timeout: WAIT });
    await screenshot(page, 'chat');

    log('asking Scout to add something to the calendar');
    await chatInput.fill('add dinner to my calendar Friday');
    await sendBtn.click();
    const confirmCard = chatWin.locator('.confirm-card').last();
    await confirmCard.waitFor({ state: 'visible', timeout: WAIT });
    await confirmCard.getByRole('button', { name: 'Yes' }).click();
    const confirmResult = confirmCard.locator('.confirm-result');
    await confirmResult.waitFor({ state: 'visible', timeout: WAIT });
    const resultText = (await confirmResult.textContent()) || '';
    assert.ok(resultText.trim().length > 0, 'expected the confirm card to show a result after clicking Yes');
    await screenshot(page, 'confirm');

    // The Scout window is open and sitting over part of the desktop icon
    // grid at this point, same as any real window would; the Start menu is
    // the reliable way to reach another window regardless, so the rest of
    // this script uses it instead of the icons underneath.
    async function openFromStartMenu(label) {
      await page.locator('#startBtn').click();
      await page.locator('#startmenu').waitFor({ state: 'visible', timeout: WAIT });
      await page.locator('#startmenu .smi', { hasText: label }).click();
    }

    log('walking through Connect step one');
    await openFromStartMenu('Connect');
    const connectWin = page.locator('#win-connect');
    await connectWin.waitFor({ state: 'visible', timeout: WAIT });
    await connectWin.locator('h2', { hasText: 'Connect Gmail and Calendar' }).waitFor({ state: 'visible', timeout: WAIT });
    await connectWin.getByRole('button', { name: 'Next', exact: true }).click();
    await connectWin.locator('h2', { hasText: 'Set a PIN first' }).waitFor({ state: 'visible', timeout: WAIT });
    await screenshot(page, 'connect');

    log('checking the netlog window lists entries');
    await openFromStartMenu('What Scout Just Did');
    const netlogWin = page.locator('#win-netlog');
    await netlogWin.waitFor({ state: 'visible', timeout: WAIT });
    await netlogWin.locator('.netlog-row').first().waitFor({ state: 'visible', timeout: WAIT });
    const rowCount = await netlogWin.locator('.netlog-row').count();
    assert.ok(rowCount > 0, 'expected at least one netlog row');
    await screenshot(page, 'netlog');

    assert.deepEqual(consoleErrors, [], 'no console errors expected, got: ' + JSON.stringify(consoleErrors));
    assert.deepEqual(pageErrors, [], 'no page errors expected, got: ' + JSON.stringify(pageErrors));

    log('all checks passed');
    await browser.close();
    await app.close();
    process.exit(0);
  } catch (err) {
    console.error('[smoke] FAILED:', err);
    if (consoleErrors.length) console.error('[smoke] console errors seen:', consoleErrors);
    if (pageErrors.length) console.error('[smoke] page errors seen:', pageErrors);
    try {
      await browser.close();
    } catch {
      // already gone
    }
    try {
      await app.close();
    } catch {
      // already gone
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[smoke] fatal error', err);
  process.exit(1);
});
