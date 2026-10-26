'use strict'
/**
 * phase.cjs —— 峰谷时段的唯一实现。
 *
 * 为什么要一个 .cjs：同一份算法要在三处跑——宿主的 Cordis 插件（ESM）、
 * 覆盖层的 Electron 主进程（CJS）、覆盖层的渲染页面（classic script）。
 * 写成 UMD 就不用把这份极易算错的时间逻辑复制三遍。
 *
 * 口径（DeepSeek 官方定价页，2026-10 抓取）：
 *   "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday,
 *    excluding Chinese public holidays. All other hours are off-peak,
 *    including weekends and Chinese public holidays in full."
 *   → 北京时间 = UTC+8，峰时段正好落在 09:00-12:00、14:00-18:00（周一到周五），
 *     不跨午夜，所以按本地日期判星期、按本地分钟判时段即可。
 *   → 法定节假日与周末整天算谷时；调休上班的周末也仍然是谷时（官方口径写死了周末）。
 *
 * 节假日表只收录国务院已正式公布的年份（2026）。没收录的年份按"工作日峰时"处理：
 * 假日当天会多问你一句，但绝不会在真峰时放行——宁可多问，不可漏问。
 */
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module && module.exports) module.exports = api
  else if (root) root.ControlBarPhase = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  const DEFAULT_TIMEZONE = 'Asia/Shanghai'
  /** 峰时段（本地时间），含头不含尾 */
  const DEFAULT_WINDOWS = ['09:00-12:00', '14:00-18:00']

  /** 国务院办公厅关于 2026 年部分节假日安排的通知（国办发明电〔2025〕7 号） */
  const HOLIDAY_PRESETS = {
    'cn-2026': [
      ['2026-01-01', '2026-01-03'], // 元旦
      ['2026-02-15', '2026-02-23'], // 春节（九天）
      ['2026-04-04', '2026-04-06'], // 清明
      ['2026-05-01', '2026-05-05'], // 劳动节
      ['2026-06-19', '2026-06-21'], // 端午
      ['2026-09-25', '2026-09-27'], // 中秋
      ['2026-10-01', '2026-10-07'], // 国庆
    ],
    none: [],
  }

  const DAY_MS = 24 * 60 * 60 * 1000

  function pad(n) {
    return String(n).padStart(2, '0')
  }

  /** 'HH:MM' | 'H:MM' → 分钟数；非法返回 NaN */
  function toMinutes(text) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text == null ? '' : text))
    if (!m) return NaN
    const hh = Number(m[1])
    const mm = Number(m[2])
    if (hh > 24 || mm > 59) return NaN
    return hh * 60 + mm
  }

  /**
   * 接受多种写法，统一成 [{start, end}]（分钟）：
   *   '09:00-12:00,14:00-18:00' | ['09:00-12:00'] | [{start:'09:00',end:'12:00'}]
   *   | [{start:540,end:720}]（分钟数）
   */
  function parseWindows(input) {
    const out = []
    if (input == null) return parseWindows(DEFAULT_WINDOWS)
    const push = (start, end) => {
      const s = typeof start === 'number' ? start : toMinutes(start)
      const e = typeof end === 'number' ? end : toMinutes(end)
      if (!Number.isFinite(s) || !Number.isFinite(e)) return
      const from = Math.min(s, e)
      const to = Math.max(s, e)
      if (to > from) out.push({ start: from, end: to })
    }
    if (typeof input === 'string') {
      for (const chunk of input.split(',')) {
        const m = /^\s*([^-]+?)\s*-\s*(.+?)\s*$/.exec(chunk)
        if (m) push(m[1], m[2])
      }
    } else if (Array.isArray(input)) {
      for (const item of input) {
        if (typeof item === 'string') {
          const m = /^\s*([^-]+?)\s*-\s*(.+?)\s*$/.exec(item)
          if (m) push(m[1], m[2])
        } else if (item && typeof item === 'object') {
          push(item.start, item.end)
        }
      }
    } else if (input && typeof input === 'object') {
      push(input.start, input.end)
    }
    return out.length > 0 ? out : parseWindows(DEFAULT_WINDOWS)
  }

  /** 把云端日历日换算成当日 00:00 的本地时刻（时区由 tz 决定） */
  function dayKey(year, month, day) {
    return `${year}-${pad(month)}-${pad(day)}`
  }

  function eachDay(fromKey, toKey, visit) {
    const start = Date.parse(fromKey + 'T00:00:00Z')
    const end = Date.parse(toKey + 'T00:00:00Z')
    if (!Number.isFinite(start) || !Number.isFinite(end)) return
    for (let t = start; t <= end; t += DAY_MS) {
      const d = new Date(t)
      visit(dayKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()))
    }
  }

  /**
   * holidays 可以是：
   *   'cn-2026' | 'none' | '2026-01-01,2026-05-01' | ['2026-01-01'] | [['2026-01-01','2026-01-03']]
   * 返回 Set<'YYYY-MM-DD'>。
   */
  function buildHolidaySet(input) {
    const set = new Set()
    if (input == null) input = 'cn-2026'
    const add = (entry) => {
      if (typeof entry === 'string') {
        const text = entry.trim()
        if (text === '' || text === 'none') return
        if (HOLIDAY_PRESETS[text]) {
          for (const [from, to] of HOLIDAY_PRESETS[text]) eachDay(from, to, (k) => set.add(k))
          return
        }
        for (const piece of text.split(',')) {
          const [from, to] = piece.split('..')
          if (to) eachDay(from.trim(), to.trim(), (k) => set.add(k))
          else if (/^\d{4}-\d{2}-\d{2}$/.test(from.trim())) set.add(from.trim())
        }
        return
      }
      if (Array.isArray(entry)) {
        if (entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string') eachDay(entry[0], entry[1], (k) => set.add(k))
        else for (const item of entry) add(item)
      }
    }
    add(input)
    return set
  }

  /** 组装一份可直接喂给 phaseAt / describe 的配置 */
  function makeConfig(options) {
    const cfg = options || {}
    const pricing = cfg.pricing || cfg
    return {
      timezone: pricing.timezone || DEFAULT_TIMEZONE,
      windows: parseWindows(pricing.windows != null ? pricing.windows : DEFAULT_WINDOWS),
      holidays: buildHolidaySet(pricing.holidays),
      holidaySpec: pricing.holidays === undefined ? 'cn-2026' : pricing.holidays,
    }
  }

  const formatterCache = new Map()
  function formatterFor(tz) {
    let fmt = formatterCache.get(tz)
    if (fmt) return fmt
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterCache.set(tz, fmt)
    return fmt
  }

  /** 某一时刻在目标时区里的本地日历字段 */
  function localParts(epochMs, tz) {
    const parts = formatterFor(tz || DEFAULT_TIMEZONE).formatToParts(new Date(epochMs))
    const bag = {}
    for (const part of parts) if (part.type !== 'literal') bag[part.type] = part.value
    const year = Number(bag.year)
    const month = Number(bag.month)
    const day = Number(bag.day)
    const hour = Number(bag.hour) % 24
    const minute = Number(bag.minute)
    const second = Number(bag.second)
    // 星期按"本地日历日"算，不受时区偏移影响
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
    return { year, month, day, hour, minute, second, dow, minutes: hour * 60 + minute, key: dayKey(year, month, day) }
  }

  /** 本地日历时间 → 绝对时刻（两次偏移修正，兼容 DST 地区） */
  function zonedToEpoch(year, month, day, hour, minute, tz) {
    const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
    let t = guess
    for (let i = 0; i < 2; i += 1) {
      const lp = localParts(t, tz)
      const asUtc = Date.UTC(lp.year, lp.month - 1, lp.day, lp.hour, lp.minute, lp.second)
      t = guess - (asUtc - t)
    }
    return t
  }

  /** 单点判定：这一毫秒是峰时还是谷时 */
  function phaseAt(epochMs, config) {
    const cfg = config && config.windows ? config : makeConfig(config)
    const lp = localParts(epochMs, cfg.timezone)
    if (lp.dow === 0 || lp.dow === 6) return { phase: 'off-peak', reason: 'weekend', local: lp }
    if (cfg.holidays.has(lp.key)) return { phase: 'off-peak', reason: 'holiday', local: lp }
    for (const w of cfg.windows) {
      if (lp.minutes >= w.start && lp.minutes < w.end) return { phase: 'peak', reason: 'peak-window', local: lp }
    }
    return { phase: 'off-peak', reason: 'off-window', local: lp }
  }

  /**
   * 完整描述：当前时段 + 下一次切换时刻 + 本地时间。
   * 返回值里的 until 是绝对毫秒时间戳（没有下一次切换时为 null）。
   */
  function describe(nowMs, config) {
    const cfg = config && config.windows ? config : makeConfig(config)
    const now = Number.isFinite(nowMs) ? nowMs : Date.now()
    const current = phaseAt(now, cfg)
    const lp = current.local
    const tz = cfg.timezone

    // 阶段只在"日期边界"和"窗口边界"上变化，扫这些点就够，不用逐分钟推
    const boundaries = []
    for (let shift = 0; shift <= 8; shift += 1) {
      const anchor = new Date(Date.UTC(lp.year, lp.month - 1, lp.day + shift))
      const y = anchor.getUTCFullYear()
      const m = anchor.getUTCMonth() + 1
      const d = anchor.getUTCDate()
      boundaries.push(zonedToEpoch(y, m, d, 0, 0, tz))
      for (const w of cfg.windows) {
        boundaries.push(zonedToEpoch(y, m, d, Math.floor(w.start / 60), w.start % 60, tz))
        boundaries.push(zonedToEpoch(y, m, d, Math.floor(w.end / 60), w.end % 60, tz))
      }
    }
    const ahead = boundaries.filter((t) => t > now).sort((a, b) => a - b)
    let until = null
    for (const t of ahead) {
      if (phaseAt(t, cfg).phase !== current.phase) {
        until = t
        break
      }
    }

    const nextPhase = until === null ? null : current.phase === 'peak' ? 'off-peak' : 'peak'
    return {
      phase: current.phase,
      reason: current.reason,
      multiplier: current.phase === 'peak' ? 2 : 1,
      timezone: tz,
      localTime: `${pad(lp.hour)}:${pad(lp.minute)}`,
      localDate: lp.key,
      weekday: lp.dow,
      until,
      nextPhase,
      minutesUntil: until === null ? null : Math.max(0, Math.round((until - now) / 60000)),
    }
  }

  function formatUntil(minutesUntil) {
    if (minutesUntil === null || minutesUntil === undefined) return ''
    if (minutesUntil >= 60) {
      const h = Math.floor(minutesUntil / 60)
      const m = minutesUntil % 60
      return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
    }
    return `${minutesUntil} 分`
  }

  /** 给人看的一句话，例：「峰时 14:12（单价 ×2），还有 3 小时 48 分转谷时」 */
  function summarize(info) {
    if (!info) return ''
    const head = info.phase === 'peak' ? '峰时' : '谷时'
    const tail = info.nextPhase && info.minutesUntil !== null
      ? `，还有 ${formatUntil(info.minutesUntil)}转${info.nextPhase === 'peak' ? '峰时' : '谷时'}`
      : ''
    return `${head} ${info.localTime}（单价 ×${info.multiplier}）${tail}`
  }

  return {
    DEFAULT_TIMEZONE,
    DEFAULT_WINDOWS,
    HOLIDAY_PRESETS,
    parseWindows,
    buildHolidaySet,
    makeConfig,
    localParts,
    zonedToEpoch,
    phaseAt,
    describe,
    summarize,
    formatUntil,
  }
})
