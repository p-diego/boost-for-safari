// ============================================================================
// Top-level wiring — must survive IIFE re-execution.
//
// Safari sometimes re-injects this content script into a page where it has
// already run (extension reloads, SPA history events, certain navigations).
// Top-level `let`/`const` would throw "duplicate variable" on the second run,
// so the declarations live inside an IIFE gated by `__boostContentScriptLoaded`.
//
// The browser API listeners, however, MUST be registered every execution OR be
// idempotent. If we register them only inside the gated IIFE, a re-execution
// skips listener setup, AND the previous execution's listeners may have been
// dropped — leaving the page silently unable to receive popup updates (the
// symptom: toggles don't apply live, only on reload).
//
// Fix: register listeners ONCE on `window` (idempotent), and route them to a
// `window.__boostApi` indirection that the IIFE keeps up-to-date with the
// latest handler references. This way the listeners survive re-execution and
// always dispatch to the freshest applyBoost / enterZapMode.
// ============================================================================

window.__boostApi = window.__boostApi || {};

if (typeof browser !== 'undefined' && browser?.storage && !window.__boostStorageListenerRegistered) {
    window.__boostStorageListenerRegistered = true;
    browser.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        const hostChange = changes[location.hostname];
        if (hostChange && window.__boostApi.applyBoost) {
            window.__boostApi.applyBoost(hostChange.newValue);
        }
    });
}

if (typeof browser !== 'undefined' && browser?.runtime && !window.__boostRuntimeListenerRegistered) {
    window.__boostRuntimeListenerRegistered = true;
    browser.runtime.onMessage.addListener((request) => {
        if (request?.type === "boost-updated" && window.__boostApi.applyBoost) {
            window.__boostApi.applyBoost(request.boost);
        } else if (request?.type === "boost-enter-zap" && window.__boostApi.enterZapMode) {
            window.__boostApi.enterZapMode(request.mode || "hide");
        }
    });
}

// Safety net for bfcache restores: re-pull boost and re-apply.
if (!window.__boostPageshowRegistered) {
    window.__boostPageshowRegistered = true;
    window.addEventListener('pageshow', () => {
        if (window.__boostApi.getBoost && window.__boostApi.applyBoost) {
            window.__boostApi.getBoost().then(b => window.__boostApi.applyBoost(b));
        }
    });
}

