import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { readdir, access, mkdir, writeFile, mkdtemp, rm, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function cachedModule(packageName, entry) {
  const cache = join(homedir(), '.npm/_npx');
  for (const directory of await readdir(cache)) {
    const candidate = join(cache, directory, 'node_modules', packageName, entry);
    try { await access(candidate); return import(pathToFileURL(candidate).href); } catch {}
  }
  throw new Error(`Existing ${packageName} module not found; no installation was attempted.`);
}
const { default: lighthouse } = await cachedModule('lighthouse', 'core/index.js');
const chromePath = process.env.CHROME_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
await access(chromePath);
const url = process.argv[2] ?? 'http://127.0.0.1:4173';
const userDataDir = await mkdtemp('/tmp/rustcore-demo-lighthouse-');
const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
let exited = false;
let launchError = null;
chrome.on('error', (error) => { launchError = error; });
chrome.once('exit', () => { exited = true; });
try {
  let port = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    if (exited) throw new Error('Chrome exited before opening its debugging port.');
    try { port = Number((await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (port) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!port) throw new Error('Chrome did not open its debugging port within 10 seconds.');
  const result = await lighthouse(url, {
    port,
    output: ['json', 'html'],
    onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    formFactor: 'mobile',
    screenEmulation: { mobile: true, width: 390, height: 844, deviceScaleFactor: 1, disabled: false },
    logLevel: 'error',
  });
  if (!result) throw new Error('Lighthouse returned no result.');
  await mkdir(join(webRoot, 'qa'), { recursive: true });
  const scores = Object.fromEntries(Object.entries(result.lhr.categories).map(([id, category]) => [id, Math.round((category.score ?? 0) * 100)]));
  const failed = Object.values(result.lhr.audits).filter((audit) => audit.score !== null && audit.score !== 1 && audit.details?.type !== 'opportunity').map((audit) => ({ id: audit.id, title: audit.title, score: audit.score, description: audit.description, items: audit.details?.items }));
  let prior = {};
  try { prior = JSON.parse(await readFile(join(webRoot, 'qa/summary.json'), 'utf8')); } catch {}
  const metrics = Object.fromEntries(['first-contentful-paint', 'largest-contentful-paint', 'speed-index', 'total-blocking-time', 'cumulative-layout-shift'].map((id) => [id, result.lhr.audits[id].displayValue]));
  await writeFile(join(webRoot, 'qa/summary.json'), JSON.stringify({ ...prior, lighthouse: { url, scores, metrics, failed } }, null, 2) + '\n');
  console.log(JSON.stringify({ url, scores, failed: failed.map(({ id, title, score }) => ({ id, title, score })) }, null, 2));
  if (Object.values(scores).some((score) => score < 95)) process.exitCode = 1;
} finally {
  if (!exited) {
    chrome.kill('SIGTERM');
    await new Promise((resolve) => {
      if (exited) return resolve();
      const timeout = setTimeout(() => { chrome.kill('SIGKILL'); resolve(); }, 3000);
      chrome.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
  await rm(userDataDir, { recursive: true, force: true });
}
