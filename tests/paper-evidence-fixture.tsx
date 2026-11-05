// Isolated browser fixture; all requests are intercepted by browser-paper-evidence.mjs.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Api } from '../shared/types';
import type { PaperPoll } from '../shared/paper-vote';
import PaperEvidence from '../src/components/PaperEvidence';
import '../src/styles.css';
const api: Api = { dataset: 'demo', draftSecret: () => 'photo-evidence-isolated-fixture', async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> { const response = await fetch('/api/paper-evidence-fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) }); const result = await response.json(); if (!response.ok) throw new Error(result.message); return result as T; } };
function Fixture() {
  const [poll, setPoll] = useState<PaperPoll | null>(null), [message, setMessage] = useState('');
  useEffect(() => { void api.call<PaperPoll>('snapshot').then(setPoll); }, []);
  return <main className="main-content"><h1>Respaldo opcional de la votación</h1>{message && <p role="status">{message}</p>}{poll && <PaperEvidence poll={poll} api={api} notify={setMessage} />}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
