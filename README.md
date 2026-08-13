# logwiju

A browser-based viewer for Betaflight blackbox flight logs. Drop in a `.BFL` /
`.BBL` file and it decodes the log and plots every field on a zoomable canvas.

No build step, no dependencies, no upload — the log is parsed entirely in your
browser and never leaves your machine.

![screenshot](docs/screenshot.png)

## Live version

<https://subtilitas.github.io/logwiju/>

The published site tracks the **latest release**, not the tip of `main`. Pushing
to `main` changes nothing that is live; publishing a release deploys it.

To ship a new version, cut a release (Releases → Draft a new release → pick a
tag → Publish). The workflow in `.github/workflows/pages.yml` then runs the
decoder test and, only if it passes, deploys that tag. Publishing an older
release out of order is ignored, and prereleases are never deployed.

## Running it locally

Browsers refuse to load JavaScript modules from `file://`, so the page has to be
served over HTTP. Any static server works:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Or, if you prefer Node:

```bash
npx http-server -p 8000
```

Opening `index.html` directly will show a message explaining this rather than a
blank page.

## Using it

Click **Open log…** or drag a log file anywhere onto the window.

| Action | Control |
| --- | --- |
| Zoom | Mouse wheel (zooms around the pointer) |
| Pan | Click and drag, or `←` / `→` |
| Zoom to a range | Shift + drag |
| Scroll horizontally | Shift + wheel, or drag the scrollbar |
| Fit whole log | Double-click, `0`, or the **Fit** button |
| Zoom in / out | `+` / `−` |
| Jump to start / end | `Home` / `End` |

Each selected field gets its own lane with an independently auto-scaled Y axis,
so a 100 000 eRPM trace and a 14 V trace stay readable side by side. Moving the
mouse snaps a crosshair to the nearest logged sample and reads out every lane's
value at that instant.

The field list on the left is built from the log itself. Fields are grouped
(Gyro, PID, Motor, RPM, Power, ESC, …) and each one shows its range over the
whole log. Fields that never change are dimmed, since they usually mean a sensor
that was not connected.

## What it handles

The decoder is a from-scratch implementation of the Betaflight blackbox format
and follows the reference decoder in
[betaflight/blackbox-log-viewer](https://github.com/betaflight/blackbox-log-viewer):

- All field encodings: signed/unsigned variable byte, `NEG_14BIT`, `TAG8_8SVB`,
  `TAG2_3S32`, `TAG8_4S16` (both the v1 and v2 layouts), `TAG2_3SVARIABLE`
- All field predictors, including straight-line, average-of-2, motor 0,
  min-throttle/min-motor, `vbatref` and GPS home coordinates
- I, P, S, G, H and E frames, with event decoding
- Files containing several concatenated logging sessions — each is decoded
  separately and picked from a dropdown
- Corrupt or truncated files: the decoder resynchronises on the next intra
  frame, reports how many frames were dropped, and shows whatever it recovered

Gyro values are converted to °/s using `gyro.scale` from the header, accelerometer
values to g using `acc_1G`, and — for Betaflight 4.x logs — voltage and current
to V and A. Anything the header doesn't let us convert with confidence is left in
raw units rather than guessed at.

Sample spacing in real logs is not uniform (dropped frames, ESC telemetry
arriving on its own schedule), so the viewer indexes by timestamp rather than by
frame number, and reports both the nominal and average rates along with the
largest gap.

## Performance

Logs routinely contain hundreds of thousands of samples, far more than there are
pixels. Rather than subsampling — which hides exactly the single-frame spikes you
open a blackbox log to find — the renderer computes a min/max envelope per pixel
column and sweeps it, so spikes survive at any zoom level. Once you zoom in far
enough that samples are further apart than a pixel, it switches to a plain
polyline and then to individual sample dots.

The example log (17 125 frames, 12 fields, 215 KB) decodes in around 60 ms.

## Layout

```
index.html            markup and the boot check
css/style.css         styling
js/bbl-parser.js      blackbox decoder (no DOM dependencies, runs in Node too)
js/renderer.js        canvas drawing: lanes, axes, envelopes, crosshair
js/interaction.js     zoom, pan, scrollbar, keyboard
js/app.js             wiring: file loading, field list, readouts
test/verify.mjs       decoder regression test against the example log
exmple_log/           example log used by the test
```

`js/bbl-parser.js` has no browser dependencies, so it can be used on its own:

```js
import { parseBlackbox } from './js/bbl-parser.js';

const logs = parseBlackbox(new Uint8Array(fs.readFileSync('LOG00015.BFL')));
console.log(logs[0].stats);           // { frames, durationSec, sampleRateHz, ... }
console.log(logs[0].columns['motor[0]']);  // Float64Array
console.log(logs[0].time);            // Float64Array of seconds
```

## Tests

```bash
node test/verify.mjs
```

This decodes `exmple_log/LOG00015.BFL` and asserts the frame count, duration,
sample rate and per-field min/max against values derived independently, so a
regression in any encoding or predictor shows up immediately.

## Licence

MIT — see [LICENSE](LICENSE).
