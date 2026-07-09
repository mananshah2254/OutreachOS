/* OutreachOS — background.js  (service worker / orchestrator)
 *
 * Owns the run: it asks engine-core WHAT to do next, then does the side effects —
 * drive ONE LinkedIn tab (navigate → resolve the person → run the step's Voyager
 * action via the content script → fold the result back into state) and schedule
 * the next tick. The loop runs on chrome.alarms (not setTimeout) so it survives
 * Chrome suspending this worker during multi-minute pauses. A 1-minute watchdog
 * self-heals a run interrupted mid-step. All state lives in chrome.storage.local.
 *
 * The DECISIONS live in engine-core.js (pure, unit-tested). This file is the
 * machinery around them.
 */
importScripts('engine-core.js');
const E = self.EngineCore;

const ALARM = 'op-step';
const WATCHDOG = 'op-watchdog';
const LOG = (...a) => console.log('[OP:bg]', ...a);
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── State ──────────────────────────────────────────────────────────────────*/
async function getState() {
  const s = await chrome.storage.local.get([
    'prospects', 'campaign', 'settings', 'counters', 'runState',
    'activeTabId', 'firstRunDay', 'lastEvent', 'consecFail',
  ]);
  return {
    prospects: Array.isArray(s.prospects) ? s.prospects : [],
    campaign: s.campaign || E.defaultCampaign(),
    settings: { ...E.defaultSettings(), ...(s.settings || {}) },
    counters: s.counters || E.normalizeCounters({}, Date.now()),
    runState: s.runState || 'idle',        // idle|running|paused|halted|done
    activeTabId: s.activeTabId ?? null,
    firstRunDay: s.firstRunDay || '',
    lastEvent: s.lastEvent || null,
    consecFail: s.consecFail || 0,
  };
}
const setState = obj => chrome.storage.local.set(obj);
const getRunState = async () => (await chrome.storage.local.get('runState')).runState || 'idle';

async function emit(event) {
  await setState({ lastEvent: { ...event, at: Date.now() } });
  chrome.runtime.sendMessage({ type: 'op:event', event }).catch(() => {});
}
async function stopEngine(runState, event) {
  await chrome.alarms.clear(ALARM);
  await chrome.alarms.clear(WATCHDOG);
  await setState({ runState });
  if (event) await emit(event);
  LOG('engine stopped →', runState, event?.reason || '');
}
function scheduleNext(delayMs) {
  chrome.alarms.create(ALARM, { when: Date.now() + Math.max(1000, delayMs) });
}
function ensureWatchdog() { chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 }); }

