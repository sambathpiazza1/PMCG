import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";

/* ============================================================
   SIMULATORE LIVELLI — sezione tecnica interattiva
   - Righello dei piani a sinistra (attivo al centro).
   - Categoria/nome piano + Tier 1-5 con simbolo.
   - Griglia stanze: righe x colonne, unione rettangoli.
   - Gruppi di stanze: nome auto A1-H3 o personalizzato.
   - Indicazioni standard a colori.
   - ID r+3 cifre in trasparenza in basso a destra.
   - Dotazioni automatiche sui piani Tier >= 3:
       · sala di sicurezza sul lato sinistro
       · decontaminazione su ogni stanza
       · ascensori (1 ogni 5 stanze; 3 centrali se < 5)
   ============================================================ */

const FONTS = {
  mono: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif",
};

// Palette tema scuro
const THEME_DARK = {
  ...FONTS,
  bg: "#0b0f14", panel: "#111823", panel2: "#0d131c", sunk: "#0a0f16",
  line: "#1d2732", lineSoft: "#161f29", lineHard: "#2b3a4b",
  text: "#e7edf4", dim: "#9aa8b8", mute: "#63707f",
  accent: "#f0a24a", accentDim: "#7a5b34", sel: "#4db6e6", ground: "#5b6b7c",
};

// Palette tema chiaro
const THEME_LIGHT = {
  ...FONTS,
  bg: "#f4f6f9", panel: "#ffffff", panel2: "#eef1f6", sunk: "#e7ebf1",
  line: "#d3dae3", lineSoft: "#e2e7ee", lineHard: "#b9c4d1",
  text: "#1b2530", dim: "#4a5a6b", mute: "#8592a1",
  accent: "#c9770f", accentDim: "#e0a866", sel: "#1f8fc4", ground: "#9aa8b8",
};

// T è mutabile: punta alla palette attiva. I sotto-componenti leggono da qui.
// Cambiando theme in App, riassegniamo T e forziamo un re-render globale.
let T = THEME_DARK;
function applyTheme(name) { T = name === "light" ? THEME_LIGHT : THEME_DARK; }

// dotazioni
const SEC = "#ef4444";     // sala sicurezza
const DECON = "#14b8a6";   // decontaminazione
const ELEV = "#8b9dff";    // ascensore
const FIX_THRESHOLD = 3;   // le dotazioni scattano da Tier 3

// gruppi: un colore per lettera A..H
const GROUP_COLORS = { A: "#e879f9", B: "#60a5fa", C: "#34d399", D: "#fbbf24", E: "#fb7185", F: "#a78bfa", G: "#22d3ee", H: "#f97316" };
const groupColor = (g) => (g && g.letter && GROUP_COLORS[g.letter]) || "#94a3b8";

const TIERS = {
  1: { color: "#64748b", label: "Base" },
  2: { color: "#3b82f6", label: "Standard" },
  3: { color: "#f59e0b", label: "Riservato" },
  4: { color: "#f97316", label: "Critico" },
  5: { color: "#ef4444", label: "Massima sicurezza" },
};
const tierColor = (t) => TIERS[t]?.color || T.mute;

const DEFAULT_ROWS = 3;
const DEFAULT_COLS = 4;
const ROW_H = 66;
const GAP = 6;

const DEFAULT_LEGEND = [
  { id: "g1", label: "Uffici", color: "#3b82f6" },
  { id: "g2", label: "Tecnico", color: "#f59e0b" },
  { id: "g3", label: "Servizi", color: "#14b8a6" },
  { id: "g4", label: "Sicurezza", color: "#ef4444" },
  { id: "g5", label: "Percorsi", color: "#22c55e" },
  { id: "g6", label: "Laboratorio", color: "#8b5cf6" },
];

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

function elevatorFractions(cols) {
  if (cols >= 5) {
    const n = Math.floor(cols / 5);
    const arr = [];
    for (let j = 1; j <= n; j++) {
      const centerIndex = 5 * j - 2;
      arr.push((centerIndex - 0.5) / cols);
    }
    return arr;
  }
  return [0.5 - 0.16, 0.5, 0.5 + 0.16];
}

// prossimo nome automatico: A1, A2, A3, B1 ... H3
function nextGroupName(groups) {
  const used = new Set(Object.values(groups).map((g) => g.name));
  for (const L of "ABCDEFGH") for (let n = 1; n <= 3; n++) { const nm = L + n; if (!used.has(nm)) return { name: nm, letter: L }; }
  let k = 1; while (used.has("Gruppo " + k)) k++;
  return { name: "Gruppo " + k, letter: null };
}
// rimuove i gruppi rimasti senza stanze
function pruneGroups(level) {
  const used = new Set(Object.values(level.rooms).map((r) => r.group).filter(Boolean));
  const groups = {};
  Object.entries(level.groups).forEach(([gid, g]) => { if (used.has(gid)) groups[gid] = g; });
  return { ...level, groups };
}

/* ---------------------------------------------------- Persistenza (localStorage) */
const STORAGE_KEY = "simulatore-livelli:v1";

// Raccoglie tutto lo stato salvabile in un oggetto semplice, poi lo serializza.
function serialize(state) {
  return JSON.stringify(state);
}
// Ricarica lo stato dal localStorage; ritorna null se assente o corrotto.
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== "object" || !s.levels) return null;
    return s;
  } catch {
    return null;
  }
}

