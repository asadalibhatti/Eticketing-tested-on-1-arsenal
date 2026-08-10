console.log('TICKET Checking content script loaded on', location.href);

// When event page loads (e.g. after queue or error403 resume), reset BG error403Count so the next hd-queue /error403 pause uses n=0 (5 min base in 5+2·n min capped at 30).
(async () => {
    const { eventUrl } = await chrome.storage.local.get('eventUrl');
    const current = (location.href || '').split('?')[0];
    const storedBase = eventUrl ? eventUrl.split('?')[0] : '';
    if (storedBase && (current === storedBase || current.startsWith(storedBase + '/'))) {
        chrome.runtime.sendMessage({ action: 'resetError403Count' }, () => {
            if (!chrome.runtime.lastError) console.log('[CS] Event URL loaded - reset queue error403Count to 0');
        });
        // Membership recovery ended successfully on event page
        chrome.storage.local.set({ hdQueueMembershipRecoveryActive: false });
    }
})();

/**
 * After Arsenal Red JOIN NOW, if we land on Memberships/List while event-open-via-membership is active,
 * navigate this same tab to stored eventUrl so normal event-tab flow resumes.
 */
(async function redirectMembershipsListToEventUrlIfRecovery() {
    try {
        const href = location.href || '';
        const lower = href.toLowerCase();
        if (!lower.includes('/arsenal/memberships/list')) return;

        const st = await chrome.storage.local.get(['hdQueueMembershipRecoveryActive', 'eventUrl']);
        if (st.hdQueueMembershipRecoveryActive !== true) {
            console.log('[CS] Memberships/List — event-via-membership flag not set; leaving page as-is');
            return;
        }
        const eventUrl = (st.eventUrl || '').trim();
        if (!eventUrl) {
            console.warn('[CS] Memberships/List during membership→event open but no eventUrl in storage');
            return;
        }
        console.log('[CS] Memberships/List — navigating same tab to eventUrl:', eventUrl);
        await chrome.storage.local.set({ hdQueueMembershipRecoveryActive: false });
        window.location.replace(eventUrl);
    } catch (e) {
        console.warn('[CS] redirectMembershipsListToEventUrlIfRecovery error:', e);
    }
})();

const BROWSING_PAUSE_WAIT_MS = 60000;
let __etkBrowsingPauseRecoveryStarted = false;

/** Title or page body shows Chrome/eticketing "Your Browsing Activity Has Been Paused". */
function isBrowsingActivityPausedOnPage() {
    const title = (document.title || '').toLowerCase();
    if (title.includes('your browsing activity')) return true;
    try {
        const bodyText = (document.body && (document.body.innerText || document.body.textContent) || '').toLowerCase();
        if (bodyText.includes('your browsing activity has been paused')) return true;
        if (bodyText.includes('your browsing activity has')) return true;
    } catch (_) {}
    return false;
}

/**
 * Notify background to run shared 60s → reload / after 3 → clear-cookies recovery.
 * Content does not reload itself (avoids double-counting with BG title poll).
 * Returns true if pause was present (caller should not start seat checks yet).
 */
function startBrowsingActivityPauseRecoveryIfNeeded() {
    if (!isBrowsingActivityPausedOnPage()) return false;
    if (__etkBrowsingPauseRecoveryStarted) return true;
    __etkBrowsingPauseRecoveryStarted = true;
    console.warn(
        `[CS] Browsing activity paused — notifying background (60s→reload; after 3→clear cookies; if still paused→10 min cooldown)`
    );
    chrome.runtime.sendMessage({ action: 'browsingActivityPaused' }, () => {
        if (chrome.runtime.lastError) {
            console.warn('[CS] browsingActivityPaused message:', chrome.runtime.lastError.message);
            __etkBrowsingPauseRecoveryStarted = false;
        }
    });
    // If pause clears without reload (rare), allow re-notify later
    const clearWatch = setInterval(() => {
        if (!isBrowsingActivityPausedOnPage()) {
            clearInterval(clearWatch);
            __etkBrowsingPauseRecoveryStarted = false;
            console.log('[CS] Browsing activity pause cleared.');
        }
    }, 2000);
    setTimeout(() => clearInterval(clearWatch), BROWSING_PAUSE_WAIT_MS + 5000);
    return true;
}

// Start recovery if this page is currently browsing-paused (all eticketing pages).
startBrowsingActivityPauseRecoveryIfNeeded();

let monitor = {
    running: false,
    sheetUrl: null,
    startSecond: null,
    areSeatsTogether: false,
    quantity: null,
    /** When non-null (0–100), each checkOnce rolls pair vs single; updated when sheet row is read. */
    pairCheckChancePct: null,
    discordWebhook: null,
    /** Bot token from sheet column TelegramBotToken (stored under this key for compatibility). */
    telegramWebhook: null,
    telegramChatId: null,
    eventUrl: null,
    eventId: null,
    intervalId: null,
    last403Time: 0
};

const VALIDATION_TAB_QUERY = 'eventId=4&reason=EventArchived';
/** Legacy flat metrics (migrated once into per-event map). */
const VALIDATION_DASHBOARD_METRICS_KEY = 'validationDashboardMetrics';
/** Per-event session history: { [normalizedEventUrl]: { seatsLocked, seatLockFailed, cookiesCleared } } */
const VALIDATION_DASHBOARD_METRICS_BY_EVENT_KEY = 'validationDashboardMetricsByEvent';
const VALIDATION_DASHBOARD_ID = 'etk-validation-dashboard';
const VALIDATION_DASHBOARD_STYLE_ID = 'etk-validation-dashboard-style';
let validationDashboardEls = null;
let validationDashboardSheetStatus = '';
let validationDashboardSheetRow = null;
let validationDashboardMetrics = { seatsLocked: 0, seatLockFailed: 0, cookiesCleared: 0 };
/** Normalized eventUrl key that `validationDashboardMetrics` currently represents. */
let validationDashboardMetricsEventKey = '';
let validationMetricsPersistTimer = null;
let validationMetricsLoadPromise = null;

function isValidationTabPage() {
    return window.location.search.includes(VALIDATION_TAB_QUERY);
}

function emptyValidationMetrics() {
    return { seatsLocked: 0, seatLockFailed: 0, cookiesCleared: 0 };
}

/** Stable key so the same event keeps one history regardless of query/hash/trailing slash. */
function normalizeEventUrlHistoryKey(url) {
    const raw = (url || '').toString().trim();
    if (!raw) return '';
    try {
        const u = new URL(raw);
        const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
        return (u.protocol + '//' + u.hostname.toLowerCase() + path).toLowerCase();
    } catch (_) {
        return raw.split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase();
    }
}

function parseValidationMetricsObj(obj) {
    if (!obj || typeof obj !== 'object') return emptyValidationMetrics();
    return {
        seatsLocked: Number(obj.seatsLocked) || 0,
        seatLockFailed: Number(obj.seatLockFailed) || 0,
        cookiesCleared: Number(obj.cookiesCleared) || 0
    };
}

/**
 * Load Session History counters for the given event URL (separate history per event).
 * Migrates legacy flat metrics into this event once if the by-event map is empty.
 */
async function loadValidationMetricsForEventUrl(eventUrl) {
    const key = normalizeEventUrlHistoryKey(eventUrl);
    validationDashboardMetricsEventKey = key;
    if (!key) {
        validationDashboardMetrics = emptyValidationMetrics();
        return;
    }
    const st = await chrome.storage.local.get([
        VALIDATION_DASHBOARD_METRICS_BY_EVENT_KEY,
        VALIDATION_DASHBOARD_METRICS_KEY
    ]);
    const byEvent =
        st[VALIDATION_DASHBOARD_METRICS_BY_EVENT_KEY] &&
        typeof st[VALIDATION_DASHBOARD_METRICS_BY_EVENT_KEY] === 'object'
            ? { ...st[VALIDATION_DASHBOARD_METRICS_BY_EVENT_KEY] }
            : {};
    if (byEvent[key]) {
        validationDashboardMetrics = parseValidationMetricsObj(byEvent[key]);
        return;
    }
    const legacy = st[VALIDATION_DASHBOARD_METRICS_KEY];
    const legacyParsed = parseValidationMetricsObj(legacy);
    const hasLegacy =
        legacyParsed.seatsLocked > 0 ||
        legacyParsed.seatLockFailed > 0 ||
        legacyParsed.cookiesCleared > 0;
    if (hasLegacy && Object.keys(byEvent).length === 0) {
        validationDashboardMetrics = legacyParsed;
        byEvent[key] = { ...legacyParsed };
        await chrome.storage.local.set({
            [VALIDATION_DASHBOARD_METRICS_BY_EVENT_KEY]: byEvent,
            [VALIDATION_DASHBOARD_METRICS_KEY]: emptyValidationMetrics()
        });
        console.log('[CS] Migrated legacy Session History into event key:', key);
        return;
    }
    validationDashboardMetrics = emptyValidationMetrics();
}

async function ensureValidationMetricsMatchEventUrl(eventUrl) {
    const nextKey = normalizeEventUrlHistoryKey(eventUrl);
    if (nextKey === validationDashboardMetricsEventKey) return;
    if (validationMetricsLoadPromise) await validationMetricsLoadPromise;
    if (nextKey === validationDashboardMetricsEventKey) return;
    validationMetricsLoadPromise = loadValidationMetricsForEventUrl(eventUrl).finally(() => {
        validationMetricsLoadPromise = null;
    });
    await validationMetricsLoadPromise;
}

function persistValidationMetricsSoon() {
    if (validationMetricsPersistTimer) clearTimeout(validationMetricsPersistTimer);
    validationMetricsPersistTimer = setTimeout(() => {
        validationMetricsPersistTimer = null;
        const key =
            validationDashboardMetricsEventKey ||
            normalizeEventUrlHistoryKey(monitor.eventUrl);
        if (!key) return;
        chrome.storage.local.get([VALIDATION_DASHBOARD_METRICS_BY_EVENT_KEY], (st) => {
            if (chrome.runtime.lastError) return;
            const byEvent =
                st[VALIDATION_DASHBOARD_METRICS_BY_EVENT_KEY] &&
                typeof st[VALIDATION_DASHBOARD_METRICS_BY_EVENT_KEY] === 'object'
                    ? { ...st[VALIDATION_DASHBOARD_METRICS_BY_EVENT_KEY] }
                    : {};
            byEvent[key] = { ...validationDashboardMetrics };
            validationDashboardMetricsEventKey = key;
            chrome.storage.local.set({ [VALIDATION_DASHBOARD_METRICS_BY_EVENT_KEY]: byEvent });
        });
    }, 500);
}

function bumpValidationMetric(key, amount = 1) {
    if (!isValidationTabPage()) return;
    if (!Object.prototype.hasOwnProperty.call(validationDashboardMetrics, key)) return;
    const delta = Number(amount) || 0;
    if (delta <= 0) return;
    const eventKey = normalizeEventUrlHistoryKey(monitor.eventUrl);
    if (!eventKey) {
        console.warn('[CS] Session History bump skipped — no eventUrl set');
        return;
    }
    const applyBump = () => {
        if (!Object.prototype.hasOwnProperty.call(validationDashboardMetrics, key)) return;
        validationDashboardMetrics[key] += delta;
        renderValidationDashboard();
        persistValidationMetricsSoon();
    };
    if (eventKey !== validationDashboardMetricsEventKey) {
        ensureValidationMetricsMatchEventUrl(monitor.eventUrl).then(applyBump);
        return;
    }
    applyBump();
}

function formatStatusBadge(snapshot) {
    const browseCooldownUntil = Number(snapshot.browsingPauseCooldownUntil) || 0;
    if (browseCooldownUntil > Date.now()) {
        const remainMin = Math.max(1, Math.ceil((browseCooldownUntil - Date.now()) / 60000));
        return { label: 'Paused (Browsing) • ' + remainMin + 'm cooldown', cls: 'st403' };
    }
    if (typeof isBrowsingActivityPausedOnPage === 'function' && isBrowsingActivityPausedOnPage()) {
        return { label: 'Paused (Browsing Activity)', cls: 'st403' };
    }
    const pauseUntil = Number(snapshot.error403PauseUntil) || 0;
    const pauseActive = pauseUntil > Date.now();
    const queueActive = snapshot.inQueueWaiting === true;
    const sheetStopped = ['off', '0', 'false', 'stop', 'stopped'].includes(String(validationDashboardSheetStatus || '').toLowerCase());
    if (pauseActive) {
        const remainSec = Math.max(0, Math.ceil((pauseUntil - Date.now()) / 1000));
        return { label: 'Paused (Error 403) • ' + remainSec + 's left', cls: 'st403' };
    }
    if (queueActive) return { label: 'Paused (Queue Waiting)', cls: 'stQueue' };
    if (sheetStopped) return { label: 'Stopped (Google Sheet Off)', cls: 'stOff' };
    if (monitor.running) return { label: 'Monitoring Active', cls: 'stOn' };
    return { label: 'Idle / Starting', cls: 'stIdle' };
}

async function getSheetRowForDashboard(sheetUrl, startSecond) {
    try {
        if (!sheetUrl) return null;
        const m = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
        if (!m) return null;
        const gidMatch = sheetUrl.match(/[?&]gid=(\d+)/);
        const gid = gidMatch ? gidMatch[1] : '0';
        const gviz = `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:json&gid=${gid}`;
        const res = await fetch(gviz);
        const txt = await res.text();
        const jsonText = txt.replace(/^[^\{]+/, '').replace(/\);?$/, '');
        const obj = JSON.parse(jsonText);
        const table = obj?.table;
        if (!table || !Array.isArray(table.rows)) return null;
        const headers = (table.cols || []).map(c => (c.label || '').trim());
        const cfgSecond = parseFloat(startSecond);
        for (const row of table.rows) {
            const values = (row.c || []).map(cell => (cell ? cell.v : ''));
            const rowData = {};
            headers.forEach((h, i) => { rowData[h] = values[i]; });
            const rowSecond = parseFloat(rowData.StartSecond);
            if (!Number.isNaN(cfgSecond) && !Number.isNaN(rowSecond) && rowSecond === cfgSecond) {
                await persistLoginEmailFromSheetRow(rowData, 'dashboard sheet row');
                return rowData;
            }
        }
    } catch (e) {
        console.warn('[CS] dashboard sheet read failed:', e && e.message);
    }
    return null;
}

