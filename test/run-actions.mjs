/* OutreachPilot — op-core action tests (mocked globals, no deps).
 *
 *   node test/run-actions.mjs
 *
 * Loads the SHIPPING op-core.js with a fake document/location/fetch and verifies
 * each Voyager call: CSRF from the cookie, member-URN + connection-distance
 * resolution, the connect / message / follow request shapes, the dash→legacy
 * message fallback, response classification, and that dry-run sends nothing.
 */

// ── Minimal browser-ish globals op-core touches ────────────────────────────
let COOKIE = 'JSESSIONID="ajax:9988"; li_at=abc';
let LOCATION = { pathname: '/in/ada-lovelace/', href: 'https://www.linkedin.com/in/ada-lovelace/' };
let DOMTEXT = '';                                   // documentElement.innerHTML
let FETCH;                                          // per-test handler
const calls = [];                                   // recorded fetch calls

global.window = {};
global.document = {
  get cookie() { return COOKIE; },
  querySelectorAll: () => [],
  querySelector: () => null,
  documentElement: { get innerHTML() { return DOMTEXT; } },
};
global.location = LOCATION;
// (global.crypto already exists in Node 22 with randomUUID — op-core uses it.)
global.fetch = async (url, opts) => { calls.push({ url, opts }); return FETCH(url, opts); };
const reply = (status, text, ok) => ({ ok: ok ?? (status >= 200 && status < 300), status, text: async () => text });

const OP = await import('../op-core.js').then(() => global.window.OPCore);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const section = s => console.log('\n' + s);
const lastBody = () => JSON.parse(calls[calls.length - 1].opts.body);
const reset = () => { calls.length = 0; };

/* ── session + identity ────────────────────────────────────────────────────*/
section('session + identity');
eq(OP.csrfToken(), 'ajax:9988', 'CSRF read from JSESSIONID cookie');
eq(OP.currentSlug(), 'ada-lovelace', 'slug from location');
eq(OP.canonUrl('https://uk.linkedin.com/in/Ada-Lovelace?trk=x'), 'https://www.linkedin.com/in/Ada-Lovelace', 'canonical url (country sub + query stripped)');

section('distance classification');
eq(OP.distanceFromText('"distance":{"value":"DISTANCE_1"}'), 'connected', 'DISTANCE_1 → connected');
eq(OP.distanceFromText('junk "DISTANCE_2" junk'), 'not_connected', 'DISTANCE_2 → not_connected');
eq(OP.distanceFromText('"distance":{"value":"SELF"}'), 'self', 'SELF → self');
eq(OP.distanceFromText('nothing here'), 'unknown', 'no signal → unknown');

section('resolveProfile via identity API');
{
  reset();
  const idJson = '{"publicIdentifier":"ada-lovelace","entityUrn":"urn:li:fsd_profile:ACoAAABBB","distance":{"value":"DISTANCE_1"}}';
  FETCH = (url) => url.includes('/identity/dash/profiles') ? reply(200, idJson) : reply(404, '');
  const r = await OP.resolveProfile();
  eq(r.urn, 'urn:li:fsd_profile:ACoAAABBB', 'urn resolved from identity API');
  eq(r.connectionState, 'connected', 'connection distance resolved alongside urn');
  eq(r.source, 'identity-api', 'source recorded');
}

/* ── connect (proven path) ─────────────────────────────────────────────────*/
section('connect');
{
  reset();
  FETCH = () => reply(200, '{"value":{}}');
  const r = await OP.doConnect('urn:li:fsd_profile:XYZ', 'Hi Ada!', {});
  eq(r.status, 'ok', 'connect ok on 2xx');
  const c = calls[calls.length - 1];
  ok(c.url.includes('verifyQuotaAndCreateV2'), 'hits verifyQuotaAndCreateV2 endpoint');
  eq(c.opts.method, 'POST', 'POST');
  eq(c.opts.headers['csrf-token'], 'ajax:9988', 'csrf header set');
  const b = lastBody();
  eq(b.invitee.inviteeUnion.memberProfile, 'urn:li:fsd_profile:XYZ', 'invitee urn in body');
  eq(b.customMessage, 'Hi Ada!', 'note in customMessage');
}
{
  reset(); FETCH = () => reply(429, 'reached the weekly invitation limit');
  eq((await OP.doConnect('urn:li:fsd_profile:XYZ', '', {})).status, 'halt', '429/quota → halt');
}
{
  reset(); FETCH = () => reply(200, '{"exception":"cant_resend_yet already invited"}', true);
  eq((await OP.doConnect('urn:li:fsd_profile:XYZ', '', {})).status, 'skipped', 'already-invited → skipped');
}
{
  reset(); FETCH = () => reply(200, 'should-not-be-called');
  const r = await OP.doConnect('urn:li:fsd_profile:XYZ', 'note', { dryRun: true });
  eq(r.status, 'skipped', 'dry run → skipped');
  eq(calls.length, 0, 'dry run makes NO network call');
}

