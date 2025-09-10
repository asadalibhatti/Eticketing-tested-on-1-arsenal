// background.js
let EVENT_NOT_ALLOWED_URL; //= "https://www.eticketing.co.uk/arsenal/EDP/Validation/EventNotAllowed?eventId=4&reason=EventArchived";
let EVENT_URL = "";

let eventTabId = null;
let notAllowedTabId = null;

console.log('[BG] Background loaded');
let lastStatus = null;
let pollIntervalId = null;
let sheetUrl = "https://docs.google.com/spreadsheets/d/1uiHk8KEp-Yc5tj8l6RnY2dEGZwsG2aMPhqiO5IP5mq0/edit?usp=sharing";

// Start polling Google Sheet
function startPolling() {
    if (pollIntervalId) return; // already running
    console.log('[BG] Polling started');
    // pollIntervalId = setInterval(pollSheetAndControl, 10000);
    // pollSheetAndControl(); // run immediately
}

// Stop polling Google Sheet
function stopPolling() {
    if (pollIntervalId) {
        clearInterval(pollIntervalId);
        pollIntervalId = null;
        console.log('[BG] Polling stopped');
    }
}

tabsOpenRecheckCount = 0;

function getGvizUrl(sheetUrl) {
    try {
        // Extract the sheet ID (the long string between /d/ and /edit)
        const idMatch = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
        if (!idMatch) throw new Error("Invalid Google Sheet URL");

        const sheetId = idMatch[1];

        // Extract gid (defaults to 0 if not found)
        const gidMatch = sheetUrl.match(/gid=([0-9]+)/);
        const gid = gidMatch ? gidMatch[1] : "0";

        // Return GViz JSON endpoint
        return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&gid=${gid}`;
    } catch (err) {
        console.error("getGvizUrl error:", err.message);
        return null;
    }
}

async function pollSheetAndControl() {
    try {
        const data = await chrome.storage.local.get(['sheetUrl', 'startSecond']);
        if (!data.sheetUrl) return;

        const targetStartSecond = parseInt(data.startSecond ?? -2, 10);


        const gvizUrl = getGvizUrl(data.sheetUrl);
        if (!gvizUrl) return; // invalid URL, stop execution

        const allCfg = await fetchSheetConfigAll(gvizUrl);

        // Find rows that are ON and match startSecond
        const matchingRows = allCfg.filter(cfg =>
            ['on', 'start', 'true', '1'].includes((cfg.status || '').toString().trim().toLowerCase()) &&
            parseInt(cfg.startSecond, 10) === targetStartSecond
        );

        const anyMatch = matchingRows.length > 0;
        const currentStatus = anyMatch ? 'on' : 'off';

        if (currentStatus !== lastStatus) {
            console.log(`[BG] Status changed: ${lastStatus} -> ${currentStatus}`);
            lastStatus = currentStatus;

            if (anyMatch) {
                console.log('[BG] Auto-start triggered for matching rows');
                for (const row of matchingRows) {
                    console.log('[BG] Opening tabs for', row.eventUrl);
                    // {
                    //     "status": "on",
                    //     "discordWebhook": "https://discord.com/api/webhooks/1371776918407483403/i0PZw3JR5Ypuw1bmoYrPGrbf9US4eXD8S1W-FSEarQ0EvVWn2iX8VIXRyzgBcQ96S1br",
                    //     "telegramWebhook": "123456789:ABCDEFghijkLmnoPQrstUVwxYZ",
                    //     "telegramChatId": 987654321,
                    //     "eventUrl": "https://www.eticketing.co.uk/arsenal/EDP/Event/Index/3674",
                    //     "areSeatsTogether": "false",
                    //     "quantity": 1,
                    //     "startSecond": 2,
                    //     "eventId": 3674,
                    //     "maximumPrice": 10000000,
                    //     "minimumPrice": ""
                    // }


                    //save to local storage currentStatus
                    await chrome.storage.local.set({
                        currentStatus: currentStatus,
                        eventUrl: row.eventUrl,
                        startSecond: row.startSecond,
                        areSeatsTogether: row.areSeatsTogether === 'true', // convert to boolean
                        quantity: parseInt(row.quantity, 10) || 1,
                        discordWebhook: row.discordWebhook,
                        telegramWebhook: row.telegramWebhook,
                        telegramChatId: row.telegramChatId,
                        eventId: row.eventId,
                        maximumPrice: row.maximumPrice,
                        minimumPrice: row.minimumPrice


                    });
                    EVENT_URL = row.eventUrl;

                    function getClubName(url) {
                        const parts = url.split('/');
                        return parts[3]; // the club name is the 4th part in the URL array
                    }

                    const clubName = getClubName(row.eventUrl);
                    // "https://www.eticketing.co.uk/clubname/EDP/Validation/EventNotAllowed?eventId=4&reason=EventArchived";
                    EVENT_NOT_ALLOWED_URL = `https://www.eticketing.co.uk/${clubName}/EDP/Validation/EventNotAllowed?eventId=4&reason=EventArchived`;
                    await openOrFocusTabs(EVENT_URL, EVENT_NOT_ALLOWED_URL);
                }
            } else {
                console.log('[BG] Auto-stop triggered');


                notifyTabStop();
            }
        }
        // no need for below code as heart beat is already handling this
        // //else if current status is on, make sure the two tabs are open else re open them
        // else if (currentStatus === 'on') {
        //     if (tabsOpenRecheckCount >= 48) {// 48 * 5 seconds = 2 minutes
        //         tabsOpenRecheckCount = 0;
        //         console.log('[BG] on 4 minutes re check , Current status is ON, checking if tabs are open');
        //         //check if there are two tabs with EVENT_URL and EVENT_NOT_ALLOWED_URL

        //         //check if there are two tabs with EVENT_URL and EVENT_NOT_ALLOWED_URL
        //         const tabs = await chrome.tabs.query({url: '*://www.eticketing.co.uk/*'});
        //         const eventTabs = tabs.filter(t => t.url && t.url.startsWith(EVENT_URL));
        //         const notAllowedTabs = tabs.filter(t => t.url && t.url.startsWith(EVENT_NOT_ALLOWED_URL));
        //         if (eventTabs.length === 0) {
        //             console.log('[BG] No event tab found on 2 minutes recheck, opening new one');
        //             await openOrFocusTabs(EVENT_URL, undefined);
        //         } else {
        //             console.log('[BG] Event tab already open on 2 minutes recheck', eventTabs[0].id);
        //         }
        //         if (notAllowedTabs.length === 0) {
        //             console.log('[BG] No EventNotAllowed tab found on 2 minutes recheck, opening new one');
        //             await openOrFocusTabs(undefined, EVENT_NOT_ALLOWED_URL);
        //         } else {
        //             console.log('[BG] EventNotAllowed tab already open on 2 minutes recheck', notAllowedTabs[0].id);
        //         }
        //         // Close other eticketing tabs
        //         await closeOtherEticketingTabs();
        //         //wait for 5 seconds
        //         await new Promise(resolve => setTimeout(resolve, 60000));


        //     }
        //     tabsOpenRecheckCount++;
        // }
    } catch (e) {
        console.warn('[BG] pollSheetAndControl error:', e);
    }
}

