// queueit_script.js

console.log("[QueueIt Script] Script loaded on:", window.location.href);

/** Returns true if the page shows "people ahead of you" (user is in queue and must wait). */
function hasPeopleAheadOfYouVisible() {
    const el = document.querySelector('#MainPart_lbUsersInLineAheadOfYouText');
    if (!el) return false;
    const text = (el.textContent || '').trim();
    if (text.indexOf('people ahead of you') === -1) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
}

/** Send setQueueWaiting message to background every 3s so background knows we're still in queue; background clears flag if no message in 10s. */
function sendQueueWaitingToBackground() {
    const onQueueUrl = window.location.href.startsWith('https://ticketmastersportuk.queue-it.net') ||
        window.location.href.startsWith('http://ticketmastersportuk.queue-it.net');
    const waiting = onQueueUrl && hasPeopleAheadOfYouVisible();
    chrome.runtime.sendMessage({ action: 'setQueueWaiting', inQueueWaiting: waiting }, () => {
        if (chrome.runtime.lastError) return;
        if (waiting) console.log("[QueueIt Script] In queue (people ahead of you) - sent setQueueWaiting true");
    });
}

if (window.location.href.startsWith("https://ticketmastersportuk.queue-it.net")) {
    console.log("[QueueIt Script] Running on the correct page.");

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startQueueItScript);
    } else {
        startQueueItScript();
    }

    // Send setQueueWaiting to background every 3s; background clears flag if no message in 10s
    setInterval(sendQueueWaitingToBackground, 3000);
    sendQueueWaitingToBackground(); // run once on load

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
    console.log("[QueueIt Script] Not running - URL doesn't match queue-it pattern");
}
