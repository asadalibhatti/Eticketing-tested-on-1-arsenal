// login_tottenham_content.js
console.log('[LOGIN] Tottenham Hotspur login content script loaded on', location.href);

// Check if we're on the correct Tottenham Hotspur login page
(function() {
    if (!window.location.href.includes('auth.tottenhamhotspur.com') || !window.location.href.includes('/u/login')) {
        console.warn('[LOGIN] Not on Tottenham Hotspur login page, stopping script execution');
        return;
    }

    console.log('[LOGIN] Tottenham Hotspur login page detected, starting login automation...');
    console.log('[LOGIN] Current page URL:', window.location.href);
    console.log('[LOGIN] Page title:', document.title);
    console.log('[LOGIN] Document ready state:', document.readyState);

    // Configuration object for login handling
    let loginConfig = {
        running: false,
        maxRetries: 3,
        retryCount: 0
    };

    // Message listener for communication with background script
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        console.log('[LOGIN] Received message:', msg);

        if (msg.action === 'startLogin') {
            console.log('[LOGIN] Starting login process...');
            startLoginProcess().catch(e => {
                console.error('[LOGIN] Login process error:', e);
            });
        }

        if (msg.action === 'stopLogin') {
            console.log('[LOGIN] Stopping login process...');
            stopLoginProcess();
        }

        return true;
    });

    // Auto-start login process with retry mechanism
    (async () => {
        try {
            console.log('[LOGIN] Auto-starting login process...');
            await startLoginProcess();
        } catch (e) {
            console.error('[LOGIN] Auto-start error:', e);
            if (e.message && e.message.includes('form elements not found')) {
                console.log('[LOGIN] Retrying login process after 5 seconds...');
                setTimeout(async () => {
                    try {
                        await startLoginProcess();
                    } catch (retryError) {
                        console.error('[LOGIN] Retry failed:', retryError);
                    }
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

        console.log('[LOGIN] Starting login process...');

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
        console.log('[LOGIN] Retrieving login credentials from Google Sheets...');

        const { loginEmail, loginPassword, currentStatus } = await chrome.storage.local.get(['loginEmail', 'loginPassword', 'currentStatus']);

        if (loginEmail && loginPassword) {
            console.log('[LOGIN] Found credentials in local storage from Google Sheets');
            return { email: loginEmail, password: loginPassword };
        }

        if (currentStatus !== 'on') {
            throw new Error('System is not active. Please ensure your Google Sheet has a row with status "on" and matching startSecond.');
        }

        console.log('[LOGIN] No credentials found, requesting background script to refresh from Google Sheets...');

        try {
            const response = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ action: 'refreshCredentials' }, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        resolve(response);
                    }
                });
            });

            if (response && response.success) {
                const { loginEmail: refreshedEmail, loginPassword: refreshedPassword } = await chrome.storage.local.get(['loginEmail', 'loginPassword']);

                if (refreshedEmail && refreshedPassword) {
                    console.log('[LOGIN] Successfully retrieved credentials after refresh');
                    return { email: refreshedEmail, password: refreshedPassword };
                }
            }
        } catch (error) {
            console.warn('[LOGIN] Failed to refresh credentials from background script:', error);
        }

        throw new Error('Login credentials not available from Google Sheets. Please check:\n1. Your Google Sheet has a row with status "on"\n2. The row has valid loginEmail and loginPassword columns\n3. The startSecond matches your configuration\n4. The Google Sheet URL is correctly configured');
    }

    /** Click "Accept All Cookies" if the button is present (OneTrust banner). */
    async function acceptCookiesIfPresent() {
        const btn = document.querySelector('#onetrust-accept-btn-handler');
        if (btn) {
            console.log('[LOGIN] Accept All Cookies button found, clicking...');
            try {
                btn.click();
                await new Promise(resolve => setTimeout(resolve, 1000));
                console.log('[LOGIN] Accept All Cookies clicked');
            } catch (e) {
                console.warn('[LOGIN] Error clicking Accept All Cookies:', e);
            }
        } else {
            console.log('[LOGIN] No Accept All Cookies button found, continuing');
        }
    }

    async function performLogin() {
        console.log('[LOGIN] Performing login...');

        await waitForLoginForm();

        // Accept cookies first if the banner is present
        await acceptCookiesIfPresent();
        await new Promise(resolve => setTimeout(resolve, 500));

        // Tottenham Hotspur specific: #username (email), #password, Login submit button
        const emailInput = document.querySelector('#username, input[name="username"][type="email"], input[name="username"], input[type="email"]');
        const passwordInput = document.querySelector('#password, input[name="password"], input[type="password"]');
        let submitButton = document.querySelector('button[type="submit"][name="action"][value="default"]');
        if (!submitButton) {
            const allButtons = document.querySelectorAll('button[type="submit"]');
            for (const button of allButtons) {
                if (button.textContent.trim() === 'Login') {
                    submitButton = button;
                    break;
                }
            }
        }
        if (!submitButton) {
            submitButton = document.querySelector('button[type="submit"], input[type="submit"]');
        }

        if (!emailInput || !passwordInput || !submitButton) {
            console.error('[LOGIN] Login form elements not found after waiting');
            throw new Error('Login form elements not found after waiting for form to load');
        }

        console.log('[LOGIN] Login form elements found');

        await new Promise(resolve => setTimeout(resolve, 1500));

        const credentials = await getLoginCredentials();
        const currentEmail = credentials.email;
        const currentPassword = credentials.password;

        try {
            emailInput.value = '';
            passwordInput.value = '';
        } catch (e) {
            console.warn('[LOGIN] Error clearing form values:', e);
        }

        await new Promise(resolve => setTimeout(resolve, 500));

        try {
            emailInput.value = currentEmail;
            passwordInput.value = currentPassword;
            console.log('[LOGIN] Filled form with credentials - Email:', currentEmail, 'Password length:', currentPassword.length);
        } catch (e) {
            console.error('[LOGIN] Error filling form values:', e);
            throw e;
        }

        emailInput.focus();
        await new Promise(resolve => setTimeout(resolve, 200));
        emailInput.click();
        await new Promise(resolve => setTimeout(resolve, 200));
        emailInput.dispatchEvent(new Event('focus', { bubbles: true, cancelable: true }));
        emailInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        emailInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        emailInput.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));

        await new Promise(resolve => setTimeout(resolve, 300));

        passwordInput.focus();
        await new Promise(resolve => setTimeout(resolve, 200));
        passwordInput.click();
        await new Promise(resolve => setTimeout(resolve, 200));
        passwordInput.dispatchEvent(new Event('focus', { bubbles: true, cancelable: true }));
        passwordInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        passwordInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        passwordInput.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));

        const form = emailInput.closest('form') || passwordInput.closest('form');
        if (form) {
            form.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            form.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        }

        document.body.click();
        await new Promise(resolve => setTimeout(resolve, 300));

        submitButton.scrollIntoView({ behavior: 'smooth' });
        await new Promise(resolve => setTimeout(resolve, 1000));

        try {
            console.log('[LOGIN] Clicking Login button...');
            submitButton.click();
            console.log('[LOGIN] Login button clicked successfully');
        } catch (e) {
            console.error('[LOGIN] Error clicking submit button:', e);
            throw e;
        }

        await waitForLoginResult();
    }

    async function waitForLoginResult() {
        console.log('[LOGIN] Waiting for login result...');

        const maxWaitTime = 90000;
        const checkInterval = 2000;
        let elapsed = 0;

        return new Promise((resolve, reject) => {
            const checkTimer = setInterval(() => {
                elapsed += checkInterval;

                // Success: no longer on auth.tottenhamhotspur.com/u/login
                if (!window.location.href.includes('/u/login') || !window.location.href.includes('auth.tottenhamhotspur.com')) {
                    clearInterval(checkTimer);
                    console.log('[LOGIN] Login successful, redirected to:', window.location.href);
                    loginConfig.running = false;
                    resolve();
                    return;
                }

                const errorElements = document.querySelectorAll('.error, .alert-error, .login-error, [class*="error"], .alert-danger, .text-danger, [role="alert"]');
                if (errorElements.length > 0) {
                    const errorText = Array.from(errorElements).map(el => el.textContent).join(' ');
                    console.warn('[LOGIN] Login error detected:', errorText);

                    if (loginConfig.retryCount < loginConfig.maxRetries) {
                        loginConfig.retryCount++;
                        console.log(`[LOGIN] Retrying login (attempt ${loginConfig.retryCount}/${loginConfig.maxRetries})...`);
                        setTimeout(() => {
                            performLogin().then(resolve).catch(reject);
                        }, 2000);
                    } else {
                        clearInterval(checkTimer);
                        reject(new Error('Login failed after maximum retries'));
                    }
                    return;
                }

                if (document.querySelector('[class*="captcha"], [class*="recaptcha"], [class*="verification"], [class*="hcaptcha"]')) {
                    console.log('[LOGIN] CAPTCHA or verification challenge detected');
                    clearInterval(checkTimer);
                    loginConfig.running = false;
                    resolve();
                    return;
                }

                if (elapsed % 10000 === 0 && elapsed > 0) {
                    console.log('[LOGIN] Still waiting for login result...', elapsed / 1000, 'seconds elapsed');
                }

                if (elapsed >= maxWaitTime) {
                    clearInterval(checkTimer);
                    console.log('[LOGIN] Login timeout after', maxWaitTime / 1000, 'seconds');
                    reject(new Error('Login timeout'));
                    return;
                }
            }, checkInterval);
        });
    }

    async function waitForLoginForm() {
        console.log('[LOGIN] Waiting for login form elements to appear...');

        const maxWaitTime = 30000;
        const checkInterval = 1000;
        let elapsed = 0;

        return new Promise((resolve, reject) => {
            const checkForForm = () => {
                elapsed += checkInterval;

                const emailInput = document.querySelector('#username, input[name="username"][type="email"], input[name="username"], input[type="email"]');
                const passwordInput = document.querySelector('#password, input[name="password"], input[type="password"]');
                let submitButton = document.querySelector('button[type="submit"][name="action"][value="default"]');
                if (!submitButton) {
                    const allButtons = document.querySelectorAll('button[type="submit"]');
                    for (const button of allButtons) {
                        if (button.textContent.trim() === 'Login') {
                            submitButton = button;
                            break;
                        }
                    }
                }
                if (!submitButton) {
                    submitButton = document.querySelector('button[type="submit"], input[type="submit"]');
                }

                if (emailInput && passwordInput && submitButton) {
                    console.log('[LOGIN] All login form elements found after', elapsed / 1000, 'seconds');
                    resolve();
                    return;
                }

                if (elapsed % 5000 === 0) {
                    console.log('[LOGIN] Still waiting for login form...', elapsed / 1000, 'seconds elapsed');
                }

                if (elapsed >= maxWaitTime) {
                    console.error('[LOGIN] Login form timeout after', maxWaitTime / 1000, 'seconds');
                    reject(new Error(`Login form elements not found within ${maxWaitTime}ms`));
                    return;
                }

                setTimeout(checkForForm, checkInterval);
            };

            checkForForm();
        });
    }

    // Monitor for successful login
    function monitorLoginSuccess() {
        if (window.location.href.includes('auth.tottenhamhotspur.com') && !window.location.href.includes('/u/login')) {
            console.log('[LOGIN] Login success detected on Tottenham Hotspur');
            chrome.runtime.sendMessage({
                action: 'loginSuccess',
                url: window.location.href
            });
        }
    }

    setInterval(monitorLoginSuccess, 2000);

    if (window.location.href.includes('auth.tottenhamhotspur.com') && !window.location.href.includes('/u/login')) {
        console.log('[LOGIN] Already on logged-in Tottenham Hotspur page');
    }

    console.log('[LOGIN] Tottenham Hotspur login content script initialization complete');
})();
