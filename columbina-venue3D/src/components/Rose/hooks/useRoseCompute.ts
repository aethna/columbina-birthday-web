import { storage, struct, vec3, uniform } from "three/tsl";
import * as THREE from "three/webgpu";
import type { RoseLODBufferConfig } from "../core/config";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  createRoseInstanceData,
  createResetCountCompute,
  createResetInstanceCompute,
  createSpawnCompute,
  createUpdateCompute,
} from "../core/vatCompute";
import { useFrame } from "@react-three/fiber";
import { WebGPURenderer } from "three/webgpu";
import { useThree } from "@react-three/fiber";
import { useShortcut } from "@core/hooks/useShortcut";

const BATCH_SIZE = 1024;

export function useRoseCompute(
    count: number,
    lodBuffers: RoseLODBufferConfig[],
    uniforms: Record<string, any>
) {
    const { gl, camera } = useThree()
    const computeRefs = useRef<{ resetCount: THREE.ComputeNode[], resetInstance: THREE.ComputeNode, spawn: THREE.ComputeNode, update: THREE.ComputeNode } | null>(null)

    const spawnUniforms = useMemo(() => ({
        uSpawnPos: uniform(vec3(0)),
        uSpawnCount: uniform(0),
        uSpawnRadius: uniform(0.5),
    }), [])

    const spawnStorage = useMemo(() => {
        const spawnStateStruct = struct({
            index: { type: 'uint', atomic: true }
        })
        const buffer = new THREE.StorageBufferAttribute(new Uint32Array([0]), 1)
        return storage(buffer, spawnStateStruct, 1)
    }, [])

    const vatData = useMemo(() => createRoseInstanceData(count), [count]);

    useEffect(() => {
        if (!lodBuffers.length || !uniforms) return;

        const resetCountComputes = lodBuffers.map((lodBuffer, index) => {
            return createResetCountCompute(lodBuffer.drawStorage, lodBuffer.vertexCount).setName(`RoseReset_LOD${index}`)
        })

        const spawnCompute = createSpawnCompute(vatData, spawnStorage, spawnUniforms, BATCH_SIZE, count).setName('RoseSpawn')
        const resetInstanceCompute = createResetInstanceCompute(vatData, count).setName('RoseResetInstance')
        const updateCompute = createUpdateCompute(lodBuffers, vatData, count, uniforms).setName('RoseUpdate')

        computeRefs.current = { resetCount: resetCountComputes, resetInstance: resetInstanceCompute, spawn: spawnCompute, update: updateCompute }

        return () => {
            computeRefs.current = null
        }
    }, [lodBuffers, uniforms, vatData, spawnStorage, spawnUniforms, count])


    useShortcut('x', () => {
        const renderer = gl as unknown as WebGPURenderer
        if (!computeRefs.current) return
        renderer.compute(computeRefs.current.resetInstance)
    });

    const spawn = useCallback((pos: THREE.Vector3, amount: number = 1, radius: number = 0.5) => {
        spawnUniforms.uSpawnPos.value.copy(pos);
        spawnUniforms.uSpawnCount.value = Math.min(amount, BATCH_SIZE);
        spawnUniforms.uSpawnRadius.value = radius;
    }, [spawnUniforms]);

    useFrame(() => {
        const renderer = gl as unknown as WebGPURenderer
        if (!computeRefs.current) return

        uniforms.uViewProjectionMatrix.value.multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse
        )
        uniforms.uCameraPosition.value.copy(camera.position)

        computeRefs.current.resetCount.forEach(resetCountCompute => {
            renderer.compute(resetCountCompute)
        })

        renderer.compute(computeRefs.current.spawn)
        renderer.compute(computeRefs.current.update)

        spawnUniforms.uSpawnCount.value = 0
    })

    return {
        vatData,
        spawn,
    }
}
