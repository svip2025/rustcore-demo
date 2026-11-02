import { loadDemoConfig } from '../caller/src/config.js';
import { requestLocalRound } from '../caller/src/local-control.js';
import { row } from '../caller/src/facts.js';

try {
  const args = process.argv.slice(2);
  const triggerIndex = args.indexOf('--trigger');
  const trigger = triggerIndex === -1 ? 'MANUAL' : args[triggerIndex + 1];
  if (trigger !== 'MANUAL' && trigger !== 'SCHEDULED') throw new Error('INVALID_TRIGGER');
  if (triggerIndex !== -1) args.splice(triggerIndex, 2);
  const config = loadDemoConfig(args);
  const result = await requestLocalRound(`${config.callerDbFile}.sock`, trigger, event => {
    if (event.event === 'step') {
      const step = row(event.data);
      console.log(JSON.stringify({ round_id: step.round_id, step: step.step, phase: step.phase, result: step.result, reason: step.reason }));
    } else if (event.event === 'round') console.log(JSON.stringify(event));
  });
  console.log(JSON.stringify({ event: 'result', ...result }));
  process.exitCode = result.status === 'SUCCEEDED' ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ event: 'scenario_unavailable', code: row(error).code ?? 'SCENARIO_COMMAND_FAILED' }));
  process.exitCode = 1;
}
