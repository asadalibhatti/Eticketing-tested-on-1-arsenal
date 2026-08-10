// background.js
let EVENT_NOT_ALLOWED_URL; //= "https://www.eticketing.co.uk/arsenal/EDP/Validation/EventNotAllowed?eventId=4&reason=EventArchived";
let EVENT_URL = "";

let eventTabId = null;
let notAllowedTabId = null;
let openOrFocusTabsInProgress = false; // prevents 2-min check from creating a second event tab while heartbeat reload runs
/** Serializes all event-tab create/reload operations (one chain, no parallel opens). */
let eventTabOpChain = Promise.resolve();
let error403ResumeTimerId = null;
/** In-memory mirror of storage `error403PauseUntil`; heartbeat / event-tab ops skip while Date.now() < this. */
let error403PauseUntil = 0;
const HD_QUEUE_RECOVERY_SHORT_WAIT_MS = 10 * 1000;
const HD_QUEUE_RECOVERY_LONG_WAIT_MS = 60 * 1000;
const HD_QUEUE_ERROR403_RECOVERY_STEP_KEY = 'hdQueueError403RecoveryStep'; // 0:club home, 1:eventUrl, 2:softblock (then repeat)
const HD_QUEUE_ERROR403_RECOVERY_CYCLE_INDEX_KEY = 'hdQueueError403RecoveryCycleIndex'; // completed 3-step cycles since last reset
const HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY = 'hdQueueBotDetectCaptchaCount'; // BotDetect hits during URL recovery; >=3 → 2captcha
const HD_QUEUE_ERROR403_RECOVERY_ALARM = 'hdQueueError403RecoveryAlarm';
const HD_QUEUE_ERROR403_RECOVERY_TARGET_URL_KEY = 'hdQueueError403RecoveryTargetUrl';
const HD_QUEUE_ERROR403_RECOVERY_TAB_ID_KEY = 'hdQueueError403RecoveryTabId';
const HD_QUEUE_ERROR403_RECOVERY_OFF_RECHECK_MS = 15 * 1000;
/** Set true by event Index page when verification token is ready; gates validation-tab create/reload. */
const EVENT_PAGE_READY_KEY = 'eventPageReady';
/** Max wait after event ensure/reload before giving up on opening validation tab. */
const EVENT_PAGE_READY_WAIT_MS = 3 * 60 * 1000;
const EVENT_PAGE_READY_POLL_MS = 2000;

/** HD queue tab reload storm: recover after N reloads. */
const HD_QUEUE_RELOAD_MAX_COUNT = 7; // cumulative reloads (after first entry) → Arsenal Red membership
const HD_QUEUE_RELOAD_RECOVERY_COOLDOWN_MS = 5 * 1000;
const HD_QUEUE_MEMBERSHIP_RECOVERY_URL = 'https://www.arsenal.com/membership/red';
const HD_QUEUE_MEMBERSHIP_RECOVERY_ACTIVE_KEY = 'hdQueueMembershipRecoveryActive';
/** tabId -> { reloadCount } */
const hdQueueReloadStateByTab = new Map();
let hdQueueReloadRecoveryInProgress = false;

/** Post-success placeholder tab (see content.js `openNewTab`); close all such tabs left on this URL ≥12 min. */
const BASKET_PLACEHOLDER_TAB_URL_PREFIX = 'https://www.exampleticketsbasketaddedinthiswindow.com';
const BASKET_PLACEHOLDER_MAX_MS = 12 * 60 * 1000;
const basketPlaceholderTabOpenedAt = new Map(); // tabId -> ms when URL first matched

function tabMatchesBasketPlaceholderUrl(url) {
    if (!url) return false;
    return url.toLowerCase().startsWith(BASKET_PLACEHOLDER_TAB_URL_PREFIX);
}

console.log('[BG] Background loaded');
/** Default Discord webhook for generic `notifyErrorWebhooks` (lock failures, etc.). */
const DEFAULT_ERROR_DISCORD_WEBHOOK =
    'https://discordapp.com/api/webhooks/1139641609240182884/umQxYbgmj_WMAe33xIFLYtkMbJJrjSk-zbZJeC_sP4__eJlEJsnQ9JL4qj2cNuPFPLWz';
/** Dedicated Discord webhook for seat-check 3×403 → clear cookies + refresh notification only. */
const SEAT_CHECK_COOKIE_CLEAR_DISCORD_WEBHOOK =
    'https://discord.com/api/webhooks/1504048209688006766/4z5MkOPfzb2UV-mEyW9wtQrUNanxWUgvPXYAP3JjrDW9Ir5O6rDI-oZJzPq41YXae5y2';
/** Public Google Sheet — A1 holds the 2Captcha API key (gid=0). */
const TWO_CAPTCHA_KEY_SHEET_ID = '1eO-ppfVSs4DyHZpvqCypjxycqAlozPuhPTyX-b985gs';
const TWO_CAPTCHA_KEY_SHEET_GID = '0';

let lastStatus = null;
let pollIntervalId = null;
let sheetUrl = "https://docs.google.com/spreadsheets/d/1uiHk8KEp-Yc5tj8l6RnY2dEGZwsG2aMPhqiO5IP5mq0/edit?usp=sharing";

// Queue waiting: flag is set only by content script messages. Cleared if no setQueueWaiting message in last 7s.
let lastSetQueueWaitingAt = 0;
const QUEUE_WAITING_TIMEOUT_MS = 7000;
const QUEUE_WAITING_CHECK_INTERVAL_MS = 3000;
/** Upper bound for error403 backoff: 5 + 3·n minutes (n = prior count before this detection), capped at this value. */
const ERROR403_MAX_WAIT_MINUTES = 30;

/** Default % Resale endpoint chance when sheet column is missing (same as historical ~96% resale behaviour). */
const DEFAULT_RESALE_ENDPOINT_CHANCES = 96;

/** Sheet "Focus Refresh tab?" → if false, reload event tab in background without focusing window. Empty / yes / anything except no → true. */
function focusRefreshTabFromSheetCell(v) {
    if (v == null || String(v).trim() === '') return true;
    const s = String(v).trim().toLowerCase();
    if (s === 'no' || s === 'false' || s === '0') return false;
    return true;
}

/** GViz header-normalized map keys (see fetchSheetConfigAll). */
function focusRefreshTabFromSheetMap(map) {
    const raw = map['focusrefreshtab?'] ?? map['focusrefreshtab'] ?? map['focusrefresh'];
    return focusRefreshTabFromSheetCell(raw);
}

/** Sheet header normalized to `paircheckchance` (see fetchSheetConfigAll). Empty → null. */
function parsePairCheckChanceFromSheetMap(map) {
    const raw = map['paircheckchance'];
    if (raw === '' || raw == null || String(raw).trim() === '') return null;
    const v = parseFloat(String(raw).replace(/%/g, '').trim());
    if (!Number.isFinite(v)) return null;
    return Math.min(100, Math.max(0, v));
}

/** null → use areSeatsTogether + quantity from sheet; else roll pair (true, 2) vs single (false, 1). */
function seatModeFromPairChance(areSeatsTogetherBool, quantityVal, pairChancePct) {
    if (pairChancePct == null) {
        return {
            areSeatsTogether: !!areSeatsTogetherBool,
            quantity: parseInt(quantityVal, 10) || 1
        };
    }
    if (Math.random() * 100 < pairChancePct) {
        return { areSeatsTogether: true, quantity: 2 };
    }
    return { areSeatsTogether: false, quantity: 1 };
}

function clubNameFromEventUrl(url) {
    try {
        const parts = (url || '').split('/');
        return parts[3] || '';
    } catch (_) {
        return '';
    }
}

/**
 * Push a matching sheet row into chrome.storage.local.
 * @param {object} row - row from fetchSheetConfigAll
 * @param {{ openingTabs: boolean }} opts - if true, apply pair-chance roll (auto-start); if false and pair chance is set, skip seats (content script owns rolls)
 */
async function syncSheetRowToStorage(row, opts) {
    const openingTabs = opts && opts.openingTabs === true;
    let seatInit = null;
    if (openingTabs) {
        seatInit = seatModeFromPairChance(row.areSeatsTogether, row.quantity, row.pairCheckChance);
    } else if (row.pairCheckChance == null) {
        seatInit = seatModeFromPairChance(row.areSeatsTogether, row.quantity, null);
    }
    const payload = {
        currentStatus: 'on',
        eventUrl: row.eventUrl,
        startSecond: row.startSecond,
        discordWebhook: (row.discordWebhook || '').trim(),
        telegramWebhook: (row.telegramWebhook || '').trim(),
        telegramChatId: row.telegramChatId != null && String(row.telegramChatId).trim() !== '' ? String(row.telegramChatId).trim() : '',
        eventId: row.eventId,
        maximumPrice: row.maximumPrice,
        minimumPrice: row.minimumPrice,
        loginEmail: row.loginEmail,
        loginPassword: row.loginPassword,
        ignoreClubLevel: row.ignoreClubLevel,
        ignoreUpperTier: row.ignoreUpperTier,
        resaleEndpointChances: row.resaleEndpointChances != null ? row.resaleEndpointChances : DEFAULT_RESALE_ENDPOINT_CHANCES,
        focusRefreshTab: row.focusRefreshTab !== undefined ? row.focusRefreshTab : true
    };
    if (seatInit) {
        payload.areSeatsTogether = seatInit.areSeatsTogether;
        payload.quantity = seatInit.quantity;
    }
    await chrome.storage.local.set(payload);
}

// On extension/background start, clear stale session flags so reload never inherits a previous stop/pause.
lastSetQueueWaitingAt = 0;

/** Clear event-page ready + one-shot reload flags so validation tab cannot open on a stale signal. */
async function resetEventPageReadyFlag(reason) {
    await chrome.storage.local.set({
        [EVENT_PAGE_READY_KEY]: false,
        eventTabReloaded: false
    });
    console.log('[BG] eventPageReady + eventTabReloaded reset to false:', reason || '(no reason)');
}

async function isEventPageReady() {
    const st = await chrome.storage.local.get([EVENT_PAGE_READY_KEY]);
    return st[EVENT_PAGE_READY_KEY] === true;
}

/**
 * Wait until event Index sets eventPageReady (verification token).
 * Aborts early if Queue-IT is active or error403 pause starts — do not open validation in those cases.
 */
async function waitForEventPageReady(opts = {}) {
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : EVENT_PAGE_READY_WAIT_MS;
    const pollMs = opts.pollMs != null ? opts.pollMs : EVENT_PAGE_READY_POLL_MS;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (await isQueueItActive()) {
            console.log('[BG] waitForEventPageReady aborted — Queue-IT active (no validation tab)');
            return false;
        }
        if (Date.now() < error403PauseUntil) {
            console.log('[BG] waitForEventPageReady aborted — error403 pause active');
            return false;
        }
        if (await isEventPageReady()) {
            console.log(
                '[BG] eventPageReady=true after ' + Math.round((Date.now() - started) / 1000) + 's'
            );
            return true;
        }
        await new Promise((r) => setTimeout(r, pollMs));
    }
    console.warn('[BG] waitForEventPageReady timed out after ' + Math.round(timeoutMs / 1000) + 's');
    return false;
}

/**
 * Create or optionally reload validation tab only when event page is ready and Queue-IT is not active.
 * Prevents a second queue from validation opening while the event tab is mid-queue.
 */
async function openOrReloadValidationTab(validationUrl, opts = {}) {
    const reloadIfExists = opts.reloadIfExists === true;
    if (!validationUrl) return { success: false, reason: 'no url' };
    if (Date.now() < error403PauseUntil) {
        console.log('[BG] openOrReloadValidationTab skipped — error403 pause');
        return { success: false, reason: 'error403' };
    }
    if (await isQueueItActive()) {
        console.log('[BG] openOrReloadValidationTab skipped — Queue-IT active');
        return { success: false, reason: 'queue' };
    }
    if (!(await isEventPageReady())) {
        console.log('[BG] openOrReloadValidationTab skipped — eventPageReady not set');
        return { success: false, reason: 'event not ready' };
    }
    try {
        const allTabs = await chrome.tabs.query({});
        const found = allTabs.find((t) => {
            const u = t.url || '';
            const pen = t.pendingUrl || '';
            return tabUrlIsValidationArchivedTab(u) || tabUrlIsValidationArchivedTab(pen);
        });
        if (found) {
            notAllowedTabId = found.id;
            if (reloadIfExists) {
                console.log('[BG] Validation tab exists — reloading (event page ready)', found.id);
                await chrome.tabs.reload(found.id);
            } else {
                console.log('[BG] Validation tab already present — leave as-is', found.id);
            }
            return { success: true, tabId: found.id, created: false };
        }
        const created = await chrome.tabs.create({ url: validationUrl, active: false });
        notAllowedTabId = created.id;
        console.log('[BG] Created validation tab (event page ready)', created.id);
        return { success: true, tabId: created.id, created: true };
    } catch (e) {
        console.warn('[BG] openOrReloadValidationTab failed:', e && e.message);
        return { success: false, reason: e && e.message };
    }
}

/** Clear 403 pause timer, counts, and storage so reload / sheet-on never inherits stale queue-403 state. */
async function resetError403State(reason) {
    if (error403ResumeTimerId != null) {
        clearTimeout(error403ResumeTimerId);
        error403ResumeTimerId = null;
    }
    error403PauseUntil = 0;
    await chrome.storage.local.set({
        error403PauseUntil: 0,
        error403Count: 0,
        [HD_QUEUE_ERROR403_RECOVERY_STEP_KEY]: 0,
        [HD_QUEUE_ERROR403_RECOVERY_CYCLE_INDEX_KEY]: 0,
        [HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]: 0
    });
    console.log('[BG] error403 state reset:', reason || '(no reason)');
}

/**
 * Clear queue-waiting + 403 state on every SW start.
 * Clear eventRestrictedStop only once per extension load (reload/install) — session storage
 * survives SW sleep/wake but is wiped when the extension is reloaded, so stop still sticks
 * until Reload / reinstall / Manual Start, without racing the first sheet poll.
 */
async function clearStaleFlagsOnBackgroundStart() {
    await chrome.storage.local.set({ inQueueWaiting: false });
    console.log('[BG] Queue waiting flag cleared on start');
    await resetError403State('extension / background started');
    await resetEventPageReadyFlag('extension / background started');

    let alreadyClearedThisLoad = false;
    try {
        const sess = await chrome.storage.session.get('eventRestrictedStopResetThisLoad');
        alreadyClearedThisLoad = sess.eventRestrictedStopResetThisLoad === true;
    } catch (e) {
        console.warn('[BG] storage.session unavailable; clearing eventRestrictedStop anyway:', e?.message || e);
    }
    if (!alreadyClearedThisLoad) {
        await chrome.storage.local.set({ eventRestrictedStop: false, eventRestrictedTabId: null });
        try {
            await chrome.storage.session.set({ eventRestrictedStopResetThisLoad: true });
        } catch (_) {}
        console.log('[BG] eventRestrictedStop cleared (new extension load / reload)');
    }
    // Stale browsing-pause hold/cooldown must not block heartbeat after extension reload
    await chrome.storage.local.set({
        [BROWSING_PAUSE_SYSTEM_HOLD_KEY]: false,
        [BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]: 0,
        [BROWSING_PAUSE_COOLDOWN_TAB_KEY]: null,
        [BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY]: null
    });
    try {
        chrome.alarms.clear(BROWSING_PAUSE_COOLDOWN_ALARM);
    } catch (_) {}
}

function tabUrlsMentionHdQueueError403(url, pendingUrl) {
    const u = ((url || '') + ' ' + (pendingUrl || '')).toLowerCase();
    return u.includes('hd-queue.eticketing.co.uk') && u.includes('error403');
}

function hasOpenHdQueueError403TabInList(tabs) {
    return (tabs || []).some((t) => tabUrlsMentionHdQueueError403(t.url, t.pendingUrl));
}

async function closeHdQueueError403Tabs() {
    const tabs = await chrome.tabs.query({});
    const toClose = [];
    for (const t of tabs) {
        if (!tabUrlsMentionHdQueueError403(t.url, t.pendingUrl)) continue;
        if (t.id != null) toClose.push(t.id);
    }
    const { removed, skipped } = await safeTabsRemove(toClose);
    for (const id of removed) console.log('[BG] Closed hd-queue /error403 tab:', id);
    if (skipped.length) console.log('[BG] closeHdQueueError403Tabs: kept last tab in window:', skipped.join(','));
}

async function enforceSingleHdQueueError403Tab(preferTabId) {
    const tabs = await chrome.tabs.query({});
    const errorTabs = tabs.filter((t) => tabUrlsMentionHdQueueError403(t.url, t.pendingUrl));
    if (errorTabs.length <= 1) return;

    let keepId = null;
    if (preferTabId != null && errorTabs.some((t) => t.id === preferTabId)) {
        keepId = preferTabId;
    } else {
        keepId = errorTabs[0].id;
    }

    const dupIds = errorTabs.map((t) => t.id).filter((id) => id != null && id !== keepId);
    const { removed, skipped } = await safeTabsRemove(dupIds);
    for (const id of removed) console.log('[BG] Closed duplicate hd-queue /error403 tab:', id, '(kept', keepId + ')');
    if (skipped.length) console.log('[BG] enforceSingleHdQueueError403Tab: skipped closing last tab in window:', skipped.join(','));
}

async function findHdQueueError403TabId() {
    const tabs = await chrome.tabs.query({});
    const matches = [];
    for (const t of tabs) {
        if (tabUrlsMentionHdQueueError403(t.url, t.pendingUrl)) matches.push(t.id);
    }
    return matches.length ? matches[0] : null;
}

