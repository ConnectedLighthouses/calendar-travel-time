# Calendar Travel Time: Google Apps Script version

Runs inside your Google account on a timer. There is nothing to install, no token files and no computer that has to be switched on.

## Setup

### 1. Maps API key
1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Geocoding API** and **Distance Matrix API**.
2. Create an API key (Credentials, then Create credentials, then API key).
3. Under **API restrictions** limit the key to those two APIs.

### 2. Create the script
1. Go to [script.google.com](https://script.google.com) and create a **New project**.
2. Replace the contents of `Code.gs` with the `Code.gs` from this folder.
3. Open **Project Settings**, tick **Show "appsscript.json" manifest file in editor**, then replace the manifest with `appsscript.json` from this folder. Change `timeZone` if you are not in London.

### 3. Script Properties (your private settings)
In **Project Settings, Script Properties**, add:

| Property | Value |
|---|---|
| `HOME_ADDRESS` | Your default departure address |
| `GOOGLE_MAPS_API_KEY` | The key from step 1 |
| `SLEEP_EVENT_NAME` | *(optional)* name of your daily sleep event, e.g. `😴Sleep`. A location on that event overrides home for the next morning. |
| `MAP_BOUNDS` | *(optional)* `south,west\|north,east` box that biases address lookups. Leave unset for the London default, or set `none` for no bias. |
| `DRY_RUN` | *(optional)* `true` to log what would happen without changing your calendar |

These stay in your Google account. They are not part of the code.

### 4. Authorise and test
1. Select `checkSetup` and press **Run**. Approve the permissions when asked (calendar access and external requests). It prints which properties are set, never their values.
2. Set `DRY_RUN` to `true`, run `main`, and read the **Execution log**. It lists the blocks it would create or replace.
3. Remove `DRY_RUN` (or set it to `false`) and run `main` again to create the blocks.

### 5. Run it daily
Run `installTrigger` once. It creates a trigger that runs `main` every day between 07:00 and 08:00. Under **Triggers** you can set failure notifications so Google emails you if a run crashes.

## Notes
- Travel blocks are tagged `[travel-auto]`, and the same description format as the Node version is used, so the two versions recognise each other's blocks.
- Events whose location Google Maps cannot route (virtual meetings, vague names) are logged as failures and skipped. That is expected.
- A run is limited to 6 minutes by Apps Script, which is plenty for a week of events.
- Don't publish your script project's ID or share the script with others. Anyone who can edit it can read your Script Properties.