function ensureValidationDashboardDom() {
    if (!isValidationTabPage()) return;
    if (!document.getElementById(VALIDATION_DASHBOARD_STYLE_ID)) {
        const style = document.createElement('style');
        style.id = VALIDATION_DASHBOARD_STYLE_ID;
        style.textContent = `
            #${VALIDATION_DASHBOARD_ID}{max-width:820px;margin:20px auto;padding:18px 20px;border-radius:14px;border:1px solid #dbe2ea;background:#fff;box-shadow:0 6px 18px rgba(15,23,42,.08);font-family:Segoe UI,Arial,sans-serif;color:#1e293b}
            #${VALIDATION_DASHBOARD_ID} .row{display:flex;gap:12px;align-items:center;justify-content:space-between;margin:8px 0}
            #${VALIDATION_DASHBOARD_ID} .title{font-size:20px;font-weight:700}
            #${VALIDATION_DASHBOARD_ID} .badge{padding:7px 11px;border-radius:999px;font-size:12px;font-weight:700}
            #${VALIDATION_DASHBOARD_ID} .stOn{background:#dcfce7;color:#166534}
            #${VALIDATION_DASHBOARD_ID} .stOff{background:#fee2e2;color:#991b1b}
            #${VALIDATION_DASHBOARD_ID} .st403{background:#ffedd5;color:#9a3412}
            #${VALIDATION_DASHBOARD_ID} .stQueue{background:#dbeafe;color:#1d4ed8}
            #${VALIDATION_DASHBOARD_ID} .stIdle{background:#e2e8f0;color:#334155}
            #${VALIDATION_DASHBOARD_ID} .grid{display:grid;grid-template-columns:repeat(2,minmax(260px,1fr));gap:10px;margin-top:10px}
            #${VALIDATION_DASHBOARD_ID} .card{border:1px solid #e2e8f0;border-radius:10px;padding:11px 12px;background:#f8fafc;display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start}
            #${VALIDATION_DASHBOARD_ID} .k{font-size:12px;color:#64748b;line-height:1.3;margin-bottom:6px;display:block}
            #${VALIDATION_DASHBOARD_ID} .v{font-size:15px;font-weight:600;color:#0f172a;word-break:break-word;line-height:1.35;display:block;min-height:20px}
            #${VALIDATION_DASHBOARD_ID} .sec{margin-top:14px;padding-top:10px;border-top:1px solid #e2e8f0}
        `;
        document.head.appendChild(style);
    }
    let root = document.getElementById(VALIDATION_DASHBOARD_ID);
    if (!root) {
        const candidates = Array.from(document.querySelectorAll('div'));
        for (const d of candidates) {
            const t = (d.textContent || '').toLowerCase();
            if (t.includes('eventnotallowed') || t.includes('event archived') || t.includes('event is') && t.includes('available')) {
                d.remove();
                break;
            }
        }
        root = document.createElement('div');
        root.id = VALIDATION_DASHBOARD_ID;
        root.innerHTML = `
            <div class="row"><div class="title">Ticket Monitor Status</div><div id="etkBadge" class="badge stIdle">Idle</div></div>
            <div class="grid">
                <div class="card"><div class="k">Google Sheet Status</div><div id="etkSheetStatus" class="v">-</div></div>
                <div class="card"><div class="k">Event URL</div><div id="etkEventUrl" class="v">-</div></div>
                <div class="card"><div class="k">Start Second</div><div id="etkStartSecond" class="v">-</div></div>
                <div class="card"><div class="k">Queue Waiting</div><div id="etkQueue" class="v">-</div></div>
                <div class="card"><div class="k">Error403 Pause</div><div id="etk403" class="v">-</div></div>
                <div class="card"><div class="k">Email</div><div id="etkEmail" class="v">-</div></div>
                <div class="card"><div class="k">Pair Check Chance</div><div id="etkPairChance" class="v">-</div></div>
                <div class="card"><div class="k">Resale Endpoint Chances</div><div id="etkResaleChance" class="v">-</div></div>
            </div>
            <div class="sec">
                <div class="title" style="font-size:16px">Session History</div>
                <div class="grid">
                    <div class="card"><div class="k">Seats Locked</div><div id="etkLocked" class="v">0</div></div>
                    <div class="card"><div class="k">Seat Lock Failed</div><div id="etkLockFail" class="v">0</div></div>
                    <div class="card"><div class="k">Cookies Cleared</div><div id="etkCookies" class="v">0</div></div>
                    <div class="card"><div class="k">Mode</div><div id="etkMode" class="v">-</div></div>
                </div>
            </div>
        `;
        document.body.prepend(root);
    }
    if (!document.getElementById('etkResaleChance')) {
        const grid = root.querySelector('.grid');
        if (grid) {
            const card = document.createElement('div');
            card.className = 'card';
            card.innerHTML = '<div class="k">Resale Endpoint Chances</div><div id="etkResaleChance" class="v">-</div>';
            grid.appendChild(card);
        }
    }
    if (!document.getElementById('etkEventUrl')) {
        const statusGrid = root.querySelector('.grid');
        if (statusGrid) {
            const card = document.createElement('div');
            card.className = 'card';
            card.innerHTML = '<div class="k">Event URL</div><div id="etkEventUrl" class="v">-</div>';
            const afterSheet = document.getElementById('etkSheetStatus');
            const sheetCard = afterSheet && afterSheet.closest ? afterSheet.closest('.card') : null;
            if (sheetCard && sheetCard.nextSibling) {
                statusGrid.insertBefore(card, sheetCard.nextSibling);
            } else if (sheetCard) {
                statusGrid.appendChild(card);
            } else {
                statusGrid.insertBefore(card, statusGrid.firstChild);
            }
        }
    }
    validationDashboardEls = {
        badge: document.getElementById('etkBadge'),
        sheetStatus: document.getElementById('etkSheetStatus'),
        eventUrl: document.getElementById('etkEventUrl'),
        startSecond: document.getElementById('etkStartSecond'),
        queue: document.getElementById('etkQueue'),
        pause403: document.getElementById('etk403'),
        email: document.getElementById('etkEmail'),
        pairChance: document.getElementById('etkPairChance'),
        resaleChance: document.getElementById('etkResaleChance'),
        locked: document.getElementById('etkLocked'),
        lockFail: document.getElementById('etkLockFail'),
        cookies: document.getElementById('etkCookies'),
        mode: document.getElementById('etkMode')
    };
}

function renderValidationDashboard(snapshot = {}) {
    if (!validationDashboardEls) return;
    const badge = formatStatusBadge(snapshot);
    validationDashboardEls.badge.className = 'badge ' + badge.cls;
    validationDashboardEls.badge.textContent = badge.label;
    validationDashboardEls.sheetStatus.textContent = validationDashboardSheetStatus || (monitor.running ? 'On' : 'Unknown');
    const eventUrl =
        (snapshot.eventUrl || monitor.eventUrl || '').toString().trim();
    if (validationDashboardEls.eventUrl) {
        validationDashboardEls.eventUrl.textContent = eventUrl || '(not set)';
        validationDashboardEls.eventUrl.title = eventUrl || '';
    }
    validationDashboardEls.startSecond.textContent = monitor.startSecond != null ? String(monitor.startSecond) : '(not set)';
    validationDashboardEls.queue.textContent = snapshot.inQueueWaiting === true ? 'Yes (waiting)' : 'No';
    const until = Number(snapshot.error403PauseUntil) || 0;
    validationDashboardEls.pause403.textContent = until > Date.now() ? 'Yes • ends at ' + new Date(until).toLocaleTimeString() : 'No';
    const email = (snapshot.loginEmail || '').toString().trim();
    validationDashboardEls.email.textContent = email || '(not set)';
    const pairChance = monitor.pairCheckChancePct != null ? String(monitor.pairCheckChancePct) + '%' : '(sheet default)';
    validationDashboardEls.pairChance.textContent = pairChance;
    let resalePct = null;
    if (validationDashboardSheetRow) {
        resalePct = getResaleEndpointChancesFromRow(validationDashboardSheetRow);
    }
    if (resalePct == null && snapshot.resaleEndpointChances != null && snapshot.resaleEndpointChances !== '') {
        const n = parseFloat(snapshot.resaleEndpointChances);
        if (Number.isFinite(n)) resalePct = Math.min(100, Math.max(0, n));
    }
    if (resalePct == null) resalePct = DEFAULT_RESALE_ENDPOINT_CHANCES;
    if (validationDashboardEls.resaleChance) {
        validationDashboardEls.resaleChance.textContent = String(resalePct) + '%';
    }
    validationDashboardEls.mode.textContent = monitor.areSeatsTogether ? 'Pair / quantity ' + monitor.quantity : 'Single / quantity ' + monitor.quantity;
    validationDashboardEls.locked.textContent = String(validationDashboardMetrics.seatsLocked || 0);
    validationDashboardEls.lockFail.textContent = String(validationDashboardMetrics.seatLockFailed || 0);
    validationDashboardEls.cookies.textContent = String(validationDashboardMetrics.cookiesCleared || 0);
}

async function refreshValidationDashboardSheetData() {
    if (!isValidationTabPage()) return;
    const st = await chrome.storage.local.get(['sheetUrl', 'startSecond']);
    const row = await getSheetRowForDashboard(st.sheetUrl || monitor.sheetUrl, st.startSecond != null ? st.startSecond : monitor.startSecond);
    validationDashboardSheetRow = row;
    const rawStatus = row ? (row.Status || row.status || '') : '';
    validationDashboardSheetStatus = String(rawStatus || '').trim() || '(unknown)';
    if (row) {
        const p = getPairCheckChanceFromRow(row);
        monitor.pairCheckChancePct = p == null ? monitor.pairCheckChancePct : p;
    }
}

async function updateValidationDashboard() {
    if (!isValidationTabPage()) return;
    ensureValidationDashboardDom();
    const snap = await chrome.storage.local.get([
        'error403PauseUntil',
        'inQueueWaiting',
        'startSecond',
        'loginEmail',
        'resaleEndpointChances',
        'browsingPauseCooldownUntil',
        'eventUrl'
    ]);
    if (snap.startSecond != null && snap.startSecond !== '' && !Number.isNaN(parseFloat(snap.startSecond))) {
        monitor.startSecond = parseFloat(snap.startSecond);
    }
    const eventUrlForHistory = (snap.eventUrl || monitor.eventUrl || '').trim();
    if (eventUrlForHistory) {
        monitor.eventUrl = eventUrlForHistory;
    }
    await ensureValidationMetricsMatchEventUrl(eventUrlForHistory);
    renderValidationDashboard(snap);
}

async function initValidationDashboard() {
    if (!isValidationTabPage()) return;
    const st = await chrome.storage.local.get(['eventUrl']);
    const eventUrlForHistory = (st.eventUrl || monitor.eventUrl || '').trim();
    await loadValidationMetricsForEventUrl(eventUrlForHistory);
    ensureValidationDashboardDom();
    await refreshValidationDashboardSheetData();
    await updateValidationDashboard();
    setInterval(updateValidationDashboard, 2000);
    setInterval(async () => {
        await refreshValidationDashboardSheetData();
        await updateValidationDashboard();
    }, 30000);
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || !changes.eventUrl || !isValidationTabPage()) return;
            const next = (changes.eventUrl.newValue || '').toString().trim();
            if (next) monitor.eventUrl = next;
            ensureValidationMetricsMatchEventUrl(next).then(() => {
                renderValidationDashboard({ eventUrl: next });
            });
        });
    } catch (_) {}
}

/**
 * True if this tab should leave a logout/session-timeout landing URL for the stored event URL
 * (same club in storage is not enough — tab can still be on /club/?PublishLogout... or /club/Error/CommonWithTitle?...).
 */
function shouldNavigateFromLogoutOrSessionTimeout(currentHref, storedEventUrl) {
    const st = (storedEventUrl || '').trim();
    if (!st) return false;
    try {
        const cur = new URL(currentHref);
        const tgt = new URL(st.split('#')[0]);
        if (cur.hostname.toLowerCase() !== tgt.hostname.toLowerCase()) return true;
        const normPath = (p) => (p.replace(/\/+$/, '') || '/').toLowerCase();
        if (normPath(cur.pathname) !== normPath(tgt.pathname)) return true;
        const pub = (cur.searchParams.get('PublishLogoutDataLayer') || '').toLowerCase();
        if (pub === 'true') return true;
        return false;
    } catch {
        return true;
    }
}

/** eTicketing account blackout / restriction landing (do not redirect away; stop bot). */
function isUrlAccountRestrictedBlackout(href) {
    const u = (href || '').toLowerCase();
    return u.includes('accountrestrictederrormessage') && u.includes('bodykey=warn_login_blackoutlimitreached');
}

/** Event tab redirected to EventNotAllowed with reason=EventRestricted — stop monitoring; keep tab open. */
function isUrlEventRestricted(href) {
    const u = (href || '').toLowerCase();
    if (!u.includes('/edp/validation/eventnotallowed')) return false;
    try {
        const parsed = new URL(href);
        return (parsed.searchParams.get('reason') || '').toLowerCase() === 'eventrestricted';
    } catch {
        return u.includes('reason=eventrestricted');
    }
}

let __etkAccountRestrictedBlackoutReported = false;
let __etkEventRestrictedStopReported = false;
async function reportAccountRestrictedBlackoutStop(source) {
    if (__etkAccountRestrictedBlackoutReported) return;
    __etkAccountRestrictedBlackoutReported = true;
    console.warn(
        '[CS] Account restricted (Warn_Login_BlackoutLimitReached) — stopping bot; leaving this tab open.',
        source || ''
    );
    await chrome.storage.local.set({ accountRestrictedBlackoutStop: true, currentStatus: 'off' });
    chrome.runtime.sendMessage({ action: 'accountRestrictedBlackoutStop' }, () => {
        if (chrome.runtime.lastError) {
            console.warn('[CS] accountRestrictedBlackoutStop message:', chrome.runtime.lastError.message);
        }
    });
    try {
        if (typeof monitor !== 'undefined' && monitor.running && typeof isValidationTabPage === 'function' && isValidationTabPage()) {
            if (typeof stopMonitoring === 'function') stopMonitoring('account restricted blackout');
        }
    } catch (_) {}
}

async function reportEventRestrictedStop(source) {
    if (__etkEventRestrictedStopReported) return;
    __etkEventRestrictedStopReported = true;
    console.warn(
        '[CS] Event restricted (EventNotAllowed?reason=EventRestricted) — stopping monitoring; leaving this tab open.',
        source || ''
    );
    await chrome.storage.local.set({ eventRestrictedStop: true, currentStatus: 'off' });
    chrome.runtime.sendMessage({ action: 'eventRestrictedStop' }, () => {
        if (chrome.runtime.lastError) {
            console.warn('[CS] eventRestrictedStop message:', chrome.runtime.lastError.message);
        }
    });
    try {
        if (typeof monitor !== 'undefined' && monitor.running && typeof isValidationTabPage === 'function' && isValidationTabPage()) {
            if (typeof stopMonitoring === 'function') stopMonitoring('event restricted');
        }
    } catch (_) {}
}

/**
 * Logout landing: `https://www.eticketing.co.uk/{club}/?PublishLogoutDataLayer=true`
 * Seid landing: `https://www.eticketing.co.uk/{club}?seid=...` (same handling as PublishLogout).
 * Session-timeout landing: `https://www.eticketing.co.uk/{club}/Error/CommonWithTitle?key=Message_SessionTimeout_Light&title=Message_SessionTimeoutTitle_Light`
 * If storage already has this club’s eventUrl but this tab is still on the logout URL, navigate to the event URL.
 * Otherwise set eventUrl and ask background to refresh the event tab.
 */
const PUBLISH_LOGOUT_BEFORE_EVENT_NAV_MS = 8000;

