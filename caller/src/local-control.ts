import { createServer, connect, type Server } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import type { RoundSummary, SseEvent } from '../../shared/schema.js';
import { row, ScenarioFailure } from './facts.js';
import type { ScenarioRunner } from './scenario.js';
import type { DemoStore } from './store.js';

/** Local Unix socket only. Filesystem 0600 is the command authorization boundary. */
export async function openLocalControl(path: string, runner: Pick<ScenarioRunner, 'run'>, store: DemoStore): Promise<Server> {
  try {
    const stat = await lstat(path);
    if (!stat.isSocket()) throw new ScenarioFailure('LOCAL_SOCKET_CONFLICT', '本机控制文件已被其他文件占用');
    await unlink(path); // caller instance lock must already be held by the owner.
  } catch (error) { if (row(error).code !== 'ENOENT') throw error; }
  const server = createServer(socket => {
    let input = '', requested = false;
    socket.setEncoding('utf8');
    socket.setTimeout(10_000, () => { if (!requested) socket.destroy(); });
    const send = (message: unknown) => { if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n'); };
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (requested) return;
      input += chunk;
      if (input.length > 1024) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      requested = true;
      let trigger: RoundSummary['trigger'];
      try {
        const request = row(JSON.parse(input.trim()));
        if (request.command !== 'run' || !['SCHEDULED', 'MANUAL'].includes(String(request.trigger))) throw new Error('invalid');
        trigger = request.trigger as RoundSummary['trigger'];
      } catch { send({ event: 'error', code: 'LOCAL_REQUEST_INVALID', reason: '仅接受本机场景请求' }); socket.end(); return; }
      let activeRound: string | null = null;
      const unsubscribe = store.subscribe((event: SseEvent) => {
        if (event.type === 'round' && event.data.status === 'RUNNING') activeRound = event.data.round_id;
        if ((event.type === 'step' || event.type === 'round') && event.data.round_id === activeRound)
          send({ event: event.type, data: event.data });
      });
      socket.once('close', unsubscribe);
      void runner.run(trigger).then(result => {
        unsubscribe(); send({ event: 'done', data: result }); socket.end();
      }, error => {
        unsubscribe(); send({ event: 'error', code: error instanceof ScenarioFailure ? error.code : 'LOCAL_SCENARIO_UNKNOWN', reason: '场景未能完成；请读取持久时间线，不能据此重发原开仓请求' }); socket.end();
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  await chmod(path, 0o600);
  return server;
}

export async function requestLocalRound(path: string, trigger: RoundSummary['trigger'], onEvent: (event: Record<string, unknown>) => void): Promise<RoundSummary> {
  return new Promise((resolve, reject) => {
    const socket = connect(path), finish = (error: Error) => { socket.destroy(); reject(error); };
    let buffered = '', done = false;
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ command: 'run', trigger }) + '\n'));
    socket.on('error', () => finish(new ScenarioFailure('CALLER_CONTROL_UNAVAILABLE', '本机 caller 未运行或控制通道不可用')));
    socket.on('data', chunk => {
      buffered += chunk;
      if (buffered.length > 1_000_000) { finish(new ScenarioFailure('LOCAL_RESULT_INVALID')); return; }
      let index: number;
      while ((index = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
        try {
          const message = row(JSON.parse(line)); onEvent(message);
          if (message.event === 'done') { done = true; socket.end(); resolve(message.data as unknown as RoundSummary); }
          if (message.event === 'error') { done = true; finish(new ScenarioFailure(String(message.code), String(message.reason))); }
        } catch { done = true; finish(new ScenarioFailure('LOCAL_RESULT_INVALID', '本机结果无法解析；请检查时间线')); }
      }
    });
    socket.on('close', () => { if (!done) reject(new ScenarioFailure('LOCAL_RESULT_UNKNOWN', '本机连接中断，场景可能仍在运行；请检查时间线，不自动发起新轮')); });
  });
}
