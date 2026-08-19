# Aster

> **An extremely fast, open-source, AI-native motion graphics and compositing editor, built GPU-first for 2D and 3D.**

**项目类型：** 开源 AI-Native、GPU-First 动态图形与合成软件  
**项目名称：** Aster  
**方案版本：** v0.2  
**日期：** 2026-08

---

## 1. 项目愿景

Aster 的目标不是复刻 After Effects 的既有实现，而是以现代实时图形引擎的思路重新定义 Motion Graphics 与 Compositing 工作流。

Aster 将 GPU 作为主要渲染与计算设备，把 **2D、3D、视频、文字、矢量、粒子和可编程特效** 统一到同一套 Timeline、Scene Graph、Dependency Graph 与 Render Graph 中，并将 AI 设计为原生工程操作层，而不是额外附加的“AI 生成视频”按钮。

Aster 最重要的产品目标是：

> **让复杂动态图形创作尽可能接近实时。**

核心关键词：

- **AI-Native** — AI 能理解并操作整个工程。
- **GPU-First** — 渲染、合成、粒子和特效优先驻留 GPU。
- **Real-Time First** — 把预览帧率和交互延迟作为一级产品指标。
- **2D + 3D** — 统一时间轴、统一 Scene、统一 Render Graph。
- **Open Source** — 开放核心、开放项目格式、开放插件生态。
- **Programmable** — WGSL Shader、Render Graph 与 Native Plugin。
- 第一版的界面完全参考 After Effects 进行实现
- 使用最新版 Tauri 和 Vite + React 完成本项目的编写。
- 尽可能让性能做的更好。
- 初版先支持 4K 分辨率。
- 尽量控制代码行数和项目解耦拆分。

---

## 2. 一句话定位

> **An extremely fast, open-source, AI-native motion graphics and compositing editor, built GPU-first for 2D and 3D.**

更短的 GitHub Description 可使用：

> **AI-native, GPU-first motion graphics and compositing for 2D and 3D.**

核心差异化可以概括为：

> **AE 的 Timeline 与动画工作流 + 游戏引擎式实时 GPU Renderer + 统一 2D/3D 合成 + 开放可编程插件 + AI 原生工程操作。**

---

## 3. 产品原则

### 3.1 GPU-first

渲染、合成、图像效果、粒子和部分模拟优先通过 Render Shader / Compute Shader 实现。

素材进入 GPU 后，应尽可能保持 GPU resident：

```text
Decode
  ↓
GPU Texture
  ↓
Transform
  ↓
Effects
  ↓
2D / 3D Render
  ↓
Composite
  ↓
Post FX
  ↓
Display / Encode
```

避免在 CPU 与 GPU 之间反复搬运完整帧。

### 3.2 Real-time first

优先优化：

- 参数拖动时的交互延迟；
- Viewport 连续帧率；
- Dirty Node 增量重算；
- GPU pipeline latency；
- 缓存命中率；
- 显存资源复用。

最终导出速度重要，但不能以牺牲编辑体验为代价。

### 3.3 Time-addressable

Aster 不是传统游戏引擎，用户会任意拖动时间轴，因此核心对象不能只依赖：

```text
update(dt)
```

而应尽量可以通过：

```text
evaluate(time)
```

直接求值。

这会影响 Animation、Particle、Video、Expression、Cache、Undo 和并行渲染等所有系统。

### 3.4 Open by design

项目格式、插件规范、Shader API、Render Graph API 应尽可能公开并版本化。

目标是让 Aster 工程可以：

- Git diff；
- Git merge；
- 被第三方工具读取；
- 被脚本修改；
- 被 AI 修改；
- 长期迁移和兼容。

### 3.5 AI as an operator

AI 不直接拥有不可控的工程状态。

AI 应把自然语言意图转换为结构化 Operation，例如：

```text
CreateLayer
SetProperty
AddKeyframe
SetEasing
AddEffect
CreateCamera
SetParent
DuplicateLayer
CreateMask
```

所有 Operation 都应：

- 可序列化；
- 可校验；
- 可预览；
- 可撤销；
- 可重放；
- 可审计。

### 3.6 Scope discipline

Aster 是 Motion Graphics / Compositing 软件，不做完整 DCC。

建模、雕刻、UV、Retopology、复杂 Rig 等交给 Blender 等工具。

---

## 4. 目标用户

### 首要用户

- Motion Designer / MG 动画设计师；
- MV / PV / MAD / Vocaloid 视觉创作者；
- 独立视频与动态图形创作者；
- 需要程序化视觉与 GPU 特效的开发者；
- 需要快速混合 2D 素材与 3D 场景的设计师；
- 希望通过 AI 操作可编辑动态图形工程的用户。

### 典型场景

| 场景 | 目标体验 |
|---|---|
| 动态排版 | 大量文字、Shape、Keyframe、Modifier 在高分辨率下实时预览 |
| 音乐视觉 / PV | 音频响应、粒子、Glow、Displacement、文字动画与 3D Camera 混合 |
| 2.5D / 3D 合成 | 视频与图片直接进入 3D 空间并参与遮挡、DOF、Motion Blur |
| 程序化特效 | 用户通过 WGSL / Render Graph 插件编写自定义 Effect 和 Generator |
| AI 辅助创作 | 自然语言创建动画、调整缓动、修改摄像机、布置层级和效果链 |

---

## 5. 第一阶段功能范围

### 5.1 编辑器基础

- Project；
- Composition；
- Timeline；
- Layer Stack；
- Inspector；
- Viewport；
- Keyframe；
- Graph Editor；
- Asset Browser；
- Undo / Redo；
- Command Palette；
- AI Panel。

### 5.2 2D

- Image Layer；
- Video Layer；
- Text Layer；
- Vector Shape；
- Mask；
- Blend Mode；
- Parent / Child；
- Precomposition；
- 2D Transform。

### 5.3 3D

- Position / Rotation / Scale；
- Perspective Camera；
- Orthographic Camera；
- glTF / GLB；
- Mesh；
- Basic PBR Material；
- Directional Light；
- Point Light；
- Spot Light；
- Shadow；
- 2D Layer in 3D Space；
- Composition as Texture。

### 5.4 Renderer Auxiliary Buffers

3D Renderer 应按需输出：

- Color；
- Depth；
- Normal；
- Motion Vector；
- Object ID；
- Material ID；
- World Position。

这些 Buffer 可以直接驱动：

