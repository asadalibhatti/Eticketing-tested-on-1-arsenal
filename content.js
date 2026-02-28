console.log('TICKET Checking content script loaded on', location.href);

// When event page loads (e.g. after queue or error403 resume), reset queue error403 count so next time wait starts at 5 min
(async () => {
    const { eventUrl } = await chrome.storage.local.get('eventUrl');
    const current = (location.href || '').split('?')[0];
    const storedBase = eventUrl ? eventUrl.split('?')[0] : '';
    if (storedBase && (current === storedBase || current.startsWith(storedBase + '/'))) {
        chrome.runtime.sendMessage({ action: 'resetError403Count' }, () => {
            if (!chrome.runtime.lastError) console.log('[CS] Event URL loaded - reset queue error403Count to 0');
        });
    }
})();

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
    }, 60000);
}

let monitor = {
    running: false,
    sheetUrl: null,
    startSecond: null,
    areSeatsTogether: false,
    quantity: null,
    discordWebhook: null,
    telegramWebhook: null,
    eventUrl: null,
    eventId: null,
    intervalId: null,
    last403Time: 0
};

// Club-based PriceClassId mapping
const clubPriceClassIdMap = {
    'arsenal': 1,
    'nottinghamforest': 317,
    'cpfc': 1,  // Crystal Palace - default to 1, update if needed
    'chelseafc': 2,  // Chelsea - default to 1, update if needed
    'tottenhamhotspur': 1,
    // Add more clubs as needed
};

// Helper function to get PriceClassId for a club
function getPriceClassIdForClub(clubName) {
    const normalizedClubName = (clubName || '').toLowerCase().trim();
    const priceClassId = clubPriceClassIdMap[normalizedClubName];
    
    if (priceClassId !== undefined) {
        return priceClassId;
    }
    
    // Default fallback to 1 if club not found in map
    console.warn(`[CS] PriceClassId not found for club "${clubName}", using default: 1`);
    return 1;
}
// Auto start monitoring if on the expected page
(async () => {
    if (!window.location.search.includes("eventId=4&reason=EventArchived")) {
        console.warn('[CS] Not on eventId=4&reason=EventArchived page, stopping auto-start');
        return;
    }

    try {
        console.log('[CS] Auto-starting monitor on page load');
        await startMonitorFlow();
    } catch (e) {
        console.error('[CS] Auto startMonitorFlow error:', e);
    }
})();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'error403Resume') {
        console.log('[CS] error403 pause ended - resuming seat check instantly');
        if (monitor.running) runCheck();
        return;
    }
    if (window.location.search.includes("eventId=4&reason=EventArchived")) {
        if (msg.action === 'startMonitoring') {//start will be from backgroun script
            console.log('[CS] received startMonitoring', msg);
            monitor.sheetUrl = msg.sheetUrl || monitor.sheetUrl;
            monitor.startSecond = (msg.startSecond); // set in extension popup, received as a message

            // eventUrl may be provided in msg or we can get from sheet
            startMonitorFlow().catch(e => console.error('[CS] startMonitorFlow error', e));
        }
        if (msg.action === 'stopMonitoring') {
            stopMonitoring('stop message from background');
        }
    } else {
        // Stop script execution
        console.warn('[CS] not on eventId=4&reason=EventArchived page, stopping script execution');
    }

    return true;
});

async function startMonitorFlow() {
    console.log('[CS] startMonitorFlow begin');

    // currentStatus: currentStatus,
    //                         eventUrl: row.eventUrl,
    //                         startSecond: row.startSecond,
    //                         areSeatsTogether: row.areSeatsTogether === 'true', // convert to boolean
    //                         quantity: parseInt(row.quantity, 10) || 1,
    //                         discordWebhook: row.discordWebhook,
    //                         telegramWebhook: row.telegramWebhook,
    //                         telegramChatId: row.telegramChatId,
    //                         eventId: row.eventId,
    //                         maximumPrice: row.maximumPrice,
    //                         minimumPrice: row.minimumPrice


    const {sheetUrl, startSecond} = await chrome.storage.local.get(['sheetUrl', 'startSecond']);
    monitor.sheetUrl = sheetUrl;
    monitor.startSecond = startSecond;
    const {eventUrl} = await chrome.storage.local.get('eventUrl');
    monitor.eventUrl = eventUrl;
    monitor.areSeatsTogether = await chrome.storage.local.get('areSeatsTogether').then(res => res.areSeatsTogether === true);
    monitor.quantity = await chrome.storage.local.get('quantity').then(res => parseInt(res.quantity || '1', 10));
    monitor.eventId = await chrome.storage.local.get('eventId').then(res => res.eventId || null);


    console.log('[CS] monitor config:', monitor);

    if (!monitor.eventUrl) {
        //read all data from google sheet and set
        console.warn('[CS] no eventUrl found in storage, will not monitor');
        if (monitor.sheetUrl) {
            console.warn('[CS] using sheetUrl', monitor.sheetUrl, 'to read eventUrl');
            //read from sheet
            const row = await getMatchingRowFromSheet(monitor.sheetUrl, monitor.startSecond);
            if (row) {
                monitor.eventUrl = row.EventUrl;
                monitor.startSecond = parseInt(row.StartSecond, 10) || monitor.startSecond;
                monitor.areSeatsTogether = row.AreSeatsTogether === true || ('' + row.AreSeatsTogether).toLowerCase() === 'true';
                monitor.quantity = parseInt(row.Quantity || '1', 10);
                
                // Save AreSeatsTogether, Quantity, and login credentials to local storage to avoid name mismatch
                // Try multiple variations of the areaIds column name
                const areaIdsValue = row['areaIds to monitor'] || row['AreaIds to monitor'] || row['areaIds to Monitor'] || 
                                    row.AreaIds || row.areaIds || row['AreaIds'] || row['areaIds'] || '';
                
                // Try multiple variations of the areas to ignore column name
                const areasToIgnoreValue = row['areas to ignore'] || row['Areas to ignore'] || row['Areas to Ignore'] || 
                                          row.AreasToIgnore || row.areasToIgnore || row['AreasToIgnore'] || row['areasToIgnore'] || '';
                
                
                await chrome.storage.local.set({
                    areSeatsTogether: monitor.areSeatsTogether,
                    quantity: monitor.quantity,
                    loginEmail: row.LoginEmail || '',
                    loginPassword: row.LoginPassword || '',
                    areaIds: areaIdsValue,
                    areasToIgnore: areasToIgnoreValue
                });
            } else {
                console.warn('[CS] no matching row found in sheet for startSecond', monitor.startSecond);
            }
        }

        // console.warn('[CS] no eventUrl found, will not monitor');
        // return;
    }

    monitor.eventId = extractEventId(monitor.eventUrl || location.href);
    console.log('[CS] using eventId', monitor.eventId);

    if (!monitor.running) {
        monitor.running = true;
        console.log('[CS] starting ======== monitor loop');
        //run immediate check once for first time
        // await alignToStartSecond(monitor.startSecond).catch(e => console.error('[CS] alignToStartSecond error', e));
        // console.log('[CS] aligned to startSecond', monitor.startSecond);
        await checkOnce().catch(e => console.error('[CS] checkOnce error', e));

        scheduleNextCheck(); // first call
    } else {
        console.log('[CS] monitor already running');
    }
}


let lastScheduledTime = null; // stores the planned next run time
let lastRealignTime = null;   // stores the timestamp of the last realignment
let lastRunStartTime = null; // when runCheck() last started (used to log response time)

