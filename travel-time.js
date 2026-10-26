'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const readline = require('readline');
const https = require('https');
const { google } = require('googleapis');

// ─── Config ──────────────────────────────────────────────────────────────────

const HOME_ADDRESS      = process.env.HOME_ADDRESS;
const MAPS_API_KEY      = process.env.GOOGLE_MAPS_API_KEY;
const CREDENTIALS_PATH  = path.join(__dirname, 'credentials.json');
const TOKEN_PATH        = path.join(__dirname, 'token.json');
const SCOPES            = ['https://www.googleapis.com/auth/calendar'];
const TRAVEL_TAG        = '[travel-auto]';
const OVERNIGHT_TAG     = '[overnight]';
const SLEEP_EVENT_NAME  = (process.env.SLEEP_EVENT_NAME ?? '').toLowerCase();
const LOOKAHEAD_DAYS    = 7;
const MAX_ORIGIN_GAP_MS = 12 * 60 * 60 * 1000;
const MODE_ICONS        = { transit: '🚇', walking: '🚶', driving: '🚗' };

// Geocoding bias box "south,west|north,east". Unset → London; set to empty → no bias.
const DEFAULT_MAP_BOUNDS = '51.28,-0.51|51.69,0.30';
const MAP_BOUNDS         = (process.env.MAP_BOUNDS ?? DEFAULT_MAP_BOUNDS).trim();
const BOUNDS_FORMAT      = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?\|-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;

if (!HOME_ADDRESS) {
  console.error('✗  Missing HOME_ADDRESS in .env');
  process.exit(1);
}
if (!MAPS_API_KEY) {
  console.error('✗  Missing GOOGLE_MAPS_API_KEY in .env');
  process.exit(1);
}
if (MAP_BOUNDS && !BOUNDS_FORMAT.test(MAP_BOUNDS)) {
  console.error('✗  MAP_BOUNDS must look like "51.28,-0.51|51.69,0.30" (south,west|north,east)');
  process.exit(1);
}

// ─── OAuth2 ──────────────────────────────────────────────────────────────────

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('✗  credentials.json not found. Download it from Google Cloud Console (OAuth 2.0 Desktop app).');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_id, client_secret, redirect_uris } = raw.installed || raw.web;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

