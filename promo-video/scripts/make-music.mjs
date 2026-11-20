// Procedurally synthesized, royalty-free soundtrack for AgentUSDefense.
// Usage: node scripts/make-music.mjs out/music.wav
import fs from "node:fs";

const SR = 44100;
const DUR = 93.2;
const N = Math.ceil(SR * DUR);
const L = new Float32Array(N);
const R = new Float32Array(N);
const sendL = new Float32Array(N); // reverb send
const sendR = new Float32Array(N);

const BPM = 96;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
// scene boundaries (seconds) — must match theme.ts SCENES at 60fps
const CUTS = [5.0, 10.5, 19.5, 38.5, 49.5, 61.5, 70.5, 79.5, 86.5];
const DRUMS_ON = 19.5;
const DRUMS_OFF = 86.5;
const ARP_ON = 10.5;

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
// C major: Fmaj7 – G6 – Em7 – Am9
const CHORDS = [
  [53, 57, 60, 64], // F A C E
  [55, 59, 62, 64], // G B D E
  [52, 55, 59, 62], // E G B D
  [57, 60, 64, 71], // A C E B
];
const FINAL = [48, 55, 59, 62, 64]; // Cmaj9

let seed = 1234567;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

const add = (i, l, r, send = 0) => {
  if (i < 0 || i >= N) return;
  L[i] += l;
  R[i] += r;
  if (send) {
    sendL[i] += l * send;
    sendR[i] += r * send;
  }
};

const chordAt = (t) => (t >= 86.5 ? FINAL : CHORDS[Math.floor(t / BAR) % 4]);

/* ------------------------------- Pad layer ------------------------------- */
{
  const phases = new Map();
  let lp = [0, 0];
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const bar = Math.floor(t / BAR);
    const inBar = t - bar * BAR;
    const cur = chordAt(t);
    const prev = t >= 86.5 && t < 86.5 + 1.2 ? CHORDS[Math.floor(86.4 / BAR) % 4] : CHORDS[(bar + 3) % 4];
    const xf = t >= 86.5 ? Math.min(1, (t - 86.5) / 1.2) : Math.min(1, inBar / 0.6);
    let sl = 0;
    let sr = 0;
    const voice = (notes, gain) => {
      notes.forEach((m, k) => {
        for (const [det, side] of [
          [-0.0025, 0],
          [0.0025, 1],
        ]) {
          const key = `${m}:${side}`;
          const f = mtof(m) * (1 + det);
          const ph = (phases.get(key) ?? k * 0.37) + f / SR;
          phases.set(key, ph % 1);
          const s =
            Math.sin(2 * Math.PI * ph) +
            0.35 * Math.sin(4 * Math.PI * ph) +
            0.12 * Math.sin(6 * Math.PI * ph);
          if (side === 0) sl += s * gain;
          else sr += s * gain;
        }
      });
    };
    voice(cur, xf);
    if (xf < 1) voice(prev, 1 - xf);
    // gentle breathing + global envelope
    const breathe = 0.85 + 0.15 * Math.sin(2 * Math.PI * t / (BAR * 2));
    let env = Math.min(1, t / 3.5);
    if (t > DUR - 5) env *= Math.max(0, (DUR - 0.4 - t) / 4.6);
    const g = 0.028 * breathe * env * (t >= DRUMS_ON && t < DRUMS_OFF ? 0.8 : 1);
    // warm one-pole low-pass
    const a = 0.08;
    lp[0] += a * (sl - lp[0]);
    lp[1] += a * (sr - lp[1]);
    add(i, lp[0] * g, lp[1] * g, 0.6);
  }
}

/* ----------------------------- Pluck arpeggio ---------------------------- */
const pluck = (t0, midi, vel, pan, dur = 0.9) => {
  const f = mtof(midi);
  const s0 = Math.floor(t0 * SR);
  const n = Math.floor(dur * SR);
  for (let j = 0; j < n; j++) {
    const tt = j / SR;
    const env = Math.min(1, tt / 0.004) * Math.exp(-tt * 6.5);
    const s = (Math.sin(2 * Math.PI * f * tt) + 0.25 * Math.sin(4 * Math.PI * f * tt) * Math.exp(-tt * 12)) * env * vel;
    add(s0 + j, s * (1 - pan) * 1.4, s * pan * 1.4, 0.45);
  }
};
{
  const pattern = [0, 2, 1, 3, 2, 1, 3, 2];
  for (let t = ARP_ON; t < DRUMS_OFF - 0.01; t += BEAT / 2) {
    const step = Math.round((t - ARP_ON) / (BEAT / 2));
    const ch = chordAt(t + 0.001);
    const idx = pattern[step % 8];
    const midi = ch[idx % ch.length] + 12;
    const fadeIn = Math.min(1, (t - ARP_ON) / 4);
    const vel = 0.05 * fadeIn * (step % 2 === 0 ? 1 : 0.7);
    const pan = 0.5 + 0.3 * Math.sin(step * 0.9);
    pluck(t, midi, vel, pan);
    // ping-pong echo (dotted eighth)
    pluck(t + BEAT * 0.75, midi, vel * 0.38, 1 - pan);
    pluck(t + BEAT * 1.5, midi, vel * 0.16, pan);
  }
}

