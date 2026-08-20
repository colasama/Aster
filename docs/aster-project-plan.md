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
- [x] 添加 `README.md`。
- [ ] 添加项目一句话 Description。
- [x] 添加 `LICENSE`，主程序采用 MPL-2.0。
- [x] 添加 `NOTICE`。
- [x] 添加 `THIRD_PARTY_LICENSES`。
- [x] 添加 `DEPENDENCY_POLICY.md`。
- [x] 添加 `CONTRIBUTING.md`。
- [x] 添加 `CODE_OF_CONDUCT.md`。
- [x] 添加 `SECURITY.md`。
- [x] 添加 Issue Templates。
- [x] 添加 Pull Request Template。
- [x] 定义 Commit / PR convention。
- [x] 初始化 Rust workspace。
- [ ] 建立 `apps/` 与 `crates/` monorepo 结构。
- [x] 配置 `rustfmt`。
- [x] 配置 `clippy`。
- [x] 配置 cargo dependency audit。
- [x] 配置 cargo deny / license policy。
- [x] 配置 Windows CI。
- [x] 配置 macOS CI。
- [x] 配置 Linux CI。
- [x] 配置 unit test workflow。
- [ ] 配置 build artifact workflow。
- [x] 配置 nightly benchmark workflow。
- [x] 定义最低 Rust toolchain。
- [x] 确定 MSRV 策略。
- [x] 确定版本号策略。
- [ ] 确定 feature flag 策略。
- [x] 创建 Architecture Decision Record（ADR）目录。
- [x] 写 ADR：为什么选择 Rust。
- [x] 写 ADR：为什么选择 wgpu。
- [x] 写 ADR：为什么使用 WGSL。
- [x] 写 ADR：为什么项目格式开放。
- [x] 写 ADR：为什么采用 time-addressable evaluation。

---

## 18.2 M0 — GPU Renderer PoC

### Window / GPU Bootstrap

- [x] 创建 `aster-render` crate。
- [x] 初始化 wgpu Instance。
- [x] 创建 Adapter selection strategy。
- [x] 创建设备与 Queue。
- [x] 创建 Window Surface。
- [x] 处理 Surface resize。
- [x] 处理 DPI scale。
- [ ] 支持 Windows Vulkan / DX12 backend 测试。
- [ ] 支持 macOS Metal backend 测试。
- [ ] 支持 Linux Vulkan backend 测试。
- [x] 输出 GPU Adapter / Driver / Backend diagnostics。

### Resource Layer

- [ ] 实现 Texture wrapper。
- [ ] 实现 Buffer wrapper。
- [x] 实现 Sampler cache。
- [x] 实现 Bind Group cache。
- [x] 实现 Pipeline cache。
- [x] 实现 Shader module cache。
- [x] 实现 GPU Resource Pool。
- [x] 实现 transient texture allocator。
- [x] 实现资源生命周期调试信息。
- [x] 实现显存估算统计。

### Minimal Render Graph

- [x] 定义 Render Graph Node。
- [x] 定义 Resource Handle。
- [x] 定义 Render Pass Node。
- [x] 定义 Compute Pass Node。
- [x] 实现 dependency edge。
- [x] 实现 topological scheduling。
- [x] 实现 resource lifetime analysis。
- [x] 实现 transient resource reuse。
- [x] 实现 graph validation。
- [x] 实现 graph debug dump。
- [x] 实现 graph visualization export（DOT / JSON）。

### First Rendering Pipeline

- [x] 加载 PNG / JPEG Image。
- [x] 上传 Image 为 GPU Texture。
- [x] 实现 fullscreen textured quad。
- [x] 实现 2D Transform matrix。
- [x] 实现 Opacity。
- [x] 实现 Alpha Composite。
- [x] 实现多个 Image Layer Composite。
- [x] 实现 offscreen render target。
- [x] 实现 Composition Texture。

### Representative GPU Effects

