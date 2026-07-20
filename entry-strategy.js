const VALID_ENTRY_STRATEGIES = new Set(['PREPUMP', 'FIBONACCI']);

function normalizeEntryStrategy(value, fallback) {
  const normalized = String(value || fallback || '').trim().toUpperCase();
  return VALID_ENTRY_STRATEGIES.has(normalized) ? normalized : fallback;
}

function requiresFibonacci(strategy, requireFibZone) {
  return requireFibZone && normalizeEntryStrategy(strategy, 'FIBONACCI') === 'FIBONACCI';
}

module.exports = { normalizeEntryStrategy, requiresFibonacci };
