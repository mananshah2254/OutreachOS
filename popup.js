/* OutreachOS — popup.js  (status snapshot + shortcuts) */
(() => {
  'use strict';
  const E = window.EngineCore;
  const $ = id => document.getElementById(id);

  async function render() {
    const s = await chrome.storage.local.get(['prospects', 'campaign', 'settings', 'counters', 'runState', 'lastEvent']);
    const st = {
      prospects: s.prospects || [],
      campaign: s.campaign || E.defaultCampaign(),
      settings: { ...E.defaultSettings(), ...(s.settings || {}) },
      counters: s.counters || E.normalizeCounters({}, Date.now()),
      runState: s.runState || 'idle',
      lastEvent: s.lastEvent || null,
    };
    const sum = E.summarize(st, Date.now());
    $('today').innerHTML = `${sum.counters.totalDay || 0}<small>/${st.settings.caps.totalDay}</small>`;
    $('active').textContent = sum.counts.active + sum.counts.sending;
    $('wait').textContent = sum.counts.waiting;
    $('state').className = 'state ' + st.runState;
    const label = { idle: 'Idle', running: 'Running', paused: 'Paused', halted: 'Halted', done: 'All done' }[st.runState] || st.runState;
    $('state-t').textContent = st.lastEvent && st.lastEvent.reason ? `${label} · ${st.lastEvent.reason}` : label;
  }

  $('dash').onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };
  $('li').onclick = async () => {
    const tabs = await chrome.tabs.query({ url: ['*://*.linkedin.com/*'] });
    if (tabs.length) chrome.tabs.update(tabs[0].id, { active: true });
    else chrome.tabs.create({ url: 'https://www.linkedin.com/search/results/people/' });
    window.close();
  };
  chrome.storage.onChanged.addListener(render);
  render();
})();
