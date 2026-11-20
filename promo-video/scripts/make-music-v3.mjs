// Synced 110.4s felt-piano + warm synth keynote soundtrack for AgentUSDefenseV3 (6600 frames @ 60fps).
import fs from "node:fs";

const SR = 44100;
const DUR = 110.4;
const N = Math.ceil(SR * DUR);
const L = new Float32Array(N);
const R = new Float32Array(N);
const revL = new Float32Array(N);
const revR = new Float32Array(N);

const BPM = 102;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;

// Scene boundaries in seconds matching V3_SCENES:
// 660(11s), 780(24s), 540(33s), 1440(57s), 600(67s), 720(79s), 900(94s), 600(104s), 360(110s)
const CUTS = [5.8, 11.0, 24.0, 33.0, 57.0, 67.0, 79.0, 86.2, 94.0, 104.0];

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const CHORDS = [
  [55, 59, 62, 66], // Gmaj7
  [57, 61, 64, 66], // A6
  [54, 57, 61, 64], // F#m7
  [59, 62, 66, 69], // Bm7
];
const RESOLVE = [50, 57, 62, 66, 69, 73]; // Dmaj9

let seed = 24681357;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

const add = (i, l, r, send = 0) => {
  if (i < 0 || i >= N) return;
  L[i] += l;
  R[i] += r;
  if (send) {
    revL[i] += l * send;
    revR[i] += r * send;
  }
};

const chordAt = (t) => (t >= 104.0 ? RESOLVE : CHORDS[Math.floor(t / BAR) % 4]);

/* -------------------------- 1. Lush Stereo Pad -------------------------- */
{
  const phases = new Map();
  let lpL = 0;
  let lpR = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const bar = Math.floor(t / BAR);
    const inBar = t - bar * BAR;
    const cur = chordAt(t);
    const prev = t >= 104.0 && t < 105.6 ? CHORDS[Math.floor(103.9 / BAR) % 4] : CHORDS[(bar + 3) % 4];
    const xf = t >= 104.0 ? Math.min(1, (t - 104.0) / 1.5) : Math.min(1, inBar / 0.75);

    let sl = 0;
    let sr = 0;
    const synthVoice = (notes, gain) => {
      notes.forEach((m, k) => {
        for (const [det, side] of [[-0.0022, 0], [0.0022, 1]]) {
          const key = `${m}:${side}`;
          const freq = mtof(m) * (1 + det);
          const ph = ((phases.get(key) ?? k * 0.29) + freq / SR) % 1;
          phases.set(key, ph);
          const wave =
            Math.sin(2 * Math.PI * ph) +
            0.28 * Math.sin(4 * Math.PI * ph) +
            0.09 * Math.sin(6 * Math.PI * ph);
          if (side === 0) sl += wave * gain;
          else sr += wave * gain;
        }
      });
    };
    synthVoice(cur, xf);
    if (xf < 1) synthVoice(prev, 1 - xf);

    const breathe = 0.86 + 0.14 * Math.sin((2 * Math.PI * t) / (BAR * 2));
    let env = Math.min(1, t / 2.6);
    if (t > 105.5) env *= Math.max(0, (DUR - 0.5 - t) / 4.4);
    const lift = (t >= 33.0 && t < 57.0) || (t >= 79.0 && t < 94.0) ? 1.06 : 0.88;
    const g = 0.025 * breathe * env * lift;

    const alpha = 0.065;
    lpL += alpha * (sl - lpL);
    lpR += alpha * (sr - lpR);
    add(i, lpL * g, lpR * g, 0.72);
  }
}

