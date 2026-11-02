import { loadDemoConfig } from '../caller/src/config.js';
import { DemoStore } from '../caller/src/store.js';
try {
  const args = process.argv.slice(2), index = args.indexOf('--round');
  const roundId = index < 0 ? undefined : args[index + 1];
  if (!roundId) throw new Error('ROUND_REQUIRED');
  args.splice(index, 2);
  const config = loadDemoConfig(args);
  const store = new DemoStore(config.callerDbFile, { source: config.source, build: config.build });
  try { process.stdout.write(JSON.stringify(store.exportRecording(roundId), null, 2) + '\n'); }
  finally { store.close(); }
} catch { console.error('Recording export failed; provide an existing completed round.'); process.exitCode = 1; }
