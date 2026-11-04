import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(webRoot, '..');
const dist = join(webRoot, 'dist');
const compiled = join(webRoot, '.build');

function apiBase(value) {
  const base = value.trim().replace(/\/+$/, '');
  if (!base || base === '/api') return base;
  let url;
  try { url = new URL(base); } catch { throw new Error('VITE_API_BASE/DEMO_API_BASE must be empty, /api, or an HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/', '/api'].includes(url.pathname)) {
    throw new Error('VITE_API_BASE/DEMO_API_BASE must be an HTTPS origin (optionally ending in /api), without credentials or query parameters.');
  }
  return base;
}

export function selectPublishedRecordings(recordings) {
  const hasReal = recordings.some((recording) => recording.source.kind !== 'MOCK');
  const published = recordings.filter((recording) => !hasReal || recording.source.kind !== 'MOCK')
    .sort((left, right) => Date.parse(right.ended_at) - Date.parse(left.ended_at));
  const defaultRecording = published.find((recording) => recording.source.kind === 'TESTNET' && recording.status === 'SUCCEEDED')
    ?? published.find((recording) => recording.status === 'SUCCEEDED')
    ?? published[0];
  return { recordings: published, defaultRecording };
}

export function buildConfig(environment = process.env) {
  return {
    api_base: apiBase(environment.VITE_API_BASE ?? environment.DEMO_API_BASE ?? '/api'),
    live_enabled: !['false', '0'].includes((environment.DEMO_LIVE_ENABLED ?? '').trim().toLowerCase()),
  };
}

export function recordingMetadata(recording, file) {
  if (![1, 2].includes(recording.schema_version)) throw new Error(`Unsupported recording schema: ${file}`);
  const started = Date.parse(recording.started_at);
  const ended = Date.parse(recording.ended_at);
  if (!recording.recording_id || !['MOCK', 'TESTNET', 'PAPER'].includes(recording.source?.kind) || !Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    throw new Error(`Invalid recording metadata: ${file}`);
  }
  const rounds = new Map((recording.initial_timeline?.rounds ?? []).map((round) => [round.round_id, round]));
  for (const event of recording.events ?? []) {
    if (event.type === 'timeline') {
      rounds.clear();
      for (const round of event.data.rounds) rounds.set(round.round_id, round);
    } else if (event.type === 'round') rounds.set(event.data.round_id, event.data);
  }
  const latestRound = [...rounds.values()].sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at))[0];
  return {
    id: recording.recording_id,
    title: recording.title,
    source: recording.source,
    status: latestRound?.status ?? null,
    reason: typeof latestRound?.reason === 'string' ? latestRound.reason : '尚无场景轮次记录。',
    file: `recordings/${file}`,
    duration_ms: ended - started,
    started_at: recording.started_at,
    ended_at: recording.ended_at,
  };
}

export async function buildSite() {
const { api_base, live_enabled } = buildConfig();
await rm(compiled, { recursive: true, force: true });
const result = spawnSync(process.execPath, [join(workspaceRoot, 'node_modules/typescript/bin/tsc'), '--project', join(webRoot, 'tsconfig.json')], {
  cwd: webRoot,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Replace only generated directories; no workspace source or recordings are changed.
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'assets'), { recursive: true });
await mkdir(join(dist, 'recordings'), { recursive: true });
await cp(join(webRoot, 'index.html'), join(dist, 'index.html'));
await cp(join(webRoot, 'styles.css'), join(dist, 'styles.css'));
await cp(join(webRoot, 'favicon.svg'), join(dist, 'favicon.svg'));
const emittedRoot = join(compiled, 'web/src');
const emittedFiles = [...(await readdir(emittedRoot)).filter((file) => extname(file) === '.js'), 'replay.js'];
for (const file of emittedFiles) {
  const emitted = file === 'replay.js' ? join(compiled, 'shared/replay.js') : join(emittedRoot, file);
  const content = (await readFile(emitted, 'utf8')).replaceAll('../../shared/replay.js', './replay.js');
  // A type-only shared contract import disappears. Refuse unresolved runtime imports.
  for (const match of content.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier.startsWith('./') || !emittedFiles.includes(specifier.slice(2))) {
      throw new Error(`Unexpected browser runtime import in ${file}: ${specifier}`);
    }
  }
  await writeFile(join(dist, 'assets', file), content);
}
if (!emittedFiles.includes('app.js')) throw new Error('The app entry point was not emitted.');

const availableRecordings = [];
const recordingFiles = new Map();
for (const file of (await readdir(join(workspaceRoot, 'recordings'))).filter((file) => extname(file) === '.json').sort()) {
  const raw = await readFile(join(workspaceRoot, 'recordings', file), 'utf8');
  const recording = JSON.parse(raw);
  availableRecordings.push(recordingMetadata(recording, file));
  recordingFiles.set(`recordings/${file}`, raw);
}
const { recordings, defaultRecording } = selectPublishedRecordings(availableRecordings);
for (const recording of recordings) await writeFile(join(dist, recording.file), recordingFiles.get(recording.file));
await writeFile(join(dist, 'recordings/index.json'), JSON.stringify({ schema_version: 1, default_id: defaultRecording?.id ?? null, recordings }, null, 2) + '\n');
await writeFile(join(dist, 'config.json'), JSON.stringify({ api_base, live_enabled }, null, 2) + '\n');
const connectOrigin = api_base.startsWith('https://') ? ` ${new URL(api_base).origin}` : '';
const csp = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'${connectOrigin}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'`;
await writeFile(join(dist, '_headers'), `/*\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n`);
await rm(compiled, { recursive: true, force: true });
console.log(`Built static web in ${dist}; ${recordings.length} recordings; default: ${defaultRecording?.id ?? 'none'}.`);

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildSite();