- [x] 实现 Color Matrix。
- [x] 实现 Exposure。
- [x] 实现 Tint。
- [x] 实现 Gaussian / Separable Blur。
- [x] 实现 Kawase Blur 实验版本。
- [x] 实现 Glow / Bloom。
- [x] 实现 Chromatic Aberration。
- [x] 实现简单 Displacement。
- [x] 实现 CC Ball Action / CC HexTile。
- [x] 实现 Beam / Radio Waves / Advanced Lightning。
- [x] 实现 Circle / CC Star Burst。
- [x] 实现 Polar Coordinates。
- [x] 实现 Offset / Magnify / Ripple / Corner Pin。
- [x] 实现 Lens Flare / Cell Pattern。
- [x] 实现 CC Rainfall / CC Snowfall。
- [x] 提供 40 套带色板预览、单事务撤销的 Looks 调色链。
- [x] 实现 Block Dissolve / Iris Wipe / Barn Doors / Gradient Wipe。
- [x] 实现 CC Burn Film / Strobe Light / Scatter / Brush Strokes。
- [x] 实现 Photo Filter / Selective Color / Shadow-Highlight / Gamma-Pedestal-Gain。
- [x] 实现 HDR Compander / Broadcast Colors / White Balance / Color Emboss。
- [x] 建立 Effect parameter uniform abstraction。
- [x] 建立 Effect pass abstraction。

### Profiling

- [x] 创建 `aster-profiler` crate。
- [x] 实现 CPU scope timing。
- [x] 实现 GPU timestamp query。
- [x] 显示 frame time。
- [x] 显示 GPU frame time。
- [x] 显示各 Render Graph pass timing。
- [x] 显示 VRAM estimate。
- [x] 显示 draw / dispatch count。
- [x] 显示 transient texture count。

### M0 Benchmark

- [x] 创建 1080p benchmark。
- [x] 创建 4K benchmark。
- [x] 创建 20-layer benchmark。
- [x] 创建 Blur benchmark。
- [x] 创建 Glow benchmark。
- [x] 创建 Effect-chain benchmark。
- [x] 保存 benchmark baseline。
- [x] 自动输出 benchmark JSON。
- [x] 创建 benchmark 可视化报告。

---

## 18.3 Dependency Graph / Incremental Evaluation

- [x] 创建 Dependency Node 数据结构。
- [x] 定义 Property dependency。
- [x] 定义 Layer dependency。
- [x] 定义 Effect dependency。
- [x] 定义 Composition dependency。
- [x] 实现 dirty flag。
- [x] 实现 dirty propagation。
- [x] 防止依赖环。
- [x] 实现 dependency graph validation。
- [x] 实现 node cache。
- [x] 定义 cache key。
- [x] 定义 time-dependent cache key。
- [x] 定义 resolution-dependent cache key。
- [x] 实现 cache invalidation。
- [x] 实现 cache statistics。
- [x] 显示当前重算 Node 数量。
- [x] 创建增量渲染 benchmark。

---

## 18.4 M1 — Timeline / Motion Core

### Time Model

- [x] 创建 `aster-timeline` crate。
- [x] 定义 Time 类型。
- [x] 支持 frame-based time。
- [x] 支持 rational frame rate。
- [x] 支持 seconds / frames 转换。
- [x] 支持任意时间 seek。
- [x] 定义 Composition duration。
- [x] 定义 layer in/out point。
- [x] 支持 time offset。
- [x] 支持 time stretch。
- [x] 设计 time remapping API。

### Property System

- [x] 定义 Animatable Property。
- [x] 支持 scalar。
- [x] 支持 vec2 / vec3 / vec4。
- [x] 支持 color。
- [x] 支持 bool / enum。
- [ ] 支持 string。
- [ ] 支持 quaternion。
- [x] 支持 static value。
- [x] 支持 animated value。
- [x] 支持 property binding。

### Keyframe

- [x] 定义 Keyframe。
- [x] 支持 Linear interpolation。
- [x] 支持 Step interpolation。
- [x] 支持 Bezier interpolation。
- [x] 支持 Hold keyframe。
- [x] 支持 easing presets。
- [x] 支持 temporal handles。
- [ ] 支持 spatial handles。
- [x] 支持 keyframe copy/paste。
- [x] 支持 keyframe multi-select。
- [x] 支持 keyframe scale / retime。

### Composition / Layer

- [x] 创建 `aster-core` crate。
- [x] 定义 Project。
- [x] 定义 Composition。
- [x] 定义 Layer。
- [x] 定义 Layer ID / UUID。
- [x] 实现 Layer ordering。
- [x] 实现 visibility。
- [x] 实现 solo。
- [x] 实现 lock。
- [x] 实现 parent/child hierarchy。
- [x] 实现 2D transform。
- [x] 实现 anchor point。
- [x] 实现 opacity。
- [x] 实现 nested composition。
- [x] 实现 composition-as-texture。

