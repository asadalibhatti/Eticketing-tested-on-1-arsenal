// content-script.js
console.log("requestVerification script loaded, on", location.href);

function isBrowsingActivityPausedForTokenScript() {
    const title = (document.title || '').toLowerCase();
    if (title.includes('your browsing activity')) return true;
    try {
        const bodyText = (document.body && (document.body.innerText || document.body.textContent) || '').toLowerCase();
        if (bodyText.includes('your browsing activity has been paused')) return true;
        if (bodyText.includes('your browsing activity has')) return true;
    } catch (_) {}
    return false;
}

if (window.location.pathname.includes("/EDP/Event/Index/")) {

    console.log("[CS] Reloading page after 120 minutes interval.");
   

    //wait for 5 seconds
    console.log("[CS] Event page detected. Waiting for 5 seconds before proceeding...");

    // Browsing-pause recovery (60s → reload; after 3 reloads → cookies) is handled by content.js / background.
    // Do not extract verification token while the pause page is showing.
    if (isBrowsingActivityPausedForTokenScript()) {
        console.warn("[CS] Browsing activity paused on event page — skipping verification token extraction until page recovers.");
    } else
    (function () {
        const TOKEN_KEY = "verification_token";
        const EMAIL_KEY = "user_email";

        console.log("[CS] Event page detected. Will wait for verification token dynamically and proceed as soon as it is available...");

        const MAX_TOKEN_WAIT_MS = 30000; // safety cap: stop trying after 30s
        const POLL_INTERVAL_MS = 500;
        let waitedMs = 0;

        const tryExtractTokenAndEmail = () => {
            let token = null;
            let email = null;

            // ----------------------
            // Extract verification token
            // ----------------------
            let hiddenInput = document.querySelector('input[name="__RequestVerificationToken"]');
            if (hiddenInput) {
                token = hiddenInput.value;
                console.log("[CS] Token found via hidden input:", token);
            }

            if (!token) {
                let metaToken = document.querySelector('meta[name=\"__RequestVerificationToken\"]');
                if (metaToken) {
                    token = metaToken.getAttribute("content");
                    console.log("[CS] Token found via meta tag:", token);
                }
            }

            if (!token) {
                let html = document.documentElement.innerHTML;
                let match = html.match(/__RequestVerificationToken\"\\s*value=\"([^\"]+)\"/);
                if (match) {
                    token = match[1];
                    console.log("[CS] Token found via HTML regex:", token);
                }
            }

            if (token) {
                localStorage.setItem(TOKEN_KEY, token);
                console.log("[CS] Token saved to localStorage");
                // Signal that event tab has loaded and verification token is ready
                // eventTabReloaded: one-shot for seat-check wait; eventPageReady: durable gate for validation tab
                chrome.storage.local.set({ eventTabReloaded: true, eventPageReady: true });
                console.log(
                    '[CS] Event tab ready flags set (eventTabReloaded=true, eventPageReady=true) — page loaded with token.'
                );
                chrome.runtime.sendMessage({ action: 'scheduleCloseEventTabAfterToken', delayMs: 5000 }, () => {
                    if (chrome.runtime.lastError) {
                        console.warn('[CS] scheduleCloseEventTabAfterToken:', chrome.runtime.lastError.message);
                    } else {
                        console.log('[CS] Background will close this event tab in 5s to save memory (re-opened when needed).');
                    }
                });
                // End any active 403 pause immediately when event tab is verifiably ready.
                chrome.runtime.sendMessage({ action: 'eventTabReloadedClear403Pause' }, (resp) => {
                    if (chrome.runtime.lastError) {
                        console.warn('[CS] eventTabReloadedClear403Pause message failed:', chrome.runtime.lastError.message);
                        return;
                    }
                    if (resp && resp.wasPaused) {
                        console.log('[CS] Cleared active error403 pause early because event tab token is ready.');
                    }
                });

                // ----------------------
                // Extract email (at same time as token)
                // ----------------------
                let emailInput = document.querySelector('#NewClientEmail');
                if (emailInput) {
                    email = emailInput.getAttribute('data-my-email')
                        || emailInput.value
                        || emailInput.placeholder;

                    if (email && email.includes('@')) {
                        localStorage.setItem(EMAIL_KEY, email);
                        console.log("[CS] Email found and saved to localStorage:", email);
                    } else {
                        console.warn("[CS] No valid email found in input.");
                    }
                } else {
                    console.warn("[CS] No email input element found.");
                }
                return true;
            }

            return false;
        };

        // Poll for token until found or timeout
        const pollForToken = () => {
            if (tryExtractTokenAndEmail()) {
                return; // success, stop polling
            }
            waitedMs += POLL_INTERVAL_MS;
            if (waitedMs >= MAX_TOKEN_WAIT_MS) {
                console.warn("[CS] No verification token found within " + (MAX_TOKEN_WAIT_MS / 1000) + "s.");
                return;
            }
            setTimeout(pollForToken, POLL_INTERVAL_MS);
        };

        // Start polling immediately; will proceed as soon as token appears in DOM
        pollForToken();


        // Helpers
        window.getVerificationToken = function () {
            return localStorage.getItem(TOKEN_KEY);
        };

        window.getUserEmail = function () {
            return localStorage.getItem(EMAIL_KEY);
        };
    })();

} else {
    // Stop script execution
    console.warn("[CS] Not an event page. requestVerfication script will not run.");
}