if (window.__boostContentScriptLoaded) {
    // Already loaded — abort this re-execution before declaring anything.
} else {
    window.__boostContentScriptLoaded = true;
(function () {

// ============================================================================
// CONSTANTS
// ============================================================================
const BOOST_STYLE_ID = "boost-injected-style";
const BOOST_CUSTOM_STYLE_ID = "boost-custom-style";
const BOOST_ZAP_STYLE_ID = "boost-zap-mode-style";
const BOOST_ZAP_OUTLINE_ID = "boost-zap-outline";
const BOOST_ZAP_CONFIRM_ID = "boost-zap-confirm";
const BOOST_ZAP_BANNER_CLASS = "boost-zap-banner";

const BOOST_FONT_FAMILIES = [
    null, // 0 = Default (no override)
    "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
    "'Helvetica Neue', Helvetica, sans-serif",
    "'Avenir Next', Avenir, sans-serif",
    "Optima, sans-serif",
    "Futura, sans-serif",
    "ui-serif, 'New York', serif",
    "Georgia, serif",
    "'Times New Roman', Times, serif",
    "Palatino, 'Palatino Linotype', serif",
    "Baskerville, serif",
    "'Hoefler Text', serif",
    "Didot, serif",
    "'Iowan Old Style', serif",
    "'American Typewriter', serif",
    "'Bradley Hand', cursive",
    "'Snell Roundhand', cursive",
    "Noteworthy, cursive",
    "'Marker Felt', cursive",
    "Copperplate, fantasy",
    "Zapfino, cursive",
];

const BOOST_TEXT_CASE_MAP = {
    "default": null,
    "upper": "uppercase",
    "lower": "lowercase",
    "capitalize": "capitalize",
};

// Tags whose colors must be counter-inverted when dark mode is on, so the
// page's images/videos don't get their hues flipped along with the page chrome.
// Mirrors Zen's "smart invert" semantics: the filter on <html> inverts
// everything, then we invert these back to their original colors.
//
// `<picture>` is intentionally excluded: it's an invisible wrapper around the
// inner `<img>`, and applying a filter to BOTH stacks a second invert on top
// of the img's own counter-invert (CSS filters wrap the entire subtree into a
// layer before applying), which double-inverts the bitmap. Excluding picture
// keeps the inner img's counter-invert as the single source of truth.
const BOOST_MEDIA_COUNTER_INVERT_SELECTOR =
    'img, video, iframe, embed, object, svg image';

// Semantic UI regions whose images should NOT be counter-inverted: logos and
// nav icons sitting inside `<header>`/`<nav>`/`<footer>`/`<aside>` are usually
// designed for the surrounding chrome's tone. After the html filter flips that
// chrome to dark, we want the logos to flip with it (a black "WIRED" wordmark
// on a now-dark header would otherwise stay invisible-black-on-black).
const BOOST_UI_REGIONS_SELECTOR =
    'header, nav, footer, aside, ' +
    '[role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]';

// Relative-luminance threshold (WCAG sRGB) below which a UI region is judged
// "already dark" by design and gets a counter-invert to preserve its look.
const BOOST_DARK_LUMINANCE_THRESHOLD = 0.35;

// Attribute used to flag UI regions that should be counter-inverted to keep
// their original dark theme. Cleared when dark mode is disabled.
const BOOST_DARK_UI_TAG = 'data-boost-dark';

// Rendered-size threshold (px on either axis) above which an `<img>` inside a
// UI region is treated as content (e.g., a hero banner inside a `<header>`)
// rather than UI (e.g., a logo) — and therefore opts back IN to counter-invert
// so its original colors are preserved.
const BOOST_LARGE_IMG_THRESHOLD = 200;
const BOOST_LARGE_IMG_TAG = 'data-boost-large';

// Attribute marking a parent that exists exclusively to host a <video> (e.g.,
// YouTube's `<div class="html5-video-container"><video/></div>`). Safari
// applies CSS filters reliably to the wrapper but not always to playing video
// frames (hardware decode bypass), so we counter-invert the wrapper instead.
const BOOST_VIDEO_CONTAINER_TAG = 'data-boost-video-container';

// ============================================================================
// CSS BUILDING
// ============================================================================

function buildFilterChain(boost) {
    const parts = [];
    if (boost.darkMode) {
        // Smart invert: flips light↔dark while preserving hue.
        parts.push("invert(1)");
        parts.push("hue-rotate(180deg)");
    }
    if (boost.colorEnabled === true) {
        // Stored values are integers: hue in degrees (0..360); brightness,
        // saturation and contrast as percentages (100 = identity). We divide
        // by 100 here to feed CSS the unitless float it expects.
        const hue = Number(boost.hueRotate);
        if (Number.isFinite(hue) && hue !== 0) {
            parts.push(`hue-rotate(${hue}deg)`);
        }
        const brightness = Number(boost.brightness);
        if (Number.isFinite(brightness) && brightness !== 100) {
            parts.push(`brightness(${brightness / 100})`);
        }
        const saturation = Number(boost.saturation);
        if (Number.isFinite(saturation) && saturation !== 100) {
            parts.push(`saturate(${saturation / 100})`);
        }
        const contrast = Number(boost.contrast);
        if (Number.isFinite(contrast) && contrast !== 100) {
            parts.push(`contrast(${contrast / 100})`);
        }
    }
    return parts.join(" ");
}

// Mathematical inverse of buildFilterChain — applied to media (and other
// "preserve original" elements) so that html_filter(media_filter(c)) ≈ c.
// CSS filters compose left-to-right, so the inverse must list operations in
// REVERSE order with each one's inverse:
//   html:    invert(1) hue-rotate(180) hue-rotate(X) brightness(Y) saturate(Z) contrast(W)
//   inverse: contrast(1/W) saturate(1/Z) brightness(1/Y) hue-rotate(-X) hue-rotate(-180) invert(1)
function buildInverseFilterChain(boost) {
    const parts = [];
    if (boost.colorEnabled === true) {
        const contrast = Number(boost.contrast);
        if (Number.isFinite(contrast) && contrast !== 100) {
            parts.push(`contrast(${100 / contrast})`);
        }
        const saturation = Number(boost.saturation);
        if (Number.isFinite(saturation) && saturation !== 100) {
            parts.push(`saturate(${100 / saturation})`);
        }
        const brightness = Number(boost.brightness);
        if (Number.isFinite(brightness) && brightness !== 100) {
            parts.push(`brightness(${100 / brightness})`);
        }
        const hue = Number(boost.hueRotate);
        if (Number.isFinite(hue) && hue !== 0) {
            parts.push(`hue-rotate(${-hue}deg)`);
        }
    }
    if (boost.darkMode) {
        parts.push("hue-rotate(-180deg)");
        parts.push("invert(1)");
    }
    return parts.join(" ");
}

function buildCSS(boost) {
    if (!boost || boost.enabled === false) return "";
    const rules = [];

    const filterChain = buildFilterChain(boost);
    if (filterChain) {
        // color-scheme hints to the UA so form controls, scrollbars, and
        // `<meta name="theme-color">` honor the inverted palette.
        if (boost.darkMode) {
            rules.push(`:root { color-scheme: dark !important; }`);
        }
        rules.push(`html { filter: ${filterChain} !important; }`);

        // Counter-invert media so photos/videos/iframes keep their real
        // colors while the rest of the page is filtered. Must mirror the
        // FULL html filter chain (dark mode + color boost), otherwise color
        // boost adjustments leak onto media even though they shouldn't.
        const inverseChain = buildInverseFilterChain(boost);
        if (inverseChain) {
            rules.push(`${BOOST_MEDIA_COUNTER_INVERT_SELECTOR} { filter: ${inverseChain} !important; }`);
        }

        if (boost.darkMode) {
            // Point 2: images inside UI regions opt back OUT of counter-invert
            // so site logos invert along with the surrounding chrome and stay
            // legible. Higher specificity than the media rule above (descendant
            // selector with an attribute matcher inside :is) so this wins.
            rules.push(`:is(${BOOST_UI_REGIONS_SELECTOR}) :is(img, svg image) { filter: none !important; }`);
            // Large images inside UI regions are content (hero banners, article
            // covers under a `<header>`), not chrome. Re-enable counter-invert
            // for them via the size tag set by tagLargeUiImages, so their
            // colors are preserved instead of being flipped with the page.
            rules.push(`:is(${BOOST_UI_REGIONS_SELECTOR}) img[${BOOST_LARGE_IMG_TAG}="true"] { filter: ${inverseChain} !important; }`);
            // Point A: UI regions whose computed background is already dark
            // (tagged by tagDarkUiElements at apply time) get counter-inverted
            // so they retain their intended dark look instead of being flipped
            // to light by the page-level filter.
            rules.push(`[${BOOST_DARK_UI_TAG}="true"] { filter: ${inverseChain} !important; }`);
            // Video wrapper counter-invert: when a parent exists exclusively
            // to host a <video> (no other children), counter-invert it so the
            // hardware-decoded video frames display in original colors. Inside
            // a tagged wrapper, suppress the video element's own counter-
            // invert to avoid double-application.
            rules.push(`[${BOOST_VIDEO_CONTAINER_TAG}="true"] { filter: ${inverseChain} !important; }`);
            rules.push(`[${BOOST_VIDEO_CONTAINER_TAG}="true"] > video { filter: none !important; }`);
        }
    }

    if (typeof boost.fontIndex === "number" && BOOST_FONT_FAMILIES[boost.fontIndex]) {
        const family = BOOST_FONT_FAMILIES[boost.fontIndex];
        rules.push(`html, body, body * { font-family: ${family} !important; }`);
    }
    const textCase = BOOST_TEXT_CASE_MAP[boost.textCase];
    if (textCase) {
        rules.push(`html, body, body * { text-transform: ${textCase} !important; }`);
    }
    if (typeof boost.textSize === "number" && boost.textSize !== 100 && boost.textSize > 0) {
        rules.push(`html { font-size: ${boost.textSize}% !important; }`);
    }
    const zaps = Array.isArray(boost.zapSelectors) ? boost.zapSelectors : [];
    if (zaps.length && boost.zapsEnabled !== false) {
        // Emit one rule per selector. CSS discards an entire selector list
        // if any of its selectors fails to parse, so a single bad zap would
        // otherwise resurface every hidden element on the page.
        const probe = document.createDocumentFragment();
        for (const s of zaps) {
            if (typeof s !== "string" || !s.trim()) continue;
            try { probe.querySelector(s); }
            catch { continue; }
            rules.push(`${s} { display: none !important; }`);
        }
    }

    return rules.join("\n");
}

// ============================================================================
// DARK UI DETECTION (Point A)
//
// Walk semantic UI regions, measure their computed background, and tag the
// ones that are already dark by design so the CSS rule above can counter-
// invert them back to dark. Re-runs on DOM changes via MutationObserver.
// ============================================================================

function boostParseRgb(str) {
    if (!str) return null;
    const m = str.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
    if (!m) return null;
    return {
        r: parseFloat(m[1]),
        g: parseFloat(m[2]),
        b: parseFloat(m[3]),
        a: m[4] !== undefined ? parseFloat(m[4]) : 1,
    };
}

// WCAG relative luminance, sRGB.
function boostRelativeLuminance(r, g, b) {
    const f = (c) => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// Returns true if a background-color string represents an opaque dark color
// per WCAG luminance, false otherwise. Returns null if the color carries no
// opinion (fully transparent, unparseable, missing).
function boostIsDarkBg(bgStr) {
    const c = boostParseRgb(bgStr);
    if (!c || c.a < 0.5) return null;
    return boostRelativeLuminance(c.r, c.g, c.b) < BOOST_DARK_LUMINANCE_THRESHOLD;
}

// Heuristic check: would tagging this element counter-invert a region that
// actually contains page content (article, main, gallery, video)? If yes the
// candidate is a "content wrapper", not chrome, and we shouldn't claim it for
// dark-UI preservation — doing so would neutralise dark mode on the article
// body. Run AFTER the walk-up, so we only validate a single candidate per
// semantic element.
function boostIsContentWrapper(el) {
    // Explicit content landmarks → it IS content.
    if (el.querySelector('main, article')) return true;
    // A <video> element inside means the wrapper is a media region.
    if (el.querySelector('video')) return true;
    // Multiple large images → likely a gallery / article image stream.
    const imgs = el.querySelectorAll('img');
    let largeCount = 0;
    for (const img of imgs) {
        const r = img.getBoundingClientRect();
        if (r.width >= 200 || r.height >= 200) {
            largeCount++;
            if (largeCount >= 2) return true;
        }
    }
    // Very tall area (more than half the viewport) → too big to be chrome.
    const rect = el.getBoundingClientRect();
    if (rect.height > window.innerHeight * 0.6) return true;
    return false;
}

function tagDarkUiElements() {
    if (!document.body) return;
    // Re-tagging may move the "right" element to tag up the tree (e.g., when
    // the page's wrapper structure changes), so start each pass from a clean
    // slate. SetAttribute on the same element across passes is idempotent.
    untagDarkUiElements();

    const els = document.querySelectorAll(BOOST_UI_REGIONS_SELECTOR);
    for (const el of els) {
        // Walk up the tree starting from this semantic element, looking for the
        // OUTERMOST dark ancestor in an unbroken chain. Stop on the first
        // opaque-non-dark ancestor (chain broken) or at <body>/<html> (tagging
        // body would counter-invert the entire page and defeat dark mode).
        //
        // Why this matters: sites like wired.it wrap a centered <footer> in a
        // full-bleed <div class="footer-bg" style="background:#000">. If we
        // only tag the inner <footer>, the outer div is left to the html-level
        // invert and shows as a white band on the sides. Tagging the outermost
        // dark wrapper instead counter-inverts the whole region.
        let outermost = null;
        let cur = el;
        while (cur && cur !== document.body && cur !== document.documentElement) {
            const isDark = boostIsDarkBg(getComputedStyle(cur).backgroundColor);
            if (isDark === true) {
                outermost = cur; // candidate — keep walking for a wider dark wrapper
            } else if (isDark === false) {
                break;           // opaque-light ancestor → chain breaks here
            }
            // isDark === null (transparent) → no opinion, keep climbing
            cur = cur.parentElement;
        }
        if (!outermost) continue;

        // Post-walk validation: if the outermost candidate is actually a
        // content wrapper (contains <main>/<article>, has multiple large
        // images, contains a <video>, or spans most of the viewport), don't
        // tag it — counter-inverting content reads as "dark mode was skipped"
        // on the article body. Fall back to tagging the semantic element
        // itself if it's dark; otherwise tag nothing.
        if (boostIsContentWrapper(outermost)) {
            if (outermost !== el && boostIsDarkBg(getComputedStyle(el).backgroundColor) === true) {
                el.setAttribute(BOOST_DARK_UI_TAG, 'true');
            }
            continue;
        }

        outermost.setAttribute(BOOST_DARK_UI_TAG, 'true');
    }
}

function untagDarkUiElements() {
    document.querySelectorAll(`[${BOOST_DARK_UI_TAG}]`).forEach((el) => {
        el.removeAttribute(BOOST_DARK_UI_TAG);
    });
}

// Tracks imgs we've already wired a load listener on, so re-tag passes don't
// pile up listeners. WeakSet self-evicts as elements get GC'd.
const boostLoadAttachedImgs = new WeakSet();

function boostMeasureImg(img) {
    // Rendered size first — a 4000×4000 image displayed at 32×32 is being used
    // as an icon, not as content. Fall back to natural dims when layout hasn't
    // settled yet (early document_start pass).
    const rect = img.getBoundingClientRect();
    const w = rect.width || img.naturalWidth || 0;
    const h = rect.height || img.naturalHeight || 0;
    return { w, h };
}

function boostTagImgBySize(img) {
    const { w, h } = boostMeasureImg(img);
    if (w >= BOOST_LARGE_IMG_THRESHOLD || h >= BOOST_LARGE_IMG_THRESHOLD) {
        img.setAttribute(BOOST_LARGE_IMG_TAG, 'true');
    } else {
        img.removeAttribute(BOOST_LARGE_IMG_TAG);
    }
}

function tagLargeUiImages() {
    if (!document.body) return;
    const imgs = document.querySelectorAll(`:is(${BOOST_UI_REGIONS_SELECTOR}) img`);
    for (const img of imgs) {
        if (img.complete && img.naturalWidth > 0) {
            boostTagImgBySize(img);
        } else if (!boostLoadAttachedImgs.has(img)) {
            // Lazy-loaded or still pending: tag once the bitmap arrives. Until
            // then it stays untagged → Point 2 applies (inverts with chrome).
            boostLoadAttachedImgs.add(img);
            img.addEventListener('load', () => boostTagImgBySize(img), { once: true });
        }
    }
}

function untagLargeUiImages() {
    document.querySelectorAll(`[${BOOST_LARGE_IMG_TAG}]`).forEach((img) => {
        img.removeAttribute(BOOST_LARGE_IMG_TAG);
    });
}

// Tag <video> parents that contain ONLY video-related children (<video>,
// <source>, <track>). Restricting to "exclusive wrappers" avoids hijacking the
// filter on containers that also host real content (e.g., an <article> with a
// video and prose) — there we leave the video element's own counter-invert as
// the best-effort fallback.
function tagVideoContainers() {
    if (!document.body) return;
    document.querySelectorAll('video').forEach((v) => {
        const p = v.parentElement;
        if (!p || p === document.body || p === document.documentElement) return;
        const exclusive = Array.from(p.children).every((c) =>
            c.tagName === 'VIDEO' || c.tagName === 'SOURCE' || c.tagName === 'TRACK'
        );
        if (exclusive) {
            p.setAttribute(BOOST_VIDEO_CONTAINER_TAG, 'true');
        } else {
            p.removeAttribute(BOOST_VIDEO_CONTAINER_TAG);
        }
    });
}

function untagVideoContainers() {
    document.querySelectorAll(`[${BOOST_VIDEO_CONTAINER_TAG}]`).forEach((el) => {
        el.removeAttribute(BOOST_VIDEO_CONTAINER_TAG);
    });
}

let boostDarkUiObserver = null;
let boostDarkUiRetagTimer = null;
let boostDarkUiDomReadyHandler = null;

function boostScheduleDarkUiRetag() {
    if (boostDarkUiRetagTimer) return;
    boostDarkUiRetagTimer = setTimeout(() => {
        boostDarkUiRetagTimer = null;
        tagDarkUiElements();
        tagLargeUiImages();
        tagVideoContainers();
    }, 250);
}

function startDarkUiTracking() {
    // Already running: just retag in case the DOM changed without an event
    // we observe (e.g., color-scheme media-query flip in the page CSS).
    if (boostDarkUiObserver) {
        tagDarkUiElements();
        tagLargeUiImages();
        tagVideoContainers();
        return;
    }

    if (document.body) {
        tagDarkUiElements();
        tagLargeUiImages();
        tagVideoContainers();
    } else {
        boostDarkUiDomReadyHandler = () => {
            boostDarkUiDomReadyHandler = null;
            tagDarkUiElements();
            tagLargeUiImages();
            tagVideoContainers();
        };
        document.addEventListener('DOMContentLoaded', boostDarkUiDomReadyHandler, { once: true });
    }

    boostDarkUiObserver = new MutationObserver(() => boostScheduleDarkUiRetag());
    boostDarkUiObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
    });
}

function stopDarkUiTracking() {
    if (boostDarkUiObserver) {
        boostDarkUiObserver.disconnect();
        boostDarkUiObserver = null;
    }
    if (boostDarkUiRetagTimer) {
        clearTimeout(boostDarkUiRetagTimer);
        boostDarkUiRetagTimer = null;
    }
    if (boostDarkUiDomReadyHandler) {
        document.removeEventListener('DOMContentLoaded', boostDarkUiDomReadyHandler);
        boostDarkUiDomReadyHandler = null;
    }
    untagDarkUiElements();
    untagLargeUiImages();
    untagVideoContainers();
}

function applyBoost(boost) {
    const css = buildCSS(boost);
    let style = document.getElementById(BOOST_STYLE_ID);
    if (!css) {
        style?.remove();
    } else {
        if (!style) {
            style = document.createElement("style");
            style.id = BOOST_STYLE_ID;
            (document.head || document.documentElement).appendChild(style);
        }
        style.textContent = css;
    }

    // Custom CSS lives in its own style tag so it can be toggled independently.
    let customStyle = document.getElementById(BOOST_CUSTOM_STYLE_ID);
    const customCSS = (boost && boost.enabled !== false && boost.customEnabled !== false) ? (boost.customCSS || "") : "";
    if (!customCSS) {
        customStyle?.remove();
    } else {
        if (!customStyle) {
            customStyle = document.createElement("style");
            customStyle.id = BOOST_CUSTOM_STYLE_ID;
            (document.head || document.documentElement).appendChild(customStyle);
        }
        customStyle.textContent = customCSS;
    }

    // Point A lifecycle: only tag/observe while dark mode is actually active.
    if (boost?.darkMode && boost?.enabled !== false) {
        startDarkUiTracking();
    } else {
        stopDarkUiTracking();
    }
}

async function getBoost() {
    const host = location.hostname;
    if (!host) return null;
    if (typeof browser === 'undefined' || !browser.storage) return null;
    const stored = await browser.storage.local.get(host);
    return stored[host] || null;
}

async function saveBoost(boost) {
    const host = location.hostname;
    if (!host) return;
    if (typeof browser === 'undefined' || !browser.storage) return;
    await browser.storage.local.set({ [host]: boost });
}

async function loadAndApply() {
    console.log('[Boost] Content script loaded', {
        hasBrowser: typeof browser !== 'undefined',
        hostname: location.hostname
    });

    const boost = await getBoost();
    applyBoost(boost);
}

// Expose handlers to the top-level listeners (registered outside this IIFE).
// Without this assignment, the storage/runtime/pageshow listeners would call
// `undefined` and silently no-op — which manifested as toggles having no
// effect until the page was reloaded.
window.__boostApi.applyBoost = applyBoost;
window.__boostApi.getBoost = getBoost;
window.__boostApi.enterZapMode = enterZapMode;

loadAndApply();

/* ─── Zap mode ────────────────────────────────────────────────── */

let zapActive = false;
let zapMode = "hide"; // "hide" | "code"
let zapState = "idle"; // "idle" | "hover" | "confirming"
let zapHovered = null;
let zapPendingEl = null;
let zapPendingSelector = null;

function computeSelector(el) {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return "#" + el.id;
    const parts = [];
    let cur = el;
    const stopAt = document.body;
    while (cur && cur.nodeType === 1 && cur !== stopAt) {
        let part = cur.tagName.toLowerCase();
        if (cur.classList && cur.classList.length) {
            const classes = Array.from(cur.classList)
                .filter((c) => /^[A-Za-z_][\w-]*$/.test(c))
                .slice(0, 2)
                .map((c) => "." + c);
            part += classes.join("");
        }
        const parent = cur.parentElement;
        if (parent) {
            const siblings = Array.from(parent.children).filter((s) => s.tagName === cur.tagName);
            if (siblings.length > 1) {
                const i = siblings.indexOf(cur) + 1;
                part += `:nth-of-type(${i})`;
            }
        }
        parts.unshift(part);
        const candidate = parts.join(" > ");
        try {
            if (document.querySelectorAll(candidate).length === 1) return candidate;
        } catch { /* invalid selector — keep walking */ }
        cur = cur.parentElement;
    }
    return parts.join(" > ");
}

function isZapChrome(el) {
    if (!el) return false;
    return el.id === BOOST_ZAP_OUTLINE_ID
        || el.id === BOOST_ZAP_CONFIRM_ID
        || el.closest?.(`#${BOOST_ZAP_CONFIRM_ID}`)
        || el.classList?.contains(BOOST_ZAP_BANNER_CLASS);
}

function ensureZapStyle() {
    if (document.getElementById(BOOST_ZAP_STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = BOOST_ZAP_STYLE_ID;
    s.textContent = `
        html.boost-zap-mode, html.boost-zap-mode * { cursor: crosshair !important; }
        html.boost-zap-mode #${BOOST_ZAP_CONFIRM_ID},
        html.boost-zap-mode #${BOOST_ZAP_CONFIRM_ID} * { cursor: default !important; }
        html.boost-zap-mode #${BOOST_ZAP_CONFIRM_ID} button { cursor: pointer !important; }
        #${BOOST_ZAP_OUTLINE_ID} {
            position: fixed;
            pointer-events: none;
            border: 2px solid #ff3b30;
            background: rgba(255, 59, 48, 0.12);
            border-radius: 2px;
            z-index: 2147483646;
            transition: all 60ms ease;
        }
        #${BOOST_ZAP_OUTLINE_ID}.is-pending {
            border-color: #ff9500;
            background: rgba(255, 149, 0, 0.16);
        }
        #${BOOST_ZAP_OUTLINE_ID}::after {
            content: attr(data-label);
            position: absolute;
            top: -22px;
            left: 0;
            background-color: #ff3b30;
            color: #fff;
            font: 600 10px/1 -apple-system, sans-serif;
            padding: 3px 6px;
            border-radius: 4px;
            white-space: nowrap;
            max-width: 320px;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        #${BOOST_ZAP_OUTLINE_ID}.is-pending::after { background-color: #ff9500; }
        .${BOOST_ZAP_BANNER_CLASS} {
            position: fixed;
            top: 12px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.85);
            color: #fff;
            font: 500 12px/1 -apple-system, sans-serif;
            padding: 8px 14px;
            border-radius: 999px;
            z-index: 2147483647;
            pointer-events: none;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        }
        #${BOOST_ZAP_CONFIRM_ID} {
            position: fixed;
            z-index: 2147483647;
            background: #fff;
            color: #000;
            border-radius: 12px;
            box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
            padding: 12px;
            font: 500 12px/1.3 -apple-system, sans-serif;
            width: 260px;
            cursor: default;
        }
        @media (prefers-color-scheme: dark) {
            #${BOOST_ZAP_CONFIRM_ID} { background: #2a2a2a; color: #fff; }
        }
        #${BOOST_ZAP_CONFIRM_ID} .boost-zap-confirm-title { font-weight: 600; margin-bottom: 6px; }
        #${BOOST_ZAP_CONFIRM_ID} .boost-zap-confirm-sel {
            font-family: ui-monospace, "SF Mono", Menlo, monospace;
            font-size: 11px;
            color: rgba(0, 0, 0, 0.55);
            padding: 6px 8px;
            background: rgba(0, 0, 0, 0.06);
            border-radius: 6px;
            margin-bottom: 10px;
            word-break: break-all;
            max-height: 60px;
            overflow: hidden;
        }
        @media (prefers-color-scheme: dark) {
            #${BOOST_ZAP_CONFIRM_ID} .boost-zap-confirm-sel {
                color: rgba(255, 255, 255, 0.6);
                background: rgba(255, 255, 255, 0.08);
            }
        }
        #${BOOST_ZAP_CONFIRM_ID} .boost-zap-confirm-actions { display: flex; gap: 6px; justify-content: flex-end; }
        #${BOOST_ZAP_CONFIRM_ID} button { font: 600 12px/1 -apple-system, sans-serif; padding: 7px 14px; border-radius: 8px; border: 0; cursor: pointer; }
        #${BOOST_ZAP_CONFIRM_ID} .boost-zap-cancel { background: rgba(0, 0, 0, 0.08); color: inherit; }
        @media (prefers-color-scheme: dark) {
            #${BOOST_ZAP_CONFIRM_ID} .boost-zap-cancel { background: rgba(255, 255, 255, 0.12); }
        }
        #${BOOST_ZAP_CONFIRM_ID} .boost-zap-hide { background: #ff3b30; color: #fff; }
        #${BOOST_ZAP_CONFIRM_ID} .boost-zap-pick { background: #007aff; color: #fff; }
    `;
    (document.head || document.documentElement).appendChild(s);
}

function ensureOutline() {
    let o = document.getElementById(BOOST_ZAP_OUTLINE_ID);
    if (o) return o;
    o = document.createElement("div");
    o.id = BOOST_ZAP_OUTLINE_ID;
    document.documentElement.appendChild(o);
    return o;
}

function positionOutline(el, pending = false) {
    const o = ensureOutline();
    const r = el.getBoundingClientRect();
    o.style.left = r.left + "px";
    o.style.top = r.top + "px";
    o.style.width = r.width + "px";
    o.style.height = r.height + "px";
    o.dataset.label = el.tagName.toLowerCase()
        + (el.id ? "#" + el.id : "")
        + (el.classList.length ? "." + Array.from(el.classList).slice(0, 2).join(".") : "");
    o.classList.toggle("is-pending", pending);
    o.style.display = "block";
}

function clearOutline() {
    const o = document.getElementById(BOOST_ZAP_OUTLINE_ID);
    if (o) o.style.display = "none";
}

function showBanner(text) {
    let b = document.querySelector(`.${BOOST_ZAP_BANNER_CLASS}`);
    if (!b) {
        b = document.createElement("div");
        b.className = BOOST_ZAP_BANNER_CLASS;
        document.documentElement.appendChild(b);
    }
    b.textContent = text;
}

function hideBanner() {
    document.querySelector(`.${BOOST_ZAP_BANNER_CLASS}`)?.remove();
}

function showConfirm(el, selector) {
    let panel = document.getElementById(BOOST_ZAP_CONFIRM_ID);
    if (!panel) {
        panel = document.createElement("div");
        panel.id = BOOST_ZAP_CONFIRM_ID;
        document.documentElement.appendChild(panel);
    }
    const isHide = zapMode === "hide";
    panel.innerHTML = `
        <div class="boost-zap-confirm-title">${isHide ? "Hide this element?" : "Use this selector?"}</div>
        <div class="boost-zap-confirm-sel"></div>
        <div class="boost-zap-confirm-actions">
            <button type="button" class="boost-zap-cancel">Cancel</button>
            <button type="button" class="${isHide ? "boost-zap-hide" : "boost-zap-pick"}">${isHide ? "Hide" : "Use"}</button>
        </div>
    `;
    panel.querySelector(".boost-zap-confirm-sel").textContent = selector;
    panel.querySelector(".boost-zap-cancel").addEventListener("click", (e) => {
        e.stopPropagation();
        cancelConfirmation();
    });
    panel.querySelector(isHide ? ".boost-zap-hide" : ".boost-zap-pick").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (isHide) await commitZap();
        else await commitPick();
    });

    const r = el.getBoundingClientRect();
    const W = 260, margin = 8;
    let left = Math.min(r.left, window.innerWidth - W - margin);
    left = Math.max(margin, left);
    let top = r.bottom + margin;
    if (top + 140 > window.innerHeight) {
        top = Math.max(margin, r.top - 140 - margin);
    }
    panel.style.left = left + "px";
    panel.style.top = top + "px";
}

function hideConfirm() {
    document.getElementById(BOOST_ZAP_CONFIRM_ID)?.remove();
}

function enterConfirmation(el) {
    zapState = "confirming";
    zapPendingEl = el;
    zapPendingSelector = computeSelector(el);
    positionOutline(el, true);
    showConfirm(el, zapPendingSelector);
    showBanner(zapMode === "hide"
        ? "Confirm to hide, or Cancel to keep choosing. Right-click to exit."
        : "Confirm to copy selector to your CSS. Right-click to exit.");
}

function cancelConfirmation() {
    zapState = "hover";
    zapPendingEl = null;
    zapPendingSelector = null;
    hideConfirm();
    clearOutline();
    showBanner(zapMode === "hide"
        ? "Zap mode — click an element to hide it. Right-click to exit."
        : "Pick mode — click an element to copy its selector. Right-click to exit.");
}

async function commitZap() {
    if (!zapPendingEl || !zapPendingSelector) return;
    const selector = zapPendingSelector;
    const boost = (await getBoost()) || { enabled: true, zapsEnabled: true, zapSelectors: [] };
    const list = Array.isArray(boost.zapSelectors) ? boost.zapSelectors : [];
    if (!list.includes(selector)) list.push(selector);
    boost.zapSelectors = list;
    if (boost.zapsEnabled === undefined) boost.zapsEnabled = true;
    boost.enabled = true;
    await saveBoost(boost);
    applyBoost(boost);
    showBanner(`Element hidden`);
    setTimeout(() => exitZapMode(), 700);
}

async function commitPick() {
    if (!zapPendingSelector) return;
    const selector = zapPendingSelector;
    const boost = (await getBoost()) || { enabled: true };
    const cur = boost.customCSS || "";
    const insertion = (cur && !cur.endsWith("\n") ? "\n" : "") + `${selector} {\n  \n}\n`;
    boost.customCSS = cur + insertion;
    if (boost.customEnabled === undefined) boost.customEnabled = true;
    boost.enabled = true;
    boost.pendingSelectorForCode = selector;
    await saveBoost(boost);
    applyBoost(boost);
    showBanner(`Selector added to Custom CSS`);
    setTimeout(() => exitZapMode(), 900);
}

function onZapMove(e) {
    if (zapState !== "hover") return;
    const el = e.target;
    if (!el || el === zapHovered) return;
    if (isZapChrome(el)) return;
    zapHovered = el;
    positionOutline(el, false);
}

function onZapClick(e) {
    if (isZapChrome(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (zapState !== "hover") return;
    const el = e.target;
    if (!el || el === document.body || el === document.documentElement) return;
    enterConfirmation(el);
}

function onZapContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    exitZapMode();
}

function enterZapMode(mode = "hide") {
    if (zapActive) return;
    zapActive = true;
    zapMode = mode;
    zapState = "hover";
    ensureZapStyle();
    document.documentElement.classList.add("boost-zap-mode");
    document.addEventListener("mousemove", onZapMove, true);
    document.addEventListener("click", onZapClick, true);
    document.addEventListener("contextmenu", onZapContextMenu, true);
    showBanner(mode === "hide"
        ? "Zap mode — click an element to hide it. Right-click to exit."
        : "Pick mode — click an element to copy its selector. Right-click to exit.");
}

function exitZapMode() {
    if (!zapActive) return;
    zapActive = false;
    zapState = "idle";
    zapHovered = null;
    zapPendingEl = null;
    zapPendingSelector = null;
    document.documentElement.classList.remove("boost-zap-mode");
    document.removeEventListener("mousemove", onZapMove, true);
    document.removeEventListener("click", onZapClick, true);
    document.removeEventListener("contextmenu", onZapContextMenu, true);
    clearOutline();
    hideBanner();
    hideConfirm();
}

})();
}
