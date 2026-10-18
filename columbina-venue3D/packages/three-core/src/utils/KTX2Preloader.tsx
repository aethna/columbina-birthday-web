import { useKTX2Texture } from '../hooks/useKTX2Texture' 

export function KTX2Preloader({ paths }: { paths: Record<string, string> }) {
  useKTX2Texture(paths)
  return null
}