/* ------------------------ 2. Warm Felt Electric Piano ------------------- */
const feltPiano = (t0, midi, vel, pan = 0.5, dur = 2.4) => {
  const f = mtof(midi);
  const s0 = Math.floor(t0 * SR);
  const n = Math.floor(dur * SR);
  for (let j = 0; j < n; j++) {
    const tt = j / SR;
    const attack = Math.min(1, tt / 0.012);
    const decay = Math.exp(-tt * 2.15);
    const s =
      (Math.sin(2 * Math.PI * f * tt) +
        0.32 * Math.sin(4 * Math.PI * f * tt) * Math.exp(-tt * 5.0) +
        0.10 * Math.sin(6 * Math.PI * f * tt) * Math.exp(-tt * 9.5) +
        0.04 * Math.sin(2 * Math.PI * f * 3.01 * tt) * Math.exp(-tt * 14)) *
      attack *
      decay *
      vel;
    add(s0 + j, s * (1 - pan) * 1.4, s * pan * 1.4, 0.62);
  }
};

// Intro delicate notes
feltPiano(0.3, 62, 0.09, 0.35, 3.0);
feltPiano(0.9, 66, 0.08, 0.55, 3.0);
feltPiano(1.5, 69, 0.08, 0.65, 3.2);
feltPiano(2.7, 73, 0.075, 0.45, 3.4);
feltPiano(5.8, 62, 0.11, 0.4, 3.5);
feltPiano(6.1, 69, 0.095, 0.6, 3.5);
feltPiano(6.4, 74, 0.095, 0.5, 3.8);

// Main body piano arpeggio (11.0s -> 103.6s)
{
  const motif = [0, 2, 3, 2, 1, 3, 2, 0];
  for (let t = 11.0; t < 103.6; t += BEAT / 2) {
    const step = Math.round((t - 11.0) / (BEAT / 2));
    const ch = chordAt(t + 0.01);
    const idx = motif[step % 8];
    const octave = step % 4 === 2 ? 24 : 12;
    const midi = ch[idx % ch.length] + octave;
    const fadeIn = Math.min(1, (t - 11.0) / 2.2);
    const accent = step % 4 === 0 ? 1.0 : step % 2 === 0 ? 0.72 : 0.48;
    const pan = 0.5 + 0.28 * Math.sin(step * 0.75);
    const energy =
      t >= 79.0 && t < 94.0 ? 1.12 : // Benchmark climax!
      t >= 33.0 && t < 57.0 ? 1.02 :
      t >= 57.0 && t < 67.0 ? 0.82 :
      0.94;
    feltPiano(t, midi, 0.056 * fadeIn * accent * energy, pan, 1.45);
    if (step % 8 === 0) {
      feltPiano(t, ch[0], 0.075 * fadeIn * energy, 0.45, 2.4);
      feltPiano(t + 0.04, ch[2], 0.06 * fadeIn * energy, 0.58, 2.2);
    }
  }
}

// Finale sparkling Dmaj9 chord (104.0s)
[50, 57, 62, 66, 69, 74, 78].forEach((m, k) => {
  feltPiano(104.05 + k * 0.14, m, 0.085 - k * 0.005, 0.35 + k * 0.05, 5.2);
});

/* ------------------- 3. Soft Brushed Pulse & Warm Sub-Bass -------------- */
const softKick = (t0, vel) => {
  const s0 = Math.floor(t0 * SR);
  let ph = 0;
  for (let j = 0; j < 0.36 * SR; j++) {
    const tt = j / SR;
    const f = 46 + 68 * Math.exp(-tt * 24);
    ph += f / SR;
    const s = Math.sin(2 * Math.PI * ph) * Math.min(1, tt / 0.006) * Math.exp(-tt * 9.0) * vel;
    add(s0 + j, s, s, 0.05);
  }
};

const softShaker = (t0, vel, pan = 0.5) => {
  const s0 = Math.floor(t0 * SR);
  let prev = 0;
  let lp = 0;
  for (let j = 0; j < 0.045 * SR; j++) {
    const tt = j / SR;
    const w = rnd();
    const hp = w - prev * 0.88;
    prev = w;
    lp += 0.35 * (hp - lp);
    const s = lp * Math.min(1, tt / 0.004) * Math.exp(-tt * 82) * vel;
    add(s0 + j, s * (1 - pan) * 1.4, s * pan * 1.4, 0.18);
  }
};

