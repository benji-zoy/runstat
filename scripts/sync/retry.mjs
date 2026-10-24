// fetch avec nouvelles tentatives sur les erreurs passagères (réseau, 429, 5xx), délai croissant.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchRetry(
  url,
  init = {},
  { tries = 4, baseMs = 2000, timeoutMs = 60_000 } = {},
) {
  for (let attempt = 1; ; attempt++) {
    let res, error;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      error = e;
    }
    const transient = error || res.status === 429 || res.status >= 500;
    if (!transient || attempt >= tries) {
      if (error) throw error;
      return res;
    }
    const wait = baseMs * 2 ** (attempt - 1);
    const why = error ? error.name : `HTTP ${res.status}`;
    console.warn(`  ${new URL(url).host} : ${why}, nouvel essai dans ${wait / 1000} s`);
    await sleep(wait);
  }
}
