import type { Recording } from './schema.js';
import type { Recording as RecordingV1 } from './schema-v1.js';
export type CompatibleRecording = Recording | RecordingV1;

/** Produce a consumer view; original v1 files/events are never rewritten. */
export function normalizePublicWire(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid public response');
  const version = (value as Record<string, unknown>).schema_version;
  if (version !== 1 && version !== 2) throw new Error(`不支持的数据版本：${String(version)}（支持 v1/v2）`);
  function visit(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(visit);
    if (!input || typeof input !== 'object') return input;
    const item = input as Record<string, unknown>;
    if ('schema_version' in item && item.schema_version !== version) throw new Error('混合的数据版本不受支持');
    const result = Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    if ('schema_version' in item) result.schema_version = 2;
    if (version === 1 && 'round_id' in item && 'status' in item) { result.scenario = null; result.metrics = null; }
    return result;
  }
  return visit(value);
}
