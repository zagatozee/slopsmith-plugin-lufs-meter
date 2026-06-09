# slopsmith-plugin-lufs-meter

> Real-time LUFS metering and automatic loudness normalisation for [Slopsmith](https://github.com/slopsmith/slopsmith).

**Version:** 1.5.5 · **Plugin ID:** `lufs-meter` · **Author:** zagatozee

---

## The problem

Rocksmith CDLC songs vary wildly in volume. One song is ear-splittingly loud, the next is barely audible. Slopsmith never reads or applies the `SongVolume` loudness offset embedded in PSARC manifest files, so even well-authored CDLC plays at the wrong level. This plugin fixes that.

---

## Features

- **Live LUFS meter** injected into the player controls bar at all times — colour-coded relative to your target level
- **Automatic PSARC `SongVolume` application** — reads the manifest offset Slopsmith ignores and applies it via a Web Audio `GainNode`
- **Pre-play loudness sampling** — fetches a ~20 s byte-range from the middle of the audio file before playback starts, so gain is set from the first note with no audible jump
- **Background analysis** — hovers over library cards queue songs for analysis while you browse; by the time you hit play, the trim is already calculated
- **Integrated refinement** — accumulates real loudness data during playback and replaces the initial estimate with a more accurate value after 60 s
- **Global loudness target** with presets (–16 LUFS default, matching CDLC community tooling; –14 for Spotify/YouTube; –23 for EBU R128)
- **Per-song trims** saved to server SQLite and localStorage — subsequent plays apply the correct gain immediately with zero latency
- Works with **PSARC**, **sloppak**, and **loose folder** songs

---

## Installation

### Via Plugin Manager (recommended)

If you have the [Update Manager plugin](https://github.com/masc0t/slopsmith-update-manager) installed, paste the repo URL into the **Install Plugin** field and click **Install** — no terminal or Docker restart required:

```
https://github.com/zagatozee/slopsmith-plugin-lufs-meter
```

### Via git (manual)

```bash
cd /path/to/slopsmith/plugins
git clone https://github.com/zagatozee/slopsmith-plugin-lufs-meter.git lufs-meter
docker compose restart
```

---

## Quick start

1. Install and restart Slopsmith
2. A **LUFS readout** appears in the player controls bar — click it to open the full screen
3. In the **Global Loudness Target** section, toggle **Enable**
4. Pick a preset or enter a custom target (–16 LUFS recommended)
5. Play any song — the plugin samples the audio before playback starts and sets the volume automatically

The setting persists per song. After the first play, subsequent plays apply the saved trim instantly.

---

## What you should see

### Player bar widget

A small readout and bar appear in the player controls at all times:

| Colour | Meaning |
|---|---|
| 🔵 Blue | Quiet — more than 2 dB below target |
| 🟢 Green | Near target — within ±2 dB |
| 🟡 Amber | Above target by 2–6 dB |
| 🔴 Red | Very loud — more than 6 dB above target |

A gold tick mark on the bar shows where your current target sits.

### Plugin screen

Click the widget or navigate via the left-hand nav. The screen has five sections:

- **Live Metering** — momentary and 3 s short-term LUFS with a coloured bar and target marker
- **Global Loudness Target** — enable/disable toggle, presets, custom target input, queue status
- **Current Song** — sampling status, provisional/refined badge, re-sample and normalise buttons
- **Applied Gain** — three-column breakdown: PSARC SongVolume + trim = total
- **Manual Trim** — ±0.5 dB nudge buttons, direct input, reset

A **← Back** button returns you to the player without stopping the song.

---

## How loudness adjustment works

### First play (no saved trim)

```
You click play
  → Plugin fetches ~400 KB from 30% into the audio file
  → Decodes offline → measures RMS → calculates required trim
  → Gain applied BEFORE audio plays (no volume jump)
  → Trim saved as provisional

During playback (60 s of non-silent audio)
  → Integrated loudness replaces the provisional estimate
  → Trim saved permanently
  → "⏳ provisional" badge replaced with "✓ refined"
```

If the byte-range fetch fails, the plugin falls back to the live meter at 8 seconds in.

### Subsequent plays

Saved trim is applied immediately from the server DB — no fetch, no analysis, no delay.

### PSARC SongVolume

Well-authored CDLC PSARCs embed a `SongVolume` dB offset in their manifest JSON. Slopsmith has never read or applied this field. This plugin reads it from the backend and applies it automatically on top of the user trim. The Applied Gain card shows this separately in green when a non-zero value is found.

---

## Global target presets

| Preset | LUFS | Notes |
|---|---|---|
| Rocksmith CDLC tools | –16 | **Default.** Matches EzCDLCCreator and CustomsForge tooling |
| Spotify / YouTube | –14 | Streaming platform loudness standard |
| Apple Music | –16 | Apple Sound Check target |
| EBU R128 | –23 | Broadcast standard — most songs will sound noticeably quieter |

You can also enter any value between –40 and –6.

---

## What is and isn't persisted

| Setting | Storage | Survives container restart |
|---|---|---|
| Per-song trim values | Server SQLite (`lufs_meter.db`) + localStorage | ✅ Yes |
| Global target value | Browser localStorage | ❌ Lost if browser data is cleared |
| Global override on/off | Browser localStorage | ❌ Lost if browser data is cleared |
| Background analysis cache | Browser memory | ❌ Lost on page refresh |

> **Known limitation:** The global override toggle and target level are stored in the browser only. If you clear browser data or switch browsers you'll need to re-enable and re-set your target. A future version should persist these server-side.

---

## Backend API

The plugin exposes the following endpoints:

| Endpoint | Method | Description |
|---|---|---|
| `/api/plugins/lufs_meter/song_volume?filename=` | GET | Returns `SongVolume` dB from the PSARC manifest (0.0 for sloppak/loose) |
| `/api/plugins/lufs_meter/set_offset` | POST | Save `{ filename, offset_db }` — called automatically, or manually from the UI |
| `/api/plugins/lufs_meter/get_offset?filename=` | GET | Return the saved offset for a song |
| `/api/plugins/lufs_meter/status` | GET | Plugin version |

No extra Python dependencies are required. The plugin uses Slopsmith's bundled `psarc` module.

---

## Compatibility

| Slopsmith version | Status |
|---|---|
| v0.2.8+ | ✅ Full support — uses `highway.getAudioElement()` |
| v0.2.7 and earlier | ⚠️ Falls back to `document.getElementById('audio')` — may conflict with other plugins touching the audio graph |

---

## Known issues and validation needed

These areas are correct in theory but require real-world testing to confirm:

1. **`song:play` event payload** — The plugin listens to `window.slopsmith.on('song:play', ...)` and expects `filename` in the payload. This was inferred from the server source; the actual frontend `app.js` was not readable. If `filename` is absent, no trim will ever be saved or applied. **This is the highest-risk assumption.** Check the browser console: you should see `[lufs_meter] bg: <filename> → -xx.x LUFS` entries if it's working.

2. **HTTP Range request support** — Pre-play sampling depends on the `/audio/` endpoint returning `206 Partial Content` for a `Range: bytes=N-M` request. If this fails silently, the fallback kicks in at ~8 seconds — you may notice a brief volume jump. Check the Network tab: the sampling request should show status 206.

3. **Audio graph conflicts** — If NAM tone, stems, or another plugin also calls `createMediaElementSource` on the same `<audio>` element, the second call will throw. We catch this and attempt to reconnect, but success depends on load order (alphabetical by folder name — `lufs_meter` loads after `l*` plugins and before `m*` ones). If the meter shows nothing mid-song, this is the likely cause.

4. **`esc()` navigation** — The ← Back button calls `esc()` directly. Confirmed as a global function in the Slopsmith README but not tested. If the button does nothing, report your Slopsmith version.

5. **Integrated refinement accuracy** — Songs with very long quiet intros followed by loud sections may produce a skewed integrated reading that overcorrects. Use the Manual Trim section to fix and save permanently.

---

## File layout

```
lufs_meter/
├── plugin.json       Manifest — v3 capability schema, nav, routes, diagnostics
├── routes.py         Backend — reads PSARC manifests, persists offsets to SQLite
├── screen.html       Plugin UI
├── screen.js         All frontend logic — Web Audio graph, background queue,
│                       byte-range sampling, live meter, integrated refinement
├── settings.html     Settings page fragment
├── requirements.txt  No extra Python deps
└── README.md         This file
```

---

## License

MIT
