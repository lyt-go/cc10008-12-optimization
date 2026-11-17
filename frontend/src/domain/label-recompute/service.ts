/**
 * 增量重算服务：在纯引擎内核之外补上本地持久化与「按既有数据流入参」的装配。
 *
 * 持久化独立于清单数据（另起 localStorage 键）：
 *   - 清单（特征模板/标签规则）仍由 local-store.ts 管理；
 *   - 引擎快照（窗口版本、向量、命中、复核、批次、覆盖率）在这里保存。
 * 清单发生变化时通过 rebuildFromCatalog 丢弃旧快照并按新清单重建，避免脏版本。
 */
import { listRows } from '@/data/local-store'

import { buildEngineSeed } from './adapters'
import { RecomputeEngine, type RecomputeResult } from './engine'
import type { ArbitrationMode, EngineSnapshot, RecomputeRequest } from './types'

const SNAPSHOT_KEY = 'behavior-event-trace-hub:label-recompute'

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

function writeSnapshot(snapshot: EngineSnapshot): void {
  if (!canUseStorage()) {
    return
  }
  window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot))
}

class LabelRecomputeService {
  private engine: RecomputeEngine | null = null

  /** 从当前清单（特征工程 + 行动标签）装配引擎。 */
  private ensureEngine(): RecomputeEngine {
    if (this.engine) {
      return this.engine
    }
    const seed = buildEngineSeed(listRows('feature'), listRows('action'))
    if (seed.templates.length === 0 || seed.rules.length === 0) {
      throw new Error('当前清单缺少已发布特征模板或可用标签规则，无法装配增量重算引擎')
    }
    this.engine = new RecomputeEngine(seed)
    writeSnapshot(this.engine.snapshot())
    return this.engine
  }

  /** 清单（模板/规则）被改动后重建：旧窗口版本与命中结果按新清单重新绑定。 */
  rebuildFromCatalog(): EngineSnapshot {
    const seed = buildEngineSeed(listRows('feature'), listRows('action'))
    this.engine = new RecomputeEngine(seed)
    writeSnapshot(this.engine.snapshot())
    return this.engine.snapshot()
  }

  reset(): EngineSnapshot {
    return this.rebuildFromCatalog()
  }

  getSnapshot(): EngineSnapshot {
    const engine = this.ensureEngine()
    return engine.snapshot()
  }

  /**
   * 提交窗口重算请求。
   * 同内容重提 → dedup-reused；异请求撞窗口版本 → conflict-rejected；
   * 旧窗口/迟到更正撞同一规则 → 按 arbitration 仲裁。
   */
  submitWindowRecompute(input: {
    requestId: string
    windowId: string
    windowVersion: number
    businessCycle: string
    arbitration: ArbitrationMode
    reason: string
  }): RecomputeResult {
    const request: RecomputeRequest = { ...input }
    const engine = this.ensureEngine()
    const result = engine.submit(request)
    writeSnapshot(engine.snapshot())
    return result
  }

  /** 特征工程 → 行动标签调用链核对。 */
  ruleCallChain(ruleId: string) {
    return this.ensureEngine().ruleCallChain(ruleId)
  }

  windowRefreshList(windowId: string) {
    return this.ensureEngine().windowRefreshList(windowId)
  }

  cycleReplacementList(businessCycle: string) {
    return this.ensureEngine().cycleReplacementList(businessCycle)
  }

  /** 引擎登记的窗口与下一可用版本号，供界面生成合规的重算请求。 */
  knownWindows() {
    const engine = this.ensureEngine()
    return engine.knownWindows().map((item) => ({
      ...item,
      nextVersion: engine.nextWindowVersion(item.windowId),
    }))
  }
}

export const labelRecomputeService = new LabelRecomputeService()
export { SNAPSHOT_KEY }
