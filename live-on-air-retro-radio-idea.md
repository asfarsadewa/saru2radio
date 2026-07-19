# Live On-Air Retro Radio Idea

> **Historical note:** this is the original brainstorm that kicked off the project. The shipped app is documented in [README.md](README.md) and has outgrown several details below — it now has a listener request line with an AI DJ, streams at 128 kbps, and caches under `.saru2radio-cache`. Keep this file for design rationale (the sound goals and cost model still hold); trust the README for actual behavior.

Working names: `jadisiaran`, `udaratua`, `jadionair`

## One-Line Concept

A small, on-demand live radio station that reads from a music folder, converts the library into low-bitrate retro broadcast copies, and streams only when the owner presses `ON AIR`.

## Goals

- Make a functional, fun radio app in the same spirit as `jadiradio`, `kacamata`, and `jadikopi`.
- Avoid 24/7 hosting costs by only streaming when manually started.
- Keep the music library simple: 100-200 local songs is enough.
- Use a deliberately retro sound: mono, low bitrate, band-limited, with crackle, hiss, and shortwave/old broadcast coloration.
- Keep the listener side simple: a web page with an audio player, `ON AIR` state, and current track/station metadata.

## Non-Goals

- No listener accounts.
- No database for v1.
- No request system for v1.
- No always-on radio automation unless added later.
- No uploading original high-quality music unless remote control becomes important later.

## Recommended V1 Architecture

Use a split architecture:

```text
Local broadcaster dashboard
  reads chosen music folder
  prepares low-bitrate radio copies
  controls queue, mic, bumpers, and broadcast state
  sends one live MP3 stream
        |
        v
Icecast relay server
  receives one source stream
  serves many listeners
        |
        v
Static listener web app
  audio player
  on-air/off-air state
  current track metadata
```

This keeps the home/local machine upload tiny. The broadcaster only sends one stream to the relay. Listener bandwidth happens on the relay server.

## Core Components

### 1. Local Broadcaster Dashboard

This is the private/local control app the station owner runs. It is the DJ booth.

Responsibilities:

- Choose a music directory.
- Scan audio files.
- Generate a local manifest.
- Convert songs into radio-ready cache files.
- Start and stop the live stream.
- Show now-playing, queue, elapsed time, and stream health.
- Control queue order, shuffle, skip, and pause.
- Trigger station IDs, intro bumpers, and sign-off bumpers.
- Control microphone talk-over.
- Show music, mic, and output levels.
- Push status metadata for the listener web page.

Good implementation options:

- **Node local service + web UI**: practical MVP, easy to build, can call FFmpeg.
- **Tauri desktop app**: cleaner desktop feel, good folder access, can bundle a small control UI.
- **Plain browser app only**: less ideal for v1 because reliable live streaming to Icecast and FFmpeg-style transcoding are awkward in the browser.

Recommended for v1: **Node local service with a Vite/Svelte control UI**.

Suggested dashboard controls:

```text
ON AIR / OFF AIR
Choose Folder
Scan Library
Prepare Broadcast Copies
Shuffle / Ordered
Queue
Skip
Now Playing
Mic Push-To-Talk
Mic Latch
Music Volume
Mic Volume
Ducking Amount
Station ID
Sign-Off
Output Meter
Stream Health
Copy Listener URL
```

The dashboard should be local-only by default. Remote admin can be added later, but v1 should assume the DJ is operating from the same machine that has the music folder and microphone.

### 2. Audio Processing Cache

Keep originals untouched. Generate broadcast copies into a cache folder.

Suggested folder shape:

```text
Music/
  originals/
    song-a.flac
    song-b.mp3
  .jadisiaran-cache/
    tracks/
      song-a.radio.mp3
      song-b.radio.mp3
    manifest.json
```

For 100-200 songs this is tiny. At 64 kbps mono, a 4-minute track is about 1.9 MB. Around 200 average songs is roughly 380 MB.

### 3. Icecast Relay

Icecast is the simplest proper Internet-radio relay for v1.

It receives a source stream from the broadcaster and exposes a listener URL like:

```text
https://radio.example.com/live.mp3
```

For local-machine development, avoid port `8000` because it is commonly used by other dev servers. Use `8010` as the default Icecast port for this project:

