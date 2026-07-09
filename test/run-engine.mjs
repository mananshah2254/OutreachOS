/* OutreachPilot — engine-core unit tests (no deps).
 *
 *   node test/run-engine.mjs
 *
 * Exercises the pure sequence brain end to end: caps, warm-up, working hours,
 * scheduling, connection-gating, acceptance waits, reply-stop, retries, and a
 * full multi-day cadence simulation. No browser, no LinkedIn account.
 */
import EngineCore from '../engine-core.js';

const {
  defaultSettings, defaultCampaign, renderTemplate,
  normalizeCounters, bumpCounters, withinWorkingHours, warmupFactor, effectiveDayCap,
  capBlock, initProspect, decideNextAction, gateStep, applyResult, applyGate, nextDueAt, DAY_MS, HOUR_MS, MIN_MS,
} = EngineCore;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const section = s => console.log('\n' + s);

// A fixed "now": Wed 2026-07-08 10:00 local (inside 08–20 working hours).
const T0 = new Date(2026, 6, 8, 10, 0, 0).getTime();

function baseState(over = {}) {
  const settings = { ...defaultSettings(), ...(over.settings || {}) };
  return {
    settings,
    campaign: over.campaign || defaultCampaign(),
    counters: over.counters || normalizeCounters({}, T0),
    firstRunDay: over.firstRunDay || null,
    consecFail: over.consecFail || 0,
    prospects: over.prospects || [],
  };
}
const P = (over = {}) => ({ ...initProspect({ url: over.url || 'https://www.linkedin.com/in/x', name: over.name || 'Ada Lovelace', company: over.company || 'Analytical Engines' }, T0), ...over });

/* ── merge tags ──────────────────────────────────────────────────────────── */
section('merge tags');
eq(renderTemplate('Hi {first} at {company}', { name: 'Ada Lovelace', company: 'Analytical Engines' }),
   'Hi Ada at Analytical Engines', 'basic tags');
eq(renderTemplate('{First} {Last} {f}{l}', { name: 'ada lovelace' }), 'Ada Lovelace al', 'caps + initials');
eq(renderTemplate('keep {unknown}', { name: 'Ada' }), 'keep {unknown}', 'unknown token left intact');
eq(renderTemplate('Hi {first}', { name: '' }), 'Hi', 'missing name → empty first, trimmed');

/* ── counters ────────────────────────────────────────────────────────────── */
section('counters');
let c = normalizeCounters({}, T0);
eq(c.perDay.connect, 0, 'fresh perDay');
c = bumpCounters(c, 'connect', T0);
c = bumpCounters(c, 'connect', T0);
c = bumpCounters(c, 'message', T0);
eq(c.perDay.connect, 2, 'connect day count'); eq(c.perDay.message, 1, 'message day count'); eq(c.totalDay, 3, 'global total');
// day rollover
const nextDay = T0 + DAY_MS;
const c2 = normalizeCounters(c, nextDay);
eq(c2.perDay.connect, 0, 'day rollover resets perDay'); eq(c2.totalDay, 0, 'day rollover resets total');
ok(c2.perWeek.connect === 2, 'week counter survives a day rollover');
// week rollover
const c3 = normalizeCounters(c, T0 + 8 * DAY_MS);
eq(c3.perWeek.connect, 0, 'week rollover resets perWeek');

/* ── working hours ───────────────────────────────────────────────────────── */
section('working hours');
ok(withinWorkingHours({ workStartHour: 8, workEndHour: 20 }, T0), '10:00 within 8–20');
ok(!withinWorkingHours({ workStartHour: 8, workEndHour: 20 }, new Date(2026, 6, 8, 3).getTime()), '03:00 outside 8–20');
ok(withinWorkingHours({ workStartHour: 22, workEndHour: 6 }, new Date(2026, 6, 8, 2).getTime()), '02:00 within overnight 22–6');
ok(!withinWorkingHours({ workStartHour: 22, workEndHour: 6 }, new Date(2026, 6, 8, 12).getTime()), 'noon outside overnight 22–6');

