import { useEffect, useState } from 'react'
import * as THREE from 'three'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { VATData, VATMeta } from './types'

const promiseCache = new Map<string, Promise<VATData>>()
const resultCache = new Map<string, VATData>()

function resolvePath(metaUrl: string, relativePath: string): string {
  if (
    relativePath.startsWith('/') ||
    relativePath.startsWith('http://') ||
    relativePath.startsWith('https://')
  ) {
    return relativePath
  }
  const metaDir = metaUrl.substring(0, metaUrl.lastIndexOf('/') + 1)
  return metaDir + relativePath
}

/**
 * Preload VAT assets (meta, mesh, position/normal textures) with global caching.
 */
export const preloadVATAssets = (metaUrl: string): Promise<VATData> => {
  if (resultCache.has(metaUrl)) return Promise.resolve(resultCache.get(metaUrl)!)
  if (promiseCache.has(metaUrl)) return promiseCache.get(metaUrl)!

  const promise = (async () => {
    try {
      const loader = new THREE.FileLoader()
      const metaStr = await loader.loadAsync(metaUrl)
      const meta = JSON.parse(metaStr as string) as VATMeta

      const resolve = (p: string) => resolvePath(metaUrl, p)

      const loadMesh = async (path: string) => {
        const ext = path.split('.').pop()?.toLowerCase()
        if (ext === 'fbx') {
          const l = new FBXLoader()
          return await l.loadAsync(path)
        }
        const l = new GLTFLoader()
        const g = await l.loadAsync(path)
        return g.scene
      }

      const loadTex = async (path: string) => {
        const isEXR = path.toLowerCase().endsWith('exr')
        const l = isEXR
          ? new EXRLoader().setDataType(THREE.FloatType)
          : new THREE.TextureLoader()
        return await l.loadAsync(path)
      }

      const [scene, posTex, nrmTex] = await Promise.all([
        meta.glb ? loadMesh(resolve(meta.glb)) : null,
        meta.textures?.position ? loadTex(resolve(meta.textures.position)) : null,
        meta.textures?.normal ? loadTex(resolve(meta.textures.normal)) : null,
      ])

      const data: VATData = { scene, posTex, nrmTex, meta, isLoaded: true }
      resultCache.set(metaUrl, data)
      return data
    } catch (e) {
      console.error('VAT Load Failed', e)
      return { scene: null, posTex: null, nrmTex: null, meta: null, isLoaded: false }
    }
  })()

  promiseCache.set(metaUrl, promise)
  return promise
}

/** React hook that loads VAT assets via the shared preload cache. */
export function useVATPreloader(metaUrl: string) {
  const [data, setData] = useState<VATData>(() => {
    if (resultCache.has(metaUrl)) return resultCache.get(metaUrl)!
    return { scene: null, posTex: null, nrmTex: null, meta: null, isLoaded: false }
  })

  useEffect(() => {
    if (data.isLoaded) return

    let active = true

    preloadVATAssets(metaUrl).then((loadedData) => {
      if (active) setData(loadedData)
    })

    return () => {
      active = false
    }
  }, [metaUrl, data.isLoaded])

  return data
}

/** Clear VAT asset caches (useful for HMR / tests). */
export function clearVATCache() {
  promiseCache.clear()
  resultCache.clear()
}
