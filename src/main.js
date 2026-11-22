import * as acorn from "https://cdn.jsdelivr.net/npm/acorn@8.14.0/dist/acorn.mjs";
import { analyze } from "./analyze.js";
import { CATEGORIES, CONCEPTS } from "./glossary.js";
import { EXAMPLES } from "./examples.js";

const $ = (id) => document.getElementById(id);
const input = $("input");
const codeEl = $("code");
const highlight = codeEl.parentElement;
const tooltip = $("tooltip");
const inspectorBody = $("inspector-body");
const statusEl = $("status");
const examplesEl = $("examples");
const colorsEl = $("colors");
const legendEl = $("legend");

const STORAGE_KEY = "hover-helper:v1";
let tokens = [];
let hoveredIndex = -1;
let activeIndex = -1;

// ---------------------------------------------------------------------------
// Persistence (best effort: storage may be unavailable)
// ---------------------------------------------------------------------------
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {}; } catch { return {}; }
}
function savePrefs(patch) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadPrefs(), ...patch })); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const escapeHtml = (s) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

/** Escape text, then turn `code` spans (from analyze.js) into <code>. */
const richText = (s) => escapeHtml(s).replace(/`([^`]+)`/g, "<code>$1</code>");

function update() {
  const code = input.value;
  const result = analyze(code, acorn);
  tokens = result.tokens;
  hoveredIndex = -1;

  let html = "";
  let pos = 0;
  tokens.forEach((t, i) => {
    if (t.start < pos) return; // overlapping tokens shouldn't happen, but be safe
    html += escapeHtml(code.slice(pos, t.start));
    html += `<span class="tok tok-${t.category}" data-i="${i}">${escapeHtml(t.text)}</span>`;
    pos = t.end;
  });
  html += escapeHtml(code.slice(pos)) + "\n\n";
  codeEl.innerHTML = html;
  syncScroll();

  if (result.error) {
    statusEl.textContent = `Syntax error on line ${result.error.line}, column ${result.error.column}: ${result.error.message}. Explanations after this point may be limited.`;
    statusEl.classList.add("error");
  } else {
    const n = tokens.length;
    statusEl.textContent = code.trim() ? `Found ${n} piece${n === 1 ? "" : "s"} of code to explain. Hover over (or tap) any of them.` : "Type or paste some JavaScript to get started.";
    statusEl.classList.remove("error");
  }

  updateFromCaret();
  applyLegendFocus();
}

function cardHtml(t, { withLink }) {
  const concept = CONCEPTS[t.concept];
  const cat = CATEGORIES[t.category];
  const link = t.mdn ?? concept?.mdn;
  const text = t.text.length > 40 ? t.text.slice(0, 39) + "…" : t.text;
  return `
    <div class="card">
      <div class="card-head">
        <span class="badge" style="--dot: var(--c-${t.category})">${escapeHtml(cat?.label ?? t.category)}</span>
        <code class="token-text">${escapeHtml(text.replace(/\s+/g, " "))}</code>
      </div>
      <p class="card-label">${escapeHtml(t.label)}</p>
      <p class="card-here">${richText(t.here)}</p>
      ${concept ? `<p class="card-concept"><strong>${escapeHtml(concept.title)}:</strong> ${richText(concept.body)}</p>` : ""}
      ${withLink && link ? `<a class="card-link" href="${escapeHtml(link)}" target="_blank" rel="noopener">Learn more on MDN →</a>` : ""}
    </div>`;
}

function spanFor(i) {
  return i < 0 ? null : codeEl.querySelector(`.tok[data-i="${i}"]`);
}

// ---------------------------------------------------------------------------
// Hover → floating tooltip
// ---------------------------------------------------------------------------
let pendingMove = null;
input.addEventListener("mousemove", (e) => {
  if (pendingMove) { pendingMove = e; return; }
  pendingMove = e;
  requestAnimationFrame(() => {
    const ev = pendingMove;
    pendingMove = null;
    handleHover(ev.clientX, ev.clientY);
  });
});
input.addEventListener("mouseleave", () => setHovered(-1));

function handleHover(x, y) {
  // The textarea sits on top of the highlighted code, so look *through* it.
  const span = document.elementsFromPoint(x, y).find((el) => el.classList?.contains("tok"));
  const i = span ? Number(span.dataset.i) : -1;
  if (i !== hoveredIndex) setHovered(i);
  if (i >= 0) positionTooltip(span, x, y);
}

function setHovered(i) {
  spanFor(hoveredIndex)?.classList.remove("is-hovered");
  hoveredIndex = i;
  const span = spanFor(i);
  if (!span) { tooltip.hidden = true; return; }
  span.classList.add("is-hovered");
  tooltip.innerHTML = cardHtml(tokens[i], { withLink: false });
  tooltip.hidden = false;
}

function positionTooltip(span, mouseX, mouseY) {
  // Multi-line tokens (comments, template text) have several boxes: use the one under the mouse.
  const rects = [...span.getClientRects()];
  const rect = rects.find((r) => mouseY >= r.top && mouseY <= r.bottom) ?? rects[0];
  const gap = 8;
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  let left = Math.min(Math.max(8, rect.left), window.innerWidth - tw - 8);
  let top = rect.bottom + gap;
  if (top + th > window.innerHeight - 8) top = Math.max(8, rect.top - th - gap);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

// ---------------------------------------------------------------------------
// Caret / click → pinned explanation in the side panel
// ---------------------------------------------------------------------------
function tokenAtCaret() {
  const pos = input.selectionStart;
  let after = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.start <= pos && pos < t.end) return i;
    if (t.end === pos) after = i; // caret sits right after a token
    if (t.start > pos) break;
  }
  return after;
}

function updateFromCaret() {
  const i = tokenAtCaret();
  spanFor(activeIndex)?.classList.remove("is-active");
  activeIndex = i;
  if (i < 0) {
    inspectorBody.innerHTML = `<p class="placeholder">Hover over any part of the code for a quick explanation, or click on it (or move the cursor there with the arrow keys) to pin the explanation here.</p>`;
    return;
  }
  spanFor(i)?.classList.add("is-active");
  inspectorBody.innerHTML = cardHtml(tokens[i], { withLink: true });
}

["click", "keyup", "focus", "select"].forEach((ev) => input.addEventListener(ev, updateFromCaret));
document.addEventListener("selectionchange", () => { if (document.activeElement === input) updateFromCaret(); });

// ---------------------------------------------------------------------------
// Editing niceties
// ---------------------------------------------------------------------------
let debounce = 0;
input.addEventListener("input", () => {
  cancelAnimationFrame(debounce);
  debounce = requestAnimationFrame(() => {
    update();
    savePrefs({ code: input.value });
    examplesEl.value = "";
  });
});

function syncScroll() {
  highlight.scrollTop = input.scrollTop;
  highlight.scrollLeft = input.scrollLeft;
}
input.addEventListener("scroll", () => { syncScroll(); setHovered(-1); });

// Tab inserts two spaces. Press Escape first to let Tab move focus instead.
let tabEscapes = false;
input.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { tabEscapes = true; return; }
  if (e.key === "Tab" && !tabEscapes && !e.shiftKey) {
    e.preventDefault();
    input.setRangeText("  ", input.selectionStart, input.selectionEnd, "end");
    input.dispatchEvent(new Event("input"));
  }
  if (e.key !== "Tab") tabEscapes = false;
});

// ---------------------------------------------------------------------------
// Toolbar: examples + color toggle
// ---------------------------------------------------------------------------
examplesEl.innerHTML =
  `<option value="">Choose…</option>` +
  EXAMPLES.map((ex, i) => `<option value="${i}">${escapeHtml(ex.name)}</option>`).join("");
examplesEl.addEventListener("change", () => {
  const ex = EXAMPLES[Number(examplesEl.value)];
  if (!ex) return;
  input.value = ex.code;
  input.scrollTop = 0;
  input.setSelectionRange(0, 0);
  update();
  savePrefs({ code: ex.code });
});

colorsEl.addEventListener("change", () => {
  document.body.classList.toggle("plain", !colorsEl.checked);
  savePrefs({ colors: colorsEl.checked });
});

// ---------------------------------------------------------------------------
// Legend: hovering a category highlights matching tokens
// ---------------------------------------------------------------------------
let legendFocus = null;
const legendCategories = Object.keys(CATEGORIES).filter((k) => k !== "unknown");
legendEl.innerHTML = legendCategories
  .map((k) => `<li tabindex="0" data-cat="${k}" title="${escapeHtml(CATEGORIES[k].hint)}"><span class="swatch" style="background: var(--c-${k})"></span>${escapeHtml(CATEGORIES[k].label)}</li>`)
  .join("");

function applyLegendFocus() {
  codeEl.classList.toggle("focusing", !!legendFocus);
  for (const span of codeEl.querySelectorAll(".tok")) {
    span.classList.toggle("is-focus", !!legendFocus && span.classList.contains(`tok-${legendFocus}`));
  }
}
for (const li of legendEl.children) {
  const on = () => { legendFocus = li.dataset.cat; applyLegendFocus(); };
  const off = () => { legendFocus = null; applyLegendFocus(); };
  li.addEventListener("mouseenter", on);
  li.addEventListener("focus", on);
  li.addEventListener("mouseleave", off);
  li.addEventListener("blur", off);
}

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------
const prefs = loadPrefs();
if (prefs.colors === false) { colorsEl.checked = false; document.body.classList.add("plain"); }
if (typeof prefs.code === "string" && prefs.code.trim()) {
  input.value = prefs.code;
  examplesEl.value = "";
} else {
  input.value = EXAMPLES[0].code;
  examplesEl.value = "0";
}
update();
