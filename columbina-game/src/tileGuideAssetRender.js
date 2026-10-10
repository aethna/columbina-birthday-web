import { createApp, h } from 'vue'
import terrainModelUrl from '../p/cat-cake-race/model.gltf?url'
import springModelUrl from '../p/cat-cake-race/弹簧-动画.gltf?url'
import pistonModelUrl from '../p/cat-cake-race/活塞-动画.gltf?url'
import spikeModelUrl from '../p/cat-cake-race/地刺.gltf?url'
import bombModelUrl from '../p/cat-cake-race/牵引炸弹.gltf?url'
import { tileGuideMap } from './games/catCakeRace/tileGuideMap.js'
import CatCakeTerrainPreview from './components/CatCakeTerrainPreview.vue'

const result = document.querySelector('#tile-guide-assets')

createApp({
  render() {
    return h(CatCakeTerrainPreview, {
      map: tileGuideMap,
      modelUrl: terrainModelUrl,
      spriteUrl: '',
      springModelUrl,
      pistonModelUrl,
      spikeModelUrl,
      bombModelUrl,
      guideMode: true,
      onGuideTilesReady(images) {
        window.__tileGuideImages = images
        result.textContent = JSON.stringify(images)
      },
    })
  },
}).mount('#app')
