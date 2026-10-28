import type { Dataset } from '../shared/types';

interface BrowserRuntime {
  documentUrl: (id: string, dataset: Dataset) => string;
  templateUrl: (dataset: Dataset) => string;
}
let browserRuntime: BrowserRuntime | null = null;
export function setBrowserRuntime(runtime: BrowserRuntime) { browserRuntime = runtime; }
export function isBrowserEdition() { return browserRuntime !== null; }
export function documentUrl(id: string, dataset: Dataset): string {
  return browserRuntime?.documentUrl(id, dataset) ?? `/api/pdfs/${encodeURIComponent(id)}/file?dataset=${dataset}`;
}
export function templateUrl(dataset: Dataset): string {
  return browserRuntime?.templateUrl(dataset) ?? `/api/records/template?dataset=${dataset}`;
}
