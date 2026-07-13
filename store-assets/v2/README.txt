OutreachOS — ADVANCED Chrome Web Store screenshots (v2)
=======================================================
Premium, caption-and-frame versions of the store screenshots: the real product
UI in a tilted browser frame on the branded sunset background, with a headline,
a supporting line, and feature chips. Upload these in place of (or alongside) the
plain screenshots in the parent folder. All exactly 1280x800 (store requirement).

  store-1-overview-1280x800.png   "Multi-step LinkedIn outreach, on autopilot"
  store-2-cadence-1280x800.png    "Design any sequence in minutes"
  store-3-safety-1280x800.png     "Safety is the whole point"
  store-4-leads-1280x800.png      "Track every prospect, live"
  store-5-panel-1280x800.png      "Runs right inside LinkedIn"

Regenerate (after UI/screenshot changes):
  node gen.mjs        # writes v2-*.html referencing ../screenshot-*.png
  then render each v2-*.html at 1280x800 with headless Chrome (see gen.mjs header).
