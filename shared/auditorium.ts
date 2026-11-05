import type { Area, Block, State } from './types';
import { presentationCategoryAssessment } from './presentation';

export interface AuditoriumPublisher { id: string; name: string; score: number }
export interface AuditoriumCategory { area: Area; block: Block; publishers: AuditoriumPublisher[] }
export interface AuditoriumVisit {
  status: 'running' | 'paused' | 'finished'; durationSeconds: number; remainingSeconds: number;
  startedAt: string; endsAt: string | null;
}
export interface AuditoriumDisplay {
  schemaVersion: 1; version: number; mode: 'instructions' | 'samples'; categories: AuditoriumCategory[];
  visit?: AuditoriumVisit; rankingId?: string; rankingVersion?: number;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 160;
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Enumerate only public display fields; malformed or future metadata never starts a clock. */
export function readAuditoriumDisplay(value: unknown): AuditoriumDisplay | null {
  if (!record(value) || value.schemaVersion !== 1 || !positiveInteger(value.version)
    || value.mode !== 'instructions' && value.mode !== 'samples' || !Array.isArray(value.categories) || value.categories.length > 6) return null;
  const categories: AuditoriumCategory[] = [];
  const categoryIds = new Set<string>();
  for (const item of value.categories) {
    if (!record(item) || item.area !== 'MAT' && item.area !== 'COM' || !['P1', 'P2', 'S1'].includes(item.block as string)
      || !Array.isArray(item.publishers) || item.publishers.length !== 3) return null;
    const key = `${item.area}-${item.block}`;
    if (categoryIds.has(key)) return null;
    categoryIds.add(key);
    const publishers: AuditoriumPublisher[] = [];
    for (const publisher of item.publishers) {
      if (!record(publisher) || !identifier(publisher.id) || typeof publisher.name !== 'string' || !publisher.name.trim()
        || publisher.name.length > 300 || typeof publisher.score !== 'number' || !Number.isFinite(publisher.score)
        || publisher.score < 0 || publisher.score > 100 || publishers.some(row => row.id === publisher.id)) return null;
      publishers.push({ id: publisher.id, name: publisher.name.trim(), score: publisher.score });
    }
    categories.push({ area: item.area, block: item.block as Block, publishers });
  }
  const result: AuditoriumDisplay = { schemaVersion: 1, version: value.version, mode: value.mode, categories };
  if (value.mode === 'instructions') return result;
  if (!categories.length || !identifier(value.rankingId) || !positiveInteger(value.rankingVersion) || !record(value.visit)) return null;
  const visit = value.visit;
  if (!['running', 'paused', 'finished'].includes(visit.status as string)
    || !Number.isInteger(visit.durationSeconds) || (visit.durationSeconds as number) < 60 || (visit.durationSeconds as number) > 3600
    || !Number.isInteger(visit.remainingSeconds) || (visit.remainingSeconds as number) < 0 || (visit.remainingSeconds as number) > (visit.durationSeconds as number)
    || !timestamp(visit.startedAt) || visit.status === 'running' && (!timestamp(visit.endsAt) || Date.parse(visit.endsAt) < Date.parse(visit.startedAt))
    || visit.status !== 'running' && visit.endsAt !== null || visit.status === 'finished' && visit.remainingSeconds !== 0) return null;
  return { ...result, rankingId: value.rankingId, rankingVersion: value.rankingVersion,
    visit: { status: visit.status as AuditoriumVisit['status'], durationSeconds: visit.durationSeconds as number,
      remainingSeconds: visit.remainingSeconds as number, startedAt: visit.startedAt, endsAt: visit.endsAt as string | null } };
}

/** A shared end timestamp survives page reloads and is interpreted against the server-calibrated clock. */
export function visitRemaining(visit: AuditoriumVisit | undefined, now: number): number {
  if (!visit || visit.status === 'finished') return 0;
  if (visit.status === 'paused') return Math.max(0, Math.min(visit.durationSeconds, visit.remainingSeconds));
  const end = visit.endsAt === null ? NaN : Date.parse(visit.endsAt);
  if (!Number.isFinite(now) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.min(visit.durationSeconds, Math.ceil((end - now) / 1000)));
}

/** Copy only three resolved current finalists from an authorized final ranking. Never publish private forms. */
export function buildAuditoriumCategories(state: State): AuditoriumCategory[] {
  const ranking = state.presentationRanking;
  const draw = state.presentationDraw;
  if (!ranking || ranking.provisional || ranking.stale || !draw || ranking.drawId !== draw.id || !draw.publishers.length
    || !draw.publishers.every(publisher => draw.completedPublisherIds.includes(publisher.id))) return [];
  const groups: AuditoriumCategory[] = [];
  for (const category of ranking.categories) {
    if (!['ready', 'published'].includes(category.state) || category.registered < 1 || category.pending !== 0
      || category.finalists.length !== 3 || new Set(category.finalists).size !== 3 || category.tied.length
      || groups.some(group => group.area === category.area && group.block === category.block)) continue;
    const current = presentationCategoryAssessment(state, category.area, category.block);
    if (!['ready', 'published'].includes(current.state) || current.pending || current.finalists.join('|') !== category.finalists.join('|')) continue;
    const publishers: AuditoriumPublisher[] = [];
    for (const id of category.finalists) {
      const publisher = state.publishers.find(item => item.id === id);
      const row = category.ranked.find(item => item.publisherId === id);
      const fresh = current.ranked.find(item => item.publisherId === id);
      if (!publisher || !identifier(publisher.id) || !publisher.name.trim() || publisher.name.length > 300 || !row || !fresh || row.state !== 'eligible' || row.pending !== 0 || row.closed !== row.registered
        || typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < 0 || row.score > 100
        || typeof fresh.score !== 'number' || Math.abs(row.score - fresh.score) > 1e-8 || row.i2 !== fresh.i2) break;
      publishers.push({ id: publisher.id, name: publisher.name, score: row.score });
    }
    if (publishers.length === 3) groups.push({ area: category.area, block: category.block, publishers });
  }
  return groups;
}
