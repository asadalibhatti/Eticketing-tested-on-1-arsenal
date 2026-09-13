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
/** In-memory mirror of sold-out / no-sales pause; skip event/validation reloads until retry alarm. */
let eventSoldOutPauseUntil = 0;
/** Avoid spam: only one "already sleeping" log per pause-until timestamp. */
let eventSoldOutAlreadyPausedLoggedUntil = 0;
/** Only one sold-out resume open at a time. */
let eventSoldOutRetryRunning = false;
const HD_QUEUE_RECOVERY_SHORT_WAIT_MS = 10 * 1000;
const HD_QUEUE_RECOVERY_LONG_WAIT_MS = 60 * 1000;
const HD_QUEUE_ERROR403_RECOVERY_STEP_KEY = 'hdQueueError403RecoveryStep'; // 0:club home, 1:eventUrl, 2:softblock (then repeat)
const HD_QUEUE_ERROR403_RECOVERY_CYCLE_INDEX_KEY = 'hdQueueError403RecoveryCycleIndex'; // completed 3-step cycles since last reset
const HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY = 'hdQueueBotDetectCaptchaCount'; // BotDetect + Botdeflector sticky after >=2 → keep 2captcha
const HD_QUEUE_ERROR403_RECOVERY_ALARM = 'hdQueueError403RecoveryAlarm';
const HD_QUEUE_ERROR403_RECOVERY_TARGET_URL_KEY = 'hdQueueError403RecoveryTargetUrl';
const HD_QUEUE_ERROR403_RECOVERY_TAB_ID_KEY = 'hdQueueError403RecoveryTabId';
const HD_QUEUE_ERROR403_RECOVERY_OFF_RECHECK_MS = 15 * 1000;
/** Event URL redirected to EventNotAllowed?reason=EventNoAvailableSalesModesOrSoldOut — pause then retry. */
const EVENT_SOLD_OUT_RETRY_ALARM = 'eventSoldOutRetry';
const EVENT_SOLD_OUT_PAUSE_UNTIL_KEY = 'eventSoldOutPauseUntil';
const EVENT_SOLD_OUT_TAB_ID_KEY = 'eventSoldOutTabId';
/** Random wait before reopening eventUrl after sold-out / no-sales redirect. */
const EVENT_SOLD_OUT_RETRY_MIN_MS = 3 * 60 * 1000;
const EVENT_SOLD_OUT_RETRY_MAX_MS = 11 * 60 * 1000;
/** Set true by event Index page when verification token is ready; gates validation-tab create/reload. */
const EVENT_PAGE_READY_KEY = 'eventPageReady';
/** Max wait after event ensure/reload before giving up on opening validation tab. */
const EVENT_PAGE_READY_WAIT_MS = 3 * 60 * 1000;
const EVENT_PAGE_READY_POLL_MS = 2000;

/** HD queue tab reload storm: recover after N reloads. */
const HD_QUEUE_RELOAD_MAX_COUNT = 7; // cumulative reloads (after first entry) → Arsenal Red membership
/** After hitting max reload count, wait this long then re-check URL before recovery. */
const HD_QUEUE_RELOAD_STORM_CONFIRM_DELAY_MS = 4 * 1000;
const HD_QUEUE_RELOAD_RECOVERY_COOLDOWN_MS = 5 * 1000;
const HD_QUEUE_MEMBERSHIP_RECOVERY_URL = 'https://www.arsenal.com/membership/red';
const HD_QUEUE_MEMBERSHIP_RECOVERY_ACTIVE_KEY = 'hdQueueMembershipRecoveryActive';
/** tabId -> { reloadCount } */
const hdQueueReloadStateByTab = new Map();
/** tabId → timeout id while waiting to confirm storm recovery after max reloads. */
const hdQueueStormConfirmTimerByTab = new Map();
/** tabId → first seen at (ms) for stuck web-identity /connect/authorize detection */
const webIdentityAuthorizeSeenAt = new Map();
/** Stuck on /connect/authorize without redirect → treat as browsing pause. */
const WEB_IDENTITY_STUCK_MS = 6 * 1000;
/**
 * How many times web-identity browsing-pause was recovered via the old membership-only path.
 * Kept for resets; recovery now uses the shared eticketing pause path.
 */
let webIdentityBrowsingPauseCycles = 0;
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
let lastUkBreakActive = false;
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

/** Column "UK Break Time" (also UK Break / Break Time UK). Empty / off / none → no break. Multiple ranges: 2:15-5:45|14:00-15:30 */
function ukBreakTimeRawFromSheetMap(map) {
    if (!map) return '';
    const raw =
        map['ukbreaktime'] ??
        map['ukbreak'] ??
        map['breaktimeuk'] ??
        map['ukstoptime'] ??
        map['breaktimerange'] ??
        map['breaktime'];
    return raw == null ? '' : String(raw).trim();
}

function formatUkMinutesAsClock(mins) {
    const m = ((Number(mins) % (24 * 60)) + 24 * 60) % (24 * 60);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

/** Parse "2:15", "02:15", "2:15am", "5:45pm" → minutes from midnight. */
function parseUkClockToMinutes(str) {
    let s = String(str || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '');
    if (!s) return null;
    let ampm = '';
    if (s.endsWith('am') || s.endsWith('pm')) {
        ampm = s.slice(-2);
        s = s.slice(0, -2);
    }
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59) return null;
    if (ampm === 'am') {
        if (h === 12) h = 0;
    } else if (ampm === 'pm') {
        if (h !== 12) h += 12;
    }
    if (h > 23) return null;
    return h * 60 + min;
}

function parseOneUkBreakWindow(chunk) {
    const s0 = String(chunk || '').trim();
    if (!s0) return null;
    const parts = s0.split(/\s*(?:-|–|—|to)\s*/i).filter(Boolean);
    if (parts.length < 2) return null;
    const startMin = parseUkClockToMinutes(parts[0]);
    const endMin = parseUkClockToMinutes(parts[1]);
    if (startMin == null || endMin == null || startMin === endMin) return null;
    return {
        startMin,
        endMin,
        label: formatUkMinutesAsClock(startMin) + '-' + formatUkMinutesAsClock(endMin)
    };
}

/**
 * Parse sheet cell: one range "2:15-5:45" or several "2:15-5:45|14:00-15:30".
 * @returns {{ windows: {startMin:number,endMin:number,label:string}[], label: string } | null}
 */
function parseUkBreakRange(raw) {
    const s0 = String(raw || '').trim();
    if (!s0) return null;
    const low = s0.toLowerCase();
    if (['off', 'none', 'no', '-', 'n/a', 'na'].includes(low)) return null;
    const chunks = s0.split('|').map((c) => c.trim()).filter(Boolean);
    const windows = [];
    for (let i = 0; i < chunks.length; i++) {
        const w = parseOneUkBreakWindow(chunks[i]);
        if (w) windows.push(w);
    }
    if (!windows.length) return null;
    return {
        windows,
        label: windows.map((w) => w.label).join('|'),
        startMin: windows[0].startMin,
        endMin: windows[0].endMin
    };
}

/** Inclusive start, exclusive end. Overnight ranges (22:00-06:00) wrap midnight. */
function isMinutesInUkBreakRange(nowMin, startMin, endMin) {
    if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
    return nowMin >= startMin || nowMin < endMin;
}

function matchingUkBreakWindow(nowMin, range) {
    if (!range || !Array.isArray(range.windows)) return null;
    for (let i = 0; i < range.windows.length; i++) {
        const w = range.windows[i];
        if (isMinutesInUkBreakRange(nowMin, w.startMin, w.endMin)) return w;
    }
    return null;
}

let cachedUkTime = { fetchedAt: 0, minutes: null, clock: '', source: '' };
const UK_TIME_CACHE_MS = 30 * 1000;
const UK_TIME_FETCH_TIMEOUT_MS = 8000;

function parseIsoClockToUkMinutes(iso) {
    const m = String(iso || '').match(/T(\d{2}):(\d{2})/);
    if (!m) return null;
    return {
        minutes: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
        clock: m[1] + ':' + m[2]
    };
}

/** Convert a trusted UTC timestamp to Europe/London clock (Chromium TZ data, not the PC clock). */
function ukMinutesFromUtcMs(utcMs) {
    const ms = Number(utcMs);
    if (!Number.isFinite(ms) || ms < 1e11) return null;
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return null;
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/London',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        }).formatToParts(d);
        const hour = Number((parts.find((p) => p.type === 'hour') || {}).value);
        const minute = Number((parts.find((p) => p.type === 'minute') || {}).value);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
        return {
            minutes: hour * 60 + minute,
            clock: String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0')
        };
    } catch (_) {
        return null;
    }
}

function ukMinutesFromHourMinute(hour, minute) {
    const h = Number(hour);
    const min = Number(minute);
    if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
    return {
        minutes: h * 60 + min,
        clock: String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0')
    };
}

async function fetchWithTimeout(url, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || UK_TIME_FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    } finally {
        clearTimeout(t);
    }
}

function logUkTimeSourceFail(name, errOrStatus) {
    console.warn('[BG] UK time source failed (' + name + '):', errOrStatus);
}

/**
 * Current UK (Europe/London) clock from public time APIs — not the PC clock.
 * Cached ~30s. If all APIs fail, returns null (break window skipped this poll).
 */
async function fetchUkMinutesOfDay() {
    if (cachedUkTime.minutes != null && Date.now() - cachedUkTime.fetchedAt < UK_TIME_CACHE_MS) {
        return cachedUkTime;
    }
    const apply = (parsed, source) => {
        if (!parsed) return null;
        cachedUkTime = {
            fetchedAt: Date.now(),
            minutes: parsed.minutes,
            clock: parsed.clock,
            source
        };
        console.log('[BG] UK time ' + parsed.clock + ' from ' + source);
        return cachedUkTime;
    };

    const tryJson = async (name, url, pick) => {
        try {
            const res = await fetchWithTimeout(url);
            if (!res.ok) {
                logUkTimeSourceFail(name, 'HTTP ' + res.status);
                return null;
            }
            const j = await res.json();
            const parsed = pick(j);
            return apply(parsed, name);
        } catch (e) {
            logUkTimeSourceFail(name, e && e.name === 'AbortError' ? 'timeout' : e?.message || e);
            return null;
        }
    };

    const tryHttpDate = async (name, url) => {
        try {
            const res = await fetchWithTimeout(url);
            const dateHdr = res.headers.get('date') || res.headers.get('Date');
            if (!dateHdr) {
                logUkTimeSourceFail(name, 'no Date header (HTTP ' + res.status + ')');
                return null;
            }
            const ms = Date.parse(dateHdr);
            const parsed = ukMinutesFromUtcMs(ms);
            if (!parsed) {
                logUkTimeSourceFail(name, 'could not parse Date header');
                return null;
            }
            return apply(parsed, name);
        } catch (e) {
            logUkTimeSourceFail(name, e && e.name === 'AbortError' ? 'timeout' : e?.message || e);
            return null;
        }
    };

    const tryCloudflareTrace = async (name, url) => {
        try {
            const res = await fetchWithTimeout(url);
            if (!res.ok) {
                logUkTimeSourceFail(name, 'HTTP ' + res.status);
                return null;
            }
            const text = await res.text();
            const m = String(text).match(/(?:^|\n)ts=([0-9]+(?:\.[0-9]+)?)/);
            if (!m) {
                logUkTimeSourceFail(name, 'no ts= in trace');
                return null;
            }
            const parsed = ukMinutesFromUtcMs(parseFloat(m[1]) * 1000);
            if (!parsed) {
                logUkTimeSourceFail(name, 'could not parse ts=');
                return null;
            }
            return apply(parsed, name);
        } catch (e) {
            logUkTimeSourceFail(name, e && e.name === 'AbortError' ? 'timeout' : e?.message || e);
            return null;
        }
    };

    let got = await tryJson('timeapi.io', 'https://timeapi.io/api/time/current/zone?timeZone=Europe%2FLondon', (j) => {
        return (
            ukMinutesFromHourMinute(j.hour, j.minute) ||
            parseIsoClockToUkMinutes(j.dateTime || j.datetime)
        );
    });
    if (got) return got;

    got = await tryJson(
        'timeapi.io (legacy path)',
        'https://timeapi.io/api/Time/current/zone?timeZone=Europe%2FLondon',
        (j) => ukMinutesFromHourMinute(j.hour, j.minute) || parseIsoClockToUkMinutes(j.dateTime || j.datetime)
    );
    if (got) return got;

    got = await tryJson('worldtimeapi', 'https://worldtimeapi.org/api/timezone/Europe/London', (j) => {
        return parseIsoClockToUkMinutes(j.datetime) || ukMinutesFromUtcMs(Number(j.unixtime) * 1000);
    });
    if (got) return got;

    got = await tryCloudflareTrace('cloudflare-trace', 'https://www.cloudflare.com/cdn-cgi/trace');
    if (got) return got;

    got = await tryCloudflareTrace('cloudflare-1.1.1.1', 'https://1.1.1.1/cdn-cgi/trace');
    if (got) return got;

    got = await tryJson('worldclockapi-utc', 'https://worldclockapi.com/api/json/utc/now', (j) => {
        const iso = j.currentDateTime || j.currentFileTime;
        if (iso && typeof iso === 'string') {
            const ms = Date.parse(iso.endsWith('Z') || iso.includes('+') ? iso : String(iso) + 'Z');
            return ukMinutesFromUtcMs(ms);
        }
        return null;
    });
    if (got) return got;

    got = await tryHttpDate('google-generate-204', 'https://www.google.com/generate_204');
    if (got) return got;

    got = await tryHttpDate('gstatic-generate-204', 'https://www.gstatic.com/generate_204');
    if (got) return got;

    got = await tryHttpDate('docs.google.com Date header', 'https://docs.google.com/');
    if (got) return got;

    console.warn('[BG] All UK time APIs failed — break window not applied this poll (system clock not used)');
    return null;
}

/**
 * @returns {{ active: boolean, range: object|null, ukNow: object|null }}
 */
async function evaluateUkBreakWindow(ukBreakTimeRaw) {
    const range = parseUkBreakRange(ukBreakTimeRaw);
    if (!range) return { active: false, range: null, ukNow: null, activeLabel: '' };
    const ukNow = await fetchUkMinutesOfDay();
    if (!ukNow) return { active: false, range, ukNow: null, activeLabel: range.label };
    const hit = matchingUkBreakWindow(ukNow.minutes, range);
    return {
        active: !!hit,
        range,
        ukNow,
        activeLabel: hit ? hit.label : range.label
    };
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

/** Arsenal is the only club that must enter via www.arsenal.com/membership/red. */
function eventUrlIsArsenalClub(url) {
    return String(clubNameFromEventUrl(url) || '').toLowerCase() === 'arsenal';
}

async function resolveStoredEventUrl(fallback) {
    let url = (fallback || EVENT_URL || '').trim();
    if (!url) {
        const st = await chrome.storage.local.get('eventUrl');
        url = (st.eventUrl || '').trim();
    }
    return url;
}

/**
 * Open event entry point for the current club:
 * - Arsenal → Red membership → Memberships/List → eventUrl
 * - Other clubs → navigate/create tab directly to eventUrl
 * @param {{ focus?: boolean, reuseTabId?: number|null, eventUrl?: string }} opts
 */
async function openEventEntryForClub(opts) {
    if (lastStatus === 'off') {
        console.log('[BG] openEventEntryForClub skipped — Google Sheet status Off');
        return { success: false, skipped: true, message: 'sheet status off' };
    }
    const wantFocus = !(opts && opts.focus === false);
    const reuseTabId = opts && opts.reuseTabId != null ? opts.reuseTabId : null;
    const url = await resolveStoredEventUrl(opts && opts.eventUrl);

    if (!url) {
        console.warn('[BG] openEventEntryForClub: no eventUrl');
        return { success: false, message: 'no eventUrl' };
    }

    if (eventUrlIsArsenalClub(url)) {
        console.log('[BG] openEventEntryForClub: Arsenal → membership/red flow');
        return openEventUrlViaArsenalMembershipRed({ focus: wantFocus, reuseTabId });
    }

    // Non-Arsenal: open event URL directly (no Arsenal membership hop)
    await resetEventPageReadyFlag('opening event URL directly (non-Arsenal club)');
    await chrome.storage.local.set({ [HD_QUEUE_MEMBERSHIP_RECOVERY_ACTIVE_KEY]: false });
    EVENT_URL = url;

    let safeReuseId = reuseTabId;
    if (safeReuseId != null) {
        if (safeReuseId === notAllowedTabId) {
            console.log('[BG] openEventEntryForClub: reuseTabId is validation tab — ignoring', safeReuseId);
            safeReuseId = null;
        } else {
            try {
                const t = await chrome.tabs.get(safeReuseId);
                if (tabIsValidationMonitorTab(t) || tabUrlIsEventRestricted(t.url) || tabUrlIsEventRestricted(t.pendingUrl)) {
                    console.log(
                        '[BG] openEventEntryForClub: refusing to navigate validation/restricted tab',
                        safeReuseId
                    );
                    safeReuseId = null;
                }
            } catch (_) {
                safeReuseId = null;
            }
        }
    }

    if (safeReuseId != null) {
        try {
            await chrome.tabs.update(safeReuseId, { url, active: wantFocus });
            eventTabId = safeReuseId;
            if (wantFocus) await focusTabWindow(safeReuseId);
            console.log('[BG] openEventEntryForClub: navigated tab', safeReuseId, '→ eventUrl');
            return { success: true, action: 'event-url-navigated', tabId: safeReuseId };
        } catch (e) {
            console.warn('[BG] openEventEntryForClub: navigate failed, creating tab:', e?.message || e);
        }
    }

    const created = await chrome.tabs.create({ url, active: wantFocus });
    if (created && created.id != null) {
        eventTabId = created.id;
        if (wantFocus) await focusTabWindow(created.id);
    }
    console.log('[BG] openEventEntryForClub: opened eventUrl directly', created && created.id, url);
    return { success: true, action: 'event-url-created', tabId: created && created.id };
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
        areaIds: row.areaIds != null ? String(row.areaIds) : '',
        areasToIgnore: row.areasToIgnore != null ? String(row.areasToIgnore) : '',
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
 * opts.allowWhileSoldOutPause: sold-out retry keeps pause active while waiting for the reopened event tab.
 */
async function waitForEventPageReady(opts = {}) {
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : EVENT_PAGE_READY_WAIT_MS;
    const pollMs = opts.pollMs != null ? opts.pollMs : EVENT_PAGE_READY_POLL_MS;
    const allowWhileSoldOutPause = opts.allowWhileSoldOutPause === true;
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
        if (!allowWhileSoldOutPause && (await isEventSoldOutPauseActive())) {
            console.log(
                '[BG] waitForEventPageReady aborted — sold-out/no-sales pause (retry ~' +
                    formatEventSoldOutPauseEndsAt() +
                    ')'
            );
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
    if (await isEventSoldOutPauseActive()) {
        console.log(
            '[BG] openOrReloadValidationTab skipped — sold-out/no-sales pause (retry ~' +
                formatEventSoldOutPauseEndsAt() +
                ')'
        );
        return { success: false, reason: 'sold-out pause' };
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
            if (eventTabId === found.id) {
                eventTabId = null;
                console.log('[BG] Cleared eventTabId — was pointing at validation tab', found.id);
            }
            if (reloadIfExists) {
                console.log('[BG] Validation tab exists — reloading (event page ready)', found.id);
                await chrome.tabs.reload(found.id);
            } else {
                console.log('[BG] Validation tab already open — ignore (leave as-is)', found.id);
            }
            return { success: true, tabId: found.id, created: false };
        }
        const created = await chrome.tabs.create({ url: validationUrl, active: false });
        notAllowedTabId = created.id;
        if (eventTabId === created.id) eventTabId = null;
        console.log('[BG] Created validation tab (event page ready)', created.id);
        return { success: true, tabId: created.id, created: true };
    } catch (e) {
        console.warn('[BG] openOrReloadValidationTab failed:', e && e.message);
        return { success: false, reason: e && e.message };
    }
}

/** Build EventNotAllowed validation URL from EVENT_NOT_ALLOWED_URL / eventUrl / EVENT_URL. */
async function resolveValidationUrlForClub() {
    let validationUrl = (EVENT_NOT_ALLOWED_URL || '').trim();
    if (validationUrl) return validationUrl;
    const { eventUrl } = await chrome.storage.local.get(['eventUrl']);
    const url = (EVENT_URL || eventUrl || '').trim();
    const clubName = clubNameFromEventUrl(url);
    if (!clubName) return '';
    validationUrl = `https://www.eticketing.co.uk/${clubName}/EDP/Validation/EventNotAllowed?eventId=4&reason=EventArchived`;
    EVENT_NOT_ALLOWED_URL = validationUrl;
    return validationUrl;
}

/**
 * When event Index has token / eventPageReady: open validation tab only if none is open.
 * If validation tab already exists — do nothing (no reload).
 */
async function ensureValidationTabExistsAfterEventReady(reason) {
    if (!(await isEventPageReady())) {
        return { skipped: true, reason: 'eventPageReady not set' };
    }
    if (await accountRestrictedBlackoutStopActive()) {
        console.log('[BG] ensureValidationTab after event ready skipped — account restricted');
        return { skipped: true, reason: 'blackout' };
    }
    if (await eventRestrictedStopActive()) {
        console.log('[BG] ensureValidationTab after event ready skipped — event restricted');
        return { skipped: true, reason: 'event restricted' };
    }
    if (await isBrowsingPauseSystemHoldActive()) {
        console.log('[BG] ensureValidationTab after event ready skipped — browsing pause recovery');
        return { skipped: true, reason: 'browsing pause' };
    }
    if (Date.now() < error403PauseUntil) {
        console.log('[BG] ensureValidationTab after event ready skipped — error403 pause');
        return { skipped: true, reason: 'error403' };
    }
    if (await isEventSoldOutPauseActive()) {
        console.log(
            '[BG] ensureValidationTab after event ready skipped — sold-out/no-sales pause (retry ~' +
                formatEventSoldOutPauseEndsAt() +
                ')'
        );
        return { skipped: true, reason: 'sold-out pause' };
    }
    if (await isQueueItActive()) {
        console.log('[BG] ensureValidationTab after event ready skipped — Queue-IT active');
        return { skipped: true, reason: 'queue' };
    }
    const validationUrl = await resolveValidationUrlForClub();
    if (!validationUrl) {
        console.warn('[BG] ensureValidationTab after event ready: no validation URL');
        return { skipped: true, reason: 'no url' };
    }
    console.log(
        '[BG] Event tab ready (token set) — ensure validation tab exists (open only if missing):',
        reason || ''
    );
    return openOrReloadValidationTab(validationUrl, { reloadIfExists: false });
}

/** Clear 403 pause timer, counts, and storage so reload / sheet-on never inherits stale queue-403 state. */
async function resetError403State(reason, opts) {
    if (error403ResumeTimerId != null) {
        clearTimeout(error403ResumeTimerId);
        error403ResumeTimerId = null;
    }
    error403PauseUntil = 0;
    const preserveCaptchaCount = opts && opts.preserveCaptchaCount === true;
    const preserveRecoveryProgress = opts && opts.preserveRecoveryProgress === true;
    const patch = {
        error403PauseUntil: 0,
        seatCheck403BackoffTier: 0
    };
    if (!preserveRecoveryProgress) {
        patch.error403Count = 0;
        patch[HD_QUEUE_ERROR403_RECOVERY_STEP_KEY] = 0;
        patch[HD_QUEUE_ERROR403_RECOVERY_CYCLE_INDEX_KEY] = 0;
    }
    // Captcha appearance count must survive sheet polls / mid-queue resets so 2captcha threshold still works
    if (!preserveCaptchaCount) {
        patch[HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY] = 0;
    }
    await chrome.storage.local.set(patch);
    console.log(
        '[BG] error403 state reset (incl. seatCheck403BackoffTier=0):',
        reason || '(no reason)',
        preserveCaptchaCount ? '[kept captcha count]' : '',
        preserveRecoveryProgress ? '[kept recovery step]' : ''
    );
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
    webIdentityBrowsingPauseCycles = 0;
    await resetBrowsingPauseCooldownStreak('extension / background started');
    await forceReleaseBrowsingPauseHold('extension / background started');
    try {
        chrome.alarms.clear(BROWSING_PAUSE_COOLDOWN_ALARM);
    } catch (_) {}
    // Sold-out / no-sales sleep must not survive extension reload
    try {
        await chrome.alarms.clear(EVENT_SOLD_OUT_RETRY_ALARM);
    } catch (_) {}
    await chrome.storage.local.set({
        [EVENT_SOLD_OUT_PAUSE_UNTIL_KEY]: 0,
        [EVENT_SOLD_OUT_TAB_ID_KEY]: null
    });
    eventSoldOutPauseUntil = 0;
    eventSoldOutAlreadyPausedLoggedUntil = 0;
    eventSoldOutRetryRunning = false;
    console.log('[BG] Event sold-out/no-sales pause cleared on start');
}

/** Pathname only — never match "error403" inside query/JWT (softblock tokens can false-positive). */
function hdQueuePathnameLower(url) {
    if (!url) return '';
    try {
        const u = new URL(String(url));
        if (!u.hostname.toLowerCase().includes('hd-queue.eticketing.co.uk')) return '';
        return (u.pathname || '').toLowerCase();
    } catch (_) {
        const s = String(url).toLowerCase();
        if (!s.includes('hd-queue.eticketing.co.uk')) return '';
        const noQuery = s.split('?')[0].split('#')[0];
        const hostIdx = noQuery.indexOf('hd-queue.eticketing.co.uk');
        if (hostIdx === -1) return '';
        return noQuery.slice(hostIdx + 'hd-queue.eticketing.co.uk'.length) || '/';
    }
}

function urlIsHdQueueError403Path(url) {
    return hdQueuePathnameLower(url).includes('/error403');
}

function urlIsHdQueueSoftblockPath(url) {
    return hdQueuePathnameLower(url).includes('/softblock');
}

function urlIsHdQueueViewPath(url) {
    return hdQueuePathnameLower(url).includes('/view');
}

/** Live Queue-IT waiting room / progress — not the /error403 error page. */
function urlIsHdQueueLiveQueuePath(url) {
    if (urlIsHdQueueError403Path(url)) return false;
    return urlIsHdQueueSoftblockPath(url) || urlIsHdQueueViewPath(url);
}

function tabUrlsMentionHdQueueError403(url, pendingUrl) {
    return urlIsHdQueueError403Path(url) || urlIsHdQueueError403Path(pendingUrl);
}

function tabUrlsMentionHdQueueSoftblock(url, pendingUrl) {
    return urlIsHdQueueSoftblockPath(url) || urlIsHdQueueSoftblockPath(pendingUrl);
}

function tabIsHdQueueLiveQueue(url, pendingUrl) {
    return urlIsHdQueueLiveQueuePath(url) || urlIsHdQueueLiveQueuePath(pendingUrl);
}

/** Stop 403 pause + rotating recovery so a live /softblock queue tab is not closed. */
async function abortHdQueueError403RecoveryForActiveQueue(reason) {
    try {
        chrome.alarms.clear(HD_QUEUE_ERROR403_RECOVERY_ALARM);
    } catch (_) {}
    if (error403ResumeTimerId != null) {
        clearTimeout(error403ResumeTimerId);
        error403ResumeTimerId = null;
    }
    error403PauseUntil = 0;
    lastSetQueueWaitingAt = Date.now();
    await chrome.storage.local.set({
        error403PauseUntil: 0,
        inQueueWaiting: true,
        [HD_QUEUE_ERROR403_RECOVERY_TARGET_URL_KEY]: '',
        [HD_QUEUE_ERROR403_RECOVERY_TAB_ID_KEY]: null
    });
    console.log('[BG] hd-queue error403 recovery aborted (queue active):', reason || '(no reason)');
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
        if (matchingRows.length === 0) return false;
        const br = await evaluateUkBreakWindow(matchingRows[0].ukBreakTime);
        if (br.active) return false;
        return true;
    } catch (e) {
        console.warn('[BG] isCurrentSheetStatusOn: sheet read failed:', e?.message || e);
        return false;
    }
}

function cookieDomainIsEticketing(domain) {
    const d = String(domain || '').toLowerCase().replace(/^\./, '');
    return d === 'eticketing.co.uk' || d.endsWith('.eticketing.co.uk');
}

/** Matches Chrome site-data hosts: eticketing.co.uk + www.eticketing.co.uk (not hd-queue / other subs). */
function cookieDomainIsWwwOrApexEticketing(domain) {
    const d = String(domain || '').toLowerCase().replace(/^\./, '');
    return d === 'eticketing.co.uk' || d === 'www.eticketing.co.uk';
}

function cookieDomainIsTmTickets(domain) {
    const d = String(domain || '').toLowerCase().replace(/^\./, '');
    return d === 'tmtickets.co.uk' || d.endsWith('.tmtickets.co.uk');
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

const ETICKETING_SITE_DATA_ORIGINS = [
    'https://www.eticketing.co.uk',
    'http://www.eticketing.co.uk',
    'https://eticketing.co.uk',
    'http://eticketing.co.uk',
    'https://hd-queue.eticketing.co.uk',
    'http://hd-queue.eticketing.co.uk',
    'https://web-identity.tmtickets.co.uk',
    'http://web-identity.tmtickets.co.uk',
    'https://www.tmtickets.co.uk',
    'http://www.tmtickets.co.uk',
    'https://tmtickets.co.uk',
    'http://tmtickets.co.uk'
];

const ETICKETING_COOKIE_PARTITION_SITES = [
    'https://www.eticketing.co.uk',
    'https://eticketing.co.uk',
    'https://hd-queue.eticketing.co.uk',
    'https://web-identity.tmtickets.co.uk',
    'https://www.tmtickets.co.uk'
];

function cookieDedupeKey(cookie) {
    return [
        cookie.storeId || '',
        cookie.domain || '',
        cookie.path || '',
        cookie.name || '',
        cookie.partitionKey ? JSON.stringify(cookie.partitionKey) : ''
    ].join('\0');
}

function cookiesGetAllPromise(query) {
    return new Promise((resolve) => {
        try {
            chrome.cookies.getAll(query, (cookies) => {
                if (chrome.runtime.lastError) {
                    resolve([]);
                    return;
                }
                resolve(cookies || []);
            });
        } catch (_) {
            resolve([]);
        }
    });
}

/**
 * Enumerate eticketing/tmtickets cookies the domain-only query misses:
 * store-wide getAll, domain getAll, and partitioned (CHIPS) cookies.
 * Chrome lock-icon "Clear data" removes partitioned + sessionStorage; domain getAll does not.
 */
async function collectEticketingCookiesThorough(opts) {
    const wwwAndApexOnly = !!(opts && opts.wwwAndApexOnly);
    const includeTmTickets = !!(opts && opts.includeTmTickets);
    const stores = await new Promise((resolve) => {
        chrome.cookies.getAllCookieStores((s) => resolve(s && s.length ? s : [{ id: undefined }]));
    });
    const domainQueries = ['eticketing.co.uk'];
    if (includeTmTickets) domainQueries.push('tmtickets.co.uk');

    const lists = [];
    for (const store of stores) {
        const base = store.id ? { storeId: store.id } : {};
        lists.push(await cookiesGetAllPromise(base));
        for (const domain of domainQueries) {
            lists.push(await cookiesGetAllPromise({ ...base, domain }));
            lists.push(await cookiesGetAllPromise({ ...base, domain, partitionKey: {} }));
            for (const topLevelSite of ETICKETING_COOKIE_PARTITION_SITES) {
                lists.push(
                    await cookiesGetAllPromise({
                        ...base,
                        domain,
                        partitionKey: { topLevelSite }
                    })
                );
                lists.push(
                    await cookiesGetAllPromise({
                        ...base,
                        domain,
                        partitionKey: { topLevelSite, hasCrossSiteAncestor: false }
                    })
                );
                lists.push(
                    await cookiesGetAllPromise({
                        ...base,
                        domain,
                        partitionKey: { topLevelSite, hasCrossSiteAncestor: true }
                    })
                );
            }
        }
    }

    const seen = new Set();
    const targets = [];
    const byDomain = {};
    const names = [];
    for (const list of lists) {
        for (const cookie of list) {
            const okEticketing = cookieDomainIsEticketing(cookie.domain);
            const okTm = includeTmTickets && cookieDomainIsTmTickets(cookie.domain);
            if (!okEticketing && !okTm) continue;
            if (wwwAndApexOnly && okEticketing && !cookieDomainIsWwwOrApexEticketing(cookie.domain)) {
                continue;
            }
            const key = cookieDedupeKey(cookie);
            if (seen.has(key)) continue;
            seen.add(key);
            targets.push(cookie);
            const d = cookie.domain || '?';
            byDomain[d] = (byDomain[d] || 0) + 1;
            names.push(
                (cookie.name || '?') +
                    '@' +
                    d +
                    (cookie.partitionKey ? '[p]' : '')
            );
        }
    }
    return { targets, byDomain, names };
}

function logCollectedCookies(label, collected) {
    const total = collected.targets.length;
    const namePreview = collected.names.slice(0, 40).join(', ');
    console.log(
        '[BG]',
        label,
        total,
        'cookie(s)',
        total ? JSON.stringify(collected.byDomain) : '(none)',
        namePreview ? '| ' + namePreview + (collected.names.length > 40 ? ' …' : '') : ''
    );
}

async function clearSessionStorageOnEticketingTabs(preferredTabId) {
    let tabs = [];
    try {
        tabs = await chrome.tabs.query({
            url: [
                '*://www.eticketing.co.uk/*',
                '*://eticketing.co.uk/*',
                '*://hd-queue.eticketing.co.uk/*',
                '*://web-identity.tmtickets.co.uk/*',
                '*://*.tmtickets.co.uk/*'
            ]
        });
    } catch (_) {
        tabs = [];
    }
    const ids = new Set();
    if (preferredTabId != null) ids.add(preferredTabId);
    for (const t of tabs || []) {
        if (t.id != null) ids.add(t.id);
    }
    let cleared = 0;
    for (const tabId of ids) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId, allFrames: true },
                world: 'MAIN',
                func: () => {
                    try {
                        sessionStorage.clear();
                    } catch (_) {}
                    try {
                        localStorage.clear();
                    } catch (_) {}
                }
            });
            cleared += 1;
        } catch (e) {
            console.warn(
                '[BG] session/localStorage inject failed on tab',
                tabId,
                e && e.message ? e.message : e
            );
        }
    }
    console.log('[BG] Cleared sessionStorage+localStorage on', cleared, 'eticketing/web-identity tab(s)');
}

