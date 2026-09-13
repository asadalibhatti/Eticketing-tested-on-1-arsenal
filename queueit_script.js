// queueit_script.js

console.log("[QueueIt Script] Script loaded on:", window.location.href);

/** Wait this long on captcha (reCAPTCHA / Botdeflector / BotDetect) before hd-queue URL recovery. */
const HD_QUEUE_CAPTCHA_RECOVERY_WAIT_MS = 15000;
const RECAPTCHA_SOLVE_TIMEOUT_PEOPLE_AHEAD_MS = 180000; // ~3 minutes
const NO_RECAPTCHA_IFRAME_REDIRECT_SEC = 50;
const NO_RECAPTCHA_IFRAME_REDIRECT_PEOPLE_AHEAD_SEC = 180; // ~3 minutes

/** Returns true if the page shows \"people ahead of you\", the main queue progress bar, or the \"Your queue position will be updated in:\" warning box (user is in queue and must wait). */
function hasPeopleAheadOfYouVisible() {
    // Check for "people ahead of you" text
    const peopleAheadEl = document.querySelector('#MainPart_lbUsersInLineAheadOfYouText');
    if (peopleAheadEl) {
        const text = (peopleAheadEl.textContent || '').trim();
        if (text.indexOf('people ahead of you') !== -1) {
            const style = window.getComputedStyle(peopleAheadEl);
            if (style.display !== 'none' && style.visibility !== 'hidden' && peopleAheadEl.offsetParent !== null) {
                return true;
            }
        }
    }
    
    // Check for progress bar (queue position update indicator)
    const progressBar = document.querySelector('#MainPart_divProgressbar');
    if (progressBar) {
        const style = window.getComputedStyle(progressBar);
        if (style.display !== 'none' && style.visibility !== 'hidden' && progressBar.offsetParent !== null) {
            return true;
        }
    }

    // Check for \"Your queue position will be updated in:\" warning box (same waiting state)
    const warningBoxTextEl = document.querySelector('.warning-box p.extrabeforeElement');
    if (warningBoxTextEl) {
        const text = (warningBoxTextEl.textContent || '').trim().toLowerCase();
        if (text.indexOf('your queue position will be updated in') !== -1) {
            const style = window.getComputedStyle(warningBoxTextEl);
            if (style.display !== 'none' && style.visibility !== 'hidden' && warningBoxTextEl.offsetParent !== null) {
                return true;
            }
        }
    }
    
    return false;
}

/**
 * True only when #buttonConfirmVisitorPresence shows the clickable "Yes, I'm here" label (not the hidden KO template).
 * Button `textContent` still includes "I'm here" from a `display:none` span — must check visibility.
 */
function isVisitorPresenceImHerePromptVisible(button) {
    if (!button) return false;
    const spans = button.querySelectorAll('span.l');
    for (let i = 0; i < spans.length; i++) {
        const sp = spans[i];
        const raw = (sp.textContent || '').replace(/\s+/g, ' ').trim();
        if (raw.indexOf("I'm here") === -1) continue;
        const st = window.getComputedStyle(sp);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
        const r = sp.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        return true;
    }
    return false;
}

function isVisitorPresenceButtonClickable(button) {
    if (!button) return false;
    if (button.disabled) return false;
    if (button.hasAttribute('disabled')) return false;
    if (button.getAttribute('aria-disabled') === 'true') return false;
    return true;
}

/** Send setQueueWaiting message to background every 3s so background knows we're still in queue; background clears flag if no message in 10s. */
function sendQueueWaitingToBackground() {
    const onQueueUrl = window.location.href.startsWith('https://hd-queue.eticketing.co.uk') ||
        window.location.href.startsWith('http://hd-queue.eticketing.co.uk');
    const waiting = onQueueUrl && looksLikeQueueItWaitingRoom();
    if (waiting) queueFlagEverSeen = true;
    chrome.runtime.sendMessage({ action: 'setQueueWaiting', inQueueWaiting: waiting }, () => {
        if (chrome.runtime.lastError) return;
        if (waiting) console.log("[QueueIt Script] In queue (people ahead or progress bar visible) - sent setQueueWaiting true");
    });
}

let queueFlagEverSeen = false; // true if "people ahead" or progress bar has been visible at any time on this page
let joinWaitingRoomButtonClicked = false; // track if "Join waiting room" button was clicked
let confirmRedirectButtonClicked = false; // track if "Yes, please" confirm redirect button was clicked
let getNewPlaceInQueueClicked = false; // track if "Get a new place in the queue" link was clicked
let confirmVisitorPresenceClicked = false; // "Yes, I'm here" (#buttonConfirmVisitorPresence)
let captchaCodeLabelHandled = false; // legacy flag; BotDetect handling uses appearance count below
let browsingPausedUntil = 0; // when \"Your browsing activity has been paused\" was seen; back off actions for 60s
/** After this many captcha appearances during URL recovery, solve via 2captcha. */
const BOTDETECT_CAPTCHA_2CAPTCHA_THRESHOLD = 2;
/** Shared sticky count for BotDetect + Botdeflector — after threshold, keep using 2captcha (no recovery reset). */
const HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY = 'hdQueueBotDetectCaptchaCount';
let hdQueueRecoveryTriggered = false; // captcha/error403 handled once per page state
/** Count captcha once per page load (persisted count spans recovery navigations). */
let botDetectAppearanceCountedThisPage = false;
/** Softblock BotDetect + 2captcha: only start one BG solve per load; gotResponse clears "wait for API" for manual fallback. */
let softblock2CaptchaStarted = false;
let softblock2CaptchaGotResponse = false;
let botdetectManualListenerAttached = false;
/** Botdeflector icon-sequence 2captcha state (after recovery threshold). */
let botdeflector2CaptchaStarted = false;
let botdeflector2CaptchaGotResponse = false;
let botdeflector2CaptchaRetryAfterMs = 0;
let botdeflectorCheckboxClicked = false;
let lastBotdeflectorChallengeKey = '';
/**
 * After icon clicks: wait to see accept vs reject (new images → retry 2captcha).
 * Count stays sticky after threshold (same as BotDetect). Rejection only after grace period.
 */
let botdeflectorAwaitingOutcome = false;
let botdeflectorAwaitingOutcomeUntil = 0;
const BOTDEFLECTOR_OUTCOME_GRACE_MS = 5000;

function clearBotdeflectorAwaitingOutcome() {
    botdeflectorAwaitingOutcome = false;
    botdeflectorAwaitingOutcomeUntil = 0;
}