async function authorize(auth) {
  if (fs.existsSync(TOKEN_PATH)) {
    auth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
    return;
  }

  const authUrl = auth.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('\nFirst-run: open this URL in your browser and authorize access:\n');
  console.log(authUrl);
  console.log();

  const code = await prompt('Paste the authorization code here: ');
  const { tokens } = await auth.getToken(code.trim());
  auth.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('✓  token.json saved — you won\'t need to do this again.\n');
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

// ─── Maps helpers ─────────────────────────────────────────────────────────────

function mapsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function geocodeLocation(address) {
  const params = new URLSearchParams({ address, key: MAPS_API_KEY });
  if (MAP_BOUNDS) params.set('bounds', MAP_BOUNDS); // biases (not restricts) results
  return mapsGet(`https://maps.googleapis.com/maps/api/geocode/json?${params}`)
    .then(data => {
      if (data.status !== 'OK' || !data.results?.length) return null;
      const r = data.results[0];
      return { address: r.formatted_address, placeId: r.place_id };
    })
    .catch(() => null);
}

function getTravelMinutes(origin, destination, mode, arrivalUnix) {
  const params = { origins: origin, destinations: destination, mode, key: MAPS_API_KEY };
  if (mode === 'transit' && arrivalUnix) params.arrival_time = String(arrivalUnix);

  return mapsGet(`https://maps.googleapis.com/maps/api/distancematrix/json?${new URLSearchParams(params)}`)
    .then(data => {
      if (data.status !== 'OK') throw new Error(`Maps API status: ${data.status}`);
      const element = data.rows?.[0]?.elements?.[0];
      if (!element || element.status !== 'OK') {
        throw new Error(`Element status: ${element?.status ?? 'missing'}`);
      }
      const seconds = element.duration_in_traffic?.value ?? element.duration?.value;
      return Math.ceil(seconds / 60);
    });
}

const AIRPORT_BUFFER_MS = 2 * 60 * 60 * 1000; // 2 hours for check-in + security

function isAirportDestination(eventSummary, resolvedAddress) {
  const s = (eventSummary ?? '').toLowerCase();
  const a = (resolvedAddress ?? '').toLowerCase();
  return s.includes('flight') || s.includes('airport') || a.includes('airport');
}

async function getBestTravel(origin, destination, arrivalUnix) {
  const [transitRes, walkingRes] = await Promise.allSettled([
    getTravelMinutes(origin, destination, 'transit', arrivalUnix),
    getTravelMinutes(origin, destination, 'walking', null),
  ]);

  const transit = transitRes.status === 'fulfilled' ? transitRes.value : Infinity;
  const walking = walkingRes.status === 'fulfilled' ? walkingRes.value : Infinity;

  if (transit === Infinity && walking === Infinity) {
    const drivingMinutes = await getTravelMinutes(origin, destination, 'driving', arrivalUnix);
    return { minutes: drivingMinutes, mode: 'driving' };
  }

  if (walking <= transit) return { minutes: walking, mode: 'walking' };
  return { minutes: transit, mode: 'transit' };
}

// ─── Calendar helpers ─────────────────────────────────────────────────────────

function isTimed(event) {
  return Boolean(event.start?.dateTime);
}

function isTravelBlock(event) {
  return (event.description ?? '').includes(TRAVEL_TAG);
}

function endMs(event) {
  return new Date(event.end.dateTime).getTime();
}

function startMs(event) {
  return new Date(event.start.dateTime).getTime();
}

function parseTravelBlockAddresses(description) {
  const match = (description ?? '').match(/From: (.+?) \| To: (.+?) \| ~/);
  return match ? { origin: match[1], destination: match[2] } : null;
}

// Extract IATA-based arrival query from a flight title, e.g. "... to Cork (ORK)" → "ORK airport"
function extractFlightArrivalQuery(summary) {
  if (!summary) return null;
  const m = summary.match(/(?:→|to)\s+[^(→\n]+?\s*\(([A-Z]{3}(?:-\w+)?)\)\s*$/i);
  if (!m) return null;
  return `${m[1].trim()} airport`;
}

// Map<event.start.dateTime → arrivalQuery> for events with a parseable flight destination
function buildFlightArrivalMap(allEvents) {
  const map = new Map();
  for (const e of allEvents) {
    if (!isTimed(e) || isTravelBlock(e)) continue;
    const q = extractFlightArrivalQuery(e.summary);
    if (q) map.set(e.start.dateTime, q);
  }
  return map;
}

// Map<"YYYY-MM-DD" → raw location> keyed on the date the 😴Sleep event ENDS
function buildSleepOverrideMap(allEvents) {
  const map = new Map();
  if (!SLEEP_EVENT_NAME) return map;
  for (const e of allEvents) {
    if (!isTimed(e) || !e.location?.trim()) continue;
    if ((e.summary ?? '').toLowerCase() !== SLEEP_EVENT_NAME) continue;
    map.set(e.end.dateTime.split('T')[0], e.location.trim());
  }
  return map;
}

// Map<"YYYY-MM-DD" → raw location> expanded across multi-day all-day events (hotels, trips, etc.)
function buildOvernightMap(allEvents) {
  const map = new Map();
  for (const e of allEvents) {
    if (isTimed(e) || !e.location?.trim()) continue;
    const startD   = new Date(e.start.date + 'T00:00:00');
    const endD     = new Date(e.end.date   + 'T00:00:00'); // end.date is exclusive in the Calendar API
    const spanDays = (endD - startD) / (24 * 60 * 60 * 1000);
    if (spanDays < 2) continue; // ignore single-day all-day events (birthdays with venues, etc.)
    let cur = new Date(startD);
    cur.setDate(cur.getDate() + 1); // skip check-in day (first morning waking up there is day+1)
    while (cur <= endD) {           // inclusive of checkout day (still at hotel that morning)
      const localDate = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
      map.set(localDate, e.location.trim());
      cur.setDate(cur.getDate() + 1);
    }
  }
  return map;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const auth = loadCredentials();
  await authorize(auth);

  const calendar = google.calendar({ version: 'v3', auth });

  const now          = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const future = new Date(startOfToday.getTime() + (LOOKAHEAD_DAYS + 1) * 24 * 60 * 60 * 1000);

  console.log(`\nFetching events ${startOfToday.toLocaleDateString()} → ${future.toLocaleDateString()}…`);

  const calListRes = await calendar.calendarList.list({ minAccessRole: 'reader' });
  const calendarIds = (calListRes.data.items ?? []).map(c => c.id);
  console.log(`  Found ${calendarIds.length} calendar(s).`);

  const eventPages = await Promise.all(
    calendarIds.map(calId =>
      calendar.events.list({
        calendarId: calId,
        timeMin: startOfToday.toISOString(),
        timeMax: future.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
      }).then(r => r.data.items ?? []).catch(() => [])
    )
  );

  const allEvents = eventPages
    .flat()
    .sort((a, b) => {
      const aT = a.start?.dateTime ?? a.start?.date ?? '';
      const bT = b.start?.dateTime ?? b.start?.date ?? '';
      return aT.localeCompare(bT);
    });

  console.log(`  Found ${allEvents.length} event(s) total.`);

  // Build overnight origin override maps
  const sleepOverrideMap  = buildSleepOverrideMap(allEvents);
  const overnightMap      = buildOvernightMap(allEvents);
  const flightArrivalMap  = buildFlightArrivalMap(allEvents);

  // Geocode all unique location strings upfront to resolve ambiguous names
  const rawLocations = new Set([
    HOME_ADDRESS,
    ...allEvents
      .filter(e => isTimed(e) && !isTravelBlock(e) && e.location?.trim())
      .map(e => e.location.trim()),
    ...[...sleepOverrideMap.values()],
    ...[...overnightMap.values()],
    ...[...flightArrivalMap.values()],
  ]);

  console.log(`  Geocoding ${rawLocations.size} location(s)…`);
  const locationCache = new Map();
  await Promise.all(
    [...rawLocations].map(async loc => {
      const cleaned = loc.replace(/\s*\(.*?\)\s*/g, '').trim(); // strip room suffixes e.g. "(LT12)"
      const result  = await geocodeLocation(cleaned);
      if (result) {
        console.log(`    "${loc}" → "${result.address}"`);
        locationCache.set(loc, { routing: `place_id:${result.placeId}`, label: result.address });
      } else {
        locationCache.set(loc, { routing: cleaned, label: cleaned });
      }
    })
  );
  console.log();

  // Travel block map: end time (UTC ms) → event. Numeric keys avoid timezone string mismatches.
  const travelBlockMap = new Map(
    allEvents
      .filter(e => isTimed(e) && isTravelBlock(e))
      .map(e => [new Date(e.end.dateTime).getTime(), e])
  );

  // All timed events with a location are candidates (travel blocks are excluded separately)
  const destinations = allEvents.filter(e =>
    isTimed(e) &&
    !isTravelBlock(e) &&
    e.location?.trim()
  );

  if (destinations.length === 0) {
    console.log('No qualifying events found (events lack a location).');
    return;
  }

  console.log(`Processing ${destinations.length} destination event(s):\n`);

  for (const dest of destinations) {
    const destStart   = new Date(dest.start.dateTime);
    const destLabel   = dest.summary ?? '(no title)';
    const rawDest      = dest.location.trim();
    const destResolved = locationCache.get(rawDest) ?? { routing: rawDest, label: rawDest };
    const destRouting  = destResolved.routing;
    const destAddress  = destResolved.label;

    // First event of the day always departs from home
    const destDateStr  = destStart.toLocaleDateString();
    const isFirstOfDay = !allEvents.some(e =>
      isTimed(e) &&
      !isTravelBlock(e) &&
      e.location?.trim() &&
      e.start.dateTime !== dest.start.dateTime &&
      new Date(e.start.dateTime).toLocaleDateString() === destDateStr &&
      startMs(e) < startMs(dest)
    );

    const preceding = isFirstOfDay ? null : (
      allEvents
        .filter(e =>
          isTimed(e) &&
          !isTravelBlock(e) &&
          e.location?.trim() &&
          e.start.dateTime !== dest.start.dateTime &&
          endMs(e) <= startMs(dest) &&
          startMs(dest) - endMs(e) <= MAX_ORIGIN_GAP_MS
        )
        .sort((a, b) => endMs(b) - endMs(a))[0] ?? null
    );

    const destISODate    = dest.start.dateTime.split('T')[0]; // YYYY-MM-DD
    const rawOrigin      = isFirstOfDay
      ? (sleepOverrideMap.get(destISODate) ?? overnightMap.get(destISODate) ?? HOME_ADDRESS)
      : (flightArrivalMap.get(preceding?.start.dateTime) ?? preceding?.location?.trim() ?? HOME_ADDRESS);
    const originResolved = locationCache.get(rawOrigin) ?? { routing: rawOrigin, label: rawOrigin };
    const originRouting  = originResolved.routing;
    const originAddress  = originResolved.label;
    const originLabel    = isFirstOfDay && rawOrigin !== HOME_ADDRESS
      ? 'Overnight'
      : rawOrigin === HOME_ADDRESS ? 'Home' : (preceding?.summary ?? originAddress);

    // Compute effective arrival (2-hr buffer for airports) before idempotency check
    const isAirport        = isAirportDestination(destLabel, destAddress);
    const effectiveArrival = isAirport
      ? new Date(destStart.getTime() - AIRPORT_BUFFER_MS)
      : destStart;

    // Check for an existing travel block — keyed by UTC ms to avoid timezone string mismatches
    const existingBlock = travelBlockMap.get(effectiveArrival.getTime())
                       ?? travelBlockMap.get(destStart.getTime())
                       ?? null;
    if (existingBlock) {
      const stored = parseTravelBlockAddresses(existingBlock.description);
      const blockEndsAtNewKey = new Date(existingBlock.end.dateTime).getTime() === effectiveArrival.getTime();
      if (blockEndsAtNewKey && stored && stored.origin === originAddress && stored.destination === destAddress) {
        console.log(`  ✓  "${destLabel}" — travel block up to date, skipping\n`);
        continue;
      }
      try {
        await calendar.events.delete({ calendarId: 'primary', eventId: existingBlock.id });
        console.log(`  🔄 "${destLabel}" — address changed, replacing travel block`);
      } catch (e) {
        console.error(`  ✗  Could not delete old travel block for "${destLabel}": ${e.message}\n`);
        continue;
      }
    }

    try {
      console.log(`  📍 "${destLabel}" at ${destStart.toLocaleTimeString()}`);
      console.log(`     Origin: ${originLabel}`);

      const arrivalUnix = Math.floor(effectiveArrival.getTime() / 1000);
      const { minutes: travelMinutes, mode } = await getBestTravel(originRouting, destRouting, arrivalUnix);

      if (travelMinutes === 0) {
        console.log(`     ⏭  Skipped — same location as origin\n`);
        continue;
      }

      const travelStart = new Date(effectiveArrival.getTime() - travelMinutes * 60 * 1000);
      const modeLabel   = mode === 'transit' ? 'by transit' : mode === 'walking' ? 'on foot' : 'by car';
      const modeIcon    = MODE_ICONS[mode];

      if (preceding && travelStart < new Date(preceding.end.dateTime)) {
        console.log(`     ⚠️  Travel block overlaps with "${preceding.summary ?? '(no title)'}"`);
      }

      await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: `${modeIcon} Travel time`,
          description: `Auto-generated. From: ${originAddress} | To: ${destAddress} | ~${travelMinutes} min ${modeLabel} ${TRAVEL_TAG}`,
          start: { dateTime: travelStart.toISOString(),      timeZone: dest.start.timeZone },
          end:   { dateTime: effectiveArrival.toISOString(), timeZone: dest.start.timeZone },
          colorId: '8',
        },
      });

      console.log(`     ✓  Created ${travelMinutes}-min block ${modeLabel} (leaves ${travelStart.toLocaleTimeString()})\n`);
    } catch (err) {
      console.error(`     ✗  Failed for "${destLabel}": ${err.message}\n`);
    }
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