(async function syncEventUrlFromPublishLogoutLanding() {
    try {
        if (isUrlAccountRestrictedBlackout(location.href)) {
            await reportAccountRestrictedBlackoutStop('account-restricted-url');
            return;
        }
        const u = new URL(location.href);
        if (u.hostname.toLowerCase() !== 'www.eticketing.co.uk') return;
        const flag = (u.searchParams.get('PublishLogoutDataLayer') || '').toLowerCase();
        const seidParam = (u.searchParams.get('seid') || '').trim();
        const keyParam = (u.searchParams.get('key') || '').toLowerCase();
        const titleParam = (u.searchParams.get('title') || '').toLowerCase();
        const isPublishLogout = flag === 'true';
        const isSeidLanding =
            !!seidParam &&
            /^\/[a-z0-9_-]+\/?$/i.test(u.pathname) &&
            !u.pathname.toLowerCase().includes('/edp/');
        const isSessionTimeoutCommonWithTitle =
            u.pathname.toLowerCase().includes('/error/commonwithtitle') &&
            keyParam === 'message_sessiontimeout_light' &&
            titleParam === 'message_sessiontimeouttitle_light';
        const isPublishLogoutLike = isPublishLogout || isSeidLanding;
        if (!isPublishLogoutLike && !isSessionTimeoutCommonWithTitle) return;

        const segments = u.pathname.split('/').filter(Boolean);
        if (!segments.length) return;
        const club = segments[0];
        if (!club || !/^[a-z0-9_-]+$/i.test(club)) return;

        const clubOrigin = `https://www.eticketing.co.uk/${club}`;
        const clubPrefixLower = `${clubOrigin.toLowerCase()}/`;

        const storage = await chrome.storage.local.get(['eventUrl', 'eventId']);
        const existing = (storage.eventUrl || '').trim();

        if (existing && existing.toLowerCase().startsWith(clubPrefixLower)) {
            if (shouldNavigateFromLogoutOrSessionTimeout(location.href, existing)) {
                const dest = existing.split('#')[0].trim();
                if (isPublishLogoutLike) {
                    console.log(
                        '[CS] PublishLogout/seid landing: waiting ' +
                            PUBLISH_LOGOUT_BEFORE_EVENT_NAV_MS / 1000 +
                            's before redirect to stored eventUrl...'
                    );
                    await delay(PUBLISH_LOGOUT_BEFORE_EVENT_NAV_MS);
                }
                console.log('[CS] Logout/session-timeout landing: redirecting this tab to stored eventUrl:', dest);
                window.location.replace(dest);
                return;
            }
            if (isPublishLogoutLike) {
                console.log(
                    '[CS] PublishLogout/seid landing: waiting ' +
                        PUBLISH_LOGOUT_BEFORE_EVENT_NAV_MS / 1000 +
                        's before refreshEventTab...'
                );
                await delay(PUBLISH_LOGOUT_BEFORE_EVENT_NAV_MS);
            }
            console.log('[CS] Logout/session-timeout landing: already on stored event path; nudging refreshEventTab —', existing);
            chrome.runtime.sendMessage({ action: 'refreshEventTab' }, () => {
                if (chrome.runtime.lastError) {
                    console.warn('[CS] Logout/session-timeout: refreshEventTab message failed:', chrome.runtime.lastError.message);
                }
            });
            return;
        }

        const eidRaw = storage.eventId != null ? String(storage.eventId).trim() : '';
        const newUrl = eidRaw
            ? `${clubOrigin}/EDP/Event/Index/${eidRaw}`
            : `${clubOrigin}/`;

        if (isPublishLogoutLike) {
            console.log(
                '[CS] PublishLogout/seid landing: waiting ' +
                    PUBLISH_LOGOUT_BEFORE_EVENT_NAV_MS / 1000 +
                    's before setting eventUrl in this tab and opening event tab...'
            );
            await delay(PUBLISH_LOGOUT_BEFORE_EVENT_NAV_MS);
        }

        await chrome.storage.local.set({ eventUrl: newUrl });
        monitor.eventUrl = newUrl;
        if (eidRaw) monitor.eventId = eidRaw;

        console.log('[CS] Logout/session-timeout landing: set eventUrl for quick event tab:', newUrl);

        chrome.runtime.sendMessage({ action: 'refreshEventTab' }, () => {
            if (chrome.runtime.lastError) {
                console.warn('[CS] Logout/session-timeout: refreshEventTab message failed:', chrome.runtime.lastError.message);
            }
        });
    } catch (e) {
        console.warn('[CS] syncEventUrlFromPublishLogoutLanding error', e);
    }
})();

/** Default % chance to use Resale endpoint when sheet column "Resale Endpoint Chances" is missing or unset. */
const DEFAULT_RESALE_ENDPOINT_CHANCES = 96;

// Club-based PriceClassId mapping
const clubPriceClassIdMap = {
    'arsenal': 1,
    'nottinghamforest': 317,//209,//317 was working before but for champion leage 209
    'cpfc': 1,  // Crystal Palace - default to 1, update if needed
    'chelseafc': 2,  // Chelsea - default to 1, update if needed
    'tottenhamhotspur': 1,
    // Add more clubs as needed
};

// Helper function to get PriceClassId for a club
function getPriceClassIdForClub(clubName) {
    const normalizedClubName = (clubName || '').toLowerCase().trim();
    const priceClassId = clubPriceClassIdMap[normalizedClubName];
    
    if (priceClassId !== undefined) {
        return priceClassId;
    }
    
    // Default fallback to 1 if club not found in map
    console.warn(`[CS] PriceClassId not found for club "${clubName}", using default: 1`);
    return 1;
}
// Auto start monitoring if on the expected page
(async () => {
    if (!window.location.search.includes("eventId=4&reason=EventArchived")) {
        console.warn('[CS] Not on eventId=4&reason=EventArchived page, stopping auto-start');
        return;
    }

    try {
        await initValidationDashboard();
        if (isBrowsingActivityPausedOnPage()) {
            console.warn('[CS] Browsing activity paused on validation tab — not starting seat checks until it clears');
            startBrowsingActivityPauseRecoveryIfNeeded();
            // Poll until pause clears (e.g. after BG/CS reload recovers), then start monitoring
            const waitUntilClear = setInterval(async () => {
                if (isBrowsingActivityPausedOnPage()) return;
                const { browsingPauseCooldownUntil = 0 } = await chrome.storage.local.get('browsingPauseCooldownUntil');
                if (Number(browsingPauseCooldownUntil) > Date.now()) return;
                clearInterval(waitUntilClear);
                if (monitor.running) return;
                console.log('[CS] Browsing pause cleared — auto-starting monitor');
                try {
                    await startMonitorFlow();
                } catch (e) {
                    console.error('[CS] Auto startMonitorFlow after browsing pause error:', e);
                }
            }, 2000);
            return;
        }
        const { browsingPauseCooldownUntil = 0 } = await chrome.storage.local.get('browsingPauseCooldownUntil');
        if (Number(browsingPauseCooldownUntil) > Date.now()) {
            console.warn('[CS] Browsing-pause 10 min cooldown active — delaying auto-start');
            const waitCooldown = setInterval(async () => {
                const st = await chrome.storage.local.get('browsingPauseCooldownUntil');
                if (Number(st.browsingPauseCooldownUntil) > Date.now()) return;
                if (isBrowsingActivityPausedOnPage()) return;
                clearInterval(waitCooldown);
                if (monitor.running) return;
                console.log('[CS] Browsing-pause cooldown ended — auto-starting monitor');
                try {
                    await startMonitorFlow();
                } catch (e) {
                    console.error('[CS] Auto startMonitorFlow after cooldown error:', e);
                }
            }, 5000);
            return;
        }
        console.log('[CS] Auto-starting monitor on page load');
        await startMonitorFlow();
    } catch (e) {
        console.error('[CS] Auto startMonitorFlow error:', e);
    }
})();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'isBrowsingActivityPaused') {
        sendResponse({ paused: isBrowsingActivityPausedOnPage() });
        return false;
    }
    if (msg.action === 'error403Resume') {
        console.log('[CS] error403 pause ended - resuming seat check instantly');
        if (monitor.running && !isBrowsingActivityPausedOnPage()) runCheck();
        return;
    }
    if (window.location.search.includes("eventId=4&reason=EventArchived")) {
        if (msg.action === 'startMonitoring') {//start will be from backgroun script
            console.log('[CS] received startMonitoring', msg);
            if (isBrowsingActivityPausedOnPage()) {
                console.warn('[CS] Ignoring startMonitoring — browsing activity still paused');
                startBrowsingActivityPauseRecoveryIfNeeded();
                return;
            }
            chrome.storage.local.get('browsingPauseCooldownUntil', (st) => {
                if (Number(st.browsingPauseCooldownUntil) > Date.now()) {
                    console.warn('[CS] Ignoring startMonitoring — browsing-pause 10 min cooldown active');
                    return;
                }
                monitor.sheetUrl = msg.sheetUrl || monitor.sheetUrl;
                monitor.startSecond = (msg.startSecond); // set in extension popup, received as a message

                // eventUrl may be provided in msg or we can get from sheet
                startMonitorFlow().catch(e => console.error('[CS] startMonitorFlow error', e));
            });
            return;
        }
        if (msg.action === 'stopMonitoring') {
            stopMonitoring('stop message from background');
        }
    } else {
        // Stop script execution
        console.warn('[CS] not on eventId=4&reason=EventArchived page, stopping script execution');
    }

    return false;
});

async function startMonitorFlow() {
    console.log('[CS] startMonitorFlow begin');

    if (isBrowsingActivityPausedOnPage()) {
        console.warn('[CS] startMonitorFlow aborted — browsing activity paused (no seat checks)');
        startBrowsingActivityPauseRecoveryIfNeeded();
        return;
    }
    const { browsingPauseCooldownUntil = 0 } = await chrome.storage.local.get('browsingPauseCooldownUntil');
    if (Number(browsingPauseCooldownUntil) > Date.now()) {
        const remainSec = Math.ceil((Number(browsingPauseCooldownUntil) - Date.now()) / 1000);
        console.warn('[CS] startMonitorFlow aborted — browsing-pause 10 min cooldown active (' + remainSec + 's left)');
        return;
    }
    //                         eventUrl: row.eventUrl,
    //                         startSecond: row.startSecond,
    //                         areSeatsTogether: row.areSeatsTogether === 'true', // convert to boolean
    //                         quantity: parseInt(row.quantity, 10) || 1,
    //                         discordWebhook: row.discordWebhook,
    //                         telegramWebhook: row.telegramWebhook,
    //                         telegramChatId: row.telegramChatId,
    //                         eventId: row.eventId,
    //                         maximumPrice: row.maximumPrice,
    //                         minimumPrice: row.minimumPrice


    const {sheetUrl, startSecond} = await chrome.storage.local.get(['sheetUrl', 'startSecond']);
    monitor.sheetUrl = sheetUrl;
    monitor.startSecond = startSecond;
    const { eventUrl, discordWebhook, telegramWebhook, telegramChatId } = await chrome.storage.local.get([
        'eventUrl', 'discordWebhook', 'telegramWebhook', 'telegramChatId'
    ]);
    monitor.eventUrl = eventUrl;
    if (discordWebhook) monitor.discordWebhook = discordWebhook;
    if (telegramWebhook) monitor.telegramWebhook = telegramWebhook;
    if (telegramChatId != null && String(telegramChatId).trim() !== '') monitor.telegramChatId = String(telegramChatId).trim();
    monitor.areSeatsTogether = await chrome.storage.local.get('areSeatsTogether').then(res => res.areSeatsTogether === true);
    monitor.quantity = await chrome.storage.local.get('quantity').then(res => parseInt(res.quantity || '1', 10));
    monitor.eventId = await chrome.storage.local.get('eventId').then(res => res.eventId || null);


    console.log('[CS] monitor config:', monitor);

    if (!monitor.eventUrl) {
        //read all data from google sheet and set
        console.warn('[CS] no eventUrl found in storage, will not monitor');
        if (monitor.sheetUrl) {
            console.warn('[CS] using sheetUrl', monitor.sheetUrl, 'to read eventUrl');
            //read from sheet
            const row = await getMatchingRowFromSheet(monitor.sheetUrl, monitor.startSecond);
            if (row) {
                const ev = eventUrlFromSheetRow(row);
                if (ev) monitor.eventUrl = ev;
                monitor.startSecond = parseFloat(row.StartSecond) ?? monitor.startSecond;
                syncSeatPairSettingsFromSheetRow(row);
                rollSeatPairModeIfChanceActive();
                syncMonitorMessagingFromSheetRow(row);

                // Save AreSeatsTogether, Quantity, and login credentials to local storage to avoid name mismatch
                // Try multiple variations of the areaIds column name
                const areaIdsValue = row['areaIds to monitor'] || row['AreaIds to monitor'] || row['areaIds to Monitor'] || 
                                    row.AreaIds || row.areaIds || row['AreaIds'] || row['areaIds'] || '';
                
                // Try multiple variations of the areas to ignore column name
                const areasToIgnoreValue = row['areas to ignore'] || row['Areas to ignore'] || row['Areas to Ignore'] || 
                                          row.AreasToIgnore || row.areasToIgnore || row['AreasToIgnore'] || row['areasToIgnore'] || '';
                
                
                const resaleChancesInit = getResaleEndpointChancesFromRow(row);
                const loginEmail = getLoginEmailFromSheetRow(row);
                await chrome.storage.local.set({
                    areSeatsTogether: monitor.areSeatsTogether,
                    quantity: monitor.quantity,
                    eventUrl: monitor.eventUrl || '',
                    discordWebhook: monitor.discordWebhook || '',
                    telegramWebhook: monitor.telegramWebhook || '',
                    telegramChatId: monitor.telegramChatId || '',
                    loginEmail,
                    loginPassword: row.LoginPassword || '',
                    areaIds: areaIdsValue,
                    areasToIgnore: areasToIgnoreValue,
                    resaleEndpointChances: resaleChancesInit != null ? resaleChancesInit : DEFAULT_RESALE_ENDPOINT_CHANCES,
                    focusRefreshTab: focusRefreshTabFromContentSheetRow(row)
                });
            } else {
                console.warn('[CS] no matching row found in sheet for startSecond', monitor.startSecond);
            }
        }

        // console.warn('[CS] no eventUrl found, will not monitor');
        // return;
    }

    monitor.eventId = extractEventId(monitor.eventUrl || location.href);
    console.log('[CS] using eventId', monitor.eventId);

    if (!monitor.running) {
        // Legacy flag from prior "reload validation tab" behavior is no longer used.
        await chrome.storage.local.set({ seat403AfterReloadNeeds12s: false });
        monitor.running = true;
        seatCheckLoopIteration = 0;
        lastLoggedSeatCheckSheetStatus = null;
        console.log('[CS] starting ======== monitor loop');
        //run immediate check once for first time
        // await alignToStartSecond(monitor.startSecond).catch(e => console.error('[CS] alignToStartSecond error', e));
        // console.log('[CS] aligned to startSecond', monitor.startSecond);
        await checkOnce().catch(e => console.error('[CS] checkOnce error', e));

        scheduleNextCheck(); // first call
    } else {
        console.log('[CS] monitor already running');
    }
}


let lastScheduledTime = null; // stores the planned next run time
let lastRealignTime = null;   // stores the timestamp of the last realignment
let lastRunStartTime = null; // when runCheck() last started (used to log response time)
let nextCheckTimeoutId = null; // single scheduled timeout; clear before setting new one to avoid duplicate API calls per cycle
let runCheckInProgress = false; // guard so only one runCheck (and thus one API call) runs at a time
/** When true, next checkOnce skips the seat GET until refreshEventTabWithTracking confirms eventTabReloaded. */
let pendingSkipSeatFetchEventReloadTimeout = false;