### Undo / Redo / Command

- [x] 定义 Command trait / Operation。
- [x] 所有 UI mutation 使用 Operation。
- [x] 实现 Undo stack。
- [x] 实现 Redo stack。
- [x] 支持 transaction / grouped commands。
- [x] 支持 serialized command log。
- [x] 支持 operation replay。
- [x] 为 AI Operation 预留 metadata。

---

## 18.5 Editor UI

### Desktop Shell

- [ ] 创建 `apps/studio`。
- [x] 集成 Tauri。
- [x] 选择 React 或 Vue 并冻结首版选择。
- [x] 建立前端状态管理方案。
- [x] 建立 Rust ↔ UI command bridge。
- [x] 建立 native viewport embedding。
- [x] 支持 workspace layout。
- [x] 支持 panel docking 基础方案。
- [x] 支持 keyboard shortcut system。
- [x] 支持 theme system。
- [x] 支持 HiDPI。

### Main Panels

- [x] Project Panel。
- [x] Composition Viewer / Viewport。
- [x] Timeline Panel。
- [x] Layer Stack。
- [x] Inspector / Properties。
- [x] Graph Editor。
- [x] Asset Browser。
- [x] Effects Browser。
- [x] Effects Browser 收藏与最近使用持久化。
- [x] 自定义 Effect Chain 预设保存、持久化、应用、删除与单步撤销。
- [x] 40 套内置 Looks（调色、胶片、夜景、VHS、印刷、故障、沉浸与风格化链）。
- [x] Effect Chain 顺序化执行、Inspector 重排与撤销。
- [x] Effect 局部椭圆 / 矩形 Mask、羽化、不透明度、反转与工程持久化。
- [x] GPU Channel / Keying 工具（Set Channels、Color Range、Matte Choker、Keylight 等）。
- [x] GPU Channel / Matte Utility（Shift / Combine、Solid Composite、Pre/Unpremultiply、Luma Matte、HDR Clamp）。
- [x] GPU 高级 Blur / Sharpen 工具（Channel、Compound、Vector、Radial、High Pass 等）。
- [x] GPU Detail Processing（Upscale、Flicker Reduction、Deband、Denoise、Clarity、Local Contrast、Smart Sharpen、Frequency Separation）。
- [x] GPU Perspective / UV Warp 工具（Sphere、Cylinder、Bend、Mesh、Page Turn 等）。
- [x] GPU Advanced Distort（Bezier、Flo Motion、Griddler、Power Pin、Ripple Pulse、Slant、Smear、Split）。
- [x] GPU Layer Styles（Glow、Stroke、Inner Shadow、Bevel、Satin、Overlay）。
- [x] GPU Noise & Grain（Add / Remove Grain、Median、HLS / Alpha Noise、Turbulence）。
- [x] GPU Retro Media（Scanlines、Tape Dropout、Head Switching、Compression、Film Damage、Gate Weave、Phosphor、Pixel Sort）。
- [x] GPU Advanced Transitions（Clock、Grid、Jaws、Light、Scale、Twister、Card Wipe）。
- [x] GPU Procedural Simulation（Bubbles、Drizzle、Hair、Mercury、Particles、Pixel Polly）。
- [x] GPU Immersive Video（Rotate / Plane to Sphere、Chromatic、Glitch、Gradient、Glow、Blur、Fractal Noise）。
- [x] GPU Advanced Stylize（Halftone、Glowing Edges、Texture、Toner、Plastic、Blobbylize）。
- [x] GPU Matte Refine（Hard / Soft、Feather、Cleanup、Decontaminate、Light Wrap）。
- [x] GPU Keying Cleanup（Key Cleaner、Screen / Core Matte、Despot、Edge Extend / Blend、Spill Killer、Wire Removal）。
- [x] GPU HDR Lighting（Rays、Spotlight、Light Leak、Flare、Fog、Caustics、Laser）。
- [x] GPU Draw / Generate（Ellipse、Stroke、Vegas、Scribble、Write-on、Eyedropper Fill、Paint Bucket）。
- [x] GPU QC Overlays（Zebra、Gamut Warning、Focus Peaking、Alpha Boundary）。
- [x] GPU Framing（Crop、Letterbox、Edge Feather、Overscan）。
- [x] GPU 专业调色（ASC CDL、RGB Lift / Gamma / Gain、Log Wheels、HSL Secondary、Highlight Recovery、Gamut Compressor、False Color、Film Print Density）。
- [x] GPU Selective Color Pipeline（Printer Lights、Hue / Luma Curves、Shadow / Highlight、Tone Map、Skin Refine）。
- [x] Console / Diagnostics。
- [x] Profiler Overlay。
- [x] AI Panel placeholder。

