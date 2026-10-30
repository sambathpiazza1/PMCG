import { useState, useEffect, useRef } from "react";

// ─── COSTANTI FISICHE ─────────────────────────────────────────────────────────
const C_LUCE = 299792458;
const EPS0 = 8.854e-12;
const MU0 = 4 * Math.PI * 1e-7;
const F_REL_H2O = 17.5e9; // frequenza rilassamento Debye acqua @20°C
const RHO_CU = 1.72e-8; // resistività rame Ω·m
const V_BAT = 3.3;

const F_WPT = [
  { id: 85e3, label: "85 kHz", note: "standard SAE J2954" },
  { id: 145e3, label: "145 kHz", note: "bobine compatte" },
  { id: 300e3, label: "300 kHz", note: "Q alto, suolo ancora ok" },
  { id: 6.78e6, label: "6.78 MHz", note: "ISM — suolo penalizzante" },
];

const BANDE = {
  169: { label: "169 MHz", duty: 10, erp: 27, note: "M-Bus wireless — max penetrazione" },
  433: { label: "433 MHz", duty: 10, erp: 10, note: "ISM SRD — compromesso" },
  868: { label: "868 MHz", duty: 1, erp: 14, note: "LoRaWAN EU — banda matura" },
};

const TERRENI = {
  sabbioso: { k: 0.5, label: "Sabbioso", col: "#8a6a42" },
  limoso: { k: 1.0, label: "Limoso", col: "#6b5033" },
  argilloso: { k: 2.0, label: "Argilloso", col: "#4d3a26" },
};

const SNR_LIM = { 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };

// ─── MODELLO DIELETTRICO DEL SUOLO ────────────────────────────────────────────
function suolo(fMHz, theta, kTerr) {
  const f = fMHz * 1e6;
  const w = 2 * Math.PI * f;
  // Topp (1980) — permittività reale da contenuto idrico volumetrico
  const e1 = 3.03 + 9.3 * theta + 146 * theta * theta - 76.7 * Math.pow(theta, 3);
  // conducibilità DC (S/m) modulata dal tipo di terreno
  const sigma = (0.005 + 0.15 * theta) * kTerr;
  // rilassamento dipolare dell'acqua libera
  const eH2O = (75.1 * (f / F_REL_H2O)) / (1 + Math.pow(f / F_REL_H2O, 2));
  const e2 = sigma / (w * EPS0) + theta * eH2O;
  const tand = e2 / e1;
  const alphaNp = w * Math.sqrt(((MU0 * EPS0 * e1) / 2) * (Math.sqrt(1 + tand * tand) - 1));
  return {
    e1,
    e2,
    sigma,
    tand,
    alphaDb: 8.686 * alphaNp,
    lambdaSuolo: C_LUCE / (f * Math.sqrt(e1)),
  };
}

// ─── RADIO LoRa: sensibilità, tempo in aria, bitrate ──────────────────────────
function radio(sf, bwHz) {
  const sens = -174 + 10 * Math.log10(bwHz) + 6 + SNR_LIM[sf];
  const Tsym = Math.pow(2, sf) / bwHz;
  const DE = sf >= 11 ? 1 : 0;
  const PL = 20; // payload byte
  const CR = 1; // 4/5
  const nSym =
    8 + Math.max(Math.ceil((8 * PL - 4 * sf + 28 + 16) / (4 * (sf - 2 * DE))) * (CR + 4), 0);
  const toa = 12.25 * Tsym + nSym * Tsym;
  const br = (sf * (bwHz / Math.pow(2, sf)) * 4) / (4 + CR);
  return { sens, toa, br };
}

// ─── BILANCIO DI TRATTA ───────────────────────────────────────────────────────
function tratta(d, fMHz, interrata, prof, hAnt, sl, veg) {
  const dd = Math.max(d, 1);
  const fspl = 20 * Math.log10(dd) + 20 * Math.log10(fMHz) - 27.55;
  const lambda = C_LUCE / (fMHz * 1e6);
  let fresnel = 0;
  if (!interrata) {
    const v = -hAnt * Math.sqrt(8 / (lambda * dd));
    fresnel =
      v > -0.78
        ? Math.max(0, 6.9 + 20 * Math.log10(Math.sqrt(Math.pow(v - 0.1, 2) + 1) + v - 0.1))
        : 0;
  }
  const lSuolo = interrata ? 2 * sl.alphaDb * prof + 6 : 0;
  const lVeg = (veg * dd) / 100;
  return { fspl, fresnel, lSuolo, lVeg, tot: fspl + fresnel + lSuolo + lVeg };
}

function margine(d, p) {
  const G = p.interrata ? -3 : 2;
  const t = tratta(d, p.fMHz, p.interrata, p.prof, p.hAnt, p.sl, p.veg);
  return { ...t, mar: p.ptx + 2 * G - t.tot - p.sens, G };
}

function portataMax(p, target) {
  let lo = 1,
    hi = 12000;
  if (margine(lo, p).mar < target) return 0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (margine(mid, p).mar >= target) lo = mid;
    else hi = mid;
  }
  return lo;
}

// ─── INTEGRALI ELLITTICI COMPLETI (AGM) ───────────────────────────────────────
function ellipKE(m) {
  let a = 1,
    b = Math.sqrt(Math.max(0, 1 - m)),
    c = Math.sqrt(Math.max(0, m));
  let sum = (c * c) / 2,
    pow = 1;
  for (let n = 0; n < 12; n++) {
    const an = (a + b) / 2;
    const bn = Math.sqrt(a * b);
    c = (a - b) / 2;
    a = an;
    b = bn;
    sum += pow * c * c;
    pow *= 2;
  }
  const K = Math.PI / (2 * a);
  return { K, E: K * (1 - sum) };
}

// campo assiale di una spira circolare in un punto fuori asse (ρ, z)
function bzSpira(a, rho, z) {
  const den = Math.pow(a + rho, 2) + z * z;
  const m = Math.min((4 * a * rho) / den, 0.999999);
  const { K, E } = ellipKE(m);
  const q = Math.pow(a - rho, 2) + z * z;
  return ((MU0 / (2 * Math.PI * Math.sqrt(den))) * (K + (E * (a * a - rho * rho - z * z)) / q));
}

// autoinduttanza di una bobina circolare a strato singolo
function induttanza(N, r, rw) {
  return MU0 * N * N * r * Math.max(0.5, Math.log((8 * r) / rw) - 2);
}

function bobina(N, r, rw, f, litz) {
  const L = induttanza(N, r, rw);
  const Rdc = (RHO_CU * 2 * Math.PI * r * N) / (Math.PI * rw * rw);
  const dCu = Math.sqrt(RHO_CU / (Math.PI * f * MU0));
  const kSkin = litz ? 1 : Math.max(1, rw / (2 * dCu));
  const kProx = Math.min(1 + 0.15 * (N - 1), 4);
  const R = Rdc * kSkin * kProx;
  return { L, R, Q: Math.min((2 * Math.PI * f * L) / R, 500) };
}

// ─── ACCOPPIAMENTO RISONANTE TRATTORE → SFERA ─────────────────────────────────
function wpt(p, rho) {
  const tx = bobina(p.N1, p.a, p.rwTx, p.f, p.litz);
  const rx = bobina(p.N2, p.b, p.rwRx, p.f, p.litz);
  const Lrx = rx.L * p.ferr;
  const M =
    Math.abs(bzSpira(p.a, rho, p.z)) *
    p.N1 *
    p.N2 *
    Math.PI *
    p.b *
    p.b *
    p.ferr *
    Math.cos((p.tilt * Math.PI) / 180);
  // profondità di penetrazione nel suolo alla frequenza di carica
  const dSuolo = Math.sqrt(2 / (2 * Math.PI * p.f * MU0 * p.sigma));
  const att = Math.exp(-p.prof / dSuolo);
  const k = (M / Math.sqrt(tx.L * Lrx)) * att;
  const U = k * Math.sqrt(tx.Q * rx.Q);
  const eta = (U * U) / Math.pow(1 + Math.sqrt(1 + U * U), 2);
  return {
    M,
    k,
    U,
    eta,
    dSuolo,
    Qtx: tx.Q,
    Qrx: rx.Q,
    Ltx: tx.L,
    Lrx,
    pRx: Math.min(eta * p.ptx * p.etaRect, p.pmaxRx),
  };
}

// energia raccolta in un singolo passaggio del trattore, con scostamento laterale
function passaggio(p, vKmh, yOff, nSamp = 70) {
  const v = Math.max(vKmh, 0.1) / 3.6;
  const X = p.a * 4 + 2;
  const step = X / nSamp;
  let E = 0,
    pPeak = 0;
  for (let i = 0; i <= nSamp; i++) {
    const x = i * step;
    const pr = wpt(p, Math.sqrt(x * x + yOff * yOff)).pRx;
    if (pr > pPeak) pPeak = pr;
    E += (i === 0 ? 1 : 2) * pr * (step / v);
  }
  return { E, pPeak };
}

// ─── UI PRIMITIVE ─────────────────────────────────────────────────────────────
function SliderRow({ label, min, max, step, value, onChange, display }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "#5f5e5a" }}>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#185FA5" }}>{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: "#185FA5" }}
      />
    </div>
  );
}

function ResultBox({ label, value, unit, color }) {
  return (
    <div
      style={{
        background: "white",
        border: "1px solid #d3d1c7",
        borderRadius: 8,
        padding: "8px 6px",
        textAlign: "center",
        flex: 1,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 9,
          color: "#888780",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, color, marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 9, color: "#888780" }}>{unit}</div>
    </div>
  );
}

