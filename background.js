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

/** Post-success placeholder tab (see content.js `openNewTab`); close all such tabs left on this URL ≥12 min. */
const BASKET_PLACEHOLDER_TAB_URL_PREFIX = 'https://www.exampleticketsbasketaddedinthiswindow.com';
const BASKET_PLACEHOLDER_MAX_MS = 12 * 60 * 1000;
const basketPlaceholderTabOpenedAt = new Map(); // tabId -> ms when URL first matched

function tabMatchesBasketPlaceholderUrl(url) {
    if (!url) return false;
    return url.toLowerCase().startsWith(BASKET_PLACEHOLDER_TAB_URL_PREFIX);
}

console.log('[BG] Background loaded');
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

// On extension/background start, clear the flag so we never start with a stale true from a previous session
lastSetQueueWaitingAt = 0;
chrome.storage.local.set({ inQueueWaiting: false });
console.log('[BG] Queue waiting flag cleared on start');

/** Clear 403 pause timer, counts, and storage so reload / sheet-on never inherits stale queue-403 state. */
async function resetError403State(reason) {
    if (error403ResumeTimerId != null) {
        clearTimeout(error403ResumeTimerId);
        error403ResumeTimerId = null;
    }
    error403PauseUntil = 0;
    await chrome.storage.local.set({ error403PauseUntil: 0, error403Count: 0 });
    console.log('[BG] error403 state reset:', reason || '(no reason)');
}

void resetError403State('extension / background started');

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
    } else if (alarm.name === CHECK_VALIDATION_TAB_ALARM) {
        checkValidationTabAndPruneEticketingTabs()
            .catch(e => console.warn('[BG] checkValidationTabAndPruneEticketingTabs error:', e));
    }
});

/** Tab IDs → timeout id: close event tab N ms after verification token is saved (memory saver). */
const eventTabPostTokenCloseTimers = new Map();

function scheduleCloseEventTabAfterTokenSave(tabId, delayMs) {
    const existing = eventTabPostTokenCloseTimers.get(tabId);
    if (existing != null) clearTimeout(existing);
    const tid = setTimeout(() => {
        eventTabPostTokenCloseTimers.delete(tabId);
        chrome.tabs.remove(tabId).then(() => {
            console.log('[BG] Closed event tab after token-save delay (memory saver):', tabId);
            if (eventTabId === tabId) eventTabId = null;
        }).catch((e) => console.warn('[BG] tabs.remove after token delay failed:', tabId, e && e.message));
    }, delayMs);
    eventTabPostTokenCloseTimers.set(tabId, tid);
}

