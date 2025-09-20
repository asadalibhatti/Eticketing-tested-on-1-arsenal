// queueit_script.js

console.log("[QueueIt Script] Script loaded on:", window.location.href);

if (window.location.href.startsWith("https://ticketmastersportuk.queue-it.net")) {
    console.log("[QueueIt Script] Running on the correct page.");

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startQueueItScript);
    } else {
        startQueueItScript();
    }

    function startQueueItScript() {
        console.log("[QueueIt Script] Starting queue-it script...");

        let checkCount = 0;
        const maxChecks = 200; // slight increase since we wait up to 28s
        let recaptchaTimeout;
        const startTime = Date.now();
        let iframeFound = false;
        let cookiesCleared = false;
        let redirectClicked = false;

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
                    console.log("[QueueIt Script] reCAPTCHA not solved in 30s. Clearing cookies and refreshing...");
                    clearInterval(checkElements);

                    chrome.runtime.sendMessage({action: "clearCookiesAndRefresh"});
                    //delay 2 seconds
                    await delay(2000);


                    // Refresh again
                    chrome.runtime.sendMessage({action: 'refreshEventTab'}, response => {
                        if (chrome.runtime.lastError) {
                            console.error('[CS] refreshEventTab error:', chrome.runtime.lastError);
                        } else {
                            console.log('[CS] refreshEventTab response:', response);
                        }
                    });
                    //delay 60 seconds
                    await delay(60000);


                }, 30000); // wait 30 sec after iframe appears
            }

            // --- If iframe not found within 25s, clear cookies & reload ---
            if (!iframeFound && !cookiesCleared && elapsed >= 50) {
                cookiesCleared = true;
                console.log("[QueueIt Script] No reCAPTCHA iframe in 50s. Clearing cookies and reloading...");

                clearInterval(checkElements);
                const { eventUrl } = await chrome.storage.local.get("eventUrl");
                chrome.runtime.sendMessage({ action: "clearCookiesAndRefresh" }, (response) => {
                    console.log("[QueueIt Script] Cookies cleared response:", response);
                    if (eventUrl) window.location.href = eventUrl;
                });
                return;
            }

            // --- Handle "Yes, please" button immediately when found ---
            const yesPleaseButton = document.querySelector('button#buttonConfirmRedirect span.l');
            if (yesPleaseButton && yesPleaseButton.textContent.trim() === 'Yes, please' && !redirectClicked) {
                redirectClicked = true;
                console.log("[QueueIt Script] 'Yes, please' button found. Clicking immediately...");
                
                clearInterval(checkElements);
                // Click the parent button element
                const parentButton = yesPleaseButton.closest('button');
                if (parentButton) {
                    parentButton.click();
                }
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