/** Format date as HH:mm:ss.SSS for logs so 80.5 vs 80 are distinguishable. */
function formatTimeWithMs(date) {
    const d = new Date(date);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms}`;
}

/**
 * Generic formula: next API call = next time (clock seconds) matches extension number in the 12s cycle.
 * - Extension 1  → refresh at :01, :13, :25, :37, :49 (seconds)
 * - Extension 1.5 → refresh at :01.5, :13.5, :25.5, ...
 * - Extension 2  → refresh at :02, :14, :26, ...
 * Formula: (clock sec + ms/1000) % 12 === extensionNumber % 12. Returns ms until that moment.
 */
function getAlignMsToNextInterval(dateNow, startSecondVal, intervalMs) {
    const baseSec = parseFloat(startSecondVal);
    if (Number.isNaN(baseSec)) return intervalMs;
    const baseOffsetMs = ((baseSec * 1000) % intervalMs + intervalMs) % intervalMs;
    const curMsInCycle = (dateNow.getSeconds() * 1000 + dateNow.getMilliseconds()) % intervalMs;
    let alignMs = (baseOffsetMs - curMsInCycle + intervalMs) % intervalMs;
    if (alignMs <= 0) alignMs = intervalMs;
    return alignMs;
}

async function scheduleNextCheck() {
    const waitMs = 12000; // 12s cycle: extension N refreshes when clock (sec % 12) === N (e.g. ext 1 at :01/:13/:25, ext 1.5 at :01.5/:13.5)
    const realignIntervalMs = 120000; // 2 min log only; schedule is always from clock

    // While Queue-IT is active, do not drive heartbeat health monitoring (BG freezes too); poll lightly until queue clears
    const { inQueueWaiting } = await chrome.storage.local.get('inQueueWaiting');
    if (inQueueWaiting === true) {
        if (nextCheckTimeoutId != null) clearTimeout(nextCheckTimeoutId);
        nextCheckTimeoutId = setTimeout(() => { nextCheckTimeoutId = null; runCheck(); }, 5000);
        return;
    }

    // During error403 pause, poll every 5s so we resume quickly when flag clears
    const { error403PauseUntil = 0 } = await chrome.storage.local.get('error403PauseUntil');
    if (error403PauseUntil > 0 && Date.now() < error403PauseUntil) {
        if (!pauseActiveLogged) {
            console.log('[CS] error403 pause is active — seat checks and event tab refresh paused until it ends.');
            pauseActiveLogged = true;
        }
        chrome.runtime.sendMessage({ type: 'heartbeat' }).catch(() => {});
        if (nextCheckTimeoutId != null) clearTimeout(nextCheckTimeoutId);
        nextCheckTimeoutId = setTimeout(() => { nextCheckTimeoutId = null; runCheck(); }, 5000);
        return;
    }
    pauseActiveLogged = false; // pause ended or not active; allow one-time log next time pause is active

    const now = Date.now();

    const base = monitor.startSecond ?? 0;
    const dateNow = new Date();
    // Single formula: next API call = next time clock (sec % 12) matches extension number
    let delay = getAlignMsToNextInterval(dateNow, base, waitMs);
    // After event tab refresh **timed out** (tab never signalled ready), add a cooldown before next API call.
    // Successful reload already waited for verification token — do not add extra delay; stay on 12s clock alignment.
    if (lastEventTabRefreshAt > 0) {
        const minDelayAfterRefresh = minDelayAfterEventTabRefreshMs;
        const elapsedSinceRefresh = now - lastEventTabRefreshAt;
        if (elapsedSinceRefresh < minDelayAfterRefresh) {
            const extraWait = minDelayAfterRefresh - elapsedSinceRefresh;
            delay = Math.max(delay, extraWait);
        }
        lastEventTabRefreshAt = 0;
        minDelayAfterEventTabRefreshMs = 15000;
    }
    // If the next call would happen too soon (<7s), skip to the next 12s cycle so we don't hammer the API,
    // while still keeping alignment to the 12s clock.
    const minGapMs = 7000;
    while (delay < minGapMs) {
        delay += waitMs;
    }
    lastScheduledTime = now + delay;
    if (!lastRealignTime) lastRealignTime = now;

    // Log realignment every 2 min (informational only; schedule is always from clock)
    if (now - lastRealignTime >= realignIntervalMs) {
        console.log(`[CS] Realigning (2 min): next call still bound to extension ${base} at :${(base % 12).toFixed(1)}s in each 12s cycle`);
        lastRealignTime = now;
    }

    const responseTimeMs = typeof lastRunStartTime === 'number' ? now - lastRunStartTime : 0;
    const nextCallAt = new Date(now + delay);
    const delaySec = (delay / 1000).toFixed(2);
    const timeStr = formatTimeWithMs(nextCallAt);
    const baseStr = monitor.startSecond != null ? ' startSecond=' + monitor.startSecond : '';
    if (typeof lastRunStartTime === 'number') {
        console.log('[CS] API+processing took ' + (responseTimeMs / 1000).toFixed(2) + 's, next seat API call in ' + delaySec + 's at ' + timeStr + baseStr);
    } else {
        console.log('[CS] Next seat API call in ' + delaySec + 's at ' + timeStr + baseStr);
    }
    chrome.runtime.sendMessage({type: "heartbeat"});
    if (nextCheckTimeoutId != null) clearTimeout(nextCheckTimeoutId);
    nextCheckTimeoutId = setTimeout(() => { nextCheckTimeoutId = null; runCheck(); }, delay);
}

async function runCheck() {
    if (runCheckInProgress) return; // prevent duplicate API calls when two timeouts or resume fire close together
    runCheckInProgress = true;
    try {
        if (monitor.running) {
            if (seatCheckLoopIteration > 0) {
                console.log('');
            }
            seatCheckLoopIteration++;
        }
        lastRunStartTime = Date.now();
        await checkOnce().catch(e => console.error('[CS] checkOnce err', e));
        if (monitor.running) scheduleNextCheck();
    } finally {
        runCheckInProgress = false;
    }
}


function extractEventId(url) {
    try {
        const m = (url || '').match(/\/Event\/Index\/(\d+)/);
        if (m) return parseInt(m[1], 10);
        const m2 = (url || '').match(/eventid=(\d+)/i);
        if (m2) return parseInt(m2[1], 10);
        return null;
    } catch (e) {
        return null;
    }
}

async function alignToStartSecond(startSec) {
    const now = new Date();
    const curSec = now.getSeconds();
    let waitMs = 0;
    if (startSec === undefined || startSec === null) startSec = 2;
    if (curSec === startSec) waitMs = 0;
    else if (curSec < startSec) waitMs = (startSec - curSec) * 1000;
    else waitMs = ((60 - curSec) + startSec) * 1000;
    console.log(`[CS] aligning to second ${startSec}. waiting ${waitMs / 1000}s`);
    return new Promise(resolve => setTimeout(resolve, waitMs));
}

/** Google Sheet column "Resale Endpoint Chances": 100 = always resale, 50 = ~50% resale / ~50% regular, 0 = always regular. Missing column → null (caller uses DEFAULT_RESALE_ENDPOINT_CHANCES). */
function getResaleEndpointChancesFromRow(row) {
    if (!row) return null;
    const raw = row['Resale Endpoint Chances'] ?? row['resale endpoint chances'] ?? row.ResaleEndpointChances ?? row.resaleEndpointChances;
    if (raw === '' || raw == null || String(raw).trim() === '') return null;
    const n = parseFloat(String(raw).replace(/%/g, '').trim());
    if (!Number.isFinite(n)) return null;
    return Math.min(100, Math.max(0, n));
}

/**
 * Google Sheet "Pair check chance": empty → null (use AreSeatsTogether + Quantity as written).
 * 0–100: each time this runs, with probability pct% use AreSeatsTogether=true & Quantity=2, else false & 1.
 * 100 = always pair (ignores the AreSeatsTogether / Quantity cells for that roll).
 */
function getPairCheckChanceFromRow(row) {
    if (!row) return null;
    const raw = row['Pair check chance'] ?? row['Pair Check Chance'] ?? row['pair check chance'] ?? row.PairCheckChance ?? row.pairCheckChance;
    if (raw === '' || raw == null || String(raw).trim() === '') return null;
    const n = parseFloat(String(raw).replace(/%/g, '').trim());
    if (!Number.isFinite(n)) return null;
    return Math.min(100, Math.max(0, n));
}

/** Event URL from sheet row (header name variants). */
function eventUrlFromSheetRow(row) {
    if (!row) return '';
    const u = row.EventUrl ?? row['Event URL'] ?? row['event url'] ?? row.EventURL ?? row.eventUrl;
    if (u == null) return '';
    return String(u).trim();
}

/** Sheet → monitor: DiscordWebhook, TelegramBotToken (stored as telegramWebhook), TelegramChatID. Empty cell clears that field. */
function syncMonitorMessagingFromSheetRow(row) {
    if (!row) return;
    if (row.DiscordWebhook !== undefined) {
        monitor.discordWebhook = String(row.DiscordWebhook ?? '').trim();
    }
    if (row.TelegramBotToken !== undefined || row.TelegramWebhook !== undefined) {
        monitor.telegramWebhook = String(row.TelegramBotToken ?? row.TelegramWebhook ?? '').trim();
    }
    if (row.TelegramChatID !== undefined || row.TelegramChatId !== undefined) {
        monitor.telegramChatId = String(row.TelegramChatID ?? row.TelegramChatId ?? '').trim();
    }
}

/** Reads sheet row: stores pair-check %; if empty, applies AreSeatsTogether + Quantity from sheet. */
function syncSeatPairSettingsFromSheetRow(row) {
    monitor.pairCheckChancePct = getPairCheckChanceFromRow(row);
    if (monitor.pairCheckChancePct == null) {
        monitor.areSeatsTogether = row.AreSeatsTogether === true || ('' + row.AreSeatsTogether).toLowerCase() === 'true';
        monitor.quantity = parseInt(row.Quantity || '1', 10);
    }
}

/** Sheet column "Focus Refresh tab?" (any casing/spacing): No/false/0 → background-only refresh; empty/Yes/other → focus when refreshing. */
function focusRefreshTabFromContentSheetRow(row) {
    if (!row || typeof row !== 'object') return true;
    let v;
    for (const key of Object.keys(row)) {
        const norm = String(key).replace(/\s+/g, '').replace(/\?/g, '').toLowerCase();
        if (norm === 'focusrefreshtab') {
            v = row[key];
            break;
        }
    }
    if (v == null || String(v).trim() === '') return true;
    const s = String(v).trim().toLowerCase();
    if (s === 'no' || s === 'false' || s === '0') return false;
    return true;
}

function getSheetValueByNormalizedKey(row, normalizedKey) {
    if (!row || typeof row !== 'object') return '';
    const target = String(normalizedKey || '').replace(/\s+/g, '').toLowerCase();
    for (const key of Object.keys(row)) {
        const norm = String(key).replace(/\s+/g, '').toLowerCase();
        if (norm === target) return row[key];
    }
    return '';
}

function getLoginEmailFromSheetRow(row) {
    const raw =
        getSheetValueByNormalizedKey(row, 'loginemail') ||
        row?.LoginEmail ||
        row?.loginEmail ||
        row?.['Login Email'] ||
        row?.['login email'] ||
        '';
    return String(raw || '').trim();
}

async function persistLoginEmailFromSheetRow(row, sourceLabel) {
    const email = getLoginEmailFromSheetRow(row);
    const prev = await chrome.storage.local.get('loginEmail');
    const prevEmail = String(prev.loginEmail || '').trim();
    const nextEmail = String(email || '').trim();
    await chrome.storage.local.set({ loginEmail: nextEmail });
    if (nextEmail !== prevEmail) {
        if (nextEmail) {
            console.log('[CS] loginEmail updated from', sourceLabel || 'sheet', ':', nextEmail.substring(0, 5) + '...');
        } else {
            console.warn('[CS] loginEmail cleared in', sourceLabel || 'sheet');
        }
    }
    return nextEmail;
}

/** When Pair check chance is set, roll every seat API cycle (pair = true & 2, else false & 1). */
function rollSeatPairModeIfChanceActive() {
    const pct = monitor.pairCheckChancePct;
    if (pct == null) return;
    if (Math.random() * 100 < pct) {
        monitor.areSeatsTogether = true;
        monitor.quantity = 2;
    } else {
        monitor.areSeatsTogether = false;
        monitor.quantity = 1;
    }
}

async function getMatchingRowFromSheet(sheetUrl, startSecond) {
    try {
        // Extract sheet ID and gid
        const m = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
        if (!m) throw new Error('Invalid sheet URL');
        const sheetId = m[1];
        let gidMatch = sheetUrl.match(/[?&]gid=(\d+)/);
        const gid = gidMatch ? gidMatch[1] : '0';

        // Build GViz URL
        const gviz = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&gid=${gid}`;
        const res = await fetch(gviz);
        const txt = await res.text();

        // Parse JSON from GViz format
        const jsonText = txt.replace(/^[^\{]+/, '').replace(/\);?$/, '');
        const obj = JSON.parse(jsonText);

        const table = obj.table;
        if (!table || !table.rows) throw new Error('No table data found');

        // Headers
        const headers = table.cols.map(c => (c.label || '').trim());

        let rowMatchedButOff = false;
        // Iterate rows
        for (const row of table.rows) {
            const values = (row.c || []).map(cell => cell ? cell.v : '');
            const rowData = {};
            headers.forEach((h, i) => {
                rowData[h] = values[i];
            });

            // Check match (startSecond can be decimal, e.g. 2.5; compare as float)
            const status = (rowData.Status || '').toString().trim().toLowerCase();
            const sheetSecond = parseFloat(rowData.StartSecond);
            const matchSecond = Number.isNaN(sheetSecond) ? null : sheetSecond;
            const configSecond = parseFloat(startSecond);
            const match = (matchSecond != null && !Number.isNaN(configSecond) && matchSecond === configSecond);
            if (match) {
                await persistLoginEmailFromSheetRow(rowData, 'matching sheet row');
                if (['off', '0', 'false', 'stop'].includes(status)) {
                    console.log('[CS] found matching row but status is Off, will not monitor');
                    rowMatchedButOff = true;
                    continue; // skip this row
                }
            }
            if (status === 'on' && match) {
                // console.log('[CS] Found matching row data:', rowData);
                return rowData; // Found matching row
            }

        }
        if (rowMatchedButOff) {
            console.log('[CS] found matching row for startSecond', startSecond, 'but status is Off, will not monitor');
            stopMonitoring('sheet status is Off');
            return null; // matched but off, stop monitoring
        }

        return null; // No match found
    } catch (err) {
        console.error('Error reading sheet:', err);
        return null;
    }
}

let checksheet = true;//read sheet one time and not next and so on
/** Dedupe `[CS] sheet status on` when unchanged between sheet polls. */
let lastLoggedSeatCheckSheetStatus = null;
/** Printed blank line between seat-check iterations (starts at 2nd runCheck). */
let seatCheckLoopIteration = 0;

// Separate error counters for different error types
let error403Count = 0;           // For 403 Forbidden errors (seat check)
/** Two consecutive **Resale** seat-check HTTP 200s reset `seatCheck403BackoffTier` (Regular 200s do not count and break the streak). */
let consecutiveResaleSeatCheck200Count = 0;
let lastEventTabRefreshAt = 0;  // set only when event tab reload **times out** — then next API waits minDelayAfterEventTabRefreshMs
let minDelayAfterEventTabRefreshMs = 15000; // cooldown after failed reload wait (successful reload uses 12s alignment only)
let tunnelTimeoutErrorCount = 0; // For tunnel connection and timeout errors
let corsErrorCount = 0;          // For CORS errors
let notfound400erorsCount = 0;   // For other HTTP errors (400, 401, 402, 302, 500)
let pauseActiveLogged = false;   // one-time log when error403 pause is active; reset when pause ends to avoid log spam

async function tryDirectAddToBasketSecondapi(data, clubname, eventId, verificationToken, endpointType = 'Regular') {
    let successCount = 0;       // Track successful adds
    let totalFetchCount = 0;    // Track total fetch attempts
    
    // Get PriceClassId for this club
    const priceClassId = getPriceClassIdForClub(clubname);

    const { areaIds, areasToIgnore } = await chrome.storage.local.get(['areaIds', 'areasToIgnore']);
    let allowedSet = null;
    if (areaIds && String(areaIds).trim() !== '') {
        const arr = String(areaIds).split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
        allowedSet = arr.length ? new Set(arr) : null;
    }
    let ignoredSet = null;
    if (areasToIgnore && String(areasToIgnore).trim() !== '') {
        const arr = String(areasToIgnore).split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
        ignoredSet = arr.length ? new Set(arr) : null;
    }
    const toAreaIdNum = (v) => { const n = Number(v); return isNaN(n) ? null : n; };
    const areasToTry = data.filter(area => {
        const id = toAreaIdNum(area.AreaId);
        if (id == null) return false;
        if (allowedSet && !allowedSet.has(id)) return false;
        if (ignoredSet && ignoredSet.has(id)) return false;
        return true;
    });
    if (areasToTry.length === 0) return false;

    for (let a = areasToTry.length - 1; a >= 0; a--) {
        const area = areasToTry[a];

        for (const priceBand of area.PriceBands) {
            for (const interval of priceBand.AvailableSeatsIntervals) {

                // Loop through all seats from StartXCoord to EndXCoord
                for (let x = interval.StartXCoord; x <= interval.EndXCoord; x++) {

                    if (totalFetchCount >= 4) {
                        return successCount > 0;
                    }

                    const seatPayload = {
                        EventId: eventId,
                        Seats: [
                            {
                                AreaId: area.AreaId,
                                XCoordinate: x,
                                YCoordinate: interval.YCoord,
                                PriceClassId: priceClassId,
                                IsSecondaryMarket: endpointType === 'Resale'
                            }
                        ]
                    };

                    try {
                        totalFetchCount++;
                        const res = await fetch(`https://www.eticketing.co.uk/${clubname}/EDP/Ism/Select${endpointType}Seat`, {
                            method: "PUT",
                            credentials: "include",
                            headers: {
                                "Accept": "application/json, text/plain, */*",
                                "Content-Type": "application/json",
                                "X-Requested-With": "XMLHttpRequest",
                                "RequestVerificationToken": verificationToken
                            },
                            body: JSON.stringify(seatPayload)
                        });

                        if (res.status === 400) {
                            await res.text();
                        } else if (res.status === 200) {
                            await res.text();
                            successCount++;
                            if (successCount >= 3) return true;
                        }
                    } catch (err) {
                        // silent during try loop for speed
                    }
                }
            }
        }
    }

    // No log here (hot path); outcome logged by caller after basket flow completes or fails
    return successCount > 0; // True if at least one success
}