- DOF；
- Fog；
- Vector Motion Blur；
- Relight；
- Edge Detect；
- Object Mask；
- Selective Glow。

### 5.5 基础 Effect

首版不追求数量，而选择能验证架构的代表性 Effect：

- Gaussian / Kawase Blur；
- Glow / Bloom；
- Color Matrix；
- Exposure；
- Tint；
- LUT；
- Mask；
- Distort；
- Displacement；
- Blend；
- Chromatic Aberration。

### 5.6 GPU Motion

- GPU Particle；
- Cloner；
- Effector；
- Audio Reactive Property；
- Procedural Generator。

### 5.7 Video

- FFmpeg decode；
- FFmpeg encode；
- Audio decode；
- Timeline sync；
- Proxy / Cache；
- Hardware decode/encode fast path（逐平台实现）。

---

## 6. 明确不在首版做的内容

- 完整 3D 建模；
- Sculpt；
- UV Editor；
- Retopology；
- 完整 Rig Editor；
- 高级骨骼制作；
- Blender 级 Geometry Nodes；
- 完整 NLE；
- 多机位剪辑；
- 专业 DAW 级音频混音；
- 完整 Nuke 级 VFX 节点系统；
- 首版 AE Project Compatibility；
- 首版 AE Plugin Compatibility；
- 数百个内置 Effects；
- 首版 Ray Tracing / Path Tracing；
- 自研完整 3D Asset DCC Pipeline。

---

## 7. 总体技术架构

```text
Desktop UI / Editor
        │
        ▼
Timeline ─── Animation ─── Expressions / AI Ops
        │
        ▼
Scene Graph
        │
        ▼
Dependency DAG
        │
        ▼
Render Graph
 ┌──────┼─────────┬───────────┐
 ▼      ▼         ▼           ▼
2D     3D      Compute      Video
 │      │         │           │
 └──────┴─────────┴───────────┘
        │
        ▼
GPU Resource / Texture Pool
        │
        ▼
Composite / Post FX
        │
        ▼
Preview / Export
```

### 核心模块

| 模块 | 职责 |
|---|---|
| Editor / UI | Project、Timeline、Inspector、Graph Editor、Viewport、Asset Browser、AI Panel |
| Timeline Engine | 时间、Keyframe、Interpolation、Expression、Time Remap、Nested Composition |
| Scene Graph | 统一管理 2D/3D Entity、Parenting、Transform、Camera、Light |
| Dependency DAG | 属性和节点依赖、Dirty Propagation、增量重算 |
| Render Graph | Render Pass、Compute Pass、临时 Texture、同步和 Resource Lifetime |
| Asset Pipeline | Image、Video、Font、glTF、Audio、LUT 等导入与缓存 |
| Plugin Runtime | Shader Plugin、Graph Plugin、Native Plugin |
| AI Operation Layer | Natural Language → Structured Operations |

---

## 8. GPU 渲染与合成架构

真正的性能优势不来自“某几个 Effect 支持 GPU”，而来自整条 Pipeline 围绕 GPU 设计。

### 关键机制

#### GPU Resource Pool

复用 Texture / Buffer，减少频繁创建与销毁。

#### Incremental Rendering

参数改变时，只让受影响的下游节点失效。

例如：

```text
Layer 87 Position
        ↓ dirty
Transform
        ↓ dirty
Effect
        ↓ dirty
Composite
```

无关节点继续使用缓存。

#### Node Cache

缓存中间节点，而不是只缓存最终 Frame。

#### Shader / Pipeline Cache

缓存 Shader 编译结果、Bind Group Layout 与 Pipeline。

#### Shader Fusion

将安全的连续 Pixel Operations 合并，例如：

```text
Color Matrix
→ Exposure
→ Tint
→ Opacity
```

尽可能融合为一次 GPU Pass。

#### Multi-resolution Processing

对于大半径 Effect 自动使用优化路径：

- Downsample；
- Separable Blur；
- Kawase Blur；
- Dual Filtering；
- 必要时 FFT。

#### Hardware Video Fast Path

长期目标：

```text
Hardware Decode
    ↓
GPU Texture
    ↓
Render / Effects / Composite
    ↓
Hardware Encode
```

尽可能减少完整帧 CPU round-trip。

---

## 9. 2D / 3D 统一场景模型

不要把 3D 做成独立插件世界。

统一 Entity 模型可以类似：

```text
Entity
 ├─ Transform
 │   ├─ position: vec3
 │   ├─ rotation: quat
 │   └─ scale: vec3
 ├─ Renderable
 │   ├─ geometry
 │   └─ material
 ├─ TimelineBinding
 └─ Effects[]
```

以下对象都映射到 Entity + Components：

```text
Image
Video
Text
Shape
Mesh
Particle
Light
Camera
```

普通 2D 本质上可以视为：

```text
Orthographic Camera
+
固定/受控 Z Plane
```

因此 2D 元素天然可以：

- 绕 X/Y/Z 旋转；
- 接受 Perspective；
- 进入 Depth Buffer；
- 被 3D Mesh 遮挡；
- 参与 DOF；
- 输出 Motion Vector。

---

## 10. AI-Native 架构

### 10.1 核心思想

AI 不直接生成不可编辑的最终视频，而是生成和修改 **工程结构**。

```text
Natural Language / Multimodal Intent
                │
                ▼
          Planning / Agent
                │
                ▼
       Structured Operations
       ┌────────┼─────────┐
       ▼        ▼         ▼
   Timeline   Scene    Render Graph
       │        │         │
       ▼        ▼         ▼
   Keyframe   Object    Effect
                │
                ▼
        Preview → Accept / Undo
```

### 10.2 首期 AI 能力

- 创建 / 删除 / 重命名 Layer；
- 创建 Composition；
- 创建 Keyframe；
- 设置 Easing；
- 创建 Stagger；
- 创建 Loop；
- 调整 Graph Curve；
- 根据语义选择对象；
- 批量设置属性；
- 创建 Effect Chain；
- 调整 Effect 参数；
- 创建 Camera Move；
- 设置 DOF / Focus Target；
- 自动创建可编辑动画模板；
- 根据画面内容提出修改建议；
- 将复杂需求拆解成多个 Operation；
- Operation Preview；
- Accept / Reject；
- Undo / Redo。

### 10.3 AI 工程原则