/* ── weekend skip ────────────────────────────────────────────────────────── */
section('weekend skip');
const SAT = new Date(2026, 6, 11, 10).getTime();   // Sat 2026-07-11
const SUN = new Date(2026, 6, 12, 10).getTime();   // Sun 2026-07-12
ok(EngineCore.withinWorkingDays({ skipWeekends: true }, T0), 'Wed is a working day');
ok(!EngineCore.withinWorkingDays({ skipWeekends: true }, SAT), 'Saturday skipped when skipWeekends on');
ok(!EngineCore.withinWorkingDays({ skipWeekends: true }, SUN), 'Sunday skipped when skipWeekends on');
ok(EngineCore.withinWorkingDays({ skipWeekends: false }, SAT), 'Saturday allowed when skipWeekends off');
{
  const st = baseState({ prospects: [P()] });   // default settings → skipWeekends on
  const d = decideNextAction(st, SAT);
  eq(d.kind, 'outside_hours', 'engine idles on the weekend');
  ok(/weekend/i.test(d.reason), 'weekend reason surfaced to the UI');
}

/* ── warm-up + effective cap ─────────────────────────────────────────────── */
section('warm-up ramp');
const s = defaultSettings();
eq(warmupFactor(s, '2026-7-8', T0), 0.3, 'day 1 = 30%');
eq(warmupFactor(s, '2026-7-8', T0 + 6 * DAY_MS), 1, 'day 7 = 100%');
ok(warmupFactor(s, '2026-7-8', T0 + 2 * DAY_MS) < 1, 'day 3 is still ramping (not yet full)');
eq(effectiveDayCap(s, 'connect', '2026-7-8', T0), 4, 'day 1 connect cap = 30% of 15 = 4');
eq(effectiveDayCap(s, 'connect', '2026-7-8', T0 + 6 * DAY_MS), 15, 'day 7 connect cap = full 15');
eq(effectiveDayCap({ ...s, warmupEnabled: false }, 'connect', '2026-7-8', T0), 15, 'warmup off → full cap');

/* ── caps block ──────────────────────────────────────────────────────────── */
section('cap blocking');
let cc = normalizeCounters({}, T0);
for (let i = 0; i < 15; i++) cc = bumpCounters(cc, 'connect', T0);
ok(capBlock(cc, s, 'connect', null, T0), 'connect blocked at day cap 15');
ok(!capBlock(cc, s, 'message', null, T0), 'message NOT blocked when only connect is maxed');
let ct = normalizeCounters({}, T0);
for (let i = 0; i < 50; i++) ct = bumpCounters(ct, 'visit', T0); // hits totalDay 50 ceiling
ok(capBlock(ct, s, 'message', null, T0), 'global total ceiling blocks even a fresh action');

/* ── decideNextAction ────────────────────────────────────────────────────── */
section('decideNextAction');
{
  const st = baseState({ prospects: [P({ nextDueAt: T0 + HOUR_MS }), P({ url: 'u2', nextDueAt: T0 })] });
  const d = decideNextAction(st, T0);
  eq(d.kind, 'act', 'something is due'); eq(d.index, 1, 'picks the earliest-due prospect');
}
{
  const st = baseState({ prospects: [P({ nextDueAt: T0 + 2 * HOUR_MS })] });
  const d = decideNextAction(st, T0);
  eq(d.kind, 'idle', 'nothing due → idle'); eq(d.untilMs, T0 + 2 * HOUR_MS, 'idle until soonest due');
}
{
  const st = baseState({ prospects: [{ ...P(), status: 'done' }] });
  eq(decideNextAction(st, T0).kind, 'done', 'all prospects finished → done');
}
{
  const st = baseState({ prospects: [P()] });
  const night = new Date(2026, 6, 8, 3).getTime();
  eq(decideNextAction(st, night).kind, 'outside_hours', 'outside hours short-circuits');
}
{
  // connect capped, but a second prospect is on a message step → must still be served
  let capped = normalizeCounters({}, T0);
  for (let i = 0; i < 15; i++) capped = bumpCounters(capped, 'connect', T0);
  const pConnect = P({ url: 'c', stepIndex: 1 });   // step 1 = connect
  const pMessage = P({ url: 'm', stepIndex: 2, connectionState: 'connected' }); // step 2 = message
  const st = baseState({ counters: capped, prospects: [pConnect, pMessage] });
  const d = decideNextAction(st, T0);
  eq(d.action, 'message', 'capped connect is skipped; message prospect served');
  eq(d.index, 1, 'served the message prospect');
}

