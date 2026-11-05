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

/** A bounded swept siren is more present than the former short sine beeps. */
export function playTimerSound(context: BaseAudioContext, sound: TimerSound): () => void {
  const duration = sound === 'start' ? .2 : sound === 'five-seconds' ? 2.4 : 4.2;
  const peak = sound === 'start' ? .34 : sound === 'five-seconds' ? .68 : .78;
  const low = sound === 'start' ? 880 : sound === 'five-seconds' ? 800 : 600;
  const high = sound === 'five-seconds' ? 1450 : 1350;
  const steps = sound === 'five-seconds' ? 8 : 12;
  const oscillator = context.createOscillator(); const gain = context.createGain();
  const start = context.currentTime;
  let ended = false;
  function disconnect() {
    if (ended) return;
    ended = true; oscillator.disconnect(); gain.disconnect();
  }
  oscillator.type = sound === 'start' ? 'sine' : 'sawtooth';
  oscillator.frequency.setValueAtTime(low, start);
  if (sound !== 'start') for (let step = 1; step <= steps; step++) {
    oscillator.frequency.linearRampToValueAtTime(step % 2 ? high : low, start + duration * step / steps);
  }
  const attack = sound === 'start' ? .015 : .04;
  const release = sound === 'start' ? .04 : .09;
  gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(peak, start + attack);
  gain.gain.setValueAtTime(peak, start + duration - release); gain.gain.linearRampToValueAtTime(0, start + duration);
  oscillator.connect(gain); gain.connect(context.destination);
  oscillator.onended = disconnect; oscillator.start(start); oscillator.stop(start + duration + .02);
  return () => {
    if (ended) return;
    gain.gain.cancelScheduledValues(context.currentTime); gain.gain.setValueAtTime(0, context.currentTime);
    try { oscillator.stop(context.currentTime); } catch { /* An already-ended source is silent. */ }
    disconnect();
  };
}

/** AudioContext is created/resumed only from a user action, as browsers require. */
export function useTimerSound(sample: TimerAudioSample) {
  const [enabled, setEnabled] = useState(false); const [error, setError] = useState('');
  const context = useRef<AudioContext | null>(null); const tracker = useRef(timerAudioBaseline(sample));
  const active = useRef<(() => void) | null>(null); const activation = useRef(0);
  const current = useRef(sample); current.current = sample;
  function stopSound() { active.current?.(); active.current = null; }
  function play(sound: TimerSound) {
    stopSound();
    if (context.current?.state === 'running') active.current = playTimerSound(context.current, sound);
  }
  useEffect(() => {
    if (!enabled) { stopSound(); tracker.current = timerAudioBaseline(sample); return; }
    if (sample.status !== 'running' && sample.status !== tracker.current.status || sample.key !== tracker.current.key) stopSound();
    const next = advanceTimerAudio(tracker.current, sample); tracker.current = next.tracker;
    next.sounds.forEach(play);
  }, [enabled, sample.key, sample.status, sample.elapsed, sample.duration]);
  useEffect(() => () => { activation.current++; stopSound(); void context.current?.close().catch(() => undefined); }, []);
  async function enable(test = true) {
    const attempt = ++activation.current;
    try {
      const Constructor = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) throw new Error('Este navegador no admite los avisos de sonido. Use un navegador actualizado.');
      if (!context.current || context.current.state === 'closed') context.current = new Constructor();
      await context.current.resume();
      if (attempt !== activation.current) return false;
      if (context.current.state !== 'running') throw new Error('El navegador bloqueó el sonido. Pulse Activar sonido y compruebe el volumen del equipo.');
      if (!enabled) tracker.current = timerAudioBaseline(current.current);
      setEnabled(true); setError(''); if (test) play('finish'); return true;
    } catch (problem) {
      if (attempt !== activation.current) return false;
      stopSound(); setEnabled(false); setError(problem instanceof Error ? problem.message : 'No se pudo activar el sonido.'); return false;
    }
  }
  function disable() {
    activation.current++; stopSound(); tracker.current = timerAudioBaseline(current.current);
    setEnabled(false); void context.current?.suspend().catch(() => undefined);
  }
  return { enabled, error, enable, disable };
}
