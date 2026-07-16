# saru2radio

A local, on-demand retro radio booth. `saru2radio` scans a local music folder, streams radio-ready MP3 files through a local Icecast source, exposes a compact listener page, and gives the DJ a browser-based studio for queue control, talk breaks, public tunnel control, and listener requests.

The app is designed for a small private/boutique broadcast: start it only when you want to go live, share the listener URL, take requests, and shut everything back down when done.

## Features

- Local DJ studio at `http://127.0.0.1:8011/`.
- Public listener facade at `http://127.0.0.1:8012/`.
- Local Icecast relay on `127.0.0.1:8010/live.mp3`.
- Direct song mode for stable server-side MP3 playout.
- Voice program submode for direct mic-only broadcasts with an optional generated ambient bed.
- DJ mixer mode for browser-side mixing/talk-over experiments.
- Direct-mode hold-to-talk breaks: song playout pauses while the mic break is sent, then resumes.
- Microphone input selection, meter, broadcast/shortwave/clean mic color modes, and local monitor.
- Queue control: ordered/shuffle, skip, and ad-hoc track switching.
- Listener-to-DJ request line with session-only DJ inbox.
- Optional Cloudflare tunnel control for sharing a public listener URL.
- Optional Cloudflare Worker front door that serves branded offline responses when the local tunnel is down.

## Architecture

```text
DJ browser studio
  controls queue, mic, tunnel, listener requests
        |
        v
Local Node/Express server
  studio API on 8011
  public listener facade on 8012
  direct MP3 playout and talk-break bridge
        |
        v
Local Icecast source on 8010/live.mp3
        |
        v
Listeners
  local facade, Cloudflare tunnel, or Cloudflare Worker front door
```

There are two broadcast paths:

- **Direct songs** is the default and recommended mode. Prepared/ready MP3 files are streamed server-side directly to Icecast. This keeps the song audio untouched during normal playback. Browser audio is used only for mic talk breaks.
- **Voice program** is a Direct submode for mic-led segments such as news breaks. It uses the browser as the live source, does not require a prepared song queue, and can keep a quiet generated ambience under the mic.
- **DJ mixer** runs the song/mic mix through the browser's Web Audio graph. It is useful for live mixing behavior, but direct mode is the safer path for stable listener playback.

## Requirements

- Windows/PowerShell is the primary tested environment.
- Node.js compatible with the current dependencies.
- npm.
- Icecast for Windows extracted under `.tools/icecast`.
- Optional: Python 3 for building the vendored `make-radio-sound.exe` used to prepare retro `.radio.mp3` copies.
- Optional: `cloudflared` for public tunnel control.

Expected Icecast path:

```text
.tools/
  icecast/
    bin/
      icecast.exe
  make-radio-sound/
    make-radio-sound.exe
```

`node_modules`, `dist`, `.saru2radio`, `.tools`, and local environment files are intentionally ignored by git. The `make-radio-sound` source is vendored under `tools/make-radio-sound`; its generated executable stays under ignored `.tools`.

## Install

```powershell
npm install
```

Build the vendored retro-audio preparation tool:

```powershell
npm run setup:radio-sound
```

Build the browser bundles:

```powershell
npm run build
```

Start the local station services:

```powershell
npm run start
```

Open:

- Studio: `http://127.0.0.1:8011/`
- Listener facade: `http://127.0.0.1:8012/`
- Icecast stream: `http://127.0.0.1:8010/live.mp3`

To run on different ports:

```powershell
$env:STUDIO_PORT='18111'
$env:PUBLIC_PORT='18112'
npm run start
```

## Preparing Music

The app can scan a folder of ready MP3 files directly. For the intended retro sound, the local Studio can inspect the source folder, prepare missing or stale radio copies, show per-track progress, and load the completed cache automatically.

By default the app looks for the tool at:

```text
.tools\make-radio-sound\make-radio-sound.exe
```

Build that executable from the vendored source:

```powershell
npm run setup:radio-sound
```

You can override it:

```powershell
$env:RADIO_SOUND_EXE='C:\path\to\make-radio-sound.exe'
```

From the Studio:

1. Pick or enter the original music folder.
2. Use **Scan** to load broadcast tracks and inspect the radio-copy cache.
3. Use **Prepare** to process only missing or stale tracks.
4. Keep the Studio open while it reports progress. When preparation finishes, the prepared library is loaded automatically.

Preparation is disabled while the station is on air. Source files are never modified; generated output stays under `.saru2radio-cache`.

