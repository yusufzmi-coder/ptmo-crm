#!/usr/bin/env node
/**
 * Measure rendered colour contrast, in a real browser, in both modes.
 *
 *   node tools/measure-contrast.mjs --page http://localhost:3000/login
 *   node tools/measure-contrast.mjs --pairs pairs.json --css http://localhost:3000
 *
 * WHY THIS EXISTS — searching for a token name does not find the defect.
 *
 * Five separate contrast rounds ran over this repo. Each one searched for
 * the name of a token: `primary-soft`, `muted-foreground`, `amber-950`.
 * Each one missed `bg-primary/10 text-primary`, which spells exactly the
 * same idea with an opacity instead of a name — 4.19 in light, 3.60 in
 * dark, on the selected state of every tag picker and audience selector
 * in the product. It survived all five because it does not contain the
 * word anyone was grepping for.
 *
 * The `/20` variant survived a sixth round for the same reason, and it
 * was worse: 3.66 and 3.24.
 *
 * So the right detector for this class of bug is not a name search. It
 * is: for every background-and-text pair the browser actually renders,
 * compute the ratio. That is what --page does.
 *
 * ---------------------------------------------------------------------
 * METHOD — why a browser and a canvas, and not arithmetic
 *
 * The theme tokens in src/app/globals.css are authored in oklab and
 * oklch. `getComputedStyle(el).color` hands those back in the colour
 * space they were written in — `oklab(0.649 -0.001 -0.009 / 0.7)` — so
 * there is nothing to parse into an sRGB triple and no alpha to unpack.
 *
 * The way through is to let the browser do the conversion. Paint the
 * colour onto a 4×4 canvas over its backdrop, read one pixel back, and
 * you have the composited sRGB value — the actual pixels a person sees,
 * with opacity, colour space and blending already resolved.
 *
 * The backdrop matters as much as the colour. A tint at 10% opacity is a
 * different colour on a white card than on a dark one, so every
 * measurement walks up the ancestors to the first opaque background and
 * composites onto that. Measuring text against `--card` when it actually
 * sits on `--background` produces a number that is precisely correct and
 * describes nothing.
 *
 * ---------------------------------------------------------------------
 * THE TRAP THAT MAKES A BROKEN RUN LOOK PERFECT
 *
 * Tailwind only generates a utility class if it finds that class in the
 * source it scans. A scratch page built by this tool is not source.
 *
 * So `--pairs` with a class nothing in src/ uses produces an element
 * with no colour rule at all, which inherits the page's text colour,
 * which is near-black on near-white. The tool then reports 17.76:1 — a
 * spectacular pass, for a class that does not exist.
 *
 * This has already happened twice in this repo. `text-red-200` reported
 * 17.76 during the fixed-colour audit because the class only ever
 * appears as `hover:text-red-200`, so the base was never generated.
 * `text-success`, `text-warning` and `text-info` reported 17.76 and
 * 17.99 the day they were added, because at that moment nothing in src/
 * used them yet.
 *
 * Both were caught only because the generated-class count was printed
 * beside the result. Neither was caught by remembering this paragraph.
 *
 * So the count prints on every run, and a zero prints its own warning.
 * Header docs are read by people who are already suspicious.
 *
 * ---------------------------------------------------------------------
 * THRESHOLDS — measure the font, do not assume the exemption
 *
 * Text needs 4.5:1. Non-text — icons, dots, bars, borders that carry
 * meaning — needs 3.0:1.
 *
 * The large-text exemption (3.0 for text) applies at 24px, or at 18.66px
 * when the weight is 700 or more. It is narrower than it feels: a 14px
 * label at weight 500 is small text, and a 4.45 measured there fails by
 * 0.05 rather than passing under a looser bar. This tool reads the
 * computed fontSize and fontWeight and picks the threshold from them, so
 * the exemption is never assumed.
 *
 * ---------------------------------------------------------------------
 * WHAT THE TOOL CANNOT DECIDE FOR YOU — solid fills
 *
 * A solid fill is measured one of two ways and no machine can tell which
 * from the CSS:
 *
 *   A fill that REPORTS something — a presence dot, a connection
 *   indicator, a status pip — carries meaning by itself and is measured
 *   against the surface behind it at 3.0.
 *
 *   A fill that IS A SURFACE — a button, a badge, a banner — carries no
 *   meaning alone. Measure the text sitting on it, at 4.5, and ignore
 *   the fill's own contrast with the page.
 *
 * Getting this backwards is expensive in both directions. `bg-red-600`
 * with white text measures 4.77 in both modes and needs no change;
 * "fixing" it to `bg-destructive` breaks dark mode, because
 * `--destructive` is a text colour and fails at 2.89 as a fill. Whereas
 * `bg-emerald-500` as an online dot measured 2.47 against a light card,
 * and that dot is the only thing telling an agent a colleague is
 * present.
 *
 * This is written here as an instruction to a person, not implemented as
 * a heuristic, because the distinction is about what the pixel MEANS.
 *
 * The same judgement applies to borders, and --border is where it bites.
 * That token is deliberately faint: it draws dividers, card outlines and
 * section rules, and at 3:1 the product would look boxed in. A border
 * only owes 3:1 when it is CARRYING something — marking a field invalid,
 * a card selected, a row active. This tool reports every resting border
 * under 3:1 because it cannot tell those apart; most of what it lists
 * for --border is a divider and should be left exactly as it is.
 *
 * ---------------------------------------------------------------------
 * LIMITS — what an empty result does and does not say
 *
 * This sweeps the page AT REST. It does not enter :hover,
 * :focus-visible, [aria-invalid], [data-*] or :disabled states, and it
 * cannot: those styles only exist while the browser is in them.
 *
 * That is not a small gap. Of the 41 dark: utilities audited in this
 * repo, 22 sat behind exactly those variants.
 *
 * So a clean run means "no failures in the resting state of the elements
 * that rendered on this page". It does not mean the page passes. Hover
 * and focus states need a person, or a driver that forces them.
 *
 * Two more:
 *   - Only what is in the DOM at measure time. Anything behind a tab, a
 *     dialog or a collapsed section is not on the page and not measured.
 *   - A page behind auth needs a session. Point --page at a URL you can
 *     already reach, or the tool measures the login screen and reports
 *     that it is fine.
 *
 * ---------------------------------------------------------------------
 * SETUP
 *
 * Needs a running dev server and Chrome. Start Chrome with a debugging
 * port first, in the same shell, so it lives exactly as long as the run:
 *
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless --disable-gpu --no-sandbox --remote-debugging-port=9222 \
 *     --user-data-dir=/tmp/cdp about:blank &
 *
 * tools/ is excluded from tsconfig, eslint and vitest, so this file is
 * not typechecked, linted or run by the suite. Verified at 92391ea;
 * re-check before assuming it still holds.
 */