- Provider agnostic；
- Model agnostic；
- Operation API 不依赖任何特定 LLM；
- AI 不直接写内部内存结构；
- AI 不绕过 Command / Undo 系统；
- Operation 必须有 Schema；
- Operation 必须有权限边界；
- 可记录 Agent action log；
- 支持 deterministic replay。

---

## 11. 插件体系

插件系统从第一版进入架构，不等到功能成熟后再补。

### Level 1 — WGSL Shader Plugin

适用于：

- Color；
- Distort；
- Blur；
- Stylize；
- Transition；
- Simple Generator。

理想插件最小结构：

```text
my-effect/
 ├─ plugin.toml
 ├─ effect.wgsl
 ├─ icon.svg
 └─ README.md
```

目标体验：

> **写一个 WGSL 文件，就可以创建一个跨平台 GPU Effect。**

### Level 2 — Render Graph Plugin

允许插件创建：

- Intermediate Texture；
- Compute Pass；
- Render Pass；
- Multi-pass Effect；
- Resource Dependency。

适用于：

- Bloom；
- DOF；
- Fluid；
- FFT；
- Complex Generator；
- Advanced Particle。

### Level 3 — Native Plugin

适用于：

- AI Model；
- Tracking；
- Optical Flow；
- Codec；
- Advanced Importer；
- Specialized Hardware Integration。

Native API 应最晚稳定，优先保证 Level 1 / Level 2 的长期兼容。

### 可开放的插件类型

- Effect；
- Generator；
- Transition；
- Render Graph Pass；
- Particle Operator；
- Effector；
- Importer；
- Exporter；
- Material；
- Shader；
- AI Tool / Operation；
- UI Panel（后期）。

---

## 12. 项目格式

建议使用开放、可版本控制的 Bundle / Directory Format。

示例：

```text
project.aster/
 ├─ project.json
 ├─ compositions/
 │   ├─ main.json
 │   └─ intro.json
 ├─ assets/
 ├─ shaders/
 ├─ metadata/
 └─ cache/          # 可重建，不进入 Git
```

### 设计目标

- 文本化核心描述；
- 稳定 UUID / Entity ID；
- Schema Version；
- Migration；
- Relative Asset Path；
- External Asset Reference；
- Packed Project；
- Command Log；
- Cache 与 Source State 分离；
- Git-friendly diff；
- Third-party readable spec。

推荐默认项目扩展名可继续研究，例如：

- `.aster` bundle；
- `.astr`；
- `.astproj`。

在正式冻结格式前不要过早承诺扩展名。

---

## 13. 推荐技术栈

| 层级 | 推荐 |
|---|---|
| Core | Rust |
| GPU | wgpu / WebGPU API model |
| Backends | Vulkan / Metal / DX12 |
| Shader | WGSL |
| Desktop | Tauri + TypeScript |
| Frontend | React / Vue 二选一 |
| Viewport | Native wgpu Surface |
| Video / Audio | FFmpeg |
| 3D Asset | glTF / GLB first |
| Text | HarfBuzz + Font Rasterization Stack |
| Serialization | Serde + JSON / readable schema |
| Plugin | WGSL + Manifest + optional Rust/C ABI |
| AI | Provider-agnostic Agent + Tool/Operation API |

### 为什么不以 CUDA 为核心

CUDA 会将核心加速路径绑定到 NVIDIA。

Aster 更适合作为跨平台桌面创作软件，因此核心应建立在 wgpu / WebGPU 模型上，再针对特定 GPU backend 做可选优化。

---

## 14. 开源与许可证

推荐：

| 组件 | 建议许可证 |
|---|---|
| Aster Desktop / Core | **MPL-2.0** |
| Aster Renderer（若独立库） | Apache-2.0 或 MPL-2.0 |
| Plugin SDK | **Apache-2.0** |
| Example Plugins | MIT / Apache-2.0 |
| Project Format Specification | Open Specification |
| 未来 Cloud / AI Server | 单独评估 |

### 为什么主程序推荐 MPL-2.0

目标是在以下两点之间取得平衡：

1. 核心修改继续回馈社区；
2. 不阻碍第三方商业插件和闭源集成。

### Dependency Governance

建立：

```text
LICENSE
NOTICE
THIRD_PARTY_LICENSES
DEPENDENCY_POLICY.md
```

特别关注 FFmpeg 的 LGPL / GPL 构建差异。

---

## 15. MVP Roadmap

### M0 — Renderer PoC

**目标：证明 GPU-first Render Graph 成立。**

验收：

- wgpu Surface；
- GPU Texture；
- Render Graph；
- Image Layer；
- Transform；
- Alpha Composite；
- 至少 3 个 GPU Effect；
- GPU profiler；
- 4K benchmark。

### M1 — Motion Core

**目标：证明 Aster 是一个真正可操作的动态图形编辑器。**

验收：

- Composition；
- Timeline；
- Keyframe；
- Easing；
- Graph Editor；
- Image；
- Text；
- Shape；
- Parenting；
- Precomp；
- Undo / Redo。

### M2 — 3D Core

**目标：证明 2D 与 3D 可以统一工作。**

验收：

- Perspective Camera；
- Mesh；
- glTF；
- PBR；
- Lights；
- Shadow；
- Depth；
- 2D Layer in 3D；
- Composition as Texture。

### M3 — Programmable FX

**目标：证明社区可以扩展 Aster，而不必修改核心源码。**

验收：

- WGSL Plugin；
- Plugin Manifest；
- Parameter Schema；
- Render Graph Plugin；
- GPU Particle；
- Example Plugins；
- Plugin Documentation。

### M4 — Video Workflow

**目标：可以完整制作和导出短片 / PV / MG 项目。**

验收：

- Video decode；
- Audio；
- Timeline sync；
- Proxy；
- Cache；
- Export；
- Hardware fast path prototype。

### M5 — AI-Native

**目标：AI 能可靠修改可编辑工程，而不是输出一次性像素。**

验收：

- Operation Schema；
- Agent Tool API；
- Natural Language → Operation；
- Multi-step Plan；
- Preview；
- Accept / Reject；
- Undo；
- Audit Log。

### M6 — Ecosystem

**目标：从软件变为真正的开源平台。**

验收：

- Stable Project Spec；
- Stable Plugin API v1；
- Documentation Site；
- Example Projects；
- Contribution Guide；
- Plugin Discovery / Registry Prototype；
- Release Pipeline。

---

## 16. 性能目标

“快”必须是可重复验证的指标，而不是宣传语。

### Performance Suite

从 M0 开始建立固定 Benchmark。

