/**
 * 增量重算引擎不变量测试（无第三方依赖：node --test 内置 runner）。
 * 运行：见 frontend/scripts/run-domain-tests.mjs（esbuild 临时打包后执行）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RecomputeEngine, type EngineSeed } from './engine'
import type { FeatureTemplate, LabelRule } from './types'

const NOW = 1_700_000_000_000

function makeSeed(): EngineSeed {
  // 三个窗口、每个窗口两个已发布模板；规则按输出字段引用模板。
  const templates: FeatureTemplate[] = [
    { templateId: 'T-A1', name: '窗口A模板1', outputField: 'f_a1', windowId: 'W-A', published: true },
    { templateId: 'T-A2', name: '窗口A模板2', outputField: 'f_a2', windowId: 'W-A', published: true },
    { templateId: 'T-B1', name: '窗口B模板1', outputField: 'f_b1', windowId: 'W-B', published: true },
    { templateId: 'T-B2', name: '窗口B模板2', outputField: 'f_b2', windowId: 'W-B', published: true },
    { templateId: 'T-C1', name: '窗口C模板1', outputField: 'f_c1', windowId: 'W-C', published: true },
    // 未发布模板：不参与重算，也不产生向量。
    { templateId: 'T-C2', name: '窗口C草稿模板', outputField: 'f_c2', windowId: 'W-C', published: false },
  ]
  const rules: LabelRule[] = [
    { ruleId: 'R-A', name: '规则A', featureFields: ['f_a1', 'f_a2'], windowId: '', effective: true, businessCycle: 'CYCLE-1' },
    { ruleId: 'R-B', name: '规则B', featureFields: ['f_b1'], windowId: '', effective: true, businessCycle: 'CYCLE-1' },
    { ruleId: 'R-C', name: '规则C', featureFields: ['f_c1'], windowId: '', effective: true, businessCycle: 'CYCLE-2' },
  ]
  return { templates, rules, now: NOW }
}

function submit(engine: RecomputeEngine, overrides: Partial<Parameters<RecomputeEngine['submit']>[0]> = {}) {
  return engine.submit({
    requestId: 'req-default',
    windowId: 'W-A',
    windowVersion: 2,
    businessCycle: 'CYCLE-1',
    arbitration: 'window-incremental',
    reason: '窗口A变更',
    ...overrides,
  })
}

test('基线：完整向量、每规则一条命中、首版覆盖率', () => {
  const engine = new RecomputeEngine(makeSeed())
  const snap = engine.snapshot()

  assert.equal(snap.vectors.length, 5, '未发布模板不产生向量')
  assert.equal(snap.hits.length, 3)
  assert.ok(snap.hits.every((hit) => hit.windowVersion === 1))
  assert.ok(snap.hits.every((hit) => hit.labelVersion === 'LV-0000'))
  assert.equal(snap.coverage[0].denominator, 3)
  assert.equal(snap.coverage[0].numerator, snap.hits.filter((h) => h.hit).length)
  assert.equal(snap.reviews.length, 3)
})

test('只修改一个时间窗口：未引用该窗口的规则与命中保持原版本', () => {
  const engine = new RecomputeEngine(makeSeed())
  const beforeB = engine.snapshot().hits.find((h) => h.ruleId === 'R-B')!
  const beforeC = engine.snapshot().hits.find((h) => h.ruleId === 'R-C')!

  const result = submit(engine, { requestId: 'req-a-v2', windowId: 'W-A', windowVersion: 2 })
  assert.equal(result.outcome, 'recomputed')

  const snap = engine.snapshot()
  const hitA = snap.hits.find((h) => h.ruleId === 'R-A')!
  const hitB = snap.hits.find((h) => h.ruleId === 'R-B')!
  const hitC = snap.hits.find((h) => h.ruleId === 'R-C')!

  assert.equal(hitA.windowVersion, 2)
  assert.equal(hitA.labelVersion, result.batch.labelVersion)
  // R-B/R-C 未引用 W-A：命中 id 与版本保持不变。
  assert.equal(hitB.hitId, beforeB.hitId)
  assert.equal(hitB.windowVersion, 1)
  assert.equal(hitC.hitId, beforeC.hitId)
  assert.equal(hitC.windowVersion, 1)

  // 未受影响模板沿用上一完整向量，并带来源版本审计。
  const vectorB1 = snap.vectors.find((v) => v.templateId === 'T-B1')!
  assert.equal(vectorB1.sourceWindowVersion, 1)
  assert.equal(vectorB1.inherited, true)
  const vectorA1 = snap.vectors.find((v) => v.templateId === 'T-A1')!
  assert.equal(vectorA1.inherited, false)
  assert.equal(vectorA1.sourceWindowVersion, 2)
})

test('增量重算只扫描受影响模板与规则，不整批重复扫描', () => {
  const engine = new RecomputeEngine(makeSeed())
  const baselineScans = engine.snapshot().totalScans

  submit(engine, { requestId: 'req-a-v2', windowId: 'W-A', windowVersion: 2 })

  const snap = engine.snapshot()
  // 只扫描 W-A 的 2 个模板 + 受影响的 1 条规则，而不是 5 模板 + 3 规则整批重扫。
  assert.equal(snap.totalScans - baselineScans, 3)
  const batch = snap.batches.find((b) => b.labelVersion !== 'LV-0000')!
  assert.deepEqual(batch.recomputedTemplates.sort(), ['T-A1', 'T-A2'])
  assert.deepEqual(batch.affectedRuleIds, ['R-A'])
})

test('覆盖率稳定边界：分母恒定，命中按 1:1 替换而非累计', () => {
  const engine = new RecomputeEngine(makeSeed())
  submit(engine, { requestId: 'req-a-v2', windowId: 'W-A', windowVersion: 2 })
  submit(engine, { requestId: 'req-b-v2', windowId: 'W-B', windowVersion: 2 })

  const history = engine.coverageHistory()
  assert.ok(history.length >= 3)
  for (const cov of history) {
    assert.equal(cov.denominator, 3, '规则-窗口对总数是稳定边界')
    assert.ok(cov.numerator <= cov.denominator)
    assert.equal(cov.rate, Number((cov.numerator / cov.denominator).toFixed(4)))
  }
  const snap = engine.snapshot()
  assert.equal(snap.hits.length, 3, '命中总数不随重算累计')
})

test('同内容提交两个窗口版本只产生一次有效重算，后到请求复用且不累计覆盖率', () => {
  const engine = new RecomputeEngine(makeSeed())
  const first = submit(engine, { requestId: 'req-1', windowId: 'W-A', windowVersion: 2, reason: '窗口A变更' })
  const coverageLenAfterFirst = engine.coverageHistory().length
  const scansAfterFirst = engine.snapshot().totalScans

  const second = submit(engine, { requestId: 'req-2', windowId: 'W-A', windowVersion: 2, reason: '窗口A变更' })

  assert.equal(second.outcome, 'dedup-reused')
  assert.equal(second.reusedLabelVersion, first.batch.labelVersion)
  assert.equal(engine.coverageHistory().length, coverageLenAfterFirst, '复用不新增覆盖率快照')
  assert.equal(engine.snapshot().totalScans, scansAfterFirst, '复用零扫描')
  assert.equal(engine.snapshot().hits.length, 3)
})

test('再次提交异请求撞同一窗口版本：只保留一个增量结果，另一请求按冲突处理', () => {
  const engine = new RecomputeEngine(makeSeed())
  const first = submit(engine, { requestId: 'req-1', windowId: 'W-A', windowVersion: 2, reason: '窗口A更正' })
  const clash = submit(engine, {
    requestId: 'req-2',
    windowId: 'W-A',
    windowVersion: 2,
    reason: '窗口A另一理由',
  })

  assert.equal(clash.outcome, 'conflict-rejected')
  assert.equal(clash.reusedLabelVersion, first.batch.labelVersion)
  assert.equal(clash.batch.hitIds.length, 0, '冲突批次不产生命中')
  assert.equal(clash.batch.scanCount, 0)

  const snap = engine.snapshot()
  const activeBatches = snap.batches.filter((b) => b.outcome !== 'conflict-rejected')
  const forVersion = activeBatches.filter((b) => b.windowId === 'W-A' && b.windowVersion === 2)
  assert.equal(forVersion.length, 1, '每个窗口版本只保留一个有效增量命中结果')
  assert.equal(snap.hits.length, 3, '冲突不累计命中/覆盖率')
})

test('仲裁一：受影响窗口增量 → 局部窗口刷新清单', () => {
  const engine = new RecomputeEngine(makeSeed())
  // 先建立 W-A@v2，迟到的同窗口更正落在同一规则 R-A。
  submit(engine, { requestId: 'req-a-v2', windowId: 'W-A', windowVersion: 2 })
  const arbitrated = submit(engine, {
    requestId: 'req-a-v3-late',
    windowId: 'W-A',
    windowVersion: 3,
    arbitration: 'window-incremental',
    reason: '迟到窗口更正',
  })

  assert.equal(arbitrated.outcome, 'conflict-arbitrated')
  assert.deepEqual(arbitrated.batch.affectedRuleIds, ['R-A'], '只刷新受影响窗口内规则')
  const refreshList = engine.windowRefreshList('W-A')
  assert.equal(refreshList.length, 1)
  assert.equal(refreshList[0].ruleId, 'R-A')
  assert.equal(refreshList[0].windowVersion, 3)
  // 同周期但不同窗口的 R-B 不动。
  const hitB = engine.snapshot().hits.find((h) => h.ruleId === 'R-B')!
  assert.equal(hitB.windowVersion, 1)
  assert.ok(arbitrated.batch.replacedHitIds.length >= 1, '记录被替换的旧命中')
})

test('仲裁二：业务周期整体重算 → 周期级替换命中清单', () => {
  const engine = new RecomputeEngine(makeSeed())
  submit(engine, { requestId: 'req-a-v2', windowId: 'W-A', windowVersion: 2 })
  const arbitrated = submit(engine, {
    requestId: 'req-a-v3-cycle',
    windowId: 'W-A',
    windowVersion: 3,
    businessCycle: 'CYCLE-1',
    arbitration: 'cycle-recompute',
    reason: '周期整体重算',
  })

  assert.equal(arbitrated.outcome, 'conflict-arbitrated')
  assert.deepEqual(
    arbitrated.batch.affectedRuleIds.sort(),
    ['R-A', 'R-B'],
    '同业务周期规则全部纳入替换',
  )
  const cycleList = engine.cycleReplacementList('CYCLE-1')
  assert.equal(cycleList.length, 2)
  assert.ok(cycleList.every((hit) => hit.labelVersion === arbitrated.batch.labelVersion))
  // 另一业务周期 CYCLE-2 的 R-C 保持原版本。
  const hitC = engine.snapshot().hits.find((h) => h.ruleId === 'R-C')!
  assert.equal(hitC.windowVersion, 1)
  assert.equal(hitC.labelVersion, 'LV-0000')
})

test('不变量：每次标签命中只引用一个窗口版本', () => {
  const engine = new RecomputeEngine(makeSeed())
  submit(engine, { requestId: 'r1', windowId: 'W-A', windowVersion: 2 })
  submit(engine, {
    requestId: 'r2',
    windowId: 'W-A',
    windowVersion: 3,
    arbitration: 'cycle-recompute',
  })

  for (const hit of engine.snapshot().hits) {
    assert.equal(typeof hit.windowVersion, 'number')
    const versions = new Set(hit.fieldSnapshot.map((f) => f.windowVersion))
    versions.add(hit.windowVersion)
    assert.equal(versions.size, 1, `命中 ${hit.hitId} 引用了多个窗口版本`)
  }
})

test('复核清单随增量结果更新，未受影响项保持原标签版本', () => {
  const engine = new RecomputeEngine(makeSeed())
  const result = submit(engine, { requestId: 'req-a-v2', windowId: 'W-A', windowVersion: 2 })
  const reviews = engine.snapshot().reviews

  const reviewA = reviews.find((r) => r.ruleId === 'R-A')!
  const reviewB = reviews.find((r) => r.ruleId === 'R-B')!
  assert.equal(reviewA.labelVersion, result.batch.labelVersion)
  assert.equal(reviewA.windowVersion, 2)
  assert.equal(reviewB.labelVersion, 'LV-0000', '未受影响复核项保持原版本')
  assert.equal(reviewB.windowVersion, 1)
})

test('调用链：特征模板在特征工程与行动标签间可核对，向量沿用上一完整版', () => {
  const engine = new RecomputeEngine(makeSeed())
  submit(engine, { requestId: 'req-a-v2', windowId: 'W-A', windowVersion: 2 })

  const chain = engine.ruleCallChain('R-A')
  assert.equal(chain.windowId, 'W-A')
  assert.equal(chain.chain.length, 2)
  assert.deepEqual(
    chain.chain.map((c) => c.templateId).sort(),
    ['T-A1', 'T-A2'],
  )
  assert.ok(chain.chain.every((c) => c.vectorWindowVersion === 2))

  const chainB = engine.ruleCallChain('R-B')
  assert.equal(chainB.chain[0].inherited, true)
  assert.equal(chainB.chain[0].hitWindowVersion, 1)
})

test('装配校验：规则引用缺失字段或跨窗口模板时直接报错', () => {
  const base = makeSeed()
  assert.throws(
    () =>
      new RecomputeEngine({
        templates: base.templates,
        rules: [
          { ruleId: 'RX', name: 'x', featureFields: ['not-exist'], windowId: '', effective: true, businessCycle: 'C' },
        ],
      }),
    /不存在的特征字段/,
  )
  assert.throws(
    () =>
      new RecomputeEngine({
        templates: base.templates,
        rules: [
          { ruleId: 'RY', name: 'y', featureFields: ['f_a1', 'f_b1'], windowId: '', effective: true, businessCycle: 'C' },
        ],
      }),
    /跨多个时间窗口/,
  )
})
