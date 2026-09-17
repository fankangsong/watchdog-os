import { useEffect, useRef, useState } from 'react';

// 通用轮询 hook：enabled 控制开关，reload 手动触发一次刷新
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  enabled = true
): { data: T | null; error: Error | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const run = async () => {
      try {
        const d = await fetcherRef.current();
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e as Error);
      }
    };
    run();
    const id = window.setInterval(run, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled, intervalMs, tick]);

  return { data, error, reload: () => setTick((t) => t + 1) };
}