#### Benchmark A — 2D

```text
4K
20+ Layers
Text
Transform
Blur
Glow
Color
Blend
```

#### Benchmark B — 3D

```text
4K
3D Camera
10+ Meshes
PBR
Lights
Shadow
2D Layers in 3D
DOF
```

#### Benchmark C — Particle

```text
100k / 500k / 1M Particles
Compute Simulation
GPU Render
Glow
```

#### Benchmark D — Video

```text
4K Video Decode
Multiple Video Layers
Effects
Composite
Encode
```

### 记录指标

- Preview FPS；
- Total Frame Time；
- GPU Frame Time；
- CPU Frame Time；
- VRAM；
- System RAM；
- Pipeline Compile Time；
- Dirty Nodes Count；
- Cache Hit Rate；
- Decode Time；
- Render Time；
- Encode Time。

### 性能原则

- 不能因为功能增加而持续退化但无人察觉；
- 每个关键模块进入主分支前跑 benchmark；
- 重要性能回归在 CI 或 nightly benchmark 中检测；
- README / 官网只展示可复现 benchmark。

---

## 17. 建议仓库结构

```text
aster/
 ├─ apps/
 │   └─ studio/
 │
 ├─ crates/
 │   ├─ aster-core/
 │   ├─ aster-timeline/
 │   ├─ aster-scene/
 │   ├─ aster-render/
 │   ├─ aster-video/
 │   ├─ aster-text/
 │   ├─ aster-project/
 │   ├─ aster-plugin/
 │   ├─ aster-ai/
 │   └─ aster-profiler/
 │
 ├─ plugins/
 │   └─ examples/
 │
 ├─ shaders/
 ├─ benchmarks/
 ├─ examples/
 ├─ docs/
 ├─ tools/
 │
 ├─ LICENSE
 ├─ NOTICE
 ├─ THIRD_PARTY_LICENSES
 ├─ CONTRIBUTING.md
 └─ README.md
```

---

# 18. Master TODO

下面的 TODO 按实现顺序整理。首要原则是 **先证明 Renderer，再证明 Motion Editor，再证明 3D / Video / Plugin / AI**，不要并行铺开所有功能。

---

## 18.1 P0 — Repository / Engineering Foundation

- [ ] 创建 GitHub Organization / Repository。
- [ ] 确认 Aster 最终仓库 slug。
- [ ] 添加 `README.md`。
- [ ] 添加项目一句话 Description。
- [ ] 添加 `LICENSE`，主程序采用 MPL-2.0。
- [ ] 添加 `NOTICE`。
- [ ] 添加 `THIRD_PARTY_LICENSES`。
- [ ] 添加 `DEPENDENCY_POLICY.md`。
- [ ] 添加 `CONTRIBUTING.md`。
- [ ] 添加 `CODE_OF_CONDUCT.md`。
- [ ] 添加 `SECURITY.md`。
- [ ] 添加 Issue Templates。
- [ ] 添加 Pull Request Template。
- [ ] 定义 Commit / PR convention。
- [ ] 初始化 Rust workspace。
- [ ] 建立 `apps/` 与 `crates/` monorepo 结构。
- [ ] 配置 `rustfmt`。
- [ ] 配置 `clippy`。
- [ ] 配置 cargo dependency audit。
- [ ] 配置 cargo deny / license policy。
- [ ] 配置 Windows CI。
- [ ] 配置 macOS CI。
- [ ] 配置 Linux CI。
- [ ] 配置 unit test workflow。
- [ ] 配置 build artifact workflow。
- [ ] 配置 nightly benchmark workflow。
- [ ] 定义最低 Rust toolchain。
- [ ] 确定 MSRV 策略。
- [ ] 确定版本号策略。
- [ ] 确定 feature flag 策略。
- [ ] 创建 Architecture Decision Record（ADR）目录。
- [ ] 写 ADR：为什么选择 Rust。
- [ ] 写 ADR：为什么选择 wgpu。
- [ ] 写 ADR：为什么使用 WGSL。
- [ ] 写 ADR：为什么项目格式开放。
- [ ] 写 ADR：为什么采用 time-addressable evaluation。

---

## 18.2 M0 — GPU Renderer PoC

### Window / GPU Bootstrap

- [ ] 创建 `aster-render` crate。
- [ ] 初始化 wgpu Instance。
- [ ] 创建 Adapter selection strategy。
- [ ] 创建设备与 Queue。
- [ ] 创建 Window Surface。
- [ ] 处理 Surface resize。
- [ ] 处理 DPI scale。
- [ ] 支持 Windows Vulkan / DX12 backend 测试。
- [ ] 支持 macOS Metal backend 测试。
- [ ] 支持 Linux Vulkan backend 测试。
- [ ] 输出 GPU Adapter / Driver / Backend diagnostics。

### Resource Layer

- [ ] 实现 Texture wrapper。
- [ ] 实现 Buffer wrapper。
- [ ] 实现 Sampler cache。
- [ ] 实现 Bind Group cache。
- [ ] 实现 Pipeline cache。
- [ ] 实现 Shader module cache。
- [ ] 实现 GPU Resource Pool。
- [ ] 实现 transient texture allocator。
- [ ] 实现资源生命周期调试信息。
- [ ] 实现显存估算统计。

### Minimal Render Graph

- [ ] 定义 Render Graph Node。
- [ ] 定义 Resource Handle。
- [ ] 定义 Render Pass Node。
- [ ] 定义 Compute Pass Node。
- [ ] 实现 dependency edge。
- [ ] 实现 topological scheduling。
- [ ] 实现 resource lifetime analysis。
- [ ] 实现 transient resource reuse。
- [ ] 实现 graph validation。
- [ ] 实现 graph debug dump。
- [ ] 实现 graph visualization export（DOT / JSON）。

### First Rendering Pipeline

- [ ] 加载 PNG / JPEG Image。
- [ ] 上传 Image 为 GPU Texture。
- [ ] 实现 fullscreen textured quad。
- [ ] 实现 2D Transform matrix。
- [ ] 实现 Opacity。
- [ ] 实现 Alpha Composite。
- [ ] 实现多个 Image Layer Composite。
- [ ] 实现 offscreen render target。
- [ ] 实现 Composition Texture。

### Representative GPU Effects