const warmBass = (t0, midi, vel, dur) => {
  const f = mtof(midi);
  const s0 = Math.floor(t0 * SR);
  for (let j = 0; j < dur * SR; j++) {
    const tt = j / SR;
    const env = Math.min(1, tt / 0.025) * Math.exp(-tt * 1.4) * Math.min(1, (dur - tt) / 0.08);
    const s = (Math.sin(2 * Math.PI * f * tt) + 0.16 * Math.sin(4 * Math.PI * f * tt)) * env * vel;
    add(s0 + j, s, s, 0);
  }
};

for (let t = 11.0; t < 103.8; t += BEAT) {
  const b = Math.round((t - 11.0) / BEAT);
  const intro = Math.min(1, (t - 11.0) / 3.0);
  const dyn =
    t >= 79.0 && t < 94.0 ? 1.08 :
    t >= 57.0 && t < 67.0 ? 0.65 :
    0.90;
  if (b % 2 === 0) softKick(t, 0.24 * intro * dyn);
  else softKick(t, 0.12 * intro * dyn);
  softShaker(t + BEAT * 0.5, 0.036 * intro * dyn, b % 2 === 0 ? 0.35 : 0.65);
  if (b % 4 === 0) {
    const root = chordAt(t + 0.01)[0] - 24;
    warmBass(t, root, 0.15 * intro * dyn, BAR * 0.96);
  }
}

/* --------------------- 4. Silky Airy Scene Transitions ------------------ */
const airSwell = (tEnd, len, vel) => {
  const s0 = Math.floor((tEnd - len) * SR);
  let lp = 0;
  for (let j = 0; j < len * SR; j++) {
    const p = j / (len * SR);
    const alpha = 0.015 + 0.16 * p * p;
    lp += alpha * (rnd() - lp);
    const s = lp * Math.sin(p * Math.PI * 0.5) * p * vel;
    add(s0 + j, s * (1 - p * 0.25), s * (0.75 + p * 0.25), 0.7);
  }
};
const softDrop = (t0, vel) => {
  const s0 = Math.floor(t0 * SR);
  let ph = 0;
  for (let j = 0; j < 1.3 * SR; j++) {
    const tt = j / SR;
    ph += (42 + 34 * Math.exp(-tt * 9)) / SR;
    const s = Math.sin(2 * Math.PI * ph) * Math.min(1, tt / 0.01) * Math.exp(-tt * 3.0) * vel;
    add(s0 + j, s, s, 0.35);
  }
};

for (const c of CUTS) {
  airSwell(c, 1.2, 0.14);
  softDrop(c, 0.17);
}

/* -------------------------- 5. Lush Hall Reverb ------------------------- */
const reverb = (inp, out, offs) => {
  const combs = [1687, 1783, 1559, 1493, 1361, 1291].map((d) => ({ buf: new Float32Array(d + offs), i: 0, lp: 0 }));
  const aps = [241, 563, 449].map((d) => ({ buf: new Float32Array(d), i: 0 }));
  for (let n = 0; n < N; n++) {
    const x = inp[n];
    let y = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.lp = o * 0.68 + c.lp * 0.32;
      c.buf[c.i] = x + c.lp * 0.86;
      c.i = (c.i + 1) % c.buf.length;
      y += o;
    }
    y /= combs.length;
    for (const a of aps) {
      const b = a.buf[a.i];
      const v = y + b * 0.5;
      a.buf[a.i] = v;
      a.i = (a.i + 1) % a.buf.length;
      y = b - v * 0.5;
    }
    out[n] += y * 0.88;
  }
};
reverb(revL, L, 0);
reverb(revR, R, 29);

/* ----------------------------- 6. Mastering ----------------------------- */
let peak = 0;
for (let i = 0; i < N; i++) {
  L[i] = Math.tanh(L[i] * 1.45);
  R[i] = Math.tanh(R[i] * 1.45);
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = 0.89 / peak;
const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + N * 4, 4);
buf.write("WAVEfmt ", 8);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * norm)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * norm)) * 32767), 46 + i * 4);
}
const out = process.argv[2] ?? "out/music-v3.wav";
fs.writeFileSync(out, buf);
console.log("wrote", out, "peak", peak.toFixed(3));
