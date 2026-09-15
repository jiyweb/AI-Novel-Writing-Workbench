/**
 * 漫画工作台模块门面
 *
 * 外部（路由/Sidebar）只允许从这里导入，不允许深入模块内部文件，
 * 以保证模块边界（comic-workbench-rule.md 第3条）。
 */
export { default as ComicWorkbenchPage } from "./pages/ComicWorkbenchPage";
export { default as ComicProjectPage } from "./pages/ComicProjectPage";