/**
 * Remove tab(s) unless that would remove the last tab in a window (keeps the window open).
 * @param {number|number[]} tabIdOrIds
 * @returns {Promise<{ removed: number[], skipped: number[] }>}
 */
async function safeTabsRemove(tabIdOrIds) {
    const raw = Array.isArray(tabIdOrIds) ? tabIdOrIds : [tabIdOrIds];
    const ids = [...new Set(raw.map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
    if (ids.length === 0) return { removed: [], skipped: [] };

    const allTabs = await chrome.tabs.query({});
    const tabsByWindow = new Map();
    for (const t of allTabs) {
        if (t.id == null || t.windowId == null) continue;
        if (!tabsByWindow.has(t.windowId)) tabsByWindow.set(t.windowId, []);
        tabsByWindow.get(t.windowId).push(t);
    }

    const removeSet = new Set(ids);
    const skipped = new Set();

    for (const [, windowTabs] of tabsByWindow) {
        const windowIds = windowTabs.map((t) => t.id).filter((id) => id != null);
        const slatedInWindow = windowIds.filter((tid) => removeSet.has(tid));
        if (slatedInWindow.length === 0) continue;
        if (slatedInWindow.length >= windowIds.length) {
            skipped.add(slatedInWindow[0]);
            console.warn('[BG] safeTabsRemove: skip tab', slatedInWindow[0], '— last tab in window; avoid closing window');
        }
    }

    const toRemove = ids.filter((id) => !skipped.has(id));
    const removed = [];
    for (const id of toRemove) {
        try {
            await chrome.tabs.remove(id);
            removed.push(id);
        } catch (e) {
            console.warn('[BG] safeTabsRemove: remove failed', id, e?.message || e);
        }
    }
    return { removed, skipped: [...skipped] };
}

async function isCurrentSheetStatusOn() {
    const { sheetUrl, startSecond } = await chrome.storage.local.get(['sheetUrl', 'startSecond']);
    const targetNum = Number.isNaN(parseFloat(startSecond)) ? -2 : parseFloat(startSecond);
    if (!sheetUrl) return false;
    try {
        const gvizUrl = getGvizUrl(sheetUrl);
        if (!gvizUrl) return false;
        const allCfg = await fetchSheetConfigAll(sheetUrl);
        const matchingRows = allCfg.filter(cfg =>
            ['on', 'start', 'true', '1'].includes((cfg.status || '').toString().trim().toLowerCase()) &&
            parseFloat(cfg.startSecond) === targetNum
        );
        return matchingRows.length > 0;
    } catch (e) {
        console.warn('[BG] isCurrentSheetStatusOn: sheet read failed:', e?.message || e);
        return false;
    }
}

function cookieDomainIsEticketing(domain) {
    const d = String(domain || '').toLowerCase().replace(/^\./, '');
    return d === 'eticketing.co.uk' || d.endsWith('.eticketing.co.uk');
}

/** Build the URL Chrome needs for cookies.remove (secure → https). */
function eticketingCookieRemoveUrl(cookie, forceScheme) {
    const domain = String(cookie.domain || '').replace(/^\./, '');
    const path = cookie.path || '/';
    const scheme = forceScheme || (cookie.secure ? 'https' : 'http');
    return `${scheme}://${domain}${path}`;
}

function removeOneEticketingCookie(cookie) {
    return new Promise((resolve) => {
        const base = {
            url: eticketingCookieRemoveUrl(cookie),
            name: cookie.name
        };
        if (cookie.storeId) base.storeId = cookie.storeId;
        if (cookie.partitionKey) base.partitionKey = cookie.partitionKey;

        const tryRemove = (details, isRetry) => {
            chrome.cookies.remove(details, (result) => {
                if (chrome.runtime.lastError || !result) {
                    if (!isRetry) {
                        // Retry opposite scheme (some cookies accept either).
                        const altScheme = details.url.startsWith('https:') ? 'http' : 'https';
                        tryRemove({ ...details, url: eticketingCookieRemoveUrl(cookie, altScheme) }, true);
                        return;
                    }
                    console.warn(
                        '[BG] cookie remove failed:',
                        cookie.name,
                        cookie.domain,
                        chrome.runtime.lastError && chrome.runtime.lastError.message
                    );
                    resolve(false);
                    return;
                }
                resolve(true);
            });
        };
        tryRemove(base, false);
    });
}

/**
 * Clear every cookie for eticketing.co.uk and all subdomains (hd-queue, www, etc.),
 * across cookie stores, including httpOnly / secure / session / partitioned.
 */
function clearEticketingCookiesOnly(done) {
    const finish = (removed, total) => {
        console.log('[BG] Cleared', removed, '/', total, 'eticketing.co.uk cookie(s)');
        if (typeof done === 'function') done();
    };

    chrome.cookies.getAllCookieStores((stores) => {
        const storeList = stores && stores.length ? stores : [{ id: undefined }];
        const getPromises = storeList.map((store) => {
            return new Promise((resolve) => {
                const query = { domain: 'eticketing.co.uk' };
                if (store.id) query.storeId = store.id;
                chrome.cookies.getAll(query, (cookies) => {
                    if (chrome.runtime.lastError) {
                        console.warn('[BG] cookies.getAll failed:', chrome.runtime.lastError.message);
                        resolve([]);
                        return;
                    }
                    resolve(cookies || []);
                });
            });
        });

        Promise.all(getPromises)
            .then(async (lists) => {
                const seen = new Set();
                const targets = [];
                for (const list of lists) {
                    for (const cookie of list) {
                        if (!cookieDomainIsEticketing(cookie.domain)) continue;
                        const key = [
                            cookie.storeId || '',
                            cookie.domain || '',
                            cookie.path || '',
                            cookie.name || '',
                            cookie.partitionKey ? JSON.stringify(cookie.partitionKey) : ''
                        ].join('\0');
                        if (seen.has(key)) continue;
                        seen.add(key);
                        targets.push(cookie);
                    }
                }
                if (targets.length === 0) {
                    finish(0, 0);
                    return;
                }
                const results = await Promise.all(targets.map(removeOneEticketingCookie));
                finish(results.filter(Boolean).length, targets.length);
            })
            .catch((e) => {
                console.warn('[BG] clearEticketingCookiesOnly error:', e?.message || e);
                if (typeof done === 'function') done();
            });
    });
}

function resetHdQueueReloadCounters(reason) {
    hdQueueReloadStateByTab.clear();
    console.log('[BG] HD queue reload counter reset to 0:', reason || '(no reason)');
}

/** True for hd-queue pages we monitor for reload storms (excludes /error403 — own recovery path). */
function urlIsHdQueueReloadMonitored(url) {
    if (!url) return false;
    const lower = String(url).toLowerCase();
    if (!lower.includes('hd-queue.eticketing.co.uk')) return false;
    if (lower.includes('error403')) return false;
    return true;
}

/**
 * Count HD queue tab loads/reloads. Triggers recovery after 7 reloads following the initial queue entry.
 */
function noteHdQueueTabLoading(tabId, url) {
    if (tabId == null) return;
    if (!urlIsHdQueueReloadMonitored(url)) {
        if (hdQueueReloadStateByTab.has(tabId) && url && !String(url).toLowerCase().includes('hd-queue.eticketing.co.uk')) {
            hdQueueReloadStateByTab.delete(tabId);
        }
        return;
    }
    if (hdQueueReloadRecoveryInProgress) return;

    let state = hdQueueReloadStateByTab.get(tabId);
    if (!state) {
        hdQueueReloadStateByTab.set(tabId, { reloadCount: 0 });
        console.log('[BG] HD queue tab first load tracked (reload count 0):', tabId);
        return;
    }

    const reloadCount = state.reloadCount + 1;
    hdQueueReloadStateByTab.set(tabId, { reloadCount });

    console.log('[BG] HD queue reload #' + reloadCount + ' tab ' + tabId);

    if (reloadCount >= HD_QUEUE_RELOAD_MAX_COUNT) {
        recoverFromHdQueueReloadStorm(tabId, 'reloaded ' + reloadCount + ' times').catch((e) =>
            console.warn('[BG] recoverFromHdQueueReloadStorm error:', e?.message || e));
    }
}

function tabUrlIsArsenalMembershipRed(url) {
    if (!url) return false;
    const u = String(url).toLowerCase();
    return u.includes('www.arsenal.com') && u.includes('/membership/red');
}

function tabUrlIsArsenalMembershipsList(url) {
    if (!url) return false;
    return String(url).toLowerCase().includes('/arsenal/memberships/list');
}

/**
 * Open / resume the event flow via Arsenal Red membership:
 * membership/red → JOIN NOW → Memberships/List → content.js navigates to stored eventUrl.
 * @param {{ focus?: boolean, reuseTabId?: number|null }} opts
 */
async function openEventUrlViaArsenalMembershipRed(opts) {
    const wantFocus = !(opts && opts.focus === false);
    const reuseTabId = opts && opts.reuseTabId != null ? opts.reuseTabId : null;

    await resetEventPageReadyFlag('opening event via Arsenal Red membership');
    await chrome.storage.local.set({ [HD_QUEUE_MEMBERSHIP_RECOVERY_ACTIVE_KEY]: true });

    const all = await chrome.tabs.query({});
    const existingRed = all.find(
        (t) => tabUrlIsArsenalMembershipRed(t.url) || tabUrlIsArsenalMembershipRed(t.pendingUrl)
    );
    if (existingRed && existingRed.id != null) {
        if (wantFocus) await focusTabWindow(existingRed.id);
        console.log('[BG] Event open via membership: existing Red membership tab', existingRed.id);
        return { success: true, action: 'membership-red-existing', tabId: existingRed.id };
    }

    const existingList = all.find(
        (t) => tabUrlIsArsenalMembershipsList(t.url) || tabUrlIsArsenalMembershipsList(t.pendingUrl)
    );
    if (existingList && existingList.id != null) {
        if (wantFocus) await focusTabWindow(existingList.id);
        console.log(
            '[BG] Event open via membership: Memberships/List already open (will redirect to eventUrl)',
            existingList.id
        );
        return { success: true, action: 'memberships-list-existing', tabId: existingList.id };
    }

    const membershipUrl = HD_QUEUE_MEMBERSHIP_RECOVERY_URL;
    if (reuseTabId != null) {
        try {
            await chrome.tabs.update(reuseTabId, { url: membershipUrl, active: wantFocus });
            if (wantFocus) await focusTabWindow(reuseTabId);
            console.log('[BG] Event open via membership: navigated tab', reuseTabId, '→', membershipUrl);
            return { success: true, action: 'membership-red-navigated', tabId: reuseTabId };
        } catch (e) {
            console.warn('[BG] Event open via membership: navigate failed, creating new tab:', e?.message || e);
        }
    }

    const created = await chrome.tabs.create({ url: membershipUrl, active: wantFocus });
    if (created && created.id != null && wantFocus) await focusTabWindow(created.id);
    console.log('[BG] Event open via membership: opened Red membership', created && created.id, membershipUrl);
    return { success: true, action: 'membership-red-created', tabId: created && created.id };
}

/**
 * Close queue tab → open Arsenal Red membership page (JOIN NOW → Memberships/List → event / queue).
 * Cookie clear on queue-reload storm remains disabled.
 */
async function recoverFromHdQueueReloadStorm(tabId, reason) {
    if (hdQueueReloadRecoveryInProgress) return;
    hdQueueReloadRecoveryInProgress = true;
    console.log('[BG] HD queue reload storm recovery:', reason, 'tab', tabId);
    try {
        resetHdQueueReloadCounters('before storm recovery');
        lastSetQueueWaitingAt = 0;
        await chrome.storage.local.set({ inQueueWaiting: false });

        const { removed, skipped } = await safeTabsRemove(tabId);
        if (removed.length) console.log('[BG] Closed HD queue tab after reload storm:', tabId);
        if (skipped.length) {
            console.warn('[BG] HD queue tab not closed (last tab in window) — will navigate it to membership');
        }

        const reuseTabId = skipped.length && !removed.length ? tabId : null;
        await openEventUrlViaArsenalMembershipRed({ focus: true, reuseTabId });

        console.log('[BG] Skipping eticketing cookie clear after queue reload storm (disabled)');
        resetHdQueueReloadCounters('after storm recovery (membership redirect)');
    } catch (e) {
        console.warn('[BG] recoverFromHdQueueReloadStorm failed:', e?.message || e);
    } finally {
        setTimeout(() => {
            hdQueueReloadRecoveryInProgress = false;
        }, HD_QUEUE_RELOAD_RECOVERY_COOLDOWN_MS);
    }
}

/**
 * When error403 pause timer ends: clear all cookies (same as content-triggered clear), close hd-queue /error403 tabs,
 * clear pause, then sheet-gated event tab ensure + validation resume.
 */
async function runError403TimerResume(contextLabel) {
    error403ResumeTimerId = null;
    const resumingAt = new Date();
    console.log('[BG] error403 timer resume:', contextLabel || '(no label)', resumingAt.toLocaleTimeString());
    await new Promise((resolve) => {
        clearEticketingCookiesOnly(() => setTimeout(resolve, 400));
    });
    await closeHdQueueError403Tabs();
    error403PauseUntil = 0;
    await chrome.storage.local.set({ error403PauseUntil: 0 });
    lastHeartbeat = null;
    isFirstHeartbeat = true;
    const { sheetUrl, startSecond, eventUrl } = await chrome.storage.local.get(['sheetUrl', 'startSecond', 'eventUrl']);
    const targetNum = Number.isNaN(parseFloat(startSecond)) ? -2 : parseFloat(startSecond);
    let sheetStatusOn = false;
    if (sheetUrl) {
        try {
            const gvizUrl = getGvizUrl(sheetUrl);
            if (gvizUrl) {
                const allCfg = await fetchSheetConfigAll(sheetUrl);
                const matchingRows = allCfg.filter(cfg =>
                    ['on', 'start', 'true', '1'].includes((cfg.status || '').toString().trim().toLowerCase()) &&
                    parseFloat(cfg.startSecond) === targetNum
                );
                sheetStatusOn = matchingRows.length > 0;
            }
        } catch (e) {
            console.warn('[BG] error403 resume: could not read sheet status', e.message);
        }
    }
    if (!sheetStatusOn) {
        console.log('[BG] error403 resume: sheet status is Off - not opening/reloading tabs.');
        await notifyValidationTabError403Resume();
        return;
    }
    if (!eventUrl) {
        console.warn('[BG] error403 resume: no eventUrl in storage, skipping refresh.');
        await notifyValidationTabError403Resume();
        return;
    }
    EVENT_URL = eventUrl;
    await chrome.storage.local.set({ inQueueWaiting: false });
    lastSetQueueWaitingAt = 0;
    console.log('[BG] error403 resume: sheet status On — ensure event tab exists (no reload; validation refresh will reload once).');
    await ensureEventTabFromBackground(eventUrl, { forceReload: false });
    await notifyValidationTabError403Resume();
    console.log('[BG] error403 resume done; heartbeat reset to initial 3-minute cycle.');
}

/** First CSV cell on the first non-empty row (handles UTF-8 BOM and quoted A1). */
function parseFirstCellFromCsvLine(line) {
    if (line == null) return '';
    const s0 = String(line).replace(/^\uFEFF/, '').trim();
    if (!s0) return '';
    if (s0.charAt(0) === '"') {
        let out = '';
        for (let i = 1; i < s0.length; i++) {
            const c = s0.charAt(i);
            if (c === '"') {
                if (s0.charAt(i + 1) === '"') {
                    out += '"';
                    i++;
                    continue;
                }
                return out.trim();
            }
            out += c;
        }
        return out.trim();
    }
    const comma = s0.indexOf(',');
    return (comma === -1 ? s0 : s0.slice(0, comma)).trim();
}

/** Fetch A1 from the public sheet CSV export (same pattern as [2captcha key sheet](https://docs.google.com/spreadsheets/d/1eO-ppfVSs4DyHZpvqCypjxycqAlozPuhPTyX-b985gs/edit?gid=0#gid=0)). */
async function fetchTwoCaptchaApiKeyFromPublicSheet() {
    const url =
        'https://docs.google.com/spreadsheets/d/' +
        TWO_CAPTCHA_KEY_SHEET_ID +
        '/export?format=csv&gid=' +
        TWO_CAPTCHA_KEY_SHEET_GID;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('2captcha key sheet HTTP ' + res.status);
    const text = await res.text();
    const firstNonEmpty = text.split(/\r?\n/).find((l) => String(l).trim() !== '') || '';
    const key = parseFirstCellFromCsvLine(firstNonEmpty);
    if (!key) throw new Error('2captcha key sheet A1 empty');
    return key;
}

/** Writes `twoCaptchaApiKey` to chrome.storage.local on success. */
async function syncTwoCaptchaKeyFromPublicSheet() {
    try {
        const key = await fetchTwoCaptchaApiKeyFromPublicSheet();
        await chrome.storage.local.set({ twoCaptchaApiKey: key });
        console.log('[BG] twoCaptchaApiKey synced from public sheet (length ' + key.length + ')');
        return key;
    } catch (e) {
        console.warn('[BG] twoCaptcha public sheet sync failed:', e?.message || e);
        return null;
    }
}

async function getTwoCaptchaApiKeyOrFetchFromSheet() {
    const { twoCaptchaApiKey } = await chrome.storage.local.get(['twoCaptchaApiKey']);
    let k = (twoCaptchaApiKey || '').trim();
    if (k) return k;
    const fromSheet = await syncTwoCaptchaKeyFromPublicSheet();
    return (fromSheet || '').trim();
}

async function checkQueueWaitingTimeout() {
    if (!lastSetQueueWaitingAt) return;
    if (Date.now() - lastSetQueueWaitingAt <= QUEUE_WAITING_TIMEOUT_MS) return;
    lastSetQueueWaitingAt = 0;
    await chrome.storage.local.set({ inQueueWaiting: false });
    console.log('[BG] No setQueueWaiting message in 7s - cleared inQueueWaiting');
}

setInterval(() => { checkQueueWaitingTimeout(); }, QUEUE_WAITING_CHECK_INTERVAL_MS);

// Alarms keep the service worker from going idle and drive sheet polling
const POLL_SHEET_ALARM = 'pollSheet';
const KEEP_ALIVE_ALARM = 'keepAlive';
/** Every 2 min: ensure validation tab exists + prune extra managed tabs (no proactive event-tab open). */
const CHECK_VALIDATION_TAB_ALARM = 'checkValidationTab';
/** After cookie-clear, if browsing pause persists: wait 10 min before resume. */
const BROWSING_PAUSE_COOLDOWN_ALARM = 'browsingPauseCooldown';
const BROWSING_PAUSE_COOLDOWN_UNTIL_KEY = 'browsingPauseCooldownUntil';
const BROWSING_PAUSE_COOLDOWN_TAB_KEY = 'browsingPauseCooldownTabId';
const BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY = 'browsingPauseCookiesClearedPendingTabId';
/** Global hold: freeze heartbeat / openOrFocusTabs / event refresh while browsing-pause recovery runs. */
const BROWSING_PAUSE_SYSTEM_HOLD_KEY = 'browsingPauseSystemHold';
let browsingPauseSystemHoldLogged = false;

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === POLL_SHEET_ALARM) {
        pollSheetAndControl()
            .then(() => scheduleNextPoll())
            .catch(e => {
                console.warn('[BG] pollSheetAndControl error, scheduling next poll:', e);
                scheduleNextPoll();
            });
    } else if (alarm.name === KEEP_ALIVE_ALARM) {
        checkQueueWaitingTimeout();
        sweepAndCloseStaleBasketPlaceholderTabs().catch((e) =>
            console.warn('[BG] sweep basket-placeholder tabs error:', e));
        enforceSingleHdQueueError403Tab().catch((e) =>
            console.warn('[BG] enforce single hd-queue /error403 tab error:', e));
    } else if (alarm.name === CHECK_VALIDATION_TAB_ALARM) {
        checkValidationTabAndPruneEticketingTabs()
            .catch(e => console.warn('[BG] checkValidationTabAndPruneEticketingTabs error:', e));
    } else if (alarm.name === BROWSING_PAUSE_COOLDOWN_ALARM) {
        finishPostCookieBrowsingPauseCooldown('alarm fired')
            .catch((e) => console.warn('[BG] browsingPauseCooldown alarm error:', e?.message || e));
    } else if (alarm.name === HD_QUEUE_ERROR403_RECOVERY_ALARM) {
        (async () => {
            const { [HD_QUEUE_ERROR403_RECOVERY_TARGET_URL_KEY]: targetUrl, [HD_QUEUE_ERROR403_RECOVERY_TAB_ID_KEY]: tabId } =
                await chrome.storage.local.get([HD_QUEUE_ERROR403_RECOVERY_TARGET_URL_KEY, HD_QUEUE_ERROR403_RECOVERY_TAB_ID_KEY]);
            if (!targetUrl || tabId == null) {
                console.warn('[BG] hd-queue recovery alarm missing targetUrl/tabId; no action');
                return;
            }
            error403PauseUntil = 0;
            await chrome.storage.local.set({ error403PauseUntil: 0 });

            const sheetOn = await isCurrentSheetStatusOn();
            if (!sheetOn) {
                console.log('[BG] hd-queue recovery timer completed, but Google Sheet status is Off — waiting to open recovery URL.');
                chrome.alarms.create(HD_QUEUE_ERROR403_RECOVERY_ALARM, { when: Date.now() + HD_QUEUE_ERROR403_RECOVERY_OFF_RECHECK_MS });
                return;
            }
            try {
                if (tabUrlIsArsenalMembershipRed(targetUrl)) {
                    await chrome.storage.local.set({ [HD_QUEUE_MEMBERSHIP_RECOVERY_ACTIVE_KEY]: true });
                }
                const created = await chrome.tabs.create({ url: targetUrl, active: tabUrlIsArsenalMembershipRed(targetUrl) });
                console.log('[BG] hd-queue recovery alarm opened new tab:', created.id, targetUrl);
                if (tabUrlIsArsenalMembershipRed(targetUrl) && created && created.id != null) {
                    await focusTabWindow(created.id);
                }
                try {
                    const { removed, skipped } = await safeTabsRemove(tabId);
                    if (removed.length) console.log('[BG] hd-queue recovery alarm closed old /error403 tab:', tabId);
                    if (skipped.length) {
                        console.warn('[BG] hd-queue recovery: did not close old tab (only tab in window); new tab:', created.id);
                    }
                } catch (closeErr) {
                    console.warn('[BG] hd-queue recovery alarm failed to close old tab:', tabId, closeErr?.message || closeErr);
                }
            } catch (e) {
                console.warn('[BG] hd-queue recovery alarm open-new-tab failed:', e?.message || e);
            } finally {
                await chrome.storage.local.set({
                    [HD_QUEUE_ERROR403_RECOVERY_TARGET_URL_KEY]: '',
                    [HD_QUEUE_ERROR403_RECOVERY_TAB_ID_KEY]: null
                });
            }
        })().catch((e) => console.warn('[BG] hd-queue recovery alarm handler error:', e?.message || e));
    }
});

