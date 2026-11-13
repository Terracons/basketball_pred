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
const lagosDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date(value));
function marketSelection() { const [type, stat] = $('type').value.split(':'); return { type, playerStat: stat || 'points' }; }
function clearResult() { prediction = null; $('slip').hidden = true; $('empty-state').hidden = false; message(''); }
function playerEvents() {
  if (!fixtureData) return;
  const selected = $('prop-event').value, market = { points: 'player_points', rebounds: 'player_rebounds', assists: 'player_assists', pra: 'player_points_rebounds_assists' }[marketSelection().playerStat];
  const events = fixtureData.events.filter(e => lagosDay(e.startsAt) === $('date').value);
  $('prop-event').replaceChildren(...(events.length ? events.map(e => option(e.id, `${e.away} at ${e.home}${e.freshMarkets?.includes(market) ? ' / prices loaded' : ''}`)) : [option('', 'Refresh to find games on this date')]));
  if (events.some(e => e.id === selected)) $('prop-event').value = selected;
  const loaded = events.filter(e => e.freshMarkets?.includes(market)).length;
  $('prop-note').textContent = `${loaded} of ${events.length} listed games have fresh ${marketSelection().playerStat.toUpperCase()} prices. Load several games for more choices. Each new game uses up to 1 odds credit; the batch loads at most 5. Cached requests are free. Player markets may be unavailable, especially in NCAA.`;
}
async function fixtures() {
  fixtureData = await api(`/api/fixtures?league=${$('league').value}`);
  if (!dateChosenByUser) {
    const dates = fixtureData.events.filter(e => e.freshMarkets?.length).map(e => lagosDay(e.startsAt)).sort();
    $('date').value = dates[0] || (fixtureData.fixtures[0] ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date(fixtureData.fixtures[0].starts_at)) : config.today);
  }
  const book = $('bookmaker').value;
  $('bookmaker').replaceChildren(option('', 'Choose automatically'), ...fixtureData.bookmakers.map(b => option(b, b)));
  if (fixtureData.bookmakers.includes(book)) $('bookmaker').value = book;
  playerEvents();
  const dates = [...new Set(fixtureData.events.filter(e => e.freshMarkets?.length).map(e => lagosDay(e.startsAt)))];
  $('price-note').textContent = `${fixtureData.fixtures.length} upcoming fixtures shown; ${fixtureData.freshPriceEvents} events with fresh prices.${dates.length ? ` Priced dates in Lagos: ${dates.join(', ')}.` : ' Prices are missing or expired. Refresh fixtures and prices to load current games.'} Refresh uses up to 2 odds credits; cached requests are free.`;
  $('coverage-note').textContent = `${fixtureData.coverageNote} ${fixtureData.latestCompletedAt ? `Latest stored result: ${new Date(fixtureData.latestCompletedAt).toLocaleString()}.` : ''} Bookmaker prices can differ from Stake and other sites.`;
}
function render(result) {
  prediction = result; $('empty-state').hidden = true; $('slip').hidden = false;
  const s = result.slip;
  $('slip-status').textContent = s.targetReached ? 'YOUR SLIP / TARGET REACHED' : s.picks.length ? 'YOUR SLIP / BELOW TARGET' : 'NO QUALIFYING GAMES';
  $('slip-title').textContent = `${s.target}-odds ${result.league.toUpperCase()} slip`;
  $('combined-odds').textContent = s.picks.length ? s.combinedOdds.toFixed(2) : 'N/A';
  $('pick-count').textContent = `${s.picks.length} ${s.picks.length === 1 ? 'pick' : 'picks'} • ${s.picks[0]?.bookmaker ?? 'No bookmaker'}`;
  $('all-win').textContent = s.estimatedAllWinProbability === null ? 'No combined chance estimate' : `All picks win: ${percent(s.estimatedAllWinProbability)} estimated`;
  $('request-count').textContent = `${result.aiRequestsAndSearches}/5 AI + search requests`;
  $('partial-reason').textContent = `${s.reason || `${result.qualifyingGameCount ?? s.picks.length} qualifying games considered. Actual combined odds are ${s.combinedOdds.toFixed(2)} against your ${s.target} minimum.${s.closeToTarget === false ? ' A closer combination to the target was not found with the available prices.' : ''}`} Each pick's estimated chance is ranked highest first. This slip is saved automatically.`;
  $('ticket-legs').replaceChildren();
  for (const [i, p] of s.picks.entries()) {
    const leg = document.createElement('li'); leg.className = 'ticket-leg';
    const game = text('div', '', 'ticket-game');
    game.append(text('span', `#${String(i + 1).padStart(2, '0')} / ${p.away} vs ${p.home}`, 'ticket-matchup'), text('strong', p.label), text('small', new Date(p.startsAt).toLocaleString()));
    const odds = text('div', '', 'ticket-number'); odds.append(text('small', 'Odds'), text('strong', p.odds.toFixed(2)));
    const chance = text('div', '', 'ticket-number ticket-chance'); chance.append(text('small', 'Est. chance'), text('strong', percent(p.probability)));
    leg.append(game, odds, chance); $('ticket-legs').append(leg);
  }
  $('odds-calculation').textContent = s.picks.length ? `${s.picks.map(p => p.odds.toFixed(2)).join(' × ')} = ${s.combinedOdds.toFixed(2)}` : 'No priced selections';
  $('method-note').textContent = `${result.methodology} ${s.probabilityNote}`;
  const coverage = result.marketCoverage;
  $('market-coverage').textContent = coverage ? `${coverage.scheduledGames} scheduled games on this filter, ${coverage.pricedEvents} events priced for this market, ${coverage.matchedEvents} matched to statistics, ${result.qualifyingGameCount} with qualifying picks. Generated ${new Date(result.generatedAt).toLocaleString()}.` : '';
  $('available-summary').textContent = `Browse available statistical picks (${result.availablePickCount ?? 0})`;
  $('available-picks').replaceChildren();
  for (const p of result.availablePicks ?? []) {
    const row = document.createElement('li');
    row.append(text('strong', `${p.away} vs ${p.home}: ${p.label}`), text('p', `${percent(p.probability)} estimated / ${p.odds.toFixed(2)} odds / ${p.bookmaker}${p.inSlip ? ' / On this slip' : ''}`, 'help'));
    $('available-picks').append(row);
  }
  $('picks').replaceChildren();
  for (const [i, p] of s.picks.entries()) {
    const card = document.createElement('article'); card.className = 'pick';
    const top = text('div', '', 'pick-top'); top.append(text('span', `${String(i + 1).padStart(2, '0')} / ${p.away} at ${p.home}`, 'game-meta'), text('span', percent(p.probability), 'estimate'));
    card.append(top, text('h3', p.label, 'pick-title'), text('p', `${p.odds.toFixed(2)} decimal odds • ${new Date(p.startsAt).toLocaleString()} • ${p.bookmaker}`, 'game-meta'));
    const details = document.createElement('details'); details.append(text('summary', 'Evidence and limitations'));
    const list = document.createElement('ul');
    const projection = p.projection;
    const facts = p.market.startsWith('player_') ? [`Projected ${projection.mean.toFixed(1)} from ${projection.samples} games; estimated minutes ${projection.minutes.toFixed(1)}.`,
      ...(projection.perMinuteRate !== undefined ? [`Per-minute production: ${projection.perMinuteRate.toFixed(2)}. Pace adjustment: ${projection.paceFactor.toFixed(2)}x; opponent adjustment: ${projection.opponentFactor.toFixed(2)}x. Distribution: ${projection.distribution ?? 'normal'}.`] : [])]
      : [`Projected score: ${p.home} ${projection.homeMean.toFixed(1)}, ${p.away} ${projection.awayMean.toFixed(1)}.`, `Recent sample: ${projection.homeSamples} home-team games, ${projection.awaySamples} away-team games.`];
    if (projection.model === 'efficiency-v1') {
      facts.push(`Expected pace: ${projection.expectedPossessions.toFixed(1)} possessions per ${projection.paceMinutes} minutes.`);
      for (const [name, metrics] of [[p.home, projection.homeMetrics], [p.away, projection.awayMetrics]]) {
        facts.push(`${name}: adjusted offense ${metrics.adjustedOffense.toFixed(1)}, defense ${metrics.adjustedDefense.toFixed(1)}, Net Rating ${metrics.adjustedNetRating.toFixed(1)} per 100 possessions.`);
        const f = metrics.factors, pct = value => value === null ? 'N/A' : percent(value);
        facts.push(`${name}: eFG ${pct(f.efg)}, offensive rebounds ${pct(f.offensiveReboundPct)}, defensive rebounds ${pct(f.defensiveReboundPct)}, turnover rate ${pct(f.turnoverRate)}, free-throw rate ${pct(f.freeThrowRate)}, assists/turnovers ${f.assistToTurnover === null ? 'N/A' : f.assistToTurnover.toFixed(2)}.`);
      }
      facts.push('Supporting percentages explain recent performance and are supplied to AI review when enabled. They do not receive extra independent prediction weights.');
    }
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
  message(`${s.targetReached ? `Your ${s.target}-odds slip is ready with ${s.picks.length} ${s.picks.length === 1 ? 'game' : 'games'}.` : s.picks.length ? `Only ${s.combinedOdds.toFixed(2)} odds are available for your filters. You can export these ${s.picks.length} selections.` : 'No priced selections match these filters. Check the messages below, or try another date or market.'} ${issues}`, Boolean(issues));
}
async function action(button, fn) { button.disabled = true; try { await fn(); } catch (e) { message(e.message, true); } finally { button.disabled = false; } }
$('prediction-form').addEventListener('submit', event => {
  event.preventDefault(); action($('generate'), async () => {
    message('Loading available game prices and finding a combination for your target odds...');
    const selected = marketSelection();
    render(await api('/api/predict', { league: $('league').value, date: $('date').value, ...selected, playerDirection: $('player-direction').value,
      ...(selected.type === 'player' && $('prop-event').value ? { playerEventId: $('prop-event').value } : {}),
      bookmaker: $('bookmaker').value, target: Number(document.querySelector('[name=target]:checked').value), minProbability: Number($('min-probability').value),
      aiEnabled: $('ai-enabled').checked, researchEnabled: $('research-enabled').checked, model: $('model').value.trim() }));
  });
});
$('league').addEventListener('change', () => { clearResult(); dateChosenByUser = false; action($('generate'), fixtures); });
$('date').addEventListener('change', () => { clearResult(); dateChosenByUser = true; playerEvents(); });
$('type').addEventListener('change', () => {
  clearResult(); const selected = marketSelection(); $('player-controls').hidden = selected.type !== 'player'; playerEvents();
  $('market-help').textContent = selected.type === 'lose' ? 'Selecting a team to lose means backing its opponent to win. This uses the opponent moneyline.'
    : selected.type === 'player' ? `Individual player ${selected.playerStat.toUpperCase()}. Choose over, under, or both. At least eight historical appearances and real prices are required.` : 'Full-game totals and winners include overtime. Forecasts use efficiency and pace where available.';
});
for (const id of ['player-direction', 'bookmaker', 'min-probability']) $(id).addEventListener('change', clearResult);
document.querySelector('.targets').addEventListener('change', clearResult);
$('refresh-odds').addEventListener('click', () => action($('refresh-odds'), async () => {
  clearResult(); message('Refreshing fixtures, recent statistics and prices...');
  const result = await api('/api/refresh-odds', { league: $('league').value, date: $('date').value }); await fixtures(); message(result.skipped || `Prices ready: ${result.events} events, ${result.snapshots} bookmaker/market snapshots.`);
}));
$('fetch-props').addEventListener('click', () => action($('fetch-props'), async () => {
  if (!$('prop-event').value) throw new Error('Refresh game prices first to find available events');
  clearResult(); const r = await api('/api/player-odds', { league: $('league').value, eventId: $('prop-event').value, playerStat: marketSelection().playerStat });
  await fixtures(); message(r.skipped || r.warning || `${r.snapshots} player market snapshots returned for this game.`);
}));
$('fetch-props-batch').addEventListener('click', () => action($('fetch-props-batch'), async () => {
  clearResult(); message('Loading the selected player market for up to five games within your quota...');
  const r = await api('/api/player-odds-batch', { league: $('league').value, date: $('date').value, playerStat: marketSelection().playerStat });
  await fixtures(); message(r.skipped || `${r.events} games checked, ${r.snapshots} bookmaker/market snapshots loaded; ${r.alreadyLoaded} already had fresh prices, ${r.recentlyUnavailable} recently returned none. ${r.remainingEvents} games left to check. ${(r.errors ?? []).join(' ')}`);
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
