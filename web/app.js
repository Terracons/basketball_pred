const $ = id => document.getElementById(id);
let config, fixtureData, prediction, modelCatalog = [];
let dateChosenByUser = false;
async function api(path, payload) {
  const response = await fetch(path, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': config?.actionToken ?? '' }, body: JSON.stringify(payload) } : {});
  const value = await response.json();
  if (response.status === 401 && value.loginRequired && !$('login-dialog').open) $('login-dialog').showModal();
  if (!response.ok) throw new Error(value.error || 'Request failed'); return value;
}
function message(text, error = false) { $('message').replaceChildren(); if (!text) return; const p = document.createElement('p'); p.className = error ? 'notice error' : 'notice'; p.textContent = text; $('message').append(p); }
function option(value, label) { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; }
function text(tag, value, className) { const e = document.createElement(tag); e.textContent = value; if (className) e.className = className; return e; }
const percent = value => `${(value * 100).toFixed(1)}%`;
async function fixtures() {
  fixtureData = await api(`/api/fixtures?league=${$('league').value}`);
  if (!dateChosenByUser) {
    const dates = fixtureData.events.map(e => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date(e.startsAt))).sort();
    $('date').value = dates[0] || (fixtureData.fixtures[0] ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date(fixtureData.fixtures[0].starts_at)) : config.today);
  }
  $('bookmaker').replaceChildren(option('', 'Choose automatically'), ...fixtureData.bookmakers.map(b => option(b, b)));
  $('prop-event').replaceChildren(...fixtureData.events.map(e => option(e.id, `${e.away} at ${e.home}`)));
  $('price-note').textContent = `${fixtureData.fixtures.length} upcoming fixtures shown. ${fixtureData.priceUpdatedAt ? `Latest stored price: ${new Date(fixtureData.priceUpdatedAt).toLocaleString()}.` : 'No bookmaker prices stored.'} Refresh uses up to 2 odds credits; cached requests are free.`;
}
function render(result) {
  prediction = result; $('empty-state').hidden = true; $('slip').hidden = false;
  const s = result.slip;
  $('slip-status').textContent = s.targetReached ? 'TARGET REACHED / STATISTICAL ESTIMATES' : 'PARTIAL RESULT / NO FORCED PICKS';
  $('slip-title').textContent = `${s.target} odds target`;
  $('combined-odds').textContent = s.picks.length ? s.combinedOdds.toFixed(2) : 'N/A';
  $('pick-count').textContent = `${s.picks.length} ${s.picks.length === 1 ? 'pick' : 'picks'} • ${s.picks[0]?.bookmaker ?? 'No bookmaker'}`;
  $('all-win').textContent = s.estimatedAllWinProbability === null ? 'No joint estimate' : `${percent(s.estimatedAllWinProbability)} estimated all-win chance`;
  $('request-count').textContent = `${result.aiRequestsAndSearches}/5 AI + search requests`;
  $('partial-reason').textContent = `${s.reason || `${result.candidateCount} qualifying market selections considered.`} Picks are ranked by individual estimated probability, highest first. This result is saved automatically, including partial slips.`;
  $('method-note').textContent = `${result.methodology} ${s.probabilityNote}`;
  $('picks').replaceChildren();
  for (const [i, p] of s.picks.entries()) {
    const card = document.createElement('article'); card.className = 'pick';
    const top = text('div', '', 'pick-top'); top.append(text('span', `${String(i + 1).padStart(2, '0')} / ${p.away} at ${p.home}`, 'game-meta'), text('span', percent(p.probability), 'estimate'));
    card.append(top, text('h3', p.label, 'pick-title'), text('p', `${p.odds.toFixed(2)} decimal odds • ${new Date(p.startsAt).toLocaleString()} • ${p.bookmaker}`, 'game-meta'));
    const details = document.createElement('details'); details.append(text('summary', 'Evidence and limitations'));
    const list = document.createElement('ul');
    const projection = p.projection;
    const facts = p.market.startsWith('player_') ? [`Weighted projection: ${projection.mean.toFixed(1)}. ${projection.samples} games; recent minutes ${projection.minutes.toFixed(1)}.`]
      : [`Projected score: ${p.home} ${projection.homeMean.toFixed(1)}, ${p.away} ${projection.awayMean.toFixed(1)}.`, `Recent sample: ${projection.homeSamples} home-team games, ${projection.awaySamples} away-team games.`];
    [...facts, `Estimated return per unit: ${p.expectedReturn.toFixed(3)}. This is model-based, not validated profit.`, `Price timestamp: ${p.priceUpdatedAt}`, ...p.flags].forEach(v => list.append(text('li', v)));
    details.append(list); card.append(details);
    const review = p.ai;
    const explanation = review.status === 'reviewed' ? `${review.model}: ${review.decision.toUpperCase()}. ${review.reason}`
      : review.status === 'skipped_70_percent' ? 'AI skipped: statistical estimate is at least 70%.'
      : review.status === 'disabled' ? 'Statistics only. AI review is off.' : `AI ${review.status.replaceAll('_', ' ')}${review.reason ? `: ${review.reason}` : ''}.`;
    card.append(text('p', explanation, 'ai-reason'));
    const sources = text('div', '', 'sources');
    for (const source of review.sources ?? []) { const a = text('a', source.title); a.href = source.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; sources.append(a); }
    card.append(sources); $('picks').append(card);
  }
  const issues = result.errors.length ? result.errors.join(' ') : '';
  message(`${s.targetReached ? 'Analysis ready.' : 'The requested target could not be reached.'} ${result.excluded.unmatchedEvents} unmatched price snapshots; ${result.excluded.insufficientHistory} selections without sufficient history. ${issues}`, Boolean(issues));
}
async function action(button, fn) { button.disabled = true; try { await fn(); } catch (e) { message(e.message, true); } finally { button.disabled = false; } }
$('prediction-form').addEventListener('submit', event => {
  event.preventDefault(); action($('generate'), async () => {
    message('Calculating recent form and available prices. AI is only called for eligible picks when enabled.');
    render(await api('/api/predict', { league: $('league').value, date: $('date').value, type: $('type').value, playerStat: $('player-stat').value,
      bookmaker: $('bookmaker').value, target: Number(document.querySelector('[name=target]:checked').value), minProbability: Number($('min-probability').value),
      aiEnabled: $('ai-enabled').checked, researchEnabled: $('research-enabled').checked, model: $('model').value.trim() }));
  });
});
$('league').addEventListener('change', () => action($('generate'), fixtures));
$('date').addEventListener('change', () => { dateChosenByUser = true; });
$('type').addEventListener('change', () => {
  $('player-controls').hidden = $('type').value !== 'player';
  $('market-help').textContent = $('type').value === 'lose' ? 'Selecting a team to lose means backing its opponent to win. This uses the opponent moneyline.'
    : $('type').value === 'player' ? 'Requires actual player prices and at least eight historical appearances.' : 'Game totals and winners use recent scoring and opponent points allowed.';
});
$('refresh-odds').addEventListener('click', () => action($('refresh-odds'), async () => {
  const result = await api('/api/refresh-odds', { league: $('league').value }); await fixtures(); message(result.skipped || `Prices ready: ${result.events} events, ${result.snapshots} bookmaker/market snapshots.`);
}));
$('fetch-props').addEventListener('click', () => action($('fetch-props'), async () => {
  if (!$('prop-event').value) throw new Error('Refresh game prices first to find available events');
  const r = await api('/api/player-odds', { league: $('league').value, eventId: $('prop-event').value });
  message(r.skipped || `${r.snapshots} player market snapshots returned. An empty result means this event has no available player markets in the feed.`);
}));
$('load-models').addEventListener('click', () => action($('load-models'), async () => {
  modelCatalog = await api('/api/models', {}); $('models').replaceChildren(...modelCatalog.map(m => option(m.id, `${m.name} / $${(m.promptPrice * 1e6).toFixed(3)} input, $${(m.completionPrice * 1e6).toFixed(3)} output per million tokens`)));
  message(`${modelCatalog.length} text models loaded, lowest token price first. Choose a model ID; none is selected automatically.`);
}));
$('model').addEventListener('change', () => {
  const m = modelCatalog.find(m => m.id === $('model').value);
  $('model-price').textContent = m ? `$${(m.promptPrice * 1e6).toFixed(3)} input / $${(m.completionPrice * 1e6).toFixed(3)} output per million tokens. A conservative cost cap is checked before each review.` : 'Enter an exact model ID. Availability and pricing are checked before review.';
});
$('download').addEventListener('click', () => { if (!prediction) return; const url = URL.createObjectURL(new Blob([JSON.stringify(prediction, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `courtside-${prediction.slipId}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
$('download-csv').addEventListener('click', () => {
  if (!prediction) return;
  const rows = [['rank', 'away', 'home', 'selection', 'decimal_odds', 'estimated_probability', 'bookmaker'],
    ...prediction.slip.picks.map((p, i) => [i + 1, p.away, p.home, p.label, p.odds, p.probability, p.bookmaker])];
  const csv = rows.map(row => row.map(value => { let cell = String(value ?? ''); if (typeof value === 'string' && /^[=+@\-\t\r]/.test(cell)) cell = `'${cell}`; return `"${cell.replaceAll('"', '""')}"`; }).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); const a = document.createElement('a'); a.href = url; a.download = `courtside-${prediction.slipId}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function boot() { try {
  config = await api('/api/config'); $('date').value = config.today; $('model').value = config.defaultModel;
  $('ai-enabled').disabled = !config.openrouterConfigured; $('research-enabled').disabled = !config.tavilyConfigured;
  $('ai-config').textContent = config.openrouterConfigured ? 'OpenRouter key configured on the server.' : 'Add OPENROUTER_API_KEY to .env, then restart the app.';
  $('research-config').textContent = config.tavilyConfigured ? 'Tavily key configured. Searches count toward the five-request limit.' : 'Add TAVILY_API_KEY to .env to enable optional research, then restart.';
  await fixtures(); $('connection').textContent = `${config.hosted ? 'PRIVATE' : 'LOCAL'} / DATA CONNECTED`;
} catch (e) { $('connection').textContent = 'CONNECTION ERROR'; message(e.message, true); } }
$('login-form').addEventListener('submit', event => {
  event.preventDefault(); $('sign-in').disabled = true;
  api('/api/login', { password: $('app-password').value }).then(async () => {
    $('app-password').value = ''; $('login-error').textContent = ''; $('login-dialog').close(); message(''); await boot();
  }).catch(e => { $('login-error').textContent = e.message; }).finally(() => { $('sign-in').disabled = false; });
});
boot();
