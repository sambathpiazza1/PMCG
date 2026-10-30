import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import * as THREE from "three";

/* ============================================================
   SIMULATORE BUCO NERO — versione EVOLUTIVA
   Motore temporale: lo stato (massa, accrescimento, luminosità,
   temperatura, spin) avanza nel tempo e reagisce agli eventi.
   Eventi iniettabili: burst di accrescimento, disruption mareale
   (TDE, decadimento t^-5/3), fusione (merger), evaporazione di Hawking.
   Grafici = serie temporali reali dell'evoluzione, non curve statiche.
   Integrazione AI: genera scenari-evento da linguaggio naturale e
   analizza il log. Con fallback locale se l'endpoint AI non risponde.

   NOTA: modello fenomenologico con leggi di scala realistiche
   (ISCO ∝ M, T_Hawking ∝ 1/M, L ∝ Ṁ, TDE ∝ t^-5/3). Non è una
   simulazione GRMHD dai primi principi. Resa Schwarzschild.
   ============================================================ */

/* ---- CONFIG AI ---------------------------------------------------------
   In ambiente artifact di Claude: funziona senza chiave.
   In locale (Vite): punta 'endpoint' al TUO proxy backend che detiene
   la chiave. NON mettere la chiave qui nel frontend.
   'directBrowser: true' + la tua chiave via proxy solo per test.       */
const AI = {
  endpoint: "https://api.anthropic.com/v1/messages",
  model: "claude-sonnet-4-6",
};

/* ----------------------------------------------------- Palette UI */
const T = {
  bg: "#05070b", panel: "#0b1017", panel2: "#080c12", sunk: "#06090e",
  line: "#151d28", lineSoft: "#101720", lineHard: "#26333f",
  text: "#dfe8f2", dim: "#8ea0b2", mute: "#566473",
  accent: "#5ad1ff", accentDim: "#245e73", warn: "#ffb24a", neg: "#ff5a7a", ok: "#7CFC9B",
  mono: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif",
};

/* ------------------------------------------------- Costanti fisiche (SI) */
const G = 6.674e-11, C = 2.998e8, MSUN = 1.989e30;
const HBAR = 1.055e-34, KB = 1.381e-23, LY = 9.4607e15;
const ETA = 0.1; // efficienza radiativa dell'accrescimento
const YR = 3.156e7;

const PRESETS = {
  sgrA: { name: "Sagittarius A*", massSun: 4.297e6, distLy: 26670, spin: 0.9, note: "Centro della Via Lattea" },
  m87: { name: "M87*", massSun: 6.5e9, distLy: 5.35e7, spin: 0.9, note: "Prima immagine EHT (2019)" },
  ton618: { name: "TON 618", massSun: 6.6e10, distLy: 1.04e10, spin: 0.5, note: "Tra i più massicci noti" },
  cygx1: { name: "Cygnus X-1", massSun: 21.2, distLy: 7240, spin: 0.95, note: "Binaria a raggi X" },
  micro: { name: "Micro-BN (10¹² kg)", massSun: 1e12 / MSUN, distLy: 1, spin: 0, note: "Per vedere l'evaporazione di Hawking" },
};

/* --------------------------------------------------- Formattazione */
function sci(x, d = 3) {
  if (x === 0) return "0";
  if (!isFinite(x)) return "∞";
  const a = Math.abs(x);
  if (a >= 1e-3 && a < 1e6) return x.toLocaleString("it-IT", { maximumSignificantDigits: d + 1 });
  const e = Math.floor(Math.log10(a));
  return `${(x / Math.pow(10, e)).toFixed(d)}·10${sup(e)}`;
}
function sup(n) {
  const m = { "-": "⁻", 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };
  return String(n).split("").map((c) => m[c] || c).join("");
}
function timeStr(s) {
  const a = Math.abs(s);
  if (a < 60) return `${s.toFixed(2)} s`;
  if (a < 3600) return `${(s / 60).toFixed(2)} min`;
  if (a < 86400) return `${(s / 3600).toFixed(2)} h`;
  if (a < YR) return `${(s / 86400).toFixed(2)} giorni`;
  if (a < YR * 1e6) return `${(s / YR).toFixed(2)} anni`;
  if (a < YR * 1e9) return `${(s / YR / 1e6).toFixed(2)} Myr`;
  return `${sci(s / YR)} anni`;
}

/* --------------------------------------------------- Fisica da M(t) */
function derive(Mkg, distLy) {
  const Rs = (2 * G * Mkg) / (C * C);
  const isco = 3 * Rs;
  const D = distLy * LY;
  const shadowUas = ((Math.sqrt(27) * Rs) / D) * 206264.806 * 1e6;
  const Thawk = (HBAR * Math.pow(C, 3)) / (8 * Math.PI * G * Mkg * KB);
  const Ledd = 1.26e31 * (Mkg / MSUN); // W
  const MdotHawk = (HBAR * Math.pow(C, 4)) / (15360 * Math.PI * G * G * Mkg * Mkg); // kg/s
  return { Rs, isco, shadowUas, Thawk, Ledd, MdotHawk };
}

/* --------------------------------------------------- Contributo eventi a Ṁ */
function eventMdot(ev, t) {
  const dt = t - ev.t0;
  if (dt < 0) return 0;
  switch (ev.type) {
    case "burst": { const w = ev.dur; return ev.amp * Math.exp(-((dt - w) * (dt - w)) / (0.5 * w * w)); }
    case "tde": { const tau = ev.dur; return ev.amp * Math.pow(1 + dt / tau, -5 / 3); }
    case "merger": { const w = ev.dur; return ev.amp * Math.exp(-(dt * dt) / (w * w)) * (0.6 + 0.4 * Math.cos(dt * 12 / w)); }
    default: return 0;
  }
}
function eventActive(ev, t) {
  const dt = t - ev.t0;
  if (dt < 0) return false;
  if (ev.type === "tde") return dt < ev.dur * 40;
  return dt < ev.dur * 4;
}

