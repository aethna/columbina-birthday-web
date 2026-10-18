import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { createVATMaterial } from "./core/vatMaterial";
import type { RoseLODBufferConfig } from "./core/config";
import { useKTX2Texture } from "@core";
import { ROSE_TEXTURES } from "./core/config";

interface RoseLODProps {
  count: number;
  lodBuffer: RoseLODBufferConfig;
  uniforms: Record<string, any>;
  vatData: ReturnType<typeof import('three/tsl').instancedArray>;
  config: any;
}

export function RoseLOD({
  count,
  lodBuffer,
  uniforms,
  vatData,
  config,
}: RoseLODProps) {
  const textures = useKTX2Texture(ROSE_TEXTURES);

  const mesh = useMemo(() => {
    if (!lodBuffer || !vatData || !textures.petal || !textures.outline || !textures.normal) {
      return null;
    }

    // Configure textures
    textures.petal.colorSpace = THREE.SRGBColorSpace;
    textures.normal.colorSpace = THREE.NoColorSpace;
    textures.normal.repeat.set(0.8, 1);
    textures.normal.offset.set(0.1, 0);

    // Get debug color from LOD config
    const lodDebugColor = lodBuffer.debugColor 
      ? new THREE.Color(...lodBuffer.debugColor)
      : new THREE.Color(1, 1, 0);

    const material = createVATMaterial(
      lodBuffer.posTex,
      lodBuffer.nrmTex,
      vatData,
      lodBuffer.indices,
      lodBuffer.meta,
      uniforms,
      textures.petal,
      textures.outline,
      textures.normal,
      lodDebugColor,
    );

    const mesh = new THREE.Mesh(lodBuffer.geometry, material);
    mesh.count = count;
    mesh.frustumCulled = false;
    mesh.receiveShadow = false;
    mesh.castShadow = false;

    return mesh;
  }, [
    count,
    lodBuffer,
    vatData,
    uniforms,
    textures.petal,
    textures.outline,
    textures.normal,
  ]);

  // Update material properties
  useEffect(() => {
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshStandardNodeMaterial;
    mat.roughness = config.roughness ?? 0.3;
    mat.metalness = config.metalness ?? 0.5;
  }, [mesh, config.roughness, config.metalness]);

  // Cleanup：**只释放本组件自己 new 出来的材质**。
  //
  // ⚠️⚠️ 曾经在这里写 `mesh.geometry.dispose()`，是个隐蔽的 use-after-free：
  //   · `mesh` 建在 useMemo 里，用的是 `lodBuffer.geometry`（`:54`）——
  //     那份几何是父级 `useRoseLODLoader` 加载后持有的**共享资源**，不归本组件所有；
  //   · useMemo 的依赖含 `count / uniforms / vatData / 三张贴图`，任一变化都会造一个
  //     **新 mesh，但仍复用同一个 `lodBuffer.geometry`**；
  //   · 而本 effect 的依赖只有 `[mesh]` ⇒ React 的顺序是「先渲染出新 mesh → 再跑旧
  //     effect 的 cleanup → 释放 geometry」，释放掉的正是新 mesh 刚要用的那份缓冲。
  //   · 后果与 `components/world/WingShip.tsx:420-436` 记录的完全同型：
  //     `TypeError: Failed to execute 'setIndexBuffer' … not of type 'GPUBuffer'`。
  //     dev 的 StrictMode 双挂载会**立刻**触发，运行时改 LOD 数量也会触发。
  // 几何的所有权在 `hooks/useRoseLODLoader.ts:91`（它已经 dispose 了），这里不碰。
  useEffect(() => {
    if (!mesh) return;
    return () => {
      if (mesh.material) {
        const mat = mesh.material as THREE.MeshStandardNodeMaterial;
        mat.dispose();
      }
    };
  }, [mesh]);

  if (!mesh) return null;

  return <primitive object={mesh} />;
}