function browsingDataRemoveOrigins() {
    return new Promise((resolve) => {
        if (!chrome.browsingData || typeof chrome.browsingData.remove !== 'function') {
            resolve({ ok: false, err: 'browsingData API missing' });
            return;
        }
        chrome.browsingData.remove(
            {
                origins: ETICKETING_SITE_DATA_ORIGINS,
                originTypes: { unprotectedWeb: true, protectedWeb: true }
            },
            {
                cookies: true,
                localStorage: true,
                indexedDB: true,
                cacheStorage: true,
                serviceWorkers: true,
                fileSystems: true,
                pluginData: true,
                // Same as Chrome lock-icon "cached images and files" for these origins.
                // Without this, reload after cookie clear can show the cached pause page.
                cache: true
            },
            () => {
                if (chrome.runtime.lastError) {
                    resolve({ ok: false, err: chrome.runtime.lastError.message });
                    return;
                }
                resolve({ ok: true });
            }
        );
    });
}

/**
 * Match Chrome lock-icon site data as closely as the extension APIs allow:
 * cookies API first (incl. partitioned), browsingData storage, leftover cookies, sessionStorage.
 */
function clearEticketingWwwSiteDataLikeChrome(done, tabId) {
    const finish = (ok, detail) => {
        console.log(
            '[BG] Chrome-like site data clear for eticketing.co.uk + www.eticketing.co.uk:',
            ok ? 'OK' : 'FAILED',
            detail || ''
        );
        if (typeof done === 'function') done(ok);
    };

    (async () => {
        try {
            const before = await collectEticketingCookiesThorough({ includeTmTickets: true });
            logCollectedCookies('Before site-data clear:', before);

            const removedFirst = await Promise.all(before.targets.map(removeOneEticketingCookie));
            console.log(
                '[BG] Cookies API removed',
                removedFirst.filter(Boolean).length,
                '/',
                before.targets.length,
                'cookie(s) (before browsingData)'
            );

            const bd = await browsingDataRemoveOrigins();
            if (!bd.ok) {
                console.warn('[BG] browsingData.remove failed:', bd.err);
            }

            const leftover = await collectEticketingCookiesThorough({ includeTmTickets: true });
            if (leftover.targets.length) {
                logCollectedCookies('Leftover after browsingData (removing):', leftover);
                const removedLeft = await Promise.all(leftover.targets.map(removeOneEticketingCookie));
                console.log(
                    '[BG] Leftover cookies API sweep:',
                    removedLeft.filter(Boolean).length,
                    '/',
                    leftover.targets.length
                );
            } else {
                console.log('[BG] Leftover cookies API sweep: 0 / 0 (none remaining)');
            }

            await clearSessionStorageOnEticketingTabs(tabId);

            const after = await collectEticketingCookiesThorough({ includeTmTickets: true });
            logCollectedCookies('After site-data clear:', after);

            finish(bd.ok, bd.ok ? '' : bd.err);
        } catch (e) {
            console.warn('[BG] clearEticketingWwwSiteDataLikeChrome error:', e?.message || e);
            clearEticketingCookiesOnly(() => finish(false, e?.message || String(e)), {

                wwwAndApexOnly: false,
                includeTmTickets: true
            });
        }
    })();
}

/**
 * Collect every cookie in every store (incl. partitioned) — full browser, not just eticketing.
 */
async function collectAllBrowserCookiesThorough() {
    const stores = await new Promise((resolve) => {
        chrome.cookies.getAllCookieStores((s) => resolve(s && s.length ? s : [{ id: undefined }]));
    });
    const lists = [];
    for (const store of stores) {
        const base = store.id ? { storeId: store.id } : {};
        lists.push(await cookiesGetAllPromise(base));
        lists.push(await cookiesGetAllPromise({ ...base, partitionKey: {} }));
        for (const topLevelSite of ETICKETING_COOKIE_PARTITION_SITES) {
            lists.push(
                await cookiesGetAllPromise({
                    ...base,
                    partitionKey: { topLevelSite }
                })
            );
            lists.push(
                await cookiesGetAllPromise({
                    ...base,
                    partitionKey: { topLevelSite, hasCrossSiteAncestor: false }
                })
            );
            lists.push(
                await cookiesGetAllPromise({
                    ...base,
                    partitionKey: { topLevelSite, hasCrossSiteAncestor: true }
                })
            );
        }
    }
    const seen = new Set();
    const targets = [];
    const byDomain = {};
    for (const list of lists) {
        for (const cookie of list) {
            const key = cookieDedupeKey(cookie);
            if (seen.has(key)) continue;
            seen.add(key);
            targets.push(cookie);
            const d = cookie.domain || '?';
            byDomain[d] = (byDomain[d] || 0) + 1;
        }
    }
    return { targets, byDomain, names: targets.map((c) => (c.name || '?') + '@' + (c.domain || '?')) };
}

function browsingDataRemovePromise(options, dataToRemove) {
    return new Promise((resolve) => {
        if (!chrome.browsingData || typeof chrome.browsingData.remove !== 'function') {
            resolve({ ok: false, err: 'browsingData API missing' });
            return;
        }
        chrome.browsingData.remove(options, dataToRemove, () => {
            if (chrome.runtime.lastError) {
                resolve({ ok: false, err: chrome.runtime.lastError.message });
                return;
            }
            resolve({ ok: true });
        });
    });
}

/** Every data type for full clear (passwords omitted — deprecated in Chrome). */
const FULL_BROWSER_CLEAR_DATA_TYPES = {
    appcache: true,
    cache: true,
    cacheStorage: true,
    cookies: true,
    downloads: true,
    fileSystems: true,
    formData: true,
    history: true,
    indexedDB: true,
    localStorage: true,
    pluginData: true,
    serviceWorkers: true,
    webSQL: true
};

/**
 * Full all-time browser clear for browsing-pause — as close as possible to Chrome UI
 * "Clear browsing data → All time" (cookies, history, cache, site data, etc.).
 * Does NOT clear passwords or chrome-extension:// storage.
 */
function clearFullBrowserDataForBrowsingPause(done, tabId) {
    const finish = (ok, detail) => {
        console.log(
            '[BG] Full all-time browser clear (browsing-pause):',
            ok ? 'OK' : 'FAILED',
            detail || ''
        );
        if (typeof done === 'function') done(ok);
    };

    (async () => {
        try {
            // 1) Wipe ALL cookies via cookies API (incl. partitioned) before browsingData
            const beforeAll = await collectAllBrowserCookiesThorough();
            logCollectedCookies('Before full clear — ALL browser cookies:', beforeAll);
            const removedFirst = await Promise.all(beforeAll.targets.map(removeOneEticketingCookie));
            console.log(
                '[BG] Cookies API removed',
                removedFirst.filter(Boolean).length,
                '/',
                beforeAll.targets.length,
                'cookie(s) (all sites)'
            );

            // 2) Chrome Clear browsing data equivalent — ALL time, unprotected + protected web
            //    (default without originTypes only clears unprotectedWeb — that was too weak)
            const removalOptions = {
                since: 0,
                originTypes: {
                    unprotectedWeb: true,
                    protectedWeb: true
                }
            };
            const bdMain = await browsingDataRemovePromise(removalOptions, FULL_BROWSER_CLEAR_DATA_TYPES);
            if (!bdMain.ok) {
                console.warn('[BG] Full browsingData.remove (main) failed:', bdMain.err);
            } else {
                console.log('[BG] browsingData.remove ALL time (unprotected+protected) — OK');
            }

            // 3) Explicit pass for eticketing / TM / Arsenal / queue origins (storage+cache+cookies)
            const bdOrigins = await browsingDataRemovePromise(
                {
                    since: 0,
                    origins: [
                        ...ETICKETING_SITE_DATA_ORIGINS,
                        'https://www.arsenal.com',
                        'http://www.arsenal.com',
                        'https://arsenal.com',
                        'http://arsenal.com'
                    ],
                    originTypes: { unprotectedWeb: true, protectedWeb: true }
                },
                {
                    cookies: true,
                    cache: true,
                    cacheStorage: true,
                    localStorage: true,
                    indexedDB: true,
                    serviceWorkers: true,
                    fileSystems: true,
                    pluginData: true,
                    webSQL: true,
                    appcache: true
                }
            );
            if (!bdOrigins.ok) {
                console.warn('[BG] browsingData.remove (eticketing/arsenal origins) failed:', bdOrigins.err);
            }

            // 4) Individual remove* calls (belt-and-suspenders — some types behave better alone)
            const individual = [
                ['removeCache', 'cache'],
                ['removeCookies', 'cookies'],
                ['removeHistory', 'history'],
                ['removeFormData', 'formData'],
                ['removeLocalStorage', 'localStorage'],
                ['removeIndexedDB', 'indexedDB'],
                ['removePluginData', 'pluginData'],
                ['removeWebSQL', 'webSQL'],
                ['removeAppcache', 'appcache'],
                ['removeFileSystems', 'fileSystems'],
                ['removeServiceWorkers', 'serviceWorkers'],
                ['removeCacheStorage', 'cacheStorage'],
                ['removeDownloads', 'downloads']
            ];
            for (const [fnName] of individual) {
                const fn = chrome.browsingData && chrome.browsingData[fnName];
                if (typeof fn !== 'function') continue;
                try {
                    await new Promise((resolve) => {
                        fn.call(chrome.browsingData, removalOptions, () => {
                            if (chrome.runtime.lastError) {
                                console.warn(
                                    '[BG]',
                                    fnName,
                                    ':',
                                    chrome.runtime.lastError.message
                                );
                            }
                            resolve();
                        });
                    });
                } catch (e) {
                    console.warn('[BG]', fnName, 'threw:', e?.message || e);
                }
            }

            // 5) Leftover cookie sweep (all sites again)
            const leftover = await collectAllBrowserCookiesThorough();
            if (leftover.targets.length) {
                logCollectedCookies('Leftover cookies after browsingData (removing):', leftover);
                await Promise.all(leftover.targets.map(removeOneEticketingCookie));
            } else {
                console.log('[BG] Leftover cookies after full clear: 0');
            }

            // 6) Tab session/localStorage inject clear on eticketing/web-identity tabs
            await clearSessionStorageOnEticketingTabs(tabId);

            const after = await collectAllBrowserCookiesThorough();
            logCollectedCookies('After full browser clear — remaining cookies:', after);
            const ok = bdMain.ok || bdOrigins.ok || after.targets.length === 0;
            finish(
                ok,
                after.targets.length
                    ? bdMain.err || bdOrigins.err || after.targets.length + ' cookies remain'
                    : ''
            );
        } catch (e) {
            console.warn('[BG] clearFullBrowserDataForBrowsingPause error:', e?.message || e);
            // Last resort: still try origin-scoped clear
            clearEticketingWwwSiteDataLikeChrome(
                (ok) => finish(!!ok, e?.message || String(e)),
                tabId
            );
        }
    })();
}

/**
 * Clear eticketing cookies across cookie stores (httpOnly / secure / session / partitioned).
 */
function clearEticketingCookiesOnly(done, opts) {
    const wwwAndApexOnly = !!(opts && opts.wwwAndApexOnly);
    const includeTmTickets = !!(opts && opts.includeTmTickets);
    const leftoverSweep = !!(opts && opts.leftoverSweep);
    const scopeLabel = wwwAndApexOnly
        ? 'eticketing.co.uk + www.eticketing.co.uk'
        : 'eticketing.co.uk (all subdomains)' + (includeTmTickets ? ' + tmtickets.co.uk' : '');
    const finish = (removed, total) => {
        console.log(
            leftoverSweep
                ? '[BG] Leftover cookies API sweep after browsingData:'
                : '[BG] Cleared',
            removed,
            '/',
            total,
            'cookie(s) for',
            scopeLabel,
            leftoverSweep && total === 0 ? '(expected if browsingData already removed them)' : ''
        );
        if (typeof done === 'function') done();
    };

    collectEticketingCookiesThorough({ wwwAndApexOnly, includeTmTickets })
        .then(async (collected) => {
            if (collected.targets.length === 0) {
                finish(0, 0);
                return;
            }
            const results = await Promise.all(collected.targets.map(removeOneEticketingCookie));
            finish(results.filter(Boolean).length, collected.targets.length);
        })
        .catch((e) => {
            console.warn('[BG] clearEticketingCookiesOnly error:', e?.message || e);
            if (typeof done === 'function') done();
        });
}

function resetHdQueueReloadCounters(reason) {
    for (const timerId of hdQueueStormConfirmTimerByTab.values()) {
        try {
            clearTimeout(timerId);
        } catch (_) {}
    }
    hdQueueStormConfirmTimerByTab.clear();
    hdQueueReloadStateByTab.clear();
    console.log('[BG] HD queue reload counter reset to 0:', reason || '(no reason)');
}

/** True for hd-queue pages we monitor for reload storms (excludes /error403 — own recovery path). */
function urlIsHdQueueReloadMonitored(url) {
    if (!url) return false;
    const path = hdQueuePathnameLower(url);
    if (!path && !String(url).toLowerCase().includes('hd-queue.eticketing.co.uk')) return false;
    if (!path) {
        const lower = String(url).toLowerCase();
        if (!lower.includes('hd-queue.eticketing.co.uk')) return false;
        if (urlIsHdQueueError403Path(url)) return false;
        return true;
    }
    if (path.includes('/error403')) return false;
    return true;
}

/** Queue-IT /view challenge page (e.g. proofofwork) — do not run storm recovery. */
function urlIsHdQueueViewPage(url) {
    if (!url) return false;
    try {
        const u = new URL(url);
        if (!u.hostname.toLowerCase().includes('hd-queue.eticketing.co.uk')) return false;
        return (u.pathname || '').toLowerCase().includes('/view');
    } catch (_) {
        const lower = String(url).toLowerCase();
        return lower.includes('hd-queue.eticketing.co.uk') && lower.includes('/view');
    }
}

/**
 * After HD_QUEUE_RELOAD_MAX_COUNT reloads: wait 4s, then if URL is still not /view → storm recovery;
 * if URL contains /view → ignore recovery (queue progressed).
 */
async function confirmAndRecoverHdQueueReloadStorm(tabId, reloadCount) {
    if (hdQueueReloadRecoveryInProgress) return;
    let tabUrl = '';
    let pendingUrl = '';
    try {
        const tab = await chrome.tabs.get(tabId);
        tabUrl = tab.url || '';
        pendingUrl = tab.pendingUrl || '';
    } catch (e) {
        console.warn('[BG] HD queue storm confirm: tab gone', tabId, e?.message || e);
        return;
    }
    const checkUrl = tabUrl || pendingUrl;
    if (urlIsHdQueueViewPage(tabUrl) || urlIsHdQueueViewPage(pendingUrl)) {
        console.log(
            '[BG] HD queue storm: after ' +
                HD_QUEUE_RELOAD_STORM_CONFIRM_DELAY_MS / 1000 +
                's URL has /view — ignoring recovery on tab',
            tabId,
            checkUrl
        );
        // Restart count so another N reloads are needed if they leave /view and thrash again
        hdQueueReloadStateByTab.set(tabId, { reloadCount: 0 });
        return;
    }
    console.log(
        '[BG] HD queue storm: after ' +
            HD_QUEUE_RELOAD_STORM_CONFIRM_DELAY_MS / 1000 +
            's URL has no /view — running recovery on tab',
        tabId,
        checkUrl || '(empty url)'
    );
    await recoverFromHdQueueReloadStorm(
        tabId,
        'reloaded ' + reloadCount + ' times (confirmed after ' + HD_QUEUE_RELOAD_STORM_CONFIRM_DELAY_MS / 1000 + 's)'
    );
}

function scheduleHdQueueReloadStormConfirm(tabId, reloadCount) {
    if (tabId == null) return;
    if (hdQueueReloadRecoveryInProgress) return;
    if (hdQueueStormConfirmTimerByTab.has(tabId)) {
        console.log('[BG] HD queue storm confirm already pending for tab', tabId);
        return;
    }
    console.log(
        '[BG] HD queue reload #' +
            reloadCount +
            ' tab ' +
            tabId +
            ' — waiting ' +
            HD_QUEUE_RELOAD_STORM_CONFIRM_DELAY_MS / 1000 +
            's then check for /view before recovery'
    );
    const timerId = setTimeout(() => {
        hdQueueStormConfirmTimerByTab.delete(tabId);
        confirmAndRecoverHdQueueReloadStorm(tabId, reloadCount).catch((e) =>
            console.warn('[BG] confirmAndRecoverHdQueueReloadStorm error:', e?.message || e)
        );
    }, HD_QUEUE_RELOAD_STORM_CONFIRM_DELAY_MS);
    hdQueueStormConfirmTimerByTab.set(tabId, timerId);
}