let queueItErrorCount = 0;  // track consecutive queue-it redirect errors

function parseBasketHtml(html) {
    try {
        // Create a temporary DOM parser
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        const basketEvents = [];
        const basketEventElements = doc.querySelectorAll('.basket-event');
        
        basketEventElements.forEach((eventElement, index) => {
            const itemRef = eventElement.getAttribute('basket-event-item-ref');
            const eventTitle = eventElement.querySelector('.basket-event__title')?.textContent?.trim();
            
            // Get seat details
            const areaElement = eventElement.querySelector('[data-testid="seat-detail-area"] .checkout-event-seat-details__value');
            const blockElement = eventElement.querySelector('[data-testid="seat-detail-block"] .checkout-event-seat-details__value');
            const rowElement = eventElement.querySelector('[data-testid="seat-detail-row"] .checkout-event-seat-details__value');
            const seatElement = eventElement.querySelector('[data-testid="seat-detail-seat-number"] .checkout-event-seat-details__value');
            
            // Get price class
            const priceClassElement = eventElement.querySelector('[data-testid="seat-price-class"] dd');
            
            // Get price
            const priceElement = eventElement.querySelector(`#basket-item-price-${itemRef}`);
            
            const seatData = {
                itemRef: itemRef,
                eventTitle: eventTitle,
                area: areaElement?.textContent?.trim(),
                block: blockElement?.textContent?.trim(),
                row: rowElement?.textContent?.trim(),
                seat: seatElement?.textContent?.trim(),
                priceClass: priceClassElement?.textContent?.trim(),
                price: priceElement?.textContent?.trim()
            };
            
            basketEvents.push(seatData);
        });
        
        return {
            events: basketEvents,
            totalEvents: basketEvents.length
        };
    } catch (e) {
        console.error('[CS] Error parsing basket HTML:', e);
        return { events: [], totalEvents: 0 };
    }
}

function shouldSendNotificationBasedOnSeats(basketData) {
    if (!basketData || basketData.events.length === 0) {
        console.log('[CS] No basket events found, will send notification');
        return { shouldSend: true, pairs: [], pairCount: 0 };
    }
    
    const events = basketData.events;
    console.log('[CS] Analyzing', events.length, 'basket events for pair detection');
    
    // Group seats by block and row to find pairs
    const seatGroups = {};
    events.forEach(event => {
        const key = `${event.block}-${event.row}`;
        if (!seatGroups[key]) {
            seatGroups[key] = [];
        }
        seatGroups[key].push({
            ...event,
            seatNumber: parseInt(event.seat) || 0
        });
    });
    
    // Find pairs (adjacent seats in same block and row)
    const pairs = [];
    Object.values(seatGroups).forEach(group => {
        // Sort by seat number
        group.sort((a, b) => a.seatNumber - b.seatNumber);
        
        // Find adjacent seats
        for (let i = 0; i < group.length - 1; i++) {
            if (group[i + 1].seatNumber === group[i].seatNumber + 1) {
                pairs.push({
                    seat1: group[i],
                    seat2: group[i + 1],
                    block: group[i].block,
                    row: group[i].row
                });
                i++; // Skip next seat as it's already paired
            }
        }
    });
    
    const pairCount = pairs.length;
    console.log('[CS] Found', pairCount, 'pairs:', pairs);
    
    // Always send notification, but include pair information
    const shouldSend = true;
    console.log('[CS] Should send notification:', shouldSend, '(always send, pairs found:', pairCount, ')');
    
    return { shouldSend, pairs, pairCount };
}

// Helper function to get email for notifications (prefer sheet-backed loginEmail so Discord shows current account after sheet update)
async function getEmailForNotification() {
    try {
        console.log('[CS] Getting email for notification...');
        const EMAIL_KEY = "user_email";

        // Method 1: chrome.storage.local (loginEmail from Google Sheet - updated when sheet/popup changes)
        const storageData = await chrome.storage.local.get(['loginEmail']);
        if (storageData.loginEmail && storageData.loginEmail.trim()) {
            console.log('[CS] Email from storage (sheet):', storageData.loginEmail.substring(0, 5) + '...');
            return storageData.loginEmail.trim();
        }

        // Method 2: Google Sheet directly (if storage not yet set)
        if (monitor.sheetUrl && monitor.startSecond) {
            try {
                const matched_row = await getMatchingRowFromSheet(monitor.sheetUrl, monitor.startSecond);
                const emailFromRow = getLoginEmailFromSheetRow(matched_row);
                if (emailFromRow) {
                    console.log('[CS] Email from sheet:', emailFromRow.substring(0, 5) + '...');
                    await chrome.storage.local.set({ loginEmail: emailFromRow });
                    return emailFromRow;
                }
            } catch (e) {
                console.warn('[CS] Error getting email from sheet:', e.message);
            }
        }

        // Method 3: Refresh credentials from background then storage
        try {
            const response = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ action: 'refreshCredentials' }, (response) => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(response);
                });
            });
            if (response && response.success) {
                const refreshedData = await chrome.storage.local.get(['loginEmail']);
                if (refreshedData.loginEmail && refreshedData.loginEmail.trim()) {
                    console.log('[CS] Email after refresh:', refreshedData.loginEmail.substring(0, 5) + '...');
                    return refreshedData.loginEmail.trim();
                }
            }
        } catch (e) {
            console.warn('[CS] Error refreshing credentials:', e.message);
        }

        // Method 4: localStorage (legacy / from page scrape - may be stale after sheet update)
        const userEmail = localStorage.getItem(EMAIL_KEY);
        if (userEmail && userEmail.trim()) {
            console.log('[CS] Email from localStorage (fallback):', userEmail.substring(0, 5) + '...');
            return userEmail.trim();
        }

        console.warn('[CS] No email from any source, returning "Unknown Email"');
        return "Unknown Email";
    } catch (e) {
        console.error('[CS] Error getting email for notification:', e);
        return "Unknown Email";
    }
}

/** Strip HTML from lock/error responses; preserve line breaks where possible (e.g. ticket limit messages). */
function plainTextFromLockApiBody(raw) {
    if (raw == null || typeof raw !== 'string') return '';
    return raw
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li)\s*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .split('\n')
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
        .trim();
}

/** Pull human-readable lines from JSON lock / validation error bodies. */
function plainTextFromJsonLockError(obj) {
    if (obj == null) return '';
    if (typeof obj === 'string') return obj.trim();
    const parts = [];
    const push = (v) => {
        if (v == null || v === '') return;
        const s = String(v).trim();
        if (s) parts.push(s);
    };
    push(obj.Message);
    push(obj.message);
    push(obj.error);
    push(obj.Error);
    push(obj.title);
    push(obj.Title);
    push(obj.ExceptionMessage);
    push(obj.Detail);
    push(obj.detail);
    if (Array.isArray(obj.Errors)) {
        for (const e of obj.Errors) {
            if (typeof e === 'string') push(e);
            else if (e && typeof e === 'object') {
                push(e.ErrorMessage || e.Message || e.message || e.error);
            }
        }
    }
    if (obj.ModelState && typeof obj.ModelState === 'object') {
        for (const k of Object.keys(obj.ModelState)) {
            const arr = obj.ModelState[k];
            if (Array.isArray(arr)) arr.forEach((x) => push(x));
        }
    }
    if (parts.length) return parts.join('\n');
    try {
        return JSON.stringify(obj, null, 2);
    } catch (_) {
        return '';
    }
}

