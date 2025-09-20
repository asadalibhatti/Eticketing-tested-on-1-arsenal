// login_arsenal_content.js
console.log('[LOGIN] Arsenal login content script loaded on', location.href);

// Check if we're on the correct Arsenal login page
(function() {
    if (!window.location.href.includes('myaccount.arsenal.com/login')) {
        console.warn('[LOGIN] Not on Arsenal login page, stopping script execution');
        return;
    }
    
    console.log('[LOGIN] Arsenal login page detected, starting login automation...');
    
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
    
    // Auto-start login process
    (async () => {
        try {
            console.log('[LOGIN] Auto-starting login process...');
            await startLoginProcess();
        } catch (e) {
            console.error('[LOGIN] Auto-start error:', e);
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
        
        // First, try to get credentials from local storage
        const { loginEmail, loginPassword, currentStatus } = await chrome.storage.local.get(['loginEmail', 'loginPassword', 'currentStatus']);
        
        if (loginEmail && loginPassword) {
            console.log('[LOGIN] Found credentials in local storage from Google Sheets');
            return { email: loginEmail, password: loginPassword };
        }
        
        // If no credentials found, check if the system is active
        if (currentStatus !== 'on') {
            throw new Error('System is not active. Please ensure your Google Sheet has a row with status "on" and matching startSecond.');
        }
        
        // Request background script to refresh credentials from Google Sheets
        console.log('[LOGIN] No credentials found, requesting background script to refresh from Google Sheets...');
        
        try {
            // Send message to background script to refresh credentials
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
                // Try again to get credentials after refresh
                const { loginEmail: refreshedEmail, loginPassword: refreshedPassword } = await chrome.storage.local.get(['loginEmail', 'loginPassword']);
                
                if (refreshedEmail && refreshedPassword) {
                    console.log('[LOGIN] Successfully retrieved credentials after refresh');
                    return { email: refreshedEmail, password: refreshedPassword };
                }
            }
        } catch (error) {
            console.warn('[LOGIN] Failed to refresh credentials from background script:', error);
        }
        
        // Final fallback - throw error
        throw new Error('Login credentials not available from Google Sheets. Please check:\n1. Your Google Sheet has a row with status "on"\n2. The row has valid loginEmail and loginPassword columns\n3. The startSecond matches your configuration\n4. The Google Sheet URL is correctly configured');
    }
    
    async function performLogin() {
        console.log('[LOGIN] Performing login...');
        
        // Wait for page to be fully loaded
        await waitForElement('form', 5000);
        
        // Find login form elements
        const emailInput = document.querySelector('input[type="email"], input[name="email"], #email, #Email');
        const passwordInput = document.querySelector('input[type="password"], input[name="password"], #password, #Password');
        const submitButton = document.querySelector('button[type="submit"], input[type="submit"], .login-button, #login-button');
        
        if (!emailInput || !passwordInput || !submitButton) {
            throw new Error('Login form elements not found');
        }
        
        console.log('[LOGIN] Login form elements found, checking for autofilled credentials...');
        
        // Wait a bit for autofill to complete
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Get login credentials from local storage (from Google Sheets)
        const credentials = await getLoginCredentials();
        
        console.log('[LOGIN] Using credentials from Google Sheets, filling form fields...');
        const currentEmail = credentials.email;
        const currentPassword = credentials.password;
        
        // Clear existing values first
        emailInput.value = '';
        passwordInput.value = '';
        
        // Wait a moment for fields to clear
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Fill in the specific credentials
        emailInput.value = currentEmail;
        passwordInput.value = currentPassword;
        
        // Comprehensive simulation of user interaction with email field
        emailInput.focus();
        await new Promise(resolve => setTimeout(resolve, 200));
        emailInput.click();
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Trigger all possible events for email field
        emailInput.dispatchEvent(new Event('focus', { bubbles: true, cancelable: true }));
        emailInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        emailInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        emailInput.dispatchEvent(new Event('keydown', { bubbles: true, cancelable: true }));
        emailInput.dispatchEvent(new Event('keyup', { bubbles: true, cancelable: true }));
        emailInput.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
        
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Comprehensive simulation of user interaction with password field
        passwordInput.focus();
        await new Promise(resolve => setTimeout(resolve, 200));
        passwordInput.click();
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Trigger all possible events for password field
        passwordInput.dispatchEvent(new Event('focus', { bubbles: true, cancelable: true }));
        passwordInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        passwordInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        passwordInput.dispatchEvent(new Event('keydown', { bubbles: true, cancelable: true }));
        passwordInput.dispatchEvent(new Event('keyup', { bubbles: true, cancelable: true }));
        passwordInput.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
        
        // Additional: Try to trigger form validation events
        const form = emailInput.closest('form') || passwordInput.closest('form');
        if (form) {
            form.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            form.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        }
        
        // Simulate clicking on the document/window to trigger global validation
        document.body.click();
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Try alternative method: simulate typing in the fields
        emailInput.focus();
        emailInput.select();
        emailInput.setSelectionRange(0, currentEmail.length);
        emailInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        emailInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
        
        await new Promise(resolve => setTimeout(resolve, 200));
        
        passwordInput.focus();
        passwordInput.select();
        passwordInput.setSelectionRange(0, currentPassword.length);
        passwordInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        passwordInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
        
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Try clicking on the form itself
        if (form) {
            form.click();
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        // Final check: try to trigger validation by dispatching a custom event
        const validationEvent = new CustomEvent('validation', { bubbles: true, cancelable: true });
        emailInput.dispatchEvent(validationEvent);
        passwordInput.dispatchEvent(validationEvent);
        if (form) form.dispatchEvent(validationEvent);
        
        console.log('[LOGIN] Comprehensive user interaction simulated, submitting login form...');
        
        // Scroll to the submit button
        submitButton.scrollIntoView({ behavior: 'smooth' });

        // Wait longer for form validation to update
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Click submit button
        submitButton.click();

        // Wait longer for form validation to update
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Wait for navigation or error
        await performLogin();
    }
    
    async function waitForLoginResult() {
        console.log('[LOGIN] Waiting for login result...');
        
        const maxWaitTime = 30000; // 30 seconds
        const checkInterval = 1000; // Check every second
        let elapsed = 0;
        
        return new Promise((resolve, reject) => {
            const checkInterval = setInterval(() => {
                elapsed += 1000;
                
                // Check if we've been redirected to a success page
                if (window.location.href.includes('myaccount.arsenal.com') && 
                    !window.location.href.includes('login')) {
                    clearInterval(checkInterval);
                    console.log('[LOGIN] Login successful, redirected to:', window.location.href);
                    loginConfig.running = false;
                    resolve();
                    return;
                }
                
                // Check for error messages
                const errorElements = document.querySelectorAll('.error, .alert-error, .login-error, [class*="error"]');
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
                        clearInterval(checkInterval);
                        reject(new Error('Login failed after maximum retries'));
                    }
                    return;
                }
                
                // Check for CAPTCHA or verification challenges
                if (document.querySelector('[class*="captcha"], [class*="recaptcha"], [class*="verification"]')) {
                    console.log('[LOGIN] CAPTCHA or verification challenge detected');
                    clearInterval(checkInterval);
                    loginConfig.running = false;
                    resolve(); // Don't fail, just stop and let user handle manually
                    return;
                }
                
                // Timeout
                if (elapsed >= maxWaitTime) {
                    clearInterval(checkInterval);
                    reject(new Error('Login timeout'));
                    return;
                }
            }, 1000);
        });
    }
    
    async function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const element = document.querySelector(selector);
            if (element) {
                resolve(element);
                return;
            }
            
            const observer = new MutationObserver(() => {
                const element = document.querySelector(selector);
                if (element) {
                    observer.disconnect();
                    resolve(element);
                }
            });
            
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
            
            setTimeout(() => {
                observer.disconnect();
                reject(new Error(`Element ${selector} not found within ${timeout}ms`));
            }, timeout);
        });
    }
    
    // Extract and store any authentication tokens or session data
    function extractAuthData() {
        console.log('[LOGIN] Extracting authentication data...');
        
        // Look for common token patterns
        const tokenPatterns = [
            /__RequestVerificationToken["\s]*value=["']([^"']+)["']/,
            /authToken["\s]*[:=]["']([^"']+)["']/,
            /sessionToken["\s]*[:=]["']([^"']+)["']/,
            /csrf["\s]*[:=]["']([^"']+)["']/
        ];
        
        const html = document.documentElement.innerHTML;
        
        for (const pattern of tokenPatterns) {
            const match = html.match(pattern);
            if (match) {
                const token = match[1];
                localStorage.setItem('arsenal_auth_token', token);
                console.log('[LOGIN] Authentication token extracted and stored');
                return token;
            }
        }
        
        // Check for cookies
        const cookies = document.cookie.split(';').reduce((acc, cookie) => {
            const [key, value] = cookie.trim().split('=');
            acc[key] = value;
            return acc;
        }, {});
        
        if (cookies['ASP.NET_SessionId'] || cookies['__RequestVerificationToken']) {
            console.log('[LOGIN] Session cookies found');
            localStorage.setItem('arsenal_session_cookies', JSON.stringify(cookies));
        }
        
        console.log('[LOGIN] No authentication tokens found');
        return null;
    }
    
    // Monitor for successful login and extract data
    function monitorLoginSuccess() {
        // Check if we're on a logged-in page
        if (window.location.href.includes('myaccount.arsenal.com') && 
            !window.location.href.includes('login')) {
            
            console.log('[LOGIN] Login success detected, extracting auth data...');
            extractAuthData();
            
            // Notify background script
            chrome.runtime.sendMessage({
                action: 'loginSuccess',
                url: window.location.href
            });
        }
    }
    
    // Set up monitoring for login success
    setInterval(monitorLoginSuccess, 2000);
    
    // Extract auth data on page load if already logged in
    if (window.location.href.includes('myaccount.arsenal.com') && 
        !window.location.href.includes('login')) {
        console.log('[LOGIN] Already on logged-in page, extracting auth data...');
        extractAuthData();
    }
    
    // Helper function to get stored auth token
    window.getArsenalAuthToken = function() {
        return localStorage.getItem('arsenal_auth_token');
    };
    
    // Helper function to get stored session cookies
    window.getArsenalSessionCookies = function() {
        const cookies = localStorage.getItem('arsenal_session_cookies');
        return cookies ? JSON.parse(cookies) : null;
    };
    

    
    console.log('[LOGIN] Arsenal login content script initialization complete');
})();
