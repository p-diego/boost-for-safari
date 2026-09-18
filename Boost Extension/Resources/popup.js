/* ─── Constants ────────────────────────────────────────────────── */

const FONTS = [
    { label: "Default", family: null },
    { label: "San Francisco", family: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" },
    { label: "Helvetica Neue", family: "'Helvetica Neue', Helvetica, sans-serif" },
    { label: "Avenir Next", family: "'Avenir Next', Avenir, sans-serif" },
    { label: "Optima", family: "Optima, sans-serif" },
    { label: "Futura", family: "Futura, sans-serif" },
    { label: "New York", family: "ui-serif, 'New York', serif" },
    { label: "Georgia", family: "Georgia, serif" },
    { label: "Times New Roman", family: "'Times New Roman', Times, serif" },
    { label: "Palatino", family: "Palatino, 'Palatino Linotype', serif" },
    { label: "Baskerville", family: "Baskerville, serif" },
    { label: "Hoefler Text", family: "'Hoefler Text', serif" },
    { label: "Didot", family: "Didot, serif" },
    { label: "Iowan Old Style", family: "'Iowan Old Style', serif" },
    { label: "American Typewriter", family: "'American Typewriter', serif" },
    { label: "Bradley Hand", family: "'Bradley Hand', cursive" },
    { label: "Snell Roundhand", family: "'Snell Roundhand', cursive" },
    { label: "Noteworthy", family: "Noteworthy, cursive" },
    { label: "Marker Felt", family: "'Marker Felt', cursive" },
    { label: "Copperplate", family: "Copperplate, fantasy" },
    { label: "Zapfino", family: "Zapfino, cursive" },
];

const DEFAULT_BOOST = {
    enabled: false,
    name: null,
    darkMode: false,
    colorEnabled: false,
    // Filter chain — stored as plain integers for readable import/export.
    // hueRotate is degrees (0..360); brightness/saturation/contrast are
    // percentages (100 = identity). content.js divides by 100 at render.
    hueRotate: 0,
    brightness: 100,
    saturation: 100,
    contrast: 100,
    fontIndex: 0,
    textCase: "default",
    textSize: 100,
    zapSelectors: [],
    zapsEnabled: true,
    customCSS: "",
    customEnabled: true,
};

const VIEWS = ["home", "hide", "code"];

// Slider config — declarative so render/wire/sanitize all read from the
// same source of truth.
const SLIDERS = [
    { key: "hueRotate",  inputId: "hue-slider",        min: 0,  max: 360 },
    { key: "brightness", inputId: "brightness-slider", min: 50, max: 150 },
    { key: "saturation", inputId: "saturation-slider", min: 0,  max: 200 },
    { key: "contrast",   inputId: "contrast-slider",   min: 50, max: 150 },
];

/* ─── State ────────────────────────────────────────────────────── */

let currentHost = null;
let boost = { ...DEFAULT_BOOST };
let currentView = "home";

/* ─── Storage ─────────────────────────────────────────────────── */

async function getActiveHost() {
    if (typeof browser === 'undefined' || !browser.tabs) return null;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    try { return new URL(tab.url).hostname || null; } catch { return null; }
}

async function loadBoost() {
    if (!currentHost) return;
    if (typeof browser === 'undefined' || !browser.storage) return;
    const stored = await browser.storage.local.get(currentHost);
    boost = { ...DEFAULT_BOOST, ...(stored[currentHost] || {}) };
}

async function saveBoost() {
    if (!currentHost) return;
    if (typeof browser !== 'undefined' && browser.storage) {
        await browser.storage.local.set({ [currentHost]: boost });
    }
    notifyContentScript();
}

/* True when no modification is currently active — nothing the master toggle
   could "turn on" remains. Slider values are ignored unless `colorEnabled`
   is on, since the filter chain only includes them in that case. */
function isBoostEffectivelyEmpty(b) {
    if (b.darkMode) return false;
    if (b.colorEnabled) return false;
    if (Number.isInteger(b.fontIndex) && b.fontIndex !== 0) return false;
    if (b.textCase && b.textCase !== "default") return false;
    if (Number.isFinite(b.textSize) && b.textSize !== 100) return false;
    if (b.zapsEnabled !== false && Array.isArray(b.zapSelectors) && b.zapSelectors.length > 0) return false;
    if (b.customEnabled !== false && (b.customCSS || "").trim() !== "") return false;
    return true;
}

/* Keeps the master `enabled` flag in sync with activity: any user edit that
   leaves at least one modification on flips `enabled` to true; an edit that
   clears the last active modification flips it off automatically. */
function syncMasterToggle() {
    const target = !isBoostEffectivelyEmpty(boost);
    if (boost.enabled !== target) {
        boost.enabled = target;
        renderEnabledToggle();
        refreshToolbarIcon();
    }
}

function refreshToolbarIcon() {
    try {
        browser.runtime.sendMessage({ type: "boost-icon-refresh" });
    } catch (e) {
        /* background may not be reachable; storage.onChanged will catch up. */
    }
}

async function notifyContentScript() {
    if (typeof browser === 'undefined' || !browser.tabs) return;
    try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return;
        await browser.tabs.sendMessage(tab.id, { type: "boost-updated", boost });
    } catch (e) {
        console.log("[Boost] content script not reachable:", e?.message);
    }
}

