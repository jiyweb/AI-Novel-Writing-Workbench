-- 补 DramaCharacter 表缺失的 portraitData 和 threeViewData 列
-- schema 已有但初始建表遗漏，导致视觉资源库打开时 Prisma 查询报错
ALTER TABLE "DramaCharacter" ADD COLUMN "portraitData" TEXT;
ALTER TABLE "DramaCharacter" ADD COLUMN "threeViewData" TEXT;
