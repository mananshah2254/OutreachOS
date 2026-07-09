/* OutreachOS — engine-core.js
 *
 * The pure sequence + scheduling brain. NO chrome.* APIs, NO DOM. It is loaded
 * into the service worker via importScripts('engine-core.js') AND imported by the
 * Node test harness (test/run-engine.mjs) — the exact same code the extension ships
 * is the code the tests exercise.
 *
 * Responsibilities (all pure functions over plain state objects):
 *   - the data model (campaign steps, prospects, counters, settings + defaults)
 *   - per-action + global daily/weekly caps, warm-up ramp, working-hours gate
 *   - decideNextAction(): pick the next due prospect+step, cap-aware
 *   - gateStep(): given a FRESH connection state, decide execute / wait / skip
 *   - applyResult() / applyGate(): advance a prospect's sequence state
 *   - merge-tag rendering, jittered delays, prospect init, done-reaping, summary
 *
 * The service worker (background.js) does the side effects (drive the tab, call
 * Voyager via the content script, persist to storage); it asks this module WHAT
 * to do. Keeping the decisions here means the whole engine is unit-testable
 * without a browser or a LinkedIn account.
 */
(function (root) {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;
  const MIN_MS = 60 * 1000;
  const ACTIONS = ['visit', 'connect', 'message', 'follow'];

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const clone = o => JSON.parse(JSON.stringify(o));

  /* ── Defaults ─────────────────────────────────────────────────────────────
   * Caps are deliberately conservative, from 2026 community + PhantomBuster
   * guidance: connects ~100/wk (the hard one), messages ~120/wk, visits well
   * under the ~250/day "scraping" flag, plus a global ~100 actions/day ceiling.
   */
  function defaultSettings() {
    return {
      // Conservative caps chosen to sit WELL under LinkedIn's 2026 ceilings. Invites
      // are the highest-risk action, so connect is 15/day · 80/week (LinkedIn's real
      // limit is ~100–200/wk). The global totalDay ceiling (50) keeps combined
      // activity far below the ~150/day that draws scrutiny. Lower is safer — raise
      // only on a warmed, healthy account.
      caps: {
        connect: { day: 15, week: 80 },
        message: { day: 20, week: 100 },
        visit:   { day: 40, week: 200 },
        follow:  { day: 15, week: 80 },
        totalDay: 50,
      },
      withinMinMs: 70_000,          // 70–140s between executed actions (unhurried, human)
      withinMaxMs: 140_000,
      batchSize: 5,                 // long pause after this many executed actions
      batchPauseMinMs: 8 * MIN_MS,
      batchPauseMaxMs: 18 * MIN_MS,
      skipDelayMinMs: 8_000,        // short hop after a skip/wait (no LinkedIn call made)
      skipDelayMaxMs: 20_000,
      workStartHour: 9,             // local; supports overnight windows (start > end)
      workEndHour: 18,              // business hours only — off-hours activity looks automated
      skipWeekends: true,           // no weekend outreach (unusual for B2B → bot-like)
      warmupEnabled: true,          // ramp effective daily caps up over the first days
      acceptWaitDays: 14,           // give up waiting for an accept after this long
      acceptPollHours: 12,          // re-check acceptance this often while waiting
      maxStepRetries: 3,            // per-prospect retries on a transient failure
      maxConsecFail: 6,             // circuit breaker across the whole run
      dryRun: false,
    };
  }

  // The classic PhantomBuster "LinkedIn Outreach" cadence, tuned as a referral
  // ask for an AI Engineer role. Fully editable in the dashboard — this is only
  // the starting point. (The connect note stays well under LinkedIn's 300-char
  // invite limit; the post-accept messages carry the fuller ask.)
  function defaultCampaign() {
    return {
      name: 'AI Engineer referral outreach',
      steps: [
        { action: 'visit',   delayValue: 0, delayUnit: 'min', template: '', requiresConnection: false },
        { action: 'connect', delayValue: 2, delayUnit: 'hour', template: 'Hi {first}, I\'m exploring the AI Engineer role at {company} and would love to connect. If you\'re open to it, I\'d really appreciate the chance to ask about a referral. Thanks so much!', requiresConnection: false },
        { action: 'message', delayValue: 1, delayUnit: 'day', template: 'Thanks for connecting, {first}! I\'m genuinely excited about the AI Engineer opening at {company}. Would you be open to referring me, or pointing me to the right person? Happy to send my resume and a short summary of relevant projects. I really appreciate any help.', requiresConnection: true, stopIfReplied: true },
        { action: 'message', delayValue: 3, delayUnit: 'day', template: 'Hi {first}, just following up in case my note got buried. Totally understand if you\'re busy. If a referral for the AI Engineer role at {company} is possible, I\'d be grateful, and I\'ll make it as easy as I can on your end. Thank you either way!', requiresConnection: true, stopIfReplied: true },
      ],
    };
  }

  /* ── Merge tags ───────────────────────────────────────────────────────────
   * {first}{last}{name}{f}{l}{company}{title} + capitalized {First}{Last}{Name}
   * {Company}. Unknown {tokens} are left intact.
   */
  function splitName(name) {
    const n = String(name || '').trim().replace(/\s+/g, ' ');
    const parts = n ? n.split(' ') : [];
    return { first: parts[0] || '', last: parts.slice(1).join(' ') || '', full: n };
  }
  const capFirst = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
  function renderTemplate(tpl, p) {
    p = p || {};
    const { first, last, full } = splitName(p.name);
    const company = p.company || '';
    const map = {
      first, last, name: full, f: first ? first[0] : '', l: last ? last[0] : '',
      company, title: p.title || '',
      First: capFirst(first), Last: capFirst(last), Name: full, Company: capFirst(company),
    };
    return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m)).trim();
  }

  /* ── Counters: per-action day + rolling week, plus a global daily total ──── */
  function dayKey(now) {
    const d = new Date(now);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }
  function freshMap(v) { const o = {}; for (const a of ACTIONS) o[a] = v || 0; return o; }

  function normalizeCounters(counters, now) {
    const c = counters ? clone(counters) : {};
    const dk = dayKey(now);
    if (c.day !== dk) { c.day = dk; c.perDay = freshMap(); c.totalDay = 0; }
    if (!c.perDay) c.perDay = freshMap();
    if (!c.weekAnchor || now - c.weekAnchor > 7 * DAY_MS) { c.weekAnchor = now; c.perWeek = freshMap(); }
    if (!c.perWeek) c.perWeek = freshMap();
    if (typeof c.totalDay !== 'number') c.totalDay = 0;
    return c;
  }
  function bumpCounters(counters, action, now) {
    const c = normalizeCounters(counters, now);
    if (ACTIONS.includes(action)) {
      c.perDay[action] = (c.perDay[action] || 0) + 1;
      c.perWeek[action] = (c.perWeek[action] || 0) + 1;
    }
    c.totalDay = (c.totalDay || 0) + 1;
    return c;
  }

  /* ── Gates: hours, warm-up, caps ──────────────────────────────────────────*/
  function withinWorkingHours(settings, now) {
    const h = new Date(now).getHours();
    const a = settings.workStartHour, b = settings.workEndHour;
    if (a === b) return true;                    // degenerate config → always on
    return a < b ? (h >= a && h < b) : (h >= a || h < b);
  }
  // Weekend gate: real B2B outreach rarely happens Sat/Sun, so sending then reads
  // as automated. On by default. (0 = Sunday, 6 = Saturday.)
  function withinWorkingDays(settings, now) {
    if (!settings.skipWeekends) return true;
    const d = new Date(now).getDay();
    return d !== 0 && d !== 6;
  }
  function withinSendWindow(settings, now) {
    return withinWorkingHours(settings, now) && withinWorkingDays(settings, now);
  }
  // Gentle warm-up: 30% of caps on day 1, climbing to 100% by ~day 6. Slower is
  // safer — a brand-new automation pattern that ramps gradually looks far less
  // like a bot than one that opens at full volume on day one.
  function warmupFactor(settings, firstRunDay, now) {
    if (!settings.warmupEnabled || !firstRunDay) return 1;
    const [y, m, d] = String(firstRunDay).split('-').map(Number);
    const start = new Date(y, m - 1, d).getTime();
    if (isNaN(start)) return 1;
    const days = Math.max(0, Math.floor((now - start) / DAY_MS));
    return clamp(0.3 + days * 0.12, 0.3, 1);
  }
  function effectiveDayCap(settings, action, firstRunDay, now) {
    const base = (settings.caps[action] && settings.caps[action].day) || 9999;
    return Math.max(1, Math.floor(base * warmupFactor(settings, firstRunDay, now)));
  }
  // Returns a reason string if `action` is capped right now, else null.
  function capBlock(counters, settings, action, firstRunDay, now) {
    const c = normalizeCounters(counters, now);
    if ((c.totalDay || 0) >= (settings.caps.totalDay || 99999)) {
      return `daily action ceiling (${settings.caps.totalDay})`;
    }
    if (ACTIONS.includes(action)) {
      const dayCap = effectiveDayCap(settings, action, firstRunDay, now);
      if ((c.perDay[action] || 0) >= dayCap) return `${action} daily cap (${dayCap})`;
      const weekCap = (settings.caps[action] && settings.caps[action].week) || 99999;
      if ((c.perWeek[action] || 0) >= weekCap) return `${action} weekly cap (${weekCap})`;
    }
    return null;
  }

  /* ── Prospect model ───────────────────────────────────────────────────────*/
  function initProspect(raw, now) {
    return {
      url: raw.url,
      name: raw.name || '',
      company: raw.company || '',
      title: raw.title || '',
      urn: raw.urn || null,
      connectionState: raw.connectionState || 'unknown', // unknown|connected|not_connected|pending|self
      stepIndex: 0,
      nextDueAt: now,                 // step 0 is due immediately
      status: 'active',               // active|waiting_accept|sending|done|failed|replied|stopped
      reason: '',
      waitStartedAt: 0,
      failCount: 0,
      history: [],
      addedAt: now,
    };
  }

  function stepFor(campaign, prospect) {
    const steps = (campaign && campaign.steps) || [];
    return steps[prospect.stepIndex] || null;
  }
  const isActive = p => p.status === 'active' || p.status === 'waiting_accept';

  // Flip prospects that have run out of steps (but were left active) to done.
  function reapDone(prospects, campaign, now) {
    return prospects.map(p => {
      if (isActive(p) && !stepFor(campaign, p)) {
        return { ...p, status: 'done', reason: p.reason || 'Sequence complete', nextDueAt: now };
      }
      return p;
    });
  }

  /* ── decideNextAction ─────────────────────────────────────────────────────
   * Pick the next prospect+step to run right now. Cap-aware: a maxed-out
   * 'connect' quota must not stall 'message' steps, so we skip capped actions
   * and keep scanning. When nothing is ready we report the soonest wake time.
   *
   * → { kind:'act', index, action, step }
   *   { kind:'idle', untilMs }
   *   { kind:'outside_hours', untilMs }
   *   { kind:'done' }
   */
  function decideNextAction(state, now) {
    const { prospects, campaign, settings, counters, firstRunDay } = state;
    if (!withinSendWindow(settings, now)) {
      const reason = !withinWorkingDays(settings, now) ? 'Weekend — paused until Monday.' : 'Outside working hours — waiting.';
      return { kind: 'outside_hours', untilMs: now + 15 * MIN_MS, reason };
    }
    const order = prospects
      .map((p, i) => i)
      .filter(i => isActive(prospects[i]) && stepFor(campaign, prospects[i]))
      .sort((a, b) => (prospects[a].nextDueAt || 0) - (prospects[b].nextDueAt || 0));

    if (order.length === 0) return { kind: 'done' };

    let soonest = Infinity;
    for (const i of order) {
      const p = prospects[i];
      const step = stepFor(campaign, p);
      const due = p.nextDueAt || 0;
      if (due > now) { soonest = Math.min(soonest, due); continue; }
      const blocked = capBlock(counters, settings, step.action, firstRunDay, now);
      if (blocked) { soonest = Math.min(soonest, now + 20 * MIN_MS); continue; }
      return { kind: 'act', index: i, action: step.action, step };
    }
    return { kind: 'idle', untilMs: soonest === Infinity ? now + 5 * MIN_MS : soonest };
  }

  /* ── gateStep ─────────────────────────────────────────────────────────────
   * Called by background AFTER it has resolved the prospect's FRESH connection
   * state on the loaded profile. Decides what to actually do with this step.
   *
   * → { do:'execute' }
   *   { do:'skip_step', reason }                      (advance, no LinkedIn call)
   *   { do:'wait', untilMs, status, reason }          (re-check later)
   *   { do:'stop_prospect', status, reason }          (end this prospect)
   */
  function gateStep(prospect, step, settings, connState, now) {
    if (connState === 'self') {
      return { do: 'stop_prospect', status: 'failed', reason: 'This is your own profile' };
    }
    if (step.action === 'connect') {
      if (connState === 'connected') return { do: 'skip_step', reason: 'Already connected' };
      if (connState === 'pending')   return { do: 'skip_step', reason: 'Invite already pending' };
      return { do: 'execute' };
    }
    // message / follow / visit
    if (step.requiresConnection) {
      if (connState === 'connected') return { do: 'execute' };
      // Not connected yet: wait for the invite to be accepted, up to acceptWaitDays.
      const started = prospect.waitStartedAt || now;
      const waited = now - started;
      const maxWait = (settings.acceptWaitDays || 14) * DAY_MS;
      if (waited >= maxWait) {
        return { do: 'stop_prospect', status: 'done', reason: 'Invite not accepted in time' };
      }
      const poll = (settings.acceptPollHours || 12) * HOUR_MS;
      return { do: 'wait', untilMs: now + poll, status: 'waiting_accept', reason: 'Waiting for the invite to be accepted' };
    }
    return { do: 'execute' };
  }

  /* ── Step delays ──────────────────────────────────────────────────────────
   * A step's delay is a single {delayValue, delayUnit} pair (unit ∈ sec/min/hour/
   * day) — cleaner than four separate d/h/m/s boxes. The old delayDays/delayHours
   * (and delayMinutes/delaySeconds) fields are still honored for any campaign saved
   * before this change.
   */
  const UNIT_MS = { sec: 1000, min: MIN_MS, hour: HOUR_MS, day: DAY_MS };
  const UNIT_LABEL = { sec: 'seconds', min: 'minutes', hour: 'hours', day: 'days' };

  function stepDelayMs(step) {
    if (!step) return 0;
    if (typeof step.delayValue === 'number' && step.delayUnit && UNIT_MS[step.delayUnit]) {
      return Math.max(0, step.delayValue) * UNIT_MS[step.delayUnit];
    }
    return ((step.delayDays || 0) * DAY_MS) + ((step.delayHours || 0) * HOUR_MS)
         + ((step.delayMinutes || 0) * MIN_MS) + ((step.delaySeconds || 0) * 1000);
  }
  // {value, unit} for the editor — pick the largest unit that divides evenly.
  function deriveDelay(step) {
    if (step && typeof step.delayValue === 'number' && step.delayUnit && UNIT_MS[step.delayUnit]) {
      return { value: step.delayValue, unit: step.delayUnit };
    }
    const ms = stepDelayMs(step);
    if (ms <= 0) return { value: 0, unit: 'min' };
    for (const u of ['day', 'hour', 'min', 'sec']) if (ms % UNIT_MS[u] === 0) return { value: ms / UNIT_MS[u], unit: u };
    return { value: Math.round(ms / 1000), unit: 'sec' };
  }
  // Human label for a step's wait, e.g. "immediately", "30 seconds", "2 hours".
  function formatDelay(step) {
    const ms = stepDelayMs(step);
    if (ms <= 0) return 'immediately';
    const { value, unit } = deriveDelay(step);
    const label = UNIT_LABEL[unit] || unit;
    return `${value} ${value === 1 ? label.replace(/s$/, '') : label}`;
  }

  /* ── Advancing state ──────────────────────────────────────────────────────*/
  // Jittered due time for the NEXT step, given its configured delay.
  function nextDueAt(now, step) {
    const base = stepDelayMs(step);
    let due;
    if (base <= 0) {
      due = now + Math.floor(30_000 + Math.random() * 60_000);     // 30–90s spacing
    } else {
      // ±15% jitter so no two waits are identical; scales with the delay so short
      // (seconds/minutes) waits stay short and long (days) waits spread out.
      const jitter = Math.round((Math.random() * 2 - 1) * base * 0.15);
      due = now + base + jitter;
    }
    return Math.max(now, due);
  }

  /* applyResult — fold an execution/skip outcome back into state.
   * result.status ∈ 'ok' | 'skipped' | 'halt' | 'fatal' | 'failed' | 'replied'
   *   ok      — action performed (bump counters, advance)
   *   skipped — nothing sent but the step is satisfied (advance, no counter)
   *   halt    — LinkedIn wall/quota → stop the whole engine (keep the step)
   *   fatal   — driver tab lost → pause the engine (keep the step)
   *   failed  — transient error → retry up to maxStepRetries, then fail prospect
   *   replied — prospect replied → stop this prospect's sequence
   * → { prospects, counters, consecFail, engineStop? }
   */
  function applyResult(state, index, result, now) {
    const prospects = state.prospects.map(p => ({ ...p }));
    let counters = normalizeCounters(state.counters, now);
    let consecFail = state.consecFail || 0;
    let engineStop = null;
    const settings = state.settings || defaultSettings();
    const p = prospects[index];
    const step = stepFor(state.campaign, p) || {};

    p.history = (p.history || []).concat([{
      action: step.action || '?', at: now, result: result.status, reason: result.reason || '',
    }]).slice(-40);

    if (result.status === 'halt') {
      engineStop = { runState: 'halted', reason: result.reason || 'LinkedIn blocked the action — stopped for safety' };
      p.status = 'active'; p.reason = result.reason || '';
      return { prospects, counters, consecFail, engineStop };
    }
    if (result.status === 'fatal') {
      engineStop = { runState: 'paused', reason: result.reason || 'Driver tab lost' };
      p.status = 'active'; p.reason = '';
      return { prospects, counters, consecFail, engineStop };
    }
    if (result.status === 'replied') {
      p.status = 'replied'; p.reason = 'They replied — sequence stopped'; consecFail = 0;
      p.nextDueAt = now;
      return { prospects, counters, consecFail, engineStop };
    }
    if (result.status === 'ok' || result.status === 'skipped') {
      const wasConnect = step.action === 'connect';
      if (result.status === 'ok' && !result.noCount) counters = bumpCounters(counters, step.action, now);
      consecFail = 0;
      p.failCount = 0;
      p.stepIndex = (p.stepIndex || 0) + 1;
      const next = stepFor(state.campaign, p);
      if (!next) {
        p.status = 'done';
        p.reason = result.reason || 'Sequence complete';
        p.nextDueAt = now;
      } else {
        if (wasConnect && result.status === 'ok') {
          p.connectionState = 'pending';   // we just invited; the next conn-gated step waits
          p.waitStartedAt = now;
        }
        p.nextDueAt = nextDueAt(now, next);
        p.status = 'active';
        p.reason = '';
      }
      return { prospects, counters, consecFail, engineStop };
    }

    // failed
    p.failCount = (p.failCount || 0) + 1;
    consecFail = consecFail + 1;
    if (p.failCount >= (settings.maxStepRetries || 3)) {
      p.status = 'failed';
      p.reason = result.reason || 'Failed';
      p.nextDueAt = now;
    } else {
      p.status = 'active';
      p.nextDueAt = now + 30 * MIN_MS;             // retry the same step later
      p.reason = (result.reason || 'Failed') + ' — will retry';
    }
    if (consecFail >= (settings.maxConsecFail || 6)) {
      engineStop = { runState: 'paused', reason: `Paused after ${consecFail} failures in a row. Check you're still logged in to LinkedIn, then Start again.` };
    }
    return { prospects, counters, consecFail, engineStop };
  }

  /* applyGate — fold a non-executing gate outcome (wait / skip / stop) into state. */
  function applyGate(state, index, outcome, now) {
    let prospects = state.prospects.map(p => ({ ...p }));
    const p = prospects[index];
    if (outcome.do === 'wait') {
      if (!p.waitStartedAt) p.waitStartedAt = now;    // anchor the accept clock once
      p.status = outcome.status || 'waiting_accept';
      p.nextDueAt = outcome.untilMs;
      p.reason = outcome.reason || '';
      return { prospects };
    }
    if (outcome.do === 'stop_prospect') {
      p.status = outcome.status || 'done';
      p.reason = outcome.reason || '';
      p.nextDueAt = now;
      return { prospects };
    }
    if (outcome.do === 'skip_step') {
      return applyResult({ ...state, prospects }, index, { status: 'skipped', reason: outcome.reason }, now);
    }
    return { prospects };
  }

  /* ── UI summary ───────────────────────────────────────────────────────────*/
  function summarize(state, now) {
    const c = normalizeCounters(state.counters, now || Date.now());
    const s = { active: 0, waiting: 0, done: 0, failed: 0, replied: 0, sending: 0, total: state.prospects.length };
    for (const p of state.prospects) {
      if (p.status === 'active') s.active++;
      else if (p.status === 'waiting_accept') s.waiting++;
      else if (p.status === 'done') s.done++;
      else if (p.status === 'failed') s.failed++;
      else if (p.status === 'replied') s.replied++;
      else if (p.status === 'sending') s.sending++;
    }
    return { counts: s, counters: c };
  }

  /* safetyStatus — a compact, human summary of the guardrails currently in force,
   * for the UI to display (so the user can SEE that conservative limits are active).
   */
  function safetyStatus(state, now) {
    now = now || Date.now();
    const settings = state.settings || defaultSettings();
    const firstRunDay = state.firstRunDay || null;
    const factor = warmupFactor(settings, firstRunDay, now);
    const warming = !!settings.warmupEnabled && factor < 1;
    let warmupDay = null;
    if (settings.warmupEnabled && firstRunDay) {
      const [y, m, d] = String(firstRunDay).split('-').map(Number);
      const start = new Date(y, m - 1, d).getTime();
      if (!isNaN(start)) warmupDay = Math.max(1, Math.floor((now - start) / DAY_MS) + 1);
    }
    const effective = {};
    for (const a of ACTIONS) effective[a] = effectiveDayCap(settings, a, firstRunDay, now);
    return {
      warming, warmupDay, factorPct: Math.round(factor * 100),
      effective,                                  // today's warmed per-action daily caps
      totalDay: settings.caps.totalDay,
      inHours: withinWorkingHours(settings, now),
      weekend: !withinWorkingDays(settings, now),
      sending: withinSendWindow(settings, now),
      dryRun: !!settings.dryRun,
    };
  }

  const EngineCore = {
    ACTIONS, DAY_MS, HOUR_MS, MIN_MS,
    defaultSettings, defaultCampaign,
    renderTemplate, splitName,
    dayKey, normalizeCounters, bumpCounters,
    withinWorkingHours, withinWorkingDays, withinSendWindow, warmupFactor, effectiveDayCap, capBlock,
    initProspect, stepFor, isActive, reapDone,
    UNIT_MS, UNIT_LABEL, stepDelayMs, deriveDelay, formatDelay,
    decideNextAction, gateStep, nextDueAt,
    applyResult, applyGate, summarize, safetyStatus,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = EngineCore;
  root.EngineCore = EngineCore;
})(typeof self !== 'undefined' ? self : globalThis);
