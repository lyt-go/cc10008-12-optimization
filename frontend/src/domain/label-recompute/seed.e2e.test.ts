/**
 * 端到端冒烟：用真实 SEED_ROWS 的 feature/action 清单走完整数据流
 * （adapters → RecomputeEngine → 提交/复用/冲突/仲裁），不依赖浏览器。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildEngineSeed, RecomputeEngine } from './index'
import { SEED_ROWS } from '@/data/seed'

test('真实播种清单可装配引擎，并完成一次完整增量重算流程', () => {
  const seed = buildEngineSeed(SEED_ROWS.feature, SEED_ROWS.action)
  assert.ok(seed.templates.length >= 2, '特征模板已播种')
  assert.ok(seed.rules.length >= 1, '至少一条生效标签规则可装配')

  const engine = new RecomputeEngine(seed)
  const baseline = engine.snapshot()
  assert.ok(baseline.hits.length >= 1)
  assert.ok(baseline.hits.every((h) => h.labelVersion === 'LV-0000'))

  // 窗口标识与下一版本号都从引擎读取：适配器的 rule.windowId 要等内核链接后才填充。
  const targetWindow = baseline.hits[0].windowId
  const targetCycle = seed.rules.find((r) => r.ruleId === baseline.hits[0].ruleId)!.businessCycle
  const v2Version = engine.nextWindowVersion(targetWindow)

  // v2：首个非基线重算 → recomputed。
  const v2 = engine.submit({
    requestId: 'e2e-1',
    windowId: targetWindow,
    windowVersion: v2Version,
    businessCycle: targetCycle,
    arbitration: 'window-incremental',
    reason: '窗口变更',
  })
  assert.equal(v2.outcome, 'recomputed')

  // 同内容重提 → 幂等复用，不新增覆盖率。
  const coverageBefore = engine.coverageHistory().length
  const reuse = engine.submit({
    requestId: 'e2e-2',
    windowId: targetWindow,
    windowVersion: v2Version,
    businessCycle: targetCycle,
    arbitration: 'window-incremental',
    reason: '窗口变更',
  })
  assert.equal(reuse.outcome, 'dedup-reused')
  assert.equal(engine.coverageHistory().length, coverageBefore)

  // 异请求撞同一窗口版本 → 冲突驳回。
  const clash = engine.submit({
    requestId: 'e2e-3',
    windowId: targetWindow,
    windowVersion: v2Version,
    businessCycle: targetCycle,
    arbitration: 'window-incremental',
    reason: '另一种更正',
  })
  assert.equal(clash.outcome, 'conflict-rejected')

  // v3 迟到更正 → 冲突仲裁（周期整体重算）。
  const v3 = engine.submit({
    requestId: 'e2e-4',
    windowId: targetWindow,
    windowVersion: engine.nextWindowVersion(targetWindow),
    businessCycle: targetCycle,
    arbitration: 'cycle-recompute',
    reason: '迟到更正',
  })
  assert.equal(v3.outcome, 'conflict-arbitrated')

  // 全局不变量：每条命中只引用一个窗口版本；覆盖率分母恒定。
  const snap = engine.snapshot()
  for (const hit of snap.hits) {
    const versions = new Set(hit.fieldSnapshot.map((f) => f.windowVersion))
    versions.add(hit.windowVersion)
    assert.equal(versions.size, 1)
  }
  const denominators = new Set(snap.coverage.map((c) => c.denominator))
  assert.equal(denominators.size, 1, '覆盖率分母（稳定边界）全程不变')
})
