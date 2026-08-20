// Single-voice Web Audio synthesis for Guitar Orbit: a Karplus-Strong
// plucked-string model (public/karplus-strong-processor.js, run through a
// single AudioWorkletNode), through a low-pass filter and a short output
// gain ramp, into a single shared dynamics compressor and then
// AudioContext.destination. The string itself --- not a scripted gain
// envelope --- produces the pluck's attack and decay: a short noise burst
// excites a pitch-length feedback loop, and the loop's own damping filter
// bleeds off energy every time round, exactly like a real plucked string.
// The AudioContext (the compressor and the worklet module, which only need
// to exist once) are created lazily on the first user gesture that calls
// startVoice --- never at module load, per the autoplay policy. Only ever
// one voice exists at a time; main.ts is responsible for calling these in
// response to pointer/ring/register transitions, not this module.

// --- Pluck timbre: Karplus-Strong string ------------------------------

// The feedback loop's per-round decay coefficient (see
// public/karplus-strong-processor.js): the two-sample average that forms
// the loop's damping filter is scaled by this every pass. Below 1 so every
// note always dies away to silence rather than sustaining forever; because
// the loop repeats once per period of the note, this single fixed value
// already makes higher notes ring for a shorter real-world time than lower
// ones, with no per-note tuning needed.
export const STRING_DECAY = 0.996;

// The amplitude of the noise burst that excites the string on every pluck
// (see the "pluck" message in startVoice/articulateNoteChange). Kept below 1
// so the burst itself never clips before the filter/gain stage.
export const EXCITE_GAIN = 0.8;

// The voice's flat output ceiling. Unlike the old PEAK_GAIN, this isn't the
// peak of a scripted decay curve --- the string model's own amplitude
// already falls away naturally --- it's just the headroom-safe level the
// whole (already-decaying) signal is scaled to.
export const OUTPUT_GAIN = 0.5;

// How long the output GainNode ramps from 0 up to OUTPUT_GAIN when a voice
// starts or re-plucks --- just long enough (a few milliseconds) to avoid a
// hard digital click at the instant the node connects, not a shaping
// envelope: the audible attack character comes from the noise burst itself.
export const ATTACK_SECONDS = 0.005;

// How long the output gain takes to fade to 0 once the pointer lifts/leaves.
export const RELEASE_SECONDS = 0.1;

// How long a filter-cutoff glide takes to settle (setTargetAtTime's time
// constant), used when the angle changes without a new pluck.
const GLIDE_TIME_CONSTANT = 0.02;

// The low-pass filter cutoff range the normalized pointer angle sweeps
// across, mapped exponentially (cutoff frequency perception is logarithmic).
export const MIN_CUTOFF_HZ = 700;
export const MAX_CUTOFF_HZ = 12000;

// A safety margin kept below the Nyquist frequency (half the AudioContext's
// sample rate): a BiquadFilterNode cutoff at or above Nyquist is undefined
// behaviour, and not every runtime uses the same sample rate. MAX_CUTOFF_HZ
// (12000 Hz) sits comfortably under Nyquist at the common 44.1/48 kHz rates,
// but every cutoff actually written to a filter node is still run through
// clampToNyquist below rather than assuming that.
const NYQUIST_SAFETY_MARGIN_HZ = 100;

function clampToNyquist(hz: number, ctx: AudioContext): number {
  return Math.min(hz, ctx.sampleRate / 2 - NYQUIST_SAFETY_MARGIN_HZ);
}

// Butterworth Q (1/sqrt(2)): the largest Q with no resonant peak in the
// passband. Keeps the filter's sweep a tone control, not a synth-sweep
// resonance, so the pluck stays recognisable across the whole angle range.
export const FILTER_Q = 0.7071067811865476;

// A note-change re-articulation briefly brightens the filter (see
// articulateNoteChange) by this multiple of the angle's own cutoff, clamped
// to MAX_CUTOFF_HZ so it can never exceed the angle sweep's own ceiling.
export const REARTICULATION_BRIGHTNESS_MULTIPLIER = 1.8;

// The brightness accent's own decay back toward the angle-controlled cutoff.
// Deliberately slower than GLIDE_TIME_CONSTANT (which exists for continuous,
// imperceptible pointer tracking) --- this one needs to be slow enough to be
// heard as a decaying shimmer, but still short enough to stay "brief" and
// not read as a filter sweep.
export const BRIGHTNESS_DECAY_TIME_CONSTANT = 0.05;

// How long updateVoiceFilterCutoff defers to the brightness accent's own
// decay curve (see articulateNoteChange) before resuming normal per-move
// angle tracking. Three time constants, so the accent's exponential curve
// has settled to about 95% of the way back down before continuous tracking
// resumes and takes over without an audible jump.
export const BRIGHTNESS_HOLD_SECONDS = BRIGHTNESS_DECAY_TIME_CONSTANT * 3;