```text
http://localhost:8010/live.mp3
```

Recommended stream:

```text
MP3 CBR
mono
64 kbps default
22.05 kHz or 32 kHz
mount: /live.mp3
```

Use 48 kbps for a more damaged shortwave feel, or 64 kbps for a better balance between music quality and retro texture.

### 4. Static Listener Site

The public site can be static.

Minimum UI:

- Station name.
- `ON AIR` / `OFF AIR`.
- Big play button.
- Current track or show title.
- Retro dial / VU meter / fake frequency display.
- Optional "last updated" or listener count if Icecast stats are exposed.

Data files:

```text
/status.json
/now-playing.json
```

Example `status.json`:

```json
{
  "onAir": true,
  "streamUrl": "https://radio.example.com/live.mp3",
  "stationName": "Jadisiaran",
  "startedAt": "2026-05-24T12:00:00Z"
}
```

## DJ Mic And Talk-Over

The broadcaster should support live microphone talk-over so the owner can speak on top of playing songs.

The mic should not be mixed in raw at equal volume. It should behave like a radio DJ mic:

```text
press or latch MIC
  open microphone input
  high-pass mic to remove rumble
  compress mic for presence
  lower music by a configurable ducking amount
  mix mic over music
  run final limiter
release MIC
  fade music back to normal
```

Recommended defaults:

```text
Mic mode: push-to-talk
Mic ducking: -12 dB
Mic fade-in: 80 ms
Mic fade-out: 180 ms
Music return: 350 ms
Mic high-pass: 100 Hz
Mic compression: medium
Final limiter ceiling: -1 dB
```

The dashboard should have both:

- **Push-to-talk**: hold while speaking.
- **Latch**: click once to keep mic open, click again to close.

Useful later controls:

- Mic monitor mute.
- Cough button.
- Talk timer.
- Auto-duck only while speech is detected.
- Voice preset: `DJ`, `Phone`, `Shortwave`, `Emergency Bulletin`.

## Audio Engine Split

The UI should control the broadcast, but it should not be the only thing responsible for the stream.

Recommended split:

```text
Svelte/Tauri/local web dashboard
  visual controls and state
        |
        v
Node/local service
  file scanning
  cache management
  stream process control
  status metadata
        |
        v
Audio engine
  queue playback
  mic mix
  ducking
  bumpers
  final encode
        |
        v
Icecast
```

Possible audio engine choices:

- **FFmpeg**: good for conversion and simple streaming, less comfortable for interactive DJ control.
- **Liquidsoap**: strong fit for radio playout, Icecast output, playlists, crossfades, mic/live inputs, and fallback behavior.
- **Custom Node/Web Audio mixer**: flexible UI integration, but more work to make reliable.

Recommended path:

- V1: use FFmpeg for cache conversion and a simple playout stream.
- V1.5: add Liquidsoap or a dedicated local audio engine for mic talk-over, bumpers, and smoother broadcast behavior.
- Later: wrap the whole broadcaster in Tauri for a polished desktop DJ booth.

## Bandwidth Estimate

The relay server carries listener bandwidth.

Approximate usage:

| Bitrate | Per listener per hour |
| --- | ---: |
| 48 kbps | 21.6 MB |
| 64 kbps | 28.8 MB |
| 96 kbps | 43.2 MB |

At 64 kbps:

| Listeners | Duration | Relay outbound |
| ---: | ---: | ---: |
| 10 | 2 hours | 576 MB |
| 50 | 2 hours | 2.9 GB |
| 100 | 2 hours | 5.8 GB |

The local broadcaster upload is only one stream, roughly 28.8 MB/hour at 64 kbps.

## Audio Style

Default preset: `Shortwave 80s Mono`

Processing chain:

```text
decode original
downmix to mono
loudness normalize
high-pass around 120-180 Hz
low-pass around 3-5 kHz
light saturation/compression
subtle wow/flutter
station fade modulation
hiss layer
crackle layer
encode MP3 CBR 64 kbps mono
```

Possible presets:

- `AM Kitchen Radio`: narrow, warm, mild hiss.
- `Shortwave Night`: more fade, hiss, and crackle.
- `Cassette Broadcast`: wow/flutter and softened highs.
- `Emergency Bulletin`: harsher compression, narrow voice-forward tone.

