# OutreachOS — multi-step LinkedIn cadences

A Manifest V3 Chrome extension that runs **PhantomBuster-style LinkedIn outreach
sequences** — visit → connect → *wait for the invite to be accepted* → message →
follow-up — on a human-paced, rate-limited schedule, **entirely inside your own
browser**. It is the big sibling of ConnectPilot: instead of only sending invites,
it drives a whole leads list through a multi-step cadence with per-action limits.

> **Read this first.** Automating LinkedIn violates its User Agreement (§8.2) and
> can get your account restricted or banned. This tool mimics careful human
> behavior and stays well under LinkedIn's limits, but that does **not** make
> automation "allowed." Use conservatively, for authorized outreach only, on an
> account you accept the risk of losing. Start with **Dry run** and a daily cap of 1.

---

## What PhantomBuster does, and how this maps to it

PhantomBuster is a cloud tool: you hand it your LinkedIn session cookie and it
replays it from a datacenter, running "Phantoms" (Search Export, Auto Connect,
Message Sender) and chaining them into a "Workflow" / the "LinkedIn Outreach"
Phantom. The core value is the **multi-step cadence with acceptance-gated
follow-ups** and the **safe rate limits**.

| PhantomBuster | OutreachOS |
|---|---|
| Phantoms (Search Export, Auto Connect, Message Sender, Profile Visitor, Follow) | **Actions**: `visit`, `connect`, `message`, `follow` — all via LinkedIn's own API |
| "LinkedIn Outreach" Workflow (connect → accept → message → follow-up) | **Cadence**: an ordered, editable step list with per-step delays |
| Leads List | **Prospects** table with per-prospect step state, connection state, history |
| Search Export → CSV | **Export this search** (walks N pages) + CSV import/export |
| Cloud cookie replay from a datacenter IP | **Your real browser, real IP, real session** — no cookie leaves your machine |
| Account-safety limits / spread-out sending | **Per-action daily/weekly caps + global ceiling + warm-up + working hours + jitter** |

### Why a browser extension beats the cloud model

LinkedIn's single strongest detection signal is an **IP/session mismatch**: your
account normally logs in from home, then suddenly acts from a server in another
country. Cloud tools that replay your cookie create exactly that mismatch.
OutreachOS runs *in your real browser*, so every request comes from your real
session, IP, and fingerprint. This is the Dux-Soup / LinkedIn Helper model.

---

## The cadence engine (this is the product)

The **default cadence is an AI Engineer referral ask**: visit → connect (with a
short referral note) → after they accept, a fuller referral message → a gentle
follow-up. Every step, delay, and message is editable in the dashboard — the
default is just a starting point. (Note: LinkedIn free accounts limit *personalized
invite notes* to a handful per month; beyond that the invite still sends, just
without the note — which is why the fuller ask also lives in the post-accept
message, not only the invite.)

Each prospect walks its own copy of the cadence. The engine, every tick, asks:
*which prospect's next step is due now, whose action isn't rate-capped?* — runs
exactly one action, then schedules the next tick with a randomized human delay.

The interesting behavior lives in the **step gate**:

- A **`message` step waits until the invite is accepted.** After a `connect`,
  the prospect is marked *pending*; each time a conn-gated step comes due, the
  engine re-reads the person's live connection distance on their profile. Not yet
  1st-degree → it re-checks later (default every 12 h) up to `acceptWaitDays`
  (default 14), then gives up gracefully. 1st-degree → it messages.
- **Already connected** at add-time → the `connect` step is skipped, straight to
  messaging. **Invite already pending** → connect is skipped, message waits.
- **Reply-stop**: before a follow-up `message`, it checks the conversation; if
  they replied, the prospect's sequence stops (no more follow-ups).
- **Own profile / can't-invite / duplicates** are detected and skipped, never retried into the ground.

### Safety engine

| Guardrail | Default | Why |
|---|---|---|
| Per-action daily caps | visit 40 · connect 15 · message 20 · follow 15 | Each action has a *different* LinkedIn ceiling; invites are the risky one |
| Per-action weekly caps | connect 80 · message 100 · visit 200 · follow 80 | The rolling weekly invite cap (~100) is the dangerous one — stay under |
| Global daily ceiling | 50 actions/day | LinkedIn also watches total activity (~150/day); this sits far below |
| Cap-aware scheduling | always | A maxed `connect` quota never stalls `message` steps |
| Within-action delay | 70–140 s (randomized) | No fixed cadence to fingerprint |
| Batch pause | after 5 actions, 8–18 min | Space bursts across the day |
| Working hours | 09:00–18:00 local | Business hours only; off-hours activity looks automated (overnight windows supported) |
| Weekend skip | on | Sat/Sun outreach is unusual for B2B and reads as a bot |
| Warm-up ramp | on | Starts at 30 % of caps on day 1, climbs to 100 % by ~day 6 |
| Halt on detection | always | Instant stop on captcha / checkpoint / limit wall |
| Circuit breaker | 6 failures in a row | Pauses on a systemic problem instead of chewing the list |
| Crash recovery | 1-min watchdog | Self-heals if Chrome kills the worker mid-step; never double-acts |
| Dry run | opt-in | Runs the whole flow (navigate, resolve, gate) but sends nothing |

The scheduler runs on `chrome.alarms` (not `setTimeout`), so it survives Chrome
suspending the service worker during multi-minute pauses. All state
(prospects, cadence, counters, settings) lives in `chrome.storage.local`, so it
survives restarts; counters auto-reset at day/week boundaries.

---

## How one action is performed (API, not button clicks)

