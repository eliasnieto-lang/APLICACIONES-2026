import { useEffect, useRef, useState } from 'react';
import type { Turn } from '../shared/types';

export type TimerSound = 'start' | 'five-seconds' | 'finish';
export interface TimerAudioSample {
  key: string | null; status: Turn['status']; elapsed: number; duration: number;
}
export interface TimerAudioTracker extends TimerAudioSample {
  startHeard: boolean; warningHeard: boolean; finishHeard: boolean;
}

/** Opening or enabling a speaker during an exposition never replays past alarms. */
export function timerAudioBaseline(sample: TimerAudioSample): TimerAudioTracker {
  return { ...sample, startHeard: Boolean(sample.key), warningHeard: sample.elapsed >= Math.max(0, sample.duration - 5), finishHeard: sample.elapsed >= sample.duration };
}

/** Pure threshold crossings: paused time and repeated snapshots never produce another sound. */
export function advanceTimerAudio(previous: TimerAudioTracker, sample: TimerAudioSample): { tracker: TimerAudioTracker; sounds: TimerSound[] } {
  if (!sample.key) return { tracker: timerAudioBaseline(sample), sounds: [] };
  if (sample.key !== previous.key) {
    const tracker = timerAudioBaseline(sample);
    // A running turn newly received after a normal server poll can be a few seconds old.
    const recentStart = sample.status === 'running' && sample.elapsed >= 0 && sample.elapsed <= 15;
    return { tracker: { ...tracker, startHeard: recentStart || tracker.startHeard }, sounds: recentStart ? ['start'] : [] };
  }
  const tracker = { ...previous, ...sample };
  if (sample.status !== 'running') return { tracker, sounds: [] };
  const reachedFinish = !previous.finishHeard && previous.elapsed < sample.duration && sample.elapsed >= sample.duration;
  const reachedWarning = !previous.warningHeard && previous.elapsed < sample.duration - 5 && sample.elapsed >= sample.duration - 5;
  if (reachedFinish) {
    tracker.finishHeard = true; tracker.warningHeard = true;
    // A sleeping/background tab announces the current deadline, never a stale warning too.
    return { tracker, sounds: ['finish'] };
  }
  if (reachedWarning) { tracker.warningHeard = true; return { tracker, sounds: ['five-seconds'] }; }
  return { tracker, sounds: [] };
}

export function timerAudioSample(turn: Turn, elapsed: number, duration: number): TimerAudioSample {
  return { key: turn.publisherId && turn.startedAt ? `${turn.publisherId}:${turn.startedAt}` : null, status: turn.status, elapsed, duration };
}

function playSound(context: AudioContext, sound: TimerSound) {
  const pattern: { offset: number; duration: number; frequency: number }[] = sound === 'start'
    ? [{ offset: 0, duration: .2, frequency: 880 }]
    : sound === 'five-seconds'
      ? [0, .22, .44].map(offset => ({ offset, duration: .14, frequency: 1080 }))
      : [{ offset: 0, duration: .42, frequency: 880 }, { offset: .46, duration: .65, frequency: 660 }];
  for (const pulse of pattern) {
    const oscillator = context.createOscillator(); const gain = context.createGain();
    const start = context.currentTime + pulse.offset;
    oscillator.type = 'sine'; oscillator.frequency.value = pulse.frequency;
    gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(.18, start + .015);
    gain.gain.setValueAtTime(.18, start + Math.max(.02, pulse.duration - .04)); gain.gain.linearRampToValueAtTime(0, start + pulse.duration);
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start(start); oscillator.stop(start + pulse.duration + .02);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }
}

/** AudioContext is created/resumed only from a user action, as browsers require. */
export function useTimerSound(sample: TimerAudioSample) {
  const [enabled, setEnabled] = useState(false); const [error, setError] = useState('');
  const context = useRef<AudioContext | null>(null); const tracker = useRef(timerAudioBaseline(sample));
  const current = useRef(sample); current.current = sample;
  useEffect(() => {
    if (!enabled) { tracker.current = timerAudioBaseline(sample); return; }
    const next = advanceTimerAudio(tracker.current, sample); tracker.current = next.tracker;
    if (context.current?.state === 'running') next.sounds.forEach(sound => playSound(context.current!, sound));
  }, [enabled, sample.key, sample.status, sample.elapsed, sample.duration]);
  useEffect(() => () => { void context.current?.close().catch(() => undefined); }, []);
  async function enable(test = true) {
    try {
      const Constructor = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) throw new Error('Este navegador no admite los avisos de sonido. Use un navegador actualizado.');
      if (!context.current || context.current.state === 'closed') context.current = new Constructor();
      await context.current.resume();
      if (context.current.state !== 'running') throw new Error('El navegador bloqueó el sonido. Pulse Activar sonido y compruebe el volumen del equipo.');
      if (!enabled) tracker.current = timerAudioBaseline(current.current);
      setEnabled(true); setError(''); if (test) playSound(context.current, 'start'); return true;
    } catch (problem) { setEnabled(false); setError(problem instanceof Error ? problem.message : 'No se pudo activar el sonido.'); return false; }
  }
  function disable() { setEnabled(false); void context.current?.suspend().catch(() => undefined); }
  return { enabled, error, enable, disable };
}
