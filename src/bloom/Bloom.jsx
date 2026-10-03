import { useEffect, useRef } from 'react';

/**
 * The bloom: the logo's capsules as a live shader. Each petal is a token; its heat comes from the token's kelvin.
 * Geometry is a fanned deck on a tilted disk (computed here, in CSS pixels), shading is per pixel (rim, heat core,
 * the tucked end, shadows on the petals below, frost grain, focus blur for the far side).
 * The canvas is transparent where there is no petal, so type can sit behind it.
 *
 * `drive` is a ref the page writes every frame target into ({ cx, cy, size, cool, ladder, open, lift }); the loop eases
 * toward it, so page re-renders never restart the motion. `onFrame` receives the petals in screen space for overlays.
 */
const MAX = 12;
const FRAG = `#version 300 es
precision highp float;
out vec4 o;
uniform float uTime; uniform int uN;
uniform vec4 uP[${MAX}]; uniform vec4 uQ[${MAX}];
uniform float uCool; uniform float uGrain;
float sdCap(vec2 p, vec2 a, vec2 b, float r){ vec2 pa=p-a, ba=b-a; float h=clamp(dot(pa,ba)/dot(ba,ba),0.,1.); return length(pa-ba*h)-r; }
float hash(vec2 p){ vec3 q=fract(vec3(p.xyx)*.1031); q+=dot(q,q.yzx+33.33); return fract((q.x+q.y)*q.z); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
void main(){
  vec2 p=gl_FragCoord.xy;
  vec3 col=vec3(0.); float cov=0.;
  vec3 COLD=mix(vec3(.16,.52,1.), vec3(.55,.80,1.), uCool*.35);
  for(int i=0;i<${MAX};i++){ if(i>=uN) break;
    vec4 E=uP[i], Q=uQ[i];
    vec2 a=E.xy, b=E.zw; float w=Q.x, blur=fract(Q.z), hov=floor(Q.z)/8., heatIn=Q.y;
    float d=sdCap(p,a,b,w);
    float soft=mix(1.1, w*.42, blur);
    float alpha=1.-smoothstep(-soft, soft, d);
    float sh=exp(-max(d,0.)/(w*.30+soft))*.75;
    col*=1.-sh; cov=max(cov, sh*.55);
    vec2 ba=b-a; float L=max(length(ba),1.); vec2 uu=ba/L;
    float s=clamp((dot(p-a,uu)+w)/(L+2.*w),0.,1.);
    float axis=clamp(-d/w,0.,1.);
    vec2 hc=b-uu*w*.05;
    float heat=heatIn*(1.-uCool);
    float hot=exp(-dot(p-hc,p-hc)/(w*w*(.9+.9*heat)));
    vec3 lil=mix(vec3(.68,.61,.88), vec3(.62,.70,.92), uCool);
    vec3 warm=mix(vec3(1.,.28,.15),vec3(1.,.46,.09),smoothstep(.35,1.,hot));
    vec3 c=mix(lil, warm*1.12, smoothstep(.04,.7,hot)*heat);
    c=mix(c, vec3(1.,.84,.56), pow(hot,3.)*pow(heat,4.)*.5);   // the hottest show a white-hot core
    c=mix(c, vec3(.30,.37,.80), (1.-smoothstep(.10,.55,s))*.7);
    c=mix(c, vec3(.34,.05,.10), (1.-smoothstep(.0,.25,s))*.5*heat);
    float rim=pow(1.-axis, 9.);
    c=mix(c, COLD*1.3, rim*.95);
    c=mix(c, c*.6+COLD*.22, pow(1.-axis,3.)*.32);
    float g=hash(floor(p)), m=vn(p/(w*.028));
    c*=.86 + .30*mix(g,m,.55)*(1.-blur*.85);
    c=mix(c, vec3(dot(c,vec3(.3,.4,.3)))*vec3(.86,.82,1.), blur*.22);
    c+=hov*.16*vec3(1.,.62,.32);
    col=mix(col, c, alpha); cov=max(cov, alpha);
    float glow=exp(-max(d,0.)/(w*.16))*.18*(1.-alpha);
    col+=COLD*glow; cov=max(cov, glow*.9);
  }
  col+=(hash(p+fract(uTime)*91.7)-.5)*uGrain*cov;
  o=vec4(max(col,0.)*1., cov);
}`;
const VERT = `#version 300 es
in vec2 q; void main(){ gl_Position=vec4(q,0.,1.); }`;

const lerp = (a, b, k) => a + (b - a) * k;
const ease = (cur, to, k) => cur + (to - cur) * k;
const sdCap = (px, py, ax, ay, bx, by, r) => {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay || 1)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
};

