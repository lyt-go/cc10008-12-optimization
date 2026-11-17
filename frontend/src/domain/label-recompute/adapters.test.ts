/**
 * 适配层测试：验证既有数据流（feature/action 的 EntryRow）到引擎领域对象的投影，
 * 以及浏览器侧 lenient 装配对脏数据的容错。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildEngineSeed, parseFeatureRefs, ruleFromRow, templateFromRow } from './adapters'
import type { EntryRow } from '@/data/types'

function row(partial: Record<string, string | number | boolean>): EntryRow {
  return { id: 1, status: '已发布', pending: false, abnormal: false, ...partial }
}

test('parseFeatureRefs 支持中英文逗号、分号与空白分隔', () => {
  assert.deepEqual(parseFeatureRefs('a, b；c; d  e'), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(parseFeatureRefs(''), [])
})

test('templateFromRow 读取「时间窗口天」作为窗口、已发布状态决定参与重算', () => {
  const template = templateFromRow(
    row({
      模板编号: 'FEAT-1',
      特征名称: '下单频次',
      输出字段名: 'order_cnt',
      时间窗口天: '30d',
      status: '已发布',
    }),
  )
  assert.deepEqual(template, {
    templateId: 'FEAT-1',
    name: '下单频次',
    outputField: 'order_cnt',
    windowId: '30d',
    published: true,
  })
  const draft = templateFromRow(
    row({ 模板编号: 'FEAT-2', 特征名称: '草稿', 输出字段名: 'f2', 时间窗口天: '30d', status: '草稿' }),
  )
  assert.equal(draft.published, false)
})

test('ruleFromRow 把「触发事件组」拆成特征字段引用并读取统计周期', () => {
  const rule = ruleFromRow(
    row({
      规则编号: 'ACTI-1',
      标签名称: '高意向',
      触发事件组: 'order_cnt, stay_sec',
      统计周期: 'CYCLE-1',
      status: '已生效',
    }),
  )
  assert.equal(rule.ruleId, 'ACTI-1')
  assert.deepEqual(rule.featureFields, ['order_cnt', 'stay_sec'])
  assert.equal(rule.businessCycle, 'CYCLE-1')
  assert.equal(rule.effective, true)
})

test('lenient 装配：丢弃引用缺失字段的规则与引用未发布模板的生效规则', () => {
  const featureRows = [
    row({ 模板编号: 'T1', 特征名称: 't1', 输出字段名: 'f1', 时间窗口天: '30d', status: '已发布' }),
    row({ 模板编号: 'T2', 特征名称: 't2', 输出字段名: 'f2', 时间窗口天: '30d', status: '草稿' }),
  ]
  const actionRows = [
    row({ 规则编号: 'R1', 触发事件组: 'f1', 统计周期: 'C1', status: '已生效' }),
    row({ 规则编号: 'R2', 触发事件组: 'missing', 统计周期: 'C1', status: '已生效' }),
    row({ 规则编号: 'R3', 触发事件组: 'f2', 统计周期: 'C1', status: '已生效' }),
    row({ 规则编号: 'R4', 触发事件组: 'f2', 统计周期: 'C1', status: '草稿' }),
  ]

  const seed = buildEngineSeed(featureRows, actionRows)
  // R1 生效且引用已发布模板 → 保留；R2 引用缺失字段 → 丢弃；
  // R3 生效却引用草稿模板 → 丢弃；R4 是草稿规则，无向量也允许保留（由引擎在生效时再校验）。
  assert.deepEqual(seed.rules.map((r) => r.ruleId).sort(), ['R1', 'R4'])
})

test('严格装配保留引用未发布模板的生效规则，交给引擎内核校验', () => {
  const featureRows = [
    row({ 模板编号: 'T1', 特征名称: 't1', 输出字段名: 'f1', 时间窗口天: '30d', status: '草稿' }),
  ]
  const actionRows = [row({ 规则编号: 'R1', 触发事件组: 'f1', 统计周期: 'C1', status: '已生效' })]

  const strictSeed = buildEngineSeed(featureRows, actionRows, false)
  assert.equal(strictSeed.rules.length, 1, '严格模式不因模板未发布而过滤规则')

  const lenientSeed = buildEngineSeed(featureRows, actionRows, true)
  assert.equal(lenientSeed.rules.length, 0, 'lenient 模式下生效规则缺少可用向量会被过滤')
})
