/**
 * Calendar Travel Time (Google Apps Script version)
 *
 * Adds a "Travel time" block before every calendar event that has a location,
 * using Google Maps for the route (transit or walking, whichever is shorter).
 *
 * Personal values (home address, Maps key, ...) live in Script Properties, never in this file.
 * Setup instructions: see README.md in this folder.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const TRAVEL_TAG         = '[travel-auto]';
const OVERNIGHT_TAG      = '[overnight]';
const LOOKAHEAD_DAYS     = 7;
const DAY_MS             = 24 * 60 * 60 * 1000;
const MAX_ORIGIN_GAP_MS  = 12 * 60 * 60 * 1000;
const AIRPORT_BUFFER_MS  = 2 * 60 * 60 * 1000; // check-in + security
const MODE_ICONS         = { transit: '🚇', walking: '🚶', driving: '🚗' };
const DEFAULT_MAP_BOUNDS = '51.28,-0.51|51.69,0.30'; // London
const BOUNDS_FORMAT      = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?\|-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;
const GEOCODE_URL        = 'https://maps.googleapis.com/maps/api/geocode/json?';
const DISTANCE_URL       = 'https://maps.googleapis.com/maps/api/distancematrix/json?';

let CFG = null; // filled in by loadConfig() at the start of every run

// ─── Entry points ────────────────────────────────────────────────────────────

/** Run this (manually or from the daily trigger). */
function main() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    log('Another run is already in progress, exiting.');
    return;
  }
  try {
    run();
  } finally {
    lock.releaseLock();
  }
}

/** Run once to create the daily trigger (replaces any existing one). */
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'main')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('main').timeBased().everyDays(1).atHour(7).create();
  log('Daily trigger installed: runs between 07:00 and 08:00 in the script time zone.');
}

/** Run to check your Script Properties without printing any values. */
function checkSetup() {
  const props = PropertiesService.getScriptProperties();
  ['HOME_ADDRESS', 'GOOGLE_MAPS_API_KEY', 'SLEEP_EVENT_NAME', 'MAP_BOUNDS', 'DRY_RUN'].forEach(k => {
    log(k + ': ' + (props.getProperty(k) === null ? 'not set' : 'set'));
  });
  log('Script time zone: ' + Session.getScriptTimeZone());
  CFG = loadConfig();
  log('Config OK.');
}

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  const props     = PropertiesService.getScriptProperties();
  const boundsRaw = props.getProperty('MAP_BOUNDS');
  let bounds      = (boundsRaw === null ? DEFAULT_MAP_BOUNDS : boundsRaw).trim();
  if (bounds.toLowerCase() === 'none') bounds = ''; // Script Properties cannot hold an empty value

  const cfg = {
    homeAddress:    (props.getProperty('HOME_ADDRESS') || '').trim(),
    mapsApiKey:     (props.getProperty('GOOGLE_MAPS_API_KEY') || '').trim(),
    sleepEventName: (props.getProperty('SLEEP_EVENT_NAME') || '').trim().toLowerCase(),
    mapBounds:      bounds,
    dryRun:         (props.getProperty('DRY_RUN') || '').trim().toLowerCase() === 'true',
    tz:             Session.getScriptTimeZone(),
  };
  if (!cfg.homeAddress) throw new Error('Missing HOME_ADDRESS in Script Properties');
  if (!cfg.mapsApiKey)  throw new Error('Missing GOOGLE_MAPS_API_KEY in Script Properties');
  if (cfg.mapBounds && !BOUNDS_FORMAT.test(cfg.mapBounds)) {
    throw new Error('MAP_BOUNDS must look like "51.28,-0.51|51.69,0.30" (south,west|north,east), or "none"');
  }
  return cfg;
}

function log(message) {
  console.log(message);
}

// ─── Which day does an event belong to? ──────────────────────────────────────

// Used to decide the "first event of the day" (which departs from home or from an overnight place)
// and to look up sleep-event and hotel overrides by date.
// Judged in the event's own time zone when the API provides one, otherwise the script time zone.
function dayKey(dateTime, timeZone) {
  return Utilities.formatDate(new Date(dateTime), timeZone || CFG.tz, 'yyyy-MM-dd');
}

// ─── Maps helpers ────────────────────────────────────────────────────────────

function buildQuery(params) {
  return Object.keys(params)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');
}

function fetchJson(url) {
  try {
    return JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText());
  } catch (e) {
    return null;
  }
}

function geocodeUrl(address) {
  const params = { address: address, key: CFG.mapsApiKey };
  if (CFG.mapBounds) params.bounds = CFG.mapBounds; // biases (does not restrict) results
  return GEOCODE_URL + buildQuery(params);
}

