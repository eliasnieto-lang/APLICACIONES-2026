// Browser-only fixture: all API operations and scanner results are intercepted by its runner.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Api, Snapshot } from '../shared/types';
import PaperVoting from '../src/views/PaperVoting';
import '../src/styles.css';
const api: Api = {
  dataset: 'demo', draftSecret: () => 'not-a-production-access',
  async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch('/api/paper-fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message), { status: response.status, code: result.code });
    return result as T;
  },
};
function Fixture() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const refresh = async () => setSnapshot(await api.call<Snapshot>('snapshot'));
  useEffect(() => { void refresh(); }, []);
  return <main className="main-content">{snapshot && <PaperVoting snapshot={snapshot} api={api} refresh={refresh} notify={() => undefined} />}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
