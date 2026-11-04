import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceTimerAudio, timerAudioBaseline, type TimerAudioSample } from '../src/timer-audio';

const sample = (patch: Partial<TimerAudioSample> = {}): TimerAudioSample => ({ key: 'publisher:2026-11-04T10:00:00Z', status: 'running', elapsed: 0, duration: 900, ...patch });

test('audio announces a fresh turn, five seconds remaining and the exact end once', () => {
  let tracker = timerAudioBaseline(sample({ key: null, status: 'ready' }));
  let step = advanceTimerAudio(tracker, sample()); assert.deepEqual(step.sounds, ['start']); tracker = step.tracker;
  step = advanceTimerAudio(tracker, sample({ elapsed: 894.75 })); assert.deepEqual(step.sounds, []); tracker = step.tracker;
  step = advanceTimerAudio(tracker, sample({ elapsed: 895 })); assert.deepEqual(step.sounds, ['five-seconds']); tracker = step.tracker;
  step = advanceTimerAudio(tracker, sample({ elapsed: 899.75 })); assert.deepEqual(step.sounds, []); tracker = step.tracker;
  step = advanceTimerAudio(tracker, sample({ elapsed: 900 })); assert.deepEqual(step.sounds, ['finish']); tracker = step.tracker;
  step = advanceTimerAudio(tracker, sample({ elapsed: 900 })); assert.deepEqual(step.sounds, []);
  step = advanceTimerAudio(step.tracker, sample({ elapsed: 903 })); assert.deepEqual(step.sounds, []);
});

test('enabling or opening sound during a turn never replays an old start or warning', () => {
  let tracker = timerAudioBaseline(sample({ elapsed: 896 }));
  let step = advanceTimerAudio(tracker, sample({ elapsed: 896.25 })); assert.deepEqual(step.sounds, []); tracker = step.tracker;
  step = advanceTimerAudio(tracker, sample({ elapsed: 900 })); assert.deepEqual(step.sounds, ['finish']);
  tracker = timerAudioBaseline(sample({ elapsed: 905 }));
  assert.deepEqual(advanceTimerAudio(tracker, sample({ elapsed: 906 })).sounds, []);
  assert.deepEqual(advanceTimerAudio(tracker, sample({ key: 'other:old', elapsed: 200 })).sounds, []);
});

test('pause and resume retain threshold history without alarms while paused', () => {
  let tracker = timerAudioBaseline(sample({ elapsed: 894 }));
  let step = advanceTimerAudio(tracker, sample({ status: 'paused', elapsed: 894 })); assert.deepEqual(step.sounds, []); tracker = step.tracker;
  step = advanceTimerAudio(tracker, sample({ status: 'paused', elapsed: 894 })); assert.deepEqual(step.sounds, []); tracker = step.tracker;
  step = advanceTimerAudio(tracker, sample({ elapsed: 894.25 })); assert.deepEqual(step.sounds, []); tracker = step.tracker;
  step = advanceTimerAudio(tracker, sample({ elapsed: 895 })); assert.deepEqual(step.sounds, ['five-seconds']); tracker = step.tracker;
  step = advanceTimerAudio(tracker, sample({ status: 'paused', elapsed: 895 })); assert.deepEqual(step.sounds, []); tracker = step.tracker;
  step = advanceTimerAudio(tracker, sample({ elapsed: 895.25 })); assert.deepEqual(step.sounds, []);
});

test('manual early finish stays silent; a new turn gets its own start and alarms', () => {
  const tracker = timerAudioBaseline(sample({ elapsed: 300 }));
  const ended = advanceTimerAudio(tracker, sample({ status: 'finished', elapsed: 900 })); assert.deepEqual(ended.sounds, []);
  const next = advanceTimerAudio(ended.tracker, sample({ key: 'next-publisher:later', elapsed: .5 })); assert.deepEqual(next.sounds, ['start']);
  assert.deepEqual(advanceTimerAudio(next.tracker, sample({ key: 'next-publisher:later', elapsed: 895 })).sounds, ['five-seconds']);
});

test('a background-tab jump past the end announces only the current deadline', () => {
  const tracker = timerAudioBaseline(sample({ elapsed: 894 }));
  assert.deepEqual(advanceTimerAudio(tracker, sample({ elapsed: 901 })).sounds, ['finish']);
});