async function sendToContent(message) {
    if (typeof browser === 'undefined' || !browser.tabs) return;
    try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return;
        await browser.tabs.sendMessage(tab.id, message);
    } catch (e) {
        console.log("[Boost] sendToContent failed:", e?.message);
    }
}

/* ─── Slide navigation ────────────────────────────────────────── */

function showView(name, animate = true) {
    if (!VIEWS.includes(name)) return;
    currentView = name;
    const idx = VIEWS.indexOf(name);
    const track = document.getElementById("boost-views-track");

    if (!animate) {
        track.classList.add("no-anim");
    }

    track.style.transform = `translateX(-${idx * (100 / VIEWS.length)}%)`;

    if (!animate) {
        void track.offsetHeight;
        requestAnimationFrame(() => track.classList.remove("no-anim"));
    }
}

/* Locks the track height to the home view's intrinsic height.
   Sub-views taller than home will scroll internally via overflow-y. */
function lockHomeHeight() {
    const track = document.getElementById("boost-views-track");
    const home = track.querySelector('.view[data-view="home"]');
    if (!home) return;
    track.style.height = "auto";
    track.style.height = home.offsetHeight + "px";
}

/* ─── Rendering ───────────────────────────────────────────────── */

function renderHostLabel() {
    const label = document.getElementById("host-label");
    label.textContent = boost.name || currentHost || "Boost";
    const sel = document.getElementById("host-select");
    if (sel) sel.value = "";
}

function renderEnabledToggle() {
    document.getElementById("enabled-toggle").checked = boost.enabled !== false;
}

function renderDarkMode() {
    document.getElementById("dark-mode-toggle").checked = boost.darkMode === true;
}

function renderColorBoostToggle() {
    document.getElementById("color-boost-toggle").checked = boost.colorEnabled === true;
    document.getElementById("color-sliders").hidden = boost.colorEnabled !== true;
}

function clampInt(n, lo, hi, fallback) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return fallback;
    return Math.max(lo, Math.min(hi, v));
}

function renderSliders() {
    for (const cfg of SLIDERS) {
        const value = clampInt(boost[cfg.key], cfg.min, cfg.max, DEFAULT_BOOST[cfg.key]);
        const input = document.getElementById(cfg.inputId);
        if (input) input.value = String(value);
    }
    applySliderColors();
}

/* Drives the live HSL gradients and thumb fills. Each thumb shows the
   color the slider would produce at its current value so the control
   reads as a color swatch, not a generic UI knob. The shared --boost-h
   on the group cascades into the saturation/brightness track gradients. */
function applySliderColors() {
    const hue = clampInt(boost.hueRotate, 0, 360, 0);
    const brightness = clampInt(boost.brightness, 50, 150, 100);
    const saturation = clampInt(boost.saturation, 0, 200, 100);
    const contrast = clampInt(boost.contrast, 50, 150, 100);

    const group = document.getElementById("color-sliders");
    if (group) group.style.setProperty("--boost-h", String(hue));

    const hueEl = document.getElementById("hue-slider");
    if (hueEl) hueEl.style.setProperty("--boost-thumb-color", `hsl(${hue}, 100%, 50%)`);

    const brightEl = document.getElementById("brightness-slider");
    if (brightEl) {
        // brightness 50..150 → display lightness 25..75
        const l = Math.round(brightness / 2);
        brightEl.style.setProperty("--boost-thumb-color", `hsl(${hue}, 55%, ${l}%)`);
    }

    const satEl = document.getElementById("saturation-slider");
    if (satEl) {
        const s = Math.min(saturation, 100);
        satEl.style.setProperty("--boost-thumb-color", `hsl(${hue}, ${s}%, 55%)`);
    }

    const contrastEl = document.getElementById("contrast-slider");
    if (contrastEl) {
        // contrast 50..150 → display lightness 75..25 (higher contrast = darker swatch)
        const l = 100 - contrast / 2;
        contrastEl.style.setProperty("--boost-thumb-color", `hsl(0, 0%, ${l}%)`);
    }
}