/* ── message (dash primary, legacy fallback) ───────────────────────────────*/
section('message');
{
  reset();
  FETCH = (url) => {
    if (url.endsWith('/voyager/api/me')) return reply(200, '{"entityUrn":"urn:li:fsd_profile:ME123"}');
    if (url.includes('createMessage')) return reply(201, '{"value":{}}');
    return reply(404, '');
  };
  const r = await OP.doMessage('urn:li:fsd_profile:REC1', 'Thanks for connecting!', {});
  eq(r.status, 'ok', 'dash message ok');
  const create = calls.find(c => c.url.includes('createMessage'));
  ok(!!create, 'called createMessage');
  const b = JSON.parse(create.opts.body);
  eq(b.hostRecipientUrns, ['urn:li:fsd_profile:REC1'], 'recipient urn in hostRecipientUrns');
  eq(b.mailboxUrn, 'urn:li:fsd_profile:ME123', 'my mailbox urn resolved from /me');
  eq(b.message.body.text, 'Thanks for connecting!', 'message text in body');
}
{
  // dash 500 → fall back to legacy conversations?action=create with member-id recipients
  reset();
  FETCH = (url) => {
    if (url.endsWith('/voyager/api/me')) return reply(200, '{"entityUrn":"urn:li:fsd_profile:ME123"}');
    if (url.includes('createMessage')) return reply(500, 'server error');
    if (url.includes('messaging/conversations?action=create')) return reply(200, '{"value":{}}');
    return reply(404, '');
  };
  const r = await OP.doMessage('urn:li:fsd_profile:REC9', 'hello', {});
  eq(r.status, 'ok', 'legacy fallback ok when dash fails');
  const legacy = calls.find(c => c.url.includes('conversations?action=create'));
  ok(!!legacy, 'fell back to legacy create');
  eq(JSON.parse(legacy.opts.body).conversationCreate.recipients, ['REC9'], 'legacy recipients = member id fragment');
}
{
  reset(); FETCH = () => reply(200, 'noop');
  const r = await OP.doMessage('urn:li:fsd_profile:REC1', '   ', {});
  eq(r.status, 'skipped', 'empty body → skipped'); eq(calls.length, 0, 'no call for empty body');
}
{
  reset(); FETCH = () => reply(200, 'noop');
  const r = await OP.doMessage('urn:li:fsd_profile:REC1', 'hi', { dryRun: true });
  eq(r.status, 'skipped', 'dry run message → skipped'); eq(calls.length, 0, 'dry run sends nothing');
}

/* ── follow ────────────────────────────────────────────────────────────────*/
section('follow');
{
  reset(); FETCH = () => reply(200, '{"value":{}}');
  const r = await OP.doFollow('urn:li:fsd_profile:REC1', {});
  eq(r.status, 'ok', 'follow ok');
  ok(calls[calls.length - 1].url.includes('FollowingStates'), 'hits following-states endpoint');
}

/* ── reply detection ───────────────────────────────────────────────────────*/
section('reply detection');
{
  reset();
  // last event is from the recipient (not me) → replied
  FETCH = (url) => {
    if (url.endsWith('/voyager/api/me')) return reply(200, '{"entityUrn":"urn:li:fsd_profile:ME123"}');
    return reply(200, '{"from":"urn:li:fs_messagingMember:ME123"},{"from":"urn:li:fs_messagingMember:REC1"}');
  };
  eq(await OP.hasReplied('urn:li:fsd_profile:REC1'), true, 'inbound-latest → replied');
  reset();
  FETCH = (url) => {
    if (url.endsWith('/voyager/api/me')) return reply(200, '{"entityUrn":"urn:li:fsd_profile:ME123"}');
    return reply(200, '{"from":"urn:li:fs_messagingMember:ME123"}');
  };
  eq(await OP.hasReplied('urn:li:fsd_profile:REC1'), false, 'only my message → not replied');
  reset(); FETCH = () => reply(500, '');
  eq(await OP.hasReplied('urn:li:fsd_profile:REC1'), null, 'error → unknown (null)');
}

console.log(`\n${fail ? '✗' : '✓'} op-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