chrome.tabs.onRemoved.addListener((tabId) => {
    basketPlaceholderTabOpenedAt.delete(tabId);
    const t = eventTabPostTokenCloseTimers.get(tabId);
    if (t != null) {
        clearTimeout(t);
        eventTabPostTokenCloseTimers.delete(tabId);
    }
    if (tabId === eventTabId) eventTabId = null;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = tab.url || '';
    if (!url) return;
    if (tabMatchesBasketPlaceholderUrl(url)) {
        if (!basketPlaceholderTabOpenedAt.has(tabId)) {
            basketPlaceholderTabOpenedAt.set(tabId, Date.now());
        }
    } else {
        basketPlaceholderTabOpenedAt.delete(tabId);
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

// Run immediately when background script loads
ensurePolling();
void syncTwoCaptchaKeyFromPublicSheet();

// Run when extension is installed or updated
chrome.runtime.onInstalled.addListener((details) => {
    console.log('[BG] onInstalled triggered:', details.reason);
    ensurePolling();
    void syncTwoCaptchaKeyFromPublicSheet();
});

// Run when Chrome starts and extension wakes up
chrome.runtime.onStartup.addListener(() => {
    console.log('[BG] onStartup triggered');
    ensurePolling();
    void syncTwoCaptchaKeyFromPublicSheet();
});

// Also re-start if extension is re-enabled after being disabled
chrome.management.onEnabled.addListener((ext) => {
    if (ext.id === chrome.runtime.id) {
        console.log('[BG] Extension re-enabled');
        ensurePolling();
        void syncTwoCaptchaKeyFromPublicSheet();
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
    if (msg.action === "clearCookiesAndRefresh") {
        // Only clear when content script (queue-it or eticketing page) sends the message, not popup
        if (!sender.tab) {
            console.log('[BG] clearCookiesAndRefresh ignored - request from popup, only content script can trigger clear');
            sendResponse({ success: false, message: 'Only content script can request clear cookies' });
            return false;
        }
        console.log('[BG] clearCookiesAndRefresh requested from content script', sender.tab.url);
        chrome.cookies.getAll({}, function (cookies) {
            cookies.forEach(cookie => {
                chrome.cookies.remove({
                    url: `https://${cookie.domain}${cookie.path}`,
                    name: cookie.name
                }, () => {
                    console.log(`[BG] Cookie cleared: ${cookie.name}`);
                });
            });
            sendResponse({ success: true, message: 'Cookies cleared successfully' });
        });
        return true; // keep channel open for async response
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
        chrome.cookies.getAll({}, async function (cookies) {
            cookies.forEach(cookie => {
                chrome.cookies.remove({
                    url: `https://${cookie.domain}${cookie.path}`,
                    name: cookie.name
                }, () => {});
            });
            const { eventUrl } = await chrome.storage.local.get('eventUrl');
            if (eventUrl) {
                await chrome.tabs.update(tabId, { url: eventUrl });
                console.log('[BG] Reopened event URL in same tab:', eventUrl);
            }
            sendResponse({ success: true });
        });
        return true;
    }
    if (msg.action === 'resetError403Count') {
        chrome.storage.local.set({ error403Count: 0 });
        console.log('[BG] error403Count reset to 0 (event URL loaded)');
        sendResponse({ success: true });
        return false;
    }
    if (msg.action === 'error403Detected') {
        const tabUrl = (sender && sender.tab && sender.tab.url) || '';
        const fromHdQueue =
            msg.fromHdQueueError403 === true ||
            (tabUrl.includes('hd-queue.eticketing.co.uk') && tabUrl.toLowerCase().includes('error403'));
        const detectedAt = new Date();
        console.log('[BG] error403 detected at', detectedAt.toLocaleTimeString(), fromHdQueue ? '(hd-queue /error403 flow)' : '(legacy resume timer)');
        (async () => {
            if (error403ResumeTimerId != null) {
                clearTimeout(error403ResumeTimerId);
                error403ResumeTimerId = null;
                console.log('[BG] error403: cleared previous resume timer (single resume only)');
            }
            const { error403Count = 0 } = await chrome.storage.local.get('error403Count');
            await chrome.storage.local.set({ error403Count: error403Count + 1 });

            if (fromHdQueue) {
                const waitMsLocal = 6 * 60 * 1000;
                const pauseUntil = Date.now() + waitMsLocal;
                error403PauseUntil = pauseUntil;
                await chrome.storage.local.set({ error403PauseUntil: pauseUntil });
                console.log(
                    '[BG] hd-queue /error403: seat checks paused for up to 6 min; tab script will history.back() then clear pause on main queue URL. Occurrence #' +
                        (error403Count + 1)
                );
                return;
            }

            const waitMinutes = Math.min(ERROR403_MAX_WAIT_MINUTES, 5 + 3 * error403Count); // 5, 8, 11, … min, max 30
            const waitMs = waitMinutes * 60 * 1000;
            const pauseUntil = Date.now() + waitMs;
            const resumeAt = new Date(pauseUntil);
            error403PauseUntil = pauseUntil;
            await chrome.storage.local.set({ error403PauseUntil: pauseUntil });
            console.log(
                `[BG] error403: detected at ${detectedAt.toLocaleTimeString()}; occurrence #${error403Count + 1}, will resume at ${resumeAt.toLocaleTimeString()} (${waitMinutes} min wait); heartbeat and seat checks paused until then.`
            );
            error403ResumeTimerId = setTimeout(async () => {
                error403ResumeTimerId = null;
                const resumingAt = new Date();
                error403PauseUntil = 0;
                await chrome.storage.local.set({ error403PauseUntil: 0 });
                lastHeartbeat = null;
                isFirstHeartbeat = true;
                console.log('[BG] error403 resuming at', resumingAt.toLocaleTimeString());
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
                    notifyValidationTabError403Resume();
                    return;
                }
                if (!eventUrl) {
                    console.warn('[BG] error403 resume: no eventUrl in storage, skipping refresh.');
                    notifyValidationTabError403Resume();
                    return;
                }
                EVENT_URL = eventUrl;
                await chrome.storage.local.set({ inQueueWaiting: false });
                lastSetQueueWaitingAt = 0;
                console.log('[BG] error403 resume: sheet status On — ensure event tab exists (no reload; validation refresh will reload once).');
                await ensureEventTabFromBackground(eventUrl, { forceReload: false });
                notifyValidationTabError403Resume();
                console.log('[BG] error403 resume done; heartbeat reset to initial 3-minute cycle.');
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
        chrome.tabs.remove(queueTabId, () => {
            if (chrome.runtime.lastError) console.warn('[BG] close queue tab error:', chrome.runtime.lastError);
            else console.log('[BG] Queue tab closed:', queueTabId);
        });
        Promise.resolve(refreshEventTab())
            .then(() => {
                sendResponse({ success: true, message: 'Queue tab closed, event tab refreshed' });
            })
            .catch(err => {
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

        // Hardcoded error webhook URL
        const errorDiscordWebhook = 'https://discordapp.com/api/webhooks/1139641609240182884/umQxYbgmj_WMAe33xIFLYtkMbJJrjSk-zbZJeC_sP4__eJlEJsnQ9JL4qj2cNuPFPLWz';
        const payload = msg.payload || {};
        const message = msg.message || 'Error notification from Arsenal Tickets Extension';

        console.log('[BG] Sending error notification to hardcoded webhook only');
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
    await checkQueueWaitingTimeout();
    const { inQueueWaiting } = await chrome.storage.local.get('inQueueWaiting');
    if (inQueueWaiting) {
        console.log('[BG] inQueueWaiting is set - user is in queue (people ahead of you). Skipping openOrFocusTabs (no closing/creating tabs).');
        return;
    }
    openOrFocusTabsInProgress = true;
    try {
        await waitThenCloseStaleWebIdentityTabsIfPresent();

        const tabs = await chrome.tabs.query({url: '*://www.eticketing.co.uk/*'});

        console.log("event url:", eventUrl);

        // check if any tab with starting url: hd-queue.eticketing.co.uk or https://web-identity than wait for 10 seconds
        // Returns true if inQueueWaiting is set (abort openOrFocusTabs); false otherwise
        async function checkTabsAndWait() {
            const tabs = await chrome.tabs.query({});
            const matchTab = tabs.find(tab =>
                tab.url.startsWith("https://hd-queue.eticketing.co.uk/") ||
                tab.url.startsWith("http://hd-queue.eticketing.co.uk/")
            );

            if (matchTab) {
                const { inQueueWaiting } = await chrome.storage.local.get('inQueueWaiting');
                if (inQueueWaiting) {
                    console.log("[BG] Queue tab found and inQueueWaiting set - skipping wait and further actions.");
                    return true; // abort
                }
                console.log("[BG] Before re opening tabs,Matching tab found:", matchTab.url);
                console.log("[BG] Waiting 145 seconds (queue URL already open)...");

                await new Promise(resolve => setTimeout(resolve, 145000));

                console.log("[BG] 145 seconds passed, you can do something here.");
                if (Date.now() < error403PauseUntil) {
                    console.log("[BG] error403 pause active - aborting openOrFocusTabs (no tab close/reopen until resume).");
                    return true;
                }
            } else {
                console.log("[BG] No matching tab found for queue or web identity related, ignoring");
            }
            return false;
        }

        // check if queue or web identity tabs still there
        if (await checkTabsAndWait()) return;
        // Close other eticketing tabs
        await closeOtherEticketingTabs();

        // Handle Event tab only if eventUrl is provided
        if (eventUrl) {
            await ensureEventTabFromBackground(eventUrl, { forceReload: true });
            // Wait before opening validation tab (after event tab)
            await new Promise(resolve => setTimeout(resolve, 50000)); // 50 seconds

        }
        if (Date.now() < error403PauseUntil) {
            console.log("[BG] error403 pause active - skipping rest of openOrFocusTabs.");
            return;
        }
        // check if queue or web identity tabs still there
        if (await checkTabsAndWait()) return;
        // Close other eticketing tabs
        await closeOtherEticketingTabs();

        // Handle Not Allowed tab only if EVENT_NOT_ALLOWED_URL is provided
        if (EVENT_NOT_ALLOWED_URL) {
            const foundNotAllowed = tabs.find(t => t.url && t.url.startsWith(EVENT_NOT_ALLOWED_URL));
            console.log("in focus open tab, check if need to send start request to event_not_allowed tab ..", EVENT_NOT_ALLOWED_URL);
            if (foundNotAllowed) {
                console.log('[BG] Found existing validation tab, reloading', foundNotAllowed.id);
                notAllowedTabId = foundNotAllowed.id;
                await chrome.tabs.reload(notAllowedTabId);
            } else {
                const created2 = await chrome.tabs.create({url: EVENT_NOT_ALLOWED_URL, active: false});
                console.log('[BG] Created validation tab', created2.id);
                notAllowedTabId = created2.id;
            }
        }


        // Wait for 40 seconds
        await new Promise(resolve => setTimeout(resolve, 10000));

        if (Date.now() < error403PauseUntil) {
            console.log("[BG] error403 pause active - skipping recheck and rest of openOrFocusTabs.");
            return;
        }
        // check if queue or web identity tabs still there
        if (await checkTabsAndWait()) return;
        // Close other eticketing tabs
        await closeOtherEticketingTabs();


        // Recheck to ensure tabs are still valid
        if (Date.now() < error403PauseUntil) {
            console.log("[BG] error403 pause active - skipping recheck and rest of openOrFocusTabs.");
            return;
        }
        console.log("Recheck to ensure tabs are still valid and not redirected ")
        const tabs2 = await chrome.tabs.query({url: '*://www.eticketing.co.uk/*'});

        if (eventUrl) {
            await ensureEventTabFromBackground(eventUrl, { forceReload: true });
            await new Promise(resolve => setTimeout(resolve, 30000));
        }
        // check if queue or web identity tabs still there
        if (await checkTabsAndWait()) return;
        // Close other eticketing tabs
        await closeOtherEticketingTabs();

        if (EVENT_NOT_ALLOWED_URL) {
            const stillNotAllowed = tabs2.some(t => t.url && t.url.startsWith(EVENT_NOT_ALLOWED_URL));
            if (!stillNotAllowed) {
                console.log('[BG] Validation tab closed, reopening...');
                const created2 = await chrome.tabs.create({url: EVENT_NOT_ALLOWED_URL, active: false});
                notAllowedTabId = created2.id;

                //wait for 5 seconds
                await new Promise(resolve => setTimeout(resolve, 60000));
            }

            // Send message to Not Allowed tab
            // if (notAllowedTabId) {
            //     await waitForTabLoad(notAllowedTabId, 30000);
            //     const storage = await chrome.storage.local.get(['sheetUrl', 'startSecond', 'areSeatsTogether', 'quantity']);
            //     const cfgMsg = {
            //         action: 'startMonitoring',
            //         sheetUrl: storage.sheetUrl,
            //         startSecond: storage.startSecond,
            //         eventUrl: eventUrl,
            //         areSeatsTogether: storage.areSeatsTogether,
            //     };
            //
            //     chrome.tabs.sendMessage(notAllowedTabId, cfgMsg, resp => {
            //         // if (chrome.runtime.lastError) {
            //         //     console.warn('[BG] sendMessage error:', chrome.runtime.lastError.message);
            //         // } else {
            //         //     console.log('[BG] Start message sent to content script in tab', notAllowedTabId);
            //         // }
            //     });
            //
            //     await chrome.tabs.update(notAllowedTabId, {active: true});
            // }
        }


        //if there are more than 1 event tab close other event tabs only keep one tab open (never close tabs with Checkout in URL)
        const eventTabs = tabs2.filter(t => t.url && t.url.startsWith(eventUrl));
        if (eventTabs.length > 1) {
            console.log('[BG] More than 1 event tab found, closing other event tabs');
            for (const t of eventTabs) {
                if (t.id !== eventTabId && t.url && !t.url.toLowerCase().includes('checkout')) {
                    await chrome.tabs.remove(t.id);
                }
            }
        }
        //if there are more than 1 not allowed tab close other not allowed tabs only keep one tab open (never close tabs with Checkout in URL)
        const notAllowedTabs = tabs2.filter(t => t.url && t.url.startsWith(EVENT_NOT_ALLOWED_URL));
        if (notAllowedTabs.length > 1) {
            console.log('[BG] More than 1 not allowed tab found, closing other not allowed tabs');
            for (const t of notAllowedTabs) {
                if (t.id !== notAllowedTabId && t.url && !t.url.toLowerCase().includes('checkout')) {
                    await chrome.tabs.remove(t.id);
                }
            }
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
                await chrome.tabs.remove(id);
                console.log('[BG] Closed web-identity tab still on identity URL after 8s:', id);
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
                await chrome.tabs.remove(id);
                console.log('[BG] Closed basket-placeholder tab (URL open ≥12 min):', id);
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
    const u = tab.url || '';
    if (!u || !eventUrl) return false;
    const host = (() => {
        try {
            return new URL(u).hostname.toLowerCase();
        } catch (_) {
            return '';
        }
    })();
    if (host !== QUEUE_HOST) return false;
    const eventId = eventIdFromEticketEventUrl(eventUrl);
    try {
        const parsed = new URL(u);
        const t = parsed.searchParams.get('t');
        if (t) {
            const decoded = decodeURIComponent(t);
            if (decoded.startsWith(eventUrl.split('?')[0])) return true;
            if (eventId && (decoded.includes(`EventId=${eventId}`) || decoded.includes(`/Event/Index/${eventId}`))) return true;
        }
    } catch (_) {}
    return false;
}

async function shouldSkipEventTabOperations() {
    if (Date.now() < error403PauseUntil) {
        console.log('[BG] Event tab op skipped — error403 pause (memory)');
        return true;
    }
    const { error403PauseUntil: storedUntil = 0 } = await chrome.storage.local.get('error403PauseUntil');
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

        const created = await chrome.tabs.create({ url, active: false });
        eventTabId = created.id;
        console.log('[BG] ensureEventTab: created new event tab', created.id);
        if (wantFocus) await focusTabWindow(created.id);
        else console.log('[BG] ensureEventTab: skipping focus (Focus Refresh tab? = No)');
        return { success: true, action: 'created' };
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

/** Keep only 1 event tab + 1 validation tab. Close other eticketing and arsenal.com tabs. Keep all hd-queue tabs (including /error403). Close localhost tabs. Never close checkout. Never close the last remaining browser tab. */
async function closeOtherEticketingTabs() {
    await waitThenCloseStaleWebIdentityTabsIfPresent();

    const eventUrl = EVENT_URL || '';
    const validationUrl = EVENT_NOT_ALLOWED_URL || '';

    const tabs = await chrome.tabs.query({});
    let keptEventId = null;
    let keptValidationId = null;
    const toClose = [];

    const eventBase = eventUrl ? eventUrl.split('?')[0] : '';
    const validationBase = validationUrl ? validationUrl.split('?')[0] : '';

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
        if (url.includes(QUEUE_HOST) || pen.includes(QUEUE_HOST)) {
            continue; // keep all hd-queue.eticketing.co.uk tabs (queue + /error403)
        }

        const isEventTab =
            eventBase && (url.startsWith(eventBase) || (pen && pen.startsWith(eventBase)));
        const isValidationTab =
            validationBase &&
            (url.startsWith(validationBase) || (pen && pen.startsWith(validationBase)));

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
    if (uniqueClose.length >= tabs.length && uniqueClose.length > 0) {
        uniqueClose = uniqueClose.slice(0, -1);
        console.log('[BG] closeOtherEticketingTabs: leaving one tab open so the browser window is not closed');
    }

    for (const id of uniqueClose) {
        try {
            await chrome.tabs.remove(id);
            console.log('[BG] Closed unnecessary tab:', id);
        } catch (e) {
            console.warn('[BG] close tab error', id, e);
        }
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
    console.log('[BG] error403 pause ended:', reason || '(no reason)');
    await notifyValidationTabError403Resume();
}

/** Runs every 2 min (alarm). Ensures validation tab exists; prunes extra managed tabs. Does not open event tab (opened on demand via refreshEventTab / openOrFocusTabs / error403 resume). */
async function checkValidationTabAndPruneEticketingTabs() {
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
    const { eventUrl, inQueueWaiting } = await chrome.storage.local.get(['eventUrl', 'inQueueWaiting']);
    if (!eventUrl || inQueueWaiting || openOrFocusTabsInProgress) {
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
        const valBase = validationUrl.split('?')[0];
        const allTabs = await chrome.tabs.query({});
        const hasValidation = allTabs.some((t) => {
            const u = t.url || '';
            const pen = t.pendingUrl || '';
            return (u.startsWith(valBase) || (pen && pen.startsWith(valBase)));
        });
        if (!hasValidation) {
            console.log('[BG] Validation tab missing (2-min check) — creating');
            try {
                const created = await chrome.tabs.create({ url: validationUrl, active: false });
                notAllowedTabId = created.id;
            } catch (e) {
                console.warn('[BG] Failed to create validation tab:', e && e.message);
            }
        }
    }
    await closeOtherEticketingTabs();
}

/** Public name kept for messages; all work goes through ensureEventTabFromBackground (serialized). */
async function refreshEventTab() {
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


function monitorBrowsingActivityTabs() {
    const CHECK_INTERVAL = 5000; // check every 5 sec
    const WAIT_BEFORE_RELOAD = 60000; // 60 sec before recheck title and reload if still paused

    setInterval(() => {
        chrome.tabs.query({}, (tabs) => {
            tabs.forEach((tab) => {
                if (tab.title && tab.title.includes("Your Browsing Activity")) {
                    const tabId = tab.id;
                    const originalTitle = tab.title;

                    console.log(`[BG] Found 'Your Browsing Activity' in tab ${tabId}, waiting 60s...`);

                    setTimeout(() => {
                        chrome.tabs.get(tabId, (updatedTab) => {
                            if (chrome.runtime.lastError) return; // Tab may be closed
                            if (updatedTab.title && updatedTab.title.includes("Your Browsing Activity")) {
                                console.warn(`[BG] Title unchanged for tab ${tabId}, reloading...`);
                                chrome.tabs.reload(tabId);
                            } else {
                                console.log(`[BG] Title changed for tab ${tabId}, no reload needed.`);
                            }
                        });
                    }, WAIT_BEFORE_RELOAD);
                }
            });
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