function renderFontSelect() {
    const sel = document.getElementById("font-select");
    if (sel.childElementCount === 0) {
        FONTS.forEach((f, i) => {
            const opt = document.createElement("option");
            opt.value = String(i);
            opt.textContent = f.label;
            sel.appendChild(opt);
        });
    }
    sel.value = String(boost.fontIndex ?? 0);
}

function renderCaseSelect() {
    document.getElementById("case-select").value = boost.textCase || "default";
}

function renderSizeSelect() {
    document.getElementById("size-select").value = String(boost.textSize || 100);
}

function renderHideBadge() {
    const badge = document.getElementById("hide-badge");
    const n = (boost.zapSelectors || []).length;
    if (n === 0) {
        badge.hidden = true;
    } else {
        badge.hidden = false;
        badge.textContent = String(n);
    }
}

function renderCodeBadge() {
    const badge = document.getElementById("code-badge");
    // Count CSS rule blocks via `{`. Stripping block comments first avoids
    // counting braces inside `/* ... */`. Inline-string `{` chars are rare
    // enough in user-written CSS that we don't bother with a full tokenizer.
    const css = (boost.customCSS || "").replace(/\/\*[\s\S]*?\*\//g, "");
    const n = (css.match(/\{/g) || []).length;
    if (n === 0) {
        badge.hidden = true;
    } else {
        badge.hidden = false;
        badge.textContent = String(n);
    }
}

function renderHideRules() {
    const card = document.getElementById("hide-rules");
    const title = document.getElementById("hide-rules-title");
    const zaps = boost.zapSelectors || [];
    if (zaps.length === 0) {
        card.hidden = true;
        title.hidden = true;
        card.replaceChildren();
        return;
    }
    title.hidden = false;
    card.hidden = false;
    card.replaceChildren();
    zaps.forEach((selector, idx) => {
        const row = document.createElement("div");
        row.className = "zap-rule-row";
        const sel = document.createElement("span");
        sel.className = "zap-rule-sel";
        sel.textContent = selector;
        sel.title = selector;
        const del = document.createElement("button");
        del.type = "button";
        del.className = "zap-rule-delete";
        del.setAttribute("aria-label", "Remove");
        del.innerHTML = `<svg viewBox="0 0 12 12" width="11" height="11"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
        del.addEventListener("click", async () => {
            boost.zapSelectors = zaps.filter((_, i) => i !== idx);
            syncMasterToggle();
            await saveBoost();
            renderHideRules();
            renderHideBadge();
        });
        row.appendChild(sel);
        row.appendChild(del);
        card.appendChild(row);
    });
}

function renderZapsToggle() {
    document.getElementById("zaps-toggle").checked = boost.zapsEnabled !== false;
}

function renderCustomToggle() {
    document.getElementById("custom-toggle").checked = boost.customEnabled !== false;
}

function renderCodeEditor() {
    const ed = document.getElementById("code-editor");
    const v = boost.customCSS || "";
    if (ed.value !== v) ed.value = v;
    updateCodeEditorChrome(v);
}

function escapeCodeHTML(s) {
    return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

/* Stateful CSS tokenizer. Tracks brace depth and whether we're past the
   colon inside a declaration so we can colour property names and values
   differently. Selectors are anything outside braces. */
function highlightCSS(text) {
    const RE = /(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(@[\w-]+)|(#[\da-fA-F]+\b)|(-?\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|rad|turn|fr|pt|pc|in|cm|mm|ch|ex)?)|([{};:,])|([\w-]+)/g;
    let out = "";
    let last = 0;
    let depth = 0;
    let afterColon = false;
    let m;
    while ((m = RE.exec(text)) !== null) {
        if (m.index > last) out += escapeCodeHTML(text.slice(last, m.index));
        const raw = m[0];
        const esc = escapeCodeHTML(raw);
        let cls;
        if (m[1])      cls = "comment";
        else if (m[2]) cls = "string";
        else if (m[3]) cls = "atrule";
        else if (m[4]) cls = "number";
        else if (m[5]) cls = "number";
        else if (m[6]) {
            cls = "punct";
            if (raw === "{")      { depth++; afterColon = false; }
            else if (raw === "}") { depth = Math.max(0, depth - 1); afterColon = false; }
            else if (raw === ";") { afterColon = false; }
            else if (raw === ":" && depth > 0) { afterColon = true; }
        }
        else if (m[7]) {
            cls = depth > 0 ? (afterColon ? "value" : "property") : "selector";
        }
        out += `<span class="tok-${cls}">${esc}</span>`;
        last = m.index + raw.length;
    }
    if (last < text.length) out += escapeCodeHTML(text.slice(last));
    return out;
}

function updateCodeEditorChrome(text) {
    const gutter = document.getElementById("code-gutter");
    const hi = document.getElementById("code-highlight");
    const lineCount = Math.max(1, text.split("\n").length);
    let gut = "";
    for (let i = 1; i <= lineCount; i++) gut += `<div>${i}</div>`;
    gutter.innerHTML = gut;
    // Trailing newline trick: a final "\n " keeps the highlight box's last
    // line tall enough to match the textarea's phantom cursor line.
    hi.innerHTML = highlightCSS(text) + "\n ";
}

function renderAll() {
    renderHostLabel();
    renderEnabledToggle();
    renderDarkMode();
    renderColorBoostToggle();
    renderSliders();
    renderFontSelect();
    renderCaseSelect();
    renderSizeSelect();
    renderHideBadge();
    renderHideRules();
    renderZapsToggle();
    renderCustomToggle();
    renderCodeEditor();
    renderCodeBadge();
}

/* ─── Slider persistence (debounced) ──────────────────────────── */

let persistTimer = null;
function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        persistTimer = null;
        saveBoost();
    }, 80);
}

/* ─── Header dropdown menu (native macOS popup menu via <select>) ─ */

function exportBoost() {
    const data = JSON.stringify({ host: currentHost, boost }, null, 2);
    navigator.clipboard.writeText(data)
        .then(() => showToast("Copied to clipboard"))
        .catch((err) => {
            console.error("[Boost] clipboard write failed:", err);
            const ta = document.getElementById("import-input");
            ta.value = data;
            document.getElementById("import-modal-backdrop").hidden = false;
            document.getElementById("import-modal").hidden = false;
            setTimeout(() => { ta.focus(); ta.select(); }, 0);
            showToast("Copy manually from box");
        });
}

function openImportModal() {
    const ta = document.getElementById("import-input");
    ta.value = "";
    document.getElementById("import-modal-backdrop").hidden = false;
    document.getElementById("import-modal").hidden = false;
    setTimeout(() => ta.focus(), 0);
}

function closeImportModal() {
    document.getElementById("import-modal-backdrop").hidden = true;
    document.getElementById("import-modal").hidden = true;
}

const VALID_TEXT_CASES = new Set(["default", "upper", "lower", "capitalize"]);

function sanitizeBoost(input) {
    const out = { ...DEFAULT_BOOST };
    if (!input || typeof input !== "object") return out;

    const bool = (k) => { if (typeof input[k] === "boolean") out[k] = input[k]; };
    bool("enabled"); bool("darkMode"); bool("colorEnabled");
    bool("zapsEnabled"); bool("customEnabled");

    if (typeof input.name === "string") out.name = input.name.trim() || null;
    else if (input.name === null) out.name = null;

    // Slider fields — clamp to declared ranges, fall back to default.
    for (const cfg of SLIDERS) {
        const v = Math.round(Number(input[cfg.key]));
        if (Number.isFinite(v)) {
            out[cfg.key] = Math.max(cfg.min, Math.min(cfg.max, v));
        }
    }

    if (Number.isInteger(input.fontIndex)
        && input.fontIndex >= 0
        && input.fontIndex < FONTS.length) {
        out.fontIndex = input.fontIndex;
    }

    if (typeof input.textCase === "string" && VALID_TEXT_CASES.has(input.textCase)) {
        out.textCase = input.textCase;
    }

    if (Number.isFinite(input.textSize) && input.textSize > 0) {
        out.textSize = input.textSize;
    }

    if (Array.isArray(input.zapSelectors)) {
        out.zapSelectors = input.zapSelectors.filter((s) => typeof s === "string" && s.trim());
    }

    if (typeof input.customCSS === "string") out.customCSS = input.customCSS;

    return out;
}

async function commitImport() {
    const text = document.getElementById("import-input").value.trim();
    if (!text) {
        showToast("Empty");
        return;
    }
    try {
        const data = JSON.parse(text);
        const imported = data && typeof data === "object" && data.boost ? data.boost : data;
        if (!imported || typeof imported !== "object") {
            showToast("Invalid format");
            return;
        }
        boost = sanitizeBoost(imported);
        await saveBoost();
        renderAll();
        closeImportModal();
        showToast("Boost imported");
    } catch (err) {
        console.error("[Boost] import failed:", err);
        showToast("Invalid JSON");
    }
}

async function deleteBoost() {
    if (!currentHost) return;
    if (typeof browser !== 'undefined' && browser.storage) {
        await browser.storage.local.remove(currentHost);
    }
    boost = { ...DEFAULT_BOOST };
    await notifyContentScript();
    renderAll();
    showToast("Boost deleted");
}

function openRenameModal() {
    const input = document.getElementById("rename-input");
    input.value = boost.name || "";
    document.getElementById("modal-backdrop").hidden = false;
    document.getElementById("rename-modal").hidden = false;
    setTimeout(() => input.focus(), 0);
}

function closeRenameModal() {
    document.getElementById("modal-backdrop").hidden = true;
    document.getElementById("rename-modal").hidden = true;
}

async function commitRename() {
    const v = document.getElementById("rename-input").value.trim();
    boost.name = v || null;
    await saveBoost();
    renderHostLabel();
    closeRenameModal();
}

function wireHostMenu() {
    const sel = document.getElementById("host-select");
    sel.addEventListener("change", () => {
        const action = sel.value;
        sel.value = "";
        if (action === "rename") openRenameModal();
        else if (action === "reset") resetBoost();
        else if (action === "delete") deleteBoost();
        else if (action === "import") openImportModal();
        else if (action === "export") exportBoost();
    });
    document.querySelector("[data-modal-cancel]").addEventListener("click", closeRenameModal);
    document.querySelector("[data-modal-ok]").addEventListener("click", commitRename);
    document.getElementById("modal-backdrop").addEventListener("click", closeRenameModal);
    document.getElementById("rename-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") commitRename();
        if (e.key === "Escape") closeRenameModal();
    });

    document.querySelector("[data-import-cancel]").addEventListener("click", closeImportModal);
    document.querySelector("[data-import-ok]").addEventListener("click", commitImport);
    document.getElementById("import-modal-backdrop").addEventListener("click", closeImportModal);
    document.getElementById("import-input").addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeImportModal();
    });
}

/* ─── Reset ──────────────────────────────────────────────────── */

async function resetBoost() {
    boost = { ...DEFAULT_BOOST };
    await saveBoost();
    renderAll();
    showToast("Reset");
}

/* ─── Toast ──────────────────────────────────────────────────── */

let toastTimer = null;
function showToast(text) {
    const t = document.getElementById("toast");
    t.textContent = text;
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
}

/* ─── Wiring ─────────────────────────────────────────────────── */

function wireNav() {
    document.querySelectorAll("[data-nav]").forEach((el) => {
        el.addEventListener("click", () => showView(el.dataset.nav));
    });
    document.querySelectorAll("[data-back]").forEach((el) => {
        el.addEventListener("click", () => showView("home"));
    });
}

function wireToggles() {
    document.getElementById("enabled-toggle").addEventListener("change", async (e) => {
        boost.enabled = e.target.checked;
        await saveBoost();
        refreshToolbarIcon();
    });
    document.getElementById("dark-mode-toggle").addEventListener("change", async (e) => {
        boost.darkMode = e.target.checked;
        syncMasterToggle();
        await saveBoost();
    });
    document.getElementById("color-boost-toggle").addEventListener("change", async (e) => {
        boost.colorEnabled = e.target.checked;
        syncMasterToggle();
        renderColorBoostToggle();
        lockHomeHeight();
        await saveBoost();
    });
    document.getElementById("zaps-toggle").addEventListener("change", async (e) => {
        boost.zapsEnabled = e.target.checked;
        syncMasterToggle();
        await saveBoost();
    });
    document.getElementById("custom-toggle").addEventListener("change", async (e) => {
        boost.customEnabled = e.target.checked;
        syncMasterToggle();
        await saveBoost();
    });
    document.getElementById("reset-btn").addEventListener("click", resetBoost);
}

function wireSliders() {
    for (const cfg of SLIDERS) {
        const input = document.getElementById(cfg.inputId);
        if (!input) continue;
        input.addEventListener("input", () => {
            const v = clampInt(input.value, cfg.min, cfg.max, DEFAULT_BOOST[cfg.key]);
            boost[cfg.key] = v;
            applySliderColors();
            syncMasterToggle();
            // Push to content immediately for live preview, then debounce
            // the storage write to avoid churn during the drag.
            notifyContentScript();
            schedulePersist();
        });
        input.addEventListener("change", () => {
            // Drag ended — flush whatever the debounce had queued.
            if (persistTimer) {
                clearTimeout(persistTimer);
                persistTimer = null;
            }
            saveBoost();
        });
    }
}

function wireSelects() {
    document.getElementById("font-select").addEventListener("change", async (e) => {
        boost.fontIndex = parseInt(e.target.value, 10);
        syncMasterToggle();
        await saveBoost();
    });
    document.getElementById("case-select").addEventListener("change", async (e) => {
        boost.textCase = e.target.value;
        syncMasterToggle();
        await saveBoost();
    });
    document.getElementById("size-select").addEventListener("change", async (e) => {
        boost.textSize = parseInt(e.target.value, 10);
        syncMasterToggle();
        await saveBoost();
    });
}

function wireZapPick() {
    document.getElementById("hide-pick-btn").addEventListener("click", async () => {
        await sendToContent({ type: "boost-enter-zap", mode: "hide" });
        window.close();
    });
    document.getElementById("code-pick-btn").addEventListener("click", async () => {
        await sendToContent({ type: "boost-enter-zap", mode: "code" });
        window.close();
    });
}

function wireCodeEditor() {
    const ed = document.getElementById("code-editor");
    const gutter = document.getElementById("code-gutter");
    const hi = document.getElementById("code-highlight");
    let timer = null;
    ed.addEventListener("input", () => {
        boost.customCSS = ed.value;
        syncMasterToggle();
        renderCodeBadge();
        updateCodeEditorChrome(ed.value);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => saveBoost(), 250);
    });
    // Keep the highlight overlay and gutter aligned with the textarea's
    // scroll position so the colored text sits exactly under the caret.
    ed.addEventListener("scroll", () => {
        hi.scrollTop = ed.scrollTop;
        hi.scrollLeft = ed.scrollLeft;
        gutter.scrollTop = ed.scrollTop;
    });
    ed.addEventListener("keydown", (e) => {
        if (e.key === "Tab") {
            e.preventDefault();
            const start = ed.selectionStart;
            const end = ed.selectionEnd;
            ed.setRangeText("    ", start, end, "end");
            // setRangeText doesn't fire `input` on its own.
            ed.dispatchEvent(new Event("input", { bubbles: true }));
        }
    });
}

/* ─── Pending selector for code (from zap pick in 'code' mode) ── */

async function consumePendingSelector() {
    if (!currentHost) return;
    if (typeof browser === 'undefined' || !browser.storage) return;

    const stored = await browser.storage.local.get(currentHost);
    const b = stored[currentHost];

    if (!b?.pendingSelectorForCode) return;
    const sel = b.pendingSelectorForCode;
    const cur = b.customCSS || "";
    if (!cur.includes(`${sel} {`)) {
        const insertion = (cur && !cur.endsWith("\n") ? "\n" : "") + `${sel} {\n  \n}\n`;
        boost.customCSS = cur + insertion;
    }
    delete boost.pendingSelectorForCode;
    await saveBoost();
    showView("code", false);
    renderCodeEditor();
    showToast(`Selector ready: ${sel}`);
}

/* ─── Init ───────────────────────────────────────────────────── */

async function init() {
    currentHost = await getActiveHost();
    console.log("[Boost] popup init, host:", currentHost);

    if (!currentHost) {
        document.getElementById("host-label").textContent = "No site to boost";
        document.querySelector(".boost-root").classList.add("is-disabled");
        return;
    }

    await loadBoost();
    renderAll();
    wireNav();
    wireToggles();
    wireSelects();
    wireSliders();
    wireHostMenu();
    wireZapPick();
    wireCodeEditor();

    requestAnimationFrame(() => {
        showView("home", false);
        requestAnimationFrame(() => {
            lockHomeHeight();
            consumePendingSelector();
        });
    });
}

window.addEventListener("resize", () => lockHomeHeight());
init();
