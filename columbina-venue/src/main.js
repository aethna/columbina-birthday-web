import Phaser from 'phaser';
import VenueScene from './VenueScene.js';

/**
 * 取父容器的实际像素尺寸。
 *
 * 为什么不能直接依赖 '100%'：
 *   Scale.RESIZE 模式下 Phaser 是从父容器读尺寸的，
 *   如果父容器的高度链（html/body/#game-root）任何一环没撑开，
 *   画布就会变成 0 高 —— 表现就是「进去一片黑」。
 *   所以这里显式测量，并在测不到时兜底到窗口尺寸。
 */
function getContainerSize() {
  const el = document.getElementById('game-root');
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 10 && r.height > 10) {
      return { width: Math.floor(r.width), height: Math.floor(r.height) };
    }
  }
  // 兜底：用窗口尺寸
  return {
    width: Math.max(320, window.innerWidth),
    height: Math.max(240, window.innerHeight),
  };
}

const size = getContainerSize();

const config = {
  type: Phaser.AUTO,
  parent: 'game-root',
  // 背景色取地图外的深色，地图边缘露出来时也不会突兀
  backgroundColor: '#141c18',

  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.NO_CENTER, // RESIZE 模式下不要居中，铺满即可
    // 用实测像素值初始化，避免 '100%' 在 RESIZE 模式下解析失败
    width: size.width,
    height: size.height,
  },

  physics: {
    default: 'arcade',
    arcade: {
      gravity: { y: 0 },
      debug: false, // 想看碰撞框就改成 true
    },
  },

  render: {
    pixelArt: false,
    antialias: true,
  },

  scene: [VenueScene],
};

const game = new Phaser.Game(config);

// 暴露给诊断脚本
window.__venueGame = game;