### Interaction

- [x] Drag layer。
- [x] Reorder layer。
- [x] Multi-select layer。
- [x] Scrub timeline。
- [x] Zoom timeline。
- [x] Pan timeline。
- [x] Add / delete keyframe。
- [x] Drag keyframe。
- [x] 在 Timeline 展示 Effect parameter track，并支持拖拽重定时与删除。
- [x] Edit Bezier handles。
- [x] Transform gizmo。
- [x] Camera gizmo（M2）。
- [x] Snap system。
- [x] Guides / ruler。
- [x] Viewport zoom / pan。
- [x] Fit composition。

---

## 18.6 Text System

文本必须尽早实现，因为 CJK / Emoji / shaping 很容易成为后期架构坑。

- [ ] 创建 `aster-text` crate。
- [x] 集成 HarfBuzz 或等价 shaping。
- [ ] 字体发现。
- [x] Font fallback。
- [ ] Font cache。
- [ ] Glyph cache。
- [ ] Glyph atlas。
- [x] GPU text rendering。
- [x] Unicode shaping。
- [x] Latin script。
- [x] CJK shaping。
- [x] Emoji fallback。
- [x] Ligature。
- [x] Kerning。
- [x] Line breaking。
- [x] Multi-line layout。
- [x] Alignment。
- [x] Tracking。
- [x] Leading。
- [x] Baseline。
- [x] Stroke / Fill。
- [x] Text on GPU texture。
- [ ] 研究竖排文字。
- [ ] 研究 variable fonts。
- [ ] 研究 per-character animation 数据模型。
- [ ] 实现最小 Text Animator。

---

## 18.7 Vector Shape System

- [x] 定义 Shape Layer。
- [x] Rectangle。
- [x] Ellipse。
- [x] Line。
- [x] Bezier Path。
- [x] Fill。
- [x] Stroke。
- [x] Stroke width。
- [x] Join / Cap。
- [x] Dash。
- [x] Gradient fill。
- [x] Path tessellation。
- [x] GPU path rendering strategy。
- [ ] Mask path reuse。
- [ ] Shape grouping。
- [x] Shape transform stack。
- [ ] Trim Paths（后续 M1+）。
- [ ] Repeater / procedural duplication（可移至 M3）。

---

## 18.8 M2 — Unified 3D

### Scene

- [x] 创建 `aster-scene` crate。
- [x] Entity / Component model。
- [x] Vec3 Transform。
- [x] Quaternion rotation。
- [x] Parent hierarchy in 3D。
- [x] World matrix evaluation。
- [x] Orthographic Camera。
- [x] Perspective Camera。
- [x] Camera animation。

### Mesh / Asset

- [x] glTF loader。
- [x] GLB loader。
- [x] Mesh buffers。
- [x] Vertex attributes。
- [x] Index buffers。
- [x] Normal。
- [ ] Tangent。
- [x] UV。
- [ ] Texture loading。
- [x] Material mapping。

### PBR

- [x] Base Color。
- [x] Metallic。
- [x] Roughness。
- [ ] Normal Map。
- [x] Emissive。
- [x] Alpha mode。
- [ ] Environment lighting prototype。
- [ ] HDR environment support。

### Lighting

- [x] Directional Light。
- [x] Point Light。
- [x] Spot Light。
- [x] Light animation。
- [x] Shadow map。
- [ ] Cascaded shadow research。
- [x] Shadow quality settings。

### GBuffer / Auxiliary Buffers

- [x] Color。
- [x] Depth。
- [ ] Normal。
- [ ] Object ID。
- [ ] Material ID。
- [ ] Motion Vector。
- [ ] World Position optional path。
- [ ] Buffer visualization debug mode。

### 2D + 3D Composition

- [x] Image Layer in 3D space。
- [x] Text Layer in 3D space。
- [x] Video Layer in 3D space。
- [ ] Composition as 3D texture。
- [x] Correct depth occlusion。
- [x] 2D overlay mode。
- [x] 3D render → post effect → final composite。
- [ ] Object-ID selective effect。
- [ ] Depth-based fog。
- [ ] Depth-of-field prototype。
- [ ] Vector motion blur prototype。