/* =========================================================== SHADER */
const VERT = `void main(){ gl_Position = vec4(position,1.0); }`;
const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform vec3 uCamPos,uRight,uUp,uFwd;
uniform float uTanHalfFov,uTime,uRin,uRout,uDiskBright,uDt,uTempShift,uTurb;
uniform int uMode;
const int MAX_STEPS = 260;
float hash13(vec3 p){ p=fract(p*0.1031); p+=dot(p,p.yzx+33.33); return fract((p.x+p.y)*p.z); }
vec3 starField(vec3 dir){
  vec3 col=vec3(0.0); vec3 d=normalize(dir);
  for(int k=0;k<3;k++){ float s=180.0+float(k)*260.0; vec3 ip=floor(d*s);
    float h=hash13(ip); float st=smoothstep(0.9987,1.0,h); float t=hash13(ip+7.31);
    col+=st*mix(vec3(0.65,0.78,1.0),vec3(1.0,0.88,0.7),t)*(0.5+0.6*t); }
  col+=0.015*vec3(0.15,0.22,0.4)*hash13(floor(d*6.0)); return col;
}
vec3 blackbody(float t){ t=clamp(t,0.0,1.0);
  vec3 c1=vec3(0.35,0.02,0.0),c2=vec3(1.0,0.35,0.05),c3=vec3(1.0,0.85,0.4),c4=vec3(1.0,1.0,0.98),c5=vec3(0.75,0.85,1.0);
  if(t<0.25)return mix(c1,c2,t/0.25); if(t<0.5)return mix(c2,c3,(t-0.25)/0.25);
  if(t<0.75)return mix(c3,c4,(t-0.5)/0.25); return mix(c4,c5,(t-0.75)/0.25);
}
vec3 thermal(float t){ t=clamp(t,0.0,1.0);
  if(t<0.25)return mix(vec3(0.0,0.0,0.12),vec3(0.12,0.0,0.6),t/0.25);
  if(t<0.5)return mix(vec3(0.12,0.0,0.6),vec3(0.9,0.0,0.25),(t-0.25)/0.25);
  if(t<0.75)return mix(vec3(0.9,0.0,0.25),vec3(1.0,0.8,0.0),(t-0.5)/0.25);
  return mix(vec3(1.0,0.8,0.0),vec3(1.0,1.0,1.0),(t-0.75)/0.25);
}
void main(){
  vec2 uv=(gl_FragCoord.xy/uRes)*2.0-1.0; uv.x*=uRes.x/uRes.y;
  vec3 rd=normalize(uFwd+uv.x*uTanHalfFov*uRight+uv.y*uTanHalfFov*uUp);
  vec3 pos=uCamPos; vec3 vel=rd; vec3 Lv=cross(pos,vel); float h2=dot(Lv,Lv);
  vec3 color=vec3(0.0); float transmit=1.0; bool captured=false; float prevY=pos.y;
  for(int i=0;i<MAX_STEPS;i++){
    float r=length(pos); if(r<1.0){captured=true;break;} if(r>55.0)break;
    vec3 acc=-1.5*h2*pos/pow(r,5.0); vel+=acc*uDt; vec3 npos=pos+vel*uDt;
    if(prevY*npos.y<0.0){
      float f=prevY/(prevY-npos.y); vec3 hp=mix(pos,npos,f); float rr=length(hp.xz);
      if(rr>uRin&&rr<uRout){
        float tnorm=clamp(pow(uRin/rr,0.75)*uTempShift,0.0,1.0);
        vec3 vdir=normalize(cross(vec3(0.0,1.0,0.0),hp)); float vorb=sqrt(0.5/rr);
        float los=dot(normalize(vel),vdir*vorb); float dopp=clamp(1.0/(1.0-los),0.35,3.0);
        float edge=smoothstep(uRin,uRin*1.12,rr)*smoothstep(uRout,uRout*0.75,rr);
        float ang=atan(hp.z,hp.x);
        float swirl=0.7+0.3*sin(ang*3.0+uTime*0.6-rr*1.5)+uTurb*0.4*sin(ang*7.0-uTime*2.0+rr*3.0);
        float bright=uDiskBright*tnorm*tnorm*dopp*dopp*edge*max(0.2,swirl);
        vec3 dcol;
        if(uMode==1){ dcol=thermal(tnorm); }
        else if(uMode==2){ float b=clamp((dopp-1.0)*0.7+0.5,0.0,1.0); dcol=mix(vec3(1.0,0.2,0.1),vec3(0.25,0.45,1.0),b); }
        else if(uMode==3){ float gz=clamp(1.0-sqrt(max(0.0,1.0-1.0/rr)),0.0,1.0); dcol=mix(vec3(1.0,0.9,0.6),vec3(1.0,0.12,0.06),gz); }
        else if(uMode==4){ dcol=(1.0-blackbody(tnorm))*vec3(0.55,0.9,1.0); }
        else { dcol=blackbody(tnorm)*mix(vec3(1.0,0.6,0.5),vec3(0.6,0.75,1.0),clamp((dopp-1.0)*0.5+0.5,0.0,1.0)); }
        color+=transmit*dcol*bright; transmit*=0.4;
      }
    }
    prevY=npos.y; pos=npos; if(transmit<0.02)break;
  }
  vec3 bg=vec3(0.0);
  if(!captured){ bg=starField(vel); if(uMode==1)bg*=vec3(0.25,0.35,0.7); if(uMode==4)bg=(1.0-bg)*vec3(0.4,0.7,1.0); }
  color+=transmit*bg; color=color/(1.0+color); color=pow(color,vec3(0.85));
  gl_FragColor=vec4(color,1.0);
}`;

/* =========================================================== APP */
export default function App() {
  const mountRef = useRef(null);
  const glRef = useRef(null);

  const [presetKey, setPresetKey] = useState("sgrA");
  const [distLy, setDistLy] = useState(PRESETS.sgrA.distLy);
  const [initMassSun, setInitMassSun] = useState(PRESETS.sgrA.massSun);
  const [mdotBaseEdd, setMdotBaseEdd] = useState(0.1); // Ṁ base in frazioni di Eddington

  const [mode, setMode] = useState(0);
  const [camMode, setCamMode] = useState("orbita");
  const [camSpeed, setCamSpeed] = useState(0.25);
  const [resScale, setResScale] = useState(0.7);
  const [showGrid, setShowGrid] = useState(true);

  // motore temporale
  const [running, setRunning] = useState(true);
  const [logTimeScale, setLogTimeScale] = useState(6); // 10^6 s di sim per s reale
  const [simDisplay, setSimDisplay] = useState({ t: 0, Msun: 0, L: 0, Ledd: 0, Thawk: 0, Mdot: 0, isco: 0, nEv: 0 });

  // camera
  const cam = useRef({ azim: 0.6, elev: 0.28, dist: 10, yaw: 0, pitch: 0, pos: new THREE.Vector3(0, 3, 10) });
  const keys = useRef({});
  const drag = useRef(null);

  // stato simulazione (nel loop)
  const sim = useRef(null);
  const [events, setEvents] = useState([]); // per la UI

  // log e AI
  const [log, setLog] = useState([]);
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiOnline, setAiOnline] = useState(null); // null sconosciuto, true/false

  // finestre grafici (serie temporali live)
  const [windows, setWindows] = useState({
    lum: { open: true, x: 40, y: 90 },
    mass: { open: false, x: 90, y: 150 },
    temp: { open: false, x: 140, y: 210 },
    mdot: { open: false, x: 190, y: 270 },
  });

  const initSim = useCallback((massSun) => {
    const M = massSun * MSUN;
    const d = derive(M, distLy);
    sim.current = {
      t: 0, M, a: PRESETS[presetKey]?.spin ?? 0.5,
      mdotBaseEdd, events: [],
      L: 0, Mdot: 0, Thawk: d.Thawk, isco: d.isco, Rs: d.Rs, Ledd: d.Ledd,
      series: [], lastPush: 0,
    };
    setEvents([]);
  }, [distLy, presetKey, mdotBaseEdd]);

  const applyPreset = (k) => {
    const p = PRESETS[k];
    setPresetKey(k); setInitMassSun(p.massSun); setDistLy(p.distLy);
  };

  const resetSim = () => initSim(initMassSun);

  /* --------------------------------- three.js */
  useEffect(() => {
    const mount = mountRef.current; if (!mount) return;
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" }); }
    catch (e) { mount.innerHTML = "<div style='color:#ff5a7a;padding:20px;font-family:monospace'>WebGL non disponibile.</div>"; return; }
    glRef.current = renderer;
    renderer.setPixelRatio(1);
    mount.appendChild(renderer.domElement);
    Object.assign(renderer.domElement.style, { width: "100%", height: "100%", display: "block" });

    const scene = new THREE.Scene();
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const U = {
      uRes: { value: new THREE.Vector2(1, 1) },
      uCamPos: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector3() },
      uUp: { value: new THREE.Vector3() }, uFwd: { value: new THREE.Vector3() },
      uTanHalfFov: { value: Math.tan((60 * Math.PI) / 360) },
      uTime: { value: 0 }, uRin: { value: 3 }, uRout: { value: 13 },
      uDiskBright: { value: 1.4 }, uDt: { value: 0.16 }, uTempShift: { value: 1 }, uTurb: { value: 0 },
      uMode: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: U });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));

    const resize = () => {
      const w = Math.max(1, Math.floor(mount.clientWidth * resScaleRef.current));
      const h = Math.max(1, Math.floor(mount.clientHeight * resScaleRef.current));
      renderer.setSize(w, h, false); U.uRes.value.set(w, h);
    };
    const ro = new ResizeObserver(resize); ro.observe(mount); resize();

    let raf, last = performance.now(), frames = 0, fpsT = last;
    const worldUp = new THREE.Vector3(0, 1, 0);

    const loop = (t) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (t - last) / 1000); last = t;

      // ---- avanza la simulazione fisica ----
      const s = sim.current;
      if (s && runningRef.current) {
        const timeScale = Math.pow(10, logTimeScaleRef.current);
        const dtSim = dt * timeScale;
        const d = derive(s.M, distLyRef.current);
        s.Ledd = d.Ledd; s.Thawk = d.Thawk; s.isco = d.isco; s.Rs = d.Rs;
        const MdotBase = (s.mdotBaseEdd * d.Ledd) / (ETA * C * C); // kg/s
        let MdotEv = 0;
        s.events.forEach((ev) => { MdotEv += eventMdot(ev, s.t); });
        const MdotAcc = MdotBase + MdotEv;
        s.Mdot = MdotAcc;
        s.M += (MdotAcc - d.MdotHawk) * dtSim;
        if (s.M < 1e3) s.M = 1e3; // evita zero
        s.L = ETA * MdotAcc * C * C; // W
        s.t += dtSim;
        // pulizia eventi spenti
        s.events = s.events.filter((ev) => eventActive(ev, s.t));
        // serie temporale (ogni ~120 ms reali)
        if (t - s.lastPush > 120) {
          s.lastPush = t;
          s.series.push({ t: s.t, M: s.M, L: s.L, Ledd: s.Ledd, Thawk: s.Thawk, Mdot: s.Mdot });
          if (s.series.length > 600) s.series.shift();
        }
        // guida lo shader dallo stato
        const edd = s.L / Math.max(1e-30, s.Ledd);
        U.uDiskBright.value = 0.6 + 2.4 * Math.min(2, edd);
        U.uTempShift.value = 0.7 + 0.9 * Math.min(2, Math.cbrt(Math.max(0.01, edd)));
        U.uTurb.value = Math.min(1, MdotEv / Math.max(1e-30, MdotBase + 1e-30) * 0.4);
      }

      // ---- camera ----
      const st = cam.current; let camPos, fwd;
      if (camModeRef.current === "orbita") {
        if (runningRef.current) st.azim += camSpeedRef.current * dt;
        const ce = Math.cos(st.elev), se = Math.sin(st.elev);
        camPos = new THREE.Vector3(st.dist * ce * Math.sin(st.azim), st.dist * se, st.dist * ce * Math.cos(st.azim));
        fwd = camPos.clone().multiplyScalar(-1).normalize(); st.pos.copy(camPos);
      } else {
        const yaw = st.yaw, pitch = st.pitch;
        fwd = new THREE.Vector3(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)).normalize();
        const rgt = new THREE.Vector3().crossVectors(fwd, worldUp).normalize();
        const sp = 6 * dt;
        if (keys.current["w"]) st.pos.addScaledVector(fwd, sp);
        if (keys.current["s"]) st.pos.addScaledVector(fwd, -sp);
        if (keys.current["a"]) st.pos.addScaledVector(rgt, -sp);
        if (keys.current["d"]) st.pos.addScaledVector(rgt, sp);
        if (keys.current["q"]) st.pos.addScaledVector(worldUp, -sp);
        if (keys.current["e"]) st.pos.addScaledVector(worldUp, sp);
        if (st.pos.length() < 1.4) st.pos.setLength(1.4);
        camPos = st.pos.clone();
      }
      const right = new THREE.Vector3().crossVectors(fwd, worldUp).normalize();
      const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
      U.uCamPos.value.copy(camPos); U.uFwd.value.copy(fwd); U.uRight.value.copy(right); U.uUp.value.copy(up);
      U.uMode.value = modeRef.current;
      U.uTime.value += dt;
      renderer.render(scene, ortho);

      coordSink.current = { x: camPos.x, y: camPos.y, z: camPos.z, dist: camPos.length() };
      frames++;
      if (t - fpsT > 500) { fpsSink.current = Math.round((frames * 1000) / (t - fpsT)); frames = 0; fpsT = t; }
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); mat.dispose(); renderer.dispose(); if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement); };
  }, []);

  // refs specchio
  const resScaleRef = useRef(resScale); useEffect(() => { resScaleRef.current = resScale; }, [resScale]);
  const modeRef = useRef(mode); useEffect(() => { modeRef.current = mode; }, [mode]);
  const camSpeedRef = useRef(camSpeed); useEffect(() => { camSpeedRef.current = camSpeed; }, [camSpeed]);
  const camModeRef = useRef(camMode); useEffect(() => { camModeRef.current = camMode; }, [camMode]);
  const runningRef = useRef(running); useEffect(() => { runningRef.current = running; }, [running]);
  const logTimeScaleRef = useRef(logTimeScale); useEffect(() => { logTimeScaleRef.current = logTimeScale; }, [logTimeScale]);
  const distLyRef = useRef(distLy); useEffect(() => { distLyRef.current = distLy; }, [distLy]);
  const coordSink = useRef({ x: 0, y: 0, z: 0, dist: 10 });
  const fpsSink = useRef(0);
  const [coords, setCoords] = useState({ x: 0, y: 0, z: 0, dist: 10 });
  const [fps, setFps] = useState(0);

  // init all'avvio + quando cambio preset/massa
  useEffect(() => { initSim(initMassSun); }, [initMassSun, distLy, presetKey]); // eslint-disable-line
  useEffect(() => { if (sim.current) sim.current.mdotBaseEdd = mdotBaseEdd; }, [mdotBaseEdd]);

  // aggiorna display a bassa frequenza
  useEffect(() => {
    const id = setInterval(() => {
      setCoords({ ...coordSink.current }); setFps(fpsSink.current);
      const s = sim.current;
      if (s) setSimDisplay({ t: s.t, Msun: s.M / MSUN, L: s.L, Ledd: s.Ledd, Thawk: s.Thawk, Mdot: s.Mdot, isco: s.isco, nEv: s.events.length });
    }, 200);
    return () => clearInterval(id);
  }, []);

  // tastiera camera libera
  useEffect(() => {
    const d = (e) => { keys.current[e.key.toLowerCase()] = true; };
    const u = (e) => { keys.current[e.key.toLowerCase()] = false; };
    window.addEventListener("keydown", d); window.addEventListener("keyup", u);
    return () => { window.removeEventListener("keydown", d); window.removeEventListener("keyup", u); };
  }, []);

  const onPointerDown = (e) => { drag.current = { x: e.clientX, y: e.clientY }; };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    const st = cam.current;
    if (camMode === "orbita") { st.azim -= dx * 0.005; st.elev = Math.max(-1.45, Math.min(1.45, st.elev + dy * 0.005)); }
    else { st.yaw -= dx * 0.004; st.pitch = Math.max(-1.4, Math.min(1.4, st.pitch - dy * 0.004)); }
  };
  const onPointerUp = () => { drag.current = null; };
  const onWheel = (e) => { e.preventDefault(); const st = cam.current; if (camMode === "orbita") st.dist = Math.max(1.7, Math.min(45, st.dist + e.deltaY * 0.01)); };

  /* --------------------------------- eventi */
  const injectEvent = (type, opts = {}) => {
    const s = sim.current; if (!s) return;
    const Medd = (s.Ledd) / (ETA * C * C); // kg/s a Eddington
    const presets = {
      burst: { amp: (opts.amp ?? 3) * Medd, dur: (opts.durYr ?? 0.5) * YR },
      tde: { amp: (opts.amp ?? 8) * Medd, dur: (opts.durYr ?? 0.1) * YR, addMass: (opts.starMsun ?? 1) * MSUN },
      merger: { amp: (opts.amp ?? 5) * Medd, dur: (opts.durYr ?? 0.02) * YR, addMass: (opts.mergerMsun ?? s.M / MSUN * 0.3) * MSUN, spinTo: opts.spinTo ?? Math.min(0.99, s.a + 0.1) },
    };
    const p = presets[type]; if (!p) return;
    const ev = { id: Math.random().toString(36).slice(2), type, t0: s.t, amp: p.amp, dur: p.dur, label: opts.label || type };
    if (type === "merger") { s.M += p.addMass; s.a = p.spinTo; }
    s.events.push(ev);
    setEvents(s.events.map((e) => ({ id: e.id, type: e.type, t0: e.t0, label: e.label })));
    // log dell'iniezione
    setLog((L) => [{ t: new Date().toISOString(), simT: s.t, kind: "EVENTO", type, label: ev.label, Msun: s.M / MSUN, L: s.L }, ...L].slice(0, 300));
  };

  /* --------------------------------- log e AI */
  const captureLog = useCallback(() => {
    const s = sim.current, c = coordSink.current; if (!s) return;
    setLog((L) => [{
      t: new Date().toISOString(), simT: s.t, kind: "CAMPIONE",
      Msun: s.M / MSUN, L: s.L, Ledd: s.Ledd, Thawk: s.Thawk, Mdot: s.Mdot,
      modalita: ["reale", "termico", "doppler", "redshift", "antimateria"][mode],
      camR: +c.dist.toFixed(2),
    }, ...L].slice(0, 300));
  }, [mode]);

  async function callClaude(system, user) {
    const res = await fetch(AI.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: AI.model, max_tokens: 1000, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    return (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  }

  // GENERA evento da linguaggio naturale
  const aiGenerate = async () => {
    if (!aiPrompt.trim()) return;
    setAiBusy(true); setAiText("");
    const sys = "Sei un motore di scenari per un simulatore di buco nero. Traduci la richiesta in UN evento. Rispondi SOLO con JSON, senza testo attorno, forma: {\"type\":\"burst|tde|merger\",\"amp\":number,\"durYr\":number,\"starMsun\":number,\"mergerMsun\":number,\"label\":\"...\"}. amp = picco di accrescimento in unità di Eddington. Ometti i campi non pertinenti.";
    try {
      const out = await callClaude(sys, aiPrompt);
      const clean = out.replace(/```json|```/g, "").trim();
      const ev = JSON.parse(clean);
      setAiOnline(true);
      injectEvent(ev.type, ev);
      setAiText(`Evento iniettato: ${ev.label || ev.type} (${ev.type}, picco ${ev.amp}× Eddington).`);
    } catch (e) {
      setAiOnline(false);
      const ev = heuristicEvent(aiPrompt);
      injectEvent(ev.type, ev);
      setAiText(`[modalità locale — endpoint AI non raggiungibile] Interpretato come: ${ev.label} (${ev.type}).`);
    } finally { setAiBusy(false); }
  };

  // ANALIZZA la serie temporale
  const aiAnalyze = async () => {
    const s = sim.current; if (!s || s.series.length < 3) { setAiText("Non ci sono ancora abbastanza dati: lascia evolvere la simulazione."); return; }
    setAiBusy(true); setAiText("");
    const summary = summarizeSeries(s.series);
    const sys = "Sei un astrofisico. Ti do una serie temporale sintetica dall'evoluzione di un buco nero (modello fenomenologico). Analizza in italiano, conciso: cosa è successo, eventuali flare/accrescimenti, variazione di massa e temperatura, e cosa suggeriresti di osservare. Max 8 frasi.";
    try {
      const out = await callClaude(sys, "Dati:\n" + summary);
      setAiOnline(true); setAiText(out);
    } catch (e) {
      setAiOnline(false); setAiText(heuristicAnalysis(s.series));
    } finally { setAiBusy(false); }
  };

  const exportLog = (fmt) => {
    let blob;
    if (fmt === "csv") {
      const keys = Object.keys(log[0] || { t: "" });
      blob = new Blob([[keys.join(","), ...log.map((r) => keys.map((k) => r[k]).join(","))].join("\n")], { type: "text/csv" });
    } else blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `log-buco-nero.${fmt}`; a.click(); URL.revokeObjectURL(url);
  };

  const toggleWin = (k) => setWindows((w) => ({ ...w, [k]: { ...w[k], open: !w[k].open } }));
  const moveWin = (k, x, y) => setWindows((w) => ({ ...w, [k]: { ...w[k], x, y } }));

  const modes = [{ i: 0, l: "Reale" }, { i: 1, l: "Termico" }, { i: 2, l: "Doppler" }, { i: 3, l: "Redshift" }, { i: 4, l: "Antimateria" }];

  const plotDefs = {
    lum: { title: "Luminosità L(t)", color: T.warn, pick: (p) => (p.L / Math.max(1e-30, p.Ledd)), ylab: "L / L_Edd" },
    mass: { title: "Massa M(t)", color: T.accent, pick: (p) => p.M / MSUN, ylab: "M (M☉)" },
    temp: { title: "Temperatura Hawking T(t)", color: T.ok, pick: (p) => p.Thawk, ylab: "T (K)" },
    mdot: { title: "Tasso accrescimento Ṁ(t)", color: T.neg, pick: (p) => p.Mdot, ylab: "Ṁ (kg/s)" },
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", minHeight: 600, background: T.bg, color: T.text, fontFamily: T.sans, overflow: "hidden" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 16px", borderBottom: `1px solid ${T.line}`, background: T.panel2, flexShrink: 0 }}>
        <div style={{ fontFamily: T.mono, fontSize: 12, letterSpacing: 3, color: T.accent, fontWeight: 700 }}>◉ EVENT HORIZON</div>
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Simulatore evolutivo</h1>
        <span style={{ fontSize: 11.5, color: T.mute, fontFamily: T.mono }}>{PRESETS[presetKey]?.name}</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.accent }}>t = {timeStr(simDisplay.t)}</span>
          <span style={{ fontSize: 11, color: T.mute, fontFamily: T.mono }}>{fps} fps</span>
        </div>
      </header>

      {/* toolbar temporale */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", padding: "8px 16px", borderBottom: `1px solid ${T.line}`, background: T.panel, flexShrink: 0 }}>
        <Btn onClick={() => setRunning((r) => !r)} accent={running}>{running ? "⏸ Pausa" : "▶ Avvia"}</Btn>
        <Btn onClick={resetSim}>⟲ Reset</Btn>
        <Field label={`Accel. tempo · 10^${logTimeScale} (${timeStr(Math.pow(10, logTimeScale))}/s)`}>
          <input type="range" min={0} max={17} step={0.5} value={logTimeScale} onChange={(e) => setLogTimeScale(+e.target.value)} style={{ width: 180, accentColor: T.accent }} />
        </Field>
        <Divider />
        <Field label="Camera"><Seg options={[{ v: "orbita", l: "Orbitale" }, { v: "libera", l: "Libera" }]} value={camMode} onChange={setCamMode} /></Field>
        <Field label="Vel. camera"><input type="range" min={0} max={1.2} step={0.01} value={camSpeed} onChange={(e) => setCamSpeed(+e.target.value)} style={{ width: 90, accentColor: T.dim }} /></Field>
        <Divider />
        <Field label="Vista">
          <div style={{ display: "flex", gap: 4 }}>
            {modes.map((m) => <button key={m.i} onClick={() => setMode(m.i)} style={{ padding: "5px 9px", borderRadius: 5, cursor: "pointer", fontSize: 11.5, fontWeight: 600, fontFamily: T.sans, background: mode === m.i ? "rgba(90,209,255,.16)" : T.sunk, color: mode === m.i ? T.accent : T.mute, border: `1px solid ${mode === m.i ? T.accentDim : T.lineHard}` }}>{m.l}</button>)}
          </div>
        </Field>
        <Field label="Risol."><input type="range" min={0.35} max={1} step={0.05} value={resScale} onChange={(e) => setResScale(+e.target.value)} style={{ width: 70, accentColor: T.dim }} /></Field>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: T.dim }}><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> Griglia</label>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* sinistra */}
        <aside style={{ width: 300, flexShrink: 0, background: T.panel, borderRight: `1px solid ${T.line}`, display: "flex", flexDirection: "column", overflow: "auto" }}>
          <Section title="Condizioni iniziali">
            <label style={S.lbl}>Oggetto (database)</label>
            <select value={presetKey} onChange={(e) => applyPreset(e.target.value)} style={S.input}>
              {Object.entries(PRESETS).map(([k, p]) => <option key={k} value={k}>{p.name}</option>)}
            </select>
            <p style={{ fontSize: 11, color: T.mute, margin: "6px 0 12px" }}>{PRESETS[presetKey]?.note}</p>
            <NumField label="Massa iniziale (M☉)" value={initMassSun} onChange={setInitMassSun} />
            <NumField label="Distanza (anni luce)" value={distLy} onChange={setDistLy} />
            <div style={{ marginBottom: 6 }}>
              <label style={S.lbl}>Accrescimento base (× Eddington)</label>
              <input type="range" min={0} max={1.5} step={0.01} value={mdotBaseEdd} onChange={(e) => setMdotBaseEdd(+e.target.value)} style={{ width: "100%", accentColor: T.warn }} />
              <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.dim }}>{mdotBaseEdd.toFixed(2)} Ṁ_Edd</div>
            </div>
          </Section>

          <Section title="Stato attuale (live)">
            <Out label="Tempo simulato" value={timeStr(simDisplay.t)} />
            <Out label="Massa" value={`${sci(simDisplay.Msun)} M☉`} sub={`${sci(simDisplay.Msun * MSUN)} kg`} />
            <Out label="Luminosità" value={`${sci(simDisplay.L)} W`} sub={`${(simDisplay.L / Math.max(1e-30, simDisplay.Ledd)).toFixed(3)} × Eddington`} />
            <Out label="Tasso accrescimento Ṁ" value={`${sci(simDisplay.Mdot)} kg/s`} sub={`${sci(simDisplay.Mdot * YR / MSUN)} M☉/anno`} />
            <Out label="Temperatura di Hawking" value={`${sci(simDisplay.Thawk)} K`} />
            <Out label="ISCO" value={`${sci(simDisplay.isco)} m`} />
            <Out label="Eventi attivi" value={`${simDisplay.nEv}`} />
          </Section>

          <Section title="Inietta evento">
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <EventBtn color={T.warn} title="Burst di accrescimento" desc="Nube di gas che cade: flare e decadimento." onClick={() => injectEvent("burst", { label: "Burst di gas" })} />
              <EventBtn color={T.neg} title="Disruption mareale (TDE)" desc="Una stella viene lacerata: picco e coda t⁻⁵ᐟ³." onClick={() => injectEvent("tde", { label: "TDE stella 1 M☉", starMsun: 1 })} />
              <EventBtn color={T.accent} title="Fusione (merger)" desc="Un altro BN cade dentro: salto di massa e spin." onClick={() => injectEvent("merger", { label: "Merger" })} />
            </div>
          </Section>

          <Section title="Coordinate camera (Rs)">
            <div style={{ fontFamily: T.mono, fontSize: 12.5, color: T.dim, lineHeight: 1.7 }}>
              <div>x = <b style={{ color: T.text }}>{coords.x.toFixed(2)}</b> · y = <b style={{ color: T.text }}>{coords.y.toFixed(2)}</b></div>
              <div>z = <b style={{ color: T.text }}>{coords.z.toFixed(2)}</b> · r = <b style={{ color: T.accent }}>{coords.dist.toFixed(2)}</b></div>
            </div>
          </Section>
        </aside>

        {/* camera */}
        <main style={{ flex: 1, position: "relative", minWidth: 0, background: "#000" }}>
          <div ref={mountRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp} onWheel={onWheel}
            style={{ position: "absolute", inset: 0, cursor: drag.current ? "grabbing" : "grab" }} />
          {showGrid && <GridOverlay />}
          <CamBadge mode={modes[mode].l} camMode={camMode} running={running} />
          <PlotToggle windows={windows} onToggle={toggleWin} />
          {Object.entries(windows).map(([k, w]) => w.open && (
            <PlotWindow key={k} def={plotDefs[k]} seriesRef={sim} x={w.x} y={w.y} onMove={(x, y) => moveWin(k, x, y)} onClose={() => toggleWin(k)} />
          ))}
        </main>

        {/* destra: AI */}
        <aside style={{ width: 296, flexShrink: 0, background: T.panel, borderLeft: `1px solid ${T.line}`, display: "flex", flexDirection: "column", overflow: "auto" }}>
          <Section title={<span>Assistente AI {aiOnline === false && <em style={{ color: T.warn, fontStyle: "normal", fontSize: 9 }}>· locale</em>}{aiOnline === true && <em style={{ color: T.ok, fontStyle: "normal", fontSize: 9 }}>· online</em>}</span>}>
            <p style={{ fontSize: 11.5, color: T.mute, margin: "0 0 8px", lineHeight: 1.5 }}>Descrivi uno scenario in italiano: l'AI lo traduce in un evento e lo inietta.</p>
            <textarea value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} placeholder="es. una stella di 3 masse solari viene lacerata dalle forze di marea"
              style={{ ...S.input, minHeight: 60, resize: "vertical", fontFamily: T.sans }} />
            <div style={{ display: "flex", gap: 7, marginTop: 8 }}>
              <Btn onClick={aiGenerate} accent disabled={aiBusy}>{aiBusy ? "…" : "✦ Genera evento"}</Btn>
              <Btn onClick={aiAnalyze} disabled={aiBusy}>{aiBusy ? "…" : "🔎 Analizza"}</Btn>
            </div>
            {aiText && <div style={{ marginTop: 10, padding: 10, background: T.sunk, border: `1px solid ${T.lineHard}`, borderRadius: 6, fontSize: 12.5, color: T.text, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{aiText}</div>}
          </Section>

          <Section title="Timeline eventi">
            {events.length === 0 ? <p style={{ fontSize: 12, color: T.mute, margin: 0 }}>Nessun evento attivo.</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {events.map((e) => (
                  <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: e.type === "tde" ? T.neg : e.type === "merger" ? T.accent : T.warn }} />
                    <span style={{ flex: 1, color: T.text }}>{e.label}</span>
                    <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.mute }}>{timeStr(e.t0)}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </aside>
      </div>

      {/* footer log */}
      <footer style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", borderTop: `1px solid ${T.line}`, background: T.panel2, flexShrink: 0, flexWrap: "wrap" }}>
        <Btn onClick={captureLog} accent>⦿ Cattura dato</Btn>
        <span style={{ fontSize: 12, color: T.mute, fontFamily: T.mono }}>{log.length} righe</span>
        <div style={{ flex: 1, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", fontFamily: T.mono, fontSize: 11.5, color: T.dim }}>
          {log[0] ? `${log[0].kind}${log[0].type ? " " + log[0].type : ""} · t=${timeStr(log[0].simT || 0)} · M=${sci(log[0].Msun)} M☉` : "nessuna riga"}
        </div>
        <Btn onClick={() => exportLog("csv")} disabled={!log.length}>↓ CSV</Btn>
        <Btn onClick={() => exportLog("json")} disabled={!log.length}>↓ JSON</Btn>
      </footer>
    </div>
  );
}

/* =========================================================== euristiche locali */
function heuristicEvent(prompt) {
  const p = prompt.toLowerCase();
  const massMatch = p.match(/(\d+(?:[.,]\d+)?)\s*(?:mass|solari|m☉|msun)/);
  const m = massMatch ? parseFloat(massMatch[1].replace(",", ".")) : 1;
  if (/(tde|maree|mareale|lacera|distrutt|stella)/.test(p)) return { type: "tde", starMsun: m, amp: 8, durYr: 0.1, label: `TDE stella ${m} M☉` };
  if (/(fusion|merger|collis|scontr|un altro buco|binari)/.test(p)) return { type: "merger", mergerMsun: m > 1 ? m : undefined, amp: 5, durYr: 0.02, label: `Merger ${m} M☉` };
  return { type: "burst", amp: 3, durYr: 0.5, label: "Burst di accrescimento" };
}
function summarizeSeries(series) {
  const n = series.length;
  const first = series[0], last = series[n - 1];
  let peakL = -Infinity, peakT = 0;
  series.forEach((p) => { const e = p.L / Math.max(1e-30, p.Ledd); if (e > peakL) { peakL = e; peakT = p.t; } });
  return [
    `campioni: ${n}`,
    `t_iniziale=${timeStr(first.t)}  t_finale=${timeStr(last.t)}`,
    `M: ${sci(first.M / MSUN)} → ${sci(last.M / MSUN)} M☉`,
    `L/L_Edd: iniziale ${(first.L / Math.max(1e-30, first.Ledd)).toFixed(3)}, picco ${peakL.toFixed(3)} a t=${timeStr(peakT)}`,
    `T_Hawking: ${sci(first.Thawk)} → ${sci(last.Thawk)} K`,
    `Ṁ finale: ${sci(last.Mdot)} kg/s`,
  ].join("\n");
}
function heuristicAnalysis(series) {
  const n = series.length, first = series[0], last = series[n - 1];
  const dM = (last.M - first.M) / MSUN;
  let peakL = -Infinity, peakT = 0;
  series.forEach((p) => { const e = p.L / Math.max(1e-30, p.Ledd); if (e > peakL) { peakL = e; peakT = p.t; } });
  const baseE = first.L / Math.max(1e-30, first.Ledd);
  const flare = peakL > baseE * 2;
  const parts = [];
  parts.push(`Nell'intervallo osservato (${timeStr(last.t - first.t)}) la massa è variata di ${dM >= 0 ? "+" : ""}${sci(dM)} M☉.`);
  if (flare) parts.push(`Si registra un flare: la luminosità ha raggiunto ${peakL.toFixed(2)}× Eddington attorno a t=${timeStr(peakT)}, compatibile con un episodio di accrescimento intenso (burst o disruption mareale).`);
  else parts.push(`La luminosità è rimasta vicina al livello quiescente (~${baseE.toFixed(2)}× Eddington), senza flare marcati.`);
  parts.push(`La temperatura di Hawking è ${sci(last.Thawk)} K: ${last.Thawk > 1 ? "non trascurabile — regime di piccola massa/evaporazione" : "irrilevante a questa massa, come atteso per un BN astrofisico"}.`);
  parts.push(`Suggerimento: osserva la coda del flare — un decadimento ∝ t⁻⁵ᐟ³ indicherebbe una TDE, mentre un profilo simmetrico è più tipico di un burst di gas.`);
  return "[analisi locale — endpoint AI non raggiungibile]\n\n" + parts.join(" ");
}

