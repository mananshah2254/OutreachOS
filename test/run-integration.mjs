/* OutreachPilot — background.js orchestration integration test (no deps).
 *
 *   node test/run-integration.mjs
 *
 * Loads the ACTUAL shipping background.js as a service worker would (importScripts
 * pulls in the real engine-core.js), with chrome.* and the tab/network layer
 * mocked and a controllable clock. Then it drives ONE prospect through the whole
 * default cadence and asserts the coordinator does the right thing at each tick:
 *   visit → connect → (invite pending, message WAITS) → (accepted) message →
 *   follow-up sees a reply → sequence stops → engine reports done.
 *
 * This is the one file with no unit coverage (it's all chrome side effects), so we
 * exercise it end to end here. Nothing touches a real browser or LinkedIn.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(DIR, '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const section = s => console.log('\n' + s);

/* ── Controllable clock + collapsed timers ─────────────────────────────────*/
let CLOCK = Date.parse('2026-07-08T10:00:00');   // Wed 10:00, inside 08–20 hours
Date.now = () => CLOCK;
// Collapse every sleep/setTimeout to a near-immediate tick so the test is fast &
// deterministic (the scheduler uses chrome.alarms, which we drive manually).
const realSetTimeout = setTimeout;
globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise(r => realSetTimeout(r, 0)); };

/* ── Scenario: what the (mocked) content script reports per call ───────────*/
const ADA = 'urn:li:fsd_profile:ADA';
let resolveCalls = 0, repliedCalls = 0;
let dispatched = [];                       // ordered list of action message types sent to the tab
// The active scenario supplies these; defaults get overridden per scenario.
let CONN_BY_CALL = ['not_connected'];
let connectResult = { status: 'ok', reason: 'Connect sent' };
function contentReply(msg) {
  dispatched.push(msg.type);
  switch (msg.type) {
    case 'op:ping': return { ok: true };
    case 'op:resolve': {
      const conn = CONN_BY_CALL[Math.min(resolveCalls, CONN_BY_CALL.length - 1)];
      resolveCalls++;
      return { urn: ADA, connectionState: conn };
    }
    case 'op:visit':   return { status: 'ok', reason: 'Visited', urn: ADA, connectionState: 'not_connected' };
    case 'op:connect': return connectResult;
    case 'op:message': return { status: 'ok', reason: 'Message sent' };
    case 'op:follow':  return { status: 'ok', reason: 'Followed' };
    case 'op:hasReplied': { const r = repliedCalls > 0; repliedCalls++; return { replied: r }; } // 1st follow-up check: no; 2nd: yes
    default: return { ok: false };
  }
}

/* ── chrome.* mock ─────────────────────────────────────────────────────────*/
const STORE = {};
let alarmCb = null, watchdogAlarm = null;
let scheduledWhen = null;                 // the pending 'op-step' alarm time

const chrome = {
  storage: {
    local: {
      async get(keys) {
        const out = {};
        const list = Array.isArray(keys) ? keys : (keys == null ? Object.keys(STORE) : [keys]);
        for (const k of list) if (k in STORE) out[k] = STORE[k];
        return out;
      },
      async set(obj) { Object.assign(STORE, JSON.parse(JSON.stringify(obj))); },
    },
    onChanged: { addListener() {} },
  },
  alarms: {
    async create(name, opts) { if (name === 'op-step') scheduledWhen = opts.when; },
    async clear(name) { if (name === 'op-step') scheduledWhen = null; },
    async get(name) { return name === 'op-step' && scheduledWhen != null ? { name, scheduledTime: scheduledWhen } : null; },
    onAlarm: { addListener(cb) { alarmCb = cb; } },
  },
  tabs: {
    async update(id, props) { return { id, ...props, status: 'complete' }; },
    async get(id) { return { id, status: 'complete', url: 'https://www.linkedin.com/in/ada/' }; },
    async sendMessage(id, msg) { return contentReply(msg); },
    onUpdated: { addListener() {}, removeListener() {} },
  },
  runtime: {
    onMessage: { addListener(cb) { msgCb = cb; } },
    async sendMessage() { /* events → ignored */ },
    onInstalled: { addListener() {} },
    openOptionsPage() {},
  },
  webRequest: { onBeforeRequest: { addListener() {} } },
};
let msgCb = null;

