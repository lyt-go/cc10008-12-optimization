# 行为特征分析与事件溯源平台

面向用户行为打点采集、事件参数规范、会话重放、热力图分析、特征工程提取与行为标签体系管理的本地化数据分析应用平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/domain/label-recompute/  行为特征标签增量重算引擎（纯内核 + 适配 + 服务）
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 行为特征标签增量重算

入口在侧边栏「增量重算」（路由 `/label-recompute`），围绕**行为特征标签版本**组织，
代码集中在 `frontend/src/domain/label-recompute/`：

- `engine.ts`：不依赖 DOM 的纯引擎内核，承载全部不变量；
- `adapters.ts`：把既有清单（特征工程 `feature` / 行动标签 `action` 的 `EntryRow`）
  投影成引擎领域对象，「时间窗口天」即窗口标识，行动标签的「触发事件组」引用特征模板
  的「输出字段名」，构成 action → feature 调用链；
- `service.ts`：引擎装配与独立 localStorage 持久化（键
  `behavior-event-trace-hub:label-recompute`），清单改动后可按当前清单重建；
- `*.test.ts`：不变量与端到端测试，运行 `npm run test:domain`（基于内置
  `node --test` 与 esbuild，不新增依赖）。

引擎保证的语义：

1. **只重算受影响部分**：窗口重算只扫描绑定该窗口的已发布特征模板与受影响标签规则；
   未受影响模板沿用上一完整行为特征向量（`inherited` + 来源窗口版本可审计），不整批重扫。
2. **幂等复用**：同一窗口版本的相同请求第二次提交直接复用已完成命中（`dedup-reused`），
   零扫描、不新增覆盖率快照。
3. **冲突只保留一个结果**：异请求撞同一窗口版本按冲突驳回（`conflict-rejected`），
   每个窗口版本至多一个有效增量命中结果批次。
4. **两种仲裁**：旧窗口重算与迟到更正落在同一标签规则时，可选「受影响窗口增量」
   （产出局部窗口刷新清单）或「业务周期整体重算」（产出周期级替换命中清单）。
5. **覆盖率稳定边界**：覆盖率按批次整批替换，分母（生效规则-窗口对）恒定、绝不累计。
6. **单窗口版本引用**：每条标签命中只引用一个窗口版本；只改一个窗口时，未引用该窗口的
   规则、命中与复核项保持原版本。复核清单随增量结果增量更新。

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 事件规范 | `eventspec` | 事件定义 | 事件编号、事件名称、事件类别 |
| 会话重放 | `session` | 会话记录 | 会话编号、用户标识、开始时间 |
| 热力分析 | `heatmap` | 热力方案 | 方案编号、目标页面、点击热力图 |
| 特征工程 | `feature` | 特征模板 | 模板编号、特征名称、特征类型 |
| 行动标签 | `action` | 标签规则 | 规则编号、标签名称、标签类别 |
| 路径分析 | `pathmap` | 路径模型 | 模型编号、起始页面、终止页面 |
| 事件溯源 | `eventtrace` | 事件链路 | 链路编号、事件链序列、链长度 |
| 时段分析 | `timewindow` | 时段配置 | 配置编号、时段名称、起始时分 |
| 设备分析 | `device` | 设备画像 | 画像编号、设备类型、操作系统 |
| 异常检测 | `anomaly` | 检测器 | 检测器编号、监控事件、异常模式 |
| 群组对比 | `cohortcmp` | 对比任务 | 任务编号、群组A、群组B |
| 漏斗诊断 | `funnel` | 诊断报告 | 报告编号、漏斗名称、步骤定义 |
| 浏览深度 | `scrollmap` | 深度分析 | 分析编号、页面名称、首屏占比 |
| 表单分析 | `formfield` | 表单诊断 | 诊断编号、表单名称、总字段数 |
| 点击流 | `clickstream` | 点击序列 | 序列编号、用户标识、起始时间 |
| 回访分析 | `retention` | 回访模式 | 模式编号、用户分群、首次访问窗口 |
| 数据视图 | `dataview` | 分析视图 | 视图编号、视图名称、数据源组合 |
| 参数字典 | `paramdef` | 参数定义 | 参数编号、参数名称、参数类型 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `behavior-event-trace-hub:entries` 这一项，或调用 `resetModule(模块)`。

领域：数据工程
子方向：数据分析与数据应用
