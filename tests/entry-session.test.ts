import test from 'node:test';
import assert from 'node:assert/strict';
import { activeEntry, lastTeacherProfile, ownTeacherCode, rememberActiveEntry, rememberTeacherCode, takeAccessFragment } from '../src/entry-session';

function browserStorage() {
  const memory = new Map<string, string>();
  return { memory, getItem: (key: string) => memory.get(key) || null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) };
}

test('teacher reentry uses only the matching private browser access and dataset', () => {
  const previousLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const local = browserStorage(), session = browserStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session });
  try {
    assert.equal(ownTeacherCode('real', 'Pérez Ramos', 'Ana María'), undefined);
    rememberTeacherCode('real', 'Pérez Ramos', 'Ana María', 'own-opaque-access', { area: 'COM', categories: ['P1', 'S1'] });
    assert.equal(ownTeacherCode('real', '  PÉREZ   RAMOS ', 'Ana María'), 'own-opaque-access');
    assert.equal(ownTeacherCode('real', 'Pérez Ramos', 'Otra Persona'), undefined);
    assert.equal(ownTeacherCode('demo', 'Pérez Ramos', 'Ana María'), undefined);
    assert.deepEqual(lastTeacherProfile('real'), { lastNames: 'Pérez Ramos', firstNames: 'Ana María', area: 'COM', categories: ['P1', 'S1'] });
    rememberActiveEntry('real', { code: 'own-opaque-access' });
    rememberActiveEntry('demo', { code: 'different-demo-access' });
    assert.equal(activeEntry('real')?.code, 'own-opaque-access');
    assert.equal(activeEntry('demo')?.code, 'different-demo-access');
    rememberActiveEntry('real', null);
    assert.equal(activeEntry('real'), null);
    assert.equal(activeEntry('demo')?.code, 'different-demo-access');
    assert.equal([...local.memory.values(), ...session.memory.values()].some(value => value.includes('password')), false);
    rememberActiveEntry('demo', null);
  } finally {
    if (previousLocal) Object.defineProperty(globalThis, 'localStorage', previousLocal); else Reflect.deleteProperty(globalThis, 'localStorage');
    if (previousSession) Object.defineProperty(globalThis, 'sessionStorage', previousSession); else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});

test('private reentry fragments are removed before the credential is used', () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  let replacement = '';
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '#access=private%2Fopaque', pathname: '/', search: '?datos=demo' } });
  Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: (_state: unknown, _title: string, url: string) => { replacement = url; } } });
  try {
    assert.equal(takeAccessFragment(), 'private/opaque');
    assert.equal(replacement, '/?datos=demo');
  } finally {
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation); else Reflect.deleteProperty(globalThis, 'location');
    if (previousHistory) Object.defineProperty(globalThis, 'history', previousHistory); else Reflect.deleteProperty(globalThis, 'history');
  }
});