async function scheduleNextCheck() {
    const waitMs = 12000; // exactly 12 seconds between each API call (realign every 2 min keeps drift small)
    const realignIntervalMs = 120000; // 2 minutes for realignment

    // During error403 pause, poll every 5s so we resume quickly when flag clears
    const { error403PauseUntil = 0 } = await chrome.storage.local.get('error403PauseUntil');
    if (error403PauseUntil > 0 && Date.now() < error403PauseUntil) {
        const pauseDelay = 5000;
        const nextAt = new Date(Date.now() + pauseDelay);
        console.log('[CS] Next seat API call in 5s at ' + nextAt.toLocaleTimeString() + ' (error403 pause, will retry when pause ends)');
        chrome.runtime.sendMessage({ type: 'heartbeat' }).catch(() => {});
        setTimeout(runCheck, pauseDelay);
        return;
    }

    const now = Date.now();

    if (!lastScheduledTime) {
        // First run: align with monitor.startSecond
        const dateNow = new Date();
        const curSec = dateNow.getSeconds();
        const base = monitor.startSecond ?? 0;

        let deltaSec = (base - curSec) % Math.floor(waitMs / 1000);
        if (deltaSec <= 0) deltaSec += Math.floor(waitMs / 1000);

        const alignMs = deltaSec * 1000 - dateNow.getMilliseconds();
        lastScheduledTime = now + alignMs;
        lastRealignTime = now;

        const nextRun = new Date(lastScheduledTime);
        console.log('[CS] Next seat API call in ' + (alignMs / 1000).toFixed(1) + 's at ' + nextRun.toLocaleTimeString() + ' (first check aligned to startSecond=' + base + ')');

        setTimeout(runCheck, alignMs);
        return;
    }

    // Check if it's time to realign
    if (now - lastRealignTime >= realignIntervalMs) {
        // Realign lastScheduledTime to current time + alignment to startSecond

        const dateNow = new Date();
        const curSec = dateNow.getSeconds();
        const base = monitor.startSecond ?? 0;

        let deltaSec = (base - curSec) % Math.floor(waitMs / 1000);
        if (deltaSec <= 0) deltaSec += Math.floor(waitMs / 1000);

        const alignMs = deltaSec * 1000 - dateNow.getMilliseconds();
        const newScheduledTime = now + alignMs;

        // Calculate how much adjustment we are making
        const adjustmentMs = newScheduledTime - lastScheduledTime;

        console.log(`[CS] Realigning schedule after 2 minutes.`);
        console.log(`[CS] Previous lastScheduledTime: ${new Date(lastScheduledTime).toLocaleTimeString()}`);
        // console.log(`[CS] New lastScheduledTime:      ${new Date(newScheduledTime).toLocaleTimeString()}`);
        console.log(`[CS] Adjustment applied:        ${adjustmentMs} ms (${(adjustmentMs / 1000).toFixed(2)} seconds)`);

        lastScheduledTime = newScheduledTime;
        lastRealignTime = now;
    } else {
        // Normal increment by waitMs (next run is 12s after *scheduled* start of last run)
        lastScheduledTime += waitMs;
    }

    // delay = lastScheduledTime - now (compensates for response time when we're on time)
    let delay = lastScheduledTime - now;

    // If we're behind (API took too long), schedule at the next 12s boundary so we never fire in the past
    if (delay <= 0) {
        const dateNow = new Date();
        const curSec = dateNow.getSeconds();
        const base = monitor.startSecond ?? 0;
        const K = Math.floor(waitMs / 1000);
        let deltaSec = (base - curSec) % K;
        if (deltaSec <= 0) deltaSec += K;
        const alignMs = deltaSec * 1000 - dateNow.getMilliseconds();
        lastScheduledTime = now + alignMs;
        delay = alignMs;
    } else if (delay < 7000) {
        // Slightly behind but positive: push to next full 12s interval
        delay += waitMs;
        lastScheduledTime = now + delay;
    }

    const nextCallAt = new Date(now + delay);
    const responseTimeMs = typeof lastRunStartTime === 'number' ? now - lastRunStartTime : null;
    if (responseTimeMs != null) {
        console.log('[CS] API+processing took ' + (responseTimeMs / 1000).toFixed(2) + 's, next seat API call in ' + (delay / 1000).toFixed(1) + 's at ' + nextCallAt.toLocaleTimeString());
    } else {
        console.log('[CS] Next seat API call in ' + (delay / 1000).toFixed(1) + 's at ' + nextCallAt.toLocaleTimeString());
    }
    chrome.runtime.sendMessage({type: "heartbeat"});
    setTimeout(runCheck, delay);
}

async function runCheck() {
    lastRunStartTime = Date.now();
    await checkOnce().catch(e => console.error('[CS] checkOnce err', e));
    if (monitor.running) scheduleNextCheck();
}


function extractEventId(url) {
    try {
        const m = (url || '').match(/\/Event\/Index\/(\d+)/);
        if (m) return parseInt(m[1], 10);
        const m2 = (url || '').match(/eventid=(\d+)/i);
        if (m2) return parseInt(m2[1], 10);
        return null;
    } catch (e) {
        return null;
    }
}

async function alignToStartSecond(startSec) {
    const now = new Date();
    const curSec = now.getSeconds();
    let waitMs = 0;
    if (startSec === undefined || startSec === null) startSec = 2;
    if (curSec === startSec) waitMs = 0;
    else if (curSec < startSec) waitMs = (startSec - curSec) * 1000;
    else waitMs = ((60 - curSec) + startSec) * 1000;
    console.log(`[CS] aligning to second ${startSec}. waiting ${waitMs / 1000}s`);
    return new Promise(resolve => setTimeout(resolve, waitMs));
}

