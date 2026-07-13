/* OutreachOS — content.js  (relay + glass sidebar UI)
 *
 * Voyager actions live in op-core.js (window.OPCore); the sequence brain in
 * engine-core.js (window.EngineCore) — both loaded before this file. This file:
 *   1. relays the service worker's action requests to OPCore
 *   2. renders the glass control panel (shadow DOM) that drives a run and lets you
 *      add targets / export a search / peek at the queue. The full campaign builder
 *      is the dashboard (options page).
 */
(() => {
  'use strict';
  if (window.top !== window.self) return;           // top frame only
  if (window.__op_loaded__) return;
  window.__op_loaded__ = true;
  const OP = window.OPCore;
  const E = window.EngineCore;

  /* ── Relay: engine → OPCore ───────────────────────────────────────────────
   * This is the ONLY onMessage listener in the content script that returns `true`
   * (async response). Chrome's message channel is fragile when multiple listeners
   * exist and any of them is an `async function` (it returns a Promise, which
   * Chrome misreads as an async-response signal and the real response is lost).
   * So every other bit of message handling here is folded into ONE plain,
   * non-async listener below that never returns true. Do not add an `async`
   * listener anywhere in this file.
   */
  const LOG = (...a) => console.log('[OP]', ...a);
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('op:')) return;
    const ACTION = /^op:(resolve|visit|connect|message|follow|hasReplied|scrape)$/.test(msg.type);
    if (ACTION && !OP) { LOG('core not loaded, cannot handle', msg.type); sendResponse({ status: 'failed', reason: 'OutreachOS core not loaded on this page — reload the LinkedIn tab' }); return; }
    // Wrap sendResponse so a lost/late reply is visible in the page console.
    const reply = label => r => { LOG(label, '→', (r && r.status) || r); try { sendResponse(r); } catch (e) { LOG('sendResponse failed (channel closed?)', String(e)); } };
    const failClosed = label => e => { LOG(label, 'threw', String(e)); try { sendResponse({ status: 'failed', reason: String(e && e.message || e) }); } catch {} };
    try {
      switch (msg.type) {
        case 'op:ping': sendResponse({ ok: true }); return;
        case 'op:scrape': sendResponse({ profiles: OP.scrapeCurrentPage() }); return;
        case 'op:resolve': OP.resolveProfile().then(reply('resolve')).catch(failClosed('resolve')); return true;
        case 'op:visit': OP.doVisit().then(reply('visit')).catch(failClosed('visit')); return true;
        case 'op:connect': OP.doConnect(msg.urn, msg.note, { dryRun: !!msg.dryRun }).then(reply('connect')).catch(failClosed('connect')); return true;
        case 'op:message': OP.doMessage(msg.urn, msg.text, { dryRun: !!msg.dryRun }).then(reply('message')).catch(failClosed('message')); return true;
        case 'op:follow': OP.doFollow(msg.urn, { dryRun: !!msg.dryRun }).then(reply('follow')).catch(failClosed('follow')); return true;
        case 'op:hasReplied': OP.hasReplied(msg.urn).then(r => reply('hasReplied')({ replied: r })).catch(() => sendResponse({ replied: null })); return true;
      }
    } catch (e) { LOG('handler threw', msg.type, String(e)); sendResponse({ status: 'failed', reason: String(e && e.message || e) }); }
  });

  /* ── UI ───────────────────────────────────────────────────────────────────*/
  buildUI();

  function buildUI() {
    if (document.getElementById('__op_host__')) return;
    const host = document.createElement('div');
    host.id = '__op_host__';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial;
          --bg:#150e1b; --surface:#211730; --surface2:#2b2040; --line:rgba(255,255,255,.10);
          --text:#f7f0f6; --muted:#bcafc6; --faint:#867a92;
          --a1:#ff6f91; --a2:#ffa863; --accent:#ff7d94; --accent2:#ffa863; --go:#37e0ac; --warn:#ffc24d; --bad:#fb3d5b; --wait:#c774ff;
          --grad:linear-gradient(135deg,var(--a1),var(--a2)); }
        * { box-sizing:border-box; margin:0; font-family:-apple-system,"SF Pro Text",Inter,system-ui,sans-serif; }
        .num{ font-variant-numeric:tabular-nums; }
        /* docked to the right edge like a side rail (flush, rounded on the inner side) */
        .panel { position:fixed; top:64px; right:0; width:344px; max-height:calc(100vh - 88px);
          display:flex; flex-direction:column; z-index:2147483000;
          background:rgba(26,18,36,.86);
          -webkit-backdrop-filter:blur(30px) saturate(1.7); backdrop-filter:blur(30px) saturate(1.7);
          border:1px solid var(--line); border-right:none; border-radius:18px 0 0 18px;
          box-shadow:-14px 0 44px rgba(10,4,16,.5), inset 0 1px 0 rgba(255,255,255,.08); color:var(--text); overflow:hidden;
          transition:transform .55s cubic-bezier(.22,1,.36,1), box-shadow .45s ease; will-change:transform; }
        .panel::before{ content:""; position:absolute; top:0; left:0; right:0; height:2.5px; background:linear-gradient(90deg,var(--a1),var(--a2),var(--wait),var(--a1)); background-size:300% 100%; animation:op-sheen 8s linear infinite; z-index:2; }
        .panel::after{ content:""; position:absolute; inset:0; z-index:-1; pointer-events:none; background:radial-gradient(60% 30% at 80% 0%, rgba(255,111,145,.14), transparent 70%), radial-gradient(50% 30% at 10% 100%, rgba(199,116,255,.12), transparent 70%); }
        @keyframes op-sheen{ 0%{ background-position:0% 0 } 100%{ background-position:300% 0 } }
        .hd { display:flex; align-items:center; gap:10px; padding:14px 15px; border-bottom:1px solid var(--line); }
        .mark { width:32px; height:32px; border-radius:10px; position:relative; flex:none; display:flex; align-items:center; justify-content:center; overflow:hidden; background:linear-gradient(145deg,#ff6f91 0%,#ff8b7a 46%,#ffb066 100%); box-shadow:0 6px 16px rgba(255,111,145,.5), inset 0 1px 0 rgba(255,255,255,.6), inset 0 -5px 12px rgba(150,30,70,.3); animation:op-markglow 5s ease-in-out infinite; }
        .mark::before{ content:""; position:absolute; inset:0; border-radius:inherit; pointer-events:none; background:linear-gradient(180deg,rgba(255,255,255,.55) 0%,rgba(255,255,255,.12) 34%,rgba(255,255,255,0) 60%); }
        .mark svg{ position:relative; z-index:1; filter:drop-shadow(0 1.5px 1.5px rgba(130,25,70,.45)); }
        @keyframes op-markglow{ 0%,100%{ box-shadow:0 6px 16px rgba(255,111,145,.45), inset 0 1px 0 rgba(255,255,255,.6), inset 0 -5px 12px rgba(150,30,70,.3) } 50%{ box-shadow:0 8px 24px rgba(255,168,99,.55), inset 0 1px 0 rgba(255,255,255,.65), inset 0 -5px 12px rgba(150,30,70,.3) } }
        .ttl { font-weight:740; font-size:14px; letter-spacing:-.02em; flex:1; background:var(--grad); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
        .ico { cursor:pointer; color:var(--faint); font-size:14px; padding:3px 6px; border-radius:6px; }
        .ico:hover{ color:var(--text); background:var(--surface2); }
        .body { padding:14px 15px; overflow-y:auto; }
        .row { display:flex; gap:8px; }
        .stat { flex:1; border:1px solid var(--line); border-radius:12px; padding:9px 10px; background:rgba(255,255,255,.04); -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px); box-shadow:inset 0 1px 0 rgba(255,255,255,.06); transition:transform .15s, border-color .15s, background .15s; }
        .stat:hover { transform:translateY(-2px); border-color:rgba(255,111,145,.32); background:rgba(255,255,255,.06); }
        .stat .n { font-size:19px; font-weight:660; letter-spacing:-.02em; }
        .stat .n small{ font-size:11px; color:var(--faint); font-weight:500; }
        .stat .l { font-size:9px; opacity:.7; text-transform:uppercase; letter-spacing:.07em; color:var(--faint); margin-top:4px; font-weight:600; }
        .safety { position:relative; overflow:hidden; margin:12px 0 0; padding:10px 12px; border-radius:11px; background:linear-gradient(120deg,rgba(55,224,172,.11),rgba(55,224,172,.04)); border:1px solid rgba(55,224,172,.24); display:flex; align-items:center; gap:9px; font-size:11px; color:#9deccb; line-height:1.4; }
        .safety::after{ content:""; position:absolute; top:0; left:-140%; width:55%; height:100%; background:linear-gradient(105deg,transparent,rgba(255,255,255,.12),transparent); transform:skewX(-18deg); animation:op-shimmer 6s ease-in-out infinite; }
        @keyframes op-shimmer{ 0%,72%{ left:-140% } 88%,100%{ left:140% } }
        .safety .shield{ font-size:13px; animation:op-shield 3.2s ease-in-out infinite; }
        @keyframes op-shield{ 0%,100%{ transform:scale(1) } 50%{ transform:scale(1.14); filter:drop-shadow(0 0 5px rgba(55,224,172,.5)) } }
        .safety.warn { background:linear-gradient(120deg,rgba(245,181,68,.11),rgba(245,181,68,.04)); border-color:rgba(245,181,68,.26); color:#f3d197; }
        .safety span{ position:relative; z-index:1; }
        .state { margin:11px 0 3px; font-size:11.5px; color:var(--muted); display:flex; align-items:center; gap:8px; line-height:1.4; }
        .state .d{ width:7px; height:7px; border-radius:50%; background:var(--faint); flex:none; }
        .state.running{ color:var(--go);} .state.running .d{ background:var(--go); }
        .state.paused,.state.done{ color:var(--warn);} .state.paused .d,.state.done .d{ background:var(--warn); }
        .state.halted{ color:var(--bad);} .state.halted .d{ background:var(--bad); }
        .btns { display:flex; gap:8px; margin:12px 0 10px; }
        button { font-family:inherit; cursor:pointer; border:none; }
        button.act { flex:1; border-radius:11px; padding:10px; font-weight:680; font-size:13px; transition:transform .12s, box-shadow .18s, filter .18s, background .18s; }
        button.act:active{ transform:translateY(1px) scale(.98); }
        .start{ background:var(--grad); color:#fff; box-shadow:0 5px 16px rgba(255,111,145,.4); }
        .start:not(:disabled):hover{ filter:brightness(1.09); box-shadow:0 7px 22px rgba(255,111,145,.55); }
        .pause{ background:transparent; border:1px solid var(--line); color:var(--text); }
        .pause:hover{ border-color:rgba(255,255,255,.18); background:var(--surface2); }
        .stop{ background:transparent; border:1px solid var(--line); color:var(--bad); }
        .stop:hover{ border-color:rgba(251,61,91,.4); background:rgba(251,61,91,.08); }
        button.act:disabled{ opacity:.35; cursor:default; }
        .tog { display:flex; align-items:center; gap:8px; font-size:12.5px; cursor:pointer; user-select:none; color:var(--muted); }
        .tog input{ appearance:none; width:32px; height:19px; border-radius:999px; background:rgba(255,255,255,.13); position:relative; cursor:pointer; transition:background .18s; flex:none; }
        .tog input:checked{ background:var(--grad); box-shadow:0 0 10px rgba(255,111,145,.4); }
        .tog input::after{ content:""; position:absolute; top:3px; left:3px; width:13px; height:13px; border-radius:50%; background:#fff; transition:transform .2s cubic-bezier(.3,1.4,.5,1); }
        .tog input:checked::after{ transform:translateX(13px); }
        .sec { margin-top:14px; border-top:1px solid var(--line); padding-top:13px; }
        .sec h4 { margin:0 0 9px; font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--faint); font-weight:600; }
        textarea, input[type=number] { width:100%; background:var(--bg); border:1px solid var(--line); border-radius:9px; color:var(--text); font-size:12px; padding:9px; resize:vertical; font-family:inherit; }
        textarea{ min-height:52px; line-height:1.5; }
        textarea::placeholder{ color:var(--faint); }
        textarea:focus, input:focus{ outline:none; border-color:rgba(255,111,145,.6); box-shadow:0 0 0 3px rgba(255,111,145,.14); }
        .hint{ font-size:10px; color:var(--faint); margin-top:6px; line-height:1.5; }
        .addbtn{ width:100%; border:1px solid var(--line); border-radius:9px; padding:9px; font-size:12px; font-weight:600; background:transparent; color:var(--text); margin-top:8px; transition:background .15s, border-color .15s, transform .12s; }
        .addbtn:hover{ background:var(--surface2); border-color:rgba(255,111,145,.28); }
        .addbtn:active{ transform:translateY(1px); }
        .inline{ display:flex; gap:8px; align-items:stretch; margin-top:8px; }
        .inline input{ width:64px; text-align:center; }
        .inline .addbtn{ margin-top:0; flex:1; }
        .steps{ display:flex; flex-direction:column; gap:6px; }
        .stp{ display:flex; align-items:center; gap:9px; font-size:11.5px; color:var(--muted); }
        .stp .b{ width:20px; height:20px; border-radius:6px; background:var(--surface2); border:1px solid var(--line); display:flex; align-items:center; justify-content:center; font-size:10px; flex:none; color:var(--text); font-weight:700; }
        .stp .a{ color:var(--text); font-weight:600; text-transform:capitalize; }
        .qhd { display:flex; justify-content:space-between; align-items:center; }
        .qhd a { font-size:10.5px; color:var(--faint); cursor:pointer; font-weight:600; }
        .qhd a:hover{ color:var(--bad); }
        .qlist { margin-top:8px; max-height:186px; overflow-y:auto; }
        .qi { display:flex; align-items:center; gap:9px; padding:8px 0; border-top:1px solid var(--line); font-size:11.5px; }
        .qi:first-child{ border-top:none; }
        .qi .nm { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:540; }
        .qi .sub { color:var(--faint); font-size:10px; font-weight:400; }
        .st { display:inline-flex; align-items:center; gap:6px; font-size:10px; color:var(--muted); white-space:nowrap; text-transform:capitalize; }
        .st .d{ width:6px; height:6px; border-radius:50%; background:var(--faint); }
        .st.sending .d,.st.sending{ color:var(--accent); } .st.sending .d{ background:var(--accent); animation:op-dotpulse 1s infinite; }
        .st.active .d{ background:var(--accent); animation:op-dotpulse 1.9s infinite; }
        .st.waiting_accept{ color:var(--wait);} .st.waiting_accept .d{ background:var(--wait); }
        .st.done{ color:var(--go);} .st.done .d{ background:var(--go); }
        .st.replied{ color:var(--go);} .st.replied .d{ background:var(--go); }
        .st.failed{ color:var(--bad);} .st.failed .d{ background:var(--bad); }
        .warn { font-size:10px; color:var(--muted); margin-top:13px; line-height:1.55; padding-top:12px; border-top:1px solid var(--line); }
        /* minimize = slide the whole rail off the right, leaving a handle tab.
           Uses the transform transition (no keyframe) so it can't fight the mount. */
        .panel.mounting{ transform:translateX(100%); }
        .panel.collapsed{ transform:translateX(calc(100% - 46px)); box-shadow:-10px 0 34px rgba(10,4,16,.55); }
        .panel.collapsed:hover{ transform:translateX(calc(100% - 60px)); }   /* peek out on hover */
        .handle{ position:absolute; left:0; top:0; bottom:0; width:46px; z-index:5; cursor:pointer;
          display:flex; flex-direction:column; align-items:center; justify-content:space-between; padding:14px 0 16px;
          /* opaque so the slid-off body can't bleed through the tab */
          background:linear-gradient(180deg, rgba(255,111,145,.18), rgba(199,116,255,.12)), #17101f;
          border-right:1px solid var(--line);
          opacity:0; pointer-events:none; transition:opacity .3s ease; }
        .panel.collapsed .handle{ opacity:1; pointer-events:auto; }
        .handle .hmark{ width:28px; height:28px; border-radius:9px; flex:none; display:flex; align-items:center; justify-content:center; overflow:hidden; position:relative;
          background:linear-gradient(145deg,#ff6f91,#ff8b7a 46%,#ffb066); box-shadow:0 5px 14px rgba(255,111,145,.5), inset 0 1px 0 rgba(255,255,255,.5); animation:op-markglow 5s ease-in-out infinite; }
        .handle .hmark svg{ filter:drop-shadow(0 1px 1px rgba(130,25,70,.4)); }
        .handle .hlabel{ writing-mode:vertical-rl; transform:rotate(180deg); font-size:11px; font-weight:750; letter-spacing:.16em; text-transform:uppercase;
          background:var(--grad); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
        .handle .hchev{ color:var(--a1); font-size:16px; font-weight:700; animation:op-nudge 1.8s ease-in-out infinite; }
        .handle:hover .hchev{ color:var(--a2); }
        @keyframes op-nudge{ 0%,100%{ transform:translateX(0) } 50%{ transform:translateX(-4px) } }
        @keyframes op-bodyin{ from{ opacity:0; transform:translateY(4px) } to{ opacity:1; transform:none } }
        .panel:not(.collapsed):not(.mounting) .body{ animation:op-bodyin .45s cubic-bezier(.2,.8,.2,1) .08s both; }
        @keyframes op-fade{ from{ opacity:0; transform:translateY(4px) } to{ opacity:1; transform:none } }
        .qi{ animation:op-fade .3s ease both; }
        @keyframes op-dotpulse{ 0%{ box-shadow:0 0 0 0 currentColor } 70%{ box-shadow:0 0 0 5px transparent } 100%{ box-shadow:0 0 0 0 transparent } }
        .state.running .d{ animation:op-dotpulse 1.7s infinite; }
        .state.halted .d{ animation:op-dotpulse 1.2s infinite; }
        @media(prefers-reduced-motion:reduce){ *,.panel::before,.safety::after{ animation:none!important; transition:none!important } }
      </style>
      <div class="panel mounting" id="panel">
        <div class="handle" id="handle" title="Expand OutreachOS">
          <div class="hmark"><svg viewBox="0 0 24 24" width="16" height="16" fill="none"><path d="M21.4 3 3.2 9.1 10.6 12.4Z" fill="#fff" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/><path d="M21.4 3 10.6 12.4 14 20.2Z" fill="#fff" fill-opacity=".68" stroke="#fff" stroke-opacity=".68" stroke-width="1.1" stroke-linejoin="round"/></svg></div>
          <div class="hlabel">OutreachOS</div>
          <div class="hchev">&#8249;</div>
        </div>
        <div class="hd">
          <div class="mark"><svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M21.4 3 3.2 9.1 10.6 12.4Z" fill="#fff" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/><path d="M21.4 3 10.6 12.4 14 20.2Z" fill="#fff" fill-opacity=".68" stroke="#fff" stroke-opacity=".68" stroke-width="1.1" stroke-linejoin="round"/></svg></div><div class="ttl">OutreachOS</div>
          <div class="ico" id="open-dash" title="Open full dashboard">&#8599;</div>
          <div class="ico" id="min" title="Minimize to the edge">&#8211;</div>
        </div>
        <div class="body">
          <div class="row">
            <div class="stat"><div class="n num" id="s-today">0<small>/50</small></div><div class="l">Actions today</div></div>
            <div class="stat"><div class="n num" id="s-active">0</div><div class="l">Active</div></div>
            <div class="stat"><div class="n num" id="s-wait">0</div><div class="l">Awaiting accept</div></div>
          </div>
          <div class="safety" id="safety"><span class="shield">🛡</span><span id="safety-t">Safe mode on</span></div>
          <div class="state" id="state"><span class="d"></span><span id="state-t">Idle</span></div>
          <div class="btns">
            <button class="act start" id="start">Start</button>
            <button class="act pause" id="pause">Pause</button>
            <button class="act stop" id="stop">Stop</button>
          </div>
          <label class="tog" title="Runs the whole flow but never actually sends"><input type="checkbox" id="dry-run"> Dry run (don't actually send)</label>
          <button class="addbtn" id="diagnose" style="margin-top:10px">Test this profile</button>
          <div class="hint" id="diag-out" style="display:none;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;margin-top:8px"></div>

          <div class="sec">
            <h4>Campaign</h4>
            <div class="steps" id="steps"></div>
            <button class="addbtn" id="edit-camp">Edit cadence &amp; limits in dashboard</button>
          </div>

          <div class="sec">
            <h4>Add prospects</h4>
            <button class="addbtn" id="add-page" style="margin-top:0">Add everyone on this page</button>
            <div class="inline">
              <input type="number" id="pages" min="1" max="20" value="3" title="How many search pages to export">
              <button class="addbtn" id="export">Export this search</button>
            </div>
            <textarea id="urls" placeholder="…or paste profile URLs, one per line" style="margin-top:9px"></textarea>
            <button class="addbtn" id="add-urls">Add URLs</button>
          </div>

          <div class="sec">
            <div class="qhd"><h4 style="margin:0">Prospects</h4><a id="clear-q">Clear all</a></div>
            <div class="qlist" id="qlist"></div>
          </div>

          <div class="warn">Runs at a human pace from your own browser. Automating LinkedIn breaks its User Agreement and can restrict your account. Keep this tab open while running. Use conservatively, at your own risk.</div>
        </div>
      </div>`;

    const $ = id => shadow.getElementById(id);
    const panel = $('panel');
    // Slide the docked rail in from the right edge on mount.
    requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.remove('mounting')));
    // Minimize collapses to the edge handle; clicking the handle expands it back.
    $('min').onclick = () => panel.classList.add('collapsed');
    $('handle').onclick = () => panel.classList.remove('collapsed');
    // Remember the collapsed state across page loads.
    chrome.storage.local.get('opPanelCollapsed', ({ opPanelCollapsed }) => { if (opPanelCollapsed) panel.classList.add('collapsed'); });
    const persistCollapsed = () => chrome.storage.local.set({ opPanelCollapsed: panel.classList.contains('collapsed') });
    $('min').addEventListener('click', persistCollapsed);
    $('handle').addEventListener('click', persistCollapsed);

    function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

    function render(st) {
      const sum = E.summarize(st, Date.now());
      $('s-today').innerHTML = `${sum.counters.totalDay || 0}<small>/${st.settings.caps.totalDay}</small>`;
      $('s-active').textContent = sum.counts.active + sum.counts.sending;
      $('s-wait').textContent = sum.counts.waiting;

      // Safety strip: show the user the guardrails that are actually in force.
      const ss = E.safetyStatus(st, Date.now());
      const safety = $('safety'); const st2 = $('safety-t');
      if (ss.dryRun) { safety.className = 'safety warn'; st2.textContent = 'Dry run — nothing is actually sent'; }
      else if (ss.weekend) { safety.className = 'safety warn'; st2.textContent = 'Weekend — paused until Monday'; }
      else if (ss.warming) { safety.className = 'safety'; st2.textContent = `Warming up (day ${ss.warmupDay}) · up to ${ss.effective.connect} invites today`; }
      else { safety.className = 'safety'; st2.textContent = `Safe pace · up to ${ss.effective.connect} invites / ${ss.effective.message} messages today`; }

      $('state').className = 'state ' + st.runState;
      const ev = st.lastEvent;
      const label = { idle: 'Idle', running: 'Running', paused: 'Paused', halted: 'Halted', done: 'All done' }[st.runState] || st.runState;
      $('state-t').textContent = ev && ev.reason ? `${label} · ${ev.reason}` : label;

      const activeish = sum.counts.active + sum.counts.waiting + sum.counts.sending;
      $('start').disabled = st.runState === 'running' || activeish === 0;
      $('pause').disabled = st.runState !== 'running';
      $('stop').disabled = st.runState === 'idle';

      // campaign steps
      const steps = $('steps'); steps.innerHTML = '';
      (st.campaign.steps || []).forEach((s, i) => {
        const d = E.formatDelay(s);
        const wait = d === 'immediately' ? '' : ` · +${d}`;
        const el = document.createElement('div'); el.className = 'stp';
        el.innerHTML = `<span class="b">${i + 1}</span><span><span class="a">${esc(s.action)}</span>${wait}${s.requiresConnection ? ' · after accept' : ''}</span>`;
        steps.appendChild(el);
      });

      setIf($('dry-run'), 'checked', st.settings.dryRun);

      const ql = $('qlist'); ql.innerHTML = '';
      st.prospects.slice(0, 40).forEach(p => {
        const stepTxt = p.status === 'active' || p.status === 'sending' ? `step ${(p.stepIndex || 0) + 1}` : '';
        const row = document.createElement('div'); row.className = 'qi';
        row.innerHTML = `<div class="nm">${esc(p.name || p.url)}${p.company ? `<div class="sub">${esc(p.company)}</div>` : ''}${p.reason && p.status !== 'active' ? `<div class="sub">${esc(p.reason)}</div>` : ''}</div>
          <span class="st ${p.status}"><span class="d"></span>${esc(p.status.replace('_', ' '))}${stepTxt ? ' · ' + stepTxt : ''}</span>`;
        ql.appendChild(row);
      });
      if (st.prospects.length > 40) {
        const more = document.createElement('div'); more.className = 'qi'; more.style.opacity = '.5';
        more.innerHTML = `<div class="nm">+${st.prospects.length - 40} more…</div>`; ql.appendChild(more);
      }
    }
    function setIf(el, prop, val) { if (shadow.activeElement === el) return; if (prop === 'checked') el.checked = !!val; else el.value = val; }

    async function fullState() {
      const s = await chrome.storage.local.get(['prospects', 'campaign', 'settings', 'counters', 'runState', 'lastEvent']);
      return {
        prospects: s.prospects || [],
        campaign: s.campaign || E.defaultCampaign(),
        settings: { ...E.defaultSettings(), ...(s.settings || {}) },
        counters: s.counters || E.normalizeCounters({}, Date.now()),
        runState: s.runState || 'idle',
        lastEvent: s.lastEvent || null,
      };
    }
    async function refresh() {
      // If the extension was reloaded, this content script is orphaned and its
      // chrome.* calls throw "Extension context invalidated". Bail quietly and
      // let the user know to reload the page, rather than spamming errors.
      if (!chrome.runtime?.id) { showOrphaned(); return; }
      try { render(await fullState()); }
      catch (e) { if (/context invalidated|Extension context/i.test(String(e))) showOrphaned(); }
    }
    function showOrphaned() {
      const t = shadow.getElementById('state-t');
      if (t) t.textContent = 'Reload this LinkedIn tab (extension was updated)';
    }
    chrome.storage.onChanged.addListener(refresh);
    // SINGLE non-async UI listener (see the relay comment above: no async listeners,
    // and this one never returns true so it can't interfere with the relay's reply).
    chrome.runtime.onMessage.addListener(m => {
      if (!m || typeof m.type !== 'string') return;
      if (m.type === 'op:event') { refresh(); return; }
      if (m.type === 'op:exportProgress') { $('export').textContent = `Page ${m.page} · ${m.total} found`; return; }
      if (m.type === 'op:exportDone' && m.profiles) {
        enqueue(m.profiles)
          .then(n => flash($('export'), `Exported ${m.profiles.length}, added ${n}`))
          .then(refresh);
        return;
      }
      // never returns true → does not hold or corrupt the message channel
    });

    // controls
    $('open-dash').onclick = () => chrome.runtime.sendMessage({ type: 'op:openDash' });
    $('edit-camp').onclick = () => chrome.runtime.sendMessage({ type: 'op:openDash' });
    $('start').onclick = () => chrome.runtime.sendMessage({ type: 'op:start' });
    $('pause').onclick = () => chrome.runtime.sendMessage({ type: 'op:pause' });
    $('stop').onclick = () => chrome.runtime.sendMessage({ type: 'op:stop' });
    $('dry-run').onchange = async e => {
      const s = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...E.defaultSettings(), ...(s.settings || {}), dryRun: e.target.checked } });
    };

    $('diagnose').onclick = async () => {
      const out = $('diag-out'); out.style.display = 'block'; out.textContent = 'Checking…';
      let d; try { d = await OP.diagnose(); } catch (e) { d = { error: String(e) }; }
      if (d.error) { out.textContent = d.error; return; }
      const ok = d.loggedIn && d.urnResolved;
      out.textContent = [
        ok ? '✓ Actions can run on this profile' : '✗ Cannot act here',
        `logged in:  ${d.loggedIn ? 'yes' : 'NO — log into LinkedIn'}`,
        `member id:  ${d.urnResolved ? 'resolved via ' + d.urnSource : 'NOT FOUND'}`,
        `connection: ${d.connectionState}`,
        d.note ? `note:       ${d.note}` : '',
      ].filter(Boolean).join('\n');
    };

    async function enqueue(items) {
      const s = await chrome.storage.local.get('prospects');
      const q = s.prospects || [];
      const have = new Set(q.map(p => p.url.toLowerCase()));
      let added = 0;
      for (const it of items) {
        const key = it.url.toLowerCase(); if (have.has(key)) continue;
        have.add(key); q.push(E.initProspect(it, Date.now())); added++;
      }
      await chrome.storage.local.set({ prospects: q });
      return added;
    }
    $('add-page').onclick = async () => {
      const found = OP.scrapeCurrentPage();
      const n = await enqueue(found);
      flash($('add-page'), n ? `Added ${n}` : (found.length ? 'Already added' : 'No profiles found here'));
    };
    $('export').onclick = async () => {
      const pages = Math.min(Math.max(1, parseInt($('pages').value, 10) || 1), 20);
      flash($('export'), `Exporting ${pages} page(s)…`);
      chrome.runtime.sendMessage({ type: 'op:exportPages', pages });
    };
    // (export-progress / export-done are handled by the single UI listener above)
    $('add-urls').onclick = async () => {
      const matches = $('urls').value.match(/https?:\/\/([\w-]+\.)*linkedin\.com\/in\/[^\s?#/]+/gi) || [];
      const urls = [...new Set(matches.map(OP.canonUrl).filter(Boolean))].map(url => ({ url }));
      const n = await enqueue(urls);
      $('urls').value = '';
      flash($('add-urls'), n ? `Added ${n}` : (matches.length ? 'Already added' : 'No LinkedIn URLs found'));
    };
    $('clear-q').onclick = async () => {
      await chrome.storage.local.set({ prospects: (await chrome.storage.local.get('prospects')).prospects?.filter(p => p.status === 'sending') || [] });
    };
    function flash(btn, text) { const o = btn.textContent; btn.textContent = text; setTimeout(() => (btn.textContent = o), 1600); }

    refresh();
  }
})();