// --- Auto Start Polling ---

function ensurePolling() {
    if (!pollIntervalId) {
        pollIntervalId = setInterval(pollSheetAndControl, 10000); // every 10s
        pollSheetAndControl(); // run immediately
        console.log('[BG] ensurePolling: Polling started');
    } else {
        console.log('[BG] ensurePolling: Polling already running');
    }
}

// Run immediately when background script loads
ensurePolling();

// Run when extension is installed or updated
chrome.runtime.onInstalled.addListener((details) => {
    console.log('[BG] onInstalled triggered:', details.reason);
    ensurePolling();
});

// Run when Chrome starts and extension wakes up
chrome.runtime.onStartup.addListener(() => {
    console.log('[BG] onStartup triggered');
    ensurePolling();
});

// Also re-start if extension is re-enabled after being disabled
chrome.management.onEnabled.addListener((ext) => {
    if (ext.id === chrome.runtime.id) {
        console.log('[BG] Extension re-enabled');
        ensurePolling();
    }
});

function notifyTabStop() {
    //set the currentStatus to 'off' in local storage
    console.log('[BG] notifyTabStop called, notifying tabs to stop monitoring');
    chrome.storage.local.set({currentStatus: 'off'});

    // Notify the EventNotAllowed tab to stop monitoring
    if (notAllowedTabId) {
        chrome.tabs.sendMessage(notAllowedTabId, {action: 'stopMonitoring'}, resp => {
            if (chrome.runtime.lastError) {
                console.warn('[BG] stopMonitoring sendMessage error (tab might not have content script yet):', chrome.runtime.lastError.message);
            } else {
                console.log('[BG] stop message sent to content script in tab', notAllowedTabId);
            }
        });
    }

}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "clearCookiesAndRefresh") {
        console.log('[BG] clearCookiesAndRefresh requested from popup', msg);
        chrome.cookies.getAll({}, function (cookies) {
            //clear all cookies
            cookies.forEach(cookie => {
                chrome.cookies.remove({
                    url: `https://${cookie.domain}${cookie.path}`,
                    name: cookie.name
                }, () => {
                    console.log(`[BG] Cookie cleared: ${cookie.name}`);
                });
            });
            // Send response after clearing cookies
            sendResponse({success: true, message: 'Cookies cleared successfully'});
        });

        // if (sender.tab?.id) {
        //     chrome.tabs.reload(sender.tab.id);
        // }
        return true; // keep channel open for async response
    }
    if (msg.action === 'manualStart') {
        console.log('[BG] manualStart requested from popup');
        startFlowFromStorage();
        startPolling(); // start auto-checking sheet
    }
    if (msg.action === 'manualStop') {
        console.log('[BG] manualStop requested from popup');
        notifyTabStop();
        stopPolling(); // stop checking sheet
    }
    if (msg.action === 'closeOtherTabsExcept') {
        console.log('[BG] closeOtherTabsExcept requested', msg);
        closeOtherEticketingTabs()
            .then(() => {
                console.log('[BG] closeOtherTabsExcept completed successfully');
                sendResponse({success: true, message: 'Other tabs closed successfully'});
            })
            .catch(err => {
                console.error('[BG] closeOtherTabsExcept error:', err);
                sendResponse({success: false, message: err?.message || 'Unknown error'});
            });
        return true; // keep channel open for async response
    }
    if (msg.action === 'refreshEventTab') {
        console.log('[BG] refreshEventTab requested', msg);
        Promise.resolve(refreshEventTab())
            .then(() => {
                console.log('[BG] Event tab refreshed successfully and response sent.');
                sendResponse({success: true, message: 'Event tab refreshed'});
            })
            .catch(err => {
                console.error('[BG] refreshEventTab error:', err);
                sendResponse({success: false, message: err?.message || 'Unknown error'});
            });
        return true; // keep channel open for async response
    }
    if (msg.action === 'notifyWebhooks') {
        console.log('[BG] notifyWebhooks requested', msg);
        console.log('[BG] Message length:', msg.message ? msg.message.length : 0);

        // Use promise chaining instead of await
        chrome.storage.local.get(['discordWebhook', 'telegramWebhook']).then(data => {
            const discordWebhook = data.discordWebhook || '';
            const telegramWebhook = data.telegramWebhook || '';
            const payload = msg.payload || {};
            const message = msg.message || 'Notification from Arsenal Tickets Extension';

            console.log('[BG] Webhook config:', { discordWebhook: !!discordWebhook, telegramWebhook: !!telegramWebhook });

            if (!discordWebhook && !telegramWebhook) {
                console.warn('[BG] No webhooks configured, skipping notification');
                return;
            }
            console.log('[BG] Sending webhooks...');
            sendWebhooks(discordWebhook, telegramWebhook, message, payload);
        }).catch(err => {
            console.error('[BG] Error reading webhooks config:', err);
        });
    }
    if (msg.action === 'notifyErrorWebhooks') {
        console.log('[BG] notifyErrorWebhooks requested', msg);

        // Hardcoded error webhook URL
        const errorDiscordWebhook = 'https://discordapp.com/api/webhooks/1139641609240182884/umQxYbgmj_WMAe33xIFLYtkMbJJrjSk-zbZJeC_sP4__eJlEJsnQ9JL4qj2cNuPFPLWz';
        const payload = msg.payload || {};
        const message = msg.message || 'Error notification from Arsenal Tickets Extension';

        console.log('[BG] Sending error notification to hardcoded webhook only');
        sendErrorWebhook(errorDiscordWebhook, message, payload);
    }
    if (msg.action === 'log') {
        console.log('[BG-LOG]', msg.message);
    }
    if (msg.action === 'openNewTab') {
        console.log('[BG] Opening new tab with URL:', msg.url);
        chrome.tabs.create({ url: msg.url })
            .then(() => {
                console.log('[BG] New tab opened successfully');
                sendResponse({success: true, message: 'New tab opened successfully'});
            })
            .catch(error => {
                console.error('[BG] Error opening new tab:', error);
                sendResponse({success: false, message: error?.message || 'Unknown error'});
            });
        return true; // keep channel open for async response
    }
    if (msg.type === "heartbeat" && sender.tab?.id) {
        heartbeatTracker[sender.tab.id] = Date.now();
        console.log(`[BG] Heartbeat received from tab ${sender.tab.id} at ${new Date().toLocaleTimeString()}`);
    }
    return true;
});


