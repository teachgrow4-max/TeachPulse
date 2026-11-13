/**
 * A short two-note chime for "attendance recorded", made with the Web Audio API so there is no sound
 * file to ship.
 *
 * Browsers keep sound switched off until the person has touched the page, and a scanner that reads a
 * code with the camera may be used for hours without a single touch. So one audio context is kept for
 * the whole page and unlocked by the first tap, click or key press (`unlockSound`); until then
 * `soundLocked()` says so, and the scanner offers a button to tap.
 */
let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (context) return context;
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    context = Ctx ? new Ctx() : null;
  } catch {
    context = null;
  }
  return context;
}

/** Call from a tap, click or key press: lets the browser play sound from now on. */
export function unlockSound(): void {
  void audio()?.resume();
}

/** True while the browser would still refuse to play sound. */
export function soundLocked(): boolean {
  const ctx = audio();
  return ctx !== null && ctx.state !== 'running';
}

export function chime(): void {
  try {
    const ctx = audio();
    if (!ctx) return;
    void ctx.resume();
    const start = ctx.currentTime;
    [880, 1319].forEach((hz, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      const at = start + i * 0.14;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.5, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.4);
    });
  } catch {
    /* sound is a nicety */
  }
}