// The very first pluck of a voice gets its own brightness accent (see
// startVoice), reusing the exact same mechanism as the note-change accent
// above but with its own multiplier/timing: every note's initial attack
// should have a bright pick transient, not only the note-to-note changes.
export const INITIAL_PLUCK_BRIGHTNESS_MULTIPLIER = 1.8;
export const INITIAL_PLUCK_BRIGHTNESS_DECAY_TIME_CONSTANT = 0.045;
export const INITIAL_PLUCK_BRIGHTNESS_HOLD_SECONDS = INITIAL_PLUCK_BRIGHTNESS_DECAY_TIME_CONSTANT * 3;

// Standard equal-tempered concert-pitch (A4 = 440 Hz) frequencies, rounded to
// two decimal places, for every note this instrument can play: five note
// families (E, G, A, B, D --- see geometry.ts's NOTES) across three
// registers each (see geometry.ts's Register/BASE_OCTAVE), chosen after
// checking this range stays comfortably inside where a Karplus-Strong
// string sounds clean and stable (roughly 70-500 Hz here; well clear of the
// very-short-buffer top end and the very-long-decay bottom end where the
// model starts sounding unstable or unpleasant).
const NOTE_FREQUENCIES: Record<string, number> = {
  D2: 73.42,
  E2: 82.41,
  G2: 98.0,
  A2: 110.0,
  B2: 123.47,
  D3: 146.83,
  E3: 164.81,
  G3: 196.0,
  A3: 220.0,
  B3: 246.94,
  D4: 293.66,
  E4: 329.63,
  G4: 392.0,
  A4: 440.0,
  B4: 493.88,
};

export function noteFrequency(note: string): number {
  return NOTE_FREQUENCIES[note] ?? 0;
}

// normalizedAngle is in [0, 1); an exponential sweep across the cutoff range
// so equal steps in angle feel like equal steps in perceived brightness.
export function cutoffForNormalizedAngle(normalizedAngle: number): number {
  const ratio = MAX_CUTOFF_HZ / MIN_CUTOFF_HZ;
  return MIN_CUTOFF_HZ * Math.pow(ratio, normalizedAngle);
}

// The brief brightness ceiling a note-change re-articulation jumps the
// filter to, before it glides back down toward the angle's own cutoff. Pure
// and clamped, so it's testable without an AudioContext.
export function brightnessAccentCutoff(normalizedAngle: number): number {
  return Math.min(
    MAX_CUTOFF_HZ,
    cutoffForNormalizedAngle(normalizedAngle) * REARTICULATION_BRIGHTNESS_MULTIPLIER,
  );
}

// The same idea as brightnessAccentCutoff, but for a brand-new voice's very
// first pluck (see startVoice) rather than a note change mid-drag --- its
// own multiplier, same clamping.
export function initialPluckBrightnessCutoff(normalizedAngle: number): number {
  return Math.min(
    MAX_CUTOFF_HZ,
    cutoffForNormalizedAngle(normalizedAngle) * INITIAL_PLUCK_BRIGHTNESS_MULTIPLIER,
  );
}

interface Voice {
  workletNode: AudioWorkletNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  // Until this AudioContext time, updateVoiceFilterCutoff defers to the
  // brightness accent's own decay curve instead of issuing a competing
  // glide (see articulateNoteChange/startVoice).
  brightnessAccentUntil: number;
}

export type VoiceState = "idle" | "active" | "releasing";
type VoiceAction = "start" | "release" | "end";

// Pure state transition table for the voice lifecycle: idle -> active ->
// releasing -> idle. No AudioContext here --- this is the part of the
// lifecycle that can be reasoned about (and tested) without one. An action
// that doesn't apply to the current state is a no-op (returns the same
// state unchanged), which is what lets startVoice/releaseVoice each just
// call this and only act when it actually changed something: a "start"
// while already active/releasing is ignored, a "release" while not active
// is ignored, and the state only reaches idle again once "end" fires from
// releasing.
export function nextVoiceState(current: VoiceState, action: VoiceAction): VoiceState {
  if (action === "start" && current === "idle") return "active";
  if (action === "release" && current === "active") return "releasing";
  if (action === "end" && current === "releasing") return "idle";
  return current;
}

let audioContext: AudioContext | null = null;
let compressor: DynamicsCompressorNode | null = null;
let workletModulePromise: Promise<void> | null = null;
let voice: Voice | null = null;
let state: VoiceState = "idle";

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  if (audioContext.state === "suspended") {
    void audioContext.resume();
  }
  return audioContext;
}

