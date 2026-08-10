// arsenal_membership_red_content.js — open event via Red membership: click JOIN NOW → Memberships/List → eventUrl.
console.log('[Arsenal Membership] Script loaded on', location.href);

(function () {
    const href = (location.href || '').toLowerCase();
    if (!href.includes('www.arsenal.com') || !href.includes('/membership/red')) {
        console.log('[Arsenal Membership] Not on /membership/red — skipping');
        return;
    }

    let joinClicked = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 120; // ~2 min at 1s

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

    async function tryClickJoinNow() {
        if (joinClicked) return true;
        attempts++;
        const btn = findJoinNowButton();
        if (!btn) {
            if (attempts === 1 || attempts % 10 === 0) {
                console.log('[Arsenal Membership] Waiting for JOIN NOW button… attempt', attempts);
            }
            return false;
        }
        joinClicked = true;
        console.log('[Arsenal Membership] JOIN NOW found — clicking', btn.href || '(no href)');
        try {
            btn.click();
        } catch (e) {
            console.warn('[Arsenal Membership] click failed, navigating href:', e);
            if (btn.href) location.href = btn.href;
        }
        return true;
    }

    const tick = setInterval(async () => {
        if (attempts >= MAX_ATTEMPTS) {
            clearInterval(tick);
            console.warn('[Arsenal Membership] JOIN NOW not found within timeout');
            return;
        }
        if (await tryClickJoinNow()) clearInterval(tick);
    }, 1000);

    tryClickJoinNow().then((done) => {
        if (done) clearInterval(tick);
    });
})();