async function startFlowFromStorage() {
    const data = await chrome.storage.local.get(['sheetUrl', 'startSecond']);
    const sheetUrl = data.sheetUrl;
    const startSecond = data.startSecond ?? 2;

    if (!sheetUrl) {
        console.warn('[BG] startFlow: no sheetUrl in storage');
        return;
    }

    const allCfg = await fetchSheetConfigAll(sheetUrl).catch(e => {
        console.warn('[BG] fetch sheet failed', e);
        return [];
    });

    console.log('[BG] Checking all rows for startSecond match:', startSecond);

    for (const cfg of allCfg) {
        if (parseInt(cfg.startSecond, 10) === parseInt(startSecond, 10)) {
            console.log('[BG] Found matching row for startSecond:', startSecond, cfg);
            // {
            //     "status": "on",
            //     "discordWebhook": "https://discord.com/api/webhooks/1371776918407483403/i0PZw3JR5Ypuw1bmoYrPGrbf9US4eXD8S1W-FSEarQ0EvVWn2iX8VIXRyzgBcQ96S1br",
            //     "telegramWebhook": "123456789:ABCDEFghijkLmnoPQrstUVwxYZ",
            //     "telegramChatId": 987654321,
            //     "eventUrl": "https://www.eticketing.co.uk/arsenal/EDP/Event/Index/3674",
            //     "areSeatsTogether": "false",
            //     "quantity": 1,
            //     "startSecond": 2,
            //     "eventId": 3674,
            //     "maximumPrice": 10000000,
            //     "minimumPrice": ""
            //     }
            // Save to local storage
            await chrome.storage.local.set({
                sheetUrl: sheetUrl,
                startSecond: cfg.startSecond,
                currentStatus: 'on', // set currentStatus to 'on'
                eventUrl: cfg.eventUrl,
                areSeatsTogether: cfg.areSeatsTogether === 'true', // convert to boolean
                quantity: parseInt(cfg.quantity, 10) || 1,


            });

            await openOrFocusTabs(cfg.eventUrl, EVENT_NOT_ALLOWED_URL);
        }
    }
}

