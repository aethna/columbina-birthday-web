# 《娅娅猫向前冲》素材需求与路径约定

## 当前阶段结论

当前阶段保留既有地图、角色和机关对象，只优化地图视觉呈现。新增的 Blockbench 模型已经接入地图预览；不改变地图坐标、玩法、高度机制、移动、跳跃、碰撞或机关逻辑。弹簧和活塞默认停在动画首帧，分别在实际弹射和实际启动时播放一次现成动画；角色、其他机关、特效和音频仍未正式接入。

当前用于地形视觉预览的素材：

`D:\ColumbinaGame\columbina-birthday-web-main\columbina-birthday-web-main\columbina-game\p\cat-cake-race\model.gltf`

当前用于机关视觉预览的素材：

```text
D:\ColumbinaGame\columbina-birthday-web-main\columbina-birthday-web-main\columbina-game\p\cat-cake-race\弹簧-未准备.gltf
D:\ColumbinaGame\columbina-birthday-web-main\columbina-birthday-web-main\columbina-game\p\cat-cake-race\活塞-准备.gltf
D:\ColumbinaGame\columbina-birthday-web-main\columbina-birthday-web-main\columbina-game\p\cat-cake-race\地刺.gltf
D:\ColumbinaGame\columbina-birthday-web-main\columbina-birthday-web-main\columbina-game\p\cat-cake-race\牵引炸弹.gltf
```

弹簧放在 `u`、`w`、`x` 格；活塞放在 `R`、`L`、`P`、`D` 格并按符号旋转。默认加载静止模型并合并其中的小网格，地图上的多个实例共享合并结果，避免直接复制成上万次绘制。机关模型替换对应格最上层的视觉方块，逻辑高度和碰撞数据不变。活塞改为青色底座与金色机关头，和普通紫色地面保持明显区分。

`弹簧-动画.gltf` 与 `活塞-动画.gltf` 已由机关事件驱动：未触发时保持首帧，收到对应事件后完整播放一次并回到首帧，不做空闲循环。重新导出的 `地刺.gltf` 已包含 878 个可见网格和两个材质：底座使用深红色，刺体使用亮红色。渲染层保留尖刺高出普通方块的原始比例，并将模型内部小网格合并后复用。

`牵引炸弹.gltf` 以 `model.gltf` 为尺寸参考另存生成，原文件保持不变。新模型由黑色低多边形内核和半透明紫色外壳组成，悬浮在 `b`、`t` 格上方，不替换地形顶面，也不产生阻挡。预览层每10秒播放一次扩散光环和线框脉冲，作为爆炸视觉占位。

这是 Blockbench 5.0.7 导出的 glTF 模型，作为立方体尺寸、厚度和正面斜俯视比例的参考。当前渲染层使用正交相机，固定为 X 轴不偏移、Yaw=0°、Roll=0°，从负 Z 方向相对 Top-down 倾斜 30°，并看向 `(0, 0, 0)`。渲染层不会逐个复制模型里的 838 个小网格，而是依据地图高度生成合并网格：同高度顶面合并，内部接触面剔除，外围和高度差位置保留侧面。这样可以避免 10×50 地图产生大量重复网格和接缝。

旧的普通格图片仍保留在源码中，但不再作为当前地图预览的地形背景：

`D:\ColumbinaGame\columbina-birthday-web-main\columbina-birthday-web-main\columbina-game\p\cat-cake-race\普通.png`

它仅作为历史占位素材，不参与新的 45° 合并地形渲染。

项目源码根目录：

`D:\ColumbinaGame\columbina-birthday-web-main\columbina-birthday-web-main\columbina-game`

素材源文件统一放在：