/* ── gateStep ────────────────────────────────────────────────────────────── */
section('gateStep');
const connectStep = { action: 'connect', requiresConnection: false };
const messageStep = { action: 'message', requiresConnection: true };
eq(gateStep(P(), connectStep, s, 'connected', T0).do, 'skip_step', 'connect skipped when already connected');
eq(gateStep(P(), connectStep, s, 'pending', T0).do, 'skip_step', 'connect skipped when invite pending');
eq(gateStep(P(), connectStep, s, 'not_connected', T0).do, 'execute', 'connect executes when not connected');
eq(gateStep(P(), messageStep, s, 'connected', T0).do, 'execute', 'message executes when connected');
{
  const g = gateStep(P({ waitStartedAt: T0 }), messageStep, s, 'not_connected', T0 + HOUR_MS);
  eq(g.do, 'wait', 'message waits while not connected');
  eq(g.untilMs, T0 + HOUR_MS + (s.acceptPollHours * HOUR_MS), 'wait re-checks after acceptPollHours');
}
{
  const g = gateStep(P({ waitStartedAt: T0 }), messageStep, s, 'not_connected', T0 + 15 * DAY_MS);
  eq(g.do, 'stop_prospect', 'message gives up after acceptWaitDays'); eq(g.status, 'done', 'gives up as done');
}
eq(gateStep(P(), messageStep, s, 'self', T0).do, 'stop_prospect', 'own profile stops the prospect');

/* ── applyResult ─────────────────────────────────────────────────────────── */
section('applyResult');
{ // connect ok → advance, bump counter, enter pending+wait for the conn-gated next step
  const st = baseState({ prospects: [P({ stepIndex: 1 })] });   // on connect step
  const r = applyResult(st, 0, { status: 'ok', reason: 'Sent' }, T0);
  eq(r.prospects[0].stepIndex, 2, 'advanced past connect');
  eq(r.prospects[0].connectionState, 'pending', 'connect ok → pending');
  eq(r.prospects[0].waitStartedAt, T0, 'accept clock started');
  eq(r.counters.perDay.connect, 1, 'connect counter bumped');
}
{ // skipped → advance, no counter bump
  const st = baseState({ prospects: [P({ stepIndex: 1 })] });
  const r = applyResult(st, 0, { status: 'skipped', reason: 'Already connected' }, T0);
  eq(r.prospects[0].stepIndex, 2, 'skip advances'); eq(r.counters.perDay.connect, 0, 'skip does not count');
}
{ // last step ok → done
  const st = baseState({ prospects: [P({ stepIndex: 3 })] });   // last step of default 4-step campaign
  const r = applyResult(st, 0, { status: 'ok' }, T0);
  eq(r.prospects[0].status, 'done', 'past the last step → done');
}
{ // failed retries then fails
  let st = baseState({ prospects: [P({ stepIndex: 0 })] });
  let r = applyResult(st, 0, { status: 'failed', reason: 'net' }, T0);
  eq(r.prospects[0].status, 'active', 'first failure → retry'); eq(r.prospects[0].failCount, 1, 'failCount 1');
  st = { ...st, prospects: r.prospects, consecFail: r.consecFail };
  r = applyResult(st, 0, { status: 'failed' }, T0);
  st = { ...st, prospects: r.prospects, consecFail: r.consecFail };
  r = applyResult(st, 0, { status: 'failed' }, T0);
  eq(r.prospects[0].status, 'failed', 'third failure → prospect failed (maxStepRetries 3)');
}
{ // halt / fatal / replied
  const st = baseState({ prospects: [P({ stepIndex: 1 })] });
  eq(applyResult(st, 0, { status: 'halt', reason: 'quota' }, T0).engineStop.runState, 'halted', 'halt stops engine');
  eq(applyResult(st, 0, { status: 'fatal', reason: 'tab' }, T0).engineStop.runState, 'paused', 'fatal pauses engine');
  eq(applyResult(st, 0, { status: 'replied' }, T0).prospects[0].status, 'replied', 'reply stops the prospect');
}
{ // circuit breaker
  const st = baseState({ prospects: [P()], consecFail: 5 });
  const r = applyResult(st, 0, { status: 'failed' }, T0);
  ok(r.engineStop && r.engineStop.runState === 'paused', 'circuit breaker trips at maxConsecFail');
}