function getBotdeflectorChallengeKey() {
    const { bg, icons } = getBotdeflectorChallengeImageEls();
    return (
        ((bg && (bg.currentSrc || bg.src)) || '') +
        '|' +
        ((icons && (icons.currentSrc || icons.src)) || '')
    );
}

/** Forward important Queue-IT logs to background (survives softblock reload). */
function queueItLog(message, detail) {
    const text = String(message || '');
    if (detail !== undefined) {
        console.log('[QueueIt Script]', text, detail);
    } else {
        console.log('[QueueIt Script]', text);
    }
    try {
        chrome.runtime.sendMessage(
            {
                action: 'queueItForwardLog',
                message: text,
                detail: detail != null ? String(detail) : '',
                href: String(location.href || '').slice(0, 220)
            },
            () => {
                void chrome.runtime.lastError;
            }
        );
    } catch (_) {}
}

function queueItWarn(message, detail) {
    const text = String(message || '');
    if (detail !== undefined) {
        console.warn('[QueueIt Script]', text, detail);
    } else {
        console.warn('[QueueIt Script]', text);
    }
    try {
        chrome.runtime.sendMessage(
            {
                action: 'queueItForwardLog',
                level: 'warn',
                message: text,
                detail: detail != null ? String(detail) : '',
                href: String(location.href || '').slice(0, 220)
            },
            () => {
                void chrome.runtime.lastError;
            }
        );
    } catch (_) {}
}

function isHdQueueError403Page() {
    try {
        const host = (window.location.hostname || '').toLowerCase();
        if (host !== 'hd-queue.eticketing.co.uk') return false;
        return (window.location.pathname || '').toLowerCase().indexOf('/error403') !== -1;
    } catch (_) {
        return false;
    }
}

function looksLikeQueueItWaitingRoom() {
    if (hasPeopleAheadOfYouVisible()) return true;
    if (isSoftblockQueueUrl()) return true;
    try {
        const path = (window.location.pathname || '').toLowerCase();
        if (path.indexOf('/view') !== -1) return true;
    } catch (_) {}
    try {
        const body = ((document.body && document.body.innerText) || '').toLowerCase();
        if (body.indexOf('you will be automatically directed') !== -1) return true;
        if (body.indexOf("when it's your turn") !== -1 || body.indexOf('when it’s your turn') !== -1) return true;
        if (body.indexOf('queue id:') !== -1) return true;
    } catch (_) {}
    return false;
}

let captchaRecoveryWaitTimerId = null;
let captchaRecoveryWaitKind = '';
let captchaRecoveryWaitLogged = false;

function hasBotDetectCaptchaUi() {
    const captchaImg = document.querySelector('img.captcha-code');
    const captchaIn = document.querySelector('input#solution');
    const submitBtn = findBotdetectImNotRobotButton();
    const label = document.querySelector('label#captcha-code-label[for="CaptchaCode"]');
    const labelOk = label && (label.textContent || '').indexOf('Enter the code from the picture') !== -1;
    return !!(captchaImg && captchaIn && submitBtn && labelOk);
}

/** Which captcha is blocking the page, if any. */
function getActiveHdQueueCaptchaKind() {
    if (document.querySelector('iframe[title="recaptcha challenge expires in two minutes"]')) {
        return 'reCAPTCHA';
    }
    if (
        (isBotdeflectorChallengeVisible() || isBotdeflectorIconChallengeVisible()) &&
        !hasBotDetectCaptchaUi()
    ) {
        return 'Botdeflector';
    }
    if (hasBotDetectCaptchaUi()) {
        return 'BotDetect';
    }
    return '';
}

function cancelHdQueueCaptchaRecoveryWait(reason) {
    if (captchaRecoveryWaitTimerId == null) return;
    clearTimeout(captchaRecoveryWaitTimerId);
    captchaRecoveryWaitTimerId = null;
    captchaRecoveryWaitKind = '';
    captchaRecoveryWaitLogged = false;
    if (reason) queueItLog('Captcha recovery wait cancelled: ' + reason);
}

/**
 * Captcha on hd-queue (incl. /softblock): wait 30s, then URL rotation recovery if still stuck.
 * Does not run while 2captcha auto-solve is active (BotDetect threshold).
 */
function scheduleHdQueueCaptchaRecoveryAfterWait(reason) {
    if (hdQueueRecoveryTriggered || captchaRecoveryWaitTimerId != null) return;
    if (softblock2CaptchaStarted || botdeflector2CaptchaStarted) return;
    if (botdeflectorAwaitingOutcome) return;
    const kind = getActiveHdQueueCaptchaKind();
    if (!kind) return;

    captchaRecoveryWaitKind = kind;
    if (!captchaRecoveryWaitLogged) {
        captchaRecoveryWaitLogged = true;
        queueItLog(
            kind +
                ' captcha visible — waiting ' +
                HD_QUEUE_CAPTCHA_RECOVERY_WAIT_MS / 1000 +
                's before hd-queue URL recovery' +
                (reason ? ' (' + reason + ')' : '')
        );
    }

    captchaRecoveryWaitTimerId = setTimeout(() => {
        captchaRecoveryWaitTimerId = null;
        captchaRecoveryWaitLogged = false;
        if (hdQueueRecoveryTriggered) return;

        const stillKind = getActiveHdQueueCaptchaKind();
        const queueProgress = hasPeopleAheadOfYouVisible();
        if (!stillKind && queueProgress) {
            queueItLog('Captcha cleared within 30s and queue progressing — skip recovery');
            captchaRecoveryWaitKind = '';
            return;
        }
        if (!stillKind && !queueProgress) {
            queueItLog('Captcha cleared within 30s — skip recovery');
            captchaRecoveryWaitKind = '';
            return;
        }

        hdQueueRecoveryTriggered = true;
        const label = stillKind || captchaRecoveryWaitKind || 'Captcha';
        captchaRecoveryWaitKind = '';
        queueItLog(
            label +
                ' still present after ' +
                HD_QUEUE_CAPTCHA_RECOVERY_WAIT_MS / 1000 +
                's — triggering hd-queue URL recovery'
        );
        chrome.runtime.sendMessage(
            {
                action: 'error403Detected',
                fromHdQueueError403: true,
                fromHdQueueCaptchaRecovery: true,
                captchaKind: label
            },
            () => {
                if (chrome.runtime.lastError) {
                    queueItWarn('error403Detected error: ' + (chrome.runtime.lastError.message || ''));
                }
            }
        );
    }, HD_QUEUE_CAPTCHA_RECOVERY_WAIT_MS);
}

