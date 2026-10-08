/**
 * 过场插画资源表
 *
 * 需求（2026-10-08 第七轮）：
 *   任务2「所有委托做完、围坐吃蛋糕场景出现后，任务列表刷新新任务：切蛋糕……
 *        让 AI 画一张所有 NPC 围坐、哥伦比娅切蛋糕的图。这个图用原始立绘不用 Q 版。
 *        互动后，全屏显示这个图。点击鼠标收起。」
 *   任务4「接委托时，所有 NPC 增加合影选项。让 AI 根据当前 NPC 所在场景图画几个背景备用，
 *        合影直接用哥伦比娅立绘 + NPC 立绘 + 背景拼接即可。」
 *
 * 为什么单独一个文件：
 *   VenueScene.js 已经 2000+ 行，过场的「要加载哪些图」是纯数据，
 *   放这里改素材（换图 / 加背景）不用动主逻辑。
 *
 * ★ 贴图 key 直接用资源路径（和 celebration.js / 道具贴图一个约定），
 *   简单而且不可能撞名。
 */

/** 切蛋糕的全屏插画（原版立绘风格，非 Q 版） */
export const CAKE_ART = {
  tex: 'assets/cutscene/cake-cut.png',
};

/**
 * 合影背景（离线拼图用，运行时【不】加载）
 *
 * 每个「有站姿 NPC 的场景」一张 —— 由 tools/gen-cutscene.mjs 生成到
 * 图片素材/合影与结局/bg-<id>.png，再由 tools/gen-photo.py 和人物立绘拼成
 * assets/cutscene/photo-<npcId>.png。
 *
 * ★ 游戏运行时不需要这些背景：拼好的成图已经把背景吃进去了。
 *   这里保留这份清单，是为了让人一眼看出「合影背景该有哪几张」，
 *   也方便 gen-cutscene.mjs 和 gen-photo.py 的清单对得上。
 */
export const PHOTO_BGS = [
  { id: 'venue',    name: '林间空地' },
  { id: 'icefield', name: '冰原遗迹' },
  { id: 'pools',    name: '月面彩池' },
  { id: 'moonpath', name: '月面夜路' },
  { id: 'starship', name: '星船草甸' },
  { id: 'shallows', name: '青水浅滩' },
  { id: 'pond',     name: '静谧池塘' },
  { id: 'grove',    name: '林间秘境' },
].map((b) => ({ ...b, tex: `assets/cutscene/bg-${b.id}.png` }));

/** 按场景 id 取合影背景 */
export function photoBgOf(sceneId) {
  return PHOTO_BGS.find((b) => b.id === sceneId) || null;
}
