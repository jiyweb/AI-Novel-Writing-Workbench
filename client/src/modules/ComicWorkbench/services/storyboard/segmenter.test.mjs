import test from "node:test";
import assert from "node:assert/strict";

import {
  findSplitOffset,
  groupSegmentsIntoPanels,
  segmentSourceText,
} from "./segmenter.ts";

// 镜像 config/shotDensity.json 的默认切分规则（测试内联，避免 JSON 依赖）
const rules = {
  sentenceEndChars: "。！？…!?；;",
  clauseBreakChars: "，,、：:",
  maxPanelChars: 120,
  minPanelChars: 12,
  sceneChangeForceSplit: true,
  sceneChangeMarkers: ["此时", "忽然", "突然", "次日", "镜头切换"],
  dialogueSeparateFromNarration: true,
  dialogueOpenChars: "“\"『「‘",
  dialogueCloseChars: "”\"』」’",
};

const levels = [
  { id: "ultraTight", name: "极紧", minSentences: 1, maxSentences: 2, description: "" },
  { id: "tight", name: "紧凑", minSentences: 2, maxSentences: 3, description: "" },
  { id: "standard", name: "标准", minSentences: 3, maxSentences: 5, description: "" },
  { id: "loose", name: "宽松", minSentences: 5, maxSentences: 8, description: "" },
  { id: "ultraLoose", name: "极松", minSentences: 8, maxSentences: 12, description: "" },
];

function segment(content) {
  return segmentSourceText(content, rules);
}

function assertRoundTrip(content, segments) {
  // 原文零修改：每个片段必须与 sourceContent.slice 严格一致
  for (const seg of segments) {
    assert.equal(seg.text, content.slice(seg.startIndex, seg.endIndex));
  }
}

test("按句末标点断句，省略号连续终止符合并为一处", () => {
  const content = "他停下脚步。夜风很凉……他叹了口气！";
  const segs = segment(content);
  assertRoundTrip(content, segs);
  assert.deepEqual(
    segs.map((s) => s.text),
    ["他停下脚步。", "夜风很凉……", "他叹了口气！"],
  );
});

test("对话与叙述分镜：引导语以冒号结尾时并入对话段", () => {
  const content = "他推门而入，说道：“你来了。”屋里很安静。";
  const segs = segment(content);
  assertRoundTrip(content, segs);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].kind, "dialogue");
  assert.equal(segs[0].text, "他推门而入，说道：“你来了。”");
  assert.equal(segs[1].kind, "narration");
  assert.equal(segs[1].text, "屋里很安静。");
});

test("对话与叙述分镜：无引导语时引文独立成段", () => {
  const content = "门开了。“谁？”他问。";
  const segs = segment(content);
  assertRoundTrip(content, segs);
  assert.deepEqual(
    segs.map((s) => s.kind),
    ["narration", "dialogue", "narration"],
  );
  assert.equal(segs[1].text, "“谁？”");
});

test("场景切换词在句中时强制断开", () => {
  const content = "他合上书，此时窗外传来脚步声。";
  const segs = segment(content);
  assertRoundTrip(content, segs);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].text, "此时窗外传来脚步声。");
});

test("场景切换片段在分组时是硬边界，不与上文同镜", () => {
  const content = "他合上书，此时窗外传来脚步声。";
  const segs = segment(content);
  const groups = groupSegmentsIntoPanels(segs, {
    levels,
    globalLevel: "standard",
    dynamic: { enabled: false, climaxKeywords: [], dialogueBoost: false },
    sceneChangeMarkers: rules.sceneChangeMarkers,
  });
  assert.equal(groups.length, 2);
});

test("超过 maxPanelChars 的叙述按从句符拆分", () => {
  const clause = "他沿着长街慢慢往前走，";
  const content = clause.repeat(20) + "。"; // 远超 120 字
  const segs = segment(content);
  assertRoundTrip(content, segs);
  for (const seg of segs) {
    assert.ok(seg.text.length <= rules.maxPanelChars, `片段超长：${seg.text.length}`);
  }
  assert.ok(segs.length > 1);
});

