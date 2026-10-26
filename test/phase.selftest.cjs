'use strict'
/* 自检：node lib/phase.cjs 只做语法检查；跑本文件做判定检查 */
const P = require('../lib/phase.cjs')
const cfg = P.makeConfig({ pricing: { timezone: 'Asia/Shanghai', windows: '09:00-12:00,14:00-18:00', holidays: 'cn-2026' } })
const at = (iso) => Date.parse(iso)
const cases = [
  ['2026-10-26T10:00:00+08:00', 'peak', 120],       // 周一 10:00 峰
  ['2026-10-26T12:00:00+08:00', 'off-peak', 120],   // 窗口右开：12:00 谷，120 分钟后转峰
  ['2026-10-26T13:00:00+08:00', 'off-peak', 60],    // 13:00 谷，60 分钟后（14:00）转峰
  ['2026-10-26T18:00:00+08:00', 'off-peak', 900],   // 18:00 谷，明天 09:00 转峰 = 15h
  ['2026-10-25T10:00:00+08:00', 'off-peak', 1380],  // 周日，明天周一 09:00 → 23h
  ['2026-10-01T10:00:00+08:00', 'off-peak', 10020],  // 国庆（周四）整日谷；下次峰时 10-08 09:00（10-08 周四）
  ['2026-10-26T09:00:00+08:00', 'peak', 180],       // 窗口左闭：09:00 就是峰
]
let bad = 0
for (const [iso, phase, minutes] of cases) {
  const info = P.describe(at(iso), cfg)
  const ok = info.phase === phase && info.minutesUntil === minutes
  if (!ok) bad += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${iso} → ${info.phase} (${info.reason}) ×${info.multiplier} 下一次 ${info.nextPhase} 在 ${info.minutesUntil} 分`)
}
console.log('windows:', JSON.stringify(P.parseWindows('09:00-12:00,14:00-18:00')))
console.log('holidays size:', cfg.holidays.size, '| 2026-10-02 in set:', cfg.holidays.has('2026-10-02'), '| 2026-10-08 in set:', cfg.holidays.has('2026-10-08'))
console.log('summarize:', P.summarize(P.describe(at('2026-10-26T10:07:00+08:00'), cfg)))
console.log(bad === 0 ? 'ALL PASS' : `${bad} FAILED`)
process.exit(bad === 0 ? 0 : 1)
