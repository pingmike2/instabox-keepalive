// InstaBox keepalive on Cloudflare Workers — renews activity leases from a cron
// trigger, so no machine of your own has to stay up doing it.
//
// 单账号：只设 INSTABOX_API_KEY，可选 INSTABOX_MACHINE 指定机器。
// 多账号：第 N 个账号的变量名 = 单账号变量名 + _N，加一个账号就多加一个 Secret：
//
//   INSTABOX_API_KEY      1 号账号的 key（也可以写成 INSTABOX_API_KEY_1）
//   INSTABOX_API_KEY_2    2 号账号的 key
//   INSTABOX_API_KEY_3    3 号账号的 key ……
//
// 检修轮转默认开：只有显式 INSTABOX_CYCLE=0（或 off/false/no）才关掉。
// 关掉时 INSTABOX_CYCLE_AT / INSTABOX_PEAK_HOURS / INSTABOX_CYCLE_MARGIN_MIN 一律不生效，
// Worker 只做「续租 + 409 自动唤醒」。
// 默认开的情况下：INSTABOX_CYCLE_AT 不写就用 DEFAULT_CYCLE_AT（01:30/08:00/13:00/19:00），
// 写了 INSTABOX_PEAK_HOURS 就按高峰自动排，两者都写则 CYCLE_AT 优先。
//
// 每个账号还可以单独覆盖 INSTABOX_MACHINE_2 / INSTABOX_LEASE_2 /
// INSTABOX_LEASE_TTL_2 / INSTABOX_AUTO_RESUME_2 / INSTABOX_CYCLE_2 /
// INSTABOX_CYCLE_MARGIN_MIN_2；不写就继承不带后缀的全局值。
// 同一把 key 配多次只续一次；编号可以不连续（只配 _2 也行）。
//
//   GET /                     所有账号各续租一次（手动触发，必写一条日志）
//   GET /status               所有账号的机器状态（含 max-run 剩余分钟 / 冷却截止）
//   GET /accounts             当前认到了哪些账号（key 打码）
//   GET /log                  最近 48 条保活日志（需要 KV 绑定 LOG）
//   GET /release              放掉租约
// 都要带 ?token=...（设了 TOKEN 变量时）；可加 &format=text 看纯文本；
// 加 &account=2 只操作 2 号账号（编号见 /accounts）。
//
// 变量 INSTABOX_LOG_MODE 控制写 KV 的频次（免费额度 1000 次写/天）：
//   hourly（默认）同一小时的连续成功只写 1 条 ≈24 次/天，失败立刻记
//   every  每次续租都写（*/9 = 160 次/天，仍在额度内）
//   off    完全不写 KV，/log 会是空的
//
// 机器被平台挂起（suspended）或停掉时，续租会 409 machine_not_running —— 此时光续租没用，
// 得先唤醒：自动 POST /resume（stopped 的用 /start 兜底）→ 等 running → 再续租。
// INSTABOX_AUTO_RESUME=0 可以关掉这个自愈。
//
// max run time：免费机固定 480 分钟（8 小时），跑满会被平台强制挂起并进入 10 分钟冷却
// （Machine.cooldownUntil，冷却期内所有唤醒路径都回 409 machine_cooldown）。
// 默认轮转：连续运行剩 INSTABOX_CYCLE_MARGIN_MIN 分钟（默认 20）时，
// 自己先 suspend 再 resume，把「连续运行」计时清零，代价是短暂暂停而不是 10 分钟停机。
// 设成 0 就只等冷却结束再唤醒（每 8 小时停 10 分钟以上）。
//
// 想固定重启时间段：INSTABOX_CYCLE_AT="02:00,08:00,14:00,20:00"（本地时间，逗号分隔），
// INSTABOX_CYCLE_TZ="Asia/Shanghai" 指定时区，到点后 INSTABOX_CYCLE_WINDOW_MIN（默认 30）
// 分钟内轮转一次，同一个点只轮转一次。时间点之间要小于 8 小时，否则还是会撞上限。
// INSTABOX_CYCLE_MARGIN_MIN=0 可以关掉「快到上限」的兜底轮转，只按时间点走。
//
// 不想手算时间点就配高峰时段：INSTABOX_PEAK_HOURS="10-12,14-18,20-23"，Worker 会自动
// 排出「全部落在空档、间隔尽量均匀、最大 7 小时」的重启点（INSTABOX_CYCLE_AT 优先于它）。
//
// 随机抖动（都是为了别显得像定时脚本，格式都是 "min-max"）：
//   INSTABOX_CYCLE_JITTER_MIN  到点后随机延迟几分钟才执行（默认 0-0）
//   INSTABOX_CYCLE_HOLD_SEC    主动轮转时 suspend 后停几秒再 resume（默认 0-0，上限 300）
//   INSTABOX_WAKE_JITTER_MIN   平台冷却结束后再随机等几分钟才唤醒（默认 0-0）
// 注意：平台那 10 分钟冷却本身改不了（服务端行为），能加的只是"结束后多等一会儿"。
const API_DEFAULT = "https://api.instabox.sh";
const LEASE_DEFAULT = "keepalive";
const TTL_DEFAULT = 900; // 要比 cron 间隔大；*/5 下 300 正好卡在边界，900 有 3 倍余量
// 检修轮转的默认时间表：没写 INSTABOX_CYCLE_AT 时用这套
// （间隔 6.5/5/6/6.5 小时，都小于 8 小时上限）。
const DEFAULT_CYCLE_AT = "01:30,08:00,13:00,19:00";

function clampTtl(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 30 && n <= 3600 ? n : fallback;
}

