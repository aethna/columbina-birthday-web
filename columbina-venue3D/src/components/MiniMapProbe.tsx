/**
 * MiniMapProbe —— 唯一在 Canvas 内运行的「小地图数据源」。
 *
 * 它自己不渲染任何东西，只把「玩家在哪 / 朝哪 / 现在几点」每帧写进
 * `ui/minimapState.ts` 那个纯模块对象，DOM 侧的 `ui/MiniMap.tsx` 再读它画图。
 *
 * 玩家坐标优先取 `gameStore.characterRef`（= 哥伦比娅本体）。
 * 注意 `?cam=` 固定机位时角色**不会**跟着走，所以那种情况下小地图显示的是
 * 相机所在位置 —— 这正是「机动验收」时想看的东西。
 */
import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three/webgpu';
import { useGameStore } from '../core/store/gameStore';
import { SkyClock } from '../core/sky/sunCycle';
import { dominantRegion } from '../core/worldRegions';
import { minimapState } from '../ui/minimapState';

const FWD = new Vector3();

/** `?cam=` 固定机位时**小地图要跟相机走，不跟角色走**：
 *  那种机位下角色还站在会场原点（`?cam=` 只挪相机，而且会卸掉 `CameraViewControl`），
 *  小地图会一直显示会场 —— 拿它去核对月球/浅海就完全对不上了。
 *  正常游玩（无 `?cam=`）跟角色走才是对的：小地图回答的是「我在哪」。 */
const CAM_LOCK = new URLSearchParams(window.location.search).has('cam');

export function MiniMapProbe() {
    const camera = useThree((s) => s.camera);
    const characterRef = useGameStore((s) => s.characterRef);

    useFrame(() => {
        const c = CAM_LOCK ? null : characterRef?.current;
        if (c) {
            minimapState.x = c.position.x;
            minimapState.z = c.position.z;
        } else {
            minimapState.x = camera.position.x;
            minimapState.z = camera.position.z;
        }

        // 朝向取相机视线在水平面的投影（`yaw` 的零点定在世界 -Z，也就是北）
        camera.getWorldDirection(FWD);
        minimapState.yaw = Math.atan2(FWD.x, -FWD.z);

        minimapState.hour = SkyClock.current;
        minimapState.region = dominantRegion(minimapState.x, minimapState.z);
        minimapState.ready = true;
    });

    return null;
}
