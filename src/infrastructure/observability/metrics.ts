/**
 * In-process metrics registry (~research D10): counters, gauges, histograms
 * with rolling 1000-sample windows reporting p50/p95/p99. Volatile BY DESIGN —
 * restart resets; durable figures are derived from the database on read.
 * Safe only because lead-api runs with `instances: 1` (load-bearing).
 */

export const METRIC_NAMES = {
  httpRequestDurationMs: 'http_request_duration_ms',
  middlewareDurationMs: 'middleware_duration_ms',
  captureToAssignMs: 'lead_capture_to_assign_ms',
  configCacheHitsTotal: 'config_cache_hits_total',
  configCacheMissesTotal: 'config_cache_misses_total',
  brokerExclusionsTotal: 'broker_exclusions_total',
  leadsCapturedTotal: 'leads_captured_total',
  leadsRoutedTotal: 'leads_routed_total',
} as const;

type Labels = Record<string, string | number>;

function key(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const pairs = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v)}"`)
    .join(',');
  return `${name}{${pairs}}`;
}

interface HistogramSnapshot {
  count: number;
  sumMs: number;
  p50: number;
  p95: number;
  p99: number;
}

class Histogram {
  private readonly samples: number[] = [];
  private sum = 0;

  constructor(private readonly windowSize = 1000) {}

  observe(value: number): void {
    this.samples.push(value);
    this.sum += value;
    if (this.samples.length > this.windowSize) {
      this.sum -= this.samples.shift() as number;
    }
  }

  snapshot(): HistogramSnapshot {
    if (this.samples.length === 0) {
      return { count: 0, sumMs: 0, p50: 0, p95: 0, p99: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const pct = (p: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ??
      0;
    return {
      count: this.samples.length,
      sumMs: Math.round(this.sum * 100) / 100,
      p50: pct(50),
      p95: pct(95),
      p99: pct(99),
    };
  }
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();

  incCounter(name: string, labels?: Labels, by = 1): void {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  setGauge(name: string, value: number, labels?: Labels): void {
    this.gauges.set(key(name, labels), value);
  }

  observeHistogram(name: string, valueMs: number, labels?: Labels): void {
    let h = this.histograms.get(key(name, labels));
    if (h === undefined) {
      h = new Histogram();
      this.histograms.set(key(name, labels), h);
    }
    h.observe(valueMs);
  }

  snapshot(): {
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, HistogramSnapshot>;
  } {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters) counters[k] = v;
    const gauges: Record<string, number> = {};
    for (const [k, v] of this.gauges) gauges[k] = v;
    const histograms: Record<string, HistogramSnapshot> = {};
    for (const [k, h] of this.histograms) histograms[k] = h.snapshot();
    return { counters, gauges, histograms };
  }
}
