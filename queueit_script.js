// queueit_script.js

console.log("[QueueIt Script] Script loaded on:", window.location.href);

/** Returns true if the page shows "people ahead of you" or progress bar (user is in queue and must wait). */
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
    
    return false;
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

if (window.location.href.startsWith("https://hd-queue.eticketing.co.uk") || window.location.href.startsWith("http://hd-queue.eticketing.co.uk")) {
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

    function startQueueItScript() {
        console.log("[QueueIt Script] Starting queue-it script...");

        let checkCount = 0;
        const maxChecks = 200; // slight increase since we wait up to 28s
        let recaptchaTimeout;
        const startTime = Date.now();
        let iframeFound = false;
        let cookiesCleared = false;

        const checkElements = setInterval(async () => {
            checkCount++;
            const elapsed = (Date.now() - startTime) / 1000;

            if (checkCount > maxChecks) {
                console.log("[QueueIt Script] Stopping checks after max attempts");
                clearInterval(checkElements);
                return;
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

            const captchaInput = document.querySelector('input#solution');
            const robotButton = document.querySelector('button.botdetect-button');
            const recaptchaIframe = document.querySelector('iframe[title="recaptcha challenge expires in two minutes"]');

            // --- Detect reCAPTCHA iframe ---
            if (recaptchaIframe) {
                if (!iframeFound) console.log("[QueueIt Script] reCAPTCHA challenge detected, waiting for auto-solve...");
                iframeFound = true;

                if (recaptchaTimeout) clearTimeout(recaptchaTimeout);
                recaptchaTimeout = setTimeout(async () => {
                    console.log("[QueueIt Script] reCAPTCHA not solved in 30s. Refreshing event tab...");
                    clearInterval(checkElements);

                    chrome.runtime.sendMessage({action: 'refreshEventTab'}, response => {
                        if (chrome.runtime.lastError) {
                            console.error('[CS] refreshEventTab error:', chrome.runtime.lastError);
                        } else {
                            console.log('[CS] refreshEventTab response:', response);
                        }
                    });
                }, 30000); // wait 30 sec after iframe appears
            }

            // --- If iframe not found within 50s, redirect to event URL ---
            if (!iframeFound && !cookiesCleared && elapsed >= 50) {
                cookiesCleared = true;
                console.log("[QueueIt Script] No reCAPTCHA iframe in 50s. Redirecting to event URL...");
                clearInterval(checkElements);
                const { eventUrl } = await chrome.storage.local.get("eventUrl");
                if (eventUrl) window.location.href = eventUrl;
                return;
            }

            // --- Handle captcha input ---
            if (captchaInput && robotButton) {
                console.log("[QueueIt Script] Captcha input and button found.");
                clearInterval(checkElements);

                captchaInput.addEventListener('input', () => {
                    if (captchaInput.value.trim() !== "") {
                        console.log("[QueueIt Script] Captcha input filled. Clicking the button...");
                        robotButton.click();
                    }
                });
            }
        }, 1000);
    }
} else {
    console.log("[QueueIt Script] Not running - URL doesn't match queue pattern");
}
