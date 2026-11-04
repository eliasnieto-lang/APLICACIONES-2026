// Isolated browser fixture; browser-questions.mjs intercepts this API.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Api, Snapshot } from '../shared/types';
import LiveRoom from '../src/views/LiveRoom';
import '../src/styles.css';
const api: Api = {
  dataset: 'demo', draftSecret: () => 'isolated-required-question-fixture',
  async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch('/api/questions-fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
    const value = await response.json(); if (!response.ok) throw new Error(value.message); return value as T;
  },
};
function Fixture() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null); const [message, setMessage] = useState('');
  const refresh = async () => setSnapshot(await api.call<Snapshot>('snapshot'));
  useEffect(() => { void refresh(); }, []);
  return <main className="main-content">{message && <p role="status">{message}</p>}{snapshot && <LiveRoom snapshot={snapshot} api={api} refresh={refresh} notify={setMessage} />}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
