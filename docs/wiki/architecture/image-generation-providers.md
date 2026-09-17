# 图像生成厂商边界

## Background

角色形象图生成服务面向写作新手，配置入口必须尽量低负担：用户只应理解“哪个厂商负责文本模型、哪个模型负责图片生成”，不应被要求判断内置厂商白名单或手动修复前后端厂商枚举。

项目中的图像生成流程默认调用 OpenAI 兼容的 `/images/generations` 接口。部分内置厂商有推荐图像模型，但自定义网关、本地转发服务和聚合接口也可能提供同样的图像接口。

## Decision

图像模型设置不再绑定到固定内置厂商。任意已保存的模型厂商都可以配置一个独立的图像模型；只有已经启用、连接信息完整且拥有图像模型的厂商，才会出现在角色形象图生成的厂商列表中。

## Current Rule

- 文本默认模型和图像模型是两类独立设置；模型设置页也因此拆成「文本模型」「生图模型」两个并列分区。
- 文本模型分区承载全部连接管理（API Key、地址、测试、余额、思考开关、模型隐藏、移除厂商）；生图模型分区是精简视图，只展示每个厂商当前的生图模型和配置入口，没有可用生图模型时显示配置引导。
- 两个分区共用同一个「添加厂商」弹窗和同一个厂商配置弹窗：API Key 与地址是一套共享凭据，弹窗内部再按连接凭据 / 文本模型 / 生图模型 / 请求限制分区表达；不要为图片模型再做一套独立凭据。
- 生图模型分区只列出已启用、连接完整且 `supportsImageGeneration` 的厂商；文本分区与生图分区的数据来源是同一份 provider 设置。
- 面向用户的统一叫法是「生图模型」（角色图、封面、漫画格子等入口一致），不要在 UI 里混用「图片模型」「图像模型」「图片服务」。
- 图像模型保存到 `provider.imageModel.<provider>` 设置键下，不要求 provider 是内置厂商。
- 内置厂商可以提供推荐图像模型选项；自定义厂商默认不预设选项，但允许手动填写。
- 图片生成执行时读取任务上的 provider 和 model，再用该 provider 保存的 API 地址和 API Key 调用 `/images/generations`。
- 自定义或本地 OpenAI 兼容服务可以不填写 API Key；请求会省略 Authorization 头。
- 角色形象图的前端选择列表必须来自当前设置数据，不能写死为 `openai`、`siliconflow`、`grok` 之类的固定列表。
- 漫画项目页头部是「厂商 + 模型」两级选择：厂商下拉只列出已配置且 `supportsImageGeneration` 的厂商；模型下拉列出该厂商已配置的生图模型（`imageModels`，含当前选择、默认模型与推荐选项的去重并集）。两级的持久化范围不同，不要混用：
  - 厂商选择只记在浏览器 localStorage（`comic.preferredImageProvider`），属于"这个项目在这台机器上用哪家生图"的工作偏好；缓存的厂商失效时回退第一个可用厂商。
  - 模型切换通过 `PUT /settings/api-keys/:provider { imageModel }` 保存为该厂商的默认生图模型（`provider.imageModel.<provider>`），对全书所有图片入口全局生效；所有漫画生图调用（角色三视图/表情/资产/场景/格子/批量）只透传 provider，模型由后端 `resolveImageModel` 统一解析。
  - 没有任何可用厂商时，页面不放一个点击必失败的下拉，而是显示「去模型设置配置」入口。
- **文本 LLM 调用严禁透传生图厂商**：`textCapable:false` 的厂商（grsai）只有图像接口，分话大纲、分格脚本等结构化文本调用不传 provider（走文本模型路由），否则会请求到不存在的对话接口而报错。

### 全局默认生图模型（image.currentSelection）

- 「模型设置」提供全局默认生图模型选择，保存在 `image.currentSelection`（`{provider, model}`），与文本的 `llm.currentSelection` 对称；读写入口是 `GET/PUT /settings/image-selection`。
- 图片生成任务的解析顺序固定为：请求显式带 provider/model 时以请求为准（场景级覆盖）；两者都未指定时使用全局默认生图模型；未保存全局默认时回退到厂商当前生图模型（`resolveImageModel`）或内置默认。不要在调用方各自实现另一套默认逻辑。
- 每个厂商的可选生图模型列表持久化在 `provider.imageModels.<provider>`（JSON 数组；空数组是合法状态，表示该厂商不再提供生图模型）；从未保存过时回退内置预设。维护入口是 `PUT /settings/api-keys/:provider/image-models`，保存时若当前生效模型不在新列表中会一并清除并回退 env/默认值。
- 漫画生图偏好「跟随主程序」指跟随全局默认生图模型：客户端先读 `image.currentSelection`，读不到再回落第一个可用厂商，与后端解析顺序保持一致。