/** Tab IDs → timeout id: close event tab N ms after verification token is saved (memory saver). */
const eventTabPostTokenCloseTimers = new Map();

function scheduleCloseEventTabAfterTokenSave(tabId, delayMs) {
    const existing = eventTabPostTokenCloseTimers.get(tabId);
    if (existing != null) clearTimeout(existing);
    const tid = setTimeout(async () => {
        eventTabPostTokenCloseTimers.delete(tabId);
        try {
            const tab = await chrome.tabs.get(tabId);
            const u = (tab && tab.url) || '';
            if (tabUrlIsEventRestricted(u)) {
                console.log('[BG] Skipped closing event tab — landed on EventRestricted:', tabId);
                return;
            }
        } catch (_) {}
        safeTabsRemove(tabId)
            .then(({ removed, skipped }) => {
                if (removed.length) {
                    console.log('[BG] Closed event tab after token-save delay (memory saver):', tabId);
                    if (eventTabId === tabId) eventTabId = null;
                }
                if (skipped.length) {
                    console.warn('[BG] Skipped closing event tab after token delay — only tab in window:', tabId);
                }
            })
            .catch((e) => console.warn('[BG] safeTabsRemove after token delay failed:', tabId, e && e.message));
    }, delayMs);
    eventTabPostTokenCloseTimers.set(tabId, tid);
}

function cancelCloseEventTabAfterTokenSave(tabId) {
    const t = eventTabPostTokenCloseTimers.get(tabId);
    if (t != null) {
        clearTimeout(t);
        eventTabPostTokenCloseTimers.delete(tabId);
        console.log('[BG] Cancelled scheduled event tab close:', tabId);
    }
}

chrome.tabs.onRemoved.addListener((tabId) => {
    basketPlaceholderTabOpenedAt.delete(tabId);
    hdQueueReloadStateByTab.delete(tabId);
    const t = eventTabPostTokenCloseTimers.get(tabId);
    if (t != null) {
        clearTimeout(t);
        eventTabPostTokenCloseTimers.delete(tabId);
    }
    if (tabId === eventTabId) eventTabId = null;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = tab.url || '';
    const navUrl = changeInfo.url || url || tab.pendingUrl || '';
    if (changeInfo.status === 'loading') {
        const trackUrl = changeInfo.url || tab.pendingUrl || tab.url || '';
        noteHdQueueTabLoading(tabId, trackUrl);
    }
    if (navUrl && tabUrlIsEventRestricted(navUrl)) {
        cancelCloseEventTabAfterTokenSave(tabId);
        applyEventRestrictedStopFromBackground('tab navigated to EventRestricted', tabId).catch((e) =>
            console.warn('[BG] applyEventRestrictedStopFromBackground (onUpdated) error:', e?.message || e));
    }
    if (!url) return;
    if (tabMatchesBasketPlaceholderUrl(url)) {
        if (!basketPlaceholderTabOpenedAt.has(tabId)) {
            basketPlaceholderTabOpenedAt.set(tabId, Date.now());
        }
    } else {
        basketPlaceholderTabOpenedAt.delete(tabId);
    }
    if (tabUrlsMentionHdQueueError403(url, tab.pendingUrl || '')) {
        enforceSingleHdQueueError403Tab(tabId).catch((e) =>
            console.warn('[BG] onUpdated enforce single hd-queue /error403 tab error:', e));
    }
});

// Start polling Google Sheet (uses alarms so background stays active)
function startPolling() {
    ensurePolling();
}

// Stop polling Google Sheet
function stopPolling() {
    chrome.alarms.clear(POLL_SHEET_ALARM);
    chrome.alarms.clear(KEEP_ALIVE_ALARM);
    chrome.alarms.clear(CHECK_VALIDATION_TAB_ALARM);
        pollIntervalId = null;
        console.log('[BG] Polling stopped');
}

tabsOpenRecheckCount = 0;

function getGvizUrl(sheetUrl) {
    try {
        // Extract the sheet ID (the long string between /d/ and /edit)
        const idMatch = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
        if (!idMatch) throw new Error("Invalid Google Sheet URL");

        const sheetId = idMatch[1];

        // Extract gid (defaults to 0 if not found)
        const gidMatch = sheetUrl.match(/gid=([0-9]+)/);
        const gid = gidMatch ? gidMatch[1] : "0";

        // Return GViz JSON endpoint
        return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&gid=${gid}`;
    } catch (err) {
        console.error("getGvizUrl error:", err.message);
        return null;
    }
}

async function pollSheetAndControl() {
    try {
        if (await accountRestrictedBlackoutStopActive()) {
            console.log('[BG] pollSheetAndControl skipped — account restricted blackout stop');
            return;
        }
        if (await eventRestrictedStopActive()) {
            console.log('[BG] pollSheetAndControl skipped — event restricted stop');
            return;
        }
        const data = await chrome.storage.local.get(['sheetUrl', 'startSecond']);
        if (!data.sheetUrl) return;

        const targetStartSecond = parseFloat(data.startSecond);
        const targetNum = Number.isNaN(targetStartSecond) ? -2 : targetStartSecond;

        const gvizUrl = getGvizUrl(data.sheetUrl);
        if (!gvizUrl) return; // invalid URL, stop execution

        const allCfg = await fetchSheetConfigAll(gvizUrl);

        // Find rows that are ON and match startSecond (supports decimals, e.g. 2.5)
        const matchingRows = allCfg.filter(cfg =>
            ['on', 'start', 'true', '1'].includes((cfg.status || '').toString().trim().toLowerCase()) &&
            parseFloat(cfg.startSecond) === targetNum
        );

        const anyMatch = matchingRows.length > 0;
        const currentStatus = anyMatch ? 'on' : 'off';

        if (currentStatus !== lastStatus) {
            const previousStatus = lastStatus;
            console.log(`[BG] Status changed: ${lastStatus} -> ${currentStatus}`);
            lastStatus = currentStatus;

            if (anyMatch) {
                if (previousStatus !== 'on') {
                    await resetError403State('Google Sheet status turned on (was off or unset)');
                    await resetEventPageReadyFlag('Google Sheet status turned on (was off or unset)');
                }
                console.log('[BG] Auto-start triggered for matching rows');
                for (const row of matchingRows) {
                    console.log('[BG] Opening tabs for', row.eventUrl);
                    await syncSheetRowToStorage(row, { openingTabs: true });
                    EVENT_URL = row.eventUrl;
                    const clubName = clubNameFromEventUrl(EVENT_URL);
                    EVENT_NOT_ALLOWED_URL = `https://www.eticketing.co.uk/${clubName}/EDP/Validation/EventNotAllowed?eventId=4&reason=EventArchived`;
                    await openOrFocusTabs(EVENT_URL, EVENT_NOT_ALLOWED_URL);
                }
            } else {
                console.log('[BG] Auto-stop triggered');


                notifyTabStop();
            }
        } else if (anyMatch && matchingRows.length > 0) {
            // Status already "on": still push latest sheet row to storage so EventUrl / webhooks / credentials update without toggling status
            const row = matchingRows[0];
            await syncSheetRowToStorage(row, { openingTabs: false });
            const nu = (row.eventUrl || '').trim();
            if (nu && nu !== (EVENT_URL || '').trim()) {
                EVENT_URL = nu;
                const clubName = clubNameFromEventUrl(EVENT_URL);
                EVENT_NOT_ALLOWED_URL = `https://www.eticketing.co.uk/${clubName}/EDP/Validation/EventNotAllowed?eventId=4&reason=EventArchived`;
                console.log('[BG] Sheet poll: synced row to storage; eventUrl updated for background helpers');
            } else {
                console.log('[BG] Sheet poll: synced row to storage (eventUrl unchanged or empty)');
            }
        }
        // no need for below code as heart beat is already handling this
        // //else if current status is on, make sure the two tabs are open else re open them
        // else if (currentStatus === 'on') {
        //     if (tabsOpenRecheckCount >= 48) {// 48 * 5 seconds = 2 minutes
        //         tabsOpenRecheckCount = 0;
        //         console.log('[BG] on 4 minutes re check , Current status is ON, checking if tabs are open');
        //         //check if there are two tabs with EVENT_URL and EVENT_NOT_ALLOWED_URL

        //         //check if there are two tabs with EVENT_URL and EVENT_NOT_ALLOWED_URL
        //         const tabs = await chrome.tabs.query({url: '*://www.eticketing.co.uk/*'});
        //         const eventTabs = tabs.filter(t => t.url && t.url.startsWith(EVENT_URL));
        //         const notAllowedTabs = tabs.filter(t => t.url && t.url.startsWith(EVENT_NOT_ALLOWED_URL));
        //         if (eventTabs.length === 0) {
        //             console.log('[BG] No event tab found on 2 minutes recheck, opening new one');
        //             await openOrFocusTabs(EVENT_URL, undefined);
        //         } else {
        //             console.log('[BG] Event tab already open on 2 minutes recheck', eventTabs[0].id);
        //         }
        //         if (notAllowedTabs.length === 0) {
        //             console.log('[BG] No EventNotAllowed tab found on 2 minutes recheck, opening new one');
        //             await openOrFocusTabs(undefined, EVENT_NOT_ALLOWED_URL);
        //         } else {
        //             console.log('[BG] EventNotAllowed tab already open on 2 minutes recheck', notAllowedTabs[0].id);
        //         }
        //         // Close other eticketing tabs
        //         await closeOtherEticketingTabs();
        //         //wait for 5 seconds
        //         await new Promise(resolve => setTimeout(resolve, 60000));


        //     }
        //     tabsOpenRecheckCount++;
        // }
    } catch (e) {
        console.warn('[BG] pollSheetAndControl error:', e);
    }
}

// --- Auto Start Polling (alarm-based so background stays active) ---

function ensurePolling() {
    if (!pollIntervalId) {
        pollIntervalId = true; // mark polling active
        chrome.alarms.clear('checkEventTab'); // old alarm name (replaced by checkValidationTab)
        // Keep-alive alarm: fire every 1 minute so service worker doesn't go idle
        chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 1 });
        // Every 2 minutes: validation tab presence + prune managed tabs (event tab opened on demand only)
        chrome.alarms.create(CHECK_VALIDATION_TAB_ALARM, { periodInMinutes: 2 });
        scheduleNextPoll();
        pollSheetAndControl(); // run immediately
        console.log('[BG] ensurePolling: Polling started with alarms (sheet + keepAlive + checkValidationTab 2min)');
    } else {
        console.log('[BG] ensurePolling: Polling already running');
    }
}

function scheduleNextPoll() {
    // Random delay between 20-100 seconds (same as before)
    const minDelay = 20000;   // 20 seconds
    const maxDelay = 100000; // 100 seconds
    const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    
    const nextPollTime = new Date(Date.now() + randomDelay);
    const nextPollTimeString = nextPollTime.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    
    console.log(`[BG] Next poll re check sheet scheduled in ${Math.round(randomDelay / 1000)} seconds (at ${nextPollTimeString})`);
    
    chrome.alarms.create(POLL_SHEET_ALARM, { when: Date.now() + randomDelay });
}

// Run immediately when background script loads — clear stop flags first so first poll is not skipped
void (async () => {
    await clearStaleFlagsOnBackgroundStart();
    ensurePolling();
    void syncTwoCaptchaKeyFromPublicSheet();
})();

// Run when extension is installed, updated, or reloaded (chrome://extensions Reload)
chrome.runtime.onInstalled.addListener((details) => {
    console.log('[BG] onInstalled triggered:', details.reason);
    void (async () => {
        await clearStaleFlagsOnBackgroundStart();
        ensurePolling();
        void syncTwoCaptchaKeyFromPublicSheet();
    })();
});

// Run when Chrome starts and extension wakes up
chrome.runtime.onStartup.addListener(() => {
    console.log('[BG] onStartup triggered');
    void (async () => {
        await clearStaleFlagsOnBackgroundStart();
        ensurePolling();
        void syncTwoCaptchaKeyFromPublicSheet();
    })();
});

// Also re-start if extension is re-enabled after being disabled
chrome.management.onEnabled.addListener((ext) => {
    if (ext.id === chrome.runtime.id) {
        console.log('[BG] Extension re-enabled');
        void (async () => {
            await clearStaleFlagsOnBackgroundStart();
            ensurePolling();
            void syncTwoCaptchaKeyFromPublicSheet();
        })();
    }
});

