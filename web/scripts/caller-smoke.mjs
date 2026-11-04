import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = new URL(process.argv[2] ?? 'http://127.0.0.1:4173');
const evidenceRoot = join(webRoot, 'qa');
const cache = join(homedir(), '.npm/_npx');
let playwright;
for (const directory of await readdir(cache)) {
  const entry = join(cache, directory, 'node_modules/playwright/index.mjs');
  try { await access(entry); playwright = await import(pathToFileURL(entry).href); break; } catch {}
}
if (!playwright) throw new Error('Existing Playwright module not found; no installation was attempted.');
const chromePath = process.env.CHROME_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
await access(chromePath);
await mkdir(evidenceRoot, { recursive: true });

async function json(path) {
  const response = await fetch(new URL(path, baseUrl), { method: 'GET', signal: AbortSignal.timeout(15_000), cache: 'no-store' });
  assert.equal(response.status, 200, `GET ${path} must succeed`);
  return response.json();
}
const index = await json('recordings/index.json');
assert.equal(index.schema_version, 1);
assert.equal(index.recordings.length, 6, 'The public replay list must contain the six actual runs.');
assert.ok(index.recordings.every(item => item.source.kind === 'TESTNET'), 'MOCK files must not appear in the actual-run list.');
const successful = index.recordings.filter(item => item.status === 'SUCCEEDED');
const failures = index.recordings.filter(item => item.status === 'FAILED');
assert.equal(successful.length, 1);
assert.equal(failures.length, 5);
assert.equal(index.default_id, successful[0].id, 'The real successful run must be the replay default.');
const records = new Map(await Promise.all(index.recordings.map(async entry => [entry.id, await json(entry.file)])));
const finalRound = recording => recording.events.findLast(event => event.type === 'round')?.data
  ?? [...recording.initial_timeline.rounds].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0];

