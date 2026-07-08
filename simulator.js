/* =========================================================================
   Spectrum Warfare — Jamming vs Anti-Jamming Simulator
   -------------------------------------------------------------------------
   A self-contained, browser-runnable simulation of a two-agent wireless
   defense loop:
     1. A jammer agent selects (or is manually forced into) a jamming
        technique and paints synthetic RF interference onto a set of
        channels.
     2. An anti-jammer agent observes only the resulting spectrum energy
        and packet-loss telemetry (never the jammer's true label) and
        classifies which technique is most likely in play using simple,
        inspectable heuristics.
     3. The anti-jammer deploys the matched countermeasure, which changes
        how the virtual transmitter behaves (channel choice, tx power,
        retry/interleaving), and packet delivery is recalculated.

   Everything here operates on abstract channel bins and made-up RF units.
   Nothing transmits, receives, or interferes with real hardware.
   ========================================================================= */

(() => {
  "use strict";

  /* ----------------------------- Configuration -------------------------- */

  const PROTOCOLS = {
    WIFI: { numChannels: 13, label: "Wi-Fi (13ch)" },
    BLUETOOTH: { numChannels: 79, label: "Bluetooth (79ch)" },
  };

  const NOISE_FLOOR = 2;      // baseline background energy on every channel
  const TX_POWER_BASE = 20;   // baseline transmitter power (arbitrary units)
  const JAM_POWER = 55;       // interference energy a jammer adds to a targeted channel
  const PHASE_DURATION = 55;  // steps per auto-cycled jammer phase
  const HISTORY_LEN = 48;     // rolling samples kept for line charts
  const ADVANTAGE_WINDOW = 20;// rolling samples used for the tug-of-war meter

  const JAM_SEQUENCE = [
    "NO_JAMMING",
    "SPOT_JAMMING",
    "SWEEP_JAMMING",
    "BARRAGE_JAMMING",
    "REACTIVE_JAMMING",
  ];

  const COUNTERMEASURES = {
    NO_JAMMING: "NORMAL_OPERATION",
    SPOT_JAMMING: "DYNAMIC_CHANNEL_SWITCH",
    SWEEP_JAMMING: "ADAPTIVE_FREQUENCY_HOPPING",
    BARRAGE_JAMMING: "RATE_ADAPTATION_POWER_BOOST",
    REACTIVE_JAMMING: "PACKET_INTERLEAVING_AND_RETRY",
  };

  const MODE_COLOR = {
    NO_JAMMING: "#4d5964",
    SPOT_JAMMING: "#f5a623",
    SWEEP_JAMMING: "#ff8a3d",
    BARRAGE_JAMMING: "#ff4b5c",
    REACTIVE_JAMMING: "#c04bff",
  };

  /* --------------------------- Jammer Agent ------------------------------ */

  class JammerAgent {
    constructor(numChannels) {
      this.setNumChannels(numChannels);
      this.override = "AUTO";
    }

    setNumChannels(n) {
      this.numChannels = n;
      this.phase = 0;
      this.phaseStep = 0;
      this.mode = "NO_JAMMING";
      this.sweepPos = 0;
      this.spotChannels = [];
      this._pickSpot();
    }

    setOverride(mode) {
      this.override = mode;
      if (mode !== "AUTO") {
        this.mode = mode;
        if (mode === "SPOT_JAMMING") this._pickSpot();
        if (mode === "SWEEP_JAMMING") this.sweepPos = 0;
      }
    }

    _pickSpot() {
      const width = Math.max(1, Math.round(this.numChannels * 0.06));
      const start = Math.floor(Math.random() * this.numChannels);
      this.spotChannels = [];
      for (let i = 0; i < width; i++) {
        this.spotChannels.push((start + i) % this.numChannels);
      }
    }

    /** Advance one simulation tick and return { mode, targets, changed } */
    step(txChannel, transmitting) {
      const prevMode = this.mode;

      if (this.override !== "AUTO") {
        this.mode = this.override;
      } else {
        this.phaseStep++;
        if (this.phaseStep > PHASE_DURATION) {
          this.phaseStep = 0;
          this.phase = (this.phase + 1) % JAM_SEQUENCE.length;
          this.mode = JAM_SEQUENCE[this.phase];
          if (this.mode === "SPOT_JAMMING") this._pickSpot();
          if (this.mode === "SWEEP_JAMMING") this.sweepPos = 0;
        }
      }

      let targets = [];
      switch (this.mode) {
        case "NO_JAMMING":
          targets = [];
          break;

        case "SPOT_JAMMING":
          targets = this.spotChannels.slice();
          break;

        case "SWEEP_JAMMING": {
          const step = Math.max(1, Math.round(this.numChannels * 0.05));
          this.sweepPos = (this.sweepPos + step) % this.numChannels;
          const w = Math.max(2, Math.round(this.numChannels * 0.08));
          for (let i = -w; i <= w; i++) {
            const c = ((this.sweepPos + i) % this.numChannels + this.numChannels) % this.numChannels;
            targets.push(c);
          }
          break;
        }

        case "BARRAGE_JAMMING":
          for (let c = 0; c < this.numChannels; c++) targets.push(c);
          break;

        case "REACTIVE_JAMMING":
          // Reactive jammers only fire when they sense an active transmission,
          // and even then their sensing isn't perfect.
          if (transmitting && Math.random() < 0.85) targets = [txChannel];
          break;
      }

      return { mode: this.mode, targets, changed: this.mode !== prevMode };
    }
  }

  /* ------------------------- Anti-Jammer Classifier ---------------------- */

  class AntiJammerClassifier {
    constructor(numChannels) {
      this.setNumChannels(numChannels);
    }

    setNumChannels(n) {
      this.numChannels = n;
      this.history = []; // rolling window of { elevated, transmitting, centroid }
      this.windowSize = 10;
    }

    // Circular mean so a jammed cluster that straddles channel 0 doesn't
    // register as two far-apart groups.
    _circularCentroid(indices) {
      if (indices.length === 0) return null;
      let sumSin = 0, sumCos = 0;
      const n = this.numChannels;
      for (const idx of indices) {
        const theta = (idx / n) * 2 * Math.PI;
        sumSin += Math.sin(theta);
        sumCos += Math.cos(theta);
      }
      let angle = Math.atan2(sumSin / indices.length, sumCos / indices.length);
      if (angle < 0) angle += 2 * Math.PI;
      return (angle / (2 * Math.PI)) * n;
    }

    /** Observe this tick's spectrum + traffic state and return a technique label */
    classify(profile, transmitting) {
      const threshold = NOISE_FLOOR + 5;
      const elevated = [];
      for (let c = 0; c < profile.length; c++) {
        if (profile[c] > threshold) elevated.push(c);
      }

      const centroid = this._circularCentroid(elevated);
      this.history.push({ elevated, transmitting, centroid });
      if (this.history.length > this.windowSize) this.history.shift();

      if (elevated.length === 0) return "NO_JAMMING";

      // 1. Channel energy distribution: near-total coverage means barrage.
      const coverage = elevated.length / this.numChannels;
      if (coverage > 0.55) return "BARRAGE_JAMMING";

      // 2. Burst-presence signature: narrow interference that only ever
      //    appears in lockstep with an active transmission looks reactive.
      const narrowBand = Math.max(2, Math.round(this.numChannels * 0.05));
      const relevant = this.history.filter(
        (h) => h.elevated.length > 0 && h.elevated.length / this.numChannels < 0.55
      );
      if (relevant.length >= 3) {
        const withTx = relevant.filter((h) => h.transmitting).length;
        const withoutTx = relevant.length - withTx;
        if (withoutTx === 0 && withTx >= Math.ceil(relevant.length * 0.7) && elevated.length <= narrowBand) {
          return "REACTIVE_JAMMING";
        }
      }

      // 3. Spatial clustering via centroid tracking: if the jammed cluster's
      //    centroid keeps drifting across the band, it's a sweep, not a spot.
      const centroids = this.history.filter((h) => h.centroid !== null).map((h) => h.centroid);
      if (centroids.length >= 4) {
        let moved = 0;
        for (let i = 1; i < centroids.length; i++) {
          let d = Math.abs(centroids[i] - centroids[i - 1]);
          d = Math.min(d, this.numChannels - d); // wrap-around distance
          moved += d;
        }
        const avgMove = moved / (centroids.length - 1);
        if (avgMove > this.numChannels * 0.03) return "SWEEP_JAMMING";
      }

      return "SPOT_JAMMING";
    }
  }

  /* ----------------------------- RF Physics ------------------------------ */

  function buildSpectrumProfile(numChannels, jamResult) {
    const profile = new Array(numChannels).fill(NOISE_FLOOR);
    if (jamResult.mode === "BARRAGE_JAMMING") {
      for (const c of jamResult.targets) profile[c] += JAM_POWER * 0.45;
    } else {
      for (const c of jamResult.targets) profile[c] += JAM_POWER;
    }
    return profile;
  }

  function applyCountermeasure(counter, profile, numChannels, prevTxChannel) {
    let txChannel = prevTxChannel;
    let txPowerMultiplier = 1;
    let retryRecoveryRate = 0;
    let reactiveMissChance = 0;

    switch (counter) {
      case "NORMAL_OPERATION":
        break;

      case "DYNAMIC_CHANNEL_SWITCH": {
        let best = 0, bestVal = Infinity;
        for (let c = 0; c < numChannels; c++) {
          if (profile[c] < bestVal) { bestVal = profile[c]; best = c; }
        }
        txChannel = best;
        break;
      }

      case "ADAPTIVE_FREQUENCY_HOPPING": {
        const clean = [];
        for (let c = 0; c < numChannels; c++) if (profile[c] <= NOISE_FLOOR + 1) clean.push(c);
        txChannel = clean.length ? clean[Math.floor(Math.random() * clean.length)]
                                  : Math.floor(Math.random() * numChannels);
        break;
      }

      case "RATE_ADAPTATION_POWER_BOOST":
        txPowerMultiplier = 3.2; // punch through wideband noise with DSSS + power boost
        break;

      case "PACKET_INTERLEAVING_AND_RETRY": {
        // Randomize channel/timing so a reactive jammer can't reliably predict
        // the next transmission, and recover some losses via interleaving/FEC.
        const clean = [];
        for (let c = 0; c < numChannels; c++) if (profile[c] <= NOISE_FLOOR + 1) clean.push(c);
        txChannel = (clean.length && Math.random() < 0.6)
          ? clean[Math.floor(Math.random() * clean.length)]
          : prevTxChannel;
        retryRecoveryRate = 0.55;
        reactiveMissChance = 0.35;
        break;
      }
    }

    return { txChannel, txPowerMultiplier, retryRecoveryRate, reactiveMissChance };
  }

  function sigmoidPdr(sinrDb) {
    const alpha = 0.5, beta = 10;
    const pdr = 1 / (1 + Math.exp(-alpha * (sinrDb - beta)));
    return Math.min(1, Math.max(0, pdr));
  }

  function randInt(a, b) {
    return a + Math.floor(Math.random() * (b - a + 1));
  }

  /* -------------------------------- State --------------------------------- */

  const state = {
    proto: "WIFI",
    numChannels: PROTOCOLS.WIFI.numChannels,
    running: false,
    step: 0,
    elapsedMs: 0,
    tickMs: 220,
    txChannel: Math.floor(PROTOCOLS.WIFI.numChannels / 2),

    jammer: null,
    classifier: null,

    lastJamMode: null,
    lastCounter: null,

    // rolling series for charts
    seriesLabels: [],
    jamNoiseSeries: [],
    jamBlockedSeries: [],
    sentSeries: [],
    receivedSeries: [],

    advantageWindow: [],

    totals: { attempted: 0, blocked: 0, received: 0 },

    timer: null,
  };

  state.jammer = new JammerAgent(state.numChannels);
  state.classifier = new AntiJammerClassifier(state.numChannels);

  /* -------------------------------- DOM ----------------------------------- */

  const el = (id) => document.getElementById(id);

  const dom = {
    simClock: el("simClock"),
    simStep: el("simStep"),
    btnStart: el("btnStart"),
    btnPause: el("btnPause"),
    btnReset: el("btnReset"),
    protoWifi: el("protoWifi"),
    protoBt: el("protoBt"),
    speedSlider: el("speedSlider"),
    speedValue: el("speedValue"),
    overrideButtons: el("overrideButtons"),

    jamModeLabel: el("jamModeLabel"),
    jamSpectrum: el("jamSpectrum"),
    jamChart: el("jamChart"),
    jamAttempted: el("jamAttempted"),
    jamBlocked: el("jamBlocked"),
    jamBlockRate: el("jamBlockRate"),

    antiModeLabel: el("antiModeLabel"),
    antiSpectrum: el("antiSpectrum"),
    antiChart: el("antiChart"),
    antiReceived: el("antiReceived"),
    antiChannel: el("antiChannel"),
    antiPdr: el("antiPdr"),

    meterFillJam: el("meterFillJam"),
    meterFillAnti: el("meterFillAnti"),
    meterMarker: el("meterMarker"),
    meterReadout: el("meterReadout"),

    battleLog: el("battleLog"),
  };

  /* ------------------------------ Charts -----------------------------------
     Plain-canvas line charts. No external library, no CDN, no network
     dependency — these draw directly with the 2D context, the same way
     drawSpectrum() below does. */

  function initCharts() {
    // Nothing to set up ahead of time; canvases are sized/drawn on demand.
  }

  function pushSeries(arr, val) {
    arr.push(val);
    if (arr.length > HISTORY_LEN) arr.shift();
  }

  function drawLineChart(canvas, series) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
    const h = canvas.clientHeight || 120;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const padTop = 6, padBottom = 6;
    const plotH = h - padTop - padBottom;

    let maxVal = 10;
    for (const s of series) {
      for (const v of s.data) if (v > maxVal) maxVal = v;
    }
    maxVal *= 1.15;

    // gridlines
    ctx.strokeStyle = "#17212b";
    ctx.lineWidth = 1;
    for (let g = 0; g <= 2; g++) {
      const y = padTop + (plotH * g) / 2;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
      ctx.stroke();
    }

    for (const s of series) {
      const data = s.data;
      if (data.length < 2) continue;
      const stepX = w / (HISTORY_LEN - 1);
      const startX = w - (data.length - 1) * stepX;

      const pointAt = (i) => {
        const x = startX + i * stepX;
        const ratio = Math.min(1, Math.max(0, data[i] / maxVal));
        const y = padTop + plotH - ratio * plotH;
        return [x, y];
      };

      if (s.fill) {
        ctx.beginPath();
        const [x0, y0] = pointAt(0);
        ctx.moveTo(x0, h - padBottom);
        ctx.lineTo(x0, y0);
        for (let i = 1; i < data.length; i++) {
          const [x, y] = pointAt(i);
          ctx.lineTo(x, y);
        }
        const [xLast] = pointAt(data.length - 1);
        ctx.lineTo(xLast, h - padBottom);
        ctx.closePath();
        ctx.fillStyle = s.fillColor || s.color;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.setLineDash(s.dashed ? [4, 3] : []);
      ctx.lineWidth = 2;
      ctx.strokeStyle = s.color;
      const [x0, y0] = pointAt(0);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < data.length; i++) {
        const [x, y] = pointAt(i);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  function updateCharts() {
    drawLineChart(dom.jamChart, [
      { data: state.jamNoiseSeries, color: "#ff4b5c", fillColor: "rgba(255,75,92,0.14)", fill: true },
      { data: state.jamBlockedSeries, color: "#f5a623" },
    ]);

    drawLineChart(dom.antiChart, [
      { data: state.sentSeries, color: "#4d5964", dashed: true },
      { data: state.receivedSeries, color: "#2fd9c4", fillColor: "rgba(47,217,196,0.14)", fill: true },
    ]);
  }

  /* --------------------------- Spectrum rendering -------------------------- */

  function drawSpectrum(canvas, profile, opts) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement.clientWidth;
    const h = canvas.clientHeight || 110;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const n = profile.length;
    const gap = n > 40 ? 0.5 : 2;
    const barW = (w - gap * (n - 1)) / n;
    const maxVal = Math.max(JAM_POWER + NOISE_FLOOR, 10);

    for (let i = 0; i < n; i++) {
      const val = profile[i];
      const ratio = Math.min(1, val / maxVal);
      const barH = Math.max(2, ratio * (h - 4));
      const x = i * (barW + gap);
      const y = h - barH;

      let color = opts.baseColor;
      if (val > NOISE_FLOOR + 5) color = opts.hotColor;
      if (opts.highlightChannel === i) color = opts.highlightColor;

      ctx.fillStyle = color;
      ctx.fillRect(x, y, barW, barH);
    }
    ctx.restore();
  }

  /* ------------------------------ Battle log ------------------------------- */

  function formatClock(ms) {
    const totalSec = ms / 1000;
    const m = Math.floor(totalSec / 60);
    const s = (totalSec % 60).toFixed(1).padStart(4, "0");
    return `${String(m).padStart(2, "0")}:${s}`;
  }

  function logLine(who, text) {
    const div = document.createElement("div");
    div.className = `log-line ${who}`;
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = formatClock(state.elapsedMs);
    div.appendChild(t);
    const body = document.createElement("span");
    body.innerHTML = text;
    div.appendChild(body);
    dom.battleLog.appendChild(div);
    while (dom.battleLog.childElementCount > 80) {
      dom.battleLog.removeChild(dom.battleLog.firstChild);
    }
  }

  /* -------------------------------- Meter ---------------------------------- */

  function updateAdvantageMeter(pdr) {
    state.advantageWindow.push(pdr);
    if (state.advantageWindow.length > ADVANTAGE_WINDOW) state.advantageWindow.shift();
    const avg = state.advantageWindow.reduce((a, b) => a + b, 0) / state.advantageWindow.length;
    // avg 0.5 -> even. avg 1 -> full anti-jammer advantage. avg 0 -> full jammer advantage.
    const advantage = (avg - 0.5) * 2; // -1..1
    const markerPct = 50 + advantage * 48;

    dom.meterMarker.style.left = `${markerPct}%`;
    if (advantage >= 0) {
      dom.meterFillAnti.style.width = `${advantage * 48}%`;
      dom.meterFillJam.style.width = `0%`;
    } else {
      dom.meterFillJam.style.width = `${-advantage * 48}%`;
      dom.meterFillAnti.style.width = `0%`;
    }

    if (Math.abs(advantage) < 0.08) dom.meterReadout.textContent = "EVEN";
    else if (advantage > 0) dom.meterReadout.textContent = `ANTI-JAMMER +${Math.round(advantage * 100)}`;
    else dom.meterReadout.textContent = `JAMMER +${Math.round(-advantage * 100)}`;
  }

  /* ------------------------------ Main tick -------------------------------- */

  function tick() {
    state.step++;
    state.elapsedMs += state.tickMs;

    const transmitting = true; // continuous background traffic model
    const jamResult = state.jammer.step(state.txChannel, transmitting);
    const profile = buildSpectrumProfile(state.numChannels, jamResult);

    const detected = state.classifier.classify(profile, transmitting);
    const counter = COUNTERMEASURES[detected];
    const applied = applyCountermeasure(counter, profile, state.numChannels, state.txChannel);

    // A reactive jammer with randomized-timing countermeasure sometimes misses.
    let effectiveProfile = profile;
    if (jamResult.mode === "REACTIVE_JAMMING" && applied.reactiveMissChance > 0 &&
        Math.random() < applied.reactiveMissChance) {
      effectiveProfile = profile.slice();
      effectiveProfile[applied.txChannel] = NOISE_FLOOR;
    }

    state.txChannel = applied.txChannel;

    const signalPower = TX_POWER_BASE * applied.txPowerMultiplier;
    const interference = Math.max(0.001, effectiveProfile[state.txChannel]);
    const sinrLinear = signalPower / interference;
    const sinrDb = 10 * Math.log10(sinrLinear);
    let pdr = sigmoidPdr(sinrDb);
    pdr = pdr + (1 - pdr) * applied.retryRecoveryRate;
    pdr = Math.min(1, Math.max(0, pdr));

    const attempted = randInt(40, 55);
    const received = Math.round(attempted * pdr);
    const blocked = attempted - received;

    state.totals.attempted += attempted;
    state.totals.blocked += blocked;
    state.totals.received += received;

    // battle log on transitions
    if (jamResult.changed) {
      logLine("jam", `<span class="who">JAMMER</span> switched to <b>${jamResult.mode}</b>`);
    }
    if (detected !== state.lastJamMode || counter !== state.lastCounter) {
      logLine("anti", `<span class="who">ANTI-JAM</span> detected <b>${detected}</b> → deployed <b>${counter}</b>`);
      state.lastJamMode = detected;
      state.lastCounter = counter;
    }

    // rolling series
    pushSeries(state.seriesLabels, state.step);
    pushSeries(state.jamNoiseSeries, Math.round(profile.reduce((a, b) => a + b, 0)));
    pushSeries(state.jamBlockedSeries, blocked);
    pushSeries(state.sentSeries, attempted);
    pushSeries(state.receivedSeries, received);

    updateAdvantageMeter(pdr);

    // --- render ---
    dom.simStep.textContent = state.step;
    dom.simClock.textContent = formatClock(state.elapsedMs);

    dom.jamModeLabel.textContent = jamResult.mode;
    dom.jamModeLabel.style.color = MODE_COLOR[jamResult.mode];
    dom.antiModeLabel.textContent = counter;

    dom.jamAttempted.textContent = state.totals.attempted;
    dom.jamBlocked.textContent = state.totals.blocked;
    dom.jamBlockRate.textContent = `${Math.round((state.totals.blocked / Math.max(1, state.totals.attempted)) * 100)}%`;

    dom.antiReceived.textContent = state.totals.received;
    dom.antiChannel.textContent = state.txChannel;
    dom.antiPdr.textContent = `${Math.round(pdr * 100)}%`;

    drawSpectrum(dom.jamSpectrum, profile, {
      baseColor: "#233241",
      hotColor: "#ff4b5c",
      highlightColor: "#ff4b5c",
      highlightChannel: -1,
    });

    drawSpectrum(dom.antiSpectrum, effectiveProfile, {
      baseColor: "#233241",
      hotColor: "#3a4a58",
      highlightColor: "#2fd9c4",
      highlightChannel: state.txChannel,
    });

    updateCharts();
  }

  /* ------------------------------- Controls -------------------------------- */

  function setRunning(run) {
    state.running = run;
    dom.btnStart.classList.toggle("primary", run);
    if (run) {
      if (state.timer) clearInterval(state.timer);
      state.timer = setInterval(tick, state.tickMs);
    } else if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function resetSimulation() {
    setRunning(false);
    state.step = 0;
    state.elapsedMs = 0;
    state.txChannel = Math.floor(state.numChannels / 2);
    state.jammer.setNumChannels(state.numChannels);
    state.classifier.setNumChannels(state.numChannels);
    state.lastJamMode = null;
    state.lastCounter = null;
    state.seriesLabels = [];
    state.jamNoiseSeries = [];
    state.jamBlockedSeries = [];
    state.sentSeries = [];
    state.receivedSeries = [];
    state.advantageWindow = [];
    state.totals = { attempted: 0, blocked: 0, received: 0 };

    dom.battleLog.innerHTML = "";
    logLine("sys", `Simulation reset — protocol ${PROTOCOLS[state.proto].label}`);

    dom.jamAttempted.textContent = "0";
    dom.jamBlocked.textContent = "0";
    dom.jamBlockRate.textContent = "0%";
    dom.antiReceived.textContent = "0";
    dom.antiChannel.textContent = String(state.txChannel);
    dom.antiPdr.textContent = "0%";
    dom.jamModeLabel.textContent = "NO_JAMMING";
    dom.antiModeLabel.textContent = "NORMAL_OPERATION";
    dom.meterMarker.style.left = "50%";
    dom.meterFillJam.style.width = "0%";
    dom.meterFillAnti.style.width = "0%";
    dom.meterReadout.textContent = "EVEN";

    updateCharts();
  }

  function setProtocol(proto) {
    state.proto = proto;
    state.numChannels = PROTOCOLS[proto].numChannels;
    dom.protoWifi.classList.toggle("active", proto === "WIFI");
    dom.protoBt.classList.toggle("active", proto === "BLUETOOTH");
    resetSimulation();
  }

  function wireControls() {
    dom.btnStart.addEventListener("click", () => setRunning(true));
    dom.btnPause.addEventListener("click", () => setRunning(false));
    dom.btnReset.addEventListener("click", resetSimulation);

    dom.protoWifi.addEventListener("click", () => setProtocol("WIFI"));
    dom.protoBt.addEventListener("click", () => setProtocol("BLUETOOTH"));

    dom.speedSlider.addEventListener("input", () => {
      const v = Number(dom.speedSlider.value); // 1..6
      const multiplier = v * 0.5; // 0.5x .. 3x
      dom.speedValue.textContent = `${multiplier.toFixed(1)}x`;
      state.tickMs = Math.round(300 / multiplier);
      if (state.running) setRunning(true); // restart interval at new speed
    });

    dom.overrideButtons.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (!btn) return;
      [...dom.overrideButtons.children].forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.jammer.setOverride(btn.dataset.mode);
      logLine("sys", `Manual override → jammer forced to <b>${btn.dataset.mode}</b>`);
    });
  }

  /* -------------------------------- Boot ----------------------------------- */

  function boot() {
    // Wire the controls FIRST. If anything below throws, Start/Pause/Reset
    // and the override buttons still respond instead of going dead.
    wireControls();
    try {
      initCharts();
      dom.speedSlider.dispatchEvent(new Event("input"));
      resetSimulation();
    } catch (err) {
      console.error("Spectrum Warfare failed to fully initialize:", err);
      logLine("sys", `⚠ Startup warning: ${String(err.message || err)} — controls should still work.`);
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
