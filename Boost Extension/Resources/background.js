/* Background page — shows a badge on the toolbar icon when the boost
   is active for the current tab. */

const ACTIVE_BADGE = "✓";       // checkmark
const ACTIVE_BG = "#007AFF";    // system blue
const ACTIVE_FG = "#FFFFFF";    // white text on the badge

const lastBadgeByTab = new Map();

function hostFromUrl(url) {
    try { return new URL(url).hostname || null; } catch { return null; }
}

async function isBoostActiveForHost(host) {
    if (!host) return false;
    const stored = await browser.storage.local.get(host);
    const b = stored[host];
    return !!(b && b.enabled === true);
}

async function refreshBadgeForTab(tab) {
    if (!tab || !tab.id) return;
    const host = hostFromUrl(tab.url);
    const active = await isBoostActiveForHost(host);
    const text = active ? ACTIVE_BADGE : "";

    // Dedupe: don't rewrite the same value.
    if (lastBadgeByTab.get(tab.id) === text) return;
    lastBadgeByTab.set(tab.id, text);

    console.log("[Boost] badge", { tabId: tab.id, host, active });
    try {
        await browser.action.setBadgeText({ tabId: tab.id, text });
        if (active) {
            await browser.action.setBadgeBackgroundColor({ tabId: tab.id, color: ACTIVE_BG });
            if (browser.action.setBadgeTextColor) {
                await browser.action.setBadgeTextColor({ tabId: tab.id, color: ACTIVE_FG });
            }
        }
    } catch (e) {
        console.log("[Boost] badge set failed:", e?.message);
    }
}

async function refreshAllTabs() {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
        refreshBadgeForTab(tab);
    }
}

/* Tab events */
browser.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
        const tab = await browser.tabs.get(tabId);
        refreshBadgeForTab(tab);
    } catch (e) {
        /* tab may have closed */
    }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === "complete") {
        refreshBadgeForTab(tab);
    }
});

browser.tabs.onRemoved.addListener((tabId) => {
    lastBadgeByTab.delete(tabId);
});

/* Storage events: refresh tabs whose host had a boost change. */
browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    const changedHosts = Object.keys(changes);
    if (!changedHosts.length) return;
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
        const host = hostFromUrl(tab.url);
        if (host && changedHosts.includes(host)) {
            refreshBadgeForTab(tab);
        }
    }
});

/* Direct request from popup (instant feedback on toggle change). */
browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === "boost-icon-refresh") {
        if (sender.tab) {
            refreshBadgeForTab(sender.tab);
        } else {
            browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
                if (tabs[0]) refreshBadgeForTab(tabs[0]);
            });
        }
    }
});

/* Initial pass on extension load. */
refreshAllTabs();