// A single shared compressor, the last stop before destination for every
// voice this module ever creates. Gentle by design: it exists to keep the
// pluck's attack transient and the re-articulation accents from ever
// clipping or feeling harsh under repeated dragging, not to squash the
// sound flat like a limiter.
function getCompressor(ctx: AudioContext): DynamicsCompressorNode {
  if (!compressor) {
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 18;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;
    compressor.connect(ctx.destination);
  }
  return compressor;
}

// Loads the Karplus-Strong AudioWorkletProcessor module, once per
// AudioContext. Resolved against document.baseURI (the deployed page's own
// URL, including its GitHub Pages subpath), not import.meta.url --- the
// latter would resolve relative to this module's bundled/hashed chunk in
// dist/, not the site root where public/karplus-strong-processor.js is
// actually served.
function ensureWorkletModule(ctx: AudioContext): Promise<void> {
  if (!workletModulePromise) {
    const moduleUrl = new URL("karplus-strong-processor.js", document.baseURI).toString();
    workletModulePromise = ctx.audioWorklet.addModule(moduleUrl);
  }
  return workletModulePromise;
}

// Builds the one voice's node graph and immediately plucks it for `note`.
// Only ever called once the worklet module is confirmed loaded (see
// startVoice).
function createVoiceNodes(ctx: AudioContext, note: string, normalizedAngle: number): Voice {
  const now = ctx.currentTime;

  const workletNode = new AudioWorkletNode(ctx, "karplus-strong", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();

  filter.type = "lowpass";
  filter.Q.value = FILTER_Q;
  // The very first pluck gets its own bright pick transient: start above
  // the angle's normal cutoff, then decay smoothly down to it, reusing the
  // same brightness-accent mechanism articulateNoteChange uses below.
  filter.frequency.setValueAtTime(clampToNyquist(initialPluckBrightnessCutoff(normalizedAngle), ctx), now);
  filter.frequency.setTargetAtTime(
    clampToNyquist(cutoffForNormalizedAngle(normalizedAngle), ctx),
    now,
    INITIAL_PLUCK_BRIGHTNESS_DECAY_TIME_CONSTANT,
  );

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(OUTPUT_GAIN, now + ATTACK_SECONDS);

  workletNode.connect(filter);
  filter.connect(gain);
  gain.connect(getCompressor(ctx));

  workletNode.port.postMessage({
    type: "pluck",
    frequency: noteFrequency(note),
    decay: STRING_DECAY,
    exciteGain: EXCITE_GAIN,
  });

  return {
    workletNode,
    filter,
    gain,
    brightnessAccentUntil: now + INITIAL_PLUCK_BRIGHTNESS_HOLD_SECONDS,
  };
}

export function voiceState(): VoiceState {
  return state;
}

// Starts a brand-new voice. Only actually creates anything when the
// lifecycle is idle --- a call while active or releasing is silently
// ignored, so a second string is never connected while a previous one is
// still sounding (including its release tail). Callers (main.ts) should
// also check voiceState() before adopting a new pointer as the active one,
// so a press during a release doesn't even get this far, but the guard here
// is what actually prevents polyphony.
//
// The AudioWorkletNode can't be created until its module has finished
// loading (addModule is asynchronous), so the state transition happens
// synchronously here --- preserving the no-polyphony guarantee even during
// that gap --- and the actual node graph is built inside the resulting
// promise's callback, which re-checks the state first: if a release arrived
// before the module finished loading, there's no voice to release, so it
// simply finishes that release's lifecycle (releasing -> idle) instead of
// building a voice that would immediately need tearing down.
export function startVoice(note: string, normalizedAngle: number): void {
  const next = nextVoiceState(state, "start");
  if (next === state) return; // not idle --- ignore
  state = next;

  const ctx = getAudioContext();
  ensureWorkletModule(ctx)
    .then(() => {
      if (state !== "active") {
        if (state === "releasing") state = nextVoiceState(state, "end");
        return;
      }
      voice = createVoiceNodes(ctx, note, normalizedAngle);
    })
    .catch(() => {
      state = "idle";
    });
}

// Interrupts whatever the output gain is currently doing and holds it at
// that exact value, with no click --- the shared primitive behind both
// releaseVoice and articulateNoteChange.
function holdCurrentGain(gainParam: AudioParam, now: number): void {
  if (typeof gainParam.cancelAndHoldAtTime === "function") {
    // The correct sample-and-hold primitive for interrupting an in-progress
    // ramp: cancels every scheduled change after `now` and holds the param
    // at whatever value its automation curve had actually reached at `now`.
    gainParam.cancelAndHoldAtTime(now);
  } else {
    // Fallback for a runtime without cancelAndHoldAtTime. The gain envelope
    // here is just a single short ramp from 0 up to OUTPUT_GAIN (the string
    // model itself, not a scripted curve, provides everything after that),
    // so reading `.value` is only ever approximate during that brief
    // window --- acceptable, since every mainstream engine implements
    // cancelAndHoldAtTime and this branch is effectively unreachable there.
    gainParam.cancelScheduledValues(now);
    gainParam.setValueAtTime(gainParam.value, now);
  }
}

export function updateVoiceFilterCutoff(normalizedAngle: number): void {
  if (state !== "active" || !voice || !audioContext) return;
  const now = audioContext.currentTime;
  // A brightness accent is still decaying (see articulateNoteChange/
  // startVoice) --- defer to its own curve instead of immediately
  // overwriting it with a competing, much faster glide. Without this guard,
  // main.ts's unconditional per-move call to this function (which runs
  // right after articulateNoteChange on every pointer move, including the
  // note-change move itself) would schedule its own setTargetAtTime at
  // essentially the same instant, and --- being the later of two automation
  // events starting at the same time --- win out and erase the accent
  // before it was perceptible.
  if (now < voice.brightnessAccentUntil) return;
  voice.filter.frequency.setTargetAtTime(
    clampToNyquist(cutoffForNormalizedAngle(normalizedAngle), audioContext),
    now,
    GLIDE_TIME_CONSTANT,
  );
}

// Re-articulates the already-playing voice for a genuine resolved-note
// change mid-drag (a ring change, a register change, or both at once), so
// crossing into a new note feels like a fresh pluck rather than a pitch
// glide. Never creates a new worklet node --- the single-voice architecture
// is unchanged, and the existing string is simply retuned and re-excited in
// place --- and does nothing unless a voice is actually active, same guard
// as updateVoiceFilterCutoff.
//
// Two things happen at once:
// 1. a fresh "pluck" message retunes the string to the new note's frequency
//    and re-excites it with a new noise burst, exactly like startVoice's
//    initial pluck --- the string model's own decay shape is what gives
//    this its attack and decay, no scripted gain envelope is involved;
// 2. the filter jumps immediately to a brightness ceiling above the new
//    angle's own cutoff, then itself glides smoothly back down toward that
//    angle's normal cutoff over BRIGHTNESS_DECAY_TIME_CONSTANT. This
//    function schedules that decay directly (rather than leaving it to
//    main.ts's subsequent per-move updateVoiceFilterCutoff call) and marks
//    voice.brightnessAccentUntil so that call defers to this curve instead
//    of overwriting it --- see the guard at the top of
//    updateVoiceFilterCutoff.
export function articulateNoteChange(note: string, normalizedAngle: number): void {
  if (state !== "active" || !voice || !audioContext) return;
  const now = audioContext.currentTime;

  holdCurrentGain(voice.gain.gain, now);
  voice.gain.gain.setValueAtTime(OUTPUT_GAIN, now);

  voice.workletNode.port.postMessage({
    type: "pluck",
    frequency: noteFrequency(note),
    decay: STRING_DECAY,
    exciteGain: EXCITE_GAIN,
  });

  voice.filter.frequency.setValueAtTime(clampToNyquist(brightnessAccentCutoff(normalizedAngle), audioContext), now);
  voice.filter.frequency.setTargetAtTime(
    clampToNyquist(cutoffForNormalizedAngle(normalizedAngle), audioContext),
    now,
    BRIGHTNESS_DECAY_TIME_CONSTANT,
  );
  voice.brightnessAccentUntil = now + BRIGHTNESS_HOLD_SECONDS;
}

// Fades the current voice out, stops exciting the string, and disconnects
// every node in the graph once the fade finishes. Safe to call with no
// active voice (a no-op). Marks the lifecycle "releasing" for the full
// release duration --- it does NOT return to idle, and the module's voice
// reference is NOT cleared, until the release fade has actually finished.
// Nothing shortens the release or reuses/steals this voice; a new
// startVoice during "releasing" is simply ignored (see startVoice). The
// shared compressor is left connected --- only this voice's own nodes are
// torn down. AudioWorkletNode has no onended event (unlike the old
// OscillatorNode), so the cleanup is scheduled with setTimeout to run once
// RELEASE_SECONDS has actually elapsed.
export function releaseVoice(): void {
  const next = nextVoiceState(state, "release");
  if (next === state || !voice || !audioContext) return; // not active --- nothing to release
  state = next;

  const { workletNode, filter, gain } = voice;
  const now = audioContext.currentTime;

  holdCurrentGain(gain.gain, now);
  gain.gain.linearRampToValueAtTime(0, now + RELEASE_SECONDS);
  workletNode.port.postMessage({ type: "stop" });

  setTimeout(() => {
    workletNode.disconnect();
    filter.disconnect();
    gain.disconnect();
    voice = null;
    state = nextVoiceState(state, "end");
  }, RELEASE_SECONDS * 1000);
}
