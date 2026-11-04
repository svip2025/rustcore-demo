import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { access, mkdir, readdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(homedir(), '.npm/_npx');
let playwright;
for (const directory of await readdir(cache)) {
  const candidate = join(cache, directory, 'node_modules/playwright/index.mjs');
  try { await access(candidate); playwright = await import(pathToFileURL(candidate).href); break; } catch {}
}
if (!playwright) throw new Error('Existing Playwright module not found; no installation was attempted.');
const chromePath = process.env.CHROME_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
await access(chromePath);
const url = process.argv[2] ?? 'http://127.0.0.1:4173';
await mkdir(join(webRoot, 'qa'), { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  // An unavailable caller closes an otherwise valid empty SSE stream. This tests
  // the real EventSource error -> replay path without a deliberate HTTP error.
  await page.route('**/config.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ api_base: '', live_enabled: true }) }));
  await page.route('**/api/stream*', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': isolated unavailable caller\n\n' }));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#dashboard[aria-busy="false"]');
  await page.waitForFunction(() => document.querySelector('#replay-mode')?.getAttribute('aria-pressed') === 'true');
  assert.match(await page.locator('#source-badge').innerText(), /MOCK|假数据/);
  assert.equal(await page.locator('#recording-select').inputValue(), 'mock-success-v1');
  checks.push('Unavailable caller automatically selects replay; MOCK source is visible; latest successful recording is default.');

  async function seek(offset, expected) {
    await page.locator('#replay-progress').evaluate((input, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, offset);
    const rendered = await page.evaluate(() => {
      const metric = (label) => [...document.querySelectorAll('.metric')].find((element) => element.querySelector('.metric-label')?.textContent?.includes(label));
      const panel = (label) => [...document.querySelectorAll('article.panel')].find((element) => element.querySelector('h2')?.textContent === label);
      const risk = [...document.querySelectorAll('.risk-cell')].find((element) => element.querySelector('h3')?.textContent === '风险预算新鲜度');
      const leg = (label) => [...document.querySelectorAll('.protection-leg')].find((element) => element.querySelector('strong')?.textContent?.includes(label))?.querySelector('.status-pill')?.textContent?.trim() ?? '';
      return {
        kernel: metric('rustcore 内核')?.querySelector('.metric-value')?.textContent?.trim() ?? '',
        'positions-status': panel('持仓与保护')?.querySelector('.panel-heading .status-pill')?.textContent?.trim() ?? '',
        'orders-status': panel('未成交订单')?.querySelector('.panel-heading .status-pill')?.textContent?.trim() ?? '',
        'budget-status': risk?.querySelector('.risk-main')?.textContent?.trim() ?? '',
        sl: leg('止损'), tp: leg('止盈'),
        'round-status': document.querySelector('.round-summary .status-pill')?.textContent?.trim() ?? '',
      };
    });
    const labels = { OFFLINE: '离线', ONLINE: '在线', STALE: '已过期', FRESH: '有效', UNKNOWN: '未证实', AVAILABLE: '完整可用', PASS: '通过', FAIL: '失败', FAILED: '失败' };
    for (const [key, value] of Object.entries(expected)) assert.ok(rendered[key].includes(labels[value]), `${offset}ms ${key}: expected ${labels[value]}, saw ${rendered[key]}`);
    checks.push({ offset_ms: offset, ...expected });
  }
  await seek(54000, { kernel: 'OFFLINE', 'positions-status': 'STALE', 'orders-status': 'STALE', 'budget-status': 'FRESH' });
  await seek(84000, { kernel: 'OFFLINE', 'budget-status': 'STALE' });
  await seek(90000, { kernel: 'ONLINE', 'positions-status': 'UNKNOWN', 'orders-status': 'UNKNOWN', 'budget-status': 'STALE' });
  await seek(94000, { kernel: 'ONLINE', 'positions-status': 'AVAILABLE', 'budget-status': 'FRESH', sl: 'PASS', tp: 'PASS' });
  await page.screenshot({ path: join(webRoot, 'qa/desktop.png'), fullPage: true });
  await page.locator('#recording-select').selectOption('mock-failure-v1');
  await seek(18000, { sl: 'PASS', tp: 'FAIL' });
  await seek(30100, { 'round-status': 'FAILED' });
  assert.match(await page.locator('#dashboard').innerText(), /失败|FAILED/);
  checks.push('Failure remains visible after successful safety cleanup.');

  const inputs = await page.locator('button,select,input').evaluateAll((elements) => elements.map((element) => ({
    tag: element.tagName,
    id: element.id,
    accessible: Boolean(element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || element.textContent?.trim() || (element.id && document.querySelector(`label[for="${element.id}"]`))),
  })));
  assert.ok(inputs.every((input) => input.accessible), 'Interactive controls must have a visible label or accessible name.');
  checks.push('All interactive controls have a visible label or accessible name.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#recording-select').selectOption('mock-success-v1');
  await seek(94000, { kernel: 'ONLINE', sl: 'PASS', tp: 'PASS' });
  const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(layout.document <= layout.viewport && layout.body <= layout.viewport, `Mobile horizontal overflow: ${JSON.stringify(layout)}`);
  await page.screenshot({ path: join(webRoot, 'qa/mobile.png'), fullPage: true });
  checks.push({ mobile_layout: layout });
  const recording = JSON.parse(await readFile(join(webRoot, '../recordings/mock-success-v1.json'), 'utf8'));
  const { seekRecording } = await import(pathToFileURL(join(webRoot, 'dist/assets/model.js')).href);
  const baseline = seekRecording(recording, 54000);
  const recovery = seekRecording(recording, 94000);
  const subscribers = new Set();
  const event = (type, data, id) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ schema_version: 1, event_id: id, emitted_at: data.generated_at, source: recording.source, type, data })}\n\n`;
  const mock = createServer(async (request, response) => {
    if (request.url === '/config.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ api_base: '', live_enabled: true }));
    } else if (request.url?.startsWith('/api/stream')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      response.write(event('state', baseline.state, 'qa-live-state-baseline'));
      response.write(event('timeline', baseline.timeline, 'qa-live-timeline-baseline'));
      subscribers.add(response);
      response.on('close', () => subscribers.delete(response));
    } else {
      try {
        const upstream = await fetch(new URL(request.url ?? '/', url));
        response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream', 'Content-Security-Policy': upstream.headers.get('content-security-policy') ?? "default-src 'self'" });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { response.writeHead(502); response.end(); }
    }
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const livePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  livePage.on('pageerror', (error) => errors.push(`SSE page: ${error.message}`));
  livePage.on('console', (message) => { if (message.type() === 'error') errors.push(`SSE console: ${message.text()}`); });
  try {
    await livePage.goto(`http://127.0.0.1:${mock.address().port}`, { waitUntil: 'domcontentloaded' });
    await livePage.waitForFunction(() => document.querySelector('#mode-badge')?.textContent?.includes('实时模式'));
    const kernel = livePage.locator('.metric').filter({ hasText: 'rustcore 内核' }).locator('.metric-value');
    assert.match(await kernel.innerText(), /离线/);
    for (const response of subscribers) {
      response.write(event('state', recovery.state, 'qa-live-state-recovery'));
      response.write(event('timeline', recovery.timeline, 'qa-live-timeline-recovery'));
    }
    await livePage.waitForFunction(() => [...document.querySelectorAll('.metric')].find((element) => element.textContent.includes('rustcore 内核'))?.querySelector('.metric-value')?.textContent.includes('在线'));
    assert.match(await livePage.locator('.protection-leg').filter({ hasText: '止损' }).locator('.status-pill').innerText(), /通过/);
    assert.match(await livePage.locator('.protection-leg').filter({ hasText: '止盈' }).locator('.status-pill').innerText(), /通过/);
    for (const response of subscribers) response.end();
    await livePage.waitForFunction(() => document.querySelector('#mode-badge')?.textContent === '回放模式');
    checks.push('Real browser SSE establishes complete baseline, applies recovery update, and switches to replay when stream closes.');
  } finally {
    for (const response of subscribers) response.end();
    await livePage.close();
    await new Promise((resolve) => mock.close(resolve));
  }
  assert.deepEqual(errors, [], 'No browser console or page errors.');
  await writeFile(join(webRoot, 'qa/summary.json'), JSON.stringify({ browser: { url, checks, errors } }, null, 2) + '\n');
  console.log(JSON.stringify({ url, passed: true, checks: checks.length, errors }, null, 2));
} finally {
  await browser.close();
}