async function openOrFocusTabs(eventUrl = null, EVENT_NOT_ALLOWED_URL = null) {
    try {
        const tabs = await chrome.tabs.query({url: '*://www.eticketing.co.uk/*'});


        console.log("event url:", eventUrl);

        // Handle Event tab only if eventUrl is provided
        if (eventUrl) {
            const foundEventTab = tabs.find(t => t.url && t.url.startsWith(eventUrl));
            console.log("checking here")
            if (foundEventTab) {
                console.log('[BG] Found existing event tab, reloading', foundEventTab.id);
                eventTabId = foundEventTab.id;
                // Clear heartbeat tracking for this tab before reloading
                clearHeartbeatTracking(eventTabId);
                await chrome.tabs.reload(eventTabId);
                await chrome.tabs.update(eventTabId, {active: true});
            } else {
                const created = await chrome.tabs.create({url: eventUrl, active: false});
                await chrome.tabs.update(eventTabId, {active: true});
                console.log('[BG] Created event tab', created.id);
                eventTabId = created.id;
                // Clear any existing heartbeat tracking for new tab
                clearHeartbeatTracking(eventTabId);
            }
            // //wait for 50 seconds here
            await new Promise(resolve => setTimeout(resolve, 60000));

        }

        // Handle Not Allowed tab only if EVENT_NOT_ALLOWED_URL is provided
        if (EVENT_NOT_ALLOWED_URL) {
            const foundNotAllowed = tabs.find(t => t.url && t.url.startsWith(EVENT_NOT_ALLOWED_URL));
            console.log("in focus open tab, check if need to send start request to event_not_allowed tab ..", EVENT_NOT_ALLOWED_URL);
            if (foundNotAllowed) {
                console.log('[BG] Found existing validation tab, reloading', foundNotAllowed.id);
                notAllowedTabId = foundNotAllowed.id;
                // Clear heartbeat tracking for this tab before reloading
                clearHeartbeatTracking(notAllowedTabId);
                await chrome.tabs.reload(notAllowedTabId);
            } else {
                const created2 = await chrome.tabs.create({url: EVENT_NOT_ALLOWED_URL, active: false});
                console.log('[BG] Created validation tab', created2.id);
                notAllowedTabId = created2.id;
                // Clear any existing heartbeat tracking for new tab
                clearHeartbeatTracking(notAllowedTabId);
            }
        }


        // Wait for 40 seconds
        await new Promise(resolve => setTimeout(resolve, 10000));

        // check if any tab with starting url: http://ticketmastersportuk.queue-it.net/ or https://web-identity than wait for 10 seconds
        async function checkTabsAndWait() {
            const tabs = await chrome.tabs.query({});
            const matchTab = tabs.find(tab =>
                //                  https://ticketmastersportuk.queue-it.net/
                tab.url.startsWith("https://ticketmastersportuk.queue-it.net/") ||
                tab.url.startsWith("https://web-identity") || tab.url.startsWith("http://ticketmastersportuk.queue-it.net/")
            );

            if (matchTab) {
                console.log("[BG] Matching tab found:", matchTab.url);
                console.log("[BG] Waiting 80 seconds...");

                // Wait using a Promise
                await new Promise(resolve => setTimeout(resolve, 120000));

                console.log("[BG] 120 seconds passed, you can do something here.");
                // Example: reload the tab
                // await chrome.tabs.reload(matchTab.id);
            } else {
                console.log("[BG] No matching tab found for queue or web identity related, ignoring");
            }
        }

        // check if queue or web identity tabs still there
        await checkTabsAndWait();
         // Close other eticketing tabs
        await closeOtherEticketingTabs(); 


        // Recheck to ensure tabs are still valid
        console.log("Recheck to ensure tabs are still valid and not redirected ")
        const tabs2 = await chrome.tabs.query({url: '*://www.eticketing.co.uk/*'});

        if (eventUrl) {
            const stillEvent = tabs2.some(t => t.url && t.url.startsWith(eventUrl));
            if (!stillEvent) {
                console.log('[BG] Event tab closed, reopening...');
                const created = await chrome.tabs.create({url: eventUrl, active: false});
                eventTabId = created.id;
                // Clear any existing heartbeat tracking for new tab
                clearHeartbeatTracking(eventTabId);
            }
            //wait for 5 seconds here
            await new Promise(resolve => setTimeout(resolve, 60000));
        }

        if (EVENT_NOT_ALLOWED_URL) {
            const stillNotAllowed = tabs2.some(t => t.url && t.url.startsWith(EVENT_NOT_ALLOWED_URL));
            if (!stillNotAllowed) {
                console.log('[BG] Validation tab closed, reopening...');
                const created2 = await chrome.tabs.create({url: EVENT_NOT_ALLOWED_URL, active: false});
                notAllowedTabId = created2.id;
                // Clear any existing heartbeat tracking for new tab
                clearHeartbeatTracking(notAllowedTabId);
            
                //wait for 5 seconds
                await new Promise(resolve => setTimeout(resolve, 60000));
            }

            // Send message to Not Allowed tab
            // if (notAllowedTabId) {
            //     await waitForTabLoad(notAllowedTabId, 30000);
            //     const storage = await chrome.storage.local.get(['sheetUrl', 'startSecond', 'areSeatsTogether', 'quantity']);
            //     const cfgMsg = {
            //         action: 'startMonitoring',
            //         sheetUrl: storage.sheetUrl,
            //         startSecond: storage.startSecond,
            //         eventUrl: eventUrl,
            //         areSeatsTogether: storage.areSeatsTogether,
            //     };
            //
            //     chrome.tabs.sendMessage(notAllowedTabId, cfgMsg, resp => {
            //         // if (chrome.runtime.lastError) {
            //         //     console.warn('[BG] sendMessage error:', chrome.runtime.lastError.message);
            //         // } else {
            //         //     console.log('[BG] Start message sent to content script in tab', notAllowedTabId);
            //         // }
            //     });
            //
            //     await chrome.tabs.update(notAllowedTabId, {active: true});
            // }
        }

       

        //if there are more than 1 event tab close other event tabs only keep one tab open
        const eventTabs = tabs2.filter(t => t.url && t.url.startsWith(eventUrl));
        if (eventTabs.length > 1) {
            console.log('[BG] More than 1 event tab found, closing other event tabs');
            for (const t of eventTabs) {
                if (t.id !== eventTabId) {
                    await chrome.tabs.remove(t.id);
                }
            }
        }
        //if there are more than 1 not allowed tab close other not allowed tabs only keep one tab open
        const notAllowedTabs = tabs2.filter(t => t.url && t.url.startsWith(EVENT_NOT_ALLOWED_URL));
        if (notAllowedTabs.length > 1) {
            console.log('[BG] More than 1 not allowed tab found, closing other not allowed tabs');
            for (const t of notAllowedTabs) {
                if (t.id !== notAllowedTabId) {
                    await chrome.tabs.remove(t.id);
                }
            }
        }

        console.log('[BG] openOrFocusTabs completed');

    } catch (e) {
        console.error('[BG] openOrFocusTabs error', e);
    }
}