function triggerHdQueueRecoverySequence(reason) {
    if (hdQueueRecoveryTriggered) return;
    hdQueueRecoveryTriggered = true;
    cancelHdQueueCaptchaRecoveryWait();
    console.log('[QueueIt Script] Triggering hd-queue recovery sequence:', reason);
    chrome.runtime.sendMessage(
        {
            action: 'error403Detected',
            fromHdQueueError403: true,
            fromHdQueueCaptchaRecovery: true
        },
        () => {
            if (chrome.runtime.lastError) {
                console.error('[QueueIt Script] error403Detected error:', chrome.runtime.lastError);
            }
        }
    );
}

function isSoftblockQueueUrl() {
    const u = window.location.href || '';
    return (
        u.startsWith('https://hd-queue.eticketing.co.uk/softblock/') ||
        u.startsWith('http://hd-queue.eticketing.co.uk/softblock/')
    );
}

/** Queue-IT /view page — only "Join waiting room" + "Yes, please" (gated); no captcha/other buttons. */
function isHdQueueViewUrl() {
    try {
        const host = (window.location.hostname || '').toLowerCase();
        if (host !== 'hd-queue.eticketing.co.uk') return false;
        return (window.location.pathname || '').toLowerCase().indexOf('/view') !== -1;
    } catch (_) {
        const u = (window.location.href || '').toLowerCase();
        return u.indexOf('hd-queue.eticketing.co.uk') !== -1 && u.indexOf('/view') !== -1;
    }
}

function normalizeQueueButtonText(el) {
    return ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
}

/**
 * Click only a visible button whose text is exactly "Join waiting room".
 * Never clicks other botdetect / generic buttons.
 */
function tryClickJoinWaitingRoomButton() {
    if (joinWaitingRoomButtonClicked) return false;
    const buttons = document.querySelectorAll('button.botdetect-button.btn, button.btn, button');
    for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        if (btn.id === 'buttonConfirmRedirect' || btn.id === 'buttonConfirmVisitorPresence') continue;
        const buttonText = normalizeQueueButtonText(btn);
        if (buttonText !== 'Join waiting room') continue;
        if (typeof isElementVisiblyShown === 'function' && !isElementVisiblyShown(btn)) continue;
        joinWaitingRoomButtonClicked = true;
        // New Join round may show Yes please again
        confirmRedirectButtonClicked = false;
        queueItLog("'Join waiting room' button found (exact text) — clicking");
        btn.click();
        return true;
    }
    return false;
}

/**
 * Click only #buttonConfirmRedirect when its visible text is exactly "Yes, please".
 * Never clicks other confirm / presence buttons.
 */
function tryClickConfirmRedirectYesPleaseButton() {
    if (confirmRedirectButtonClicked) return false;
    const confirmRedirectButton = document.querySelector('button#buttonConfirmRedirect');
    if (!confirmRedirectButton) return false;
    const text = normalizeQueueButtonText(confirmRedirectButton);
    if (text !== 'Yes, please') return false;
    if (typeof isElementVisiblyShown === 'function' && !isElementVisiblyShown(confirmRedirectButton)) {
        return false;
    }
    confirmRedirectButtonClicked = true;
    queueItLog("'Yes, please' (#buttonConfirmRedirect, exact text) — clicking");
    confirmRedirectButton.click();
    return true;
}

/**
 * /view click gate:
 * 1) Wait for / click "Join waiting room" first (exact text only).
 * 2) After Join clicked — skip all other buttons except "Yes, please".
 * 3) After "Yes, please" clicked — allow "Join waiting room" again.
 * No other buttons on /view.
 */
function runHdQueueViewOnlyButtonClicks() {
    if (!joinWaitingRoomButtonClicked) {
        tryClickJoinWaitingRoomButton();
        // Do not click Yes please (or anything else) until Join has been clicked once
        return;
    }
    // Join already clicked — only Yes please is allowed
    if (tryClickConfirmRedirectYesPleaseButton()) {
        // After Yes please, Join may appear again
        joinWaitingRoomButtonClicked = false;
        queueItLog("/view: 'Yes, please' clicked — Join waiting room allowed again");
    }
}

/** Raw base64 payload for 2captcha `method=base64` (no data: prefix). */
function parseDataUrlBase64(src) {
    if (!src || typeof src !== 'string') return null;
    const idx = src.indexOf('base64,');
    if (idx === -1) return null;
    return src.slice(idx + 7);
}