The equivalent local command is:

```powershell
npm run prepare:radio -- "C:\path\to\music"
```

Prepare recursively:

```powershell
npm run prepare:radio -- "C:\path\to\music" --recursive
```

Strict mode stops with a non-zero exit code if any track fails:

```powershell
npm run prepare:radio -- "C:\path\to\music" --strict
```

Prepared output is written next to the source folder:

```text
Music/
  .saru2radio-cache/
    manifest.json
    tracks/
      <track>.radio.mp3
```

In the Studio, use the original folder that contains `.saru2radio-cache` when preparing songs so manifest titles and artists remain available. The `.saru2radio-cache` folder and its `tracks` folder can also be scanned as ready broadcast libraries, but the Studio will not prepare those cached copies again.

## DJ Studio Workflow

1. Start the server with `npm run start`.
2. Open `http://127.0.0.1:8011/`.
3. Choose or type a broadcast folder.
4. Use **Scan**.
5. If the cache summary reports missing or stale copies, use **Prepare** and wait for the prepared library to load.
6. Keep **Direct songs** selected for normal playback.
7. Click **ON AIR**.
8. Share the listener URL, or start the tunnel if configured.
9. Use **Skip**, **Shuffle/Ordered**, click a ready track to play it now, or use its **Next** control to place it immediately after the current song.
10. Hold the mic button for a direct talk break. In direct mode the song pauses while the mic break is live.
10. Click **OFF AIR** when finished.

For a voice-only program, keep **Direct songs** selected, switch the Direct submode from **Songs** to **Voice**, then click **ON AIR**. The mic button latches on/off, and the ambient bed control sets the generated background level.

### Direct Song Switching

Clicking a ready song while on air in direct mode replaces the active queue without reconnecting the Icecast source. This avoids dropping the listener stream during ad-hoc song changes.

The **Next** control updates the queue without interrupting the current song. It is available while a song program is on air, and the selected row stays marked **Queued** until it becomes the current song.

### Microphone Controls

- **Hold talk / Hold mic** opens the mic only while pressed.
- **Latch** exists only in DJ mixer mode and keeps the mic open until unlatched.
- **Mic color** controls the DJ voice tone: `Broadcast`, `Shortwave`, or `Clean`.
- **Local monitor** lets the DJ hear the local mic/mix, but is not required for listeners to hear talk breaks.

## Listener Page

The listener page is served from:

```text
http://127.0.0.1:8012/
```

It shows:

- On-air/off-air status.
- Play/pause control.
- Now-playing title and artist.
- Listener request line.

The request line is disabled while the station is off air. When on air, listeners can enter:

- Name: required, max 40 characters.
- Message/request: required, max 500 characters.

Requests are one-way only. They are visible to the DJ in the studio's **Listener requests** panel and are kept only in memory for the current server session.

If `OPENAI_API_KEY` is set, the local studio server also runs an AI DJ request agent. The agent classifies accepted listener messages against the current ready local track list, logs every action in the studio's **AI DJ actions** panel, and only auto-plays a match while Direct songs is already active. A request for an artist without a song title randomly selects one ready local track by that artist. The listener facade never receives the OpenAI key and does not expose the action log.

## Listener Request API

Public listener route:

```http
POST /requests
Content-Type: application/json

{
  "name": "Adi",
  "message": "Can you play KLa Project?"
}
```

Responses:

- `201` with the stored message when accepted.
- `400` for invalid input.
- `409` when the station is off air.

Studio-only routes:

```text
GET    /api/listener-messages
DELETE /api/listener-messages/:id
DELETE /api/listener-messages
GET    /api/ai-dj/actions
DELETE /api/ai-dj/actions
```

The public listener facade intentionally does not expose `/api/*`.

## Cloudflare Tunnel

If `cloudflared` is installed, the studio can start and stop a public tunnel.

Without named tunnel config, the app starts a quick tunnel and waits for a `trycloudflare.com` URL.

For a named tunnel, create:

```text
.saru2radio/cloudflare-named-tunnel.json
```

Example:

```json
{
  "mode": "named",
  "hostname": "saru2radio.com",
  "url": "https://saru2radio.com",
  "tokenPath": "cloudflare-token.txt"
}
```

You can point to another config path:

```powershell
$env:SARU2RADIO_TUNNEL_CONFIG='C:\path\to\cloudflare-named-tunnel.json'
```

## Cloudflare Worker Front Door

