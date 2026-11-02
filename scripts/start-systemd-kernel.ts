import { loadDemoConfig } from '../caller/src/config.js';

process.umask(0o077);
try {
  const config = loadDemoConfig();
  if (!process.execve) throw new Error('EXECVE_UNAVAILABLE');
  // Replace this validated launcher: systemd's MainPID becomes the Rust process.
  // Inherit no unrelated parent environment, shell expansion or extra arguments.
  process.execve(config.kernelBinary, [config.kernelBinary], {
    ...config.environment, PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  });
} catch (error) {
  console.error(JSON.stringify({ event: 'kernel_start_failed',
    code: error && typeof error === 'object' && 'code' in error ? error.code : 'KERNEL_START_FAILED' }));
  process.exitCode = 1;
}
