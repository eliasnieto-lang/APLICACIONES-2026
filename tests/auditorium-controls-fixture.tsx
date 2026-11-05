import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Api, Snapshot } from '../shared/types';
import AuditoriumControls from '../src/components/AuditoriumControls';
import '../src/styles.css';
const api: Api = { dataset: 'demo', draftSecret: () => 'isolated-control-fixture', async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch('/api/auditorium-control-fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.message), { status: response.status }); return result as T;
} };
declare global { interface Window { auditoriumControlFixture: { loaded: boolean; refresh(): Promise<void> } } }
window.auditoriumControlFixture = { loaded: false, refresh: async () => undefined };
function Fixture() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const refresh = async () => setSnapshot(await api.call<Snapshot>('snapshot'));
  window.auditoriumControlFixture.refresh = refresh;
  useEffect(() => { void refresh(); }, []); useEffect(() => { window.auditoriumControlFixture.loaded = !!snapshot; }, [snapshot]);
  return <main className="main-content" style={{ margin: 0, padding: 16, maxWidth: 1200 }}><h1>Prueba de proyección</h1>{snapshot && <AuditoriumControls snapshot={snapshot} api={api} refresh={refresh} notify={() => undefined} />}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
