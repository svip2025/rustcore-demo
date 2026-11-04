import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { buildConfig, recordingMetadata, selectPublishedRecordings } from './build.mjs';

const entry = (id, kind, status, day) => ({ id, source: { kind, label: kind }, status, ended_at: `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z` });

test('real recordings exclude newer MOCK files and retain all five failed runs', () => {
  const input = [entry('mock-new', 'MOCK', 'SUCCEEDED', 20), entry('real-success', 'TESTNET', 'SUCCEEDED', 3), ...Array.from({ length: 5 }, (_, index) => entry(`failed-${index}`, 'TESTNET', 'FAILED', index + 4))];
  const result = selectPublishedRecordings(input);
  assert.equal(result.recordings.length, 6);
  assert.equal(result.recordings.some((recording) => recording.source.kind === 'MOCK'), false);
  assert.equal(result.recordings.filter((recording) => recording.status === 'FAILED').length, 5);
  assert.equal(result.defaultRecording.id, 'real-success');
  assert.equal(input[0].id, 'mock-new', 'selection does not reorder the caller array');
});

test('latest TESTNET success takes priority over a newer PAPER success', () => {
  const result = selectPublishedRecordings([entry('old-testnet', 'TESTNET', 'SUCCEEDED', 1), entry('testnet', 'TESTNET', 'SUCCEEDED', 2), entry('paper', 'PAPER', 'SUCCEEDED', 3)]);
  assert.equal(result.defaultRecording.id, 'testnet');
});

test('other real successes and latest failures remain usable without TESTNET success', () => {
  assert.equal(selectPublishedRecordings([entry('failed', 'TESTNET', 'FAILED', 3), entry('paper', 'PAPER', 'SUCCEEDED', 2)]).defaultRecording.id, 'paper');
  assert.equal(selectPublishedRecordings([entry('failed-old', 'TESTNET', 'FAILED', 1), entry('failed-new', 'TESTNET', 'FAILED', 2)]).defaultRecording.id, 'failed-new');
});

test('MOCK remains available only when there are no real recordings', () => {
  const result = selectPublishedRecordings([entry('mock-failure', 'MOCK', 'FAILED', 2), entry('mock-success', 'MOCK', 'SUCCEEDED', 1)]);
  assert.equal(result.recordings.length, 2);
  assert.equal(result.defaultRecording.id, 'mock-success');
  assert.deepEqual(selectPublishedRecordings([]), { recordings: [], defaultRecording: undefined });
});


test('same-origin API is the default and VITE_API_BASE overrides the compatible legacy variable', () => {
  assert.deepEqual(buildConfig({}), { api_base: '/api', live_enabled: true });
  assert.equal(buildConfig({ DEMO_API_BASE: 'https://legacy.example/api' }).api_base, 'https://legacy.example/api');
  assert.equal(buildConfig({ VITE_API_BASE: 'https://chosen.example/api/', DEMO_API_BASE: 'https://legacy.example/api' }).api_base, 'https://chosen.example/api');
  assert.equal(buildConfig({ VITE_API_BASE: '', DEMO_API_BASE: 'https://legacy.example/api' }).api_base, '');
  assert.deepEqual(buildConfig({ DEMO_LIVE_ENABLED: 'false' }), { api_base: '/api', live_enabled: false });
});

test('real recording metadata keeps each latest round reason, five failures, and the successful default', async () => {
  const directory = new URL('../../recordings/', import.meta.url);
  const metadata = await Promise.all((await readdir(directory)).filter((file) => file.endsWith('.json')).map(async (file) => recordingMetadata(JSON.parse(await readFile(new URL(file, directory), 'utf8')), file)));
  const { recordings, defaultRecording } = selectPublishedRecordings(metadata);
  assert.equal(recordings.length, 6);
  const failed = recordings.filter((recording) => recording.status === 'FAILED');
  assert.equal(failed.length, 5);
  assert.ok(recordings.every((recording) => typeof recording.reason === 'string' && recording.reason.trim().length > 0));
  assert.ok(failed.every((recording) => recording.source.kind === 'TESTNET'));
  assert.equal(defaultRecording.file, 'recordings/run-20261102-150145-succeeded.json');
  assert.equal(defaultRecording.status, 'SUCCEEDED');
});
