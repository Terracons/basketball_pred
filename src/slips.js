import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSlip, generateCandidates, TARGETS } from './predict.js';

export function slipCsv(result) {
  const rows = [['rank', 'league', 'away', 'home', 'selection', 'decimal_odds', 'estimated_probability', 'bookmaker', 'game_start_utc', 'price_updated_utc', 'ai_status'],
    ...result.slip.picks.map((p, i) => [i + 1, p.league, p.away, p.home, p.label, p.odds, p.probability, p.bookmaker, p.startsAt, p.priceUpdatedAt, p.ai.status])];
  return rows.map(row => row.map(value => {
    let cell = String(value ?? '');
    if (typeof value === 'string' && /^[=+@\-\t\r]/.test(cell)) cell = `'${cell}`;
    return `"${cell.replaceAll('"', '""')}"`;
  }).join(',')).join('\r\n') + '\r\n';
}

export async function createPrediction(store, intelligence, options = {}, { exportDirectory, preparation } = {}) {
  const target = Number(options.target ?? 5);
  if (!TARGETS.includes(target)) throw new Error('Invalid target odds');
  const generated = generateCandidates(store, options), slipId = randomUUID();
  const banned = new Set(), reviews = new Map(), errors = [...(preparation?.warnings ?? [])];
  let slip = buildSlip(generated.candidates, target);
  if (options.aiEnabled) {
    if (!intelligence.env.OPENROUTER_API_KEY || !options.model) throw new Error('Add OPENROUTER_API_KEY and select your model before enabling AI');
    for (let pass = 0; pass < 6; pass++) {
      let veto = false;
      for (const pick of slip.picks) {
        if (pick.probability >= 0.7 || reviews.has(pick.id) || intelligence.used(slipId) >= 5) continue;
        try {
          const sources = options.researchEnabled && intelligence.used(slipId) < 4 ? await intelligence.research(slipId, pick) : [];
          if (intelligence.used(slipId) >= 5) break;
          const review = await intelligence.review(slipId, pick, options.model, sources);
          reviews.set(pick.id, review);
          if (review.decision === 'avoid') { banned.add(pick.id); veto = true; }
        } catch (error) {
          reviews.set(pick.id, { status: 'failed', reason: error.message }); errors.push(error.message);
        }
      }
      if (!veto) break;
      slip = buildSlip(generated.candidates, target, { banned });
    }
  }
  slip.picks = slip.picks.map(pick => ({ ...pick, ai: pick.probability >= 0.7 ? { status: 'skipped_70_percent' }
    : reviews.get(pick.id) ?? { status: options.aiEnabled ? 'request_limit_or_unreviewed' : 'disabled' } }));
  const result = { slipId, ...generated, candidates: undefined, candidateCount: generated.candidates.length,
    slip, aiRequestsAndSearches: intelligence.used(slipId), aiThreshold: 0.7, maxRequests: 5,
    reviews: [...reviews.entries()].map(([pickId, review]) => ({ pickId, ...review })), preparation, errors };
  store.put('prediction', options.league ?? 'nba', 'statistics', slipId, result);
  if (exportDirectory) {
    mkdirSync(exportDirectory, { recursive: true });
    writeFileSync(join(exportDirectory, `${slipId}.json`), JSON.stringify(result, null, 2));
    writeFileSync(join(exportDirectory, `${slipId}.csv`), slipCsv(result));
  }
  return result;
}
