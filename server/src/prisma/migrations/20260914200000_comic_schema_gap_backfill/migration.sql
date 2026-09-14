-- Backfill: Comic 模块 schema 与迁移链缺口
-- 这些字段/表已经存在于 schema.prisma，但此前遗漏了对应迁移。

-- ComicCharacter.gender
ALTER TABLE "ComicCharacter" ADD COLUMN "gender" TEXT NOT NULL DEFAULT 'unknown';

-- ComicPanel.sceneRef
ALTER TABLE "ComicPanel" ADD COLUMN "sceneRef" TEXT;

-- ComicScene
CREATE TABLE "ComicScene" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sceneType" TEXT NOT NULL DEFAULT 'interior',
    "bible" TEXT,
    "sheetData" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComicScene_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ComicScene_projectId_idx" ON "ComicScene"("projectId");

ALTER TABLE "ComicScene" ADD CONSTRAINT "ComicScene_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ComicProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ComicCharacterAsset
CREATE TABLE "ComicCharacterAsset" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageData" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComicCharacterAsset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ComicCharacterAsset_characterId_idx" ON "ComicCharacterAsset"("characterId");
CREATE INDEX "ComicCharacterAsset_projectId_idx" ON "ComicCharacterAsset"("projectId");

ALTER TABLE "ComicCharacterAsset" ADD CONSTRAINT "ComicCharacterAsset_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "ComicCharacter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComicCharacterAsset" ADD CONSTRAINT "ComicCharacterAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ComicProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