async function getMatchingRowFromSheet(sheetUrl, startSecond) {
    try {
        // Extract sheet ID and gid
        const m = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
        if (!m) throw new Error('Invalid sheet URL');
        const sheetId = m[1];
        let gidMatch = sheetUrl.match(/[?&]gid=(\d+)/);
        const gid = gidMatch ? gidMatch[1] : '0';

        // Build GViz URL
        const gviz = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&gid=${gid}`;
        const res = await fetch(gviz);
        const txt = await res.text();

        // Parse JSON from GViz format
        const jsonText = txt.replace(/^[^\{]+/, '').replace(/\);?$/, '');
        const obj = JSON.parse(jsonText);

        const table = obj.table;
        if (!table || !table.rows) throw new Error('No table data found');

        // Headers
        const headers = table.cols.map(c => (c.label || '').trim());

        let rowMatchedButOff = false;
        // Iterate rows
        for (const row of table.rows) {
            const values = (row.c || []).map(cell => cell ? cell.v : '');
            const rowData = {};
            headers.forEach((h, i) => {
                rowData[h] = values[i];
            });

            // Check match
            const status = (rowData.Status || '').toString().trim().toLowerCase();
            const sheetSecond = parseInt(rowData.StartSecond, 10);
            if (sheetSecond === startSecond) {
                // console.log('[CS] found matching row for startSecond', startSecond, 'with status', status);
                if (['off', '0', 'false', 'stop'].includes(status)) {
                    console.log('[CS] found matching row but status is Off, will not monitor');
                    rowMatchedButOff = true;
                    continue; // skip this row
                }


            }
            if (status === 'on' && sheetSecond === startSecond) {
                // console.log('[CS] Found matching row data:', rowData);
                return rowData; // Found matching row
            }

        }
        if (rowMatchedButOff) {
            console.log('[CS] found matching row for startSecond', startSecond, 'but status is Off, will not monitor');
            stopMonitoring('sheet status is Off');
            return null; // matched but off, stop monitoring
        }

        return null; // No match found
    } catch (err) {
        console.error('Error reading sheet:', err);
        return null;
    }
}

let checksheet = true;//read sheet one time and not next and so on

// Separate error counters for different error types
let error403Count = 0;           // For 403 Forbidden errors
let justRefreshedDueTo403 = false; // true after a refresh due to 403; next 403 triggers clear cookies + refresh
let tunnelTimeoutErrorCount = 0; // For tunnel connection and timeout errors
let corsErrorCount = 0;          // For CORS errors
let notfound400erorsCount = 0;   // For other HTTP errors (400, 401, 402, 302, 500)

async function tryDirectAddToBasketSecondapi(data, clubname, eventId, verificationToken, endpointType = 'Regular') {
    let successCount = 0;       // Track successful adds
    let totalFetchCount = 0;    // Track total fetch attempts
    
    // Get PriceClassId for this club
    const priceClassId = getPriceClassIdForClub(clubname);

    const { areaIds, areasToIgnore } = await chrome.storage.local.get(['areaIds', 'areasToIgnore']);
    let allowedSet = null;
    if (areaIds && String(areaIds).trim() !== '') {
        const arr = String(areaIds).split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
        allowedSet = arr.length ? new Set(arr) : null;
    }
    let ignoredSet = null;
    if (areasToIgnore && String(areasToIgnore).trim() !== '') {
        const arr = String(areasToIgnore).split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
        ignoredSet = arr.length ? new Set(arr) : null;
    }
    const toAreaIdNum = (v) => { const n = Number(v); return isNaN(n) ? null : n; };
    const areasToTry = data.filter(area => {
        const id = toAreaIdNum(area.AreaId);
        if (id == null) return false;
        if (allowedSet && !allowedSet.has(id)) return false;
        if (ignoredSet && ignoredSet.has(id)) return false;
        return true;
    });
    if (areasToTry.length === 0) return false;

    for (let a = areasToTry.length - 1; a >= 0; a--) {
        const area = areasToTry[a];

        for (const priceBand of area.PriceBands) {
            for (const interval of priceBand.AvailableSeatsIntervals) {

                // Loop through all seats from StartXCoord to EndXCoord
                for (let x = interval.StartXCoord; x <= interval.EndXCoord; x++) {

                    if (totalFetchCount >= 4) {
                        return successCount > 0;
                    }

                    const seatPayload = {
                        EventId: eventId,
                        Seats: [
                            {
                                AreaId: area.AreaId,
                                XCoordinate: x,
                                YCoordinate: interval.YCoord,
                                PriceClassId: priceClassId,
                                IsSecondaryMarket: endpointType === 'Resale'
                            }
                        ]
                    };

                    try {
                        totalFetchCount++;
                        const res = await fetch(`https://www.eticketing.co.uk/${clubname}/EDP/Ism/Select${endpointType}Seat`, {
                            method: "PUT",
                            credentials: "include",
                            headers: {
                                "Accept": "application/json, text/plain, */*",
                                "Content-Type": "application/json",
                                "X-Requested-With": "XMLHttpRequest",
                                "RequestVerificationToken": verificationToken
                            },
                            body: JSON.stringify(seatPayload)
                        });

                        if (res.status === 400) {
                            await res.text();
                        } else if (res.status === 200) {
                            await res.text();
                            successCount++;
                            if (successCount >= 3) return true;
                        }
                    } catch (err) {
                        // silent during try loop for speed
                    }
                }
            }
        }
    }

    console.log('[CS] Direct add to basket (' + endpointType + '): ' + successCount + ' seat(s) added from ' + totalFetchCount + ' attempt(s), ' + areasToTry.length + ' area(s) tried.');
    return successCount > 0; // True if at least one success
}

let queueItErrorCount = 0;  // track consecutive queue-it redirect errors

function parseBasketHtml(html) {
    try {
        // Create a temporary DOM parser
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        const basketEvents = [];
        const basketEventElements = doc.querySelectorAll('.basket-event');
        
        basketEventElements.forEach((eventElement, index) => {
            const itemRef = eventElement.getAttribute('basket-event-item-ref');
            const eventTitle = eventElement.querySelector('.basket-event__title')?.textContent?.trim();
            
            // Get seat details
            const areaElement = eventElement.querySelector('[data-testid="seat-detail-area"] .checkout-event-seat-details__value');
            const blockElement = eventElement.querySelector('[data-testid="seat-detail-block"] .checkout-event-seat-details__value');
            const rowElement = eventElement.querySelector('[data-testid="seat-detail-row"] .checkout-event-seat-details__value');
            const seatElement = eventElement.querySelector('[data-testid="seat-detail-seat-number"] .checkout-event-seat-details__value');
            
            // Get price class
            const priceClassElement = eventElement.querySelector('[data-testid="seat-price-class"] dd');
            
            // Get price
            const priceElement = eventElement.querySelector(`#basket-item-price-${itemRef}`);
            
            const seatData = {
                itemRef: itemRef,
                eventTitle: eventTitle,
                area: areaElement?.textContent?.trim(),
                block: blockElement?.textContent?.trim(),
                row: rowElement?.textContent?.trim(),
                seat: seatElement?.textContent?.trim(),
                priceClass: priceClassElement?.textContent?.trim(),
                price: priceElement?.textContent?.trim()
            };
            
            console.log(`[CS] Parsed basket item ${index + 1}:`, seatData);
            basketEvents.push(seatData);
        });
        
        return {
            events: basketEvents,
            totalEvents: basketEvents.length
        };
    } catch (e) {
        console.error('[CS] Error parsing basket HTML:', e);
        return { events: [], totalEvents: 0 };
    }
}

function shouldSendNotificationBasedOnSeats(basketData) {
    if (!basketData || basketData.events.length === 0) {
        console.log('[CS] No basket events found, will send notification');
        return { shouldSend: true, pairs: [], pairCount: 0 };
    }
    
    const events = basketData.events;
    console.log('[CS] Analyzing', events.length, 'basket events for pair detection');
    
    // Group seats by block and row to find pairs
    const seatGroups = {};
    events.forEach(event => {
        const key = `${event.block}-${event.row}`;
        if (!seatGroups[key]) {
            seatGroups[key] = [];
        }
        seatGroups[key].push({
            ...event,
            seatNumber: parseInt(event.seat) || 0
        });
    });
    
    // Find pairs (adjacent seats in same block and row)
    const pairs = [];
    Object.values(seatGroups).forEach(group => {
        // Sort by seat number
        group.sort((a, b) => a.seatNumber - b.seatNumber);
        
        // Find adjacent seats
        for (let i = 0; i < group.length - 1; i++) {
            if (group[i + 1].seatNumber === group[i].seatNumber + 1) {
                pairs.push({
                    seat1: group[i],
                    seat2: group[i + 1],
                    block: group[i].block,
                    row: group[i].row
                });
                i++; // Skip next seat as it's already paired
            }
        }
    });
    
    const pairCount = pairs.length;
    console.log('[CS] Found', pairCount, 'pairs:', pairs);
    
    // Always send notification, but include pair information
    const shouldSend = true;
    console.log('[CS] Should send notification:', shouldSend, '(always send, pairs found:', pairCount, ')');
    
    return { shouldSend, pairs, pairCount };
}

