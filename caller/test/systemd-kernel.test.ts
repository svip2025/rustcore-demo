import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { DemoConfig } from '../src/config.js';
import { KernelProcessError, ManagedKernel } from '../src/kernel-process.js';
import { createKernel, SystemdKernel } from '../src/systemd-kernel.js';

test('systemd start only checks the fixed service, restart uses the sole sudo capability, and stop leaves it running', async () => {
  const calls: { file: string; args: readonly string[]; options: unknown }[] = [];
  const kernel = new SystemdKernel({ connectOnly: false, phaseTimeoutMs: 2345 }, {
    command: async (file, args, options) => { calls.push({ file, args, options }); },
  });
  await kernel.start();
  assert.equal(kernel.isRunning, true);
  await kernel.restart();
  await kernel.stop();
  assert.equal(kernel.isRunning, true, 'caller stop is not a service stop');
  assert.deepEqual(calls.map(({ file, args }) => ({ file, args })), [
    { file: '/usr/bin/systemctl', args: ['is-active', '--quiet', 'rustcore.service'] },
    { file: '/usr/bin/sudo', args: ['-n', '/usr/bin/systemctl', 'restart', 'rustcore.service'] },
  ]);
  assert.deepEqual(calls[1]?.options, { timeout: 2345, maxBuffer: 16_384, shell: false,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', SYSTEMD_PAGER: 'cat' } });
});

test('inactive service and denied restart preserve public-safe failures while connect-only executes nothing', async () => {
  const privateError = new Error('synthetic-private-token /tmp/private-fixture/private.service');
  let allowed = false;
  const kernel = new SystemdKernel({ connectOnly: false, phaseTimeoutMs: 1000 }, {
    command: async () => { if (!allowed) throw privateError; },
  });
  const rejected = (code: string) => (error: unknown) => {
    assert.ok(error instanceof KernelProcessError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /synthetic-private-token|private-fixture|private\.service/);
    return true;
  };
  await assert.rejects(kernel.start(), rejected('KERNEL_SERVICE_NOT_ACTIVE'));
  assert.equal(kernel.isRunning, false);
  allowed = true;
  await kernel.start();
  allowed = false;
  await assert.rejects(kernel.restart(), rejected('KERNEL_SERVICE_RESTART_FAILED'));
  assert.equal(kernel.isRunning, false);
  await kernel.stop();
  let calls = 0;
  const external = new SystemdKernel({ connectOnly: true, phaseTimeoutMs: 1000 }, {
    command: async () => { calls++; },
  });
  await external.start();
  await assert.rejects(external.restart(), rejected('KERNEL_NOT_MANAGED'));
  await external.stop();
  assert.equal(calls, 0);
});

test('control operations serialize and the factory preserves default child and explicit systemd ownership', async () => {
  let release!: () => void;
  let active = 0, maximum = 0, calls = 0;
  const kernel = new SystemdKernel({ connectOnly: false, phaseTimeoutMs: 1000 }, {
    command: async () => {
      active++; maximum = Math.max(maximum, active);
      if (++calls === 1) await new Promise<void>(resolve => { release = resolve; });
      active--;
    },
  });
  const first = kernel.start(), second = kernel.restart();
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(maximum, 1);
  const partial = { kernelMode: 'child', connectOnly: true, environment: {}, phaseTimeoutMs: 1000 } as DemoConfig;
  assert.ok(createKernel(partial) instanceof ManagedKernel);
  assert.ok(createKernel({ ...partial, kernelMode: 'systemd' }) instanceof SystemdKernel);
});

test('validated systemd launcher execs in place with only the private file environment and controlled PATH', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rustcore-execve-'));
  const envFile = join(directory, 'env'), binary = join(directory, 'kernel fixture');
  const program = '#!/bin/sh\nprintf "%s\\n" "$$" "${UNRELATED_FIXTURE-unset}" "$PATH" "$ENGINE_LIVE_ENABLED" "$ENGINE_STAGE_MAX" "$BINANCE_VENUE_H39303031"\n';
  writeFileSync(binary, program, { mode: 0o700 });
  const base: Record<string, string> = { ENGINE_LIVE_ENABLED: '0', ENGINE_STAGE_MAX: 'demo',
    DEMO_KERNEL_MODE: 'systemd', DEMO_KERNEL_BINARY: binary, BINANCE_VENUE_H39303031: 'testnet',
    BINANCE_API_KEY_H39303031: 'synthetic-key', BINANCE_API_SECRET_H39303031: 'synthetic-secret',
    PATH: '/untrusted/fixture/path' };
  const write = (changes: Record<string, string> = {}) => {
    writeFileSync(envFile, Object.entries({ ...base, ...changes }).map(([key, value]) => `${key}="${value}"`).join('\n'), { mode: 0o600 });
    chmodSync(envFile, 0o600);
  };
  const run = async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('scripts/start-systemd-kernel.ts'), '--env', envFile], {
      env: { ...process.env, UNRELATED_FIXTURE: 'must-not-be-inherited' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (value: string) => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('exit', resolve);
    });
    return { pid: child.pid, stdout, stderr, code };
  };
  try {
    write();
    const launched = await run();
    assert.equal(launched.code, 0, launched.stderr);
    assert.deepEqual(launched.stdout.trim().split('\n'), [String(launched.pid), 'unset',
      '/usr/sbin:/usr/bin:/sbin:/bin', '0', 'demo', 'testnet']);
    write({ ENGINE_LIVE_ENABLED: '1' });
    const refused = await run();
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /CONFIG_MAINNET/);
    assert.doesNotMatch(refused.stderr, /synthetic-key|synthetic-secret|must-not-be-inherited/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
