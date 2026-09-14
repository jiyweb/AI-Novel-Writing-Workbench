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

## Failure Modes

- 如果设置页允许填写图像模型，但角色图生成页仍写死厂商，用户会误以为自定义厂商保存失败。
- 如果后端只允许固定厂商进入图像生成，前端动态列表会把可选项交给用户，但任务提交后失败。
- 如果删除自定义厂商时保留旧图像模型设置，后续重建同名厂商可能继承过期图片模型，造成难以解释的配置污染。

## Related Modules

- `server/src/services/settings/ProviderImageSettingsService.ts`
- `server/src/services/image/provider.ts`
- `server/src/routes/settings.ts`
- `server/src/routes/settings/customProviderRoutes.ts`
- `client/src/pages/settings/components/providers/ProviderConfigDialog.tsx`：厂商配置弹窗（连接凭据 / 文本模型 / 生图模型 / 请求限制分区）
- `client/src/pages/settings/components/providers/TextModelProvidersSection.tsx`：文本模型分区
- `client/src/pages/settings/components/providers/ImageModelProvidersSection.tsx` 与 `ImageProviderStatusCard.tsx`：生图模型分区与精简卡片
- `client/src/pages/characters/components/CharacterImageDialog.tsx`