// Helper function to get email for notifications
async function getEmailForNotification() {
    try {
        console.log('[CS] Getting email for notification...');
        
        // Method 1: Try to get from localStorage
        const EMAIL_KEY = "user_email";
        const userEmail = localStorage.getItem(EMAIL_KEY);
        if (userEmail && userEmail.trim()) {
            console.log('[CS] Email found in localStorage:', userEmail.substring(0, 5) + '...');
            return userEmail;
        }
        console.log('[CS] Email not found in localStorage');
        
        // Method 2: Try to get from chrome.storage.local (loginEmail from Google Sheets)
        const storageData = await chrome.storage.local.get(['loginEmail']);
        if (storageData.loginEmail && storageData.loginEmail.trim()) {
            console.log('[CS] Email found in chrome.storage.local:', storageData.loginEmail.substring(0, 5) + '...');
            return storageData.loginEmail;
        }
        console.log('[CS] Email not found in chrome.storage.local');
        
        // Method 3: Try to get from Google Sheet directly if we have sheetUrl and startSecond
        if (monitor.sheetUrl && monitor.startSecond) {
            try {
                console.log('[CS] Attempting to get email from Google Sheet directly...');
                const matched_row = await getMatchingRowFromSheet(monitor.sheetUrl, monitor.startSecond);
                if (matched_row && matched_row.LoginEmail && matched_row.LoginEmail.trim()) {
                    console.log('[CS] Email found in Google Sheet:', matched_row.LoginEmail.substring(0, 5) + '...');
                    // Also save it to storage for future use
                    await chrome.storage.local.set({ loginEmail: matched_row.LoginEmail });
                    return matched_row.LoginEmail;
                }
            } catch (e) {
                console.warn('[CS] Error getting email from Google Sheet:', e.message);
            }
        }
        
        // Method 4: Try to get from background script (refresh credentials)
        try {
            console.log('[CS] Attempting to refresh credentials from background script...');
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
                const refreshedData = await chrome.storage.local.get(['loginEmail']);
                if (refreshedData.loginEmail && refreshedData.loginEmail.trim()) {
                    console.log('[CS] Email found after refreshing credentials:', refreshedData.loginEmail.substring(0, 5) + '...');
                    return refreshedData.loginEmail;
                }
            }
        } catch (e) {
            console.warn('[CS] Error refreshing credentials:', e.message);
        }
        
        console.warn('[CS] Could not find email from any source, returning "Unknown Email"');
        return "Unknown Email";
    } catch (e) {
        console.error('[CS] Error getting email for notification:', e);
        return "Unknown Email";
    }
}

