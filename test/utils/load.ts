/**
 * 부하 러너. 절대 수치는 머신마다 다르므로 테스트가 단정하지 않고 리포트로만 찍는다.
 * 테스트가 단정하는 것은 "부하를 줘도 깨지지 않아야 하는 불변식" 쪽이다.
 */

export type Outcome = { status: number; ms: number };

export type LoadReport = {
  name: string;
  total: number;
  concurrency: number;
  wallMs: number;
  rps: number;
  byStatus: Record<number, number>;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
};

const percentile = (sortedMs: number[], p: number) => {
  if (sortedMs.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedMs.length) - 1;
  return sortedMs[Math.min(sortedMs.length - 1, Math.max(0, rank))];
};

export const report = (
  name: string,
  outcomes: Outcome[],
  concurrency: number,
  wallMs: number,
): LoadReport => {
  const sorted = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  const byStatus: Record<number, number> = {};
  for (const { status } of outcomes) {
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  return {
    name,
    total: outcomes.length,
    concurrency,
    wallMs,
    rps: (outcomes.length / wallMs) * 1000,
    byStatus,
    avg: sorted.reduce((sum, ms) => sum + ms, 0) / (sorted.length || 1),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
  };
};

/** concurrency 개의 워커가 total 개의 요청을 나눠 던진다 */
export const runLoad = async ({
  name,
  total,
  concurrency,
  task,
}: {
  name: string;
  total: number;
  concurrency: number;
  task: (i: number) => Promise<number>;
}): Promise<LoadReport> => {
  const outcomes: Outcome[] = Array.from({ length: total }) as Outcome[];
  let next = 0;

  const worker = async () => {
    for (;;) {
      // JS 는 싱글 스레드라 await 없는 read-increment 는 원자적이다
      const i = next++;
      if (i >= total) return;

      const startedAt = performance.now();
      const status = await task(i);
      outcomes[i] = { status, ms: performance.now() - startedAt };
    }
  };

  const startedAt = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = performance.now() - startedAt;

  return report(name, outcomes, concurrency, wallMs);
};

const ms = (value: number) => `${value.toFixed(1)}ms`;

export const printReport = (r: LoadReport) => {
  const statuses = Object.entries(r.byStatus)
    .map(([status, count]) => `${status}:${count}`)
    .join(' ');

  console.log(
    [
      `\n[부하] ${r.name}`,
      `  요청 ${r.total} / 동시 ${r.concurrency} / 총 ${ms(r.wallMs)}`,
      `  처리량 ${r.rps.toFixed(0)} req/s`,
      `  지연 avg ${ms(r.avg)} p50 ${ms(r.p50)} p95 ${ms(r.p95)} p99 ${ms(r.p99)} max ${ms(r.max)}`,
      `  상태 ${statuses}`,
    ].join('\n'),
  );
};

/** 동시성별 충돌률처럼 행이 여러 개인 결과를 표로 찍는다 */
export const printTable = (title: string, rows: Record<string, unknown>[]) => {
  if (rows.length === 0) return;

  const columns = Object.keys(rows[0]);
  const width = (column: string) =>
    Math.max(column.length, ...rows.map((row) => String(row[column]).length));

  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padStart(width(columns[i])))
      .join('  ')
      .trimEnd();

  console.log(
    [
      `\n[부하] ${title}`,
      `  ${line(columns)}`,
      ...rows.map((row) => `  ${line(columns.map((c) => String(row[c])))}`),
    ].join('\n'),
  );
};

/** fetch 기반 최소 클라이언트. supertest 와 달리 커넥션을 새로 띄우지 않는다 */
export const apiClient = (baseUrl: string) => {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  return {
    get: (path: string) => call('GET', path),
    post: (path: string, body: unknown) => call('POST', path, body),
    patch: (path: string, body: unknown) => call('PATCH', path, body),
  };
};
