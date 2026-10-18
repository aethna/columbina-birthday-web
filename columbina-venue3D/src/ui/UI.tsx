import { useGameStore } from "../core/store/gameStore";
import { LoadingScreen } from "./LoadingScreen";
import AudioButton from "./AudioButton";
import { SideBar } from "./SideBar";
import { MiniMap } from "./MiniMap";
import { WorldMap } from "./WorldMap";
import { QuestList } from "./QuestList";
import { InteractHint } from "./InteractHint";
import { DialogBox } from "./DialogBox";
import { PhotoView } from "./PhotoView";
import { LetterPaper } from "./LetterPaper";
import { PhotoBar } from "./PhotoBar";
import { AlbumView } from "./AlbumView";
import { Toast } from "./Toast";
import { BlackFade } from "./BlackFade";
import { TouchJoystick } from "../core/input/TouchJoystick";
import { input } from "../core/input/controls";

export function UI() {
    const isMobile = useGameStore((state) => state.isMobile);
    const isControlEnabled = useGameStore((state) => state.isControlEnabled);

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none', // Critical: lets clicks pass through to the 3D canvas
            zIndex: 10 // Ensure UI is above Canvas
        }}>
            <LoadingScreen />

            {/* ★ 左上角小地图 + 方向指示。**挂在最外层**（而不是 isControlEnabled 那一层）：
                它跟 AudioButton/SideBar 不一样，不是「操作 UI」——玩家一进场景就该看见自己在哪。
                自己用 rAF 驱动 canvas，不参与 React 重渲染。 */}
            <MiniMap />

            {/* ★ M 键大地图（用户 m01512）。整张图按种子函数烘出来，进游戏就是完整的。 */}
            <WorldMap />

            {/* ★ 右侧任务列表（用户 m02541：「右侧新增任务列表，任务名为写邀请函」）。
                挂最外层：任务进度跟 isControlEnabled 无关，载入/过场时也该在。 */}
            <QuestList />

            {/* ★ 屏幕底部的「按 F」互动提示。数据源是 `core/game/interact.ts` 的
                `interactState`（每帧被写），组件用 rAF 自己读，只在目标变化时 setState。 */}
            <InteractHint />

            {/* ★ 纯文字对话框（用户 m02627：「对话框设计为纯文字即可，按鼠标/F键翻下一页」）。
                挂载期间它会用**捕获阶段**截住 KeyF，免得互动系统把同一个 F 又吃一次。 */}
            <DialogBox />

            {/* ★ 合影查看（用户 m02541 第⑤步：切完蛋糕给合影，「按 F 收起」）。
                ⚠️ m02646 收紧后这里**只有 F**、没有鼠标 handler —— 遮罩仍然吃掉点击，
                免得穿透到 3D canvas 上误触发。 */}
            <PhotoView />

            {/* ★ 信纸（用户 m02541 第①步）。这是**明确允许用鼠标**的两处之一
                （「显示完成后，点击鼠标，做信纸收进信封动画」），所以它有 onClick。
                没在写信时自己 `return null`。 */}
            <LetterPaper />

            {/* ★ 拍照 / 相册（用户 m02820：「合影功能做常态化（即界面UI做一个拍照按钮），
                再做一个相册按钮」）。这两个是 UI 按钮，用户点名要鼠标点击。 */}
            <PhotoBar />
            <AlbumView />

            {/* ★ 屏幕中央文字提示（「邀请函已寄出」这类），`pointerEvents:'none'`。 */}
            <Toast />

            {/* ★ 黑屏过渡 + 载入进度条（用户 m02762 授权：「如果刷新过程慢，卡顿，
                可以增加黑屏淡入淡出重新载入（配载入进度条）」）。
                zIndex 最高（90），过渡期间吃点击防误操作。 */}
            <BlackFade />

            <div style={{
                position: 'absolute',
                top: 0, left: 0, width: '100%', height: '100%',
                pointerEvents: 'none',

                opacity: isControlEnabled ? 1 : 0,
                visibility: isControlEnabled ? 'visible' : 'hidden',
                transition: `opacity 0.5s ease, visibility 0s linear ${isControlEnabled ? '0s' : '0.5s'}`
            }}>
                <AudioButton />
                <SideBar />

                {isMobile &&
                    <TouchJoystick
                        input={input}
                        actions={{
                            forward: 'MoveForward',
                            backward: 'MoveBackward',
                            left: 'RotateLeft',
                            right: 'RotateRight',
                            run: 'Run'
                        }} />}
            </div>
        </div>
    );
}