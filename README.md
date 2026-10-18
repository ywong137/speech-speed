# Speech Speed (advanced)

A Chrome and Firefox extension that adjusts video playback speed to how fast the speaker is talking. Slow speakers get sped up more and fast speakers less, so everything you watch plays at roughly the same comfortable listening pace. You get through lectures, talks and podcasts faster, and fast passages stay understandable.

Fixed speed-up buttons treat every speaker the same: 2x is fine for a slow lecturer and too fast for a fast talker. Speech Speed listens to the audio, measures the speaker's syllable rate, and picks the speed for you, adjusting as speakers change.

This is a fork of [Speech Speed](https://github.com/ywong137/speech-speed) by Yishan Wong ([@ywong137](https://github.com/ywong137)). The original is a Chrome extension. This fork runs in both Chrome and Firefox and has a rewritten speech-rate detector.

## Features

- **Chrome and Firefox.** One Manifest V3 codebase with no separate per-browser versions. The same folder loads in Chrome (and other Chromium browsers) and in Firefox.
- **Automatic, per-speaker speed.** Measures the speaker's natural syllable rate and sets the playback speed so you hear about the same number of syllables per second (9 by default) whoever is talking.
- **Works on most video sites.** Attaches to the largest `<video>` on the page (YouTube and other HTML5 players) and re-attaches when single-page sites like YouTube swap the video.
- **Leaves the player alone.** Taps the video's audio with `captureStream()` (falling back to `mozCaptureStream()` in Firefox) and only ever changes `playbackRate`. Turning it off puts the video back to 1x.
- **Measurement that doesn't depend on the current speed.** Syllables are timed against the video's own timeline, so a speaker measures the same at 1x or 3x, and the speed can't run away to the maximum.
- **Pauses don't count.** The rate is syllables per second of actual speech, so speakers who pause a lot aren't treated as slow.
- **Works at any volume.** The speech detector adapts to the noise floor and loudness of each video, with no fixed thresholds.
- **Smooth changes.** The speed changes gradually, holds steady through short pauses, eases back to 1x after a few seconds of silence, and freezes while the video is paused, seeking or buffering.
- **Popup controls.** An on/off switch, the current playback speed, and sliders for target rate, minimum speed and maximum speed. Settings are saved between sessions.
- **Diagnostic overlay.** An on-page panel shows the current speed, the detected syllable rate, speech/silence state, an audio level meter and a scrolling history of speed changes.
- **Private and lightweight.** All audio is analysed locally in the page. There are no network requests, no external libraries and no build step.

### Changes from the original

- Documented for Firefox as well as Chrome, with Firefox install steps. The code was already compatible: it uses the `chrome.*` extension APIs, which Firefox supports, and falls back to `mozCaptureStream()` when `captureStream()` isn't available.
- New speech-rate detector (v4, described below): picks syllable peaks in a 10 ms energy envelope, timed in media time, instead of counting zero-crossings in a 33 Hz envelope. The old detector couldn't keep up once the video ran faster than about 2x, so it read speakers as slower than they were and pushed the speed to the maximum.
- The rate is computed over voiced time only, so pauses no longer lower it.
- Speed smoothing uses a time constant in seconds, based on the actual time between polls, so it no longer depends on the timer rate.
- Detection pauses while the video is paused, seeking or buffering, so the speed doesn't jump on resume.

## Credits

Many thanks to Yishan Wong ([@ywong137](https://github.com/ywong137)) for creating the original [Speech Speed](https://github.com/ywong137/speech-speed) extension. The idea, the audio pipeline, the popup, the diagnostic overlay and the detailed write-up of earlier detector versions all come from that project, and this fork builds on it.

## How it works

### Audio capture

The extension's content script finds the largest `<video>` element on the page and taps its audio output using `HTMLMediaElement.captureStream()`. This returns a `MediaStream` without interrupting normal playback. The stream is fed into a Web Audio API graph:

```
video.captureStream()
  → MediaStreamSource
    → BiquadFilter (highpass 300 Hz)
      → BiquadFilter (lowpass 3000 Hz)
        → AnalyserNode (16384-sample buffer, polled every 30 ms)
```

The 300-3000 Hz bandpass isolates the vowel formant region where syllable energy is concentrated, rejecting low-frequency rumble and high-frequency noise.

### Syllable rate detection

The core algorithm measures **syllable rate** by picking peaks in a short-time energy envelope. It went through four iterations:

**v1 (abandoned): Threshold peak-counting.** Computed a smoothed RMS envelope and counted peaks above an adaptive threshold. Failed because fast continuous speech maintains high energy without deep dips between syllables, so the detector saw one long above-threshold region instead of individual syllables. This systematically undercounted fast speech.

**v2 (abandoned): AudioWorklet-based detection.** The same peak-counting algorithm running in an AudioWorklet for off-main-thread processing. Blocked by YouTube's Content Security Policy, which rejects blob: URLs for script loading.

**v3 (abandoned): Energy-envelope zero-crossings.** High-pass filtered the RMS of each 2048-sample poll, counted positive-going zero crossings over a 4 s wall-clock window, and divided by the current playback speed. The envelope was only sampled ~33 times a second and weak syllables never rose above the running mean, so once the video played faster than ~2× it saw at most ~5 syllables per wall-clock second. Dividing by the now higher playback speed made the speaker look even slower, which raised the speed again: a feedback loop that pinned slow speakers at `maxSpeed`. Pauses also counted as speaking time, so deliberate speakers measured slower than they talk.

**v4 (current): dB peak picking in media time.**

1. **10 ms frames.** Each poll reads the analyser buffer but only uses the samples rendered since the previous poll (from the `AudioContext.currentTime` difference), cut into 10 ms frames. That gives a 100 Hz envelope instead of 33 Hz. The large buffer is headroom, so a late timer tick doesn't lose audio.

2. **Power in dB, averaged over 3 frames** (30 ms). That covers at least two pitch periods, so the voice's own glottal pulses aren't mistaken for syllables.

3. **Adaptive voicing gate.** A noise floor follows the quietest frames and a speech level follows the loudest; both drift back at 2 dB/s. A frame is voiced when it is at least 10 dB above the floor and within 25 dB of the speech level. There are no absolute thresholds, so the video's loudness doesn't matter.

4. **Peak picking with hysteresis.** A syllable nucleus is a voiced peak with a dip of at least 3 dB on both sides. Peaks closer than 80 ms of media time are ignored.

5. **Media time.** Every frame is stamped in media time (frame duration × `playbackRate`), so the rate comes out as the speaker's natural rate at any playback speed. Audio lost to a late poll just shortens the analysed media; it doesn't bias the rate.

6. **Articulation rate.** Rate = syllable peaks / voiced media time over the last 6 s of media. Dips shorter than 200 ms count as voiced (they're between syllables); longer gaps are pauses and are left out. A rate is reported only once there's 1 s of voiced speech in the window.

### Speed mapping

The detected syllable rate is converted to a playback speed:

```
targetSpeed = clamp(targetSyllableRate / naturalRate, minSpeed, maxSpeed)
currentSpeed += (1 - exp(-dt / smoothingSec)) * (targetSpeed - currentSpeed)
```

`captureStream()` delivers audio at the current playback rate: at 2x the syllables arrive twice as fast. Because the detector timestamps frames in media time, `naturalRate` is already the speaker's own rate, and nothing is divided by the current speed (in v3 that division caused the feedback loop).

With the default target of 9 syl/s:

| Speaker pace | Natural rate | Playback speed |
|---|---|---|
| Very slow | ~2.5 syl/s | 3.50x (capped) |
| Slow | ~3.0 syl/s | 3.00x |
| Normal | ~4.5 syl/s | 2.00x |
| Fast | ~6.0 syl/s | 1.50x |
| Very fast | ~8.0 syl/s | 1.12x |

During pauses (no voiced frames for 0.25 s) the speed is held. After 3 s of silence it eases back toward 1x. While the video is paused, seeking or buffering, the detector stops, so nothing jumps on resume.

### Smoothing

Speed changes follow an exponential moving average with a 1.5 s time constant, computed from the actual time between polls. Together with the 6 s rate window, the speed settles a few seconds after a new speaker starts, and pauses don't move it.

## Installation

Clone or download this repository, then load it in your browser.

### Chrome (and other Chromium browsers)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the repository folder
4. Navigate to any page with a video, click the extension icon, and toggle **ON**

### Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and select `manifest.json` in the repository folder
3. Navigate to any page with a video, click the extension icon, and toggle **ON**

Firefox removes temporary add-ons when it restarts, so you'll need to load it again after a restart.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3 extension config |
| `content.js` | Content script: audio capture, syllable detection, speed control, diagnostic overlay |
| `popup.html/js/css` | Extension popup: on/off toggle and settings sliders |
| `syllable-worklet.js` | (Legacy, unused) AudioWorklet from v2 approach |

## Configuration

The popup exposes three sliders:

- **Target rate** (4-14 syl/s, default 9): the desired effective syllable rate you hear. Higher = more speedup across the board. Lower = gentler.
- **Min speed** (1-2x, default 1.0): floor for playback rate. Set to 1.0 to never slow below normal.
- **Max speed** (1.5-5x, default 3.5): ceiling for playback rate. Protects against extreme speedup on very slow speakers.

Settings persist in `chrome.storage.local`.

## Diagnostic overlay

When enabled, a dark panel appears in the top-right corner of the page showing:

- **Speed** (large green number): current playback multiplier
- **syl/s** (large blue number): estimated natural syllable rate of the speaker
- **State**: SPEAKING (green) or SILENCE with duration (amber)
- **Energy bar**: real-time audio energy level
- **History log**: scrolling list of rate-to-speed mappings, one per second, most recent at bottom (bold). Lets you see at a glance how the speed changes as different speakers talk.
- **Stats**: syllable peaks / voiced seconds in the rate window, poll tick count, pipeline stage

## Tuning guide

All tunable parameters are in `content.js`. Here are the ones most worth adjusting:

### Detector parameters (in the `detector` object)

| Parameter | Default | What it does | How to tune |
|---|---|---|---|
| `prominenceDb` | 3 dB | Dip required on both sides of a peak for it to count as a syllable. | Raise to 4-5 if syllables are overcounted (noisy audio, music). Lower to 2 if fast speech is undercounted. |
| `minPeakIntervalMs` | 80 ms (media) | Minimum time between syllables. Caps the rate at 12.5 syl/s. | Rarely needs changing. |
| `floorMarginDb` | 10 dB | How far above the noise floor a frame must be to count as speech. | Raise if background noise or music counts as speech. Lower if quiet speech over a noisy background is missed. |
| `peakRangeDb` | 25 dB | How far below recent speech peaks a frame can be and still count as speech. | Lower if reverb tails count as speech. |
| `maxGapMs` | 200 ms (media) | Longest dip that still counts as part of speech. Longer gaps are pauses. | Raise if the rate reads high because dips inside words are treated as pauses. |
| `windowMs` | 6000 ms (media) | Sliding window for the rate. | Shorter (4000) adapts faster to a new speaker but is noisier. Longer (8000) is steadier. |
| `minVoicedMs` | 1000 ms (media) | Voiced speech needed in the window before the rate is used. | Raise for steadier estimates at the start of a video. |

### Speed control parameters (in `DEFAULTS`)

| Parameter | Default | What it does | How to tune |
|---|---|---|---|
| `targetRate` | 9 syl/s | Desired effective syllable rate. The speed adjusts so you hear syllables at roughly this rate. | This is the primary dial. 7 = moderate speedup. 9 = aggressive. 12 = very aggressive. Normal English speech is ~4-5 syl/s. |
| `smoothingSec` | 1.5 s | Time constant for speed changes. | Lower (0.7) = snappier but more audible changes. Higher (3) = gentler. |
| `silenceHoldSec` | 3 | Seconds of silence before speed starts drifting toward 1x. | Raise if speed is resetting during natural pauses in speech. Lower if speed hangs too long after someone stops talking. |
| `minSpeed` / `maxSpeed` | 1.0 / 3.5 | Speed clamps. | Adjust based on your tolerance. Some people can track 4-5x; others top out at 2x. |

### Bandpass filter

The highpass (300 Hz) and lowpass (3000 Hz) in the audio pipeline isolate the vowel formant region. If you're seeing poor detection on content with unusual audio characteristics:

- **Lots of bass bleed triggering false syllables**: raise highpass to 400-500 Hz
- **Missing high-pitched speakers**: raise lowpass to 4000 Hz
- **Sibilance ("s", "sh") being counted as syllables**: lower lowpass to 2500 Hz

### Polling rate

The `setInterval` in `setupAudio` runs every 30 ms, but the poll interval doesn't limit time resolution: each poll analyses every sample rendered since the previous one, in 10 ms frames. A poll can be up to ~340 ms late (16384 samples at 48 kHz) before audio is dropped, and dropped audio only shortens the analysed window.

## Known limitations

- **DRM-protected content** (Netflix, Disney+, etc.): `captureStream()` is blocked on encrypted media. The extension will not work on these sites.
- **Music and sound effects**: The detector may count rhythmic beats as syllables. The bandpass filter and silence gating help, but aren't perfect. A Voice Activity Detection model (e.g., Silero VAD at ~2 MB) could improve this.
- **Multiple simultaneous speakers**: The detector measures aggregate syllable rate across all speakers. This is a reasonable degradation since overlapping speech is hard to parse at any speed.
- **Non-speech audio content**: Podcasts with heavy background music or sound design may see inaccurate rate detection.
- **SPA navigation**: On YouTube and similar single-page apps, the extension re-attaches when the video element changes. There may be a brief 1-2 second gap during navigation.

## Potential improvements

- **Silero VAD integration**: Adding the ~2 MB Silero VAD model via onnxruntime-web could gate the detector to only count syllables during confirmed speech, ignoring music and ambient sound.
- **Autocorrelation-based rate estimation**: Instead of counting peaks, compute the autocorrelation of the energy envelope to find the dominant modulation frequency. This would be more robust to noise and provide smoother rate estimates.
- **Per-speaker adaptation**: If combined with speaker diarization, the extension could maintain separate rate estimates for each speaker and switch speeds instantly when the active speaker changes.
- **Keyboard shortcut toggle**: Add `chrome.commands` for quick enable/disable without opening the popup.

## License

MIT