/** Raw lock API body → text for Discord (JSON messages or HTML stripped). */
function extractLockApiErrorTextFromRaw(raw) {
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (!t) return '';
    const looksJson = (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
    if (looksJson) {
        try {
            const j = JSON.parse(t);
            const fromJson = plainTextFromJsonLockError(j);
            if (fromJson && fromJson.trim()) return fromJson.trim();
        } catch (_) {
            /* not valid JSON, fall through */
        }
    }
    return plainTextFromLockApiBody(t);
}

/** Read `fetch` response body once; normalize HTML, JSON, or plain text for notifications. */
async function plainTextFromFetchResponse(res) {
    if (!res || typeof res.text !== 'function') return '';
    try {
        const raw = await res.text();
        return extractLockApiErrorTextFromRaw(raw);
    } catch (_) {
        return '';
    }
}

/** IIS / long HTML errors: prefer text before "Most likely causes:" when that head is substantial; otherwise keep full body so we do not drop the only useful text. */
function clipLockApiBodyForDiscord(plain) {
    let s = String(plain).trim();
    if (!s) return '';
    const re = /most likely causes:/i;
    const m = re.exec(s);
    if (!m) return s.replace(/\s+$/, '');
    const head = s.slice(0, m.index).trim();
    // If stripping at "Most likely causes" removes almost everything, keep full text (common on 404 IIS pages).
    if (head.length < 40) return s.replace(/\s+$/, '');
    return head.replace(/\s+$/, '');
}

/** Non-empty API body snippet for Discord (capped length for webhook limits). */
function discordResponseBodySection(label, plain) {
    const raw = plain != null ? String(plain) : '';
    const trimmed = raw.trim();
    if (!trimmed) {
        return '\n📄 **' + label + ':**\n_(no response body or empty)_';
    }
    const max = 1800;
    let s = clipLockApiBodyForDiscord(trimmed);
    if (!s) s = trimmed;
    if (!s) return '\n📄 **' + label + ':**\n_(empty after normalizing)_';
    if (s.length > max) s = s.slice(0, max) + '\n… (truncated)';
    return '\n📄 **' + label + ':**\n' + s;
}

/** Event ID + URL for every Discord/Telegram error (monitor may omit URL briefly — still show "(not set)"). */
function formatNotificationEventContext() {
    const u = (monitor.eventUrl || '').trim();
    const idRaw = monitor.eventId;
    const id = idRaw != null && String(idRaw).trim() !== '' ? String(idRaw).trim() : '';
    let s = '';
    if (id) s += '\n🆔 **Event ID:** ' + id;
    s += '\n🔗 **Event URL:** ' + (u || '(not set)');
    return s;
}

async function checkOnce() {
    if (!monitor.running) return;

    if (isBrowsingActivityPausedOnPage()) {
        console.warn('[CS] Skipping seat check — browsing activity paused on this tab');
        startBrowsingActivityPauseRecoveryIfNeeded();
        return;
    }

    const { browsingPauseCooldownUntil = 0 } = await chrome.storage.local.get('browsingPauseCooldownUntil');
    if (Number(browsingPauseCooldownUntil) > Date.now()) {
        const remainSec = Math.ceil((Number(browsingPauseCooldownUntil) - Date.now()) / 1000);
        console.warn('[CS] Skipping seat check — browsing-pause 10 min cooldown (' + remainSec + 's left)');
        return;
    }

    const { accountRestrictedBlackoutStop, eventRestrictedStop } = await chrome.storage.local.get([
        'accountRestrictedBlackoutStop',
        'eventRestrictedStop'
    ]);
    if (accountRestrictedBlackoutStop === true) {
        console.log('[CS] accountRestrictedBlackoutStop — halting seat checks.');
        stopMonitoring('account restricted blackout');
        return;
    }
    if (eventRestrictedStop === true) {
        console.log('[CS] eventRestrictedStop — halting seat checks.');
        stopMonitoring('event restricted');
        return;
    }

    // Pause seat checking while Queue-IT is active (people ahead / queue waiting)
    const { inQueueWaiting } = await chrome.storage.local.get('inQueueWaiting');
    if (inQueueWaiting === true) {
        console.log('[CS] Queue-IT active (inQueueWaiting) — skipping seat API check');
        return;
    }

    // Pause seat checking while BG error403 pause is active (duration from sheet/queue path: 5+3·n min, cap 30)
    const { error403PauseUntil = 0 } = await chrome.storage.local.get('error403PauseUntil');
    if (error403PauseUntil > 0 && Date.now() < error403PauseUntil) {
        if (!pauseActiveLogged) {
            console.log('[CS] error403 pause is active — seat checks and event tab refresh paused until it ends.');
            pauseActiveLogged = true;
        }
        return;
    }

    const storageSnap = await chrome.storage.local.get(['eventUrl', 'startSecond']);
    const storedEv = (storageSnap.eventUrl || '').trim();
    if (storedEv && storedEv !== (monitor.eventUrl || '').trim()) {
        monitor.eventUrl = storedEv;
        monitor.eventId = extractEventId(storedEv);
        console.log('[CS] eventUrl synced from storage (e.g. sheet poll while monitoring)');
    }
    if (storageSnap.startSecond != null && storageSnap.startSecond !== '') {
        const ss = parseFloat(storageSnap.startSecond);
        if (!Number.isNaN(ss) && ss !== monitor.startSecond) {
            monitor.startSecond = ss;
        }
    }

    let matched_row = null;
    if (checksheet) {
        matched_row = await getMatchingRowFromSheet(monitor.sheetUrl, monitor.startSecond);
        if (matched_row) {
            const sheetEv = eventUrlFromSheetRow(matched_row);
            if (sheetEv) {
                monitor.eventUrl = sheetEv;
                monitor.eventId = extractEventId(sheetEv);
            }
            syncSeatPairSettingsFromSheetRow(matched_row);
            syncMonitorMessagingFromSheetRow(matched_row);

            // Save AreSeatsTogether, Quantity, and login credentials to local storage to avoid name mismatch
            // Try multiple variations of the areaIds column name
            const areaIdsValue = matched_row['areaIds to monitor'] || matched_row['AreaIds to monitor'] || matched_row['areaIds to Monitor'] || 
                                matched_row.AreaIds || matched_row.areaIds || matched_row['AreaIds'] || matched_row['areaIds'] || '';
            
            // Try multiple variations of the areas to ignore column name
            const areasToIgnoreValue = matched_row['areas to ignore'] || matched_row['Areas to ignore'] || matched_row['Areas to Ignore'] || 
                                      matched_row.AreasToIgnore || matched_row.areasToIgnore || matched_row['AreasToIgnore'] || matched_row['areasToIgnore'] || '';
            
            const resaleChances = getResaleEndpointChancesFromRow(matched_row);
            const loginEmail = getLoginEmailFromSheetRow(matched_row);
            await chrome.storage.local.set({
                loginEmail,
                loginPassword: matched_row.LoginPassword || '',
                eventUrl: monitor.eventUrl || '',
                discordWebhook: monitor.discordWebhook || '',
                telegramWebhook: monitor.telegramWebhook || '',
                telegramChatId: monitor.telegramChatId || '',
                areaIds: areaIdsValue,
                areasToIgnore: areasToIgnoreValue,
                resaleEndpointChances: resaleChances != null ? resaleChances : DEFAULT_RESALE_ENDPOINT_CHANCES,
                focusRefreshTab: focusRefreshTabFromContentSheetRow(matched_row)
            });

            const status = (matched_row.Status || '').toString().trim().toLowerCase();
            if (status !== lastLoggedSeatCheckSheetStatus) {
                console.log('[CS] sheet status', status);
                lastLoggedSeatCheckSheetStatus = status;
            }

            if (['off', '0', 'false', 'stop'].includes(status)) {
                console.log('[CS] sheet status is Off, stopping monitoring');
                stopMonitoring('sheet status is Off');
                return;
            } else if (!['on', 'start', 'true', '1'].includes(status)) {
                console.warn('[CS] unknown sheet status:', status);
            }
        }
        checksheet = false;
    } else {
        checksheet = true;
    }

    rollSeatPairModeIfChanceActive();
    await chrome.storage.local.set({
        areSeatsTogether: monitor.areSeatsTogether,
        quantity: monitor.quantity != null ? monitor.quantity : 1
    });

    if (!monitor.eventId) {
        monitor.eventId = extractEventId(monitor.eventUrl || location.href);
        if (!monitor.eventId) {
            console.warn('[CS] no eventId, will not check');
            return;
        }
    }

    function getClubName(url) {
        const parts = url.split('/');
        return parts[3];
    }

    const clubName = getClubName(monitor.eventUrl);
    const { resaleEndpointChances: storedResalePct } = await chrome.storage.local.get(['resaleEndpointChances']);
    let resalePct = parseFloat(storedResalePct);
    if (!Number.isFinite(resalePct)) resalePct = DEFAULT_RESALE_ENDPOINT_CHANCES;
    resalePct = Math.min(100, Math.max(0, resalePct));
    const isResale = Math.random() * 100 < resalePct;
    const endpointType = isResale ? 'Resale' : 'Regular';
    const marketTypeParam = isResale ? '&MarketType=1' : '';
    const url = `https://www.eticketing.co.uk/${clubName}/EDP/Seats/Available${endpointType}?AreSeatsTogether=${monitor.areSeatsTogether}&EventId=${monitor.eventId}${marketTypeParam}&MaximumPrice=10000000&MinimumPrice=0&Quantity=${monitor.quantity}`;

    const seatsCheckEndpointLabel = endpointType;
    let seatsCheckHttpStatus = null;
    const logSeatsOutcome = (detail) => {
        const http = seatsCheckHttpStatus != null ? String(seatsCheckHttpStatus) : 'n/a';
        const q = monitor.quantity != null ? monitor.quantity : '?';
        console.log('[CS] ' + detail + ' | Seats check: ' + seatsCheckEndpointLabel + ', HTTP ' + http + ', quantity: ' + q);
    };

    if (pendingSkipSeatFetchEventReloadTimeout) {
        console.log('[CS] Event tab reload was not confirmed earlier — retrying refresh before seat API (no GET until flag is set).');
        const recovered = await refreshEventTabWithTracking();
        if (!recovered) {
            const reason = await getCurrentSeatsCheckBlockReason();
            logSeatsOutcome('Skipped seat API — event tab reload not confirmed (retry again next cycle); waiting due to: ' + reason);
            return;
        }
    }

    let res;
    try {
        res = await fetch(url, {
            method: 'GET',
            headers: {
                "accept": "application/json, text/plain, */*",
                "x-requested-with": "XMLHttpRequest",
                "referer": location.href
            },
            credentials: "include"
        });
        seatsCheckHttpStatus = res.status;

        // Reset queue-it error count on successful fetch
        // queueItErrorCount = 0;

        // Detect if redirected to queue (queue-it.net or hd-queue.eticketing.co.uk)
        if (res.url.includes('queue-it.net') || res.url.includes('hd-queue.eticketing.co.uk')) {
            queueItErrorCount++;
            console.warn('[CS] Redirected to queue page, count:', queueItErrorCount);

            if (queueItErrorCount >= 1) {
                console.warn('[CS] 1 consecutive queue-it redirects (count:', queueItErrorCount, '), refreshing...');
                chrome.runtime.sendMessage({action: 'closeOtherTabsExcept'});
                const refreshed = await refreshEventTabWithTracking();
                queueItErrorCount = 0; // always reset; if pause blocked refresh we backoff (unblocked time only)
                if (!refreshed) {
                    console.log(
                        '[CS] Refresh blocked by pause — waiting ' +
                            BACKOFF_UNBLOCKED_MS_AFTER_REFRESH_BLOCKED / 1000 +
                            's unblocked (queue / error403 pause excluded) before continuing.'
                    );
                    await delayUnblockedMs(BACKOFF_UNBLOCKED_MS_AFTER_REFRESH_BLOCKED);
                }
                logSeatsOutcome('Redirected to queue');
                return;
            }
        } else {
            // If not queue-it redirect, reset count
            queueItErrorCount = 0;
        }
    } catch (e) {
        console.error('[CS] fetch seats error', e);

        // Detect CORS / Failed to fetch case
        if (e instanceof TypeError && e.message.includes('Failed to fetch')) {
            console.warn('[CS] Failed to fetch error detected');

            // We need to distinguish between different types of "Failed to fetch" errors:
            // 1. CORS errors: Usually happen when redirected to queue-it.net
            // 2. Tunnel connection errors: Network connectivity issues (ERR_TUNNEL_CONNECTION_FAILED)
            // 3. Other network errors: Timeouts, DNS issues, etc.
            
            // The challenge is that both CORS and tunnel errors result in "Failed to fetch"
            // but have different underlying causes. Since we can't access the detailed error
            // from the JavaScript error object, we need a different approach.
            
            // One approach is to use timing or other heuristics, but for now,
            // let's be more conservative and treat most "Failed to fetch" errors as
            // tunnel/network errors, unless we have strong evidence they're CORS errors.
            
            // We'll only treat as CORS errors if we can definitively identify them.
            // For now, let's treat all "Failed to fetch" as tunnel errors to avoid
            // false positives, and rely on the redirect detection logic above
            // to catch actual CORS errors.
            
            tunnelTimeoutErrorCount++;
            console.warn('[CS] Cors or network or Tunnel connection or timeout error detected, count:', tunnelTimeoutErrorCount);
            
            if (tunnelTimeoutErrorCount >= 2) {
                console.warn('[CS] 2 consecutive tunnel/timeout errors (count:', tunnelTimeoutErrorCount, '), refreshing...');
                chrome.runtime.sendMessage({action: 'closeOtherTabsExcept'});
                const refreshed = await refreshEventTabWithTracking();
                tunnelTimeoutErrorCount = 0; // always reset; if pause blocked refresh we backoff (unblocked time only)
                if (!refreshed) {
                    console.log(
                        '[CS] Failed-to-fetch / CORS-like path: refresh blocked by pause — waiting ' +
                            BACKOFF_UNBLOCKED_MS_AFTER_REFRESH_BLOCKED / 1000 +
                            's unblocked (queue / error403 pause excluded) before continuing.'
                    );
                    await delayUnblockedMs(BACKOFF_UNBLOCKED_MS_AFTER_REFRESH_BLOCKED);
                }
                logSeatsOutcome('Tunnel/timeout — refresh triggered');
                return;
            }
        } else {
            // reset on other errors
            queueItErrorCount = 0;
        }

        notfound400erorsCount++;
        logSeatsOutcome('Seats API fetch failed (see error above)');
        return;
    }

    // Only reset all error counters on successful 200 status; two consecutive **Resale** 200s reset 403 backoff tier (not Regular).
    if (res.status === 200) {
        error403Count = 0;
        tunnelTimeoutErrorCount = 0;
        corsErrorCount = 0;
        notfound400erorsCount = 0;
        queueItErrorCount = 0;
        if (isResale) {
            consecutiveResaleSeatCheck200Count++;
            if (consecutiveResaleSeatCheck200Count >= 2) {
                consecutiveResaleSeatCheck200Count = 0;
                const tierSnap = await chrome.storage.local.get('seatCheck403BackoffTier');
                const prevTierSnap = Number(tierSnap.seatCheck403BackoffTier) || 0;
                await chrome.storage.local.set({ seatCheck403BackoffTier: 0 });
                if (prevTierSnap > 0) {
                    console.log(
                        '[CS] Two consecutive Resale seat check HTTP 200 — reset seatCheck403BackoffTier (was ' +
                            prevTierSnap +
                            ').'
                    );
                }
            }
        } else {
            consecutiveResaleSeatCheck200Count = 0;
        }
    } else {
        consecutiveResaleSeatCheck200Count = 0;
    }

    // Handle 403 errors separately
    if (res.status === 403) {
        error403Count++;

        // At every 3 consecutive 403s (3, 6, 9, ...): 1st → 0s + refresh event tab + 12s + tier 1; 2nd+ → Discord + clear cookies + refresh + 30s + tier 0.
        if (error403Count >= 3 && error403Count % 3 === 0) {
            await handleThreeConsecutiveSeat403BackoffAndReload(
                seatsCheckEndpointLabel,
                seatsCheckHttpStatus,
                monitor.quantity
            );
            return;
        }

        logSeatsOutcome('403 Forbidden (count ' + error403Count + ')');
        return;
    }

    // Handle other HTTP errors (400, 401, 402, 302, 500)
    const otherErrorStatuses = [400, 401, 402, 302, 500];
    if (otherErrorStatuses.includes(res.status)) {
        notfound400erorsCount++;
        logSeatsOutcome('Seats check HTTP ' + res.status + ', other-error streak: ' + notfound400erorsCount);

        // If reached 4 errors -> refresh
        if (notfound400erorsCount === 4) {
            console.warn('[CS] 4 consecutive other errors (count:', notfound400erorsCount, ') — refreshing tab.');
            const refreshed = await refreshEventTabWithTracking();
            if (!refreshed) {
                notfound400erorsCount = 0;
                console.log('[CS] Refresh blocked by pause — waiting 60s before continuing.');
                await delay(60000);
            }
        }

        // If reached 7 errors -> clear cookies + refresh
        if (notfound400erorsCount >= 7) {
            console.warn('[CS] 7 or more consecutive other errors (count:', notfound400erorsCount, ') — requesting cookie clear & refresh.');
            chrome.runtime.sendMessage({action: "clearCookiesAndRefresh"});
            bumpValidationMetric('cookiesCleared');
            await delay(2000);
            const refreshed = await refreshEventTabWithTracking();
            notfound400erorsCount = 0; // always reset; if pause blocked refresh we wait 60s below
            if (!refreshed) {
                console.log('[CS] Refresh blocked by pause — waiting 60s before continuing.');
                await delay(60000);
            }
        }

        return;
    }

    let data;
    try {
        data = await res.json();
    } catch (e) {
        console.warn('[CS] seats response JSON parse failed', e);
        logSeatsOutcome('Seats response JSON parse failed');
        return;
    }

    if (!Array.isArray(data) || data.length === 0) {
        logSeatsOutcome('No areas returned (seat not found)');
        return;
    }

    const { areaIds, areasToIgnore } = await chrome.storage.local.get(['areaIds', 'areasToIgnore']);
    let allowedSet = null;
    if (areaIds && String(areaIds).trim() !== '') {
        const arr = String(areaIds).split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
        allowedSet = arr.length ? new Set(arr) : null;
    }
    let ignoredSet = null;
    if (areasToIgnore && String(areasToIgnore).trim() !== '') {
        const arr = String(areasToIgnore).split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
        ignoredSet = arr.length ? new Set(arr) : null;
    }

    const toAreaIdNum = (v) => { const n = Number(v); return isNaN(n) ? null : n; };
    const allAreaIds = data.map(a => toAreaIdNum(a.AreaId)).filter(id => id != null);
    let area = null;
    for (let i = 0; i < data.length; i++) {
        const a = data[i];
        if (!a.PriceBands || !a.PriceBands.length) continue;
        const id = toAreaIdNum(a.AreaId);
        if (id == null) continue;
        if (allowedSet && !allowedSet.has(id)) continue;
        if (ignoredSet && ignoredSet.has(id)) continue;
        area = a;
        break;
    }
    if (!area && (allowedSet || ignoredSet)) {
        const allowedList = allowedSet ? Array.from(allowedSet) : [];
        const ignoredList = ignoredSet ? Array.from(ignoredSet) : [];
        console.log('\n[CS] Seats API areas returned:', allAreaIds.length ? allAreaIds.join(', ') : '(none)');
        console.log('[CS] Seats monitor areaIds (filter):', allowedList.length ? allowedList.join(', ') : '(none)');
        console.log('[CS] Seats ignore areaIds:', ignoredList.length ? ignoredList.join(', ') : '(none)');

        if (allowedSet) {
            logSeatsOutcome('No area matches monitor filter (API returned ' + data.length + ' areas)');
            return;
        }
        area = data.find(a => {
            const id = toAreaIdNum(a.AreaId);
            return id != null && a.PriceBands && a.PriceBands.length && (!ignoredSet || !ignoredSet.has(id));
        }) || null;
        if (!area) {
            logSeatsOutcome('No area matches monitor/ignore after filtering (API returned ' + data.length + ' areas)');
            return;
        }
    }
    // Only fallback to "any area" when there are NO filters configured.
    if (!area && !(allowedSet || ignoredSet)) area = data.find(a => a.PriceBands && a.PriceBands.length) || data[0];
    if (!area) {
        logSeatsOutcome('No area with PriceBands in API response');
        return;
    }

    const priceBand = area.PriceBands[0];
    const areaId = area.AreaId;
    const priceBandId = priceBand.PriceBandCode;

    const { startSecond: storedStartSecondForLock } = await chrome.storage.local.get('startSecond');
    const startSecondDiscordVal =
        storedStartSecondForLock != null && String(storedStartSecondForLock).trim() !== ''
            ? String(storedStartSecondForLock).trim()
            : monitor.startSecond != null && monitor.startSecond !== ''
              ? String(monitor.startSecond)
              : '(n/a)';
    const lockDiscordStartSecondLine = '📊 **startSecond:** ' + startSecondDiscordVal;

    let verificationToken = localStorage.getItem("verification_token");
    if (!verificationToken) {
        verificationToken = 'MOn7sdIDdiCrtszHY1RszN2HcxXfJZh4u5JWRkfGzwqplL9l_wSMkXYhJl3VRBglbAZvjJqeNQLamfQkFoO78OD1eLA1';
    }

    const lockUrl = `https://www.eticketing.co.uk/${clubName}/EDP/BestAvailable/${endpointType}Seats`;
    const lockBody = {
        EventId: monitor.eventId,
        Quantity: monitor.quantity,
        AreSeatsTogether: monitor.areSeatsTogether,
        AreaId: areaId,
        PriceBandId: priceBandId,
        SeatAttributeIds: [],
        MinimumPrice: 0,
        MaximumPrice: 10000000
    };

    let lockRes;
    try {
        // Step 3: Make the POST request including the token
        lockRes = await fetch(lockUrl, {
            method: 'POST',
            headers: {
                "accept": "application/json, text/plain, */*",
                "accept-language": "en-US,en;q=0.9",
                "content-type": "application/json",
                "origin": "https://www.eticketing.co.uk",
                "referer": monitor.eventUrl,
                "requestverificationtoken": verificationToken,
                "sec-ch-ua": "\"Chromium\";v=\"134\", \"Not:A-Brand\";v=\"24\", \"Google Chrome\";v=\"134\"",
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": "\"Windows\"",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
                "x-requested-with": "XMLHttpRequest"
            },
            credentials: "include",
            body: JSON.stringify(lockBody)
        });
    } catch (e) {
        const email = await getEmailForNotification();
        chrome.runtime.sendMessage({
            action: 'notifyErrorWebhooks',
            message:
                `\n\nError locking seats: ${e.message} for AreaId ${areaId} PriceBandId ${priceBandId}\n👤 **Account:** ${email}\n` +
                lockDiscordStartSecondLine +
                formatNotificationEventContext() +
                `\n📍 **Endpoint:** ${endpointType}\n🔢 **Quantity:** ${monitor.quantity}`,
            payload: null
        });
        logSeatsOutcome('Lock request failed: ' + e.message);
        bumpValidationMetric('seatLockFailed');
        return;
    }

    if (lockRes.status === 403) {
        let lock403Plain = '';
        try {
            lock403Plain = extractLockApiErrorTextFromRaw(await lockRes.text());
        } catch (e) {
            lock403Plain = '';
        }

        if (!(await tryDirectAddToBasketSecondapi(data, clubName, monitor.eventId, verificationToken, endpointType))) {
            const email = await getEmailForNotification();
            const errorMessage =
                `🎫 Direct add to basket failed for all areas. Seats were found but could not be added to basket.\n👤 **Account:** ${email}\n` +
                lockDiscordStartSecondLine +
                formatNotificationEventContext() +
                `\n📍 **Endpoint:** ${endpointType}\n🔢 **Quantity:** ${monitor.quantity}${discordResponseBodySection('Lock API (403) response', lock403Plain)}`;
            chrome.runtime.sendMessage({
                action: 'notifyErrorWebhooks',
                message: errorMessage,
                payload: null
            });
            logSeatsOutcome('Direct add to basket failed (lock was 403)');
            bumpValidationMetric('seatLockFailed');
            if (lock403Plain) {
                console.log('[CS] Lock API (403) response text:\n' + lock403Plain);
            }
            return;
        }
    } else if (lockRes.status === 400 || lockRes.status === 404) {
        const lockErrPlain = await plainTextFromFetchResponse(lockRes);
        const email = await getEmailForNotification();
        chrome.runtime.sendMessage({
            action: 'notifyErrorWebhooks',
            message:
                `\n🎫 Seat AreaId ${areaId} PriceBandId ${priceBandId} found but not locked. Status: ${lockRes.status}\n👤 **Account:** ${email}\n` +
                lockDiscordStartSecondLine +
                formatNotificationEventContext() +
                `\n📍 **Endpoint:** ${endpointType}\n🔢 **Quantity:** ${monitor.quantity}${discordResponseBodySection('Lock API (' + lockRes.status + ') response', lockErrPlain)}`,
            payload: null
        });
        logSeatsOutcome('Lock failed HTTP ' + lockRes.status);
        bumpValidationMetric('seatLockFailed');
        return;
    } else if (lockRes.status !== 200) {
        const lockErrPlain = await plainTextFromFetchResponse(lockRes);
        const email = await getEmailForNotification();
        chrome.runtime.sendMessage({
            action: 'notifyErrorWebhooks',
            message:
                `🎫 Error locking seats: ${lockRes.status} for AreaId ${areaId}\n👤 **Account:** ${email}\n` +
                lockDiscordStartSecondLine +
                formatNotificationEventContext() +
                `\n📍 **Endpoint:** ${endpointType}\n🔢 **Quantity:** ${monitor.quantity}${discordResponseBodySection('Lock API (' + lockRes.status + ') response', lockErrPlain)}`,
            payload: null
        });
        logSeatsOutcome('Lock failed HTTP ' + lockRes.status);
        bumpValidationMetric('seatLockFailed');
        return;
    } else {

        let lockJson;
        try {
            lockJson = await lockRes.json();
        } catch (e) {
            lockJson = null;
        }

        const lockedSeats = lockJson?.LockedSeats;
        if (!lockedSeats || lockedSeats.length === 0) {
            logSeatsOutcome('Lock HTTP 200 but no LockedSeats in response');
            bumpValidationMetric('seatLockFailed');
            return;
        }

        const priceClassId = getPriceClassIdForClub(clubName);
        let seatsToAdd;
        if (monitor.areSeatsTogether && monitor.quantity > 1) {
            seatsToAdd = lockedSeats.map(seat => ({ Id: seat.Id, PriceClassId: priceClassId }));
        } else {
            seatsToAdd = [{ Id: lockedSeats[0].Id, PriceClassId: priceClassId }];
        }

        const putBody = { EventId: monitor.eventId, Seats: seatsToAdd };
        let putRes;
        try {
            putRes = await fetch(lockUrl, {
                method: 'PUT',
                headers: {
                    "authority": "www.eticketing.co.uk",
                    "accept": "application/json, text/plain, */*",
                    "accept-encoding": "gzip, deflate, br, zstd",
                    "accept-language": "en-US,en;q=0.9,ur;q=0.8",
                    "content-length": JSON.stringify(putBody).length,

                    "content-type": "application/json",
                    "dnt": "1",
                    "origin": "https://www.eticketing.co.uk",
                    "priority": "u=1, i",
                    "referer": monitor.eventUrl,
                    "requestverificationtoken": verificationToken,
                    "x-requested-with": "XMLHttpRequest"
                },
                credentials: "include",
                body: JSON.stringify(putBody)
            });
        } catch (e) {
            logSeatsOutcome('Add-to-basket request failed before HTTP response');
            bumpValidationMetric('seatLockFailed');
            return;
        }

        // Check if add to basket failed (not 200 or 201)
        if (putRes.status !== 200 && putRes.status !== 201) {
            const putErrPlain = await plainTextFromFetchResponse(putRes);
            // Get email for notification
            const email = await getEmailForNotification();
            
            // Format seat details from lockedSeats
            const seatDetails = lockedSeats.map((seat, idx) => {
                return `Seat ${idx + 1}: ID ${seat.Id}${seat.AreaId ? `, AreaId ${seat.AreaId}` : ''}${seat.Row ? `, Row ${seat.Row}` : ''}${seat.SeatNumber ? `, Seat ${seat.SeatNumber}` : ''}`;
            }).join('\n');
            
            // Create error message with seat details
            const errorMessage = `❌ **SEAT LOCKED BUT NOT ADDED TO BASKET**
════════════════════════════════════════════════════════════════
🎫 **Status:** Seat locked successfully but failed to add to basket (HTTP ${putRes.status})
🆔 **Event ID:** ${monitor.eventId}
🔗 **Event URL:** ${monitor.eventUrl || '(not set)'}
📊 **startSecond:** ${startSecondDiscordVal}
📍 **Area ID:** ${areaId}
🔢 **Quantity:** ${monitor.quantity}
👤 **Account:** ${email}
📍 **Endpoint:** ${endpointType}
            
🎫 **LOCKED SEATS:**
${seatDetails}
${discordResponseBodySection('Basket PUT (HTTP ' + putRes.status + ') response', putErrPlain)}
⚠️ **Action Required:** Please check the basket manually or try again.
════════════════════════════════════════════════════════════════`;
            
            chrome.runtime.sendMessage({
                action: 'notifyErrorWebhooks',
                message: errorMessage,
                payload: null
            });
            logSeatsOutcome('Basket PUT failed HTTP ' + putRes.status);
            bumpValidationMetric('seatLockFailed');
            // Return early to prevent success notification
            return;
        }
        
        // Ticket successfully added to basket (status 200 or 201) — no console logs until data layer work completes
        
        // Wait 2 seconds before calling GetDataLayer to ensure data is ready
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Get data layer (products added to basket)
        const dlUrl = `https://www.eticketing.co.uk/${clubName}/tagManager/GetDataLayer`;
        let dlRes;
        try {
            dlRes = await fetch(dlUrl, {
                method: 'GET',
                headers: {
                    "authority": "www.eticketing.co.uk",
                    "path": `/${clubName}/tagManager/GetDataLayer`,
                    "scheme": "https",
                    "accept-encoding": "gzip, deflate, br, zstd",
                    "accept": "application/json, " +
                        "text/plain, */*",
                    "accept-language": "en-US,en;q=0.9,ur;q=0.8",
                    "dnt": "1",
                    "priority": "u=1, i",
                    "origin": "https://www.eticketing.co.uk",
                    "x-requested-with": "XMLHttpRequest",
                    "referer": monitor.eventUrl
                },
                credentials: "include"
            });
        } catch (e) {
            // silent during hot path
        }
        let dlJson = null;
        try {
            if (dlRes) dlJson = await dlRes.json();
        } catch (e) {
            // silent during hot path
        }

        //asyn call checkOnce function
        checkOnce().catch(e => console.error('[CS] checkOnce error after one product was added to basket', e));



// const message = `Tickets added to basket for Event ${monitor.eventId}. Seat info: ${JSON.stringify(dlJson?.[0]?.products || [])}`;
// Tickets added to basket for Event 3674. Seat info: [{"kickoff_datetime":"2025-09-06 13:30","category_3":"Club Level Tier 2","position":0,"category_2":"Adult","quantity":1,"price":"39.50","currency":"GBP","seatArea":"46","seatBlock":"46 Club Level","seatRow":"7 ","seatSeat":"122","id":"3674","name":"Arsenal Women v London City Lionesses","category":"Match Tickets","business_line":"eTicketing","filter_event_type":"Away Box Office"}]
// Use email from sheet (storage) so Discord shows current account after sheet update; fallback to localStorage
    const userEmail = (await getEmailForNotification()) || "Unknown Email";

    // Extract information from dataLayer - look for the last basket_viewed event
    let basketData = null;
    let products = [];
    let eventName = "Unknown Event";
    let eventDate = "Unknown Date/Time";
    let totalValue = 0;
    let currency = "GBP";
    let membershipType = "Unknown";
    let crn = "Unknown";
    
    if (dlJson && Array.isArray(dlJson)) {
        // First, try to find product_added_to_basket events (these contain price information)
        const productAddedEvents = dlJson.filter(item => item.event === 'product_added_to_basket');
        if (productAddedEvents.length > 0) {
            // Get the last product_added_to_basket event
            basketData = productAddedEvents[productAddedEvents.length - 1];
            products = basketData.products || [];
            
            // Calculate total value from products (sum of all prices)
            totalValue = products.reduce((sum, product) => {
                const price = parseFloat(product.price || 0);
                return sum + (price * (product.quantity || 1));
            }, 0);
            
            currency = products[0]?.currency || basketData.currency || "GBP";
            membershipType = basketData.membership_type || "Unknown";
            crn = basketData.crn || "Unknown";
            
            if (products.length > 0) {
                eventName = products[0].name || "Unknown Event";
                eventDate = products[0].kickoff_datetime || "Unknown Date/Time";
            }
            
        } else {
            // Fall back to basket_viewed event if product_added_to_basket is not found
            const basketViewedEvents = dlJson.filter(item => item.event === 'basket_viewed');
            if (basketViewedEvents.length > 0) {
                basketData = basketViewedEvents[basketViewedEvents.length - 1]; // Get the last one
                products = basketData.products || [];
                totalValue = basketData.value || 0;
                currency = basketData.currency || "GBP";
                membershipType = basketData.membership_type || "Unknown";
                crn = basketData.crn || "Unknown";
                
                if (products.length > 0) {
                    eventName = products[0].name || "Unknown Event";
                    eventDate = products[0].kickoff_datetime || "Unknown Date/Time";
                }
                
            }
        }
    }
    
    // Check if we need to fall back to basket HTML information
    // This happens when:
    // 1. Products array is empty, OR
    // 2. Products array length doesn't match the quantity (incomplete data)
    let expectedQuantity = 0;
    if (basketData) {
        // For product_added_to_basket events, calculate quantity from products
        if (basketData.event === 'product_added_to_basket' && products.length > 0) {
            expectedQuantity = products.reduce((sum, product) => sum + (product.quantity || 1), 0);
        } else {
            // For basket_viewed events, use the quantity from the event
            expectedQuantity = basketData.quantity || 0;
        }
    }
    const needsFallback = products.length === 0 || (expectedQuantity > 0 && products.length < expectedQuantity);
    
    // Only fetch basket HTML if dataLayer is incomplete
    if (needsFallback) {
        const basketUrl = `https://www.eticketing.co.uk/${clubName}/Checkout/Basket`;
        try {
            const basketRes = await fetch(basketUrl, {
                method: 'GET',
                headers: {
                    "authority": "www.eticketing.co.uk",
                    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                    "accept-language": "en-US,en;q=0.9,ur;q=0.8",
                    "dnt": "1",
                    "referer": monitor.eventUrl,
                    "x-requested-with": "XMLHttpRequest"
                },
                credentials: "include"
            });
            
            if (basketRes.ok) {
                const basketHtml = await basketRes.text();
                // Parse basket HTML to get seat details
                const basketHtmlData = parseBasketHtml(basketHtml);
                
                if (basketHtmlData.events && basketHtmlData.events.length > 0) {
                    products = basketHtmlData.events.map(event => ({
                        seatBlock: event.block,
                        seatRow: event.row,
                        seatSeat: event.seat,
                        seatArea: event.area,
                        category_2: event.priceClass,
                        price: event.price,
                        currency: "GBP",
                        name: "Unknown Event",
                        kickoff_datetime: "Unknown Date/Time",
                        category_3: event.block && event.block.toLowerCase().includes('club level') ? 'Club Level' : 'General',
                        business_line: "eTicketing",
                        filter_event_type: "Unknown"
                    }));
                    
                    // Set event name and date from monitor if available
                    if (monitor.eventUrl) {
                        eventName = "Event from URL";
                        eventDate = "Unknown Date/Time";
                    }
                }
            }
        } catch (e) {
            /* silent */
        }
    }

    // Build seat info with proper price formatting
    const seatInfo = products.map((p, idx) => {
        const isClubLevel = p.seatBlock && p.seatBlock.toLowerCase().includes('club level');
        const clubLevelIndicator = isClubLevel ? ' 🏆' : '';
        const price = p.price && p.price !== 'undefined' ? p.price : 'N/A';
        const currency = p.currency && p.currency !== 'undefined' ? p.currency : 'GBP';
        return `**[${idx + 1}]** ${p.seatBlock}${clubLevelIndicator} - Row ${p.seatRow} Seat ${p.seatSeat} (${price} ${currency})`;
    }).join("\n");

    const firstProduct = products[0] || {};

// Format current local date & time
    const now = new Date();
    const formattedNow = now.toLocaleString("en-GB", {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });

// Removed duplicate prevention filter - notifications will be sent every time


    // Detect pairs from products (either dataLayer or basket HTML)
    let pairInfoText = '';
    let basketDetailsText = '';
    
    if (products.length > 0) {
        // Group seats by block and row to find pairs
        const seatGroups = {};
        products.forEach(product => {
            const key = `${product.seatBlock}-${product.seatRow}`;
            if (!seatGroups[key]) {
                seatGroups[key] = [];
            }
            seatGroups[key].push({
                ...product,
                seatNumber: parseInt(product.seatSeat) || 0
            });
        });
        
        // Find pairs (adjacent seats in same block and row)
        const pairs = [];
        Object.values(seatGroups).forEach(group => {
            // Sort by seat number
            group.sort((a, b) => a.seatNumber - b.seatNumber);
            
            // Find adjacent seats
            for (let i = 0; i < group.length - 1; i++) {
                if (group[i + 1].seatNumber === group[i].seatNumber + 1) {
                    pairs.push({
                        seat1: group[i],
                        seat2: group[i + 1],
                        block: group[i].seatBlock,
                        row: group[i].seatRow
                    });
                    i++; // Skip next seat as it's already paired
                }
            }
        });
        
        const pairCount = pairs.length;
        
        // Add pair information (always show, even if 0 pairs)
        const pairDetails = pairs.map((pair, idx) => {
            return `**[Pair ${idx + 1}]** ${pair.block} - Row ${pair.row} Seats: ${pair.seat1.seatSeat} & ${pair.seat2.seatSeat}`;
        }).join("\n");
        
        pairInfoText = `
        
**🎫 PAIRS:** ${pairCount}  
${pairCount > 0 ? pairDetails : 'No adjacent pairs found'}`;
        
        // No need to show basket details note
    }

    const message =
        `🎟 **TICKET SUCCESS - Added to Basket**  
═════════════════════════════════════════════════
📅 **Time:** ${new Date().toLocaleString('en-GB', { 
                hour: '2-digit', 
                minute: '2-digit', 
                second: '2-digit' 
            })}  
🏟️ **Game:** ${eventName}  
🆔 **Event ID:** ${monitor.eventId}  
🔗 **Event URL:** ${monitor.eventUrl}  
📍 **Area ID:** ${areaId}  
🔢 **Quantity (monitor):** ${monitor.quantity}  
👤 **Account:** ${userEmail}  
📍 **Endpoint:** ${endpointType}  
            
🎫 **TICKETS:**  
${seatInfo}${pairInfoText}
            
🎯 **SUMMARY:**  
✅ **Total Seats:** ${expectedQuantity || products.length}  
💰 **Total Value:** ${totalValue} ${currency}  
            
═════════════════════════════════════════════════`;

    const seatsHttp = seatsCheckHttpStatus != null ? seatsCheckHttpStatus : '?';
    bumpValidationMetric('seatsLocked', monitor.areSeatsTogether && monitor.quantity > 1 ? monitor.quantity : 1);
    console.log('[CS] Ticket added to basket | Seats check: ' + seatsCheckEndpointLabel + ', HTTP ' + seatsHttp + ', quantity: ' + monitor.quantity + ' | lock/add: OK');
    
    chrome.runtime.sendMessage({
        action: 'notifyWebhooks',
        message,
        payload: dlJson
    }, (response) => {
        if (chrome.runtime.lastError) {
            console.error('[CS] Webhook send error:', chrome.runtime.lastError);
        }
    });

    // Open new tab after sending success notification
    chrome.runtime.sendMessage({
        action: 'openNewTab',
        url: 'https://www.exampleTicketsbasketaddedinthisWindow.com'
    });

// Play 5s sound
// playNotifySound(5000);

// stop monitoring after successful booking to avoid multiple BOOKINGS
// stopMonitoring('successfully added to basket');
    } // End of else block (successful add to basket)
}

function stopMonitoring(reason) {//stop of monitoring will be received from content script signal
    console.log('[CS] stopMonitoring:', reason);
    monitor.running = false;
    seatCheckLoopIteration = 0;
    lastLoggedSeatCheckSheetStatus = null;
    if (nextCheckTimeoutId != null) {
        clearTimeout(nextCheckTimeoutId);
        nextCheckTimeoutId = null;
    }
    if (monitor.intervalId) {
        clearInterval(monitor.intervalId);
        monitor.intervalId = null;
    }
}

void (async () => {
    try {
        if (isUrlAccountRestrictedBlackout(location.href)) {
            await reportAccountRestrictedBlackoutStop('page-load');
            return;
        }
        if (isUrlEventRestricted(location.href)) {
            await reportEventRestrictedStop('page-load');
        }
    } catch (e) {
        console.warn('[CS] account/event restricted page-load handler error', e);
    }
})();

function getRequestVerificationToken() {
    try {
        const input = document.querySelector('input[name="__RequestVerificationToken"]');
        if (input && input.value) return input.value;
        const meta = document.querySelector('meta[name="requestverificationtoken"]');
        if (meta && meta.content) return meta.content;
        // try cookie parse
        const match = document.cookie.match(/__RequestVerificationToken=([^;]+)/);
        if (match) return decodeURIComponent(match[1]);
    } catch (e) {
        console.warn('[CS] token parse err', e);
    }
    return null;
}

function playNotifySound(ms = 5000) {
    try {
        const src = chrome.runtime.getURL('sounds/notify.mp3');
        const audio = document.createElement('audio');
        audio.src = src;
        audio.autoplay = true;
        audio.volume = 1;
        audio.play().catch(e => console.warn('[CS] audio play failed', e));
        setTimeout(() => {
            audio.pause();
            try {
                audio.remove();
            } catch (e) {
            }
        }, ms);
        console.log('[CS] playing notify sound for', ms, 'ms');
    } catch (e) {
        console.warn('[CS] play sound error', e);
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Human-readable reason when seat-side actions are currently blocked by queue and/or error403 pause. */
function describeSeatsCheckBlockReason(snapshot) {
    const reasons = [];
    if (snapshot.inQueueWaiting === true) reasons.push('queue waiting is active');
    const until = Number(snapshot.error403PauseUntil) || 0;
    if (until > Date.now()) {
        const remainSec = Math.max(0, Math.ceil((until - Date.now()) / 1000));
        reasons.push('error403 pause active (' + remainSec + 's remaining)');
    }
    return reasons.length ? reasons.join(' + ') : 'no queue/error403 pause block';
}

async function getCurrentSeatsCheckBlockReason() {
    const st = await chrome.storage.local.get(['inQueueWaiting', 'error403PauseUntil']);
    return describeSeatsCheckBlockReason(st);
}

/** Wall-clock wait while keeping background heartbeat alive (avoids tab reload from heartbeat timeout). */
async function delayMsWithHeartbeats(totalMs, heartbeatEveryMs = 20000) {
    let left = Math.max(0, totalMs);
    while (left > 0) {
        const chunk = Math.min(heartbeatEveryMs, left);
        await delay(chunk);
        left -= chunk;
        chrome.runtime.sendMessage({ type: 'heartbeat' }).catch(() => {});
    }
}

async function fetchPublicIpForDiscord() {
    try {
        const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
        if (!r.ok) return '(unknown)';
        const j = await r.json();
        if (j && typeof j.ip === 'string' && j.ip.trim()) return j.ip.trim();
    } catch (e) {
        console.warn('[CS] Public IP lookup failed:', e && e.message);
    }
    return '(unknown)';
}

/** Discord when 3×403 triggers cookie clear + refresh (second occurrence path). */
async function sendSeatCheck403CookieClearDiscord(prevTier, endpointLabel) {
    const { startSecond, loginEmail } = await chrome.storage.local.get(['startSecond', 'loginEmail']);
    const ip = await fetchPublicIpForDiscord();
    const ss = startSecond != null && startSecond !== '' ? String(startSecond) : '(n/a)';
    const em = loginEmail && String(loginEmail).trim() ? String(loginEmail).trim() : '(n/a)';
    const endpointStr =
        endpointLabel != null && String(endpointLabel).trim() !== '' ? String(endpointLabel).trim() : '(n/a)';
    const message =
        '**Clear Cookies & refresh event tab**\n' +
        '📧 **loginEmail:** ' +
        em +
        '\n' +
        '📊 **startSecond:** ' +
        ss +
        '\n' +
        '📍 **Endpoint:** ' +
        endpointStr +
        '\n' +
        '🌐 **Public IP:** ' +
        ip +
        '\n' +
        '📈 **seatCheck403BackoffTier** (before reset): ' +
        prevTier +
        '\n' +
        '📢 **Next:** 30s before next seat check API; tier reset to 0 after this run.';
    chrome.runtime.sendMessage({
        action: 'notifyErrorWebhooks',
        message,
        payload: {
            kind: 'seat_check_403_cookie_clear',
            startSecond: ss,
            loginEmail: em,
            publicIp: ip,
            prevTier,
            endpoint: endpointStr
        }
    });
}

const SEAT_CHECK_403_AFTER_FIRST_REFRESH_MS = 12 * 1000;
const SEAT_CHECK_403_AFTER_COOKIE_CLEAR_MS = 30 * 1000;

/**
 * 3 consecutive seat-check 403s (every 3rd 403 in a row):
 * - **First** since tier was 0 (`seatCheck403BackoffTier` 0): no wait, refresh event tab, 12s with heartbeats, set tier to 1 (no Discord).
 * - **Again** (tier ≥ 1): Discord (cookie clear), `clearCookiesAndRefresh`, 2s, refresh event tab, 30s with heartbeats, set tier to 0.
 * Tier also resets after 2 consecutive **Resale** HTTP 200s (elsewhere).
 */
async function handleThreeConsecutiveSeat403BackoffAndReload(endpointLabel, httpStatus, quantity) {
    const prev = await chrome.storage.local.get(['seatCheck403BackoffTier']);
    const prevTier = Number(prev.seatCheck403BackoffTier) || 0;
    const q = quantity != null ? quantity : '?';
    const http = httpStatus != null ? String(httpStatus) : '403';

    if (prevTier === 0) {
        console.warn(
            '[CS] 403×3 (tier 0): refresh event URL tab → ' +
                SEAT_CHECK_403_AFTER_FIRST_REFRESH_MS / 1000 +
                's → tier 1 | Seats check: ' +
                endpointLabel +
                ', HTTP ' +
                http +
                ', qty ' +
                q
        );
        error403Count = 0;
        const refreshed = await refreshEventTabWithTracking();
        if (!refreshed) {
            console.warn('[CS] 3×403 first path: event tab refresh not confirmed (pause/timeout). Continuing to next aligned cycle.');
        }
        await delayMsWithHeartbeats(SEAT_CHECK_403_AFTER_FIRST_REFRESH_MS);
        await chrome.storage.local.set({ seatCheck403BackoffTier: 1 });
        return;
    }

    console.warn(
        '[CS] 403×3 (tier ' +
            prevTier +
            '): Discord + clear cookies → refresh → ' +
            SEAT_CHECK_403_AFTER_COOKIE_CLEAR_MS / 1000 +
            's → tier 0 | Seats check: ' +
            endpointLabel +
            ', HTTP ' +
            http +
            ', qty ' +
            q
    );

    await sendSeatCheck403CookieClearDiscord(prevTier, endpointLabel);
    chrome.runtime.sendMessage({ action: 'clearCookiesAndRefresh' }, () => {
        if (chrome.runtime.lastError) {
            console.warn('[CS] clearCookiesAndRefresh:', chrome.runtime.lastError.message);
        }
    });
    bumpValidationMetric('cookiesCleared');
    await delay(2000);

    error403Count = 0;
    const refreshed = await refreshEventTabWithTracking();
    if (!refreshed) {
        console.warn('[CS] 3×403 repeat path: event tab refresh not confirmed (pause/timeout). Continuing to next aligned cycle.');
    }
    await delayMsWithHeartbeats(SEAT_CHECK_403_AFTER_COOKIE_CLEAR_MS);
    await chrome.storage.local.set({ seatCheck403BackoffTier: 0 });
}

// Helper: wait for event tab to set eventTabReloaded in storage (set by event tab after load + verification token). Timeout 2 min.
const EVENT_TAB_RELOAD_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/** True while people-ahead queue or BG error403 pause should stall seat-side waits. */
function seatsCheckBlockedByQueueOrPauseSync(snapshot) {
    const until = Number(snapshot.error403PauseUntil) || 0;
    return snapshot.inQueueWaiting === true || (until > 0 && Date.now() < until);
}

async function seatsCheckBlockedByQueueOrPause() {
    const st = await chrome.storage.local.get(['inQueueWaiting', 'error403PauseUntil']);
    return seatsCheckBlockedByQueueOrPauseSync(st);
}

/** Like fixed delay() but only counts elapsed time when queue / error403 pause are clear (same idea as reload-flag wait). */
async function delayUnblockedMs(targetUnblockedMs, pollMs = 1000) {
    let unblockedMs = 0;
    while (unblockedMs < targetUnblockedMs) {
        await delay(pollMs);
        if (!(await seatsCheckBlockedByQueueOrPause())) unblockedMs += pollMs;
    }
}

/** After refreshEventTab was skipped (pause): short unblocked backoff instead of 60s wall clock. */
const BACKOFF_UNBLOCKED_MS_AFTER_REFRESH_BLOCKED = 15 * 1000;

async function waitForEventTabReload(timeoutMs = EVENT_TAB_RELOAD_TIMEOUT_MS) {
    const startTime = Date.now();
    const checkInterval = 1000; // Check every 1 second

    while (Date.now() - startTime < timeoutMs) {
        const { eventTabReloaded } = await chrome.storage.local.get('eventTabReloaded');
        if (eventTabReloaded === true) {
            console.log('[CS] Event tab reload completed (flag set by event tab).');
            await chrome.storage.local.set({ eventTabReloaded: false });
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    console.warn('[CS] Event tab reload timeout after ' + (timeoutMs / 1000) + 's — reload flag not set.');
    return false;
}

/**
 * Wait for eventTabReloaded. Only counts elapsed time while NOT in queue (people ahead) and NOT in BG error403 pause — those stretch the wait.
 */
async function waitForEventTabReloadUnblocked(maxUnblockedMs, pollMs = 1000) {
    let unblockedMs = 0;
    while (unblockedMs < maxUnblockedMs) {
        const { eventTabReloaded, inQueueWaiting, error403PauseUntil } = await chrome.storage.local.get([
            'eventTabReloaded',
            'inQueueWaiting',
            'error403PauseUntil'
        ]);
        if (eventTabReloaded === true) {
            console.log('[CS] Event tab reload completed (flag set by event tab).');
            await chrome.storage.local.set({ eventTabReloaded: false });
            return true;
        }
        const blocked = seatsCheckBlockedByQueueOrPauseSync({ inQueueWaiting, error403PauseUntil });
        await delay(pollMs);
        if (!blocked) unblockedMs += pollMs;
    }
    console.warn(
        '[CS] eventTabReloaded not set within ' +
            maxUnblockedMs / 1000 +
            's of unblocked wait (queue / error403 pause time excluded).'
    );
    return false;
}

/** Send refreshEventTab; false if BG error403 pause blocks it. */
async function refreshEventTabSendOnly() {
    const { error403PauseUntil = 0 } = await chrome.storage.local.get('error403PauseUntil');
    if (error403PauseUntil > 0 && Date.now() < error403PauseUntil) {
        const remainSec = Math.max(0, Math.ceil((error403PauseUntil - Date.now()) / 1000));
        if (!pauseActiveLogged) {
            console.log('[CS] error403 pause is active — seat checks and event tab refresh paused until it ends (' + remainSec + 's remaining).');
            pauseActiveLogged = true;
        }
        return false;
    }
    await chrome.storage.local.set({ eventTabReloaded: false });
    chrome.runtime.sendMessage({ action: 'refreshEventTab' }, () => {
        if (chrome.runtime.lastError) {
            console.error('[CS] refreshEventTab error:', chrome.runtime.lastError);
        }
    });
    return true;
}

/**
 * Refresh event tab and wait for eventTabReloaded. On first wait timeout, sends a second refresh and waits again.
 * Returns true only when reload flag is seen. Returns false if pause blocked send, or both waits timed out (seat API should not run).
 */
async function refreshEventTabWithTracking() {
    const sent = await refreshEventTabSendOnly();
    if (!sent) {
        const reason = await getCurrentSeatsCheckBlockReason();
        console.log('[CS] Event tab refresh send deferred — waiting due to: ' + reason + '.');
        return false;
    }
    let completed = await waitForEventTabReload(EVENT_TAB_RELOAD_TIMEOUT_MS);
    if (!completed) {
        console.warn('[CS] Event tab reload timeout — sending second refreshEventTab and waiting again (max ' + EVENT_TAB_RELOAD_TIMEOUT_MS / 1000 + 's)...');
        const sent2 = await refreshEventTabSendOnly();
        if (!sent2) {
            const reason = await getCurrentSeatsCheckBlockReason();
            console.log('[CS] Second refresh send deferred — waiting due to: ' + reason + '.');
            lastEventTabRefreshAt = Date.now();
            pendingSkipSeatFetchEventReloadTimeout = true;
            return false;
        }
        completed = await waitForEventTabReload(EVENT_TAB_RELOAD_TIMEOUT_MS);
    }
    if (!completed) {
        console.warn('[CS] Event tab reload still not confirmed after second wait — will skip seat API until reload succeeds.');
        const reason = await getCurrentSeatsCheckBlockReason();
        if (reason !== 'no queue/error403 pause block') {
            console.log('[CS] Event tab reload unresolved — waiting due to: ' + reason + '.');
        }
        lastEventTabRefreshAt = Date.now();
        pendingSkipSeatFetchEventReloadTimeout = true;
        return false;
    }
    pendingSkipSeatFetchEventReloadTimeout = false;
    return true;
}
