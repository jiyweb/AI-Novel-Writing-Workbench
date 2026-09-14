import { useMemo, useState } from "react";
import { Image as ImageIcon, Images, Plus } from "lucide-react";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { APIKeyStatus } from "@/api/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AUTO_DIRECTOR_MOBILE_CLASSES } from "@/mobile/autoDirector";
import ImageProviderStatusCard from "./ImageProviderStatusCard";
import AddProviderDialog from "./AddProviderDialog";

export default function ImageModelProvidersSection(props: {
  providers: APIKeyStatus[];
  onCreateCustomProvider: () => void;
  onOpenConfig: (provider: LLMProvider) => void;
}) {
  const { providers, onCreateCustomProvider, onOpenConfig } = props;
  const [isAddProviderOpen, setIsAddProviderOpen] = useState(false);
  const imageProviders = useMemo(
    () => providers.filter((provider) => provider.isConfigured && provider.isActive && provider.supportsImageGeneration),
    [providers],
  );
  const addableBuiltIns = providers.filter((provider) => provider.kind === "builtin" && (!provider.isConfigured || !provider.isActive));

  return (
    <Card id="settings-image-model-section" className="min-w-0 scroll-mt-20 overflow-hidden border-primary/10 bg-gradient-to-b from-primary/[0.035] to-background shadow-sm">
      <CardHeader className="flex flex-col gap-4 border-b bg-background/60 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <ImageIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>生图模型</CardTitle>
              <Badge variant={imageProviders.length ? "default" : "outline"}>{imageProviders.length} 个可用连接</Badge>
            </div>
            <CardDescription className={AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}>
              角色形象、小说封面、漫画格子等图片生成使用的模型。在厂商配置里填写生图模型后，就会出现在这里。
            </CardDescription>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button className={AUTO_DIRECTOR_MOBILE_CLASSES.fullWidthAction} onClick={() => setIsAddProviderOpen(true)}>
            <Plus className="h-4 w-4" /> 添加厂商
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4 pt-5 md:grid-cols-2">
        {imageProviders.map((provider) => (
          <ImageProviderStatusCard
            key={provider.provider}
            provider={provider}
            onOpenConfig={onOpenConfig}
          />
        ))}
        {!imageProviders.length ? (
          <div className="rounded-xl border border-dashed bg-background/70 p-6 text-center text-sm text-muted-foreground md:col-span-2">
            <Images className="mx-auto mb-3 h-6 w-6 text-primary" />
            <div className="font-medium text-foreground">还没有可用的生图模型</div>
            <div className="mt-1">添加支持图片生成的厂商，在配置里填写生图模型后，就能生成角色图、封面和漫画图。</div>
          </div>
        ) : null}
      </CardContent>
      <AddProviderDialog
        open={isAddProviderOpen}
        onOpenChange={setIsAddProviderOpen}
        addableBuiltIns={addableBuiltIns}
        onPickBuiltIn={onOpenConfig}
        onCreateCustom={onCreateCustomProvider}
      />
    </Card>
  );
}
