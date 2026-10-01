// WebGPU implementation of the lens stage (lens.js has the model and the CPU
// reference). The frame is uploaded once as an rgba8unorm-srgb texture: the
// hardware sampler decodes to LINEAR light before filtering, so every bilinear
// tap is interpolated in linear light, as in the CPU path, at a fraction of the cost.
// Output: linear Rec.2020 (p3) or linear sRGB floats, interleaved RGB, for the region.
import { LENS_CONST, lensGeometry } from './lens.js';
import { P3_TO_REC2020 } from './color.js';
import { TONE_SQRT_N } from './tone.js';

const { CA_TAPS, ANISO_Y, VIG_T, VIG_KNEE, WARM_R, WARM_B } = LENS_CONST;

const WGSL = /* wgsl */`
struct P {
  frame: vec2<f32>, origin: vec2<f32>,      // frame size, region origin (frame px)
  axis: vec2<f32>, rMax: f32, falloff: f32,
  dR: f32, dB: f32, blur: f32, depth: f32,
  scale: f32, p3: f32, regionW: f32, regionH: f32,
  m0: vec4<f32>, m1: vec4<f32>, m2: vec4<f32>, // P3 → Rec.2020 rows (xyz)
};
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> p: P;
@group(0) @binding(3) var<storage, read_write> outBuf: array<f32>;
@group(0) @binding(4) var<storage, read> tone: array<f32>;   // tone.js `packed`: gain ++ scene, over sqrt(display linear)

fn lut(base: u32, v: f32) -> f32 {             // same lookup as tone.js
  let f = sqrt(clamp(v, 0.0, 1.0)) * ${TONE_SQRT_N}.0;
  let i = u32(f);
  if (i >= ${TONE_SQRT_N}u) { return tone[base + ${TONE_SQRT_N}u]; }
  return mix(tone[base + i], tone[base + i + 1u], f - f32(i));
}.0;
  let i = u32(f);
  if (i >= ${TONE_SQRT_N}u) { return tone[${TONE_SQRT_N}u]; }
  return mix(tone[i], tone[i + 1u], f - f32(i));
}

fn at(pos: vec2<f32>) -> vec4<f32> {           // pos in frame pixel coords (pixel centres at integers)
  return textureSampleLevel(tex, smp, (pos + 0.5) / p.frame, 0.0);
}
fn coverage(u: f32) -> f32 {                   // 0 on the axis, 1 at the farthest corner
  let raw = pow(1.0 + (u * ${VIG_T}) * (u * ${VIG_T}), -2.0);
  let r1 = pow(1.0 + ${VIG_T} * ${VIG_T}, -2.0);
  let soft = (1.0 - raw) / (1.0 - r1);
  let t = clamp((u - ${VIG_KNEE}) / (1.0 - ${VIG_KNEE}), 0.0, 1.0);
  return soft + (t * t * (3.0 - 2.0 * t) - soft) * p.falloff;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (f32(id.x) >= p.regionW || f32(id.y) >= p.regionH) { return; }
  let pos = p.origin + vec2<f32>(f32(id.x), f32(id.y));
  let d = pos - p.axis;
  let r = length(d);
  let g = coverage(min(r / p.rMax, 1.0));      // one curve drives both effects
  var c: vec3<f32>;
  if (p.dR > 0.0 && r > 0.5) {
    let u = vec2<f32>(d.x / r, d.y / r * ${ANISO_Y});
    let oR = p.dR * g; let oB = p.dB * g; let L = p.blur * g;
    if (L < 0.5) {
      c = vec3<f32>(at(pos + u * oR).r, at(pos).g, at(pos + u * oB).b);
    } else {
      // Smear each channel along its own radial displacement (G too, at zero offset).
      let taps = i32(min(${CA_TAPS}.0, max(3.0, ceil(L) + 1.0)));
      let step = L / f32(taps - 1); let half = L * 0.5;
      var acc = vec3<f32>(0.0);
      for (var t = 0; t < taps; t++) {
        let o = f32(t) * step - half;
        acc += vec3<f32>(at(pos + u * (oR + o)).r, at(pos + u * o).g, at(pos + u * (oB + o)).b);
      }
      c = acc / f32(taps);
    }
  } else {
    c = at(pos).rgb;
  }
  // tone.js applyTone: display curve on max(R,G,B) as a common gain, then per-channel scene LUT.
  let k = lut(0u, max(c.r, max(c.g, c.b)));
  let S = ${TONE_SQRT_N}u + 1u;
  c = vec3<f32>(lut(S, c.r * k), lut(S, c.g * k), lut(S, c.b * k));
  var gainOut = p.scale;
  if (p.depth > 0.0) {
    let lost = p.depth * g;                    // fraction of light the lens loses here
    gainOut *= 1.0 - lost;
    c.r *= 1.0 + ${WARM_R} * lost;
    c.b *= 1.0 - ${WARM_B} * lost;
  }
  if (p.p3 > 0.5) { c = vec3<f32>(dot(p.m0.xyz, c), dot(p.m1.xyz, c), dot(p.m2.xyz, c)); }
  let i = (id.y * u32(p.regionW) + id.x) * 3u;
  outBuf[i] = c.r * gainOut; outBuf[i + 1u] = c.g * gainOut; outBuf[i + 2u] = c.b * gainOut;
}`;