---

## 18.9 GPU Particle / Procedural Motion

- [x] Particle storage buffer。
- [x] Compute update pass。
- [x] Particle spawn system。
- [x] Lifetime。
- [x] Position / Velocity。
- [x] Acceleration。
- [x] Color over life。
- [x] Size over life。
- [x] Rotation over life。
- [x] GPU random source。
- [x] Billboard rendering。
- [ ] Mesh particle rendering。
- [x] Indirect draw research / implementation。
- [x] 100k particle benchmark。
- [x] 500k particle benchmark。
- [x] 1M particle benchmark。
- [x] Particle cache / deterministic seed。
- [x] Arbitrary-time evaluation strategy。
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

- [x] 创建 `aster-plugin` crate。
- [x] 定义 Plugin Manifest schema。
- [x] 定义 plugin ID。
- [x] 定义 semantic version。
- [x] 定义 Aster API version。
- [x] 定义 capability / permission。
- [x] 实现 plugin discovery。
- [x] 实现 plugin loading。
- [x] 实现 plugin error reporting。
- [x] 实现 plugin disable / safe mode。

### WGSL Plugin

- [x] 定义 Effect shader ABI。
- [x] 定义 texture inputs。
- [x] 定义 output。
- [x] 定义 numeric parameter schema。
- [x] 定义 color parameter。
- [x] 定义 enum parameter。
- [x] 定义 texture parameter。
- [ ] 自动生成 Inspector UI。
- [x] Shader compile error UI。
- [ ] Hot reload shader。
- [x] Example: Tint。
- [x] Example: Chromatic Aberration。
- [x] Example: CRT / Stylize。

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
- [x] 首版暂不承诺稳定 ABI。

---

## 18.11 M4 — Video / Audio Workflow

### Video

- [ ] 创建 `aster-video` crate。
- [ ] FFmpeg integration。
- [ ] Container probe。
- [ ] Video stream selection。
- [x] Decode frame。
- [x] Timestamp handling。
- [x] Frame-rate handling。
- [x] Variable frame rate strategy。
- [x] Seek。
- [ ] Decode cache。
- [ ] Frame cache。
- [x] Video layer → GPU texture。
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

- [x] 定义 internal working color model。
- [x] Linear-light compositing。
- [x] sRGB import/export。
- [x] Display transform。
- [x] LUT support。
- [ ] ICC / OCIO strategy research。
- [ ] HDR roadmap。
- [x] 16-bit / float pipeline strategy。
- [x] Texture format policy。
- [x] Premultiplied alpha policy。
- [ ] Color-management test suite。

---

## 18.13 M5 — AI-Native

### Operation API

- [x] 创建 `aster-ai` crate。
- [ ] 列出全部可供 AI 调用的基础 Operation。
- [x] 定义 JSON Schema。
- [x] 定义 parameter validation。
- [x] 定义 operation permission。
- [x] 定义 operation result。
- [x] 定义 error schema。
- [x] 定义 dry-run / preview 模式。
- [x] 定义 operation transaction。
- [x] 定义 rollback。
- [x] 定义 audit log。

### AI Tooling

- [x] Provider abstraction。
- [x] Tool calling abstraction。
- [x] Context builder。
- [x] Project summary API。
- [x] Layer query API。
- [x] Property query API。
- [x] Timeline query API。
- [x] Scene query API。
- [x] Effect query API。
- [x] Asset query API。
- [x] Selection-aware context。

### Natural Language Workflows

- [x] “创建文字图层”。
- [x] “让文字从下面弹入”。
- [ ] “每个字延迟 0.08 秒”。
- [ ] “减少弹性”。
- [x] “给背景加 Glow”。
- [x] “让 Camera 缓慢推近”。
- [ ] “人物保持清晰，背景增加景深”。
- [ ] “复制这组 Layer 并改成左右交替进入”。
- [x] 多步骤 Planning。
- [x] 失败自动解释而不是静默修改。

### AI Safety / UX

- [x] Preview changes。
- [x] Diff changes。
- [x] Accept all。
- [x] Accept selected。
- [x] Reject。
- [x] Undo AI transaction。
- [x] 显示 AI 修改了哪些对象。
- [x] 阻止模型访问未授权本地文件。
- [x] 明确网络 Provider 数据边界。
- [x] Local model provider interface。

