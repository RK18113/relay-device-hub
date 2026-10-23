export const celsius = value => typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}°C` : 'Unavailable';
export const gpuSleeping = snapshot => snapshot?.gpu?.state === 'D3cold' || snapshot?.gpu?.state === 'D3hot' || snapshot?.gpu?.runtimeStatus === 'suspended';

// Missing sensors and reporting gaps must not become artificial zero temperatures.
export function thermalPlot(points, kind, gapMs = 90000) {
  const samples = points.map(point => ({
    time: Date.parse(point.receivedAt),
    value: kind === 'gpu' ? point.gpu?.temperatureC : point.temperatureC,
  })).filter(point => Number.isFinite(point.time)).sort((a, b) => a.time - b.time);
  const readings = samples.filter(point => typeof point.value === 'number' && Number.isFinite(point.value));
  const ceiling = Math.max(100, Math.ceil((Math.max(0, ...readings.map(point => point.value)) + 5) / 10) * 10);
  const start = samples[0]?.time || 0, span = Math.max(1, (samples.at(-1)?.time || start) - start);
  const segments = []; let segment = [], previous = null;
  for (const sample of samples) {
    const valid = typeof sample.value === 'number' && Number.isFinite(sample.value);
    if (!valid || (previous != null && sample.time - previous > gapMs)) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (valid) segment.push({ x: 8 + (sample.time - start) / span * 584, y: 102 - Math.max(0, sample.value) / ceiling * 94 });
    previous = sample.time;
  }
  if (segment.length) segments.push(segment);
  return { segments, readings, ceiling,
    low: readings.length ? Math.min(...readings.map(point => point.value)) : null,
    peak: readings.length ? Math.max(...readings.map(point => point.value)) : null };
}
