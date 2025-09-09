// queueit_script.js

console.log("[QueueIt Script] Script loaded on:", window.location.href);

if (window.location.href.startsWith("https://ticketmastersportuk.queue-it.net")) {
    console.log("[QueueIt Script] Running on the correct page.");

    // Wait for page to be fully loaded before starting
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startQueueItScript);
    } else {
        startQueueItScript();
    }

    function startQueueItScript() {
        console.log("[QueueIt Script] Starting queue-it script...");
        
        let checkCount = 0;
        const maxChecks = 150; // Stop after 30 seconds (150 * 200ms)
        
        const checkElements = setInterval(async () => {
            checkCount++;
            
            // Stop checking after max attempts to prevent infinite loops
            if (checkCount > maxChecks) {
                console.log("[QueueIt Script] Stopping checks after max attempts");
                clearInterval(checkElements);
                return;
            }

            const captchaInput = document.querySelector('input#solution');
            const robotButton = document.querySelector('button.botdetect-button');
            const confirmRedirectButton = document.querySelector('button#buttonConfirmRedirect');

            // Check for the confirm redirect button first
            if (confirmRedirectButton) {
                console.log("[QueueIt Script] Confirm redirect button found. Clicking immediately...");
                clearInterval(checkElements);
                //wait for 5 seconds
                await new Promise(resolve => setTimeout(resolve, 120000));
                //click the confirm redirect button
                confirmRedirectButton.click();
                //wait for 60 seconds
                // await new Promise(resolve => setTimeout(resolve, 60000));

                return;
            }

            // Original captcha handling
            if (captchaInput && robotButton) {
                console.log("[QueueIt Script] Captcha input and button found.");
                clearInterval(checkElements);

                captchaInput.addEventListener('input', () => {
                    if (captchaInput.value.trim() !== "") {
                        console.log("[QueueIt Script] Captcha input filled. Clicking the button...");
                        robotButton.click();
                    }
                });
            }
        }, 200); // check every 200ms for faster response
    }
} else {
    console.log("[QueueIt Script] Not running - URL doesn't match queue-it pattern");
}