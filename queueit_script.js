// queueit_script.js

if (window.location.href.startsWith("https://ticketmastersportuk.queue-it.net/softblock/?c=ticketmastersportuk")) {
    console.log("[QueueIt Script] Running on the correct page.");

    const checkElements = setInterval(() => {
        const captchaInput = document.querySelector('input#solution');
        const robotButton = document.querySelector('button.botdetect-button');
        const confirmRedirectButton = document.querySelector('button#buttonConfirmRedirect');

        // Check for the confirm redirect button first
        if (confirmRedirectButton) {
            console.log("[QueueIt Script] Confirm redirect button found. Clicking immediately...");
            clearInterval(checkElements);
            confirmRedirectButton.click();
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