OutreachOS calls LinkedIn's own internal **Voyager** API the same way the site
does, from a first-party `fetch` that carries your cookies + CSRF. No DOM
clicking (LinkedIn rewrites its DOM constantly).

| Action | Endpoint | Trust |
|---|---|---|
| **visit** | *(navigating to the profile registers the view server-side)* | **Proven** |
| **connect** | `POST …/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2` | **Proven** (same call ConnectPilot ships) |
| **message** | `POST …/voyagerMessagingDashMessengerMessages?action=createMessage` (dash) → legacy `…/messaging/conversations?action=create` fallback | **Capture-verify** |
| **follow** | `POST …/voyagerFeedDashFollowingStates` | **Capture-verify, experimental** |

Every profile is resolved to its **member URN** three independent ways (page JSON
→ identity API → raw profile HTML), paired to the URL slug so a "People also
viewed" card can't be mistaken for the target. The same pass reads the person's
**connection distance** for acceptance-gating, free.

### Capture (verify/refresh the message & follow contracts)

`message` and `follow` use LinkedIn's *current* internal endpoints, but LinkedIn
changes them. So the service worker uses `chrome.webRequest` to observe LinkedIn's
own POSTs. Send one message (or follow) manually on LinkedIn, open the dashboard →
**Endpoint capture**, and you'll see the exact request LinkedIn sent — confirm it
matches, or copy it to update `op-core.js`. Nothing is reverse-engineered by
guessing; the contract is captured from a real click.

---

## Files

```
manifest.json     MV3; content scripts on linkedin.com; storage+alarms+tabs+webRequest
engine-core.js    PURE sequence brain (no chrome.*/DOM): caps, warm-up, hours,
                  decideNextAction, gateStep, applyResult/applyGate, merge tags.
                  Loaded into the worker via importScripts AND by the Node tests.
op-core.js        The LinkedIn action layer (content script): Voyager calls for
                  visit/connect/message/follow, URN + connection-distance resolution,
                  reply detection, search-page scraping, response classification.
background.js     The orchestrator (service worker): drives one tab, wires the pure
                  engine to op-core, schedules ticks, watchdog, webRequest capture.
content.js        Relay to op-core + the glass control panel (shadow DOM).
dashboard.html/js Full control center: cadence builder, safety limits, leads table
                  (CSV in/out), capture viewer.
popup.html/js     Status snapshot + Open dashboard / Open LinkedIn.
test/run-engine.mjs      105 unit tests for the pure engine (no deps, no browser).
test/run-actions.mjs     37 unit tests for op-core with mocked globals (no deps).
test/run-integration.mjs 16 tests driving the REAL background.js through full runs
                         with chrome.* + the network layer mocked (no deps).
icons/            PNGs generated by a pure-Python zlib/struct script.
```

---

## Install & run

1. `chrome://extensions` → Developer mode → **Load unpacked** → select this folder.
2. Log into LinkedIn in the same Chrome.
3. Open the **dashboard** (extension popup → *Open dashboard*), or use the glass
   panel that appears on any LinkedIn page.
4. **Build your cadence** (or keep the default: visit → connect+note → message on
   accept → follow-up). Save.
5. **Add prospects**: on a LinkedIn search/People page use *Add everyone on this
   page* or *Export this search* (walks N pages); or paste profile URLs; or
   **Import CSV** (`name, company, title, url`).
6. Set your **safety limits** (or keep defaults). Save.
7. Press **Start**. Keep a LinkedIn tab open — the engine drives it. Pause/Stop
   any time.

Debug: DevTools console filtered to `[OP]` (page) and `[OP:bg]` (service worker,
via the extension's "Inspect views: service worker" link).

## Your first real run (do this once, safely)

There is no server — the extension *is* the mechanism, on the real LinkedIn page.

1. In the dashboard, tick **Dry run**, set **connect day cap = 1**, add 1–2 prospects.
2. **Start.** Watch the leads table: each prospect gets navigated, resolved, and
   gated, marked *skipped — Dry run* without sending anything.
3. If that looks right, untick **Dry run** and Start to send 1–2 real invites.
   Confirm they show as *Pending* on LinkedIn.
4. When an invite is accepted, the cadence's message step will fire on its own on
   the next due tick — verify the message endpoint via **Endpoint capture** the
   first time.
5. Only then raise caps toward the defaults.

## Testing (no LinkedIn account needed)

```bash
node test/run-engine.mjs        # 105 pass — the sequence brain end to end
node test/run-actions.mjs       # 37 pass — every Voyager request shape + classification
node test/run-integration.mjs   # 16 pass — the real background.js, driven end to end
```

`run-engine.mjs` includes a full multi-day cadence simulation (visit → connect →
wait-for-accept → message → reply-stop). `run-actions.mjs` loads the *shipping*
`op-core.js` under mocked globals and asserts the connect/message/follow request
bodies, the dash→legacy message fallback, CSRF, URN+distance resolution, and that
dry-run makes zero network calls. `run-integration.mjs` loads the *shipping*
`background.js` exactly as a service worker would (`importScripts` pulls in the real
engine-core), with `chrome.*` and the tab/network layer mocked and a controllable
clock, then drives whole runs: the full cadence with an acceptance wait + reply-stop,
a LinkedIn wall causing a hard halt with nothing advancing, and a per-action cap
holding back further sends. All 158 tests pass.

## Limits / not yet built

- Single driven tab; don't manually navigate that tab while a run is active.
- `message`/`follow` endpoints are capture-verify (see above) — confirm on first use.
- Reply-stop is best-effort; if the conversation can't be read it errs toward
  sending the follow-up.
- Connection-distance parsing is reliable but if it ever can't be read, a message
  step waits (never messages a non-connection) and times out after `acceptWaitDays`.