function notifyTabStop() {
    //set the currentStatus to 'off' in local storage
    console.log('[BG] notifyTabStop called, notifying tabs to stop monitoring');
    chrome.storage.local.set({currentStatus: 'off'});

    // Notify the EventNotAllowed tab to stop monitoring
    if (notAllowedTabId) {
        chrome.tabs.sendMessage(notAllowedTabId, {action: 'stopMonitoring'}, resp => {
            if (chrome.runtime.lastError) {
                // Check if it's the specific async response error
                if (chrome.runtime.lastError.message.includes('message channel closed')) {
                    console.log('[BG] Content script received stop message but channel closed (normal behavior)');
                } else {
                    console.warn('[BG] stopMonitoring sendMessage error:', chrome.runtime.lastError.message);
                }
            } else {
                console.log('[BG] stop message sent to content script in tab', notAllowedTabId);
            }
        });
    }

}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'saveHdQueueSoftblockUrl') {
        const raw = (msg.url || '').trim();
        const ok = /^https?:\/\/hd-queue\.eticketing\.co\.uk\/softblock\/\?c/i.test(raw);
        if (!ok) {
            sendResponse({ success: false, message: 'not a softblock ?c url' });
            return false;
        }
        chrome.storage.local.set({ hdQueueSoftblockUrl: raw }, () => {
            if (chrome.runtime.lastError) {
                sendResponse({ success: false, message: chrome.runtime.lastError.message });
                return;
            }
            console.log('[BG] Saved hdQueueSoftblockUrl for recovery:', raw);
            sendResponse({ success: true });
        });
        return true;
    }
    if (msg.action === 'accountRestrictedBlackoutStop') {
        (async () => {
            const src =
                sender && sender.tab && sender.tab.id != null ? 'content-tab-' + sender.tab.id : 'content-script';
            await applyAccountRestrictedBlackoutStopFromBackground(src);
            sendResponse({ success: true });
        })().catch((e) => {
            console.warn('[BG] accountRestrictedBlackoutStop error:', e?.message || e);
            sendResponse({ success: false, message: e?.message || String(e) });
        });
        return true;
    }
    if (msg.action === 'eventRestrictedStop') {
        (async () => {
            const tabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;
            const src = tabId != null ? 'content-tab-' + tabId : 'content-script';
            await applyEventRestrictedStopFromBackground(src, tabId);
            sendResponse({ success: true });
        })().catch((e) => {
            console.warn('[BG] eventRestrictedStop error:', e?.message || e);
            sendResponse({ success: false, message: e?.message || String(e) });
        });
        return true;
    }
    if (msg.action === "clearCookiesAndRefresh") {
        // Only clear when content script (queue-it or eticketing page) sends the message, not popup
        if (!sender.tab) {
            console.log('[BG] clearCookiesAndRefresh ignored - request from popup, only content script can trigger clear');
            sendResponse({ success: false, message: 'Only content script can request clear cookies' });
            return false;
        }
        console.log('[BG] clearCookiesAndRefresh requested from content script', sender.tab.url);
        clearEticketingCookiesOnly(() => {
            sendResponse({ success: true, message: 'Cookies cleared successfully' });
        });
        return true; // keep channel open for async response
    }
    if (msg.action === 'browsingActivityPaused') {
        const tabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;
        if (tabId == null) {
            sendResponse({ success: false, message: 'no tab' });
            return false;
        }
        noteBrowsingActivityPausedTab(tabId, 'content-script');
        sendResponse({ success: true });
        return false;
    }
    if (msg.action === 'setQueueWaiting') {
        const waiting = msg.inQueueWaiting === true;
        chrome.storage.local.set({ inQueueWaiting: waiting });
        if (waiting) {
            lastSetQueueWaitingAt = Date.now();
            console.log('[BG] setQueueWaiting true (people ahead of you)');
        } else {
            lastSetQueueWaitingAt = 0;
            console.log('[BG] setQueueWaiting false');
        }
        sendResponse({ success: true });
        return false;
    }
    if (msg.action === 'clearCookiesAndReopenInSameTab') {
        if (!sender.tab) {
            sendResponse({ success: false, message: 'Only content script can request' });
            return false;
        }
        const tabId = sender.tab.id;
        console.log('[BG] clearCookiesAndReopenInSameTab from queue tab', tabId);
        clearEticketingCookiesOnly(async () => {
            console.log('[BG] clearCookiesAndReopenInSameTab — opening event via Arsenal Red membership');
            await openEventUrlViaArsenalMembershipRed({ focus: true, reuseTabId: tabId });
            sendResponse({ success: true });
        });
        return true;
    }
    if (msg.action === 'resetError403Count') {
        chrome.storage.local.set({
            error403Count: 0,
            [HD_QUEUE_ERROR403_RECOVERY_STEP_KEY]: 0,
            [HD_QUEUE_ERROR403_RECOVERY_CYCLE_INDEX_KEY]: 0,
            [HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]: 0
        });
        resetHdQueueReloadCounters('event URL loaded successfully');
        console.log(
            '[BG] error403Count + recovery step/cycle + BotDetect captcha count reset to 0 (event URL loaded)'
        );
        sendResponse({ success: true });
        return false;
    }
    if (msg.action === 'error403Detected') {
        const senderTabId = sender && sender.tab ? sender.tab.id : null;
        const tabUrl = (sender && sender.tab && sender.tab.url) || '';
        const fromHdQueue =
            msg.fromHdQueueError403 === true ||
            (tabUrl.includes('hd-queue.eticketing.co.uk') && tabUrl.toLowerCase().includes('error403'));
        const detectedAt = new Date();
        console.log('[BG] error403 detected at', detectedAt.toLocaleTimeString(), fromHdQueue ? '(hd-queue /error403)' : '(validation/seat path)');
        (async () => {
            if (error403ResumeTimerId != null) {
                clearTimeout(error403ResumeTimerId);
                error403ResumeTimerId = null;
                console.log('[BG] error403: cleared previous resume timer (single resume only)');
            }
            const snap = await chrome.storage.local.get([
                'error403Count',
                'hdQueueSoftblockUrl',
                HD_QUEUE_ERROR403_RECOVERY_STEP_KEY,
                HD_QUEUE_ERROR403_RECOVERY_CYCLE_INDEX_KEY,
                'eventUrl'
            ]);
            const prior = Number(snap.error403Count) || 0;
            await chrome.storage.local.set({ error403Count: prior + 1 });
            const softblockUrl = (snap.hdQueueSoftblockUrl || '').trim();
            const hasSavedSoftblock = /^https?:\/\/hd-queue\.eticketing\.co\.uk\/softblock\/\?c/i.test(softblockUrl);
            const eventUrlStored = (snap.eventUrl || '').trim();
            const stepRaw = Number(snap[HD_QUEUE_ERROR403_RECOVERY_STEP_KEY]) || 0;
            const recoveryStep = ((stepRaw % 3) + 3) % 3;
            const cycleIndex = Number(snap[HD_QUEUE_ERROR403_RECOVERY_CYCLE_INDEX_KEY]) || 0; // completed 3-step cycles
            const waitMs = fromHdQueue
                ? (recoveryStep === 0 && cycleIndex > 0 ? HD_QUEUE_RECOVERY_LONG_WAIT_MS : HD_QUEUE_RECOVERY_SHORT_WAIT_MS)
                : (Math.min(ERROR403_MAX_WAIT_MINUTES, 5 + 3 * prior) * 60 * 1000);
            const waitMinutes = Math.ceil(waitMs / 60000);
            const pauseUntil = Date.now() + waitMs;
            const resumeAt = new Date(pauseUntil);
            error403PauseUntil = pauseUntil;
            await chrome.storage.local.set({ error403PauseUntil: pauseUntil });
            const modeTag = fromHdQueue
                ? ` [hd-queue rotating recovery step ${recoveryStep + 1}/3]`
                : ' [seat path 5+3·n min]';
            console.log(
                `[BG] error403: occurrence #${prior + 1}, pause ${waitMinutes} min (max ${ERROR403_MAX_WAIT_MINUTES}), resume ~${resumeAt.toLocaleTimeString()}` +
                    modeTag
            );
            if (fromHdQueue) {
                await enforceSingleHdQueueError403Tab(senderTabId);
                let tabIdToUse = senderTabId;
                if (tabIdToUse == null) {
                    tabIdToUse = await findHdQueueError403TabId();
                }
                if (tabIdToUse == null) {
                    console.warn('[BG] hd-queue /error403 recovery: no hd-queue /error403 tabId found; cannot open recovery URL.');
                    return;
                }

                let targetUrl = '';
                if (recoveryStep === 0) {
                    targetUrl = 'https://www.eticketing.co.uk/arsenal';
                } else if (recoveryStep === 1) {
                    // Open event via Arsenal Red membership (JOIN NOW → Memberships/List → eventUrl)
                    targetUrl = HD_QUEUE_MEMBERSHIP_RECOVERY_URL;
                } else {
                    targetUrl = hasSavedSoftblock ? softblockUrl : HD_QUEUE_MEMBERSHIP_RECOVERY_URL;
                }

                const nextStep = (recoveryStep + 1) % 3;
                const nextCycleIndex = recoveryStep === 2 ? cycleIndex + 1 : cycleIndex;

                await chrome.storage.local.set({
                    [HD_QUEUE_ERROR403_RECOVERY_STEP_KEY]: nextStep,
                    [HD_QUEUE_ERROR403_RECOVERY_CYCLE_INDEX_KEY]: nextCycleIndex,
                    [HD_QUEUE_ERROR403_RECOVERY_TARGET_URL_KEY]: targetUrl,
                    [HD_QUEUE_ERROR403_RECOVERY_TAB_ID_KEY]: tabIdToUse
                });

                chrome.alarms.clear(HD_QUEUE_ERROR403_RECOVERY_ALARM);
                chrome.alarms.create(HD_QUEUE_ERROR403_RECOVERY_ALARM, { when: Date.now() + waitMs });

                const waitLabel = Math.round(waitMs / 1000) + 's';
                console.log(
                    '[BG] hd-queue /error403: step ' +
                        nextStep +
                        ' -> open in same tab after ' +
                        waitLabel +
                        ': ' +
                        targetUrl +
                        ' (tab ' +
                        tabIdToUse +
                        ')'
                );
                return;
            }
            const label = fromHdQueue ? 'hd-queue /error403' : 'validation/seat error403';
            error403ResumeTimerId = setTimeout(() => {
                runError403TimerResume(label).catch((e) => console.warn('[BG] runError403TimerResume:', e?.message || e));
            }, waitMs);
        })();
        sendResponse({ success: true });
        return false;
    }
    if (msg.action === 'error403QueueReturnedClearPause') {
        (async () => {
            const st = await chrome.storage.local.get('error403PauseUntil');
            const until = Number(st.error403PauseUntil) || 0;
            const pauseActive =
                Date.now() < error403PauseUntil || (until > 0 && Date.now() < until);
            if (!pauseActive) {
                sendResponse({ success: true, noOp: true });
                return;
            }
            await endError403PauseFromQueueOrToken('hd-queue main page after /error403 (history.back)', {
                clearInQueueWaiting: false
            });
            sendResponse({ success: true });
        })().catch((e) => {
            console.warn('[BG] error403QueueReturnedClearPause error:', e?.message || e);
            sendResponse({ success: false, error: e?.message || String(e) });
        });
        return true;
    }
    if (msg.action === 'eventTabReloadedClear403Pause') {
        (async () => {
            await endError403PauseFromQueueOrToken('event tab verification token ready', { clearInQueueWaiting: true });
            sendResponse({ success: true, wasPaused: true });
        })().catch((e) => {
            console.warn('[BG] eventTabReloadedClear403Pause error:', e?.message || e);
            sendResponse({ success: false, error: e?.message || String(e) });
        });
        return true;
    }
    if (msg.action === 'scheduleCloseEventTabAfterToken') {
        const tab = sender.tab;
        if (!tab || tab.id == null) {
            sendResponse({ success: false, message: 'No sender tab' });
            return false;
        }
        const u = (tab.url || '').toLowerCase();
        const pen = ((tab.pendingUrl || '') + '').toLowerCase();
        if (u.indexOf('/edp/event/index/') === -1 && pen.indexOf('/edp/event/index/') === -1) {
            console.warn('[BG] scheduleCloseEventTabAfterToken: sender is not an event index tab, ignoring');
            sendResponse({ success: false, message: 'not event index tab' });
            return false;
        }
        const raw = Number(msg.delayMs);
        const delayMs = Math.min(120000, Math.max(1000, Number.isFinite(raw) ? raw : 5000));
        console.log('[BG] Scheduling event tab close in ' + delayMs / 1000 + 's (tab ' + tab.id + ') after verification token save');
        scheduleCloseEventTabAfterTokenSave(tab.id, delayMs);
        sendResponse({ success: true, delayMs, tabId: tab.id });
        return false;
    }
    if (msg.action === 'manualStart') {
        console.log('[BG] manualStart requested from popup');
        chrome.storage.local.set({ accountRestrictedBlackoutStop: false, eventRestrictedStop: false });
        startFlowFromStorage();
        startPolling(); // start auto-checking sheet
    }
    if (msg.action === 'manualStop') {
        console.log('[BG] manualStop requested from popup');
        notifyTabStop();
        stopPolling(); // stop checking sheet
    }
    if (msg.action === 'closeOtherTabsExcept') {
        console.log('[BG] closeOtherTabsExcept requested', msg);
        closeOtherEticketingTabs()
            .then(() => {
                console.log('[BG] closeOtherTabsExcept completed successfully');
                sendResponse({success: true, message: 'Other tabs closed successfully'});
            })
            .catch(err => {
                console.error('[BG] closeOtherTabsExcept error:', err);
                sendResponse({success: false, message: err?.message || 'Unknown error'});
            });
        return true; // keep channel open for async response
    }
    if (msg.action === 'refreshEventTab') {
        if (Date.now() < error403PauseUntil) {
            console.log('[BG] refreshEventTab skipped - error403 pause active.');
            sendResponse({ success: false, message: 'error403 pause active, skipped' });
            return false;
        }
        console.log('[BG] refreshEventTab requested', msg);
        Promise.resolve(refreshEventTab())
            .then(() => {
                console.log('[BG] Event tab refreshed successfully and response sent.');
                sendResponse({success: true, message: 'Event tab refreshed'});
            })
            .catch(err => {
                console.error('[BG] refreshEventTab error:', err);
                sendResponse({success: false, message: err?.message || 'Unknown error'});
            });
        return true; // keep channel open for async response
    }
    if (msg.action === 'refreshEventTabAndCloseQueueTab') {
        if (Date.now() < error403PauseUntil) {
            console.log('[BG] refreshEventTabAndCloseQueueTab skipped - error403 pause active.');
            sendResponse({ success: false, message: 'error403 pause active, skipped' });
            return false;
        }
        if (!sender.tab) {
            sendResponse({ success: false, message: 'No sender tab' });
            return false;
        }
        const queueTabId = sender.tab.id;
        console.log('[BG] refreshEventTabAndCloseQueueTab from queue tab', queueTabId);
        (async () => {
            const { removed, skipped } = await safeTabsRemove(queueTabId);
            if (removed.length) console.log('[BG] Queue tab closed:', queueTabId);
            if (skipped.length) console.warn('[BG] Queue tab not closed — only tab in window:', queueTabId);
            await refreshEventTab();
            sendResponse({ success: true, message: 'Queue tab closed, event tab refreshed' });
        })().catch((err) => {
            console.error('[BG] refreshEventTabAndCloseQueueTab error:', err);
            sendResponse({ success: false, message: err?.message || 'Unknown error' });
        });
        return true;
    }
    if (msg.action === 'notifyWebhooks') {
        console.log('[BG] notifyWebhooks requested', msg);
        console.log('[BG] Message length:', msg.message ? msg.message.length : 0);

        // Use promise chaining instead of await
        chrome.storage.local.get(['discordWebhook', 'telegramWebhook', 'telegramChatId']).then(data => {
            const discordWebhook = data.discordWebhook || '';
            const telegramWebhook = data.telegramWebhook || '';
            const telegramChatId = data.telegramChatId != null && data.telegramChatId !== '' ? String(data.telegramChatId).trim() : '';
            const payload = msg.payload || {};
            const message = msg.message || 'Notification from Arsenal Tickets Extension';

            console.log('[BG] Webhook config:', { discordWebhook: !!discordWebhook, telegramBotToken: !!telegramWebhook, telegramChatId: !!telegramChatId });

            // Always send success notification: default Discord webhook + sheet webhook if provided
            console.log('[BG] Sending webhooks...');
            sendWebhooks(discordWebhook, telegramWebhook, telegramChatId, message, payload);
        }).catch(err => {
            console.error('[BG] Error reading webhooks config:', err);
        });
    }
    if (msg.action === 'notifyErrorWebhooks') {
        console.log('[BG] notifyErrorWebhooks requested', msg);

        const payload = msg.payload || {};
        const message = msg.message || 'Error notification from Arsenal Tickets Extension';
        const useCookieClearWebhook = payload.kind === 'seat_check_403_cookie_clear';
        const errorDiscordWebhook = useCookieClearWebhook ? SEAT_CHECK_COOKIE_CLEAR_DISCORD_WEBHOOK : DEFAULT_ERROR_DISCORD_WEBHOOK;

        console.log(
            '[BG] Sending error notification to',
            useCookieClearWebhook ? 'seat-check cookie-clear webhook' : 'default error webhook'
        );
        sendErrorWebhook(errorDiscordWebhook, message, payload);
    }
    if (msg.action === 'log') {
        console.log('[BG-LOG]', msg.message);
    }
    if (msg.action === 'openNewTab') {
        console.log('[BG] Opening new tab with URL:', msg.url);
        chrome.tabs.create({url: msg.url})
            .then((tab) => {
                if (tab && tab.id != null && tabMatchesBasketPlaceholderUrl(msg.url || tab.url || '')) {
                    basketPlaceholderTabOpenedAt.set(tab.id, Date.now());
                }
                console.log('[BG] New tab opened successfully');
                sendResponse({success: true, message: 'New tab opened successfully'});
            })
            .catch(error => {
                console.error('[BG] Error opening new tab:', error);
                sendResponse({success: false, message: error?.message || 'Unknown error'});
            });
        return true; // keep channel open for async response
    }
    if (msg.type === "heartbeat" ) {
        // heartbeatTracker[sender.tab.id] = Date.now();
        updateHeartbeat();
        
        console.log(`[BG] Heartbeat received from tab ${sender.tab.id} at ${new Date().toLocaleTimeString()}`);
    }
    if (msg.action === 'refreshCredentials') {
        console.log('[BG] refreshCredentials requested from content script');
        Promise.resolve(refreshCredentialsFromSheet())
            .then(() => {
                console.log('[BG] Credentials refreshed successfully');
                sendResponse({success: true, message: 'Credentials refreshed from Google Sheets'});
            })
            .catch(err => {
                console.error('[BG] refreshCredentials error:', err);
                sendResponse({success: false, message: err?.message || 'Failed to refresh credentials'});
            });
        return true; // keep channel open for async response
    }
    if (msg.action === 'syncTwoCaptchaKeyFromSheet') {
        syncTwoCaptchaKeyFromPublicSheet()
            .then((key) => sendResponse({ success: !!key, keyLength: key ? key.length : 0 }))
            .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg.action === 'twoCaptchaSolveImageBase64') {
        const base64Body = msg.base64;
        if (!base64Body || typeof base64Body !== 'string') {
            sendResponse({ success: false, error: 'missing base64' });
            return false;
        }
        (async () => {
            try {
                const apiKey = await getTwoCaptchaApiKeyOrFetchFromSheet();
                if (!apiKey) {
                    sendResponse({
                        success: false,
                        error: 'twoCaptchaApiKey missing and public sheet fetch failed (popup or sheet A1)'
                    });
                    return;
                }
                const inParams = new URLSearchParams();
                inParams.set('key', apiKey);
                inParams.set('method', 'base64');
                inParams.set('body', base64Body);
                const inRes = await fetch('https://2captcha.com/in.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                    body: inParams.toString()
                });
                const inText = (await inRes.text()).trim();
                if (!inText.startsWith('OK|')) {
                    console.warn('[BG] 2captcha in.php:', inText);
                    sendResponse({ success: false, error: inText });
                    return;
                }
                const taskId = inText.slice(3);
                console.log('[BG] 2captcha image task created:', taskId);
                const pollIntervalMs = 2000;
                const maxPolls = 120; // 120 × 2s ≈ 4 min cap (same order of magnitude as prior 48 × 5s)
                for (let poll = 0; poll < maxPolls; poll++) {
                    await new Promise((r) => setTimeout(r, pollIntervalMs));
                    const resUrl =
                        'https://2captcha.com/res.php?key=' +
                        encodeURIComponent(apiKey) +
                        '&action=get&id=' +
                        encodeURIComponent(taskId);
                    const resRes = await fetch(resUrl);
                    const resText = (await resRes.text()).trim();
                    const upper = resText.toUpperCase();
                    if (upper === 'CAPCHA_NOT_READY' || upper === 'CAPTCHA_NOT_READY') continue;
                    if (resText.startsWith('OK|')) {
                        const text = resText.slice(3);
                        console.log('[BG] 2captcha solved, code length:', text.length);
                        sendResponse({ success: true, text });
                        return;
                    }
                    console.warn('[BG] 2captcha res.php:', resText);
                    sendResponse({ success: false, error: resText });
                    return;
                }
                sendResponse({ success: false, error: '2captcha poll timeout (~' + Math.round((maxPolls * pollIntervalMs) / 60000) + ' min)' });
            } catch (e) {
                console.error('[BG] 2captcha exception:', e);
                sendResponse({ success: false, error: e?.message || String(e) });
            }
        })();
        return true;
    }
    return true;
});