function parseAutoResume(value, fallback) {
  if (!value) return fallback;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

// 主动轮转的提前量（分钟）：连续运行快到上限（免费机 8 小时）时，自己先 suspend→resume，
// 把「连续运行」计时清零，免得被平台在整点强制挂起再吃 10 分钟冷却。
function clampMargin(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 1 && n <= 120 ? n : fallback;
}

// 定时轮转的窗口宽度（分钟）：到点后这么多分钟内允许触发（cron 9 分钟一轮，30 分钟 = 3 次机会）
function clampWindow(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 1 && n <= 180 ? n : fallback;
}

// "10-15" / "10" → {min,max}；留空用默认值；用来做随机抖动区间
function parseRange(value, fallbackMin, fallbackMax, max) {
  const raw = String(value ?? "").trim();
  if (!raw) return { min: fallbackMin, max: fallbackMax };
  const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(raw);
  if (!m) return { min: fallbackMin, max: fallbackMax };
  let a = Number(m[1]);
  let b = m[2] === undefined ? a : Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { min: fallbackMin, max: fallbackMax };
  if (a > b) [a, b] = [b, a];
  return { min: Math.min(a, max), max: Math.min(b, max) };
}

const rangeText = (r) => (r.min === r.max ? String(r.min) : `${r.min}-${r.max}`);

// 稳定的伪随机：同一个种子永远得到同一个值，cron 反复跑不会让时间点跳来跳去
function stableRand(seed, max) {
  if (!(max > 0)) return 0;
  let h = 2166136261;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % (max + 1);
}

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// "02:00,08:00,14:00,20:00" → [{h,m,minutes}]；留空 = 不定时，只按「快到 8 小时」兜底
function parseCycleAt(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const out = [];
  for (const piece of raw.split(/[,\s]+/)) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(piece);
    if (!m) continue;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) continue;
    out.push({ h, mi, minutes: h * 60 + mi });
  }
  return out.sort((a, b) => a.minutes - b.minutes);
}

const cycleAtText = (slots) => slots.map((s) => `${String(s.h).padStart(2, "0")}:${String(s.mi).padStart(2, "0")}`).join(",");

// "10-12,14-18,20-23" → [{s,e}]（分钟，已合并重叠）；支持 10:30-12:00 和跨零点 23-02
function parsePeaks(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const out = [];
  for (const piece of raw.split(/[,\s]+/)) {
    const m = /^(\d{1,2})(?::(\d{2}))?-(\d{1,2})(?::(\d{2}))?$/.exec(piece);
    if (!m) continue;
    const s = Number(m[1]) * 60 + Number(m[2] || 0);
    const e = Number(m[3]) * 60 + Number(m[4] || 0);
    if (s < 0 || s > 1440 || e < 0 || e > 1440 || s === e) continue;
    if (e > s) out.push({ s, e });
    else {
      out.push({ s, e: 1440 });
      out.push({ s: 0, e });
    }
  }
  out.sort((a, b) => a.s - b.s);
  const merged = [];
  for (const seg of out) {
    const last = merged[merged.length - 1];
    if (last && seg.s <= last.e) last.e = Math.max(last.e, seg.e);
    else merged.push({ ...seg });
  }
  return merged;
}

// 高峰之外的空档：[[600,720],[840,1080],[1200,1380]] → [{s:0,e:600},{s:720,e:840},...]
function offPeak(peaks) {
  if (!peaks.length) return [{ s: 0, e: 1440 }];
  const segs = [];
  let cur = 0;
  for (const p of peaks) {
    if (p.s > cur) segs.push({ s: cur, e: p.s });
    cur = Math.max(cur, p.e);
  }
  if (cur < 1440) segs.push({ s: cur, e: 1440 });
  return segs;
}

const inSegs = (segs, m) => segs.some((x) => m >= x.s && m < x.e);

// 给定高峰时段，自动挑出「全在空档里、间隔尽量均匀」的重启点。
// 目标：任意两次间隔 ≤ 7 小时（离 8 小时上限留 1 小时余量），次数越少越好。
const slotCache = new Map();
function autoSlots(peaks) {
  if (!peaks.length) return [];
  const key = peaks.map((p) => `${p.s}-${p.e}`).join(",");
  const hit = slotCache.get(key);
  if (hit) return hit;

  const segs = offPeak(peaks);
  const TARGET = 420; // 7 小时
  let best = null;
  for (let n = 2; n <= 8; n++) {
    const step = 1440 / n;
    for (let phase = 0; phase < 1440; phase += 5) {
      const pts = [];
      let ok = true;
      for (let i = 0; i < n; i++) {
        const p = Math.round(phase + i * step) % 1440;
        if (!inSegs(segs, p)) {
          ok = false;
          break;
        }
        pts.push(p);
      }
      if (!ok) continue;
      const gaps = pts.map((p, i) => (pts[(i + 1) % n] - p + 1440) % 1440 || 1440);
      const maxGap = Math.max(...gaps);
      if (!best || maxGap < best.maxGap) best = { pts, maxGap };
    }
    if (best && best.maxGap <= TARGET) break; // 找到满足余量的最少次数就停
  }

  // 排出来的最大间隔如果还是 ≥8 小时，这套高峰定义就没法既避开高峰又不被平台挂，
  // 返回空让调用方退回「快到上限才转」，比给一个注定撞上限的时间表强
  const slots = (best && best.maxGap < 480 ? best.pts : [])
    .sort((a, b) => a - b)
    .map((m) => ({ h: Math.floor(m / 60), mi: m % 60, minutes: m }));
  slotCache.set(key, slots);
  return slots;
}

function safeTz(value) {
  const tz = String(value ?? "").trim() || "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "Asia/Shanghai";
  }
}

// 某个 UTC 时刻在 tz 里是几号几点（Workers 里 Intl 可用）
function tzParts(ts, tz) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(ts))) p[type] = value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