// Geocode every distinct location up front so ambiguous names resolve consistently.
// Returns Map<raw location → { routing, label }>.
function geocodeAll(rawLocations) {
  const cleaned   = rawLocations.map(loc => loc.replace(/\s*\(.*?\)\s*/g, '').trim()); // strip "(LT12)" etc.
  const responses = UrlFetchApp.fetchAll(
    cleaned.map(c => ({ url: geocodeUrl(c), muteHttpExceptions: true }))
  );
  const cache = new Map();
  rawLocations.forEach((loc, i) => {
    let result = null;
    try {
      const data = JSON.parse(responses[i].getContentText());
      if (data.status === 'OK' && data.results && data.results.length) {
        result = { address: data.results[0].formatted_address, placeId: data.results[0].place_id };
      }
    } catch (e) { /* fall through to the plain-text fallback */ }

    if (result) {
      log('    "' + loc + '" → "' + result.address + '"');
      cache.set(loc, { routing: 'place_id:' + result.placeId, label: result.address });
    } else {
      cache.set(loc, { routing: cleaned[i], label: cleaned[i] });
    }
  });
  return cache;
}

function getTravelMinutes(origin, destination, mode, arrivalUnix) {
  const params = { origins: origin, destinations: destination, mode: mode, key: CFG.mapsApiKey };
  if (mode === 'transit' && arrivalUnix) params.arrival_time = String(arrivalUnix);

  const data = fetchJson(DISTANCE_URL + buildQuery(params));
  if (!data) throw new Error('Maps request failed');
  if (data.status !== 'OK') throw new Error('Maps API status: ' + data.status);

  const element = data.rows && data.rows[0] && data.rows[0].elements && data.rows[0].elements[0];
  if (!element || element.status !== 'OK') {
    throw new Error('Element status: ' + (element ? element.status : 'missing'));
  }
  const seconds = (element.duration_in_traffic && element.duration_in_traffic.value)
               || (element.duration && element.duration.value);
  return Math.ceil(seconds / 60);
}

function tryTravelMinutes(origin, destination, mode, arrivalUnix) {
  try {
    return getTravelMinutes(origin, destination, mode, arrivalUnix);
  } catch (e) {
    return Infinity;
  }
}

function getBestTravel(origin, destination, arrivalUnix) {
  const transit = tryTravelMinutes(origin, destination, 'transit', arrivalUnix);
  const walking = tryTravelMinutes(origin, destination, 'walking', null);

  if (transit === Infinity && walking === Infinity) {
    return { minutes: getTravelMinutes(origin, destination, 'driving', arrivalUnix), mode: 'driving' };
  }
  if (walking <= transit) return { minutes: walking, mode: 'walking' };
  return { minutes: transit, mode: 'transit' };
}

function isAirportDestination(eventSummary, resolvedAddress) {
  const s = (eventSummary || '').toLowerCase();
  const a = (resolvedAddress || '').toLowerCase();
  return s.indexOf('flight') !== -1 || s.indexOf('airport') !== -1 || a.indexOf('airport') !== -1;
}

// ─── Calendar helpers ────────────────────────────────────────────────────────

function isTimed(event)       { return Boolean(event.start && event.start.dateTime); }
function isTravelBlock(event) { return (event.description || '').indexOf(TRAVEL_TAG) !== -1; }
function hasLocation(event)   { return Boolean(event.location && event.location.trim()); }
function endMs(event)         { return new Date(event.end.dateTime).getTime(); }
function startMs(event)       { return new Date(event.start.dateTime).getTime(); }
function fmtTime(date)        { return Utilities.formatDate(date, CFG.tz, 'HH:mm'); }

function parseTravelBlockAddresses(description) {
  const match = (description || '').match(/From: (.+?) \| To: (.+?) \| ~/);
  return match ? { origin: match[1], destination: match[2] } : null;
}