/* ── Tab driving ────────────────────────────────────────────────────────────*/
function waitForTabLoad(tabId, timeoutMs = 30_000) {
  return new Promise(resolve => {
    let done = false;
    const finish = okv => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(onUpd); resolve(okv); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(true); };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then(t => { if (t && t.status === 'complete') finish(true); }).catch(() => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}
async function pingContent(tabId, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try { const r = await chrome.tabs.sendMessage(tabId, { type: 'op:ping' }); if (r && r.ok) return true; }
    catch { /* not injected yet */ }
    await sleep(500);
  }
  return false;
}
// Navigate the driven tab to a URL and confirm the content script is live there.
// → { ok:true } | { fatal:true, reason } | { failed:true, reason }
async function navigateTo(tabId, url) {
  try { await chrome.tabs.update(tabId, { url }); }
  catch { return { fatal: true, reason: 'LinkedIn tab was closed. Re-open LinkedIn and press Start.' }; }
  if (!(await waitForTabLoad(tabId))) return { failed: true, reason: 'Page load timed out' };
  await sleep(rand(2500, 5000));                        // settle + human read time
  if (!(await pingContent(tabId))) {
    try { await chrome.tabs.get(tabId); } catch { return { fatal: true, reason: 'LinkedIn tab was closed. Re-open LinkedIn and press Start.' }; }
    return { failed: true, reason: 'Page not ready' };
  }
  return { ok: true };
}
async function ask(tabId, msg) {
  try { return await chrome.tabs.sendMessage(tabId, msg); }
  catch {
    try { await chrome.tabs.get(tabId); } catch { return { status: 'fatal', reason: 'LinkedIn tab was closed. Re-open LinkedIn and press Start.' }; }
    return { status: 'failed', reason: 'Page stopped responding' };
  }
}

/* ── The step machine ───────────────────────────────────────────────────────*/
let stepping = false;

async function processStep() {
  if (stepping) return;
  stepping = true;
  try {
    let st = await getState();
    if (st.runState !== 'running') return;

    // Normalize counters + reap finished prospects up front.
    const counters = E.normalizeCounters(st.counters, Date.now());
    const reaped = E.reapDone(st.prospects, st.campaign, Date.now());
    await setState({ counters, prospects: reaped });
    st = { ...st, counters, prospects: reaped };

    const now = Date.now();
    const decision = E.decideNextAction(st, now);

    if (decision.kind === 'outside_hours') {
      await emit({ kind: 'info', reason: decision.reason || 'Outside working hours — waiting.' });
      scheduleNext(Math.max(60_000, decision.untilMs - now));
      return;
    }
    if (decision.kind === 'done') {
      return stopEngine('done', { kind: 'done', reason: 'All prospects complete.' });
    }
    if (decision.kind === 'idle') {
      const wait = Math.min(Math.max(60_000, decision.untilMs - now), 30 * 60_000);
      await emit({ kind: 'info', reason: 'Waiting for the next scheduled step…' });
      scheduleNext(wait);
      return;
    }

    if (st.activeTabId == null) {
      return stopEngine('paused', { kind: 'error', reason: 'No LinkedIn tab bound. Open LinkedIn and press Start.' });
    }

    // decision.kind === 'act'
    const idx = decision.index;
    const prospect = st.prospects[idx];
    const step = decision.step;

    // Mark in-flight (engine treats 'sending' as inactive, so no double-pick).
    const marking = st.prospects.slice();
    marking[idx] = { ...prospect, status: 'sending', reason: '' };
    await setState({ prospects: marking });
    await emit({ kind: 'sending', name: prospect.name || prospect.url, action: step.action });

    // 1) Navigate to the profile (this is also what registers a "visit").
    const nav = await navigateTo(st.activeTabId, prospect.url);
    if (nav.fatal) return finishWith(prospect.url, { status: 'fatal', reason: nav.reason }, step.action);
    if (nav.failed) return finishWith(prospect.url, { status: 'failed', reason: nav.reason }, step.action);

    // 2) Resolve the person fresh (urn + current connection distance).
    const resolved = await ask(st.activeTabId, { type: 'op:resolve' });
    if (resolved && resolved.status === 'fatal') return finishWith(prospect.url, resolved, step.action);
    const urn = (resolved && resolved.urn) || prospect.urn || null;
    const connState = (resolved && resolved.connectionState) || prospect.connectionState || 'unknown';

    // 3) Gate the step against the fresh connection state.
    const gate = E.gateStep(prospect, step, st.settings, connState, now);
    if (gate.do !== 'execute') {
      // Persist any freshly learned urn/connState, then apply the non-executing outcome.
      await patchProspect(prospect.url, { urn, connectionState: connState });
      return applyGateAndSchedule(prospect.url, gate);
    }

    // 3b) Reply-stop: if this is a message step flagged stopIfReplied and they've
    // already replied, end the sequence instead of messaging again.
    if (step.action === 'message' && step.stopIfReplied) {
      const rr = await ask(st.activeTabId, { type: 'op:hasReplied', urn });
      if (rr && rr.replied === true) {
        await patchProspect(prospect.url, { urn, connectionState: connState });
        return applyResultAndSchedule(prospect.url, { status: 'replied' }, step.action, false);
      }
    }

    // 4) Execute the action.
    const note = step.template ? E.renderTemplate(step.template, prospect) : '';
    let result;
    if (step.action === 'visit')        result = await ask(st.activeTabId, { type: 'op:visit' });
    else if (step.action === 'connect') result = await ask(st.activeTabId, { type: 'op:connect', urn, note, dryRun: st.settings.dryRun });
    else if (step.action === 'message') result = await ask(st.activeTabId, { type: 'op:message', urn, text: note, dryRun: st.settings.dryRun });
    else if (step.action === 'follow')  result = await ask(st.activeTabId, { type: 'op:follow', urn, dryRun: st.settings.dryRun });
    else result = { status: 'skipped', reason: 'Unknown action' };
    LOG(step.action, 'result:', result);   // both consoles ([OP:bg] here, [OP] on the page) show the action outcome
    result = result || { status: 'failed', reason: 'No response from page' };

    // Learn connState from the action result if it carried one (visit does).
    const learnedConn = result.connectionState || connState;
    await patchProspect(prospect.url, { urn: result.urn || urn, connectionState: learnedConn });

    const executed = result.status === 'ok';   // only real actions consume delay/quota
    return applyResultAndSchedule(prospect.url, result, step.action, executed);
  } catch (e) {
    LOG('step error', e);
    if ((await getRunState()) === 'running') scheduleNext(60_000);
  } finally {
    stepping = false;
  }
}

/* Merge a small patch into a prospect (matched by url), preserving 'sending'. */
async function patchProspect(url, patch) {
  const s = await getState();
  const i = s.prospects.findIndex(p => p.url === url);
  if (i === -1) return;
  const q = s.prospects.slice();
  q[i] = { ...q[i], ...patch };
  await setState({ prospects: q });
}

/* Apply an engine result for the (still 'sending') prospect and schedule next. */
async function applyResultAndSchedule(url, result, action, executed) {
  const st = await getState();
  const idx = st.prospects.findIndex(p => p.url === url && p.status === 'sending');
  if (idx === -1) { // user removed it mid-flight — just move on
    if ((await getRunState()) === 'running') scheduleNext(rand(st.settings.skipDelayMinMs, st.settings.skipDelayMaxMs));
    return;
  }
  const out = E.applyResult(st, idx, result, Date.now());
  await setState({ prospects: out.prospects, counters: out.counters, consecFail: out.consecFail });
  await emit({ kind: result.status, name: out.prospects[idx].name || url, action, reason: out.prospects[idx].reason });

  if (out.engineStop) return stopEngine(out.engineStop.runState, { kind: 'halt', reason: out.engineStop.reason });
  return scheduleAfter(executed, out.counters);
}

async function applyGateAndSchedule(url, gate) {
  const st = await getState();
  const idx = st.prospects.findIndex(p => p.url === url && p.status === 'sending');
  if (idx === -1) { if ((await getRunState()) === 'running') scheduleNext(rand(st.settings.skipDelayMinMs, st.settings.skipDelayMaxMs)); return; }
  const out = E.applyGate(st, idx, gate, Date.now());
  const patch = { prospects: out.prospects };
  if (out.counters) patch.counters = out.counters;
  if (typeof out.consecFail === 'number') patch.consecFail = out.consecFail;
  await setState(patch);
  await emit({ kind: 'info', name: out.prospects[idx].name || url, reason: out.prospects[idx].reason });
  if (out.engineStop) return stopEngine(out.engineStop.runState, { kind: 'halt', reason: out.engineStop.reason });
  return scheduleAfter(false, st.counters);   // gate (skip/wait) made no LinkedIn call
}

// Used for fatal/halt where we must reset the in-flight prospect and stop.
async function finishWith(url, result, action) {
  const st = await getState();
  const idx = st.prospects.findIndex(p => p.url === url);
  if (idx !== -1) {
    const out = E.applyResult(st, idx, result, Date.now());
    const patch = { prospects: out.prospects, counters: out.counters, consecFail: out.consecFail };
    await setState(patch);
    if (out.engineStop) return stopEngine(out.engineStop.runState, { kind: 'error', reason: out.engineStop.reason });
    await emit({ kind: result.status, name: out.prospects[idx].name || url, action, reason: out.prospects[idx].reason });
  }
  if ((await getRunState()) === 'running') scheduleNext(rand(st.settings.skipDelayMinMs, st.settings.skipDelayMaxMs));
}

// Long pause on a batch boundary, short after a skip/wait, normal otherwise.
async function scheduleAfter(executed, counters) {
  if ((await getRunState()) !== 'running') return;
  const st = await getState();
  if (!executed) return scheduleNext(rand(st.settings.skipDelayMinMs, st.settings.skipDelayMaxMs));
  const onBatchBoundary = (counters.totalDay || 0) > 0 && (counters.totalDay % st.settings.batchSize === 0);
  if (onBatchBoundary) {
    const d = rand(st.settings.batchPauseMinMs, st.settings.batchPauseMaxMs);
    await emit({ kind: 'info', reason: `Batch done — pausing ${Math.round(d / 60000)} min.` });
    return scheduleNext(d);
  }
  return scheduleNext(rand(st.settings.withinMinMs, st.settings.withinMaxMs));
}

/* ── Watchdog: recover a run interrupted mid-step ───────────────────────────*/
async function watchdog() {
  if (stepping) return;
  const st = await getState();
  if (st.runState !== 'running') { await chrome.alarms.clear(WATCHDOG); return; }
  if (await chrome.alarms.get(ALARM)) return;                 // a step is legitimately scheduled
  const q = st.prospects.map(p => (p.status === 'sending' ? { ...p, status: 'active', reason: '' } : p));
  await setState({ prospects: q });
  LOG('watchdog recovering a stalled run');
  processStep();
}

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === ALARM) processStep();
  else if (a.name === WATCHDOG) watchdog();
});