export class LensGPU {
  static async create() {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize },
    });
    return new LensGPU(device);
  }

  constructor(device) {
    this.device = device;
    this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: WGSL }), entryPoint: 'main' } });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.uniform = device.createBuffer({ size: 32 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.frame = null;
  }

  // Tone LUT buffer (tone.js `packed`), re-uploaded only when it changes.
  toneBuffer(packed) {
    if (!packed) {
      const n = TONE_SQRT_N + 1;
      packed = this.identity ||= Float32Array.from({ length: 2 * n }, (_, i) => (i < n ? 1 : ((i - n) / TONE_SQRT_N) ** 2));
    }
    if (this.toneLut !== packed) {
      this.toneBuf ||= this.device.createBuffer({ size: 2 * (TONE_SQRT_N + 1) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(this.toneBuf, 0, packed);
      this.toneLut = packed;
    }
    return this.toneBuf;
  }

  /** Upload the whole frame (8-bit RGBA, sRGB or Display P3 encoded — same transfer curve). */
  setFrame(data, W, H) {
    this.frame?.texture.destroy();
    const texture = this.device.createTexture({
      size: [W, H], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture({ texture }, data, { bytesPerRow: W * 4 }, [W, H]);
    this.frame = { texture, W, H };
  }

  /** Same contract as lens.js extractLens, for the frame last passed to setFrame. */
  /** `tone` (tone.js) turns display-linear samples into scene light; null = identity. */
  async extract(p3, x0, y0, w, h, scale, lens, tone = null) {
    const { device, frame } = this;
    const geo = lensGeometry(frame.W, frame.H, lens);
    const M = P3_TO_REC2020;
    device.queue.writeBuffer(this.uniform, 0, new Float32Array([
      frame.W, frame.H, x0, y0,
      geo.cx, geo.cy, geo.rMax, geo.falloff,
      geo.dR, geo.dB, geo.blur, geo.depth,
      scale, p3 ? 1 : 0, w, h,
      ...M[0], 0, ...M[1], 0, ...M[2], 0,
    ]));
    const bytes = w * h * 3 * 4;
    const out = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const bind = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 4, resource: { buffer: this.toneBuffer(tone?.packed) } },
        { binding: 0, resource: frame.texture.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.uniform } },
        { binding: 3, resource: { buffer: out } },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16));
    pass.end();
    enc.copyBufferToBuffer(out, 0, read, 0, bytes);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const rgb = new Float32Array(read.getMappedRange().slice(0));
    read.unmap(); read.destroy(); out.destroy();
    return rgb;
  }
}
