// Arena scanner: incrementally scans ScoreSubmitted events on AgentAtlasV6 and
// maintains game/arena.json (daily arena standings by UTC day + watermark).
// Runs locally and in GitHub Actions. No dependencies (node >= 18, global fetch).
// Public BSC endpoints only tolerate ~500-block eth_getLogs ranges, so we chunk
// at 450 and rotate endpoints on any failure. State lives inside arena.json so
// the file is self-contained; the web page only reads the public fields.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ATLAS = '0x935e72e456cE6b2cc2c7Fa79bbCB843D44C7Eee1';
const TOPIC0 = '0xa35b52935dd375b09862bd5bbf5ef1da2ead1be5bf862f37fcbffdd5135a32eb';
const RPCS = ['https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed1.defibit.io', 'https://bnb.api.onfinality.io/public'];
const OUT = process.env.ARENA_OUT || 'game/arena.json';
// First-ever scan starts just before the V6 deployment (2026-11-18 18:51 UTC).
const GENESIS_SCAN = 134350000;
const CHUNK = 450;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rpcIdx = 0;
async function rpc(method, params) {
  let lastErr;
  // 3 rotation rounds with backoff: public endpoints rate-limit in bursts,
  // and dataseed reports limits as -32005 rather than 429.
  for (let round = 0; round < 3; round++) {
    for (let k = 0; k < RPCS.length; k++) {
      const url = RPCS[(rpcIdx + k) % RPCS.length];
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15000);
        let j;
        try {
          const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
          if (!res.ok) throw new Error('http ' + res.status);
          j = await res.json();
        } finally { clearTimeout(timer); }
        if (!j || j.error || j.result === undefined) throw new Error('rpc error ' + JSON.stringify(j && j.error));
        rpcIdx = (rpcIdx + k) % RPCS.length;
        return j.result;
      } catch (e) { lastErr = e; }
    }
    if (round < 2) await sleep(2000 * (round + 1));
  }
  throw lastErr || new Error('all endpoints failed for ' + method);
}
const hex = (n) => '0x' + n.toString(16);
function wordAt(data, i) { return BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64)); }

const SEL_GLOBAL_SUBS = '0x61a0b1b0'; // globalScoreSubmissions()

async function main() {
  let state = { watermark: GENESIS_SCAN - 1, days: {}, totalSeen: 0, slow: false, updatedAt: 0 };
  if (existsSync(OUT)) { try { state = JSON.parse(readFileSync(OUT, 'utf8')); } catch (e) {} }
  if (!state.days) state.days = {};
  if (typeof state.totalSeen !== 'number') state.totalSeen = 0;
  if (!state.watermark || state.watermark < GENESIS_SCAN - 1) state.watermark = GENESIS_SCAN - 1;

  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const from = state.watermark + 1;
  if (head < from) { console.log('arena: already at head', head); return; }

  const tsCache = new Map();
  async function blockDay(bn) {
    if (!tsCache.has(bn)) {
      const b = await rpc('eth_getBlockByNumber', [hex(bn), false]);
      tsCache.set(bn, Math.floor(parseInt(b.timestamp, 16) / 86400));
    }
    return tsCache.get(bn);
  }

  // Adaptive chunking (mirrors the proven pool-watch scanner): if a chunk
  // fails on every endpoint, split it in half down to 50 blocks before giving up.
  async function getLogsChunk(f, t) {
    try {
      return await rpc('eth_getLogs', [{ address: ATLAS, topics: [TOPIC0], fromBlock: hex(f), toBlock: hex(t) }]);
    } catch (e) {
      if (t - f > 50) {
        const mid = Math.floor((f + t) / 2);
        const a = await getLogsChunk(f, mid);
        const b = await getLogsChunk(mid + 1, t);
        return a.concat(b);
      }
      throw e;
    }
  }

  let added = 0;
  let nChunks = 0;
  let partial = false;
  const pace = state.slow ? 400 : 120;
  for (let cur = from; cur <= head; cur += CHUNK) {
    const to = Math.min(cur + CHUNK - 1, head);
    nChunks++;
    if (nChunks % 100 === 0) console.log(`arena: ...chunk ${nChunks}, at block ${to}/${head}, found ${added}`);
    await sleep(pace);
    let logs;
    try { logs = await getLogsChunk(cur, to); }
    catch (e) { console.log(`arena: chunk ${cur}-${to} unreachable (${e.message}); saving partial progress, next run resumes`); partial = true; break; }
    for (const log of logs) {
      state.totalSeen += 1; // every ScoreSubmitted event, both modes (verification counter)
      const mode = Number(wordAt(log.data, 0));
      if (mode !== 1) continue; // arena counts daily runs only
      const score = Number(wordAt(log.data, 1));
      const nights = Number(wordAt(log.data, 2));
      const agent = ('0x' + log.topics[1].slice(-40)).toLowerCase();
      const day = await blockDay(parseInt(log.blockNumber, 16));
      const dkey = String(day);
      if (!state.days[dkey]) state.days[dkey] = {};
      const cur2 = state.days[dkey][agent] || { best: 0, nights: 0, subs: 0 };
      cur2.subs += 1;
      if (score > cur2.best) { cur2.best = score; cur2.nights = nights; }
      state.days[dkey][agent] = cur2;
      added++;
    }
    state.watermark = to;
    // persist per chunk so an interrupted run loses nothing
    state.updatedAt = Math.floor(Date.now() / 1000);
    writeFileSync(OUT, JSON.stringify(state, null, 1));
  }
  if (!partial) {
    // Verification: public endpoints sometimes return empty arrays under rate
    // pressure instead of erroring, which would silently skip events. The
    // contract's globalScoreSubmissions counter, read at the same head block,
    // is the ground truth for how many ScoreSubmitted events exist in range.
    try {
      const raw = await rpc('eth_call', [{ to: ATLAS, data: SEL_GLOBAL_SUBS }, hex(head)]);
      const expected = Number(BigInt(raw));
      if (state.totalSeen !== expected) {
        console.log(`arena: VERIFY FAILED: saw ${state.totalSeen} events, contract says ${expected}. Resetting for a slow full rescan next run.`);
        state = { watermark: GENESIS_SCAN - 1, days: {}, totalSeen: 0, slow: true, updatedAt: Math.floor(Date.now() / 1000) };
        writeFileSync(OUT, JSON.stringify(state, null, 1));
        return;
      }
      state.slow = false;
      console.log(`arena: verified: ${state.totalSeen} events == globalScoreSubmissions at block ${head}`);
    } catch (e) {
      console.log('arena: verification read failed (' + e.message + '); keeping scan result unverified');
    }
  }
  // prune to the last 3 UTC days present
  const keys = Object.keys(state.days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 3))) delete state.days[k];
  state.updatedAt = Math.floor(Date.now() / 1000);
  writeFileSync(OUT, JSON.stringify(state, null, 1));
  console.log(`arena: scanned ${from}..${head}, new daily submissions: ${added}, days: ${Object.keys(state.days).join(',')}`);
}
main().catch((e) => { console.error('arena scan failed:', e.message); process.exit(1); });