const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const evidence = {
  checked_at: new Date().toISOString(),
  url: baseUrl.origin,
  scope: 'Read-only browser integration with the actual caller through the configured local proxy; no trading requests or process restarts.',
  index: { count: index.recordings.length, succeeded: successful.length, failed: failures.length, default_id: index.default_id },
  checks: [],
  errors: [],
};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' });
  // This adds observation only. The EventSource, its URL, and its messages stay real.
  await context.addInitScript(() => {
    window.__callerQa = { states: [], renders: [] };
    const Original = window.EventSource;
    window.EventSource = new Proxy(Original, {
      construct(target, args) {
        const stream = Reflect.construct(target, args);
        stream.addEventListener('state', message => {
          try {
            const event = JSON.parse(message.data);
            window.__callerQa.states.push({
              id: event.event_id,
              received_ms: performance.now(),
              generated_at: event.data.generated_at,
              build: event.data.build,
              source: event.source,
              rustcore: event.data.rustcore.status,
              positions_as_of: event.data.positions.source_as_of,
            });
          } catch {}
        });
        return stream;
      },
    });
    const observe = () => {
      const dashboard = document.querySelector('#dashboard');
      if (!dashboard) return;
      new MutationObserver(() => {
        const qa = window.__callerQa;
        const latest = qa.states.at(-1);
        if (!latest || !document.querySelector('#mode-badge')?.textContent?.includes('实时模式')) return;
        if (qa.renders.some(item => item.id === latest.id)) return;
        qa.renders.push({ id: latest.id, received_ms: latest.received_ms, rendered_ms: performance.now(), generated_at: latest.generated_at });
      }).observe(dashboard, { childList: true, subtree: true, characterData: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true });
    else observe();
  });
  const page = await context.newPage();
  page.on('pageerror', error => evidence.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') evidence.errors.push(`console: ${message.text()}`); });
  await page.goto(baseUrl.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#mode-badge')?.textContent?.includes('实时模式'), null, { timeout: 20_000 });
  assert.match(await page.locator('#source-badge').innerText(), /TESTNET/);
  assert.doesNotMatch(await page.locator('#source-badge').innerText(), /MOCK|假数据/);
  const liveRoundOptions = await page.locator('#round-select option').evaluateAll(options => options.map(option => ({ id: option.value, label: option.textContent })));
  assert.equal(liveRoundOptions.length, 6);
  assert.equal(liveRoundOptions.filter(option => option.label.includes('成功')).length, 1);
  assert.equal(liveRoundOptions.filter(option => option.label.includes('失败')).length, 5);
  assert.ok(liveRoundOptions.every(option => option.label.includes('手动')));
  evidence.checks.push('Actual SSE establishes live + TESTNET; all six MANUAL rounds are selectable with one success and five failures.');

  await page.waitForFunction(() => {
    const qa = window.__callerQa;
    return new Set(qa?.states.map(item => item.generated_at)).size >= 2 && qa.renders.length >= 2;
  }, null, { timeout: 25_000 });
  const observed = await page.evaluate(() => window.__callerQa);
  assert.ok(observed.states.every(state => state.source.kind === 'TESTNET'));
  const renders = observed.renders.map(render => ({
    event_id: render.id,
    generated_at: render.generated_at,
    receive_to_render_ms: Number((render.rendered_ms - render.received_ms).toFixed(3)),
  }));
  evidence.live = {
    source: observed.states.at(-1).source,
    build: observed.states.at(-1).build,
    state_generated_at: [...new Set(observed.states.map(item => item.generated_at))],
    browser_receive_to_render: renders,
    latency_scope: 'Browser state-event receipt to DOM update, including initial timeline-baseline wait; excludes exchange, caller, SSH/network latency and cross-host clock offsets.',
  };
  evidence.checks.push('At least two distinct real state.generated_at values reached the browser and triggered live dashboard rendering; heartbeat was not counted as a state update.');
  await page.screenshot({ path: join(evidenceRoot, 'caller-live.png'), fullPage: true });

  await page.locator('#replay-mode').click();
  await page.waitForFunction(() => document.querySelector('#mode-badge')?.textContent === '回放模式');
  await page.waitForFunction(id => document.querySelector('#recording-select')?.value === id, index.default_id);
  const replayOptions = await page.locator('#recording-select option').evaluateAll(options => options.map(option => ({ id: option.value, label: option.textContent })));
  assert.equal(replayOptions.length, 6);
  assert.equal(new Set(replayOptions.map(option => option.id)).size, 6);
  assert.equal(new Set(replayOptions.map(option => option.label)).size, 6, 'Round labels must distinguish all five failures.');
  assert.deepEqual(new Set(replayOptions.map(option => option.id)), new Set(index.recordings.map(entry => entry.id)));
  assert.match(await page.locator('#source-badge').innerText(), /TESTNET/);
  evidence.checks.push('Entering replay selects the actual successful recording by default; all six real runs have distinct selectable labels.');
  await page.locator('.recording-history-panel > summary').click();
  assert.equal(await page.locator('#recording-history > li').count(), 6);
  for (const entry of index.recordings) {
    const item = page.locator('#recording-history > li').filter({ has: page.locator(`button[data-recording-id="${entry.id}"]`) });
    assert.equal(await item.locator('p').innerText(), finalRound(records.get(entry.id)).reason);
    assert.ok(await item.locator('p').isVisible());
  }
  await page.locator('.recording-history-panel > summary').click();
  evidence.checks.push('The expanded recording-history list visibly retains all six original outcome reasons.');


  async function selectAndFinish(entry) {
    const recording = records.get(entry.id);
    const round = finalRound(recording);
    await page.locator('#recording-select').selectOption(entry.id);
    await page.waitForFunction(({ id, started }) =>
      document.querySelector('#recording-select')?.value === id
      && document.querySelector('#recording-date')?.textContent?.includes(started),
    { id: entry.id, started: recording.started_at.replace('T', ' ').slice(0, 19) });
    await page.locator('#replay-progress').evaluate(input => {
      input.value = input.max;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(id => document.querySelector('.round-id')?.textContent === id, round.round_id);
    const result = await page.locator('.round-summary .status-pill').innerText();
    assert.match(result, round.status === 'FAILED' ? /失败/ : /成功/);
    assert.equal(await page.locator('.round-reason').innerText(), round.reason);
    assert.match(await page.locator('#source-badge').innerText(), /TESTNET/);
    return {
      recording_id: entry.id,
      round_id: round.round_id,
      status: round.status,
      reason: round.reason,
      trigger: round.trigger,
      original_build: recording.build,
    };
  }
  const success = await selectAndFinish(successful[0]);
  assert.equal(await page.locator('.timeline-step').count(), 9);
  const successfulSteps = await page.locator('.timeline-step .step-meta > .status-pill').allTextContents();
  assert.equal(successfulSteps.length, 9);
  assert.ok(successfulSteps.every(text => text.includes('通过')));
  evidence.successful_replay = { ...success, steps: successfulSteps.length, all_pass: true };
  evidence.failed_replays = [];
  for (const entry of failures) evidence.failed_replays.push(await selectAndFinish(entry));
  evidence.checks.push('The successful replay ends with nine PASS steps; each of the five failed recordings can be selected and retains its original FAILED reason at the end.');
  evidence.checks.push('Historical replay build identifiers are read from their original recordings; the live build is recorded separately.');
  await selectAndFinish(successful[0]);
  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(layout.document <= layout.viewport && layout.body <= layout.viewport, `Mobile horizontal overflow: ${JSON.stringify(layout)}`);
  await page.screenshot({ path: join(evidenceRoot, 'caller-replay.png'), fullPage: true });
  evidence.mobile_layout = layout;
  evidence.checks.push('The 390px mobile layout has no page-level horizontal overflow.');

  // Failure is isolated to this browser context. The actual caller is left running.
  const disconnected = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await disconnected.route('**/api/stream*', route => route.abort('failed'));
  const fallback = await disconnected.newPage();
  await fallback.goto(baseUrl.href, { waitUntil: 'domcontentloaded' });
  await fallback.waitForFunction(() => document.querySelector('#mode-badge')?.textContent === '回放模式'
    && document.querySelector('#connection-message')?.textContent?.includes('自动切换'), null, { timeout: 15_000 });
  assert.equal(await fallback.locator('#recording-select').inputValue(), index.default_id);
  assert.match(await fallback.locator('#source-badge').innerText(), /TESTNET/);
  await disconnected.close();
  evidence.checks.push('An isolated failed SSE connection falls back to the successful TESTNET replay; no caller or trading process is stopped.');
  assert.deepEqual(evidence.errors, [], 'The actual-caller browser page must have no console or page errors.');
  evidence.passed = true;
  await writeFile(join(evidenceRoot, 'caller-integration.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks: evidence.checks.length, source: evidence.live.source, state_updates: evidence.live.state_generated_at.length, first_state_receive_to_render_ms: renders[0]?.receive_to_render_ms, failed_recordings: evidence.failed_replays.length, errors: evidence.errors }, null, 2));
} catch (error) {
  evidence.passed = false;
  evidence.failure = error instanceof Error ? error.message : String(error);
  await writeFile(join(evidenceRoot, 'caller-integration.json'), JSON.stringify(evidence, null, 2) + '\n');
  throw error;
} finally {
  await browser.close();
}
