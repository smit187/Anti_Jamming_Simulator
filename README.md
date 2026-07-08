# Spectrum Warfare — Jamming & Anti-Jamming Simulator

A self-contained browser simulator for a two-agent wireless defense loop:

- The **jammer agent** selects (or is manually forced into) a jamming technique and paints synthetic RF interference onto a set of channels.
- The **anti-jammer agent** classifies that pattern purely from spectrum energy and packet-loss telemetry — it never sees the jammer's true label, only what a real receiver could observe.
- The anti-jammer deploys the matched countermeasure, and packet delivery is recalculated so you can watch the connection recover in real time.

Open `index.html` in a browser to run it. No build step or package install required — it loads Chart.js from a CDN and two Google Fonts, everything else is plain JS/CSS.

## Files

| File | Purpose |
|---|---|
| `index.html` | Dashboard structure: dual jammer/anti-jammer panels, controls, advantage meter, battle log |
| `styles.css` | Dark "RF console" theme, responsive down to mobile |
| `simulator.js` | Channel model, jammer agent, anti-jammer classifier, countermeasure logic, canvas + Chart.js rendering |

## How the loop works

```
[ Spectrum State (Wi-Fi 13ch / Bluetooth 79ch) ]
                 |
        Jammer agent picks a technique
                 v
   Synthetic interference painted onto channels
                 |
        Anti-jammer OBSERVES spectrum + packet loss only
                 v
   Classifier labels the pattern (Spot / Sweep / Barrage / Reactive / None)
                 |
        Matched countermeasure is deployed
                 v
   SINR + packet delivery rate recalculated → charts & log update
```

## Jamming techniques modeled

- `NO_JAMMING` — background noise floor only.
- `SPOT_JAMMING` — high energy concentrated on a fixed narrow slice of channels.
- `SWEEP_JAMMING` — a moving interference cluster that sweeps across the band.
- `BARRAGE_JAMMING` — weaker energy spread across (almost) every channel at once.
- `REACTIVE_JAMMING` — the jammer stays mostly silent and only fires a short pulse when it senses an active transmission.

## Anti-jamming countermeasures modeled

- `NORMAL_OPERATION` — no jamming detected, stay put.
- `DYNAMIC_CHANNEL_SWITCH` — counters spot jamming by hopping to the cleanest available channel.
- `ADAPTIVE_FREQUENCY_HOPPING` — counters sweep jamming by hopping among currently-clean channels each tick.
- `RATE_ADAPTATION_POWER_BOOST` — counters barrage jamming by boosting transmit power (stands in for a DSSS/power-boost strategy) to punch through wideband noise.
- `PACKET_INTERLEAVING_AND_RETRY` — counters reactive jamming by randomizing channel/timing and recovering some losses through retry/interleaving, so the jammer can't reliably predict the next transmission.

## Classifier heuristics

The anti-jammer never receives the jammer's label — it infers the technique from three signals computed over a rolling history window, matching the approach used in the fuller battle-simulator build:

1. **Channel energy distribution** — near-total coverage across the band signals barrage.
2. **Spatial clustering via circular centroid tracking** — the elevated channels' centroid is computed with a circular mean (so a cluster straddling channel 0 doesn't look like two separate groups); if that centroid keeps drifting, it's a sweep rather than a static spot.
3. **Burst-presence signature** — narrow-band energy that only ever appears in lockstep with an active transmission (and never when idle) is classified as reactive jamming.

## Controls

- **Start / Pause / Reset** — run, pause, or restart the simulation clock.
- **Protocol toggle** — switch between Wi-Fi (13 channels) and Bluetooth (79 channels); resets the run.
- **Speed slider** — adjusts the tick rate.
- **Jammer override** — force a specific technique instead of the default auto-cycling sequence, useful for testing the classifier against one pattern at a time.

## Where to extend

The agents are intentionally rule-based so every decision is inspectable. Natural next steps:

1. **Swap the heuristic classifier for a trained model.** Log `{ spectrum profile, packet loss ratio, active channel count, centroid, burst duty cycle }` each tick as features, label each row with the jammer's true mode, and train a small classifier (Random Forest, or a compact neural net) offline. Export to TensorFlow.js to run it client-side in place of `AntiJammerClassifier.classify()`.
2. **Connect to a real RF backend.** GNU Radio (via ZeroMQ blocks) or NS-3 could replace `buildSpectrumProfile()` with real or simulated-but-physically-accurate spectrum data.
3. **Add more technique variants**, e.g. follower/protocol-aware jamming, or countermeasures like DSSS spreading modeled explicitly rather than as a power-boost stand-in.

## Notes

This is an educational simulator. It models abstract channel bins, RF energy, SINR, and packet delivery ratio with heuristics — it does not transmit, receive, or interfere with real wireless signals, and isn't a substitute for hardware-in-the-loop testing (GNU Radio / NS-3) before drawing conclusions about real-world jamming resilience.