/* ── importScripts (loads the real engine-core into this global) ───────────*/
globalThis.self = globalThis;
globalThis.chrome = chrome;
globalThis.importScripts = (...files) => {
  for (const f of files) (0, eval)(fs.readFileSync(path.join(root, f), 'utf8'));
};

/* ── Load the real background.js (registers its listeners on our mock) ─────*/
(0, eval)(fs.readFileSync(path.join(root, 'background.js'), 'utf8'));

/* ── Helpers to drive the engine like the UI + Chrome would ────────────────*/
function sendToBg(msg) {
  return new Promise(resolve => {
    const ret = msgCb(msg, { tab: { id: 1 } }, resolve);
    if (ret !== true) resolve(undefined);
  });
}
async function fireStepAlarm() {
  if (scheduledWhen == null) return false;
  CLOCK = Math.max(CLOCK, scheduledWhen);          // jump the clock to when it's due
  scheduledWhen = null;
  await alarmCb({ name: 'op-step' });
  await flush();
  return true;
}
// Run ticks until the engine leaves 'running' or a bound is hit. Returns tick count.
async function runUntilSettled(maxTicks = 80) {
  let n = 0;
  let runState = (await chrome.storage.local.get('runState')).runState;
  while (runState === 'running' && n++ < maxTicks) {
    const fired = await fireStepAlarm();
    if (!fired) { await flush(); if (scheduledWhen == null) break; }
    runState = (await chrome.storage.local.get('runState')).runState;
  }
  return n;
}
// Reset all mutable test state + storage between scenarios.
async function resetScenario() {
  for (const k of Object.keys(STORE)) delete STORE[k];
  scheduledWhen = null; dispatched = []; resolveCalls = 0; repliedCalls = 0;
  connectResult = { status: 'ok', reason: 'Connect sent' };
}
const zeroDelay = camp => ({ ...camp, steps: camp.steps.map(s => ({ ...s, delayValue: 0, delayUnit: 'sec', delayDays: 0, delayHours: 0 })) });

const E = () => self.EngineCore;
const seed = obj => chrome.storage.local.set(obj);

/* ── Scenario 1: full cadence, one prospect ────────────────────────────────
 * The default cadence SHAPE (visit → connect → message → follow-up, message
 * steps connection-gated + reply-stop) with delays zeroed and the accept poll
 * shrunk so it converges in a handful of ticks. (Real delays/jitter are covered
 * by the engine-core unit tests; here we test the coordinator's plumbing.)
 */
async function scenarioFullCadence() {
  section('scenario 1 — full cadence: visit → connect → wait-for-accept → message → reply-stop');
  await resetScenario();
  CONN_BY_CALL = ['not_connected', 'not_connected', 'not_connected', 'connected', 'connected'];
  await seed({
    prospects: [E().initProspect({ url: 'https://www.linkedin.com/in/ada', name: 'Ada Lovelace', company: 'Acme' }, CLOCK)],
    campaign: zeroDelay(E().defaultCampaign()),
    settings: { ...E().defaultSettings(), acceptPollHours: 1 },
  });

  eq(await sendToBg({ type: 'op:start', tabId: 1 }), { ok: true }, 'op:start acknowledged');
  await flush();
  await runUntilSettled();

  const s = await chrome.storage.local.get(['prospects', 'counters', 'runState']);
  const actions = dispatched.filter(t => ['op:visit', 'op:connect', 'op:message', 'op:follow'].includes(t));
  eq(actions, ['op:visit', 'op:connect', 'op:message'], 'dispatched visit → connect → message (follow-up never sent: replied)');
  ok(resolveCalls >= 4, `re-resolved connection state across ticks (${resolveCalls} resolves incl. the accept wait)`);
  eq(s.counters.perDay.visit, 1, 'one visit counted');
  eq(s.counters.perDay.connect, 1, 'one connect counted');
  eq(s.counters.perDay.message, 1, 'one message counted');
  ok(s.counters.totalDay === 3, `global total = 3 executed actions (got ${s.counters.totalDay})`);
  eq(s.prospects[0].status, 'replied', 'prospect stopped as replied on the follow-up');
  eq(s.runState, 'done', 'engine reports the whole queue done');
}