// "... to Cork (ORK)" → "ORK airport"
function extractFlightArrivalQuery(summary) {
  if (!summary) return null;
  const m = summary.match(/(?:→|to)\s+[^(→\n]+?\s*\(([A-Z]{3}(?:-\w+)?)\)\s*$/i);
  return m ? m[1].trim() + ' airport' : null;
}

// Map<event.start.dateTime → arrival query> for events whose title names a flight destination
function buildFlightArrivalMap(allEvents) {
  const map = new Map();
  allEvents.forEach(e => {
    if (!isTimed(e) || isTravelBlock(e)) return;
    const q = extractFlightArrivalQuery(e.summary);
    if (q) map.set(e.start.dateTime, q);
  });
  return map;
}

// Map<day → raw location> keyed on the day the Sleep event ENDS
function buildSleepOverrideMap(allEvents) {
  const map = new Map();
  if (!CFG.sleepEventName) return map;
  allEvents.forEach(e => {
    if (!isTimed(e) || !hasLocation(e)) return;
    if ((e.summary || '').toLowerCase() !== CFG.sleepEventName) return;
    map.set(dayKey(e.end.dateTime, e.end.timeZone), e.location.trim());
  });
  return map;
}

// Map<day → raw location> across multi-day all-day events (hotels, trips). Pure UTC date arithmetic,
// so it does not depend on any time zone.
function buildOvernightMap(allEvents) {
  const map = new Map();
  allEvents.forEach(e => {
    if (isTimed(e) || !hasLocation(e)) return;
    const from = Date.parse(e.start.date + 'T00:00:00Z');
    const to   = Date.parse(e.end.date + 'T00:00:00Z'); // end.date is exclusive in the Calendar API
    if ((to - from) / DAY_MS < 2) return;               // ignore single-day all-day events
    // skip the check-in day; include the checkout day (still at the hotel that morning)
    for (let cur = from + DAY_MS; cur <= to; cur += DAY_MS) {
      map.set(new Date(cur).toISOString().slice(0, 10), e.location.trim());
    }
  });
  return map;
}

function fetchAllEvents(timeMin, timeMax) {
  const calendars = Calendar.CalendarList.list({ minAccessRole: 'reader' }).items || [];
  log('  Found ' + calendars.length + ' calendar(s).');

  const all = [];
  calendars.forEach(cal => {
    try {
      const res = Calendar.Events.list(cal.id, {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
      });
      (res.items || []).forEach(e => all.push(e));
    } catch (e) { /* skip calendars we cannot read */ }
  });

  return all.sort((a, b) => {
    const aT = (a.start && (a.start.dateTime || a.start.date)) || '';
    const bT = (b.start && (b.start.dateTime || b.start.date)) || '';
    return aT.localeCompare(bT);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

function run() {
  CFG = loadConfig();
  const tz = CFG.tz;

  const todayKey     = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const startOfToday = Utilities.parseDate(todayKey, tz, 'yyyy-MM-dd');
  const future       = new Date(startOfToday.getTime() + (LOOKAHEAD_DAYS + 1) * DAY_MS);

  log((CFG.dryRun ? '[DRY RUN] ' : '') + 'Fetching events ' + todayKey + ' → ' +
      Utilities.formatDate(future, tz, 'yyyy-MM-dd') + '…');

  const allEvents = fetchAllEvents(startOfToday, future);
  log('  Found ' + allEvents.length + ' event(s) total.');

  const sleepOverrideMap = buildSleepOverrideMap(allEvents);
  const overnightMap     = buildOvernightMap(allEvents);
  const flightArrivalMap = buildFlightArrivalMap(allEvents);

  const rawLocations = new Set([CFG.homeAddress]);
  allEvents
    .filter(e => isTimed(e) && !isTravelBlock(e) && hasLocation(e))
    .forEach(e => rawLocations.add(e.location.trim()));
  sleepOverrideMap.forEach(v => rawLocations.add(v));
  overnightMap.forEach(v => rawLocations.add(v));
  flightArrivalMap.forEach(v => rawLocations.add(v));

  log('  Geocoding ' + rawLocations.size + ' location(s)…');
  const locationCache = geocodeAll(Array.from(rawLocations));

  // Existing travel blocks keyed by end time (UTC ms), for idempotency and update detection
  const travelBlockMap = new Map();
  allEvents
    .filter(e => isTimed(e) && isTravelBlock(e))
    .forEach(e => travelBlockMap.set(new Date(e.end.dateTime).getTime(), e));

  const destinations = allEvents.filter(e => isTimed(e) && !isTravelBlock(e) && hasLocation(e));
  if (destinations.length === 0) {
    log('No qualifying events found (events lack a location).');
    return;
  }
  log('Processing ' + destinations.length + ' destination event(s):');

  for (const dest of destinations) {
    const destStart    = new Date(dest.start.dateTime);
    const destLabel    = dest.summary || '(no title)';
    const rawDest      = dest.location.trim();
    const destResolved = locationCache.get(rawDest) || { routing: rawDest, label: rawDest };
    const destRouting  = destResolved.routing;
    const destAddress  = destResolved.label;
    const destDay      = dayKey(dest.start.dateTime, dest.start.timeZone);

    // The first event of the day (that has a location) departs from home or an overnight place
    const isFirstOfDay = !allEvents.some(e =>
      isTimed(e) && !isTravelBlock(e) && hasLocation(e) &&
      e.start.dateTime !== dest.start.dateTime &&
      dayKey(e.start.dateTime, e.start.timeZone) === destDay &&
      startMs(e) < startMs(dest)
    );

    const preceding = isFirstOfDay ? null : (
      allEvents
        .filter(e =>
          isTimed(e) && !isTravelBlock(e) && hasLocation(e) &&
          e.start.dateTime !== dest.start.dateTime &&
          endMs(e) <= startMs(dest) &&
          startMs(dest) - endMs(e) <= MAX_ORIGIN_GAP_MS
        )
        .sort((a, b) => endMs(b) - endMs(a))[0] || null
    );

    const rawOrigin = isFirstOfDay
      ? (sleepOverrideMap.get(destDay) || overnightMap.get(destDay) || CFG.homeAddress)
      : ((preceding && flightArrivalMap.get(preceding.start.dateTime)) ||
         (preceding && hasLocation(preceding) && preceding.location.trim()) ||
         CFG.homeAddress);

    const originResolved = locationCache.get(rawOrigin) || { routing: rawOrigin, label: rawOrigin };
    const originRouting  = originResolved.routing;
    const originAddress  = originResolved.label;
    const originLabel    = isFirstOfDay && rawOrigin !== CFG.homeAddress
      ? 'Overnight'
      : rawOrigin === CFG.homeAddress ? 'Home' : ((preceding && preceding.summary) || originAddress);

    // Airports need a 2-hour buffer for check-in and security
    const isAirport        = isAirportDestination(destLabel, destAddress);
    const effectiveArrival = isAirport ? new Date(destStart.getTime() - AIRPORT_BUFFER_MS) : destStart;

    // Existing travel block? Keyed by UTC ms so time zone strings cannot cause mismatches.
    const existingBlock = travelBlockMap.get(effectiveArrival.getTime())
                       || travelBlockMap.get(destStart.getTime())
                       || null;
    if (existingBlock) {
      const stored            = parseTravelBlockAddresses(existingBlock.description);
      const blockEndsAtNewKey = new Date(existingBlock.end.dateTime).getTime() === effectiveArrival.getTime();
      if (blockEndsAtNewKey && stored && stored.origin === originAddress && stored.destination === destAddress) {
        log('  ✓  "' + destLabel + '" — travel block up to date, skipping');
        continue;
      }
      if (CFG.dryRun) {
        log('  🔄 [dry run] "' + destLabel + '" — would replace travel block');
      } else {
        try {
          Calendar.Events.remove('primary', existingBlock.id);
          log('  🔄 "' + destLabel + '" — address changed, replacing travel block');
        } catch (e) {
          log('  ✗  Could not delete old travel block for "' + destLabel + '": ' + e.message);
          continue;
        }
      }
    }

    try {
      log('  📍 "' + destLabel + '" at ' + fmtTime(destStart));
      log('     Origin: ' + originLabel);

      const arrivalUnix = Math.floor(effectiveArrival.getTime() / 1000);
      const best        = getBestTravel(originRouting, destRouting, arrivalUnix);
      const travelMinutes = best.minutes;
      const mode          = best.mode;

      if (travelMinutes === 0) {
        log('     ⏭  Skipped — same location as origin');
        continue;
      }

      const travelStart = new Date(effectiveArrival.getTime() - travelMinutes * 60 * 1000);
      const modeLabel   = mode === 'transit' ? 'by transit' : mode === 'walking' ? 'on foot' : 'by car';

      if (preceding && travelStart < new Date(preceding.end.dateTime)) {
        log('     ⚠️  Travel block overlaps with "' + (preceding.summary || '(no title)') + '"');
      }

      if (CFG.dryRun) {
        log('     [dry run] would create ' + travelMinutes + '-min block ' + modeLabel +
            ' (leaves ' + fmtTime(travelStart) + ')');
        continue;
      }

      Calendar.Events.insert({
        summary: MODE_ICONS[mode] + ' Travel time',
        description: 'Auto-generated. From: ' + originAddress + ' | To: ' + destAddress +
                     ' | ~' + travelMinutes + ' min ' + modeLabel + ' ' + TRAVEL_TAG,
        start: { dateTime: travelStart.toISOString(),      timeZone: dest.start.timeZone },
        end:   { dateTime: effectiveArrival.toISOString(), timeZone: dest.start.timeZone },
        colorId: '8',
      }, 'primary');

      log('     ✓  Created ' + travelMinutes + '-min block ' + modeLabel + ' (leaves ' + fmtTime(travelStart) + ')');
    } catch (err) {
      log('     ✗  Failed for "' + destLabel + '": ' + err.message);
    }
  }

  log('Done.');
}