/** Petals for a set of heats, in CSS pixels. Exported so tests and overlays share the geometry. */
export function bloomGeometry({ heats, cx, cy, size, spin, tilt = 0.42, open = 0, ladder = 0, lift = -1, ladderBox = null }) {
  const N = heats.length, R = size, f = 3.4;
  const r0 = 0.16 + open * 0.14, len = 0.40, wid = 0.30, twist = 0.78;
  const proj = (x, y) => { const z = y * Math.sin(tilt), yy = y * Math.cos(tilt), k = f / (f + z); return [cx + x * k * R, cy - yy * k * R, z, k]; };
  const out = [];
  for (let k = 0; k < N; k++) {
    const th = spin - 0.95 - k * (Math.PI * 2 / N), tw = th + twist, up = k === lift ? 0.07 : 0;
    const ax = Math.cos(th) * (r0 + up), ay = Math.sin(th) * (r0 + up), bx = ax + Math.cos(tw) * len, by = ay + Math.sin(tw) * len;
    const A = proj(ax, ay), B = proj(bx, by), mz = (A[2] + B[2]) / 2, mk = (A[3] + B[3]) / 2;
    let e = [A[0], A[1], B[0], B[1]], w = wid * R * mk, blur = Math.min(0.85, Math.max(0, (mz + 0.05) * 1.6)), key = mz + k * 0.045;
    if (ladder > 0 && ladderBox) {
      // the ladder: petals lie flat in a column, hottest at the top, each at its own row
      const rowH = ladderBox.h / N, y = ladderBox.y + rowH * (k + 0.5), lw = Math.min(rowH * 0.36, ladderBox.w * 0.09);
      const len2 = ladderBox.w * (0.25 + 0.75 * heats[k]) - lw * 2;
      const L = [ladderBox.x + lw, y, ladderBox.x + lw + Math.max(lw * 0.5, len2), y];
      e = e.map((v, i) => lerp(v, L[i], ladder)); w = lerp(w, lw, ladder); blur = lerp(blur, 0, ladder); key = lerp(key, -k * 0.01, ladder);
    }
    if (k === lift) { blur = Math.min(blur, 0.1); key -= 2; }
    out.push({ k, e, w, blur, key, heat: heats[k] });
  }
  return out;
}

export default function Bloom({ drive, heats, onFrame, onPick, className, fallback }) {
  const canvas = useRef(null), state = useRef(null), heatsRef = useRef(heats), pick = useRef(onPick), frameCb = useRef(onFrame);
  heatsRef.current = heats; pick.current = onPick; frameCb.current = onFrame;

  useEffect(() => {
    const cv = canvas.current;
    const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: true });
    if (!gl) { cv.dataset.failed = '1'; return; }
    const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    let prog;
    try {
      prog = gl.createProgram(); gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) { cv.dataset.failed = '1'; console.warn('bloom', e); return; }
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'q'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (n) => gl.getUniformLocation(prog, n);
    const uni = { time: U('uTime'), n: U('uN'), p: U('uP'), q: U('uQ'), cool: U('uCool'), grain: U('uGrain') };
    const P = new Float32Array(MAX * 4), Q = new Float32Array(MAX * 4);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cur = { cx: 0, cy: 0, size: 0, cool: 0, ladder: 0, open: 0, spin: 0, set: false };
    let hover = -1, raf = 0, last = performance.now(), pointer = null, lost = false;
    state.current = { petals: [] };

    const onMove = (e) => { const r = cv.getBoundingClientRect(); pointer = [e.clientX - r.left, e.clientY - r.top]; };
    const onLeave = () => { pointer = null; };
    const onClick = () => { if (hover >= 0) pick.current?.(hover); };
    window.addEventListener('pointermove', onMove, { passive: true });
    cv.addEventListener('pointerleave', onLeave); cv.addEventListener('click', onClick);
    cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; cv.dataset.failed = '1'; });

    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      if (lost) return;
      try {
        const dt = Math.min(64, now - last); last = now;
        const dpr = Math.min(1.75, devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
        if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
        const t = drive.current || {};
        const k = cur.set && !reduce ? 1 - Math.pow(0.0022, dt / 1000) : 1;
        for (const key of ['cx', 'cy', 'size', 'cool', 'ladder', 'open']) cur[key] = ease(cur[key], t[key] ?? cur[key], k);
        cur.set = true;
        if (!reduce) cur.spin += dt * 0.000035 * (1 - cur.ladder) * (hover >= 0 || (t.focus ?? -1) >= 0 ? 0.2 : 1);
        const hs = heatsRef.current?.length ? heatsRef.current : [1, .96, .94, .9, .82, .4, .3, .3, .45];
        // hit test, front to back, on the geometry of the last frame
        const prev = state.current.petals;
        let hit = -1;
        if (pointer && prev.length) {
          for (const p of [...prev].sort((a, b) => a.key - b.key)) {
            if (sdCap(pointer[0], pointer[1], p.e[0], p.e[1], p.e[2], p.e[3], p.w) < 0) { hit = p.k; break; }
          }
        }
        hover = hit; cv.style.cursor = hit >= 0 ? 'pointer' : '';
        const lift = hit >= 0 ? hit : (t.focus ?? -1);
        const petals = bloomGeometry({ heats: hs, cx: cur.cx, cy: cur.cy, size: cur.size, spin: cur.spin, open: cur.open, ladder: cur.ladder, ladderBox: t.ladderBox, lift });
        state.current.petals = petals;
        const sorted = [...petals].sort((a, b) => b.key - a.key);
        sorted.forEach((p, i) => {
          P.set([p.e[0] * dpr, (H - p.e[1]) * dpr, p.e[2] * dpr, (H - p.e[3]) * dpr], i * 4);
          Q.set([p.w * dpr, p.heat, (p.k === lift ? 8 : 0) + Math.min(0.999, p.blur), 0], i * 4);
        });
        gl.viewport(0, 0, cv.width, cv.height);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(uni.time, reduce ? 0 : now / 1000); gl.uniform1i(uni.n, sorted.length);
        gl.uniform4fv(uni.p, P); gl.uniform4fv(uni.q, Q); gl.uniform1f(uni.cool, cur.cool); gl.uniform1f(uni.grain, 0.05);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        frameCb.current?.({ petals, hover: hit, pointer });
      } catch (e) {
        cancelAnimationFrame(raf); cv.dataset.failed = '1'; console.warn('bloom frame', e);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('pointermove', onMove); cv.removeEventListener('pointerleave', onLeave); cv.removeEventListener('click', onClick); };
  }, [drive]);

  return <div className={className}>
    <canvas ref={canvas} className="kv-bloom-canvas" aria-hidden="true" />
    {fallback}
  </div>;
}
