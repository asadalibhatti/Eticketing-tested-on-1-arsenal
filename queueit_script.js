// queueit_script.js

console.log("[QueueIt Script] Script loaded on:", window.location.href);

/** When queue UI shows people ahead / progress, wait longer before treating reCAPTCHA as stuck or redirecting without iframe. */
const RECAPTCHA_SOLVE_TIMEOUT_MS = 30000;
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
    const waiting = onQueueUrl && hasPeopleAheadOfYouVisible();
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
/** After this many BotDetect appearances during URL recovery, solve via 2captcha instead of rotating URLs. */
const BOTDETECT_CAPTCHA_2CAPTCHA_THRESHOLD = 3;
const HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY = 'hdQueueBotDetectCaptchaCount';
let hdQueueRecoveryTriggered = false; // captcha/error403 handled once per page state
/** Count BotDetect once per page load (persisted count spans recovery navigations). */
let botDetectAppearanceCountedThisPage = false;
/** Softblock BotDetect + 2captcha: only start one BG solve per load; gotResponse clears "wait for API" for manual fallback. */
let softblock2CaptchaStarted = false;
let softblock2CaptchaGotResponse = false;
let botdetectManualListenerAttached = false;

function triggerHdQueueRecoverySequence(reason) {
    if (hdQueueRecoveryTriggered) return;
    hdQueueRecoveryTriggered = true;
    console.log('[QueueIt Script] Triggering hd-queue recovery sequence:', reason);
    chrome.runtime.sendMessage({ action: 'error403Detected', fromHdQueueError403: true }, () => {
        if (chrome.runtime.lastError) {
            console.error('[QueueIt Script] error403Detected error:', chrome.runtime.lastError);
        }
    });
}

