// login_chelsea_content.js
console.log('[LOGIN] Chelsea login content script loaded on', location.href);

// Check if we're on the correct Chelsea login page
(function() {
    if (!window.location.href.startsWith('https://account.chelseafc.com/oauth2/authorize')) {
        console.warn('[LOGIN] Not on Chelsea login page, stopping script execution');
        return;
    }
    
    console.log('[LOGIN] Chelsea login page detected, starting login automation...');
    
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
    
    async function waitForElement(selector, timeout = 10000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            const element = document.querySelector(selector);
            if (element) {
                return element;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`Element not found: ${selector}`);
    }
    
    async function performLogin() {
        try {
            console.log('[LOGIN] ========== Starting login process ==========');
            console.log('[LOGIN] Current URL:', window.location.href);
            console.log('[LOGIN] Page title:', document.title);
            console.log('[LOGIN] Timestamp:', new Date().toISOString());
        
        // Wait for page to be fully loaded and form elements to be available
        console.log('[LOGIN] Waiting for email input field to appear...');
        await waitForElement('input[name="loginId"], input[data-testid="mdc-text-field__input--loginId"]', 10000);
        console.log('[LOGIN] ✓ Email input field found');
        
        // Find login form elements - Chelsea FC specific selectors
        console.log('[LOGIN] Searching for form elements...');
        const emailInput = document.querySelector('input[name="loginId"]') || 
                          document.querySelector('input[data-testid="mdc-text-field__input--loginId"]') ||
                          document.querySelector('input[type="email"]');
        
        const passwordInput = document.querySelector('input[name="password"]') || 
                             document.querySelector('input[data-testid="mdc-text-field__input--password"]') ||
                             document.querySelector('input[type="password"]');
        
        const submitButton = document.querySelector('button.button--primary') ||
                            document.querySelector('button[type="type"]') ||
                            document.querySelector('button.button');
        
        // Log element detection results
        console.log('[LOGIN] Element detection results:');
        console.log('[LOGIN]   - Email input:', emailInput ? `Found (${emailInput.tagName}, name="${emailInput.name}", type="${emailInput.type}")` : 'NOT FOUND');
        console.log('[LOGIN]   - Password input:', passwordInput ? `Found (${passwordInput.tagName}, name="${passwordInput.name}", type="${passwordInput.type}")` : 'NOT FOUND');
        console.log('[LOGIN]   - Submit button:', submitButton ? `Found (${submitButton.tagName}, type="${submitButton.type}", class="${submitButton.className}")` : 'NOT FOUND');
        
        if (!emailInput) {
            console.error('[LOGIN] ❌ Email input field not found');
            throw new Error('Email input field not found');
        }
        
        if (!passwordInput) {
            console.error('[LOGIN] ❌ Password input field not found');
            throw new Error('Password input field not found');
        }
        
        // Check if submit button exists, but we'll use Enter key as primary method
        if (!submitButton) {
            console.warn('[LOGIN] ⚠️ Submit button not found, will use Enter key method only');
        } else {
            console.log('[LOGIN] ✓ Submit button found as backup method');
        }
        
        console.log('[LOGIN] ✓ All required form elements found');
        console.log('[LOGIN] Checking for autofilled credentials...');
        
        // Wait a bit for autofill to complete
        console.log('[LOGIN] Waiting 1.5s for autofill to complete...');
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Log current field values before clearing
        console.log('[LOGIN] Current field values before clearing:');
        console.log('[LOGIN]   - Email field value:', emailInput.value ? `"${emailInput.value.substring(0, 5)}..."` : '(empty)');
        console.log('[LOGIN]   - Password field value:', passwordInput.value ? `"${'*'.repeat(passwordInput.value.length)}"` : '(empty)');
        
        // Get login credentials from local storage (from Google Sheets)
        console.log('[LOGIN] Retrieving credentials from Google Sheets...');
        const credentials = await getLoginCredentials();
        
        const currentEmail = credentials.email;
        const currentPassword = credentials.password;
        
        console.log('[LOGIN] ✓ Credentials retrieved:');
        console.log('[LOGIN]   - Email:', currentEmail ? `"${currentEmail.substring(0, 5)}..."` : '(empty)');
        console.log('[LOGIN]   - Password:', currentPassword ? `"${'*'.repeat(currentPassword.length)}"` : '(empty)');
        
        if (!currentEmail || !currentPassword) {
            console.error('[LOGIN] ❌ Credentials are incomplete');
            throw new Error('Email or password is missing from credentials');
        }
        
        console.log('[LOGIN] Clearing existing field values...');
        // Clear existing values first
        emailInput.value = '';
        passwordInput.value = '';
        
        // Wait a moment for fields to clear
        await new Promise(resolve => setTimeout(resolve, 500));
        console.log('[LOGIN] ✓ Fields cleared');
        
        // Fill in the specific credentials
        console.log('[LOGIN] Filling in credentials...');
        emailInput.value = currentEmail;
        passwordInput.value = currentPassword;
        console.log('[LOGIN] ✓ Credentials filled into form fields');
        
        // Comprehensive simulation of user interaction with email field
        console.log('[LOGIN] Simulating user interaction with email field...');
        emailInput.focus();
        console.log('[LOGIN]   - Email field focused');
        await new Promise(resolve => setTimeout(resolve, 200));
        emailInput.click();
        console.log('[LOGIN]   - Email field clicked');
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Trigger all possible events for email field
        console.log('[LOGIN]   - Dispatching events for email field...');
        emailInput.dispatchEvent(new Event('focus', { bubbles: true, cancelable: true }));
        emailInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        emailInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        emailInput.dispatchEvent(new Event('keydown', { bubbles: true, cancelable: true }));
        emailInput.dispatchEvent(new Event('keyup', { bubbles: true, cancelable: true }));
        emailInput.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
        console.log('[LOGIN]   - ✓ Email field events dispatched');
        
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Comprehensive simulation of user interaction with password field
        console.log('[LOGIN] Simulating user interaction with password field...');
        passwordInput.focus();
        console.log('[LOGIN]   - Password field focused');
        await new Promise(resolve => setTimeout(resolve, 200));
        passwordInput.click();
        console.log('[LOGIN]   - Password field clicked');
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Trigger all possible events for password field
        console.log('[LOGIN]   - Dispatching events for password field...');
        passwordInput.dispatchEvent(new Event('focus', { bubbles: true, cancelable: true }));
        passwordInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        passwordInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        passwordInput.dispatchEvent(new Event('keydown', { bubbles: true, cancelable: true }));
        passwordInput.dispatchEvent(new Event('keyup', { bubbles: true, cancelable: true }));
        passwordInput.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
        console.log('[LOGIN]   - ✓ Password field events dispatched');
        
        // Additional: Try to trigger form validation events
        console.log('[LOGIN] Triggering form validation events...');
        const form = emailInput.closest('form') || passwordInput.closest('form');
        if (form) {
            console.log('[LOGIN]   - Form element found, dispatching form events...');
            form.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            form.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        } else {
            console.log('[LOGIN]   - No form element found');
        }
        
        // Simulate clicking on the document/window to trigger global validation
        console.log('[LOGIN] Simulating document click for validation...');
        document.body.click();
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Try alternative method: simulate typing in the fields (with error handling)
        console.log('[LOGIN] Simulating keyboard selection in fields...');
        try {
            emailInput.focus();
            emailInput.select();
            // Only use setSelectionRange if the field supports it
            if (emailInput.setSelectionRange && typeof emailInput.setSelectionRange === 'function') {
                try {
                    emailInput.setSelectionRange(0, currentEmail.length);
                } catch (e) {
                    console.log('[LOGIN]   - setSelectionRange not supported on email field, skipping');
                }
            }
            emailInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
            emailInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
        } catch (e) {
            console.warn('[LOGIN]   - Error simulating keyboard selection on email field:', e.message);
        }
        
        await new Promise(resolve => setTimeout(resolve, 200));
        
        try {
            passwordInput.focus();
            passwordInput.select();
            // Password fields often don't support setSelectionRange, so wrap in try-catch
            if (passwordInput.setSelectionRange && typeof passwordInput.setSelectionRange === 'function') {
                try {
                    passwordInput.setSelectionRange(0, currentPassword.length);
                } catch (e) {
                    console.log('[LOGIN]   - setSelectionRange not supported on password field (normal), skipping');
                }
            }
            passwordInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
            passwordInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
        } catch (e) {
            console.warn('[LOGIN]   - Error simulating keyboard selection on password field:', e.message);
        }
        
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Try clicking on the form itself
        if (form) {
            console.log('[LOGIN] Clicking form element...');
            form.click();
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        // Final check: try to trigger validation by dispatching a custom event
        console.log('[LOGIN] Dispatching custom validation events...');
        const validationEvent = new CustomEvent('validation', { bubbles: true, cancelable: true });
        emailInput.dispatchEvent(validationEvent);
        passwordInput.dispatchEvent(validationEvent);
        if (form) form.dispatchEvent(validationEvent);
        
        // Wait for form validation to update
        console.log('[LOGIN] Waiting 1s for form validation to update...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Check field states before submission
        console.log('[LOGIN] Field states before submission:');
        console.log('[LOGIN]   - Email field value:', emailInput.value ? `"${emailInput.value.substring(0, 10)}..."` : '(empty)');
        console.log('[LOGIN]   - Password field value:', passwordInput.value ? `"${'*'.repeat(passwordInput.value.length)}"` : '(empty)');
        console.log('[LOGIN]   - Email field disabled:', emailInput.disabled);
        console.log('[LOGIN]   - Password field disabled:', passwordInput.disabled);
        console.log('[LOGIN]   - Email field readonly:', emailInput.readOnly);
        console.log('[LOGIN]   - Password field readonly:', passwordInput.readOnly);
        
        // Store original URL before submission for monitoring
        const originalUrl = window.location.href;
        console.log('[LOGIN] Stored original URL for monitoring:', originalUrl);
        
        // Scroll to submit button first to ensure it's visible and form is ready
        console.log('[LOGIN] ========== Scrolling to submit button ==========');
        if (submitButton) {
            console.log('[LOGIN] Scrolling submit button into view...');
            try {
                submitButton.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
                console.log('[LOGIN] ✓ Scrolled to submit button');
                // Wait for scroll to complete
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Check if button is visible
                const rect = submitButton.getBoundingClientRect();
                const isVisible = rect.top >= 0 && rect.left >= 0 && 
                                 rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && 
                                 rect.right <= (window.innerWidth || document.documentElement.clientWidth);
                console.log('[LOGIN] Submit button visibility check:');
                console.log('[LOGIN]   - Button position:', { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right });
                console.log('[LOGIN]   - Viewport size:', { width: window.innerWidth, height: window.innerHeight });
                console.log('[LOGIN]   - Is visible:', isVisible);
                
                if (!isVisible) {
                    console.log('[LOGIN] ⚠️ Button not fully visible, scrolling again...');
                    submitButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            } catch (e) {
                console.warn('[LOGIN] Error scrolling to button:', e.message);
            }
        } else {
            console.log('[LOGIN] ⚠️ No submit button found, will use Enter key only');
        }
        
        // Wait a bit more for any animations or form validation
        console.log('[LOGIN] Waiting 500ms for form to stabilize after scroll...');
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // PRIMARY METHOD: Press Enter key on password field
        console.log('[LOGIN] ========== Submitting form using Enter key ==========');
        console.log('[LOGIN] Focusing password field for Enter key submission...');
        passwordInput.focus();
        await new Promise(resolve => setTimeout(resolve, 300));
        
        console.log('[LOGIN] Pressing Enter key on password field...');
        // Create and dispatch Enter key event
        const enterKeyEvent = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
        });
        
        passwordInput.dispatchEvent(enterKeyEvent);
        console.log('[LOGIN] ✓ Enter key event dispatched');
        
        // Also try keypress and keyup for Enter
        passwordInput.dispatchEvent(new KeyboardEvent('keypress', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
        }));
        
        passwordInput.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
        }));
        
        console.log('[LOGIN] ✓ All Enter key events dispatched');
        
        // FALLBACK METHOD: Click submit button if Enter doesn't work
        if (submitButton) {
            console.log('[LOGIN] Waiting 1s, then checking if form was submitted...');
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Store URL before checking
            const urlBeforeButton = window.location.href;
            
            // Check if form was already submitted (URL changed) by comparing with original
            if (urlBeforeButton !== originalUrl) {
                console.log('[LOGIN] ✓ Form already submitted via Enter key, skipping button click');
                console.log('[LOGIN]   - Original URL:', originalUrl);
                console.log('[LOGIN]   - Current URL:', urlBeforeButton);
            } else {
                console.log('[LOGIN] Form not submitted yet, clicking submit button as backup...');
                console.log('[LOGIN]   - URL unchanged:', urlBeforeButton);
                
                // Ensure button is still visible
                try {
                    submitButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await new Promise(resolve => setTimeout(resolve, 300));
                    
                    // Check button state
                    console.log('[LOGIN] Submit button state before click:');
                    console.log('[LOGIN]   - Disabled:', submitButton.disabled);
                    console.log('[LOGIN]   - Type:', submitButton.type);
                    console.log('[LOGIN]   - Visible:', submitButton.offsetParent !== null);
                    
                    if (submitButton.disabled) {
                        console.warn('[LOGIN] ⚠️ Submit button is disabled, may need form validation');
                    }
                    
                    // Try clicking the button
                    submitButton.click();
                    console.log('[LOGIN] ✓ Submit button clicked');
                    
                    // Also try dispatching click event directly
                    submitButton.dispatchEvent(new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                        view: window
                    }));
                    console.log('[LOGIN] ✓ Mouse click event dispatched on button');
                } catch (e) {
                    console.error('[LOGIN] ❌ Error clicking submit button:', e.message);
                }
            }
        }
        
        // Wait for navigation or error
        console.log('[LOGIN] Waiting 2s for form submission response...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        console.log('[LOGIN] ========== Form submission completed ==========');
        console.log('[LOGIN] Current URL after submission:', window.location.href);
        console.log('[LOGIN] Page title after submission:', document.title);
        
        // Check if login was successful by monitoring URL change
        console.log('[LOGIN] ========== Monitoring login result ==========');
        console.log('[LOGIN] Original URL:', originalUrl);
        let urlChanged = false;
        let checkCount = 0;
        const maxChecks = 20; // 20 checks * 500ms = 10 seconds
        
        // Monitor for URL change (successful login)
        const checkInterval = setInterval(() => {
            checkCount++;
            const currentUrl = window.location.href;
            const currentTitle = document.title;
            
            if (currentUrl !== originalUrl) {
                urlChanged = true;
                clearInterval(checkInterval);
                console.log('[LOGIN] ✓ URL changed detected!');
                console.log('[LOGIN]   - Original URL:', originalUrl);
                console.log('[LOGIN]   - New URL:', currentUrl);
                console.log('[LOGIN]   - Page title:', currentTitle);
                console.log('[LOGIN]   - Checks performed:', checkCount);
                console.log('[LOGIN] ✅ Login may have been successful!');
            } else {
                // Log progress every 5 checks
                if (checkCount % 5 === 0) {
                    console.log(`[LOGIN] Still monitoring... (check ${checkCount}/${maxChecks}, URL unchanged)`);
                }
            }
        }, 500);
        
        // Stop monitoring after 10 seconds
        setTimeout(() => {
            clearInterval(checkInterval);
            if (!urlChanged) {
                console.log('[LOGIN] ⚠️ No URL change detected after 10 seconds');
                console.log('[LOGIN]   - Final URL:', window.location.href);
                console.log('[LOGIN]   - Final title:', document.title);
                console.log('[LOGIN]   - Total checks:', checkCount);
                console.log('[LOGIN] Login may still be processing or may have failed');
            }
            console.log('[LOGIN] ========== Login monitoring completed ==========');
        }, 10000);
        
        loginConfig.running = false;
        console.log('[LOGIN] Login process marked as complete');
        } catch (error) {
            console.error('[LOGIN] ❌ Error in performLogin:', error);
            console.error('[LOGIN] Error name:', error.name);
            console.error('[LOGIN] Error message:', error.message);
            console.error('[LOGIN] Error stack:', error.stack);
            loginConfig.running = false;
            throw error; // Re-throw to be caught by startLoginProcess
        }
    }
})();

