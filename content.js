console.log('TICKET Checking content script loaded on', location.href);


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
                await chrome.storage.local.set({
                    areSeatsTogether: monitor.areSeatsTogether,
                    quantity: monitor.quantity,
                    loginEmail: row.LoginEmail || '',
                    loginPassword: row.LoginPassword || '',
                    ignoreClubLevel: row.IgnoreClubLevel || row.ignoreClubLevel || '',
                    ignoreUpperTier: row.IgnoreUpperTier || row.ignoreUpperTier || ''
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

function scheduleNextCheck() {
    const waitMs = 13000; // interval between checks (ms)
    const realignIntervalMs = 30000; // 1 minutes for realignment

    console.log(`\n===================================\n`);

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
        console.log(`[CS] First check aligned to startSecond=${base}, scheduled at ${nextRun.toLocaleTimeString()} (in ${(alignMs / 1000).toFixed(2)}s)`);

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
        // Normal increment by waitMs
        lastScheduledTime += waitMs;
    }

    let delay = lastScheduledTime - now;
    // if delay is less than 7 seconds , increment it with waitMs
    if (delay < 7000) {
        delay += waitMs;
    }

    const nextRun = new Date(lastScheduledTime);

    console.log(`[CS] Next check scheduled at ${nextRun.toLocaleTimeString()} (in ${(delay / 1000).toFixed(2)}s)`);


    chrome.runtime.sendMessage({type: "heartbeat"});
    setTimeout(runCheck, delay);
}

async function runCheck() {
    const runTime = new Date();
    // console.log(`[CS] Running checkOnce at ${runTime.toLocaleTimeString()}`);

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
        console.log('[CS] Available column names in Google Sheet:', headers);

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
                console.log('[CS] Found matching row data:', rowData);
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
let tunnelTimeoutErrorCount = 0; // For tunnel connection and timeout errors
let corsErrorCount = 0;          // For CORS errors
let notfound400erorsCount = 0;   // For other HTTP errors (400, 401, 402, 302, 500)

async function tryDirectAddToBasketSecondapi(data, clubname, eventId, verificationToken, endpointType = 'Regular') {
    console.log(`[INFO] Using ${endpointType} endpoint for direct add to basket`);
    let successCount = 0;       // Track successful adds
    let totalFetchCount = 0;    // Track total fetch attempts

    // Loop over areas in reverse order
    for (let a = data.length - 1; a >= 0; a--) {
        const area = data[a];

        for (const priceBand of area.PriceBands) {
            for (const interval of priceBand.AvailableSeatsIntervals) {

                // Loop through all seats from StartXCoord to EndXCoord
                for (let x = interval.StartXCoord; x <= interval.EndXCoord; x++) {

                    // Stop if we have already made 4 fetch requests
                    if (totalFetchCount >= 4) {
                        console.log(`[INFO] Reached ${totalFetchCount} total fetch attempts, stopping`);
                        return successCount > 0; // Return true if at least one success
                    }

                    const seatPayload = {
                        EventId: eventId,
                        Seats: [
                            {
                                AreaId: area.AreaId,
                                XCoordinate: x,
                                YCoordinate: interval.YCoord,
                                PriceClassId: 1,
                                IsSecondaryMarket: endpointType === 'Resale'
                            }
                        ]
                    };

                    console.log(`[INFO] Trying AreaId: ${area.AreaId}, Row: ${interval.YCoord}, Seat: ${x}`);

                    try {
                        totalFetchCount++; // Increment fetch counter
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
                            const text = await res.text();
                            console.log(`[400]`, text);

                        } else if (res.status === 200) {
                            const text = await res.text();
                            successCount++;
                            console.log(`[SUCCESS #${successCount}] AreaId ${area.AreaId}, Row ${interval.YCoord}, Seat ${x} => ${text}`);

                            if (successCount >= 3) { // Keep your original 3 success condition
                                console.log(`[INFO] Reached 10 successes, returning true`);
                                return true;
                            }

                        } else {
                            console.warn(`[FAIL] Status ${res.status}`);
                        }

                    } catch (err) {
                        console.error(`[ERROR] AreaId ${area.AreaId}, Row ${interval.YCoord}, Seat ${x}`, err);
                    }
                }
            }
        }
    }

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

async function checkOnce() {
    

    if (!monitor.running) return;

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
            await chrome.storage.local.set({
                areSeatsTogether: monitor.areSeatsTogether,
                quantity: monitor.quantity,
                loginEmail: matched_row.LoginEmail || '',
                loginPassword: matched_row.LoginPassword || '',
                ignoreClubLevel: matched_row.IgnoreClubLevel || matched_row.ignoreClubLevel || '',
                ignoreUpperTier: matched_row.IgnoreUpperTier || matched_row.ignoreUpperTier || ''
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
    console.log('[CS] checking if seats available ');
    // https://www.eticketing.co.uk/arsenal/EDP/Seats/AvailableResale? AreSeatsTogether=false&EventId=3631&MarketType=1&MaximumPrice=10000000&MinimumPrice=0&Quantity=1
    // https://www.eticketing.co.uk/arsenal/EDP/Seats/AvailableRegular?AreSeatsTogether=false&EventId=3631&             MaximumPrice=10000000&MinimumPrice=0&Quantity=1

    // Randomly select between regular and resale endpoints (96% Resale, 4% Regular)
    // For manual override, uncomment the line below and set to true/false as needed
    // const isResale = true;
    
    // Generate a more accurate 96% distribution using a counter-based approach
    const isResale = (() => {
        // Use a combination of timestamp and random for better distribution
        const now = Date.now();
        const randomSeed = Math.random();
        const combinedSeed = (now % 1000) + (randomSeed * 1000);
        return (combinedSeed % 100) < 96;//chances of resale
    })();
    const endpointType = isResale ? 'Resale' : 'Regular';
    const marketTypeParam = isResale ? '&MarketType=1' : '';
    
    console.log(`[CS] Randomly selected __${endpointType} endpoint for this check (96% Resale bias)`);
    
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

        // Detect if redirected to queue-it.net
        if (res.url.includes('queue-it.net')) {
            queueItErrorCount++;
            console.warn('[CS] Redirected to queue-it.net, count:', queueItErrorCount);

            if (queueItErrorCount >= 1) {
                console.warn('[CS] 1 consecutive queue-it redirects (count:', queueItErrorCount, '), refreshing...');

                chrome.runtime.sendMessage({action: 'closeOtherTabsExcept'});
                await refreshEventTabWithTracking();
                queueItErrorCount = 0; // reset after refresh
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
                await refreshEventTabWithTracking();
                tunnelTimeoutErrorCount = 0; // reset after refresh
            return;
            }
        } else {
            // reset on other errors
            queueItErrorCount = 0;
        }

        notfound400erorsCount++;
        return;
    }

    console.log('[CS] seats response status', res.status);
    
    // Only reset all error counters on successful 200 status
    if (res.status === 200) {
        error403Count = 0;
        tunnelTimeoutErrorCount = 0;
        corsErrorCount = 0;
        notfound400erorsCount = 0;
        queueItErrorCount = 0;
    }
    
    // Handle 403 errors separately
    if (res.status === 403) {
        error403Count++;
        console.warn('[CS] received 403 Forbidden error from check seats availability API, count:', error403Count);

        // If reached 6 consecutive 403 errors -> refresh
        if (error403Count >= 6) {
            console.warn('[CS] 6 consecutive 403 errors (count:', error403Count, ') — refreshing tab.');
            await refreshEventTabWithTracking();
            error403Count = 0; // reset after refresh
        }

        // If reached 11 consecutive 403 errors -> clear cookies + refresh
        if (error403Count >= 9) {
            console.warn('[CS] 9 consecutive 403 errors (count:', error403Count, ') — requesting cookie clear & refresh.');
            chrome.runtime.sendMessage({action: "clearCookiesAndRefresh"});
            await delay(2000);
            await refreshEventTabWithTracking();
            error403Count = 0; // reset error counter
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
            await refreshEventTabWithTracking();
            notfound400erorsCount = 0; // reset error counter
        }

        return;
    }

    let data;
    try {
        data = await res.json();
    } catch (e) {
        console.warn('[CS] seats response JSON parse failed', e);
        console.log('[CS] seats response text', await res.text());
        return;
    }

// ✅ All error counters already reset above on 200 status

    if (!Array.isArray(data) || data.length === 0) {
        //after waitMs
        console.log('[CS] no seats available (empty array). will retry after 13 seconds\n\n');

        return;

    }


    console.log('[CS] tickets available seats found:', data);
    console.log('[CS] Total areas found:', data.length);
    console.log('[CS] Area IDs found:', data.map(a => a.AreaId).join(', '));
    
    // Get ignore settings from local storage
    const { ignoreClubLevel, ignoreUpperTier } = await chrome.storage.local.get(['ignoreClubLevel', 'ignoreUpperTier']);
    console.log('[CS] Filter settings - ignoreClubLevel:', ignoreClubLevel, 'ignoreUpperTier:', ignoreUpperTier);
    
    // Filter out club level and upper tier areas (known area IDs for Arsenal Emirates Stadium)
    // upper tier range 1942-1988
    // lower tier range 1691-1941
    // Club level area IDs: 1647-1690
    const clubLevelAreaIds = [
        1647, 1648, 1649, 1650, 1651, 1652, 1653, 1654, 1655, 1656, 1657, 1658, 1659, 1660,
        1661, 1662, 1663, 1664, 1665, 1666, 1667, 1668, 1669, 1670, 1671, 1672, 1673, 1674, 1675, 1676, 1677, 1678, 1679, 1680,
        1681, 1682, 1683, 1684, 1685, 1686, 1687, 1688, 1689, 1690
    ];
    
    const upperTierAreaIds = [
        1942, 1943, 1944, 1945, 1946, 1947, 1948, 1949, 1950, 1951, 1952, 1953, 1954, 1955, 1956, 1957, 1958, 1959, 1960,
        1961, 1962, 1963, 1964, 1965, 1966, 1967, 1968, 1969, 1970, 1971, 1972, 1973, 1974, 1975, 1976, 1977, 1978, 1979, 1980,
        1981, 1982, 1983, 1984, 1985, 1986, 1987, 1988
    ];
    
    // Apply conditional filtering based on ignore settings
    // If ignoreClubLevel is "yes", filter out club level areas
    // If ignoreUpperTier is "yes", filter out upper tier areas
    const shouldIgnoreClubLevel = ignoreClubLevel && ignoreClubLevel.toLowerCase() === 'yes';
    const shouldIgnoreUpperTier = ignoreUpperTier && ignoreUpperTier.toLowerCase() === 'yes';
    
    console.log('[CS] Filter logic - shouldIgnoreClubLevel:', shouldIgnoreClubLevel, 'shouldIgnoreUpperTier:', shouldIgnoreUpperTier);
    
    // Filter areas based on ignore settings
    const preferredAreas = data.filter(a => {
        if (!a.PriceBands || !a.PriceBands.length) return false;
        
        // If should ignore club level and this is a club level area, exclude it
        if (shouldIgnoreClubLevel && clubLevelAreaIds.includes(a.AreaId)) {
            return false;
        }
        
        // If should ignore upper tier and this is an upper tier area, exclude it
        if (shouldIgnoreUpperTier && upperTierAreaIds.includes(a.AreaId)) {
            return false;
        }
        
        return true;
    });
    
    console.log('[CS] Preferred areas found after filtering:', preferredAreas.length);
    console.log('[CS] Preferred area IDs:', preferredAreas.map(a => a.AreaId).join(', '));
    
    // If no preferred areas found, check what areas are available and log the reason
    if (preferredAreas.length === 0) {
        const clubLevelAreas = data.filter(a => 
            a.PriceBands && 
            a.PriceBands.length && 
            clubLevelAreaIds.includes(a.AreaId)
        );
        
        const upperTierAreas = data.filter(a => 
            a.PriceBands && 
            a.PriceBands.length && 
            upperTierAreaIds.includes(a.AreaId)
        );
        
        if (clubLevelAreas.length > 0 || upperTierAreas.length > 0) {
            console.log('[CS] Filtered out areas based on ignore settings:');
            if (clubLevelAreas.length > 0 && shouldIgnoreClubLevel) {
                console.log('[CS] Club level areas filtered out (ignoreClubLevel=yes):', clubLevelAreas.map(a => a.AreaId).join(', '));
            }
            if (upperTierAreas.length > 0 && shouldIgnoreUpperTier) {
                console.log('[CS] Upper tier areas filtered out (ignoreUpperTier=yes):', upperTierAreas.map(a => a.AreaId).join(', '));
            }
            return;
        }
        
    }
    
    // If no preferred areas found, fall back to any available area
    const area = preferredAreas.length > 0 ? preferredAreas[preferredAreas.length - 1] : (data.find(a => a.PriceBands && a.PriceBands.length) || data[0]);
    const priceBand = area.PriceBands[0];
    const areaId = area.AreaId;
    const priceBandId = priceBand.PriceBandCode || priceBand.PriceBandId || priceBandId;
    
    const isClubLevel = clubLevelAreaIds.includes(areaId);
    const isUpperTier = upperTierAreaIds.includes(areaId);
    const areaType = isClubLevel ? 'CLUB LEVEL' : isUpperTier ? 'UPPER TIER' : 'LOWER TIER';
    console.log('[CS] selected areaId', areaId, 'priceBandId', priceBandId, `(${areaType})`);


    // Step 1: Get the token from localStorage
    let verificationToken = localStorage.getItem("verification_token");

    if (!verificationToken) {
        console.error('❌ Verification token not found in localStorage.');
        //use default token if not found
        console.log('Using default verification token: MOn7sdIDdiCrtszHY1RszN2HcxXfJZh4u5JWRkfGzwqplL9l_wSMkXYhJl3VRBglbAZvjJqeNQLamfQkFoO78OD1eLA1');
        verificationToken = 'MOn7sdIDdiCrtszHY1RszN2HcxXfJZh4u5JWRkfGzwqplL9l_wSMkXYhJl3VRBglbAZvjJqeNQLamfQkFoO78OD1eLA1';
    }
    // console.log('✅ Token from localStorage:', verificationToken);

    // 2a api Lock seats (POST)
    //               https://www.eticketing.co.uk/arsenal/EDP/BestAvailable/ResaleSeats
    const lockUrl = `https://www.eticketing.co.uk/${clubName}/EDP/BestAvailable/${endpointType}Seats`;
    console.log(`[CS] Using ${endpointType} endpoint for locking seats: ${lockUrl}`);
// Step 2: Prepare body
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
    console.log('[CS] locking seats with body', lockBody);

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
        console.error('[CS] lock fetch failed', e);
        //send message to webhook
        const errorMessage = `\n\nError locking seats: ${e.message} for received data ${JSON.stringify(data)}`;
        
        
        // Also send to background for error webhook dispatch
        chrome.runtime.sendMessage({
            action: 'notifyErrorWebhooks',
            message: errorMessage,
            payload: null
        });
        
        return;
    }

    console.log('[CS] lock response status', lockRes.status);
    
    // Handle different lock response statuses
    if (lockRes.status === 403) {
        console.warn('[CS] lock got 403 Forbidden, trying to add directly to basket with 2nd api');

        // try direct add to basket with 2nd api
        if (!(await tryDirectAddToBasketSecondapi(data, clubName, monitor.eventId, verificationToken, endpointType))) {
            console.warn('[CS] direct add to basket failed for all areas, stopping monitoring');
            
            // Send webhook message about the failure
            const errorMessage = `🎫 Direct add to basket failed for all areas. Event ${monitor.eventId}. Seats were found but could not be added to basket.`;
            chrome.runtime.sendMessage({
                action: 'notifyErrorWebhooks',
                message: errorMessage,
                payload: null
            });
            
            // stop monitoring if no seats available
            return;
        }
        console.log('[CS] direct add to basket successful, going to next lines to send notifications');
        // return;
    } else if (lockRes.status === 400 || lockRes.status === 404) {
        console.warn('[CS] lock got 400/404, likely issue with verification token or no seats available');
        
        //get response html text only not html and also send in discord message
        lockResponseHtmlText = await lockRes.text();
        //get only text
        lockResponseHtmlText = lockResponseHtmlText.replace(/<[^>]*>?/g, '');
        //remove all break lines or \n from text
        lockResponseHtmlText = lockResponseHtmlText.replace(/\n/g, '');
        console.log('[CS] lock response html text', lockResponseHtmlText);

        //send to background for error webhook dispatch
        
        // Send webhook message about the failure
        const errorMessage = `\n🎫 Seat with areaId ${areaId} priceBandId ${priceBandId} found but not locked Status: ${lockRes.status}`;
        chrome.runtime.sendMessage({
            action: 'notifyErrorWebhooks',
            message: errorMessage,
            payload: null
        });

        return;
    } else if (lockRes.status !== 200) {
        // Handle any other non-200 status codes
        const errorMessage = `🎫 Error locking seats: ${lockRes.status} for received data ${JSON.stringify(data)}`;
        console.warn('[CS] sending error notification:', errorMessage);
        
        chrome.runtime.sendMessage({
            action: 'notifyErrorWebhooks',
            message: errorMessage,
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
            console.warn('[CS] no LockedSeats in response', lockJson);
            return;
        }
        console.log('[CS] LockedSeats', lockedSeats);

        // Determine how many seats to add to basket
        let seatsToAdd = [];
        
        if (monitor.areSeatsTogether && monitor.quantity > 1) {
            // When seats together is true and quantity > 1, add all locked seats
            seatsToAdd = lockedSeats.map(seat => ({
                Id: seat.Id,
                PriceClassId: 1
            }));
            console.log('[CS] Adding all locked seats to basket (areSeatsTogether=true, quantity=' + monitor.quantity + ')');
        } else {
            // When seats together is false or quantity is 1, add only the first seat
            seatsToAdd = [{Id: lockedSeats[0].Id, PriceClassId: 1}];
            console.log('[CS] Adding only first locked seat to basket (areSeatsTogether=' + monitor.areSeatsTogether + ', quantity=' + monitor.quantity + ')');
        }

        // Adding to basket (PUT)
        const putBody = {
            EventId: monitor.eventId,
            Seats: seatsToAdd
        };


        console.log('[CS] adding to basket with body', putBody);
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
        console.log('[CS] add to basket status', putRes.status);
       


    }

// Basket HTML will be fetched only if needed after dataLayer processing

// Get data layer (products added to basket)
    const dlUrl = `https://www.eticketing.co.uk/arsenal/tagManager/GetDataLayer`;
    console.log('[CS] fetching data layer', dlUrl);
    let dlRes;
    try {

        dlRes = await fetch(dlUrl, {
            method: 'GET',
            headers: {
                "authority": "www.eticketing.co.uk",
                "path": "/arsenal/tagManager/GetDataLayer",
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
        // Find the last basket_viewed event which contains current basket items
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
        }
    }
    
    // Check if we need to fall back to basket HTML information
    // This happens when:
    // 1. Products array is empty, OR
    // 2. Products array length doesn't match the quantity (incomplete data)
    const expectedQuantity = basketData ? basketData.quantity || 0 : 0;
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
════════════════════════════════════════════════════════════════  
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
            
════════════════════════════════════════════════════════════════`;

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

// Helper function to refresh event tab with reload tracking
async function refreshEventTabWithTracking() {
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
    return await waitForEventTabReload();
}
