#!/usr/bin/env node
/**
 * qa-a11y — keyboard, focus, contrast and motion checks against the real app.
 *
 * Axe alone misses most of what matters here: it cannot tell that a dock tray
 * only opens on hover, that a focused button looks identical to an unfocused
 * one, or that a city jump still sweeps the camera for three seconds when the
 * visitor asked the OS for reduced motion. Each check below drives the running
 * app the way a keyboard or reduced-motion user would and records PASS/FAIL.
 *
 * Usage:
 *   node scripts/qa-a11y.mjs --url http://localhost:4173
 *   node scripts/qa-a11y.mjs --url http://localhost:4173 --json qa-shots/a11y/report.json
 *
 * The app only needs to boot: a placeholder GOOGLE_MAPS_API_KEY is enough,
 * since none of these checks look at the photorealistic tiles.
 *
 * Exit code is the number of failed checks (0 = all green).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const getOpt = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const APP_URL = getOpt('--url', 'http://localhost:4173').replace(/\/$/, '');
const JSON_OUT = getOpt('--json', null);
const HEADFUL = args.includes('--headful');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
  '/opt/pw-browsers/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

/** WCAG 1.4.3 thresholds; text at least this large only needs 3:1. */
const MIN_CONTRAST = 4.5;
const MIN_CONTRAST_LARGE = 3;
const LARGE_TEXT_PX = 24;
const LARGE_BOLD_TEXT_PX = 18.66;
/** Pure box-drawing glyphs are HUD ornament, not text a reader needs. */
const DECORATIVE_TEXT = /^[\s┌┐└┘─│]+$/;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function launch() {
  const executablePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  return puppeteer.launch({
    executablePath,
    headless: HEADFUL ? false : 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
}

/** Load the app with reduced motion requested and wait for the viewer. */
async function openApp(browser, { dismissLauncher = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(`${APP_URL}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__godsEyeView?.viewer, { timeout: 60_000 });
  // The first-run launcher reveals after the loading cover yields.
  await new Promise((resolve) => setTimeout(resolve, 3500));
  if (dismissLauncher) {
    await page.keyboard.press('Escape');
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return page;
}

/** Tab through the page and describe each stop, including whether focus is visible. */
async function tabStops(page, count) {
  await page.evaluate(() => document.activeElement?.blur());
  const stops = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const focused = getComputedStyle(el);
      const ring = (focused.outlineStyle !== 'none' && parseFloat(focused.outlineWidth) > 0)
        || focused.boxShadow !== 'none';
      const name = (el.getAttribute('aria-label') || el.textContent || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 48);
      return {
        selector: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : ''),
        name,
        ring,
        inLocationBar: !!el.closest('#location-bar'),
      };
    }));
  }
  return stops.filter(Boolean);
}

async function checkLocationTrayKeyboard(page) {
  const stops = await tabStops(page, 40);
  const opener = stops.find((stop) => stop.inLocationBar);
  if (!opener) {
    record('Location tray is reachable by keyboard', false, `no tab stop inside #location-bar across ${stops.length} stops`);
    return;
  }
  // Re-walk to that stop and activate it the way a keyboard user would.
  await page.evaluate(() => document.activeElement?.blur());
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => !!document.activeElement?.closest('#location-bar'))) break;
  }
  await page.keyboard.press('Enter');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const open = await page.evaluate(() => !document.getElementById('location-bar')?.classList.contains('collapsed'));
  record('Location tray is reachable by keyboard', open, open ? `opened from ${opener.selector}` : `${opener.selector} is focusable but Enter leaves the tray collapsed`);
}

async function checkFocusVisible(page) {
  const stops = await tabStops(page, 30);
  const seen = new Map();
  for (const stop of stops) seen.set(`${stop.selector}|${stop.name}`, stop);
  const unique = [...seen.values()];
  const missing = unique.filter((stop) => !stop.ring);
  record(
    'Every tab stop shows a focus ring',
    missing.length === 0,
    missing.length ? `${missing.length}/${unique.length} without outline or box-shadow: ${missing.map((stop) => stop.name || stop.selector).join(', ')}` : `${unique.length} stops`,
  );
}