/**
 * Count HD queue tab loads/reloads. Triggers recovery after HD_QUEUE_RELOAD_MAX_COUNT reloads following the initial queue entry.
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
        scheduleHdQueueReloadStormConfirm(tabId, reloadCount);
    }
}

function tabUrlIsArsenalMembershipRed(url) {
    if (!url) return false;
    const u = String(url).toLowerCase();
    return u.includes('www.arsenal.com') && u.includes('/membership/red');
}

/** Any EventNotAllowed validation page — never navigate this tab for event/membership open. */
function tabUrlIsValidationMonitor(url) {
    // Only the intentional EventArchived placeholder. Sold-out / other EventNotAllowed
    // redirects must remain navigable so we can retry the real eventUrl.
    return tabUrlIsValidationArchivedTab(url);
}

function getEventNotAllowedReason(url) {
    if (!url) return '';
    try {
        return (new URL(url).searchParams.get('reason') || '').toLowerCase();
    } catch {
        const m = String(url).toLowerCase().match(/[?&]reason=([^&]*)/);
        return m ? decodeURIComponent(m[1]) : '';
    }
}

/** Event tab redirected because sales modes unavailable / sold out — temporary; retry after pause. */
function tabUrlIsEventSoldOutOrNoSales(url) {
    if (!url) return false;
    const u = String(url).toLowerCase();
    // Keyword match (any club): …/EventNotAllowed?…reason=EventNoAvailableSalesModesOrSoldOut
    if (!u.includes('eventnotallowed')) return false;
    return (
        u.includes('eventnoavailablesalesmodesorsoldout') ||
        getEventNotAllowedReason(url) === 'eventnoavailablesalesmodesorsoldout'
    );
}

function tabIsValidationMonitorTab(tab) {
    if (!tab) return false;
    if (notAllowedTabId != null && tab.id === notAllowedTabId) return true;
    return tabUrlIsValidationMonitor(tab.url) || tabUrlIsValidationMonitor(tab.pendingUrl);
}

function tabUrlIsArsenalMembershipsList(url) {
    if (!url) return false;
    return String(url).toLowerCase().includes('/arsenal/memberships/list');
}

/**
 * Prefer one existing Arsenal flow tab (membership / list / event / web-identity / eticketing)
 * instead of opening a second membership tab.
 * Never returns the validation (EventNotAllowed) tab.
 */
function findReusableArsenalFlowTab(allTabs, preferTabId) {
    const list = allTabs || [];
    const score = (t) => {
        if (!t || t.id == null) return -1;
        if (tabIsValidationMonitorTab(t)) return -1;
        const u = t.url || '';
        const p = t.pendingUrl || '';
        if (tabUrlIsValidationMonitor(u) || tabUrlIsValidationMonitor(p)) return -1;
        if (tabUrlIsArsenalMembershipRed(u) || tabUrlIsArsenalMembershipRed(p)) return 100;
        if (tabUrlIsArsenalMembershipsList(u) || tabUrlIsArsenalMembershipsList(p)) return 90;
        if (tabUrlIsWebIdentity(u) || tabUrlIsWebIdentity(p)) return 80;
        if (tabUrlIsEventIndex(u) || tabUrlIsEventIndex(p)) return 70;
        if (
            (u.includes('www.eticketing.co.uk/arsenal') || p.includes('www.eticketing.co.uk/arsenal')) &&
            !tabIsCheckout(u) &&
            !tabIsCheckout(p)
        ) {
            return 60;
        }
        return -1;
    };
    if (preferTabId != null) {
        const pref = list.find((t) => t.id === preferTabId);
        if (pref && score(pref) >= 0) return pref;
    }
    if (eventTabId != null && eventTabId !== notAllowedTabId) {
        const et = list.find((t) => t.id === eventTabId);
        if (et && score(et) >= 0) return et;
    }
    let best = null;
    let bestScore = -1;
    for (const t of list) {
        const sc = score(t);
        if (sc > bestScore) {
            best = t;
            bestScore = sc;
        }
    }
    return bestScore >= 0 ? best : null;
}

/** Close extra membership/list tabs so only keepTabId remains for that flow. */
async function closeDuplicateArsenalMembershipTabs(keepTabId) {
    if (keepTabId == null) return;
    try {
        const all = await chrome.tabs.query({});
        const extras = [];
        for (const t of all || []) {
            if (t.id == null || t.id === keepTabId) continue;
            const u = t.url || '';
            const p = t.pendingUrl || '';
            if (
                tabUrlIsArsenalMembershipRed(u) ||
                tabUrlIsArsenalMembershipRed(p) ||
                tabUrlIsArsenalMembershipsList(u) ||
                tabUrlIsArsenalMembershipsList(p)
            ) {
                extras.push(t.id);
            }
        }
        if (!extras.length) return;
        const { removed } = await safeTabsRemove(extras);
        if (removed.length) {
            console.log(
                '[BG] Closed duplicate Arsenal membership/list tab(s):',
                removed.join(','),
                '| kept',
                keepTabId
            );
        }
    } catch (e) {
        console.warn('[BG] closeDuplicateArsenalMembershipTabs failed:', e?.message || e);
    }
}