/* ── Search export: walk the current search across N pages ──────────────────*/
async function exportPages(tabId, maxPages) {
  const collected = new Map();
  let baseUrl;
  try { const t = await chrome.tabs.get(tabId); baseUrl = t.url; }
  catch { return { error: 'tab closed' }; }
  for (let page = 1; page <= maxPages; page++) {
    const url = setPageParam(baseUrl, page);
    const nav = await navigateTo(tabId, url);
    if (nav.fatal) break;
    if (!nav.ok) continue;
    await sleep(rand(1200, 2600));
    const r = await ask(tabId, { type: 'op:scrape' });
    const found = (r && r.profiles) || [];
    let added = 0;
    for (const p of found) { if (!collected.has(p.url.toLowerCase())) { collected.set(p.url.toLowerCase(), p); added++; } }
    chrome.runtime.sendMessage({ type: 'op:exportProgress', page, total: collected.size }).catch(() => {});
    if (added === 0 && page > 1) break;                        // no new results → end of list
    await sleep(rand(2500, 5000));                             // polite delay between pages
  }
  return { profiles: [...collected.values()] };
}
function setPageParam(url, page) {
  try {
    const u = new URL(url);
    u.searchParams.set('page', String(page));
    return u.toString();
  } catch { return url; }
}

/* ── Control messages from the UI ───────────────────────────────────────────*/
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'op:start': {
        const st = await getState();
        const tabId = msg.tabId ?? sender.tab?.id ?? st.activeTabId;
        if (tabId == null) { sendResponse({ ok: false, error: 'no-tab' }); return; }
        const counters = E.normalizeCounters(st.counters, Date.now());
        const prospects = st.prospects.map(p => (p.status === 'sending' ? { ...p, status: 'active', reason: '' } : p));
        const patch = { runState: 'running', activeTabId: tabId, counters, prospects, consecFail: 0 };
        if (!st.firstRunDay) patch.firstRunDay = E.dayKey(Date.now());
        await setState(patch);
        await emit({ kind: 'info', reason: 'Started.' });
        ensureWatchdog();
        sendResponse({ ok: true });
        processStep();
        break;
      }
      case 'op:pause': await stopEngine('paused', { kind: 'info', reason: 'Paused.' }); sendResponse({ ok: true }); break;
      case 'op:stop':  await stopEngine('idle',   { kind: 'info', reason: 'Stopped.' }); sendResponse({ ok: true }); break;
      case 'op:openDash': chrome.runtime.openOptionsPage(); sendResponse({ ok: true }); break;
      case 'op:getState': sendResponse(await getState()); break;
      case 'op:exportPages': {
        const tabId = msg.tabId ?? sender.tab?.id;
        if (tabId == null) { sendResponse({ ok: false, error: 'no-tab' }); break; }
        sendResponse({ ok: true });
        const out = await exportPages(tabId, Math.min(Math.max(1, msg.pages || 1), 20));
        chrome.runtime.sendMessage({ type: 'op:exportDone', ...out }).catch(() => {});
        break;
      }
      default: sendResponse({ ok: false });
    }
  })();
  return true; // async
});

