type ModelStats = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
};

const modelStats: Record<string, ModelStats> = {};

export function accumulateModelUsage(mu: unknown) {
  if (!mu || typeof mu !== "object") return;
  for (const [model, raw] of Object.entries(mu as Record<string, unknown>)) {
    const u = raw as Partial<ModelStats>;
    if (!modelStats[model]) {
      modelStats[model] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
      };
    }
    const s = modelStats[model];
    s.inputTokens += u.inputTokens ?? 0;
    s.outputTokens += u.outputTokens ?? 0;
    s.cacheReadInputTokens += u.cacheReadInputTokens ?? 0;
    s.cacheCreationInputTokens += u.cacheCreationInputTokens ?? 0;
    s.webSearchRequests += u.webSearchRequests ?? 0;
    s.costUSD += u.costUSD ?? 0;
  }
}

function fmtN(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function formatUsage(totalCost: number, totalTurns: number): string {
  const totals = Object.values(modelStats).reduce(
    (acc, s) => ({
      in: acc.in + s.inputTokens,
      out: acc.out + s.outputTokens,
      cr: acc.cr + s.cacheReadInputTokens,
      cw: acc.cw + s.cacheCreationInputTokens,
    }),
    { in: 0, out: 0, cr: 0, cw: 0 },
  );
  const head = `$${totalCost.toFixed(4)} · ${totalTurns} turns · in=${fmtN(totals.in)} out=${fmtN(totals.out)} cache(r/w)=${fmtN(totals.cr)}/${fmtN(totals.cw)}`;
  const models = Object.entries(modelStats);
  if (models.length === 0) return `${head} · (no model data yet)`;
  if (models.length === 1) return head;
  const perModel = models
    .map(([m, s]) => `${m}:$${s.costUSD.toFixed(4)}`)
    .join(" ");
  return `${head} · [${perModel}]`;
}