/* --------------------------------- Bells --------------------------------- */
const bell = (t0, midi, vel) => {
  const f = mtof(midi);
  const s0 = Math.floor(t0 * SR);
  const n = Math.floor(3.5 * SR);
  for (let j = 0; j < n; j++) {
    const tt = j / SR;
    const env = Math.min(1, tt / 0.003) * Math.exp(-tt * 1.6);
    const s =
      (Math.sin(2 * Math.PI * f * tt) +
        0.5 * Math.sin(2 * Math.PI * f * 2.76 * tt) * Math.exp(-tt * 3) +
        0.25 * Math.sin(2 * Math.PI * f * 5.4 * tt) * Math.exp(-tt * 6)) *
      env *
      vel;
    add(s0 + j, s, s, 0.8);
  }
};
bell(0.25, 76, 0.07);
bell(0.75, 83, 0.045);
bell(86.6, 72, 0.08);
bell(87.1, 79, 0.06);
bell(87.6, 84, 0.05);

/* ------------------------------- Drums ---------------------------------- */
const kick = (t0, vel) => {
  const s0 = Math.floor(t0 * SR);
  let ph = 0;
  for (let j = 0; j < 0.45 * SR; j++) {
    const tt = j / SR;
    const f = 45 + 95 * Math.exp(-tt * 28);
    ph += f / SR;
    const s = Math.sin(2 * Math.PI * ph) * Math.exp(-tt * 7.5) * vel;
    add(s0 + j, s, s, 0);
  }
};
const hat = (t0, vel) => {
  const s0 = Math.floor(t0 * SR);
  let prev = 0;
  for (let j = 0; j < 0.06 * SR; j++) {
    const tt = j / SR;
    const w = rnd();
    const hp = w - prev;
    prev = w;
    const s = hp * Math.exp(-tt * 70) * vel;
    add(s0 + j, s * 0.8, s, 0.1);
  }
};
const bass = (t0, midi, vel, dur) => {
  const f = mtof(midi);
  const s0 = Math.floor(t0 * SR);
  for (let j = 0; j < dur * SR; j++) {
    const tt = j / SR;
    const env = Math.min(1, tt / 0.01) * Math.exp(-tt * 2.2) * Math.min(1, (dur - tt) / 0.05);
    const s = (Math.sin(2 * Math.PI * f * tt) + 0.2 * Math.sin(4 * Math.PI * f * tt)) * env * vel;
    add(s0 + j, s, s, 0);
  }
};
{
  for (let t = DRUMS_ON; t < DRUMS_OFF - 0.01; t += BEAT) {
    const beatIdx = Math.round((t - DRUMS_ON) / BEAT);
    const intro = Math.min(1, (t - DRUMS_ON) / 3);
    // lighter groove in ecosystem/architecture section
    const light = t >= 61.5 && t < 70.5 ? 0.6 : 1;
    kick(t, 0.32 * intro * light);
    hat(t + BEAT / 2, 0.06 * intro * light);
    if (beatIdx % 2 === 1) hat(t + BEAT * 0.75, 0.03 * intro * light);
    const root = chordAt(t + 0.001)[0] - 24;
    bass(t, root, 0.14 * intro, BEAT * 0.95);
  }
}

/* --------------------------- Transitions FX ------------------------------ */
const riser = (tEnd, len, vel) => {
  const s0 = Math.floor((tEnd - len) * SR);
  let lpv = 0;
  for (let j = 0; j < len * SR; j++) {
    const p = j / (len * SR);
    const a = 0.02 + 0.25 * p * p;
    lpv += a * (rnd() - lpv);
    const s = lpv * p * p * vel;
    add(s0 + j, s * (1 - p * 0.3), s * (0.7 + p * 0.3), 0.5);
  }
};
const impact = (t0, vel) => {
  const s0 = Math.floor(t0 * SR);
  let ph = 0;
  for (let j = 0; j < 1.6 * SR; j++) {
    const tt = j / SR;
    ph += (38 + 40 * Math.exp(-tt * 10)) / SR;
    const s = Math.sin(2 * Math.PI * ph) * Math.exp(-tt * 2.6) * vel;
    add(s0 + j, s, s, 0.3);
  }
};
for (const c of CUTS) {
  riser(c, 1.4, 0.22);
  impact(c, 0.22);
}

/* ------------------------------- Reverb ---------------------------------- */
const reverb = (inp, out, offs) => {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => ({ buf: new Float32Array(d + offs), i: 0, lp: 0 }));
  const aps = [225, 556, 441].map((d) => ({ buf: new Float32Array(d), i: 0 }));
  for (let n = 0; n < N; n++) {
    const x = inp[n];
    let y = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.lp = o * 0.7 + c.lp * 0.3;
      c.buf[c.i] = x + c.lp * 0.84;
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
    out[n] += y * 0.9;
  }
};
reverb(sendL, L, 0);
reverb(sendR, R, 23);

/* ------------------------------- Master ---------------------------------- */
let peak = 0;
for (let i = 0; i < N; i++) {
  L[i] = Math.tanh(L[i] * 1.6);
  R[i] = Math.tanh(R[i] * 1.6);
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
const out = process.argv[2] ?? "out/music.wav";
fs.writeFileSync(out, buf);
console.log("wrote", out, "peak", peak.toFixed(3));
