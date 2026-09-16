-- 漫画工作台分镜图场景类型（任务归属由客户端维护，服务端仅记录场景类型）
ALTER TYPE "ImageSceneType" ADD VALUE IF NOT EXISTS 'comic_panel';
