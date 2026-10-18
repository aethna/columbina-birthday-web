# @momentchan/three-core

A minimalist utility library for **Three.js (WebGPU)** and **React Three Fiber**.

## 📦 Installation

This package is managed as a Git Submodule. To add it to your project:

```bash
git submodule add [https://github.com/momentchan/three-core.git](https://github.com/momentchan/three-core.git) packages/three-core
```

## Core Modules

### 1. Rendering & Performance
* **`WebGPUCanvas`**: Pre-configured canvas tailored for WebGPU.
* **`AsyncCompile`**: Prevents frame stutters by compiling shaders asynchronously.
* **`WebGpuPerf`**: Performance monitor overlay for FPS and GPU memory.

### 2. Input System
* **`InputSystem`**: Logic engine that tracks game actions (e.g., "Jump", "Move").
* **`KeyboardMapper`**: Component that maps physical keys to the `InputSystem`.

### 3. Media & Visuals
* **`AudioManager` & `Bgm`**: Centralized system for sound effects and background music.
* **`LevaWrapper`**: A UI panel for real-time debugging and variable tweaking.
* **`DistortedCircle`**: Shader-based procedural visual component.

### 4. Custom Hooks
* **`useDeviceDetection`**: Detects Mobile vs. Desktop to toggle UI like Joysticks.
* **`useKTX2Texture`**: Optimized loader for GPU-friendly compressed textures.
* **`useUploadQueue`**: Manages resource uploads to the GPU to maintain smooth FPS.

### 5. TSL Utilities
* **`math` & `color`**: Helper functions for **Three Shading Language (TSL)** to write GPU logic in JavaScript.
