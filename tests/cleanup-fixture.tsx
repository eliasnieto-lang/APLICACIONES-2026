// Isolated UI fixture: its runner intercepts all requests; no installed dataset is mutated.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Api, Dataset, Snapshot } from '../shared/types';
import DataCleanup from '../src/views/DataCleanup';
import '../src/styles.css';
const dataset = (new URLSearchParams(location.search).get('dataset') ?? 'real') as Dataset;
const api: Api = {
  dataset, draftSecret: () => 'cleanup-ui-fixture-only',
  async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch('/api/cleanup-fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message), { status: response.status, code: result.code });
    return result as T;
  },
};
function Fixture() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const refresh = async () => setSnapshot(await api.call<Snapshot>('snapshot'));
  useEffect(() => { void refresh(); }, []);
  return <main className="main-content"><button type="button" onClick={() => void refresh()}>Actualizar datos de ensayo</button>{snapshot && <DataCleanup snapshot={snapshot} api={api} refresh={refresh} notify={() => undefined} />}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