const PORT = Number(process.env.CDP_PORT ?? 9222);
const MODES = ['light', 'dark'];
const THEME = process.env.THEME ?? 'ptmo';

// ---------------------------------------------------------------------
// Minimal CDP client. No dependency; Node 22 has a global WebSocket.
// ---------------------------------------------------------------------
async function connect() {
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch {
    die(
      `No Chrome on port ${PORT}. Start one with --remote-debugging-port=${PORT} ` +
        `(see SETUP in the header of this file).`,
    );
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) die(`Chrome on ${PORT} has no page target.`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, (m) =>
        m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result),
      );
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text);
    }
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('CSS.enable');
  return { send, evaluate, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------
// Everything below runs INSIDE the page. Kept as one string so the
// measuring code and the code being measured share a document.
// ---------------------------------------------------------------------
const IN_PAGE = `
(() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 4;
  const cx = cv.getContext('2d', { willReadFrequently: true });

  // Paint colour over backdrop, read the pixel back. This is the step
  // that resolves oklab/oklch and alpha into something comparable.
  const composite = (colour, backdrop) => {
    cx.clearRect(0, 0, 4, 4);
    if (backdrop) { cx.fillStyle = backdrop; cx.fillRect(0, 0, 4, 4); }
    cx.fillStyle = colour;
    cx.fillRect(0, 0, 4, 4);
    const d = cx.getImageData(1, 1, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const rgb = (a) => 'rgb(' + a.join(',') + ')';

  const luminance = (c) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => {
    const x = luminance(a), y = luminance(b);
    return +(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2));
  };

  // Walk up to the first ancestor that actually paints, and composite
  // onto it. An element's own translucent background is meaningless
  // without knowing what shows through.
  const surfaceUnder = (el) => {
    let n = el.parentElement;
    while (n) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        return composite(bg, 'rgb(255,255,255)');
      }
      n = n.parentElement;
    }
    return composite(getComputedStyle(document.body).backgroundColor || '#fff', 'rgb(255,255,255)');
  };

  // WCAG large text: >=24px, or >=18.66px at weight >=700. Anything else
  // is small text and needs 4.5. Read, never assumed.
  const thresholdFor = (cs) => {
    const px = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = px >= 24 || (px >= 18.66 && weight >= 700);
    return large ? 3.0 : 4.5;
  };

  return { composite, rgb, ratio, surfaceUnder, thresholdFor };
})()
`;

// ---------------------------------------------------------------------
// --page : every text-bearing element the page actually rendered.
// ---------------------------------------------------------------------
const SCAN = `
(() => {
  const H = ${IN_PAGE};
  const out = [];
  const seen = new Set();
  let scanned = 0;

  for (const el of document.querySelectorAll('*')) {
    // Only elements with their own visible text; a wrapper inherits the
    // same colours and would report the same pair many times over.
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ')
      .trim();
    if (!own) continue;

    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;

    const under = H.surfaceUnder(el);
    const bg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
      ? H.composite(cs.backgroundColor, H.rgb(under))
      : under;
    const fg = H.composite(cs.color, H.rgb(bg));

    scanned++;

    // Borders at rest. A border that marks a selected, active or invalid
    // state is non-text information and needs 3.0 against the surface it
    // sits on. A divider is not — see the note on --border below.
    // A fully transparent border is layout, not information — buttons
    // carry border-transparent so a focus ring has somewhere to land.
    //
    // Tested by compositing rather than by matching a string: the first
    // version of this checked for rgba(...,0) and missed Tailwind v4's
    // oklab(... / 0) entirely, so every button reported a 1.0 border.
    // If the colour painted over the surface IS the surface, nobody can
    // see it, whatever colour space it was written in.
    const bPainted = H.composite(cs.borderTopColor, H.rgb(under));
    const bInvisible =
      bPainted[0] === under[0] && bPainted[1] === under[1] && bPainted[2] === under[2];
    if ((parseFloat(cs.borderTopWidth) || 0) > 0 && !bInvisible) {
      const bd = H.ratio(H.composite(cs.borderTopColor, H.rgb(under)), under);
      if (bd < 3.0) {
        const bkey = 'B|' + cs.borderTopColor + '|' + cs.borderTopWidth;
        if (!seen.has(bkey)) {
          seen.add(bkey);
          out.push({
            text: '(border)',
            cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').toString().slice(0, 58),
            px: cs.borderTopWidth,
            weight: '-',
            need: 3.0,
            got: bd,
          });
        }
      }
    }

    const need = H.thresholdFor(cs);
    const got = H.ratio(fg, bg);
    if (got >= need) continue;

    const key = cs.color + '|' + cs.backgroundColor + '|' + cs.fontSize + '|' + cs.fontWeight;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      text: own.slice(0, 46),
      cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').toString().slice(0, 58),
      px: cs.fontSize,
      weight: cs.fontWeight,
      need,
      got,
    });
  }
  return { scanned, rows: out.sort((a, b) => a.got - b.got) };
})()
`;


// ---------------------------------------------------------------------
// Forced states. The rest sweep cannot see :hover, :focus-visible or
// [aria-invalid], and that is where the form-error borders live — the
// only visual mark that a field needs fixing, visible precisely when
// the user is already confused.
//
// Pseudo-classes are forced through CDP's CSS.forcePseudoState, which
// really does re-resolve the cascade: verified against a fixture whose
// :hover and :focus-visible rules change `color`, and the forced value
// came back changed and the cleared value came back to rest.
//
// aria-invalid is an attribute, so it is set and removed in the page.
// ---------------------------------------------------------------------
const TAG_STATEFUL = `
(() => {
  let i = 0;
  const found = [];
  for (const el of document.querySelectorAll('*')) {
    const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').toString();
    if (!cls) continue;
    const states = [];
    if (/(^|\\s)hover:/.test(cls)) states.push('hover');
    if (/(^|\\s)focus-visible:/.test(cls)) states.push('focus-visible');
    else if (/(^|\\s)focus:/.test(cls)) states.push('focus');
    const invalid = /aria-invalid:/.test(cls);
    if (!states.length && !invalid) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    el.setAttribute('data-mc-i', String(i));
    found.push({ i, states, invalid, tag: el.tagName.toLowerCase(), cls: cls.slice(0, 62) });
    i++;
  }
  return found;
})()
`;

const MEASURE_ONE = (i) => `
(() => {
  const H = ${IN_PAGE};
  const el = document.querySelector('[data-mc-i="${i}"]');
  if (!el) return null;
  const cs = getComputedStyle(el);
  const under = H.surfaceUnder(el);
  const bg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
    ? H.composite(cs.backgroundColor, H.rgb(under)) : under;
  const out = {};
  const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
  if (own) {
    out.text = { got: H.ratio(H.composite(cs.color, H.rgb(bg)), bg), need: H.thresholdFor(cs), sample: own.slice(0, 32) };
  }
  if ((parseFloat(cs.borderTopWidth) || 0) > 0) {
    out.border = { got: H.ratio(H.composite(cs.borderTopColor, H.rgb(under)), under), need: 3.0 };
  }
  return out;
})()
`;

// ---------------------------------------------------------------------
// --pairs : explicit class pairs, on a scratch page built from the
// app's own compiled stylesheet.
// ---------------------------------------------------------------------
async function pairsPage(cssOrigin) {
  const loginHtml = await (await fetch(`${cssOrigin}/login`)).text();
  const href = loginHtml.match(/\/_next\/static\/chunks\/[^"']+\.css/)?.[0];
  if (!href) die(`Could not find a stylesheet link at ${cssOrigin}/login — is the dev server up?`);
  const css = await (await fetch(cssOrigin + href)).text();
  return css;
}

const PAIRS_EVAL = (pairs) => `
(() => {
  const H = ${IN_PAGE};
  const PAIRS = ${JSON.stringify(pairs)};
  const host = document.getElementById('__mc_host');
  host.innerHTML = PAIRS.map((p, i) =>
    '<span id="__mc_' + i + '" class="' + p.bg + ' ' + p.fg + '" ' +
    'style="display:inline-block;padding:6px;font-size:' + (p.px || '14px') + '">Ab</span>'
  ).join('');

  return PAIRS.map((p, i) => {
    const el = document.getElementById('__mc_' + i);
    const cs = getComputedStyle(el);

    // THE TRAP. If Tailwind never generated these utilities the element
    // has no rule of its own, inherits the page text colour, and scores
    // a fake near-perfect pass. Report it rather than the ratio.
    const declaredFg = cs.color;
    const declaredBg = cs.backgroundColor;
    const generated = !(declaredBg === 'rgba(0, 0, 0, 0)' && p.bg);

    const under = H.surfaceUnder(el);
    const bg = declaredBg !== 'rgba(0, 0, 0, 0)' ? H.composite(declaredBg, H.rgb(under)) : under;
    const fg = H.composite(declaredFg, H.rgb(bg));

    return {
      label: p.label || (p.bg + ' + ' + p.fg),
      generated,
      need: H.thresholdFor(cs),
      got: H.ratio(fg, bg),
    };
  });
})()
`;

// ---------------------------------------------------------------------
function args() {
  const a = process.argv.slice(2);
  const get = (flag) => {
    const i = a.indexOf(flag);
    return i === -1 ? null : a[i + 1];
  };
  return { page: get('--page'), pairs: get('--pairs'), css: get('--css') ?? 'http://localhost:3000' };
}

function table(rows, mode) {
  console.log(`\n  ── ${mode} ──`);
  if (!rows.length) {
    console.log('    no failures at rest');
    return 0;
  }
  for (const r of rows) {
    const where = r.text !== undefined ? `"${r.text}"` : r.label;
    const extra = r.px ? `  ${r.px}/${r.weight}` : '';
    console.log(`    ${String(r.got).padStart(6)} / ${r.need}   ${where}${extra}`);
    if (r.cls) console.log(`             ${r.cls}`);
  }
  return rows.length;
}

// A forced state only counts if it CHANGED something. If hover leaves the
// ratio where rest left it, the rest sweep already reported it.
function collect(into, el, state, rest, got) {
  if (!rest || !got) return;
  for (const kind of ['text', 'border']) {
    const a = rest[kind];
    const b = got[kind];
    if (!b) continue;
    if (a && a.got === b.got) continue;
    if (b.got >= b.need) continue;
    into.push({
      state,
      what: kind,
      got: b.got,
      need: b.need,
      sample: b.sample,
      tag: el.tag,
      cls: el.cls,
    });
  }
}

const statesSwept = new Set();
let unreachable = 0;
let stateChecked = 0;

const { page, pairs, css } = args();
if (!page && !pairs) {
  die('Usage: --page <url>   or   --pairs <file.json> [--css <origin>]');
}

const cdp = await connect();
let failures = 0;
let generatedMisses = 0;
let measured = 0;

if (page) {
  await cdp.send('Page.navigate', { url: page });
  await sleep(4000);
  const where = await cdp.evaluate('location.pathname');
  console.log(`\n  page: ${page}   (landed on ${where})`);
  if (/\/login$/.test(where) && !/\/login$/.test(page)) {
    console.log('  NOTE: redirected to the login screen — this run measured that, not your page.');
  }
  for (const mode of MODES) {
    await cdp.evaluate(
      `document.documentElement.dataset.mode='${mode}';document.documentElement.dataset.theme='${THEME}';document.body.offsetHeight`,
    );
    await sleep(400);
    const { scanned, rows } = await cdp.evaluate(SCAN);
    measured += scanned;
    failures += table(rows, mode);

    // ----- forced states -----
    const stateful = await cdp.evaluate(TAG_STATEFUL);
    // Fresh each pass: the attributes were added after any earlier
    // snapshot, and a stale root silently returns no nodeIds — which
    // reads as "this page has no hover states" rather than as an error.
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const stateRows = [];
    for (const el of stateful) {
      const rest = await cdp.evaluate(MEASURE_ONE(el.i));
      const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
        nodeId: doc.root.nodeId,
        selector: `[data-mc-i="${el.i}"]`,
      });
      const nodeId = nodeIds?.[0];

      if (el.states.length && !nodeId) {
        unreachable += el.states.length;
      }
      for (const st of el.states) {
        if (!nodeId) continue;
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [st] });
        const got = await cdp.evaluate(MEASURE_ONE(el.i));
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
        collect(stateRows, el, st, rest, got);
        statesSwept.add(st);
      }

      if (el.invalid) {
        await cdp.evaluate(
          `document.querySelector('[data-mc-i="${el.i}"]').setAttribute('aria-invalid','true'); true`,
        );
        const got = await cdp.evaluate(MEASURE_ONE(el.i));
        await cdp.evaluate(
          `document.querySelector('[data-mc-i="${el.i}"]').removeAttribute('aria-invalid'); true`,
        );
        collect(stateRows, el, 'aria-invalid', rest, got);
        statesSwept.add('aria-invalid');
      }
    }
    await cdp.evaluate(`document.querySelectorAll('[data-mc-i]').forEach((n) => n.removeAttribute('data-mc-i')); true`);
    stateChecked += stateful.length;

    if (stateRows.length) {
      console.log(`  forced states — ${mode}`);
      for (const r of stateRows) {
        console.log(`    ${String(r.got).padStart(6)} / ${r.need}   [:${r.state}] ${r.what}${r.sample ? ` "${r.sample}"` : ''}`);
        console.log(`             <${r.tag}> ${r.cls}`);
      }
      failures += stateRows.length;
    }
  }
} else {
  const spec = JSON.parse(await (await import('node:fs/promises')).readFile(pairs, 'utf8'));
  const sheet = await pairsPage(css);
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await cdp.evaluate(
    `document.write('<!doctype html><html><head><style>' + ${JSON.stringify(sheet)} +
     '</style></head><body class="bg-background"><div class="bg-card" id="__mc_host" style="padding:12px"></div></body></html>');
     document.close(); true`,
  );
  await sleep(400);
  console.log(`\n  pairs: ${spec.length} from ${pairs}`);
  for (const mode of MODES) {
    await cdp.evaluate(
      `document.documentElement.dataset.mode='${mode}';document.documentElement.dataset.theme='${THEME}';document.body.offsetHeight`,
    );
    await sleep(300);
    const rows = await cdp.evaluate(PAIRS_EVAL(spec));
    measured += rows.length;
    generatedMisses += rows.filter((r) => !r.generated).length;
    console.log(`\n  ── ${mode} ──`);
    for (const r of rows) {
      const flag = !r.generated ? '  ⚠ CLASS NOT GENERATED' : r.got < r.need ? '  FAIL' : '';
      console.log(`    ${String(r.got).padStart(6)} / ${r.need}   ${r.label}${flag}`);
      if (r.got < r.need && r.generated) failures++;
    }
  }
}