async function checkContrast(page) {
  const offenders = await page.evaluate(({ MIN_CONTRAST, MIN_CONTRAST_LARGE, LARGE_TEXT_PX, LARGE_BOLD_TEXT_PX, decorative }) => {
    const DECORATIVE = new RegExp(decorative);
    const channels = (color) => (color.match(/[\d.]+/g) || []).map(Number);
    const luminance = ([r, g, b]) => {
      const linear = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    };
    // Nearest mostly-opaque ancestor background; the HUD floats over a dark globe.
    const backgroundOf = (el) => {
      for (let node = el; node; node = node.parentElement) {
        const c = channels(getComputedStyle(node).backgroundColor);
        if (c.length >= 3 && (c[3] ?? 1) > 0.5) return c.slice(0, 3);
      }
      return [10, 11, 15];
    };
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
      if (!text || DECORATIVE.test(text)) continue;
      if (el.closest('[aria-hidden="true"], .material-symbols-outlined, .cesium-widget-credits, #loading-screen')) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden') continue;
      let opacity = 1;
      for (let node = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      if (opacity < 0.05) continue;
      const fg = channels(style.color);
      const bg = backgroundOf(el);
      const alpha = (fg[3] ?? 1) * opacity;
      const blended = fg.slice(0, 3).map((v, i) => v * alpha + bg[i] * (1 - alpha));
      const [hi, lo] = [luminance(blended), luminance(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const size = parseFloat(style.fontSize);
      const large = size >= LARGE_TEXT_PX || (size >= LARGE_BOLD_TEXT_PX && Number(style.fontWeight) >= 700);
      if (ratio < (large ? MIN_CONTRAST_LARGE : MIN_CONTRAST)) {
        out.push({ text: text.slice(0, 28), id: el.id, cls: typeof el.className === 'string' ? el.className.split(' ')[0] : '', size, ratio: Number(ratio.toFixed(2)) });
      }
    }
    return out.sort((a, b) => a.ratio - b.ratio);
  }, { MIN_CONTRAST, MIN_CONTRAST_LARGE, LARGE_TEXT_PX, LARGE_BOLD_TEXT_PX, decorative: DECORATIVE_TEXT.source });
  const worst = offenders.slice(0, 8).map((o) => `"${o.text}" ${o.ratio}:1 @${o.size}px`).join('; ');
  record('Visible chrome text meets WCAG AA contrast', offenders.length === 0, offenders.length ? `${offenders.length} below threshold; worst: ${worst}` : '');
  const tiny = offenders.filter((o) => o.size < 9);
  record('No readable text below 9px', tiny.length === 0, tiny.length ? tiny.map((o) => `"${o.text}" @${o.size}px`).join('; ') : '');
}

async function checkReducedMotionCityJump(page) {
  // Under prefers-reduced-motion a preset jump should land (near) instantly
  // instead of a multi-second fly-through.
  const sample = () => page.evaluate(() => {
    const { x, y, z } = window.__godsEyeView.viewer.camera.positionWC;
    return [x, y, z];
  });
  await page.evaluate(() => document.querySelector('[data-collapse-target="location-bar"], [data-dock-toggle-target="location-bar"]')?.click());
  await page.evaluate(() => document.getElementById('location-bar')?.classList.remove('collapsed'));
  const before = await sample();
  const clicked = await page.evaluate(() => {
    const pill = [...document.querySelectorAll('.location-pill')].find((p) => p.dataset.locationId !== document.querySelector('.location-pill.active')?.dataset.locationId);
    pill?.click();
    return pill?.dataset.locationId;
  });
  const started = Date.now();
  let settledAt = null;
  let last = before;
  while (Date.now() - started < 8000) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const now = await sample();
    const step = Math.hypot(now[0] - last[0], now[1] - last[1], now[2] - last[2]);
    if (step < 1 && Math.hypot(now[0] - before[0], now[1] - before[1], now[2] - before[2]) > 1) {
      settledAt ??= Date.now() - started;
      break;
    }
    last = now;
  }
  // 600 ms leaves room for the app's deferred-navigation handoff and a short
  // cross-fade, but not for a globe-spanning fly-through.
  record(
    'City jump honors prefers-reduced-motion',
    settledAt !== null && settledAt <= 600,
    settledAt === null ? `jump to ${clicked} never settled within 8 s` : `jump to ${clicked} settled after ~${settledAt} ms`,
  );
}

async function checkRunningAnimations(page) {
  // Only motion a visitor can see counts; the hidden loading cover keeps its
  // pulse running at opacity 0, which costs frames but moves nothing on screen.
  const running = await page.evaluate(() => document.getAnimations()
    .filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime) === false)
    .filter((a) => {
      const target = a.effect?.target;
      if (!target || getComputedStyle(target).visibility === 'hidden') return false;
      let opacity = 1;
      for (let node = target; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      return opacity > 0.05;
    })
    .map((a) => a.animationName || a.constructor.name));
  record('No infinite CSS animation runs under reduced motion', running.length === 0, running.length ? running.join(', ') : '');
}

async function checkLauncherDialog(browser) {
  const page = await openApp(browser, { dismissLauncher: false });
  const info = await page.evaluate(() => {
    const dialog = document.querySelector('#first-run-launcher');
    if (!dialog || dialog.hidden) return null;
    return {
      native: dialog.tagName === 'DIALOG',
      role: dialog.getAttribute('role'),
      modal: dialog.getAttribute('aria-modal') === 'true' || (dialog.tagName === 'DIALOG' && dialog.matches(':modal')),
      labelled: !!dialog.getAttribute('aria-labelledby'),
      focusInside: dialog.contains(document.activeElement),
    };
  });
  if (!info) {
    record('First-run launcher is an accessible modal', true, 'launcher not shown (already dismissed in this profile)');
  } else {
    const ok = (info.native || info.role === 'dialog') && info.modal && info.labelled && info.focusInside;
    record('First-run launcher is an accessible modal', ok, JSON.stringify(info));
  }
  await page.close();
}

async function checkAxe(page) {
  let axePath;
  try { axePath = require.resolve('axe-core/axe.min.js'); } catch {
    record('axe-core WCAG 2.1 AA scan', true, 'skipped: axe-core is not installed (npm i -D axe-core)');
    return;
  }
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => (await window.axe.run(document, {
    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
  })).violations.map((v) => `${v.id} (${v.nodes.length})`));
  record('axe-core WCAG 2.1 AA scan', violations.length === 0, violations.join(', '));
}

const browser = await launch();
try {
  console.log(`qa-a11y against ${APP_URL}`);
  await checkLauncherDialog(browser);
  const page = await openApp(browser);
  await checkLocationTrayKeyboard(page);
  await checkFocusVisible(page);
  await checkContrast(page);
  await checkRunningAnimations(page);
  await checkAxe(page);
  await checkReducedMotionCityJump(page);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (JSON_OUT) {
  const target = path.resolve(ROOT, JSON_OUT);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ url: APP_URL, results }, null, 2));
}
process.exit(failed);
