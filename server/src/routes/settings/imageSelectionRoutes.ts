import type { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { z } from "zod";
import { llmProviderSchema } from "../../llm/providerSchema";
import { validate } from "../../middleware/validate";
import {
  getImageSelectionSettings,
  saveImageSelectionSettings,
  type ImageSelectionSettings,
} from "../../services/settings/ImageSelectionSettingsService";

const imageSelectionSchema = z.object({
  provider: llmProviderSchema,
  model: z.string().trim().min(1, "生图模型名称不能为空。"),
});

export function registerImageSelectionRoutes(router: Router): void {
  router.get("/image-selection", async (_req, res, next) => {
    try {
      const data = await getImageSelectionSettings();
      res.status(200).json({
        success: true,
        data,
        message: "当前生图模型选择已加载。",
      } satisfies ApiResponse<ImageSelectionSettings | null>);
    } catch (error) {
      next(error);
    }
  });

  router.put(
    "/image-selection",
    validate({ body: imageSelectionSchema }),
    async (req, res, next) => {
      try {
        const data = await saveImageSelectionSettings(req.body as z.infer<typeof imageSelectionSchema>);
        res.status(200).json({
          success: true,
          data,
          message: "当前生图模型选择已保存。",
        } satisfies ApiResponse<ImageSelectionSettings>);
      } catch (error) {
        next(error);
      }
    },
  );
}
