# Third-party licenses

Aster is distributed under MPL-2.0, while dependencies retain their original licenses. The primary
runtime families include Rust, Electron, wgpu, React, Vite, Lucide, serde, glam, reqwest, and their
transitive dependencies.

The authoritative inventories are `Cargo.lock` and `pnpm-lock.yaml`. Before a release, generate the
complete attribution report from the exact lockfiles and attach it to the release artifact:

```bash
cargo deny check licenses sources bans advisories
pnpm licenses list --prod --json
```

No dependency license is relicensed by this file. If this summary conflicts with an upstream license,
the upstream license controls.

## Chromium audio resampling compatibility

The native audio resampler follows the Blink SincResampler algorithm and sample-conversion
semantics from Chromium 150.0.7871.250, preserving phase and floating-point reduction behavior.
No Chromium native library is linked. Source: https://chromium.googlesource.com/chromium/src/+/150.0.7871.250/third_party/blink/renderer/platform/audio/sinc_resampler.cc

```text
Copyright (C) 2011 Google Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1.  Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.
2.  Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in the
    documentation and/or other materials provided with the distribution.
3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of
    its contributors may be used to endorse or promote products derived
    from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
