// login_nottingham_forest_content.js
console.log('[LOGIN] Nottingham Forest login content script loaded on', location.href);

// Check if we're on the correct Nottingham Forest login page
(function() {
    if (!window.location.href.includes('login.nottinghamforest.co.uk')) {
        console.warn('[LOGIN] Not on Nottingham Forest login page, stopping script execution');
        return;
    }
    
    console.log('[LOGIN] Nottingham Forest login page detected, starting login automation...');
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
            // Retry after a delay if the form wasn't found
            if (e.message.includes('form elements not found')) {
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
        
        // Wait for page to be fully loaded - increase timeout and try multiple selectors
        console.log('[LOGIN] Waiting for login form to load...');
        await waitForLoginForm();
        
        // Find login form elements - Nottingham Forest specific selectors
        const emailInput = document.querySelector('#Email, input[name="Email"], input[type="email"], input[name="email"], input[name="username"]');
        const passwordInput = document.querySelector('#Password, input[name="Password"], input[type="password"], input[name="password"]');
        
        // Try to find the specific Nottingham Forest submit button first, then fallback to generic selectors
        let submitButton = document.querySelector('#submitForm, input[type="submit"][value="Log in"], button[type="submit"], input[type="submit"]');
        
        if (!emailInput || !passwordInput || !submitButton) {
            console.error('[LOGIN] Login form elements not found after waiting');
            console.log('[LOGIN] Email input found:', !!emailInput);
            console.log('[LOGIN] Password input found:', !!passwordInput);
            console.log('[LOGIN] Submit button found:', !!submitButton);
            console.log('[LOGIN] Available inputs on page:', document.querySelectorAll('input'));
            console.log('[LOGIN] Available buttons on page:', document.querySelectorAll('button'));
            throw new Error('Login form elements not found after waiting for form to load');
        }
        
        console.log('[LOGIN] Login form elements found, checking for autofilled credentials...');
        console.log('[LOGIN] Email input element:', emailInput);
        console.log('[LOGIN] Password input element:', passwordInput);
        console.log('[LOGIN] Submit button element:', submitButton);
        console.log('[LOGIN] Submit button classes:', submitButton.className);
        console.log('[LOGIN] Submit button text:', submitButton.value || submitButton.textContent);
        console.log('[LOGIN] Submit button type:', submitButton.type);
        console.log('[LOGIN] Email input type:', emailInput.type);
        console.log('[LOGIN] Password input type:', passwordInput.type);
        
        // Wait a bit for autofill to complete
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Get login credentials from local storage (from Google Sheets)
        const credentials = await getLoginCredentials();
        
        console.log('[LOGIN] Using credentials from Google Sheets, filling form fields...');
        const currentEmail = credentials.email;
        const currentPassword = credentials.password;
        
        // Clear existing values first
        try {
            emailInput.value = '';
            passwordInput.value = '';
            console.log('[LOGIN] Cleared existing form values');
        } catch (e) {
            console.warn('[LOGIN] Error clearing form values:', e);
        }
        
        // Wait a moment for fields to clear
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Fill in the specific credentials
        try {
            emailInput.value = currentEmail;
            passwordInput.value = currentPassword;
            console.log('[LOGIN] Filled form with credentials - Email:', currentEmail, 'Password length:', currentPassword.length);
        } catch (e) {
            console.error('[LOGIN] Error filling form values:', e);
            throw e;
        }
        
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
        
        // Try alternative method: simulate typing in the fields (without selection for email inputs)
        emailInput.focus();
        // Don't use select() or setSelectionRange() on email inputs as they don't support it
        emailInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        emailInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
        
        await new Promise(resolve => setTimeout(resolve, 200));
        
        passwordInput.focus();
        // Only use select() and setSelectionRange() for password fields
        try {
            passwordInput.select();
            passwordInput.setSelectionRange(0, currentPassword.length);
        } catch (e) {
            console.log('[LOGIN] Password field selection not supported, continuing...');
        }
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
        try {
            console.log('[LOGIN] Clicking submit button...');
            submitButton.click();
            console.log('[LOGIN] Submit button clicked successfully');
        } catch (e) {
            console.error('[LOGIN] Error clicking submit button:', e);
            throw e;
        }

        // Wait for navigation or error
        await waitForLoginResult();
    }
    
    async function waitForLoginResult() {
        console.log('[LOGIN] Waiting for login result...');
        
        const maxWaitTime = 90000; // 90 seconds (triple the previous 30 seconds)
        const checkInterval = 2000; // Check every 2 seconds (less frequent checking)
        let elapsed = 0;
        
        return new Promise((resolve, reject) => {
            const checkTimer = setInterval(() => {
                elapsed += checkInterval;
                
                // Check if we've been redirected to a success page (Nottingham Forest specific)
                if (window.location.href.includes('nottinghamforest.co.uk') && 
                    !window.location.href.includes('login.nottinghamforest.co.uk')) {
                    clearInterval(checkTimer);
                    console.log('[LOGIN] Login successful, redirected to:', window.location.href);
                    loginConfig.running = false;
                    resolve();
                    return;
                }
                
                // Check for error messages
                const errorElements = document.querySelectorAll('.error, .alert-error, .login-error, [class*="error"], .alert-danger, .text-danger, .field-validation-error');
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
                
                // Check for CAPTCHA or verification challenges (ALTCHA widget)
                if (document.querySelector('[class*="captcha"], [class*="recaptcha"], [class*="verification"], [class*="hcaptcha"], altcha-widget, [class*="altcha"]')) {
                    console.log('[LOGIN] CAPTCHA or verification challenge detected (ALTCHA widget)');
                    clearInterval(checkTimer);
                    loginConfig.running = false;
                    resolve(); // Don't fail, just stop and let user handle manually
                    return;
                }
                
                // Log progress every 10 seconds
                if (elapsed % 10000 === 0 && elapsed > 0) {
                    console.log('[LOGIN] Still waiting for login result...', elapsed / 1000, 'seconds elapsed');
                }
                
                // Timeout
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
        
        const maxWaitTime = 30000; // 30 seconds
        const checkInterval = 1000; // Check every second
        let elapsed = 0;
        
        return new Promise((resolve, reject) => {
            const checkForForm = () => {
                elapsed += checkInterval;
                
                // Check for form elements with multiple selectors
                const emailInput = document.querySelector('#Email, input[name="Email"], input[type="email"], input[name="email"], input[name="username"]');
                const passwordInput = document.querySelector('#Password, input[name="Password"], input[type="password"], input[name="password"]');
                
                // Try to find the specific Nottingham Forest submit button first, then fallback to generic selectors
                let submitButton = document.querySelector('#submitForm, input[type="submit"][value="Log in"], button[type="submit"], input[type="submit"]');
                
                if (emailInput && passwordInput && submitButton) {
                    console.log('[LOGIN] All login form elements found after', elapsed / 1000, 'seconds');
                    console.log('[LOGIN] Email input:', emailInput);
                    console.log('[LOGIN] Password input:', passwordInput);
                    console.log('[LOGIN] Submit button:', submitButton);
                    resolve();
                    return;
                }
                
                // Log progress every 5 seconds
                if (elapsed % 5000 === 0) {
                    console.log('[LOGIN] Still waiting for login form...', elapsed / 1000, 'seconds elapsed');
                    console.log('[LOGIN] Found elements - Email:', !!emailInput, 'Password:', !!passwordInput, 'Submit:', !!submitButton);
                }
                
                // Timeout
                if (elapsed >= maxWaitTime) {
                    console.error('[LOGIN] Login form timeout after', maxWaitTime / 1000, 'seconds');
                    console.log('[LOGIN] Available form elements on page:');
                    console.log('[LOGIN] All inputs:', document.querySelectorAll('input'));
                    console.log('[LOGIN] All buttons:', document.querySelectorAll('button'));
                    console.log('[LOGIN] All forms:', document.querySelectorAll('form'));
                    reject(new Error(`Login form elements not found within ${maxWaitTime}ms`));
                    return;
                }
                
                // Continue checking
                setTimeout(checkForForm, checkInterval);
            };
            
            // Start checking
            checkForForm();
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
            /csrf["\s]*[:=]["']([^"']+)["']/,
            /access_token["\s]*[:=]["']([^"']+)["']/,
            /bearer["\s]*[:=]["']([^"']+)["']/
        ];
        
        const html = document.documentElement.innerHTML;
        
        for (const pattern of tokenPatterns) {
            const match = html.match(pattern);
            if (match) {
                const token = match[1];
                localStorage.setItem('nottingham_forest_auth_token', token);
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
        
        if (cookies['ASP.NET_SessionId'] || cookies['__RequestVerificationToken'] || cookies['sessionid']) {
            console.log('[LOGIN] Session cookies found');
            localStorage.setItem('nottingham_forest_session_cookies', JSON.stringify(cookies));
        }
        
        console.log('[LOGIN] No authentication tokens found');
        return null;
    }
    
    // Monitor for successful login and extract data
    function monitorLoginSuccess() {
        // Check if we're on a logged-in page (Nottingham Forest specific)
        if (window.location.href.includes('nottinghamforest.co.uk') && 
            !window.location.href.includes('login.nottinghamforest.co.uk')) {
            
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
    if (window.location.href.includes('nottinghamforest.co.uk') && 
        !window.location.href.includes('login.nottinghamforest.co.uk')) {
        console.log('[LOGIN] Already on logged-in page, extracting auth data...');
        extractAuthData();
    }
    
    // Helper function to get stored auth token
    window.getNottinghamForestAuthToken = function() {
        return localStorage.getItem('nottingham_forest_auth_token');
    };
    
    // Helper function to get stored session cookies
    window.getNottinghamForestSessionCookies = function() {
        const cookies = localStorage.getItem('nottingham_forest_session_cookies');
        return cookies ? JSON.parse(cookies) : null;
    };
    
    console.log('[LOGIN] Nottingham Forest login content script initialization complete');
})();
