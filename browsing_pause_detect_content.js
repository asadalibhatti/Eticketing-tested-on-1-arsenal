/**
 * Lightweight browsing-pause detector for web-identity (and similar) hosts.
 * Detects: title text, body text, <abuse-component action="block">, stuck /connect/authorize.
 */
(function () {
    const STUCK_AUTHORIZE_MS = 6000;
    const POLL_MS = 2000;
    let reported = false;
    let stuckConfirmed = false;
    let stuckTimerId = null;

    function hasAbuseBlockComponent() {
        try {
            if (document.querySelector('abuse-component[action="block"]')) return true;
            if (document.querySelector('abuse-component')) return true;
        } catch (_) {}
        return false;
    }

    function isStuckWebIdentityAuthorize() {
        try {
            const host = (location.hostname || '').toLowerCase();
            const path = (location.pathname || '').toLowerCase();
            if (!host.includes('web-identity.tmtickets.co.uk')) return false;
            return path.includes('/connect/authorize');
        } catch (_) {
            return false;
        }
    }

    function isBrowsingActivityPausedOnPage() {
        const title = (document.title || '').toLowerCase();
        if (title.includes('your browsing activity')) return true;
        if (hasAbuseBlockComponent()) return true;
        try {
            const bodyText =
                (document.body && (document.body.innerText || document.body.textContent)) || '';
            const lower = bodyText.toLowerCase();
            if (lower.includes('your browsing activity has been paused')) return true;
            if (lower.includes('your browsing activity has')) return true;
        } catch (_) {}
        return false;
    }

    function isPausedEffective() {
        if (isBrowsingActivityPausedOnPage()) return true;
        // Stuck authorize counts as paused once confirmed (BG also checks URL after grace)
        if (stuckConfirmed && isStuckWebIdentityAuthorize()) return true;
        return false;
    }

    function notifyPaused(source) {
        if (reported) return;
        reported = true;
        console.warn(
            '[CS] Browsing activity paused detected (' + (source || 'dom') + ') on',
            location.href
        );
        const src = source || 'web-identity-detect';
        chrome.runtime.sendMessage(
            { action: 'browsingActivityPaused', source: src },
            () => {
                if (chrome.runtime.lastError) {
                    console.warn(
                        '[CS] browsingActivityPaused:',
                        chrome.runtime.lastError.message
                    );
                    reported = false;
                }
            }
        );
    }

    function checkNow() {
        if (isBrowsingActivityPausedOnPage()) {
            notifyPaused(
                hasAbuseBlockComponent() ? 'web-identity-abuse-component' : 'web-identity-title-or-body'
            );
            return true;
        }
        if (stuckConfirmed && isStuckWebIdentityAuthorize()) {
            notifyPaused('web-identity-stuck-authorize');
            return true;
        }
        return false;
    }

    function armStuckAuthorizeWatch() {
        if (!isStuckWebIdentityAuthorize()) {
            stuckConfirmed = false;
            return;
        }
        if (stuckTimerId != null) return;
        console.log(
            '[CS] web-identity /connect/authorize — if still here in ' +
                STUCK_AUTHORIZE_MS / 1000 +
                's, treat as browsing pause'
        );
        stuckTimerId = setTimeout(() => {
            stuckTimerId = null;
            if (!isStuckWebIdentityAuthorize()) return;
            stuckConfirmed = true;
            notifyPaused('web-identity-stuck-authorize');
        }, STUCK_AUTHORIZE_MS);
    }

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg && msg.action === 'isBrowsingActivityPaused') {
            sendResponse({
                paused: isPausedEffective(),
                abuseComponent: hasAbuseBlockComponent(),
                stuckAuthorize: isStuckWebIdentityAuthorize(),
                stuckConfirmed: stuckConfirmed
            });
            return false;
        }
    });

    checkNow();
    armStuckAuthorizeWatch();

    try {
        const mo = new MutationObserver(() => {
            checkNow();
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}

    setInterval(() => {
        if (!checkNow()) {
            if (reported && !isPausedEffective()) {
                reported = false;
            }
        }
        armStuckAuthorizeWatch();
    }, POLL_MS);
})();
