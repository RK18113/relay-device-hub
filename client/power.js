export const watts = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${value.toFixed(1)} W` : 'Unavailable';

// Keep measurement scopes separate: battery output and wall input are different.
export function powerPlot(points, kind, scope, gapMs = 90000) {
  const samples = points.map(point => ({ time: Date.parse(point.receivedAt),
    value: point.power?.[kind]?.scope === scope ? point.power[kind].watts : null }))
    .filter(point => Number.isFinite(point.time)).sort((a, b) => a.time - b.time);
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const readings = samples.filter(point => valid(point.value));
  const ceiling = Math.max(10, Math.ceil(Math.max(0, ...readings.map(point => point.value)) * 1.1 / 10) * 10);
  const start = samples[0]?.time || 0, span = Math.max(1, (samples.at(-1)?.time || start) - start);
  const segments = []; let segment = [], previous = null;
  for (const sample of samples) {
    if (!valid(sample.value) || (previous != null && sample.time - previous > gapMs)) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (valid(sample.value)) segment.push({ x: 8 + (sample.time - start) / span * 584, y: 102 - sample.value / ceiling * 94 });
    previous = sample.time;
  }
  if (segment.length) segments.push(segment);
  return { segments, readings, ceiling, peak: readings.length ? Math.max(...readings.map(point => point.value)) : null };
}