function NumIn({ value, onChange, step, w, dis }) {
  return (
    <input
      type="number"
      value={value}
      step={step || 0.1}
      disabled={dis}
      onChange={(e) => onChange(Math.max(0, parseFloat(e.target.value) || 0))}
      style={{
        width: w || 50,
        fontSize: 11,
        padding: "3px 4px",
        border: "1px solid #d3d1c7",
        borderRadius: 4,
        background: dis ? "#f1efe8" : "#fafaf8",
        color: dis ? "#888780" : "#2c2c2a",
        textAlign: "right",
      }}
    />
  );
}

function Segmented({ options, value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          style={{
            flex: 1,
            padding: "7px 0",
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 700,
            background: value === o.id ? "#185FA5" : "#e8e6df",
            color: value === o.id ? "white" : "#5f5e5a",
            transition: "all 0.15s",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const colMar = (m) => (m >= 10 ? "#1D9E75" : m >= 0 ? "#EF9F27" : "#E24B4A");
const seed = (i) => {
  const x = Math.sin(i * 127.1) * 43758.5453;
  return x - Math.floor(x);
};

// ─── VISTA X: GRIGLIA DALL'ALTO ───────────────────────────────────────────────
function ViewGrid({ Nx, Ny, passo, campoW, campoH, torre, marOrto, marDiag, portata }) {
  const cvRef = useRef(null);
  const animRef = useRef(null);

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const H = 320;

    function resize() {
      cv.width = cv.offsetWidth * dpr;
      cv.height = H * dpr;
    }
    resize();

    const N = Nx * Ny;
    const dettaglio = N <= 900;
    const ti = torre === "angolo" ? 0 : Math.floor((Nx - 1) / 2);
    const tj = torre === "angolo" ? 0 : Math.floor((Ny - 1) / 2);

    function draw(ts) {
      const t = ts / 1000;
      const W = cv.offsetWidth;
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // sfondo campo
      ctx.fillStyle = "#141a0e";
      ctx.fillRect(0, 0, W, H);

      const pad = 34;
      const sc = Math.min((W - 2 * pad) / campoW, (H - 2 * pad) / campoH);
      const fw = campoW * sc,
        fh = campoH * sc;
      const ox = (W - fw) / 2,
        oy = (H - fh) / 2;

      // terreno arato
      ctx.fillStyle = "#2b3a1c";
      ctx.fillRect(ox, oy, fw, fh);
      ctx.strokeStyle = "rgba(120,150,80,0.13)";
      ctx.lineWidth = 1;
      for (let y = oy; y < oy + fh; y += 7) {
        ctx.beginPath();
        ctx.moveTo(ox, y);
        ctx.lineTo(ox + fw, y);
        ctx.stroke();
      }
      ctx.strokeStyle = "rgba(200,220,160,0.35)";
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(ox, oy, fw, fh);
      ctx.setLineDash([]);

      const px = (i) => ox + i * passo * sc;
      const py = (j) => oy + j * passo * sc;

      // cerchio di portata attorno alla torre
      const rPx = portata * sc;
      if (rPx > 4 && rPx < Math.max(W, H) * 2) {
        const g = ctx.createRadialGradient(px(ti), py(tj), 0, px(ti), py(tj), rPx);
        g.addColorStop(0, "rgba(24,95,165,0.20)");
        g.addColorStop(1, "rgba(24,95,165,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px(ti), py(tj), rPx, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(110,170,235,0.45)";
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px(ti), py(tj), rPx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // link mesh
      if (dettaglio) {
        if (marDiag > 0) {
          ctx.strokeStyle = colMar(marDiag) + "44";
          ctx.setLineDash([2, 3]);
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          for (let i = 0; i < Nx - 1; i++)
            for (let j = 0; j < Ny - 1; j++) {
              ctx.moveTo(px(i), py(j));
              ctx.lineTo(px(i + 1), py(j + 1));
              ctx.moveTo(px(i + 1), py(j));
              ctx.lineTo(px(i), py(j + 1));
            }
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.strokeStyle = colMar(marOrto) + (marOrto >= 0 ? "cc" : "66");
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        for (let i = 0; i < Nx; i++)
          for (let j = 0; j < Ny; j++) {
            if (i < Nx - 1) {
              ctx.moveTo(px(i), py(j));
              ctx.lineTo(px(i + 1), py(j));
            }
            if (j < Ny - 1) {
              ctx.moveTo(px(i), py(j));
              ctx.lineTo(px(i), py(j + 1));
            }
          }
        ctx.stroke();
      }

      // sfere
      const rN = Math.max(2, Math.min(6, passo * sc * 0.13));
      for (let i = 0; i < Nx; i++)
        for (let j = 0; j < Ny; j++) {
          if (i === ti && j === tj) continue;
          const x = px(i),
            y = py(j);
          const pulse = dettaglio ? 0.5 + 0.5 * Math.sin(t * 1.6 + (i + j) * 0.5) : 1;
          ctx.beginPath();
          ctx.arc(x, y, rN + 2.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(24,95,165,${0.16 * pulse})`;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y, rN, 0, Math.PI * 2);
          ctx.fillStyle = "#185FA5";
          ctx.fill();
          if (rN > 3.2) {
            ctx.beginPath();
            ctx.arc(x - rN * 0.3, y - rN * 0.3, rN * 0.35, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(255,255,255,0.55)";
            ctx.fill();
          }
        }

      // pacchetti in transito verso la torre
      if (dettaglio && marOrto >= 0) {
        for (let k = 0; k < 4; k++) {
          const si = Math.floor(seed(k * 3 + 1) * Nx);
          const sj = Math.floor(seed(k * 3 + 2) * Ny);
          const dx = Math.abs(si - ti),
            dy = Math.abs(sj - tj);
          const tot = dx + dy;
          if (tot === 0) continue;
          const prog = ((t * 0.55 + k * 0.25) % 1) * tot;
          let hx, hy;
          if (prog <= dx) {
            hx = si + (ti - si) * (prog / Math.max(dx, 0.001));
            hy = sj;
          } else {
            hx = ti;
            hy = sj + (tj - sj) * ((prog - dx) / Math.max(dy, 0.001));
          }
          const x = px(hx),
            y = py(hy);
          ctx.beginPath();
          ctx.arc(x, y, 3.2, 0, Math.PI * 2);
          ctx.fillStyle = "#EF9F27";
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y, 7, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(239,159,39,0.22)";
          ctx.fill();
        }
      }

      // torre / gateway
      const tx = px(ti),
        ty = py(tj);
      for (let r = 0; r < 3; r++) {
        const rr = ((t * 26 + r * 22) % 66) + 8;
        ctx.beginPath();
        ctx.arc(tx, ty, rr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(29,158,117,${0.4 * (1 - rr / 74)})`;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
      ctx.strokeStyle = "#1D9E75";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tx - 7, ty + 9);
      ctx.lineTo(tx, ty - 12);
      ctx.lineTo(tx + 7, ty + 9);
      ctx.moveTo(tx - 4, ty + 1);
      ctx.lineTo(tx + 4, ty + 1);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tx, ty - 14, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = "#1D9E75";
      ctx.fill();
      ctx.fillStyle = "#1D9E75";
      ctx.font = "bold 9px Helvetica";
      ctx.textAlign = "center";
      ctx.fillText("TORRE", tx, ty + 21);

      // quota passo griglia
      if (Nx > 1 && passo * sc > 26) {
        const ai = ti === 0 ? Nx - 2 : 0;
        const aj = tj === 0 ? Ny - 1 : 0;
        const x1 = px(ai),
          x2 = px(ai + 1),
          yq = py(aj) - 13;
        ctx.strokeStyle = "#EF9F27";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x1, yq);
        ctx.lineTo(x2, yq);
        ctx.moveTo(x1, yq - 3);
        ctx.lineTo(x1, yq + 3);
        ctx.moveTo(x2, yq - 3);
        ctx.lineTo(x2, yq + 3);
        ctx.stroke();
        ctx.fillStyle = "#EF9F27";
        ctx.font = "bold 10px Helvetica";
        ctx.textAlign = "center";
        ctx.fillText(`d = ${passo} m`, (x1 + x2) / 2, yq - 5);
      }

      // assi e scala
      ctx.fillStyle = "rgba(200,220,160,0.55)";
      ctx.font = "9px Helvetica";
      ctx.textAlign = "center";
      ctx.fillText(`${campoW} m`, ox + fw / 2, oy + fh + 13);
      ctx.save();
      ctx.translate(ox - 11, oy + fh / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`${campoH} m`, 0, 0);
      ctx.restore();
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(200,220,160,0.4)";
      ctx.fillText(`${Nx} × ${Ny} = ${N} sfere`, 6, 13);
      if (!dettaglio) ctx.fillText("link non tracciati (>900 nodi)", 6, 25);

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [Nx, Ny, passo, campoW, campoH, torre, marOrto, marDiag, portata]);

  return (
    <canvas
      ref={cvRef}
      style={{ width: "100%", height: 320, borderRadius: 8, display: "block", background: "#141a0e" }}
    />
  );
}

// ─── VISTA Y: SEZIONE SOTTO SUOLO ─────────────────────────────────────────────
function ViewSection({ passo, prof, hAnt, interrata, sl, terr, marOrto, lambdaAria }) {
  const cvRef = useRef(null);
  const animRef = useRef(null);

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const H = 320;

    function resize() {
      cv.width = cv.offsetWidth * dpr;
      cv.height = H * dpr;
    }
    resize();

    const PROF_MAX = 3; // m visualizzati sotto lo zero
    const ALT_MAX = 4; // m visualizzati sopra lo zero

    function draw(ts) {
      const t = ts / 1000;
      const W = cv.offsetWidth;
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const gy = H * 0.42; // linea di campagna
      const vAlt = gy / ALT_MAX; // px per metro sopra
      const vProf = (H - gy) / PROF_MAX; // px per metro sotto

      // cielo
      const sky = ctx.createLinearGradient(0, 0, 0, gy);
      sky.addColorStop(0, "#0a1628");
      sky.addColorStop(1, "#20405e");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, gy);

      // suolo — colore per umidità
      const base = TERRENI[terr].col;
      const soilG = ctx.createLinearGradient(0, gy, 0, H);
      soilG.addColorStop(0, base);
      soilG.addColorStop(1, "#241a10");
      ctx.fillStyle = soilG;
      ctx.fillRect(0, gy, W, H - gy);
      ctx.fillStyle = "#3d6428";
      ctx.fillRect(0, gy - 3, W, 4);

      // inclusioni / scheletro del terreno
      for (let i = 0; i < 90; i++) {
        const x = seed(i) * W;
        const y = gy + seed(i + 200) * (H - gy);
        const r = 0.7 + seed(i + 400) * 1.9;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,240,210,${0.05 + seed(i + 600) * 0.07})`;
        ctx.fill();
      }

      // asse profondità
      ctx.font = "9px Helvetica";
      ctx.textAlign = "left";
      for (let m = 0; m <= PROF_MAX; m += 0.5) {
        const y = gy + m * vProf;
        ctx.setLineDash([2, 6]);
        ctx.strokeStyle = "rgba(255,235,200,0.13)";
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(255,235,200,0.42)";
        ctx.fillText(`-${m.toFixed(1)} m`, 4, y - 2);
      }
      for (let m = 1; m <= ALT_MAX; m++) {
        const y = gy - m * vAlt;
        ctx.setLineDash([2, 6]);
        ctx.strokeStyle = "rgba(180,210,255,0.12)";
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(180,210,255,0.4)";
        ctx.fillText(`+${m} m`, 4, y - 2);
      }

      // tre sfere in sezione
      const xs = [W * 0.22, W * 0.5, W * 0.78];
      const sy = gy + prof * vProf;
      const rS = 15;
      const antY = interrata ? sy : gy - hAnt * vAlt;

      // fascio radio fra le antenne
      for (let k = 0; k < xs.length - 1; k++) {
        const x1 = xs[k],
          x2 = xs[k + 1];
        if (!interrata) {
          // ellisse di Fresnel
          const F1 = 0.5 * Math.sqrt((lambdaAria * passo) / 1);
          const fPx = Math.min((F1 / ALT_MAX) * vAlt, gy * 0.75);
          ctx.beginPath();
          ctx.ellipse((x1 + x2) / 2, antY, (x2 - x1) / 2, fPx, 0, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(24,95,165,0.13)";
          ctx.fill();
          ctx.strokeStyle = "rgba(110,170,235,0.3)";
          ctx.setLineDash([3, 4]);
          ctx.lineWidth = 0.8;
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // pacchetto in volo
        const prog = (t * 0.5 + k * 0.5) % 1;
        const pxk = x1 + (x2 - x1) * prog;
        const arc = interrata ? 0 : Math.sin(prog * Math.PI) * 10;
        ctx.beginPath();
        ctx.arc(pxk, antY - arc, 3, 0, Math.PI * 2);
        ctx.fillStyle = marOrto >= 0 ? "#EF9F27" : "#E24B4A";
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x1, antY);
        ctx.lineTo(x2, antY);
        ctx.strokeStyle = (marOrto >= 0 ? "rgba(239,159,39," : "rgba(226,75,74,") + "0.35)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      xs.forEach((x, idx) => {
        // onde attenuate nel terreno
        for (let r = 0; r < 4; r++) {
          const rr = ((t * 22 + r * 17 + idx * 9) % 68) + 6;
          const attDb = (rr / vProf) * sl.alphaDb;
          const a = Math.max(0, Math.pow(10, -attDb / 40)) * 0.55;
          if (a < 0.02) continue;
          ctx.beginPath();
          ctx.arc(x, sy, rr, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,190,90,${a})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }

        // stelo antenna
        if (!interrata) {
          ctx.strokeStyle = "#C8C6BC";
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(x, sy - rS);
          ctx.lineTo(x, antY);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x, antY, 2.6, 0, Math.PI * 2);
          ctx.fillStyle = "#1D9E75";
          ctx.fill();
        }

        // sfera
        const g = ctx.createRadialGradient(x - 5, sy - 6, 2, x, sy, rS);
        g.addColorStop(0, "#5fa8e8");
        g.addColorStop(0.6, "#185FA5");
        g.addColorStop(1, "#0d3660");
        ctx.beginPath();
        ctx.arc(x, sy, rS, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1;
        ctx.stroke();
        // equatore sensori
        ctx.beginPath();
        ctx.ellipse(x, sy, rS, rS * 0.32, 0, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(29,158,117,0.75)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = "white";
        ctx.font = "bold 7px Helvetica";
        ctx.textAlign = "center";
        ctx.fillText(`S${idx + 1}`, x, sy + 2.5);
      });

      // quota passo orizzontale
      const yq = 16;
      ctx.strokeStyle = "#EF9F27";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xs[0], yq);
      ctx.lineTo(xs[1], yq);
      ctx.moveTo(xs[0], yq - 3);
      ctx.lineTo(xs[0], yq + 3);
      ctx.moveTo(xs[1], yq - 3);
      ctx.lineTo(xs[1], yq + 3);
      ctx.stroke();
      ctx.fillStyle = "#EF9F27";
      ctx.font = "bold 10px Helvetica";
      ctx.textAlign = "center";
      ctx.fillText(`d = ${passo} m  (scala orizz. compressa)`, (xs[0] + xs[1]) / 2, yq - 5);

      // quota profondità
      ctx.strokeStyle = "#1D9E75";
      ctx.lineWidth = 1;
      const xq = W - 26;
      ctx.beginPath();
      ctx.moveTo(xq, gy);
      ctx.lineTo(xq, sy);
      ctx.moveTo(xq - 3, gy);
      ctx.lineTo(xq + 3, gy);
      ctx.moveTo(xq - 3, sy);
      ctx.lineTo(xq + 3, sy);
      ctx.stroke();
      ctx.save();
      ctx.translate(xq - 6, (gy + sy) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = "#1D9E75";
      ctx.font = "bold 9px Helvetica";
      ctx.textAlign = "center";
      ctx.fillText(`${prof.toFixed(2)} m`, 0, 0);
      ctx.restore();

      // etichette suolo
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255,220,170,0.75)";
      ctx.font = "9px Helvetica";
      ctx.fillText(`α = ${sl.alphaDb.toFixed(1)} dB/m`, W - 6, H - 18);
      ctx.fillText(`λ nel suolo = ${(sl.lambdaSuolo * 100).toFixed(0)} cm`, W - 6, H - 6);

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [passo, prof, hAnt, interrata, sl, terr, marOrto, lambdaAria]);

  return (
    <canvas
      ref={cvRef}
      style={{ width: "100%", height: 320, borderRadius: 8, display: "block", background: "#0e1a0a" }}
    />
  );
}

// ─── VISTA Z: CARICA INDUTTIVA DAL TRATTORE ───────────────────────────────────
function ViewCharge({ curva, pPeak, prof, hBob, aTx, bRx, tilt, vTratt, terr, yOff }) {
  const cvRef = useRef(null);
  const animRef = useRef(null);
  const dataRef = useRef(null);
  dataRef.current = { curva, pPeak, prof, hBob, aTx, bRx, tilt, vTratt, terr, yOff };

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const H = 340;
    cv.width = cv.offsetWidth * dpr;
    cv.height = H * dpr;

    function draw(ts) {
      const d = dataRef.current;
      if (!d || !d.curva.length) {
        animRef.current = requestAnimationFrame(draw);
        return;
      }
      const t = ts / 1000;
      const W = cv.offsetWidth;
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const SCENE = H * 0.62;
      const gy = SCENE * 0.55; // linea di campagna
      const X = d.curva[d.curva.length - 1].x; // metà larghezza scena in metri
      const pad = 26;
      const hs = (W - 2 * pad) / (2 * X); // px per metro orizzontale
      const vs = Math.min((SCENE - gy - 12) / Math.max(d.prof + 0.4, 1), 78); // px/m verticale
      const mx = (m) => W / 2 + m * hs;
      const my = (m) => gy + m * vs; // m positivo = sotto terra

      // cielo
      const sky = ctx.createLinearGradient(0, 0, 0, gy);
      sky.addColorStop(0, "#0a1628");
      sky.addColorStop(1, "#22455f");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, gy);

      // suolo
      const sg = ctx.createLinearGradient(0, gy, 0, SCENE);
      sg.addColorStop(0, TERRENI[d.terr].col);
      sg.addColorStop(1, "#221810");
      ctx.fillStyle = sg;
      ctx.fillRect(0, gy, W, SCENE - gy);
      ctx.fillStyle = "#3d6428";
      ctx.fillRect(0, gy - 3, W, 4);
      for (let i = 0; i < 60; i++) {
        ctx.beginPath();
        ctx.arc(seed(i) * W, gy + seed(i + 90) * (SCENE - gy), 0.7 + seed(i + 180) * 1.6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,240,210,${0.05 + seed(i + 270) * 0.06})`;
        ctx.fill();
      }

      // posizione trattore (m), ciclica
      const span = 2 * X + 3;
      const xT = (((t * (d.vTratt / 3.6) + X + 1.5) % span) - X - 1.5) * -1;
      const cx = mx(xT);
      const coilY = gy - d.hBob * vs;

      // linee di campo dalla bobina TX
      const nL = 5;
      for (let i = 1; i <= nL; i++) {
        const rr = (i / nL) * d.aTx * 2.1;
        const phase = (t * 1.6 + i * 0.4) % 1;
        ctx.beginPath();
        ctx.ellipse(cx, coilY, rr * hs, rr * vs * 0.85, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(110,190,255,${0.28 * (1 - i / (nL + 1)) * (0.5 + 0.5 * Math.sin(phase * Math.PI * 2))})`;
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }

      // bobina TX sotto il trattore
      ctx.strokeStyle = "#EF9F27";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(cx - d.aTx * hs, coilY);
      ctx.lineTo(cx + d.aTx * hs, coilY);
      ctx.stroke();
      ctx.lineCap = "butt";
      for (let s = -1; s <= 1; s += 2) {
        ctx.beginPath();
        ctx.arc(cx + s * d.aTx * hs, coilY, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#EF9F27";
        ctx.fill();
      }

      // trattore
      const wheelR = 0.42 * vs,
        wheelF = 0.26 * vs;
      const bodyB = coilY - 6;
      ctx.fillStyle = "#1f2a1a";
      ctx.fillRect(cx - 0.95 * hs, bodyB - 0.75 * vs, 1.9 * hs, 0.75 * vs);
      ctx.fillStyle = "#2f4a24";
      ctx.fillRect(cx - 0.9 * hs, bodyB - 0.7 * vs, 1.8 * hs, 0.62 * vs);
      // cabina
      ctx.fillStyle = "#3a5c2c";
      ctx.fillRect(cx - 0.1 * hs, bodyB - 1.45 * vs, 0.85 * hs, 0.78 * vs);
      ctx.fillStyle = "rgba(160,210,240,0.45)";
      ctx.fillRect(cx - 0.02 * hs, bodyB - 1.35 * vs, 0.68 * hs, 0.5 * vs);
      // scarico
      ctx.fillStyle = "#1f2a1a";
      ctx.fillRect(cx - 0.28 * hs, bodyB - 1.35 * vs, 0.07 * hs, 0.62 * vs);
      for (let s = 0; s < 3; s++) {
        const pr = (t * 0.9 + s * 0.33) % 1;
        ctx.beginPath();
        ctx.arc(cx - 0.24 * hs - pr * 12, bodyB - 1.38 * vs - pr * 26, 2 + pr * 5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(200,200,190,${0.22 * (1 - pr)})`;
        ctx.fill();
      }
      // ruote
      const spin = -t * (d.vTratt / 3.6) * 2;
      [
        [cx + 0.62 * hs, bodyB - wheelR * 0.15, wheelR],
        [cx - 0.72 * hs, bodyB - wheelF * 0.15, wheelF],
      ].forEach(([wx, wy, wr]) => {
        ctx.beginPath();
        ctx.arc(wx, wy, wr, 0, Math.PI * 2);
        ctx.fillStyle = "#15170f";
        ctx.fill();
        ctx.strokeStyle = "#48503a";
        ctx.lineWidth = 2;
        ctx.stroke();
        for (let s = 0; s < 5; s++) {
          const a2 = spin + (s / 5) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(wx, wy);
          ctx.lineTo(wx + Math.cos(a2) * wr * 0.75, wy + Math.sin(a2) * wr * 0.75);
          ctx.strokeStyle = "#48503a";
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      });

      // sfera interrata a x = 0
      const sx = mx(0),
        sy = my(d.prof);
      const rS = Math.max(10, Math.min(16, d.bRx * vs * 1.6));
      // bobina RX inclinata
      const ta = (d.tilt * Math.PI) / 180;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(ta);
      ctx.strokeStyle = "#1D9E75";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-d.bRx * vs * 1.6, 0);
      ctx.lineTo(d.bRx * vs * 1.6, 0);
      ctx.stroke();
      ctx.restore();
      ctx.lineCap = "butt";

      const g = ctx.createRadialGradient(sx - 5, sy - 6, 2, sx, sy, rS);
      g.addColorStop(0, "#5fa8e8");
      g.addColorStop(0.6, "#185FA5");
      g.addColorStop(1, "#0d3660");
      ctx.beginPath();
      ctx.arc(sx, sy, rS, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // potenza istantanea → indicatore di carica
      let pNow = 0;
      const idx = Math.round(((xT + X) / (2 * X)) * (d.curva.length - 1));
      if (idx >= 0 && idx < d.curva.length) pNow = d.curva[idx].p;
      const frac = d.pPeak > 0 ? pNow / d.pPeak : 0;
      if (frac > 0.02) {
        for (let r = 0; r < 3; r++) {
          const rr = ((t * 30 + r * 20) % 60) + rS;
          ctx.beginPath();
          ctx.arc(sx, sy, rr, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(29,158,117,${0.5 * frac * (1 - rr / 78)})`;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }
        // flusso di energia bobina → sfera
        for (let s = 0; s < 5; s++) {
          const pr = (t * 1.3 + s * 0.2) % 1;
          const px2 = cx + (sx - cx) * pr;
          const py2 = coilY + (sy - coilY) * pr;
          ctx.beginPath();
          ctx.arc(px2, py2, 2 + frac * 1.6, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(239,159,39,${0.75 * frac * Math.sin(pr * Math.PI)})`;
          ctx.fill();
        }
      }

      // quota distanza verticale
      ctx.strokeStyle = "#EF9F27";
      ctx.lineWidth = 1;
      const qx = W - 18;
      ctx.beginPath();
      ctx.moveTo(qx, coilY);
      ctx.lineTo(qx, sy);
      ctx.moveTo(qx - 3, coilY);
      ctx.lineTo(qx + 3, coilY);
      ctx.moveTo(qx - 3, sy);
      ctx.lineTo(qx + 3, sy);
      ctx.stroke();
      ctx.save();
      ctx.translate(qx - 6, (coilY + sy) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = "#EF9F27";
      ctx.font = "bold 9px Helvetica";
      ctx.textAlign = "center";
      ctx.fillText(`z = ${(d.hBob + d.prof).toFixed(2)} m`, 0, 0);
      ctx.restore();

      ctx.fillStyle = "rgba(200,220,240,0.55)";
      ctx.font = "9px Helvetica";
      ctx.textAlign = "left";
      ctx.fillText(`${d.vTratt} km/h · scostamento ${d.yOff.toFixed(1)} m`, 6, 13);

      // ─── grafico potenza ricevuta ───
      const gTop = SCENE + 10,
        gH = H - gTop - 16;
      ctx.fillStyle = "#12100c";
      ctx.fillRect(0, SCENE, W, H - SCENE);
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(pad, gTop + gH);
      ctx.lineTo(W - pad, gTop + gH);
      ctx.stroke();

      const peak = Math.max(d.pPeak, 1e-6);
      ctx.beginPath();
      ctx.moveTo(mx(d.curva[0].x), gTop + gH);
      d.curva.forEach((pt) => ctx.lineTo(mx(pt.x), gTop + gH - (pt.p / peak) * gH));
      ctx.lineTo(mx(d.curva[d.curva.length - 1].x), gTop + gH);
      ctx.closePath();
      const pg = ctx.createLinearGradient(0, gTop, 0, gTop + gH);
      pg.addColorStop(0, "rgba(29,158,117,0.55)");
      pg.addColorStop(1, "rgba(29,158,117,0.05)");
      ctx.fillStyle = pg;
      ctx.fill();
      ctx.beginPath();
      d.curva.forEach((pt, i) => {
        const X2 = mx(pt.x),
          Y2 = gTop + gH - (pt.p / peak) * gH;
        i === 0 ? ctx.moveTo(X2, Y2) : ctx.lineTo(X2, Y2);
      });
      ctx.strokeStyle = "#1D9E75";
      ctx.lineWidth = 1.6;
      ctx.stroke();

      // marker posizione trattore
      const myk = gTop + gH - (pNow / peak) * gH;
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = "rgba(239,159,39,0.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, gTop);
      ctx.lineTo(cx, gTop + gH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(cx, myk, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#EF9F27";
      ctx.fill();

      ctx.fillStyle = "rgba(255,220,170,0.85)";
      ctx.font = "bold 10px Helvetica";
      ctx.textAlign = "left";
      ctx.fillText(`P ricevuta = ${pNow.toFixed(2)} W`, pad, gTop + 11);
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.font = "9px Helvetica";
      ctx.fillText(`picco ${peak.toFixed(2)} W`, W - pad, gTop + 11);
      ctx.textAlign = "center";
      ctx.fillText("posizione del trattore lungo il passaggio (m)", W / 2, H - 4);

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  return (
    <canvas
      ref={cvRef}
      style={{ width: "100%", height: 340, borderRadius: 8, display: "block", background: "#0e1a0a" }}
    />
  );
}

// ─── APP PRINCIPALE ───────────────────────────────────────────────────────────
export default function TerraGridCalc() {
  const [banda, setBanda] = useState(868);
  const [passo, setPasso] = useState(60);
  const [campoW, setCampoW] = useState(400);
  const [campoH, setCampoH] = useState(300);
  const [prof, setProf] = useState(0.4);
  const [interrata, setInterrata] = useState(false);
  const [hAnt, setHAnt] = useState(1.2);
  const [theta, setTheta] = useState(0.22);
  const [terr, setTerr] = useState("limoso");
  const [veg, setVeg] = useState(3);
  const [ptx, setPtx] = useState(14);
  const [sf, setSf] = useState(9);
  const [periodo, setPeriodo] = useState(15);
  const [torre, setTorre] = useState("angolo");
  const [view, setView] = useState("X");

  // carica induttiva
  const [fWpt, setFWpt] = useState(145e3);
  const [aTx, setATx] = useState(0.9);
  const [n1, setN1] = useState(12);
  const [bRx, setBRx] = useState(0.1);
  const [n2, setN2] = useState(80);
  const [hBob, setHBob] = useState(0.3);
  const [ptxW, setPtxW] = useState(500);
  const [pMaxRx, setPMaxRx] = useState(10);
  const [vTratt, setVTratt] = useState(6);
  const [yOff, setYOff] = useState(0);
  const [tilt, setTilt] = useState(0);
  const [litz, setLitz] = useState(true);
  const [ferrite, setFerrite] = useState(true);
  const [capBat, setCapBat] = useState(2400);

  // distinta della scheda madre
  const [comp, setComp] = useState([
    { id: 1, on: true, nome: "MCU nRF52840 — elaborazione", tipo: "ciclo", mA: 4.2, s: 0.8 },
    { id: 2, on: true, nome: "MCU — sleep con RTC e RAM", tipo: "sempre", uA: 2.5 },
    { id: 3, on: true, nome: "Radio LoRa SX1262 — TX", tipo: "radio-tx" },
    { id: 4, on: true, nome: "Radio LoRa SX1262 — ascolto", tipo: "radio-rx", mA: 11.5, mult: 3 },
    { id: 5, on: true, nome: "Sensore umidità/temperatura suolo", tipo: "ciclo", mA: 1.5, s: 1.5 },
    { id: 6, on: true, nome: "Sonda conducibilità EC", tipo: "ciclo", mA: 8, s: 2 },
    { id: 7, on: true, nome: "Accelerometro — assetto sfera", tipo: "sempre", uA: 3 },
    { id: 8, on: true, nome: "Regolatore buck — riposo", tipo: "sempre", uA: 3.5 },
    { id: 9, on: true, nome: "BMS + raddrizzatore di carica", tipo: "sempre", uA: 8 },
    { id: 10, on: true, nome: "Memoria flash — scrittura dato", tipo: "ciclo", mA: 6, s: 0.05 },
    { id: 11, on: false, nome: "Sensore NPK ottico", tipo: "ciclo", mA: 32, s: 3 },
    { id: 12, on: false, nome: "Modem satellitare di riserva", tipo: "ciclo", mA: 145, s: 6 },
  ]);
  const setC = (id, campo, val) =>
    setComp((cs) => cs.map((c) => (c.id === id ? { ...c, [campo]: val } : c)));

  const sl = suolo(banda, theta, TERRENI[terr].k);
  const rd = radio(sf, 125000);
  const P = { fMHz: banda, interrata, prof, hAnt, sl, veg, ptx, sens: rd.sens };

  const orto = margine(passo, P);
  const diag = margine(passo * Math.SQRT2, P);
  const portata = portataMax(P, 10);

  const Nx = Math.floor(campoW / passo) + 1;
  const Ny = Math.floor(campoH / passo) + 1;
  const N = Nx * Ny;
  const densita = (N / ((campoW * campoH) / 10000)).toFixed(1);

  const diagOk = diag.mar >= 0;
  const hopMax =
    torre === "angolo"
      ? diagOk
        ? Math.max(Nx - 1, Ny - 1)
        : Nx - 1 + (Ny - 1)
      : diagOk
      ? Math.max(Math.ceil((Nx - 1) / 2), Math.ceil((Ny - 1) / 2))
      : Math.ceil((Nx - 1) / 2) + Math.ceil((Ny - 1) / 2);

  const viciniTorre = torre === "angolo" ? (diagOk ? 3 : 2) : diagOk ? 8 : 4;
  const caricoRelay = Math.max(1, Math.ceil((N - 1) / viciniTorre));
  const dutyRelay = ((caricoRelay * rd.toa) / (periodo * 60)) * 100;
  const dutyLim = BANDE[banda].duty;
  const erpLim = BANDE[banda].erp;

  const passoMax = portata;
  const lambdaAria = C_LUCE / (banda * 1e6);

  // ── carica induttiva ──
  const parW = {
    a: aTx,
    N1: n1,
    rwTx: 0.0015,
    b: bRx,
    N2: n2,
    rwRx: 0.0004,
    f: fWpt,
    litz,
    ferr: ferrite ? 2.2 : 1,
    z: hBob + prof,
    prof,
    tilt,
    sigma: sl.sigma,
    ptx: ptxW,
    etaRect: 0.85,
    pmaxRx: pMaxRx,
  };
  const w0 = wpt(parW, 0);
  const pass = passaggio(parW, vTratt, yOff);
  const passCentro = yOff === 0 ? pass : passaggio(parW, vTratt, 0);

  let corridoio = 0;
  for (let y = 0; y <= aTx * 3 + 1.5; y += 0.1) {
    if (passaggio(parW, vTratt, y, 34).E >= 0.1 * passCentro.E) corridoio = y;
  }

  const curva = [];
  {
    const XW = aTx * 4 + 2;
    for (let i = -60; i <= 60; i++) {
      const x = (i / 60) * XW;
      curva.push({ x, p: wpt(parW, Math.sqrt(x * x + yOff * yOff)).pRx });
    }
  }

  // consumo del nodo, voce per voce
  const cicliGiorno = 1440 / periodo;
  const iTxmA = 15 + (Math.pow(10, ptx / 10) / 1000 / 0.35 / V_BAT) * 1000;
  const nTxCiclo = 1 + hopMax / 2;
  const righe = comp.map((c) => {
    let mA = 0,
      s = 0,
      uMed = 0;
    if (c.tipo === "sempre") {
      uMed = c.on ? c.uA : 0;
    } else {
      if (c.tipo === "radio-tx") {
        mA = iTxmA;
        s = rd.toa * nTxCiclo;
      } else if (c.tipo === "radio-rx") {
        mA = c.mA;
        s = rd.toa * c.mult;
      } else {
        mA = c.mA;
        s = c.s;
      }
      uMed = c.on ? ((mA * s * cicliGiorno) / 86400) * 1000 : 0;
    }
    return { ...c, mAcalc: mA, sCalc: s, uMed };
  });
  const iTot = righe.reduce((a, r) => a + r.uMed, 0);
  const iPicco = Math.max(
    0,
    ...righe.filter((r) => r.on).map((r) => Math.max(r.mAcalc, (r.uA || 0) / 1000))
  );
  const eGiorno = V_BAT * iTot * 1e-6 * 86400;
  const passMese = pass.E > 1e-9 ? (eGiorno * 30) / pass.E : Infinity;
  const autonomia = iTot > 0 ? (capBat * 1000) / iTot / 24 : 0; // giorni
  const giorniPerPassaggio = eGiorno > 0 ? pass.E / eGiorno : 0;

  const warnCarica = passMese > 30;
  const warnSuolo = w0.dSuolo < 3 * (hBob + prof);
  const warnLink = orto.mar < 0;
  const warnDuty = dutyRelay > dutyLim;
  const warnErp = ptx > erpLim;

  const bg = "#f8f7f4";
  const card = {
    background: "white",
    border: "1px solid #d3d1c7",
    borderRadius: 10,
    padding: "12px 14px",
    marginBottom: 10,
  };
  const sec = {
    fontSize: 11,
    fontWeight: 700,
    color: "#444441",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    borderBottom: "1px solid #e0ddd6",
    paddingBottom: 6,
    marginBottom: 10,
  };
  const warnBox = (col, bgc, brd) => ({
    background: bgc,
    border: `1px solid ${brd}`,
    borderRadius: 6,
    padding: "8px 12px",
    fontSize: 12,
    color: col,
    marginTop: 8,
  });

  const PASSI = [20, 30, 40, 60, 80, 100, 150, 200, 300];

  return (
    <div
      style={{
        background: bg,
        minHeight: "100vh",
        padding: "12px 14px",
        fontFamily: "'Helvetica Neue',Arial,sans-serif",
        color: "#2c2c2a",
      }}
    >
      {/* HEADER */}
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "#185FA5",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Progetto Terra
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, color: "#1a1a18", lineHeight: 1.2 }}>
          Griglia sfere — separazione e bilancio di tratta
        </div>
        <div style={{ fontSize: 11, color: "#888780", marginTop: 2 }}>
          Topp 1980 · Debye H₂O · LoRa 125 kHz · mesh multi-hop
        </div>
      </div>

      {/* EQUAZIONI */}
      <div style={card}>
        <div style={sec}>Equazioni fisiche</div>
        <div
          style={{
            background: "#1a1a18",
            borderRadius: 6,
            padding: "10px 12px",
            fontFamily: "Courier New,monospace",
            fontSize: 11,
            lineHeight: 1.85,
            color: "#e8e6df",
          }}
        >
          <span style={{ color: "#888780" }}>{"// permittività reale del suolo (Topp)"}</span>
          <br />
          <span style={{ color: "#EF9F27" }}>ε′</span> = 3.03 + 9.3θ + 146θ² − 76.7θ³
          <br />
          <br />
          <span style={{ color: "#888780" }}>{"// perdita: conduzione + rilassamento acqua"}</span>
          <br />
          <span style={{ color: "#EF9F27" }}>ε″</span> = σ/(ωε₀) + θ·ε″<sub>H₂O</sub>(f)
          <br />
          <br />
          <span style={{ color: "#888780" }}>{"// attenuazione nel terreno"}</span>
          <br />
          <span style={{ color: "#1D9E75" }}>α</span> = ω√(με′/2 · [√(1+tan²δ) − 1]){" "}
          <span style={{ color: "#888780" }}>[Np/m]</span>
          <br />
          <br />
          <span style={{ color: "#888780" }}>{"// spazio libero + ostruzione Fresnel"}</span>
          <br />
          <span style={{ color: "#EF9F27" }}>L</span> = 20log(d) + 20log(f) − 27.55 + J(ν)
          <br />
          <br />
          <span style={{ color: "#888780" }}>{"// margine di collegamento"}</span>
          <br />
          <span style={{ color: "#1D9E75" }}>M</span> = P<sub>tx</sub> + 2G − L<sub>tot</sub> − S
          <sub>rx</sub> <span style={{ color: "#888780" }}>[dB]</span>
        </div>
      </div>

      {/* BANDA + TERRENO + TORRE */}
      <div style={card}>
        <div style={sec}>Configurazione</div>
        <div style={{ fontSize: 10, color: "#888780", marginBottom: 4 }}>Banda radio</div>
        <Segmented
          options={Object.keys(BANDE).map((b) => ({ id: +b, label: BANDE[b].label }))}
          value={banda}
          onChange={setBanda}
        />
        <div style={{ fontSize: 10, color: "#888780", marginBottom: 4 }}>Tipo di terreno</div>
        <Segmented
          options={Object.keys(TERRENI).map((k) => ({ id: k, label: TERRENI[k].label }))}
          value={terr}
          onChange={setTerr}
        />
        <div style={{ fontSize: 10, color: "#888780", marginBottom: 4 }}>Antenna della sfera</div>
        <Segmented
          options={[
            { id: false, label: "Emergente" },
            { id: true, label: "Interrata" },
          ]}
          value={interrata}
          onChange={setInterrata}
        />
        <div style={{ fontSize: 10, color: "#888780", marginBottom: 4 }}>Posizione torre</div>
        <Segmented
          options={[
            { id: "angolo", label: "Angolo campo" },
            { id: "centro", label: "Centro campo" },
          ]}
          value={torre}
          onChange={setTorre}
        />
        <div style={{ fontSize: 11, color: "#888780", marginTop: 2 }}>
          {BANDE[banda].note} · duty cycle {dutyLim}% · ERP max {erpLim} dBm
        </div>
      </div>

      {/* SLIDER */}
      <div style={card}>
        <div style={sec}>Parametri — trascina per modificare</div>
        <SliderRow
          label="Passo griglia d"
          min={20}
          max={300}
          step={5}
          value={passo}
          onChange={setPasso}
          display={`${passo} m`}
        />
        <SliderRow
          label="Lato campo X"
          min={100}
          max={1000}
          step={50}
          value={campoW}
          onChange={setCampoW}
          display={`${campoW} m`}
        />
        <SliderRow
          label="Lato campo Y"
          min={100}
          max={1000}
          step={50}
          value={campoH}
          onChange={setCampoH}
          display={`${campoH} m`}
        />
        <SliderRow
          label="Profondità sfera"
          min={0.1}
          max={2}
          step={0.05}
          value={prof}
          onChange={setProf}
          display={`${prof.toFixed(2)} m`}
        />
        {!interrata && (
          <SliderRow
            label="Altezza antenna sul piano campagna"
            min={0.1}
            max={3}
            step={0.1}
            value={hAnt}
            onChange={setHAnt}
            display={`${hAnt.toFixed(1)} m`}
          />
        )}
        <SliderRow
          label="Umidità volumetrica θ"
          min={0.05}
          max={0.45}
          step={0.01}
          value={theta}
          onChange={setTheta}
          display={`${(theta * 100).toFixed(0)} %`}
        />
        <SliderRow
          label="Attenuazione coltura"
          min={0}
          max={20}
          step={0.5}
          value={veg}
          onChange={setVeg}
          display={`${veg.toFixed(1)} dB/100m`}
        />
        <SliderRow
          label="Potenza TX"
          min={0}
          max={27}
          step={1}
          value={ptx}
          onChange={setPtx}
          display={`${ptx} dBm`}
        />
        <SliderRow
          label="Spreading factor"
          min={7}
          max={12}
          step={1}
          value={sf}
          onChange={setSf}
          display={`SF${sf}`}
        />
        <SliderRow
          label="Periodo di invio"
          min={1}
          max={120}
          step={1}
          value={periodo}
          onChange={setPeriodo}
          display={`${periodo} min`}
        />
      </div>

      {/* RISULTATI */}
      <div style={card}>
        <div style={sec}>Risultati</div>
        <div style={{ display: "flex", gap: 5, marginBottom: 6 }}>
          <ResultBox
            label="Margine ortog."
            value={orto.mar.toFixed(1)}
            unit="dB"
            color={colMar(orto.mar)}
          />
          <ResultBox
            label="Margine diag."
            value={diag.mar.toFixed(1)}
            unit="dB"
            color={colMar(diag.mar)}
          />
          <ResultBox
            label="Passo max"
            value={passoMax > 0 ? passoMax.toFixed(0) : "—"}
            unit="m (10 dB)"
            color="#185FA5"
          />
        </div>
        <div style={{ display: "flex", gap: 5, marginBottom: 6 }}>
          <ResultBox label="Sfere" value={N} unit={`${Nx}×${Ny}`} color="#185FA5" />
          <ResultBox label="Densità" value={densita} unit="sfere/ha" color="#1D9E75" />
          <ResultBox label="Hop max" value={hopMax} unit="salti" color="#BA7517" />
        </div>
        <div style={{ display: "flex", gap: 5, marginBottom: 6 }}>
          <ResultBox
            label="α suolo"
            value={sl.alphaDb.toFixed(1)}
            unit="dB/m"
            color="#BA7517"
          />
          <ResultBox label="Sensibilità" value={rd.sens.toFixed(1)} unit="dBm" color="#185FA5" />
          <ResultBox
            label="Duty relay"
            value={dutyRelay.toFixed(2)}
            unit={`% / lim ${dutyLim}%`}
            color={dutyRelay > dutyLim ? "#E24B4A" : "#1D9E75"}
          />
        </div>
        <div style={{ display: "flex", gap: 5 }}>
          <ResultBox label="Time on air" value={(rd.toa * 1000).toFixed(0)} unit="ms" color="#185FA5" />
          <ResultBox label="Bitrate" value={rd.br.toFixed(0)} unit="bps" color="#1D9E75" />
          <ResultBox
            label="Carico relay"
            value={caricoRelay}
            unit="pacchetti/ciclo"
            color="#BA7517"
          />
        </div>

        {/* Ripartizione perdite */}
        <div
          style={{
            marginTop: 10,
            background: "#f1efe8",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 11,
            color: "#5f5e5a",
            lineHeight: 1.7,
          }}
        >
          <b style={{ color: "#444441" }}>Ripartizione perdite su un salto di {passo} m</b>
          <br />
          Spazio libero {orto.fspl.toFixed(1)} dB · Ostruzione suolo {orto.fresnel.toFixed(1)} dB ·
          Terreno {orto.lSuolo.toFixed(1)} dB · Coltura {orto.lVeg.toFixed(1)} dB ={" "}
          <b>{orto.tot.toFixed(1)} dB</b>
          <br />
          ε′ = {sl.e1.toFixed(1)} · tanδ = {sl.tand.toFixed(3)} · σ = {sl.sigma.toFixed(3)} S/m · λ
          nel suolo = {(sl.lambdaSuolo * 100).toFixed(0)} cm
        </div>

        {warnLink && (
          <div style={warnBox("#712B13", "#FAECE7", "#D85A30")}>
            ⚠️ Margine negativo — il salto di {passo} m non chiude. Riduci il passo sotto{" "}
            {passoMax.toFixed(0)} m, alza l'antenna o sali di SF.
          </div>
        )}
        {warnDuty && (
          <div style={warnBox("#712B13", "#FAECE7", "#D85A30")}>
            ⚠️ Il nodo relay adiacente alla torre supera il {dutyLim}% di duty cycle (
            {dutyRelay.toFixed(1)}%). Allunga il periodo di invio, scendi di SF o distribuisci il
            traffico su più gateway.
          </div>
        )}
        {warnErp && (
          <div style={warnBox("#5c4708", "#FBF3DC", "#C6A02B")}>
            ⓘ {ptx} dBm supera il limite ERP di {erpLim} dBm per la banda {BANDE[banda].label}{" "}
            (salvo sotto-bande dedicate).
          </div>
        )}
      </div>

      {/* CONSUMO SCHEDA MADRE */}
      <div style={card}>
        <div style={sec}>Consumo della scheda — distinta componenti</div>
        <div style={{ fontSize: 11, color: "#888780", marginBottom: 8, lineHeight: 1.6 }}>
          Corrente attiva e tempo di accensione per ciclo. Le righe radio si calcolano da sole dal
          time on air ({(rd.toa * 1000).toFixed(0)} ms), dalla potenza TX ({iTxmA.toFixed(0)} mA a{" "}
          {ptx} dBm) e dai {nTxCiclo.toFixed(1)} pacchetti che il nodo medio trasmette per ciclo.
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: "#f1efe8" }}>
                {["", "Componente", "mA", "s/ciclo", "µA medi", "Quota"].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: "5px 5px",
                      textAlign: "left",
                      fontWeight: 600,
                      color: "#444441",
                      borderBottom: "1px solid #d3d1c7",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {righe.map((r, i) => {
                const quota = iTot > 0 ? (r.uMed / iTot) * 100 : 0;
                const auto = r.tipo.startsWith("radio");
                const sempre = r.tipo === "sempre";
                return (
                  <tr
                    key={r.id}
                    style={{
                      background: i % 2 === 0 ? "#fafaf8" : "#f1efe8",
                      opacity: r.on ? 1 : 0.42,
                    }}
                  >
                    <td style={{ padding: "4px 5px", borderBottom: "1px solid #e8e6e0" }}>
                      <input
                        type="checkbox"
                        checked={r.on}
                        onChange={() => setC(r.id, "on", !r.on)}
                        style={{ accentColor: "#185FA5", cursor: "pointer" }}
                      />
                    </td>
                    <td
                      style={{
                        padding: "4px 5px",
                        borderBottom: "1px solid #e8e6e0",
                        minWidth: 150,
                        color: auto ? "#185FA5" : "#2c2c2a",
                      }}
                    >
                      {r.nome}
                    </td>
                    <td style={{ padding: "4px 5px", borderBottom: "1px solid #e8e6e0" }}>
                      {sempre ? (
                        <span style={{ color: "#888780" }}>—</span>
                      ) : (
                        <NumIn
                          value={auto ? +r.mAcalc.toFixed(1) : r.mA}
                          dis={r.tipo === "radio-tx"}
                          step={0.1}
                          onChange={(v) => setC(r.id, "mA", v)}
                        />
                      )}
                    </td>
                    <td style={{ padding: "4px 5px", borderBottom: "1px solid #e8e6e0" }}>
                      {sempre ? (
                        <NumIn value={r.uA} step={0.5} onChange={(v) => setC(r.id, "uA", v)} />
                      ) : auto ? (
                        <span style={{ color: "#888780" }}>{r.sCalc.toFixed(2)}</span>
                      ) : (
                        <NumIn value={r.s} step={0.05} onChange={(v) => setC(r.id, "s", v)} />
                      )}
                    </td>
                    <td
                      style={{
                        padding: "4px 5px",
                        borderBottom: "1px solid #e8e6e0",
                        fontWeight: 700,
                        color: "#185FA5",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.uMed < 1 ? r.uMed.toFixed(2) : r.uMed.toFixed(1)}
                    </td>
                    <td
                      style={{
                        padding: "4px 5px",
                        borderBottom: "1px solid #e8e6e0",
                        minWidth: 66,
                      }}
                    >
                      <div
                        style={{
                          background: "#e0ddd6",
                          borderRadius: 3,
                          height: 8,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.min(quota, 100)}%`,
                            height: "100%",
                            background:
                              quota > 40 ? "#E24B4A" : quota > 15 ? "#EF9F27" : "#1D9E75",
                          }}
                        />
                      </div>
                      <div style={{ fontSize: 9, color: "#888780", marginTop: 1 }}>
                        {quota.toFixed(1)}%
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ fontSize: 10, color: "#888780", marginTop: 6, marginBottom: 10 }}>
          Nella colonna "s/ciclo" le righe sempre alimentate riportano direttamente i µA assorbiti.
        </div>

        <div style={{ display: "flex", gap: 5, marginBottom: 6 }}>
          <ResultBox
            label="Corrente media"
            value={iTot < 1000 ? iTot.toFixed(1) : (iTot / 1000).toFixed(2)}
            unit={iTot < 1000 ? "µA" : "mA"}
            color={iTot > 500 ? "#E24B4A" : iTot > 150 ? "#EF9F27" : "#1D9E75"}
          />
          <ResultBox label="Consumo" value={eGiorno.toFixed(1)} unit="J/giorno" color="#BA7517" />
          <ResultBox label="Picco" value={iPicco.toFixed(0)} unit="mA istantanei" color="#185FA5" />
        </div>
        <div style={{ display: "flex", gap: 5 }}>
          <ResultBox
            label="Autonomia"
            value={autonomia > 3650 ? ">10" : (autonomia / 365).toFixed(1)}
            unit="anni a batteria"
            color="#1D9E75"
          />
          <ResultBox label="Cicli" value={cicliGiorno.toFixed(0)} unit="al giorno" color="#185FA5" />
          <ResultBox
            label="Un passaggio copre"
            value={giorniPerPassaggio.toFixed(1)}
            unit="giorni"
            color="#BA7517"
          />
        </div>

        <div
          style={{
            marginTop: 10,
            background: "#f1efe8",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 11,
            color: "#5f5e5a",
            lineHeight: 1.7,
          }}
        >
          <b style={{ color: "#444441" }}>Voce dominante</b>
          <br />
          {(() => {
            const top = [...righe].sort((a, b) => b.uMed - a.uMed)[0];
            return top && top.uMed > 0
              ? `${top.nome} — ${top.uMed.toFixed(1)} µA, pari al ${((top.uMed / iTot) * 100).toFixed(0)}% del budget. `
              : "Nessun componente attivo. ";
          })()}
          Carico continuo{" "}
          {righe
            .filter((r) => r.tipo === "sempre")
            .reduce((a, r) => a + r.uMed, 0)
            .toFixed(1)}{" "}
          µA · carico a impulsi{" "}
          {righe
            .filter((r) => r.tipo !== "sempre")
            .reduce((a, r) => a + r.uMed, 0)
            .toFixed(1)}{" "}
          µA su {cicliGiorno.toFixed(0)} cicli al giorno.
        </div>

        {iPicco > 100 && (
          <div style={warnBox("#5c4708", "#FBF3DC", "#C6A02B")}>
            ⓘ Picco di {iPicco.toFixed(0)} mA: serve un condensatore di buffer vicino al regolatore,
            altrimenti la caduta di tensione sotto carico fa resettare l'MCU quando la batteria è
            fredda o scarica.
          </div>
        )}
      </div>

      {/* CARICA INDUTTIVA */}
      <div style={card}>
        <div style={sec}>Carica induttiva dal trattore</div>
        <div
          style={{
            background: "#1a1a18",
            borderRadius: 6,
            padding: "10px 12px",
            fontFamily: "Courier New,monospace",
            fontSize: 11,
            lineHeight: 1.85,
            color: "#e8e6df",
            marginBottom: 10,
          }}
        >
          <span style={{ color: "#888780" }}>{"// mutua induttanza (spira ↔ bobina fuori asse)"}</span>
          <br />
          <span style={{ color: "#EF9F27" }}>M</span> = N₁N₂·πb²·B<sub>z</sub>(ρ,z)·cos φ
          <br />
          <br />
          <span style={{ color: "#888780" }}>{"// figura di merito e rendimento massimo"}</span>
          <br />
          <span style={{ color: "#EF9F27" }}>U</span> = k√(Q₁Q₂) &nbsp;·&nbsp;{" "}
          <span style={{ color: "#1D9E75" }}>η</span> = U² / (1+√(1+U²))²
          <br />
          <br />
          <span style={{ color: "#888780" }}>{"// penetrazione nel suolo conduttivo"}</span>
          <br />
          <span style={{ color: "#1D9E75" }}>δ</span> = √(2 / ωμσ) &nbsp;·&nbsp; k ∝ e^(−p/δ)
        </div>

        <div style={{ fontSize: 10, color: "#888780", marginBottom: 4 }}>Frequenza di carica</div>
        <Segmented
          options={F_WPT.map((x) => ({ id: x.id, label: x.label }))}
          value={fWpt}
          onChange={setFWpt}
        />
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {[
            { st: litz, set: setLitz, on: "Filo Litz", off: "Rame pieno" },
            { st: ferrite, set: setFerrite, on: "Con ferrite", off: "Senza ferrite" },
          ].map((o, i) => (
            <button
              key={i}
              onClick={() => o.set(!o.st)}
              style={{
                flex: 1,
                padding: "7px 0",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 700,
                background: o.st ? "#1D9E75" : "#e8e6df",
                color: o.st ? "white" : "#5f5e5a",
              }}
            >
              {o.st ? o.on : o.off}
            </button>
          ))}
        </div>

        <SliderRow label="Raggio bobina trattore" min={0.2} max={1.5} step={0.05} value={aTx} onChange={setATx} display={`${aTx.toFixed(2)} m`} />
        <SliderRow label="Spire bobina trattore" min={4} max={40} step={1} value={n1} onChange={setN1} display={`${n1}`} />
        <SliderRow label="Altezza bobina da terra" min={0.1} max={1.2} step={0.05} value={hBob} onChange={setHBob} display={`${hBob.toFixed(2)} m`} />
        <SliderRow label="Raggio bobina sfera" min={0.03} max={0.2} step={0.005} value={bRx} onChange={setBRx} display={`${(bRx * 100).toFixed(1)} cm`} />
        <SliderRow label="Spire bobina sfera" min={10} max={300} step={5} value={n2} onChange={setN2} display={`${n2}`} />
        <SliderRow label="Disallineamento angolare" min={0} max={80} step={1} value={tilt} onChange={setTilt} display={`${tilt}°`} />
        <SliderRow label="Potenza inviata" min={20} max={2000} step={20} value={ptxW} onChange={setPtxW} display={`${ptxW} W`} />
        <SliderRow label="Potenza max accettata dalla sfera" min={0.5} max={20} step={0.5} value={pMaxRx} onChange={setPMaxRx} display={`${pMaxRx.toFixed(1)} W`} />
        <SliderRow label="Velocità trattore" min={2} max={25} step={0.5} value={vTratt} onChange={setVTratt} display={`${vTratt.toFixed(1)} km/h`} />
        <SliderRow label="Scostamento laterale dalla sfera" min={0} max={5} step={0.1} value={yOff} onChange={setYOff} display={`${yOff.toFixed(1)} m`} />
        <SliderRow label="Capacità batteria" min={200} max={10000} step={100} value={capBat} onChange={setCapBat} display={`${capBat} mAh`} />

        <div style={{ display: "flex", gap: 5, marginTop: 10, marginBottom: 6 }}>
          <ResultBox label="Accoppiamento k" value={w0.k.toFixed(4)} unit="—" color="#185FA5" />
          <ResultBox label="Merito U" value={w0.U.toFixed(2)} unit="k√(Q₁Q₂)" color="#1D9E75" />
          <ResultBox
            label="Rendimento"
            value={(w0.eta * 100).toFixed(1)}
            unit="%"
            color={w0.eta > 0.3 ? "#1D9E75" : w0.eta > 0.05 ? "#EF9F27" : "#E24B4A"}
          />
        </div>
        <div style={{ display: "flex", gap: 5, marginBottom: 6 }}>
          <ResultBox label="P picco" value={pass.pPeak.toFixed(2)} unit="W" color="#BA7517" />
          <ResultBox label="Energia/passaggio" value={pass.E.toFixed(1)} unit="joule" color="#185FA5" />
          <ResultBox label="Corridoio" value={(2 * corridoio).toFixed(1)} unit="m utili" color="#1D9E75" />
        </div>
        <div style={{ display: "flex", gap: 5 }}>
          <ResultBox label="Consumo sfera" value={eGiorno.toFixed(1)} unit="J/giorno" color="#BA7517" />
          <ResultBox
            label="Passaggi"
            value={passMese > 999 ? "∞" : passMese.toFixed(1)}
            unit="al mese"
            color={passMese > 30 ? "#E24B4A" : "#1D9E75"}
          />
          <ResultBox label="Autonomia" value={(autonomia / 30).toFixed(1)} unit="mesi a batteria" color="#185FA5" />
        </div>

        <div
          style={{
            marginTop: 10,
            background: "#f1efe8",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 11,
            color: "#5f5e5a",
            lineHeight: 1.7,
          }}
        >
          <b style={{ color: "#444441" }}>Bobine e suolo a {F_WPT.find((x) => x.id === fWpt).label}</b>
          <br />
          L₁ = {(w0.Ltx * 1e6).toFixed(0)} µH (Q {w0.Qtx.toFixed(0)}) · L₂ ={" "}
          {(w0.Lrx * 1e6).toFixed(0)} µH (Q {w0.Qrx.toFixed(0)}) · M = {(w0.M * 1e6).toFixed(2)} µH
          <br />
          Spessore di penetrazione nel terreno δ = {w0.dSuolo.toFixed(2)} m — attenuazione a{" "}
          {prof.toFixed(2)} m di profondità: {(20 * Math.log10(Math.exp(prof / w0.dSuolo))).toFixed(1)} dB
        </div>

        {warnSuolo && (
          <div style={warnBox("#5c4708", "#FBF3DC", "#C6A02B")}>
            ⓘ A questa frequenza il terreno non è più trasparente (δ = {w0.dSuolo.toFixed(2)} m,
            confrontabile con z = {(hBob + prof).toFixed(2)} m). Scendi a 85–145 kHz: la potenza
            passa quasi indisturbata e le correnti parassite nel suolo crollano.
          </div>
        )}
        {warnCarica && (
          <div style={warnBox("#712B13", "#FAECE7", "#D85A30")}>
            ⚠️ Servirebbero {passMese > 999 ? "innumerevoli" : passMese.toFixed(0)} passaggi al mese
            per pareggiare il consumo. Allarga la bobina del trattore, avvicinala al suolo, rallenta,
            o riduci il traffico radio del nodo.
          </div>
        )}
      </div>

      {/* VISTE */}
      <div style={card}>
        <div style={sec}>Visualizzazione dinamica</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {[
            { id: "X", label: "X — Griglia" },
            { id: "Y", label: "Y — Sezione" },
            { id: "Z", label: "Z — Carica" },
          ].map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              style={{
                flex: 1,
                padding: "8px 0",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 700,
                background: view === v.id ? "#185FA5" : "#e8e6df",
                color: view === v.id ? "white" : "#5f5e5a",
                transition: "all 0.15s",
              }}
            >
              {v.label}
            </button>
          ))}
        </div>

        {view === "X" && (
          <ViewGrid
            Nx={Nx}
            Ny={Ny}
            passo={passo}
            campoW={campoW}
            campoH={campoH}
            torre={torre}
            marOrto={orto.mar}
            marDiag={diag.mar}
            portata={portata}
          />
        )}
        {view === "Y" && (
          <ViewSection
            passo={passo}
            prof={prof}
            hAnt={hAnt}
            interrata={interrata}
            sl={sl}
            terr={terr}
            marOrto={orto.mar}
            lambdaAria={lambdaAria}
          />
        )}

        {view === "Z" && (
          <ViewCharge
            curva={curva}
            pPeak={pass.pPeak}
            prof={prof}
            hBob={hBob}
            aTx={aTx}
            bRx={bRx}
            tilt={tilt}
            vTratt={vTratt}
            terr={terr}
            yOff={yOff}
          />
        )}

        <div style={{ fontSize: 10, color: "#888780", marginTop: 6, textAlign: "center" }}>
          {view === "X"
            ? "Verde = margine ≥10 dB · arancio = 0–10 dB · rosso = tratta non chiusa. Alone blu = portata dalla torre."
            : view === "Y"
            ? "Sezione verticale: sfere interrate, onde attenuate nel suolo, ellisse di Fresnel fra le antenne."
            : "Il trattore passa sopra la sfera: linee di campo, flusso di energia e curva della potenza raccolta."}
        </div>
      </div>

      {/* TABELLA PASSO */}
      <div style={card}>
        <div style={sec}>Passo griglia vs margine (config. corrente)</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: "#f1efe8" }}>
                {["d (m)", "Margine", "Sfere", "Hop", "Duty relay", "Esito"].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: "5px 6px",
                      textAlign: "left",
                      fontWeight: 600,
                      color: "#444441",
                      borderBottom: "1px solid #d3d1c7",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PASSI.map((d, i) => {
                const m = margine(d, P);
                const md = margine(d * Math.SQRT2, P);
                const nx = Math.floor(campoW / d) + 1;
                const ny = Math.floor(campoH / d) + 1;
                const n = nx * ny;
                const dOk = md.mar >= 0;
                const hop =
                  torre === "angolo"
                    ? dOk
                      ? Math.max(nx - 1, ny - 1)
                      : nx - 1 + (ny - 1)
                    : dOk
                    ? Math.max(Math.ceil((nx - 1) / 2), Math.ceil((ny - 1) / 2))
                    : Math.ceil((nx - 1) / 2) + Math.ceil((ny - 1) / 2);
                const vic = torre === "angolo" ? (dOk ? 3 : 2) : dOk ? 8 : 4;
                const dr = ((Math.ceil((n - 1) / vic) * rd.toa) / (periodo * 60)) * 100;
                const active = Math.abs(d - passo) <= 6;
                const ok = m.mar >= 10 && dr <= dutyLim;
                return (
                  <tr
                    key={d}
                    style={{
                      background: active ? "#e6f1fb" : i % 2 === 0 ? "#fafaf8" : "#f1efe8",
                    }}
                  >
                    <td
                      style={{
                        padding: "5px 6px",
                        fontWeight: active ? 700 : 400,
                        borderBottom: "1px solid #e8e6e0",
                      }}
                    >
                      {d}
                    </td>
                    <td
                      style={{
                        padding: "5px 6px",
                        color: colMar(m.mar),
                        fontWeight: 700,
                        borderBottom: "1px solid #e8e6e0",
                      }}
                    >
                      {m.mar.toFixed(1)}
                    </td>
                    <td style={{ padding: "5px 6px", borderBottom: "1px solid #e8e6e0" }}>{n}</td>
                    <td style={{ padding: "5px 6px", borderBottom: "1px solid #e8e6e0" }}>{hop}</td>
                    <td
                      style={{
                        padding: "5px 6px",
                        color: dr > dutyLim ? "#E24B4A" : "#5f5e5a",
                        borderBottom: "1px solid #e8e6e0",
                      }}
                    >
                      {dr.toFixed(2)}%
                    </td>
                    <td
                      style={{
                        padding: "5px 6px",
                        color: ok ? "#1D9E75" : "#888780",
                        borderBottom: "1px solid #e8e6e0",
                      }}
                    >
                      {m.mar < 0
                        ? "tratta aperta"
                        : dr > dutyLim
                        ? "duty oltre limite"
                        : m.mar < 10
                        ? "margine risicato"
                        : "ok"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* TABELLA DISTANZA ENERGIA */}
      <div style={card}>
        <div style={sec}>Distanza bobina ↔ sfera vs energia trasferita</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: "#f1efe8" }}>
                {["z (m)", "k", "U", "η", "P picco", "J/passaggio", "Passaggi/mese"].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: "5px 6px",
                      textAlign: "left",
                      fontWeight: 600,
                      color: "#444441",
                      borderBottom: "1px solid #d3d1c7",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[0.3, 0.5, 0.7, 1.0, 1.4, 1.8, 2.5, 3.5].map((z, i) => {
                const pz = { ...parW, z };
                const w = wpt(pz, 0);
                const ps = passaggio(pz, vTratt, yOff, 40);
                const pm = ps.E > 1e-9 ? (eGiorno * 30) / ps.E : Infinity;
                const active = Math.abs(z - (hBob + prof)) < 0.12;
                return (
                  <tr
                    key={z}
                    style={{ background: active ? "#e6f1fb" : i % 2 === 0 ? "#fafaf8" : "#f1efe8" }}
                  >
                    <td style={{ padding: "5px 6px", fontWeight: active ? 700 : 400, borderBottom: "1px solid #e8e6e0" }}>{z.toFixed(1)}</td>
                    <td style={{ padding: "5px 6px", borderBottom: "1px solid #e8e6e0" }}>{w.k.toFixed(4)}</td>
                    <td style={{ padding: "5px 6px", borderBottom: "1px solid #e8e6e0" }}>{w.U.toFixed(2)}</td>
                    <td
                      style={{
                        padding: "5px 6px",
                        fontWeight: 700,
                        color: w.eta > 0.3 ? "#1D9E75" : w.eta > 0.05 ? "#EF9F27" : "#E24B4A",
                        borderBottom: "1px solid #e8e6e0",
                      }}
                    >
                      {(w.eta * 100).toFixed(1)}%
                    </td>
                    <td style={{ padding: "5px 6px", borderBottom: "1px solid #e8e6e0" }}>{ps.pPeak.toFixed(2)} W</td>
                    <td style={{ padding: "5px 6px", borderBottom: "1px solid #e8e6e0" }}>{ps.E.toFixed(1)}</td>
                    <td
                      style={{
                        padding: "5px 6px",
                        color: pm > 30 ? "#E24B4A" : "#1D9E75",
                        borderBottom: "1px solid #e8e6e0",
                      }}
                    >
                      {pm > 999 ? "—" : pm.toFixed(1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 10, color: "#888780", marginTop: 6 }}>
          z = altezza bobina + profondità sfera. L'accoppiamento cade con (a²+z²)^1.5: raddoppiare z
          costa molto più che raddoppiare la potenza inviata.
        </div>
      </div>

      <div style={{ fontSize: 10, color: "#aaa9a4", textAlign: "center", paddingBottom: 8 }}>
        Modello semplificato · verificare sempre con rilievo RSSI e prova di carica in campo
      </div>
    </div>
  );
}