/* ── Recovery on worker wake / install ──────────────────────────────────────*/
(async () => {
  const st = await getState();
  if (st.runState === 'running') {
    ensureWatchdog();
    if (!(await chrome.alarms.get(ALARM))) { LOG('recovering run on worker wake'); watchdog(); }
  }
})();
chrome.runtime.onInstalled.addListener(() => LOG('installed'));

/* ── Capture LinkedIn's own POSTs (verify/refresh the message & follow contracts).
 * Same technique ConnectPilot uses for the invite API: observe the real request
 * body via webRequest so contracts are confirmed from a live click, not guessed. */
const CAP_API_RE = /\/voyager\/|\/graphql|\/api\//i;
const CAP_TAG_RE = /messag|createmessage|conversation|follow|invit|verifyquotaandcreate|memberrelationship/i;
async function recordCapture(entry) {
  entry.t = Date.now();
  entry.tag = CAP_TAG_RE.test(entry.url || '') || CAP_TAG_RE.test(entry.body || '');
  const s = await chrome.storage.local.get('capRing');
  const ring = s.capRing || [];
  ring.push(entry);
  while (ring.length > 40) ring.shift();
  await chrome.storage.local.set({ capRing: ring });
}
try {
  chrome.webRequest.onBeforeRequest.addListener(
    details => {
      try {
        if (details.method !== 'POST' || !CAP_API_RE.test(details.url)) return;
        let body = null;
        const rb = details.requestBody;
        if (rb) {
          if (rb.raw && rb.raw.length && rb.raw[0].bytes) { try { body = new TextDecoder('utf-8').decode(rb.raw[0].bytes); } catch {} }
          else if (rb.formData) body = JSON.stringify(rb.formData);
        }
        recordCapture({ url: details.url, method: 'POST', body: body ? body.slice(0, 3000) : null });
      } catch {}
    },
    { urls: ['*://*.linkedin.com/*'] },
    ['requestBody']
  );
  LOG('webRequest capture armed');
} catch (e) { LOG('webRequest unavailable', e); }