async function checkOnce() {
    if (!monitor.running) return;

    // Pause seat checking during queue error403 wait (5 min)
    const { error403PauseUntil = 0 } = await chrome.storage.local.get('error403PauseUntil');
    if (error403PauseUntil > 0 && Date.now() < error403PauseUntil) {
        console.log('[CS] error403 pause active - skipping seat check');
        return;
    }

    let matched_row = null;
    if (checksheet) {
        matched_row = await getMatchingRowFromSheet(monitor.sheetUrl, monitor.startSecond);
        if (matched_row) {
            monitor.discordWebhook = matched_row.DiscordWebhook || monitor.discordWebhook;
            monitor.telegramWebhook = matched_row.TelegramWebhook || monitor.telegramWebhook;
            monitor.eventUrl = matched_row.EventUrl || monitor.eventUrl;
            monitor.areSeatsTogether = matched_row.AreSeatsTogether === true || ('' + matched_row.AreSeatsTogether).toLowerCase() === 'true';
            monitor.quantity = parseInt(matched_row.Quantity || '1', 10);
            
            // Save AreSeatsTogether, Quantity, and login credentials to local storage to avoid name mismatch
            // Try multiple variations of the areaIds column name
            const areaIdsValue = matched_row['areaIds to monitor'] || matched_row['AreaIds to monitor'] || matched_row['areaIds to Monitor'] || 
                                matched_row.AreaIds || matched_row.areaIds || matched_row['AreaIds'] || matched_row['areaIds'] || '';
            
            // Try multiple variations of the areas to ignore column name
            const areasToIgnoreValue = matched_row['areas to ignore'] || matched_row['Areas to ignore'] || matched_row['Areas to Ignore'] || 
                                      matched_row.AreasToIgnore || matched_row.areasToIgnore || matched_row['AreasToIgnore'] || matched_row['areasToIgnore'] || '';
            
            
            await chrome.storage.local.set({
                areSeatsTogether: monitor.areSeatsTogether,
                quantity: monitor.quantity,
                loginEmail: matched_row.LoginEmail || '',
                loginPassword: matched_row.LoginPassword || '',
                areaIds: areaIdsValue,
                areasToIgnore: areasToIgnoreValue
            });

            const status = (matched_row.Status || '').toString().trim().toLowerCase();
            console.log('[CS] sheet status', status);

            if (['off', '0', 'false', 'stop'].includes(status)) {
                console.log('[CS] sheet status is Off, stopping monitoring');
                stopMonitoring('sheet status is Off');
                return;
            } else if (!['on', 'start', 'true', '1'].includes(status)) {
                console.warn('[CS] unknown sheet status:', status);
            }
        }
        checksheet = false;
    } else {
        checksheet = true;
    }

    if (!monitor.eventId) {
        monitor.eventId = extractEventId(monitor.eventUrl || location.href);
        if (!monitor.eventId) {
            console.warn('[CS] no eventId, will not check');
            return;
        }
    }

    function getClubName(url) {
        const parts = url.split('/');
        return parts[3];
    }

    const clubName = getClubName(monitor.eventUrl);
    const isResale = (() => {
        const now = Date.now();
        const randomSeed = Math.random();
        const combinedSeed = (now % 1000) + (randomSeed * 1000);
        return (combinedSeed % 100) < 96;
    })();
    const endpointType = isResale ? 'Resale' : 'Regular';
    const marketTypeParam = isResale ? '&MarketType=1' : '';
    const url = `https://www.eticketing.co.uk/${clubName}/EDP/Seats/Available${endpointType}?AreSeatsTogether=${monitor.areSeatsTogether}&EventId=${monitor.eventId}${marketTypeParam}&MaximumPrice=10000000&MinimumPrice=0&Quantity=${monitor.quantity}`;

    let res;
    try {
        res = await fetch(url, {
            method: 'GET',
            headers: {
                "accept": "application/json, text/plain, */*",
                "x-requested-with": "XMLHttpRequest",
                "referer": location.href
            },
            credentials: "include"
        });

        // Reset queue-it error count on successful fetch
        // queueItErrorCount = 0;

        // Detect if redirected to queue (queue-it.net or hd-queue.eticketing.co.uk)
        if (res.url.includes('queue-it.net') || res.url.includes('hd-queue.eticketing.co.uk')) {
            queueItErrorCount++;
            console.warn('[CS] Redirected to queue page, count:', queueItErrorCount);

            if (queueItErrorCount >= 1) {
                console.warn('[CS] 1 consecutive queue-it redirects (count:', queueItErrorCount, '), refreshing...');
                chrome.runtime.sendMessage({action: 'closeOtherTabsExcept'});
                if (await refreshEventTabWithTracking()) queueItErrorCount = 0;
                return;
            }
        } else {
            // If not queue-it redirect, reset count
            queueItErrorCount = 0;
        }
    } catch (e) {
        console.error('[CS] fetch seats error', e);

        // Detect CORS / Failed to fetch case
        if (e instanceof TypeError && e.message.includes('Failed to fetch')) {
            console.warn('[CS] Failed to fetch error detected');

            // We need to distinguish between different types of "Failed to fetch" errors:
            // 1. CORS errors: Usually happen when redirected to queue-it.net
            // 2. Tunnel connection errors: Network connectivity issues (ERR_TUNNEL_CONNECTION_FAILED)
            // 3. Other network errors: Timeouts, DNS issues, etc.
            
            // The challenge is that both CORS and tunnel errors result in "Failed to fetch"
            // but have different underlying causes. Since we can't access the detailed error
            // from the JavaScript error object, we need a different approach.
            
            // One approach is to use timing or other heuristics, but for now,
            // let's be more conservative and treat most "Failed to fetch" errors as
            // tunnel/network errors, unless we have strong evidence they're CORS errors.
            
            // We'll only treat as CORS errors if we can definitively identify them.
            // For now, let's treat all "Failed to fetch" as tunnel errors to avoid
            // false positives, and rely on the redirect detection logic above
            // to catch actual CORS errors.
            
            tunnelTimeoutErrorCount++;
            console.warn('[CS] Cors or network or Tunnel connection or timeout error detected, count:', tunnelTimeoutErrorCount);
            
            if (tunnelTimeoutErrorCount >= 2) {
                console.warn('[CS] 2 consecutive tunnel/timeout errors (count:', tunnelTimeoutErrorCount, '), refreshing...');
                chrome.runtime.sendMessage({action: 'closeOtherTabsExcept'});
                if (await refreshEventTabWithTracking()) tunnelTimeoutErrorCount = 0;
                return;
            }
        } else {
            // reset on other errors
            queueItErrorCount = 0;
        }

        notfound400erorsCount++;
        return;
    }

    // Only reset all error counters on successful 200 status
    if (res.status === 200) {
        error403Count = 0;
        justRefreshedDueTo403 = false;
        tunnelTimeoutErrorCount = 0;
        corsErrorCount = 0;
        notfound400erorsCount = 0;
        queueItErrorCount = 0;
    }

    // Handle 403 errors separately
    if (res.status === 403) {
        // If we already refreshed once due to 403 and get 403 again on next check -> clear cookies and refresh immediately
        if (justRefreshedDueTo403) {
            console.warn('[CS] 403 after refresh — clearing cookies and refreshing.');
            justRefreshedDueTo403 = false;
            error403Count = 0;
            chrome.runtime.sendMessage({ action: 'clearCookiesAndRefresh' });
            await delay(2000);
            await refreshEventTabWithTracking();
            return;
        }

        error403Count++;
        console.warn('[CS] received 403 Forbidden error from check seats availability API, count:', error403Count);

        if (error403Count >= 6) {
            console.warn('[CS] 6 consecutive 403 errors — refreshing tab.');
            if (await refreshEventTabWithTracking()) {
                justRefreshedDueTo403 = true;
                error403Count = 0;
            }
        }

        return;
    }

    // Handle other HTTP errors (400, 401, 402, 302, 500)
    const otherErrorStatuses = [400, 401, 402, 302, 500];
    if (otherErrorStatuses.includes(res.status)) {
        notfound400erorsCount++;
        console.warn('[CS] received error status from check seats availability API:', res.status, ', count:', notfound400erorsCount);

        // If reached 4 errors -> refresh
        if (notfound400erorsCount === 4) {
            console.warn('[CS] 4 consecutive other errors (count:', notfound400erorsCount, ') — refreshing tab.');
            await refreshEventTabWithTracking();
        }

        // If reached 7 errors -> clear cookies + refresh
        if (notfound400erorsCount >= 7) {
            console.warn('[CS] 7 or more consecutive other errors (count:', notfound400erorsCount, ') — requesting cookie clear & refresh.');
            chrome.runtime.sendMessage({action: "clearCookiesAndRefresh"});
            await delay(2000);
            if (await refreshEventTabWithTracking()) notfound400erorsCount = 0;
        }

        return;
    }

    let data;
    try {
        data = await res.json();
    } catch (e) {
        console.warn('[CS] seats response JSON parse failed', e);
        return;
    }

    if (!Array.isArray(data) || data.length === 0) {
        console.log('[CS] Seats API: no areas returned (seat not found).');
        return;
    }

    const { areaIds, areasToIgnore } = await chrome.storage.local.get(['areaIds', 'areasToIgnore']);
    let allowedSet = null;
    if (areaIds && String(areaIds).trim() !== '') {
        const arr = String(areaIds).split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
        allowedSet = arr.length ? new Set(arr) : null;
    }
    let ignoredSet = null;
    if (areasToIgnore && String(areasToIgnore).trim() !== '') {
        const arr = String(areasToIgnore).split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
        ignoredSet = arr.length ? new Set(arr) : null;
    }

    const toAreaIdNum = (v) => { const n = Number(v); return isNaN(n) ? null : n; };
    let area = null;
    for (let i = 0; i < data.length; i++) {
        const a = data[i];
        if (!a.PriceBands || !a.PriceBands.length) continue;
        const id = toAreaIdNum(a.AreaId);
        if (id == null) continue;
        if (allowedSet && !allowedSet.has(id)) continue;
        if (ignoredSet && ignoredSet.has(id)) continue;
        area = a;
        break;
    }
    if (!area && (allowedSet || ignoredSet)) {
        if (allowedSet) {
            console.log('[CS] Skipping: no areas match areaIds filter (API returned ' + data.length + ' areas).');
            return;
        }
        area = data.find(a => {
            const id = toAreaIdNum(a.AreaId);
            return id != null && a.PriceBands && a.PriceBands.length && (!ignoredSet || !ignoredSet.has(id));
        }) || null;
        if (!area) area = data.find(a => a.PriceBands && a.PriceBands.length) || data[0];
    }
    if (!area) area = data.find(a => a.PriceBands && a.PriceBands.length) || data[0];
    if (!area) {
        console.log('[CS] Skipping: no area with PriceBands in API response.');
        return;
    }

    const priceBand = area.PriceBands[0];
    const areaId = area.AreaId;
    const priceBandId = priceBand.PriceBandCode;

    let verificationToken = localStorage.getItem("verification_token");
    if (!verificationToken) {
        verificationToken = 'MOn7sdIDdiCrtszHY1RszN2HcxXfJZh4u5JWRkfGzwqplL9l_wSMkXYhJl3VRBglbAZvjJqeNQLamfQkFoO78OD1eLA1';
    }

    const lockUrl = `https://www.eticketing.co.uk/${clubName}/EDP/BestAvailable/${endpointType}Seats`;
    const lockBody = {
        EventId: monitor.eventId,
        Quantity: monitor.quantity,
        AreSeatsTogether: monitor.areSeatsTogether,
        AreaId: areaId,
        PriceBandId: priceBandId,
        SeatAttributeIds: [],
        MinimumPrice: 0,
        MaximumPrice: 10000000
    };

    let lockRes;
    try {
        // Step 3: Make the POST request including the token
        lockRes = await fetch(lockUrl, {
            method: 'POST',
            headers: {
                "accept": "application/json, text/plain, */*",
                "accept-language": "en-US,en;q=0.9",
                "content-type": "application/json",
                "origin": "https://www.eticketing.co.uk",
                "referer": monitor.eventUrl,
                "requestverificationtoken": verificationToken,
                "sec-ch-ua": "\"Chromium\";v=\"134\", \"Not:A-Brand\";v=\"24\", \"Google Chrome\";v=\"134\"",
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": "\"Windows\"",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
                "x-requested-with": "XMLHttpRequest"
            },
            credentials: "include",
            body: JSON.stringify(lockBody)
        });
    } catch (e) {
        console.log('[CS] Seats API: ' + data.length + ' area(s). After filters: AreaId ' + areaId + ', PriceBand ' + priceBandId + '. Lock: failed (' + e.message + ').');
        const email = await getEmailForNotification();
        chrome.runtime.sendMessage({
            action: 'notifyErrorWebhooks',
            message: `\n\nError locking seats: ${e.message} for AreaId ${areaId} PriceBandId ${priceBandId}\n👤 **Account:** ${email}`,
            payload: null
        });
        return;
    }

    if (lockRes.status === 403) {
        console.log('[CS] Seats API: ' + data.length + ' area(s). After filters: AreaId ' + areaId + ', PriceBand ' + priceBandId + '. Lock: 403, trying direct add to basket.');
        if (!(await tryDirectAddToBasketSecondapi(data, clubName, monitor.eventId, verificationToken, endpointType))) {
            console.warn('[CS] Direct add to basket failed for all areas.');
            
            // Send webhook message about the failure
            const email = await getEmailForNotification();
            const errorMessage = `🎫 Direct add to basket failed for all areas. Event ${monitor.eventId}. Seats were found but could not be added to basket.\n👤 **Account:** ${email}`;
            chrome.runtime.sendMessage({
                action: 'notifyErrorWebhooks',
                message: errorMessage,
                payload: null
            });
            
            return;
        }
    } else if (lockRes.status === 400 || lockRes.status === 404) {
        lockResponseHtmlText = await lockRes.text();
        lockResponseHtmlText = lockResponseHtmlText.replace(/<[^>]*>?/g, '').replace(/\n/g, '');
        console.log('[CS] Seats API: ' + data.length + ' area(s). After filters: AreaId ' + areaId + ', PriceBand ' + priceBandId + '. Lock: failed (status ' + lockRes.status + ').');
        const email = await getEmailForNotification();
        chrome.runtime.sendMessage({
            action: 'notifyErrorWebhooks',
            message: `\n🎫 Seat AreaId ${areaId} PriceBandId ${priceBandId} found but not locked. Status: ${lockRes.status}\n👤 **Account:** ${email}`,
            payload: null
        });
        return;
    } else if (lockRes.status !== 200) {
        console.log('[CS] Seats API: ' + data.length + ' area(s). After filters: AreaId ' + areaId + ', PriceBand ' + priceBandId + '. Lock: failed (status ' + lockRes.status + ').');
        const email = await getEmailForNotification();
        chrome.runtime.sendMessage({
            action: 'notifyErrorWebhooks',
            message: `🎫 Error locking seats: ${lockRes.status} for AreaId ${areaId}\n👤 **Account:** ${email}`,
            payload: null
        });
        return;
    } else {

        let lockJson;
        try {
            lockJson = await lockRes.json();
        } catch (e) {
            console.warn('[CS] lock JSON parse failed', e);
            lockJson = null;
        }

        const lockedSeats = lockJson?.LockedSeats;
        if (!lockedSeats || lockedSeats.length === 0) {
            console.log('[CS] Seats API: ' + data.length + ' area(s). After filters: AreaId ' + areaId + ', PriceBand ' + priceBandId + '. Lock: 200 but no LockedSeats in response.');
            return;
        }

        const foundAreaIds = data.map(a => toAreaIdNum(a.AreaId)).filter(id => id != null);
        console.log('[CS] Seats API: ' + data.length + ' area(s). After filters: AreaId ' + areaId + ', PriceBand ' + priceBandId + '. Lock: success. Monitor: ' + (areaIds === '' || areaIds == null ? '(any)' : areaIds) + ' | ignore: ' + (areasToIgnore === '' || areasToIgnore == null ? '(none)' : areasToIgnore) + ' | API areas: ' + (foundAreaIds.length ? foundAreaIds.join(', ') : '(none)'));

        const priceClassId = getPriceClassIdForClub(clubName);
        let seatsToAdd;
        if (monitor.areSeatsTogether && monitor.quantity > 1) {
            seatsToAdd = lockedSeats.map(seat => ({ Id: seat.Id, PriceClassId: priceClassId }));
        } else {
            seatsToAdd = [{ Id: lockedSeats[0].Id, PriceClassId: priceClassId }];
        }

        const putBody = { EventId: monitor.eventId, Seats: seatsToAdd };
        let putRes;
        try {
            putRes = await fetch(lockUrl, {
                method: 'PUT',
                headers: {
                    "authority": "www.eticketing.co.uk",
                    "accept": "application/json, text/plain, */*",
                    "accept-encoding": "gzip, deflate, br, zstd",
                    "accept-language": "en-US,en;q=0.9,ur;q=0.8",
                    "content-length": JSON.stringify(putBody).length,

                    "content-type": "application/json",
                    "dnt": "1",
                    "origin": "https://www.eticketing.co.uk",
                    "priority": "u=1, i",
                    "referer": monitor.eventUrl,
                    "requestverificationtoken": verificationToken,
                    "x-requested-with": "XMLHttpRequest"
                },
                credentials: "include",
                body: JSON.stringify(putBody)
            });
        } catch (e) {
            console.error('[CS] add to basket fetch failed', e);
            return;
        }

        // Check if add to basket failed (not 200 or 201)
        if (putRes.status !== 200 && putRes.status !== 201) {
            console.error('[CS] Seat locked but failed to add to basket (status', putRes.status + ')');
            
            // Get email for notification
            const email = await getEmailForNotification();
            
            // Format seat details from lockedSeats
            const seatDetails = lockedSeats.map((seat, idx) => {
                return `Seat ${idx + 1}: ID ${seat.Id}${seat.AreaId ? `, AreaId ${seat.AreaId}` : ''}${seat.Row ? `, Row ${seat.Row}` : ''}${seat.SeatNumber ? `, Seat ${seat.SeatNumber}` : ''}`;
            }).join('\n');
            
            // Create error message with seat details
            const errorMessage = `❌ **SEAT LOCKED BUT NOT ADDED TO BASKET**
════════════════════════════════════════════════════════════════
🎫 **Status:** Seat locked successfully but failed to add to basket (HTTP ${putRes.status})
🆔 **Event ID:** ${monitor.eventId}
🔗 **Event URL:** ${monitor.eventUrl}
📍 **Area ID:** ${areaId}
👤 **Account:** ${email}
            
🎫 **LOCKED SEATS:**
${seatDetails}
            
⚠️ **Action Required:** Please check the basket manually or try again.
════════════════════════════════════════════════════════════════`;
            
            console.error('[CS] Sending error notification for locked seat not added to basket');
            chrome.runtime.sendMessage({
                action: 'notifyErrorWebhooks',
                message: errorMessage,
                payload: null
            });
            
            // Return early to prevent success notification
            return;
        }
        
        // Ticket successfully added to basket (status 200 or 201)
        console.log('[CS] Ticket successfully added to basket, waiting 2 seconds before fetching data layer...');
        
        // Wait 2 seconds before calling GetDataLayer to ensure data is ready
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Get data layer (products added to basket)
        const dlUrl = `https://www.eticketing.co.uk/${clubName}/tagManager/GetDataLayer`;
        console.log('[CS] Fetching data layer after 2 second delay:', dlUrl);
        let dlRes;
        try {
            dlRes = await fetch(dlUrl, {
                method: 'GET',
                headers: {
                    "authority": "www.eticketing.co.uk",
                    "path": `/${clubName}/tagManager/GetDataLayer`,
                    "scheme": "https",
                    "accept-encoding": "gzip, deflate, br, zstd",
                    "accept": "application/json, " +
                        "text/plain, */*",
                    "accept-language": "en-US,en;q=0.9,ur;q=0.8",
                    "dnt": "1",
                    "priority": "u=1, i",
                    "origin": "https://www.eticketing.co.uk",
                    "x-requested-with": "XMLHttpRequest",
                    "referer": monitor.eventUrl
                },
                credentials: "include"
            });
        } catch (e) {
            console.warn('[CS] getDataLayer fetch failed', e);
        }
        let dlJson = null;
        try {
            if (dlRes) dlJson = await dlRes.json();
        } catch (e) {
            console.warn('[CS] data layer parse failed', e);
        }

        console.log('[CS] dataLayer result', dlJson);

        //asyn call checkOnce function
        checkOnce().catch(e => console.error('[CS] checkOnce error after one product was added to basket', e));



// const message = `Tickets added to basket for Event ${monitor.eventId}. Seat info: ${JSON.stringify(dlJson?.[0]?.products || [])}`;
// Tickets added to basket for Event 3674. Seat info: [{"kickoff_datetime":"2025-09-06 13:30","category_3":"Club Level Tier 2","position":0,"category_2":"Adult","quantity":1,"price":"39.50","currency":"GBP","seatArea":"46","seatBlock":"46 Club Level","seatRow":"7 ","seatSeat":"122","id":"3674","name":"Arsenal Women v London City Lionesses","category":"Match Tickets","business_line":"eTicketing","filter_event_type":"Away Box Office"}]
// Get saved email from localStorage
    const EMAIL_KEY = "user_email";
    const userEmail = localStorage.getItem(EMAIL_KEY) || "Unknown Email";

    // Extract information from dataLayer - look for the last basket_viewed event
    let basketData = null;
    let products = [];
    let eventName = "Unknown Event";
    let eventDate = "Unknown Date/Time";
    let totalValue = 0;
    let currency = "GBP";
    let membershipType = "Unknown";
    let crn = "Unknown";
    
    if (dlJson && Array.isArray(dlJson)) {
        // First, try to find product_added_to_basket events (these contain price information)
        const productAddedEvents = dlJson.filter(item => item.event === 'product_added_to_basket');
        if (productAddedEvents.length > 0) {
            // Get the last product_added_to_basket event
            basketData = productAddedEvents[productAddedEvents.length - 1];
            products = basketData.products || [];
            
            // Calculate total value from products (sum of all prices)
            totalValue = products.reduce((sum, product) => {
                const price = parseFloat(product.price || 0);
                return sum + (price * (product.quantity || 1));
            }, 0);
            
            currency = products[0]?.currency || basketData.currency || "GBP";
            membershipType = basketData.membership_type || "Unknown";
            crn = basketData.crn || "Unknown";
            
            if (products.length > 0) {
                eventName = products[0].name || "Unknown Event";
                eventDate = products[0].kickoff_datetime || "Unknown Date/Time";
            }
            
            console.log('[CS] Found product_added_to_basket event with', products.length, 'products');
            console.log('[CS] Products with prices:', products.map(p => ({ 
                seat: `${p.seatBlock} Row ${p.seatRow} Seat ${p.seatSeat}`, 
                price: p.price, 
                currency: p.currency 
            })));
        } else {
            // Fall back to basket_viewed event if product_added_to_basket is not found
            const basketViewedEvents = dlJson.filter(item => item.event === 'basket_viewed');
            if (basketViewedEvents.length > 0) {
                basketData = basketViewedEvents[basketViewedEvents.length - 1]; // Get the last one
                products = basketData.products || [];
                totalValue = basketData.value || 0;
                currency = basketData.currency || "GBP";
                membershipType = basketData.membership_type || "Unknown";
                crn = basketData.crn || "Unknown";
                
                if (products.length > 0) {
                    eventName = products[0].name || "Unknown Event";
                    eventDate = products[0].kickoff_datetime || "Unknown Date/Time";
                }
                
                console.log('[CS] Found basket_viewed event with', products.length, 'products');
            }
        }
    }
    
    // Check if we need to fall back to basket HTML information
    // This happens when:
    // 1. Products array is empty, OR
    // 2. Products array length doesn't match the quantity (incomplete data)
    let expectedQuantity = 0;
    if (basketData) {
        // For product_added_to_basket events, calculate quantity from products
        if (basketData.event === 'product_added_to_basket' && products.length > 0) {
            expectedQuantity = products.reduce((sum, product) => sum + (product.quantity || 1), 0);
        } else {
            // For basket_viewed events, use the quantity from the event
            expectedQuantity = basketData.quantity || 0;
        }
    }
    const needsFallback = products.length === 0 || (expectedQuantity > 0 && products.length < expectedQuantity);
    
    // Only fetch basket HTML if dataLayer is incomplete
    if (needsFallback) {
        console.log(`[CS] DataLayer incomplete: products=${products.length}, quantity=${expectedQuantity}, fetching basket HTML`);
        
        const basketUrl = `https://www.eticketing.co.uk/${clubName}/Checkout/Basket`;
        try {
            const basketRes = await fetch(basketUrl, {
                method: 'GET',
                headers: {
                    "authority": "www.eticketing.co.uk",
                    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                    "accept-language": "en-US,en;q=0.9,ur;q=0.8",
                    "dnt": "1",
                    "referer": monitor.eventUrl,
                    "x-requested-with": "XMLHttpRequest"
                },
                credentials: "include"
            });
            
            if (basketRes.ok) {
                const basketHtml = await basketRes.text();
                console.log('[CS] basket HTML fetched successfully for fallback');
                
                // Parse basket HTML to get seat details
                const basketHtmlData = parseBasketHtml(basketHtml);
                console.log('[CS] parsed basket HTML data:', basketHtmlData);
                
                if (basketHtmlData.events && basketHtmlData.events.length > 0) {
                    products = basketHtmlData.events.map(event => ({
                        seatBlock: event.block,
                        seatRow: event.row,
                        seatSeat: event.seat,
                        seatArea: event.area,
                        category_2: event.priceClass,
                        price: event.price,
                        currency: "GBP",
                        name: "Unknown Event",
                        kickoff_datetime: "Unknown Date/Time",
                        category_3: event.block && event.block.toLowerCase().includes('club level') ? 'Club Level' : 'General',
                        business_line: "eTicketing",
                        filter_event_type: "Unknown"
                    }));
                    
                    console.log(`[CS] Using basket HTML data: ${products.length} seats found`);
                    
                    // Set event name and date from monitor if available
                    if (monitor.eventUrl) {
                        eventName = "Event from URL";
                        eventDate = "Unknown Date/Time";
                    }
                } else {
                    console.warn('[CS] No basket events found in HTML');
                }
            } else {
                console.warn('[CS] basket HTML fetch failed with status:', basketRes.status);
            }
        } catch (e) {
            console.warn('[CS] basket HTML fetch error:', e);
        }
    } else {
        console.log(`[CS] DataLayer complete: products=${products.length}, quantity=${expectedQuantity}, no need for basket HTML`);
    }

    // Build seat info with proper price formatting
    const seatInfo = products.map((p, idx) => {
        const isClubLevel = p.seatBlock && p.seatBlock.toLowerCase().includes('club level');
        const clubLevelIndicator = isClubLevel ? ' 🏆' : '';
        const price = p.price && p.price !== 'undefined' ? p.price : 'N/A';
        const currency = p.currency && p.currency !== 'undefined' ? p.currency : 'GBP';
        return `**[${idx + 1}]** ${p.seatBlock}${clubLevelIndicator} - Row ${p.seatRow} Seat ${p.seatSeat} (${price} ${currency})`;
    }).join("\n");

    const firstProduct = products[0] || {};

// Format current local date & time
    const now = new Date();
    const formattedNow = now.toLocaleString("en-GB", {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });

// Removed duplicate prevention filter - notifications will be sent every time


    // Detect pairs from products (either dataLayer or basket HTML)
    let pairInfoText = '';
    let basketDetailsText = '';
    
    if (products.length > 0) {
        // Group seats by block and row to find pairs
        const seatGroups = {};
        products.forEach(product => {
            const key = `${product.seatBlock}-${product.seatRow}`;
            if (!seatGroups[key]) {
                seatGroups[key] = [];
            }
            seatGroups[key].push({
                ...product,
                seatNumber: parseInt(product.seatSeat) || 0
            });
        });
        
        // Find pairs (adjacent seats in same block and row)
        const pairs = [];
        Object.values(seatGroups).forEach(group => {
            // Sort by seat number
            group.sort((a, b) => a.seatNumber - b.seatNumber);
            
            // Find adjacent seats
            for (let i = 0; i < group.length - 1; i++) {
                if (group[i + 1].seatNumber === group[i].seatNumber + 1) {
                    pairs.push({
                        seat1: group[i],
                        seat2: group[i + 1],
                        block: group[i].seatBlock,
                        row: group[i].seatRow
                    });
                    i++; // Skip next seat as it's already paired
                }
            }
        });
        
        const pairCount = pairs.length;
        console.log('[CS] Found', pairCount, 'pairs from products:', pairs);
        
        // Add pair information (always show, even if 0 pairs)
        const pairDetails = pairs.map((pair, idx) => {
            return `**[Pair ${idx + 1}]** ${pair.block} - Row ${pair.row} Seats: ${pair.seat1.seatSeat} & ${pair.seat2.seatSeat}`;
        }).join("\n");
        
        pairInfoText = `
        
**🎫 PAIRS:** ${pairCount}  
${pairCount > 0 ? pairDetails : 'No adjacent pairs found'}`;
        
        // No need to show basket details note
    }

    const message =
        `🎟 **TICKET SUCCESS - Added to Basket**  
═════════════════════════════════════════════════
📅 **Time:** ${new Date().toLocaleString('en-GB', { 
                hour: '2-digit', 
                minute: '2-digit', 
                second: '2-digit' 
            })}  
🏟️ **Game:** ${eventName}  
🆔 **Event ID:** ${monitor.eventId}  
🔗 **Event URL:** ${monitor.eventUrl}  
📍 **Area ID:** ${areaId}  
👤 **Account:** ${userEmail}  
📍 **Endpoint:** ${endpointType}  
            
🎫 **TICKETS:**  
${seatInfo}${pairInfoText}
            
🎯 **SUMMARY:**  
✅ **Total Seats:** ${expectedQuantity || products.length}  
💰 **Total Value:** ${totalValue} ${currency}  
            
═════════════════════════════════════════════════`;

    console.log('[CS] message to send:', message);

    // Always send success notification when tickets are added to basket
    console.log('[CS] Sending success webhook notification - tickets added to basket');
    console.log('[CS] Webhook message length:', message.length);
    console.log('[CS] Webhook payload:', dlJson);
    
    chrome.runtime.sendMessage({
        action: 'notifyWebhooks',
        message,
        payload: dlJson
    }, (response) => {
        if (chrome.runtime.lastError) {
            console.error('[CS] Webhook send error:', chrome.runtime.lastError);
        } else {
            console.log('[CS] Webhook send response:', response);
        }
    });

    // Open new tab after sending success notification
    console.log('[CS] Opening new tab with success URL');
    chrome.runtime.sendMessage({
        action: 'openNewTab',
        url: 'https://www.exampleTicketsbasketaddedinthisWindow.com'
    });

// Play 5s sound
// playNotifySound(5000);

// stop monitoring after successful booking to avoid multiple BOOKINGS
// stopMonitoring('successfully added to basket');
    } // End of else block (successful add to basket)
}

