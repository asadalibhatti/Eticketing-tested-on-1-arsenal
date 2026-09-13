// arsenal_membership_red_content.js — JOIN NOW on /membership/red; reload on fetch-fail or 15s timeout.
console.log('[Arsenal Membership] Script loaded on', location.href);

(function () {
    const href = (location.href || '').toLowerCase();
    if (!href.includes('www.arsenal.com') || !href.includes('/membership/red')) {
        console.log('[Arsenal Membership] Not on /membership/red — skipping');
        return;
    }

    let joinClicked = false;
    let reloadScheduled = false;
    let attempts = 0;
    const POLL_MS = 1000;
    const RELOAD_AFTER_FETCH_FAILED_MS = 3 * 1000;
    /** Backup: if JOIN NOW never appears and fetch-fail not handled, reload anyway. */
    const BACKUP_RELOAD_MS = 15 * 1000;

    function findJoinNowButton() {
        const wrappers = document.querySelectorAll('.button-group-wrapper a.button, a.button');
        for (let i = 0; i < wrappers.length; i++) {
            const a = wrappers[i];
            const title = (a.getAttribute('title') || '').trim().toUpperCase();
            const text = (a.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
            if (title === 'JOIN NOW' || text === 'JOIN NOW') return a;
        }
        return null;
    }

    function textLooksLikeFetchFailed(raw) {
        const t = String(raw || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
        return t.includes('failed to fetch') || t.includes('no data available');
    }

    /**
     * Matches the Red Membership error block:
     * <div class="ui-notification" role="status">
     *   <div class="ui-notification-title">No Data available</div>
     *   <p class="ui-notification-text">Failed to fetch</p>
     * </div>
     */
    function hasFetchFailedNotification() {
        try {
            const textEl = document.querySelector('p.ui-notification-text, .ui-notification-text');
            if (textEl && textLooksLikeFetchFailed(textEl.textContent)) return true;

            const titleEl = document.querySelector('.ui-notification-title');
            if (titleEl && textLooksLikeFetchFailed(titleEl.textContent)) return true;

            const box = document.querySelector('.ui-notification[role="status"], .ui-notification');
            if (box && textLooksLikeFetchFailed(box.textContent)) return true;

            const main = document.querySelector('main#main-content, main.Structure_main__mStf0, main');
            if (main && textLooksLikeFetchFailed(main.innerText || main.textContent)) return true;

            if (textLooksLikeFetchFailed(document.body && (document.body.innerText || document.body.textContent))) {
                return true;
            }
        } catch (_) {}
        return false;
    }

    function scheduleReload(reason, waitMs) {
        if (reloadScheduled || joinClicked) return;
        reloadScheduled = true;
        if (tick) clearInterval(tick);
        console.warn(
            '[Arsenal Membership] ' +
                reason +
                ' — waiting ' +
                waitMs / 1000 +
                's then reloading https://www.arsenal.com/membership/red'
        );
        setTimeout(() => {
            location.reload();
        }, waitMs);
    }

    function tryClickJoinNow() {
        if (joinClicked || reloadScheduled) return true;

        if (hasFetchFailedNotification()) {
            scheduleReload('"Failed to fetch" / No Data available on page', RELOAD_AFTER_FETCH_FAILED_MS);
            return true;
        }

        attempts++;
        const btn = findJoinNowButton();
        if (!btn) {
            if (attempts === 1 || attempts % 5 === 0) {
                console.log('[Arsenal Membership] Waiting for JOIN NOW button… attempt', attempts);
            }
            return false;
        }

        joinClicked = true;
        const joinHref = (btn.href || btn.getAttribute('href') || '').trim();
        console.log('[Arsenal Membership] JOIN NOW found — same-tab navigate', joinHref || '(no href)');
        // Always same tab: JOIN NOW often has target=_blank and opens a second event tab.
        try {
            btn.removeAttribute('target');
            btn.setAttribute('target', '_self');
        } catch (_) {}
        try {
            if (joinHref && !joinHref.startsWith('#') && joinHref.toLowerCase() !== 'javascript:void(0)') {
                location.assign(joinHref);
            } else {
                btn.click();
            }
        } catch (e) {
            console.warn('[Arsenal Membership] same-tab navigate failed, click fallback:', e);
            try {
                btn.click();
            } catch (e2) {
                if (joinHref) location.href = joinHref;
            }
        }
        return true;
    }

    const tick = setInterval(() => {
        if (tryClickJoinNow()) clearInterval(tick);
    }, POLL_MS);

    if (tryClickJoinNow()) clearInterval(tick);

    setTimeout(() => {
        if (joinClicked || reloadScheduled) return;
        if (findJoinNowButton()) return;
        scheduleReload('JOIN NOW not found within 15s (backup reload)', 0);
    }, BACKUP_RELOAD_MS);

    try {
        const mo = new MutationObserver(() => {
            if (reloadScheduled || joinClicked) return;
            if (hasFetchFailedNotification()) {
                scheduleReload('"Failed to fetch" / No Data available on page', RELOAD_AFTER_FETCH_FAILED_MS);
            }
        });
        mo.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true
        });
    } catch (_) {}
})();