async function refreshCredentialsFromSheet() {
    console.log('[BG] Refreshing credentials from Google Sheets...');
    
    const data = await chrome.storage.local.get(['sheetUrl', 'startSecond']);
    const sheetUrl = data.sheetUrl;
    const startSecond = data.startSecond ?? 2;

    if (!sheetUrl) {
        throw new Error('No Google Sheet URL configured');
    }

    const allCfg = await fetchSheetConfigAll(sheetUrl).catch(e => {
        console.warn('[BG] fetch sheet failed', e);
        throw new Error('Failed to fetch data from Google Sheets: ' + e.message);
    });

    console.log('[BG] Checking all rows for startSecond match:', startSecond);

    // Find matching rows that are active (startSecond can be decimal, e.g. 2.5)
    const targetNum = parseFloat(startSecond);
    const matchingRows = allCfg.filter(cfg =>
        ['on', 'start', 'true', '1'].includes((cfg.status || '').toString().trim().toLowerCase()) &&
        parseFloat(cfg.startSecond) === targetNum
    );

    if (matchingRows.length === 0) {
        throw new Error(`No active row found with startSecond=${startSecond}. Please check your Google Sheet configuration.`);
    }

    // Use the first matching row
    const cfg = matchingRows[0];
    console.log('[BG] Found matching active row for credentials:', cfg);

    // Update credentials in local storage
    await chrome.storage.local.set({
        loginEmail: cfg.loginEmail,
        loginPassword: cfg.loginPassword,
        currentStatus: 'on',
        discordWebhook: (cfg.discordWebhook || '').trim(),
        telegramWebhook: (cfg.telegramWebhook || '').trim(),
        telegramChatId: cfg.telegramChatId != null && String(cfg.telegramChatId).trim() !== '' ? String(cfg.telegramChatId).trim() : '',
        ignoreClubLevel: cfg.ignoreClubLevel,
        ignoreUpperTier: cfg.ignoreUpperTier,
        resaleEndpointChances: cfg.resaleEndpointChances != null ? cfg.resaleEndpointChances : DEFAULT_RESALE_ENDPOINT_CHANCES,
        focusRefreshTab: cfg.focusRefreshTab !== undefined ? cfg.focusRefreshTab : true
    });

    console.log('[BG] Credentials updated in local storage');
}

async function startFlowFromStorage() {
    const data = await chrome.storage.local.get(['sheetUrl', 'startSecond']);
    const sheetUrl = data.sheetUrl;
    const startSecond = data.startSecond ?? 2;

    if (!sheetUrl) {
        console.warn('[BG] startFlow: no sheetUrl in storage');
        return;
    }

    const allCfg = await fetchSheetConfigAll(sheetUrl).catch(e => {
        console.warn('[BG] fetch sheet failed', e);
        return [];
    });

    console.log('[BG] Checking all rows for startSecond match:', startSecond);

    const targetNum = parseFloat(startSecond);
    for (const cfg of allCfg) {
        if (parseFloat(cfg.startSecond) === targetNum) {
            console.log('[BG] Found matching row for startSecond:', startSecond, cfg);
            // {
            //     "status": "on",
            //     "discordWebhook": "https://discord.com/api/webhooks/1371776918407483403/i0PZw3JR5Ypuw1bmoYrPGrbf9US4eXD8S1W-FSEarQ0EvVWn2iX8VIXRyzgBcQ96S1br",
            //     "telegramWebhook": "123456789:ABCDEFghijkLmnoPQrstUVwxYZ",
            //     "telegramChatId": 987654321,
            //     "eventUrl": "https://www.eticketing.co.uk/arsenal/EDP/Event/Index/3674",
            //     "areSeatsTogether": "false",
            //     "quantity": 1,
            //     "startSecond": 2,
            //     "eventId": 3674,
            //     "maximumPrice": 10000000,
            //     "minimumPrice": ""
            //     }
            // Save to local storage
            const seatCfg = seatModeFromPairChance(cfg.areSeatsTogether, cfg.quantity, cfg.pairCheckChance);
            await chrome.storage.local.set({
                sheetUrl: sheetUrl,
                startSecond: cfg.startSecond,
                currentStatus: 'on', // set currentStatus to 'on'
                eventUrl: cfg.eventUrl,
                areSeatsTogether: seatCfg.areSeatsTogether,
                quantity: seatCfg.quantity,
                discordWebhook: (cfg.discordWebhook || '').trim(),
                telegramWebhook: (cfg.telegramWebhook || '').trim(),
                telegramChatId: cfg.telegramChatId != null && String(cfg.telegramChatId).trim() !== '' ? String(cfg.telegramChatId).trim() : '',
                loginEmail: cfg.loginEmail,
                loginPassword: cfg.loginPassword,
                ignoreClubLevel: cfg.ignoreClubLevel,
                ignoreUpperTier: cfg.ignoreUpperTier,
                resaleEndpointChances: cfg.resaleEndpointChances != null ? cfg.resaleEndpointChances : DEFAULT_RESALE_ENDPOINT_CHANCES,
                focusRefreshTab: cfg.focusRefreshTab !== undefined ? cfg.focusRefreshTab : true
            });

            await openOrFocusTabs(cfg.eventUrl, EVENT_NOT_ALLOWED_URL);
        }
    }
}

async function openOrFocusTabs(eventUrl = null, EVENT_NOT_ALLOWED_URL = null) {
    if (openOrFocusTabsInProgress) {
        console.log('[BG] openOrFocusTabs already running - skip duplicate call');
        return;
    }
    if (Date.now() < error403PauseUntil) {
        console.log('[BG] error403 pause active - skipping openOrFocusTabs.');
        return;
    }
    if (await accountRestrictedBlackoutStopActive()) {
        console.log('[BG] openOrFocusTabs skipped — account restricted blackout stop');
        return;
    }
    if (await eventRestrictedStopActive()) {
        console.log('[BG] openOrFocusTabs skipped — event restricted stop');
        return;
    }
    if (await isBrowsingPauseSystemHoldActive()) {
        console.log('[BG] openOrFocusTabs skipped — browsing pause recovery/cooldown active');
        return;
    }
    if (await isQueueItActive()) {
        console.log('[BG] Queue-IT active — skipping openOrFocusTabs (no validation/event tab create/reload).');
        return;
    }
    openOrFocusTabsInProgress = true;
    try {
        await waitThenCloseStaleWebIdentityTabsIfPresent();

        console.log('event url:', eventUrl);

        // check if any tab with starting url: hd-queue.eticketing.co.uk or https://web-identity than wait for 10 seconds
        // Returns true if queue is active (abort openOrFocusTabs); false otherwise
        async function checkTabsAndWait() {
            if (await isQueueItActive()) {
                console.log('[BG] Queue-IT active — aborting openOrFocusTabs (no validation create/reload).');
                return true;
            }
            const tabsNow = await chrome.tabs.query({});
            const matchTab = tabsNow.find((tab) => tabIsAnyHdQueueEticketingTab(tab));

            if (matchTab) {
                console.log('[BG] hd-queue tab present — aborting openOrFocusTabs:', matchTab.url || matchTab.pendingUrl);
                return true;
            }
            console.log('[BG] No matching tab found for queue or web identity related, ignoring');
            return false;
        }

        // check if queue or web identity tabs still there
        if (await checkTabsAndWait()) return;
        // Close other eticketing tabs
        await closeOtherEticketingTabs();

        // Event tab first: reset ready flag, ensure/reload event, wait for token flag — only then validation
        let eventReady = false;
        if (eventUrl) {
            await resetEventPageReadyFlag('openOrFocusTabs before event ensure/reload');
            await ensureEventTabFromBackground(eventUrl, { forceReload: true });
            if (Date.now() < error403PauseUntil || (await isQueueItActive())) {
                console.log('[BG] After event ensure — pause/queue active; skip validation tab');
                return;
            }
            eventReady = await waitForEventPageReady({ timeoutMs: EVENT_PAGE_READY_WAIT_MS });
            if (!eventReady) {
                console.log(
                    '[BG] Event page ready flag not set — skipping validation tab create/reload (avoids 2nd queue)'
                );
            }
        } else {
            eventReady = await isEventPageReady();
        }

        if (Date.now() < error403PauseUntil) {
            console.log('[BG] error403 pause active - skipping rest of openOrFocusTabs.');
            return;
        }
        if (await checkTabsAndWait()) return;
        await closeOtherEticketingTabs();

        if (EVENT_NOT_ALLOWED_URL && eventReady) {
            await openOrReloadValidationTab(EVENT_NOT_ALLOWED_URL, { reloadIfExists: true });
        } else if (EVENT_NOT_ALLOWED_URL && !eventReady) {
            console.log('[BG] Validation tab deferred — waiting for eventPageReady on a later check');
        }

        await new Promise((resolve) => setTimeout(resolve, 10000));

        if (Date.now() < error403PauseUntil) {
            console.log('[BG] error403 pause active - skipping recheck and rest of openOrFocusTabs.');
            return;
        }
        if (await checkTabsAndWait()) return;
        await closeOtherEticketingTabs();

        // Recheck: only create missing validation if event is still ready (do not force-reload event again)
        if (Date.now() < error403PauseUntil) {
            console.log('[BG] error403 pause active - skipping recheck and rest of openOrFocusTabs.');
            return;
        }
        console.log('[BG] Recheck tabs — validation only if eventPageReady and not in queue');
        const tabs2 = await chrome.tabs.query({ url: '*://www.eticketing.co.uk/*' });

        if (EVENT_NOT_ALLOWED_URL && (await isEventPageReady()) && !(await isQueueItActive())) {
            await openOrReloadValidationTab(EVENT_NOT_ALLOWED_URL, { reloadIfExists: false });
        }

        //if there are more than 1 event tab close other event tabs only keep one tab open (never close tabs with Checkout in URL)
        const eventTabs = eventUrl
            ? tabs2.filter((t) => t.url && t.url.startsWith(eventUrl))
            : [];
        if (eventTabs.length > 1) {
            console.log('[BG] More than 1 event tab found, closing other event tabs');
            const dupEventIds = eventTabs
                .filter((t) => t.id !== eventTabId && t.url && !t.url.toLowerCase().includes('checkout'))
                .map((t) => t.id)
                .filter((id) => id != null);
            const { removed, skipped } = await safeTabsRemove(dupEventIds);
            if (skipped.length) console.warn('[BG] Skipped closing some event tabs (would empty a window):', skipped.join(','));
            if (removed.length) console.log('[BG] Closed duplicate event tab(s):', removed.join(','));
        }
        //if there are more than 1 not allowed tab close other not allowed tabs only keep one tab open (never close tabs with Checkout in URL)
        const notAllowedTabs = tabs2.filter(
            (t) => t.url && tabUrlIsValidationArchivedTab(t.url) && !tabUrlIsEventRestricted(t.url)
        );
        if (notAllowedTabs.length > 1) {
            console.log('[BG] More than 1 not allowed tab found, closing other not allowed tabs');
            const dupNaIds = notAllowedTabs
                .filter((t) => t.id !== notAllowedTabId && t.url && !t.url.toLowerCase().includes('checkout'))
                .map((t) => t.id)
                .filter((id) => id != null);
            const { removed: r2, skipped: s2 } = await safeTabsRemove(dupNaIds);
            if (s2.length) console.warn('[BG] Skipped closing some validation tabs (would empty a window):', s2.join(','));
            if (r2.length) console.log('[BG] Closed duplicate validation tab(s):', r2.join(','));
        }

        console.log('[BG] openOrFocusTabs completed');

    } catch (e) {
        console.error('[BG] openOrFocusTabs error', e);
    } finally {
        openOrFocusTabsInProgress = false;
    }
}

function waitForTabLoad(tabId, timeout = 15000) {
    return new Promise(resolve => {
        let settled = false;

        function check(info) {
            if (info.tabId === tabId && info.status === 'complete') {
                if (!settled) {
                    settled = true;
                    chrome.tabs.onUpdated.removeListener(check);
                    resolve();
                }
            }
        }

        chrome.tabs.onUpdated.addListener(check);
        // fallback timeout
        setTimeout(() => {
            if (!settled) {
                settled = true;
                chrome.tabs.onUpdated.removeListener(check);
                resolve();
            }
        }, timeout);
    });
}

// Hosts we manage: only event tab + validation tab allowed; everything else from these hosts gets closed (except checkout)
const ETICKETING_HOST = 'www.eticketing.co.uk';
const QUEUE_HOST = 'hd-queue.eticketing.co.uk';
const ARSENAL_HOST = 'www.arsenal.com';

/** True if tab URL or pendingUrl is on hd-queue.eticketing.co.uk (covers mid-redirect when `url` is empty/transitional). */
function tabHostnameIsHdQueueEticketing(urlOrPending) {
    if (!urlOrPending) return false;
    try {
        return new URL(urlOrPending).hostname.toLowerCase() === QUEUE_HOST;
    } catch (_) {
        return false;
    }
}

function tabTextMentionsHdQueueHost(s) {
    if (!s) return false;
    return String(s).toLowerCase().includes(QUEUE_HOST);
}

function tabIsAnyHdQueueEticketingTab(tab) {
    return (
        tabHostnameIsHdQueueEticketing(tab.url) ||
        tabHostnameIsHdQueueEticketing(tab.pendingUrl) ||
        tabTextMentionsHdQueueHost(tab.url) ||
        tabTextMentionsHdQueueHost(tab.pendingUrl)
    );
}

function hasAnyHdQueueEticketingTabInList(tabs) {
    return (tabs || []).some((t) => tabIsAnyHdQueueEticketingTab(t));
}

/**
 * True when Queue-IT is active: people-ahead flag and/or any hd-queue tab (url/pendingUrl).
 * While active: freeze heartbeat health reload and do not create/reload validation tab.
 */
