// Isolated browser fixture; requests are intercepted by browser-jornada-live.mjs.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Api, Snapshot } from '../shared/types';
import LiveRoom from '../src/views/LiveRoom';
import PresentationPublicView from '../src/views/PresentationPublicView';
import '../src/styles.css';

const api: Api = {
  dataset: 'demo', draftSecret: () => 'isolated-live-fixture',
  async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch('/api/jornada-fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.message); return result as T;
  },
};
function Fixture() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null); const [message, setMessage] = useState('');
  const refresh = async () => setSnapshot(await api.call<Snapshot>('snapshot'));
  useEffect(() => { void refresh(); }, []);
  return <main className="main-content">{message && <p role="alert">{message}</p>}{snapshot && (new URLSearchParams(location.search).has('public')
    ? <PresentationPublicView data={snapshot} refresh={refresh} />
    : <LiveRoom snapshot={snapshot} api={api} refresh={refresh} notify={setMessage} />)}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