### 厂商能力标记（textCapable）

- `PROVIDERS` 元数据支持 `textCapable?: boolean`，默认 `true`；`providerSupportsText(provider)` 是统一判断入口，自定义厂商恒为 `true`。
- 只有图像接口、没有文本对话接口的聚合平台必须标记 `textCapable: false`（当前为 `grsai`）。这类厂商：
  - 出现在「生图模型」分区的添加列表，配置 API Key + 生图模型后即视为已配置；不出现在「文本模型」分区、新手引导、知识库向量厂商列表、`/llm/providers` 文本模型下拉。
  - 厂商配置弹窗隐藏文本模型区和测试连接按钮，保存时跳过 `/models` 列表刷新。
  - 后端 `isConfigured` 对其按「Key + 生图模型」计算，而不是「Key + 文本模型」。

### 非标准生图协议适配

- 默认执行路径（`generateImagesByProvider`）仍是 OpenAI 兼容：JSON `/images/generations`，或带本地参考图时走 multipart `/images/edits`，响应解析 `{data:[{url|b64_json}]}`。
- 非标准协议的内置厂商必须在 `server/src/services/image/providers/` 下新增独立适配器，并在 `provider.ts` 入口按 provider 分流；不要把第三方专有字段塞进通用请求体构造。
- 火山方舟（`volcengine`）：OpenAI 兼容 `POST /api/v3/images/generations`；差异点是尺寸只接收 `1K/2K` 档位关键字、图生图通过 JSON `image` 字段（URL 或 data URL，单图 string / 多图 array），Seedream 4.0/4.5 仅输出 jpeg；Seedream 5.0 pro 不支持组图，多张需求按张并发请求。
- GrsAI（`grsai`）：协议非 OpenAI。提交 `POST /v1/api/generate`（`replyType:"json"`，参考图放 `images` 数组，nano-banana 系列用宽高比、gpt-image 系列可直接给像素尺寸），响应 `{id,status,results}` 可能是 `running`，需轮询 `GET /v1/api/result?id=`，`violation` 按内容违规报错；单次只产一张，多张按张并发。默认根地址 `https://grsaiapi.com`（不带 `/v1`），适配器会容错去掉误填的 `/v1` 尾缀。
- 本地参考图统一由 `providers/referenceImages.ts` 转 data URL（火山、GrsAI 均不使用 multipart），上限 10 张。

## Failure Modes

- 如果设置页允许填写图像模型，但角色图生成页仍写死厂商，用户会误以为自定义厂商保存失败。
- 如果后端只允许固定厂商进入图像生成，前端动态列表会把可选项交给用户，但任务提交后失败。
- 如果删除自定义厂商时保留旧图像模型设置，后续重建同名厂商可能继承过期图片模型，造成难以解释的配置污染。
- 纯生图厂商若漏标 `textCapable: false`，会同时出现在文本模型下拉、新手引导和 RAG 向量列表中，用户配置后所有文字任务都会调用失败。
- 如果把漫画头部的厂商选择当成全局设置保存（或把模型切换只存在 localStorage），会出现"换了项目/机器模型选择丢失"或"厂商偏好污染全局文本任务"两类问题；厂商偏好与模型默认值的持久化边界必须保持上文的划分。
- GrsAI 是异步任务协议，若把首次返回的 `running` 当作成功，会得到空结果；必须轮询到 `succeeded` 再取 `results[].url`。

## Related Modules

- `server/src/services/settings/ProviderImageSettingsService.ts`
- `server/src/services/image/provider.ts`：执行入口与厂商分流
- `server/src/services/image/providers/volcengineAdapter.ts`：火山方舟 Seedream 适配器
- `server/src/services/image/providers/grsaiAdapter.ts`：GrsAI 异步生图与轮询适配器
- `server/src/services/image/providers/referenceImages.ts`：本地参考图转 data URL
- `server/src/llm/providers.ts`：内置厂商元数据与 `providerSupportsText`
- `server/src/routes/settings.ts`
- `server/src/routes/settings/customProviderRoutes.ts`
- `client/src/pages/settings/components/providers/ProviderConfigDialog.tsx`：厂商配置弹窗（连接凭据 / 文本模型 / 生图模型 / 请求限制分区）
- `client/src/pages/settings/components/providers/TextModelProvidersSection.tsx`：文本模型分区
- `client/src/pages/settings/components/providers/ImageModelProvidersSection.tsx` 与 `ImageProviderStatusCard.tsx`：生图模型分区与精简卡片
- `client/src/pages/characters/components/CharacterImageDialog.tsx`
