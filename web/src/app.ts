import type { Recording, DataSource, Observation, ProtectionPairView, ScenarioStep, TimelineStep, RoundTimeline, DisplayMode } from '../../shared/schema.js';
import { parseRecording, seekRecording, type Snapshot } from './model.js';
import { LiveConnection } from './live.js';

interface RecordingEntry { id: string; reason: string; title: string; source: DataSource; status: string | null; file: string; duration_ms: number; started_at: string; ended_at: string }
interface RecordingIndex { schema_version: number; default_id: string | null; recordings: RecordingEntry[] }
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`界面组件缺失：${id}`);
  return element as T;
};
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const decimal = (value: string | null | undefined): string => {
  if (value == null) return '—';
  const [integer, fraction] = value.split('.');
  return escape(integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : '.' + fraction));
};
const elapsed = (ms: number): string => `${String(Math.floor(Math.max(0, ms) / 60000)).padStart(2, '0')}:${String(Math.floor(Math.max(0, ms) / 1000) % 60).padStart(2, '0')}`;
const time = (iso: string | null | undefined): string => iso ? new Date(iso).toISOString().slice(11, 19) : '未知';
const dateTime = (iso: string | null | undefined): string => iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '时间未知';
const labels: Record<string, string> = { AVAILABLE: '完整可用', PARTIAL: '部分数据', STALE: '已过期', UNAVAILABLE: '不可用', UNKNOWN: '未证实', ONLINE: '在线', OFFLINE: '离线', RESTARTING: '重启中', FRESH: '有效', NOT_PUBLISHED: '未发布', PASS: '通过', FAIL: '失败', RUNNING: '进行中', SUCCEEDED: '成功', FAILED: '失败', none: '未触发', pause_new: '暂停开仓', manage_only: '仅管理', flatten: '强制平仓', LONG: '多头', SHORT: '空头', OPEN: '持仓中', PROTECTED: '内核标记 protected', PENDING: '待执行', CLOSING: '平仓中', FLATTENING: '强平中', CLOSED: '已平仓' };
const stepLabels: Record<ScenarioStep, string> = { preflight: '前置检查', cleanup_before: '检查残留', open_position: '开仓成交', verify_protection: '核对双保护', hold: '带保护持仓', restart_kernel: '重启内核', verify_recovery: '验证恢复', close_position: '平仓成交', cleanup_after: '清理确认' };
const tone = (status: string): string => ['PASS', 'AVAILABLE', 'ONLINE', 'FRESH', 'SUCCEEDED', 'none'].includes(status) ? 'good' : ['FAIL', 'FAILED', 'OFFLINE', 'flatten'].includes(status) ? 'bad' : ['STALE', 'PARTIAL', 'RESTARTING', 'manage_only', 'pause_new'].includes(status) ? 'warning' : 'neutral';
const pill = (status: string, text = labels[status] ?? status): string => `<span class="status-pill ${tone(status)}"><span class="dot"></span>${escape(text)}</span>`;

let index: RecordingIndex = { schema_version: 1, default_id: null, recordings: [] };
let recording: Recording | null = null;
let snapshot: Snapshot | null = null;
let mode: DisplayMode = 'replay';
let offset = 0;
let playing = false;
let speed = 1;
let lastTick = performance.now();
let apiBase = '';
let connection: LiveConnection | null = null;
let selection = '';
let loadGeneration = 0;
let renderKey = '';
let currentNotice = '';
let livePending = false;
let liveEnabled = true;

