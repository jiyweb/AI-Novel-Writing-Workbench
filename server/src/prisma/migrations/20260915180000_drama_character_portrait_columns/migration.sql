-- 补 DramaCharacter 表缺失的 portraitData 和 threeViewData 列
ALTER TABLE "DramaCharacter" ADD COLUMN "portraitData" TEXT;
ALTER TABLE "DramaCharacter" ADD COLUMN "threeViewData" TEXT;
