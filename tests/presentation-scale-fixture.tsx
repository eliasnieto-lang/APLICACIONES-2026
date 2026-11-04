// Browser-only fixture: the test runner intercepts this endpoint with an isolated in-memory server.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Api, Snapshot } from '../shared/types';
import PresentationEvaluations from '../src/views/PresentationEvaluations';
import { loadDraft, saveDraft } from '../src/drafts';
import '../src/styles.css';

const secret = 'isolated-scale-ui-fixture-secret';
const currentDraft = JSON.stringify(['presentation-v2', 'scale-teacher', 'scale-publisher', 'MAT', 'P1']);
const legacyDraft = JSON.stringify(['presentation', 'scale-teacher', 'scale-publisher', 'MAT', 'P1']);
const api: Api = {
  dataset: 'demo', draftSecret: () => secret,
  async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch('/api/scale-fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.message), { code: value.code, status: response.status });
    return value as T;
  },
};

declare global {
  interface Window {
    presentationScaleFixture: {
      currentDraft(): Promise<unknown>;
      legacyDraft(): Promise<unknown>;
      seedLegacyDraft(): Promise<void>;
    };
  }
}
window.presentationScaleFixture = {
  currentDraft: () => loadDraft(secret, 'demo', currentDraft),
  legacyDraft: () => loadDraft(secret, 'demo', legacyDraft),
  seedLegacyDraft: () => saveDraft(secret, 'demo', legacyDraft, { scores: Array(10).fill(2), notes: Array(10).fill(''), generalObservation: 'respaldo de escala anterior', physicalText: '', baseVersion: 0, savedAt: new Date().toISOString() }),
};

function Fixture() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const refresh = async () => { setSnapshot(await api.call<Snapshot>('snapshot')); };
  useEffect(() => { void refresh(); }, []);
  return <main className="main-content">{snapshot && <PresentationEvaluations snapshot={snapshot} api={api} refresh={refresh} notify={() => undefined} />}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