/* ── Scenario 2: LinkedIn wall → hard halt ─────────────────────────────────
 * A connect step gets a quota/captcha response. The engine must STOP everything
 * (runState 'halted') and NOT advance the prospect past the un-sent step.
 */
async function scenarioHalt() {
  section('scenario 2 — LinkedIn wall on connect → engine halts, nothing advances');
  await resetScenario();
  CONN_BY_CALL = ['not_connected', 'not_connected'];
  connectResult = { status: 'halt', reason: 'LinkedIn limit reached (429) — stopping for safety' };
  // Connect-only cadence so the halt lands on the first sending action.
  await seed({
    prospects: [E().initProspect({ url: 'https://www.linkedin.com/in/ada', name: 'Ada' }, CLOCK)],
    campaign: { name: 't', steps: [{ action: 'connect', delayValue: 0, delayUnit: 'sec', template: 'hi', requiresConnection: false }] },
    settings: { ...E().defaultSettings() },
  });
  await sendToBg({ type: 'op:start', tabId: 1 });
  await flush();
  await runUntilSettled();

  const s = await chrome.storage.local.get(['prospects', 'counters', 'runState']);
  eq(s.runState, 'halted', 'engine halted on the wall');
  eq(s.counters.perDay.connect, 0, 'halt did NOT count a send');
  eq(s.prospects[0].stepIndex, 0, 'prospect stayed on the un-sent connect step');
  ok(s.prospects[0].status !== 'done', 'prospect not marked done by a halt');
}

/* ── Scenario 3: per-action cap → engine idles instead of over-sending ─────
 * Connect cap = 1, warm-up off, two connect prospects. After the first connect,
 * the second must NOT be sent (the action is capped) — the engine idles/paused
 * rather than blowing past the cap.
 */
async function scenarioCap() {
  section('scenario 3 — connect cap reached → second connect is NOT sent');
  await resetScenario();
  CONN_BY_CALL = ['not_connected', 'not_connected', 'not_connected', 'not_connected'];
  const settings = { ...E().defaultSettings(), warmupEnabled: false };
  settings.caps = { ...settings.caps, connect: { day: 1, week: 100 }, totalDay: 100 };
  await seed({
    prospects: [
      E().initProspect({ url: 'https://www.linkedin.com/in/a', name: 'A One' }, CLOCK),
      E().initProspect({ url: 'https://www.linkedin.com/in/b', name: 'B Two' }, CLOCK),
    ],
    campaign: { name: 't', steps: [{ action: 'connect', delayValue: 0, delayUnit: 'sec', template: '', requiresConnection: false }] },
    settings,
  });
  await sendToBg({ type: 'op:start', tabId: 1 });
  await flush();
  await runUntilSettled(20);                 // bounded: capped action idles, won't self-terminate

  const s = await chrome.storage.local.get(['prospects', 'counters']);
  const connects = dispatched.filter(t => t === 'op:connect').length;
  eq(connects, 1, 'exactly one connect dispatched despite two prospects');
  eq(s.counters.perDay.connect, 1, 'connect counter stopped at the cap of 1');
  const sent = s.prospects.filter(p => p.status === 'done').length;
  ok(sent === 1, `one prospect completed, the other held back by the cap (done=${sent})`);
}

async function main() {
  await scenarioFullCadence();
  await scenarioHalt();
  await scenarioCap();
  console.log(`\n${fail ? '✗' : '✓'} integration: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
