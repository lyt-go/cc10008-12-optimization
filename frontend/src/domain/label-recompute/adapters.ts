/**
 * 数据适配层：把既有 localStorage 数据层（feature / action 模块的 EntryRow）
 * 投影成增量重算引擎需要的领域对象。
 *
 * 修改点定位（按既有数据流）：
 *   特征工程 views/feature → local-service.listRows('feature')
 *     → 这里映射为 FeatureTemplate（「时间窗口天」即窗口标识）
 *   行动标签 views/action → local-service.listRows('action')
 *     → 这里映射为 LabelRule；「触发事件组」里引用特征模板的输出字段名，
 *       构成 action → feature 的调用链。
 */
import type { EntryRow } from '@/data/types'

import type { FeatureTemplate, LabelRule } from './types'

function text(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

/** 把「触发事件组」里的引用拆成特征输出字段名列表。 */
export function parseFeatureRefs(raw: string): string[] {
  return raw
    .split(/[，,;；\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export function templateFromRow(row: EntryRow): FeatureTemplate {
  return {
    templateId: text(row, '模板编号'),
    name: text(row, '特征名称'),
    outputField: text(row, '输出字段名'),
    windowId: text(row, '时间窗口天'),
    // 状态存在 EntryRow 的英文字段 status 上（见 data/types.ts）。
    published: String(row.status ?? '').trim() === '已发布',
  }
}

export function ruleFromRow(row: EntryRow): LabelRule {
  const refs = parseFeatureRefs(text(row, '触发事件组'))
  return {
    ruleId: text(row, '规则编号'),
    name: text(row, '标签名称'),
    featureFields: refs.length > 0 ? refs : [],
    windowId: '',
    effective: String(row.status ?? '').trim() === '已生效',
    businessCycle: text(row, '统计周期') || 'CYCLE-DEFAULT',
  }
}

/**
 * 按既有清单装配引擎种子。
 * lenient 模式（默认，面向浏览器里可能过期的 localStorage 数据）会丢弃：
 *   - 引用了不存在特征字段的规则；
 *   - 生效中却引用未发布模板的规则（没有可用向量会无法重算）。
 * 引擎内核本身仍保持严格校验，测试可直接 new RecomputeEngine 验证报错。
 */
export function buildEngineSeed(
  featureRows: EntryRow[],
  actionRows: EntryRow[],
  lenient = true,
): { templates: FeatureTemplate[]; rules: LabelRule[] } {
  const templates = featureRows
    .map(templateFromRow)
    .filter((item) => item.templateId && item.outputField)
  const fieldMap = new Map(templates.map((item) => [item.outputField, item]))

  const rules = actionRows
    .map(ruleFromRow)
    .filter((item) => item.ruleId && item.featureFields.length > 0)
    .filter((rule) => {
      const allResolved = rule.featureFields.every((field) => fieldMap.has(field))
      if (!allResolved) {
        return false
      }
      if (lenient && rule.effective) {
        return rule.featureFields.every((field) => fieldMap.get(field)?.published)
      }
      return true
    })

  return { templates, rules }
}