function waitForTabLoad(tabId, timeout = 15000) {
    return new Promise(resolve => {
        let settled = false;

        function check(info) {
            if (info.tabId === tabId && info.status === 'complete') {
                if (!settled) {
                    settled = true;
                    chrome.tabs.onUpdated.removeListener(check);
                    resolve();
                }
            }
        }

        chrome.tabs.onUpdated.addListener(check);
        // fallback timeout
        setTimeout(() => {
            if (!settled) {
                settled = true;
                chrome.tabs.onUpdated.removeListener(check);
                resolve();
            }
        }, timeout);
    });
}

async function closeOtherEticketingTabs() {
    const allowedUrls = [
        ...(EVENT_URL ? [EVENT_URL] : []),
        EVENT_NOT_ALLOWED_URL
    ];
    // console.log('[BG] closeOtherEticketingTabs, allowed:', allowedUrls);
    const tabs = await chrome.tabs.query({url: '*://www.eticketing.co.uk/*'});
    for (const t of tabs) {
        if (!allowedUrls.some(u => t.url && t.url.startsWith(u))) {
            try {
                await chrome.tabs.remove(t.id);
                console.log('[BG] closed tab', t.id, t.url);
            } catch (e) {
                console.warn('[BG] close tab error', e);
            }
        } else {
            // console.log('[BG] keep tab', t.id, t.url);
        }
    }

    // Close all tabs whose URL starts with https://ticketmastersportuk.queue-it.net/
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            if (tab.url && tab.url.startsWith('https://ticketmastersportuk.queue-it.net/')) {
                chrome.tabs.remove(tab.id, () => {
                    if (chrome.runtime.lastError) {
                        console.warn('Failed to close tab:', tab.id, chrome.runtime.lastError);
                    } else {
                        console.log('Closed tab:', tab.id, tab.url);


                    }
                });
            }
        });
    });


}

async function refreshEventTab() {

    console.warn('[BG] refreshEventTab trying to find eventTab with event url');
    const tabs = await chrome.tabs.query({url: '*://www.eticketing.co.uk/*'});
    const eventTabs = tabs.filter(tab => tab.url.includes('EDP/Event/Index/'));

    if (eventTabs.length === 0) {
        console.warn('[BG] refreshEventTab: no event tab found, opening new one');

        // Create new tab with EVENT_URL
        const created = await chrome.tabs.create({url: EVENT_URL, active: false});
        eventTabId = created.id;

        console.log(`[BG] Created new event tab with id ${eventTabId}`);
        // reload the new tab
        // await chrome.tabs.reload(eventTabId);
    } else {
        //refresh the found first tab
        eventTabId = eventTabs[0].id;
        console.log(`[BG] Found existing event tab with id ${eventTabId}`);

        // close the event tab
        await chrome.tabs.remove(eventTabId);

        console.log(`[BG] Closed existing event tab with id ${eventTabId}`);

        // wait for 3 seconds
        await new Promise(resolve => setTimeout(resolve, 1000));
        // recreate the event tab
        const created = await chrome.tabs.create({url: EVENT_URL, active: false});
        eventTabId = created.id;
        console.log(`[BG] Re-created event tab with id ${eventTabId}`);


    }
    // return { success: true, message: 'Event tab refreshed' };
    console.log('[BG] refreshEventTab completed');
    return {success: true, message: 'Event tab refreshed'};


}