export default function App() {
  // stato caricato una sola volta all'avvio (se esiste)
  const saved = useRef(loadState()).current;

  const idRef = useRef(saved?.idCounter || 1);
  const genId = useCallback(() => "r" + String(idRef.current++).padStart(3, "0"), []);
  const gidRef = useRef(saved?.gidCounter || 1);
  const genGid = useCallback(() => "grp" + (gidRef.current++), []);

  const makeLevel = useCallback((rows, cols) => {
    const rooms = {};
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const id = genId();
        rooms[id] = { id, name: "", color: null, group: null, r0: r, c0: c, r1: r, c1: c };
      }
    return { rows, cols, rooms, groups: {}, name: "", tier: 1 };
  }, [genId]);

  const [theme, setTheme] = useState(saved?.theme || "dark");
  const [maxAbove, setMaxAbove] = useState(saved?.maxAbove ?? 3);
  const [maxBelow, setMaxBelow] = useState(saved?.maxBelow ?? 1);
  const [current, setCurrent] = useState(saved?.current ?? 0);
  const [levels, setLevels] = useState(() => saved?.levels || { 0: makeLevel(DEFAULT_ROWS, DEFAULT_COLS) });
  const [selected, setSelected] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [legend, setLegend] = useState(saved?.legend || DEFAULT_LEGEND);
  const [rowsInput, setRowsInput] = useState(saved?.levels?.[saved?.current ?? 0]?.rows ?? DEFAULT_ROWS);
  const [colsInput, setColsInput] = useState(saved?.levels?.[saved?.current ?? 0]?.cols ?? DEFAULT_COLS);

  // Applica la palette PRIMA del render dei figli. useState iniziale garantisce
  // che al primo paint T sia già corretto.
  applyTheme(theme);

  const lv = levels[current];
  const tier = lv?.tier || 1;
  const fixtures = tier >= FIX_THRESHOLD;

  useEffect(() => {
    if (!levels[current])
      setLevels((p) => (p[current] ? p : { ...p, [current]: makeLevel(rowsInput, colsInput) }));
  }, [current]); // eslint-disable-line

  useEffect(() => {
    const l = levels[current];
    if (l) { setRowsInput(l.rows); setColsInput(l.cols); }
  }, [current]); // eslint-disable-line

  useEffect(() => {
    if (current > maxAbove) goToLevel(maxAbove);
    else if (current < -maxBelow) goToLevel(-maxBelow);
  }, [maxAbove, maxBelow]); // eslint-disable-line

  // Applica la palette e ridipinge lo sfondo pagina quando cambia il tema
  useEffect(() => {
    applyTheme(theme);
    document.body.style.background = T.bg;
  }, [theme]);

  // Salvataggio automatico: ogni volta che qualcosa di rilevante cambia,
  // serializziamo lo stato completo nel localStorage.
  useEffect(() => {
    const state = {
      theme, maxAbove, maxBelow, current, levels, legend,
      idCounter: idRef.current,
      gidCounter: gidRef.current,
    };
    try {
      localStorage.setItem(STORAGE_KEY, serialize(state));
    } catch (e) {
      // localStorage pieno o non disponibile: fallisce in silenzio
      console.warn("Salvataggio non riuscito:", e);
    }
  }, [theme, maxAbove, maxBelow, current, levels, legend]);

  const goToLevel = useCallback((l) => {
    const target = clampInt(l, -maxBelow, maxAbove);
    setLevels((p) => (p[target] ? p : { ...p, [target]: makeLevel(rowsInput, colsInput) }));
    setCurrent(target); setSelected([]); setEditingId(null);
  }, [maxAbove, maxBelow, rowsInput, colsInput, makeLevel]);

  const regenGrid = () => {
    const r = clampInt(rowsInput, 1, 40), c = clampInt(colsInput, 1, 40);
    setLevels((p) => ({ ...p, [current]: { ...makeLevel(r, c), name: lv?.name || "", tier: lv?.tier || 1 } }));
    setSelected([]); setEditingId(null);
  };

  const setFloorName = (name) => lv && setLevels((p) => ({ ...p, [current]: { ...lv, name } }));
  const setFloorTier = (t) => lv && setLevels((p) => ({ ...p, [current]: { ...lv, tier: t } }));

  const onRoomClick = (id, e) => {
    if (editingId) return;
    const multi = e.shiftKey || e.metaKey || e.ctrlKey;
    setSelected((prev) => {
      if (multi) return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      return [id];
    });
  };

  const mergeSelected = () => {
    if (!lv) return;
    const sel = selected.map((id) => lv.rooms[id]).filter(Boolean);
    if (sel.length < 2) return;
    let R0 = Infinity, C0 = Infinity, R1 = -Infinity, C1 = -Infinity;
    sel.forEach((rm) => {
      R0 = Math.min(R0, rm.r0); C0 = Math.min(C0, rm.c0);
      R1 = Math.max(R1, rm.r1); C1 = Math.max(C1, rm.c1);
    });
    const kept = {};
    Object.values(lv.rooms).forEach((rm) => {
      if (rm.r1 < R0 || rm.r0 > R1 || rm.c1 < C0 || rm.c0 > C1) kept[rm.id] = rm;
    });
    const primary = lv.rooms[selected[selected.length - 1]];
    const nid = genId();
    kept[nid] = { id: nid, name: primary?.name || "", color: primary?.color || null, group: primary?.group || null, r0: R0, c0: C0, r1: R1, c1: C1 };
    setLevels((p) => ({ ...p, [current]: pruneGroups({ ...lv, rooms: kept }) }));
    setSelected([nid]); setEditingId(null);
  };

  const splitSelected = () => {
    if (!lv) return;
    const rooms = { ...lv.rooms };
    selected.forEach((id) => {
      const rm = rooms[id];
      if (!rm) return;
      if (rm.r1 > rm.r0 || rm.c1 > rm.c0) {
        delete rooms[id];
        for (let r = rm.r0; r <= rm.r1; r++)
          for (let c = rm.c0; c <= rm.c1; c++) {
            const nid = genId();
            rooms[nid] = { id: nid, name: "", color: rm.color, group: rm.group || null, r0: r, c0: c, r1: r, c1: c };
          }
      }
    });
    setLevels((p) => ({ ...p, [current]: { ...lv, rooms } }));
    setSelected([]);
  };

  const applyColor = (color) => {
    if (!lv || selected.length === 0) return;
    const rooms = { ...lv.rooms };
    selected.forEach((id) => { if (rooms[id]) rooms[id] = { ...rooms[id], color }; });
    setLevels((p) => ({ ...p, [current]: { ...lv, rooms } }));
  };

  const commitName = (id, name) => {
    if (!lv) return;
    const rooms = { ...lv.rooms };
    if (rooms[id]) rooms[id] = { ...rooms[id], name };
    setLevels((p) => ({ ...p, [current]: { ...lv, rooms } }));
    setEditingId(null);
  };

  // --- gruppi ---
  const createGroup = () => {
    if (!lv || selected.length === 0) return;
    const groups = { ...lv.groups };
    const { name, letter } = nextGroupName(groups);
    const gid = genGid();
    groups[gid] = { id: gid, name, letter };
    const rooms = { ...lv.rooms };
    selected.forEach((id) => { if (rooms[id]) rooms[id] = { ...rooms[id], group: gid }; });
    setLevels((p) => ({ ...p, [current]: pruneGroups({ ...lv, rooms, groups }) }));
  };
  const renameGroup = (gid, name) => {
    if (!lv) return;
    setLevels((p) => ({ ...p, [current]: { ...lv, groups: { ...lv.groups, [gid]: { ...lv.groups[gid], name } } } }));
  };
  const removeGroup = (gid) => {
    if (!lv) return;
    const rooms = { ...lv.rooms };
    Object.values(rooms).forEach((r) => { if (r.group === gid) rooms[r.id] = { ...r, group: null }; });
    const groups = { ...lv.groups }; delete groups[gid];
    setLevels((p) => ({ ...p, [current]: { ...lv, rooms, groups } }));
    setSelected([]);
  };
  const selectGroup = (gid) => {
    if (!lv) return;
    setSelected(Object.values(lv.rooms).filter((r) => r.group === gid).map((r) => r.id));
    setEditingId(null);
  };

  const clearCanvas = (e) => {
    if (e.target.dataset.bg === "1") { setSelected([]); setEditingId(null); }
  };

  // --- esporta / importa / reset ---
  const fileRef = useRef(null);

  const exportJSON = () => {
    const state = { theme, maxAbove, maxBelow, current, levels, legend, idCounter: idRef.current, gidCounter: gidRef.current };
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `simulatore-livelli-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJSON = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const s = JSON.parse(ev.target.result);
        if (!s.levels) throw new Error("File non valido");
        setTheme(s.theme || "dark");
        setMaxAbove(s.maxAbove ?? 3);
        setMaxBelow(s.maxBelow ?? 1);
        setLevels(s.levels);
        setLegend(s.legend || DEFAULT_LEGEND);
        setCurrent(s.current ?? 0);
        idRef.current = s.idCounter || 1;
        gidRef.current = s.gidCounter || 1;
        setSelected([]); setEditingId(null);
      } catch (err) {
        alert("Impossibile leggere il file: " + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = ""; // permette di reimportare lo stesso file
  };

  const resetAll = () => {
    if (!confirm("Cancellare tutto e ripartire da zero? L'operazione non è reversibile.")) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    idRef.current = 1; gidRef.current = 1;
    setMaxAbove(3); setMaxBelow(1); setCurrent(0);
    setLevels({ 0: makeLevel(DEFAULT_ROWS, DEFAULT_COLS) });
    setLegend(DEFAULT_LEGEND);
    setSelected([]); setEditingId(null);
  };

  const ladder = useMemo(() => {
    const a = [];
    for (let l = maxAbove; l >= -maxBelow; l--) a.push(l);
    return a;
  }, [maxAbove, maxBelow]);

  const label = (l) => (l === 0 ? "PT" : l > 0 ? "+" + l : String(l));
  const kind = (l) => (l === 0 ? "Piano terra" : l > 0 ? "Fuori terra" : "Interrato");
  const tierOf = (l) => levels[l]?.tier ?? null;

  const roomCount = lv ? Object.keys(lv.rooms).length : 0;
  const single = selected.length === 1 ? lv?.rooms[selected[0]] : null;

  const groupList = useMemo(() => {
    if (!lv) return [];
    const counts = {};
    Object.values(lv.rooms).forEach((r) => { if (r.group) counts[r.group] = (counts[r.group] || 0) + 1; });
    return Object.values(lv.groups).map((g) => ({ ...g, count: counts[g.id] || 0 }));
  }, [lv]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", minHeight: 560, background: T.bg, color: T.text, fontFamily: T.sans, overflow: "hidden" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 18px", borderBottom: `1px solid ${T.line}`, background: T.panel2, flexShrink: 0 }}>
        <div style={{ fontFamily: T.mono, fontSize: 12, letterSpacing: 3, color: T.accent, fontWeight: 600 }}>◈ SEZIONE</div>
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: .2 }}>Simulatore livelli</h1>
        <span style={{ fontSize: 12, color: T.mute, fontFamily: T.mono }}>{maxBelow} interrati · PT · {maxAbove} fuori terra</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: T.mute, fontFamily: T.mono }}>✓ salvato</span>
          <HdrBtn onClick={exportJSON} title="Esporta lo stato in un file .json">↓ Esporta</HdrBtn>
          <HdrBtn onClick={() => fileRef.current?.click()} title="Importa uno stato da file .json">↑ Importa</HdrBtn>
          <input ref={fileRef} type="file" accept=".json,application/json" onChange={importJSON} style={{ display: "none" }} />
          <HdrBtn onClick={resetAll} title="Cancella tutto e riparti da zero" danger>⟲ Reset</HdrBtn>
          <button onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "Passa al tema chiaro" : "Passa al tema scuro"}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 6, cursor: "pointer",
              background: T.panel, border: `1px solid ${T.lineHard}`, color: T.text, fontSize: 12.5, fontWeight: 600, fontFamily: T.sans }}>
            {theme === "dark" ? "☀ Chiaro" : "☾ Scuro"}
          </button>
        </div>
      </header>

      <Toolbar
        maxAbove={maxAbove} setMaxAbove={(v) => setMaxAbove(clampInt(v, 0, 60))}
        maxBelow={maxBelow} setMaxBelow={(v) => setMaxBelow(clampInt(v, 0, 60))}
        rowsInput={rowsInput} setRowsInput={setRowsInput}
        colsInput={colsInput} setColsInput={setColsInput}
        onRegen={regenGrid} onMerge={mergeSelected} onSplit={splitSelected} onGroup={createGroup}
        canMerge={selected.length >= 2} canGroup={selected.length >= 1}
        canSplit={selected.some((id) => lv && lv.rooms[id] && (lv.rooms[id].r1 > lv.rooms[id].r0 || lv.rooms[id].c1 > lv.rooms[id].c0))}
      />

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <LevelGauge
          ladder={ladder} current={current} label={label} kind={kind} tierOf={tierOf}
          onPick={goToLevel} onUp={() => goToLevel(current + 1)} onDown={() => goToLevel(current - 1)}
          atTop={current >= maxAbove} atBottom={current <= -maxBelow}
        />

        <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: T.bg }}>
          <div style={{ borderBottom: `1px solid ${T.lineSoft}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "9px 16px 6px" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexShrink: 0 }}>
                <span style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 700, color: T.accent }}>{label(current)}</span>
                <span style={{ fontSize: 13, color: T.dim }}>{kind(current)}</span>
              </div>
              <input
                value={lv?.name || ""} onChange={(e) => setFloorName(e.target.value)}
                placeholder="Categoria / nome del piano — es. Laboratori, Data center…"
                style={{ flex: 1, minWidth: 0, background: T.sunk, color: T.text, border: `1px solid ${T.lineHard}`, borderRadius: 6, padding: "6px 10px", fontFamily: T.sans, fontSize: 13, outline: "none" }}
              />
              <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.mute, flexShrink: 0 }}>
                {lv ? `${lv.rows}×${lv.cols} · ${roomCount} stanze` : "…"}
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 16px 9px", flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: T.mute, fontFamily: T.mono }}>Tier</span>
              <TierSelector value={tier} onChange={setFloorTier} />
              <TierBadge tier={tier} size={26} />
              <span style={{ fontSize: 12.5, color: tierColor(tier), fontWeight: 600 }}>{TIERS[tier].label}</span>
              {fixtures && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: 4, paddingLeft: 12, borderLeft: `1px solid ${T.line}`, flexWrap: "wrap" }}>
                  <FixChip color={SEC} label="Sala sicurezza" />
                  <FixChip color={DECON} label="Decontaminazione / stanza" />
                  <FixChip color={ELEV} label={colsInput >= 5 ? "Ascensore ogni 5" : "3 ascensori centrali"} />
                </div>
              )}
            </div>
          </div>

          <div data-bg="1" onMouseDown={clearCanvas} style={{ flex: 1, overflow: "auto", padding: 20 }}>
            {lv && (
              <div data-bg="1" style={{ display: "flex", gap: 12, alignItems: "stretch", minWidth: lv.cols * 84 + (fixtures ? 66 : 0) }}>
                {fixtures && <SecurityBay />}
                <div style={{ position: "relative", flex: 1, minWidth: lv.cols * 84 }}>
                  <div
                    data-bg="1"
                    style={{
                      display: "grid",
                      gridTemplateColumns: `repeat(${lv.cols}, minmax(84px, 1fr))`,
                      gridTemplateRows: `repeat(${lv.rows}, ${ROW_H}px)`,
                      gap: GAP, width: "100%",
                      backgroundImage: `linear-gradient(${T.lineSoft} 1px, transparent 1px), linear-gradient(90deg, ${T.lineSoft} 1px, transparent 1px)`,
                      backgroundSize: "22px 22px", backgroundColor: T.panel2,
                      border: `1px solid ${T.line}`, borderRadius: 6, padding: GAP,
                    }}
                  >
                    {Object.values(lv.rooms).map((rm) => (
                      <Room
                        key={rm.id} rm={rm} decon={fixtures}
                        group={rm.group ? lv.groups[rm.group] : null}
                        selected={selected.includes(rm.id)} editing={editingId === rm.id}
                        onClick={(e) => onRoomClick(rm.id, e)}
                        onEdit={() => { setSelected([rm.id]); setEditingId(rm.id); }}
                        onCommit={(name) => commitName(rm.id, name)}
                      />
                    ))}
                  </div>
                  {fixtures && <ElevatorOverlay cols={lv.cols} />}
                </div>
              </div>
            )}
          </div>

          <footer style={{ padding: "7px 16px", borderTop: `1px solid ${T.lineSoft}`, fontSize: 11.5, color: T.mute, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <span>Doppio clic = rinomina</span>
            <span>Maiusc/Ctrl + clic = selezione multipla</span>
            <span>Unisci / Dividi = fondi o riseparo</span>
            <span>Raggruppa = crea gruppo (A1–H3)</span>
            <span style={{ color: fixtures ? tierColor(tier) : T.mute }}>Dotazioni: Tier ≥ 3</span>
          </footer>
        </main>

        <Sidebar
          single={single} count={selected.length}
          onName={(name) => single && commitName(single.id, name)}
          legend={legend} setLegend={setLegend}
          onColor={applyColor} hasSelection={selected.length > 0}
          groupList={groupList} onCreateGroup={createGroup} onRenameGroup={renameGroup}
          onRemoveGroup={removeGroup} onSelectGroup={selectGroup}
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Toolbar */
function Toolbar(props) {
  const { maxAbove, setMaxAbove, maxBelow, setMaxBelow, rowsInput, setRowsInput, colsInput, setColsInput, onRegen, onMerge, onSplit, onGroup, canMerge, canSplit, canGroup } = props;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", padding: "10px 16px", borderBottom: `1px solid ${T.line}`, background: T.panel, flexShrink: 0 }}>
      <Field label="Fuori terra max"><Stepper value={maxAbove} onChange={setMaxAbove} min={0} /></Field>
      <Field label="Interrati max"><Stepper value={maxBelow} onChange={setMaxBelow} min={0} /></Field>
      <Divider />
      <Field label="Righe"><Stepper value={rowsInput} onChange={(v) => setRowsInput(clampInt(v, 1, 40))} min={1} /></Field>
      <Field label="Colonne"><Stepper value={colsInput} onChange={(v) => setColsInput(clampInt(v, 1, 40))} min={1} /></Field>
      <Btn onClick={onRegen} title="Rigenera la griglia del piano attivo">Rigenera griglia</Btn>
      <Divider />
      <Btn onClick={onMerge} disabled={!canMerge} accent title="Fondi i rettangoli selezionati">⧉ Unisci</Btn>
      <Btn onClick={onSplit} disabled={!canSplit} title="Riseparo la stanza selezionata">⤢ Dividi</Btn>
      <Btn onClick={onGroup} disabled={!canGroup} title="Raggruppa le stanze selezionate (nome A1–H3 o personalizzato)">⊞ Raggruppa</Btn>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: T.mute, fontFamily: T.mono }}>{label}</span>
      {children}
    </label>
  );
}
function Stepper({ value, onChange, min = 0 }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", border: `1px solid ${T.lineHard}`, borderRadius: 6, overflow: "hidden", background: T.sunk }}>
      <StepBtn onClick={() => onChange(Math.max(min, value - 1))}>−</StepBtn>
      <input value={value} onChange={(e) => onChange(e.target.value === "" ? min : e.target.value)}
        style={{ width: 40, textAlign: "center", background: "transparent", color: T.text, border: "none", outline: "none", fontFamily: T.mono, fontSize: 14, padding: "5px 0" }} />
      <StepBtn onClick={() => onChange(value + 1)}>+</StepBtn>
    </div>
  );
}
function StepBtn({ children, onClick }) {
  return <button onClick={onClick} style={{ width: 26, height: 30, background: T.panel, color: T.dim, border: "none", cursor: "pointer", fontSize: 15, lineHeight: 1 }}>{children}</button>;
}
function Btn({ children, onClick, disabled, accent, title }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} style={{
      padding: "7px 13px", borderRadius: 6, cursor: disabled ? "not-allowed" : "pointer", fontSize: 12.5, fontWeight: 600, fontFamily: T.sans,
      background: disabled ? T.panel2 : accent ? "rgba(240,162,74,.14)" : T.panel,
      color: disabled ? T.mute : accent ? T.accent : T.text,
      border: `1px solid ${disabled ? T.lineSoft : accent ? T.accentDim : T.lineHard}`, opacity: disabled ? .5 : 1, transition: "all .12s",
    }}>{children}</button>
  );
}
function Divider() { return <div style={{ width: 1, alignSelf: "stretch", background: T.line, margin: "2px 0" }} />; }
function HdrBtn({ children, onClick, title, danger }) {
  return (
    <button onClick={onClick} title={title} style={{
      padding: "6px 11px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: T.sans,
      background: T.panel, color: danger ? "#ef4444" : T.dim,
      border: `1px solid ${danger ? "rgba(239,68,68,.4)" : T.lineHard}`,
    }}>{children}</button>
  );
}

