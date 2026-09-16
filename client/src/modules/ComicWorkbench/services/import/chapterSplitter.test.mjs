import test from "node:test";
import assert from "node:assert/strict";

import { classifyLine, compileChapterRules, splitIntoChapters } from "./chapterSplitter.ts";

// 镜像 config/chapterPatterns.json（测试内联，避免 JSON 依赖）
const patterns = {
  chapterHeadingPatterns: [
    "^第\\s*[0-9０-９]+\\s*[章节回话集卷部篇]",
    "^第\\s*[零〇一二两三四五六七八九十百千万]+\\s*[章节回话集卷部篇]",
    "^Chapter\\s+\\d+",
    "^Chapter\\s+(One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)\\b",
    "^\\d{1,4}\\s*[、．]",
    "^\\d{1,4}\\.\\s+\\S",
  ],
  storyHeadingPatterns: ["^序章", "^楔子", "^引子", "^尾声", "^终章", "^番外"],
  frontMatterHeadingPatterns: [
    "^前言", "^序言", "^导语", "^引言", "^简介", "^内容简介", "^内容提要",
    "^文案", "^作品相关", "^作品信息", "^设定集",
  ],
  authorNoteHeadingPatterns: [
    "^作者的话", "^作者留言", "^作者有话说", "^上架感言", "^感言", "^公告",
    "^致谢", "^后记", "^更新说明", "^请假条",
  ],
  headingMaxChars: 50,
  headingTitleMaxChars: 30,
  headingTightTitleMaxChars: 12,
  headingTightTitleForbiddenStarts: "的了是说有在就也都也被把让使向从与和跟给为对快要想到看听走回来去说",
  headingPunctuationForbidden: "。！？；…，、",
  pureNumberHeadingPattern: "^\\d{1,4}$",
  pureNumberMaxChars: 8,
  frontMatterHeadingMaxChars: 30,
  frontMatterMaxChars: 5000,
  junkLinePatterns: [
    "https?://\\S+",
    "www\\.\\S+",
    "^求(收藏|推荐票?|月票|订阅|评论|鲜花|打赏|追读|支持)\\s*[：:!！，,。\\s]",
    "^\\[\\s*求(收藏|推荐票?|月票|订阅|评论|鲜花|打赏)\\s*\\]",
    "^[（(]\\s*求(收藏|推荐票?|月票|订阅|评论|鲜花|打赏)\\s*[)）]",
    "记住本站|本书首发|最新章节|无弹窗|笔趣阁|小说网|首发于|转载请注明|盗版必究",
  ],
  junkLineMaxChars: 60,
  separatorLinePattern: "^[\\s\\-—－–=_＝~～*＊*•·・.。…·]{6,}$",
  invisibleCharPattern: "[\\u200b\\u200c\\u200d\\u2060\\ufeff\\u00ad\\u180e\\u200e\\u200f]",
};

const rules = compileChapterRules(patterns);

function split(raw, fallbackTitle = "测试书") {
  return splitIntoChapters(raw, patterns, fallbackTitle);
}

test("识别「第X章」中文数字与阿拉伯数字章节号", () => {
  const raw = [
    "第一章 初入宗门",
    "他推开了山门。",
    "第二章 风雪夜",
    "雪下得很大。",
    "第 3 节",
    "又是新的一天。",
  ].join("\n");
  const { chapters, report } = split(raw);
  assert.equal(chapters.length, 3);
  assert.equal(chapters[0].title, "第一章 初入宗门");
  assert.equal(chapters[1].title, "第二章 风雪夜");
  assert.equal(chapters[2].title, "第 3 节");
  assert.ok(report.headingLineCount >= 3);
});

test("识别纯数字章节号行，但行中断句中的数字不误判", () => {
  // 纯数字行独立成行（前有空行/文件开头）→ 章节号，后续正文归入该章
  const raw = ["12", "他今年十二岁。", "正文继续。"].join("\n");
  const { chapters } = split(raw);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, "12");
  assert.ok(chapters[0].content.includes("他今年十二岁。"));

  // 纯数字行紧贴正文（前一行非空）→ 不算章节号
  const raw2 = ["他数到", "12", "就停了。"].join("\n");
  const { chapters: chapters2 } = split(raw2);
  assert.equal(chapters2.length, 1);
  assert.ok(chapters2[0].content.includes("12"));
});

