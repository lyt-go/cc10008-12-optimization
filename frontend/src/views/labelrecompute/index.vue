<template>
  <section class="page" data-module="label-recompute">
    <header class="page-head">
      <div>
        <h2>行为特征标签增量重算</h2>
        <p class="page-desc">
          围绕行为特征标签版本提交窗口重算：同内容请求幂等复用、撞版本冲突驳回、
          同规则碰撞按仲裁处理；覆盖率按批次整批替换，稳定边界不变。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="rebuild">按当前清单重建</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">累计扫描次数</span>
        <strong class="stat-value">{{ snapshot.totalScans }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">有效标签版本批次</span>
        <strong class="stat-value">{{ activeBatches.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">当前覆盖率（命中/规则对）</span>
        <strong class="stat-value">{{ latestCoverage ? `${latestCoverage.numerator}/${latestCoverage.denominator}` : '—' }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">复核项</span>
        <strong class="stat-value">{{ snapshot.reviews.length }}</strong>
      </article>
    </div>

    <p v-if="message" :class="['status-legend', outcomeClass]">{{ message }}</p>

    <form class="filter-bar" @submit.prevent="submitRecompute">
      <label class="filter-item">
        <span>时间窗口</span>
        <select v-model="form.windowId" @change="syncNextVersion">
          <option v-for="win in knownWindows" :key="win.windowId" :value="win.windowId">
            {{ win.windowId }}（当前 v{{ win.version }}）
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>窗口版本号</span>
        <input v-model.number="form.windowVersion" type="number" min="2" />
        <button class="btn ghost" type="button" @click="syncNextVersion">取下一版本</button>
      </label>
      <label class="filter-item">
        <span>业务周期</span>
        <input v-model="form.businessCycle" placeholder="如 CYCLE-2026-09" />
      </label>
      <label class="filter-item">
        <span>仲裁做法</span>
        <select v-model="form.arbitration">
          <option value="window-incremental">受影响窗口增量（局部刷新清单）</option>
          <option value="cycle-recompute">业务周期整体重算（周期级替换清单）</option>
        </select>
      </label>
      <label class="filter-item">
        <span>变更原因</span>
        <input v-model="form.reason" placeholder="如 迟到窗口更正" />
      </label>
      <button class="btn primary" type="submit">提交重算请求</button>
    </form>

    <h3>覆盖率历史（分母为稳定边界，不累计）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>行为特征标签版本</th>
          <th>命中数（分子）</th>
          <th>规则-窗口对（分母）</th>
          <th>覆盖率</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="cov in snapshot.coverage" :key="cov.labelVersion">
          <td>{{ cov.labelVersion }}</td>
          <td>{{ cov.numerator }}</td>
          <td>{{ cov.denominator }}</td>
          <td>{{ (cov.rate * 100).toFixed(2) }}%</td>
        </tr>
      </tbody>
    </table>

    <h3>重算批次（每个窗口版本至多一个有效结果）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>标签版本</th>
          <th>请求</th>
          <th>窗口@版本</th>
          <th>仲裁做法</th>
          <th>处理结果</th>
          <th>重算模板</th>
          <th>受影响规则</th>
          <th>扫描次数</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="batch in snapshot.batches" :key="`${batch.labelVersion}-${batch.requestId}`">
          <td>{{ batch.labelVersion }}</td>
          <td>{{ batch.requestId }}</td>
          <td>{{ batch.windowId }}@v{{ batch.windowVersion }}</td>
          <td>{{ batch.arbitration === 'cycle-recompute' ? '周期整体重算' : '窗口增量' }}</td>
          <td>{{ outcomeText(batch.outcome) }}</td>
          <td>{{ batch.recomputedTemplates.join('、') || '—' }}</td>
          <td>{{ batch.affectedRuleIds.join('、') || '—' }}</td>
          <td>{{ batch.scanCount }}</td>
        </tr>
      </tbody>
    </table>

    <h3>行为特征标签命中（每条命中只引用一个窗口版本）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>命中编号</th>
          <th>标签规则</th>
          <th>窗口</th>
          <th>引用窗口版本</th>
          <th>标签版本</th>
          <th>命中</th>
          <th>特征分量快照</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="hit in snapshot.hits" :key="hit.hitId">
          <td>{{ hit.hitId }}</td>
          <td>{{ hit.ruleId }}</td>
          <td>{{ hit.windowId }}</td>
          <td>v{{ hit.windowVersion }}</td>
          <td>{{ hit.labelVersion }}</td>
          <td>{{ hit.hit ? '命中' : '未命中' }}</td>
          <td>{{ hit.fieldSnapshot.map((f) => `${f.field}@v${f.windowVersion}=${f.value}`).join('；') }}</td>
        </tr>
      </tbody>
    </table>

    <h3>复核清单（随增量结果更新，未受影响项保持原版本）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>标签规则</th>
          <th>窗口</th>
          <th>窗口版本</th>
          <th>标签版本</th>
          <th>复核状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="review in snapshot.reviews" :key="`${review.ruleId}-${review.windowId}`">
          <td>{{ review.ruleId }}</td>
          <td>{{ review.windowId }}</td>
          <td>v{{ review.windowVersion }}</td>
          <td>{{ review.labelVersion }}</td>
          <td>{{ review.status }}</td>
        </tr>
      </tbody>
    </table>

    <h3>特征工程 → 行动标签调用链核对</h3>
    <form class="filter-bar" @submit.prevent="loadChain">
      <label class="filter-item">
        <span>标签规则</span>
        <select v-model="chainRuleId">
          <option v-for="ruleId in ruleIds" :key="ruleId" :value="ruleId">{{ ruleId }}</option>
        </select>
      </label>
      <button class="btn" type="submit">核对调用链</button>
    </form>
    <table v-if="callChain" class="data-table">
      <thead>
        <tr>
          <th>输出字段</th>
          <th>特征模板</th>
          <th>模板窗口</th>
          <th>向量窗口版本</th>
          <th>向量值</th>
          <th>是否沿用上一完整向量</th>
          <th>命中引用版本</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="link in callChain.chain" :key="link.outputField">
          <td>{{ link.outputField }}</td>
          <td>{{ link.templateId }}</td>
          <td>{{ link.templateWindow }}</td>
          <td>v{{ link.vectorWindowVersion }}</td>
          <td>{{ link.vectorValue }}</td>
          <td>{{ link.inherited ? '是（稳定部分）' : '否（本批重算）' }}</td>
          <td>v{{ link.hitWindowVersion }}</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>窗口版本 {{ snapshot.windows.length }} 个 · 命中 {{ snapshot.hits.length }} 条 · 批次 {{ snapshot.batches.length }} 个</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { labelRecomputeService } from '@/domain/label-recompute'
import type {
  ArbitrationMode,
  EngineSnapshot,
  RecomputeOutcome,
} from '@/domain/label-recompute'
import { listRows } from '@/data/local-store'

const emptySnapshot: EngineSnapshot = {
  windows: [],
  vectors: [],
  hits: [],
  reviews: [],
  batches: [],
  coverage: [],
  totalScans: 0,
}

const snapshot = ref<EngineSnapshot>(emptySnapshot)
const knownWindows = ref<{ windowId: string; version: number; nextVersion: number; businessCycle: string }[]>([])
const message = ref('')
const outcomeClass = ref('')
const requestSeq = ref(0)
const callChain = ref<ReturnType<typeof labelRecomputeService.ruleCallChain> | null>(null)
const chainRuleId = ref('')

const form = reactive({
  windowId: '',
  windowVersion: 2,
  businessCycle: 'CYCLE-2026-09',
  arbitration: 'window-incremental' as ArbitrationMode,
  reason: '窗口变更重算',
})

const ruleIds = computed(() => [...new Set(snapshot.value.hits.map((item) => item.ruleId))])
const activeBatches = computed(() => snapshot.value.batches.filter((b) => b.outcome !== 'conflict-rejected'))
const latestCoverage = computed(() => snapshot.value.coverage[snapshot.value.coverage.length - 1])

function syncNextVersion() {
  const win = knownWindows.value.find((item) => item.windowId === form.windowId)
  if (win) {
    form.windowVersion = win.nextVersion
    form.businessCycle = win.businessCycle
  }
}

function refresh() {
  try {
    snapshot.value = labelRecomputeService.getSnapshot()
    knownWindows.value = labelRecomputeService.knownWindows()
    if (!form.windowId && knownWindows.value.length > 0) {
      form.windowId = knownWindows.value[0].windowId
      syncNextVersion()
    }
    if (!chainRuleId.value && ruleIds.value.length > 0) {
      chainRuleId.value = ruleIds.value[0]
    }
  } catch (error) {
    message.value = error instanceof Error ? error.message : '引擎装配失败'
    outcomeClass.value = 'error-text'
  }
}

function submitRecompute() {
  requestSeq.value += 1
  try {
    const result = labelRecomputeService.submitWindowRecompute({
      requestId: `req-${Date.now()}-${requestSeq.value}`,
      windowId: form.windowId,
      windowVersion: Number(form.windowVersion),
      businessCycle: form.businessCycle,
      arbitration: form.arbitration,
      reason: form.reason,
    })
    message.value = `请求处理结果：${outcomeText(result.outcome)}，行为特征标签版本 ${result.batch.labelVersion}`
    outcomeClass.value = result.outcome === 'conflict-rejected' ? 'error-text' : ''
    refresh()
  } catch (error) {
    message.value = error instanceof Error ? error.message : '重算请求失败'
    outcomeClass.value = 'error-text'
  }
}

function rebuild() {
  try {
    snapshot.value = labelRecomputeService.rebuildFromCatalog()
    knownWindows.value = labelRecomputeService.knownWindows()
    callChain.value = null
    message.value = '已按特征工程/行动标签当前清单重新绑定基线版本 LV-0000'
    outcomeClass.value = ''
    refresh()
  } catch (error) {
    message.value = error instanceof Error ? error.message : '重建失败'
    outcomeClass.value = 'error-text'
  }
}

function loadChain() {
  if (!chainRuleId.value) {
    return
  }
  callChain.value = labelRecomputeService.ruleCallChain(chainRuleId.value)
}

function outcomeText(outcome: RecomputeOutcome): string {
  const map: Record<RecomputeOutcome, string> = {
    recomputed: '有效重算',
    'dedup-reused': '幂等复用（未重复累计）',
    'conflict-rejected': '冲突驳回',
    'conflict-arbitrated': '冲突仲裁',
  }
  return map[outcome]
}

onMounted(() => {
  // 清单为空（例如全部规则未生效）时给出可读提示，而不是抛白屏。
  if (listRows('feature').length === 0 || listRows('action').length === 0) {
    message.value = '特征模板或标签规则清单为空，无法装配增量重算引擎'
    outcomeClass.value = 'error-text'
    return
  }
  refresh()
})
</script>