/* =========================================================== UI parti */
const S = {
  lbl: { display: "block", fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: T.mute, fontFamily: T.mono, marginBottom: 5, marginTop: 4 },
  input: { width: "100%", boxSizing: "border-box", background: T.sunk, color: T.text, border: `1px solid ${T.lineHard}`, borderRadius: 6, padding: "7px 9px", fontFamily: T.sans, fontSize: 13, outline: "none" },
};
function Section({ title, children }) {
  return <div style={{ padding: "13px 15px", borderBottom: `1px solid ${T.lineSoft}` }}>
    <div style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: T.accent, fontFamily: T.mono, marginBottom: 9, fontWeight: 700 }}>{title}</div>{children}
  </div>;
}
function NumField({ label, value, onChange, step = "any" }) {
  return <div style={{ marginBottom: 9 }}><label style={S.lbl}>{label}</label>
    <input type="number" step={step} value={value} onChange={(e) => onChange(e.target.value === "" ? 0 : +e.target.value)} style={S.input} /></div>;
}
function Out({ label, value, sub }) {
  return <div style={{ marginBottom: 9 }}><div style={{ fontSize: 11, color: T.mute, marginBottom: 1 }}>{label}</div>
    <div style={{ fontFamily: T.mono, fontSize: 13.5, color: T.text, fontWeight: 600 }}>{value}</div>
    {sub && <div style={{ fontSize: 10.5, color: T.mute }}>{sub}</div>}</div>;
}
function Field({ label, children }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <span style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: T.mute, fontFamily: T.mono }}>{label}</span>{children}</label>;
}
function Seg({ options, value, onChange }) {
  return <div style={{ display: "inline-flex", border: `1px solid ${T.lineHard}`, borderRadius: 6, overflow: "hidden" }}>
    {options.map((o, i) => <button key={o.v} onClick={() => onChange(o.v)} style={{ padding: "6px 11px", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: T.sans, borderRight: i < options.length - 1 ? `1px solid ${T.lineSoft}` : "none", background: value === o.v ? "rgba(90,209,255,.16)" : T.sunk, color: value === o.v ? T.accent : T.mute }}>{o.l}</button>)}
  </div>;
}
function Btn({ children, onClick, disabled, accent, danger }) {
  const col = danger ? T.neg : accent ? T.accent : T.text;
  const bd = danger ? "rgba(255,90,122,.4)" : accent ? T.accentDim : T.lineHard;
  return <button onClick={onClick} disabled={disabled} style={{ padding: "7px 12px", borderRadius: 6, cursor: disabled ? "not-allowed" : "pointer", fontSize: 12.5, fontWeight: 600, fontFamily: T.sans, background: disabled ? T.panel2 : accent ? "rgba(90,209,255,.14)" : danger ? "rgba(255,90,122,.12)" : T.panel, color: disabled ? T.mute : col, border: `1px solid ${disabled ? T.lineSoft : bd}`, opacity: disabled ? 0.5 : 1 }}>{children}</button>;
}
function EventBtn({ color, title, desc, onClick }) {
  return <button onClick={onClick} style={{ textAlign: "left", padding: "8px 10px", borderRadius: 6, cursor: "pointer", background: T.sunk, border: `1px solid ${T.lineHard}`, display: "flex", gap: 9, alignItems: "flex-start" }}>
    <span style={{ width: 9, height: 9, borderRadius: 3, marginTop: 3, flexShrink: 0, background: color, boxShadow: `0 0 6px ${color}` }} />
    <span><span style={{ display: "block", fontSize: 12.5, color: T.text, fontWeight: 600 }}>{title}</span>
      <span style={{ display: "block", fontSize: 11, color: T.mute, lineHeight: 1.35, marginTop: 1 }}>{desc}</span></span>
  </button>;
}
function Divider() { return <div style={{ width: 1, height: 30, background: T.line }} />; }
function GridOverlay() {
  return <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", opacity: 0.5 }}>
    <defs><pattern id="g" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M 48 0 L 0 0 0 48" fill="none" stroke={T.accent} strokeWidth="0.4" opacity="0.16" /></pattern></defs>
    <rect width="100%" height="100%" fill="url(#g)" />
    <line x1="50%" y1="0" x2="50%" y2="100%" stroke={T.accent} strokeWidth="0.6" opacity="0.28" />
    <line x1="0" y1="50%" x2="100%" y2="50%" stroke={T.accent} strokeWidth="0.6" opacity="0.28" />
  </svg>;
}
function CamBadge({ mode, camMode, running }) {
  return <div style={{ position: "absolute", left: 12, bottom: 12, display: "flex", gap: 8, fontFamily: T.mono, fontSize: 11 }}>
    <span style={{ padding: "4px 9px", borderRadius: 5, background: "rgba(0,0,0,.55)", border: `1px solid ${T.lineHard}`, color: T.accent }}>◉ {mode}</span>
    <span style={{ padding: "4px 9px", borderRadius: 5, background: "rgba(0,0,0,.55)", border: `1px solid ${T.lineHard}`, color: T.dim }}>{camMode === "orbita" ? "◐ Orbitale" : "✈ Libera"}</span>
    {!running && <span style={{ padding: "4px 9px", borderRadius: 5, background: "rgba(0,0,0,.55)", border: `1px solid ${T.warn}`, color: T.warn }}>⏸ PAUSA</span>}
  </div>;
}
function PlotToggle({ windows, onToggle }) {
  const labels = { lum: "L(t)", mass: "M(t)", temp: "T(t)", mdot: "Ṁ(t)" };
  return <div style={{ position: "absolute", top: 12, right: 12, display: "flex", gap: 5 }}>
    {Object.keys(labels).map((k) => <button key={k} onClick={() => onToggle(k)} style={{ padding: "5px 9px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontFamily: T.mono, fontWeight: 600, background: windows[k].open ? "rgba(90,209,255,.16)" : "rgba(0,0,0,.5)", color: windows[k].open ? T.accent : T.dim, border: `1px solid ${windows[k].open ? T.accentDim : T.lineHard}` }}>▢ {labels[k]}</button>)}
  </div>;
}
/* finestra con serie temporale live (legge sim.current.series) */
function PlotWindow({ def, seriesRef, x, y, onMove, onClose }) {
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  useEffect(() => {
    let raf;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = canvasRef.current; if (!cv) return;
      const ctx = cv.getContext("2d"); const W = cv.width, H = cv.height, pad = 34;
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = T.lineHard; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad, 8); ctx.lineTo(pad, H - pad); ctx.lineTo(W - 8, H - pad); ctx.stroke();
      const s = seriesRef.current; const series = s?.series || [];
      if (series.length < 2) { ctx.fillStyle = T.mute; ctx.font = "10px ui-monospace,monospace"; ctx.fillText("in attesa di dati…", pad + 10, H / 2); return; }
      const ys = series.map(def.pick); const ts = series.map((p) => p.t);
      let ymin = Math.min(...ys), ymax = Math.max(...ys); if (ymax === ymin) ymax = ymin + Math.abs(ymin || 1) * 0.1 + 1e-9;
      const t0 = ts[0], t1 = ts[ts.length - 1] || t0 + 1;
      ctx.strokeStyle = "rgba(120,140,160,.12)";
      for (let i = 1; i <= 4; i++) { const yy = 8 + ((H - pad - 8) * i) / 5; ctx.beginPath(); ctx.moveTo(pad, yy); ctx.lineTo(W - 8, yy); ctx.stroke(); }
      ctx.strokeStyle = def.color; ctx.lineWidth = 1.8; ctx.beginPath();
      series.forEach((p, i) => {
        const px = pad + ((W - 8 - pad) * (ts[i] - t0)) / (t1 - t0 || 1);
        const py = (H - pad) - ((H - pad - 8) * (ys[i] - ymin)) / (ymax - ymin);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.fillStyle = T.dim; ctx.font = "9px ui-monospace,monospace";
      ctx.fillText(fmtNum(ymax), pad + 3, 13); ctx.fillText(fmtNum(ymin), pad + 3, H - pad - 3);
      ctx.fillStyle = T.mute; ctx.fillText(def.ylab, pad + 3, 24);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [def, seriesRef]);

  const down = (e) => { dragRef.current = { mx: e.clientX, my: e.clientY, x, y }; };
  const move = (e) => { if (!dragRef.current) return; const d = dragRef.current; onMove(d.x + (e.clientX - d.mx), d.y + (e.clientY - d.my)); };
  const up = () => { dragRef.current = null; };
  useEffect(() => { window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); }; });

  return <div style={{ position: "absolute", left: x, top: y, width: 270, background: T.panel, border: `1px solid ${T.lineHard}`, borderRadius: 8, boxShadow: "0 8px 30px rgba(0,0,0,.6)", zIndex: 20, overflow: "hidden" }}>
    <div onPointerDown={down} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", background: T.panel2, borderBottom: `1px solid ${T.line}`, cursor: "grab" }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: def.color }} />
      <span style={{ fontSize: 11.5, fontWeight: 600, color: T.text, flex: 1 }}>{def.title}</span>
      <button onClick={onClose} style={{ width: 20, height: 20, borderRadius: 4, border: `1px solid ${T.lineHard}`, background: T.sunk, color: T.mute, cursor: "pointer", fontSize: 13, lineHeight: 1 }}>×</button>
    </div>
    <canvas ref={canvasRef} width={270} height={150} style={{ display: "block", width: 270, height: 150 }} />
  </div>;
}
function fmtNum(x) {
  if (x === 0) return "0"; const a = Math.abs(x);
  if (a >= 1e-3 && a < 1e5) return x.toPrecision(3);
  const e = Math.floor(Math.log10(a)); return `${(x / Math.pow(10, e)).toFixed(1)}e${e}`;
}