- [x] 实现 Color Matrix。
- [x] 实现 Exposure。
- [x] 实现 Tint。
- [x] 实现 Gaussian / Separable Blur。
- [x] 实现 Kawase Blur 实验版本。
- [x] 实现 Glow / Bloom。
- [x] 实现 Chromatic Aberration。
- [x] 实现简单 Displacement。
- [x] 建立 Effect parameter uniform abstraction。
- [x] 建立 Effect pass abstraction。

### Profiling

- [ ] 创建 `aster-profiler` crate。
- [ ] 实现 CPU scope timing。
- [ ] 实现 GPU timestamp query。
- [ ] 显示 frame time。
- [ ] 显示 GPU frame time。
- [ ] 显示各 Render Graph pass timing。
- [ ] 显示 VRAM estimate。
- [ ] 显示 draw / dispatch count。
- [ ] 显示 transient texture count。

### M0 Benchmark

- [ ] 创建 1080p benchmark。
- [ ] 创建 4K benchmark。
- [ ] 创建 20-layer benchmark。
- [ ] 创建 Blur benchmark。
- [ ] 创建 Glow benchmark。
- [ ] 创建 Effect-chain benchmark。
- [ ] 保存 benchmark baseline。
- [ ] 自动输出 benchmark JSON。
- [ ] 创建 benchmark 可视化报告。

---

## 18.3 Dependency Graph / Incremental Evaluation

- [ ] 创建 Dependency Node 数据结构。
- [ ] 定义 Property dependency。
- [ ] 定义 Layer dependency。
- [ ] 定义 Effect dependency。
- [ ] 定义 Composition dependency。
- [ ] 实现 dirty flag。
- [ ] 实现 dirty propagation。
- [ ] 防止依赖环。
- [ ] 实现 dependency graph validation。
- [ ] 实现 node cache。
- [ ] 定义 cache key。
- [ ] 定义 time-dependent cache key。
- [ ] 定义 resolution-dependent cache key。
- [ ] 实现 cache invalidation。
- [ ] 实现 cache statistics。
- [ ] 显示当前重算 Node 数量。
- [ ] 创建增量渲染 benchmark。

---

## 18.4 M1 — Timeline / Motion Core

### Time Model

- [ ] 创建 `aster-timeline` crate。
- [ ] 定义 Time 类型。
- [ ] 支持 frame-based time。
- [ ] 支持 rational frame rate。
- [ ] 支持 seconds / frames 转换。
- [ ] 支持任意时间 seek。
- [ ] 定义 Composition duration。
- [ ] 定义 layer in/out point。
- [ ] 支持 time offset。
- [ ] 支持 time stretch。
- [ ] 设计 time remapping API。

### Property System

- [ ] 定义 Animatable Property。
- [ ] 支持 scalar。
- [ ] 支持 vec2 / vec3 / vec4。
- [ ] 支持 color。
- [ ] 支持 bool / enum。
- [ ] 支持 string。
- [ ] 支持 quaternion。
- [ ] 支持 static value。
- [ ] 支持 animated value。
- [ ] 支持 property binding。

### Keyframe

- [ ] 定义 Keyframe。
- [ ] 支持 Linear interpolation。
- [ ] 支持 Step interpolation。
- [ ] 支持 Bezier interpolation。
- [ ] 支持 Hold keyframe。
- [ ] 支持 easing presets。
- [ ] 支持 temporal handles。
- [ ] 支持 spatial handles。
- [ ] 支持 keyframe copy/paste。
- [ ] 支持 keyframe multi-select。
- [ ] 支持 keyframe scale / retime。

### Composition / Layer

- [ ] 创建 `aster-core` crate。
- [ ] 定义 Project。
- [ ] 定义 Composition。
- [ ] 定义 Layer。
- [ ] 定义 Layer ID / UUID。
- [ ] 实现 Layer ordering。
- [ ] 实现 visibility。
- [ ] 实现 solo。
- [ ] 实现 lock。
- [ ] 实现 parent/child hierarchy。
- [ ] 实现 2D transform。
- [ ] 实现 anchor point。
- [ ] 实现 opacity。
- [ ] 实现 nested composition。
- [ ] 实现 composition-as-texture。

### Undo / Redo / Command

- [ ] 定义 Command trait / Operation。
- [ ] 所有 UI mutation 使用 Operation。
- [ ] 实现 Undo stack。
- [ ] 实现 Redo stack。
- [ ] 支持 transaction / grouped commands。
- [ ] 支持 serialized command log。
- [ ] 支持 operation replay。
- [ ] 为 AI Operation 预留 metadata。

---

## 18.5 Editor UI

### Desktop Shell

- [ ] 创建 `apps/studio`。
- [ ] 集成 Tauri。
- [ ] 选择 React 或 Vue 并冻结首版选择。
- [ ] 建立前端状态管理方案。
- [ ] 建立 Rust ↔ UI command bridge。
- [ ] 建立 native viewport embedding。
- [ ] 支持 workspace layout。
- [ ] 支持 panel docking 基础方案。
- [ ] 支持 keyboard shortcut system。
- [ ] 支持 theme system。
- [ ] 支持 HiDPI。

### Main Panels

- [ ] Project Panel。
- [ ] Composition Viewer / Viewport。
- [ ] Timeline Panel。
- [ ] Layer Stack。
- [ ] Inspector / Properties。
- [ ] Graph Editor。
- [ ] Asset Browser。
- [x] Effects Browser。
- [ ] Console / Diagnostics。
- [ ] Profiler Overlay。
- [ ] AI Panel placeholder。

### Interaction

- [ ] Drag layer。
- [ ] Reorder layer。
- [ ] Multi-select layer。
- [ ] Scrub timeline。
- [ ] Zoom timeline。
- [ ] Pan timeline。
- [ ] Add / delete keyframe。
- [ ] Drag keyframe。
- [ ] Edit Bezier handles。
- [ ] Transform gizmo。
- [ ] Camera gizmo（M2）。
- [ ] Snap system。
- [ ] Guides / ruler。
- [ ] Viewport zoom / pan。
- [ ] Fit composition。

---

## 18.6 Text System

文本必须尽早实现，因为 CJK / Emoji / shaping 很容易成为后期架构坑。

