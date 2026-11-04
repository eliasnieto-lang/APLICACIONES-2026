import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDraft, removeDraft, saveDraft, type DraftStorage } from '../src/drafts';

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: DraftStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
  return { storage, values };
}

test('encrypted draft recovers only with its individual code and dataset', async () => {
  const { storage, values } = memoryStorage();
  const draft = { scores: [0, 1, 2, null], evidence: ['Página privada 27'], baseVersion: 4 };
  await saveDraft('individual-secret', 'real', 'assignment-private', draft, storage);
  assert.deepEqual(await loadDraft('individual-secret', 'real', 'assignment-private', storage), draft);
  const persisted = JSON.stringify([...values]);
  for (const plain of ['individual-secret', 'assignment-private', 'Página privada', 'scores', 'baseVersion']) assert.equal(persisted.includes(plain), false);
  assert.equal(await loadDraft('another-code', 'real', 'assignment-private', storage), null);
  assert.equal(await loadDraft('individual-secret', 'demo', 'assignment-private', storage), null);
  assert.equal(await loadDraft('individual-secret', 'real', 'another-assignment', storage), null);
  await removeDraft('individual-secret', 'real', 'assignment-private', storage);
  assert.equal(await loadDraft('individual-secret', 'real', 'assignment-private', storage), null);
});

test('ciphertext modification is rejected and preserved for recovery', async () => {
  const { storage, values } = memoryStorage();
  await saveDraft('teacher-code', 'real', 'book-a', { evidence: 'Private evidence' }, storage);
  const [key, value] = [...values][0];
  const envelope = JSON.parse(value);
  envelope.ciphertext = `${envelope.ciphertext.startsWith('A') ? 'B' : 'A'}${envelope.ciphertext.slice(1)}`;
  values.set(key, JSON.stringify(envelope));
  await assert.rejects(loadDraft('teacher-code', 'real', 'book-a', storage), /Se conserva el respaldo/);
  assert.equal(values.size, 1);
});

test('multiple edits retain the newest encrypted draft', async () => {
  const { storage } = memoryStorage();
  await Promise.all(Array.from({ length: 12 }, (_, revision) => saveDraft('one-code', 'demo', 'assignment', { revision }, storage)));
  assert.deepEqual(await loadDraft('one-code', 'demo', 'assignment', storage), { revision: 11 });
});
