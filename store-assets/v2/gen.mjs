/* Generates 5 "advanced" Chrome Web Store screenshots (1280x800) as HTML,
 * rendered by headless Chrome. Branded sunset-glass background, a short headline
 * + chips at the top, and the real product screenshot LARGE and flat in a clean
 * browser frame below (near-native scale so the UI stays legible). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const shots = path.resolve(dir, '..');

const PLANE = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none"><path d="M21.4 3 3.2 9.1 10.6 12.4Z" fill="#fff" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/><path d="M21.4 3 10.6 12.4 14 20.2Z" fill="#fff" fill-opacity=".68" stroke="#fff" stroke-opacity=".68" stroke-width="1.1" stroke-linejoin="round"/></svg>';

const CSS = `
*{box-sizing:border-box;margin:0;font-family:-apple-system,"SF Pro Display","SF Pro Text",Inter,system-ui,sans-serif}
:root{--a1:#ff6f91;--a2:#ffa863;--a3:#c774ff;--go:#37e0ac;--text:#f7f0f6;--muted:#cabfd2}
.stage{width:1280px;height:800px;position:relative;overflow:hidden;background:#160e1e;color:var(--text)}
.stage::before{content:"";position:absolute;inset:-16%;background:
  radial-gradient(30% 40% at 12% 6%,rgba(255,111,145,.40),transparent 60%),
  radial-gradient(30% 38% at 90% 4%,rgba(255,168,99,.32),transparent 60%),
  radial-gradient(40% 44% at 84% 96%,rgba(199,116,255,.30),transparent 62%),
  radial-gradient(26% 32% at 6% 96%,rgba(55,224,172,.15),transparent 60%);filter:blur(22px)}
.stage::after{content:"";position:absolute;inset:0;background:radial-gradient(120% 80% at 50% 130%,transparent 46%,rgba(11,6,15,.7))}
.top{position:relative;z-index:3;padding:44px 64px 0;display:flex;align-items:flex-end;justify-content:space-between}
.left{max-width:760px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.mk{width:34px;height:34px;border-radius:11px;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;
  background:linear-gradient(145deg,#ff6f91,#ff8b7a 46%,#ffb066);box-shadow:0 7px 18px rgba(255,111,145,.5),inset 0 1.5px 0 rgba(255,255,255,.55)}
.mk::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,.55),transparent 55%)}
.mk svg{position:relative;z-index:1;filter:drop-shadow(0 1.5px 1.5px rgba(130,25,70,.4))}
.bn{font-weight:750;font-size:18px;letter-spacing:-.02em}
.h{font-size:40px;font-weight:770;letter-spacing:-.03em;line-height:1.05}
.h em{font-style:normal;background:linear-gradient(120deg,var(--a1),var(--a2));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.sub{font-size:16.5px;color:var(--muted);margin-top:10px;max-width:66ch;line-height:1.4}
.chips{display:flex;flex-direction:column;gap:9px;align-items:flex-end;padding-bottom:4px}
.chip{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--muted);
  padding:8px 14px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.13);white-space:nowrap;
  -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.dot{width:8px;height:8px;border-radius:50%}
/* big flat screenshot in a clean browser frame, below the headline */
.frame{position:absolute;left:50%;bottom:-14px;transform:translateX(-50%);width:1120px;border-radius:16px 16px 0 0;overflow:hidden;
  border:1px solid rgba(255,255,255,.16);border-bottom:none;background:#0f0a16;z-index:2;
  box-shadow:0 -2px 0 rgba(255,255,255,.05) inset,0 40px 100px rgba(0,0,0,.6),0 0 90px rgba(255,111,145,.14)}
.bar{height:34px;display:flex;align-items:center;gap:7px;padding:0 15px;background:rgba(255,255,255,.06);border-bottom:1px solid rgba(255,255,255,.08)}
.bar i{width:12px;height:12px;border-radius:50%}
.bar .u{flex:1;margin:0 14px;height:16px;border-radius:8px;background:rgba(255,255,255,.05)}
.view{position:relative;width:100%;height:470px;overflow:hidden}
.view img{position:absolute;left:0;width:100%;display:block}
`;

const chip = (color, label) => `<span class="chip"><span class="dot" style="background:${color}"></span>${label}</span>`;
const dots = `<i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span class="u"></span>`;

// top:negative px shifts the screenshot up inside the viewport to reveal its key region.
const slides = [
  {
    file: 'v2-1-overview.html', img: 'screenshot-1-dashboard-1280x800.png', top: -55,
    h: 'Multi-step LinkedIn outreach, <em>on autopilot</em>.',
    sub: 'Build a cadence once. Visit, connect, message and follow up run themselves, at a safe human pace.',
    chips: [chip('#ff6f91', 'Visit → Connect → Message'), chip('#37e0ac', 'Safe by default'), chip('#ffa863', 'No cloud, ever')],
  },
  {
    file: 'v2-2-cadence.html', img: 'screenshot-2-cadence-1280x800.png', top: -30,
    h: 'Design <em>any sequence</em> in minutes.',
    sub: 'Reorderable steps, delays from seconds to days, messages personalized with merge tags.',
    chips: [chip('#ff6f91', 'Drag & reorder'), chip('#ffa863', '{first} {company}'), chip('#c774ff', 'Waits for the accept')],
  },
  {
    file: 'v2-3-safety.html', img: 'screenshot-3-safety-1280x800.png', top: 0,
    h: 'Safety is <em>the whole point</em>.',
    sub: 'Conservative caps, a warm-up ramp, business hours, and an instant stop on any LinkedIn warning.',
    chips: [chip('#37e0ac', '15 invites / day'), chip('#37e0ac', 'Warm-up ramp'), chip('#ffa863', 'Auto-halt')],
  },
  {
    file: 'v2-4-leads.html', img: 'screenshot-4-leads-1280x800.png', top: -40,
    h: 'Track <em>every prospect</em>, live.',
    sub: 'See who is on which step, whose invite is pending or accepted, and who has replied. CSV in and out.',
    chips: [chip('#ff6f91', 'Per-step status'), chip('#c774ff', 'Reply-stop'), chip('#ffa863', 'CSV in / out')],
  },
  {
    file: 'v2-5-panel.html', img: 'screenshot-5-panel-1280x800.png', top: -70,
    h: 'Runs <em>right inside</em> LinkedIn.',
    sub: 'Add prospects from any search and launch a cadence from the glass panel, without leaving the page.',
    chips: [chip('#ff6f91', 'On-page panel'), chip('#37e0ac', 'Your browser only'), chip('#ffa863', 'One-click start')],
  },
];

for (const s of slides) {
  const imgPath = path.join(shots, s.img);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="stage">
  <div class="top">
    <div class="left">
      <div class="brand"><span class="mk">${PLANE}</span><span class="bn">OutreachOS</span></div>
      <div class="h">${s.h}</div>
      <div class="sub">${s.sub}</div>
    </div>
    <div class="chips">${s.chips.join('')}</div>
  </div>
  <div class="frame">
    <div class="bar">${dots}</div>
    <div class="view"><img src="file://${imgPath}" style="top:${s.top}px"></div>
  </div>
</div></body></html>`;
  fs.writeFileSync(path.join(dir, s.file), html);
  console.log('wrote', s.file);
}
