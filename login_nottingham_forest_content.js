// login_nottingham_forest_content.js
// Works on https://login.nottinghamforest.co.uk/auth/login (Shoelace sl-input + ALTCHA onsubmit)
console.log('[LOGIN] Nottingham Forest login content script loaded on', location.href);

(function () {
    const href = window.location.href.toLowerCase();
    if (!href.includes('login.nottinghamforest.co.uk')) {
        console.warn('[LOGIN] Not on Nottingham Forest login host, stopping');
        return;
    }
    // Prefer /auth/login pages; still allow other login paths under this host
    if (!href.includes('/auth/login') && !href.includes('/auth/login?')) {
        // Older paths may still land here; continue if login form exists later
        console.log('[LOGIN] URL is not /auth/login — will still try if login form appears');
    }

    console.log('[LOGIN] Nottingham Forest login page detected, starting login automation...');

    let loginConfig = {
        running: false,
        maxRetries: 3,
        retryCount: 0
    };

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.action === 'startLogin') {
            startLoginProcess().catch((e) => console.error('[LOGIN] Login process error:', e));
        }
        if (msg.action === 'stopLogin') {
            stopLoginProcess();
        }
        return true;
    });

    (async () => {
        try {
            await startLoginProcess();
        } catch (e) {
            console.error('[LOGIN] Auto-start error:', e);
            if (String(e && e.message || '').includes('form elements not found')) {
                setTimeout(() => {
                    startLoginProcess().catch((retryError) =>
                        console.error('[LOGIN] Retry failed:', retryError)
                    );
                }, 5000);
            }
        }
    })();

    async function startLoginProcess() {
        if (loginConfig.running) {
            console.log('[LOGIN] Login process already running');
            return;
        }
        loginConfig.running = true;
        loginConfig.retryCount = 0;
        try {
            await performLogin();
        } catch (e) {
            console.error('[LOGIN] Login process failed:', e);
            loginConfig.running = false;
        }
    }

    function stopLoginProcess() {
        loginConfig.running = false;
        console.log('[LOGIN] Login process stopped');
    }

    async function getLoginCredentials() {
        const { loginEmail, loginPassword, currentStatus } = await chrome.storage.local.get([
            'loginEmail',
            'loginPassword',
            'currentStatus'
        ]);
        if (loginEmail && loginPassword) {
            return { email: loginEmail, password: loginPassword };
        }
        if (currentStatus !== 'on') {
            throw new Error('System is not active. Ensure Google Sheet status is on.');
        }
        const response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'refreshCredentials' }, (resp) => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(resp);
            });
        });
        if (response && response.success) {
            const refreshed = await chrome.storage.local.get(['loginEmail', 'loginPassword']);
            if (refreshed.loginEmail && refreshed.loginPassword) {
                return { email: refreshed.loginEmail, password: refreshed.loginPassword };
            }
        }
        throw new Error('Login credentials not available from Google Sheets.');
    }

    /** Find Shoelace / classic email+password+submit for Forest login. */
    function findLoginControls() {
        const form =
            document.querySelector('form#authForm') ||
            document.querySelector('#login-field form') ||
            document.querySelector('form.validity-styles') ||
            document.querySelector('.login-view form#authForm');

        const emailSl =
            document.querySelector('sl-input[name="email"]') ||
            document.querySelector('#login-field sl-input[type="email"]') ||
            document.querySelector('form#authForm sl-input[name="email"]');
        const passwordSl =
            document.querySelector('sl-input[name="password"]') ||
            document.querySelector('#login-field sl-input[type="password"]') ||
            document.querySelector('form#authForm sl-input[name="password"]');

        const emailNative =
            document.querySelector('input[name="email"][type="email"]') ||
            document.querySelector('#Email, input[name="Email"], input[type="email"]');
        const passwordNative =
            document.querySelector('input[name="password"][type="password"]') ||
            document.querySelector('#Password, input[name="Password"], input[type="password"]');

        const submitButton =
            document.querySelector('#submitForm') ||
            document.querySelector('input[type="submit"][value="Log in"]') ||
            document.querySelector('form#authForm input[type="submit"]') ||
            document.querySelector('input.signin-btn, button.signin-btn');

        return {
            form,
            emailInput: emailSl || emailNative,
            passwordInput: passwordSl || passwordNative,
            submitButton,
            usesShoelace: !!(emailSl && passwordSl)
        };
    }

    function setControlValue(el, value) {
        if (!el) return;
        try {
            el.value = value;
        } catch (_) {}
        // Shoelace: also set attribute + fire events that update validity
        try {
            if (el.tagName && el.tagName.toLowerCase() === 'sl-input') {
                el.setAttribute('value', value);
                if (typeof el.focus === 'function') el.focus();
            }
        } catch (_) {}
        try {
            el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        } catch (_) {}
        // Shadow native input if present
        try {
            const inner = el.shadowRoot && el.shadowRoot.querySelector('input');
            if (inner) {
                inner.value = value;
                inner.dispatchEvent(new Event('input', { bubbles: true }));
                inner.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (_) {}
    }

    async function waitForLoginForm() {
        const maxWaitTime = 30000;
        const checkInterval = 500;
        let elapsed = 0;
        return new Promise((resolve, reject) => {
            const tick = () => {
                elapsed += checkInterval;
                const c = findLoginControls();
                if (c.emailInput && c.passwordInput && c.submitButton) {
                    console.log(
                        '[LOGIN] Form ready after',
                        elapsed / 1000,
                        's (shoelace=',
                        c.usesShoelace,
                        ')'
                    );
                    resolve(c);
                    return;
                }
                if (elapsed % 5000 < checkInterval) {
                    console.log(
                        '[LOGIN] Waiting for form…',
                        elapsed / 1000,
                        's email=',
                        !!c.emailInput,
                        'pass=',
                        !!c.passwordInput,
                        'submit=',
                        !!c.submitButton
                    );
                }
                if (elapsed >= maxWaitTime) {
                    reject(new Error('Login form elements not found after waiting for form to load'));
                    return;
                }
                setTimeout(tick, checkInterval);
            };
            tick();
        });
    }

    async function performLogin() {
        console.log('[LOGIN] Performing Nottingham Forest login…');
        let controls = await waitForLoginForm();
        await new Promise((r) => setTimeout(r, 800));
        controls = findLoginControls();
        if (!controls.emailInput || !controls.passwordInput || !controls.submitButton) {
            throw new Error('Login form elements not found after waiting for form to load');
        }

        const credentials = await getLoginCredentials();
        console.log('[LOGIN] Filling credentials for', credentials.email);

        setControlValue(controls.emailInput, '');
        setControlValue(controls.passwordInput, '');
        await new Promise((r) => setTimeout(r, 300));
        setControlValue(controls.emailInput, credentials.email);
        setControlValue(controls.passwordInput, credentials.password);

        // Nudge validation / Shoelace internals
        try {
            controls.emailInput.focus && controls.emailInput.focus();
            controls.passwordInput.focus && controls.passwordInput.focus();
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 400));

        const form = controls.form || controls.emailInput.closest('form') || document.querySelector('form#authForm');
        controls.submitButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise((r) => setTimeout(r, 500));

        // ALTCHA is auto="onsubmit" — clicking Log in should trigger it; do not abort just because widget exists
        console.log('[LOGIN] Clicking Log in (#submitForm)…');
        try {
            controls.submitButton.click();
        } catch (e) {
            console.warn('[LOGIN] submit click failed, trying form.requestSubmit:', e);
            if (form && typeof form.requestSubmit === 'function') form.requestSubmit(controls.submitButton);
            else if (form) form.submit();
        }

        await waitForLoginResult();
    }

    async function waitForLoginResult() {
        console.log('[LOGIN] Waiting for login result…');
        const maxWaitTime = 90000;
        const checkInterval = 2000;
        let elapsed = 0;

        return new Promise((resolve, reject) => {
            const checkTimer = setInterval(() => {
                elapsed += checkInterval;
                const loc = window.location.href.toLowerCase();

                // Left the login host / auth login path → success
                if (
                    loc.includes('nottinghamforest.co.uk') &&
                    !loc.includes('login.nottinghamforest.co.uk')
                ) {
                    clearInterval(checkTimer);
                    console.log('[LOGIN] Login successful, redirected to:', window.location.href);
                    loginConfig.running = false;
                    resolve();
                    return;
                }
                if (loc.includes('login.nottinghamforest.co.uk') && !loc.includes('/auth/login')) {
                    // e.g. redirected to another auth step that is not the login form
                    console.log('[LOGIN] Navigated away from /auth/login:', window.location.href);
                }

                const errorElements = document.querySelectorAll(
                    '.error, .alert-error, .login-error, .alert-danger, .text-danger, .field-validation-error, [class*="validation-summary"]'
                );
                const errorText = Array.from(errorElements)
                    .map((el) => (el.textContent || '').trim())
                    .filter(Boolean)
                    .join(' ');
                if (errorText && /invalid|incorrect|failed|error/i.test(errorText)) {
                    console.warn('[LOGIN] Login error detected:', errorText);
                    if (loginConfig.retryCount < loginConfig.maxRetries) {
                        loginConfig.retryCount++;
                        clearInterval(checkTimer);
                        setTimeout(() => {
                            performLogin().then(resolve).catch(reject);
                        }, 2000);
                    } else {
                        clearInterval(checkTimer);
                        reject(new Error('Login failed after maximum retries'));
                    }
                    return;
                }

                // ALTCHA verifying — wait, do not treat as hard failure
                const altcha = document.querySelector('altcha-widget');
                if (altcha) {
                    const state =
                        (altcha.getAttribute('data-state') ||
                            (altcha.shadowRoot &&
                                altcha.shadowRoot.querySelector('.altcha') &&
                                altcha.shadowRoot.querySelector('.altcha').getAttribute('data-state')) ||
                            '') + '';
                    if (/verifying/i.test(state)) {
                        if (elapsed % 10000 < checkInterval) {
                            console.log('[LOGIN] ALTCHA verifying…');
                        }
                    }
                }

                if (elapsed % 10000 < checkInterval && elapsed > 0) {
                    console.log('[LOGIN] Still waiting…', elapsed / 1000, 's');
                }
                if (elapsed >= maxWaitTime) {
                    clearInterval(checkTimer);
                    reject(new Error('Login timeout'));
                }
            }, checkInterval);
        });
    }

    function extractAuthData() {
        const html = document.documentElement.innerHTML;
        const match = html.match(/__RequestVerificationToken["\s]*value=["']([^"']+)["']/);
        if (match) {
            localStorage.setItem('nottingham_forest_auth_token', match[1]);
            return match[1];
        }
        return null;
    }

    function monitorLoginSuccess() {
        const loc = window.location.href.toLowerCase();
        if (loc.includes('nottinghamforest.co.uk') && !loc.includes('login.nottinghamforest.co.uk')) {
            extractAuthData();
            chrome.runtime.sendMessage({ action: 'loginSuccess', url: window.location.href }, () => {
                void chrome.runtime.lastError;
            });
        }
    }

    setInterval(monitorLoginSuccess, 2000);
    console.log('[LOGIN] Nottingham Forest login content script initialization complete');
})();