/**
 * Open / resume the event flow via Arsenal Red membership:
 * membership/red → JOIN NOW → Memberships/List → content.js navigates to stored eventUrl.
 * Never opens a second membership tab if any Arsenal flow tab already exists.
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
        await closeDuplicateArsenalMembershipTabs(existingRed.id);
        console.log('[BG] Event open via membership: existing Red membership tab', existingRed.id);
        return { success: true, action: 'membership-red-existing', tabId: existingRed.id };
    }

    const existingList = all.find(
        (t) => tabUrlIsArsenalMembershipsList(t.url) || tabUrlIsArsenalMembershipsList(t.pendingUrl)
    );
    if (existingList && existingList.id != null) {
        if (wantFocus) await focusTabWindow(existingList.id);
        await closeDuplicateArsenalMembershipTabs(existingList.id);
        console.log(
            '[BG] Event open via membership: Memberships/List already open (will redirect to eventUrl)',
            existingList.id
        );
        return { success: true, action: 'memberships-list-existing', tabId: existingList.id };
    }

    const membershipUrl = HD_QUEUE_MEMBERSHIP_RECOVERY_URL;
    const reusable = findReusableArsenalFlowTab(all, reuseTabId);
    let navTabId = reusable && reusable.id != null ? reusable.id : reuseTabId;
    // Never navigate the validation (EventNotAllowed) tab for event/membership open
    if (navTabId != null) {
        const navTab =
            all.find((t) => t.id === navTabId) ||
            (notAllowedTabId != null && navTabId === notAllowedTabId ? { id: navTabId } : null);
        if (
            navTabId === notAllowedTabId ||
            (navTab && tabIsValidationMonitorTab(navTab))
        ) {
            console.log(
                '[BG] Event open via membership: refusing to reuse validation tab',
                navTabId,
                '— will open a new tab'
            );
            navTabId = null;
        }
    }
    if (navTabId != null) {
        try {
            await chrome.tabs.update(navTabId, { url: membershipUrl, active: wantFocus });
            if (wantFocus) await focusTabWindow(navTabId);
            eventTabId = navTabId;
            await closeDuplicateArsenalMembershipTabs(navTabId);
            console.log('[BG] Event open via membership: navigated tab', navTabId, '→', membershipUrl);
            return { success: true, action: 'membership-red-navigated', tabId: navTabId };
        } catch (e) {
            console.warn('[BG] Event open via membership: navigate failed, creating new tab:', e?.message || e);
        }
    }

    const created = await chrome.tabs.create({ url: membershipUrl, active: wantFocus });
    if (created && created.id != null) {
        eventTabId = created.id;
        if (wantFocus) await focusTabWindow(created.id);
        await closeDuplicateArsenalMembershipTabs(created.id);
        // Drop leftover pause/event tabs so JOIN NOW does not leave a second event tab around
        try {
            const leftovers = (await chrome.tabs.query({})).filter((t) => {
                if (t.id == null || t.id === created.id) return false;
                const u = t.url || '';
                const p = t.pendingUrl || '';
                return (
                    tabUrlIsEventIndex(u) ||
                    tabUrlIsEventIndex(p) ||
                    tabUrlIsWebIdentity(u) ||
                    tabUrlIsWebIdentity(p) ||
                    tabTitleIsBrowsingPaused(t.title)
                );
            });
            if (leftovers.length) {
                const { removed } = await safeTabsRemove(leftovers.map((t) => t.id));
                if (removed.length) {
                    console.log('[BG] Closed leftover event/web-identity tab(s) after new membership tab:', removed.join(','));
                }
            }
        } catch (_) {}
    }
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
        // Paused-tab recovery state must not block refresh after this tab is closed/moved
        clearBrowsingPauseStateForTab(tabId, { clearStoragePending: true });
        await forceReleaseBrowsingPauseHold('HD queue storm recovery tab ' + tabId);

        const { removed, skipped } = await safeTabsRemove(tabId);
        if (removed.length) console.log('[BG] Closed HD queue tab after reload storm:', tabId);
        if (skipped.length) {
            console.warn('[BG] HD queue tab not closed (last tab in window) — will navigate it to membership');
        }

        const reuseTabId = skipped.length && !removed.length ? tabId : null;
        await openEventEntryForClub({ focus: true, reuseTabId });

        console.log('[BG] Skipping eticketing cookie clear after queue reload storm (disabled)');
        resetHdQueueReloadCounters('after storm recovery (event entry)');
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
/** After cookie-clear, if browsing pause persists: escalating cooldown then resume. */
const BROWSING_PAUSE_COOLDOWN_ALARM = 'browsingPauseCooldown';
const BROWSING_PAUSE_COOLDOWN_UNTIL_KEY = 'browsingPauseCooldownUntil';
const BROWSING_PAUSE_COOLDOWN_TAB_KEY = 'browsingPauseCooldownTabId';
/** How many cooldowns have run since last token-ready reset (1→30m, 2→1h, 3→2h, 4+→4h). */
const BROWSING_PAUSE_COOLDOWN_STREAK_KEY = 'browsingPauseCooldownStreak';
/** Ms used for the currently armed cooldown (for END logs). */
const BROWSING_PAUSE_COOLDOWN_ACTIVE_MS_KEY = 'browsingPauseCooldownActiveMs';
const BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY = 'browsingPauseCookiesClearedPendingTabId';
/** Global hold: freeze heartbeat / openOrFocusTabs / event refresh while browsing-pause recovery runs. */
const BROWSING_PAUSE_SYSTEM_HOLD_KEY = 'browsingPauseSystemHold';
/** True while Google Sheet is Off and browsing-pause recovery is frozen (resume on On). */
const BROWSING_PAUSE_SHEET_OFF_FROZEN_KEY = 'browsingPauseSheetOffFrozen';
const BROWSING_PAUSE_FROZEN_SNAPSHOT_KEY = 'browsingPauseFrozenSnapshot';
let browsingPauseSystemHoldLogged = false;
let browsingPauseFrozenBySheetOff = false;

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
                    const stCap = await chrome.storage.local.get(['hdQueueRecoveryIsCaptcha']);
                    const wasCaptcha = stCap.hdQueueRecoveryIsCaptcha === true;
                    if (removed.length) {
                        console.log(
                            '[BG] hd-queue recovery alarm closed old ' +
                                (wasCaptcha ? 'captcha/softblock' : '/error403') +
                                ' tab:',
                            tabId
                        );
                    }
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
                    [HD_QUEUE_ERROR403_RECOVERY_TAB_ID_KEY]: null,
                    hdQueueRecoveryIsCaptcha: false
                });
            }
        })().catch((e) => console.warn('[BG] hd-queue recovery alarm handler error:', e?.message || e));
    } else if (alarm.name === EVENT_SOLD_OUT_RETRY_ALARM) {
        runEventSoldOutRetryFromAlarm().catch((e) =>
            console.warn('[BG] event sold-out retry alarm error:', e?.message || e)
        );
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
            if (tabUrlIsEventSoldOutOrNoSales(u)) {
                console.log('[BG] Skipped closing event tab — landed on sold-out/no-sales (will retry):', tabId);
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
    webIdentityAuthorizeSeenAt.delete(tabId);
    const t = eventTabPostTokenCloseTimers.get(tabId);
    if (t != null) {
        clearTimeout(t);
        eventTabPostTokenCloseTimers.delete(tabId);
    }
    if (tabId === eventTabId) eventTabId = null;
    void releaseBrowsingPauseBecauseTabGone(tabId, 'browsing-pause tab closed ' + tabId);
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
    if (navUrl && tabUrlIsEventSoldOutOrNoSales(navUrl)) {
        scheduleEventSoldOutRetry(tabId, 'tab navigated to EventNoAvailableSalesModesOrSoldOut').catch((e) =>
            console.warn('[BG] scheduleEventSoldOutRetry (onUpdated) error:', e?.message || e));
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

        const startSecondRows = allCfg.filter(cfg => parseFloat(cfg.startSecond) === targetNum);
        const matchingRows = startSecondRows.filter(cfg =>
            ['on', 'start', 'true', '1'].includes((cfg.status || '').toString().trim().toLowerCase())
        );

        const breakSrcRow = matchingRows[0] || startSecondRows[0] || null;
        const br = await evaluateUkBreakWindow(breakSrcRow && breakSrcRow.ukBreakTime);
        await chrome.storage.local.set({
            ukBreakActive: br.active === true,
            ukBreakRangeLabel: br.range ? br.range.label : '',
            ukBreakNowLabel: br.ukNow ? br.ukNow.clock : ''
        });

        const anyMatch = matchingRows.length > 0;
        const currentStatus = anyMatch && !br.active ? 'on' : 'off';

        if (br.active && anyMatch && !lastUkBreakActive) {
            console.log(
                '[BG] UK break window active (' +
                    (br.activeLabel || (br.range && br.range.label)) +
                    (br.range && br.range.windows && br.range.windows.length > 1
                        ? ' of ' + br.range.label
                        : '') +
                    ', now ' +
                    (br.ukNow && br.ukNow.clock) +
                    ' UK) — stopping like sheet Off'
            );
        }
        if (!br.active && lastUkBreakActive && anyMatch) {
            console.log(
                '[BG] UK break window ended (now ' +
                    (br.ukNow && br.ukNow.clock) +
                    ' UK, range ' +
                    (br.range && br.range.label) +
                    ') — sheet is On, resuming'
            );
        }
        lastUkBreakActive = br.active === true;

        if (currentStatus !== lastStatus) {
            const previousStatus = lastStatus;
            console.log(`[BG] Status changed: ${lastStatus} -> ${currentStatus}`);
            lastStatus = currentStatus;

            if (anyMatch) {
                if (previousStatus !== 'on') {
                    const queueActive = await isQueueItActive();
                    await resetError403State(
                        br.active
                            ? 'resume after UK break (sheet still On)'
                            : 'Google Sheet status turned on (was off or unset)',
                        {
                            // Do not wipe Botdeflector/BotDetect appearance count mid-queue
                            preserveCaptchaCount: true,
                            // If already in Queue-IT, keep rotation step so we don't restart at step 1
                            preserveRecoveryProgress: queueActive === true
                        }
                    );
                    await resetEventPageReadyFlag(
                        br.range && previousStatus === 'off'
                            ? 'resume after UK break or sheet On'
                            : 'Google Sheet status turned on (was off or unset)'
                    );
                }
                console.log('[BG] Auto-start triggered for matching rows');
                const recoveryOwns = await resumeBrowsingPauseRecoveryAfterSheetOn();
                for (const row of matchingRows) {
                    console.log('[BG] Opening tabs for', row.eventUrl);
                    await syncSheetRowToStorage(row, { openingTabs: true });
                    EVENT_URL = row.eventUrl;
                    const clubName = clubNameFromEventUrl(EVENT_URL);
                    EVENT_NOT_ALLOWED_URL = `https://www.eticketing.co.uk/${clubName}/EDP/Validation/EventNotAllowed?eventId=4&reason=EventArchived`;
                    if (!recoveryOwns) {
                        await openOrFocusTabs(EVENT_URL, EVENT_NOT_ALLOWED_URL);
                    } else {
                        console.log(
                            '[BG] Sheet On — skipping event-tab open; browsing-pause recovery/cooldown still in progress'
                        );
                    }
                }
                await notifyValidationTabStartMonitoring();
            } else {
                console.log(br.active && anyMatch ? '[BG] Auto-stop triggered (UK break window)' : '[BG] Auto-stop triggered');
                notifyTabStop();
                await freezeBrowsingPauseRecoveryForSheetOff();
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

/** When event tab finishes (token / eventPageReady), open validation if missing. */
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.eventPageReady?.newValue === true && changes.eventPageReady?.oldValue !== true) {
        void resetBrowsingPauseCooldownStreak('storage-eventPageReady');
        void ensureValidationTabExistsAfterEventReady('storage-eventPageReady');
    }
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
        (async () => {
            await chrome.storage.local.set({ hdQueueSoftblockUrl: raw });
            lastSetQueueWaitingAt = Date.now();
            await chrome.storage.local.set({ inQueueWaiting: true });
            console.log('[BG] Saved hdQueueSoftblockUrl for recovery:', raw);
            sendResponse({ success: true });
        })().catch((e) => {
            console.warn('[BG] saveHdQueueSoftblockUrl error:', e?.message || e);
            sendResponse({ success: false, message: e?.message || String(e) });
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
    if (msg.action === 'eventSoldOutRetry') {
        (async () => {
            const tabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;
            const src = tabId != null ? 'content-tab-' + tabId : 'content-script';
            await scheduleEventSoldOutRetry(tabId, src);
            sendResponse({ success: true });
        })().catch((e) => {
            console.warn('[BG] eventSoldOutRetry error:', e?.message || e);
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
        const tabUrl = (sender.tab && (sender.tab.url || sender.tab.pendingUrl)) || '';
        let src = (msg.source && String(msg.source)) || '';
        // Always tag web-identity detects so they share eticketing pause recovery (grace / 5s / clear / cooldown)
        if (tabUrlIsWebIdentity(tabUrl)) {
            if (!src) src = 'web-identity-dom';
            else if (src.indexOf('web-identity') < 0) src = 'web-identity-' + src;
        } else if (!src) {
            src = 'content-script';
        }
        noteBrowsingActivityPausedTab(tabId, src);
        sendResponse({ success: true });
        return false;
    }
    if (msg.action === 'setQueueWaiting') {
        const waiting = msg.inQueueWaiting === true;
        if (waiting) {
            lastSetQueueWaitingAt = Date.now();
            chrome.storage.local.set({ inQueueWaiting: true });
            console.log('[BG] setQueueWaiting true (people ahead of you)');
            sendResponse({ success: true });
            return false;
        }
        (async () => {
            const senderUrl = (sender && sender.tab && (sender.tab.url || sender.tab.pendingUrl)) || '';
            if (urlIsHdQueueLiveQueuePath(senderUrl)) {
                lastSetQueueWaitingAt = Date.now();
                await chrome.storage.local.set({ inQueueWaiting: true });
                sendResponse({ success: true, kept: true, reason: 'live queue tab' });
                return;
            }
            try {
                const tabs = await chrome.tabs.query({});
                if (tabs.some((t) => tabIsHdQueueLiveQueue(t.url, t.pendingUrl))) {
                    lastSetQueueWaitingAt = Date.now();
                    await chrome.storage.local.set({ inQueueWaiting: true });
                    sendResponse({ success: true, kept: true, reason: 'live queue tab open' });
                    return;
                }
            } catch (_) {}
            lastSetQueueWaitingAt = 0;
            await chrome.storage.local.set({ inQueueWaiting: false });
            console.log('[BG] setQueueWaiting false');
            sendResponse({ success: true });
        })().catch((e) => {
            console.warn('[BG] setQueueWaiting error:', e?.message || e);
            sendResponse({ success: false });
        });
        return true;
    }
    if (msg.action === 'clearCookiesAndReopenInSameTab') {
        if (!sender.tab) {
            sendResponse({ success: false, message: 'Only content script can request' });
            return false;
        }
        const tabId = sender.tab.id;
        console.log('[BG] clearCookiesAndReopenInSameTab from queue tab', tabId);
        clearEticketingCookiesOnly(async () => {
            console.log('[BG] clearCookiesAndReopenInSameTab — opening club event entry');
            await openEventEntryForClub({ focus: true, reuseTabId: tabId });
            sendResponse({ success: true });
        });
        return true;
    }
    if (msg.action === 'resetError403Count') {
        // Only treat event as loaded when verification token set eventPageReady
        (async () => {
            if (!(await isEventPageReady())) {
                console.log(
                    '[BG] resetError403Count ignored — eventPageReady not set (URL load alone is not enough)'
                );
                sendResponse({ success: false, ignored: true, reason: 'eventPageReady not set' });
                return;
            }
            await chrome.storage.local.set({
                error403Count: 0,
                [HD_QUEUE_ERROR403_RECOVERY_STEP_KEY]: 0,
                [HD_QUEUE_ERROR403_RECOVERY_CYCLE_INDEX_KEY]: 0,
                [HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]: 0
            });
            resetHdQueueReloadCounters('event page loaded successfully (verification token ready)');
            console.log(
                '[BG] error403Count + recovery step/cycle + captcha count reset to 0 (verification token ready)'
            );
            sendResponse({ success: true });
        })().catch((e) => {
            console.warn('[BG] resetError403Count error:', e?.message || e);
            sendResponse({ success: false, error: e?.message || String(e) });
        });
        return true;
    }
        if (msg.action === 'error403Detected') {
        const senderTabId = sender && sender.tab ? sender.tab.id : null;
        const tabUrl = (sender && sender.tab && (sender.tab.url || sender.tab.pendingUrl)) || '';
        (async () => {
            const captchaRecovery = msg.fromHdQueueCaptchaRecovery === true;
            if (
                urlIsHdQueueLiveQueuePath(tabUrl) &&
                !urlIsHdQueueError403Path(tabUrl) &&
                !captchaRecovery
            ) {
                console.log(
                    '[BG] error403Detected ignored — tab is live hd-queue (softblock/view), not /error403'
                );
                await abortHdQueueError403RecoveryForActiveQueue('error403Detected from live queue tab');
                return;
            }
            if (captchaRecovery && urlIsHdQueueLiveQueuePath(tabUrl)) {
                console.log(
                    '[BG] hd-queue captcha recovery after wait on live queue' +
                        (msg.captchaKind ? ' (' + msg.captchaKind + ')' : '') +
                        ' — starting URL rotation (not a real /error403 page)'
                );
            }
            // Captcha recovery reuses the same URL-rotation machinery as /error403, but is not an HTTP 403 page
            const fromHdQueue =
                captchaRecovery ||
                msg.fromHdQueueError403 === true ||
                urlIsHdQueueError403Path(tabUrl);
            const detectedAt = new Date();
            if (captchaRecovery) {
                console.log(
                    '[BG] captcha URL recovery at',
                    detectedAt.toLocaleTimeString(),
                    msg.captchaKind ? '(' + msg.captchaKind + ')' : '(hd-queue captcha)'
                );
            } else {
                console.log(
                    '[BG] error403 detected at',
                    detectedAt.toLocaleTimeString(),
                    urlIsHdQueueError403Path(tabUrl) || msg.fromHdQueueError403
                        ? '(hd-queue /error403)'
                        : '(validation/seat path)'
                );
            }
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
                ? captchaRecovery
                    ? ` [captcha URL recovery step ${recoveryStep + 1}/3]`
                    : ` [hd-queue rotating recovery step ${recoveryStep + 1}/3]`
                : ' [seat path 5+3·n min]';
            console.log(
                `[BG] ${captchaRecovery ? 'captcha recovery' : 'error403'}: occurrence #${prior + 1}, pause ${waitMinutes} min (max ${ERROR403_MAX_WAIT_MINUTES}), resume ~${resumeAt.toLocaleTimeString()}` +
                    modeTag
            );
            if (fromHdQueue) {
                // Real /error403 only — do not prune softblock captcha tabs as "error403"
                if (!captchaRecovery) {
                    await enforceSingleHdQueueError403Tab(senderTabId);
                }
                let tabIdToUse = senderTabId;
                if (tabIdToUse == null && !captchaRecovery) {
                    tabIdToUse = await findHdQueueError403TabId();
                }
                if (tabIdToUse == null) {
                    console.warn(
                        captchaRecovery
                            ? '[BG] captcha URL recovery: no sender tabId; cannot open recovery URL.'
                            : '[BG] hd-queue /error403 recovery: no hd-queue /error403 tabId found; cannot open recovery URL.'
                    );
                    return;
                }

                let targetUrl = '';
                const clubName = clubNameFromEventUrl(eventUrlStored) || 'arsenal';
                const clubHome = 'https://www.eticketing.co.uk/' + clubName;
                if (recoveryStep === 0) {
                    targetUrl = clubHome;
                } else if (recoveryStep === 1) {
                    // Arsenal: membership/red; other clubs: event URL directly
                    if (eventUrlIsArsenalClub(eventUrlStored)) {
                        targetUrl = HD_QUEUE_MEMBERSHIP_RECOVERY_URL;
                    } else {
                        targetUrl = eventUrlStored || clubHome;
                    }
                } else {
                    targetUrl = hasSavedSoftblock
                        ? softblockUrl
                        : eventUrlIsArsenalClub(eventUrlStored)
                          ? HD_QUEUE_MEMBERSHIP_RECOVERY_URL
                          : eventUrlStored || clubHome;
                }

                const nextStep = (recoveryStep + 1) % 3;
                const nextCycleIndex = recoveryStep === 2 ? cycleIndex + 1 : cycleIndex;

                await chrome.storage.local.set({
                    [HD_QUEUE_ERROR403_RECOVERY_STEP_KEY]: nextStep,
                    [HD_QUEUE_ERROR403_RECOVERY_CYCLE_INDEX_KEY]: nextCycleIndex,
                    [HD_QUEUE_ERROR403_RECOVERY_TARGET_URL_KEY]: targetUrl,
                    [HD_QUEUE_ERROR403_RECOVERY_TAB_ID_KEY]: tabIdToUse,
                    hdQueueRecoveryIsCaptcha: captchaRecovery === true
                });

                chrome.alarms.clear(HD_QUEUE_ERROR403_RECOVERY_ALARM);
                chrome.alarms.create(HD_QUEUE_ERROR403_RECOVERY_ALARM, { when: Date.now() + waitMs });

                const waitLabel = Math.round(waitMs / 1000) + 's';
                console.log(
                    '[BG] hd-queue ' +
                        (captchaRecovery ? 'captcha' : '/error403') +
                        ' recovery: next open after ' +
                        waitLabel +
                        ': ' +
                        targetUrl +
                        ' (tab ' +
                        tabIdToUse +
                        ', next step index ' +
                        nextStep +
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
            webIdentityBrowsingPauseCycles = 0;
            await resetBrowsingPauseCooldownStreak('event tab verification token ready');
            await forceReleaseBrowsingPauseHold('event tab verification token ready');
            await endError403PauseFromQueueOrToken('event tab verification token ready', { clearInQueueWaiting: true });
            await ensureValidationTabExistsAfterEventReady('verification token ready');
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
        (async () => {
            if (Date.now() < error403PauseUntil) {
                console.log('[BG] refreshEventTab skipped - error403 pause active.');
                sendResponse({ success: false, skipped: true, message: 'error403 pause active, skipped' });
                return;
            }
            if (await isEventSoldOutPauseActive()) {
                console.log(
                    '[BG] refreshEventTab skipped — sold-out/no-sales pause (retry ~' +
                        formatEventSoldOutPauseEndsAt() +
                        ')'
                );
                sendResponse({ success: false, skipped: true, message: 'sold-out pause active, skipped' });
                return;
            }
            if (await isQueueItActive()) {
                console.log('[BG] refreshEventTab skipped — Queue-IT active');
                sendResponse({ success: false, skipped: true, message: 'Queue-IT active, skipped' });
                return;
            }
            console.log('[BG] refreshEventTab requested', msg);
            try {
                const result = await refreshEventTab();
                if (result && result.skipped) {
                    console.log('[BG] Event tab refresh skipped:', result.message || '(no message)');
                    sendResponse({
                        success: false,
                        skipped: true,
                        message: result.message || 'refresh skipped'
                    });
                    return;
                }
                console.log('[BG] Event tab refreshed successfully and response sent.');
                sendResponse({ success: true, message: 'Event tab refreshed', result: result || null });
            } catch (err) {
                console.error('[BG] refreshEventTab error:', err);
                sendResponse({ success: false, message: err?.message || 'Unknown error' });
            }
        })();
        return true; // keep channel open for async response
    }
    if (msg.action === 'recoverStuckEventTabViaMembership') {
        (async () => {
            if (await isEventSoldOutPauseActive()) {
                console.log(
                    '[BG] recoverStuckEventTabViaMembership skipped — sold-out/no-sales pause (retry ~' +
                        formatEventSoldOutPauseEndsAt() +
                        ')'
                );
                sendResponse({
                    success: false,
                    skipped: true,
                    message: 'sold-out pause active'
                });
                return;
            }
            const result = await recoverStuckEventTabViaMembership(
                msg.reason || 'content: event tab refresh timeout / stuck'
            );
            sendResponse({ success: true, result });
        })().catch((e) => {
            console.warn('[BG] recoverStuckEventTabViaMembership error:', e?.message || e);
            sendResponse({ success: false, error: e?.message || String(e) });
        });
        return true;
    }
    if (msg.action === 'refreshEventTabAndCloseQueueTab') {
        (async () => {
            if (Date.now() < error403PauseUntil) {
                console.log('[BG] refreshEventTabAndCloseQueueTab skipped - error403 pause active.');
                sendResponse({ success: false, message: 'error403 pause active, skipped' });
                return;
            }
            if (await isEventSoldOutPauseActive()) {
                console.log(
                    '[BG] refreshEventTabAndCloseQueueTab skipped — sold-out/no-sales pause (retry ~' +
                        formatEventSoldOutPauseEndsAt() +
                        ')'
                );
                sendResponse({ success: false, message: 'sold-out pause active, skipped' });
                return;
            }
            if (!sender.tab) {
                sendResponse({ success: false, message: 'No sender tab' });
                return;
            }
            const queueTabId = sender.tab.id;
            console.log('[BG] refreshEventTabAndCloseQueueTab from queue tab', queueTabId);
            try {
                const { removed, skipped } = await safeTabsRemove(queueTabId);
                if (removed.length) console.log('[BG] Queue tab closed:', queueTabId);
                if (skipped.length) console.warn('[BG] Queue tab not closed — only tab in window:', queueTabId);
                await refreshEventTab();
                sendResponse({ success: true, message: 'Queue tab closed, event tab refreshed' });
            } catch (err) {
                console.error('[BG] refreshEventTabAndCloseQueueTab error:', err);
                sendResponse({ success: false, message: err?.message || 'Unknown error' });
            }
        })();
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
        const useCookieClearWebhook =
            payload.kind === 'seat_check_403_cookie_clear' ||
            payload.kind === 'browsing_activity_paused';
        const errorDiscordWebhook = useCookieClearWebhook ? SEAT_CHECK_COOKIE_CLEAR_DISCORD_WEBHOOK : DEFAULT_ERROR_DISCORD_WEBHOOK;

        console.log(
            '[BG] Sending error notification to',
            useCookieClearWebhook
                ? payload.kind === 'browsing_activity_paused'
                    ? 'browsing-pause webhook'
                    : 'seat-check cookie-clear webhook'
                : 'default error webhook'
        );
        sendErrorWebhook(errorDiscordWebhook, message, payload);
    }
    if (msg.action === 'log') {
        console.log('[BG-LOG]', msg.message);
    }
    if (msg.action === 'queueItForwardLog') {
        const level = msg.level === 'warn' || msg.level === 'error' ? msg.level : 'log';
        const parts = ['[QueueIt]', msg.message || ''];
        if (msg.detail) parts.push(String(msg.detail));
        if (msg.href) parts.push('(' + String(msg.href).slice(0, 120) + ')');
        const line = parts.join(' ');
        if (level === 'warn') console.warn(line);
        else if (level === 'error') console.error(line);
        else console.log(line);
        try {
            sendResponse({ ok: true });
        } catch (_) {}
        return false;
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
    /**
     * Botdeflector icon-sequence: coordinatescaptcha.
     * msg: { imageUrl|imageBase64, instructionsImageUrl|instructionsBase64, comment? }
     * Returns { success, coordinates: [{x,y}, ...] }
     */
    if (msg.action === 'twoCaptchaSolveCoordinates') {
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

                /**
                 * 2captcha coordinates accepts JPEG/PNG/GIF only — Botdeflector bg is often .webp.
                 * Pass through png/jpeg; convert webp→jpeg with retries.
                 */
                function arrayBufferToBase64(buf) {
                    const bytes = new Uint8Array(buf);
                    let binary = '';
                    const chunk = 0x8000;
                    for (let i = 0; i < bytes.length; i += chunk) {
                        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
                    }
                    return btoa(binary);
                }

                async function blobToJpegBase64(blob) {
                    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
                        return arrayBufferToBase64(await blob.arrayBuffer());
                    }
                    let lastErr = null;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            const bitmap = await createImageBitmap(blob);
                            try {
                                const w = Math.max(1, bitmap.width || 300);
                                const h = Math.max(1, bitmap.height || 200);
                                const canvas = new OffscreenCanvas(w, h);
                                const ctx = canvas.getContext('2d');
                                if (!ctx) throw new Error('OffscreenCanvas 2d unavailable');
                                ctx.fillStyle = '#ffffff';
                                ctx.fillRect(0, 0, w, h);
                                ctx.drawImage(bitmap, 0, 0, w, h);
                                const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
                                return arrayBufferToBase64(await jpegBlob.arrayBuffer());
                            } finally {
                                try {
                                    bitmap.close();
                                } catch (_) {}
                            }
                        } catch (e) {
                            lastErr = e;
                            // Transient: image often still loading — silent retry (no per-attempt spam)
                            await new Promise((r) => setTimeout(r, 200 * attempt));
                        }
                    }
                    throw lastErr || new Error('image decode failed');
                }

                async function urlOrBase64ToCaptchaBase64(url, b64) {
                    let blob = null;
                    let hint = '';
                    if (b64 && typeof b64 === 'string' && b64.length > 40) {
                        const raw = String(b64).replace(/^data:([^;]+);base64,/i, (_, mime) => {
                            hint = String(mime || '').toLowerCase();
                            return '';
                        });
                        const bin = atob(raw);
                        const bytes = new Uint8Array(bin.length);
                        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                        blob = new Blob([bytes], { type: hint || 'application/octet-stream' });
                    } else if (url && typeof url === 'string') {
                        const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
                        if (!res.ok) throw new Error('image fetch HTTP ' + res.status + ' for ' + url.slice(0, 80));
                        blob = await res.blob();
                        hint = (res.headers.get('content-type') || blob.type || '').toLowerCase();
                        if (!hint && /\.webp(\?|$)/i.test(url)) hint = 'image/webp';
                        if (!hint && /\.png(\?|$)/i.test(url)) hint = 'image/png';
                        if (!hint && /\.jpe?g(\?|$)/i.test(url)) hint = 'image/jpeg';
                    } else {
                        return '';
                    }

                    const isWebp = hint.includes('webp') || (url && /\.webp(\?|$)/i.test(String(url)));
                    const alreadyOk =
                        !isWebp &&
                        (hint.includes('png') ||
                            hint.includes('jpeg') ||
                            hint.includes('jpg') ||
                            hint.includes('gif'));

                    if (alreadyOk) {
                        return arrayBufferToBase64(await blob.arrayBuffer());
                    }
                    // webp→jpeg convert is expected; no log unless final task create fails
                    return blobToJpegBase64(blob);
                }

                function isTransientImageDecodeErr(e) {
                    const m = String((e && e.message) || e || '').toLowerCase();
                    return (
                        m.includes('could not be decoded') ||
                        m.includes('image decode') ||
                        m.includes('invalidstateerror') ||
                        m.includes('source image')
                    );
                }

                let bodyB64 = '';
                try {
                    bodyB64 = await urlOrBase64ToCaptchaBase64(msg.imageUrl, msg.imageBase64);
                } catch (e) {
                    // Often still buffering — silent refetch once
                    await new Promise((r) => setTimeout(r, 400));
                    try {
                        bodyB64 = await urlOrBase64ToCaptchaBase64(msg.imageUrl, null);
                    } catch (e2) {
                        if (isTransientImageDecodeErr(e2)) {
                            // QueueIt retries shortly; one short line max
                            console.log('[BG] 2captcha challenge image not ready yet (will retry)');
                            sendResponse({
                                success: false,
                                error: 'challenge image not ready yet',
                                retryable: true
                            });
                            return;
                        }
                        throw e2;
                    }
                }
                if (!bodyB64 || bodyB64.length < 80) {
                    sendResponse({ success: false, error: 'missing challenge image (body)' });
                    return;
                }
                let instrB64 = '';
                try {
                    instrB64 = await urlOrBase64ToCaptchaBase64(msg.instructionsImageUrl, msg.instructionsBase64);
                } catch (_) {
                    // Instruction strip optional — silent if convert fails
                }

                const inParams = new URLSearchParams();
                inParams.set('key', apiKey);
                inParams.set('method', 'base64');
                inParams.set('coordinatescaptcha', '1');
                inParams.set('body', bodyB64);
                inParams.set(
                    'textinstructions',
                    (msg.comment && String(msg.comment).trim()) ||
                        'Click the icons on the image in the exact order shown in the instruction strip'
                );
                if (instrB64 && instrB64.length > 40) {
                    inParams.set('imginstructions', instrB64);
                }
                inParams.set('json', '1');

                const inRes = await fetch('https://2captcha.com/in.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                    body: inParams.toString()
                });
                const inText = (await inRes.text()).trim();
                let taskId = '';
                try {
                    const inJson = JSON.parse(inText);
                    if (Number(inJson.status) === 1 && inJson.request != null) {
                        taskId = String(inJson.request);
                    } else {
                        sendResponse({
                            success: false,
                            error: inJson.request || inJson.error_text || inText
                        });
                        return;
                    }
                } catch (_) {
                    if (!inText.startsWith('OK|')) {
                        console.warn('[BG] 2captcha coordinates in.php:', inText);
                        sendResponse({ success: false, error: inText });
                        return;
                    }
                    taskId = inText.slice(3);
                }
                console.log('[BG] 2captcha coordinates task created:', taskId);

                function parseCoordinatesPayload(raw) {
                    const coords = [];
                    if (raw == null) return coords;
                    if (Array.isArray(raw)) {
                        for (const p of raw) {
                            if (p && p.x != null && p.y != null) {
                                coords.push({ x: Number(p.x), y: Number(p.y) });
                            }
                        }
                        return coords;
                    }
                    let s = String(raw).trim();
                    if (s.toLowerCase().startsWith('coordinate:')) s = s.slice('coordinate:'.length);
                    if (s.toLowerCase().startsWith('coordinates:')) s = s.slice('coordinates:'.length);
                    const parts = s.split(';');
                    for (const part of parts) {
                        const m = String(part).match(/x\s*=\s*([\d.]+)\s*,\s*y\s*=\s*([\d.]+)/i);
                        if (m) coords.push({ x: Number(m[1]), y: Number(m[2]) });
                    }
                    return coords.filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y));
                }

                const pollIntervalMs = 3000;
                const maxPolls = 100; // ~5 min
                for (let poll = 0; poll < maxPolls; poll++) {
                    await new Promise((r) => setTimeout(r, pollIntervalMs));
                    const resUrl =
                        'https://2captcha.com/res.php?key=' +
                        encodeURIComponent(apiKey) +
                        '&action=get&id=' +
                        encodeURIComponent(taskId) +
                        '&json=1';
                    const resRes = await fetch(resUrl);
                    const resText = (await resRes.text()).trim();
                    let coords = [];
                    try {
                        const resJson = JSON.parse(resText);
                        if (Number(resJson.status) === 0) {
                            const req = String(resJson.request || '').toUpperCase();
                            if (req === 'CAPCHA_NOT_READY' || req === 'CAPTCHA_NOT_READY') continue;
                            sendResponse({ success: false, error: resJson.request || resText });
                            return;
                        }
                        if (Number(resJson.status) === 1) {
                            coords = parseCoordinatesPayload(resJson.request);
                        }
                    } catch (_) {
                        const upper = resText.toUpperCase();
                        if (upper === 'CAPCHA_NOT_READY' || upper === 'CAPTCHA_NOT_READY') continue;
                        if (resText.startsWith('OK|')) {
                            coords = parseCoordinatesPayload(resText.slice(3));
                        } else {
                            console.warn('[BG] 2captcha coordinates res.php:', resText);
                            sendResponse({ success: false, error: resText });
                            return;
                        }
                    }
                    if (coords.length) {
                        console.log('[BG] 2captcha coordinates solved:', coords.length, 'point(s)');
                        sendResponse({ success: true, coordinates: coords });
                        return;
                    }
                    sendResponse({ success: false, error: '2captcha returned no coordinates' });
                    return;
                }
                sendResponse({
                    success: false,
                    error: '2captcha coordinates poll timeout (~' + Math.round((maxPolls * pollIntervalMs) / 60000) + ' min)'
                });
            } catch (e) {
                const msgText = e?.message || String(e);
                const soft =
                    /could not be decoded|image decode|invalidstateerror|source image/i.test(msgText);
                if (soft) {
                    console.log('[BG] 2captcha challenge image not ready yet (will retry)');
                    sendResponse({ success: false, error: 'challenge image not ready yet', retryable: true });
                } else {
                    console.warn('[BG] 2captcha coordinates failed:', msgText);
                    sendResponse({ success: false, error: msgText });
                }
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
        areaIds: cfg.areaIds != null ? String(cfg.areaIds) : '',
        areasToIgnore: cfg.areasToIgnore != null ? String(cfg.areasToIgnore) : '',
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
            const br = await evaluateUkBreakWindow(cfg.ukBreakTime);
            const sheetOn = ['on', 'start', 'true', '1'].includes((cfg.status || '').toString().trim().toLowerCase());
            if (br.active) {
                console.log(
                    '[BG] startFlow skipped — UK break window active (' +
                        (br.activeLabel || (br.range && br.range.label)) +
                        (br.range && br.range.windows && br.range.windows.length > 1
                            ? ' of ' + br.range.label
                            : '') +
                        ', now ' +
                        (br.ukNow && br.ukNow.clock) +
                        ' UK)'
                );
                lastStatus = 'off';
                await chrome.storage.local.set({
                    currentStatus: 'off',
                    ukBreakActive: true,
                    ukBreakRangeLabel: br.range ? br.range.label : '',
                    ukBreakNowLabel: br.ukNow ? br.ukNow.clock : ''
                });
                notifyTabStop();
                return;
            }
            if (!sheetOn) {
                console.log('[BG] startFlow: matching row status is Off — not opening tabs');
                lastStatus = 'off';
                await chrome.storage.local.set({ currentStatus: 'off', ukBreakActive: false });
                return;
            }
            // Save to local storage
            const seatCfg = seatModeFromPairChance(cfg.areSeatsTogether, cfg.quantity, cfg.pairCheckChance);
            await chrome.storage.local.set({
                sheetUrl: sheetUrl,
                startSecond: cfg.startSecond,
                currentStatus: 'on', // set currentStatus to 'on'
                ukBreakActive: false,
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
                areaIds: cfg.areaIds != null ? String(cfg.areaIds) : '',
                areasToIgnore: cfg.areasToIgnore != null ? String(cfg.areasToIgnore) : '',
                resaleEndpointChances: cfg.resaleEndpointChances != null ? cfg.resaleEndpointChances : DEFAULT_RESALE_ENDPOINT_CHANCES,
                focusRefreshTab: cfg.focusRefreshTab !== undefined ? cfg.focusRefreshTab : true
            });

            await openOrFocusTabs(cfg.eventUrl, EVENT_NOT_ALLOWED_URL);
        }
    }
}

async function openOrFocusTabs(eventUrl = null, EVENT_NOT_ALLOWED_URL = null, opts = {}) {
    const reloadValidationIfExists = opts.reloadValidationIfExists === true;
    if (lastStatus === 'off') {
        console.log('[BG] openOrFocusTabs skipped — Google Sheet status Off');
        return;
    }
    if (openOrFocusTabsInProgress) {
        console.log('[BG] openOrFocusTabs already running - skip duplicate call');
        return;
    }
    if (Date.now() < error403PauseUntil) {
        console.log('[BG] openOrFocusTabs skipped — error403 pause active');
        return;
    }
    if (await isEventSoldOutPauseActive()) {
        console.log(
            '[BG] openOrFocusTabs skipped — sold-out/no-sales pause (retry ~' +
                formatEventSoldOutPauseEndsAt() +
                ')'
        );
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
            if (Date.now() < error403PauseUntil || (await isQueueItActive()) || (await isEventSoldOutPauseActive())) {
                console.log('[BG] After event ensure — pause/queue/sold-out active; skip validation tab');
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
        if (await isEventSoldOutPauseActive()) {
            console.log(
                '[BG] sold-out/no-sales pause — skipping rest of openOrFocusTabs (retry ~' +
                    formatEventSoldOutPauseEndsAt() +
                    ')'
            );
            return;
        }
        if (await checkTabsAndWait()) return;
        await closeOtherEticketingTabs();

        if (EVENT_NOT_ALLOWED_URL && eventReady) {
            await openOrReloadValidationTab(EVENT_NOT_ALLOWED_URL, { reloadIfExists: reloadValidationIfExists });
        } else if (EVENT_NOT_ALLOWED_URL && !eventReady) {
            console.log('[BG] Validation tab deferred — waiting for eventPageReady on a later check');
        }

        await new Promise((resolve) => setTimeout(resolve, 10000));

        if (Date.now() < error403PauseUntil) {
            console.log('[BG] error403 pause active - skipping recheck and rest of openOrFocusTabs.');
            return;
        }
        if (await isEventSoldOutPauseActive()) {
            console.log(
                '[BG] sold-out/no-sales pause — skipping recheck openOrFocusTabs (retry ~' +
                    formatEventSoldOutPauseEndsAt() +
                    ')'
            );
            return;
        }
        if (await checkTabsAndWait()) return;
        await closeOtherEticketingTabs();

        // Recheck: only create missing validation if event is still ready (do not force-reload event again)
        if (Date.now() < error403PauseUntil) {
            console.log('[BG] error403 pause active - skipping recheck and rest of openOrFocusTabs.');
            return;
        }
        if (await isEventSoldOutPauseActive()) {
            console.log(
                '[BG] sold-out/no-sales pause — skipping final recheck openOrFocusTabs (retry ~' +
                    formatEventSoldOutPauseEndsAt() +
                    ')'
            );
            return;
        }
        console.log('[BG] Recheck tabs — validation only if eventPageReady and not in queue');
        const tabs2 = await chrome.tabs.query({ url: '*://www.eticketing.co.uk/*' });

        if (EVENT_NOT_ALLOWED_URL && (await isEventPageReady()) && !(await isQueueItActive())) {
            await openOrReloadValidationTab(EVENT_NOT_ALLOWED_URL, { reloadIfExists: reloadValidationIfExists });
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
    const candidates = [tab.url || '', tab.pendingUrl || ''].filter(Boolean);
    for (const u of candidates) {
        // Never treat sold-out / restricted / archived validation as the event Index page
        if (
            tabUrlIsEventSoldOutOrNoSales(u) ||
            tabUrlIsEventRestricted(u) ||
            tabUrlIsValidationArchivedTab(u) ||
            String(u).toLowerCase().includes('/edp/validation/eventnotallowed')
        ) {
            return false;
        }
    }
    const base = eventUrl.split('?')[0];
    for (const u of candidates) {
        if (u.startsWith(base)) return true;
    }
    const eid = eventIdFromEticketEventUrl(eventUrl);
    if (eid) {
        // Only real Event/Index paths — not EventNotAllowed?eventId=
        const re = new RegExp(`/Event/Index/${eid}(?:[^0-9]|$)`, 'i');
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

/**
 * True while EventNoAvailableSalesModesOrSoldOut sleep is active (memory + storage).
 * During this pause: skip event/validation create/reload and heartbeat tab recovery.
 */
async function isEventSoldOutPauseActive() {
    // Hold checkers while a single resume open is in progress
    if (eventSoldOutRetryRunning) return true;
    const now = Date.now();
    if (now < eventSoldOutPauseUntil) return true;
    try {
        const st = await chrome.storage.local.get(EVENT_SOLD_OUT_PAUSE_UNTIL_KEY);
        const until = Number(st[EVENT_SOLD_OUT_PAUSE_UNTIL_KEY]) || 0;
        if (until > now) {
            eventSoldOutPauseUntil = until;
            return true;
        }
    } catch (_) {}
    if (eventSoldOutPauseUntil > 0 && now >= eventSoldOutPauseUntil) {
        eventSoldOutPauseUntil = 0;
    }
    return false;
}

function formatEventSoldOutPauseEndsAt() {
    const until = eventSoldOutPauseUntil || 0;
    return until > 0 ? new Date(until).toLocaleTimeString() : '?';
}

async function shouldSkipEventTabOperations() {
    if (Date.now() < error403PauseUntil) {
        console.log('[BG] Event tab op skipped — error403 pause (memory)');
        return true;
    }
    if (await isEventSoldOutPauseActive()) {
        console.log(
            '[BG] Event tab op skipped — sold-out/no-sales pause (retry ~' +
                formatEventSoldOutPauseEndsAt() +
                ')'
        );
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
                    // Always navigate to eventUrl — never reload (reload would keep sold-out / wrong URL)
                    await chrome.tabs.update(wwwTab.id, { url, active: wantFocus });
                    console.log('[BG] ensureEventTab: navigated existing event tab', wwwTab.id, '→ eventUrl');
                } catch (e) {
                    console.warn('[BG] ensureEventTab navigate failed', e);
                }
            } else {
                console.log('[BG] ensureEventTab: using existing www event tab', wwwTab.id);
            }
            if (wantFocus) await focusTabWindow(wwwTab.id);
            else console.log('[BG] ensureEventTab: skipping focus (Focus Refresh tab? = No)');
            return { success: true, action: forceReload ? 'navigated' : 'found-www', tabId: wwwTab.id };
        }

        // Sold-out / EventNotAllowed tab for this club: do not reload it — navigate to eventUrl
        const soldOutTab = allTabs.find((t) => {
            const u = t.url || '';
            const p = t.pendingUrl || '';
            return tabUrlIsEventSoldOutOrNoSales(u) || tabUrlIsEventSoldOutOrNoSales(p);
        });
        if (soldOutTab && (await isEventSoldOutPauseActive())) {
            console.log(
                '[BG] ensureEventTab: skipped — sold-out/no-sales pause (retry ~' +
                    formatEventSoldOutPauseEndsAt() +
                    '); will reopen eventUrl when pause ends'
            );
            return { success: false, skipped: true, message: 'sold-out pause' };
        }
        if (soldOutTab && forceReload) {
            try {
                await chrome.tabs.update(soldOutTab.id, { url, active: wantFocus });
                eventTabId = soldOutTab.id;
                if (wantFocus) await focusTabWindow(soldOutTab.id);
                console.log('[BG] ensureEventTab: sold-out tab navigated to eventUrl', soldOutTab.id);
                return { success: true, action: 'sold-out-navigated', tabId: soldOutTab.id };
            } catch (e) {
                console.warn('[BG] ensureEventTab sold-out navigate failed', e);
            }
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

        // Arsenal only: membership/red → eventUrl. Other clubs: open eventUrl directly.
        if (eventUrlIsArsenalClub(url)) {
            // Prefer reuse of an existing membership / event / web-identity tab — never open a 2nd flow tab.
            const latest = await chrome.tabs.query({});
            const reusable = findReusableArsenalFlowTab(latest, eventTabId);
            if (reusable && (tabUrlIsArsenalMembershipRed(reusable.url) || tabUrlIsArsenalMembershipRed(reusable.pendingUrl))) {
                eventTabId = reusable.id;
                if (wantFocus) await focusTabWindow(reusable.id);
                console.log('[BG] ensureEventTab: Arsenal — already on Red membership tab', reusable.id);
                return { success: true, action: 'membership-red-existing', tabId: reusable.id };
            }
            if (reusable && (tabUrlIsArsenalMembershipsList(reusable.url) || tabUrlIsArsenalMembershipsList(reusable.pendingUrl))) {
                eventTabId = reusable.id;
                if (wantFocus) await focusTabWindow(reusable.id);
                console.log('[BG] ensureEventTab: Arsenal — Memberships/List already open', reusable.id);
                return { success: true, action: 'memberships-list-existing', tabId: reusable.id };
            }
            console.log('[BG] ensureEventTab: Arsenal — opening via Red membership (not direct eventUrl)');
            let reuseId = reusable && reusable.id != null ? reusable.id : eventTabId;
            if (reuseId != null) {
                const cand =
                    (reusable && reusable.id === reuseId && reusable) ||
                    latest.find((t) => t.id === reuseId) ||
                    null;
                if (reuseId === notAllowedTabId || (cand && tabIsValidationMonitorTab(cand))) {
                    console.log('[BG] ensureEventTab: not reusing validation tab', reuseId);
                    reuseId = null;
                }
            }
            const via = await openEventUrlViaArsenalMembershipRed({
                focus: wantFocus,
                reuseTabId: reuseId
            });
            return {
                success: true,
                action: via.action || 'opened-via-membership',
                tabId: via.tabId
            };
        }
        console.log('[BG] ensureEventTab: non-Arsenal — opening eventUrl directly');
        const direct = await openEventEntryForClub({ focus: wantFocus, eventUrl: url });
        return {
            success: !!direct.success,
            action: direct.action || 'opened-event-url',
            tabId: direct.tabId,
            message: direct.message
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

let eventSoldOutRetryScheduling = false;

function randomEventSoldOutRetryDelayMs() {
    const span = EVENT_SOLD_OUT_RETRY_MAX_MS - EVENT_SOLD_OUT_RETRY_MIN_MS;
    return EVENT_SOLD_OUT_RETRY_MIN_MS + Math.floor(Math.random() * (span + 1));
}

/**
 * After sold-out resume: keep one event tab; close extra eventUrl / sold-out EventNotAllowed tabs.
 */
async function pruneDuplicateTabsAfterSoldOutRetry(eventUrl, keepTabId) {
    const url = (eventUrl || '').trim();
    if (!url) return;
    const base = url.split('?')[0];
    const club = String(clubNameFromEventUrl(url) || '').toLowerCase();
    try {
        const tabs = await chrome.tabs.query({});
        const toClose = [];
        for (const t of tabs || []) {
            if (t.id == null || (keepTabId != null && t.id === keepTabId)) continue;
            if (t.id === notAllowedTabId) continue; // leave archived validation monitor alone
            const u = t.url || '';
            const p = t.pendingUrl || '';
            const hit =
                (u && (u.startsWith(base) || (base && u.indexOf(base) === 0))) ||
                (p && (p.startsWith(base) || (base && p.indexOf(base) === 0))) ||
                tabUrlIsEventSoldOutOrNoSales(u) ||
                tabUrlIsEventSoldOutOrNoSales(p);
            if (!hit) continue;
            // Same club sold-out / event pages only
            if (club) {
                const hostPath = (u || p || '').toLowerCase();
                if (hostPath.includes('eticketing.co.uk') && !hostPath.includes('/' + club + '/')) {
                    continue;
                }
            }
            toClose.push(t.id);
        }
        if (!toClose.length) return;
        const { removed, skipped } = await safeTabsRemove(toClose);
        if (removed.length) {
            console.log(
                '[BG] Event sold-out retry — closed duplicate tab(s):',
                removed.join(',')
            );
        }
        if (skipped.length) {
            console.warn(
                '[BG] Event sold-out retry — could not close some duplicate tabs:',
                skipped.join(',')
            );
        }
    } catch (e) {
        console.warn('[BG] pruneDuplicateTabsAfterSoldOutRetry error:', e?.message || e);
    }
}

/**
 * Event URL landed on EventNoAvailableSalesModesOrSoldOut — do NOT stop permanently.
 * Pause 3–11 minutes (random), then reopen eventUrl (reuse that tab when possible via openEventEntryForClub).
 */
async function scheduleEventSoldOutRetry(tabId, source) {
    if (tabId != null) cancelCloseEventTabAfterTokenSave(tabId);
    if (eventSoldOutRetryScheduling || eventSoldOutRetryRunning) return;
    eventSoldOutRetryScheduling = true;
    try {
        const st = await chrome.storage.local.get([EVENT_SOLD_OUT_PAUSE_UNTIL_KEY]);
        const existingUntil = Number(st[EVENT_SOLD_OUT_PAUSE_UNTIL_KEY]) || 0;
        if (existingUntil > Date.now() + 5000) {
            if (tabId != null) {
                await chrome.storage.local.set({ [EVENT_SOLD_OUT_TAB_ID_KEY]: tabId });
            }
            eventSoldOutPauseUntil = existingUntil;
            // Dedupe: onUpdated + content-script both fire; log once per pause window
            if (eventSoldOutAlreadyPausedLoggedUntil !== existingUntil) {
                eventSoldOutAlreadyPausedLoggedUntil = existingUntil;
                const remainMs = Math.max(0, existingUntil - Date.now());
                console.log(
                    '[BG] Event sold-out/no-sales already sleeping',
                    (remainMs / 60000).toFixed(1) +
                        ' min more — retry ~' +
                        new Date(existingUntil).toLocaleTimeString() +
                        ' (event/validation reload frozen)',
                    tabId != null ? '(tab ' + tabId + ')' : ''
                );
            }
            return;
        }
        const delayMs = randomEventSoldOutRetryDelayMs();
        const pauseUntil = Date.now() + delayMs;
        eventSoldOutPauseUntil = pauseUntil;
        eventSoldOutAlreadyPausedLoggedUntil = pauseUntil;
        await chrome.storage.local.set({
            [EVENT_SOLD_OUT_PAUSE_UNTIL_KEY]: pauseUntil,
            [EVENT_SOLD_OUT_TAB_ID_KEY]: tabId != null ? tabId : null
        });
        await chrome.alarms.clear(EVENT_SOLD_OUT_RETRY_ALARM);
        chrome.alarms.create(EVENT_SOLD_OUT_RETRY_ALARM, { when: pauseUntil });
        console.log(
            '[BG] Event sold-out/no-sales (EventNoAvailableSalesModesOrSoldOut) — sleeping',
            (delayMs / 60000).toFixed(1) +
                ' min (random 3–11) — retry ~' +
                new Date(pauseUntil).toLocaleTimeString() +
                ' (event/validation reload frozen until then)',
            tabId != null ? '(tab ' + tabId + ')' : ''
        );
    } finally {
        eventSoldOutRetryScheduling = false;
    }
}

async function runEventSoldOutRetryFromAlarm() {
    if (eventSoldOutRetryRunning) {
        console.log('[BG] Event sold-out retry already running — skip duplicate alarm/checker');
        return;
    }
    eventSoldOutRetryRunning = true;
    try {
        // Drop any duplicate alarms immediately
        try {
            await chrome.alarms.clear(EVENT_SOLD_OUT_RETRY_ALARM);
        } catch (_) {}

        if (await accountRestrictedBlackoutStopActive()) {
            eventSoldOutPauseUntil = 0;
            eventSoldOutAlreadyPausedLoggedUntil = 0;
            await chrome.storage.local.set({
                [EVENT_SOLD_OUT_PAUSE_UNTIL_KEY]: 0,
                [EVENT_SOLD_OUT_TAB_ID_KEY]: null
            });
            console.log('[BG] Event sold-out retry skipped — account restricted blackout');
            return;
        }
        if (await eventRestrictedStopActive()) {
            eventSoldOutPauseUntil = 0;
            eventSoldOutAlreadyPausedLoggedUntil = 0;
            await chrome.storage.local.set({
                [EVENT_SOLD_OUT_PAUSE_UNTIL_KEY]: 0,
                [EVENT_SOLD_OUT_TAB_ID_KEY]: null
            });
            console.log('[BG] Event sold-out retry skipped — event restricted stop');
            return;
        }
        if (lastStatus === 'off') {
            eventSoldOutPauseUntil = 0;
            eventSoldOutAlreadyPausedLoggedUntil = 0;
            await chrome.storage.local.set({
                [EVENT_SOLD_OUT_PAUSE_UNTIL_KEY]: 0,
                [EVENT_SOLD_OUT_TAB_ID_KEY]: null
            });
            console.log('[BG] Event sold-out retry skipped — Google Sheet status Off');
            return;
        }
        if (await isQueueItActive()) {
            const deferUntil = Date.now() + 60 * 1000;
            eventSoldOutPauseUntil = deferUntil;
            eventSoldOutAlreadyPausedLoggedUntil = deferUntil;
            console.log('[BG] Event sold-out retry deferred — Queue-IT active; retry in 60s');
            chrome.alarms.create(EVENT_SOLD_OUT_RETRY_ALARM, { when: deferUntil });
            await chrome.storage.local.set({ [EVENT_SOLD_OUT_PAUSE_UNTIL_KEY]: deferUntil });
            return;
        }

        const st = await chrome.storage.local.get(['eventUrl', EVENT_SOLD_OUT_TAB_ID_KEY]);
        const eventUrl = (st.eventUrl || EVENT_URL || '').trim();
        let reuseTabId = st[EVENT_SOLD_OUT_TAB_ID_KEY] != null ? Number(st[EVENT_SOLD_OUT_TAB_ID_KEY]) : null;
        if (!Number.isFinite(reuseTabId)) reuseTabId = null;
        if (reuseTabId != null) {
            try {
                const t = await chrome.tabs.get(reuseTabId);
                const u = (t && (t.url || t.pendingUrl)) || '';
                if (tabUrlIsValidationArchivedTab(u) || tabUrlIsEventRestricted(u) || reuseTabId === notAllowedTabId) {
                    reuseTabId = null;
                }
            } catch (_) {
                reuseTabId = null;
            }
        }

        // Keep pause active while opening so heartbeat / openOrFocusTabs / validation cannot race a 2nd open
        console.log(
            '[BG] Event sold-out retry — reopening eventUrl (single open)',
            eventUrl || '(none)',
            reuseTabId != null ? 'via tab ' + reuseTabId : '(new/reuse flow)'
        );
        await resetEventPageReadyFlag('event sold-out retry');
        const openResult = await runExclusiveEventTabOp(async () => {
            return openEventEntryForClub({
                focus: true,
                reuseTabId,
                eventUrl: eventUrl || undefined
            });
        });
        const keepTabId =
            (openResult && openResult.tabId != null ? openResult.tabId : null) ||
            reuseTabId ||
            eventTabId;

        await pruneDuplicateTabsAfterSoldOutRetry(eventUrl, keepTabId);

        // Keep sold-out pause until event Index has a verification token (eventPageReady).
        // Seat checks must not resume on open alone — that caused 401/403 spam.
        console.log(
            '[BG] Event sold-out retry — waiting for eventPageReady before clearing pause / seat checks',
            keepTabId != null ? '(tab ' + keepTabId + ')' : ''
        );
        const ready = await waitForEventPageReady({
            allowWhileSoldOutPause: true,
            timeoutMs: EVENT_PAGE_READY_WAIT_MS
        });

        if (await isQueueItActive()) {
            const deferUntil = Date.now() + 60 * 1000;
            eventSoldOutPauseUntil = deferUntil;
            eventSoldOutAlreadyPausedLoggedUntil = deferUntil;
            console.log('[BG] Event sold-out retry deferred — Queue-IT during eventPageReady wait; retry in 60s');
            chrome.alarms.create(EVENT_SOLD_OUT_RETRY_ALARM, { when: deferUntil });
            await chrome.storage.local.set({
                [EVENT_SOLD_OUT_PAUSE_UNTIL_KEY]: deferUntil,
                [EVENT_SOLD_OUT_TAB_ID_KEY]: keepTabId
            });
            return;
        }

        if (!ready) {
            // Still sold out / restricted / no token — sleep again instead of starting seat APIs
            const delayMs = randomEventSoldOutRetryDelayMs();
            const pauseUntil = Date.now() + delayMs;
            eventSoldOutPauseUntil = pauseUntil;
            eventSoldOutAlreadyPausedLoggedUntil = pauseUntil;
            await chrome.alarms.clear(EVENT_SOLD_OUT_RETRY_ALARM);
            chrome.alarms.create(EVENT_SOLD_OUT_RETRY_ALARM, { when: pauseUntil });
            await chrome.storage.local.set({
                [EVENT_SOLD_OUT_PAUSE_UNTIL_KEY]: pauseUntil,
                [EVENT_SOLD_OUT_TAB_ID_KEY]: keepTabId
            });
            console.log(
                '[BG] Event sold-out retry — eventPageReady not set; sleeping again',
                (delayMs / 60000).toFixed(1) +
                    ' min — retry ~' +
                    new Date(pauseUntil).toLocaleTimeString()
            );
            return;
        }

        // Clear pause only after event tab loaded + flag set
        eventSoldOutPauseUntil = 0;
        eventSoldOutAlreadyPausedLoggedUntil = 0;
        await chrome.storage.local.set({
            [EVENT_SOLD_OUT_PAUSE_UNTIL_KEY]: 0,
            [EVENT_SOLD_OUT_TAB_ID_KEY]: null
        });
        console.log(
            '[BG] Event sold-out retry complete — eventPageReady set; pause cleared; kept tab',
            keepTabId != null ? keepTabId : '(none)'
        );
        await notifyValidationTabSoldOutResume();
    } catch (e) {
        console.warn('[BG] Event sold-out retry error:', e?.message || e);
        // On failure, clear pause so we are not stuck forever; next sold-out hit can reschedule
        eventSoldOutPauseUntil = 0;
        eventSoldOutAlreadyPausedLoggedUntil = 0;
        try {
            await chrome.storage.local.set({
                [EVENT_SOLD_OUT_PAUSE_UNTIL_KEY]: 0,
                [EVENT_SOLD_OUT_TAB_ID_KEY]: null
            });
        } catch (_) {}
        // Do not notify soldOutResume on error — seat checks wait for eventPageReady via CS gate
    } finally {
        eventSoldOutRetryRunning = false;
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
        if (tabUrlIsEventSoldOutOrNoSales(url) || tabUrlIsEventSoldOutOrNoSales(pen)) {
            continue; // keep sold-out tab open until retry navigates it back to eventUrl
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

/** Notify validation tabs that sold-out/no-sales pause ended so seat checks resume (no more 401/403 spam during sleep). */
async function notifyValidationTabSoldOutResume() {
    const tabs = await chrome.tabs.query({ url: '*://www.eticketing.co.uk/*' });
    const validationTabs = tabs.filter(t => t.url && t.url.includes('EDP/Validation/EventNotAllowed'));
    for (const tab of validationTabs) {
        chrome.tabs.sendMessage(tab.id, { action: 'soldOutResume' }).catch(() => {});
    }
    if (validationTabs.length) console.log('[BG] Sent soldOutResume to', validationTabs.length, 'validation tab(s)');
}

/** Tell validation tab(s) to start/resume seat checks (e.g. after Google Sheet status turns back on). */
async function notifyValidationTabStartMonitoring() {
    const { sheetUrl, startSecond } = await chrome.storage.local.get(['sheetUrl', 'startSecond']);
    await chrome.storage.local.set({ currentStatus: 'on' });
    const payload = { action: 'startMonitoring', sheetUrl, startSecond };
    const tabs = await chrome.tabs.query({ url: '*://www.eticketing.co.uk/*' });
    const validationTabs = tabs.filter(t => t.url && t.url.includes('EDP/Validation/EventNotAllowed'));
    const sent = new Set();
    for (const tab of validationTabs) {
        if (tab.id != null) sent.add(tab.id);
        chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
    }
    if (notAllowedTabId && !sent.has(notAllowedTabId)) {
        chrome.tabs.sendMessage(notAllowedTabId, payload).catch(() => {});
    }
    if (validationTabs.length || notAllowedTabId) {
        console.log('[BG] Sent startMonitoring to validation tab(s) (sheet on / resume)');
    }
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
            error403Count: 0,
            [HD_QUEUE_ERROR403_RECOVERY_STEP_KEY]: 0,
            [HD_QUEUE_ERROR403_RECOVERY_CYCLE_INDEX_KEY]: 0,
            [HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]: 0
        });
        resetHdQueueReloadCounters('event page loaded successfully (verification token ready)');
        console.log(
            '[BG] error403Count + hdQueue recovery step/cycle + captcha count reset to 0 (event tab verification token ready)'
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
    if (await isEventSoldOutPauseActive()) {
        console.log(
            '[BG] checkValidationTab: skip — sold-out/no-sales pause (retry ~' +
                formatEventSoldOutPauseEndsAt() +
                ')'
        );
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
    if (await isEventSoldOutPauseActive()) {
        console.log(
            '[BG] refreshEventTab skipped — sold-out/no-sales pause (retry ~' +
                formatEventSoldOutPauseEndsAt() +
                ')'
        );
        return { success: false, skipped: true, message: 'sold-out pause' };
    }
    if (await isQueueItActive()) {
        console.log('[BG] refreshEventTab skipped — Queue-IT active');
        return { success: false, skipped: true, message: 'Queue-IT active' };
    }
    if (await isBrowsingPauseSystemHoldActive()) {
        // Do not reconcile-away an in-flight pause wait / pending clear / membership reopen —
        // that previously self-healed and opened a second Arsenal membership tab.
        if (browsingPauseMemoryHoldActive()) {
            console.log('[BG] refreshEventTab skipped — browsing pause recovery/cooldown active');
            return { success: false, skipped: true, message: 'browsing pause recovery/cooldown' };
        }
        await reconcileStaleBrowsingPauseHold('refreshEventTab pre-check');
        if (await isBrowsingPauseSystemHoldActive()) {
            console.log('[BG] refreshEventTab skipped — browsing pause recovery/cooldown active');
            return { success: false, skipped: true, message: 'browsing pause recovery/cooldown' };
        }
        console.log('[BG] refreshEventTab: stale browsing-pause hold cleared — proceeding');
    }
    const { eventUrl } = await chrome.storage.local.get('eventUrl');
    const u = (EVENT_URL || eventUrl || '').trim();
    // Navigate to eventUrl (never bare reload of current tab — sold-out pages must not be reloaded)
    return ensureEventTabFromBackground(u || eventUrl, { forceReload: true });
}

/**
 * Event tab refresh never confirmed (internet hang / blank tab / token never set).
 * Close stuck event + web-identity tabs, then reopen via Arsenal membership (or direct event for other clubs).
 */
async function recoverStuckEventTabViaMembership(reason) {
    const why = reason || 'event tab refresh timeout / stuck';
    if (await isEventSoldOutPauseActive()) {
        console.warn(
            '[BG] recoverStuckEventTabViaMembership skipped — sold-out/no-sales pause (retry ~' +
                formatEventSoldOutPauseEndsAt() +
                '):',
            why
        );
        return { success: false, skipped: true, message: 'sold-out pause active' };
    }
    // Pause recovery already reopens via membership — do not open a second tab.
    if (browsingPauseMemoryHoldActive() || (await isBrowsingPauseSystemHoldActive())) {
        console.warn(
            '[BG] recoverStuckEventTabViaMembership skipped — browsing-pause recovery/cooldown owns reopen:',
            why
        );
        return { success: false, skipped: true, message: 'browsing pause recovery active' };
    }
    console.warn('[BG] recoverStuckEventTabViaMembership:', why);
    webIdentityBrowsingPauseCycles = 0;
    await resetEventPageReadyFlag(why);
    const primaryId = eventTabId;
    const { closed, skipped } = await closeStaleEventTabsBeforeMembershipReopen(primaryId);
    let reuseTabId = null;
    if (skipped && skipped.length) {
        reuseTabId = skipped.includes(primaryId) ? primaryId : skipped[0];
    }
    if (reuseTabId == null && primaryId != null) {
        try {
            await chrome.tabs.get(primaryId);
            reuseTabId = primaryId;
        } catch (_) {}
    }
    const opened = await openEventEntryForClub({ focus: true, reuseTabId });
    console.log(
        '[BG] Stuck event recovery: closed',
        (closed && closed.length) || 0,
        'tab(s); membership/event entry:',
        opened && opened.action
    );
    return { success: true, closed, opened };
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
            // Headers may be "areaIds to monitor SL+LL only", "areas to ignore Club level", etc.
            areaIds: (() => {
                const pick = (tokens) => {
                    const need = tokens.map((t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, ''));
                    for (const k of Object.keys(map)) {
                        const norm = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (need.every((t) => norm.includes(t))) {
                            const v = map[k];
                            if (v != null && String(v).trim() !== '') return String(v).trim();
                        }
                    }
                    return '';
                };
                return (
                    pick(['area', 'monitor']) ||
                    map['areaidstomonitor'] ||
                    map['areastomonitor'] ||
                    map['areaids'] ||
                    map['areaid'] ||
                    ''
                );
            })(),
            areasToIgnore: (() => {
                const pick = (tokens) => {
                    const need = tokens.map((t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, ''));
                    for (const k of Object.keys(map)) {
                        const norm = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (need.every((t) => norm.includes(t))) {
                            const v = map[k];
                            if (v != null && String(v).trim() !== '') return String(v).trim();
                        }
                    }
                    return '';
                };
                return (
                    pick(['area', 'ignore']) ||
                    map['areastoignore'] ||
                    map['areaidstoignore'] ||
                    map['ignoreareas'] ||
                    map['ignoreareaids'] ||
                    ''
                );
            })(),
            resaleEndpointChances: (() => {
                const raw = map['resaleendpointchances'];
                if (raw === '' || raw == null) return null;
                const v = parseFloat(String(raw).replace(/%/g, '').trim());
                if (!Number.isFinite(v)) return null;
                return Math.min(100, Math.max(0, v));
            })(),
            pairCheckChance: parsePairCheckChanceFromSheetMap(map),
            focusRefreshTab: focusRefreshTabFromSheetMap(map),
            ukBreakTime: ukBreakTimeRawFromSheetMap(map)
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

    if (await isEventSoldOutPauseActive()) {
        // Freeze countdown — sold-out tab has no seat heartbeat; do not reload event/validation
        lastHeartbeat = now;
        if (now % 30000 < HEARTBEAT_CHECK_INTERVAL) {
            console.log(
                '[BG] ⏸️ Heartbeat health check frozen — sold-out/no-sales pause (retry ~' +
                    formatEventSoldOutPauseEndsAt() +
                    ')'
            );
        }
        return;
    }

    if (await isBrowsingPauseSystemHoldActive()) {
        // Keep countdown frozen while browsing-pause recovery / cooldown runs
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
        
            await openOrFocusTabs(EVENT_URL, EVENT_NOT_ALLOWED_URL, { reloadValidationIfExists: true });
        console.log("[BG] ✅ Tabs reloaded, heartbeat tracking reset to initial 3-minute cycle");
    } else {
        if (timeSinceLast % 30000 < HEARTBEAT_CHECK_INTERVAL) {
            console.log(`[BG] ✅ Heartbeat OK (${Math.round(timeSinceLast / 1000)}s ago, ${timeoutType} timeout: ${timeoutMinutes}min)`);
        }
    }
}, HEARTBEAT_CHECK_INTERVAL);


/**
 * Applies to www.eticketing.co.uk and web-identity.tmtickets.co.uk (same path).
 * Quiet recovery (avoid IP/fingerprint spam):
 * 1) wait 3 min → reload 1/1 → 20s grace → if still paused → wait 20s more
 * 2) first recovery: eticketing cookie/site-data clear only → wait 10s → Arsenal membership
 * 3) if pause returns → long escalating cooldown only (30 / 60 / 120 / max 240 min) — idle, no clears
 * 4) cooldown ends → if still paused: eticketing clear after 30m; FULL browser clear after 1h/2h/4h
 *    if not paused: soft membership only → restart from step 1
 * Cooldown streak resets when event Index loads with verification token (or extension/browser start).
 * While recovery/cooldown/grace is active, heartbeat + openOrFocusTabs + event refresh stay frozen.
 */
const browsingPauseStateByTab = new Map();
/** Initial wait before first soft reload. */
const BROWSING_PAUSE_WAIT_MS = 3 * 60 * 1000;
/** After this many reloads, next still-paused detect → clear (1 = after first reload). */
const BROWSING_PAUSE_RELOADS_BEFORE_SITE_DATA_CLEAR = 1;
/** After reload 1/1, wait this long then check; if still paused → clear + membership. */
const BROWSING_PAUSE_POST_RELOADS_BEFORE_CLEAR_MS = 20 * 1000;
/** After clear completes — wait then open Arsenal membership. */
const BROWSING_PAUSE_AFTER_CLEAR_RELOAD_MS = 10 * 1000;
/** After reload or membership open — wait before treating pause as still present / pause-again. */
const BROWSING_PAUSE_POST_ACTION_GRACE_MS = 20 * 1000;
/** Escalating cooldown minutes: 30m → 1h → 2h → 4h cap. */
const BROWSING_PAUSE_COOLDOWN_MINUTES_LADDER = [30, 60, 120, 240];
const BROWSING_PAUSE_COOLDOWN_MAX_MS =
    BROWSING_PAUSE_COOLDOWN_MINUTES_LADDER[BROWSING_PAUSE_COOLDOWN_MINUTES_LADDER.length - 1] *
    60 *
    1000;
/** After cooldowns of this length or longer, use full browser clear if still paused (1h+). */
const BROWSING_PAUSE_FULL_CLEAR_AFTER_COOLDOWN_MS = 60 * 60 * 1000;
/** Discord: at most one browsing-pause notify every 10 minutes (avoids spam). */
const BROWSING_PAUSE_DISCORD_COOLDOWN_MS = 10 * 60 * 1000;
const BROWSING_PAUSE_DISCORD_LAST_SENT_KEY = 'browsingPauseDiscordLastSentAt';

/** streak 1→30min, 2→60, 3→120, 4+→240 (cap). */
function browsingPauseCooldownMsForStreak(streak) {
    const ladder = BROWSING_PAUSE_COOLDOWN_MINUTES_LADDER;
    const idx = Math.min(Math.max(1, Number(streak) || 1), ladder.length) - 1;
    return ladder[idx] * 60 * 1000;
}

function browsingPauseCooldownMinutesLabel(ms) {
    const mins = Math.round((Number(ms) || 0) / 60000);
    if (mins >= 60 && mins % 60 === 0) return mins / 60 + 'h';
    if (mins >= 60) return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
    return mins + ' min';
}

function browsingPauseGraceSecondsLabel(ms) {
    return Math.round((Number(ms) || BROWSING_PAUSE_POST_ACTION_GRACE_MS) / 1000) + 's';
}

async function peekNextBrowsingPauseCooldownMs() {
    const snap = await chrome.storage.local.get(BROWSING_PAUSE_COOLDOWN_STREAK_KEY);
    const nextStreak = (Number(snap[BROWSING_PAUSE_COOLDOWN_STREAK_KEY]) || 0) + 1;
    return browsingPauseCooldownMsForStreak(nextStreak);
}

async function resetBrowsingPauseCooldownStreak(reason) {
    await chrome.storage.local.set({
        [BROWSING_PAUSE_COOLDOWN_STREAK_KEY]: 0,
        [BROWSING_PAUSE_COOLDOWN_ACTIVE_MS_KEY]: 0
    });
    console.log(
        '[BG] Browsing-pause cooldown streak reset (next cooldown back to 30 min):',
        reason || ''
    );
}

/** e.g. "20:31:09" — matches sheet-poll schedule style */
function formatBrowsingPauseClock(ms) {
    return new Date(ms).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/** "waiting 180s (until 20:31:09) → reload 1/1" */
function browsingPauseScheduleSuffix(waitMs, nextAction) {
    const until = formatBrowsingPauseClock(Date.now() + waitMs);
    const secs = Math.round(waitMs / 1000);
    const waitLabel = secs >= 60 ? browsingPauseCooldownMinutesLabel(waitMs) : secs + 's';
    return `waiting ${waitLabel} (until ${until}) → ${nextAction}`;
}

function tabTitleIsBrowsingPaused(title) {
    return !!(title && String(title).toLowerCase().includes('your browsing activity'));
}

function tabUrlIsEventIndex(url) {
    return ((url || '') + '').toLowerCase().includes('/edp/event/index/');
}

function tabUrlIsWebIdentity(url) {
    return ((url || '') + '').toLowerCase().includes('web-identity.tmtickets.co.uk');
}

function tabUrlIsWebIdentityAuthorize(url) {
    const u = ((url || '') + '').toLowerCase();
    return u.includes('web-identity.tmtickets.co.uk') && u.includes('/connect/authorize');
}

/** Tabs that can show browsing-pause (eticketing + TM web-identity). */
function queryBrowsingPauseWatchTabs(callback) {
    chrome.tabs.query(
        {
            url: ['*://www.eticketing.co.uk/*', '*://web-identity.tmtickets.co.uk/*']
        },
        (tabs) => {
            if (typeof callback === 'function') callback(tabs || []);
        }
    );
}

async function queryBrowsingPauseWatchTabsAsync() {
    try {
        return await chrome.tabs.query({
            url: ['*://www.eticketing.co.uk/*', '*://web-identity.tmtickets.co.uk/*']
        });
    } catch (_) {
        return [];
    }
}

/**
 * Event Index without verification token is not a successful recovery.
 * Used so pause hold / reload streak are not cleared on URL/title alone.
 */
async function eventIndexLoadedWithoutToken(tabs) {
    const list = tabs || [];
    const hasEventIndex = list.some((t) => tabUrlIsEventIndex(t.url) || tabUrlIsEventIndex(t.pendingUrl));
    if (!hasEventIndex) return false;
    return !(await isEventPageReady());
}

/** True while wait / grace / pending / cooldown / mid-reload streak is active — do not wipe state. */
function browsingPauseMemoryHoldActive() {
    if (browsingPauseFrozenBySheetOff) {
        for (const s of browsingPauseStateByTab.values()) {
            if (!s) continue;
            if (
                s.waiting ||
                s.cookiesClearedPendingCheck ||
                s.postClearReloadPending ||
                s.reloadCount > 0 ||
                s.waitUntil > 0 ||
                s.postClearMembershipUntil > 0 ||
                s.deferredAction
            ) {
                return true;
            }
        }
    }
    for (const s of browsingPauseStateByTab.values()) {
        if (!s) continue;
        if (s.waiting || s.cookiesClearedPendingCheck || s.postClearReloadPending) return true;
        if (s.cooldownUntil > Date.now()) return true;
        if (s.postActionGraceUntil > Date.now()) return true;
        if (s.waitUntil > 0) return true;
        if (s.postClearMembershipUntil > 0) return true;
        if (s.deferredAction) return true;
        if (s.reloadCount > 0) return true;
        if (s.timerId != null || s.postActionGraceTimerId != null) return true;
    }
    return false;
}

/**
 * When the tab that triggered browsing-pause recovery is closed (or leaves eticketing),
 * drop its recovery state and clear system hold unless another tab still shows the pause.
 *
 * Exception: after clear we intentionally navigate the same tab to Arsenal
 * membership (off the eticketing watch list). Keep cookiesClearedPendingCheck so the
 * next pause starts the long cooldown (30m→1h→2h→4h) instead of another clear.
 */
async function releaseBrowsingPauseBecauseTabGone(tabId, reason) {
    if (tabId == null) return;
    const hadMemoryState = browsingPauseStateByTab.has(tabId);
    const mem = browsingPauseStateByTab.get(tabId);
    let snap = {};
    try {
        snap = await chrome.storage.local.get([
            BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY,
            BROWSING_PAUSE_COOLDOWN_TAB_KEY,
            BROWSING_PAUSE_COOLDOWN_UNTIL_KEY,
            HD_QUEUE_MEMBERSHIP_RECOVERY_ACTIVE_KEY
        ]);
    } catch (_) {}
    const wasPending = browsingPausePendingTabIdMatches(
        snap[BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY],
        tabId
    );
    const wasCooldownTab = browsingPausePendingTabIdMatches(
        snap[BROWSING_PAUSE_COOLDOWN_TAB_KEY],
        tabId
    );
    const cooldownLive = Number(snap[BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]) > Date.now();
    const pendingKeep =
        wasPending ||
        !!(mem && mem.cookiesClearedPendingCheck) ||
        (wasCooldownTab && cooldownLive);

    // Tab left eticketing/web-identity watch list but is still open (e.g. membership/red) —
    // do not wipe post-clear pending / active cooldown.
    if (pendingKeep || snap[HD_QUEUE_MEMBERSHIP_RECOVERY_ACTIVE_KEY] === true) {
        try {
            await chrome.tabs.get(tabId);
            if (wasPending) {
                const keep = mem || getBrowsingPauseState(tabId);
                keep.cookiesClearedPendingCheck = true;
            }
            console.log(
                '[BG] Pause tab left eticketing/web-identity watch list but still open — keeping pending/cooldown (no force clear):',
                tabId,
                reason || ''
            );
            return;
        } catch (_) {
            // Tab truly closed — fall through and clear
        }
    }

    clearBrowsingPauseStateForTab(tabId, { clearStoragePending: true });

    // Only act if this tab was part of browsing-pause recovery
    if (!hadMemoryState && !wasPending && !wasCooldownTab) {
        return;
    }

    try {
        const tabs = await queryBrowsingPauseWatchTabsAsync();
        if ((tabs || []).some((t) => tabTitleIsBrowsingPaused(t.title))) {
            console.log(
                '[BG] Pause tab gone but another tab still shows browsing pause — hold kept.',
                reason || ''
            );
            return;
        }
    } catch (_) {}

    // Another tab still mid wait / cookie-pending / cooldown
    if (browsingPauseMemoryHoldActive()) {
        console.log(
            '[BG] Pause tab gone; other browsing-pause recovery still active — not force-clearing hold.',
            reason || ''
        );
        return;
    }

    await forceReleaseBrowsingPauseHold(reason || 'browsing-pause tab gone');
}

function clearBrowsingPauseStateForTab(tabId, opts) {
    if (tabId == null) return;
    const s = browsingPauseStateByTab.get(tabId);
    if (s) {
        if (s.timerId != null) clearTimeout(s.timerId);
        if (s.postCookieGraceTimerId != null) clearTimeout(s.postCookieGraceTimerId);
        if (s.postActionGraceTimerId != null) clearTimeout(s.postActionGraceTimerId);
        browsingPauseStateByTab.delete(tabId);
    }
    if (opts && opts.clearStoragePending) {
        chrome.storage.local.get([BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY, BROWSING_PAUSE_COOLDOWN_TAB_KEY], (snap) => {
            const patch = {};
            if (browsingPausePendingTabIdMatches(snap[BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY], tabId)) {
                patch[BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY] = null;
            }
            if (browsingPausePendingTabIdMatches(snap[BROWSING_PAUSE_COOLDOWN_TAB_KEY], tabId)) {
                patch[BROWSING_PAUSE_COOLDOWN_TAB_KEY] = null;
                patch[BROWSING_PAUSE_COOLDOWN_UNTIL_KEY] = 0;
                try {
                    chrome.alarms.clear(BROWSING_PAUSE_COOLDOWN_ALARM);
                } catch (_) {}
            }
            if (Object.keys(patch).length) chrome.storage.local.set(patch);
        });
    }
}

/** Drop stale hold when no eticketing tab still shows the pause title and no live recovery timers. */
async function reconcileStaleBrowsingPauseHold(reason) {
    try {
        const tabs = await queryBrowsingPauseWatchTabsAsync();
        if ((tabs || []).some((t) => tabTitleIsBrowsingPaused(t.title))) return false;
        // Event Index open but token not ready — do not treat as recovered
        if (await eventIndexLoadedWithoutToken(tabs)) {
            return false;
        }
    } catch (_) {}

    for (const [id, s] of [...browsingPauseStateByTab.entries()]) {
        if (!s) {
            browsingPauseStateByTab.delete(id);
            continue;
        }
        // Keep mid-recovery state (reload streak / grace) — wiping it reset reloadCount and looped forever
        if (
            !s.waiting &&
            !s.cookiesClearedPendingCheck &&
            !s.postClearReloadPending &&
            !(s.cooldownUntil > Date.now()) &&
            !(s.postActionGraceUntil > Date.now()) &&
            !(s.waitUntil > 0) &&
            !(s.postClearMembershipUntil > 0) &&
            !s.deferredAction &&
            !(s.reloadCount > 0) &&
            s.timerId == null &&
            s.postActionGraceTimerId == null
        ) {
            if (s.postCookieGraceTimerId != null) clearTimeout(s.postCookieGraceTimerId);
            browsingPauseStateByTab.delete(id);
        }
    }

    const snap = await chrome.storage.local.get([
        BROWSING_PAUSE_SYSTEM_HOLD_KEY,
        BROWSING_PAUSE_COOLDOWN_UNTIL_KEY,
        BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY,
        BROWSING_PAUSE_COOLDOWN_TAB_KEY
    ]);
    if (Number(snap[BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]) > Date.now() || snap[BROWSING_PAUSE_COOLDOWN_TAB_KEY] != null) {
        const coolTab = snap[BROWSING_PAUSE_COOLDOWN_TAB_KEY];
        if (coolTab != null) {
            try {
                await chrome.tabs.get(coolTab);
                return false; // cooldown running or already due (waiting for sheet On)
            } catch (_) {
                await chrome.storage.local.set({
                    [BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]: 0,
                    [BROWSING_PAUSE_COOLDOWN_TAB_KEY]: null
                });
                try {
                    chrome.alarms.clear(BROWSING_PAUSE_COOLDOWN_ALARM);
                } catch (_) {}
            }
        } else if (Number(snap[BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]) > Date.now()) {
            await chrome.storage.local.set({ [BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]: 0 });
            try {
                chrome.alarms.clear(BROWSING_PAUSE_COOLDOWN_ALARM);
            } catch (_) {}
        }
    }
    const pendingTab = snap[BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY];
    if (pendingTab != null) {
        try {
            await chrome.tabs.get(pendingTab);
        } catch (_) {
            await chrome.storage.local.set({ [BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY]: null });
        }
    }

    if (snap[BROWSING_PAUSE_SYSTEM_HOLD_KEY] !== true && !browsingPauseMemoryHoldActive()) {
        return true;
    }
    return exitBrowsingPauseSystemHoldIfSafe(reason || 'reconcile stale browsing-pause hold');
}

/** Hard clear (paused tab gone / storm recovery / extension start). */
async function forceReleaseBrowsingPauseHold(reason) {
    for (const [id, s] of [...browsingPauseStateByTab.entries()]) {
        if (s && s.timerId != null) clearTimeout(s.timerId);
        if (s && s.postCookieGraceTimerId != null) clearTimeout(s.postCookieGraceTimerId);
        if (s && s.postActionGraceTimerId != null) clearTimeout(s.postActionGraceTimerId);
        browsingPauseStateByTab.delete(id);
    }
    await chrome.storage.local.set({
        [BROWSING_PAUSE_SYSTEM_HOLD_KEY]: false,
        [BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]: 0,
        [BROWSING_PAUSE_COOLDOWN_TAB_KEY]: null,
        [BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY]: null,
        [BROWSING_PAUSE_SHEET_OFF_FROZEN_KEY]: false,
        [BROWSING_PAUSE_FROZEN_SNAPSHOT_KEY]: null
    });
    try {
        chrome.alarms.clear(BROWSING_PAUSE_COOLDOWN_ALARM);
    } catch (_) {}
    browsingPauseSystemHoldLogged = false;
    browsingPauseFrozenBySheetOff = false;
    lastHeartbeat = Date.now();
    console.log('[BG] ▶️ Browsing-pause hold FORCE cleared — refresh/heartbeat ops unblocked.', reason || '');
}

async function isBrowsingPauseSystemHoldActive() {
    if (browsingPauseMemoryHoldActive()) return true;
    const snap = await chrome.storage.local.get([
        BROWSING_PAUSE_SYSTEM_HOLD_KEY,
        BROWSING_PAUSE_COOLDOWN_UNTIL_KEY,
        BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY,
        BROWSING_PAUSE_COOLDOWN_TAB_KEY,
        BROWSING_PAUSE_SHEET_OFF_FROZEN_KEY
    ]);
    if (Number(snap[BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]) > Date.now()) return true;
    if (snap[BROWSING_PAUSE_COOLDOWN_TAB_KEY] != null) {
        const coolTid = snap[BROWSING_PAUSE_COOLDOWN_TAB_KEY];
        try {
            await chrome.tabs.get(coolTid);
            return true;
        } catch (_) {
            await chrome.storage.local.set({
                [BROWSING_PAUSE_COOLDOWN_TAB_KEY]: null,
                [BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]: 0
            });
        }
    }
    if (snap[BROWSING_PAUSE_SHEET_OFF_FROZEN_KEY] === true && browsingPauseMemoryHoldActive()) return true;
    if (snap[BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY] != null) {
        const tid = snap[BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY];
        try {
            await chrome.tabs.get(tid);
            return true;
        } catch (_) {
            await chrome.storage.local.set({ [BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY]: null });
        }
    }
    try {
        const tabs = await queryBrowsingPauseWatchTabsAsync();
        if ((tabs || []).some((t) => tabTitleIsBrowsingPaused(t.title))) return true;
        // Hold is intentional while event Index is up without verification token
        if (snap[BROWSING_PAUSE_SYSTEM_HOLD_KEY] === true && (await eventIndexLoadedWithoutToken(tabs))) {
            return true;
        }
    } catch (_) {}
    if (snap[BROWSING_PAUSE_SYSTEM_HOLD_KEY] === true) {
        // Stale storage hold with no live pause — clear so refreshEventTab is not frozen forever
        if (browsingPauseMemoryHoldActive()) return true;
        const cleared = await reconcileStaleBrowsingPauseHold('isBrowsingPauseSystemHoldActive self-heal');
        if (cleared) return false;
        // exit may have failed if memory still active; re-check
        if (browsingPauseMemoryHoldActive()) return true;
        try {
            const tabsAgain = await queryBrowsingPauseWatchTabsAsync();
            if (await eventIndexLoadedWithoutToken(tabsAgain)) return true;
        } catch (_) {}
        const again = await chrome.storage.local.get([BROWSING_PAUSE_SYSTEM_HOLD_KEY]);
        if (again[BROWSING_PAUSE_SYSTEM_HOLD_KEY] === true) {
            await forceReleaseBrowsingPauseHold('stale hold with no pause title');
            return false;
        }
        return false;
    }
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
        BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY,
        BROWSING_PAUSE_COOLDOWN_TAB_KEY
    ]);
    if (Number(snap[BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]) > Date.now()) return false;
    if (snap[BROWSING_PAUSE_COOLDOWN_TAB_KEY] != null) return false;
    if (snap[BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY] != null) return false;
    try {
        const tabs = await queryBrowsingPauseWatchTabsAsync();
        if ((tabs || []).some((t) => tabTitleIsBrowsingPaused(t.title))) return false;
        if (await eventIndexLoadedWithoutToken(tabs)) {
            console.log(
                '[BG] Browsing pause hold kept — event Index open but eventPageReady/token not set yet.',
                reason || ''
            );
            return false;
        }
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
            postActionGraceTimerId: null,
            postActionGraceUntil: 0,
            cookiesClearedPendingCheck: false,
            postClearReloadPending: false,
            postClearMembershipUntil: 0,
            postClearMembershipTimerId: null,
            waitUntil: 0,
            waitSrc: '',
            deferredAction: '',
            cooldownUntil: 0
        };
        browsingPauseStateByTab.set(tabId, s);
    }
    return s;
}

function browsingPauseActionsBlockedBySheetOff(label) {
    if (lastStatus !== 'off') return false;
    console.log('[BG] Sheet Off — skip browsing-pause action:', label || '(none)');
    return true;
}

function serializeBrowsingPauseFrozenSnapshot() {
    const snapshot = {};
    for (const [tabId, s] of browsingPauseStateByTab.entries()) {
        if (!s) continue;
        snapshot[String(tabId)] = {
            reloadCount: s.reloadCount || 0,
            waiting: !!s.waiting,
            waitUntil: s.waitUntil || 0,
            waitSrc: s.waitSrc || '',
            cookiesClearedPendingCheck: !!s.cookiesClearedPendingCheck,
            postClearReloadPending: !!s.postClearReloadPending,
            postClearMembershipUntil: s.postClearMembershipUntil || 0,
            postActionGraceUntil: s.postActionGraceUntil || 0,
            cooldownUntil: s.cooldownUntil || 0,
            deferredAction: s.deferredAction || ''
        };
    }
    return snapshot;
}

function restoreBrowsingPauseFrozenSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    for (const [idStr, row] of Object.entries(snapshot)) {
        const tabId = Number(idStr);
        if (!Number.isFinite(tabId) || !row) continue;
        const s = getBrowsingPauseState(tabId);
        s.reloadCount = Number(row.reloadCount) || 0;
        s.waiting = !!row.waiting;
        s.waitUntil = Number(row.waitUntil) || 0;
        s.waitSrc = row.waitSrc || '';
        s.cookiesClearedPendingCheck = !!row.cookiesClearedPendingCheck;
        s.postClearReloadPending = !!row.postClearReloadPending;
        s.postClearMembershipUntil = Number(row.postClearMembershipUntil) || 0;
        s.postActionGraceUntil = Number(row.postActionGraceUntil) || 0;
        s.cooldownUntil = Number(row.cooldownUntil) || 0;
        s.deferredAction = row.deferredAction || '';
    }
}

/** Sheet Off: stop recovery timers / membership / cookie-clear. Keep state so On can resume. */
async function freezeBrowsingPauseRecoveryForSheetOff() {
    browsingPauseFrozenBySheetOff = true;
    for (const s of browsingPauseStateByTab.values()) {
        if (!s) continue;
        if (s.timerId != null) {
            clearTimeout(s.timerId);
            s.timerId = null;
        }
        if (s.postActionGraceTimerId != null) {
            clearTimeout(s.postActionGraceTimerId);
            s.postActionGraceTimerId = null;
        }
        if (s.postCookieGraceTimerId != null) {
            clearTimeout(s.postCookieGraceTimerId);
            s.postCookieGraceTimerId = null;
        }
        if (s.postClearMembershipTimerId != null) {
            clearTimeout(s.postClearMembershipTimerId);
            s.postClearMembershipTimerId = null;
        }
    }
    try {
        chrome.alarms.clear(BROWSING_PAUSE_COOLDOWN_ALARM);
    } catch (_) {}
    const snapshot = serializeBrowsingPauseFrozenSnapshot();
    await chrome.storage.local.set({
        [BROWSING_PAUSE_SHEET_OFF_FROZEN_KEY]: true,
        [BROWSING_PAUSE_FROZEN_SNAPSHOT_KEY]: snapshot
    });
    console.log(
        '[BG] Sheet Off — browsing-pause recovery frozen (' +
            Object.keys(snapshot).length +
            ' tab(s)); no reload/clear/membership/event open until sheet On'
    );
}

/**
 * Sheet On: resume frozen recovery.
 * @returns {boolean} true if recovery/cooldown still owns the flow (do not open event tabs)
 */
async function resumeBrowsingPauseRecoveryAfterSheetOn() {
    const stored = await chrome.storage.local.get([
        BROWSING_PAUSE_SHEET_OFF_FROZEN_KEY,
        BROWSING_PAUSE_FROZEN_SNAPSHOT_KEY,
        BROWSING_PAUSE_COOLDOWN_UNTIL_KEY,
        BROWSING_PAUSE_COOLDOWN_TAB_KEY
    ]);
    restoreBrowsingPauseFrozenSnapshot(stored[BROWSING_PAUSE_FROZEN_SNAPSHOT_KEY]);
    browsingPauseFrozenBySheetOff = false;
    await chrome.storage.local.set({
        [BROWSING_PAUSE_SHEET_OFF_FROZEN_KEY]: false,
        [BROWSING_PAUSE_FROZEN_SNAPSHOT_KEY]: null
    });

    const now = Date.now();
    const coolTab = stored[BROWSING_PAUSE_COOLDOWN_TAB_KEY];
    const coolUntil = Number(stored[BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]) || 0;

    if (coolTab != null && coolUntil > now) {
        chrome.alarms.create(BROWSING_PAUSE_COOLDOWN_ALARM, { when: coolUntil });
        console.log(
            '[BG] Sheet On — browsing-pause cooldown still running (' +
                browsingPauseScheduleSuffix(coolUntil - now, 're-check → clear if still paused → Arsenal membership') +
                ')'
        );
        return true;
    }
    if (coolTab != null) {
        console.log('[BG] Sheet On — browsing-pause cooldown already ended; starting next step');
        await finishPostCookieBrowsingPauseCooldown('sheet On — cooldown already ended');
        return true;
    }

    let resumed = false;
    for (const [tabId, s] of [...browsingPauseStateByTab.entries()]) {
        if (!s) continue;
        const deferred = s.deferredAction || '';
        s.deferredAction = '';

        if (s.postClearReloadPending) {
            resumed = true;
            const remain = Math.max(0, (s.postClearMembershipUntil || 0) - now);
            const go = () => {
                void navigateFreshAfterBrowsingPauseSiteDataClear(tabId, s, { restartFreshCycle: false }).catch(
                    (e) => console.warn('[BG] sheet-on membership resume failed:', e?.message || e)
                );
            };
            if (remain > 50) {
                console.log(
                    '[BG] Sheet On — resume Arsenal membership in ' + Math.round(remain / 1000) + 's (post-clear wait)'
                );
                s.postClearMembershipTimerId = setTimeout(() => {
                    s.postClearMembershipTimerId = null;
                    go();
                }, remain);
            } else {
                console.log('[BG] Sheet On — post-clear wait already ended; opening Arsenal membership now');
                go();
            }
            continue;
        }

        if (s.postActionGraceUntil > now) {
            resumed = true;
            console.log(
                '[BG] Sheet On — resume ' +
                    browsingPauseGraceSecondsLabel(s.postActionGraceUntil - now) +
                    ' grace until ' +
                    formatBrowsingPauseClock(s.postActionGraceUntil)
            );
            noteBrowsingActivityPausedTab(tabId, s.waitSrc || 'sheet-on-resume');
            continue;
        }
        if (s.postActionGraceUntil > 0 && s.postActionGraceUntil <= now) {
            resumed = true;
            s.postActionGraceUntil = 0;
            console.log('[BG] Sheet On — grace already ended; re-checking if pause still present');
            noteBrowsingPauseStillPresentAfterGrace(tabId, s, 'sheet-on-resume-after-grace');
            continue;
        }

        if (s.waitUntil > now) {
            resumed = true;
            const remain = s.waitUntil - now;
            s.waiting = true;
            console.log(
                '[BG] Sheet On — resume browsing-pause wait (' +
                    browsingPauseScheduleSuffix(remain, 'next recovery step') +
                    ')'
            );
            s.timerId = setTimeout(() => {
                s.timerId = null;
                s.waiting = false;
                s.waitUntil = 0;
                onBrowsingPauseWaitElapsed(tabId, s);
            }, remain);
            continue;
        }

        if (
            deferred === 'waitElapsed' ||
            deferred === 'reload' ||
            deferred === 'clear' ||
            s.waiting ||
            (s.waitUntil > 0 && s.waitUntil <= now)
        ) {
            resumed = true;
            s.waiting = false;
            s.waitUntil = 0;
            console.log('[BG] Sheet On — wait already ended; starting next browsing-pause step');
            if (deferred === 'reload' || deferred === 'clear') {
                reloadAfterBrowsingPause(tabId, s);
            } else {
                onBrowsingPauseWaitElapsed(tabId, s);
            }
            continue;
        }

        if (deferred === 'membership') {
            resumed = true;
            console.log('[BG] Sheet On — resume Arsenal membership (was deferred)');
            void navigateFreshAfterBrowsingPauseSiteDataClear(tabId, s, { restartFreshCycle: false });
            continue;
        }

        if (s.cookiesClearedPendingCheck || s.reloadCount > 0) {
            resumed = true;
            noteBrowsingActivityPausedTab(tabId, 'sheet-on-resume');
        }
    }

    if (resumed || browsingPauseMemoryHoldActive()) {
        console.log('[BG] Sheet On — browsing-pause recovery still in progress (event tab open deferred)');
        return true;
    }
    return false;
}

/** After reload / membership open: ignore pause-again decisions until this grace ends. */
function armBrowsingPausePostActionGrace(tabId, state, reason) {
    const s = state || getBrowsingPauseState(tabId);
    s.postActionGraceUntil = Date.now() + BROWSING_PAUSE_POST_ACTION_GRACE_MS;
    if (s.postActionGraceTimerId != null) {
        clearTimeout(s.postActionGraceTimerId);
        s.postActionGraceTimerId = null;
    }
    const g = browsingPauseGraceSecondsLabel(BROWSING_PAUSE_POST_ACTION_GRACE_MS);
    console.log(
        `[BG] STEP: ${g} grace after ${reason || 'action'} on tab ${tabId}` +
            ` (until ${formatBrowsingPauseClock(s.postActionGraceUntil)}) — will not decide pause-again until then`
    );
}

/**
 * After clear (+ wait by caller): always reopen via Arsenal membership.
 * @param {boolean} restartFreshCycle if true, next pause starts full quiet cycle (not immediate cooldown)
 */
async function navigateFreshAfterBrowsingPauseSiteDataClear(tabId, state, opts) {
    if (browsingPauseActionsBlockedBySheetOff('open Arsenal membership after clear')) {
        const s0 = state || getBrowsingPauseState(tabId);
        s0.postClearReloadPending = true;
        s0.deferredAction = 'membership';
        return;
    }
    const restartFreshCycle = !!(opts && opts.restartFreshCycle);
    const s = state || getBrowsingPauseState(tabId);
    s.waiting = false;
    s.postClearReloadPending = false;
    s.cooldownUntil = 0;
    s.reloadCount = 0;
    // After clear+membership → pending so next pause = long cooldown only. After cooldown recovery → fresh cycle.
    s.cookiesClearedPendingCheck = !restartFreshCycle;
    if (s.timerId != null) {
        clearTimeout(s.timerId);
        s.timerId = null;
    }
    if (s.postCookieGraceTimerId != null) clearTimeout(s.postCookieGraceTimerId);
    if (restartFreshCycle) {
        s.postCookieGraceTimerId = null;
        try {
            chrome.storage.local.set({ [BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY]: null });
        } catch (_) {}
    } else {
        s.postCookieGraceTimerId = setTimeout(() => {
            s.postCookieGraceTimerId = null;
            if (!s.cookiesClearedPendingCheck) return;
            if (s.cooldownUntil > Date.now()) return;
            s.cookiesClearedPendingCheck = false;
            try {
                chrome.storage.local.set({ [BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY]: null });
            } catch (_) {}
            console.log(
                '[BG] Browsing pause did not return after clear + membership — pending flag cleared for tab',
                tabId
            );
            void exitBrowsingPauseSystemHoldIfSafe('post-clear membership succeeded');
        }, 5 * 60 * 1000);
        await chrome.storage.local.set({ [BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY]: tabId });
    }

    try {
        await chrome.storage.local.set({
            [BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]: 0,
            [BROWSING_PAUSE_COOLDOWN_TAB_KEY]: null,
            [BROWSING_PAUSE_SYSTEM_HOLD_KEY]: false
        });
    } catch (_) {}
    browsingPauseSystemHoldLogged = false;
    lastHeartbeat = Date.now();

    await resetEventPageReadyFlag(
        restartFreshCycle
            ? 'after cooldown → clear/membership (fresh cycle)'
            : 'after clear → Arsenal membership'
    );

    const now = formatBrowsingPauseClock(Date.now());
    const g = browsingPauseGraceSecondsLabel(BROWSING_PAUSE_POST_ACTION_GRACE_MS);
    try {
        await chrome.tabs.get(tabId);
    } catch (_) {
        console.warn(`[BG] Clear tab ${tabId} gone — opening Arsenal membership in new tab`);
        await openEventEntryForClub({ focus: true, reuseTabId: null });
        armBrowsingPausePostActionGrace(tabId, s, 'Arsenal membership open (tab gone)');
        return;
    }

    console.log(
        `[BG] STEP: opening Arsenal membership NOW (${now})` +
            ` — reuse tab ${tabId} after clear;` +
            (restartFreshCycle
                ? ' next pause restarts quiet cycle (3m → reload → eticketing clear → membership)'
                : ` if pause returns (after ${g} grace) → long cooldown only`)
    );
    await openEventEntryForClub({ focus: true, reuseTabId: tabId });
    armBrowsingPausePostActionGrace(
        tabId,
        s,
        restartFreshCycle ? 'Arsenal membership open (fresh cycle)' : 'Arsenal membership open after clear'
    );
}

/**
 * Soft reopen after cooldown when pause is already gone — membership only, no clear.
 */
async function softReopenMembershipAfterBrowsingPauseCooldown(tabId, state) {
    const s = state || getBrowsingPauseState(tabId);
    s.waiting = false;
    s.postClearReloadPending = false;
    s.cooldownUntil = 0;
    s.reloadCount = 0;
    s.cookiesClearedPendingCheck = false;
    try {
        chrome.storage.local.set({ [BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY]: null });
    } catch (_) {}
    await resetEventPageReadyFlag('after cooldown — soft membership (pause not present)');
    browsingPauseSystemHoldLogged = false;
    lastHeartbeat = Date.now();
    const now = formatBrowsingPauseClock(Date.now());
    console.log(
        `[BG] STEP: soft Arsenal membership NOW (${now}) after cooldown — no clear (pause not present on tab ${tabId})`
    );
    try {
        await chrome.tabs.get(tabId);
        await openEventEntryForClub({ focus: true, reuseTabId: tabId });
    } catch (_) {
        await openEventEntryForClub({ focus: true, reuseTabId: null });
    }
    armBrowsingPausePostActionGrace(tabId, s, 'soft Arsenal membership after cooldown');
    void exitBrowsingPauseSystemHoldIfSafe('soft membership after cooldown');
}

/** Probe whether tab still shows browsing-pause (title or content-script). */
async function tabStillHasBrowsingPause(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tabTitleIsBrowsingPaused(tab.title)) return true;
        const u = tab.url || tab.pendingUrl || '';
        if (tabUrlIsWebIdentityAuthorize(u)) return true;
        return await new Promise((resolve) => {
            chrome.tabs.sendMessage(tabId, { action: 'isBrowsingActivityPaused' }, (resp) => {
                if (chrome.runtime.lastError) {
                    resolve(false);
                    return;
                }
                resolve(
                    !!(
                        resp &&
                        (resp.paused || resp.stuckAuthorize === true || resp.stuckConfirmed === true)
                    )
                );
            });
        });
    } catch (_) {
        return false;
    }
}

/**
 * Clear → wait → Arsenal membership.
 * @param {'eticketing' | 'full'} clearMode eticketing cookie/site-data (first path) or full browser clear (after 1h+ cooldown)
 * @param {boolean} restartFreshCycle if true after cooldown, next pause is fresh quiet cycle
 * @param {{ cooldownJustEndedMs?: number, cooldownJustEndedLabel?: string, cooldownStreak?: number }} [notifyExtra]
 */
function runBrowsingPauseCookieClearThenMembership(
    tabId,
    state,
    whyLabel,
    afterAction,
    restartFreshCycle,
    clearMode,
    notifyExtra
) {
    const mode = clearMode === 'full' ? 'full' : 'eticketing';
    const s = state || getBrowsingPauseState(tabId);
    const stepName =
        mode === 'full' ? 'FULL BROWSER CLEAR' : 'ETICKETING COOKIE/SITE-DATA CLEAR';
    if (browsingPauseActionsBlockedBySheetOff(stepName)) {
        s.deferredAction = 'clear';
        return;
    }
    const extra = notifyExtra && typeof notifyExtra === 'object' ? notifyExtra : {};
    const clearNow = formatBrowsingPauseClock(Date.now());
    const nextLabel = 'open Arsenal membership';
    const waitSec = BROWSING_PAUSE_AFTER_CLEAR_RELOAD_MS / 1000;
    console.warn(
        `[BG] STEP: ${stepName} starting NOW (${clearNow}) on tab ${tabId}` +
            ` — ${whyLabel || 'browsing pause'}; then wait ${waitSec}s → ${nextLabel}`
    );
    s.reloadCount = 0;
    s.cookiesClearedPendingCheck = !restartFreshCycle;
    s.waiting = true;
    s.postClearReloadPending = true;
    s.cooldownUntil = 0;
    void chrome.storage.local.set({
        [BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY]: s.cookiesClearedPendingCheck ? tabId : null
    });
    if (s.postCookieGraceTimerId != null) {
        clearTimeout(s.postCookieGraceTimerId);
        s.postCookieGraceTimerId = null;
    }
    const clearFn =
        mode === 'full' ? clearFullBrowserDataForBrowsingPause : clearEticketingWwwSiteDataLikeChrome;
    void (async () => {
        await maybeNotifyBrowsingPauseDiscord(tabId, {
            source: mode === 'full' ? 'before-full-browser-clear' : 'before-eticketing-cookie-clear',
            clearMode: mode,
            whyLabel: whyLabel || '',
            restartFreshCycle: !!restartFreshCycle,
            cooldownJustEndedMs: extra.cooldownJustEndedMs,
            cooldownJustEndedLabel: extra.cooldownJustEndedLabel,
            cooldownStreak: extra.cooldownStreak
        });
        if (lastStatus === 'off') {
            console.log('[BG] Sheet Off after Discord — skip cookie clear; deferred until sheet On');
            s.deferredAction = 'clear';
            s.postClearReloadPending = false;
            s.waiting = false;
            return;
        }
        clearFn(() => {
            const waitMs = BROWSING_PAUSE_AFTER_CLEAR_RELOAD_MS;
            s.postClearMembershipUntil = Date.now() + waitMs;
            console.log(
                `[BG] STEP: ${stepName} DONE (${formatBrowsingPauseClock(Date.now())}) on tab ${tabId}` +
                    ` — ${browsingPauseScheduleSuffix(waitMs, nextLabel)}`
            );
            if (s.postClearMembershipTimerId != null) clearTimeout(s.postClearMembershipTimerId);
            s.postClearMembershipTimerId = setTimeout(() => {
                s.postClearMembershipTimerId = null;
                if (lastStatus === 'off') {
                    s.deferredAction = 'membership';
                    console.log('[BG] Sheet Off — defer Arsenal membership after clear on tab', tabId);
                    return;
                }
                console.log(
                    `[BG] STEP: ${waitSec}s wait after ${mode} clear finished (${formatBrowsingPauseClock(Date.now())})` +
                        ` — opening Arsenal membership ${tabId} now`
                );
                void navigateFreshAfterBrowsingPauseSiteDataClear(tabId, s, {
                    afterAction: 'membership',
                    restartFreshCycle: !!restartFreshCycle
                }).catch((e) => {
                    console.warn('[BG] post-clear membership navigate failed:', e?.message || e);
                    s.waiting = false;
                    s.postClearReloadPending = false;
                    void openEventEntryForClub({ focus: true, reuseTabId: tabId }).catch(() => {});
                });
            }, waitMs);
        }, tabId);
    })();
}

/** First-path recovery: eticketing cookies/site-data only → Arsenal membership. */
function recoverBrowsingPauseWithEticketingClearAndMembership(tabId, state, whyLabel) {
    runBrowsingPauseCookieClearThenMembership(
        tabId,
        state || getBrowsingPauseState(tabId),
        whyLabel || 'after reload check still paused',
        'membership',
        false,
        'eticketing'
    );
}

/** @deprecated name — first path now uses eticketing-only clear. */
function recoverBrowsingPauseWithFullClearAndMembership(tabId, state, whyLabel) {
    recoverBrowsingPauseWithEticketingClearAndMembership(tabId, state, whyLabel);
}

/**
 * After 3 min: reload once to see if pause cleared.
 * After reload + 20s re-check still paused: eticketing clear → membership.
 */
function reloadAfterBrowsingPause(tabId, state) {
    const s = state || getBrowsingPauseState(tabId);
    if (browsingPauseActionsBlockedBySheetOff('reload / clear')) {
        s.deferredAction = s.reloadCount >= BROWSING_PAUSE_RELOADS_BEFORE_SITE_DATA_CLEAR ? 'clear' : 'reload';
        return;
    }
    const maxReloads = BROWSING_PAUSE_RELOADS_BEFORE_SITE_DATA_CLEAR;
    if (s.reloadCount >= maxReloads) {
        recoverBrowsingPauseWithEticketingClearAndMembership(
            tabId,
            s,
            `after reload ${maxReloads}/${maxReloads} + ${BROWSING_PAUSE_POST_RELOADS_BEFORE_CLEAR_MS / 1000}s re-check still paused`
        );
        return;
    }
    s.reloadCount += 1;
    console.warn(
        `[BG] STEP: reload ${s.reloadCount}/${maxReloads} NOW (${formatBrowsingPauseClock(Date.now())}) on tab ${tabId}` +
            ' — check if browsing pause cleared'
    );
    chrome.tabs.reload(tabId, () => {
        if (chrome.runtime.lastError) {
            console.warn('[BG] browsing-pause reload failed:', chrome.runtime.lastError.message);
        }
        armBrowsingPausePostActionGrace(
            tabId,
            s,
            'reload ' + s.reloadCount + '/' + maxReloads
        );
    });
}

/**
 * Event URL → web-identity authorize with browsing pause:
 * same shared path (3m → reload → 20s → eticketing clear → membership).
 */
async function closeStaleEventTabsBeforeMembershipReopen(primaryTabId) {
    const eventUrl = await resolveStoredEventUrl();
    const toClose = new Set();
    if (primaryTabId != null) toClose.add(primaryTabId);

    try {
        const tabs = await chrome.tabs.query({});
        for (const t of tabs || []) {
            if (t.id == null) continue;
            const u = t.url || '';
            const p = t.pendingUrl || '';
            // Event Index tabs for current eventUrl (stuck pause / half-loaded)
            if (eventUrl && (tabIsOurEticketEventPage(t, eventUrl) || tabUrlIsEventIndex(u) || tabUrlIsEventIndex(p))) {
                // Only close Index tabs that match our event (or any Index if URL matches club path)
                if (tabIsOurEticketEventPage(t, eventUrl)) {
                    toClose.add(t.id);
                    continue;
                }
            }
            // web-identity authorize / pause pages from event redirect
            if (tabUrlIsWebIdentity(u) || tabUrlIsWebIdentity(p)) {
                toClose.add(t.id);
                continue;
            }
            // Any www eticketing tab still showing browsing-pause title
            if (
                (u.includes('www.eticketing.co.uk') || p.includes('www.eticketing.co.uk')) &&
                tabTitleIsBrowsingPaused(t.title)
            ) {
                toClose.add(t.id);
            }
        }
    } catch (e) {
        console.warn('[BG] closeStaleEventTabsBeforeMembershipReopen query failed:', e?.message || e);
    }

    const ids = [...toClose];
    for (const id of ids) {
        clearBrowsingPauseStateForTab(id, { clearStoragePending: true });
        webIdentityAuthorizeSeenAt.delete(id);
    }

    if (!ids.length) {
        console.log('[BG] No stale event/web-identity tabs to close before membership reopen');
        return { closed: [], skipped: [] };
    }

    const { removed, skipped } = await safeTabsRemove(ids);
    console.log(
        '[BG] Closed stale event/web-identity tab(s) before Arsenal membership reopen:',
        removed.join(',') || '(none)',
        skipped.length ? '| skipped last-in-window: ' + skipped.join(',') : ''
    );
    if (removed.includes(eventTabId)) eventTabId = null;
    return { closed: removed, skipped };
}

/**
 * Legacy web-identity-only recovery (membership cycles 1–3). Unused —
 * web-identity now uses the same 3m → reload → eticketing clear → membership path as eticketing.
 */
async function recoverFromWebIdentityBrowsingPause(tabId, state, reason) {
    console.warn(
        '[BG] recoverFromWebIdentityBrowsingPause redirected to shared pause path:',
        reason || ''
    );
    webIdentityAuthorizeSeenAt.delete(tabId);
    if (state) {
        state.waiting = false;
        if (state.timerId != null) {
            clearTimeout(state.timerId);
            state.timerId = null;
        }
    }
    reloadAfterBrowsingPause(tabId, state || getBrowsingPauseState(tabId));
}

async function startPostCookieBrowsingPauseCooldown(tabId, state) {
    const snap = await chrome.storage.local.get(BROWSING_PAUSE_COOLDOWN_STREAK_KEY);
    const streak = (Number(snap[BROWSING_PAUSE_COOLDOWN_STREAK_KEY]) || 0) + 1;
    const cooldownMs = browsingPauseCooldownMsForStreak(streak);
    const minsLabel = browsingPauseCooldownMinutesLabel(cooldownMs);
    const until = Date.now() + cooldownMs;
    state.cooldownUntil = until;
    state.waiting = false;
    state.cookiesClearedPendingCheck = false;
    state.postClearReloadPending = false;
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
        [BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY]: null,
        [BROWSING_PAUSE_COOLDOWN_STREAK_KEY]: streak,
        [BROWSING_PAUSE_COOLDOWN_ACTIVE_MS_KEY]: cooldownMs
    });
    chrome.alarms.create(BROWSING_PAUSE_COOLDOWN_ALARM, { when: until });
    await enterBrowsingPauseSystemHold(
        'post-cookie ' + minsLabel + ' cooldown (#' + streak + ') tab ' + tabId
    );
    const capLabel = browsingPauseCooldownMinutesLabel(BROWSING_PAUSE_COOLDOWN_MAX_MS);
    const afterCooldownHint =
        cooldownMs >= BROWSING_PAUSE_FULL_CLEAR_AFTER_COOLDOWN_MS
            ? 're-check → FULL browser clear if still paused → Arsenal membership → restart quiet cycle'
            : 're-check → eticketing clear if still paused → Arsenal membership → restart quiet cycle';
    console.warn(
        `[BG] STEP: ${minsLabel} cooldown START (#${streak}, cap ${capLabel}) (${formatBrowsingPauseClock(Date.now())}) on tab ${tabId}` +
            ` — pause returned after eticketing clear + membership;` +
            ` ${browsingPauseScheduleSuffix(cooldownMs, afterCooldownHint)}`
    );
}

async function finishPostCookieBrowsingPauseCooldown(reason) {
    if (lastStatus === 'off') {
        console.log(
            '[BG] Cooldown next-step deferred — Google Sheet is Off (will run when status is On):',
            reason || ''
        );
        return;
    }
    const {
        [BROWSING_PAUSE_COOLDOWN_TAB_KEY]: tabId,
        [BROWSING_PAUSE_COOLDOWN_ACTIVE_MS_KEY]: activeMs,
        [BROWSING_PAUSE_COOLDOWN_STREAK_KEY]: streak
    } = await chrome.storage.local.get([
        BROWSING_PAUSE_COOLDOWN_TAB_KEY,
        BROWSING_PAUSE_COOLDOWN_ACTIVE_MS_KEY,
        BROWSING_PAUSE_COOLDOWN_STREAK_KEY
    ]);
    const minsLabel = browsingPauseCooldownMinutesLabel(
        activeMs || browsingPauseCooldownMsForStreak(streak || 1)
    );
    await chrome.storage.local.set({
        [BROWSING_PAUSE_COOLDOWN_UNTIL_KEY]: 0,
        [BROWSING_PAUSE_COOLDOWN_TAB_KEY]: null,
        [BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY]: null,
        [BROWSING_PAUSE_COOLDOWN_ACTIVE_MS_KEY]: 0
    });
    chrome.alarms.clear(BROWSING_PAUSE_COOLDOWN_ALARM);
    const now = formatBrowsingPauseClock(Date.now());
    if (tabId == null) {
        console.log(
            `[BG] STEP: ${minsLabel} cooldown END (#${Number(streak) || '?'}) (${now})` +
                ` — ${reason || '(no reason)'}; no tab`
        );
        await exitBrowsingPauseSystemHoldIfSafe('cooldown ended (no tab)');
        return;
    }
    const state = getBrowsingPauseState(tabId);
    state.cooldownUntil = 0;
    state.postClearReloadPending = false;
    state.reloadCount = 0;
    state.waiting = false;
    state.cookiesClearedPendingCheck = false;
    try {
        await chrome.tabs.get(tabId);
    } catch (_) {
        browsingPauseStateByTab.delete(tabId);
        console.warn('[BG] Cooldown tab gone; nothing to reopen:', tabId);
        await exitBrowsingPauseSystemHoldIfSafe('cooldown ended (tab gone)');
        return;
    }

    const stillPaused = await tabStillHasBrowsingPause(tabId);
    if (stillPaused) {
        const usedMs = Number(activeMs) || browsingPauseCooldownMsForStreak(streak || 1);
        const clearMode =
            usedMs >= BROWSING_PAUSE_FULL_CLEAR_AFTER_COOLDOWN_MS ? 'full' : 'eticketing';
        const clearLabel =
            clearMode === 'full' ? 'FULL BROWSER CLEAR' : 'ETICKETING COOKIE/SITE-DATA CLEAR';
        console.log(
            `[BG] STEP: ${minsLabel} cooldown END (#${Number(streak) || '?'}) (${now}) tab ${tabId}` +
                ` — ${reason || '(no reason)'}; still paused → ${clearLabel}` +
                ` → wait ${BROWSING_PAUSE_AFTER_CLEAR_RELOAD_MS / 1000}s → Arsenal membership`
        );
        runBrowsingPauseCookieClearThenMembership(
            tabId,
            state,
            'after ' + minsLabel + ' cooldown (still paused)',
            'membership',
            true,
            clearMode,
            {
                cooldownJustEndedMs: usedMs,
                cooldownJustEndedLabel: minsLabel,
                cooldownStreak: Number(streak) || 0
            }
        );
        return;
    }

    console.log(
        `[BG] STEP: ${minsLabel} cooldown END (#${Number(streak) || '?'}) (${now}) tab ${tabId}` +
            ` — ${reason || '(no reason)'}; pause not present → soft membership only (no clear)`
    );
    await softReopenMembershipAfterBrowsingPauseCooldown(tabId, state);
}

async function fetchPublicIpForBrowsingPauseDiscord() {
    try {
        const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
        if (!r.ok) return '(unknown)';
        const j = await r.json();
        if (j && typeof j.ip === 'string' && j.ip.trim()) return j.ip.trim();
    } catch (e) {
        console.warn('[BG] Public IP lookup for browsing-pause Discord failed:', e?.message || e);
    }
    return '(unknown)';
}

/**
 * Discord when browsing-pause recovery is about to clear cookies/site data.
 * Same webhook/fields style as Clear Cookies & refresh; max once per 10 minutes.
 * @param {number} tabId
 * @param {string|{ source?: string, clearMode?: 'eticketing'|'full', whyLabel?: string, restartFreshCycle?: boolean, cooldownJustEndedMs?: number, cooldownJustEndedLabel?: string, cooldownStreak?: number }} sourceOrOpts
 */
async function maybeNotifyBrowsingPauseDiscord(tabId, sourceOrOpts) {
    try {
        const opts =
            sourceOrOpts && typeof sourceOrOpts === 'object'
                ? sourceOrOpts
                : { source: sourceOrOpts };
        const snap = await chrome.storage.local.get([
            BROWSING_PAUSE_DISCORD_LAST_SENT_KEY,
            'startSecond',
            'loginEmail',
            'seatCheck403BackoffTier',
            'eventUrl',
            BROWSING_PAUSE_COOLDOWN_STREAK_KEY
        ]);
        const lastSent = Number(snap[BROWSING_PAUSE_DISCORD_LAST_SENT_KEY]) || 0;
        const now = Date.now();
        if (lastSent > 0 && now - lastSent < BROWSING_PAUSE_DISCORD_COOLDOWN_MS) {
            const remainSec = Math.ceil((BROWSING_PAUSE_DISCORD_COOLDOWN_MS - (now - lastSent)) / 1000);
            console.log(
                '[BG] Browsing-pause Discord skipped — cooldown',
                remainSec + 's left (no spam)'
            );
            return;
        }
        await chrome.storage.local.set({ [BROWSING_PAUSE_DISCORD_LAST_SENT_KEY]: now });

        let tabUrl = '';
        try {
            const tab = await chrome.tabs.get(tabId);
            tabUrl = (tab && (tab.url || tab.pendingUrl)) || '';
        } catch (_) {}

        const ip = await fetchPublicIpForBrowsingPauseDiscord();
        const ss =
            snap.startSecond != null && snap.startSecond !== '' ? String(snap.startSecond) : '(n/a)';
        const em =
            snap.loginEmail && String(snap.loginEmail).trim()
                ? String(snap.loginEmail).trim()
                : '(n/a)';
        const prevTier = Number(snap.seatCheck403BackoffTier) || 0;
        const eventUrl = (snap.eventUrl && String(snap.eventUrl).trim()) || '(n/a)';
        const src = opts.source || 'before-site-data-clear';
        const urlShort =
            tabUrl && tabUrl.length > 160 ? tabUrl.slice(0, 160) + '…' : tabUrl || '(n/a)';

        const clearMode = opts.clearMode === 'full' ? 'full' : 'eticketing';
        const afterClearWaitSec = BROWSING_PAUSE_AFTER_CLEAR_RELOAD_MS / 1000;
        const endedLabel = (opts.cooldownJustEndedLabel || '').toString().trim();
        const endedMs = Number(opts.cooldownJustEndedMs) || 0;
        const streak =
            Number(opts.cooldownStreak) || Number(snap[BROWSING_PAUSE_COOLDOWN_STREAK_KEY]) || 0;
        const afterCooldown = !!(opts.restartFreshCycle || endedLabel || endedMs);
        const endedShown =
            endedLabel ||
            (endedMs > 0 ? browsingPauseCooldownMinutesLabel(endedMs) : '');

        const clearNowLabel =
            clearMode === 'full'
                ? '**full browser cookies clear** (all browsing data, not just eticketing)'
                : '**eticketing cookies only** (www.eticketing.co.uk — not the whole browser)';

        let happened;
        if (afterCooldown) {
            happened =
                'Pause is **still showing** after we sat idle for **' +
                (endedShown || 'a cooldown') +
                '**' +
                (streak ? ' (cooldown #' + streak + ' on 30m → 1h → 2h → 4h)' : '') +
                '. No cookies were cleared during that wait.';
        } else {
            happened =
                'Pause is **still showing** after the **first wait**: 3 min idle → 1 reload → 20s check → 20s more. No long cooldown has run yet.';
        }

        const doingNow =
            '1. Clear ' +
            clearNowLabel +
            '\n' +
            '2. Wait **' +
            afterClearWaitSec +
            ' seconds**\n' +
            '3. Open **Arsenal membership** (JOIN NOW → event)';

        let ifComesBack;
        if (afterCooldown) {
            ifComesBack =
                'Start over from the 3 min wait. Next idle cooldown on the ladder is **30m → 1h → 2h → 4h**. Full browser clear is only used after a **1h / 2h / 4h** wait if still paused.';
        } else {
            ifComesBack =
                'Do **not** clear cookies again immediately. Sit idle: **30m**, then **1h**, then **2h**, then **4h**.\n' +
                '• After **30m**, if still paused → eticketing cookies only again\n' +
                '• After **1h / 2h / 4h**, if still paused → full browser cookies clear';
        }

        const message =
            '**Browsing activity paused**\n' +
            '📧 **loginEmail:** ' +
            em +
            '\n' +
            '📊 **startSecond:** ' +
            ss +
            '\n' +
            '🌐 **Public IP:** ' +
            ip +
            '\n' +
            '📈 **seatCheck403BackoffTier:** ' +
            prevTier +
            '\n' +
            '🔗 **eventUrl:** ' +
            eventUrl +
            '\n' +
            '📄 **Tab URL:** ' +
            urlShort +
            '\n\n' +
            '**What happened**\n' +
            happened +
            '\n\n' +
            '**Doing now**\n' +
            doingNow +
            '\n\n' +
            '**If pause comes back after this**\n' +
            ifComesBack;

        console.log('[BG] Sending browsing-pause Discord notification (before cookie/site-data clear)');
        await sendErrorWebhook(SEAT_CHECK_COOKIE_CLEAR_DISCORD_WEBHOOK, message, {
            kind: 'browsing_activity_paused',
            startSecond: ss,
            loginEmail: em,
            publicIp: ip,
            prevTier,
            source: src,
            tabId,
            tabUrl: urlShort,
            eventUrl,
            clearMode,
            cooldownJustEnded: endedLabel || (endedMs > 0 ? browsingPauseCooldownMinutesLabel(endedMs) : ''),
            cooldownStreak: streak
        });
    } catch (e) {
        console.warn('[BG] browsing-pause Discord notify failed:', e?.message || e);
    }
}

function browsingPausePendingTabIdMatches(stored, tabId) {
    if (stored == null || tabId == null) return false;
    return Number(stored) === Number(tabId);
}

/** Restore post-clear pending from storage; never clear a true in-memory flag here. */
function syncBrowsingPausePendingFromStorage(state, tabId, snap) {
    if (!state || tabId == null) return;
    if (browsingPausePendingTabIdMatches(snap[BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY], tabId)) {
        state.cookiesClearedPendingCheck = true;
    }
}

async function startBrowsingPauseCooldownAfterClearMembership(tabId, state, source) {
    const cooldownMs = await peekNextBrowsingPauseCooldownMs();
    const coolUntil = formatBrowsingPauseClock(Date.now() + cooldownMs);
    const src = source || 'after-clear-membership';
    console.warn(
        `[BG] STEP: pause again after clear + membership on tab ${tabId} via ${src}` +
            ` — starting ${browsingPauseCooldownMinutesLabel(cooldownMs)} cooldown (until ${coolUntil})` +
            ` → idle → then re-check (eticketing clear after 30m; full clear after 1h+) → Arsenal membership → restart quiet cycle`
    );
    await startPostCookieBrowsingPauseCooldown(tabId, state);
}

/**
 * Grace ended and pause still present — start cooldown if post-clear pending, else first recovery.
 * Uses closure state so we do not lose cookiesClearedPendingCheck after clear + membership.
 */
function noteBrowsingPauseStillPresentAfterGrace(tabId, state, source) {
    chrome.storage.local.get([BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY], (snap) => {
        if (chrome.runtime.lastError) {
            noteBrowsingActivityPausedTabContinue(tabId, source, state || getBrowsingPauseState(tabId));
            return;
        }
        const s = state || getBrowsingPauseState(tabId);
        syncBrowsingPausePendingFromStorage(s, tabId, snap);
        if (s.cookiesClearedPendingCheck) {
            void startBrowsingPauseCooldownAfterClearMembership(tabId, s, source);
            return;
        }
        noteBrowsingActivityPausedTabContinue(tabId, source, s);
    });
}

function onBrowsingPauseWaitElapsed(tabId, state) {
    if (lastStatus === 'off') {
        state.deferredAction = 'waitElapsed';
        console.log('[BG] Sheet Off — defer browsing-pause wait elapsed on tab', tabId);
        return;
    }
    const src = state.waitSrc || 'poll';
    const isWebIdentitySrc =
        src === 'web-identity-stuck' ||
        src === 'web-identity-dom' ||
        src.indexOf('web-identity') === 0 ||
        src.indexOf('web-identity-') === 0;
    const fromContent = src === 'content-script' || src.indexOf('content-script') === 0;
    chrome.tabs.get(tabId, (updatedTab) => {
        if (chrome.runtime.lastError || !updatedTab) {
            void releaseBrowsingPauseBecauseTabGone(tabId, 'paused tab closed');
            return;
        }

        const tabUrl = updatedTab.url || updatedTab.pendingUrl || '';
        const onWebIdentity = tabUrlIsWebIdentity(tabUrl) || tabUrlIsWebIdentityAuthorize(tabUrl);
        const titlePaused = tabTitleIsBrowsingPaused(updatedTab.title);
        const stuckAuth = tabUrlIsWebIdentityAuthorize(tabUrl);

        const continueRecovery = (why) => {
            console.warn('[BG] Still paused after wait —', why);
            reloadAfterBrowsingPause(tabId, state);
        };

        if (onWebIdentity || isWebIdentitySrc) {
            if (titlePaused || stuckAuth) {
                continueRecovery(
                    titlePaused
                        ? 'still paused on web-identity after wait'
                        : 'still stuck on /connect/authorize after wait'
                );
                return;
            }
            chrome.tabs.sendMessage(tabId, { action: 'isBrowsingActivityPaused' }, (resp) => {
                if (chrome.runtime.lastError) {
                    if (stuckAuth || onWebIdentity) {
                        continueRecovery('web-identity after wait (no CS probe)');
                        return;
                    }
                    state.reloadCount = 0;
                    void exitBrowsingPauseSystemHoldIfSafe('web-identity probe failed / assume clear');
                    return;
                }
                if (resp && resp.paused) {
                    continueRecovery('web-identity DOM still paused after wait');
                } else if (stuckAuth) {
                    continueRecovery('still on authorize after wait');
                } else {
                    console.log(`[BG] Web-identity browsing pause cleared on tab ${tabId}`);
                    state.reloadCount = 0;
                    void exitBrowsingPauseSystemHoldIfSafe('web-identity cleared after wait');
                }
            });
            return;
        }

        if (titlePaused) {
            continueRecovery('browsing pause still present after wait');
            return;
        }
        const onEventIndex = tabUrlIsEventIndex(updatedTab.url) || tabUrlIsEventIndex(updatedTab.pendingUrl);
        if (onEventIndex) {
            chrome.storage.local.get([EVENT_PAGE_READY_KEY], (st) => {
                if (st[EVENT_PAGE_READY_KEY] !== true) {
                    console.warn(
                        `[BG] Event Index on tab ${tabId} after wait but eventPageReady/token not set — continuing recovery`
                    );
                    void enterBrowsingPauseSystemHold('event Index without token tab ' + tabId);
                    continueRecovery('event Index without token after wait');
                    return;
                }
                console.log(`[BG] Browsing pause cleared on tab ${tabId} (eventPageReady=true), no further action.`);
                state.reloadCount = 0;
                void exitBrowsingPauseSystemHoldIfSafe('title cleared + eventPageReady');
            });
            return;
        }
        if (!fromContent) {
            console.log(`[BG] Browsing pause cleared on tab ${tabId}, no further action.`);
            state.reloadCount = 0;
            void exitBrowsingPauseSystemHoldIfSafe('title cleared after wait');
            return;
        }
        chrome.tabs.sendMessage(tabId, { action: 'isBrowsingActivityPaused' }, (resp) => {
            if (chrome.runtime.lastError) {
                console.warn('[BG] isBrowsingActivityPaused probe failed:', chrome.runtime.lastError.message);
                state.reloadCount = 0;
                void exitBrowsingPauseSystemHoldIfSafe('probe failed / assume clear');
                return;
            }
            if (resp && resp.paused) {
                continueRecovery('content still reports pause after wait');
            } else {
                console.log(`[BG] Content reports browsing pause cleared on tab ${tabId}`);
                state.reloadCount = 0;
                void exitBrowsingPauseSystemHoldIfSafe('content reports clear');
            }
        });
    });
}

function noteBrowsingActivityPausedTab(tabId, source) {
    if (tabId == null) return;
    if (lastStatus === 'off') {
        console.log('[BG] Sheet Off — ignore browsing-pause detect on tab', tabId, 'via', source || 'poll');
        return;
    }
    const state = getBrowsingPauseState(tabId);
    if (state.cooldownUntil > Date.now()) {
        return; // already in post-cookie cooldown
    }
    if (state.waiting || state.postClearReloadPending) {
        if (state.postClearReloadPending) {
            console.log(
                '[BG] Ignoring pause detect during clear + membership wait on tab',
                tabId,
                'via',
                source || 'poll'
            );
        }
        return;
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
            syncBrowsingPausePendingFromStorage(state, tabId, snap);
            noteBrowsingActivityPausedTabContinue(tabId, source, state);
        }
    );
}

function noteBrowsingActivityPausedTabContinue(tabId, source, state) {
    if (lastStatus === 'off') {
        console.log('[BG] Sheet Off — ignore browsing-pause continue on tab', tabId);
        return;
    }
    if (state.waiting || state.postClearReloadPending) {
        if (state.postClearReloadPending) {
            console.log(
                '[BG] Ignoring pause detect during clear + membership wait on tab',
                tabId,
                'via',
                source || 'poll'
            );
        } else {
            console.log(
                '[BG] Ignoring pause detect — already waiting on tab',
                tabId,
                'via',
                source || 'poll'
            );
        }
        return;
    }
    // Do not start a second wait timer while grace is in progress
    if (state.timerId != null) {
        console.log('[BG] Ignoring pause detect — wait timer already armed on tab', tabId);
        return;
    }

    const src = source || 'poll';
    const gLabel = browsingPauseGraceSecondsLabel(BROWSING_PAUSE_POST_ACTION_GRACE_MS);

    // After reload / membership open: wait grace before deciding pause still present / pause-again
    if (state.postActionGraceUntil > Date.now()) {
        const remain = Math.max(50, state.postActionGraceUntil - Date.now());
        console.log(
            `[BG] Pause detect during ${gLabel} grace on tab ${tabId} via ${src}` +
                ` — deferring decision until ${formatBrowsingPauseClock(state.postActionGraceUntil)}` +
                (state.cookiesClearedPendingCheck
                    ? ' (then may start long cooldown 30m→1h→2h→4h)'
                    : '')
        );
        if (state.postActionGraceTimerId != null) clearTimeout(state.postActionGraceTimerId);
        state.postActionGraceTimerId = setTimeout(() => {
            state.postActionGraceTimerId = null;
            if (lastStatus === 'off') {
                console.log('[BG] Sheet Off — defer grace-end decision on tab', tabId);
                return;
            }
            state.postActionGraceUntil = 0;
            chrome.storage.local.get([BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY], (snap) => {
                syncBrowsingPausePendingFromStorage(state, tabId, snap);
                console.log(
                    `[BG] STEP: ${gLabel} grace ended (${formatBrowsingPauseClock(Date.now())}) on tab ${tabId}` +
                        ' — re-checking if browsing pause / web-identity still present' +
                        (state.cookiesClearedPendingCheck ? ' (post-clear pending → cooldown if still paused)' : '')
                );
                chrome.tabs.get(tabId, (tab) => {
                    if (chrome.runtime.lastError || !tab) return;
                    const tabUrl = tab.url || tab.pendingUrl || '';
                    const onWebIdentity =
                        tabUrlIsWebIdentity(tabUrl) || tabUrlIsWebIdentityAuthorize(tabUrl);
                    const stuckAuth = tabUrlIsWebIdentityAuthorize(tabUrl);
                    if (tabTitleIsBrowsingPaused(tab.title)) {
                        noteBrowsingPauseStillPresentAfterGrace(
                            tabId,
                            state,
                            onWebIdentity ? 'web-identity-after-grace' : 'after-grace'
                        );
                        return;
                    }
                    const onEventIndex =
                        tabUrlIsEventIndex(tab.url) || tabUrlIsEventIndex(tab.pendingUrl);
                    chrome.tabs.sendMessage(tabId, { action: 'isBrowsingActivityPaused' }, (resp) => {
                        const probePaused = !chrome.runtime.lastError && resp && resp.paused;
                        const stuckFromProbe =
                            !chrome.runtime.lastError &&
                            resp &&
                            (resp.stuckAuthorize === true || resp.stuckConfirmed === true);
                        if (probePaused || stuckFromProbe || stuckAuth) {
                            noteBrowsingPauseStillPresentAfterGrace(
                                tabId,
                                state,
                                stuckAuth || stuckFromProbe
                                    ? 'web-identity-stuck-after-grace'
                                    : onWebIdentity
                                      ? 'web-identity-dom-after-grace'
                                      : 'after-grace'
                            );
                            return;
                        }
                        if (chrome.runtime.lastError && stuckAuth) {
                            noteBrowsingPauseStillPresentAfterGrace(
                                tabId,
                                state,
                                'web-identity-stuck-after-grace'
                            );
                            return;
                        }
                        if (onEventIndex) {
                            chrome.storage.local.get([EVENT_PAGE_READY_KEY], (st) => {
                                if (st[EVENT_PAGE_READY_KEY] !== true) {
                                    noteBrowsingPauseStillPresentAfterGrace(
                                        tabId,
                                        state,
                                        'event-index-no-token-after-grace'
                                    );
                                } else {
                                    console.log(
                                        `[BG] After ${gLabel} grace — event Index OK (token ready) on tab ${tabId}`
                                    );
                                }
                            });
                            return;
                        }
                        if (onWebIdentity) {
                            noteBrowsingPauseStillPresentAfterGrace(
                                tabId,
                                state,
                                'web-identity-after-grace'
                            );
                            return;
                        }
                        if (state.cookiesClearedPendingCheck) {
                            console.log(
                                `[BG] After ${gLabel} grace — pause not present on tab ${tabId}; pending kept until recovery or timeout`
                            );
                            return;
                        }
                        console.log(
                            `[BG] After ${gLabel} grace — browsing pause / web-identity cleared on tab ${tabId}`
                        );
                        state.reloadCount = 0;
                        void exitBrowsingPauseSystemHoldIfSafe('pause cleared after reload grace');
                    });
                });
            });
        }, remain);
        return;
    }
    state.postActionGraceUntil = 0;

    const isWebIdentitySrc =
        src === 'web-identity-stuck' ||
        src === 'web-identity-dom' ||
        src.indexOf('web-identity') === 0 ||
        src.indexOf('web-identity-') === 0;

    const startFreshCycleOrCooldown = () => {
        // After eticketing clear + membership, pause again → long cooldown only (no immediate re-clear)
        if (state.cookiesClearedPendingCheck) {
            void startBrowsingPauseCooldownAfterClearMembership(tabId, state, src);
            return;
        }

        state.waiting = true;
        void enterBrowsingPauseSystemHold('tab ' + tabId + ' via ' + src);
        const maxReloads = BROWSING_PAUSE_RELOADS_BEFORE_SITE_DATA_CLEAR;
        let waitMs = BROWSING_PAUSE_WAIT_MS;
        let waitLabel = isWebIdentitySrc ? 'Web-identity browsing pause' : 'Browsing-activity pause';
        let nextAction = `reload ${(state.reloadCount || 0) + 1}/${maxReloads}`;
        // After reload 1/1 + grace, wait 20s then eticketing clear if still paused
        if (state.reloadCount >= maxReloads) {
            waitMs = BROWSING_PAUSE_POST_RELOADS_BEFORE_CLEAR_MS;
            nextAction = 'eticketing cookie/site-data clear → Arsenal membership';
            if (src.indexOf('event-index-no-token') === 0) {
                waitLabel =
                    'event Index without token (post-' +
                    maxReloads +
                    '/' +
                    maxReloads +
                    ' → eticketing clear)';
            } else {
                waitLabel =
                    (isWebIdentitySrc ? 'Web-identity pause' : 'Browsing-activity pause') +
                    ' (post-' +
                    maxReloads +
                    '/' +
                    maxReloads +
                    ' → eticketing clear)';
            }
        } else if (src.indexOf('event-index-no-token') === 0) {
            waitLabel = 'event Index without token';
        }

        console.log(
            `[BG] ${waitLabel} on tab ${tabId} via ${src}` +
                ` (reload count ${state.reloadCount}/${maxReloads})` +
                `, ${browsingPauseScheduleSuffix(waitMs, nextAction)}`
        );

        state.waitSrc = src;
        state.waitUntil = Date.now() + waitMs;
        state.timerId = setTimeout(() => {
            state.timerId = null;
            state.waiting = false;
            state.waitUntil = 0;
            onBrowsingPauseWaitElapsed(tabId, state);
        }, waitMs);
    };

    if (state.cookiesClearedPendingCheck) {
        startFreshCycleOrCooldown();
        return;
    }
    chrome.storage.local.get([BROWSING_PAUSE_COOKIES_CLEARED_PENDING_TAB_KEY], (snap) => {
        syncBrowsingPausePendingFromStorage(state, tabId, snap);
        startFreshCycleOrCooldown();
    });
}

function clearBrowsingPauseRecoverySuccess(tabId, state, reason) {
    // Post-clear pending: title may look healthy briefly after membership while pause can still return.
    // Only the 5 min post-clear timer or cooldown path may clear cookiesClearedPendingCheck.
    if (state.cookiesClearedPendingCheck) {
        return;
    }
    if (state.postActionGraceUntil > Date.now()) {
        return;
    }
    if (state.reloadCount > 0) {
        state.reloadCount = 0;
    }
    void exitBrowsingPauseSystemHoldIfSafe(reason);
}

function probeTabForBrowsingPauseDom(tabId, source) {
    chrome.tabs.sendMessage(tabId, { action: 'isBrowsingActivityPaused' }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.paused) {
            noteBrowsingActivityPausedTab(tabId, source || 'dom-probe');
        }
    });
}

function monitorBrowsingActivityTabs() {
    const CHECK_INTERVAL = 5000;

    setInterval(() => {
        if (lastStatus === 'off') return;
        queryBrowsingPauseWatchTabs((tabs) => {
            if (chrome.runtime.lastError) return;
            const seen = new Set();
            for (const tab of tabs || []) {
                if (tab.id == null) continue;
                seen.add(tab.id);

                const url = tab.url || tab.pendingUrl || '';
                const onWebIdentityAuth = tabUrlIsWebIdentityAuthorize(url);

                // Stuck on web-identity authorize (redirect never finishes) → same as browsing pause
                if (onWebIdentityAuth) {
                    if (!webIdentityAuthorizeSeenAt.has(tab.id)) {
                        webIdentityAuthorizeSeenAt.set(tab.id, Date.now());
                    } else if (Date.now() - webIdentityAuthorizeSeenAt.get(tab.id) >= WEB_IDENTITY_STUCK_MS) {
                        noteBrowsingActivityPausedTab(tab.id, 'web-identity-stuck');
                    }
                    // Title often lags; also probe DOM for abuse-component
                    if (!tabTitleIsBrowsingPaused(tab.title)) {
                        probeTabForBrowsingPauseDom(tab.id, 'web-identity-dom');
                    }
                } else {
                    webIdentityAuthorizeSeenAt.delete(tab.id);
                }

                if (!tabTitleIsBrowsingPaused(tab.title)) {
                    const s = browsingPauseStateByTab.get(tab.id);
                    // Title healthy again — end recovery streak and release hold only if truly recovered.
                    if (
                        s &&
                        !s.waiting &&
                        !s.postClearReloadPending &&
                        !s.cookiesClearedPendingCheck &&
                        !(s.postActionGraceUntil > Date.now()) &&
                        !(s.cooldownUntil > Date.now())
                    ) {
                        const onEventIndex =
                            tabUrlIsEventIndex(tab.url) || tabUrlIsEventIndex(tab.pendingUrl);
                        if (onEventIndex) {
                            chrome.storage.local.get([EVENT_PAGE_READY_KEY], (st) => {
                                if (st[EVENT_PAGE_READY_KEY] !== true) {
                                    void enterBrowsingPauseSystemHold(
                                        'event Index without token on tab ' + tab.id
                                    );
                                    if (
                                        !s.waiting &&
                                        !s.postClearReloadPending &&
                                        !(s.cooldownUntil > Date.now())
                                    ) {
                                        noteBrowsingActivityPausedTab(tab.id, 'event-index-no-token');
                                    }
                                    return;
                                }
                                clearBrowsingPauseRecoverySuccess(
                                    tab.id,
                                    s,
                                    'title healthy + eventPageReady on tab ' + tab.id
                                );
                            });
                            continue;
                        }
                        // web-identity: confirm DOM cleared before releasing
                        if (tabUrlIsWebIdentity(url) || onWebIdentityAuth) {
                            chrome.tabs.sendMessage(
                                tab.id,
                                { action: 'isBrowsingActivityPaused' },
                                (resp) => {
                                    if (chrome.runtime.lastError) {
                                        // No content script — if authorize stuck tracker cleared, allow exit
                                        if (!onWebIdentityAuth) {
                                            clearBrowsingPauseRecoverySuccess(
                                                tab.id,
                                                s,
                                                'web-identity title healthy (no CS) tab ' + tab.id
                                            );
                                        }
                                        return;
                                    }
                                    if (resp && resp.paused) {
                                        noteBrowsingActivityPausedTab(tab.id, 'web-identity-dom');
                                        return;
                                    }
                                    clearBrowsingPauseRecoverySuccess(
                                        tab.id,
                                        s,
                                        'web-identity recovered on tab ' + tab.id
                                    );
                                }
                            );
                            continue;
                        }
                        clearBrowsingPauseRecoverySuccess(tab.id, s, 'title healthy on tab ' + tab.id);
                    }
                    continue;
                }
                noteBrowsingActivityPausedTab(
                    tab.id,
                    tabUrlIsWebIdentity(url) || onWebIdentityAuth ? 'web-identity-dom' : 'title-poll'
                );
            }
            for (const id of [...browsingPauseStateByTab.keys()]) {
                if (!seen.has(id)) {
                    webIdentityAuthorizeSeenAt.delete(id);
                    void releaseBrowsingPauseBecauseTabGone(
                        id,
                        'paused tab left eticketing/web-identity / closed (' + id + ')'
                    );
                }
            }
            void reconcileStaleBrowsingPauseHold('title-poll reconcile');
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


