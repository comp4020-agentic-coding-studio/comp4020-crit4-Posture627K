// Single-voice Web Audio synthesis for Guitar Orbit: one oscillator through a
// low-pass filter into a gain envelope, feeding AudioContext.destination. The
// AudioContext is created lazily (and resumed) on the first user gesture that
// calls startVoice --- never at module load, per the autoplay policy. Only
// ever one voice exists at a time; main.ts is responsible for calling these
// in response to pointer/ring transitions, not this module.

export const ATTACK_SECONDS = 0.015;
export const RELEASE_SECONDS = 0.08;
export const PEAK_GAIN = 0.2;

// How long a frequency/filter glide takes to settle (setTargetAtTime's time
// constant), used when a value changes without a new note attack.
const GLIDE_TIME_CONSTANT = 0.02;

// The low-pass filter cutoff range the normalized pointer angle sweeps
// across, mapped exponentially (cutoff frequency perception is logarithmic).
export const MIN_CUTOFF_HZ = 200;
export const MAX_CUTOFF_HZ = 8000;

// Standard equal-tempered concert-pitch (A4 = 440 Hz) frequencies, rounded to
// two decimal places, for the six locked ring notes.
const NOTE_FREQUENCIES: Record<string, number> = {
  E3: 164.81,
  G3: 196.0,
  A3: 220.0,
  B3: 246.94,
  D4: 293.66,
  E4: 329.63,
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

interface Voice {
  oscillator: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  attackStartTime: number;
}

export type VoiceState = "idle" | "active" | "releasing";
type VoiceAction = "start" | "release" | "end";

// Pure state transition table for the voice lifecycle: idle -> active ->
// releasing -> idle. No AudioContext here --- this is the part of the
// lifecycle that can be reasoned about (and tested) without one. An action
// that doesn't apply to the current state is a no-op (returns the same
// state unchanged), which is what lets startVoice/releaseVoice/onended each
// just call this and only act when it actually changed something: a "start"
// while already active/releasing is ignored, a "release" while not active
// is ignored, and the state only reaches idle again once "end" (the
// oscillator's `onended`) fires from releasing.
export function nextVoiceState(current: VoiceState, action: VoiceAction): VoiceState {
  if (action === "start" && current === "idle") return "active";
  if (action === "release" && current === "active") return "releasing";
  if (action === "end" && current === "releasing") return "idle";
  return current;
}

let audioContext: AudioContext | null = null;
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

export function voiceState(): VoiceState {
  return state;
}

// Starts a brand-new voice with a short linear attack. Only actually creates
// an oscillator when the lifecycle is idle --- a call while active or
// releasing is silently ignored, so a second OscillatorNode is never
// connected while a previous one is still sounding (including its release
// tail). Callers (main.ts) should also check voiceState() before adopting a
// new pointer as the active one, so a press during a release doesn't even
// get this far, but the guard here is what actually prevents polyphony.
export function startVoice(note: string, normalizedAngle: number): void {
  const next = nextVoiceState(state, "start");
  if (next === state) return; // not idle --- ignore
  state = next;

  const ctx = getAudioContext();
  const now = ctx.currentTime;

  const oscillator = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(noteFrequency(note), now);

  filter.type = "lowpass";
  filter.frequency.setValueAtTime(cutoffForNormalizedAngle(normalizedAngle), now);

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + ATTACK_SECONDS);

  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(now);

  voice = { oscillator, filter, gain, attackStartTime: now };
}

// Glides the current voice to a new note's frequency instead of retriggering
// a new oscillator --- used when the active ring changes mid-drag. Only
// applies while a voice is actually active (not mid-release).
export function updateVoiceFrequency(note: string): void {
  if (state !== "active" || !voice || !audioContext) return;
  voice.oscillator.frequency.setTargetAtTime(
    noteFrequency(note),
    audioContext.currentTime,
    GLIDE_TIME_CONSTANT,
  );
}

export function updateVoiceFilterCutoff(normalizedAngle: number): void {
  if (state !== "active" || !voice || !audioContext) return;
  voice.filter.frequency.setTargetAtTime(
    cutoffForNormalizedAngle(normalizedAngle),
    audioContext.currentTime,
    GLIDE_TIME_CONSTANT,
  );
}

// Fades the current voice out, stops the oscillator once the release
// finishes, and disconnects every node in the graph. Safe to call with no
// active voice (a no-op). Marks the lifecycle "releasing" for the full
// release duration --- it does NOT return to idle, and the module's voice
// reference is NOT cleared, until the oscillator's own `onended` fires,
// i.e. until it has actually stopped sounding. Nothing shortens the release
// or reuses/steals this voice; a new startVoice during "releasing" is
// simply ignored (see startVoice).
export function releaseVoice(): void {
  const next = nextVoiceState(state, "release");
  if (next === state || !voice || !audioContext) return; // not active --- nothing to release
  state = next;

  const { oscillator, filter, gain, attackStartTime } = voice;
  const now = audioContext.currentTime;
  const gainParam = gain.gain;

  if (typeof gainParam.cancelAndHoldAtTime === "function") {
    // The correct sample-and-hold primitive for interrupting an in-progress
    // ramp: cancels every scheduled change after `now` and holds the param
    // at whatever value its automation curve had actually reached at `now`.
    // Reading `.value` instead cannot be trusted to reflect that --- the
    // spec only guarantees it as the *intrinsic* value, and interrupting a
    // ramp with a stale or rounded read is exactly the kind of click this
    // release path exists to avoid.
    gainParam.cancelAndHoldAtTime(now);
  } else {
    // Fallback for a runtime without cancelAndHoldAtTime. The only
    // automation ever applied to this gain is the linear attack ramp from
    // 0 to PEAK_GAIN starting at attackStartTime (nothing else ever
    // schedules gain changes), so its value at `now` is computed directly
    // from that known ramp rather than trusted from `.value`.
    const attackEndTime = attackStartTime + ATTACK_SECONDS;
    let heldValue: number;
    if (now <= attackStartTime) {
      heldValue = 0;
    } else if (now >= attackEndTime) {
      heldValue = PEAK_GAIN;
    } else {
      heldValue = (PEAK_GAIN * (now - attackStartTime)) / ATTACK_SECONDS;
    }
    gainParam.cancelScheduledValues(now);
    gainParam.setValueAtTime(heldValue, now);
  }

  gainParam.linearRampToValueAtTime(0, now + RELEASE_SECONDS);
  oscillator.stop(now + RELEASE_SECONDS);
  oscillator.onended = () => {
    oscillator.disconnect();
    filter.disconnect();
    gain.disconnect();
    voice = null;
    state = nextVoiceState(state, "end");
  };
}
