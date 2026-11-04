import type { Dataset } from '../shared/types';

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type Envelope = { version: 1; iv: string; ciphertext: string };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const writes = new Map<string, Promise<void>>();
const queueName = (secret: string, dataset: Dataset, assignmentId: string) => JSON.stringify([secret, dataset, assignmentId]);

async function queued(name: string, operation: () => Promise<void>): Promise<void> {
  const previous = writes.get(name) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(operation);
  writes.set(name, write);
  try { await write; } finally { if (writes.get(name) === write) writes.delete(name); }
}

function cryptoApi(): Crypto {
  if (!globalThis.crypto?.subtle) throw new Error('El respaldo cifrado requiere HTTPS o localhost. Mantenga esta pestaña abierta hasta guardar en el servidor.');
  return globalThis.crypto;
}

function storageApi(storage?: DraftStorage): DraftStorage {
  if (storage) return storage;
  if (!globalThis.localStorage) throw new Error('El navegador no permite guardar el respaldo cifrado local. Mantenga esta pestaña abierta.');
  return globalThis.localStorage;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function context(secret: string, dataset: Dataset, assignmentId: string) {
  if (!secret) throw new Error('Falta la clave individual para cifrar el borrador.');
  const crypto = cryptoApi();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`textos-2027/draft-key/${secret}`));
  const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const scope = encoder.encode(`textos-2027/draft/${dataset}/${assignmentId}`);
  const index = await crypto.subtle.digest('SHA-256', encoder.encode(`${secret}/${dataset}/${assignmentId}`));
  const name = `textos-draft-v1-${Array.from(new Uint8Array(index), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  return { crypto, key, scope, name };
}

/** No score, evidence, code or assignment identifier is stored in clear text. */
export async function saveDraft<T>(secret: string, dataset: Dataset, assignmentId: string, value: T, storage?: DraftStorage): Promise<void> {
  // Queue before asynchronous key derivation so edits keep their original order.
  return queued(queueName(secret, dataset, assignmentId), async () => {
    const { crypto, key, scope, name } = await context(secret, dataset, assignmentId);
    const local = storageApi(storage);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: scope }, key, encoder.encode(JSON.stringify(value)));
    local.setItem(name, JSON.stringify({ version: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) } satisfies Envelope));
  });
}

export async function loadDraft<T>(secret: string, dataset: Dataset, assignmentId: string, storage?: DraftStorage): Promise<T | null> {
  await writes.get(queueName(secret, dataset, assignmentId));
  const { crypto, key, scope, name } = await context(secret, dataset, assignmentId);
  const raw = storageApi(storage).getItem(name);
  if (!raw) return null;
  try {
    const envelope = JSON.parse(raw) as Envelope;
    if (envelope.version !== 1 || !envelope.iv || !envelope.ciphertext) throw new Error('Formato desconocido');
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: scope }, key, fromBase64(envelope.ciphertext));
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    throw new Error('No se pudo recuperar el borrador cifrado. Se conserva el respaldo local; no lo descarte antes de revisar su ficha del servidor.');
  }
}

export async function removeDraft(secret: string, dataset: Dataset, assignmentId: string, storage?: DraftStorage): Promise<void> {
  return queued(queueName(secret, dataset, assignmentId), async () => {
    const { name } = await context(secret, dataset, assignmentId);
    storageApi(storage).removeItem(name);
  });
}