/* ------------------------------------------------------------- Tier UI */
function TierBadge({ tier, size = 24 }) {
  const c = tierColor(tier);
  return (
    <span style={{ position: "relative", display: "inline-flex", width: size, height: size * 1.14, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <svg width={size} height={size * 1.14} viewBox="0 0 24 28" style={{ position: "absolute", inset: 0 }}>
        <path d="M12 1.5 L21.5 5.2 V13 C21.5 19.6 17 24.4 12 26.5 C7 24.4 2.5 19.6 2.5 13 V5.2 Z" fill={hexA(c, .18)} stroke={c} strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
      <span style={{ position: "relative", fontFamily: T.mono, fontSize: size * 0.5, fontWeight: 700, color: c, marginTop: -1 }}>{tier}</span>
    </span>
  );
}
function TierSelector({ value, onChange }) {
  return (
    <div style={{ display: "inline-flex", border: `1px solid ${T.lineHard}`, borderRadius: 6, overflow: "hidden" }}>
      {[1, 2, 3, 4, 5].map((t) => {
        const active = t === value;
        const c = tierColor(t);
        return (
          <button key={t} onClick={() => onChange(t)} title={TIERS[t].label} style={{
            width: 30, height: 28, border: "none", cursor: "pointer", fontFamily: T.mono, fontSize: 13, fontWeight: 700,
            borderRight: t < 5 ? `1px solid ${T.lineSoft}` : "none",
            background: active ? hexA(c, .22) : T.sunk, color: active ? c : T.mute,
            boxShadow: active ? `inset 0 -2px 0 ${c}` : "none",
          }}>{t}</button>
        );
      })}
    </div>
  );
}
function FixChip({ color, label }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: T.dim }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: hexA(color, .3), border: `1px solid ${color}` }} />
      {label}
    </span>
  );
}

