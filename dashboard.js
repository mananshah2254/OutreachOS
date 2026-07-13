/* OutreachOS — dashboard.js  (options page control center)
 * Campaign builder, safety config, leads table (CSV in/out), capture viewer,
 * and run controls. Uses window.EngineCore (engine-core.js) for defaults + the
 * same summary/model helpers the engine uses. All state in chrome.storage.local.
 */
(() => {
  'use strict';
  const E = window.EngineCore;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function get() {
    const s = await chrome.storage.local.get(['prospects', 'campaign', 'settings', 'counters', 'runState', 'lastEvent', 'capRing']);
    return {
      prospects: s.prospects || [],
      campaign: s.campaign || E.defaultCampaign(),
      settings: { ...E.defaultSettings(), ...(s.settings || {}) },
      counters: s.counters || E.normalizeCounters({}, Date.now()),
      runState: s.runState || 'idle',
      lastEvent: s.lastEvent || null,
      capRing: s.capRing || [],
    };
  }
  const set = obj => chrome.storage.local.set(obj);

  /* ── KPIs + state ──────────────────────────────────────────────────────── */
  const prefersReduced = matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Smoothly tween a number element from its current value to `to`.
  function animateCount(el, to) {
    const from = parseInt(String(el.textContent).replace(/[^0-9-]/g, ''), 10) || 0;
    if (from === to || prefersReduced) { el.textContent = to; return; }
    const dur = 450, t0 = performance.now();
    const tick = t => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  let kpiBuilt = false;
  function renderKpis(st) {
    const sum = E.summarize(st, Date.now());
    const c = sum.counters;
    const cells = [
      ['Actions today', c.totalDay || 0, `/${st.settings.caps.totalDay}`],
      ['Active', sum.counts.active + sum.counts.sending, ''],
      ['Awaiting accept', sum.counts.waiting, ''],
      ['Done', sum.counts.done, ''],
      ['Replied', sum.counts.replied, ''],
      ['Failed', sum.counts.failed, ''],
    ];
    const box = $('kpis');
    if (!kpiBuilt) {
      box.innerHTML = cells.map(([l, , suf], i) => `<div class="kpi"><div class="n num"><span data-kn="${i}">0</span><small data-ks="${i}">${suf}</small></div><div class="l">${l}</div></div>`).join('');
      kpiBuilt = true;
    }
    cells.forEach(([, val, suf], i) => {
      const n = box.querySelector(`[data-kn="${i}"]`); if (n) animateCount(n, val);
      const s = box.querySelector(`[data-ks="${i}"]`); if (s) s.textContent = suf;
    });

    $('state').className = 'state ' + st.runState;
    const label = { idle: 'Idle', running: 'Running', paused: 'Paused', halted: 'Halted', done: 'All done' }[st.runState] || st.runState;
    $('state-t').textContent = st.lastEvent && st.lastEvent.reason ? `${label} · ${st.lastEvent.reason}` : label;
    const activeish = sum.counts.active + sum.counts.waiting + sum.counts.sending;
    $('start').disabled = st.runState === 'running' || activeish === 0;
    $('pause').disabled = st.runState !== 'running';
    $('stop').disabled = st.runState === 'idle';
    renderSafety(st);
  }

  // The reassurance strip: shows the guardrails actually in force right now.
  function renderSafety(st) {
    const ss = E.safetyStatus(st, Date.now());
    const bar = $('safebar');
    let icon = '🛡', cls = 'safebar', head;
    if (ss.dryRun) { icon = '🧪'; cls = 'safebar warn'; head = '<b>Dry run</b> — the full flow runs but nothing is actually sent.'; }
    else if (ss.weekend) { icon = '🌙'; cls = 'safebar warn'; head = '<b>Weekend</b> — outreach is paused until Monday (safer, less bot-like).'; }
    else if (ss.warming) { head = `<b>Warming up — day ${ss.warmupDay} of ~6.</b> Limits ramp up gradually to protect a fresh account.`; }
    else { head = '<b>Safe mode on.</b> Conservative limits, randomized human pacing, auto-stop on any LinkedIn warning.'; }
    bar.className = cls;
    const chips = [
      `${ss.effective.connect} invites/day`,
      `${ss.effective.message} messages/day`,
      `${ss.totalDay} actions/day max`,
      ss.inHours ? 'business hours' : 'outside hours',
    ].map(c => `<span class="chip">${c}</span>`).join('');
    bar.innerHTML = `<span class="ic">${icon}</span><span class="grow">${head}</span><span class="chips">${chips}</span>`;
  }

  /* ── Campaign builder ──────────────────────────────────────────────────── */
  const ACTION_OPTS = ['visit', 'connect', 'message', 'follow'];
  const ACTION_ICON = { visit: '👁', connect: '🤝', message: '✉️', follow: '＋' };
  const UNIT_OPTS = [['sec', 'seconds'], ['min', 'minutes'], ['hour', 'hours'], ['day', 'days']];
  let draftSteps = null;   // in-progress edit buffer

  function stepRow(step, i) {
    const needsText = step.action === 'connect' || step.action === 'message';
    const dd = E.deriveDelay(step);
    const el = document.createElement('div');
    el.className = 'step';
    el.innerHTML = `
      <div class="badge" title="Step ${i + 1}">${ACTION_ICON[step.action] || (i + 1)}</div>
      <div>
        <div class="steplabel">Step ${i + 1} · action</div>
        <select data-k="action">${ACTION_OPTS.map(a => `<option value="${a}"${a === step.action ? ' selected' : ''}>${a}</option>`).join('')}</select>
      </div>
      <div>
        <div class="steplabel">Wait ${i === 0 ? '' : 'after previous'}</div>
        <div class="delay">
          <input type="number" data-k="delayValue" min="0" max="999" value="${dd.value}">
          <select data-k="delayUnit">${UNIT_OPTS.map(([v, l]) => `<option value="${v}"${v === dd.unit ? ' selected' : ''}>${l}</option>`).join('')}</select>
        </div>
      </div>
      <div>
        <div class="steplabel">${step.action === 'message' ? 'Message' : step.action === 'connect' ? 'Invite note (optional)' : 'No message for this action'}</div>
        <textarea data-k="template" placeholder="${needsText ? 'Hi {first}, …' : ''}" ${needsText ? '' : 'disabled style="opacity:.4"'}>${esc(step.template || '')}</textarea>
        <div class="stepopts">
          ${step.action === 'message' ? `<label class="tog"><input type="checkbox" data-k="stopIfReplied" ${step.stopIfReplied ? 'checked' : ''}> Stop if they reply</label>` : ''}
          ${step.action === 'message' ? `<span class="faint">waits for accept automatically</span>` : ''}
        </div>
      </div>
      <div class="x" title="Remove step">✕</div>`;

    el.querySelectorAll('[data-k]').forEach(inp => {
      inp.addEventListener('change', () => readSteps());
      inp.addEventListener('input', () => { if (inp.dataset.k === 'action') readSteps(true); });
    });
    el.querySelector('.x').onclick = () => { draftSteps.splice(i, 1); renderSteps(); };
    return el;
  }
  function readSteps(rerender) {
    const rows = [...$('steps').children];
    draftSteps = rows.map(r => {
      const g = k => r.querySelector(`[data-k="${k}"]`);
      const action = g('action').value;
      const unit = g('delayUnit') ? g('delayUnit').value : 'min';
      return {
        action,
        delayValue: clampInt(g('delayValue').value, 0, 999, 0),
        delayUnit: E.UNIT_MS[unit] ? unit : 'min',
        template: g('template') ? g('template').value : '',
        requiresConnection: action === 'message',
        stopIfReplied: g('stopIfReplied') ? g('stopIfReplied').checked : (action === 'message'),
      };
    });
    if (rerender) renderSteps();
  }
  function renderSteps() {
    const box = $('steps'); box.innerHTML = '';
    draftSteps.forEach((s, i) => box.appendChild(stepRow(s, i)));
    validateCampaign();
  }
  function validateCampaign() {
    // Warn if a message precedes any connect and no prior connection is assumed.
    let sawConnect = false, warn = '';
    for (const s of draftSteps) {
      if (s.action === 'connect') sawConnect = true;
      if (s.action === 'message' && !sawConnect) { warn = 'Heads up: a message step comes before any connect step. It will only fire for prospects who are already your 1st-degree connections; others will wait for an accept that never comes and time out.'; break; }
    }
    const note = $('camp-note');
    if (warn) { note.style.display = 'block'; note.textContent = warn; } else { note.style.display = 'none'; }
  }
  const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return isNaN(n) ? d : Math.min(hi, Math.max(lo, n)); };

  /* ── Safety limits ─────────────────────────────────────────────────────── */
  function renderCaps(st) {
    const acts = ['visit', 'connect', 'message', 'follow'];
    $('caps').innerHTML = acts.map(a => `
      <div class="capbox">
        <div class="t">${a}</div>
        <div class="r">
          <div><div class="l">Day</div><input type="number" data-cap="${a}.day" min="1" max="500" value="${st.settings.caps[a].day}"></div>
          <div><div class="l">Week</div><input type="number" data-cap="${a}.week" min="1" max="2000" value="${st.settings.caps[a].week}"></div>
        </div>
      </div>`).join('') + `
      <div class="capbox">
        <div class="t">All actions</div>
        <div class="r"><div><div class="l">Total / day</div><input type="number" data-cap="totalDay" min="1" max="600" value="${st.settings.caps.totalDay}"></div></div>
      </div>`;
    $('s-hs').value = st.settings.workStartHour;
    $('s-he').value = st.settings.workEndHour;
    $('s-acceptDays').value = st.settings.acceptWaitDays;
    $('s-pollHours').value = st.settings.acceptPollHours;
    $('s-batch').value = st.settings.batchSize;
    $('s-min').value = Math.round(st.settings.withinMinMs / 1000);
    $('s-max').value = Math.round(st.settings.withinMaxMs / 1000);
    $('s-warmup').checked = st.settings.warmupEnabled;
    $('s-weekends').checked = !st.settings.skipWeekends;   // UI shows "send on weekends" = inverse of skip
    $('s-dry').checked = st.settings.dryRun;
  }
  async function saveSettings() {
    const st = await get();
    const caps = JSON.parse(JSON.stringify(st.settings.caps));
    document.querySelectorAll('[data-cap]').forEach(inp => {
      const path = inp.dataset.cap.split('.');
      const v = clampInt(inp.value, 1, 2000, 1);
      if (path.length === 2) caps[path[0]][path[1]] = v; else caps[path[0]] = v;
    });
    const min = clampInt($('s-min').value, 10, 600, 60) * 1000;
    const max = Math.max(min + 1000, clampInt($('s-max').value, 20, 1200, 120) * 1000);
    const settings = {
      ...st.settings, caps,
      workStartHour: clampInt($('s-hs').value, 0, 23, 8),
      workEndHour: clampInt($('s-he').value, 1, 24, 20),
      acceptWaitDays: clampInt($('s-acceptDays').value, 1, 60, 14),
      acceptPollHours: clampInt($('s-pollHours').value, 1, 72, 12),
      batchSize: clampInt($('s-batch').value, 1, 30, 6),
      withinMinMs: min, withinMaxMs: max,
      warmupEnabled: $('s-warmup').checked,
      skipWeekends: !$('s-weekends').checked,             // "send on weekends" checked → don't skip
      dryRun: $('s-dry').checked,
    };
    await set({ settings });
    flash($('save-settings'), 'Saved ✓');
  }

  /* ── Prospects table ───────────────────────────────────────────────────── */
  function renderProspects(st) {
    const tb = $('prospects'); tb.innerHTML = '';
    $('prospect-empty').style.display = st.prospects.length ? 'none' : 'block';
    st.prospects.slice(0, 500).forEach((p, i) => {
      const tr = document.createElement('tr');
      const step = (p.status === 'active' || p.status === 'sending' || p.status === 'waiting_accept')
        ? `${(p.stepIndex || 0) + 1}/${st.campaign.steps.length}` : '—';
      tr.innerHTML = `
        <td><div class="tname">${esc(p.name || '(unknown)')}</div><div class="tsub">${esc(shortUrl(p.url))}</div></td>
        <td class="muted">${esc(p.company || '')}${p.title ? `<div class="tsub">${esc(p.title)}</div>` : ''}</td>
        <td><span class="pill ${p.status}"><span class="d"></span>${esc(p.status.replace('_', ' '))}</span></td>
        <td class="muted num">${step}</td>
        <td class="muted">${esc((p.connectionState || 'unknown').replace('_', ' '))}</td>
        <td class="faint">${esc(p.reason || '')}</td>
        <td><span class="x" data-i="${i}" title="Remove">✕</span></td>`;
      tr.querySelector('.x').onclick = async () => {
        const s = await get(); s.prospects.splice(i, 1); await set({ prospects: s.prospects });
      };
      tb.appendChild(tr);
    });
  }
  const shortUrl = u => String(u || '').replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, '/in/').replace(/\/$/, '');

  /* ── CSV import / export ───────────────────────────────────────────────── */
  function parseCsv(text) {
    const rows = [];
    let field = '', row = [], inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') { if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; } if (c === '\r' && text[i + 1] === '\n') i++; }
        else field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  async function importCsv(text) {
    const rows = parseCsv(text).filter(r => r.some(c => c.trim()));
    if (!rows.length) return;
    const header = rows[0].map(h => h.trim().toLowerCase());
    const idx = names => { for (const n of names) { const i = header.indexOf(n); if (i !== -1) return i; } return -1; };
    const iUrl = idx(['url', 'profileurl', 'profile url', 'linkedin', 'linkedin url', 'link']);
    const iName = idx(['name', 'full name', 'fullname']);
    const iFirst = idx(['first name', 'firstname', 'first']);
    const iLast = idx(['last name', 'lastname', 'last']);
    const iCo = idx(['company', 'organization', 'company name']);
    const iTitle = idx(['title', 'job title', 'headline', 'position']);
    const hasHeader = iUrl !== -1 || iName !== -1;
    const start = hasHeader ? 1 : 0;
    const urlCol = iUrl !== -1 ? iUrl : 0;

    const items = [];
    for (let r = start; r < rows.length; r++) {
      const row = rows[r];
      const rawUrl = (row[urlCol] || '').trim();
      const url = canon(rawUrl);
      if (!url) continue;
      let name = iName !== -1 ? (row[iName] || '').trim() : '';
      if (!name && iFirst !== -1) name = [(row[iFirst] || '').trim(), (row[iLast] || '').trim()].filter(Boolean).join(' ');
      items.push({ url, name, company: iCo !== -1 ? (row[iCo] || '').trim() : '', title: iTitle !== -1 ? (row[iTitle] || '').trim() : '' });
    }
    const st = await get();
    const have = new Set(st.prospects.map(p => p.url.toLowerCase()));
    let added = 0;
    for (const it of items) { if (have.has(it.url.toLowerCase())) continue; have.add(it.url.toLowerCase()); st.prospects.push(E.initProspect(it, Date.now())); added++; }
    await set({ prospects: st.prospects });
    flash($('import-btn'), `Imported ${added}`);
  }
  const canon = u => { const m = String(u || '').match(/^https?:\/\/([\w-]+\.)*linkedin\.com\/in\/([^/?#]+)/i); if (!m) return null; let s = m[2]; try { s = decodeURIComponent(s); } catch {} return `https://www.linkedin.com/in/${s}`; };

  async function exportCsv() {
    const st = await get();
    const head = ['name', 'company', 'title', 'url', 'status', 'step', 'connection', 'last_result', 'history'];
    const q = s => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
    const lines = [head.join(',')];
    for (const p of st.prospects) {
      const hist = (p.history || []).map(h => `${h.action}:${h.result}`).join(' | ');
      lines.push([p.name, p.company, p.title, p.url, p.status, (p.stepIndex || 0) + 1, p.connectionState, p.reason, hist].map(q).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `outreachpilot-${E.dayKey(Date.now())}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ── Capture viewer ────────────────────────────────────────────────────── */
  function renderCaptures(st) {
    const box = $('cap-list');
    const tagged = (st.capRing || []).filter(e => e.tag).slice(-8).reverse();
    if (!tagged.length) { box.innerHTML = '<div class="faint">Nothing captured yet. Send a message or follow manually on LinkedIn, then Refresh.</div>'; return; }
    box.innerHTML = tagged.map(e => `
      <div class="cap-item">
        <div class="cap-url">${esc(e.url)}</div>
        ${e.body ? `<pre>${esc(e.body)}</pre>` : '<div class="faint">no body captured</div>'}
        <div class="faint">${new Date(e.t).toLocaleTimeString()}</div>
      </div>`).join('');
  }

  /* ── Run controls (need a LinkedIn tab bound) ──────────────────────────── */
  async function start() {
    let tabs = await chrome.tabs.query({ url: ['*://*.linkedin.com/*'] });
    let tabId;
    if (tabs.length) tabId = tabs.find(t => t.active)?.id ?? tabs[0].id;
    else { const t = await chrome.tabs.create({ url: 'https://www.linkedin.com/feed/', active: false }); tabId = t.id; await new Promise(r => setTimeout(r, 2500)); }
    chrome.runtime.sendMessage({ type: 'op:start', tabId });
  }

  /* ── Wiring + live refresh ───────────────────────────────────────────────
   * Live data (counters, prospects, captures) is safe to re-render on any storage
   * change. The cadence and safety-limit inputs hold UNSAVED user edits, so they
   * are only re-rendered on first load or when THEIR storage key actually changes
   * (i.e. a save) — otherwise a live run would wipe out mid-edit typing.
   */
  async function renderAll(which) {
    which = which || {};
    const st = await get();
    renderKpis(st);
    renderProspects(st);
    renderCaptures(st);
    if (which.all || which.campaign) {
      if (!draftSteps) { draftSteps = JSON.parse(JSON.stringify(st.campaign.steps)); $('camp-name').value = st.campaign.name || ''; }
      renderSteps();
    }
    if (which.all || which.settings) renderCaps(st);
  }
  function flash(btn, text) { const o = btn.textContent; btn.textContent = text; btn.disabled = true; setTimeout(() => { btn.textContent = o; btn.disabled = false; }, 1500); }

  document.addEventListener('DOMContentLoaded', () => {
    $('start').onclick = start;
    $('pause').onclick = () => chrome.runtime.sendMessage({ type: 'op:pause' });
    $('stop').onclick = () => chrome.runtime.sendMessage({ type: 'op:stop' });

    $('add-step').onclick = () => { readSteps(); draftSteps.push({ action: 'message', delayValue: 2, delayUnit: 'day', template: '', requiresConnection: true, stopIfReplied: true }); renderSteps(); };
    $('save-camp').onclick = async () => { readSteps(); await set({ campaign: { name: $('camp-name').value.trim() || 'My cadence', steps: draftSteps } }); flash($('save-camp'), 'Saved ✓'); };
    $('reset-camp').onclick = async () => { draftSteps = E.defaultCampaign().steps; renderSteps(); $('camp-name').value = E.defaultCampaign().name; };

    $('save-settings').onclick = saveSettings;

    $('import-btn').onclick = () => $('import-file').click();
    $('import-file').onchange = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => importCsv(String(r.result)); r.readAsText(f); e.target.value = ''; };
    $('export-csv').onclick = exportCsv;
    $('clear-prospects').onclick = async () => { const s = await get(); await set({ prospects: s.prospects.filter(p => p.status === 'sending') }); };
    $('refresh-cap').onclick = () => renderAll();

    renderAll({ all: true });
    chrome.storage.onChanged.addListener(changes => {
      const which = {};
      // Only rebuild the cadence / limit inputs when their key actually changed
      // (a save), so a live run's counter writes can't clobber unsaved edits.
      if (changes.campaign) { draftSteps = null; which.campaign = true; }
      if (changes.settings) which.settings = true;
      renderAll(which);
    });
    chrome.runtime.onMessage.addListener(m => { if (m.type === 'op:event') renderAll(); });
  });
})();
