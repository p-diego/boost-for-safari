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
    { key: "hueRotate",  inputId: "hue-slider",        valueId: "hue-value",        min: 0,  max: 360, suffix: "°" },
    { key: "brightness", inputId: "brightness-slider", valueId: "brightness-value", min: 50, max: 150, suffix: "%" },
    { key: "saturation", inputId: "saturation-slider", valueId: "saturation-value", min: 0,  max: 200, suffix: "%" },
    { key: "contrast",   inputId: "contrast-slider",   valueId: "contrast-value",   min: 50, max: 150, suffix: "%" },
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

/* Marks the boost as active after any user modification. */
function markActive() {
    if (boost.enabled !== true) {
        boost.enabled = true;
        renderEnabledToggle();
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
    document.getElementById("color-sliders").classList.toggle("is-disabled", boost.colorEnabled !== true);
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
        const label = document.getElementById(cfg.valueId);
        if (input) input.value = String(value);
        if (label) label.textContent = value + cfg.suffix;
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
    if (ed.value !== (boost.customCSS || "")) ed.value = boost.customCSS || "";
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
        markActive();
        await saveBoost();
    });
    document.getElementById("color-boost-toggle").addEventListener("change", async (e) => {
        boost.colorEnabled = e.target.checked;
        markActive();
        renderColorBoostToggle();
        await saveBoost();
    });
    document.getElementById("zaps-toggle").addEventListener("change", async (e) => {
        boost.zapsEnabled = e.target.checked;
        await saveBoost();
    });
    document.getElementById("custom-toggle").addEventListener("change", async (e) => {
        boost.customEnabled = e.target.checked;
        await saveBoost();
    });
    document.getElementById("reset-btn").addEventListener("click", resetBoost);
}

function wireSliders() {
    for (const cfg of SLIDERS) {
        const input = document.getElementById(cfg.inputId);
        const label = document.getElementById(cfg.valueId);
        if (!input) continue;
        input.addEventListener("input", () => {
            const v = clampInt(input.value, cfg.min, cfg.max, DEFAULT_BOOST[cfg.key]);
            boost[cfg.key] = v;
            if (label) label.textContent = v + cfg.suffix;
            // First touch on any slider implicitly turns color boost on.
            if (!boost.colorEnabled) {
                boost.colorEnabled = true;
                renderColorBoostToggle();
            }
            markActive();
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
        markActive();
        await saveBoost();
    });
    document.getElementById("case-select").addEventListener("change", async (e) => {
        boost.textCase = e.target.value;
        markActive();
        await saveBoost();
    });
    document.getElementById("size-select").addEventListener("change", async (e) => {
        boost.textSize = parseInt(e.target.value, 10);
        markActive();
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
    let timer = null;
    ed.addEventListener("input", () => {
        boost.customCSS = ed.value;
        markActive();
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => saveBoost(), 250);
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