/** BotDetect submit on softblock: button text "I'm not a robot" (not "Join waiting room"). */
function findBotdetectImNotRobotButton() {
    const buttons = document.querySelectorAll('button.botdetect-button.btn');
    for (let i = 0; i < buttons.length; i++) {
        const t = (buttons[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (t === "I'm not a robot" || t.toLowerCase().indexOf('not a robot') !== -1) return buttons[i];
    }
    return null;
}

function isElementVisiblyShown(el) {
    if (!el) return false;
    try {
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        return true;
    } catch (_) {
        return !!el;
    }
}

/**
 * Queue-IT Botdeflector checkbox widget (#divChallenge / .botdeflector-widget / "I'm not a robot").
 * Different from BotDetect image captcha (img.captcha-code + input#solution).
 */
function isBotdeflectorChallengeVisible() {
    const widget = document.querySelector('.botdeflector-widget');
    if (isElementVisiblyShown(widget)) return true;
    const checkbox = document.querySelector('input.botdeflector-checkbox, .botdeflector-widget input[type="checkbox"]');
    if (isElementVisiblyShown(checkbox)) return true;
    const challenge =
        document.querySelector('#divChallenge') ||
        document.querySelector('#challenge-widget-container') ||
        document.querySelector('#MainPart_divWarningBox');
    if (!challenge || !isElementVisiblyShown(challenge)) return false;
    if (challenge.querySelector('.botdeflector-widget, .botdeflector-checkbox, .botdeflector-icon, .botdeflector-headphone')) {
        return true;
    }
    const t = (challenge.textContent || '').replace(/\s+/g, ' ');
    if (/I['\u2019]?m not a robot/i.test(t) && challenge.querySelector('input[type="checkbox"]')) return true;
    if (/botdeflector/i.test(challenge.getAttribute('aria-label') || '')) return true;
    return false;
}

/** Icon-sequence popup after clicking Botdeflector "I'm not a robot". */
function isBotdeflectorIconChallengeVisible() {
    const root =
        document.querySelector('#iconChallenge') ||
        document.querySelector('#botdeflector #iconChallenge') ||
        document.querySelector('#botdeflector');
    if (!isElementVisiblyShown(root)) return false;
    const bg =
        document.querySelector('#iconChallenge #image img') ||
        document.querySelector('#botdeflector #image img') ||
        document.querySelector('#image img[alt="challenge image"]');
    const icons =
        document.querySelector('#iconChallenge #icons img') ||
        document.querySelector('#botdeflector #icons img') ||
        document.querySelector('#icons img[alt="challenge icons"]');
    if (!bg || !icons) return false;
    const bgSrc = (bg.currentSrc || bg.src || '').trim();
    const icSrc = (icons.currentSrc || icons.src || '').trim();
    return !!(bgSrc && icSrc && isElementVisiblyShown(bg));
}

function getBotdeflectorChallengeImageEls() {
    const bg =
        document.querySelector('#iconChallenge #image img') ||
        document.querySelector('#botdeflector #image img') ||
        document.querySelector('#image img[alt="challenge image"]');
    const icons =
        document.querySelector('#iconChallenge #icons img') ||
        document.querySelector('#botdeflector #icons img') ||
        document.querySelector('#icons img[alt="challenge icons"]');
    return { bg, icons };
}

function clickBotdeflectorImNotRobotCheckbox() {
    const cb = document.querySelector('input.botdeflector-checkbox, .botdeflector-widget input[type="checkbox"]');
    if (cb && isElementVisiblyShown(cb)) {
        try {
            if (!cb.checked) {
                cb.click();
                return true;
            }
        } catch (_) {
            cb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return true;
        }
    }
    const widget = document.querySelector('.botdeflector-widget');
    if (widget) {
        const label = Array.from(widget.querySelectorAll('span, [role="button"]')).find((el) =>
            /I['\u2019]?m not a robot/i.test((el.textContent || '').trim())
        );
        if (label) {
            label.click();
            return true;
        }
        const icon = widget.querySelector('.botdeflector-icon, svg[aria-label="Toggle verification"]');
        if (icon) {
            icon.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return true;
        }
    }
    return false;
}

/** Click at natural-image coordinates (2captcha origin = top-left of challenge image). */
function clickImageAtNaturalCoords(img, x, y) {
    if (!img) return false;
    const rect = img.getBoundingClientRect();
    const nw = img.naturalWidth || rect.width || 300;
    const nh = img.naturalHeight || rect.height || 200;
    if (nw <= 0 || nh <= 0 || rect.width <= 0 || rect.height <= 0) return false;
    const clientX = rect.left + (Number(x) / nw) * rect.width;
    const clientY = rect.top + (Number(y) / nh) * rect.height;
    const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
        button: 0,
        buttons: 1
    };
    const el = document.elementFromPoint(clientX, clientY) || img;
    try {
        el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse' }, opts)));
    } catch (_) {}
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    try {
        el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse' }, opts)));
    } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return true;
}

function delayMs(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

const CAPTCHA_STATUS_FIELD_MAX_LEN = 160;

/** `pattern="[A-Za-z0-9]*"` blocks "Solving..." and error text — remove while showing status. */
function relaxCaptchaSolutionField(el) {
    if (!el) return;
    try {
        el.removeAttribute('pattern');
    } catch (_) {}
}

/** Show one-line status or API error in the captcha input (e.g. Solving…, Error: …). */
function showCaptchaSolutionFieldStatus(el, text) {
    if (!el) return;
    relaxCaptchaSolutionField(el);
    let s = String(text || '').replace(/\r|\n/g, ' ').trim();
    if (s.length > CAPTCHA_STATUS_FIELD_MAX_LEN) s = s.slice(0, CAPTCHA_STATUS_FIELD_MAX_LEN - 1) + '\u2026';
    el.value = s;
}

if (window.location.href.startsWith("https://hd-queue.eticketing.co.uk") || window.location.href.startsWith("http://hd-queue.eticketing.co.uk")) {
    // Save full softblock URL (including query) for recovery when /error403 happens.
    if (isSoftblockQueueUrl() && window.location.href.indexOf('/softblock/?c') !== -1) {
        chrome.runtime.sendMessage({ action: 'saveHdQueueSoftblockUrl', url: window.location.href }, () => {
            if (chrome.runtime.lastError) {
                console.warn('[QueueIt Script] saveHdQueueSoftblockUrl failed:', chrome.runtime.lastError.message);
            } else {
                console.log('[QueueIt Script] Saved softblock URL for error403 recovery.');
                queueItLog('Saved softblock URL for recovery');
            }
        });
    }

    // hd-queue /error403: pathname only (do not match query/JWT). Softblock waiting room is a live queue.
    if (isHdQueueError403Page()) {
        if (!window.__hdQueueError403FlowScheduled) {
            window.__hdQueueError403FlowScheduled = true;
            chrome.runtime.sendMessage({ action: 'error403Detected', fromHdQueueError403: true }, () => {
                if (chrome.runtime.lastError) {
                    console.error('[QueueIt Script] error403Detected error:', chrome.runtime.lastError);
                }
            });
            console.log('[QueueIt Script] hd-queue /error403 — notified background (pause ladder); showing wait countdown.');
            (function injectError403PauseCountdown() {
                if (document.getElementById('etk-hd403-pause-banner')) return;
                const el = document.createElement('div');
                el.id = 'etk-hd403-pause-banner';
                el.setAttribute(
                    'style',
                    'position:fixed;top:0;left:0;right:0;z-index:2147483646;padding:10px 14px;text-align:center;' +
                        'font:14px/1.35 Segoe UI,system-ui,sans-serif;background:#1e293b;color:#f8fafc;' +
                        'box-shadow:0 2px 12px rgba(0,0,0,.25);pointer-events:none'
                );
                document.documentElement.appendChild(el);
                let tickTimer = null;
                function formatRemain(ms) {
                    if (ms <= 0) return 'Pause ending…';
                    const s = Math.ceil(ms / 1000);
                    const m = Math.floor(s / 60);
                    const r = s % 60;
                    return m > 0 ? m + 'm ' + r + 's remaining' : r + 's remaining';
                }
                function tick() {
                    chrome.storage.local.get(['error403PauseUntil', 'currentStatus'], (st) => {
                        if (chrome.runtime.lastError) return;
                        const until = Number(st.error403PauseUntil) || 0;
                        const left = until - Date.now();
                        const status = String(st.currentStatus || '').trim().toLowerCase();
                        if (left <= 0 && (status === 'off' || status === 'stop' || status === 'false' || status === '0')) {
                            el.textContent = 'Error 403 pause ended — Google Sheet status is Off, waiting until it turns On.';
                            return;
                        }
                        el.textContent = 'Error 403 pause — ' + formatRemain(left);
                    });
                }
                tick();
                tickTimer = setInterval(tick, 1000);
                try {
                    chrome.storage.onChanged.addListener(function etk403Storage(changes, area) {
                        if (area !== 'local' || !changes.error403PauseUntil) return;
                        tick();
                    });
                } catch (_) {}
                window.addEventListener(
                    'beforeunload',
                    function () {
                        if (tickTimer) clearInterval(tickTimer);
                    },
                    { once: true }
                );
            })();
        } else {
            console.log('[QueueIt Script] hd-queue /error403 — flow already started for this tab.');
        }
        // Do not start queue checks, 120s timeout, or sendQueueWaiting while on /error403
    } else {
    console.log("[QueueIt Script] Running on the correct page.");

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startQueueItScript);
    } else {
        startQueueItScript();
        }

        // Send setQueueWaiting to background every 3s; background clears flag if no message in 10s
        setInterval(sendQueueWaitingToBackground, 3000);
        sendQueueWaitingToBackground(); // run once on load

        // If neither queue UI nor /softblock appears after 120s, clear cookies and reopen event URL
        setTimeout(() => {
            if (queueFlagEverSeen) return;
            if (looksLikeQueueItWaitingRoom()) return;
            if (isBotdeflectorChallengeVisible()) return;
            console.log("[QueueIt Script] No queue indicators after 120s - clearing cookies and reopening event URL in same tab");
            chrome.runtime.sendMessage({ action: 'clearCookiesAndReopenInSameTab' }, () => {
                if (chrome.runtime.lastError) console.error('[QueueIt Script] clearCookiesAndReopenInSameTab error:', chrome.runtime.lastError);
            });
        }, 120000);
    }

    function startQueueItScript() {
        console.log("[QueueIt Script] Starting queue-it script...");

        let checkCount = 0;
        /** Softblock / 2captcha can sit through many rounds without reload — allow long run; other queue pages keep a short cap. */
        let maxChecks = isSoftblockQueueUrl() || isHdQueueViewUrl() ? 36000 : 200;
        let recaptchaTimeout;
        const startTime = Date.now();
        let iframeFound = false;
        let cookiesCleared = false;
        let softblockTwoCaptchaSheetSyncSent = false;
        let softblockSheetSyncSentAt = 0;
        /** `img.captcha-code` src after last successful submit — when it changes, site issued a new challenge. */
        let lastSoftblockCaptchaImgSrc = null;
        /** After a 2captcha error, wait before retrying the same image (avoid hammering API). */
        let softblock2CaptchaRetryAfterMs = 0;
        let botDetectCaptchaResetOnQueueProgress = false;

        const checkElements = setInterval(async () => {
            checkCount++;
            const elapsed = (Date.now() - startTime) / 1000;

            if (checkCount > maxChecks) {
                console.log("[QueueIt Script] Stopping checks after max attempts");
                clearInterval(checkElements);
                return;
            }

            // If Chrome/page shows "Your browsing activity has been paused", back off for 60s before taking any queue actions
            try {
                const bodyText = (document.body && document.body.innerText) || '';
                if (bodyText.toLowerCase().includes('your browsing activity has been paused')) {
                    const now = Date.now();
                    if (now >= browsingPausedUntil) {
                        browsingPausedUntil = now + 60000; // 60 seconds
                        console.log("[QueueIt Script] 'Your browsing activity has been paused' detected - backing off actions for 60 seconds");
                    }
                }
            } catch (_) {}
            if (Date.now() < browsingPausedUntil) {
                return; // skip this iteration; do nothing while paused
            }

            // /view: gated Join waiting room → Yes please only; no captcha / other buttons
            if (isHdQueueViewUrl()) {
                runHdQueueViewOnlyButtonClicks();
                return;
            }

            // Past captcha into real queue — reset appearance counter and cancel captcha recovery wait
            if (hasPeopleAheadOfYouVisible() && !botDetectCaptchaResetOnQueueProgress) {
                botDetectCaptchaResetOnQueueProgress = true;
                clearBotdeflectorAwaitingOutcome();
                if (!getActiveHdQueueCaptchaKind()) {
                    cancelHdQueueCaptchaRecoveryWait('queue progress visible, no captcha');
                }
                chrome.storage.local.set({ [HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]: 0 }, () => {
                    if (!chrome.runtime.lastError) {
                        queueItLog('Captcha count reset (queue progress visible)');
                    }
                });
            }

            const hasBotDetectUi = hasBotDetectCaptchaUi();
            const hasBotDeflectorUi =
                !hasBotDetectUi && (isBotdeflectorChallengeVisible() || isBotdeflectorIconChallengeVisible());

            let allowAuto2Captcha = false;
            if (hasBotDetectUi || hasBotDeflectorUi) {
                if (!botDetectAppearanceCountedThisPage) {
                    botDetectAppearanceCountedThisPage = true;
                    captchaCodeLabelHandled = true;
                    const prev = await chrome.storage.local.get([HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]);
                    const n = (Number(prev[HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]) || 0) + 1;
                    await chrome.storage.local.set({ [HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]: n });
                    const kind = hasBotDeflectorUi ? 'Botdeflector' : 'BotDetect';
                    queueItLog(
                        kind +
                            ' captcha appearance #' +
                            n +
                            ' (URL recovery first; 2captcha after ' +
                            BOTDETECT_CAPTCHA_2CAPTCHA_THRESHOLD +
                            ' appearances; sticky after threshold → keep 2captcha)'
                    );
                    // Appearances 1..(threshold-1): wait then URL recovery. threshold+: 2captcha.
                    if (n < BOTDETECT_CAPTCHA_2CAPTCHA_THRESHOLD) {
                        scheduleHdQueueCaptchaRecoveryAfterWait(
                            kind + ' appearance ' + n + '/' + BOTDETECT_CAPTCHA_2CAPTCHA_THRESHOLD
                        );
                    } else {
                        cancelHdQueueCaptchaRecoveryWait('switching to 2captcha after recovery attempts');
                        queueItLog(
                            kind +
                                ' appeared ' +
                                n +
                                '+ times during URL recovery — solving with 2captcha'
                        );
                        maxChecks = Math.max(maxChecks, 36000);
                    }
                }
                const stCount = await chrome.storage.local.get([HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]);
                allowAuto2Captcha =
                    (Number(stCount[HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]) || 0) >=
                    BOTDETECT_CAPTCHA_2CAPTCHA_THRESHOLD;
            }

            // After icon clicks: rejected after grace → retry 2captcha; accepted → clear await (count stays sticky)
            if (botdeflectorAwaitingOutcome && hasBotDeflectorUi) {
                if (Date.now() < botdeflectorAwaitingOutcomeUntil) {
                    // Grace: redirect often briefly mutates challenge DOM — do not treat as reject yet
                } else {
                    const keyNow = getBotdeflectorChallengeKey();
                    if (keyNow && lastBotdeflectorChallengeKey && keyNow !== lastBotdeflectorChallengeKey) {
                        clearBotdeflectorAwaitingOutcome();
                        botdeflector2CaptchaGotResponse = false;
                        botdeflector2CaptchaRetryAfterMs = 0;
                        botdeflectorCheckboxClicked = false;
                        queueItLog(
                            'Botdeflector rejected after ' +
                                BOTDEFLECTOR_OUTCOME_GRACE_MS / 1000 +
                                's (new challenge images) — retrying 2captcha (count sticky)'
                        );
                    } else if (
                        !isBotdeflectorIconChallengeVisible() &&
                        isBotdeflectorChallengeVisible()
                    ) {
                        clearBotdeflectorAwaitingOutcome();
                        botdeflector2CaptchaGotResponse = false;
                        botdeflector2CaptchaRetryAfterMs = Date.now() + 1500;
                        botdeflectorCheckboxClicked = false;
                        lastBotdeflectorChallengeKey = '';
                        queueItLog(
                            'Botdeflector rejected after ' +
                                BOTDEFLECTOR_OUTCOME_GRACE_MS / 1000 +
                                's (back to checkbox) — retrying 2captcha (count sticky)'
                        );
                    }
                }
            } else if (
                botdeflectorAwaitingOutcome &&
                !hasBotDeflectorUi &&
                !hasBotDetectUi
            ) {
                clearBotdeflectorAwaitingOutcome();
                queueItLog('Botdeflector accepted (UI gone) — count stays sticky for next softblock');
            }

            // Any captcha (reCAPTCHA / Botdeflector / BotDetect): wait 30s then URL recovery unless 2captcha active
            if (!allowAuto2Captcha && !hdQueueRecoveryTriggered && !botdeflector2CaptchaStarted) {
                const captchaKind = getActiveHdQueueCaptchaKind();
                if (captchaKind) {
                    if (captchaKind === 'reCAPTCHA') iframeFound = true;
                    scheduleHdQueueCaptchaRecoveryAfterWait(captchaKind + ' visible');
                }
            }

            let twoCaptchaKey = '';
            if (allowAuto2Captcha) {
                const st = await chrome.storage.local.get(['twoCaptchaApiKey']);
                twoCaptchaKey = (st.twoCaptchaApiKey || '').trim();
                if (!softblockTwoCaptchaSheetSyncSent) {
                    softblockTwoCaptchaSheetSyncSent = true;
                    softblockSheetSyncSentAt = Date.now();
                    chrome.runtime.sendMessage({ action: 'syncTwoCaptchaKeyFromSheet' }, () => {
                        if (chrome.runtime.lastError) {
                            console.warn(
                                '[QueueIt Script] syncTwoCaptchaKeyFromSheet:',
                                chrome.runtime.lastError.message
                            );
                        } else {
                            console.log('[QueueIt Script] Background syncing 2Captcha API key from public Google Sheet');
                        }
                    });
                }
            }

            // --- New captcha image without full reload (src changes) — allow another 2captcha round ---
            if (allowAuto2Captcha && twoCaptchaKey && !softblock2CaptchaStarted) {
                const imgProbe = document.querySelector('img.captcha-code');
                const curSrc = imgProbe && imgProbe.src ? imgProbe.src : '';
                if (
                    curSrc &&
                    lastSoftblockCaptchaImgSrc &&
                    curSrc !== lastSoftblockCaptchaImgSrc
                ) {
                    softblock2CaptchaGotResponse = false;
                    softblock2CaptchaRetryAfterMs = 0;
                    console.log('[QueueIt Script] New BotDetect captcha image (src changed) — will auto-solve again.');
                    queueItLog('New BotDetect captcha image (src changed) — will auto-solve again (sticky after threshold)');
                }
            }

            // --- Botdeflector: open icon challenge then solve click-sequence via 2captcha ---
            // Do not touch "I'm not a robot" / 2captcha while post-click grace (awaiting accept vs reject)
            if (
                allowAuto2Captcha &&
                hasBotDeflectorUi &&
                twoCaptchaKey &&
                !botdeflector2CaptchaStarted &&
                !botdeflectorAwaitingOutcome &&
                Date.now() >= botdeflector2CaptchaRetryAfterMs
            ) {
                if (!isBotdeflectorIconChallengeVisible()) {
                    if (!botdeflectorCheckboxClicked) {
                        botdeflectorCheckboxClicked = true;
                        const clicked = clickBotdeflectorImNotRobotCheckbox();
                        queueItLog(
                            'Botdeflector — clicked "I\'m not a robot" to open icon challenge: ' + clicked
                        );
                        // Allow popup/images a few seconds to load before next tick sends to 2captcha
                        botdeflector2CaptchaRetryAfterMs = Date.now() + 2500;
                    } else {
                        // Still no popup — retry checkbox click periodically
                        botdeflectorCheckboxClicked = false;
                        botdeflector2CaptchaRetryAfterMs = Date.now() + 4000;
                    }
                } else if (!botdeflector2CaptchaGotResponse || (() => {
                    const { bg, icons } = getBotdeflectorChallengeImageEls();
                    const key =
                        ((bg && (bg.currentSrc || bg.src)) || '') +
                        '|' +
                        ((icons && (icons.currentSrc || icons.src)) || '');
                    return key && key !== lastBotdeflectorChallengeKey;
                })()) {
                    const { bg, icons } = getBotdeflectorChallengeImageEls();
                    const bgSrc = bg && (bg.currentSrc || bg.src);
                    const icSrc = icons && (icons.currentSrc || icons.src);
                    const challengeKey = (bgSrc || '') + '|' + (icSrc || '');
                    if (challengeKey && challengeKey !== lastBotdeflectorChallengeKey) {
                        botdeflector2CaptchaGotResponse = false;
                    }
                    if (
                        bgSrc &&
                        icSrc &&
                        (!botdeflector2CaptchaGotResponse || challengeKey !== lastBotdeflectorChallengeKey)
                    ) {
                        botdeflector2CaptchaStarted = true;
                        lastBotdeflectorChallengeKey = challengeKey;
                        cancelHdQueueCaptchaRecoveryWait('Botdeflector 2captcha solve started');
                        queueItLog(
                            'Botdeflector icon challenge — sending images to 2captcha coordinates...'
                        );
                        chrome.runtime.sendMessage(
                            {
                                action: 'twoCaptchaSolveCoordinates',
                                imageUrl: bgSrc,
                                instructionsImageUrl: icSrc,
                                comment:
                                    'Select icons on the big image in the exact order shown in the small strip (left to right)'
                            },
                            async (resp) => {
                                const release = () => {
                                    botdeflector2CaptchaStarted = false;
                                };
                                const retrySoon = () => {
                                    botdeflector2CaptchaGotResponse = false;
                                    botdeflector2CaptchaRetryAfterMs = Date.now() + 5000;
                                };
                                if (chrome.runtime.lastError) {
                                    queueItWarn(
                                        'Botdeflector 2captcha message error: ' +
                                            (chrome.runtime.lastError.message || '')
                                    );
                                    retrySoon();
                                    release();
                                    return;
                                }
                                if (!resp || !resp.success || !Array.isArray(resp.coordinates) || !resp.coordinates.length) {
                                    const err = (resp && resp.error) || 'no coordinates';
                                    const retryable =
                                        (resp && resp.retryable) ||
                                        /not ready|could not be decoded|image decode/i.test(String(err));
                                    if (retryable) {
                                        queueItLog('Botdeflector 2captcha: ' + err + ' — retrying shortly');
                                    } else {
                                        queueItWarn('Botdeflector 2captcha failed: ' + err);
                                    }
                                    retrySoon();
                                    release();
                                    return;
                                }
                                const imgs = getBotdeflectorChallengeImageEls();
                                if (!imgs.bg) {
                                    queueItWarn('Botdeflector challenge image gone after solve');
                                    retrySoon();
                                    release();
                                    return;
                                }
                                queueItLog(
                                    'Botdeflector — clicking ' +
                                        resp.coordinates.length +
                                        ' point(s) in order'
                                );
                                let clickOkCount = 0;
                                for (let i = 0; i < resp.coordinates.length; i++) {
                                    const p = resp.coordinates[i];
                                    const ok = clickImageAtNaturalCoords(imgs.bg, p.x, p.y);
                                    if (ok) clickOkCount++;
                                    queueItLog(
                                        'Botdeflector click ' +
                                            (i + 1) +
                                            '/' +
                                            resp.coordinates.length +
                                            ' at ' +
                                            p.x +
                                            ',' +
                                            p.y +
                                            (ok ? ' ok' : ' failed')
                                    );
                                    await delayMs(350);
                                }
                                botdeflector2CaptchaGotResponse = true;
                                botdeflectorAwaitingOutcome = true;
                                botdeflectorAwaitingOutcomeUntil = Date.now() + BOTDEFLECTOR_OUTCOME_GRACE_MS;
                                cancelHdQueueCaptchaRecoveryWait(
                                    'Botdeflector clicks done — awaiting accept or new images'
                                );
                                queueItLog(
                                    'Botdeflector clicks done (' +
                                        clickOkCount +
                                        '/' +
                                        resp.coordinates.length +
                                        ') — waiting ' +
                                        BOTDEFLECTOR_OUTCOME_GRACE_MS / 1000 +
                                        's before treat-as-reject; count stays sticky after threshold'
                                );
                                release();
                            }
                        );
                    }
                }
            }

            // --- Solve BotDetect image via 2captcha (after threshold appearances during URL recovery) ---
            if (
                allowAuto2Captcha &&
                hasBotDetectUi &&
                twoCaptchaKey &&
                !softblock2CaptchaStarted &&
                !softblock2CaptchaGotResponse &&
                Date.now() >= softblock2CaptchaRetryAfterMs
            ) {
                const captchaImg = document.querySelector('img.captcha-code');
                const captchaIn = document.querySelector('input#solution');
                const submitBtn = findBotdetectImNotRobotButton();
                const label = document.querySelector('label#captcha-code-label[for="CaptchaCode"]');
                const labelOk =
                    label && (label.textContent || '').indexOf('Enter the code from the picture') !== -1;
                if (captchaImg && captchaIn && submitBtn && labelOk) {
                    const b64 = parseDataUrlBase64(captchaImg.src);
                    if (b64 && b64.length > 80) {
                        softblock2CaptchaStarted = true;
                        showCaptchaSolutionFieldStatus(captchaIn, 'Solving...');
                        console.log(
                            '[QueueIt Script] BotDetect image — sending to 2captcha (base64 length ' +
                                b64.length +
                                ')...'
                        );
                        queueItLog('BotDetect image — sending to 2captcha (base64 length ' + b64.length + ')');
                        chrome.runtime.sendMessage({ action: 'twoCaptchaSolveImageBase64', base64: b64 }, (resp) => {
                            const fieldNow = document.querySelector('input#solution') || captchaIn;
                            const releaseSolveLock = () => {
                                softblock2CaptchaStarted = false;
                            };
                            const markSolvedUntilNewImage = () => {
                                softblock2CaptchaGotResponse = true;
                                const im = document.querySelector('img.captcha-code');
                                if (im && im.src) lastSoftblockCaptchaImgSrc = im.src;
                            };
                            const markErrorRetry = () => {
                                softblock2CaptchaGotResponse = false;
                                softblock2CaptchaRetryAfterMs = Date.now() + 4000;
                            };
                            if (chrome.runtime.lastError) {
                                const msg = chrome.runtime.lastError.message || 'message channel error';
                                console.error('[QueueIt Script] 2captcha message error:', msg);
                                showCaptchaSolutionFieldStatus(fieldNow, 'Error: ' + msg);
                                markErrorRetry();
                                releaseSolveLock();
                                return;
                            }
                            if (!resp || !resp.success) {
                                const err = (resp && resp.error) || 'unknown API error';
                                console.warn('[QueueIt Script] 2captcha failed:', err);
                                showCaptchaSolutionFieldStatus(
                                    fieldNow,
                                    err.toLowerCase().startsWith('error:') ? err : 'Error: ' + err
                                );
                                markErrorRetry();
                                releaseSolveLock();
                                return;
                            }
                            let code = String(resp.text || '').trim();
                            code = code.replace(/[^A-Za-z0-9]/g, '');
                            if (!code) {
                                console.warn('[QueueIt Script] 2captcha returned empty code after sanitizing');
                                showCaptchaSolutionFieldStatus(fieldNow, 'Error: empty code from 2captcha');
                                markErrorRetry();
                                releaseSolveLock();
                                return;
                            }
                            const el = document.querySelector('input#solution');
                            const btn = findBotdetectImNotRobotButton();
                            if (!el || !btn) {
                                console.warn(
                                    '[QueueIt Script] captcha field or submit button missing after 2captcha response'
                                );
                                markErrorRetry();
                                releaseSolveLock();
                                return;
                            }
                            el.focus();
                            relaxCaptchaSolutionField(el);
                            el.value = '';
                            el.value = code;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            try {
                                el.dispatchEvent(
                                    new InputEvent('input', { bubbles: true, data: code, inputType: 'insertText' })
                                );
                            } catch (_) {}
                            try {
                                el.setAttribute('pattern', '[A-Za-z0-9]*');
                            } catch (_) {}

                            markSolvedUntilNewImage();
                            console.log('[QueueIt Script] Filled code from 2captcha; clicking I\'m not a robot.');
                            btn.click();
                            releaseSolveLock();

                            // If the site rejects the code but keeps the same image src, allow another solve once the field clears.
                            setTimeout(() => {
                                if (softblock2CaptchaStarted) return;
                                const el2 = document.querySelector('input#solution');
                                const im2 = document.querySelector('img.captcha-code');
                                if (!el2 || !im2 || !im2.src || !lastSoftblockCaptchaImgSrc) return;
                                if (im2.src !== lastSoftblockCaptchaImgSrc) return;
                                const v = (el2.value || '').trim();
                                const looksIdle =
                                    v === '' || v === 'Solving...' || /^error:/i.test(v);
                                if (looksIdle) {
                                    softblock2CaptchaGotResponse = false;
                                    console.log(
                                        '[QueueIt Script] Same captcha image, field reset — will auto-solve again if needed.'
                                    );
                                }
                            }, 6000);
                        });
                    }
                }
            }

            // --- Click "Join waiting room" button as soon as it appears (non-/view pages) ---
            tryClickJoinWaitingRoomButton();

            // --- Click "Yes, please" confirm redirect button as soon as it appears ---
            tryClickConfirmRedirectYesPleaseButton();

            // --- Click "Yes, I'm here" visitor-presence button only when that label is visible (not hidden KO span) ---
            const visitorPresenceBtn = document.querySelector('button#buttonConfirmVisitorPresence');
            if (
                visitorPresenceBtn &&
                !confirmVisitorPresenceClicked &&
                isVisitorPresenceButtonClickable(visitorPresenceBtn) &&
                isVisitorPresenceImHerePromptVisible(visitorPresenceBtn)
            ) {
                confirmVisitorPresenceClicked = true;
                console.log("[QueueIt Script] 'Yes, I'm here' (#buttonConfirmVisitorPresence) visible and clickable — clicking...");
                visitorPresenceBtn.click();
            }

            // --- Click "Get a new place in the queue" link as soon as it appears ---
            if (!getNewPlaceInQueueClicked) {
                const getNewPlaceLink = Array.from(document.querySelectorAll('a.btn')).find(a => {
                    const t = (a.textContent || '').trim();
                    return t.indexOf('Get a new place in the queue') !== -1;
                });
                if (getNewPlaceLink) {
                    getNewPlaceInQueueClicked = true;
                    console.log("[QueueIt Script] 'Get a new place in the queue' link found, clicking immediately...");
                    getNewPlaceLink.click();
                }
            }

            // --- BotDetect label: counted above; only recover if somehow not counted yet and under threshold ---
            if (!captchaCodeLabelHandled) {
                const captchaCodeLabel = document.querySelector('label#captcha-code-label[for="CaptchaCode"]');
                const hasLabelText =
                    captchaCodeLabel &&
                    (captchaCodeLabel.textContent || '').trim().indexOf('Enter the code from the picture') !== -1;
                if (hasLabelText) {
                    captchaCodeLabelHandled = true;
                    if (!allowAuto2Captcha) {
                        scheduleHdQueueCaptchaRecoveryAfterWait('BotDetect captcha label');
                    }
                }
            }

            const captchaInput = document.querySelector('input#solution');
            const imNotRobotBtn = findBotdetectImNotRobotButton();
            const recaptchaIframe = document.querySelector('iframe[title="recaptcha challenge expires in two minutes"]');

            // reCAPTCHA handled above via scheduleHdQueueCaptchaRecoveryAfterWait
            if (recaptchaIframe) {
                iframeFound = true;
            }

            // --- If iframe not found within N seconds, redirect to event URL (softblock / 2captcha BotDetect — skip this) ---
            if (!iframeFound && !cookiesCleared && !isSoftblockQueueUrl() && !allowAuto2Captcha && !hasBotDeflectorUi) {
                const needSec = hasPeopleAheadOfYouVisible()
                    ? NO_RECAPTCHA_IFRAME_REDIRECT_PEOPLE_AHEAD_SEC
                    : NO_RECAPTCHA_IFRAME_REDIRECT_SEC;
                if (elapsed >= needSec) {
                    if (hasPeopleAheadOfYouVisible()) {
                        // Do not redirect away from queue while user is clearly in line
                        return;
                    }
                cookiesCleared = true;
                    console.log("[QueueIt Script] No reCAPTCHA iframe after " + Math.round(needSec) + "s. Redirecting to event URL...");
                clearInterval(checkElements);
                const { eventUrl } = await chrome.storage.local.get("eventUrl");
                    if (eventUrl) window.location.href = eventUrl;
                    return;
                }
            }

            // --- Manual BotDetect: defer while 2captcha request is in flight (after threshold) ---
            const sheetSyncGraceMs = 25000;
            const sheetSyncGrace =
                allowAuto2Captcha &&
                softblockTwoCaptchaSheetSyncSent &&
                Date.now() - softblockSheetSyncSentAt < sheetSyncGraceMs;
            const waitOnSoftblock2Captcha =
                allowAuto2Captcha &&
                ((!softblock2CaptchaGotResponse &&
                    (twoCaptchaKey || softblock2CaptchaStarted || sheetSyncGrace)) ||
                    (hasBotDeflectorUi &&
                        (botdeflector2CaptchaStarted ||
                            !botdeflector2CaptchaGotResponse ||
                            sheetSyncGrace)));
            // With 2captcha key: never stop the interval for a one-shot manual listener — new captcha images need ticks.
            const skipManualBotdetect = allowAuto2Captcha && twoCaptchaKey;
            if (
                allowAuto2Captcha &&
                !twoCaptchaKey &&
                softblockTwoCaptchaSheetSyncSent &&
                Date.now() - softblockSheetSyncSentAt >= sheetSyncGraceMs &&
                !hdQueueRecoveryTriggered
            ) {
                console.warn(
                    '[QueueIt Script] 2captcha key still missing after sheet sync — falling back to URL recovery'
                );
                scheduleHdQueueCaptchaRecoveryAfterWait('2captcha key missing');
            }
            if (
                captchaInput &&
                imNotRobotBtn &&
                !botdetectManualListenerAttached &&
                !waitOnSoftblock2Captcha &&
                !skipManualBotdetect &&
                !allowAuto2Captcha
            ) {
                scheduleHdQueueCaptchaRecoveryAfterWait('BotDetect captcha input/button');
            }
        }, 1000);
    }
} else {
    console.log("[QueueIt Script] Not running - URL doesn't match queue pattern");
}
