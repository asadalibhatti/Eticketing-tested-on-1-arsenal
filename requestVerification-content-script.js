// content-script.js
console.log("requestVerification script loaded, on", location.href);
if (window.location.pathname.includes("/EDP/Event/Index/")) {

    console.log("[CS] Reloading page after 120 minutes interval.");
    // Reload the page every 120 minutes
    setInterval(() => {
        console.log("[CS] Reloading page after 120 minutes interval.");
        window.location.reload();
    }, 120 * 60 * 1000); // 120 minutes in milliseconds



    //wait for 5 seconds
    console.log("[CS] Event page detected. Waiting for 5 seconds before proceeding...");
    // setTimeout(() => {
    //     console.log("[CS] 5 seconds passed. Proceeding with verification token extraction.");
    //
    // } , 5000);

    //it current tab title is "Your Browsing Activity has" than wait for 10 seconds and keep checking
    // if title changes else reload it after 10 seconds
    if (document.title.includes("Your Browsing Activity Has")) {
        console.log("[CS] Waiting for tab title to change...");
        let checkTitleInterval = setInterval(() => {
            if (!document.title.includes("Your Browsing Activity has")) {
                clearInterval(checkTitleInterval);
                console.log("[CS] Tab title changed. Proceeding with verification token extraction.");
            } else {
                console.log("[CS] Still waiting for tab title to change...");
            }
        }, 1000);

        setTimeout(() => {
            if (document.title.includes("Your Browsing Activity has")) {
                console.warn("[CS] Tab title did not change within 10 seconds. Reloading the page...");
                window.location.reload();
            }
        }, 10000);
    }
    (function () {
        const TOKEN_KEY = "verification_token";
        const EMAIL_KEY = "user_email";


        console.log("[CS] Event page detected. Will extract token and email in 30 seconds...");

        setTimeout(() => {
            let token = null;
            let email = null;

            // ----------------------
            // Extract verification token
            // ----------------------
            let hiddenInput = document.querySelector('input[name="__RequestVerificationToken"]');
            if (hiddenInput) {
                token = hiddenInput.value;
                console.log("[CS] Token found via hidden input:", token);
            }

            if (!token) {
                let metaToken = document.querySelector('meta[name="__RequestVerificationToken"]');
                if (metaToken) {
                    token = metaToken.getAttribute("content");
                    console.log("[CS] Token found via meta tag:", token);
                }
            }

            if (!token) {
                let html = document.documentElement.innerHTML;
                let match = html.match(/__RequestVerificationToken"\s*value="([^"]+)"/);
                if (match) {
                    token = match[1];
                    console.log("[CS] Token found via HTML regex:", token);
                }
            }

            if (token) {
                localStorage.setItem(TOKEN_KEY, token);
                console.log("[CS] Token saved to localStorage");
            } else {
                console.warn("[CS] No verification token found.");
            }

            // ----------------------
            // Extract email
            // ----------------------
            let emailInput = document.querySelector('#NewClientEmail');
            if (emailInput) {
                // Try reading from data attribute first
                email = emailInput.getAttribute('data-my-email')
                    || emailInput.value
                    || emailInput.placeholder;

                if (email && email.includes('@')) {
                    localStorage.setItem(EMAIL_KEY, email);
                    console.log("[CS] Email found and saved to localStorage:", email);
                } else {
                    console.warn("[CS] No valid email found in input.");
                }
            } else {
                console.warn("[CS] No email input element found.");
            }

        }, 5000); // wait 15 seconds


        // Helpers
        window.getVerificationToken = function () {
            return localStorage.getItem(TOKEN_KEY);
        };

        window.getUserEmail = function () {
            return localStorage.getItem(EMAIL_KEY);
        };
    })();

} else {
    // Stop script execution
    console.warn("[CS] Not an event page. requestVerfication script will not run.");
}