---

## 18.14 Project Format / Persistence

- [x] 创建 `aster-project` crate。
- [x] 定义 Project Schema v0。
- [x] 定义 Composition Schema。
- [x] 定义 Layer Schema。
- [x] 定义 Property Schema。
- [x] 定义 Keyframe Schema。
- [x] 定义 Effect Schema。
- [x] 定义 Asset Schema。
- [x] 定义 Plugin dependency Schema。
- [x] 定义 Stable UUID。
- [x] 实现 project save。
- [x] 实现 project load。
- [x] 实现 atomic save。
- [x] 实现 autosave。
- [x] 实现 crash recovery。
- [ ] 实现 relative asset paths。
- [ ] 实现 missing asset relink。
- [ ] 实现 packed project。
- [x] 实现 schema validation。
- [x] 实现 migration framework。
- [x] 实现 migration test fixtures。
- [x] 将 cache 与 source project 分离。
- [x] 发布 Project Format draft specification。

---

## 18.15 Performance / Optimization Backlog

- [x] Render Graph resource aliasing。
- [x] Pipeline prewarming。
- [ ] Async shader compilation strategy。
- [ ] Shader fusion prototype。
- [ ] Effect fusion eligibility analysis。
- [x] Dynamic resolution preview。
- [x] Preview quality levels。
- [ ] Tile processing research for huge compositions。
- [ ] Multi-threaded CPU scheduling。
- [ ] Parallel asset decode。
- [ ] Async disk IO。
- [ ] Texture upload batching。
- [ ] Persistent staging buffers。
- [ ] GPU culling for 3D / particles。
- [x] Indirect drawing。
- [ ] Bindless/resource-array strategy research。
- [ ] Memory budget manager。
- [ ] VRAM pressure handling。
- [x] LRU GPU cache。
- [ ] Disk cache benchmark。
- [ ] Temporal cache design。
- [x] Multi-frame render export strategy。
- [x] CPU fallback strategy for unsupported GPU features。
- [ ] Performance regression dashboard。

---

## 18.16 Testing / QA

### Core Tests

- [x] Unit tests for Time。
- [x] Unit tests for Keyframe interpolation。
- [x] Unit tests for Dependency DAG。
- [x] Unit tests for Project serialization。
- [x] Unit tests for Operation / Undo。
- [x] Unit tests for Plugin manifest。

### Rendering Tests

- [ ] Golden image tests。
- [ ] GPU backend comparison tests。
- [ ] Alpha compositing tests。
- [x] Color tests。
- [x] Blur tests。
- [ ] Text rendering tests。
- [x] 3D depth tests。
- [ ] Motion vector tests。

### Project Compatibility

- [x] Save/load roundtrip test。
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

- [x] README hero section。
- [x] Architecture overview。
- [x] Build from source guide。
- [x] Contribution guide。
- [x] Plugin tutorial。
- [x] WGSL Effect tutorial。
- [x] Render Graph tutorial。
- [x] Project Format spec。
- [x] AI Operation API docs。
- [x] Benchmark methodology docs。
- [x] Roadmap page。
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
- [x] Plugin directory convention。
- [x] Plugin search UI。
- [x] Plugin install UI。
- [x] Plugin update UI。
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

- [x] FPS。
- [x] Total Frame Time。
- [x] GPU Frame Time。
- [x] CPU Frame Time。
- [x] VRAM。
- [x] Dirty / Recomputed Node Count。
- [x] Particle Count。
- [x] Render Graph Pass Count。

Demo 发布准备：

- [x] 制作 benchmark project。
- [ ] 固定测试硬件配置。
- [x] 记录 Aster performance。
- [ ] 选择合理竞品对照方式。
- [x] 保证测试条件公平可复现。
- [ ] 录制实时交互视频。
- [ ] README 添加 Demo GIF / Video。
- [x] 发布 benchmark methodology。

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

- [x] 复杂 2D Motion 可以通过统一 GPU pipeline 实时预览；
- [x] Timeline 可以任意 seek，而不会被游戏式帧状态模型绑死；
- [x] Dirty Propagation 能显著减少不必要的重算；
- [x] 2D 与 3D 可以共享同一套 Scene / Render Graph；
- [ ] WGSL Plugin 可以低成本扩展效果；
- [x] 工程文件是开放、稳定、可版本控制的；
- [x] AI 能通过结构化 API 修改工程并完整 Undo；
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