`D:\ColumbinaGame\columbina-birthday-web-main\columbina-birthday-web-main\columbina-game\p\cat-cake-race\`

不要手动把素材放进 `public\game\assets\`。该目录是构建同步产物，后续应由源码导入和构建流程生成。

## 建议目录

```text
p/
└─ cat-cake-race/
   ├─ characters/
   │  ├─ player/
   │  │  ├─ idle.png
   │  │  ├─ jump.png
   │  │  ├─ death.png
   │  │  └─ respawn.png
   │  └─ ai/
   │     ├─ ai-01.png
   │     ├─ ai-02.png
   │     ├─ ai-03.png
   │     └─ ai-04.png
   ├─ terrain/
   │  ├─ normal.png
   │  ├─ wall.png
   │  ├─ pit.png
   │  ├─ spikes.png
   │  └─ glue.png
   ├─ mechanisms/
   │  ├─ spring-2-up.png
   │  ├─ spring-3-up.png
   │  ├─ spring-4-up.png
   │  ├─ piston-up.png
   │  ├─ piston-down.png
   │  ├─ piston-left.png
   │  ├─ piston-right.png
   │  └─ bomb.png
   ├─ effects/
   │  ├─ jump.webp
   │  ├─ death.webp
   │  ├─ respawn.webp
   │  ├─ spring.webp
   │  ├─ piston.webp
   │  ├─ glue.webp
   │  └─ bomb.webp
   ├─ ui/
   │  ├─ map-frame.webp
   │  ├─ checkpoint-line.webp
   │  ├─ start-line.webp
   │  └─ finish-line.webp
   └─ audio/
      ├─ bgm/
      └─ sfx/
```

## 素材类型说明

| 目录 | 用途 | 当前是否调用 |
| --- | --- | --- |
| `characters/` | 玩家和4个AI猫猫糕的待机、跳跃、死亡、复活表现 | 否（仅保留中央角色占位图） |
| `terrain/` | 普通格、墙、坑、尖刺、胶水的视觉表现 | 否 |
| `model.gltf` | Blockbench 立方体尺寸与比例参考；当前用于合并地形预览 | 是（仅地形预览） |
| `弹簧-未准备.gltf` | 弹簧静态模型备份 | 否（保留） |
| `活塞-准备.gltf` | 活塞静态模型备份 | 否（保留） |
| `弹簧-动画.gltf` / `活塞-动画.gltf` | 机关默认首帧与触发时的单次动画 | 是 |
| `地刺.gltf` | `^` 格的红色地刺模型 | 是 |
| `牵引炸弹.gltf` | `b`、`t` 格的悬浮黑核透明外壳模型 | 是 |
| `mechanisms/` | 后续其他机关的静态图标或底图 | 否 |
| `effects/` | 跳跃、死亡、复活和机关触发动画 | 否 |
| `ui/` | 起点线、复活线、终点线和地图界面装饰 | 否 |
| `audio/` | 背景音乐、跳跃、机关、死亡等声音 | 否 |

## 当前地图符号与素材关系

`地图.txt` 中的符号只代表逻辑对象，不要求现在准备同名图片：

- `.`、`0`、`2` → `terrain/normal.png` 的不同高度状态；
- `#` → `terrain/wall.png`；
- `o` → `terrain/pit.png`；
- `^` → 红色 `地刺.gltf`；
- `g` → `terrain/glue.png`；
- `u`、`w`、`x` → `弹簧-动画.gltf`；不同弹射距离仅保留为逻辑参数；
- `R`、`L`、`P`、`D` → `活塞-动画.gltf`，显示层按上、下、左、右旋转；
- `b`、`t` → `牵引炸弹.gltf`，两者是同一种牵引炸弹；
- `S`、`C`、`F` → 起点线、复活线、终点线。

## 尚未确定的素材规格

当前不擅自规定角色/机关图片的像素尺寸、帧数、动画帧率、音频格式、采样率、是否需要透明背景或是否使用精灵图。`model.gltf` 的网格合并仅用于视觉显示，不改变逻辑高度值；后续如提供带纹理的 `.bbmodel`/`.glb`，再补充纹理映射和材质校验。