/* ── applyGate ───────────────────────────────────────────────────────────── */
section('applyGate');
{
  const st = baseState({ prospects: [P()] });
  const r = applyGate(st, 0, { do: 'wait', untilMs: T0 + HOUR_MS, status: 'waiting_accept', reason: 'w' }, T0);
  eq(r.prospects[0].status, 'waiting_accept', 'wait sets status');
  eq(r.prospects[0].waitStartedAt, T0, 'wait anchors the accept clock');
  eq(r.prospects[0].nextDueAt, T0 + HOUR_MS, 'wait sets nextDueAt');
}

/* ── safety status (UI summary) ──────────────────────────────────────────── */
section('safety status');
{
  const st = baseState({ firstRunDay: '2026-7-8' });   // day 1
  const ss = EngineCore.safetyStatus(st, T0);
  ok(ss.warming, 'day 1 reports warming up');
  eq(ss.warmupDay, 1, 'warmup day 1');
  eq(ss.effective.connect, 4, "today's connect cap reflects the warm-up (4)");
  ok(!ss.weekend, 'Wed is not a weekend');
  ok(ss.sending, 'within the send window on a Wed at 10:00');
  const ss2 = EngineCore.safetyStatus(baseState({ firstRunDay: '2026-7-8' }), T0 + 6 * DAY_MS);
  ok(!ss2.warming, 'day 7 no longer warming');
  eq(ss2.effective.connect, 15, 'day 7 connect cap at full 15');
  const ssWk = EngineCore.safetyStatus(baseState({ firstRunDay: '2026-7-8' }), new Date(2026, 6, 11, 10).getTime());
  ok(ssWk.weekend && !ssWk.sending, 'weekend flagged, not sending');
}

/* ── step delays (value + unit, with backward compat) ────────────────────── */
section('step delays');
eq(EngineCore.stepDelayMs({ delayValue: 30, delayUnit: 'sec' }), 30_000, '30 seconds');
eq(EngineCore.stepDelayMs({ delayValue: 5, delayUnit: 'min' }), 5 * 60_000, '5 minutes');
eq(EngineCore.stepDelayMs({ delayValue: 2, delayUnit: 'hour' }), 2 * 3_600_000, '2 hours');
eq(EngineCore.stepDelayMs({ delayValue: 1, delayUnit: 'day' }), 86_400_000, '1 day');
eq(EngineCore.stepDelayMs({ delayValue: 0, delayUnit: 'min' }), 0, 'zero');
eq(EngineCore.stepDelayMs({ delayDays: 1, delayHours: 2 }), DAY_MS + 2 * HOUR_MS, 'old delayDays/Hours still honored');
eq(EngineCore.stepDelayMs({ delayMinutes: 90 }), 90 * 60_000, 'old delayMinutes honored');
eq(EngineCore.deriveDelay({ delayValue: 3, delayUnit: 'hour' }), { value: 3, unit: 'hour' }, 'derive passes value+unit through');
eq(EngineCore.deriveDelay({ delayDays: 1 }), { value: 1, unit: 'day' }, 'derive old 1 day');
eq(EngineCore.deriveDelay({ delayHours: 2 }), { value: 2, unit: 'hour' }, 'derive old 2 hours');
eq(EngineCore.deriveDelay({ delayMinutes: 90 }), { value: 90, unit: 'min' }, 'derive old 90 minutes');
eq(EngineCore.deriveDelay({ delayValue: 0, delayUnit: 'sec' }), { value: 0, unit: 'sec' }, 'derive explicit zero passes unit through');
eq(EngineCore.deriveDelay({}), { value: 0, unit: 'min' }, 'derive empty/old zero → {0,min}');
eq(EngineCore.formatDelay({ delayValue: 0, delayUnit: 'min' }), 'immediately', 'zero → immediately');
eq(EngineCore.formatDelay({ delayValue: 1, delayUnit: 'day' }), '1 day', 'singular day');
eq(EngineCore.formatDelay({ delayValue: 3, delayUnit: 'day' }), '3 days', 'plural days');
eq(EngineCore.formatDelay({ delayValue: 30, delayUnit: 'sec' }), '30 seconds', '30 seconds');
{
  const base = 5 * 60_000; let good = true;
  for (let i = 0; i < 50; i++) { const d = nextDueAt(T0, { delayValue: 5, delayUnit: 'min' }) - T0; if (d < base * 0.8 || d > base * 1.2) good = false; }
  ok(good, 'nextDueAt(5 min) stays within ±20% jitter, never negative');
  good = true;
  for (let i = 0; i < 50; i++) { const d = nextDueAt(T0, { delayValue: 0, delayUnit: 'min' }) - T0; if (d < 30_000 || d > 90_000) good = false; }
  ok(good, 'zero-delay step → 30–90s spacing (never 0)');
}