async function isQueueItActive() {
    await checkQueueWaitingTimeout();
    const { inQueueWaiting } = await chrome.storage.local.get('inQueueWaiting');
    if (inQueueWaiting === true) return true;
    try {
        const allTabs = await chrome.tabs.query({});
        return hasAnyHdQueueEticketingTabInList(allTabs);
    } catch (_) {
        return false;
    }
}

/** Stuck Ticketmaster web-identity login; close after wait if it does not redirect away. */
function tabUrlIsWebIdentityPage(url) {
    if (!url) return false;
    const u = url.toLowerCase();
    return u.startsWith('https://web-identity.tmtickets.co.uk/') || u.startsWith('http://web-identity.tmtickets.co.uk/');
}

/**
 * Before opening event or validation tabs: if any tab is on web-identity, wait 8s; if still on that URL (not redirected), close it.
 * If no such tab, returns immediately.
 */
async function waitThenCloseStaleWebIdentityTabsIfPresent() {
    const all = await chrome.tabs.query({});
    const stuckIds = [];
    for (const t of all) {
        if (t.url && tabUrlIsWebIdentityPage(t.url)) stuckIds.push(t.id);
    }
    if (stuckIds.length === 0) return;
    console.log('[BG] web-identity tab(s) open — waiting 8s before event/validation flow:', stuckIds.join(','));
    await new Promise((r) => setTimeout(r, 8000));
    for (const id of stuckIds) {
        try {
            const t = await chrome.tabs.get(id);
            if (tabUrlIsWebIdentityPage(t.url)) {
                const { removed, skipped } = await safeTabsRemove(id);
                if (removed.length) console.log('[BG] Closed web-identity tab still on identity URL after 8s:', id);
                if (skipped.length) console.warn('[BG] Web-identity tab not closed — only tab in window:', id);
            }
        } catch (_) {
            /* tab already closed */
        }
    }
}

/**
 * Close every tab whose URL still starts with the basket-success placeholder after ≥12 min on that URL.
 * Tracks per-tab first-seen time; clears when URL changes or tab closes.
 */
async function sweepAndCloseStaleBasketPlaceholderTabs() {
    const now = Date.now();
    const all = await chrome.tabs.query({});
    const matchingIds = [];

    for (const t of all) {
        if (t.id == null || !t.url || !tabMatchesBasketPlaceholderUrl(t.url)) continue;
        matchingIds.push(t.id);
        if (!basketPlaceholderTabOpenedAt.has(t.id)) {
            basketPlaceholderTabOpenedAt.set(t.id, now);
        }
    }

    for (const id of matchingIds) {
        const opened = basketPlaceholderTabOpenedAt.get(id);
        if (opened != null && now - opened >= BASKET_PLACEHOLDER_MAX_MS) {
            try {
                const { removed, skipped } = await safeTabsRemove(id);
                if (removed.length) console.log('[BG] Closed basket-placeholder tab (URL open ≥12 min):', id);
                if (skipped.length) console.warn('[BG] Basket-placeholder tab not closed — only tab in window:', id);
            } catch (e) {
                console.warn('[BG] Failed to close basket-placeholder tab:', id, e);
            }
            basketPlaceholderTabOpenedAt.delete(id);
        }
    }

    for (const id of [...basketPlaceholderTabOpenedAt.keys()]) {
        if (matchingIds.includes(id)) continue;
        try {
            const tab = await chrome.tabs.get(id);
            if (!tabMatchesBasketPlaceholderUrl(tab.url || '')) basketPlaceholderTabOpenedAt.delete(id);
        } catch {
            basketPlaceholderTabOpenedAt.delete(id);
        }
    }
}

function eventIdFromEticketEventUrl(url) {
    if (!url) return null;
    const m = url.match(/\/Event\/Index\/(\d+)/i);
    if (m) return m[1];
    const m2 = url.match(/[?&]EventId=(\d+)/i);
    return m2 ? m2[1] : null;
}

function tabIsOurEticketEventPage(tab, eventUrl) {
    if (!eventUrl || !tab) return false;
    const base = eventUrl.split('?')[0];
    const candidates = [tab.url || '', tab.pendingUrl || ''].filter(Boolean);
    for (const u of candidates) {
        if (u.startsWith(base)) return true;
    }
    const eid = eventIdFromEticketEventUrl(eventUrl);
    if (eid) {
        const re = new RegExp(`(?:/Event/Index/${eid}(?:[^0-9]|$)|[?&]EventId=${eid}(?:[^0-9]|$))`, 'i');
        for (const u of candidates) {
            if (re.test(u)) return true;
        }
    }
    return false;
}

/** Queue tab still “owns” the event flow if `t=` target points at our event. */
function tabIsOurQueueSlotForEvent(tab, eventUrl) {
    if (!eventUrl) return false;
    const eventId = eventIdFromEticketEventUrl(eventUrl);
    const base = eventUrl.split('?')[0];
    for (const raw of [tab.url || '', tab.pendingUrl || ''].filter(Boolean)) {
        let host = '';
        try {
            host = new URL(raw).hostname.toLowerCase();
        } catch (_) {
            continue;
        }
        if (host !== QUEUE_HOST) continue;
        try {
            const parsed = new URL(raw);
            const t = parsed.searchParams.get('t');
            if (t) {
                const decoded = decodeURIComponent(t);
                if (decoded.startsWith(base)) return true;
                if (eventId && (decoded.includes(`EventId=${eventId}`) || decoded.includes(`/Event/Index/${eventId}`))) return true;
            }
        } catch (_) {}
    }
    return false;
}

async function shouldSkipEventTabOperations() {
    if (Date.now() < error403PauseUntil) {
        console.log('[BG] Event tab op skipped — error403 pause (memory)');
        return true;
    }
    const { error403PauseUntil: storedUntil = 0, accountRestrictedBlackoutStop, eventRestrictedStop } =
        await chrome.storage.local.get(['error403PauseUntil', 'accountRestrictedBlackoutStop', 'eventRestrictedStop']);
    if (accountRestrictedBlackoutStop === true) {
        console.log('[BG] Event tab op skipped — account restricted blackout stop');
        return true;
    }
    if (eventRestrictedStop === true) {
        console.log('[BG] Event tab op skipped — event restricted stop');
        return true;
    }
    if (await isBrowsingPauseSystemHoldActive()) {
        console.log('[BG] Event tab op skipped — browsing pause recovery/cooldown active');
        return true;
    }
    const until = Number(storedUntil) || 0;
    if (until > 0 && Date.now() < until) {
        console.log('[BG] Event tab op skipped — error403 pause (storage)');
        return true;
    }
    await checkQueueWaitingTimeout();
    const { inQueueWaiting } = await chrome.storage.local.get('inQueueWaiting');
    if (inQueueWaiting) {
        console.log('[BG] Event tab op skipped — inQueueWaiting (people ahead)');
        return true;
    }
    const allTabs = await chrome.tabs.query({});
    if (hasAnyHdQueueEticketingTabInList(allTabs)) {
        console.log('[BG] Event tab op skipped — hd-queue.eticketing.co.uk tab open or redirecting (url/pendingUrl)');
        return true;
    }
    return false;
}

async function focusTabWindow(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.tabs.update(tabId, { active: true });
    } catch (e) {
        console.warn('[BG] focusTabWindow failed', tabId, e);
    }
}

/** When sheet says not to focus, reload/ensure event tab without stealing focus (undefined storage → focus). */
async function resolveFocusEventTabPreference(opts) {
    if (opts && typeof opts.focusEventTab === 'boolean') return opts.focusEventTab;
    const { focusRefreshTab } = await chrome.storage.local.get('focusRefreshTab');
    if (focusRefreshTab === false) return false;
    return true;
}

function runExclusiveEventTabOp(fn) {
    const run = eventTabOpChain.then(() => fn());
    eventTabOpChain = run.then(() => {}).catch((e) => console.warn('[BG] Event tab chain error', e));
    return run;
}

/**
 * Single entry for event tab: reload www match, or recognize hd-queue as same flow (no duplicate tab), or create.
 * @param {string} eventUrlParam
 * @param {{ forceReload?: boolean, focusEventTab?: boolean }} opts - focusEventTab overrides sheet "Focus Refresh tab?"
 */
async function ensureEventTabFromBackground(eventUrlParam, opts) {
    const forceReload = opts && opts.forceReload === true;
    return runExclusiveEventTabOp(async () => {
        if (await shouldSkipEventTabOperations()) {
            return { success: false, skipped: true, message: 'queue or error403 pause' };
        }
        await waitThenCloseStaleWebIdentityTabsIfPresent();
        const wantFocus = await resolveFocusEventTabPreference(opts);
        let url = (eventUrlParam || EVENT_URL || '').trim();
        if (!url) {
            const st = await chrome.storage.local.get('eventUrl');
            url = (st.eventUrl || '').trim();
        }
        if (!url) {
            console.warn('[BG] ensureEventTab: no event URL');
            return { success: false, message: 'no eventUrl' };
        }
        EVENT_URL = url;

        const allTabs = await chrome.tabs.query({});
        if (hasOpenHdQueueError403TabInList(allTabs)) {
            console.log('[BG] ensureEventTab: skipped — an hd-queue /error403 tab is already open');
            return { success: false, skipped: true, message: 'hd-queue error403 tab open' };
        }
        if (hasAnyHdQueueEticketingTabInList(allTabs)) {
            console.log(
                '[BG] ensureEventTab: skipped — hd-queue.eticketing.co.uk tab present (any queue page; pendingUrl-aware)'
            );
            return { success: false, skipped: true, message: 'hd-queue tab active' };
        }
        const wwwTab = allTabs.find((t) => tabIsOurEticketEventPage(t, url));
        if (wwwTab) {
            eventTabId = wwwTab.id;
            if (forceReload) {
                try {
                    await chrome.tabs.reload(wwwTab.id);
                    console.log('[BG] ensureEventTab: reloaded existing event tab', wwwTab.id);
                } catch (e) {
                    console.warn('[BG] ensureEventTab reload failed', e);
                }
            } else {
                console.log('[BG] ensureEventTab: using existing www event tab', wwwTab.id);
            }
            if (wantFocus) await focusTabWindow(wwwTab.id);
            else console.log('[BG] ensureEventTab: skipping focus (Focus Refresh tab? = No)');
            return { success: true, action: forceReload ? 'reloaded' : 'found-www' };
        }

        const queueTab = allTabs.find((t) => tabIsOurQueueSlotForEvent(t, url));
        if (queueTab) {
            eventTabId = queueTab.id;
            console.log('[BG] ensureEventTab: event flow on queue tab — not creating another', queueTab.id);
            if (wantFocus) await focusTabWindow(queueTab.id);
            else console.log('[BG] ensureEventTab: skipping focus (Focus Refresh tab? = No)');
            return { success: true, action: 'queue-holds-slot' };
        }

        for (let rescan = 0; rescan < 3; rescan++) {
            const again = await chrome.tabs.query({});
            if (hasAnyHdQueueEticketingTabInList(again)) {
                console.log(
                    '[BG] ensureEventTab: skipped create — hd-queue tab appeared mid-redirect (rescan ' + (rescan + 1) + ')'
                );
                return { success: false, skipped: true, message: 'hd-queue tab active (rescan)' };
            }
            await new Promise((r) => setTimeout(r, 500));
        }

        // Do not open eventUrl directly — go Arsenal Red → Memberships/List → eventUrl
        console.log('[BG] ensureEventTab: opening event via Arsenal Red membership (not direct eventUrl)');
        const via = await openEventUrlViaArsenalMembershipRed({ focus: wantFocus });
        return {
            success: true,
            action: via.action || 'opened-via-membership',
            tabId: via.tabId
        };
    });
}

function tabUrlIsManagedHost(url) {
    if (!url) return false;
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        return host === ETICKETING_HOST || host === QUEUE_HOST || host === ARSENAL_HOST;
    } catch (_) {
        return false;
    }
}

function tabIsCheckout(url) {
    return url && url.toLowerCase().includes('checkout');
}

/** Account blackout / restriction page — never close this tab in prune; full URL contains these markers. */
function tabUrlIsAccountRestrictedBlackout(url) {
    if (!url) return false;
    const u = url.toLowerCase();
    return u.includes('accountrestrictederrormessage') && u.includes('bodykey=warn_login_blackoutlimitreached');
}

/** Event tab landed on EventNotAllowed?reason=EventRestricted — keep open; do not treat as validation monitor tab. */
function tabUrlIsEventRestricted(url) {
    if (!url) return false;
    const u = url.toLowerCase();
    if (!u.includes('/edp/validation/eventnotallowed')) return false;
    try {
        const parsed = new URL(url);
        return (parsed.searchParams.get('reason') || '').toLowerCase() === 'eventrestricted';
    } catch {
        return u.includes('reason=eventrestricted');
    }
}

/** Validation monitor tab (EventArchived placeholder), not an event-restricted redirect. */
function tabUrlIsValidationArchivedTab(url) {
    if (!url) return false;
    const u = url.toLowerCase();
    if (!u.includes('/edp/validation/eventnotallowed')) return false;
    if (tabUrlIsEventRestricted(url)) return false;
    try {
        const parsed = new URL(url);
        return (parsed.searchParams.get('reason') || '').toLowerCase() === 'eventarchived';
    } catch {
        return u.includes('reason=eventarchived');
    }
}

async function accountRestrictedBlackoutStopActive() {
    const { accountRestrictedBlackoutStop } = await chrome.storage.local.get('accountRestrictedBlackoutStop');
    return accountRestrictedBlackoutStop === true;
}

async function eventRestrictedStopActive() {
    const { eventRestrictedStop } = await chrome.storage.local.get('eventRestrictedStop');
    return eventRestrictedStop === true;
}

let eventRestrictedStopApplying = false;

async function applyEventRestrictedStopFromBackground(reason, tabId) {
    if (tabId != null) cancelCloseEventTabAfterTokenSave(tabId);
    if (await eventRestrictedStopActive()) return;
    if (eventRestrictedStopApplying) return;
    eventRestrictedStopApplying = true;
    try {
        const patch = { eventRestrictedStop: true, currentStatus: 'off' };
        if (tabId != null) patch.eventRestrictedTabId = tabId;
        await chrome.storage.local.set(patch);
        lastStatus = 'off';
        stopPolling();
        notifyTabStop();
        console.log('[BG] Event restricted — stopped monitoring; keeping tab open.', reason || '', tabId != null ? '(tab ' + tabId + ')' : '');
    } finally {
        eventRestrictedStopApplying = false;
    }
}

async function applyAccountRestrictedBlackoutStopFromBackground(reason) {
    await chrome.storage.local.set({ accountRestrictedBlackoutStop: true, currentStatus: 'off' });
    lastStatus = 'off';
    stopPolling();
    notifyTabStop();
    console.log('[BG] Account restricted blackout — bot stopped.', reason || '');
}

/** Keep only 1 event tab + 1 validation tab. Close other eticketing and arsenal.com tabs. Keep all hd-queue tabs (including /error403). Close localhost tabs. Never close checkout. Never close the last remaining browser tab. */
async function closeOtherEticketingTabs() {
    await waitThenCloseStaleWebIdentityTabsIfPresent();

    const eventUrl = EVENT_URL || '';

    const tabs = await chrome.tabs.query({});
    let keptEventId = null;
    let keptValidationId = null;
    const toClose = [];

    const eventBase = eventUrl ? eventUrl.split('?')[0] : '';
    const { [HD_QUEUE_MEMBERSHIP_RECOVERY_ACTIVE_KEY]: membershipRecoveryActive } = await chrome.storage.local.get(
        HD_QUEUE_MEMBERSHIP_RECOVERY_ACTIVE_KEY
    );

    function tabHostLocal(url) {
        if (!url) return '';
        try {
            return new URL(url).hostname.toLowerCase();
        } catch (_) {
            return '';
        }
    }

    for (const t of tabs) {
        const url = t.url || '';
        const pen = t.pendingUrl || '';
        const hostU = tabHostLocal(url);
        const hostP = tabHostLocal(pen);
        const isLocalhost =
            hostU === 'localhost' ||
            hostU === '127.0.0.1' ||
            hostP === 'localhost' ||
            hostP === '127.0.0.1';

        if (!tabUrlIsManagedHost(url) && !tabUrlIsManagedHost(pen) && !isLocalhost) continue;
        if (tabIsCheckout(url) || tabIsCheckout(pen)) continue;
        if (tabUrlIsArsenalMembershipRed(url) || tabUrlIsArsenalMembershipRed(pen)) {
            continue; // keep Arsenal Red membership recovery tab open
        }
        // During membership recovery, keep Memberships/List until content.js redirects to eventUrl
        const membershipsList =
            (url || '').toLowerCase().includes('/arsenal/memberships/list') ||
            (pen || '').toLowerCase().includes('/arsenal/memberships/list');
        if (membershipsList && membershipRecoveryActive === true) {
            continue;
        }
        if (tabUrlIsAccountRestrictedBlackout(url) || tabUrlIsAccountRestrictedBlackout(pen)) {
            continue; // keep account-restricted / blackout message tab open
        }
        if (tabUrlIsEventRestricted(url) || tabUrlIsEventRestricted(pen)) {
            continue; // keep event-restricted tab open (event tab redirect)
        }
        if (url.includes(QUEUE_HOST) || pen.includes(QUEUE_HOST)) {
            continue; // keep all hd-queue.eticketing.co.uk tabs (queue + /error403)
        }

        const isEventTab =
            eventBase && (url.startsWith(eventBase) || (pen && pen.startsWith(eventBase)));
        const isValidationTab =
            tabUrlIsValidationArchivedTab(url) || tabUrlIsValidationArchivedTab(pen);

        if (isEventTab) {
            if (keptEventId == null) keptEventId = t.id;
            else toClose.push(t.id); // duplicate event tab
        } else if (isValidationTab) {
            if (keptValidationId == null) keptValidationId = t.id;
            else toClose.push(t.id); // duplicate validation tab
        } else if (isLocalhost) {
            toClose.push(t.id);
        } else {
            // other eticketing or arsenal tab
            toClose.push(t.id);
        }
    }

    let uniqueClose = [...new Set(toClose)];
    const { removed, skipped } = await safeTabsRemove(uniqueClose);
    if (skipped.length) {
        console.warn('[BG] closeOtherEticketingTabs: skipped closing last tab(s) in window:', skipped.join(','));
    }
    for (const id of removed) {
        console.log('[BG] Closed unnecessary tab:', id);
    }
}