- [ ] 创建 `aster-text` crate。
- [ ] 集成 HarfBuzz 或等价 shaping。
- [ ] 字体发现。
- [ ] Font fallback。
- [ ] Font cache。
- [ ] Glyph cache。
- [ ] Glyph atlas。
- [ ] GPU text rendering。
- [ ] Unicode shaping。
- [ ] Latin script。
- [ ] CJK shaping。
- [ ] Emoji fallback。
- [ ] Ligature。
- [ ] Kerning。
- [ ] Line breaking。
- [ ] Multi-line layout。
- [ ] Alignment。
- [ ] Tracking。
- [ ] Leading。
- [ ] Baseline。
- [ ] Stroke / Fill。
- [ ] Text on GPU texture。
- [ ] 研究竖排文字。
- [ ] 研究 variable fonts。
- [ ] 研究 per-character animation 数据模型。
- [ ] 实现最小 Text Animator。

---

## 18.7 Vector Shape System

- [ ] 定义 Shape Layer。
- [ ] Rectangle。
- [ ] Ellipse。
- [ ] Line。
- [ ] Bezier Path。
- [ ] Fill。
- [ ] Stroke。
- [ ] Stroke width。
- [ ] Join / Cap。
- [ ] Dash。
- [ ] Gradient fill。
- [ ] Path tessellation。
- [ ] GPU path rendering strategy。
- [ ] Mask path reuse。
- [ ] Shape grouping。
- [ ] Shape transform stack。
- [ ] Trim Paths（后续 M1+）。
- [ ] Repeater / procedural duplication（可移至 M3）。

---

## 18.8 M2 — Unified 3D

### Scene

- [ ] 创建 `aster-scene` crate。
- [ ] Entity / Component model。
- [ ] Vec3 Transform。
- [ ] Quaternion rotation。
- [ ] Parent hierarchy in 3D。
- [ ] World matrix evaluation。
- [ ] Orthographic Camera。
- [ ] Perspective Camera。
- [ ] Camera animation。

### Mesh / Asset

- [ ] glTF loader。
- [ ] GLB loader。
- [ ] Mesh buffers。
- [ ] Vertex attributes。
- [ ] Index buffers。
- [ ] Normal。
- [ ] Tangent。
- [ ] UV。
- [ ] Texture loading。
- [ ] Material mapping。

### PBR

- [ ] Base Color。
- [ ] Metallic。
- [ ] Roughness。
- [ ] Normal Map。
- [ ] Emissive。
- [ ] Alpha mode。
- [ ] Environment lighting prototype。
- [ ] HDR environment support。

### Lighting

- [ ] Directional Light。
- [ ] Point Light。
- [ ] Spot Light。
- [ ] Light animation。
- [ ] Shadow map。
- [ ] Cascaded shadow research。
- [ ] Shadow quality settings。

### GBuffer / Auxiliary Buffers

- [ ] Color。
- [ ] Depth。
- [ ] Normal。
- [ ] Object ID。
- [ ] Material ID。
- [ ] Motion Vector。
- [ ] World Position optional path。
- [ ] Buffer visualization debug mode。

### 2D + 3D Composition

- [ ] Image Layer in 3D space。
- [ ] Text Layer in 3D space。
- [ ] Video Layer in 3D space。
- [ ] Composition as 3D texture。
- [ ] Correct depth occlusion。
- [ ] 2D overlay mode。
- [ ] 3D render → post effect → final composite。
- [ ] Object-ID selective effect。
- [ ] Depth-based fog。
- [ ] Depth-of-field prototype。
- [ ] Vector motion blur prototype。

---

## 18.9 GPU Particle / Procedural Motion

- [ ] Particle storage buffer。
- [ ] Compute update pass。
- [ ] Particle spawn system。
- [ ] Lifetime。
- [ ] Position / Velocity。
- [ ] Acceleration。
- [ ] Color over life。
- [ ] Size over life。
- [ ] Rotation over life。
- [ ] GPU random source。
- [ ] Billboard rendering。
- [ ] Mesh particle rendering。
- [ ] Indirect draw research / implementation。
- [ ] 100k particle benchmark。
- [ ] 500k particle benchmark。
- [ ] 1M particle benchmark。
- [ ] Particle cache / deterministic seed。
- [ ] Arbitrary-time evaluation strategy。
- [ ] Checkpoint-based seek strategy。
- [ ] Cloner abstraction。
- [ ] Grid cloner。
- [ ] Radial cloner。
- [ ] Random effector。
- [ ] Position effector。
- [ ] Scale effector。
- [ ] Rotation effector。
- [ ] Audio-reactive effector。

---

## 18.10 M3 — Plugin System

### Plugin Foundation

- [ ] 创建 `aster-plugin` crate。
- [ ] 定义 Plugin Manifest schema。
- [ ] 定义 plugin ID。
- [ ] 定义 semantic version。
- [ ] 定义 Aster API version。
- [ ] 定义 capability / permission。
- [ ] 实现 plugin discovery。
- [ ] 实现 plugin loading。
- [ ] 实现 plugin error reporting。
- [ ] 实现 plugin disable / safe mode。

### WGSL Plugin

- [ ] 定义 Effect shader ABI。
- [ ] 定义 texture inputs。
- [ ] 定义 output。
- [ ] 定义 numeric parameter schema。
- [ ] 定义 color parameter。
- [ ] 定义 enum parameter。
- [ ] 定义 texture parameter。
- [ ] 自动生成 Inspector UI。
- [ ] Shader compile error UI。
- [ ] Hot reload shader。
- [ ] Example: Tint。
- [ ] Example: Chromatic Aberration。
- [ ] Example: CRT / Stylize。

### Render Graph Plugin

- [ ] 定义 graph plugin API。
- [ ] 允许 temporary texture。
- [ ] 允许 compute pass。
- [ ] 允许 render pass。
- [ ] 允许 multi-pass dependency。
- [ ] Graph validation sandbox。
- [ ] Resource quota / safety research。
- [ ] Example: Bloom。
- [ ] Example: Multi-pass Blur。

### Native Plugin

- [ ] 设计 C ABI 草案。
- [ ] 设计 Rust plugin API 草案。
- [ ] 明确 ABI stability policy。
- [ ] 明确 crash isolation policy。
- [ ] 明确 unsafe capability policy。
- [ ] 首版暂不承诺稳定 ABI。

---

## 18.11 M4 — Video / Audio Workflow

### Video

- [ ] 创建 `aster-video` crate。
- [ ] FFmpeg integration。
- [ ] Container probe。
- [ ] Video stream selection。
- [ ] Decode frame。
- [ ] Timestamp handling。
- [ ] Frame-rate handling。
- [ ] Variable frame rate strategy。
- [ ] Seek。
- [ ] Decode cache。
- [ ] Frame cache。
- [ ] Video layer → GPU texture。
- [ ] Color space metadata。
- [ ] Alpha video support research。