/* ── full cadence simulation ─────────────────────────────────────────────── */
section('full multi-day cadence simulation');
{
  // One prospect through the default campaign: visit → connect → (accept) → msg → follow-up.
  // 24h window + weekends allowed so the simulation's multi-day time-stepping is
  // deterministic (the hours gate and weekend gate are covered by their own tests
  // above; this test is only about cadence progression, and the +3-day follow-up
  // would otherwise randomly land on a weekend depending on the due-time jitter).
  let st = baseState({ firstRunDay: '2026-7-8', settings: { workStartHour: 0, workEndHour: 24, skipWeekends: false }, prospects: [P({ url: 'https://www.linkedin.com/in/ada', connectionState: 'not_connected' })] });
  let now = T0;
  const run = (connState, execResult) => {
    const d = decideNextAction(st, now);
    if (d.kind !== 'act') return d;
    const step = st.campaign.steps[st.prospects[d.index].stepIndex];
    const g = gateStep(st.prospects[d.index], step, st.settings, connState, now);
    let r;
    if (g.do === 'execute') r = applyResult({ ...st }, d.index, execResult, now);
    else r = applyGate({ ...st }, d.index, g, now);
    st = { ...st, prospects: r.prospects, counters: r.counters || st.counters, consecFail: r.consecFail || 0 };
    return { d, g, step };
  };

  // step 0: visit (executes, no connection needed)
  let out = run('not_connected', { status: 'ok' });
  eq(out.step.action, 'visit', 'step 0 is visit'); eq(st.prospects[0].stepIndex, 1, 'advanced to connect');

  // advance time to when connect is due
  now = st.prospects[0].nextDueAt;
  out = run('not_connected', { status: 'ok', reason: 'Sent' });
  eq(out.step.action, 'connect', 'step 1 is connect'); eq(st.prospects[0].connectionState, 'pending', 'now pending');
  eq(st.counters.perDay.connect, 1, 'one connect counted');

  // message due next day, but NOT accepted yet → waits
  now = st.prospects[0].nextDueAt;
  out = run('not_connected', null);
  eq(out.g.do, 'wait', 'message waits — invite not yet accepted');
  eq(st.prospects[0].status, 'waiting_accept', 'prospect waiting');

  // poll again, now accepted → message sends
  now = st.prospects[0].nextDueAt;
  out = run('connected', { status: 'ok', reason: 'Message sent' });
  eq(out.step.action, 'message', 'step 2 is message'); eq(st.counters.perDay.message, 1, 'one message counted');
  eq(st.prospects[0].stepIndex, 3, 'advanced to follow-up');

  // follow-up due 3 days later, but they REPLIED → sequence stops
  now = st.prospects[0].nextDueAt;
  out = run('connected', { status: 'replied' });
  eq(st.prospects[0].status, 'replied', 'reply detected on follow-up → stopped');
  // (perDay.message has rolled over across the multi-day gap; the rolling weekly
  // counter is the right check: exactly the one real message, the replied follow-up
  // never sent.)
  eq(st.counters.perWeek.message, 1, 'exactly one message counted; replied follow-up not sent');

  // engine now reports done for this prospect set
  eq(decideNextAction(st, now).kind, 'done', 'campaign complete');
}

console.log(`\n${fail ? '✗' : '✓'} engine-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