## Runtime Behavior

When off:

- Icecast can stay up, but no source is connected.
- Listener site shows `OFF AIR`.
- Audio player is disabled or points to a short offline loop.

When starting:

1. User opens local broadcaster.
2. User chooses folder or loads saved local config.
3. App checks whether cache is current.
4. Missing/stale tracks are converted.
5. User presses `ON AIR`.
6. Broadcaster starts queue playback and pushes stream to Icecast.
7. Listener site status changes to `ON AIR`.

When stopping:

1. User presses `OFF AIR`.
2. Broadcaster disconnects source stream.
3. Listener site status changes to `OFF AIR`.
4. Optional sign-off bumper plays before disconnect.

## Local Machine Hosting

The project can start Jellyfin-style, with the radio running from the local machine.

```text
Local machine
  music folder
  broadcaster app
  Icecast on port 8010
        |
        v
Local/public listener URL
  http://localhost:8010/live.mp3
  or https://radio.example.com/live.mp3 through a proxy/tunnel
```

This is a good early architecture because it avoids running a paid relay before the station has real listeners.

Tradeoff: every listener consumes local upload bandwidth. At 64 kbps mono, each listener uses about 64 kbps of upload while listening. Ten listeners is roughly 0.64 Mbps; fifty listeners is roughly 3.2 Mbps.

For private or small friend-group listening, local hosting is fine. If listener spikes become annoying, keep the same broadcaster and add a small VPS Icecast relay later:

```text
Local broadcaster sends one stream
        |
        v
VPS Icecast relay
        |
        v
All listeners
```

## MVP Scope

Build only the core loop first:

1. Pick a folder.
2. Scan supported audio files.
3. Convert to radio cache.
4. Start Icecast stream.
5. Stop Icecast stream.
6. Static listener page can play `/live.mp3`.
7. Publish `status.json` and `now-playing.json`.

MVP controls:

```text
Choose Folder
Scan
Prepare Broadcast Copies
Shuffle / Ordered
Start Broadcast
Stop Broadcast
Copy Listener URL
```

## Later Features

- Station ID bumper every 15 minutes.
- Intro and sign-off jingles.
- Crossfade between tracks.
- Manual queue editing.
- Fake frequency selector.
- Web visualizer with VU meter.
- Listener count display.
- Schedule card: "next on air".
- HLS/CDN mode for bigger listener spikes.
- Remote start from a private admin page.

## Alternative Architecture: HLS + Object Storage

If listener bandwidth becomes the main cost problem, switch distribution to HLS.

```text
Broadcaster app
  creates 6-10 second audio segments
  uploads live.m3u8 and segments
        |
        v
Cloudflare R2 or similar object storage/CDN
        |
        v
Web audio player
```

Pros:

- Listener traffic becomes ordinary HTTP file serving.
- Works well with CDN caching.
- Cloudflare R2 currently advertises no egress bandwidth charge.

Cons:

- More moving parts.
- Higher latency, usually 20-60 seconds.
- Less "live radio" feeling than Icecast.

Recommendation: use **Icecast for v1**, then add HLS/CDN mode only if listener scale makes server egress annoying.

## Deployment Shape

### Minimal

- One small VPS running Icecast.
- One static site on Vercel/Cloudflare Pages.
- Local broadcaster app on the owner's machine.

### Slightly More Polished

- VPS runs Icecast behind Caddy/Nginx with HTTPS.
- Static site reads status files from a tiny public endpoint.
- Local broadcaster pushes metadata to the static host or a small Worker endpoint.

## Open Decisions

- Final name: `jadisiaran`, `udaratua`, or something else.
- Whether the control app is a local web app or Tauri desktop app.
- Whether FFmpeg is required on the machine or bundled.
- Default bitrate: 48 kbps for stronger retro, 64 kbps for better music.
- Whether originals stay local only forever, or whether an optional remote library is added later.

## Reference Links

- Icecast documentation: https://www.icecast.org/docs/icecast-latest/
- Liquidsoap encoding examples: https://www.liquidsoap.info/doc-dev/encoding_formats.html
- Apple HLS overview: https://developer.apple.com/library/archive/referencelibrary/GettingStarted/AboutHTTPLiveStreaming/about/about.html
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
