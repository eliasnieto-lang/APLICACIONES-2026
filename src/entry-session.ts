import type { Area, Block, Dataset } from '../shared/types';

export interface EntrySession { code: string }
export interface TeacherEntryProfile { lastNames: string; firstNames: string; area: Area; categories: Block[] }
const activeKey = (dataset: Dataset) => `textos-entry-session-v1:${dataset}`;
const teachersKey = (dataset: Dataset) => `textos-teacher-access-v1:${dataset}`;
const profileKey = (dataset: Dataset) => `textos-teacher-profile-v1:${dataset}`;
const memoryActive = new Map<Dataset, EntrySession>();
const memoryTeachers = new Map<Dataset, Record<string, string>>();
const memoryProfiles = new Map<Dataset, TeacherEntryProfile>();

function nameKey(lastNames: string, firstNames: string) {
  const normalize = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es-PE');
  return JSON.stringify([normalize(lastNames), normalize(firstNames)]);
}

function readTeacherCodes(dataset: Dataset): Record<string, string> {
  try {
    const raw = localStorage.getItem(teachersKey(dataset));
    if (!raw) return memoryTeachers.get(dataset) || {};
    const stored: unknown = JSON.parse(raw);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0));
    }
  } catch { /* The browser can still keep this session in memory. */ }
  return memoryTeachers.get(dataset) || {};
}

/** A name resumes only an access already issued to this browser and dataset. */
export function ownTeacherCode(dataset: Dataset, lastNames: string, firstNames: string): string | undefined {
  if (!lastNames.trim() || !firstNames.trim()) return undefined;
  return readTeacherCodes(dataset)[nameKey(lastNames, firstNames)];
}

export function rememberTeacherCode(dataset: Dataset, lastNames: string, firstNames: string, code: string, profile?: Pick<TeacherEntryProfile, 'area' | 'categories'>) {
  const entries = { ...readTeacherCodes(dataset), [nameKey(lastNames, firstNames)]: code };
  memoryTeachers.set(dataset, entries);
  try { localStorage.setItem(teachersKey(dataset), JSON.stringify(entries)); } catch { /* Memory fallback. */ }
  if (profile) {
    const saved = { lastNames: lastNames.trim(), firstNames: firstNames.trim(), area: profile.area, categories: [...profile.categories] };
    memoryProfiles.set(dataset, saved);
    try { localStorage.setItem(profileKey(dataset), JSON.stringify(saved)); } catch { /* Memory fallback. */ }
  }
}

export function lastTeacherProfile(dataset: Dataset): TeacherEntryProfile | null {
  try {
    const stored = JSON.parse(localStorage.getItem(profileKey(dataset)) || 'null');
    if (stored && typeof stored.lastNames === 'string' && typeof stored.firstNames === 'string' && ['MAT', 'COM'].includes(stored.area) && Array.isArray(stored.categories) && stored.categories.length && stored.categories.every((block: unknown) => ['P1', 'P2', 'S1'].includes(String(block)))) return stored;
  } catch { /* Memory fallback. */ }
  return memoryProfiles.get(dataset) || null;
}

export function activeEntry(dataset: Dataset): EntrySession | null {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(activeKey(dataset)) || 'null');
    if (stored && typeof stored === 'object' && 'code' in stored && typeof stored.code === 'string' && stored.code.trim()) return { code: stored.code };
  } catch { /* Memory fallback. */ }
  return memoryActive.get(dataset) || null;
}

export function rememberActiveEntry(dataset: Dataset, session: EntrySession | null) {
  if (session) memoryActive.set(dataset, { code: session.code });
  else memoryActive.delete(dataset);
  try {
    if (session) sessionStorage.setItem(activeKey(dataset), JSON.stringify({ code: session.code }));
    else sessionStorage.removeItem(activeKey(dataset));
  } catch { /* Memory fallback. */ }
}

/** Remove a private invitation from the address bar before making any requests. */
export function takeAccessFragment(): string | null {
  const params = new URLSearchParams(location.hash.slice(1));
  const code = (params.get('access') || params.get('acceso'))?.trim() || null;
  if (params.has('access') || params.has('acceso')) history.replaceState(null, '', `${location.pathname}${location.search}`);
  return code;
}
