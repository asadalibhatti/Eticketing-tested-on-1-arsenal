// Keep all bindings inside this IIFE — content.js shares the same isolated world on eticketing pages.
console.log('requestVerification script loaded, on', location.href);

(function () {
    function isBrowsingActivityPausedForTokenScript() {
        const title = (document.title || '').toLowerCase();
        if (title.includes('your browsing activity')) return true;
        try {
            if (document.querySelector('abuse-component[action="block"]')) return true;
            if (document.querySelector('abuse-component')) return true;
        } catch (_) {}
        try {
            const bodyText =
                (document.body && (document.body.innerText || document.body.textContent)) || '';
            const lower = bodyText.toLowerCase();
            if (lower.includes('your browsing activity has been paused')) return true;
            if (lower.includes('your browsing activity has')) return true;
        } catch (_) {}
        return false;
    }

    const RV_EVENT_TITLES_BY_URL_KEY = 'eventTitlesByUrl';

    /** Stable key so the same event keeps one cached title (match content.js history key). */
    function rvNormalizeEventUrlHistoryKey(url) {
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

    function rvReadEventTitleFromDom() {
        const el =
            document.querySelector('h2.eventinfo__name#content') ||
            document.querySelector('h2.eventinfo__name') ||
            document.querySelector('.eventinfo__title h2.eventinfo__name') ||
            document.querySelector('.eventinfo__title h2');
        if (!el) return '';
        return String(el.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Scrape event title once per event URL. Skips DOM work if already cached for this page or stored eventUrl.
     */
    async function rvEnsureEventTitleCachedFromPage() {
        const pageKey = rvNormalizeEventUrlHistoryKey(window.location.href);
        let storedEventUrl = '';
        try {
            const st = await chrome.storage.local.get(['eventUrl', RV_EVENT_TITLES_BY_URL_KEY]);
            storedEventUrl = (st.eventUrl || '').trim();
            const storedKey = rvNormalizeEventUrlHistoryKey(storedEventUrl);
            const map =
                st[RV_EVENT_TITLES_BY_URL_KEY] && typeof st[RV_EVENT_TITLES_BY_URL_KEY] === 'object'
                    ? st[RV_EVENT_TITLES_BY_URL_KEY]
                    : {};
            const existing =
                (pageKey && map[pageKey]) || (storedKey && map[storedKey]) || '';
            if (existing) {
                if ((st.eventTitle || '') !== existing) {
                    await chrome.storage.local.set({ eventTitle: existing });
                }
                return existing;
            }
        } catch (e) {
            console.warn('[CS] Event title cache read failed:', e && e.message);
        }

        const title = rvReadEventTitleFromDom();
        if (!title) return '';

        try {
            const st = await chrome.storage.local.get([RV_EVENT_TITLES_BY_URL_KEY, 'eventUrl']);
            const map =
                st[RV_EVENT_TITLES_BY_URL_KEY] && typeof st[RV_EVENT_TITLES_BY_URL_KEY] === 'object'
                    ? { ...st[RV_EVENT_TITLES_BY_URL_KEY] }
                    : {};
            const storedKey = rvNormalizeEventUrlHistoryKey(st.eventUrl || storedEventUrl);
            if (pageKey) map[pageKey] = title;
            if (storedKey && storedKey !== pageKey) map[storedKey] = title;
            await chrome.storage.local.set({
                [RV_EVENT_TITLES_BY_URL_KEY]: map,
                eventTitle: title
            });
            console.log('[CS] Saved event title for', pageKey || storedKey || '(url)', '→', title);
        } catch (e) {
            console.warn('[CS] Event title save failed:', e && e.message);
        }
        return title;
    }

    if (!window.location.pathname.includes('/EDP/Event/Index/')) {
        console.warn('[CS] Not an event page. requestVerfication script will not run.');
        return;
    }

    console.log('[CS] Reloading page after 120 minutes interval.');
    console.log('[CS] Event page detected. Waiting for 5 seconds before proceeding...');

    // Browsing-pause recovery is handled by content.js / background.
    // Do not extract verification token while the pause page is showing.
    if (isBrowsingActivityPausedForTokenScript()) {
        console.warn(
            '[CS] Browsing activity paused on event page — skipping verification token extraction until page recovers.'
        );
        return;
    }

    const TOKEN_KEY = 'verification_token';
    const EMAIL_KEY = 'user_email';

    console.log(
        '[CS] Event page detected. Will wait for verification token dynamically and proceed as soon as it is available...'
    );

    const MAX_TOKEN_WAIT_MS = 30000;
    const POLL_INTERVAL_MS = 500;
    let waitedMs = 0;
    let eventTitleCacheAttempted = false;

    const tryExtractTokenAndEmail = () => {
        // Title scrape is independent of token; try once early, retry later if DOM not ready yet
        if (!eventTitleCacheAttempted) {
            eventTitleCacheAttempted = true;
            rvEnsureEventTitleCachedFromPage()
                .then((t) => {
                    if (!t) {
                        setTimeout(() => {
                            rvEnsureEventTitleCachedFromPage().catch(() => {});
                        }, 1500);
                    }
                })
                .catch(() => {});
        }

        let token = null;
        let email = null;

        let hiddenInput = document.querySelector('input[name="__RequestVerificationToken"]');
        if (hiddenInput) {
            token = hiddenInput.value;
            console.log('[CS] Token found via hidden input:', token);
        }

        if (!token) {
            let metaToken = document.querySelector('meta[name="__RequestVerificationToken"]');
            if (metaToken) {
                token = metaToken.getAttribute('content');
                console.log('[CS] Token found via meta tag:', token);
            }
        }

        if (!token) {
            let html = document.documentElement.innerHTML;
            let match = html.match(/__RequestVerificationToken\"\\s*value=\"([^\"]+)\"/);
            if (match) {
                token = match[1];
                console.log('[CS] Token found via HTML regex:', token);
            }
        }

        if (token) {
            localStorage.setItem(TOKEN_KEY, token);
            console.log('[CS] Token saved to localStorage');
            chrome.storage.local.set({ eventTabReloaded: true, eventPageReady: true });
            console.log(
                '[CS] Event tab ready flags set (eventTabReloaded=true, eventPageReady=true) — page loaded with token.'
            );
            rvEnsureEventTitleCachedFromPage().catch(() => {});
            chrome.runtime.sendMessage({ action: 'scheduleCloseEventTabAfterToken', delayMs: 5000 }, () => {
                if (chrome.runtime.lastError) {
                    console.warn('[CS] scheduleCloseEventTabAfterToken:', chrome.runtime.lastError.message);
                } else {
                    console.log(
                        '[CS] Background will close this event tab in 5s to save memory (re-opened when needed).'
                    );
                }
            });
            chrome.runtime.sendMessage({ action: 'eventTabReloadedClear403Pause' }, (resp) => {
                if (chrome.runtime.lastError) {
                    console.warn(
                        '[CS] eventTabReloadedClear403Pause message failed:',
                        chrome.runtime.lastError.message
                    );
                    return;
                }
                if (resp && resp.wasPaused) {
                    console.log('[CS] Cleared active error403 pause early because event tab token is ready.');
                }
            });

            let emailInput = document.querySelector('#NewClientEmail');
            if (emailInput) {
                email =
                    emailInput.getAttribute('data-my-email') ||
                    emailInput.value ||
                    emailInput.placeholder;

                if (email && email.includes('@')) {
                    localStorage.setItem(EMAIL_KEY, email);
                    console.log('[CS] Email found and saved to localStorage:', email);
                } else {
                    console.warn('[CS] No valid email found in input.');
                }
            } else {
                console.warn('[CS] No email input element found.');
            }
            return true;
        }

        return false;
    };

    const pollForToken = () => {
        if (tryExtractTokenAndEmail()) {
            return;
        }
        waitedMs += POLL_INTERVAL_MS;
        if (waitedMs >= MAX_TOKEN_WAIT_MS) {
            console.warn('[CS] No verification token found within ' + MAX_TOKEN_WAIT_MS / 1000 + 's.');
            rvEnsureEventTitleCachedFromPage().catch(() => {});
            return;
        }
        setTimeout(pollForToken, POLL_INTERVAL_MS);
    };

    pollForToken();

    window.getVerificationToken = function () {
        return localStorage.getItem(TOKEN_KEY);
    };

    window.getUserEmail = function () {
        return localStorage.getItem(EMAIL_KEY);
    };
})();
