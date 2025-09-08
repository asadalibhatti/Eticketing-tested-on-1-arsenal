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
    }, 10000);
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
notfound400erorsCount = 0;

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

let consecutiveErrorCount = 0;  // track consecutive CORS or queue-it errors

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
    
    // Send notification if at least 1 pair is found
    const shouldSend = pairCount > 0;
    console.log('[CS] Should send notification:', shouldSend, '(at least 1 pair required)');
    
    return { shouldSend, pairs, pairCount };
}

async function checkOnce() {
    chrome.runtime.sendMessage({type: "heartbeat"});

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

    // Randomly select between regular and resale endpoints
    const isResale = Math.random() < 0.5;
    const endpointType = isResale ? 'Resale' : 'Regular';
    const marketTypeParam = isResale ? '&MarketType=1' : '';
    
    console.log(`[CS] Randomly selected __${endpointType} endpoint for this check`);
    
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

        // Reset consecutive error count on success
        consecutiveErrorCount = 0;

        // Detect if redirected to queue-it.net
        if (res.url.includes('queue-it.net')) {
            console.warn('[CS] Redirected to queue-it.net');

            consecutiveErrorCount++;
            if (consecutiveErrorCount >= 5) {
                console.warn('[CS] 5 consecutive queue-it redirects, refreshing...');

                chrome.runtime.sendMessage({action: 'closeOtherTabsExcept'});
                chrome.runtime.sendMessage({action: 'refreshEventTab'}, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error('Message failed:', chrome.runtime.lastError);
                        return;
                    }
                    console.log('Response received after refresh:', response);
                });

                await delay(50000);
                consecutiveErrorCount = 0; // reset after refresh
                return;
            }
        } else {
            // If not queue-it redirect, reset count
            consecutiveErrorCount = 0;
        }
    } catch (e) {
        console.error('[CS] fetch seats error', e);

        // Detect CORS / Failed to fetch case
        if (e instanceof TypeError && e.message.includes('Failed to fetch')) {
            console.warn('[CS] CORS or network error detected');

            consecutiveErrorCount++;
            if (consecutiveErrorCount >= 2) {
                console.warn('[CS] 2 consecutive CORS/network errors, refreshing...');

                chrome.runtime.sendMessage({action: 'closeOtherTabsExcept'});

                chrome.runtime.sendMessage({action: 'refreshEventTab'}, response => {
                    if (chrome.runtime.lastError) {
                        console.error('[CS] refreshEventTab error:', chrome.runtime.lastError);
                    } else {
                        console.log('[CS] refreshEventTab response:', response);
                    }
                });

                await delay(40000);
                consecutiveErrorCount = 0; // reset after refresh
                return;
            }
        } else {
            // reset on other errors
            consecutiveErrorCount = 0;
        }

        notfound400erorsCount++;
        return;
    }

    console.log('[CS] seats response status', res.status);
    const errorStatuses = [400, 401, 402, 403, 302, 500];

    if (errorStatuses.includes(res.status)) {
        console.warn('[CS] received error status from check seats availability API:', res.status);
        notfound400erorsCount++;

        // If reached 5 errors -> refresh
        if (notfound400erorsCount === 6) {
            console.warn('[CS] 6 consecutive errors — refreshing tab.');
            chrome.runtime.sendMessage({action: 'refreshEventTab'}, response => {
                if (chrome.runtime.lastError) {
                    console.error('[CS] refreshEventTab error:', chrome.runtime.lastError);
                } else {
                    console.log('[CS] refreshEventTab response:', response);
                }
            });
            //delay 50 seconds
            await delay(50000);
        }

        // If reached 9 errors -> clear cookies + refresh
        if (notfound400erorsCount >= 11) {
            // Clear all cookies
            console.warn('[CS] 11 or more consecutive errors — requesting cookie clear & refresh.');

            chrome.runtime.sendMessage({action: "clearCookiesAndRefresh"});
            //delay 2 seconds
            await delay(2000);


            // Refresh again
            chrome.runtime.sendMessage({action: 'refreshEventTab'}, response => {
                if (chrome.runtime.lastError) {
                    console.error('[CS] refreshEventTab error:', chrome.runtime.lastError);
                } else {
                    console.log('[CS] refreshEventTab response:', response);
                }
            });
            //wait for 70 seconds before next check
            await delay(70000);
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

// ✅ Reset error counter ONLY on valid JSON data
    notfound400erorsCount = 0;

    if (!Array.isArray(data) || data.length === 0) {
        //after waitMs
        console.log('[CS] no seats available (empty array). will retry after 13 seconds\n\n');

        return;

    }


    console.log('[CS] tickets available seats found:', data);
    // pick first area and first price band
    const area = data.find(a => a.PriceBands && a.PriceBands.length) || data[0];
    const priceBand = area.PriceBands[0];
    const areaId = area.AreaId;
    const priceBandId = priceBand.PriceBandCode || priceBand.PriceBandId || priceBandId;
    console.log('[CS] selected areaId', areaId, 'priceBandId', priceBandId);


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
        const errorMessage = `Error locking seats: ${e.message} for received data ${JSON.stringify(data)}`;
        
        
        // Also send to background for general webhook dispatch
        chrome.runtime.sendMessage({
            action: 'notifyWebhooks',
            message: errorMessage,
            payload: null
        });
        
        return;
    }

    console.log('[CS] lock response status', lockRes.status);
    // send message to webhook
    if (lockRes.status !== 200) {
        const errorMessage = `Error locking seats: ${lockRes.status} for received data ${JSON.stringify(data)}`;
        console.warn('[CS] sending error notification:', errorMessage);
        
       
        
        // Also send to background for general webhook dispatch
        chrome.runtime.sendMessage({
            action: 'notifyWebhooks',
            message: errorMessage,
            payload: null
        });
    }


    if (lockRes.status === 403) {
        console.warn('[CS] lock got 403 Forbidden, trying to add directly to basket with 2nd api');

        // try direct add to basket with 2nd api
        if (!(await tryDirectAddToBasketSecondapi(data, clubName, monitor.eventId, verificationToken, endpointType))) {
            console.warn('[CS] direct add to basket failed for all areas, stopping monitoring');
            
            // Send webhook message about the failure
            const errorMessage = `Direct add to basket failed for all areas. Event ${monitor.eventId}. Seats were found but could not be added to basket.`;
            chrome.runtime.sendMessage({
                action: 'notifyWebhooks',
                message: errorMessage,
                payload: null
            });
            
            // stop monitoring if no seats available
            return;
        }
        console.log('[CS] direct add to basket successful, going to next lines to send notifications');
        // return;
    } else if (lockRes.status === 400 || lockRes.status === 404) {
        console.warn('[CS] lock got 400 Bad Request, likely issue with verification token or no seats available');
        // stop monitoring if no seats available
        //send message to webhook
        let message1 = `Seat with areaId ${areaId} and priceBandId ${priceBandId} found but not able to Lock them for Event ${monitor.eventId}. Status: ${lockRes.status}`;
        //send message
        console.log('[CS] message to send:', message1);

        // Send to background for webhook dispatch
        chrome.runtime.sendMessage({
            action: 'notifyWebhooks',
            message: message1,
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

        const lockedSeat = lockJson?.LockedSeats?.[0];
        if (!lockedSeat) {
            console.warn('[CS] no LockedSeats in response', lockJson);
            return;
        }
        console.log('[CS] LockedSeat', lockedSeat);

        // Adding to basket (PUT)
        const putBody = {
            EventId: monitor.eventId,
            Seats: [{Id: lockedSeat.Id, PriceClassId: 1}]
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

// Check basket for seat details before getting data layer
    const basketUrl = `https://www.eticketing.co.uk/${clubName}/Checkout/Basket`;
    console.log('[CS] fetching basket details', basketUrl);
    let basketRes;
    let basketHtml = '';
    let shouldSendNotification = true;
    
    try {
        basketRes = await fetch(basketUrl, {
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
            basketHtml = await basketRes.text();
            console.log('[CS] basket HTML fetched successfully');
            
            // Parse basket HTML to check seat details
            const basketData = parseBasketHtml(basketHtml);
            console.log('[CS] parsed basket data:', basketData);
            
            // Check if we should send notification based on seat details
            const notificationResult = shouldSendNotificationBasedOnSeats(basketData);
            shouldSendNotification = notificationResult.shouldSend;
            const pairInfo = notificationResult;
            console.log('[CS] should send notification:', shouldSendNotification);
        } else {
            console.warn('[CS] basket fetch failed with status:', basketRes.status);
        }
    } catch (e) {
        console.warn('[CS] basket fetch error:', e);
    }

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

    const products = dlJson?.[0]?.products || [];

    const seatInfo = products.map((p, idx) => {
        return `**[${idx + 1}]** ${p.seatBlock} - Row ${p.seatRow} Seat ${p.seatSeat}  
• Area: ${p.seatArea}  
• Category: ${p.category_2 || "N/A"}  
• Price: ${p.price} ${p.currency}`;
    }).join("\n\n");

    const firstProduct = products[0] || {};
    const eventName = firstProduct.name || "Unknown Event";
    const eventDate = firstProduct.kickoff_datetime || "Unknown Date/Time";

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

// Check if last message was sent recently
    const LAST_MESSAGE_TIME_KEY = "last_message_time";
    const lastMessageTime = parseInt(localStorage.getItem(LAST_MESSAGE_TIME_KEY), 10) || 0;
    const timeSinceLastMessage = now.getTime() - lastMessageTime;
    localStorage.setItem(LAST_MESSAGE_TIME_KEY, now.getTime());


    // Add pair information to the message
    let pairInfoText = '';
    if (typeof pairInfo !== 'undefined' && pairInfo.pairCount > 0) {
        const pairDetails = pairInfo.pairs.map((pair, idx) => {
            return `**[Pair ${idx + 1}]** ${pair.block} - Row ${pair.row}  
• Seats: ${pair.seat1.seat} & ${pair.seat2.seat}  
• Price: ${pair.seat1.price || 'N/A'}`;
        }).join("\n\n");
        
        pairInfoText = `
            
            **🎫 Pairs Found:** ${pairInfo.pairCount}  
            ${pairDetails}`;
    }

    const message =
        `\n\n🎟 **Ticket(s) Added to Basket**  
            ━━━━━━━━━━━━━━━━━━  
            📅 **Generated:** ${formattedNow}  
            
            **Event:** ${eventName} (ID: ${monitor.eventId})  
            **Date/Time:** ${eventDate}  
            **Event URL:** ${monitor.eventUrl}  
            
            👤 **Account Email:** ${userEmail}  
            
            **Seat Details:**  
            ${seatInfo}${pairInfoText}

            ━━━━━━━━━━━━━━━━━━  
            **Total Tickets:** ${products.length}  
            🏢 Business Line: ${firstProduct.business_line || "N/A"}  
            🎭 Event Type: ${firstProduct.filter_event_type || "N/A"}`;

    console.log('[CS] message to send:', message);

    // Send to background for webhook dispatch only if notification should be sent
    if (shouldSendNotification) {
        console.log('[CS] Sending webhook notification based on seat analysis (pairs found)');
        chrome.runtime.sendMessage({
            action: 'notifyWebhooks',
            message,
            payload: dlJson
        });
    } else {
        console.log('[CS] Skipping webhook notification based on seat analysis (no pairs found)');
    }

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
