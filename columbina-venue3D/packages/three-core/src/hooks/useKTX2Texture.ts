import { useLoader, useThree } from '@react-three/fiber'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { Texture } from 'three'
import { useMemo } from 'react'

export function useKTX2Texture(paths: Record<string, string>) {
  const gl = useThree((state) => state.gl)
  
  const { keys, urls } = useMemo(() => {
    const keys = Object.keys(paths)
    const urls = Object.values(paths).map(p => p.replace('.png', '.ktx2').replace('.jpg', '.ktx2'))
    return { keys, urls }
  }, [paths])

  const textures = useLoader(KTX2Loader, urls, (loader) => {
    loader.setTranscoderPath('https://cdn.jsdelivr.net/gh/pmndrs/drei-assets@master/basis/')
    loader.detectSupport(gl)
  })

  const result = useMemo(() => {
      const res: Record<string, Texture> = {}
      
      if (Array.isArray(textures)) {
          keys.forEach((key, i) => res[key] = textures[i])
      } else {
          res[keys[0]] = textures as Texture
      }
      
      return res
  }, [textures, keys])
  
  return result
}