/** Notify validation (EventNotAllowed) tabs that error403 pause ended so they resume seat checks instantly. */
async function notifyValidationTabError403Resume() {
    const tabs = await chrome.tabs.query({ url: '*://www.eticketing.co.uk/*' });
    const validationTabs = tabs.filter(t => t.url && t.url.includes('EDP/Validation/EventNotAllowed'));
    for (const tab of validationTabs) {
        chrome.tabs.sendMessage(tab.id, { action: 'error403Resume' }).catch(() => {});
    }
    if (validationTabs.length) console.log('[BG] Sent error403Resume to', validationTabs.length, 'validation tab(s)');
}

/** Clears BG error403 pause; optionally clears inQueueWaiting. Queue “people ahead” can set inQueueWaiting again immediately. */
async function endError403PauseFromQueueOrToken(reason, opts) {
    const clearIw = opts && opts.clearInQueueWaiting === true;
    if (error403ResumeTimerId != null) {
        clearTimeout(error403ResumeTimerId);
        error403ResumeTimerId = null;
    }
    error403PauseUntil = 0;
    const payload = { error403PauseUntil: 0 };
    if (clearIw) {
        lastSetQueueWaitingAt = 0;
        payload.inQueueWaiting = false;
    }
    await chrome.storage.local.set(payload);
    if ((reason || '').toLowerCase().includes('event tab verification token ready')) {
        await chrome.storage.local.set({
            [HD_QUEUE_ERROR403_RECOVERY_STEP_KEY]: 0,
            [HD_QUEUE_ERROR403_RECOVERY_CYCLE_INDEX_KEY]: 0,
            [HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]: 0
        });
        resetHdQueueReloadCounters('event page loaded successfully (verification token ready)');
        console.log(
            '[BG] hdQueueError403RecoveryStep/reset cycle + BotDetect captcha count to 0 (event tab verification token ready)'
        );
    }
    console.log('[BG] error403 pause ended:', reason || '(no reason)');
    await notifyValidationTabError403Resume();
}

/** Runs every 2 min (alarm). Ensures validation tab exists; prunes extra managed tabs. Does not open event tab (opened on demand via refreshEventTab / openOrFocusTabs / error403 resume). */
async function checkValidationTabAndPruneEticketingTabs() {
    if (await accountRestrictedBlackoutStopActive()) {
        console.log('[BG] checkValidationTab: skipped — account restricted blackout stop');
        return;
    }
    if (await eventRestrictedStopActive()) {
        console.log('[BG] checkValidationTab: skipped — event restricted stop');
        return;
    }
    if (await isBrowsingPauseSystemHoldActive()) {
        console.log('[BG] checkValidationTab: skipped — browsing pause recovery/cooldown active');
        return;
    }
    if (lastStatus !== 'on') return;
    const { error403PauseUntil: stored403 = 0 } = await chrome.storage.local.get('error403PauseUntil');
    const until403 = Number(stored403) || 0;
    const pausedForError403 = Date.now() < error403PauseUntil || (until403 > 0 && Date.now() < until403);
    if (pausedForError403) {
        const pauseEndsAt = new Date(Math.max(error403PauseUntil || 0, until403 || 0)).toLocaleTimeString();
        console.log('[BG] checkValidationTab: skip validation-tab check while error403 pause is active (ends at ' + pauseEndsAt + ').');
        await closeOtherEticketingTabs();
        return;
    }
    if (await isQueueItActive()) {
        console.log('[BG] checkValidationTab: Queue-IT active — skip create/reload of validation tab (health/API monitoring paused).');
        return;
    }
    if (!(await isEventPageReady())) {
        console.log(
            '[BG] checkValidationTab: eventPageReady not set — skip validation create (wait for event Index token)'
        );
        await closeOtherEticketingTabs();
        return;
    }
    const { eventUrl } = await chrome.storage.local.get(['eventUrl']);
    if (!eventUrl || openOrFocusTabsInProgress) {
        await closeOtherEticketingTabs();
        return;
    }
    let validationUrl = (EVENT_NOT_ALLOWED_URL || '').trim();
    if (!validationUrl && EVENT_URL) {
        const clubName = clubNameFromEventUrl(EVENT_URL);
        if (clubName) {
            validationUrl = `https://www.eticketing.co.uk/${clubName}/EDP/Validation/EventNotAllowed?eventId=4&reason=EventArchived`;
        }
    }
    if (validationUrl) {
        await openOrReloadValidationTab(validationUrl, { reloadIfExists: false });
    }
    await closeOtherEticketingTabs();
}

/** Public name kept for messages; all work goes through ensureEventTabFromBackground (serialized). */
async function refreshEventTab() {
    if (await accountRestrictedBlackoutStopActive()) {
        console.log('[BG] refreshEventTab skipped — account restricted blackout stop');
        return { success: false, skipped: true, message: 'account restricted blackout stop' };
    }
    if (await eventRestrictedStopActive()) {
        console.log('[BG] refreshEventTab skipped — event restricted stop');
        return { success: false, skipped: true, message: 'event restricted stop' };
    }
    if (await isBrowsingPauseSystemHoldActive()) {
        console.log('[BG] refreshEventTab skipped — browsing pause recovery/cooldown active');
        return { success: false, skipped: true, message: 'browsing pause recovery/cooldown' };
    }
    const { eventUrl } = await chrome.storage.local.get('eventUrl');
    const u = (EVENT_URL || eventUrl || '').trim();
    return ensureEventTabFromBackground(u || eventUrl, { forceReload: true });
}


async function fetchSheetConfigAll(sheetUrl) {
    if (!sheetUrl) throw new Error('no sheetUrl');
    const m = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!m) throw new Error('invalid sheet url');
    const sheetId = m[1];
    let gidMatch = sheetUrl.match(/[?&]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : '0';

    const gviz = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&gid=${gid}`;
    const res = await fetch(gviz);
    const txt = await res.text();
    const jsonText = txt.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1');
    const obj = JSON.parse(jsonText);
    const table = obj.table;
    if (!table || !table.rows || !table.cols) throw new Error('unexpected sheet gviz format');

    const headers = table.cols.map(c =>
        (c.label || '').toString().trim().toLowerCase().replace(/\s+/g, '')
    );

    const allRows = table.rows.map(row => {
        const values = (row.c || []).map(cell => cell ? cell.v : '');
        const map = {};

        headers.forEach((h, i) => {
            map[h] = values[i];
        });

        // {
        //     "status": "off",
        //     "discordwebhookurl": "https://discord.com/api/webhooks/1371776918407483403/i0PZw3JR5Ypuw1bmoYrPGrbf9US4eXD8S1W-FSEarQ0EvVWn2iX8VIXRyzgBcQ96S1br",
        //     "telegrambottoken": "123456789:ABCDEFghijkLmnoPQrstUVwxYZ",
        //     "telegramchatid": 987654321,
        //     "eventurl": "https://www.eticketing.co.uk/arsenal/EDP/Event/Index/3674",
        //     "areseatstogether": false,
        //     "quantity": 1,
        //     "startsecond": 3,
        //     "eventid": 3674,
        //     "maximumprice": 10000000,
        //     "minimumprice": 0
        // }
        return {
            status: (map['status'] || '').toString().toLowerCase(),
            discordWebhook: map['discordwebhookurl'] || map['discordwebhook'] || '',
            telegramWebhook: map['telegrambottoken'] || map['telegramwebhook'] || map['telegramtoken'] || '',
            telegramChatId: map['telegramchatid'] || map['telegramchat'] || '',
            eventUrl: map['eventurl'] || '',
            areSeatsTogether: String(map['areseatstogether']).toLowerCase() === 'true',
            quantity: parseInt(map['quantity'] || '1', 10),
            startSecond: (() => { const v = parseFloat(map['startsecond']); return Number.isNaN(v) ? 1 : v; })(),
            eventId: map['eventid'] || '',
            maximumPrice: map['maximumprice'] || '',
            minimumPrice: map['minimumprice'] || '',
            loginEmail: map['loginemail'] || '',
            loginPassword: map['loginpassword'] || '',
            ignoreClubLevel: map['ignoreclublevel'] || '',
            ignoreUpperTier: map['ignoreuppertier'] || '',
            resaleEndpointChances: (() => {
                const raw = map['resaleendpointchances'];
                if (raw === '' || raw == null) return null;
                const v = parseFloat(String(raw).replace(/%/g, '').trim());
                if (!Number.isFinite(v)) return null;
                return Math.min(100, Math.max(0, v));
            })(),
            pairCheckChance: parsePairCheckChanceFromSheetMap(map),
            focusRefreshTab: focusRefreshTabFromSheetMap(map)
        };
    });

    return allRows;
}

// async function fetchSheetConfig(sheetUrl) {
//     if (!sheetUrl) throw new Error('no sheetUrl');
//     // parse sheetId and gid if present
//     const m = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
//     if (!m) throw new Error('invalid sheet url');
//     const sheetId = m[1];
//     // try to find gid
//     let gidMatch = sheetUrl.match(/[?&]gid=(\d+)/);
//     const gid = gidMatch ? gidMatch[1] : '0';
//     const gviz = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&gid=${gid}`;
//     const res = await fetch(gviz);
//     const txt = await res.text();
//     // strip wrapper
//     const jsonText = txt.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1');
//     const obj = JSON.parse(jsonText);
//     const table = obj.table;
//     if (!table || !table.rows || !table.cols) throw new Error('unexpected sheet gviz format');
//     // build header -> index map
//     const headers = table.cols.map(c => (c.label || '').toString().trim());
//     const row = table.rows[0] || {c: []};
//     const values = (row.c || []).map(cell => cell ? cell.v : '');
//     // map keys by fuzzy name
//     const map = {};
//     headers.forEach((h, i) => {
//         const key = (h || '').toLowerCase().replace(/\s+/g, '');
//         map[key] = values[i];
//     });
//
//     // helpers to pick
//     function findKeyContains(...pieces) {
//         for (const k of Object.keys(map)) {
//             if (pieces.every(p => k.includes(p.toLowerCase()))) return k;
//         }
//         return null;
//     }
//
//     const statusKey = findKeyContains('status') || findKeyContains('onoff') || findKeyContains('state');
//     const discordKey = findKeyContains('discord');
//     const telegramKey = findKeyContains('telegram');
//     const eventUrlKey = findKeyContains('event', 'url') || findKeyContains('event');
//     const areTogetherKey = findKeyContains('areseatstogether') || findKeyContains('seatstogether') || findKeyContains('arestogether');
//     const quantityKey = findKeyContains('quantity') || findKeyContains('qty');
//     const startSecondKey = findKeyContains('StartSecond') || findKeyContains('qty');
//
//     return {
//         status: statusKey ? (map[statusKey] || '') : '',
//         discordWebhook: discordKey ? (map[discordKey] || '') : '',
//         telegramWebhook: telegramKey ? (map[telegramKey] || '') : '',
//         eventUrl: eventUrlKey ? (map[eventUrlKey] || '') : '',
//         areSeatsTogether: areTogetherKey ? (map[areTogetherKey] || 'false') : 'false',
//         quantity: quantityKey ? parseInt(map[quantityKey] || '1', 10) : 1,
//         startSecond: startSecondKey ? parseInt(map[startSecondKey] || '1', 10) : 1
//     };
// }

async function sendErrorWebhook(errorWebhook, message, payload) {
    console.log('[BG] sendErrorWebhook', {errorWebhook, message});
    try {
        if (errorWebhook) {
            const separator = '\n\n────────────────────────────────────────';
            const msg = String(message || '');
            const content = msg.endsWith(separator) ? msg : (msg + separator);
            await fetch(errorWebhook, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({content, embeds: []})
            });
            console.log('[BG] error webhook sent to:', errorWebhook);
        }
    } catch (e) {
        console.warn('[BG] error webhook send failed', e);
    }
}

// Default Discord webhook for success notifications.
// If Google Sheet uses the same URL, we still send exactly once (no duplicates, no missing notifications).
const DEFAULT_SUCCESS_DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1371776918407483403/i0PZw3JR5Ypuw1bmoYrPGrbf9US4eXD8S1W-FSEarQ0EvVWn2iX8VIXRyzgBcQ96S1br';

async function sendWebhooks(discordWebhook, telegramBotToken, telegramChatId, message, payload) {
    const botToken = (telegramBotToken || '').trim();
    const chatId = telegramChatId != null && String(telegramChatId).trim() !== '' ? String(telegramChatId).trim() : '';
    console.log('[BG] sendWebhooks called', {
        discordWebhook: !!discordWebhook,
        telegramBotToken: !!botToken,
        telegramChatId: !!chatId,
        messageLength: message.length
    });
    const discordBody = JSON.stringify({content: message, embeds: []});

    // Build a unique set of Discord webhook targets (default + optional sheet webhook).
    const targets = new Set();
    if (DEFAULT_SUCCESS_DISCORD_WEBHOOK) targets.add(DEFAULT_SUCCESS_DISCORD_WEBHOOK);
    if (discordWebhook && discordWebhook.trim()) targets.add(discordWebhook.trim());

    // Send once to each unique Discord webhook URL.
    for (const url of targets) {
        try {
            console.log('[BG] Sending to Discord webhook:', url === DEFAULT_SUCCESS_DISCORD_WEBHOOK ? 'default' : url);
            await fetch(url, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: discordBody
            });
            console.log('[BG] Discord webhook sent:', url === DEFAULT_SUCCESS_DISCORD_WEBHOOK ? 'default' : url);
    } catch (e) {
            console.warn('[BG] Discord webhook send failed for', url, e);
        }
    }
    if (botToken && chatId) {
        try {
            const maxLen = 4090;
            const text = message.length > maxLen ? message.slice(0, maxLen) + '\n…' : message;
            const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
            const res = await fetch(url, {
                    method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || body.ok === false) {
                console.warn('[BG] Telegram sendMessage failed', res.status, body.description || body);
            } else {
                console.log('[BG] Telegram sendMessage ok');
        }
    } catch (e) {
        console.warn('[BG] telegram send failed', e);
        }
    } else if (botToken || chatId) {
        console.log('[BG] Telegram skipped — need both TelegramBotToken and TelegramChatID in sheet (one is empty).');
    }
}

// Simplified heartbeat tracking - no tab-specific tracking
const HEARTBEAT_CHECK_INTERVAL = 10000; // check every 10 seconds
const INITIAL_HEARTBEAT_TIMEOUT = 180000; // 3 minutes for initial heartbeat
const SUBSEQUENT_HEARTBEAT_TIMEOUT = 120000; // 2 minutes for subsequent heartbeats

let lastHeartbeat = null; // store last heartbeat timestamp
let isFirstHeartbeat = true; // track if this is the first heartbeat received
let heartbeatMonitoringPaused = false; // track if heartbeat monitoring is paused

// Call this whenever you receive a heartbeat
function updateHeartbeat() {
    const now = Date.now();
    lastHeartbeat = now;
    
    if (isFirstHeartbeat) {
        console.log("[BG] 💓 First heartbeat received, switching to 2-minute timeout");
        isFirstHeartbeat = false;
    } else {
    console.log("[BG] 💓 Heartbeat received");
    }
}

setInterval(async () => {
    const now = Date.now();
    
    // During error403 wait, skip heartbeat reload so we only retry after our set minutes
    if (now < error403PauseUntil) {
        return;
    }

    if (await isBrowsingPauseSystemHoldActive()) {
        // Keep countdown frozen while browsing-pause recovery / 10 min cooldown runs
        lastHeartbeat = now;
        if (!browsingPauseSystemHoldLogged) {
            // hold flag may be set without enter() log (storage/title only)
            browsingPauseSystemHoldLogged = true;
            console.warn('[BG] ⏸️ Heartbeat monitoring frozen — browsing pause recovery/cooldown active');
        }
        return;
    }

    // Queue-IT active: freeze health check so we do not recreate validation/event tabs mid-queue
    if (await isQueueItActive()) {
        lastHeartbeat = now;
        if (now % 30000 < HEARTBEAT_CHECK_INTERVAL) {
            console.log('[BG] ⏸️ Heartbeat health check frozen — Queue-IT active (no validation tab create/reload)');
        }
        return;
    }
    
    // Pause heartbeat monitoring when status is off
    if (lastStatus === "off") {
        if (!heartbeatMonitoringPaused) {
            console.log("[BG] ⏸️ Heartbeat monitoring paused (status is off)");
            heartbeatMonitoringPaused = true;
            // Reset heartbeat tracking when pausing
            lastHeartbeat = null;
            isFirstHeartbeat = true;
        }
        return;
    }
    
    // Resume heartbeat monitoring when status is on
    if (heartbeatMonitoringPaused && lastStatus === "on") {
        console.log("[BG] ▶️ Heartbeat monitoring resumed (status is on)");
        heartbeatMonitoringPaused = false;
    }
    
    // Determine timeout based on whether we've received first heartbeat
    const timeoutMs = isFirstHeartbeat ? INITIAL_HEARTBEAT_TIMEOUT : SUBSEQUENT_HEARTBEAT_TIMEOUT;
    const timeoutMinutes = timeoutMs / 60000;
    const timeoutType = isFirstHeartbeat ? "initial" : "subsequent";

    // If no heartbeat ever received, initialize the countdown
    if (!lastHeartbeat) {
        lastHeartbeat = now; // Start the countdown from now
        console.log(`[BG] ⚠️ No heartbeat yet, starting ${timeoutMinutes}-minute ${timeoutType} timeout countdown`);
        return;
    }

    const timeSinceLast = now - lastHeartbeat;

    if (timeSinceLast > timeoutMs) {
        console.log(`[BG] ⚠️ Heartbeat timeout (${timeoutType}), last at ${new Date(lastHeartbeat).toLocaleTimeString()}`);
        console.log(`[BG] Time since last heartbeat: ${Math.round(timeSinceLast / 1000)}s (timeout: ${timeoutMinutes}min)`);

            console.log(`[BG] 🔄 No heartbeat for ${timeoutMinutes} minutes, reloading tabs...`);
        
        // Reset heartbeat tracking and cycle
        lastHeartbeat = null;
        isFirstHeartbeat = true;
        
            await openOrFocusTabs(EVENT_URL, EVENT_NOT_ALLOWED_URL);
        console.log("[BG] ✅ Tabs reloaded, heartbeat tracking reset to initial 3-minute cycle");
    } else {
        if (timeSinceLast % 30000 < HEARTBEAT_CHECK_INTERVAL) {
            console.log(`[BG] ✅ Heartbeat OK (${Math.round(timeSinceLast / 1000)}s ago, ${timeoutType} timeout: ${timeoutMinutes}min)`);
        }
    }
}, HEARTBEAT_CHECK_INTERVAL);


