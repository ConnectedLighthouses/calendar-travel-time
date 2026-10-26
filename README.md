# Calendar Travel Time

Automatically adds travel time blocks to your Google Calendar. For each event with a location, it calculates how long it takes to get there (by public transit or walking, whichever is shorter) and creates a calendar block ending at the event start time. Runs silently on Windows login and/or on a daily schedule.

## What it does

- Scans your Google Calendar for the next 7 days
- For every timed event with a location, calculates travel time using Google Maps
- Creates a colour-coded travel block before each event
- Skips or updates blocks automatically if events change
- Chains events across the day (routes from your last event's location, not always from home)
- Detects flight events and adds a 2-hour airport buffer before departure
- Uses hotel/trip all-day events as your home base for those days
- Override your home address for a day by adding a location to your daily Sleep event

---

## Setup

### 1. Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- A Google account

### 2. Google Cloud — Maps API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Enable **Distance Matrix API** and **Geocoding API**
4. Go to **Credentials** → **Create Credentials** → **API Key**
5. Copy the key — you'll add it to `.env` in step 5

### 3. Google Cloud — OAuth 2.0 (Calendar access)

1. In the same project, go to **APIs & Services** → enable **Google Calendar API**
2. Go to **OAuth consent screen**:
   - User type: **External**
   - Fill in app name and your email
   - Add scope: `https://www.googleapis.com/auth/calendar`
   - Add your Google account as a test user
   - **Publish the app** (so your OAuth token doesn't expire every 7 days)
3. Go to **Credentials** → **Create Credentials** → **OAuth client ID**
   - Application type: **Desktop app**
   - Download the JSON file and rename it `credentials.json`
   - Place `credentials.json` in this folder

### 4. Install dependencies

Open a terminal in this folder and run:

```
npm install
```

### 5. Configure your settings

Copy `.env.example` to a new file named `.env`:

```
cp .env.example .env
```

Open `.env` and fill in your values:

```
HOME_ADDRESS=123 Your Street, Your City, Your Country
GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here
SLEEP_EVENT_NAME=😴Sleep
```

- **HOME_ADDRESS** — your default departure address (used for the first event of each day)
- **GOOGLE_MAPS_API_KEY** — the API key from step 2
- **SLEEP_EVENT_NAME** — the exact name of your daily sleep event, if you use one (leave as `😴Sleep` or change to match yours). If you add a location to this event on a given night, the script will route that day's first event from there instead of your home address.
- **MAP_BOUNDS** *(optional)* — a `south,west|north,east` box that biases address lookups toward your area, e.g. `51.28,-0.51|51.69,0.30`. If you leave it out, the London box above is used; set `MAP_BOUNDS=` (empty) to turn the bias off. It biases results, it does not restrict them.

### 6. First run & authorise

```
node travel-time.js
```

The first time you run it, a URL will appear in the terminal. Open it in your browser, sign in with your Google account, allow access, and paste the authorisation code back into the terminal. A `token.json` file is saved — you won't need to do this again.

### 7. Run on Windows login (optional)

To have this run silently every time you log in:

1. Open **PowerShell as Administrator**
2. Run the following (adjust the path to match where you saved the files):

```powershell
$action   = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"C:\path\to\this\folder\run-travel-time.vbs`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "TravelTimeCalendar" -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force

$task = Get-ScheduledTask -TaskName "TravelTimeCalendar"
$task.Settings.DisallowStartIfOnBatteries = $false
$task.Settings.StopIfGoingOnBatteries     = $false
Set-ScheduledTask -InputObject $task
```

Output is logged to `travel-time.log` in this folder.

**Also run it on a schedule.** A logon trigger only fires when you sign in, so a machine that mostly sleeps and wakes can go days without a run. Add a daily trigger as well:

```powershell
$task = Get-ScheduledTask -TaskName "TravelTimeCalendar"
$daily = New-ScheduledTaskTrigger -Daily -At 7:00AM
Set-ScheduledTask -TaskName "TravelTimeCalendar" -Trigger ($task.Triggers + $daily)
```

If `Set-ScheduledTask` complains that account names can't be mapped (for example after renaming the PC), rebuild both triggers instead of reusing the old one: `New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\$env:USERNAME"`.

**Mac / Linux.** Skip the `.bat`/`.vbs` files and use cron instead. For example, `crontab -e` and add a line like this to run at 7:00 every day:

```
0 7 * * * cd /path/to/calendar-travel-time && node travel-time.js >> travel-time.log 2>&1
```

---

## Overnight / travel overrides

| Situation | What to do |
|---|---|
| Staying at a friend's | Add their address to your Sleep event for that night |
| Hotel booking (multi-day all-day event) | Add the hotel address to the event's Location field — it will be used automatically for the days you're there |
| Changing your home address | Edit `HOME_ADDRESS` in `.env` |

---

## Notes

- Travel blocks are tagged `[travel-auto]` in their description so the script can find and update them
- Flight events are detected by title keywords (`flight`, airport IATA codes like `(LHR)`) — the script adds a 2-hour check-in buffer before the departure time
- Events where Google Maps returns no route (e.g. international transit across water) are logged as failures and skipped
- You can run `node travel-time.js` manually at any time — it will skip blocks that are already correct and only update ones whose address has changed