function isSoftblockQueueUrl() {
    const u = window.location.href || '';
    return (
        u.startsWith('https://hd-queue.eticketing.co.uk/softblock/') ||
        u.startsWith('http://hd-queue.eticketing.co.uk/softblock/')
    );
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
            }
        });
    }

    // hd-queue /error403: background sets pause (5,7,9,… min capped 30); timer ends pause, clears cookies, closes this tab.
    if (window.location.href.indexOf('error403') !== -1) {
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

        // If neither "people ahead" nor progress bar appears after 120s, clear cookies and reopen event URL in same tab (do not clear if flag was ever seen)
        setTimeout(() => {
            if (queueFlagEverSeen) return;
            if (hasPeopleAheadOfYouVisible()) return;
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
        let maxChecks = isSoftblockQueueUrl() ? 36000 : 200;
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

            // Past BotDetect into real queue — reset appearance counter for future recoveries
            if (hasPeopleAheadOfYouVisible() && !botDetectCaptchaResetOnQueueProgress) {
                botDetectCaptchaResetOnQueueProgress = true;
                chrome.storage.local.set({ [HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]: 0 }, () => {
                    if (!chrome.runtime.lastError) {
                        console.log('[QueueIt Script] BotDetect captcha count reset (queue progress visible)');
                    }
                });
            }

            const captchaImgEarly = document.querySelector('img.captcha-code');
            const captchaInEarly = document.querySelector('input#solution');
            const submitBtnEarly = findBotdetectImNotRobotButton();
            const labelEarly = document.querySelector('label#captcha-code-label[for="CaptchaCode"]');
            const labelOkEarly =
                labelEarly &&
                (labelEarly.textContent || '').indexOf('Enter the code from the picture') !== -1;
            const hasBotDetectUi = !!(captchaImgEarly && captchaInEarly && submitBtnEarly && labelOkEarly);

            let allowAuto2Captcha = false;
            if (hasBotDetectUi) {
                if (!botDetectAppearanceCountedThisPage) {
                    botDetectAppearanceCountedThisPage = true;
                    captchaCodeLabelHandled = true;
                    const prev = await chrome.storage.local.get([HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]);
                    const n = (Number(prev[HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]) || 0) + 1;
                    await chrome.storage.local.set({ [HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]: n });
                    console.log(
                        '[QueueIt Script] BotDetect captcha appearance #' +
                            n +
                            ' (2captcha after ' +
                            BOTDETECT_CAPTCHA_2CAPTCHA_THRESHOLD +
                            ')'
                    );
                    if (n < BOTDETECT_CAPTCHA_2CAPTCHA_THRESHOLD) {
                        clearInterval(checkElements);
                        triggerHdQueueRecoverySequence(
                            'BotDetect captcha appearance ' + n + '/' + BOTDETECT_CAPTCHA_2CAPTCHA_THRESHOLD
                        );
                        return;
                    }
                    console.log(
                        '[QueueIt Script] BotDetect appeared ' +
                            n +
                            '+ times during URL recovery — solving with 2captcha'
                    );
                    maxChecks = Math.max(maxChecks, 36000);
                }
                const stCount = await chrome.storage.local.get([HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]);
                allowAuto2Captcha =
                    (Number(stCount[HD_QUEUE_BOTDETECT_CAPTCHA_COUNT_KEY]) || 0) >=
                    BOTDETECT_CAPTCHA_2CAPTCHA_THRESHOLD;
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
                }
            }

            // --- Solve BotDetect image via 2captcha (after 3+ appearances during URL recovery) ---
            if (
                allowAuto2Captcha &&
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

            // --- Click "Join waiting room" button as soon as it appears ---
            const joinWaitingRoomButton = document.querySelector('button.botdetect-button.btn');
            if (joinWaitingRoomButton && !joinWaitingRoomButtonClicked) {
                const buttonText = (joinWaitingRoomButton.textContent || '').trim();
                if (buttonText === 'Join waiting room') {
                    joinWaitingRoomButtonClicked = true;
                    console.log("[QueueIt Script] 'Join waiting room' button found, clicking immediately...");
                    joinWaitingRoomButton.click();
                }
            }

            // --- Click "Yes, please" confirm redirect button as soon as it appears ---
            const confirmRedirectButton = document.querySelector('button#buttonConfirmRedirect');
            if (confirmRedirectButton && !confirmRedirectButtonClicked) {
                const text = (confirmRedirectButton.textContent || '').trim();
                if (text.indexOf('Yes, please') !== -1) {
                    confirmRedirectButtonClicked = true;
                    console.log("[QueueIt Script] 'Yes, please' confirm redirect button found, clicking immediately...");
                    confirmRedirectButton.click();
                }
            }

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
                        clearInterval(checkElements);
                        triggerHdQueueRecoverySequence('BotDetect captcha label detected');
                        return;
                    }
                }
            }

            const captchaInput = document.querySelector('input#solution');
            const imNotRobotBtn = findBotdetectImNotRobotButton();
            const recaptchaIframe = document.querySelector('iframe[title="recaptcha challenge expires in two minutes"]');

            // --- Detect reCAPTCHA iframe ---
            if (recaptchaIframe) {
                if (!iframeFound) console.log("[QueueIt Script] reCAPTCHA challenge detected - using hd-queue recovery sequence.");
                iframeFound = true;
                    clearInterval(checkElements);
                triggerHdQueueRecoverySequence('reCAPTCHA iframe detected');
                return;
            }

            // --- If iframe not found within N seconds, redirect to event URL (softblock / 2captcha BotDetect — skip this) ---
            if (!iframeFound && !cookiesCleared && !isSoftblockQueueUrl() && !allowAuto2Captcha) {
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
                !softblock2CaptchaGotResponse &&
                (twoCaptchaKey || softblock2CaptchaStarted || sheetSyncGrace);
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
                clearInterval(checkElements);
                triggerHdQueueRecoverySequence('BotDetect 2captcha key missing');
                return;
            }
            if (
                captchaInput &&
                imNotRobotBtn &&
                !botdetectManualListenerAttached &&
                !waitOnSoftblock2Captcha &&
                !skipManualBotdetect &&
                !allowAuto2Captcha
            ) {
                console.log("[QueueIt Script] BotDetect captcha input detected - using hd-queue recovery sequence.");
                clearInterval(checkElements);
                triggerHdQueueRecoverySequence('BotDetect captcha input/button detected');
                return;
            }
        }, 1000);
    }
} else {
    console.log("[QueueIt Script] Not running - URL doesn't match queue pattern");
}
