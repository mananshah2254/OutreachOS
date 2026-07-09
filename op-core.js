/* OutreachOS — op-core.js  (the LinkedIn action layer)
 *
 * Pure-ish logic that runs in the content script (first-party on linkedin.com) so
 * its fetches carry the user's own cookies + CSRF. NO chrome.* APIs — it talks to
 * LinkedIn's OWN internal "Voyager" API, exactly as LinkedIn's UI does, rather than
 * clicking DOM buttons (which churn constantly and break).
 *
 * Exposes window.OPCore. Tested by test/run-actions.mjs with mocked globals.
 *
 * Endpoint provenance / trust levels:
 *   • connect  — PROVEN. Same verifyQuotaAndCreateV2 call ConnectPilot ships.
 *   • visit    — PROVEN. Loading the profile page IS the visit (server logs it).
 *   • message  — CAPTURE-VERIFY. createMessage (dash) primary, legacy fallback.
 *   • follow   — CAPTURE-VERIFY, experimental.
 * The service worker's webRequest capture records LinkedIn's real POSTs so the
 * message/follow contracts can be confirmed/updated from a live click — never
 * reverse-engineered by guessing. See README "Capture".
 */
(() => {
  'use strict';
  const LOG = (...a) => console.log('[OP]', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();

  /* ── Session / headers ───────────────────────────────────────────────────*/
  function csrfToken() {
    const m = (document.cookie || '').match(/JSESSIONID="?(ajax:\d+)"?/);
    return m ? m[1] : null;
  }
  const voyagerHeaders = (extra = {}) => ({
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'csrf-token': csrfToken(),
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'x-li-track': '{"clientVersion":"1.13.0"}',
    ...extra,
  });
  // A random client token (LinkedIn expects a unique per-message dedupe/origin token).
  function uuid() {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
      const r = (Math.random() * 16) | 0; return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /* ── Walls / page identity ───────────────────────────────────────────────*/
  function detectWall() {
    const p = location.pathname;
    if (p.includes('/checkpoint/') || p.includes('/authwall')) return 'Security checkpoint';
    if (document.querySelector('iframe[src*="captcha"], [id*="captcha" i]')) return 'Captcha challenge';
    return null;
  }
  function currentSlug() {
    const m = location.pathname.match(/\/in\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]).toLowerCase() : '';
  }
  function canonUrl(u) {
    const m = String(u || '').match(/^https?:\/\/([\w-]+\.)*linkedin\.com\/in\/([^/?#]+)/i);
    if (!m) return null;
    let slug = m[2]; try { slug = decodeURIComponent(slug); } catch { /* keep raw */ }
    return `https://www.linkedin.com/in/${slug}`;
  }

  /* ── URN + connection distance resolution (three independent strategies) ──
   * We resolve the target's member URN AND their connection distance in the same
   * pass, so acceptance-gating is free. Distance is paired to the slug so we never
   * grab a "People also viewed" card's data.
   */
  const URN_RE = /urn:li:fsd_profile:[A-Za-z0-9_-]+/;

  function pairSlugUrn(text, slug) {
    if (!text || !slug) return null;
    const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = text.match(new RegExp('"entityUrn":"(urn:li:fsd_profile:[^"]+)"(?:(?!"entityUrn")[\\s\\S]){0,700}?"publicIdentifier":"' + esc + '"'))
      || text.match(new RegExp('"publicIdentifier":"' + esc + '"(?:(?!"publicIdentifier")[\\s\\S]){0,700}?"entityUrn":"(urn:li:fsd_profile:[^"]+)"'));
    if (m) return m[1];
    if (text.includes('"publicIdentifier":"' + slug + '"')) { const f = text.match(URN_RE); if (f) return f[0]; }
    return null;
  }
  // DISTANCE_1 → connected, SELF → self, DISTANCE_2/3 → not_connected.
  function distanceFromText(text) {
    if (!text) return 'unknown';
    if (/"distance":\{"value":"(SELF|DISTANCE__SELF)"\}|"DISTANCE__SELF"|"\$type":"com\.linkedin\.voyager\.dash\.identity\.profile\.Profile"[\s\S]{0,80}"SELF"/.test(text)) return 'self';
    if (/"(distance|memberDistance|connectionDistance)":\s*\{?\s*"?(value"?\s*:\s*")?DISTANCE_1"|"DISTANCE_1"|"connectionDegree":\s*1\b/.test(text)) return 'connected';
    if (/"DISTANCE_2"|"DISTANCE_3"|"OUT_OF_NETWORK"|"connectionDegree":\s*[23]\b/.test(text)) return 'not_connected';
    return 'unknown';
  }
  // DOM fallback: on a profile page LinkedIn renders the degree ("1st"/"2nd"/"3rd")
  // in the top card. This is reliable even when the JSON we scraped for the URN
  // didn't carry the distance. Only meaningful when we're ON that person's page.
  function degreeFromBadge() {
    const sels = ['.distance-badge', '[class*="distance-badge"]', '[class*="dist-value"]', 'span.dist-value', '.pv-top-card--list [class*="distance"]'];
    const seen = new Set();
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        if (seen.has(el)) continue; seen.add(el);
        const t = (el.textContent || '').toLowerCase().replace(/\s+/g, ' ');
        if (/(^|[^a-z])1st([^a-z]|$)/.test(t)) return 'connected';
        if (/(^|[^a-z])(2nd|3rd)([^a-z]|$)/.test(t)) return 'not_connected';
      }
    }
    return 'unknown';
  }

  function fromDom(slug) {
    const codes = [...document.querySelectorAll('code, script[type="application/json"]')].map(e => e.textContent || '');
    for (const c of codes) {
      if (c.indexOf('fsd_profile') < 0) continue;
      const urn = pairSlugUrn(c, slug);
      if (urn) return { urn, connectionState: distanceFromText(c) };
    }
    const html = document.documentElement.innerHTML;
    const urn = pairSlugUrn(html, slug);
    return urn ? { urn, connectionState: distanceFromText(html) } : null;
  }
  async function fromIdentityApi(slug) {
    if (!csrfToken()) return null;
    try {
      const res = await fetch('https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=' + encodeURIComponent(slug), { credentials: 'include', headers: voyagerHeaders() });
      if (!res.ok) return null;
      const txt = await res.text();
      const urn = pairSlugUrn(txt, slug) || (txt.match(URN_RE) || [null])[0];
      return urn ? { urn, connectionState: distanceFromText(txt) } : null;
    } catch { return null; }
  }
  async function fromProfileHtml(slug) {
    try {
      const res = await fetch('https://www.linkedin.com/in/' + encodeURIComponent(slug) + '/', { credentials: 'include' });
      if (!res.ok) return null;
      const txt = await res.text();
      const urn = pairSlugUrn(txt, slug) || (txt.match(URN_RE) || [null])[0];
      return urn ? { urn, connectionState: distanceFromText(txt) } : null;
    } catch { return null; }
  }
  async function resolveProfile(slug) {
    slug = slug || currentSlug();
    if (!slug) return { urn: null, connectionState: 'unknown', error: 'not a profile page' };
    let out = null;
    let r = fromDom(slug); if (r && r.urn) out = { ...r, source: 'page' };
    if (!out) { r = await fromIdentityApi(slug); if (r && r.urn) out = { ...r, source: 'identity-api' }; }
    if (!out) { r = await fromProfileHtml(slug); if (r && r.urn) out = { ...r, source: 'profile-html' }; }
    if (!out) return { urn: null, connectionState: 'unknown', error: 'no member id found for this profile' };
    // If the JSON didn't carry a distance, fall back to the on-page degree badge
    // (only valid when we're actually on this person's profile).
    if (out.connectionState === 'unknown' && slug === currentSlug()) {
      const badge = degreeFromBadge();
      if (badge !== 'unknown') out.connectionState = badge;
    }
    return out;
  }

  // My own profile URN (mailbox owner for messaging). Cached on window.
  let _meUrn = null;
  async function getMeUrn() {
    if (_meUrn) return _meUrn;
    try {
      const res = await fetch('https://www.linkedin.com/voyager/api/me', { credentials: 'include', headers: voyagerHeaders() });
      if (res.ok) {
        const txt = await res.text();
        const m = txt.match(/urn:li:fsd_profile:[A-Za-z0-9_-]+/) || txt.match(/urn:li:fs_miniProfile:[A-Za-z0-9_-]+/);
        if (m) { _meUrn = m[0].replace('fs_miniProfile', 'fsd_profile'); return _meUrn; }
      }
    } catch { /* fall through */ }
    return null;
  }

  /* ── Response classification (shared shape across actions) ────────────────
   * → { status: 'ok'|'skipped'|'halt'|'failed', reason }
   */
  function classify(res, txt, okReason) {
    const low = (txt || '').toLowerCase();
    if (res.status === 429 || /\bquota\b|reached the (weekly|monthly|daily|maximum)|too many requests|rate.?limit/i.test(low)) {
      return { status: 'halt', reason: `LinkedIn limit reached (${res.status}) — stopping for safety` };
    }
    if (res.status === 401) return { status: 'halt', reason: 'Session expired (401) — log in to LinkedIn again' };
    if (/cant_resend_yet|already invited|pending invitation|invitation.*already|already sent/i.test(low)) return { status: 'skipped', reason: 'Already invited' };
    if (/already connected|existing connection|is already a connection/i.test(low)) return { status: 'skipped', reason: 'Already connected' };
    if (res.ok && !/exception|"status":4|"status":5|errordetails|"code":"/i.test(low)) return { status: 'ok', reason: okReason };
    if (res.status === 403) return { status: 'skipped', reason: `Not permitted for this person (403)` };
    return { status: 'failed', reason: `HTTP ${res.status}` + (txt ? ': ' + txt.slice(0, 140) : ' (empty response)') };
  }

  /* ── ACTION: visit ────────────────────────────────────────────────────────
   * The engine has already navigated the driven tab to the profile, which is what
   * registers a profile view. We just confirm we're on a real, loaded profile.
   */
  async function doVisit() {
    const wall = detectWall(); if (wall) return { status: 'halt', reason: wall };
    if (!currentSlug()) return { status: 'failed', reason: 'Not on a profile page' };
    if (!csrfToken()) return { status: 'halt', reason: 'Not logged in to LinkedIn' };
    await sleep(rand(600, 1400));                       // brief human-ish dwell
    // A resolvable profile means the page really loaded (not an interstitial).
    const r = await resolveProfile();
    if (!r.urn) return { status: 'failed', reason: 'Profile did not load (' + (r.error || '') + ')' };
    return { status: 'ok', reason: 'Visited', connectionState: r.connectionState, urn: r.urn };
  }

  /* ── ACTION: connect (PROVEN — mirrors ConnectPilot) ─────────────────────*/
  async function doConnect(urn, note, opts = {}) {
    const wall = detectWall(); if (wall) return { status: 'halt', reason: wall };
    if (!csrfToken()) return { status: 'halt', reason: 'Not logged in to LinkedIn' };
    if (!urn) { const r = await resolveProfile(); urn = r.urn; if (!urn) return { status: 'skipped', reason: 'Could not resolve profile id' }; }
    if (opts.dryRun) return { status: 'skipped', reason: `Dry run — would connect (…${urn.slice(-8)})${note ? ' + note' : ''}` };
    const body = { invitee: { inviteeUnion: { memberProfile: urn } } };
    if (note) body.customMessage = String(note).slice(0, 300);
    let res, txt = '';
    try {
      res = await fetch('https://www.linkedin.com/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2', {
        method: 'POST', credentials: 'include',
        headers: voyagerHeaders({ 'content-type': 'application/json; charset=UTF-8' }),
        body: JSON.stringify(body),
      });
      try { txt = await res.text(); } catch { /* empty ok */ }
    } catch (e) { return { status: 'failed', reason: 'Network error: ' + (e && e.message) }; }
    return classify(res, txt, note ? 'Connect sent with note' : 'Connect sent');
  }

  /* ── ACTION: message (CAPTURE-VERIFY) ────────────────────────────────────
   * Primary: voyagerMessagingDashMessengerMessages?action=createMessage (dash).
   * Fallback: legacy messaging/conversations?action=create.
   * Both need the recipient's member id and (dash) our own mailbox urn.
   */
  async function doMessage(urn, text, opts = {}) {
    const wall = detectWall(); if (wall) return { status: 'halt', reason: wall };
    if (!csrfToken()) return { status: 'halt', reason: 'Not logged in to LinkedIn' };
    if (!urn) { const r = await resolveProfile(); urn = r.urn; if (!urn) return { status: 'skipped', reason: 'Could not resolve profile id' }; }
    text = String(text || '').slice(0, 1900);
    if (!text.trim()) return { status: 'skipped', reason: 'Empty message body' };
    if (opts.dryRun) return { status: 'skipped', reason: `Dry run — would message (…${urn.slice(-8)})` };

    const token = uuid();
    const mailbox = await getMeUrn();

    // 1) Primary: dash createMessage.
    if (mailbox) {
      const body = {
        message: { body: { attributes: [], text }, originToken: token, renderContentUnions: [] },
        mailboxUrn: mailbox,
        trackingId: token,
        dedupeByClientGeneratedToken: false,
        hostRecipientUrns: [urn],
      };
      try {
        const res = await fetch('https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage', {
          method: 'POST', credentials: 'include',
          headers: voyagerHeaders({ 'content-type': 'application/json; charset=UTF-8' }),
          body: JSON.stringify(body),
        });
        let txt = ''; try { txt = await res.text(); } catch { /* empty */ }
        const c = classify(res, txt, 'Message sent');
        if (c.status !== 'failed') return c;    // ok / skipped / halt → trust it
        LOG('dash createMessage failed, trying legacy', res.status);
      } catch (e) { LOG('dash createMessage threw', e && e.message); }
    }

    // 2) Fallback: legacy conversations?action=create. recipients = member id fragment.
    const memberId = urn.split(':').pop();
    const legacyBody = {
      keyVersion: 'LEGACY_INBOX',
      conversationCreate: {
        eventCreate: {
          originToken: token,
          value: { 'com.linkedin.voyager.messaging.create.MessageCreate': { attributedBody: { text, attributes: [] }, attachments: [] } },
        },
        recipients: [memberId],
        subtype: 'MEMBER_TO_MEMBER',
      },
    };
    try {
      const res = await fetch('https://www.linkedin.com/voyager/api/messaging/conversations?action=create', {
        method: 'POST', credentials: 'include',
        headers: voyagerHeaders({ 'content-type': 'application/json; charset=UTF-8' }),
        body: JSON.stringify(legacyBody),
      });
      let txt = ''; try { txt = await res.text(); } catch { /* empty */ }
      return classify(res, txt, 'Message sent');
    } catch (e) { return { status: 'failed', reason: 'Network error: ' + (e && e.message) }; }
  }

  /* ── ACTION: follow (CAPTURE-VERIFY, experimental) ───────────────────────*/
  async function doFollow(urn, opts = {}) {
    const wall = detectWall(); if (wall) return { status: 'halt', reason: wall };
    if (!csrfToken()) return { status: 'halt', reason: 'Not logged in to LinkedIn' };
    if (!urn) { const r = await resolveProfile(); urn = r.urn; if (!urn) return { status: 'skipped', reason: 'Could not resolve profile id' }; }
    if (opts.dryRun) return { status: 'skipped', reason: `Dry run — would follow (…${urn.slice(-8)})` };
    const body = { patch: { $set: { following: true } } };
    try {
      const res = await fetch('https://www.linkedin.com/voyager/api/voyagerFeedDashFollowingStates?ids=List(urn%3Ali%3Afsd_followingState%3A' + encodeURIComponent(urn.split(':').pop()) + ')', {
        method: 'POST', credentials: 'include',
        headers: voyagerHeaders({ 'content-type': 'application/json; charset=UTF-8', 'x-http-method-override': 'PATCH' }),
        body: JSON.stringify(body),
      });
      let txt = ''; try { txt = await res.text(); } catch { /* empty */ }
      return classify(res, txt, 'Followed');
    } catch (e) { return { status: 'failed', reason: 'Network error: ' + (e && e.message) }; }
  }

  /* ── Reply detection (best-effort) ───────────────────────────────────────
   * → true (they replied) | false (no reply) | null (couldn't determine).
   * Fetches the 1:1 conversation and checks whether the newest event is inbound
   * (from someone other than me). Never throws; unknown → null (caller decides).
   */
  async function hasReplied(urn) {
    try {
      const me = await getMeUrn();
      const memberId = (urn || '').split(':').pop();
      if (!memberId) return null;
      const res = await fetch('https://www.linkedin.com/voyager/api/messaging/conversations?q=participants&recipients=List(' + encodeURIComponent('urn:li:fsd_profile:' + memberId) + ')&count=1', { credentials: 'include', headers: voyagerHeaders() });
      if (!res.ok) return null;
      const txt = await res.text();
      // Find the latest event's sender. If we can find any event whose sender is
      // NOT me, and it's the most recent, treat as replied.
      const senders = [...txt.matchAll(/"from":"?(urn:li:fs[a-zA-Z]*_?(?:messagingMember|profile):[^"',]+)/g)].map(m => m[1]);
      if (!senders.length) return null;
      const meId = (me || '').split(':').pop();
      const last = senders[senders.length - 1];
      if (!meId) return null;
      return !last.includes(meId);
    } catch { return null; }
  }

  /* ── SCRAPE a list/search page → [{name,company,title,url}] ───────────────*/
  const BAD_NAME = /^(linkedin member|linkedin user)$/i;
  function cleanName(s) {
    return norm(String(s)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\(.*?\)/g, '')
      .replace(/\s*[•·].*$/, '')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .replace(/\b(Dr|Prof|Mr|Ms|Mrs)\.?\s+/gi, ''));
  }
  const validName = n => n && n.length >= 2 && n.split(' ').length >= 2 && !BAD_NAME.test(n);

  function scrapeCurrentPage() {
    const out = [];
    const seen = new Set();
    const add = (name, company, title, url) => {
      url = canonUrl(url); if (!url) return;
      const key = url.toLowerCase(); if (seen.has(key)) return;
      seen.add(key);
      out.push({ name: cleanName(name), company: norm(company), title: norm(title), url, connectionState: 'unknown' });
    };

    // A single open profile page.
    if (/^\/in\/[^/]+/.test(location.pathname)) {
      add(document.querySelector('h1')?.textContent || '', '', '', location.href);
      return out;
    }

    const cardSels = [
      '.entity-result', '[class*="entity-result"]',
      'li[class*="reusable-search__result"]',
      '[data-chameleon-result-urn]', '[data-view-name*="search-entity"]',
      '[class*="mn-connection-card"]', '[class*="discover-entity"]',
      '[class*="pymk"]', '[class*="org-people-profile-card"]',
      'li[class*="artdeco-list__item"]',
    ];
    const cards = new Set();
    cardSels.forEach(s => document.querySelectorAll(s).forEach(c => cards.add(c)));
    if (!cards.size) {
      document.querySelectorAll('a[href*="/in/"]').forEach(a => {
        cards.add(a.closest('li, div[class*="card"], div[class*="result"]') || a.parentElement);
      });
    }
    cards.forEach(card => {
      if (!card) return;
      const link = card.querySelector('a[href*="/in/"]');
      if (!link) return;
      const nameEl = link.querySelector('span[aria-hidden="true"]') || link;
      const subEl = card.querySelector('[class*="subline"], [class*="primary-subtitle"], [class*="entity-result__primary-subtitle"], [class*="subtitle"]');
      const sub = norm(subEl?.textContent || '');
      const parts = sub.split(/\bat\b/i);
      const company = parts.length > 1 ? parts.pop().trim() : '';
      const title = parts.length ? parts.join('at').trim() : sub;
      add(cleanName(nameEl.textContent), company, title, link.href);
    });
    return out.filter(p => validName(p.name));
  }

  /* ── DIAGNOSE (self-test on the current profile) ─────────────────────────*/
  async function diagnose() {
    const slug = currentSlug();
    const r = slug ? await resolveProfile() : { urn: null, error: 'not a profile page' };
    return {
      url: location.href, profileSlug: slug, loggedIn: !!csrfToken(),
      urnResolved: !!r.urn, urn: r.urn, urnSource: r.source || null,
      connectionState: r.connectionState || 'unknown',
      note: r.error || (r.urn ? 'Ready — actions can run on this profile.' : null),
    };
  }

  window.OPCore = {
    detectWall, currentSlug, canonUrl, csrfToken, uuid,
    resolveProfile, getMeUrn,
    doVisit, doConnect, doMessage, doFollow, hasReplied,
    scrapeCurrentPage, diagnose, classify, distanceFromText,
  };
})();