// The count prints on every run, not on request. See THE TRAP above.
console.log(
  page
    ? `\n  text-bearing elements measured: ${measured}`
    : `\n  generated classes resolved: ${measured - generatedMisses}/${measured}`,
);
if (generatedMisses > 0) {
  console.log(
    `  ⚠ ${generatedMisses} pair(s) had no generated utility. Those ratios are the page's\n` +
      `    inherited text colour, not your classes — they will read as a near-perfect\n` +
      `    pass. Tailwind only emits a class it finds in src/. Add a real usage, or\n` +
      `    safelist it, before believing any number on those rows.`,
  );
}
if (measured === 0) {
  console.log(
    '  ⚠ nothing was measured. An empty sweep and a clean sweep print the same\n' +
      '    thing — check the page actually rendered before reading this as a pass.',
  );
}
// Say what was covered on EVERY run. A clean result is the dangerous one,
// and "no failures" means something much narrower than it sounds.
const swept = [...statesSwept].sort();
console.log(`\n  ${failures} failure(s).`);
if (page) {
  console.log(
    `  coverage: resting state` +
      (swept.length ? `, plus forced :${swept.join(', :')} on ${stateChecked} element(s)` : '') +
      `.`,
  );
  if (!swept.length) {
    console.log('  no stateful utilities found on this page — resting state ONLY.');
  }
  if (unreachable > 0) {
    console.log(
      `  ⚠ ${unreachable} pseudo-state(s) could not be forced — the element was not\n` +
        '    reachable through the DOM agent. Those states were NOT measured, and\n' +
        '    their absence above is a tool failure, not a pass.',
    );
  }
  console.log(
    '  NOT covered: :active, :disabled, [data-*] variants, anything not in the\n' +
      '  DOM at measure time, and any page this session cannot reach.',
  );
} else {
  console.log('  coverage: declared class pairs only — no page, no states.');
}
console.log('');

cdp.close();
process.exit(0);