`cloudflare/saru2radio-listener-edge.js` is an optional Worker that fronts the listener URL.

It routes public requests from:

```text
https://saru2radio.com
```

to a hidden tunnel origin:

```text
https://origin.saru2radio.com
```

It also:

- rewrites `status.json` to public URLs;
- hides the local Icecast URL;
- preserves `live.mp3` as a no-transform MP3 stream;
- serves branded offline responses when the tunnel/origin is down.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `STUDIO_PORT` | `8011` | Local DJ studio and private API port. |
| `PUBLIC_PORT` | `8012` | Local public listener facade port. |
| `LISTENER_REQUEST_LIMIT` | `6` | Public listener requests allowed per client window. |
| `LISTENER_REQUEST_WINDOW_MS` | `60000` | Listener request rate-limit window in milliseconds. |
| `RADIO_BITRATE_KBPS` | `128` | Browser encoder/source pacer bitrate target. |
| `RADIO_SOUND_EXE` | `.tools\make-radio-sound\make-radio-sound.exe` | Retro audio preparation tool path. |
| `SARU2RADIO_TUNNEL_CONFIG` | `.saru2radio/cloudflare-named-tunnel.json` | Optional named Cloudflare tunnel config. |
| `OPENAI_API_KEY` | unset | Local OpenAI key for the server-side AI DJ request agent. |
| `OPENAI_MODEL` | `gpt-5.6` | AI DJ model used for request classification. |
| `AI_DJ_ENABLED` | `true` | Set to `false` to keep listener requests manual-only. |
| `AI_DJ_MIN_CONFIDENCE` | `0.72` | Minimum model confidence required before AI DJ auto-plays a matched track. |

Icecast runtime secrets are generated in:

```text
.saru2radio/runtime.json
```

Do not commit `.saru2radio`.

## Useful Commands

```powershell
npm run start
```

Start the local server and Icecast integration.

```powershell
npm run dev
```

Build once, then start the local server.

```powershell
npm run prepare:radio -- "C:\path\to\music"
```

Prepare retro radio MP3 copies.

```powershell
npm run check
npm run test:unit
npm run build
npm run test:e2e
```

Run the validation steps used during development.

```powershell
npm run test
```

Run the full validation sequence.

## Development Notes

- Frontend entrypoints are `studio.html` and `listener.html`.
- Vite builds both Svelte apps into `dist`.
- The Playwright e2e suite starts or reuses `http://127.0.0.1:8011/`.
- Unit tests include server helpers, tunnel config, Cloudflare Worker behavior, MP3 playout pacing, and listener message validation.
- `Direct songs` mode is the default UX path for stable streaming.
- Listener messages are not persisted and are cleared on server restart.

## Repository Layout

```text
cloudflare/       Optional listener-edge Worker.
server/           Local Express server, Icecast, library, playout, tunnel, request inbox.
src/listener/     Public listener Svelte app.
src/studio/       DJ studio Svelte app.
src/lib/          Shared API clients, types, and audio helpers.
tests/            Vitest and Playwright tests.
listener.html     Listener app HTML entrypoint.
studio.html       Studio app HTML entrypoint.
```

## Troubleshooting

### `Icecast did not become reachable`

Confirm the Icecast binary exists at:

```text
.tools/icecast/bin/icecast.exe
```

Also check that port `8010` is free or already serving Icecast.

### `make-radio-sound.exe was not found`

Build the vendored tool:

```powershell
npm run setup:radio-sound
```

Or set `RADIO_SOUND_EXE` to a custom `make-radio-sound.exe` path.

### Listener cannot hear the station

Check:

- Studio shows `ON AIR`.
- Icecast status is connected.
- Listener URL points to the active facade/tunnel.
- Direct songs mode has at least one ready MP3 track.
- Browser autoplay restrictions: listeners may need to press play.

### Listener requests do not send

Requests are accepted only when the station is on air. Off-air requests return `409`.

### Public tunnel works locally but not on `saru2radio.com`

Check:

- `cloudflared` is installed and available on `PATH`.
- named tunnel config exists if using the fixed domain;
- the tunnel points to `http://127.0.0.1:8012`;
- the Cloudflare Worker routes `saru2radio.com` to `origin.saru2radio.com`.

## Privacy and Scope

The DJ studio is intended to run locally. The public listener facade exposes only listener-safe routes. Request messages are session-only and are not written to disk. Original music files are not modified by the app; prepared radio copies are written under `.saru2radio-cache` inside the selected music folder.