test("识别编号标题「12、标题」但拒绝正文数字句", () => {
  assert.equal(classifyLine("12、重生归来", { prevLine: "", atFileStart: true }, rules).type, "chapter");
  assert.equal(classifyLine("1. 风雪夜", { prevLine: "", atFileStart: true }, rules).type, "chapter");
  // 无分隔符的数字开头正文行不误判
  assert.equal(classifyLine("12岁的时候他还在上学", { prevLine: "", atFileStart: true }, rules).type, "normal");
  // 「第十二章的内容」不误判
  assert.equal(classifyLine("第十二章的内容让我震惊", { prevLine: "", atFileStart: true }, rules).type, "normal");
});

test("前言/导语/作者的话识别为非正文块并从正文中移出", () => {
  const raw = [
    "前言",
    "这本书讲了一个故事。",
    "第一章 开端",
    "故事开始了。",
    "作者的话：",
    "感谢大家支持。",
  ].join("\n");
  const { chapters, report } = split(raw);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, "第一章 开端");
  assert.ok(chapters[0].content.startsWith("故事开始了。"));
  assert.ok(!chapters[0].content.includes("这本书讲了一个故事"));
  assert.ok(!chapters[0].content.includes("感谢大家支持"));
  assert.equal(chapters[0].annotations.length, 2);
  assert.equal(chapters[0].annotations[0].kind, "frontMatter");
  assert.equal(chapters[0].annotations[1].kind, "authorNote");
  assert.equal(report.annotationCount, 2);
});

test("广告推广行与分隔线被清理", () => {
  const raw = [
    "本书首发于某某小说网，盗版必究",
    "http://www.example.com/abc",
    "——————",
    "。。。。。。",
    "第一章 开端",
    "正文内容在这里。",
  ].join("\n");
  const { chapters, report } = split(raw);
  assert.equal(chapters.length, 1);
  assert.ok(!chapters[0].content.includes("小说网"));
  assert.ok(!chapters[0].content.includes("example.com"));
  assert.ok(!chapters[0].content.includes("——————"));
  assert.ok(report.junkLineCount >= 2);
  assert.ok(report.separatorLineCount >= 2);
});

test("不可见字符被清除", () => {
  const raw = "第一章 开端\n\u200b正文\u00ad内容。\uFEFF";
  const { chapters, report } = split(raw);
  assert.ok(report.invisibleCharCount >= 3);
  assert.ok(!chapters[0].content.includes("\u200b"));
  assert.ok(chapters[0].content.includes("正文内容。"));
});

test("无章节号时整体回落为单章", () => {
  const raw = "第一段。\n\n第二段。";
  const { chapters } = split(raw, "我的书");
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, "我的书");
  assert.ok(chapters[0].content.includes("第一段。"));
  assert.ok(chapters[0].content.includes("第二段。"));
});

test("整本书只有前言时回落为单章不丢内容", () => {
  const raw = "前言\n这整本书都是说明文字。";
  const { chapters } = split(raw);
  assert.equal(chapters.length, 1);
  assert.ok(chapters[0].content.includes("这整本书都是说明文字。"));
});

test("序章/楔子/番外视为正文章节", () => {
  const raw = ["楔子", "很久以前。", "第一章 开端", "正文。"].join("\n");
  const { chapters } = split(raw);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, "楔子");
  assert.ok(chapters[0].content.includes("很久以前。"));
});

test("章节号行不能包含句读", () => {
  const raw = ["第一章，他来了。", "这不是标题。"].join("\n");
  const { chapters } = split(raw);
  assert.equal(chapters.length, 1);
  assert.ok(chapters[0].content.includes("第一章，他来了。"));
});
