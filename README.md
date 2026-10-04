# dsh-model-doctor · 模型医生

DSH 桌面客户端插件：在对话输入区的**模型选择菜单**里，为每个模型选项追加两枚按钮。

| 按钮 | 功能 |
| --- | --- |
| ⟳ 连通检测 | 宿主直连该模型的网关发一次 1-token 探测，行内徽章显示结果：`✓ 832ms`（连通）/ `✗ 402 鉴权/欠费` / `✗ 429 额度/限流` / `✗ 404 不存在` / `✗ 网络/超时`；悬停徽章看完整报错原文 |
| 🗑 删除 | 两段式确认（先点变「确认删除?」再点执行），从 `llm-pi-ai` 用户配置里移除该模型；写配置前自动备份配置文档（保留最近 5 份 `.dsh-model-doctor-*.bak`） |

菜单顶部是「⚡ 全部检测」条：并发（4 路）探测菜单里出现的**全部**模型，汇总「N 通 / M 异常」，
并显示 siliconflow 与 DeepSeek 官方的**账户余额**。

## 结果会保留

- 检测结果（含单模型 ⟳ 的结果）落盘为单个快照文件：
  `%USERPROFILE%\.dsh\model-doctor-results.json`
- **关掉菜单再打开**：自动回填徽章，状态条显示 `上次结果：X 通 / Y 异常（共 N）· 14:32`
- **重启软件**：客户端启动时读快照，开菜单即回填，无需重新检测
- **只保留最近一次**：单文件覆盖写，每次检测直接盖掉上一次，更早的自动消失

## 探测范围与欠费判定

1. `cordis.patch.yml` 里 `llm-pi-ai` 配置的供应商（智谱 / 硅基流动 / 阿里云百炼…）；
2. **DeepSeek 官方**（不在 llm-pi-ai 配置里，走内置兜底路由
   `https://api.deepseek.com/v1` + 凭据 `DEEPSEEK_API_KEY`）。

状态码含义：`200` 连通；`401/402/403` 鉴权失败或欠费（余额不足）；`429` 额度耗尽或限流；
`404` 模型不存在；`5xx` 服务端错误；无响应记为超时。
密钥从 `~/.dsh/.credentials.yaml` 的 refs 段或进程环境解析，只在内存里拼进请求头，不落盘、不打印。

## 依赖与适配

- 模型菜单本体由 **dsh-reasoning-effort** 插件渲染（`.re-model-*` 行结构）。本插件是
  行内 DOM 增强：在既有行上追加自持元素并 `stopPropagation`，不替换任何 React 节点、
  不抢 `conversation.input.model` 座位。禁用 dsh-reasoning-effort 后按钮不出现（安全无副作用）。
- 宿主↔浏览器通道走 `ctx.connection.fetch.register` 注册到共享 `/api` 通道
  （客户端裸 `fetch('/api/model-doctor/...')`），这是桌面端实测可达的机制。
- `package.json` 的 `dsh.client.immediately: true` 必须保留：客户端脚本包默认懒加载，
  没有它纯 DOM 增强插件永远不会被激活。

## 安装

本目录即完整插件（无构建步骤、零依赖、无需 npm install）。

**方式一（从本包安装）**：把 `dsh-model-doctor` 整个目录放进
`C:\Users\lxy33\.dsh\profiles\desktop\node_modules\`，并在 profile 的
`C:\Users\lxy33\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: model-doctor
      name: 'dsh-model-doctor'
```

⚠️ 必须是 `insert:` 列表格式；写成 `- id: model-doctor / name: dsh-model-doctor`
（config 覆盖格式）会被装载器**静默忽略**，插件不会装载且没有任何报错。

宿主半热加载即时生效；客户端半刷新 GUI 页面（`Ctrl+R`）后生效。

**方式二（从桌面 zip）**：解压 `dsh-model-doctor-v0.3.0.zip` 后按方式一放置即可。

## 恢复误删的模型

- 打开 `C:\Users\lxy33\.dsh\profiles\desktop\cordis.patch.yml.dsh-model-doctor-*.bak`
  （时间戳最新的一份），把对应模型条目复制回 `models:` 列表；
- 或在 DSH 设置 → 模型供应商里重新添加；
- 官方内置目录（如 DeepSeek 官方）的模型不受配置文件管辖，点 🗑 会提示无法删除——这是预期行为。

## 版本

- v0.3.0 — 检测结果持久化（跨菜单开关与重启保留，只留最近一次）
- v0.2.1 — 按钮放大到 27px
- v0.2.0 — 修复结果回填映射（重扫重新入表 + 模型 id 兜底匹配）、按钮钉在选项右侧、
  探测范围扩展到权威目录、新增 DeepSeek 官方兜底路由与余额
- v0.1.2/0.1.3 — 切换到 `/api` 共享通道；修复 `llm.listProviders()` 同步返回被误挂 `.catch`