### Audio

- [ ] Audio stream decode。
- [ ] Timeline audio clock。
- [ ] Waveform generation。
- [ ] Audio preview playback。
- [ ] AV sync。
- [ ] Audio mute / gain。
- [ ] Audio analysis API。
- [ ] FFT / spectrum data for animation。

### Proxy / Cache

- [ ] Proxy metadata model。
- [ ] Proxy generation command。
- [ ] Disk cache directory。
- [ ] Cache eviction policy。
- [ ] Cache size setting。
- [ ] Cache diagnostics。

### Export

- [x] Render frame sequence。
- [x] PNG sequence export。
- [ ] EXR research / support。
- [ ] H.264 export。
- [ ] H.265 optional path。
- [ ] ProRes platform strategy research。
- [ ] Audio muxing。
- [x] Export progress。
- [x] Cancel export。
- [ ] Background export architecture research。

### Hardware Fast Path

- [ ] Windows hardware decode research。
- [ ] macOS VideoToolbox decode research。
- [ ] Linux VAAPI decode research。
- [ ] GPU interop capability matrix。
- [ ] Zero/low-copy prototype。
- [ ] Hardware encode prototype。

---

## 18.12 Color Management

- [ ] 定义 internal working color model。
- [ ] Linear-light compositing。
- [ ] sRGB import/export。
- [ ] Display transform。
- [ ] LUT support。
- [ ] ICC / OCIO strategy research。
- [ ] HDR roadmap。
- [ ] 16-bit / float pipeline strategy。
- [ ] Texture format policy。
- [ ] Premultiplied alpha policy。
- [ ] Color-management test suite。

---

## 18.13 M5 — AI-Native

### Operation API

- [ ] 创建 `aster-ai` crate。
- [ ] 列出全部可供 AI 调用的基础 Operation。
- [ ] 定义 JSON Schema。
- [ ] 定义 parameter validation。
- [ ] 定义 operation permission。
- [ ] 定义 operation result。
- [ ] 定义 error schema。
- [ ] 定义 dry-run / preview 模式。
- [ ] 定义 operation transaction。
- [ ] 定义 rollback。
- [ ] 定义 audit log。

### AI Tooling

- [ ] Provider abstraction。
- [ ] Tool calling abstraction。
- [ ] Context builder。
- [ ] Project summary API。
- [ ] Layer query API。
- [ ] Property query API。
- [ ] Timeline query API。
- [ ] Scene query API。
- [ ] Effect query API。
- [ ] Asset query API。
- [ ] Selection-aware context。

### Natural Language Workflows

- [ ] “创建文字图层”。
- [ ] “让文字从下面弹入”。
- [ ] “每个字延迟 0.08 秒”。
- [ ] “减少弹性”。
- [ ] “给背景加 Glow”。
- [ ] “让 Camera 缓慢推近”。
- [ ] “人物保持清晰，背景增加景深”。
- [ ] “复制这组 Layer 并改成左右交替进入”。
- [ ] 多步骤 Planning。
- [ ] 失败自动解释而不是静默修改。

### AI Safety / UX

- [ ] Preview changes。
- [ ] Diff changes。
- [ ] Accept all。
- [ ] Accept selected。
- [ ] Reject。
- [ ] Undo AI transaction。
- [ ] 显示 AI 修改了哪些对象。
- [ ] 阻止模型访问未授权本地文件。
- [ ] 明确网络 Provider 数据边界。
- [ ] Local model provider interface。

---

## 18.14 Project Format / Persistence

- [ ] 创建 `aster-project` crate。
- [ ] 定义 Project Schema v0。
- [ ] 定义 Composition Schema。
- [ ] 定义 Layer Schema。
- [ ] 定义 Property Schema。
- [ ] 定义 Keyframe Schema。
- [ ] 定义 Effect Schema。
- [ ] 定义 Asset Schema。
- [ ] 定义 Plugin dependency Schema。
- [ ] 定义 Stable UUID。
- [ ] 实现 project save。
- [ ] 实现 project load。
- [ ] 实现 atomic save。
- [ ] 实现 autosave。
- [ ] 实现 crash recovery。
- [ ] 实现 relative asset paths。
- [ ] 实现 missing asset relink。
- [ ] 实现 packed project。
- [ ] 实现 schema validation。
- [ ] 实现 migration framework。
- [ ] 实现 migration test fixtures。
- [ ] 将 cache 与 source project 分离。
- [ ] 发布 Project Format draft specification。

---

## 18.15 Performance / Optimization Backlog

- [ ] Render Graph resource aliasing。
- [ ] Pipeline prewarming。
- [ ] Async shader compilation strategy。
- [ ] Shader fusion prototype。
- [ ] Effect fusion eligibility analysis。
- [ ] Dynamic resolution preview。
- [ ] Preview quality levels。
- [ ] Tile processing research for huge compositions。
- [ ] Multi-threaded CPU scheduling。
- [ ] Parallel asset decode。
- [ ] Async disk IO。
- [ ] Texture upload batching。
- [ ] Persistent staging buffers。
- [ ] GPU culling for 3D / particles。
- [ ] Indirect drawing。
- [ ] Bindless/resource-array strategy research。
- [ ] Memory budget manager。
- [ ] VRAM pressure handling。
- [ ] LRU GPU cache。
- [ ] Disk cache benchmark。
- [ ] Temporal cache design。
- [ ] Multi-frame render export strategy。
- [ ] CPU fallback strategy for unsupported GPU features。
- [ ] Performance regression dashboard。

---

## 18.16 Testing / QA

### Core Tests

- [ ] Unit tests for Time。
- [ ] Unit tests for Keyframe interpolation。
- [ ] Unit tests for Dependency DAG。
- [ ] Unit tests for Project serialization。
- [ ] Unit tests for Operation / Undo。
- [ ] Unit tests for Plugin manifest。

### Rendering Tests

- [ ] Golden image tests。
- [ ] GPU backend comparison tests。
- [ ] Alpha compositing tests。
- [ ] Color tests。
- [ ] Blur tests。
- [ ] Text rendering tests。
- [ ] 3D depth tests。
- [ ] Motion vector tests。

### Project Compatibility

- [ ] Save/load roundtrip test。
- [ ] Migration test。
- [ ] Missing plugin test。
- [ ] Missing asset test。
- [ ] Corrupted project recovery test。

### Platform QA