function notify(message: string): void { if (message !== currentNotice) { currentNotice = message; $('connection-message').textContent = message; } }
function api(path: string): string { return apiBase ? `${apiBase}${apiBase.endsWith('/api') ? '' : '/api'}${path}` : `/api${path}`; }
function sourceDisplay(): void {
  if (!snapshot) return;
  const source = snapshot.state.source;
  $('source-badge').textContent = source.kind === 'MOCK' ? 'MOCK · 假数据' : source.kind === 'TESTNET' ? 'TESTNET · 测试网' : 'PAPER · 模拟资金';
  $('source-badge').className = `tag ${source.kind === 'MOCK' ? 'mock' : source.kind === 'TESTNET' ? 'source-testnet' : 'source-paper'}`;
  $('source-label').textContent = source.label;
  $('mode-badge').textContent = mode === 'live' ? '实时模式 · 只读' : '回放模式';
  $('replay-mode').classList.toggle('selected', mode === 'replay' && !livePending);
  $('live-mode').classList.toggle('selected', mode === 'live' || livePending);
  $('replay-mode').setAttribute('aria-pressed', String(mode === 'replay' && !livePending));
  $('live-mode').setAttribute('aria-pressed', String(mode === 'live' || livePending));
  $('replay-panel').hidden = mode === 'live';
}
function observationNote<T>(observation: Observation<T>): string {
  return `<div class="observation-note">${pill(observation.status)} ${escape(observation.reason)}<br>来源时间 <time>${escape(dateTime(observation.source_as_of))}</time></div>`;
}
function viewedAt(): number { return mode === 'replay' && recording ? Date.parse(recording.started_at) + offset : Date.now(); }
function budgetAge(): number | null {
  if (!snapshot) return null;
  const budget = snapshot.state.risk_budget;
  return budget.age_ms == null ? null : budget.age_ms + Math.max(0, viewedAt() - Date.parse(snapshot.state.generated_at));
}
function chosenRound(): RoundTimeline | undefined {
  const rounds = snapshot?.timeline.rounds ?? [];
  return rounds.find(round => round.round_id === selection) ?? rounds[0];
}
function metrics(): string {
  const state = snapshot!.state;
  const p = state.positions;
  const count = p.value == null ? '—' : String(p.value.length);
  const positionsValue = p.status === 'AVAILABLE' && p.value !== null ? (p.value.length === 0 ? '空仓' : count) : p.value !== null ? `已知 ${count}` : '未知';
  const orders = state.open_orders;
  const ordersValue = orders.status === 'AVAILABLE' && orders.value !== null ? String(orders.value.length) : orders.value !== null ? `已知 ${orders.value.length}` : '未知';
  const a = state.account;
  return `<section class="metric-grid" aria-label="当前状态摘要"><article class="metric"><div class="metric-label">rustcore 内核<span class="metric-icon" aria-hidden="true">⌘</span></div><div class="metric-value ${tone(state.rustcore.status)}"><span class="dot"></span>${escape(labels[state.rustcore.status])}</div><p class="metric-note">${escape(state.rustcore.status === 'ONLINE' ? '可连接 · 恢复结果另行核对' : state.rustcore.reason)}</p></article><article class="metric"><div class="metric-label">BTCUSDT 持仓<span class="metric-icon" aria-hidden="true">◈</span></div><div class="metric-value">${escape(positionsValue)}${p.value?.length ? '<span class="unit">个</span>' : ''}</div><p class="metric-note ${tone(p.status)}">${escape(labels[p.status])} · ${escape(time(p.source_as_of))} UTC</p></article><article class="metric"><div class="metric-label">未成交订单<span class="metric-icon" aria-hidden="true">≡</span></div><div class="metric-value">${escape(ordersValue)}<span class="unit">笔</span></div><p class="metric-note ${tone(orders.status)}">${escape(labels[orders.status])} · 含普通 / Algo 订单</p></article><article class="metric"><div class="metric-label">${a.status === 'AVAILABLE' ? '账户权益' : '账户权益 · ' + labels[a.status]}<span class="metric-icon" aria-hidden="true">◷</span></div><div class="metric-value">${decimal(a.value?.equity_usdt)}<span class="unit">USDT</span></div><p class="metric-note">${escape(a.value?.account_label ?? a.reason)}</p></article></section>`;
}
function protectionLeg(pair: ProtectionPairView, leg: 'sl' | 'tp'): string {
  const item = pair[leg];
  const observation = snapshot!.state.protection;
  const current = observation.status === 'AVAILABLE' && pair.observation_id !== null;
  const status = current ? item.status : 'UNKNOWN';
  return `<div class="protection-leg ${status === 'FAIL' ? 'warn' : status === 'UNKNOWN' ? 'unknown' : ''}"><div class="leg-title"><strong>${leg === 'sl' ? '↘ 止损 / SL' : '↗ 止盈 / TP'}</strong>${pill(status, current ? labels[item.status] : `${pair.observation_id === null ? labels.UNKNOWN : labels[item.status]} · ${pair.observation_id === null ? '无快照' : labels[observation.status]}`)}</div><div class="leg-price">${decimal(item.trigger_price)} <small class="muted">USDT</small></div><p class="leg-reason">${escape(item.reason)}</p><p class="leg-venue">${escape(item.venue_status ?? '交易所状态未知')} · ${escape(time(item.source_as_of))} UTC</p></div>`;
}
function lifecycle(round: RoundTimeline | undefined): string {
  const phases: { label: string; steps: ScenarioStep[] }[] = [{ label: '开仓', steps: ['open_position'] }, { label: '保护', steps: ['verify_protection'] }, { label: '重启', steps: ['restart_kernel'] }, { label: '恢复', steps: ['verify_recovery'] }, { label: '平仓', steps: ['close_position', 'cleanup_after'] }];
  return `<div class="lifecycle"><div class="lifecycle-caption">EXECUTION LIFECYCLE · 仅显示已执行步骤的结果</div><div class="lifecycle-track">${phases.map((phase, i) => {
    const steps = round?.steps.filter(step => phase.steps.includes(step.step)) ?? [];
    const failed = steps.some(step => step.result === 'FAIL');
    const done = steps.length === phase.steps.length && steps.every(step => step.result === 'PASS');
    const current = steps.length > 0 && !done && !failed;
    return `<div class="lifecycle-node ${failed ? 'failed' : done ? 'done' : current ? 'current' : ''}"><span class="node-dot">${failed ? '×' : done ? '✓' : String(i + 1).padStart(2, '0')}</span>${phase.label}${steps.length === 0 ? '<span class="sr-only">，尚未执行</span>' : ''}</div>`;
  }).join('')}</div></div>`;
}
function positions(): string {
  const state = snapshot!.state;
  const positions = state.positions.value;
  const pairs = state.protection.value;
  const rows = positions?.map(position => {
    const pair = pairs?.find(item => item.position_id === position.position_id);
    return `<div class="position-values"><div><p class="value-label">持仓数量 · ${escape(labels[position.side])}</p><div class="value-main">${decimal(position.quantity)} <small>BTC</small></div></div><div><p class="value-label">开仓均价</p><div class="value-main">${decimal(position.entry_price)} <small>USDT</small></div></div><div><p class="value-label">标记价格</p><div class="value-main">${decimal(position.mark_price)} <small>USDT</small></div></div></div><p class="observation-note">内核持仓标记：${escape(labels[position.state])} · 双保护以各腿观察为准</p>${pair ? `<div class="protection-grid">${protectionLeg(pair, 'sl')}${protectionLeg(pair, 'tp')}</div><p class="pair-ref">同一 Algo 观察 / ${escape(pair.observation_id ?? '未建立')}</p>` : '<div class="protection-empty">SL / TP 均未证实 · 尚无匹配的双保护观察。</div>'}`;
  }).join('');
  const empty = state.positions.status === 'AVAILABLE' && positions !== null ? '已确认无持仓' : '当前持仓尚未完整证实';
  return `<article class="panel" aria-labelledby="position-title"><div class="panel-heading"><div class="panel-title"><span class="panel-index">01</span><h2 id="position-title">持仓与保护</h2></div>${pill(state.positions.status)}</div><div class="position-body"><div class="instrument"><span class="bitcoin" aria-hidden="true">₿</span><div><h3>BTC <span class="muted">/ USDT</span></h3><small>USDⓈ-M PERPETUAL</small></div><span class="position-state tag testnet">${escape(state.account.value?.btc_leverage == null ? '杠杆未知' : state.account.value.btc_leverage + '×')} · ${state.account.value?.margin_mode === 'CROSS' ? '全仓' : state.account.value?.margin_mode === 'ISOLATED' ? '逐仓' : '保证金未知'}</span></div>${rows || `<div class="position-empty">${escape(empty)}</div><div class="protection-empty">${state.protection.status === 'AVAILABLE' && pairs?.length === 0 ? '当前无保护单观察项；历史校验结果见时间线。' : '保护单观察尚未完整取得；不能据此判定没有保护单。'}</div>`}<div class="observation-note">${observationNote(state.positions)}</div><div class="observation-note">${observationNote(state.protection)}</div></div>${lifecycle(chosenRound())}</article>`;
}
function risk(): string {
  const state = snapshot!.state;
  const budget = state.risk_budget;
  const age = budgetAge();
  const status = budget.status === 'FRESH' && age !== null && age > budget.max_age_ms ? 'STALE' : budget.status;
  return `<article class="panel"><div class="panel-heading"><div class="panel-title"><span class="panel-index">02</span><h2>风险与准入</h2></div><span class="small-label">OBSERVED FACTS</span></div><div class="risk-body"><div class="risk-cell"><h3>风险预算新鲜度</h3><div class="risk-main ${tone(status)}">${escape(labels[status])} <small class="muted">${age == null ? '—' : (age / 1000).toFixed(1) + 's'} / ${budget.max_age_ms / 1000}s</small></div><progress class="budget-progress ${status === 'STALE' ? 'expired' : ''}" max="100" value="${age === null ? 0 : Math.min(100, age / budget.max_age_ms * 100)}" aria-label="风险预算有效窗口已用比例"></progress><p>${escape(budget.reason)}</p><p>来源 ${escape(time(budget.source_as_of))} UTC</p></div><div class="risk-cell"><h3>熔断状态</h3><div class="risk-main ${tone(state.kill_switch.level)}">${escape(labels[state.kill_switch.level])}</div><p>${escape(state.kill_switch.reason)}</p><div class="kill-detail">原始状态 <span class="mono">${escape(state.kill_switch.level)}</span></div></div></div></article>`;
}
function orders(): string {
  const observation = snapshot!.state.open_orders;
  return `<article class="panel"><div class="panel-heading"><div class="panel-title"><span class="panel-index">03</span><h2>未成交订单</h2></div>${pill(observation.status)}</div>${observation.value?.length ? `<div class="table-scroll"><table class="orders-table"><thead><tr><th>用途 / 类型</th><th>方向</th><th>数量 · BTC</th><th>价格 · USDT</th><th>状态</th></tr></thead><tbody>${observation.value.map(order => `<tr><td>${escape(order.role)}<br><span class="muted">${escape(order.order_type)}</span></td><td>${escape(order.side)}</td><td>${decimal(order.quantity)}</td><td>${decimal(order.price)}</td><td>${escape(order.status)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="orders-empty">${observation.status === 'AVAILABLE' && observation.value !== null ? '完整观察确认：当前无未成交订单。' : '未取得完整订单事实，不能判定无挂单。'}</p>`}<div class="orders-foot">${observationNote(observation)}</div></article>`;
}
function stepView(step: TimelineStep): string {
  const duration = step.ended_at ? ((Date.parse(step.ended_at) - Date.parse(step.started_at)) / 1000).toFixed(1) + 's' : '运行中';
  const protection = step.actual.protection;
  return `<article class="timeline-step ${step.result === 'FAIL' ? 'fail' : step.result === 'UNKNOWN' ? 'unknown' : ''}"><span class="step-icon" aria-hidden="true">${step.result === 'PASS' ? '✓' : step.result === 'FAIL' ? '×' : '·'}</span><div class="step-heading"><h3>${escape(stepLabels[step.step])}</h3><time datetime="${escape(step.started_at)}">${escape(time(step.started_at))}</time></div><p class="step-summary">${escape(step.actual.summary)}</p><div class="step-meta">${pill(step.result, step.phase === 'RUNNING' ? '进行中 · 未证实' : labels[step.result])}<span>${escape(duration)}</span>${protection ? `<span>SL ${escape(protection.sl.status)} / TP ${escape(protection.tp.status)}</span>` : ''}</div>${step.actual.fill ? `<p class="step-fill">成交 ${escape(step.actual.fill.side)} ${decimal(step.actual.fill.quantity)} BTC @ ${decimal(step.actual.fill.average_price)}<br>实际名义额 ${decimal(step.actual.fill.notional_usdt)} USDT</p>` : ''}<details class="step-details" data-step-id="${escape(step.step_id)}"><summary>预期与判据</summary><p>预期：${escape(step.expected)}<br>判定：${escape(step.reason)}${step.actual.code ? `<br>原因码：${escape(step.actual.code)}` : ''}${protection ? `<br>SL：${escape(protection.sl.reason)}<br>TP：${escape(protection.tp.reason)}<br>共同观察：${escape(protection.observation_id ?? '未建立')}` : ''}</p></details></article>`;
}
function scenarioDetails(round: RoundTimeline): string {
  const scenario = round.scenario;
  if (!scenario) return '<p class="small-label">v1 历史记录：场景参数与费用指标未录制</p>';
  const detail = round.metrics;
  const observed = (value: string | number | null | undefined) => value === null || value === undefined ? '未知' : escape(String(value));
  return `<p class="round-reason">${escape(scenario.scenario_id)} · ${scenario.direction === 'LONG' ? '做多' : '做空'} BTCUSDT · ${escape(scenario.policy_version)}<br>请求 SL ${escape(scenario.sl_pct)} / TP ${escape(scenario.tp_pct)} · 最长持仓 ${scenario.max_hold_ms / 60000} 分钟<br>实际保护价 SL ${observed(detail?.planned_sl_price)} / TP ${observed(detail?.planned_tp_price)}<br>保护确认 ${observed(detail?.protection_confirmation_ms)} ms · UNKNOWN ${observed(detail?.unknown_duration_ms)} ms<br>本轮净盈亏 ${observed(detail?.net_pnl_usdt)} USDT · 手续费 ${observed(detail?.fees_usdt)} · 资金费用 ${observed(detail?.funding_usdt)} · ${detail?.accounting_status === 'COMPLETE' ? '流水完整' : '费用核对未知'}</p>`;
}

function timeline(): string {
  const rounds = snapshot!.timeline.rounds;
  const round = chosenRound();
  return `<section id="timeline-section" class="panel timeline-panel" aria-labelledby="timeline-title"><div class="panel-heading timeline-heading"><div><div class="panel-title"><span class="panel-index">04</span><h2 id="timeline-title">场景时间线</h2></div><p class="small-label">EVERY STEP LEAVES A TRACE</p></div><span class="tag testnet">${round?.steps.length ?? 0} STEPS</span></div>${round ? `<div class="round-selector"><label for="round-select">已收到的轮次 · 成功与失败均保留</label><select id="round-select">${rounds.map(item => `<option value="${escape(item.round_id)}" ${item.round_id === round.round_id ? 'selected' : ''}>${escape(labels[item.status])} · ${escape(dateTime(item.started_at))} · ${item.trigger === 'MANUAL' ? '手动' : '定时'}</option>`).join('')}</select><div class="round-summary">${pill(round.status)}<span>${round.trigger === 'MANUAL' ? '本机手动触发' : '定时触发'}</span><span>UTC</span></div><p class="round-id">${escape(round.round_id)}</p><p class="round-reason">${escape(round.reason)}</p>${scenarioDetails(round)}</div>` : ''}<div class="timeline-list">${round?.steps.length ? round.steps.map(stepView).join('') : '<p class="empty-timeline">尚未发生场景步骤。<br>播放录制，查看完整执行过程。</p>'}</div><div class="timeline-foot"><span>${mode === 'replay' ? '按录制时序展示 · 未执行步骤不补造' : 'SSE 只读订阅 · 不提供执行入口'}</span>${mode === 'live' && snapshot!.timeline.next_cursor ? '<button id="load-more" class="text-button">更早轮次</button>' : '<span>UTC</span>'}</div></section>`;
}
function updateClock(): void {
  if (!snapshot) return;
  $('view-time').textContent = (mode === 'replay' ? '回放时刻 ' : '当前时刻 ') + dateTime(new Date(viewedAt()).toISOString());
  if (mode === 'replay' && recording) {
    $('elapsed').textContent = elapsed(offset);
    $('duration').textContent = elapsed(Date.parse(recording.ended_at) - Date.parse(recording.started_at));
    const slider = $<HTMLInputElement>('replay-progress');
    slider.value = String(Math.round(offset));
    slider.setAttribute('aria-valuetext', `${elapsed(offset)}，共 ${elapsed(Number(slider.max))}`);
    slider.style.background = `linear-gradient(to right, #9be7cd ${offset / Number(slider.max) * 100}%, #465269 ${offset / Number(slider.max) * 100}%)`;
    $('play-button').textContent = playing ? 'Ⅱ' : '▶';
    $('play-button').setAttribute('aria-label', playing ? '暂停录制' : offset >= Number(slider.max) ? '重新播放录制' : '播放录制');
  }
}
function render(force = false): void {
  if (!snapshot) return;
  sourceDisplay();
  updateClock();
  const age = budgetAge();
  const key = `${mode}:${snapshot.state.generated_at}:${snapshot.timeline.generated_at}:${snapshot.timeline.rounds.map(r => `${r.round_id}:${r.status}:${r.steps.map(s => `${s.step_id}-${s.phase}-${s.result}`).join(',')}`).join('|')}:${selection}:${age === null ? 'null' : Math.floor(age / 1000)}`;
  if (!force && key === renderKey) return;
  renderKey = key;
  const dashboard = $('dashboard');
  const scroller = dashboard.querySelector('.timeline-list');
  const scroll = scroller?.scrollTop ?? 0;
  const openDetails = new Set([...dashboard.querySelectorAll<HTMLDetailsElement>('details[open]')].map(item => item.dataset.stepId));
  const focusedRound = document.activeElement?.id === 'round-select';
  dashboard.innerHTML = `${metrics()}<div class="content-grid"><div class="left-column">${positions()}${risk()}${orders()}</div>${timeline()}</div>`;
  dashboard.setAttribute('aria-busy', 'false');
  dashboard.querySelectorAll<HTMLDetailsElement>('details').forEach(item => { if (openDetails.has(item.dataset.stepId)) item.open = true; });
  const newScroll = dashboard.querySelector('.timeline-list');
  if (newScroll) newScroll.scrollTop = scroll;
  if (focusedRound) $('round-select').focus();
  const selector = dashboard.querySelector<HTMLSelectElement>('#round-select');
  selector?.addEventListener('change', () => { selection = selector.value; render(true); });
  dashboard.querySelector('#load-more')?.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement;
    const cursor = snapshot?.timeline.next_cursor;
    if (!connection || !cursor) return;
    button.disabled = true;
    try { await connection.loadMore(`${api('/timeline')}?limit=20&cursor=${encodeURIComponent(cursor)}`); }
    catch { notify('更早轮次暂时无法加载；已显示的失败记录继续保留。'); button.disabled = false; }
  });
}
async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(6000), cache: 'no-store' });
  if (!response.ok) throw new Error('只读数据暂时不可用。');
  return response.json();
}
function stopLive(): void { connection?.close(); connection = null; livePending = false; }
function chapters(): void {
  if (!recording) return;
  const duration = Date.parse(recording.ended_at) - Date.parse(recording.started_at);
  const matches = recording.events.filter(event => event.type === 'step' && ['restart_kernel', 'verify_recovery', 'verify_protection'].includes(event.data.step) && (event.data.step === 'restart_kernel' ? event.data.phase === 'RUNNING' : event.data.phase === 'COMPLETED'));
  const unique = new Map<string, { name: string; offset: number }>();
  unique.set('start', { name: '↶ 从头', offset: 0 });
  for (const event of matches) if (event.type === 'step') unique.set(event.data.step, { name: event.data.result === 'FAIL' ? '保护失败 ↗' : event.data.step === 'restart_kernel' ? '内核重启 ↗' : event.data.step === 'verify_recovery' ? '恢复核对 ↗' : '双保护 ↗', offset: Date.parse(event.emitted_at) - Date.parse(recording.started_at) });
  unique.set('end', { name: '最终结果 ↗', offset: duration });
  $('chapter-buttons').innerHTML = [...unique.values()].map((chapter, i) => `<button data-chapter="${i}">${escape(chapter.name)}</button>`).join('');
  $('chapter-buttons').querySelectorAll<HTMLButtonElement>('button').forEach((button, i) => button.addEventListener('click', () => {
    if (mode !== 'replay') return;
    offset = [...unique.values()][i]!.offset;
    playing = false;
    snapshot = seekRecording(recording!, offset);
    render(true);
  }));
  $('progress-markers').replaceChildren();
  for (const chapter of unique.values()) {
    const marker = document.createElement('span'); marker.style.left = `${duration ? chapter.offset / duration * 100 : 0}%`; $('progress-markers').append(marker);
  }
}
async function loadRecording(id: string, notice?: string): Promise<void> {
  const entry = index.recordings.find(item => item.id === id);
  if (!entry || !/^recordings\/[\w.-]+\.json$/.test(entry.file)) throw new Error('没有可读取的场景录制。');
  const generation = ++loadGeneration;
  playing = false;
  const loaded = parseRecording(await json(entry.file));
  if (generation !== loadGeneration) return;
  recording = loaded;
  selection = '';
  offset = Date.parse(recording.ended_at) - Date.parse(recording.started_at);
  snapshot = seekRecording(recording, offset);
  mode = 'replay';
  $<HTMLSelectElement>('recording-select').value = id;
  const slider = $<HTMLInputElement>('replay-progress');
  slider.max = String(Math.max(1, Date.parse(recording.ended_at) - Date.parse(recording.started_at)));
  slider.disabled = false;
  $<HTMLButtonElement>('play-button').disabled = false;
  $('recording-date').textContent = `${dateTime(recording.started_at)} · 已定位最终结果，可从头播放`;
  $('recording-result').textContent = `录制最终结果：${labels[entry.status ?? ''] ?? '未证实'} · ${entry.reason ?? entry.title}`;
  chapters();
  notify(notice ?? '录制回放 · 可拖动进度；失败与重启期间的未知状态均保留。');
  render(true);
}
function fallback(reason: string): void {
  stopLive();
  mode = 'replay';
  if (recording && recording.recording_id === index.default_id) { selection = ''; snapshot = seekRecording(recording, offset); notify(reason); render(true); }
  else if (index.default_id) void loadRecording(index.default_id, reason).catch(showError);
  else showError(new Error(`${reason} 当前也没有可用录制。`));
}
function connect(): void {
  if (!liveEnabled) { fallback('此静态预览尚未连接 caller，当前使用录制回放；部署接口后可启用实时模式。'); return; }
  stopLive();
  playing = false;
  livePending = true;
  notify('正在连接 caller，只在收到完整状态和时间线后显示实时模式…');
  if (snapshot) sourceDisplay();
  connection = new LiveConnection({
    url: api('/stream'),
    onStatus(status) {
      if (status === 'resyncing') { notify('实时数据正在重新同步；等待完整基线，旧事实不作为当前结果。'); mode = 'replay'; if (recording) snapshot = seekRecording(recording, offset); render(true); }
    },
    onSnapshot(next) { ++loadGeneration; snapshot = next; mode = 'live'; livePending = false; notify('已连接 caller · SSE 只读实时更新。内核在线与恢复完成分别展示。'); render(true); },
    onError(reason) { fallback(`${reason} 已自动切换到录制回放。`); },
  });
}
function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : '暂时无法读取场景。';
  notify(message);
  $('dashboard').innerHTML = `<div class="error-panel" role="alert">${escape(message)}<br>未取得可靠数据，当前不展示执行成功或空仓结论。</div>`;
  $('dashboard').setAttribute('aria-busy', 'false');
}
$('play-button').addEventListener('click', () => {
  if (!recording || mode !== 'replay') return;
  if (offset >= Date.parse(recording.ended_at) - Date.parse(recording.started_at)) offset = 0;
  playing = !playing; lastTick = performance.now(); render(true);
});
$('replay-progress').addEventListener('input', event => {
  if (!recording) return;
  playing = false;
  offset = Number((event.target as HTMLInputElement).value);
  snapshot = seekRecording(recording, offset);
  render(true);
});
$('playback-speed').addEventListener('change', event => { speed = Number((event.target as HTMLSelectElement).value); });
$('recording-select').addEventListener('change', event => {
  stopLive(); void loadRecording((event.target as HTMLSelectElement).value).catch(showError);
});
$('replay-mode').addEventListener('click', () => { stopLive(); fallback('已选择录制回放 · 访客操作仅改变本地播放进度。'); });
$('live-mode').addEventListener('click', connect);
window.addEventListener('pagehide', stopLive);
document.querySelectorAll<HTMLAnchorElement>('.nav-link').forEach(link => link.addEventListener('click', () => { document.querySelectorAll('.nav-link').forEach(item => item.classList.remove('active')); link.classList.add('active'); }));
setInterval(() => {
  const now = performance.now();
  if (mode === 'replay' && playing && recording) {
    const duration = Date.parse(recording.ended_at) - Date.parse(recording.started_at);
    offset = Math.min(duration, offset + Math.min(1000, now - lastTick) * speed);
    snapshot = seekRecording(recording, offset);
    if (offset >= duration) playing = false;
  }
  lastTick = now;
  render();
}, 250);
async function init(): Promise<void> {
  const [config, recordings] = await Promise.allSettled([json('config.json'), json('recordings/index.json')]);
  if (config.status === 'fulfilled' && config.value && typeof config.value === 'object' && 'live_enabled' in config.value) liveEnabled = config.value.live_enabled !== false;
  if (config.status === 'fulfilled' && config.value && typeof config.value === 'object' && 'api_base' in config.value && typeof config.value.api_base === 'string') apiBase = config.value.api_base.replace(/\/+$/, '');
  if (recordings.status === 'fulfilled' && recordings.value && typeof recordings.value === 'object' && 'schema_version' in recordings.value && recordings.value.schema_version === 1 && 'recordings' in recordings.value && Array.isArray(recordings.value.recordings)) {
    index = recordings.value as RecordingIndex;
    $<HTMLSelectElement>('recording-select').innerHTML = index.recordings.map(entry => `<option value="${escape(entry.id)}">${entry.source.kind === 'MOCK' ? '[假数据] ' : entry.source.kind === 'TESTNET' ? '[测试网] ' : '[模拟] '}${escape((labels[entry.status ?? ''] ?? '录制') + ' · ' + dateTime(entry.started_at) + (entry.status === 'FAILED' ? ' · ' + (entry.reason ?? '').split(':')[0] : ''))}</option>`).join('');
    const succeeded = index.recordings.filter(entry => entry.status === 'SUCCEEDED').length;
    const failed = index.recordings.filter(entry => entry.status === 'FAILED').length;
    $('recording-summary').textContent = `${succeeded} 轮成功 · ${failed} 轮失败 · 全部可选`;
    $('recording-history').innerHTML = index.recordings.map(entry => `<li><button type="button" data-recording-id="${escape(entry.id)}">${pill(entry.status ?? 'UNKNOWN')}<span class="mono">${escape(dateTime(entry.started_at))}</span><span aria-hidden="true">↗</span></button><p>${escape(entry.reason || entry.title)}</p></li>`).join('');
    $('recording-history').querySelectorAll<HTMLButtonElement>('button').forEach(button => button.addEventListener('click', () => { stopLive(); void loadRecording(button.dataset.recordingId!).catch(showError); }));
    if (index.default_id) {
      try { await loadRecording(index.default_id, '正在连接 caller；当前先展示录制回放。'); }
      catch (error) { showError(error); }
    }
  }
  connect();
}
void init().catch(showError);