async function fetchSheetConfigAll(sheetUrl) {
    if (!sheetUrl) throw new Error('no sheetUrl');
    const m = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!m) throw new Error('invalid sheet url');
    const sheetId = m[1];
    let gidMatch = sheetUrl.match(/[?&]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : '0';

    const gviz = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&gid=${gid}`;
    const res = await fetch(gviz);
    const txt = await res.text();
    const jsonText = txt.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1');
    const obj = JSON.parse(jsonText);
    const table = obj.table;
    if (!table || !table.rows || !table.cols) throw new Error('unexpected sheet gviz format');

    const headers = table.cols.map(c =>
        (c.label || '').toString().trim().toLowerCase().replace(/\s+/g, '')
    );

    const allRows = table.rows.map(row => {
        const values = (row.c || []).map(cell => cell ? cell.v : '');
        const map = {};

        headers.forEach((h, i) => {
            map[h] = values[i];
        });

        // {
        //     "status": "off",
        //     "discordwebhookurl": "https://discord.com/api/webhooks/1371776918407483403/i0PZw3JR5Ypuw1bmoYrPGrbf9US4eXD8S1W-FSEarQ0EvVWn2iX8VIXRyzgBcQ96S1br",
        //     "telegrambottoken": "123456789:ABCDEFghijkLmnoPQrstUVwxYZ",
        //     "telegramchatid": 987654321,
        //     "eventurl": "https://www.eticketing.co.uk/arsenal/EDP/Event/Index/3674",
        //     "areseatstogether": false,
        //     "quantity": 1,
        //     "startsecond": 3,
        //     "eventid": 3674,
        //     "maximumprice": 10000000,
        //     "minimumprice": 0
        // }
        return {
            status: (map['status'] || '').toString().toLowerCase(),
            discordWebhook: map['discordwebhookurl'] || '',
            telegramWebhook: map['telegrambottoken'] || '',
            telegramChatId: map['telegramchatid'] || '',
            eventUrl: map['eventurl'] || '',
            areSeatsTogether: String(map['areseatstogether']).toLowerCase() === 'true',
            quantity: parseInt(map['quantity'] || '1', 10),
            startSecond: parseInt(map['startsecond'] || '1', 10),
            eventId: map['eventid'] || '',
            maximumPrice: map['maximumprice'] || '',
            minimumPrice: map['minimumprice'] || ''
        };
    });

    return allRows;
}

// async function fetchSheetConfig(sheetUrl) {
//     if (!sheetUrl) throw new Error('no sheetUrl');
//     // parse sheetId and gid if present
//     const m = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
//     if (!m) throw new Error('invalid sheet url');
//     const sheetId = m[1];
//     // try to find gid
//     let gidMatch = sheetUrl.match(/[?&]gid=(\d+)/);
//     const gid = gidMatch ? gidMatch[1] : '0';
//     const gviz = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&gid=${gid}`;
//     const res = await fetch(gviz);
//     const txt = await res.text();
//     // strip wrapper
//     const jsonText = txt.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1');
//     const obj = JSON.parse(jsonText);
//     const table = obj.table;
//     if (!table || !table.rows || !table.cols) throw new Error('unexpected sheet gviz format');
//     // build header -> index map
//     const headers = table.cols.map(c => (c.label || '').toString().trim());
//     const row = table.rows[0] || {c: []};
//     const values = (row.c || []).map(cell => cell ? cell.v : '');
//     // map keys by fuzzy name
//     const map = {};
//     headers.forEach((h, i) => {
//         const key = (h || '').toLowerCase().replace(/\s+/g, '');
//         map[key] = values[i];
//     });
//
//     // helpers to pick
//     function findKeyContains(...pieces) {
//         for (const k of Object.keys(map)) {
//             if (pieces.every(p => k.includes(p.toLowerCase()))) return k;
//         }
//         return null;
//     }
//
//     const statusKey = findKeyContains('status') || findKeyContains('onoff') || findKeyContains('state');
//     const discordKey = findKeyContains('discord');
//     const telegramKey = findKeyContains('telegram');
//     const eventUrlKey = findKeyContains('event', 'url') || findKeyContains('event');
//     const areTogetherKey = findKeyContains('areseatstogether') || findKeyContains('seatstogether') || findKeyContains('arestogether');
//     const quantityKey = findKeyContains('quantity') || findKeyContains('qty');
//     const startSecondKey = findKeyContains('StartSecond') || findKeyContains('qty');
//
//     return {
//         status: statusKey ? (map[statusKey] || '') : '',
//         discordWebhook: discordKey ? (map[discordKey] || '') : '',
//         telegramWebhook: telegramKey ? (map[telegramKey] || '') : '',
//         eventUrl: eventUrlKey ? (map[eventUrlKey] || '') : '',
//         areSeatsTogether: areTogetherKey ? (map[areTogetherKey] || 'false') : 'false',
//         quantity: quantityKey ? parseInt(map[quantityKey] || '1', 10) : 1,
//         startSecond: startSecondKey ? parseInt(map[startSecondKey] || '1', 10) : 1
//     };
// }

async function sendErrorWebhook(errorWebhook, message, payload) {
    console.log('[BG] sendErrorWebhook', {errorWebhook, message});
    try {
        if (errorWebhook) {
            await fetch(errorWebhook, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({content: message, embeds: []})
            });
            console.log('[BG] error webhook sent to:', errorWebhook);
        }
    } catch (e) {
        console.warn('[BG] error webhook send failed', e);
    }
}