// tz 比 UTC 快多少毫秒（东八区 = +28800000）
function tzOffset(ts, tz) {
  const p = tzParts(ts, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

// tz 时区的「某天 hh:mm」→ UTC 毫秒（两遍逼近，夏令时也够用）
function zonedToUtc(y, mo, d, h, mi, tz) {
  const target = Date.UTC(y, mo - 1, d, h, mi, 0);
  let ts = target;
  for (let i = 0; i < 2; i++) ts = target - tzOffset(ts, tz);
  return ts;
}

// 最近一个已经到点的时间点：{ ts, at, inWindow }；刚过点 windowMin 分钟内才算「在窗口里」
function slotView(now, tz, slots, windowMin, jitter) {
  if (!slots.length) return null;
  const local = tzParts(now, tz);
  const yest = tzParts(now - 86_400_000, tz);
  const last = slots[slots.length - 1];
  const candidates = slots.map((s) => zonedToUtc(local.y, local.mo, local.d, s.h, s.mi, tz));
  // 跨零点：今天的点都还没到，就看昨天最后一班
  candidates.push(zonedToUtc(yest.y, yest.mo, yest.d, last.h, last.mi, tz));
  let ts = null;
  for (const c of candidates) if (c <= now && (ts === null || c > ts)) ts = c;
  if (ts === null) return null;
  // 抖动：每个时间点固定偏移（种子=时间戳），实际执行落在 [ts, ts+jitter] 里
  const jitterMin = jitter && jitter.max > 0 ? jitter.min + stableRand(ts, jitter.max - jitter.min) : 0;
  const effectiveMs = ts + jitterMin * 60_000;
  return {
    ts,
    effectiveMs,
    jitterMin,
    at: new Date(ts).toISOString(),
    effective: new Date(effectiveMs).toISOString(),
    inWindow: now >= effectiveMs && now - effectiveMs <= windowMin * 60_000,
  };
}

// 下一个还没到的时间点（/status 里告诉用户「下次轮转是几点」）
function nextSlot(now, tz, slots, jitter) {
  if (!slots.length) return null;
  const local = tzParts(now, tz);
  const tmr = tzParts(now + 86_400_000, tz);
  const candidates = slots.map((s) => zonedToUtc(local.y, local.mo, local.d, s.h, s.mi, tz));
  candidates.push(zonedToUtc(tmr.y, tmr.mo, tmr.d, slots[0].h, slots[0].mi, tz));
  let best = null;
  for (const c of candidates) if (c > now && (best === null || c < best)) best = c;
  if (best === null) return null;
  const jitterMin = jitter && jitter.max > 0 ? jitter.min + stableRand(best, jitter.max - jitter.min) : 0;
  return new Date(best + jitterMin * 60_000).toISOString();
}

function cfg(env) {
  // 轮转默认开：只有显式 INSTABOX_CYCLE=0（off/false/no）才关。
  // 关掉时 INSTABOX_CYCLE_AT / PEAK_HOURS 配了也不生效，时间点表直接作废。
  const cycleOn = parseAutoResume(env.INSTABOX_CYCLE, true);
  // 时间点优先级：手写 CYCLE_AT > 高峰自动排 > DEFAULT_CYCLE_AT。
  const peaks = parsePeaks(env.INSTABOX_PEAK_HOURS);
  const manualAt = parseCycleAt(env.INSTABOX_CYCLE_AT);
  const autoAt = !manualAt.length && peaks.length ? autoSlots(peaks) : [];
  // slotsAll = 未经 INSTABOX_CYCLE 裁剪的表，供子账号单独开 CYCLE 时继承
  const slotsAll = manualAt.length ? manualAt : peaks.length ? autoAt : parseCycleAt(DEFAULT_CYCLE_AT);
  const slots = cycleOn ? slotsAll : [];
  let cycleWarning =
    !manualAt.length && peaks.length && !autoAt.length
      ? "高峰时段太满：排不出间隔 < 8 小时的时间表，已退回「快到上限才转」"
      : "";
  if (!cycleOn && (manualAt.length || peaks.length)) {
    cycleWarning =
      "INSTABOX_CYCLE_AT / INSTABOX_PEAK_HOURS 已配置，但 INSTABOX_CYCLE=0 把轮转关了：要按时间点轮转请删掉这行或改成 1";
  }
  const base = {
    api: (env.INSTABOX_API_URL || API_DEFAULT).replace(/\/+$/, ""),
    lease: (env.INSTABOX_LEASE || LEASE_DEFAULT).trim() || LEASE_DEFAULT,
    ttl: clampTtl(env.INSTABOX_LEASE_TTL, TTL_DEFAULT),
    kv: env.LOG || null,
    // 被平台挂起后光续租没用，默认自愈：409 machine_not_running → resume/start → 再续租
    autoResume: parseAutoResume(env.INSTABOX_AUTO_RESUME ?? "1", true),
    // 快撞 max run time 时主动睡一觉再醒（默认开，INSTABOX_CYCLE=0 可关），提前量默认 20 分钟
    cycle: cycleOn,
    cycleMarginMin: clampMargin(env.INSTABOX_CYCLE_MARGIN_MIN, 20),
    // 定时轮转：手写时间点优先；没写但配了高峰时段，就按高峰自动排；都没有就用默认表
    cycleAt: slots,
    cycleAtAll: slotsAll,
    cycleAtManual: manualAt.length > 0,
    cycleAtDefault: !manualAt.length && !peaks.length,
    cycleWarning,
    cycleTz: safeTz(env.INSTABOX_CYCLE_TZ),
    cycleWindowMin: clampWindow(env.INSTABOX_CYCLE_WINDOW_MIN, 30),
    // 随机抖动：时间点偏移 / 停机时长 / 冷却结束后多久唤醒（都是为了不显得像定时脚本）
    cycleJitterMin: parseRange(env.INSTABOX_CYCLE_JITTER_MIN, 0, 0, 60),
    cycleHoldSec: parseRange(env.INSTABOX_CYCLE_HOLD_SEC, 0, 0, 900),
    wakeJitterMin: parseRange(env.INSTABOX_WAKE_JITTER_MIN, 0, 0, 30),
    peakHours: peaks,
    peakText: (env.INSTABOX_PEAK_HOURS || "").trim(),
    // hourly（默认）：同一小时的“成功”不重复写 KV，省额度；every：每次都写；off：不写
    logMode: (env.INSTABOX_LOG_MODE || "hourly").trim(),
  };
  if (!cycleWarning && base.cycleHoldSec.max > 600 && !base.kv) {
    cycleWarning = "停机时长 > 600 秒需要绑定 KV（LOG），否则会封顶 600 秒";
  }
  return { ...base, accounts: accountsOf(env, base) };
}

// "qqq" / "m_xxx,qqq" → ["m_xxx", "qqq"]；留空 = 该账号全部机器
function splitMachines(value) {
  if (value == null || value === "") return [];
  const arr = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

// 账号 N 的设置：带 _N 后缀的优先，其次是不带后缀的全局值，都没有就返回空（用内置默认）
function setting(env, name, n) {
  for (const key of [`INSTABOX_${name}_${n}`, `INSTABOX_${name}`]) {
    const value = env[key];
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

// 从 env 里找出所有 INSTABOX_API_KEY / INSTABOX_API_KEY_2 / _3 ……，按编号排序。
// 单个变量里也能塞多把 key：INSTABOX_API_KEY="ibk_aaa,ibk_bbb"（逗号分隔）→
// 按顺序拆成 1 号、2 号账号。多余的 key 往后找空位；显式 _N 变量永远优先占自己的编号。
const KEY_RE = /^INSTABOX_API_KEY(?:_(\d+))?$/;

// 单值里的多把 key："ibk_aaa, ibk_bbb, ibk_ccc" → [ibk_aaa, ibk_bbb, ibk_ccc]
function splitKeys(value) {
  return String(value ?? "")
    .split(/,+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function accountKeys(env) {
  const byNumber = new Map();
  const explicit = new Set();
  // 第一遍：每个编号变量认领自己的编号（同一编号两把不同 key，不带后缀的优先）
  for (const [name, value] of Object.entries(env)) {
    const m = KEY_RE.exec(name);
    if (!m) continue;
    const key = String(value ?? "").trim();
    if (!key) continue;
    const n = m[1] ? Number.parseInt(m[1], 10) : 1;
    if (!Number.isSafeInteger(n) || n < 1) continue;
    explicit.add(n);
    const keys = splitKeys(value);
    const prev = byNumber.get(n);
    const entry = { key: keys[0], name, suffixed: !!m[1], origin: name };
    if (!prev) {
      byNumber.set(n, entry);
    } else {
      const winner = prev.suffixed && !entry.suffixed ? entry : prev;
      if (prev.key !== keys[0]) {
        console.warn(
          `instabox-keepalive: ${prev.origin} 和 ${name} 都是 ${n} 号账号但 key 不同，用 ${winner.origin}`,
        );
      }
      byNumber.set(n, winner);
    }
  }
  // 第二遍：把每个变量里逗号分隔的“第二把以后”的 key 外推到空编号；
  // 显式 _N 的编号永不被外推挤占（explicit 里有记录）
  for (const [name, value] of Object.entries(env)) {
    const m = KEY_RE.exec(name);
    if (!m) continue;
    const s = String(value ?? "").trim();
    if (!s) continue;
    const n = m[1] ? Number.parseInt(m[1], 10) : 1;
    if (!Number.isSafeInteger(n) || n < 1) continue;
    for (const k of splitKeys(s).slice(1)) {
      let e = n;
      while (byNumber.has(e) || explicit.has(e)) e += 1;
      byNumber.set(e, { key: k, name: `${name}#${e}`, suffixed: true, origin: `${name} 里第 ${e - n + 1} 把` });
    }
  }
  return [...byNumber.entries()].sort((a, b) => a[0] - b[0]);
}

// 账号列表：每个账号就是一套「单账号变量 + _N 后缀」
function accountsOf(env, base) {
  const accounts = [];
  for (const [n, { key }] of accountKeys(env)) {
    if (accounts.some((a) => a.key === key)) {
      console.warn(`instabox-keepalive: ${n} 号账号的 key 和前面的重复，已跳过`);
      continue;
    }
    const at = setting(env, "CYCLE_AT", n);
    const pk = setting(env, "PEAK_HOURS", n);
    const peaks = pk ? parsePeaks(pk) : base.peakHours;
    // 账号级 CYCLE：不写就继承全局（全局默认关）。开了才让时间点表生效，
    // 所以账号单独设 INSTABOX_CYCLE_2=1 时，也能拿到 base 里未经裁剪的 slotsAll。
    const acctCycle = parseAutoResume(setting(env, "CYCLE", n), base.cycle);
    const acctAtAll = at ? parseCycleAt(at) : pk ? autoSlots(peaks) : base.cycleAtAll;
    let acctWarning = pk && !at && !autoSlots(peaks).length ? "高峰时段太满：排不出间隔 < 8 小时的时间表" : base.cycleWarning;
    if (!acctCycle && (at || pk)) {
      acctWarning = `INSTABOX_CYCLE_AT${n === 1 ? "" : `_${n}`} / INSTABOX_PEAK_HOURS${n === 1 ? "" : `_${n}`} 已配置，但 INSTABOX_CYCLE${n === 1 ? "" : `_${n}`}=0 把轮转关了：要按时间点轮转请删掉这行或改成 1`;
    }
    accounts.push({
      account: n,
      key,
      machine: splitMachines(setting(env, "MACHINE", n)),
      lease: setting(env, "LEASE", n) || base.lease,
      ttl: clampTtl(setting(env, "LEASE_TTL", n), base.ttl),
      autoResume: parseAutoResume(setting(env, "AUTO_RESUME", n), base.autoResume),
      cycle: acctCycle,
      cycleMarginMin: clampMargin(setting(env, "CYCLE_MARGIN_MIN", n), base.cycleMarginMin),
      cycleAt: acctCycle ? acctAtAll : [],
      cycleAtAll: acctAtAll,
      cycleAtManual: at ? true : pk ? false : base.cycleAtManual,
      cycleAtDefault: at ? false : pk ? false : base.cycleAtDefault,
      cycleWarning: acctWarning,
      cycleTz: safeTz(setting(env, "CYCLE_TZ", n) || base.cycleTz),
      cycleWindowMin: clampWindow(setting(env, "CYCLE_WINDOW_MIN", n), base.cycleWindowMin),
      cycleJitterMin: parseRange(setting(env, "CYCLE_JITTER_MIN", n), base.cycleJitterMin.min, base.cycleJitterMin.max, 60),
      cycleHoldSec: parseRange(setting(env, "CYCLE_HOLD_SEC", n), base.cycleHoldSec.min, base.cycleHoldSec.max, 900),
      kv: base.kv,
      wakeJitterMin: parseRange(setting(env, "WAKE_JITTER_MIN", n), base.wakeJitterMin.min, base.wakeJitterMin.max, 30),
      peakHours: peaks,
      peakText: pk || base.peakText,
      api: base.api,
    });
  }
  return accounts;
}

function pickAccounts(c, name) {
  if (!name) return c.accounts;
  const m = /^#?(\d+)$/.exec(name);
  if (!m) return [];
  const n = Number.parseInt(m[1], 10);
  return c.accounts.filter((a) => a.account === n);
}

function resolve(c, name) {
  if (!c.accounts.length) {
    return { error: "没配账号：加一个 INSTABOX_API_KEY（多账号再加 INSTABOX_API_KEY_2）" };
  }
  const picked = pickAccounts(c, name);
  if (!picked.length) {
    const have = c.accounts.map((a) => `#${a.account}`).join("、");
    return {
      error: /^#?\d+$/.test(name) ? `没有 ${name} 号账号；现在有 ${have}` : `?account= 要填账号编号，比如 2；现在有 ${have}`,
    };
  }
  return { picked };
}

async function call(c, method, path, body) {
  const res = await fetch(c.api + path, {
    method,
    headers: {
      "X-API-Key": c.key,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

// 机器列表：填了名字/id 就那几台，留空=这把 key 名下全部（isolate 内按账号缓存 10 分钟）
const listCache = new Map();

async function machines(acc) {
  const cacheKey = `${acc.api}\n${acc.key}\n${acc.machine.join(",")}`;
  const hit = listCache.get(cacheKey);
  // 缓存压到 60 秒：runStartedAt / cooldownUntil 是「快到 8 小时没有」的判断依据，不能太旧
  if (hit && Date.now() - hit.at < 60_000) return hit.value;

  const list = [];
  const missing = [];
  let error = "";
  if (acc.machine.length) {
    for (const sel of acc.machine) {
      if (sel.startsWith("m_")) {
        list.push({ id: sel, name: sel, state: "", raw: null });
        continue;
      }
      const r = await call(acc, "GET", `/v1/machines/${encodeURIComponent(sel)}`);
      if (r.ok && r.json?.id) list.push({ id: r.json.id, name: r.json.name || sel, state: r.json.state || "", raw: r.json });
      else missing.push(sel);
    }
  } else {
    const r = await call(acc, "GET", "/v1/machines");
    if (r.ok) {
      for (const m of r.json?.machines || []) list.push({ id: m.id, name: m.name, state: m.state || "", raw: m });
    } else {
      error = `列机器失败：HTTP ${r.status} ${(r.text || "").slice(0, 160)}`;
    }
  }

  const value = { list, missing, error };
  if (!error && !missing.length) listCache.set(cacheKey, { value, at: Date.now() });
  return value;
}

// 保活日志：绑了 KV（变量名 LOG）就留最近 48 条，没绑也能用，只是 /log 空
// hourly 模式下同一小时的连续成功只写 1 次（KV 免费额度每天 1000 次写），失败照样立刻记
async function logEvent(c, entry, force) {
  if (!c.kv || c.logMode === "off") return;
  try {
    const arr = JSON.parse((await c.kv.get("log")) || "[]");
    const last = arr[0];
    if (!force && c.logMode === "hourly" && entry.ok && last && String(last.at).slice(0, 13) === entry.at.slice(0, 13)) {
      return;
    }
    arr.unshift(entry);
    await c.kv.put("log", JSON.stringify(arr.slice(0, 48)), {
      expirationTtl: 604800,
    });
  } catch (e) {
    console.log("instabox-keepalive: 写日志失败", e.message);
  }
}

const lease = (c, id) =>
  call(c, "PUT", `/v1/machines/${id}/activity-leases/${c.lease}`, { ttlSeconds: c.ttl });

// 409 machine_not_running：机器被平台挂起（suspended）或停掉了，续租对它是无效的
const isNotRunning = (r) =>
  r.status === 409 && /not_running|suspended|stopped/i.test(r.text || "");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// 换状态的写操作要 Idempotency-Key（缺了 400）；key 带时间戳，重试不会撞旧 key
async function act(c, id, type) {
  const res = await fetch(`${c.api}/v1/machines/${id}/${type}`, {
    method: "POST",
    headers: { "X-API-Key": c.key, "Idempotency-Key": `ka-${type}-${id}-${Date.now()}` },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function getMachine(c, id) {
  const r = await call(c, "GET", `/v1/machines/${id}`);
  return r.ok ? r.json : null;
}

async function stateOf(c, id) {
  const info = await getMachine(c, id);
  return info?.state || "";
}

// max run time：免费机固定 480 分钟（8 小时），跑满会被平台强制挂起并进入冷却；
// 冷却期内所有唤醒路径都返回 409 machine_cooldown，只能用 cooldownUntil 判断什么时候能再叫醒它。
function maxRunView(info, now) {
  const maxRun = Number.isInteger(info?.maxRunMinutes) ? info.maxRunMinutes : -1;
  const startedAt = Date.parse(info?.runStartedAt ?? "");
  const cooldownUntil = Date.parse(info?.cooldownUntil ?? "");
  const limitAt = maxRun > 0 && Number.isFinite(startedAt) ? startedAt + maxRun * 60_000 : 0;
  return {
    maxRunMinutes: maxRun,
    runStartedAt: Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : null,
    cooldownUntil: Number.isFinite(cooldownUntil) ? new Date(cooldownUntil).toISOString() : null,
    remainingMinutes: limitAt ? Math.max(0, Math.round((limitAt - now) / 60_000)) : null,
    coolingDown: Number.isFinite(cooldownUntil) && cooldownUntil > now,
  };
}

// 挂了就先唤醒再续租：resume 优先，stopped 的用 start 兜底；running 后立刻续租一次。
// 冷却刚结束时 resume 可能是冷启动，给 40 秒再放弃（否则要等下一轮 cron，白丢 9 分钟）。
async function wakeThenLease(c, m) {
  const wake = [];
  for (const type of ["resume", "start"]) {
    const a = await act(c, m.id, type);
    wake.push(`${type}:${a.status}`);
    if (a.ok) break;
  }
  for (let i = 0; i < 8; i++) {
    await sleep(5000);
    if ((await stateOf(c, m.id)) === "running") {
      const r = await lease(c, m.id);
      return r.ok
        ? { ok: true, resumed: true, expiresAt: r.json?.expiresAt, wake }
        : { ok: false, resumed: true, status: r.status, error: r.text.slice(0, 200), wake };
    }
  }
  return { ok: false, resumed: true, status: 409, error: "已发唤醒，机器还没 running（下一轮再续）", wake };
}

// 主动轮转：在撞上 8 小时上限之前先 suspend（连续运行计时清零），再 resume 回来并重新续租。
// 生命周期操作会让旧租约失效，所以醒来必须再 lease 一次；进程通常会被保留（runtime.processesPreserved）。
async function cycleThenLease(c, m) {
  const wake = [];
  const s = await act(c, m.id, "suspend");
  wake.push(`suspend:${s.status}`);
  if (!s.ok) {
    return { ok: false, cycled: false, status: s.status, error: `主动轮转失败：suspend HTTP ${s.status} ${(s.text || "").slice(0, 120)}`, wake };
  }

  let slept = false;
  for (let i = 0; i < 8; i++) {
    await sleep(2000);
    if ((await stateOf(c, m.id)) === "suspended") {
      slept = true;
      break;
    }
  }
  if (!slept) return { ok: false, cycled: false, status: 409, error: "已发 suspend，机器还没进入 suspended（下一轮再看）", wake };

  // 可选：确认睡下后停一会儿再叫醒，让每次停机时长不是一个固定值。
  // ≤300 秒直接在本轮等；更长的停机超过一次 cron 调用的安全时长，写进 KV，下一轮再唤醒。
  const holdSec = randInt(c.cycleHoldSec.min, c.cycleHoldSec.max);
  if (holdSec > 0) {
    if (holdSec > 600 && c.kv) {
      const until = new Date(Date.now() + holdSec * 1000).toISOString();
      await c.kv.put(holdKey(m.id), until, { expirationTtl: holdSec + 3600 });
      wake.push(`hold:${holdSec}s(kv)`);
      return { ok: true, cycled: true, held: true, holdUntil: until, wake };
    }
    const waitSec = Math.min(holdSec, 600);
    wake.push(`hold:${waitSec}s${waitSec < holdSec ? "(已封顶 600s，绑 KV 才能停更久)" : ""}`);
    await sleep(waitSec * 1000);
  }

  let woke = false;
  for (const type of ["resume", "start"]) {
    const a = await act(c, m.id, type);
    wake.push(`${type}:${a.status}`);
    if (a.ok) {
      woke = true;
      break;
    }
  }
  if (!woke) return { ok: false, cycled: false, status: 409, error: "suspend 成功但 resume/start 失败（下一轮再看）", wake };

  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const info = await getMachine(c, m.id);
    if (info?.state === "running") {
      const r = await lease(c, m.id);
      // 带上轮转后的新 runStartedAt / 剩余分钟，日志里就不会还写着旧值
      const fresh = maxRunView(info, Date.now());
      return r.ok
        ? { ok: true, cycled: true, expiresAt: r.json?.expiresAt, wake, ...fresh }
        : { ok: false, cycled: true, status: r.status, error: r.text.slice(0, 200), wake, ...fresh };
    }
  }
  return { ok: false, cycled: true, status: 409, error: "轮转后机器还没 running（下一轮再续）", wake };
}

const holdKey = (id) => `hold:${id}`;

const noMachine = (acc) =>
  acc.machine.length ? `找不到机器 ${acc.machine.join("、")}（或 key 没权限）` : "这把 key 名下没有机器";

// 一个账号：把它的机器全部续一遍；单台失败不影响同账号其它机器
async function keepaliveAccount(acc, budget) {
  const { list, missing, error } = await machines(acc);
  if (error) return { account: acc.account, lease: acc.lease, ttl: acc.ttl, ok: false, error, machines: [] };
  if (!list.length) {
    return { account: acc.account, lease: acc.lease, ttl: acc.ttl, ok: false, error: noMachine(acc), machines: [] };
  }

  const results = [];
  for (const m of list) {
    const base = { machine: m.name, id: m.id };
    try {
      // 每次都取一次最新的机器对象：runStartedAt / cooldownUntil 靠它判断，
      // 列表缓存（60 秒）里的快照可能已经过期
      const info = (await getMachine(acc, m.id)) || m.raw || null;
      const now = Date.now();
      const view = maxRunView(info, now);
      const state = info?.state || m.state || "";

      // 已经被平台按 max run time 挂起、还在冷却：所有唤醒路径都会被拒，别白打接口。
      // 已经在 running 的不算（cooldownUntil 可能是还没清掉的旧值），照常续租。
      // 冷却结束后再随机等 0..WAKE_JITTER_MIN 分钟才叫醒（种子=cooldownUntil，结果稳定）。
      const wakeJitterMs =
        view.cooldownUntil && acc.wakeJitterMin.max > 0
          ? (acc.wakeJitterMin.min + stableRand(view.cooldownUntil, acc.wakeJitterMin.max - acc.wakeJitterMin.min)) * 60_000
          : 0;
      const wakeAtMs = view.cooldownUntil ? Date.parse(view.cooldownUntil) + wakeJitterMs : 0;
      if (wakeAtMs > now && state !== "running") {
        results.push({
          ...base,
          ok: false,
          coolingDown: true,
          cooldownUntil: view.cooldownUntil,
          wakeAt: new Date(wakeAtMs).toISOString(),
          wakeJitterMin: wakeJitterMs / 60_000,
          error: `max-run 冷却中，${new Date(wakeAtMs).toISOString()} 之后才能唤醒`,
        });
        continue;
      }

      // 主动停机中（KV 里记着 hold 截止时间）：时间没到就别叫醒它
      if (state === "suspended" && acc.kv) {
        const until = await acc.kv.get(holdKey(m.id));
        if (until) {
          const untilMs = Date.parse(until);
          if (Number.isFinite(untilMs) && untilMs > now) {
            results.push({ ...base, ok: true, held: true, holdUntil: until, ...view, note: "主动停机中，等 hold 结束再唤醒" });
            continue;
          }
          await acc.kv.delete(holdKey(m.id));
        }
      }

      const slot = acc.cycleAt.length
        ? slotView(now, acc.cycleTz, acc.cycleAt, acc.cycleWindowMin, acc.cycleJitterMin)
        : null;
      const startedMs = view.runStartedAt ? Date.parse(view.runStartedAt) : 0;

      // 定时窗口：到点后 windowMin 分钟内，且这台机器「这个点之后还没重启过」才轮转，
      // 所以一个时间点只会触发一次，不会在窗口里反复重启
      const dueBySlot = !!(acc.cycle && slot && slot.inWindow && state === "running" && startedMs < slot.effectiveMs);
      // 兜底：还没到时间点、但已经快到 8 小时上限了，也轮转一次（margin 设 0 可关掉）
      const dueByLimit = !!(
        acc.cycle &&
        acc.cycleMarginMin > 0 &&
        state === "running" &&
        view.remainingMinutes !== null &&
        view.remainingMinutes > 0 &&
        view.remainingMinutes <= acc.cycleMarginMin
      );
      const trigger = dueBySlot ? "slot" : dueByLimit ? "limit" : "";

      // 快撞 8 小时上限：先自己睡一下再醒，把连续运行计时清零，绕开平台的强制挂起 + 10 分钟冷却。
      // 每轮 cron 只轮转一台，避免一次调用把 50 个子请求额度用光（其余下一轮 9 分钟后轮到）。
      if (trigger) {
        if (budget && budget.cycles >= 1) {
          // 排不上队也先把租约续上，别让这台掉出租约保护
          const lr = await lease(acc, m.id);
          results.push({
            ...base,
            ok: lr.ok,
            expiresAt: lr.json?.expiresAt,
            deferred: true,
            trigger,
            ...(dueBySlot && slot ? { slotAt: slot.at, jitterMin: slot.jitterMin } : {}),
            ...view,
            note: "本轮已轮转过一台，这台下一轮再轮转",
          });
          continue;
        }
        if (budget) budget.cycles += 1;
        results.push({
          ...base,
          ...view,
          trigger,
          ...(dueBySlot && slot ? { slotAt: slot.at, jitterMin: slot.jitterMin } : {}),
          ...(await cycleThenLease(acc, m)),
        });
        continue;
      }

      const r = await lease(acc, m.id);
      if (r.ok) {
        results.push({ ...base, ok: true, expiresAt: r.json?.expiresAt, ...view });
      } else if (acc.autoResume && isNotRunning(r)) {
        // 被挂起了：续租是空转，先把它弄醒再续
        results.push({ ...base, ...view, ...(await wakeThenLease(acc, m)) });
      } else {
        results.push({ ...base, ok: false, status: r.status, error: r.text.slice(0, 200), ...view });
      }
    } catch (e) {
      results.push({ ...base, ok: false, error: e.message });
    }
  }

  const out = {
    account: acc.account,
    lease: acc.lease,
    ttl: acc.ttl,
    ok: results.every((r) => r.ok) && !missing.length,
    machines: results,
  };
  if (missing.length) out.error = `找不到机器 ${missing.join("、")}`;
  return out;
}

const flatten = (accounts) => accounts.flatMap((a) => a.machines.map((m) => ({ account: a.account, ...m })));

async function keepalive(c, opts = {}) {
  const { picked, error } = resolve(c, opts.account);
  if (error) {
    return { ok: false, at: new Date().toISOString(), error, count: 0, accounts: [], machines: [] };
  }

  const accounts = [];
  // 每轮 cron 最多主动轮转一台：一次轮转约 20 个子请求，免费版每次调用上限 50 个
  const budget = { cycles: 0 };
  for (const acc of picked) {
    try {
      accounts.push(await keepaliveAccount(acc, budget));
    } catch (e) {
      // 一个账号的异常不能拖垮其它账号
      accounts.push({ account: acc.account, lease: acc.lease, ttl: acc.ttl, ok: false, error: `续租异常：${e.message}`, machines: [] });
    }
  }

  const flat = flatten(accounts);
  const out = {
    ok: accounts.length > 0 && accounts.every((a) => a.ok),
    at: new Date().toISOString(),
    count: flat.length,
    accounts: accounts.map((a) => ({
      account: a.account,
      ok: a.ok,
      count: a.machines.length,
      lease: a.lease,
      ttl: a.ttl,
      error: a.error,
    })),
    machines: flat,
  };
  await logEvent(c, out, opts.forceLog);
  return out;
}

async function status(c, account) {
  const { picked, error } = resolve(c, account);
  if (error) return { ok: false, error, count: 0, accounts: [], machines: [] };

  const accounts = [];
  for (const acc of picked) {
    try {
      const { list, missing, error: err } = await machines(acc);
      if (err) {
        accounts.push({ account: acc.account, ok: false, error: err, count: 0, machines: [] });
        continue;
      }
      const ms = [];
      for (const m of list) {
        const r = await call(acc, "GET", `/v1/machines/${m.id}`);
        ms.push(
          r.ok
            ? {
                machine: m.name,
                id: m.id,
                state: r.json?.state,
                autoSuspendAfterSeconds: r.json?.autoSuspendAfterSeconds,
                autoSuspendedAt: r.json?.autoSuspendedAt ?? null,
                ...maxRunView(r.json, Date.now()),
                nextCycleAt: nextSlot(Date.now(), acc.cycleTz, acc.cycleAt, acc.cycleJitterMin),
                cycleAt: cycleAtText(acc.cycleAt) || null,
                cycleTz: acc.cycleAt.length ? acc.cycleTz : null,
              }
            : { machine: m.name, id: m.id, error: `HTTP ${r.status}` },
        );
      }
      accounts.push({
        account: acc.account,
        ok: ms.length > 0 && !missing.length && ms.every((x) => !x.error),
        count: ms.length,
        error: missing.length ? `找不到机器 ${missing.join("、")}` : undefined,
        machines: ms,
      });
    } catch (e) {
      accounts.push({ account: acc.account, ok: false, error: `查询异常：${e.message}`, count: 0, machines: [] });
    }
  }

  const flat = flatten(accounts);
  return { ok: accounts.length > 0 && accounts.every((a) => a.ok), count: flat.length, accounts, machines: flat };
}

async function release(c, account) {
  const { picked, error } = resolve(c, account);
  if (error) return { ok: false, error, count: 0, accounts: [], machines: [] };

  const accounts = [];
  for (const acc of picked) {
    try {
      const { list, missing, error: err } = await machines(acc);
      if (err) {
        accounts.push({ account: acc.account, ok: false, error: err, count: 0, machines: [] });
        continue;
      }
      const ms = [];
      for (const m of list) {
        const r = await call(acc, "DELETE", `/v1/machines/${m.id}/activity-leases/${acc.lease}`);
        ms.push({ machine: m.name, id: m.id, ok: r.ok || r.status === 404, status: r.status });
      }
      accounts.push({
        account: acc.account,
        ok: ms.length > 0 && !missing.length && ms.every((x) => x.ok),
        count: ms.length,
        error: missing.length ? `找不到机器 ${missing.join("、")}` : undefined,
        machines: ms,
      });
    } catch (e) {
      accounts.push({ account: acc.account, ok: false, error: `释放异常：${e.message}`, count: 0, machines: [] });
    }
  }

  const flat = flatten(accounts);
  return { ok: accounts.length > 0 && accounts.every((a) => a.ok), count: flat.length, accounts, machines: flat };
}

function maskKey(key) {
  if (!key) return "";
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function accountsView(c) {
  if (!c.accounts.length) return { ok: false, error: "没配账号：加一个 INSTABOX_API_KEY（多账号再加 INSTABOX_API_KEY_2）" };
  return {
    ok: true,
    count: c.accounts.length,
    accounts: c.accounts.map((a) => ({
      account: a.account,
      key: maskKey(a.key),
      machine: a.machine,
      lease: a.lease,
      ttl: a.ttl,
      autoResume: a.autoResume,
      cycle: a.cycle,
      cycleMarginMin: a.cycleMarginMin,
      cycleAt: cycleAtText(a.cycleAt) || null,
      // 没开 CYCLE 时时间点表是空的，来源也就没有意义
      cycleAtSource:
        a.cycle && a.cycleAt.length
          ? a.cycleAtManual
            ? "manual"
            : a.peakText
              ? "auto"
              : a.cycleAtDefault
                ? "default"
                : null
          : null,
      cycleWarning: a.cycleWarning || null,
      peakHours: a.peakText || null,
      cycleTz: a.cycleAt.length ? a.cycleTz : null,
      cycleWindowMin: a.cycleAt.length ? a.cycleWindowMin : null,
      cycleJitterMin: rangeText(a.cycleJitterMin),
      cycleHoldSec: rangeText(a.cycleHoldSec),
      wakeJitterMin: rangeText(a.wakeJitterMin),
      nextCycleAt: nextSlot(Date.now(), a.cycleTz, a.cycleAt, a.cycleJitterMin),
    })),
  };
}

export default {
  async scheduled(_event, env) {
    const out = await keepalive(cfg(env));
    if (out.ok) console.log("instabox-keepalive:", JSON.stringify(out));
    else console.error("instabox-keepalive:", JSON.stringify(out));
  },

  async fetch(request, env) {
    const c = cfg(env);
    const url = new URL(request.url);
    const asText = url.searchParams.get("format") === "text";
    if (env.TOKEN && url.searchParams.get("token") !== env.TOKEN) {
      return reply({ ok: false, error: "token 不对" }, 401, asText);
    }

    const route = url.pathname.replace(/\/+$/, "") || "/";
    const account = (url.searchParams.get("account") || "").trim();

    if (route === "/") {
      const out = await keepalive(c, { account, forceLog: true }); // 手动触发不给去重，一定出现在 /log
      return reply(out, out.ok ? 200 : 502, asText);
    }

    if (route === "/accounts") {
      const out = accountsView(c);
      return reply(out, out.ok ? 200 : 502, asText);
    }

    if (route === "/status") {
      const out = await status(c, account);
      return reply(out, out.ok ? 200 : 502, asText);
    }

    if (route === "/log") {
      const raw = c.kv ? await c.kv.get("log") : null;
      const entries = raw ? JSON.parse(raw) : [];
      return reply(
        {
          ok: true,
          storage: c.kv ? "KV 已绑定，保留最近 48 次（7 天）" : "未绑定 KV（变量 LOG），/log 为空",
          count: entries.length,
          entries,
        },
        200,
        asText,
      );
    }

    if (route === "/release") {
      const out = await release(c, account);
      return reply(out, out.ok ? 200 : 502, asText);
    }

    return reply(
      { ok: false, error: "用 / 续租、/status 状态、/accounts 账号、/log 日志、/release 放租约" },
      404,
      asText,
    );
  },
};

function reply(body, status, asText) {
  if (asText) {
    const lines = [`ok=${body.ok}`];
    if (body.error) lines.push(`error=${body.error}`);
    for (const a of body.accounts || []) {
      if (a.key) {
        // /accounts
        lines.push(`[#${a.account}] ${a.key} ${(a.machine || []).join(",") || "全部机器"} lease=${a.lease} ttl=${a.ttl}`);
      } else if (a.error) {
        lines.push(`[#${a.account}] FAIL ${a.error}`);
      }
    }
    for (const m of body.machines || []) {
      const bad = m.ok === false || !!m.error;
      const note = m.coolingDown
        ? `冷却至 ${m.cooldownUntil}`
        : m.cycled
          ? m.trigger === "slot"
            ? "定时轮转"
            : "兜底轮转"
          : m.remainingMinutes !== null && m.remainingMinutes !== undefined
            ? `剩 ${m.remainingMinutes} 分钟到上限`
            : "";
      lines.push(
        [
          m.account !== undefined ? `[#${m.account}]` : "",
          m.machine || m.name,
          bad ? "FAIL" : "ok",
          m.expiresAt || m.state || m.status || "",
          note,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    for (const e of body.entries || []) {
      lines.push(`${e.at} ok=${e.ok} 续租 ${e.count} 台`);
    }
    return new Response(lines.join("\n") + "\n", {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
