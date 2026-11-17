/**
 * 行为特征标签增量重算引擎（纯函数内核，不依赖浏览器/DOM，可直接单测）。
 *
 * 设计要点对应需求：
 * 1. 窗口重算只扫描绑定该窗口的已发布特征模板与受影响标签规则，未受影响模板
 *    沿用上一完整行为特征向量，杜绝整批重复扫描。
 * 2. 同一窗口版本的重复请求幂等复用（dedup-reused），不新增扫描、不新增覆盖率；
 *    异请求撞同一窗口版本按冲突处理（conflict-rejected），每个窗口版本只保留一个
 *    增量命中结果批次。
 * 3. 旧窗口重算与迟到窗口更正落在同一标签规则时按仲裁模式处理：
 *    window-incremental 产出局部窗口刷新清单；cycle-recompute 产出周期级替换清单。
 * 4. 覆盖率按批次整批替换：分母（规则-窗口对）恒定，稳定部分边界不变，绝不累计。
 * 5. 每条标签命中只引用一个窗口版本；未引用被修改窗口的规则与命中保持原版本。
 */
import type {
  ArbitrationMode,
  CoverageSnapshot,
  EngineSnapshot,
  FeatureTemplate,
  FeatureVector,
  LabelHit,
  LabelRule,
  RecomputeBatch,
  RecomputeOutcome,
  RecomputeRequest,
  ReviewItem,
  WindowVersion,
} from './types'

export type EngineSeed = {
  templates: FeatureTemplate[]
  rules: LabelRule[]
  now?: number
}

export type RecomputeResult = {
  outcome: RecomputeOutcome
  batch: RecomputeBatch
  /** 冲突复用/驳回时回传的既有标签版本，调用方无需二次查询。 */
  reusedLabelVersion?: string
  coverage: CoverageSnapshot
}