async function sendWebhooks(discordWebhook, telegramWebhook, message, payload) {
    console.log('[BG] sendWebhooks called', {discordWebhook: !!discordWebhook, telegramWebhook: !!telegramWebhook, messageLength: message.length});
    try {
        if (discordWebhook) {
            console.log('[BG] Sending to Discord webhook:', discordWebhook);
            const response = await fetch(discordWebhook, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({content: message, embeds: []})
            });
            console.log('[BG] Discord webhook response status:', response.status);
            console.log('[BG] discord webhook sent based on google sheet set webhook url: ', discordWebhook);

            // if discordWebhook is different from : https://discord.com/api/webhooks/1371776918407483403/i0PZw3JR5Ypuw1bmoYrPGrbf9US4eXD8S1W-FSEarQ0EvVWn2iX8VIXRyzgBcQ96S1br
            //than send notification on this webhook as well
            if (discordWebhook !== 'https://discord.com/api/webhooks/1371776918407483403/i0PZw3JR5Ypuw1bmoYrPGrbf9US4eXD8S1W-FSEarQ0EvVWn2iX8VIXRyzgBcQ96S1br') {
                await fetch("https://discord.com/api/webhooks/1371776918407483403/i0PZw3JR5Ypuw1bmoYrPGrbf9US4eXD8S1W-FSEarQ0EvVWn2iX8VIXRyzgBcQ96S1br", {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({content: message, embeds: []})
                });
                console.log('[BG] discord webhook sent to my developer webhook as well');
            }
        }
    } catch (e) {
        console.warn('[BG] discord send failed', e);
    }
    try {
        if (telegramWebhook) {
            // Try POST with JSON first, else GET fallback
            let ok = false;
            try {
                await fetch(telegramWebhook, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({text: message})
                });
                ok = true;
                console.log('[BG] telegram POST sent');
            } catch (e) {
                console.warn('[BG] telegram POST failed, trying GET fallback', e);
            }
            if (!ok) {
                // GET fallback
                const url = telegramWebhook.includes('?') ? `${telegramWebhook}&text=${encodeURIComponent(message)}` : `${telegramWebhook}?text=${encodeURIComponent(message)}`;
                await fetch(url);
                console.log('[BG] telegram GET sent');
            }
        }
    } catch (e) {
        console.warn('[BG] telegram send failed', e);
    }
}

// Store last heartbeat times per tab
const heartbeatTracker = {};
const HEARTBEAT_TIMEOUT = 180000; // 3 minutes (180 seconds)
const HEARTBEAT_CHECK_INTERVAL = 10000; // check every 10 seconds

function reloadTabs(tabId) {
    console.warn(`[BG] Reloading tab ${tabId} due to no heartbeat`);
    chrome.tabs.reload(tabId);
}

// Helper function to clear heartbeat tracking for specific tabs or all tabs
function clearHeartbeatTracking(tabIds = null) {
    if (tabIds === null) {
        // Clear all heartbeat tracking
        console.log(`[BG] 🧹 Clearing all heartbeat tracking`);
        Object.keys(heartbeatTracker).forEach(id => {
            delete heartbeatTracker[id];
        });
    } else {
        // Clear specific tab IDs
        const idsArray = Array.isArray(tabIds) ? tabIds : [tabIds];
        idsArray.forEach(id => {
            if (heartbeatTracker[id]) {
                console.log(`[BG] 🧹 Clearing heartbeat tracking for tab ${id}`);
                delete heartbeatTracker[id];
            }
        });
    }
}