- [ ] Windows NVIDIA matrix。
- [ ] Windows AMD matrix。
- [ ] Windows Intel matrix。
- [ ] macOS Apple Silicon matrix。
- [ ] Linux NVIDIA matrix。
- [ ] Linux AMD matrix。
- [ ] High-DPI test。
- [ ] Multi-monitor test。

---

## 18.17 Documentation / Community

- [ ] README hero section。
- [ ] Architecture overview。
- [ ] Build from source guide。
- [ ] Contribution guide。
- [ ] Plugin tutorial。
- [ ] WGSL Effect tutorial。
- [ ] Render Graph tutorial。
- [ ] Project Format spec。
- [ ] AI Operation API docs。
- [ ] Benchmark methodology docs。
- [ ] Roadmap page。
- [ ] Good First Issues。
- [ ] Example project repository。
- [ ] Example shader repository。
- [ ] Contributor recognition policy。
- [ ] Release notes template。

---

## 18.18 M6 — Distribution / Ecosystem

- [ ] Windows installer。
- [ ] macOS package。
- [ ] Linux AppImage / Flatpak strategy。
- [ ] Auto-update strategy。
- [ ] Crash reporting opt-in design。
- [ ] Plugin directory convention。
- [ ] Plugin search UI。
- [ ] Plugin install UI。
- [ ] Plugin update UI。
- [ ] Plugin signature / trust research。
- [ ] Plugin Registry prototype。
- [ ] Example plugin CI template。
- [ ] Stable Plugin API v1 criteria。
- [ ] Stable Project Spec v1 criteria。
- [ ] Semantic version compatibility rules。

---

## 18.19 First Public Demo

首个公开 Demo 应避免只是展示一个简单方块，而要直接证明 Aster 的核心优势。

建议场景：

```text
4K Composition
+
Dynamic Typography
+
Video Texture
+
3D Camera
+
glTF Model
+
100k GPU Particles
+
Glow
+
Blur
+
Color Grading
```

界面实时显示：

- [ ] FPS。
- [ ] Total Frame Time。
- [ ] GPU Frame Time。
- [ ] CPU Frame Time。
- [ ] VRAM。
- [ ] Dirty / Recomputed Node Count。
- [ ] Particle Count。
- [ ] Render Graph Pass Count。

Demo 发布准备：

- [ ] 制作 benchmark project。
- [ ] 固定测试硬件配置。
- [ ] 记录 Aster performance。
- [ ] 选择合理竞品对照方式。
- [ ] 保证测试条件公平可复现。
- [ ] 录制实时交互视频。
- [ ] README 添加 Demo GIF / Video。
- [ ] 发布 benchmark methodology。

---

## 18.20 Future / Post-v1 Backlog

以下内容暂不进入 MVP，但架构应尽量避免堵死：

- [ ] Advanced Motion Blur。
- [ ] Optical Flow。
- [ ] Frame Interpolation。
- [ ] Advanced Tracking。
- [ ] Planar Tracking。
- [ ] Camera Tracking。
- [ ] Rotoscoping。
- [ ] Advanced Mask tools。
- [ ] Advanced Color Grading。
- [ ] OCIO pipeline。
- [ ] HDR mastering。
- [ ] USD import。
- [ ] FBX importer plugin。
- [ ] Skeletal animation。
- [ ] Morph target。
- [ ] Physics integration。
- [ ] Fluid simulation。
- [ ] Volumetric rendering。
- [ ] Ray tracing optional renderer。
- [ ] Path tracing optional renderer。
- [ ] Collaborative editing。
- [ ] Project sync。
- [ ] Remote render worker。
- [ ] Render farm protocol。
- [ ] Plugin marketplace / registry maturity。
- [ ] Template ecosystem。
- [ ] Asset library integration。
- [ ] Scripting API。
- [ ] Headless rendering CLI。
- [ ] Web-based project viewer。
- [ ] Mobile / tablet companion workflow。

---

# 19. 建议最先创建的 GitHub Issues

如果今天开始编码，第一批 Issue 建议严格控制为：

1. [ ] **Initialize Rust workspace, CI, licensing and contribution docs**
2. [ ] **Create wgpu window/surface and render first texture**
3. [ ] **Implement minimal Render Graph**
4. [ ] **Add GPU timestamp profiler**
5. [ ] **Implement Image Layer + 2D Transform + Alpha Composite**
6. [ ] **Implement Timeline Clock and time-addressable evaluation**
7. [ ] **Implement Keyframe + Linear/Bezier Easing**
8. [ ] **Implement Dependency DAG + Dirty Propagation**
9. [ ] **Implement intermediate Node Cache**
10. [ ] **Add Color Matrix WGSL Effect**
11. [ ] **Add Blur WGSL Effect**
12. [ ] **Add Glow/Bloom WGSL Effect**
13. [ ] **Create 1080p and 4K performance benchmark**
14. [ ] **Create minimal Editor UI with Viewport + Timeline + Inspector**
15. [ ] **Only after the above: start Text / Shape / Video / 3D work**

---

# 20. Definition of Success

Aster 的第一阶段成功标准不是“拥有多少 AE 功能”，而是证明以下假设：

- [ ] 复杂 2D Motion 可以通过统一 GPU pipeline 实时预览；
- [ ] Timeline 可以任意 seek，而不会被游戏式帧状态模型绑死；
- [ ] Dirty Propagation 能显著减少不必要的重算；
- [ ] 2D 与 3D 可以共享同一套 Scene / Render Graph；
- [ ] WGSL Plugin 可以低成本扩展效果；
- [ ] 工程文件是开放、稳定、可版本控制的；
- [ ] AI 能通过结构化 API 修改工程并完整 Undo；
- [ ] Aster 在公开、可复现 Benchmark 中体现出明显的实时性能优势。

如果这些成立，后续功能数量可以逐步由核心团队和社区扩展。

---

# 21. 项目原则总结

Aster 不应成为：

> **“一个免费的 After Effects 克隆。”**

更理想的方向是：

> **一个以实时 GPU 图形引擎为基础、原生理解 2D/3D、可被程序与 AI 操作、并拥有开放插件生态的下一代 Motion Graphics & Compositing 平台。**

开发优先级始终保持：

```text
Architecture
    ↓
Performance
    ↓
Editing Experience
    ↓
Programmability
    ↓
AI-native Workflow
    ↓
Feature Breadth
```

**先证明架构和速度，再扩展功能。**