function stopMonitoring(reason) {//stop of monitoring will be received from content script signal
    console.log('[CS] stopMonitoring:', reason);
    monitor.running = false;
    if (monitor.intervalId) {
        clearInterval(monitor.intervalId);
        monitor.intervalId = null;
    }
}

function getRequestVerificationToken() {
    try {
        const input = document.querySelector('input[name="__RequestVerificationToken"]');
        if (input && input.value) return input.value;
        const meta = document.querySelector('meta[name="requestverificationtoken"]');
        if (meta && meta.content) return meta.content;
        // try cookie parse
        const match = document.cookie.match(/__RequestVerificationToken=([^;]+)/);
        if (match) return decodeURIComponent(match[1]);
    } catch (e) {
        console.warn('[CS] token parse err', e);
    }
    return null;
}

function playNotifySound(ms = 5000) {
    try {
        const src = chrome.runtime.getURL('sounds/notify.mp3');
        const audio = document.createElement('audio');
        audio.src = src;
        audio.autoplay = true;
        audio.volume = 1;
        audio.play().catch(e => console.warn('[CS] audio play failed', e));
        setTimeout(() => {
            audio.pause();
            try {
                audio.remove();
            } catch (e) {
            }
        }, ms);
        console.log('[CS] playing notify sound for', ms, 'ms');
    } catch (e) {
        console.warn('[CS] play sound error', e);
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to wait for event tab reload completion
async function waitForEventTabReload(timeoutMs = 140000) {
    console.log('[CS] Waiting for event tab reload completion...');
    
    const startTime = Date.now();
    const checkInterval = 1000; // Check every 1 second
    
    while (Date.now() - startTime < timeoutMs) {
        const { eventTabReloaded } = await chrome.storage.local.get('eventTabReloaded');
        
        if (eventTabReloaded === true) {
            console.log('[CS] Event tab reload completed successfully');
            // Reset the flag for next time
            await chrome.storage.local.set({ eventTabReloaded: false });
            return true;
        }
        
        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    console.warn('[CS] Event tab reload timeout after', timeoutMs / 1000, 'seconds');
    return false;
}

// Helper function to refresh event tab with reload tracking. Returns true if refresh was sent/done, false if skipped (e.g. error403 pause).
async function refreshEventTabWithTracking() {
    const { error403PauseUntil = 0 } = await chrome.storage.local.get('error403PauseUntil');
    if (error403PauseUntil > 0 && Date.now() < error403PauseUntil) {
        console.log('[CS] error403 pause active - not sending refresh event tab.');
        return false;
    }
    console.log('[CS] Setting event tab reload flag to false');
    await chrome.storage.local.set({ eventTabReloaded: false });
    
    console.log('[CS] Sending refresh event tab message');
    chrome.runtime.sendMessage({action: 'refreshEventTab'}, response => {
        if (chrome.runtime.lastError) {
            console.error('[CS] refreshEventTab error:', chrome.runtime.lastError);
        } else {
            console.log('[CS] refreshEventTab response:', response);
        }
    });
    
    // Wait for reload completion instead of fixed time
    await waitForEventTabReload();
    return true;
}
