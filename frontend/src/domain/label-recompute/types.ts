/**
 * 增量重算引擎的领域类型。
 *
 * 数据流（与 README 的模块划分对齐）：
 *   特征工程 feature（特征模板）
 *     └─ 按「时间窗口天」生成/刷新行为特征向量 FeatureVector
 *          └─ 行动标签 action（标签规则，按输出字段名引用模板）
 *               └─ 行为特征标签命中 LabelHit（每次命中只引用一个窗口版本）
 *                    └─ 复核清单 ReviewItem（随命中结果增量更新）
 *
 * 入口始终围绕「行为特征标签版本」LabelVersion：窗口重算只产生一个增量更新的
 * 命中结果批次，覆盖率按批次整批替换、绝不累计。
 */

/** 时间窗口版本：同一个时间窗口（windowId）可以先后提交多个版本。 */
export type WindowVersion = {
  /** 时间窗口标识，取自特征模板的「时间窗口天」。 */
  windowId: string
  /** 窗口版本号，同一 windowId 下单调递增（v1、v2……）。 */
  version: number
  /** 业务周期：周期整体重算时以它圈定替换范围。 */
  businessCycle: string
  createdAt: number
}

/** 特征模板（特征工程模块的领域投影）。 */
export type FeatureTemplate = {
  templateId: string
  name: string
  /** 输出字段名：标签规则通过它调用特征工程产出的向量分量。 */
  outputField: string
  /** 模板绑定的时间窗口，等价于「时间窗口天」。 */
  windowId: string
  /** 只有已发布模板参与重算，未发布模板保持上一完整向量。 */
  published: boolean
}

/**
 * 完整行为特征向量。
 * 窗口未变化时沿用同一向量；窗口重算只重算绑定该窗口的模板，
 * 未受影响模板继续读取上一完整行为特征向量（lineage 指向来源版本）。
 */
export type FeatureVector = {
  templateId: string
  windowId: string
  windowVersion: number
  outputField: string
  /** 向量分量值（本地演示用确定性生成）。 */
  value: number
  /** true 表示该分量未参与本次重算，沿用上一完整向量。 */
  inherited: boolean
  /** 来源窗口版本，便于审计「未受影响模板继续读取上一完整向量」。 */
  sourceWindowVersion: number
}

/** 标签规则（行动标签模块的领域投影）。 */
export type LabelRule = {
  ruleId: string
  name: string
  /** 引用的特征模板输出字段，构成 action → feature 的调用链。 */
  featureFields: string[]
  /** 由引用模板推导出来的规则所在窗口（每次命中只允许落到一个窗口）。 */
  windowId: string
  effective: boolean
  /** 业务周期，用于周期级整体重算。 */
  businessCycle: string
}

/** 行为特征标签命中数据：一次命中只引用一个窗口版本。 */
export type LabelHit = {
  hitId: string
  ruleId: string
  windowId: string
  /** 该命中引用的唯一窗口版本，不变量：每条命中只指向一个版本。 */
  windowVersion: number
  /** 所属行为特征标签版本（批次 id），入口围绕它组织。 */
  labelVersion: string
  /** 命中时读取的特征向量分量，记录调用链证据。 */
  fieldSnapshot: { field: string; value: number; windowVersion: number }[]
  hit: boolean
  createdAt: number
}

/** 复核清单项：随增量命中结果增量更新，未受影响项保持原版本。 */
export type ReviewItem = {
  ruleId: string
  windowId: string
  windowVersion: number
  labelVersion: string
  status: '待复核' | '复核通过' | '冲突待仲裁'
  updatedAt: number
}

/** 版本冲突的仲裁做法。 */
export type ArbitrationMode =
  /** 受影响窗口增量：只刷新落在冲突窗口上的命中，产出局部窗口刷新清单。 */
  | 'window-incremental'
  /** 业务周期整体重算：替换同一业务周期内的全部命中，产出周期级替换命中清单。 */
  | 'cycle-recompute'

/** 重算请求的处理结果。 */
export type RecomputeOutcome =
  | 'recomputed'
  | 'dedup-reused'
  | 'conflict-rejected'
  | 'conflict-arbitrated'

/** 提交一次窗口重算请求。 */
export type RecomputeRequest = {
  requestId: string
  windowId: string
  windowVersion: number
  businessCycle: string
  arbitration: ArbitrationMode
  reason: string
}

/** 一次重算产出的增量更新批次（每个窗口版本至多一个有效批次）。 */
export type RecomputeBatch = {
  labelVersion: string
  requestId: string
  windowId: string
  windowVersion: number
  businessCycle: string
  outcome: RecomputeOutcome
  arbitration: ArbitrationMode
  reason: string
  /** 本批真正重算的模板，未受影响模板不在内（避免整批重复扫描）。 */
  recomputedTemplates: string[]
  /** 本批新增/替换的命中 id。 */
  hitIds: string[]
  /** 仲裁时被替换掉的旧命中 id（局部或周期级清单）。 */
  replacedHitIds: string[]
  affectedRuleIds: string[]
  scanCount: number
  createdAt: number
}

/** 标签覆盖率快照：稳定部分的边界在多次重算间保持不变。 */
export type CoverageSnapshot = {
  labelVersion: string
  /** 参与统计的规则-窗口对总数（稳定边界）。 */
  denominator: number
  /** 命中为 true 的规则-窗口对数。 */
  numerator: number
  rate: number
}

/** 引擎对外只读快照。 */
export type EngineSnapshot = {
  windows: WindowVersion[]
  vectors: FeatureVector[]
  hits: LabelHit[]
  reviews: ReviewItem[]
  batches: RecomputeBatch[]
  coverage: CoverageSnapshot[]
  /** 累计扫描次数，用来验证「重复扫描明显减少」。 */
  totalScans: number
}