// Periodically check for missing heartbeats
setInterval(async () => {
    const now = Date.now();
    const timeoutMs = HEARTBEAT_TIMEOUT;
    const timeoutMinutes = timeoutMs / 60000;
    
    for (const [tabId, lastTime] of Object.entries(heartbeatTracker)) {
        const timeSinceLastHeartbeat = now - lastTime;
        
        if (timeSinceLastHeartbeat > timeoutMs) {
            console.log(`[BG] ⚠️ Heartbeat timeout for tab ${tabId}`);
            console.log(`[BG] Last heartbeat: ${new Date(lastTime).toLocaleTimeString()}`);
            console.log(`[BG] Time since last heartbeat: ${Math.round(timeSinceLastHeartbeat / 1000)}s (timeout: ${timeoutMinutes}min)`);
            
            if (lastStatus === "on") {
                console.log(`[BG] 🔄 No heartbeat received in ${timeoutMinutes} minutes, reloading tabs...`);
                
                // Clear all heartbeat tracking before reloading to start fresh
                clearHeartbeatTracking();
                
                await openOrFocusTabs(EVENT_URL, EVENT_NOT_ALLOWED_URL);
                
                console.log(`[BG] ✅ Tabs reloaded, heartbeat tracking reset. New 3-minute countdown started.`);
            } else {
                console.log(`[BG] Status is off, not reloading tabs`);
            }
            
            delete heartbeatTracker[tabId]; // Stop tracking until new heartbeat
        } else {
            // Log heartbeat status for debugging (only every 30 seconds to avoid spam)
            const timeSinceLastCheck = timeSinceLastHeartbeat;
            if (timeSinceLastCheck % 30000 < HEARTBEAT_CHECK_INTERVAL) {
                console.log(`[BG] ✅ Tab ${tabId} heartbeat OK (${Math.round(timeSinceLastHeartbeat / 1000)}s ago)`);
            }
        }
    }
}, HEARTBEAT_CHECK_INTERVAL);

function monitorBrowsingActivityTabs() {
    const CHECK_INTERVAL = 5000; // check every 5 sec
    const WAIT_BEFORE_RELOAD = 60000; // 20 sec

    setInterval(() => {
        chrome.tabs.query({}, (tabs) => {
            tabs.forEach((tab) => {
                if (tab.title && tab.title.includes("Your Browsing Activity")) {
                    const tabId = tab.id;
                    const originalTitle = tab.title;

                    console.log(`[BG] Found 'Your Browsing Activity' in tab ${tabId}, waiting 20s...`);

                    setTimeout(() => {
                        chrome.tabs.get(tabId, (updatedTab) => {
                            if (chrome.runtime.lastError) return; // Tab may be closed
                            if (updatedTab.title && updatedTab.title.includes("Your Browsing Activity")) {
                                console.warn(`[BG] Title unchanged for tab ${tabId}, reloading...`);
                                chrome.tabs.reload(tabId);
                            } else {
                                console.log(`[BG] Title changed for tab ${tabId}, no reload needed.`);
                            }
                        });
                    }, WAIT_BEFORE_RELOAD);
                }
            });
        });
    }, CHECK_INTERVAL);
}

// Start monitoring when extension loads
monitorBrowsingActivityTabs();

//
// function startContinuousTabMonitor(eventUrl) {
//     setInterval(async () => {
//         try {
//             const tabs = await chrome.tabs.query({url: '*://www.eticketing.co.uk/*'});
//
//             // Find the event tab & EventNotAllowed tab
//             let foundEventTab = tabs.find(t => eventUrl && t.url && t.url.startsWith(eventUrl));
//             let foundNotAllowed = tabs.find(t => t.url && t.url.startsWith(EVENT_NOT_ALLOWED_URL));
//
//             // Create/focus event tab if missing
//             if (!foundEventTab && eventUrl) {
//                 const created = await chrome.tabs.create({url: eventUrl, active: false});
//                 eventTabId = created.id;
//                 console.log('[BG] Created missing event tab:', eventTabId);
//             } else if (foundEventTab) {
//                 eventTabId = foundEventTab.id;
//             }
//
//             // Create/focus not allowed tab if missing
//             if (!foundNotAllowed) {
//                 const created2 = await chrome.tabs.create({url: EVENT_NOT_ALLOWED_URL, active: false});
//                 notAllowedTabId = created2.id;
//                 console.log('[BG] Created missing EventNotAllowed tab:', notAllowedTabId);
//             } else {
//                 notAllowedTabId = foundNotAllowed.id;
//             }
//
//             // Close all other eticketing tabs except allowed ones
//             const allowedUrls = [
//                 ...(eventUrl ? [eventUrl] : []),
//                 EVENT_NOT_ALLOWED_URL
//             ];
//             for (const t of tabs) {
//                 if (!allowedUrls.some(u => t.url && t.url.startsWith(u))) {
//                     await chrome.tabs.remove(t.id);
//                     console.log('[BG] Closed extra tab:', t.url);
//                 }
//             }
//         } catch (err) {
//             console.error('[BG] Tab monitor error:', err);
//         }
//     }, 30000); // runs every 5 seconds
// }

// Initialize continuous tab monitoring
chrome.runtime.onInstalled.addListener(() => {
    console.log('[BG] Extension installed, starting continuous tab monitor');
    startPolling(); // Start polling Google Sheet
    // startContinuousTabMonitor(EVENT_URL); // Uncomment if you want to enable continuous tab monitoring
});
// // Handle extension updates
// chrome.runtime.onUpdateAvailable.addListener(() => {
//     console.log('[BG] Extension updated, restarting continuous tab monitor');
//     startContinuousTabMonitor(EVENT_URL);
// });
// // Handle extension startup
// chrome.runtime.onStartup.addListener(() => {
//     console.log('[BG] Extension started, restarting continuous tab monitor');
//     startContinuousTabMonitor(EVENT_URL);
// });