test("短句不再被吞并，保持句级片段供密度分组", () => {
  const content = "风停了。他抬头。天色已晚，他加快脚步走进巷子深处。";
  const segs = segment(content);
  assertRoundTrip(content, segs);
  assert.deepEqual(
    segs.map((s) => s.text),
    ["风停了。", "他抬头。", "天色已晚，他加快脚步走进巷子深处。"],
  );
});

test("密度分组：standard 档每组句数在 2-5 之间", () => {
  const content = "第一句。第二句。第三句。第四句。第五句。第六句。第七句。第八句。";
  const segs = segment(content);
  const groups = groupSegmentsIntoPanels(segs, {
    levels,
    globalLevel: "standard",
    dynamic: { enabled: false, climaxKeywords: [], dialogueBoost: false },
    sceneChangeMarkers: rules.sceneChangeMarkers,
  });
  assert.ok(groups.length >= 2);
  for (const group of groups) {
    assert.ok(group.segmentIndexes.length <= 5);
    assert.ok(group.segmentIndexes.length >= 2);
  }
});

test("动态密度：高潮词命中时收组更紧", () => {
  const content = "他平静地走过广场。人群忽然爆发了怒吼。他转身就跑。心跳如鼓。";
  const segs = segment(content);
  const dynamicGroups = groupSegmentsIntoPanels(segs, {
    levels,
    globalLevel: "standard",
    dynamic: { enabled: true, climaxKeywords: ["爆发", "怒吼", "心跳"], dialogueBoost: true },
    sceneChangeMarkers: rules.sceneChangeMarkers,
  });
  const staticGroups = groupSegmentsIntoPanels(segs, {
    levels,
    globalLevel: "standard",
    dynamic: { enabled: false, climaxKeywords: [], dialogueBoost: false },
    sceneChangeMarkers: rules.sceneChangeMarkers,
  });
  assert.ok(dynamicGroups.length > staticGroups.length);
});

test("对话段在对话加成下收紧收组", () => {
  const content = "夜色渐深。“你到底是谁？”她后退一步。灯忽然灭了。";
  const segs = segment(content);
  const groups = groupSegmentsIntoPanels(segs, {
    levels,
    globalLevel: "ultraLoose",
    dynamic: { enabled: true, climaxKeywords: [], dialogueBoost: true },
    sceneChangeMarkers: rules.sceneChangeMarkers,
  });
  const dialogueGroup = groups.find((g) =>
    g.segmentIndexes.some((i) => segs[i].kind === "dialogue"),
  );
  assert.ok(dialogueGroup);
  assert.ok(dialogueGroup.segmentIndexes.length <= 4);
});

test("findSplitOffset 优先句末符且两半都不低于 minPanelChars", () => {
  const text = "第一句话他说得格外郑重。第二句话语气突然冷了下来。第三句继续推进到巷口。";
  const offset = findSplitOffset(text, rules);
  assert.ok(offset !== null);
  assert.ok(offset > 0 && offset < text.length);
  assert.ok(offset >= rules.minPanelChars);
  assert.ok(text.length - offset >= rules.minPanelChars);
  assert.ok(rules.sentenceEndChars.includes(text[offset - 1]));
});

test("findSplitOffset 无可用句末符时退回从句符", () => {
  const text = "前面这一段先慢慢铺垫足够的情绪，后面这一段开始收束到行动上，最终落地。";
  const offset = findSplitOffset(text, rules);
  assert.ok(offset !== null);
  assert.ok(rules.clauseBreakChars.includes(text[offset - 1]));
  assert.ok(offset >= rules.minPanelChars);
  assert.ok(text.length - offset >= rules.minPanelChars);
});

test("文本过短（两半不足 minPanelChars）时拒绝拆分", () => {
  assert.equal(findSplitOffset("很短的一句话。", rules), null);
  assert.equal(findSplitOffset("没有标点也没有办法处理拆分操作", rules), null);
});

test("空文本与纯空白返回空片段", () => {
  assert.deepEqual(segment(""), []);
  assert.deepEqual(segment("   \n  "), []);
});