/**
 * "Your Browsing Activity Has Been Paused" recovery (shared by title poll + content message):
 * wait 60s → reload; after 3 reloads → clear cookies + reload;
 * if still paused after cookie clear → wait 10 minutes before resuming recovery.
 * While recovery/cooldown is active, heartbeat + openOrFocusTabs + event/validation refresh stay frozen.
 * One wait/cooldown timer per tab (avoids stacking).
 */
const browsingPauseStateByTab = new Map();
const BROWSING_PAUSE_WAIT_MS = 60000;
const BROWSING_PAUSE_POST_COOKIE_COOLDOWN_MS = 10 * 60 * 1000;

function tabTitleIsBrowsingPaused(title) {
    return !!(title && String(title).toLowerCase().includes('your browsing activity'));
}

function browsingPauseMemoryHoldActive() {
    for (const s of browsingPauseStateByTab.values()) {
        if (!s) continue;
        if (s.waiting || s.cookiesClearedPendingCheck || s.reloadCount > 0) return true;
        if (s.cooldownUntil > Date.now()) return true;
    }
    return false;
}

async function isBrowsingPauseSystemHoldActive() {
    if (browsingPauseMemoryHoldActive()) return true;
    const snap = await chrome.storage.local.get([
        BROWSING_PAUSE_SYSTEM_HOLD_KEY,
        BROWSING_PAUSE_COOLDOWN_UNTIL_KEY,
        BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY
    ]);
    if (snap[BROWSING_PAUSE_SYSTEM_HOLD_KEY] === true) return true;
    if (Number(snap[BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]) > Date.now()) return true;
    if (snap[BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY] != null) return true;
    try {
        const tabs = await chrome.tabs.query({ url: '*://www.eticketing.co.uk/*' });
        if ((tabs || []).some((t) => tabTitleIsBrowsingPaused(t.title))) return true;
    } catch (_) {}
    return false;
}

async function enterBrowsingPauseSystemHold(reason) {
    await chrome.storage.local.set({ [BROWSING_PAUSE_SYSTEM_HOLD_KEY]: true });
    // Freeze heartbeat countdown so we do not timeout-reload validation/event tabs mid-recovery
    lastHeartbeat = Date.now();
    if (!browsingPauseSystemHoldLogged) {
        browsingPauseSystemHoldLogged = true;
        console.warn(
            '[BG] ⏸️ System hold ON (browsing pause) — heartbeat / openOrFocusTabs / event refresh frozen.',
            reason || ''
        );
    }
}

async function exitBrowsingPauseSystemHoldIfSafe(reason) {
    if (browsingPauseMemoryHoldActive()) return false;
    const snap = await chrome.storage.local.get([
        BROWSING_PAUSE_COOLDOWN_UNTIL_KEY,
        BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY
    ]);
    if (Number(snap[BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]) > Date.now()) return false;
    if (snap[BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY] != null) return false;
    try {
        const tabs = await chrome.tabs.query({ url: '*://www.eticketing.co.uk/*' });
        if ((tabs || []).some((t) => tabTitleIsBrowsingPaused(t.title))) return false;
    } catch (_) {}
    await chrome.storage.local.set({ [BROWSING_PAUSE_SYSTEM_HOLD_KEY]: false });
    if (browsingPauseSystemHoldLogged) {
        browsingPauseSystemHoldLogged = false;
        lastHeartbeat = Date.now();
        isFirstHeartbeat = true;
        console.log(
            '[BG] ▶️ System hold OFF (browsing pause cleared) — heartbeat / tab ops resumed.',
            reason || ''
        );
    }
    return true;
}

function getBrowsingPauseState(tabId) {
    let s = browsingPauseStateByTab.get(tabId);
    if (!s) {
        s = {
            waiting: false,
            reloadCount: 0,
            timerId: null,
            postCookieGraceTimerId: null,
            cookiesClearedPendingCheck: false,
            cooldownUntil: 0
        };
        browsingPauseStateByTab.set(tabId, s);
    }
    return s;
}

function reloadAfterBrowsingPause(tabId, state) {
    if (state.reloadCount >= 3) {
        console.warn(
            `[BG] Browsing pause still present after ${state.reloadCount} reloads on tab ${tabId} — clearing eticketing cookies then reloading`
        );
        state.reloadCount = 0;
        state.cookiesClearedPendingCheck = true;
        chrome.storage.local.set({ [BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY]: tabId });
        // If pause does not return soon, cookie clear worked — drop the pending flag.
        if (state.postCookieGraceTimerId != null) clearTimeout(state.postCookieGraceTimerId);
        state.postCookieGraceTimerId = setTimeout(() => {
            state.postCookieGraceTimerId = null;
            if (!state.cookiesClearedPendingCheck) return;
            if (state.cooldownUntil > Date.now()) return;
            state.cookiesClearedPendingCheck = false;
            chrome.storage.local.set({ [BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY]: null });
            console.log('[BG] Browsing pause did not return after cookie clear — pending flag cleared for tab', tabId);
            void exitBrowsingPauseSystemHoldIfSafe('cookie clear succeeded');
        }, 120000);
        clearEticketingCookiesOnly(() => {
            chrome.tabs.reload(tabId, () => {
                if (chrome.runtime.lastError) {
                    console.warn('[BG] reload after cookie clear failed:', chrome.runtime.lastError.message);
                } else {
                    console.log('[BG] Reloaded tab after cookie clear; if pause persists next detect → 10 min cooldown');
                }
            });
        });
        return;
    }
    state.reloadCount += 1;
    console.warn(`[BG] Browsing pause still present on tab ${tabId} — reload ${state.reloadCount}/3`);
    chrome.tabs.reload(tabId, () => {
        if (chrome.runtime.lastError) {
            console.warn('[BG] browsing-pause reload failed:', chrome.runtime.lastError.message);
        }
    });
}

async function startPostCookieBrowsingPauseCooldown(tabId, state) {
    const until = Date.now() + BROWSING_PAUSE_POST_COOKIE_COOLDOWN_MS;
    state.cooldownUntil = until;
    state.waiting = false;
    state.cookiesClearedPendingCheck = false;
    state.reloadCount = 0;
    if (state.timerId != null) {
        clearTimeout(state.timerId);
        state.timerId = null;
    }
    if (state.postCookieGraceTimerId != null) {
        clearTimeout(state.postCookieGraceTimerId);
        state.postCookieGraceTimerId = null;
    }
    await chrome.storage.local.set({
        [BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]: until,
        [BROWSING_PAUSE_COOLDOWN_TAB_KEY]: tabId,
        [BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY]: null
    });
    chrome.alarms.create(BROWSING_PAUSE_COOLDOWN_ALARM, { when: until });
    await enterBrowsingPauseSystemHold('post-cookie 10 min cooldown tab ' + tabId);
    console.warn(
        `[BG] Browsing pause still present after cookie clear on tab ${tabId} — waiting 10 minutes before resume (until ${new Date(until).toLocaleTimeString()})`
    );
}

async function finishPostCookieBrowsingPauseCooldown(reason) {
    const { [BROWSING_PAUSE_COOLDOWN_TAB_KEY]: tabId } = await chrome.storage.local.get(
        BROWSING_PAUSE_COOLDOWN_TAB_KEY
    );
    await chrome.storage.local.set({
        [BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]: 0,
        [BROWSING_PAUSE_COOLDOWN_TAB_KEY]: null,
        [BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY]: null
    });
    chrome.alarms.clear(BROWSING_PAUSE_COOLDOWN_ALARM);
    console.log('[BG] Browsing-pause 10 min cooldown ended:', reason || '(no reason)', tabId != null ? '(tab ' + tabId + ')' : '');
    if (tabId == null) {
        await exitBrowsingPauseSystemHoldIfSafe('cooldown ended (no tab)');
        return;
    }
    const state = getBrowsingPauseState(tabId);
    state.cooldownUntil = 0;
    state.cookiesClearedPendingCheck = false;
    state.reloadCount = 0;
    state.waiting = false;
    try {
        await chrome.tabs.get(tabId);
        chrome.tabs.reload(tabId, () => {
            if (chrome.runtime.lastError) {
                console.warn('[BG] cooldown-end reload failed:', chrome.runtime.lastError.message);
            } else {
                console.log('[BG] Reloaded tab after 10 min browsing-pause cooldown:', tabId);
            }
            void exitBrowsingPauseSystemHoldIfSafe('cooldown ended + reloaded');
        });
    } catch (_) {
        browsingPauseStateByTab.delete(tabId);
        console.warn('[BG] Cooldown tab gone; nothing to reload:', tabId);
        await exitBrowsingPauseSystemHoldIfSafe('cooldown ended (tab gone)');
    }
}

function noteBrowsingActivityPausedTab(tabId, source) {
    if (tabId == null) return;
    const state = getBrowsingPauseState(tabId);
    if (state.cooldownUntil > Date.now()) {
        return; // already in 10 min post-cookie cooldown
    }
    // Storage may outlive SW memory after sleep
    chrome.storage.local.get(
        [BROWSING_PAUSE_COOLDOWN_UNTIL_KEY, BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY],
        (snap) => {
            const until = Number(snap[BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]) || 0;
            if (until > Date.now()) {
                state.cooldownUntil = until;
                return;
            }
            if (snap[BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY] === tabId) {
                state.cookiesClearedPendingCheck = true;
            }
            noteBrowsingActivityPausedTabContinue(tabId, source, state);
        }
    );
}

function noteBrowsingActivityPausedTabContinue(tabId, source, state) {
    if (state.waiting) return;

    // Pause returned after we already cleared cookies + reloaded → 10 min cooldown before trying again
    if (state.cookiesClearedPendingCheck) {
        void startPostCookieBrowsingPauseCooldown(tabId, state);
        return;
    }

    state.waiting = true;
    void enterBrowsingPauseSystemHold('tab ' + tabId + ' via ' + (source || 'poll'));
    const fromContent = source === 'content-script';
    console.log(
        `[BG] Browsing-activity pause on tab ${tabId} via ${source || 'poll'} (reload count ${state.reloadCount}/3), waiting ${BROWSING_PAUSE_WAIT_MS / 1000}s...`
    );
    state.timerId = setTimeout(() => {
        state.timerId = null;
        state.waiting = false;
        chrome.tabs.get(tabId, (updatedTab) => {
            if (chrome.runtime.lastError || !updatedTab) {
                browsingPauseStateByTab.delete(tabId);
                void exitBrowsingPauseSystemHoldIfSafe('paused tab closed');
                return;
            }
            const titlePaused = tabTitleIsBrowsingPaused(updatedTab.title);
            if (titlePaused) {
                reloadAfterBrowsingPause(tabId, state);
                return;
            }
            if (!fromContent) {
                console.log(`[BG] Browsing pause cleared on tab ${tabId}, no reload.`);
                state.reloadCount = 0;
                state.cookiesClearedPendingCheck = false;
                void exitBrowsingPauseSystemHoldIfSafe('title cleared after wait');
                return;
            }
            // Content reported body/title pause — confirm with content script (title alone may be fine)
            chrome.tabs.sendMessage(tabId, { action: 'isBrowsingActivityPaused' }, (resp) => {
                if (chrome.runtime.lastError) {
                    console.warn('[BG] isBrowsingActivityPaused probe failed:', chrome.runtime.lastError.message);
                    state.reloadCount = 0;
                    void exitBrowsingPauseSystemHoldIfSafe('probe failed / assume clear');
                    return;
                }
                if (resp && resp.paused) {
                    reloadAfterBrowsingPause(tabId, state);
                } else {
                    console.log(`[BG] Content reports browsing pause cleared on tab ${tabId}`);
                    state.reloadCount = 0;
                    state.cookiesClearedPendingCheck = false;
                    void exitBrowsingPauseSystemHoldIfSafe('content reports clear');
                }
            });
        });
    }, BROWSING_PAUSE_WAIT_MS);
}

function monitorBrowsingActivityTabs() {
    const CHECK_INTERVAL = 5000;

    setInterval(() => {
        chrome.tabs.query({ url: '*://www.eticketing.co.uk/*' }, (tabs) => {
            if (chrome.runtime.lastError) return;
            const seen = new Set();
            for (const tab of tabs || []) {
                if (tab.id == null) continue;
                seen.add(tab.id);
                if (!tabTitleIsBrowsingPaused(tab.title)) {
                    const s = browsingPauseStateByTab.get(tab.id);
                    // Do NOT zero reloadCount on a brief healthy title during recovery (would restart 0/3).
                    // Only try releasing system hold when this tab is idle (no wait / pending / cooldown / mid-count).
                    if (
                        s &&
                        !s.waiting &&
                        !s.cookiesClearedPendingCheck &&
                        !(s.cooldownUntil > Date.now()) &&
                        s.reloadCount === 0
                    ) {
                        void exitBrowsingPauseSystemHoldIfSafe('all titles healthy');
                    }
                    continue;
                }
                noteBrowsingActivityPausedTab(tab.id, 'title-poll');
            }
            for (const id of [...browsingPauseStateByTab.keys()]) {
                if (!seen.has(id)) {
                    const s = browsingPauseStateByTab.get(id);
                    // Keep cooldown state even if tab briefly missing; only drop idle entries
                    if (s && s.timerId != null) clearTimeout(s.timerId);
                    if (s && (s.cooldownUntil > Date.now() || s.cookiesClearedPendingCheck)) {
                        s.waiting = false;
                        s.timerId = null;
                        continue;
                    }
                    browsingPauseStateByTab.delete(id);
                }
            }
        });
    }, CHECK_INTERVAL);
}

// Start monitoring when extension loads
monitorBrowsingActivityTabs();

//
// function startContinuousTabMonitor(eventUrl) {
//     setInterval(async () => {
//         try {
//             const tabs = await chrome.tabs.query({url: '*://www.eticketing.co.uk/*'});
//
//             // Find the event tab & EventNotAllowed tab
//             let foundEventTab = tabs.find(t => eventUrl && t.url && t.url.startsWith(eventUrl));
//             let foundNotAllowed = tabs.find(t => t.url && t.url.startsWith(EVENT_NOT_ALLOWED_URL));
//
//             // Create/focus event tab if missing
//             if (!foundEventTab && eventUrl) {
//                 const created = await chrome.tabs.create({url: eventUrl, active: false});
//                 eventTabId = created.id;
//                 console.log('[BG] Created missing event tab:', eventTabId);
//             } else if (foundEventTab) {
//                 eventTabId = foundEventTab.id;
//             }
//
//             // Create/focus not allowed tab if missing
//             if (!foundNotAllowed) {
//                 const created2 = await chrome.tabs.create({url: EVENT_NOT_ALLOWED_URL, active: false});
//                 notAllowedTabId = created2.id;
//                 console.log('[BG] Created missing EventNotAllowed tab:', notAllowedTabId);
//             } else {
//                 notAllowedTabId = foundNotAllowed.id;
//             }
//
//             // Close all other eticketing tabs except allowed ones
//             const allowedUrls = [
//                 ...(eventUrl ? [eventUrl] : []),
//                 EVENT_NOT_ALLOWED_URL
//             ];
//             for (const t of tabs) {
//                 if (!allowedUrls.some(u => t.url && t.url.startsWith(u))) {
//                     await chrome.tabs.remove(t.id);
//                     console.log('[BG] Closed extra tab:', t.url);
//                 }
//             }
//         } catch (err) {
//             console.error('[BG] Tab monitor error:', err);
//         }
//     }, 30000); // runs every 5 seconds
// }

// Initialize continuous tab monitoring
chrome.runtime.onInstalled.addListener(() => {
    console.log('[BG] Extension installed, starting continuous tab monitor');
    startPolling(); // Start polling Google Sheet
    // startContinuousTabMonitor(EVENT_URL); // Uncomment if you want to enable continuous tab monitoring
});
// // Handle extension updates
// chrome.runtime.onUpdateAvailable.addListener(() => {
//     console.log('[BG] Extension updated, restarting continuous tab monitor');
//     startContinuousTabMonitor(EVENT_URL);
// });
// // Handle extension startup
// chrome.runtime.onStartup.addListener(() => {
//     console.log('[BG] Extension started, restarting continuous tab monitor');
//     startContinuousTabMonitor(EVENT_URL);
// });