/* ---------------------------------------------------------- Dotazioni */
function SecurityBay() {
  return (
    <div style={{ width: 54, flexShrink: 0, background: hexA(SEC, .08), border: `1px solid ${hexA(SEC, .4)}`, borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: "12px 0" }}>
      <svg width="22" height="25" viewBox="0 0 24 28">
        <path d="M12 1.5 L21.5 5.2 V13 C21.5 19.6 17 24.4 12 26.5 C7 24.4 2.5 19.6 2.5 13 V5.2 Z" fill={hexA(SEC, .16)} stroke={SEC} strokeWidth="1.6" strokeLinejoin="round" />
        <rect x="9" y="12" width="6" height="5" rx="1" fill="none" stroke={SEC} strokeWidth="1.3" />
        <path d="M10 12 V10.5 A2 2 0 0 1 14 10.5 V12" fill="none" stroke={SEC} strokeWidth="1.3" />
      </svg>
      <span style={{ writingMode: "vertical-rl", fontFamily: T.mono, fontSize: 10, letterSpacing: 2, color: SEC, fontWeight: 600 }}>SALA SICUREZZA</span>
    </div>
  );
}
function ElevatorOverlay({ cols }) {
  const fr = elevatorFractions(cols);
  const w = cols < 5 ? 20 : 26;
  return (
    <div style={{ position: "absolute", top: GAP, bottom: GAP, left: GAP, right: GAP, pointerEvents: "none", zIndex: 5 }}>
      {fr.map((f, i) => (
        <div key={i} style={{
          position: "absolute", top: 0, bottom: 0, left: `calc(${f * 100}% - ${w / 2}px)`, width: w,
          background: hexA(ELEV, .13), border: `1px dashed ${hexA(ELEV, .6)}`, borderRadius: 4,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
        }}>
          <span style={{ color: ELEV, fontSize: 9, lineHeight: 1 }}>▲</span>
          <span style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1, color: ELEV, writingMode: "vertical-rl", fontWeight: 700 }}>ASC</span>
          <span style={{ color: ELEV, fontSize: 9, lineHeight: 1 }}>▼</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Room */
function Room({ rm, group, decon, selected, editing, onClick, onEdit, onCommit }) {
  const [draft, setDraft] = useState(rm.name);
  useEffect(() => { setDraft(rm.name); }, [rm.name, editing]);

  const gcol = group ? groupColor(group) : null;
  const bg = rm.color ? hexA(rm.color, 0.16) : T.panel;
  const border = selected ? T.sel : gcol ? gcol : rm.color ? hexA(rm.color, 0.55) : T.lineHard;
  const shadow = selected ? `0 0 0 2px ${hexA(T.sel, 0.35)}` : gcol ? `0 0 0 1px ${hexA(gcol, 0.25)}` : "none";

  return (
    <div
      onClick={onClick} onDoubleClick={onEdit}
      style={{
        position: "relative", gridColumn: `${rm.c0 + 1} / ${rm.c1 + 2}`, gridRow: `${rm.r0 + 1} / ${rm.r1 + 2}`,
        background: bg, border: `1.5px solid ${border}`, borderRadius: 5, boxShadow: shadow, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 8, overflow: "hidden",
        transition: "border-color .1s, box-shadow .1s",
      }}
    >
      {rm.color && <span style={{ position: "absolute", top: 6, left: 6, width: 8, height: 8, borderRadius: 2, background: rm.color }} />}

      {decon && (
        <span title="Decontaminazione" style={{ position: "absolute", top: 5, right: 6, display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, borderRadius: 4, background: hexA(DECON, .18), border: `1px solid ${hexA(DECON, .6)}` }}>
          <svg width="9" height="9" viewBox="0 0 12 12">
            <path d="M6 1 C6 1 10 6 10 8.2 A4 4 0 1 1 2 8.2 C2 6 6 1 6 1 Z" fill="none" stroke={DECON} strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
        </span>
      )}

      {editing ? (
        <input autoFocus value={draft}
          onChange={(e) => setDraft(e.target.value)} onBlur={() => onCommit(draft)}
          onKeyDown={(e) => { if (e.key === "Enter") onCommit(draft); if (e.key === "Escape") onCommit(rm.name); }}
          onClick={(e) => e.stopPropagation()} placeholder="nome stanza"
          style={{ width: "100%", textAlign: "center", background: T.sunk, color: T.text, border: `1px solid ${T.sel}`, borderRadius: 4, outline: "none", fontFamily: T.sans, fontSize: 13, padding: "4px 6px" }} />
      ) : (
        <span style={{ fontSize: 13, fontWeight: 500, color: rm.name ? T.text : T.mute, textAlign: "center", lineHeight: 1.2, wordBreak: "break-word" }}>{rm.name || "—"}</span>
      )}

      {group && (
        <span title={`Gruppo ${group.name}`} style={{
          position: "absolute", bottom: 4, left: 6, fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, lineHeight: "14px",
          padding: "0 5px", borderRadius: 3, color: gcol, background: hexA(gcol, .16), border: `1px solid ${hexA(gcol, .5)}`,
          pointerEvents: "none", maxWidth: "62%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{group.name}</span>
      )}

      <span style={{ position: "absolute", bottom: 4, right: 6, fontFamily: T.mono, fontSize: 10, letterSpacing: .5, color: T.text, opacity: 0.28, pointerEvents: "none", userSelect: "none" }}>{rm.id}</span>
    </div>
  );
}

/* ------------------------------------------------------------ LevelGauge */
function LevelGauge({ ladder, current, label, kind, tierOf, onPick, onUp, onDown, atTop, atBottom }) {
  const rowH = 34, viewH = 320;
  const idx = ladder.indexOf(current);
  const offset = viewH / 2 - (idx + 0.5) * rowH;

  return (
    <aside style={{ width: 150, flexShrink: 0, background: T.panel2, borderRight: `1px solid ${T.line}`, display: "flex", flexDirection: "column", alignItems: "center", padding: "12px 0" }}>
      <NavArrow dir="up" onClick={onUp} disabled={atTop} />
      <div style={{ position: "relative", width: "100%", height: viewH, overflow: "hidden", margin: "6px 0" }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: viewH / 2 - rowH / 2, height: rowH, background: "rgba(240,162,74,.10)", borderTop: `1px solid ${T.accentDim}`, borderBottom: `1px solid ${T.accentDim}`, pointerEvents: "none", zIndex: 2 }} />
        <div style={{ position: "absolute", left: 0, top: viewH / 2 - 5, width: 0, height: 0, borderTop: "5px solid transparent", borderBottom: "5px solid transparent", borderLeft: `7px solid ${T.accent}`, zIndex: 3, pointerEvents: "none" }} />
        <div style={{ position: "absolute", left: 0, right: 0, transform: `translateY(${offset}px)`, transition: "transform .22s cubic-bezier(.4,0,.2,1)" }}>
          {ladder.map((l) => {
            const active = l === current, ground = l === 0, tr = tierOf(l);
            return (
              <button key={l} onClick={() => onPick(l)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", height: rowH, padding: "0 12px 0 22px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}>
                <span style={{ width: active ? 26 : ground ? 20 : 13, height: ground ? 2 : 1, background: active ? T.accent : ground ? T.ground : T.lineHard, flexShrink: 0 }} />
                <span style={{ fontFamily: T.mono, fontSize: active ? 17 : 13, fontWeight: active ? 700 : 500, color: active ? T.accent : ground ? T.dim : T.mute, minWidth: 26 }}>{label(l)}</span>
                {tr && <span title={`Tier ${tr}`} style={{ marginLeft: "auto", width: active ? 9 : 7, height: active ? 9 : 7, borderRadius: "50%", background: hexA(tierColor(tr), .35), border: `1.5px solid ${tierColor(tr)}`, flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
        <Fade top /><Fade />
      </div>
      <NavArrow dir="down" onClick={onDown} disabled={atBottom} />
      <div style={{ marginTop: 10, textAlign: "center", padding: "0 10px", lineHeight: 1.2, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
        <div style={{ fontFamily: T.mono, fontSize: 11, letterSpacing: 1, color: T.mute }}>LIVELLO</div>
        <div style={{ fontFamily: T.mono, fontSize: 26, fontWeight: 700, color: T.accent }}>{label(current)}</div>
        <div style={{ fontSize: 11, color: T.dim }}>{kind(current)}</div>
        {tierOf(current) && <div style={{ marginTop: 4 }}><TierBadge tier={tierOf(current)} size={22} /></div>}
      </div>
    </aside>
  );
}
function Fade({ top }) {
  return <div style={{ position: "absolute", left: 0, right: 0, height: 40, pointerEvents: "none", zIndex: 1, [top ? "top" : "bottom"]: 0, background: `linear-gradient(${top ? "to bottom" : "to top"}, ${T.panel2}, transparent)` }} />;
}
function NavArrow({ dir, onClick, disabled }) {
  return <button onClick={onClick} disabled={disabled} title={dir === "up" ? "Sali di un piano" : "Scendi di un piano"} style={{ width: 34, height: 26, borderRadius: 6, cursor: disabled ? "not-allowed" : "pointer", background: T.panel, border: `1px solid ${T.lineHard}`, color: disabled ? T.mute : T.dim, opacity: disabled ? .4 : 1, fontSize: 12 }}>{dir === "up" ? "▲" : "▼"}</button>;
}

/* --------------------------------------------------------------- Sidebar */
function Sidebar({ single, count, onName, legend, setLegend, onColor, hasSelection, groupList, onCreateGroup, onRenameGroup, onRemoveGroup, onSelectGroup }) {
  const updateLegend = (id, patch) => setLegend((L) => L.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  return (
    <aside style={{ width: 244, flexShrink: 0, background: T.panel, borderLeft: `1px solid ${T.line}`, display: "flex", flexDirection: "column", overflow: "auto" }}>
      <Section title="Stanza selezionata">
        {count === 0 && <Hint>Nessuna selezione. Clicca una stanza.</Hint>}
        {count > 1 && <Hint>{count} stanze selezionate. Usa <b style={{ color: T.dim }}>Unisci</b> o <b style={{ color: T.dim }}>Raggruppa</b>.</Hint>}
        {single && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 11, color: T.mute, fontFamily: T.mono }}>ID</span>
              <span style={{ fontFamily: T.mono, fontSize: 14, color: T.text }}>{single.id}</span>
            </div>
            <label style={{ display: "block", fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: T.mute, fontFamily: T.mono, marginBottom: 5 }}>Nome</label>
            <input value={single.name} onChange={(e) => onName(e.target.value)} placeholder="nome stanza"
              style={{ width: "100%", boxSizing: "border-box", background: T.sunk, color: T.text, border: `1px solid ${T.lineHard}`, borderRadius: 6, padding: "8px 10px", fontFamily: T.sans, fontSize: 13, outline: "none" }} />
          </>
        )}
      </Section>

      <Section title="Indicazioni standard">
        <Hint>Seleziona una o più stanze, poi applica un colore.</Hint>
        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10 }}>
          {legend.map((e) => (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => onColor(e.color)} disabled={!hasSelection} title={hasSelection ? "Applica alla selezione" : "Seleziona prima una stanza"}
                style={{ width: 24, height: 24, borderRadius: 5, flexShrink: 0, background: e.color, border: `1px solid rgba(255,255,255,.18)`, cursor: hasSelection ? "pointer" : "not-allowed", opacity: hasSelection ? 1 : .45 }} />
              <input value={e.label} onChange={(ev) => updateLegend(e.id, { label: ev.target.value })}
                style={{ flex: 1, minWidth: 0, background: "transparent", color: T.text, border: "none", borderBottom: `1px solid ${T.lineSoft}`, outline: "none", fontSize: 12.5, padding: "3px 2px", fontFamily: T.sans }} />
              <input type="color" value={e.color} onChange={(ev) => updateLegend(e.id, { color: ev.target.value })} title="Cambia colore"
                style={{ width: 22, height: 22, padding: 0, border: "none", background: "none", cursor: "pointer", flexShrink: 0 }} />
            </div>
          ))}
        </div>
        <button onClick={() => onColor(null)} disabled={!hasSelection}
          style={{ marginTop: 12, width: "100%", padding: "7px 0", borderRadius: 6, background: T.panel2, color: hasSelection ? T.dim : T.mute, border: `1px solid ${T.lineHard}`, cursor: hasSelection ? "pointer" : "not-allowed", fontSize: 12, fontFamily: T.sans, opacity: hasSelection ? 1 : .5 }}>Nessun colore</button>
      </Section>

      <Section title="Gruppi di stanze">
        <Hint>Seleziona delle stanze e crea un gruppo. Nome automatico A1–H3, oppure personalizzato.</Hint>
        <button onClick={onCreateGroup} disabled={!hasSelection}
          style={{ marginTop: 10, width: "100%", padding: "8px 0", borderRadius: 6, background: hasSelection ? "rgba(77,182,230,.14)" : T.panel2, color: hasSelection ? T.sel : T.mute, border: `1px solid ${hasSelection ? "#2f5c72" : T.lineHard}`, cursor: hasSelection ? "pointer" : "not-allowed", fontSize: 12.5, fontWeight: 600, fontFamily: T.sans, opacity: hasSelection ? 1 : .6 }}>
          ⊞ Crea gruppo dalla selezione
        </button>
        {groupList.length === 0 ? (
          <p style={{ margin: "10px 0 0", fontSize: 12, color: T.mute }}>Nessun gruppo su questo piano.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 12 }}>
            {groupList.map((g) => (
              <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, flexShrink: 0, background: hexA(groupColor(g), .3), border: `1px solid ${groupColor(g)}` }} />
                <input value={g.name} onChange={(e) => onRenameGroup(g.id, e.target.value)}
                  style={{ flex: 1, minWidth: 0, background: "transparent", color: T.text, border: "none", borderBottom: `1px solid ${T.lineSoft}`, outline: "none", fontSize: 12.5, padding: "3px 2px", fontFamily: T.sans }} />
                <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.mute, flexShrink: 0, minWidth: 14, textAlign: "right" }}>{g.count}</span>
                <button onClick={() => onSelectGroup(g.id)} title="Seleziona le stanze del gruppo" style={{ width: 22, height: 22, flexShrink: 0, borderRadius: 4, background: T.sunk, border: `1px solid ${T.lineHard}`, color: T.dim, cursor: "pointer", fontSize: 12, lineHeight: 1 }}>◎</button>
                <button onClick={() => onRemoveGroup(g.id)} title="Elimina il gruppo" style={{ width: 22, height: 22, flexShrink: 0, borderRadius: 4, background: T.sunk, border: `1px solid ${T.lineHard}`, color: T.mute, cursor: "pointer", fontSize: 14, lineHeight: 1 }}>×</button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Dotazioni Tier ≥ 3">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <FixRow color={SEC} title="Sala sicurezza" desc="Bay dedicato sul lato sinistro del piano." />
          <FixRow color={DECON} title="Decontaminazione" desc="Piccola cella su ogni stanza (icona in alto a destra)." />
          <FixRow color={ELEV} title="Ascensori" desc="Uno ogni 5 stanze per fila; 3 centrali se meno di 5." />
        </div>
      </Section>
    </aside>
  );
}
function FixRow({ color, title, desc }) {
  return (
    <div style={{ display: "flex", gap: 9 }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, marginTop: 3, flexShrink: 0, background: hexA(color, .3), border: `1px solid ${color}` }} />
      <div>
        <div style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 11.5, color: T.mute, lineHeight: 1.4 }}>{desc}</div>
      </div>
    </div>
  );
}
function Section({ title, children }) {
  return (
    <div style={{ padding: "14px 16px", borderBottom: `1px solid ${T.lineSoft}` }}>
      <div style={{ fontSize: 10.5, letterSpacing: 1.5, textTransform: "uppercase", color: T.accent, fontFamily: T.mono, marginBottom: 10, fontWeight: 600 }}>{title}</div>
      {children}
    </div>
  );
}
function Hint({ children }) { return <p style={{ margin: 0, fontSize: 12, color: T.mute, lineHeight: 1.5 }}>{children}</p>; }

/* ------------------------------------------------------------------ util */
function hexA(hex, a) {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