function hash32(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 特征分量值：同模板同版本确定且稳定，版本变化才变化（模拟重算）。 */
function vectorValue(templateId: string, windowVersion: number): number {
  return (hash32(`${templateId}@v${windowVersion}`) % 1000) / 10
}

/** 命中判定：只依赖规则与其当时读取到的向量分量，向量不变则命中不变。 */
function evaluateHit(ruleId: string, fields: FeatureVector[]): boolean {
  const signature = fields
    .map((item) => `${item.outputField}=${item.value}`)
    .sort()
    .join('|')
  return hash32(`${ruleId}#${signature}`) % 2 === 0
}

export class RecomputeEngine {
  private windows: WindowVersion[] = []

  private vectors: FeatureVector[] = []

  private hits: LabelHit[] = []

  private reviews: ReviewItem[] = []

  private batches: RecomputeBatch[] = []

  private coverageSnapshots: CoverageSnapshot[] = []

  private totalScans = 0

  private labelSeq = 0

  /** 窗口版本 → 有效批次标签版本：保证每个窗口版本至多一个有效结果。 */
  private batchByWindowVersion = new Map<string, string>()

  /** 请求内容指纹 → 标签版本：相同内容后到请求直接复用。 */
  private batchByFingerprint = new Map<string, string>()

  private readonly templates: FeatureTemplate[]

  private readonly rules: LabelRule[]

  private readonly fieldToTemplate = new Map<string, FeatureTemplate>()

  constructor(seed: EngineSeed) {
    this.templates = seed.templates.map((item) => ({ ...item }))
    this.rules = seed.rules.map((item) => ({ ...item }))
    this.validateAndLink()
    this.bootstrap(seed.now ?? Date.now())
  }

  /** 核对特征模板在特征工程与行动标签间的调用链。 */
  private validateAndLink(): void {
    for (const template of this.templates) {
      if (this.fieldToTemplate.has(template.outputField)) {
        throw new Error(`特征输出字段「${template.outputField}」被多个模板重复定义`)
      }
      this.fieldToTemplate.set(template.outputField, template)
    }
    for (const rule of this.rules) {
      if (rule.featureFields.length === 0) {
        throw new Error(`标签规则 ${rule.ruleId} 未引用任何特征模板输出字段`)
      }
      const linkedWindows = new Set<string>()
      for (const field of rule.featureFields) {
        const template = this.fieldToTemplate.get(field)
        if (!template) {
          throw new Error(`标签规则 ${rule.ruleId} 引用了不存在的特征字段「${field}」`)
        }
        linkedWindows.add(template.windowId)
      }
      // 一条规则的所有特征必须落在同一窗口，命中才能只引用一个窗口版本。
      if (linkedWindows.size > 1) {
        throw new Error(`标签规则 ${rule.ruleId} 跨多个时间窗口，无法保证命中只引用单个窗口版本`)
      }
      rule.windowId = [...linkedWindows][0]
    }
  }

  /** 基线绑定：为每个窗口建立 v1 完整向量、全量命中与首版覆盖率。 */
  private bootstrap(now: number): void {
    const windowIds = [...new Set(this.templates.map((item) => item.windowId))].sort()
    for (const windowId of windowIds) {
      this.windows.push({
        windowId,
        version: 1,
        businessCycle: this.rules.find((rule) => rule.windowId === windowId)?.businessCycle ?? 'CYCLE-DEFAULT',
        createdAt: now,
      })
    }
    this.vectors = this.templates
      .filter((template) => template.published)
      .map((template) => ({
        templateId: template.templateId,
        windowId: template.windowId,
        windowVersion: 1,
        outputField: template.outputField,
        value: vectorValue(template.templateId, 1),
        inherited: false,
        sourceWindowVersion: 1,
      }))
    this.totalScans += this.templates.filter((template) => template.published).length

    const baseHits: LabelHit[] = []
    for (const rule of this.rules.filter((item) => item.effective)) {
      const fields = this.vectorsFor(rule)
      baseHits.push(this.buildHit(rule, 1, 'LV-0000', fields, now))
      this.upsertReview(rule, 1, 'LV-0000', now)
    }
    this.totalScans += this.rules.filter((item) => item.effective).length
    this.hits = baseHits

    const baseBatch: RecomputeBatch = {
      labelVersion: 'LV-0000',
      requestId: 'bootstrap',
      windowId: '*',
      windowVersion: 1,
      businessCycle: '*',
      outcome: 'recomputed',
      arbitration: 'window-incremental',
      reason: '基线全量绑定',
      recomputedTemplates: this.vectors.map((item) => item.templateId),
      hitIds: baseHits.map((item) => item.hitId),
      replacedHitIds: [],
      affectedRuleIds: this.rules.filter((item) => item.effective).map((item) => item.ruleId),
      scanCount: this.totalScans,
      createdAt: now,
    }
    this.batches.push(baseBatch)
    this.coverageSnapshots.push(this.measureCoverage('LV-0000'))
  }

  private vectorsFor(rule: LabelRule): FeatureVector[] {
    return rule.featureFields.map((field) => {
      const template = this.fieldToTemplate.get(field)
      const vector = this.vectors.find((item) => item.templateId === template?.templateId)
      if (!vector) {
        throw new Error(`规则 ${rule.ruleId} 依赖的模板 ${template?.templateId ?? field} 尚无可用行为特征向量`)
      }
      return vector
    })
  }

  private buildHit(
    rule: LabelRule,
    windowVersion: number,
    labelVersion: string,
    fields: FeatureVector[],
    now: number,
  ): LabelHit {
    return {
      hitId: `${labelVersion}:${rule.ruleId}:${rule.windowId}@v${windowVersion}`,
      ruleId: rule.ruleId,
      windowId: rule.windowId,
      windowVersion,
      labelVersion,
      fieldSnapshot: fields.map((item) => ({
        field: item.outputField,
        value: item.value,
        windowVersion: item.sourceWindowVersion,
      })),
      hit: evaluateHit(
        rule.ruleId,
        fields,
      ),
      createdAt: now,
    }
  }

  private upsertReview(
    rule: LabelRule,
    windowVersion: number,
    labelVersion: string,
    now: number,
    status: ReviewItem['status'] = '待复核',
  ): void {
    const key = `${rule.ruleId}#${rule.windowId}`
    const index = this.reviews.findIndex((item) => `${item.ruleId}#${item.windowId}` === key)
    const next: ReviewItem = {
      ruleId: rule.ruleId,
      windowId: rule.windowId,
      windowVersion,
      labelVersion,
      status,
      updatedAt: now,
    }
    if (index >= 0) {
      this.reviews[index] = next
    } else {
      this.reviews.push(next)
    }
  }

  private measureCoverage(labelVersion: string): CoverageSnapshot {
    // 分母按生效规则的规则-窗口对计算：规则集合不变，分母恒定 → 稳定边界。
    const denominator = this.rules.filter((rule) => rule.effective).length
    const numerator = this.hits.filter((hit) => hit.hit).length
    return {
      labelVersion,
      denominator,
      numerator,
      rate: denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4)),
    }
  }

  private issueLabelVersion(): string {
    this.labelSeq += 1
    return `LV-${String(this.labelSeq).padStart(4, '0')}`
  }

  private static fingerprint(request: RecomputeRequest): string {
    return [
      request.windowId,
      request.windowVersion,
      request.businessCycle,
      request.arbitration,
      request.reason,
    ].join('|')
  }

  /** 提交一次窗口重算请求。 */
  submit(request: RecomputeRequest): RecomputeResult {
    const now = Date.now()
    const versionKey = `${request.windowId}#${request.windowVersion}`
    const fingerprint = RecomputeEngine.fingerprint(request)

    // 1) 幂等：相同请求内容已经算过 → 后到请求复用已完成命中，零扫描、零覆盖率累计。
    const reusedByFingerprint = this.batchByFingerprint.get(fingerprint)
    if (reusedByFingerprint) {
      const batch = this.batches.find((item) => item.labelVersion === reusedByFingerprint)
      if (batch) {
        return this.dedupResult(batch)
      }
    }

    // 2) 冲突：该窗口版本已被另一个请求占用 → 只保留既有结果，本请求按冲突驳回。
    const occupiedBy = this.batchByWindowVersion.get(versionKey)
    if (occupiedBy) {
      const existing = this.batches.find((item) => item.labelVersion === occupiedBy)
      if (existing) {
        return this.conflictReject(request, existing, now)
      }
    }

    // 3) 新窗口版本：判断是否与既有版本在同一标签规则上相撞，需要仲裁。
    //    基线 v1 → 首个重算版本属于常规 recomputed；窗口此前已发生过非基线重算，
    //    再到的更正（旧窗口重算/迟到更正）落在同一规则时按冲突仲裁处理。
    const overlappingRules = this.rules.filter(
      (rule) => rule.effective && rule.windowId === request.windowId,
    )
    const alreadyRecomputed = this.windows.some(
      (item) => item.windowId === request.windowId && item.version > 1,
    )
    const needsArbitration =
      alreadyRecomputed &&
      overlappingRules.some((rule) =>
        this.hits.some((hit) => hit.ruleId === rule.ruleId && hit.windowId === request.windowId),
      )

    return this.executeRecompute(request, overlappingRules, needsArbitration, now, fingerprint)
  }

  private dedupResult(batch: RecomputeBatch): RecomputeResult {
    return {
      outcome: 'dedup-reused',
      batch,
      reusedLabelVersion: batch.labelVersion,
      coverage: this.coverageSnapshots.find((item) => item.labelVersion === batch.labelVersion)!,
    }
  }

  private conflictReject(
    request: RecomputeRequest,
    existing: RecomputeBatch,
    now: number,
  ): RecomputeResult {
    // 冲突请求只留审计批次，不产生命中、不扫描、不动覆盖率与复核清单。
    const rejected: RecomputeBatch = {
      labelVersion: `REJECTED-${request.requestId}`,
      requestId: request.requestId,
      windowId: request.windowId,
      windowVersion: request.windowVersion,
      businessCycle: request.businessCycle,
      outcome: 'conflict-rejected',
      arbitration: request.arbitration,
      reason: request.reason,
      recomputedTemplates: [],
      hitIds: [],
      replacedHitIds: [],
      affectedRuleIds: [],
      scanCount: 0,
      createdAt: now,
    }
    this.batches.push(rejected)
    return {
      outcome: 'conflict-rejected',
      batch: rejected,
      reusedLabelVersion: existing.labelVersion,
      coverage: this.coverageSnapshots.find((item) => item.labelVersion === existing.labelVersion)!,
    }
  }

  private executeRecompute(
    request: RecomputeRequest,
    affectedRules: LabelRule[],
    needsArbitration: boolean,
    now: number,
    fingerprint: string,
  ): RecomputeResult {
    const labelVersion = this.issueLabelVersion()

    // 登记窗口新版本。
    this.windows.push({
      windowId: request.windowId,
      version: request.windowVersion,
      businessCycle: request.businessCycle,
      createdAt: now,
    })

    // 4) 只重算绑定该窗口的已发布模板；其余模板整体沿用上一完整向量。
    const recomputedTemplates = this.templates.filter(
      (template) => template.published && template.windowId === request.windowId,
    )
    const recomputedIds = new Set(recomputedTemplates.map((item) => item.templateId))
    this.vectors = this.vectors.map((vector) => {
      if (recomputedIds.has(vector.templateId)) {
        this.totalScans += 1
        return {
          ...vector,
          windowVersion: request.windowVersion,
          value: vectorValue(vector.templateId, request.windowVersion),
          inherited: false,
          sourceWindowVersion: request.windowVersion,
        }
      }
      // 未受影响模板：继承上一完整向量，保留来源版本用于审计。
      return { ...vector, inherited: true }
    })

    // 5) 仲裁圈定受影响规则：窗口增量只看本窗口；周期重算扩到同一业务周期。
    const scopeRules =
      request.arbitration === 'cycle-recompute'
        ? this.rules.filter((rule) => rule.effective && rule.businessCycle === request.businessCycle)
        : affectedRules

    const scopeRuleIds = new Set(scopeRules.map((item) => item.ruleId))
    const replacedHitIds = this.hits
      .filter((hit) => scopeRuleIds.has(hit.ruleId))
      .map((hit) => hit.hitId)

    // 移除旧命中，按当前向量整批重建（1:1 替换，不新增规则-窗口对）。
    this.hits = this.hits.filter((hit) => !scopeRuleIds.has(hit.ruleId))
    const newHits: LabelHit[] = []
    for (const rule of scopeRules) {
      const fields = this.vectorsFor(rule)
      const hitVersion =
        rule.windowId === request.windowId ? request.windowVersion : fields[0]?.sourceWindowVersion ?? 1
      const hit = this.buildHit(rule, hitVersion, labelVersion, fields, now)
      newHits.push(hit)
      this.upsertReview(rule, hitVersion, labelVersion, now)
      this.totalScans += 1
    }
    this.hits = [...this.hits, ...newHits]

    const outcome: RecomputeOutcome = needsArbitration ? 'conflict-arbitrated' : 'recomputed'
    const batch: RecomputeBatch = {
      labelVersion,
      requestId: request.requestId,
      windowId: request.windowId,
      windowVersion: request.windowVersion,
      businessCycle: request.businessCycle,
      outcome,
      arbitration: request.arbitration,
      reason: request.reason,
      recomputedTemplates: recomputedTemplates.map((item) => item.templateId),
      hitIds: newHits.map((item) => item.hitId),
      replacedHitIds,
      affectedRuleIds: scopeRules.map((item) => item.ruleId),
      scanCount: recomputedTemplates.length + scopeRules.length,
      createdAt: now,
    }
    this.batches.push(batch)
    this.batchByWindowVersion.set(`${request.windowId}#${request.windowVersion}`, labelVersion)
    this.batchByFingerprint.set(fingerprint, labelVersion)

    const coverage = this.measureCoverage(labelVersion)
    this.coverageSnapshots.push(coverage)
    return { outcome, batch, coverage }
  }

  // ── 只读查询入口 ─────────────────────────────────────────────────────

  snapshot(): EngineSnapshot {
    return {
      windows: this.windows.map((item) => ({ ...item })),
      vectors: this.vectors.map((item) => ({ ...item })),
      hits: this.hits.map((item) => ({ ...item, fieldSnapshot: [...item.fieldSnapshot] })),
      reviews: this.reviews.map((item) => ({ ...item })),
      batches: this.batches.map((item) => ({ ...item, hitIds: [...item.hitIds], replacedHitIds: [...item.replacedHitIds] })),
      coverage: this.coverageSnapshots.map((item) => ({ ...item })),
      totalScans: this.totalScans,
    }
  }

  /** 特征模板 → 输出字段 → 标签规则的完整调用链核对。 */
  ruleCallChain(ruleId: string) {
    const rule = this.rules.find((item) => item.ruleId === ruleId)
    if (!rule) {
      throw new Error(`标签规则 ${ruleId} 不存在`)
    }
    return {
      ruleId: rule.ruleId,
      windowId: rule.windowId,
      businessCycle: rule.businessCycle,
      chain: rule.featureFields.map((field) => {
        const template = this.fieldToTemplate.get(field)!
        const vector = this.vectors.find((item) => item.templateId === template.templateId)!
        const hit = this.hits.find((item) => item.ruleId === ruleId)
        return {
          outputField: field,
          templateId: template.templateId,
          templateWindow: template.windowId,
          vectorWindowVersion: vector.sourceWindowVersion,
          vectorValue: vector.value,
          inherited: vector.inherited,
          hitWindowVersion: hit?.windowVersion,
          hitLabelVersion: hit?.labelVersion,
        }
      }),
    }
  }

  /** 局部窗口刷新清单（window-incremental 仲裁结果）。 */
  windowRefreshList(windowId: string): LabelHit[] {
    return this.hits.filter((hit) => hit.windowId === windowId).map((item) => ({ ...item }))
  }

  /** 周期级替换命中清单（cycle-recompute 仲裁结果）。 */
  cycleReplacementList(businessCycle: string): LabelHit[] {
    const ruleIds = new Set(
      this.rules.filter((rule) => rule.businessCycle === businessCycle).map((rule) => rule.ruleId),
    )
    return this.hits.filter((hit) => ruleIds.has(hit.ruleId)).map((item) => ({ ...item }))
  }

  coverageHistory(): CoverageSnapshot[] {
    return this.coverageSnapshots.map((item) => ({ ...item }))
  }

  /** 该窗口当前最大版本号；窗口不存在返回 0（调用方据此取下一版本）。 */
  currentWindowVersion(windowId: string): number {
    const versions = this.windows
      .filter((item) => item.windowId === windowId)
      .map((item) => item.version)
    return versions.length === 0 ? 0 : Math.max(...versions)
  }

  /** 该窗口下一可用版本号（已被占用的窗口版本会在 submit 时按冲突处理）。 */
  nextWindowVersion(windowId: string): number {
    return this.currentWindowVersion(windowId) + 1
  }

  /** 引擎已登记的全部窗口（由模板「时间窗口天」推导，不依赖适配器的空 windowId）。 */
  knownWindows(): WindowVersion[] {
    return this.windows.map((item) => ({ ...item }))
  }
}
