/**
 * Circle Drop — balls colored by birth position so mixing stays visible.
 * Inspired by https://www.youtube.com/watch?v=7IE2kM6vyAw
 *
 * No gravity, no friction: balls travel in straight lines and rebound
 * perfectly (elastically) off the vessel walls. Vessel shapes include a
 * circle, ellipse, stadium, annulus, and coupled resonance chambers with
 * open coupling windows. Every ball launches with the same heading, so a
 * cluster flies as a parallel beam. By default they pass through one
 * another; ball–ball collisions can be enabled from the panel.
 */

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d", { alpha: false });

const ui = {
  balls: document.getElementById("balls"),
  ballsOut: document.getElementById("balls-out"),
  size: document.getElementById("size"),
  sizeOut: document.getElementById("size-out"),
  pack: document.getElementById("pack"),
  packOut: document.getElementById("pack-out"),
  heading: document.getElementById("heading"),
  headingOut: document.getElementById("heading-out"),
  velocity: document.getElementById("velocity"),
  velocityOut: document.getElementById("velocity-out"),
  collide: document.getElementById("collide"),
  collideHint: document.getElementById("collide-hint"),
  colorMode: document.getElementById("color-mode"),
  trails: document.getElementById("trails"),
  sheet: document.getElementById("sheet"),
  sheetColor: document.getElementById("sheet-color"),
  mode3d: document.getElementById("mode3d"),
  chamber3d: document.getElementById("chamber3d"),
  autorotate3d: document.getElementById("autorotate3d"),
  vessel: document.getElementById("vessel"),
  vesselHint: document.getElementById("vessel-hint"),
  spawn: document.getElementById("spawn"),
  orbit: document.getElementById("orbit"),
  orbitParams: document.getElementById("orbit-params"),
  orbitP: document.getElementById("orbit-p"),
  orbitQ: document.getElementById("orbit-q"),
  orbitOut: document.getElementById("orbit-out"),
  orbitPeriod: document.getElementById("orbit-period"),
  orbitHint: document.getElementById("orbit-hint"),
  restart: document.getElementById("btn-restart"),
  pause: document.getElementById("btn-pause"),
  presetSelect: document.getElementById("preset-select"),
  savePreset: document.getElementById("btn-save-preset"),
  deletePreset: document.getElementById("btn-delete-preset"),
  statCount: document.getElementById("stat-count"),
  statSteps: document.getElementById("stat-steps"),
  statFps: document.getElementById("stat-fps"),
};

const state = {
  running: true,
  dpr: 1,
  w: 0,
  h: 0,
  cx: 0,
  cy: 0,
  radius: 0,
  count: 0,
  /** Drawn + collision radius. */
  ballR: 0,
  /** Spawn point as a normalized offset from bowl center (−1..1 of radius). */
  spawnNX: 0,
  spawnNY: 0,
  /** Shared launch heading in radians. */
  heading: Math.PI / 2,
  /** Launch speed in px/s (already scaled by dpr). */
  speed: 0,
  /** Wall/ball restitution — fixed at 1 for perfectly elastic bouncing. */
  restitution: 1,
  collideBalls: false,
  colorMode: "xy",
  vessel: "circle",
  spawn: "grid",
  /** Long-exposure rendering: fade old frames instead of clearing them. */
  trails: false,
  /** Per-frame retention for trails (higher = longer streaks). */
  trailDecay: 0.88,
  /** Sheet mode: spawn a connected lattice and render it as a deforming mesh. */
  sheet: false,
  sheetCols: 0,
  sheetRows: 0,
  /** Initial lattice spacing (px) — used to cull torn/over-stretched cells. */
  sheetSpacing: 0,
  /** How to paint the sheet (lattice UV gradients stay readable as it folds). */
  sheetColor: "uv",
  /** Revival orbit: launch every ball tangent to a shared caustic for periodic re-forming. */
  orbit: false,
  /** Effective reduced rotation number and derived orbit geometry (set on rebuild). */
  orbitBounces: 0,
  orbitPeriod: 0,
  orbitCaustic: 0,
  x: null,
  y: null,
  vx: null,
  vy: null,
  ox: null,
  oy: null,
  colors: null,
  cellSize: 0,
  gridW: 0,
  gridH: 0,
  heads: null,
  next: null,
  /** Physics steps advanced since the last restart — a speed-independent progress reference. */
  stepCount: 0,
};

let lastT = performance.now();
let fpsAccum = 0;
let fpsFrames = 0;

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return [
    Math.round(255 * f(0)),
    Math.round(255 * f(8)),
    Math.round(255 * f(4)),
  ];
}

function colorFromOrigin(ox, oy, index, count) {
  const mode = state.colorMode;
  const nx = (ox - state.cx) / state.radius;
  const ny = (oy - state.cy) / state.radius;
  let h;
  let s = 0.78;
  let l = 0.55;

  if (mode === "x") {
    h = ((nx + 1) * 0.5) * 300;
  } else if (mode === "y") {
    h = ((ny + 1) * 0.5) * 300;
  } else if (mode === "angle") {
    h = ((Math.atan2(ny, nx) + Math.PI) / (Math.PI * 2)) * 360;
  } else if (mode === "index") {
    h = (index / Math.max(count - 1, 1)) * 300;
  } else {
    h = ((nx + 1) * 0.5) * 300;
    l = 0.35 + ((ny + 1) * 0.5) * 0.4;
  }

  const [r, g, b] = hslToRgb(h, s, l);
  return (255 << 24) | (b << 16) | (g << 8) | r;
}

/** Above this count, ball–ball collisions are auto-skipped for performance. */
const COLLISION_LIMIT = 60000;

function ballCountFromSlider() {
  // Use multiplication (not <<) so exponents above 30 stay correct.
  return Math.round(2 ** Number(ui.balls.value));
}

/** Multiplier text: more precision at low values, coarser once it's large. */
function formatMultiplier(v) {
  if (v >= 10) return `${v.toFixed(1)}×`;
  return `${v.toFixed(2)}×`;
}

function updateOutputs() {
  const n = ballCountFromSlider();
  ui.ballsOut.textContent = n.toLocaleString();
  ui.sizeOut.textContent = `${Number(ui.size.value).toFixed(2)}×`;
  ui.packOut.textContent = `${Number(ui.pack.value).toFixed(2)}×`;
  // Show heading as a signed angle around 0° = pointing right, negative = up.
  let deg = Number(ui.heading.value);
  if (deg > 180) deg -= 360;
  ui.headingOut.textContent = `${deg}°`;
  ui.velocityOut.textContent = formatMultiplier(velocityMultiplierFromSlider());
  ui.statCount.textContent = `${state.count.toLocaleString()} balls`;
  ui.statSteps.textContent = `${state.stepCount.toLocaleString()} steps`;
  updateCollideHint(n);
  updateVesselHint();
  updateOrbitReadout();
}

const VESSEL_HINTS = {
  circle: "Classic circular bowl — elastic rebounds off a single rim.",
  ellipse: "Stretched bowl — integrable billiards with confocal caustics.",
  stadium: "Bunimovich stadium — flat sides + semicaps; famously chaotic mixing.",
  annulus: "Ring chamber — outer rim and an inner island balls bounce around.",
  twin: "Two resonance chambers joined by an open window — watch beams tunnel between lobes.",
  triad: "Three chambers at 120° with coupling windows — color streams remix across lobes.",
  chain: "Waveguide chain — five cavities in a row; a beam tunnels down the line window by window.",
  flower: "Rosette — a hub cavity ringed by six petals; color fans out and refocuses through the core.",
  necklace: "Resonance ring — seven chambers coupled in a loop around a hollow core; energy circulates around.",
};

function updateVesselHint() {
  const id = ui.vessel.value;
  ui.vesselHint.textContent = VESSEL_HINTS[id] || VESSEL_HINTS.circle;
  const circleOnly = id === "circle";
  ui.orbit.disabled = !circleOnly;
  if (!circleOnly && ui.orbit.checked) {
    ui.orbit.checked = false;
    state.orbit = false;
  }
  ui.orbitHint.textContent = circleOnly
    ? "Launches every ball tangent to a shared inner circle so the shape dissolves and then exactly re-forms on a fixed cycle."
    : "Revival orbit needs a circular vessel — switch Vessel back to Circle to enable.";
}

function updateOrbitReadout() {
  ui.orbitParams.hidden = !ui.orbit.checked;
  if (!ui.orbit.checked) return;
  const g = orbitGeometry();
  ui.orbitOut.textContent = `${g.p} / ${g.q}`;
  const t = g.period;
  const timeText = t >= 1 ? `${t.toFixed(2)} s` : `${(t * 1000).toFixed(0)} ms`;
  ui.orbitPeriod.textContent = `Re-forms every ${g.bounces} bounces ≈ ${timeText} per cycle`;
}

function updateCollideHint(n) {
  if (ui.collide.checked && n > COLLISION_LIMIT) {
    ui.collideHint.textContent = `Paused above ${COLLISION_LIMIT.toLocaleString()} balls — too many to collide smoothly`;
  } else if (ui.collide.checked) {
    ui.collideHint.textContent = "On: elastic billiard collisions between balls";
  } else {
    ui.collideHint.textContent = "Off: balls pass through each other like the video";
  }
}

/** Re-paint colors without restarting the run (sheet uses lattice UV; dots use birth pos). */
function recolorParticles() {
  const n = state.count;
  if (!n || !state.colors) return;
  if (state.sheet) {
    const cols = state.sheetCols;
    const denom = Math.max(1, cols - 1);
    for (let i = 0; i < n; i++) {
      const u = (i % cols) / denom;
      const v = Math.floor(i / cols) / denom;
      state.colors[i] = colorFromSheet(u, v, state.ox[i], state.oy[i], i, n);
    }
  } else {
    for (let i = 0; i < n; i++) {
      state.colors[i] = colorFromOrigin(state.ox[i], state.oy[i], i, n);
    }
  }
}

/** Convert UI heading (degrees, screen space so +Y is down) to radians. */
function headingRadians() {
  return (Number(ui.heading.value) * Math.PI) / 180;
}

/** Velocity slider is log-scaled (position = log10(multiplier)) so 0.1×–100× stays usable. */
function velocityMultiplierFromSlider() {
  return Math.pow(10, Number(ui.velocity.value));
}

/** Launch speed in px/s from the velocity slider, scaled to the bowl + dpr. */
function launchSpeed() {
  return velocityMultiplierFromSlider() * state.radius * 1.1;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Geometry of a rational revival orbit for the current p/q sliders and speed.
 *
 * A billiard chord at perpendicular distance `b` from center advances its
 * contact point around the rim by a constant angle α = 2·acos(b/Rw). Choosing
 * α = 2π·(p/q) makes every such orbit close after `q` bounces. All balls tangent
 * to that same caustic circle (radius b) share one chord length and speed, so
 * they share one period and re-form the shape simultaneously.
 */
function orbitGeometry() {
  const Rw = state.radius - state.ballR;
  let p = Math.round(Number(ui.orbitP.value));
  let q = Math.round(Number(ui.orbitQ.value));
  p = Math.max(1, Math.min(p, q - 1));
  // Rotation number must be < 1/2 for a positive caustic radius; mirror if needed.
  let rho = p / q;
  if (rho > 0.5) rho = 1 - rho;
  const g = gcd(Math.round(rho * q), q) || 1;
  const bounces = Math.max(2, Math.round(q / g));

  const b = Rw * Math.cos(Math.PI * rho);
  const chord = 2 * Rw * Math.sin(Math.PI * rho);
  const speed = state.speed || launchSpeed();
  const period = speed > 0 ? (bounces * chord) / speed : 0;

  return { p, q, rho, caustic: Math.max(0, b), chord, bounces, period };
}

// ---------------------------------------------------------------------------
// Vessel geometries — circular arcs + flat walls for resonance-style chambers.
// ---------------------------------------------------------------------------

/**
 * Cached vessel metrics rebuilt whenever the stage size or vessel type changes.
 * Centers are absolute canvas coords; radii already include the playable inset
 * for a unit ball (callers subtract ballR again where needed via `inset`).
 */
let vesselCache = null;

function vesselKey() {
  return `${state.vessel}|${state.cx}|${state.cy}|${state.radius}|${state.w}|${state.h}`;
}

function getVessel() {
  const key = vesselKey();
  if (vesselCache && vesselCache.key === key) return vesselCache;
  vesselCache = buildVessel(state.vessel);
  vesselCache.key = key;
  return vesselCache;
}

function buildVessel(kind) {
  const cx = state.cx;
  const cy = state.cy;
  const R = state.radius;

  if (kind === "ellipse") {
    return {
      kind,
      a: R,
      b: R * 0.68,
      cx,
      cy,
    };
  }

  if (kind === "stadium") {
    // Bunimovich stadium: rectangle of half-length L with semicircular caps of radius Rw.
    const rw = R * 0.55;
    const L = R * 0.72;
    return { kind, cx, cy, rw, L };
  }

  if (kind === "annulus") {
    return {
      kind,
      cx,
      cy,
      outer: R,
      inner: R * 0.38,
    };
  }

  if (kind === "twin") {
    // Two disks whose overlap leaves an open coupling window (no wall in the neck).
    const rr = R * 0.72;
    const sep = rr * 1.28;
    return {
      kind,
      chambers: [
        { cx: cx - sep * 0.5, cy, r: rr },
        { cx: cx + sep * 0.5, cy, r: rr },
      ],
    };
  }

  if (kind === "triad") {
    const rr = R * 0.58;
    const orbit = rr * 0.78;
    const chambers = [];
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
      chambers.push({
        cx: cx + Math.cos(a) * orbit,
        cy: cy + Math.sin(a) * orbit,
        r: rr,
      });
    }
    return { kind, chambers };
  }

  if (kind === "chain") {
    // Linear waveguide: a row of equal cavities, each overlapping its neighbor
    // so beams tunnel down the line through the coupling windows.
    const n = 5;
    const rr = R * 0.32;
    const spacing = rr * 1.24; // < 2·rr so neighbors share an open window
    const startX = cx - (spacing * (n - 1)) / 2;
    const chambers = [];
    for (let i = 0; i < n; i++) {
      chambers.push({ cx: startX + i * spacing, cy, r: rr });
    }
    return { kind, chambers };
  }

  if (kind === "flower") {
    // Rosette: a central hub cavity ringed by petals that couple only to the
    // hub, so modes fan out into the petals and refocus back through the core.
    const petals = 6;
    const hub = R * 0.42;
    const petal = R * 0.3;
    const orbit = R * 0.6; // hub↔petal overlap opens a window; petals don't touch
    const chambers = [{ cx, cy, r: hub }];
    for (let i = 0; i < petals; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / petals;
      chambers.push({
        cx: cx + Math.cos(a) * orbit,
        cy: cy + Math.sin(a) * orbit,
        r: petal,
      });
    }
    return { kind, chambers };
  }

  if (kind === "necklace") {
    // Resonance ring: chambers coupled in a closed loop around a hollow core,
    // so energy can circulate lobe-to-lobe all the way around.
    const n = 7;
    const petal = R * 0.32;
    const orbit = R * 0.66; // neighbor overlap couples the loop; center stays void
    const chambers = [];
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
      chambers.push({
        cx: cx + Math.cos(a) * orbit,
        cy: cy + Math.sin(a) * orbit,
        r: petal,
      });
    }
    return { kind, chambers };
  }

  return { kind: "circle", cx, cy, r: R };
}

/** True if a ball center at (px,py) with radius `inset` lies inside the vessel. */
function vesselContains(px, py, inset) {
  const v = getVessel();
  const kind = v.kind;

  if (kind === "circle") {
    const dx = px - v.cx;
    const dy = py - v.cy;
    const maxR = v.r - inset;
    return dx * dx + dy * dy <= maxR * maxR;
  }

  if (kind === "ellipse") {
    const a = v.a - inset;
    const b = v.b - inset;
    if (a <= 0 || b <= 0) return false;
    const dx = px - v.cx;
    const dy = py - v.cy;
    return (dx * dx) / (a * a) + (dy * dy) / (b * b) <= 1;
  }

  if (kind === "stadium") {
    const rw = v.rw - inset;
    if (rw <= 0) return false;
    const L = v.L;
    const dx = px - v.cx;
    const dy = py - v.cy;
    const ax = Math.abs(dx);
    if (ax <= L) return Math.abs(dy) <= rw;
    const hx = ax - L;
    return hx * hx + dy * dy <= rw * rw;
  }

  if (kind === "annulus") {
    const dx = px - v.cx;
    const dy = py - v.cy;
    const d2 = dx * dx + dy * dy;
    const outer = v.outer - inset;
    const inner = v.inner + inset;
    return d2 <= outer * outer && d2 >= inner * inner;
  }

  // twin / triad — union of disks
  for (let i = 0; i < v.chambers.length; i++) {
    const c = v.chambers[i];
    const dx = px - c.cx;
    const dy = py - c.cy;
    const maxR = c.r - inset;
    if (dx * dx + dy * dy <= maxR * maxR) return true;
  }
  return false;
}

/** Project a point into the vessel (for spawn clamping). Returns [x,y]. */
function vesselProject(px, py, inset) {
  const v = getVessel();
  const kind = v.kind;

  if (kind === "circle") {
    const dx = px - v.cx;
    const dy = py - v.cy;
    const maxR = Math.max(0, v.r - inset);
    const d2 = dx * dx + dy * dy;
    if (d2 <= maxR * maxR) return [px, py];
    const d = Math.sqrt(d2) || 1;
    return [v.cx + (dx / d) * maxR, v.cy + (dy / d) * maxR];
  }

  if (kind === "ellipse") {
    const a = Math.max(1e-6, v.a - inset);
    const b = Math.max(1e-6, v.b - inset);
    let dx = px - v.cx;
    let dy = py - v.cy;
    const s = Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b));
    if (s <= 1) return [px, py];
    return [v.cx + dx / s, v.cy + dy / s];
  }

  if (kind === "stadium") {
    const rw = Math.max(1e-6, v.rw - inset);
    const L = v.L;
    let dx = px - v.cx;
    let dy = py - v.cy;
    const ax = Math.abs(dx);
    if (ax <= L) {
      if (Math.abs(dy) > rw) dy = Math.sign(dy || 1) * rw;
      return [v.cx + dx, v.cy + dy];
    }
    const hx = ax - L;
    const d2 = hx * hx + dy * dy;
    if (d2 <= rw * rw) return [px, py];
    const d = Math.sqrt(d2) || 1;
    const nx = (hx / d) * rw;
    const ny = (dy / d) * rw;
    return [v.cx + Math.sign(dx || 1) * (L + nx), v.cy + ny];
  }

  if (kind === "annulus") {
    const dx = px - v.cx;
    const dy = py - v.cy;
    const d = Math.hypot(dx, dy) || 1;
    const outer = Math.max(0, v.outer - inset);
    const inner = v.inner + inset;
    let rr = d;
    if (rr > outer) rr = outer;
    if (rr < inner) rr = inner;
    return [v.cx + (dx / d) * rr, v.cy + (dy / d) * rr];
  }

  // twin / triad: pull into the nearest chamber disk
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < v.chambers.length; i++) {
    const c = v.chambers[i];
    const dx = px - c.cx;
    const dy = py - c.cy;
    const d = Math.hypot(dx, dy);
    const maxR = Math.max(0, c.r - inset);
    if (d <= maxR) return [px, py];
    const over = d - maxR;
    if (over < bestD) {
      bestD = over;
      const s = d || 1;
      best = [c.cx + (dx / s) * maxR, c.cy + (dy / s) * maxR];
    }
  }
  return best || [v.chambers[0].cx, v.chambers[0].cy];
}

/** An interior "pull toward" point for the region nearest (px,py). */
function vesselAnchor(px, py) {
  const v = getVessel();
  const kind = v.kind;

  if (kind === "annulus") {
    const dx = px - v.cx;
    const dy = py - v.cy;
    const d = Math.hypot(dx, dy) || 1;
    const rr = (v.inner + v.outer) * 0.5;
    return [v.cx + (dx / d) * rr, v.cy + (dy / d) * rr];
  }

  if (v.chambers) {
    let best = v.chambers[0];
    let bd = Infinity;
    for (const c of v.chambers) {
      const dd = (px - c.cx) * (px - c.cx) + (py - c.cy) * (py - c.cy);
      if (dd < bd) {
        bd = dd;
        best = c;
      }
    }
    return [best.cx, best.cy];
  }

  return [v.cx, v.cy];
}

/**
 * Move a spawn point that fell outside the vessel back *inside* it.
 * Rather than snapping to the rim (which piles balls on the wall and makes
 * them glide along it), walk inward from the wall toward an interior anchor by
 * a randomized fraction so relocated balls fill the interior.
 */
function relocateInside(px, py, coreR) {
  if (vesselContains(px, py, coreR)) return [px, py];

  const [bx, by] = vesselProject(px, py, coreR);
  const [ax, ay] = vesselAnchor(bx, by);

  const f = 0.18 + Math.random() * 0.7;
  const rx = bx + (ax - bx) * f;
  const ry = by + (ay - by) * f;
  if (vesselContains(rx, ry, coreR)) return [rx, ry];

  for (let t = 0.25; t <= 1.0001; t += 0.25) {
    const qx = bx + (ax - bx) * t;
    const qy = by + (ay - by) * t;
    if (vesselContains(qx, qy, coreR)) return [qx, qy];
  }
  return [ax, ay];
}

/** Normalize click offset (−1..1 of radius) into a vessel-valid spawn. */
function clampSpawnOffset(nx, ny) {
  const R = state.radius;
  const [px, py] = vesselProject(
    state.cx + nx * R,
    state.cy + ny * R,
    state.ballR || R * 0.02
  );
  return [(px - state.cx) / R, (py - state.cy) / R];
}

function reflectVelocity(vx, vy, nx, ny, e) {
  const vn = vx * nx + vy * ny;
  if (vn <= 0) return [vx, vy];
  return [vx - (1 + e) * vn * nx, vy - (1 + e) * vn * ny];
}

/**
 * Earliest exit time t∈(0,1] of ray p + t·d from a disk of radius maxR.
 * Returns Infinity if no outward crossing in range.
 */
function diskExitT(rx, ry, dx, dy, maxR) {
  const maxR2 = maxR * maxR;
  const A = dx * dx + dy * dy;
  const B = 2 * (rx * dx + ry * dy);
  const C = rx * rx + ry * ry - maxR2;
  if (A === 0) return Infinity;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / (2 * A);
  const t2 = (-B + sq) / (2 * A);
  let t = Infinity;
  // Outward exit is the larger root when starting inside. Both roots must land
  // within this step (t ≤ 1); otherwise the wall is farther than we travel and
  // there's no hit — without the t2 ≤ 1 clamp the ball teleports to the rim.
  if (t1 > 1e-9 && t1 <= 1) t = t1;
  if (t2 > 1e-9 && t2 <= 1 && t2 < t) t = t2;
  return t;
}

/** Earliest entry time into a forbidden inner disk (annulus hole). */
function diskEnterT(rx, ry, dx, dy, minR) {
  const minR2 = minR * minR;
  const A = dx * dx + dy * dy;
  const B = 2 * (rx * dx + ry * dy);
  const C = rx * rx + ry * ry - minR2;
  if (A === 0) return Infinity;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / (2 * A);
  const t2 = (-B + sq) / (2 * A);
  // Entering from outside: take the smaller positive root within this step.
  let t = Infinity;
  if (t1 > 1e-9 && t1 <= 1) t = t1;
  if (t2 > 1e-9 && t2 <= 1 && t2 < t) t = t2;
  return t;
}

function ellipseExitT(rx, ry, dx, dy, a, b) {
  // |(p-c) + t d| on ellipse: (rx+t dx)^2/a^2 + (ry+t dy)^2/b^2 = 1
  const A = (dx * dx) / (a * a) + (dy * dy) / (b * b);
  const B = 2 * ((rx * dx) / (a * a) + (ry * dy) / (b * b));
  const C = (rx * rx) / (a * a) + (ry * ry) / (b * b) - 1;
  if (A === 0) return Infinity;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / (2 * A);
  const t2 = (-B + sq) / (2 * A);
  let t = Infinity;
  if (t1 > 1e-9 && t1 <= 1) t = t1;
  if (t2 > 1e-9 && t2 <= 1 && t2 < t) t = t2;
  return t;
}

/**
 * Find the soonest boundary hit for a free-flight step, returning
 * { t, nx, ny } where (nx,ny) is the outward unit normal at contact.
 */
function findVesselHit(px, py, vx, vy, remaining, inset) {
  const v = getVessel();
  const kind = v.kind;
  const dx = vx * remaining;
  const dy = vy * remaining;

  if (kind === "circle") {
    const maxR = v.r - inset;
    const t = diskExitT(px - v.cx, py - v.cy, dx, dy, maxR);
    if (!isFinite(t)) return null;
    const hx = px + dx * t;
    const hy = py + dy * t;
    const nx = (hx - v.cx) / maxR;
    const ny = (hy - v.cy) / maxR;
    return { t, nx, ny, hx, hy };
  }

  if (kind === "ellipse") {
    const a = v.a - inset;
    const b = v.b - inset;
    if (a <= 0 || b <= 0) return null;
    const t = ellipseExitT(px - v.cx, py - v.cy, dx, dy, a, b);
    if (!isFinite(t)) return null;
    const hx = px + dx * t;
    const hy = py + dy * t;
    // Gradient of x²/a² + y²/b²
    let nx = (hx - v.cx) / (a * a);
    let ny = (hy - v.cy) / (b * b);
    const nlen = Math.hypot(nx, ny) || 1;
    nx /= nlen;
    ny /= nlen;
    return { t, nx, ny, hx, hy };
  }

  if (kind === "stadium") {
    const rw = v.rw - inset;
    const L = v.L;
    let best = null;

    // Top / bottom flats (|x|<=L, y = ±rw)
    if (Math.abs(dy) > 1e-12) {
      for (const sign of [-1, 1]) {
        const t = (v.cy + sign * rw - py) / dy;
        if (t > 1e-9 && t <= 1) {
          const hx = px + dx * t;
          if (Math.abs(hx - v.cx) <= L + 1e-6) {
            if (!best || t < best.t) {
              best = { t, nx: 0, ny: sign, hx, hy: py + dy * t };
            }
          }
        }
      }
    }

    // Left / right semicaps
    for (const side of [-1, 1]) {
      const ccx = v.cx + side * L;
      const t = diskExitT(px - ccx, py - v.cy, dx, dy, rw);
      if (!isFinite(t)) continue;
      const hx = px + dx * t;
      const hy = py + dy * t;
      // Only the outer half-cap counts as boundary.
      if ((hx - v.cx) * side < L - 1e-6) continue;
      const nx = (hx - ccx) / rw;
      const ny = (hy - v.cy) / rw;
      if (!best || t < best.t) best = { t, nx, ny, hx, hy };
    }
    return best;
  }

  if (kind === "annulus") {
    const outer = v.outer - inset;
    const inner = v.inner + inset;
    let best = null;
    const tOut = diskExitT(px - v.cx, py - v.cy, dx, dy, outer);
    if (isFinite(tOut)) {
      const hx = px + dx * tOut;
      const hy = py + dy * tOut;
      best = {
        t: tOut,
        nx: (hx - v.cx) / outer,
        ny: (hy - v.cy) / outer,
        hx,
        hy,
      };
    }
    const tIn = diskEnterT(px - v.cx, py - v.cy, dx, dy, inner);
    if (isFinite(tIn) && (!best || tIn < best.t)) {
      const hx = px + dx * tIn;
      const hy = py + dy * tIn;
      // Outward normal of the playable region points toward the hole center.
      best = {
        t: tIn,
        nx: -(hx - v.cx) / inner,
        ny: -(hy - v.cy) / inner,
        hx,
        hy,
      };
    }
    return best;
  }

  // twin / triad: exit the union = leave a disk while outside every other disk
  let best = null;
  const chambers = v.chambers;
  for (let i = 0; i < chambers.length; i++) {
    const c = chambers[i];
    const maxR = c.r - inset;
    if (maxR <= 0) continue;
    const t = diskExitT(px - c.cx, py - c.cy, dx, dy, maxR);
    if (!isFinite(t)) continue;
    const hx = px + dx * t;
    const hy = py + dy * t;
    let inOther = false;
    for (let j = 0; j < chambers.length; j++) {
      if (j === i) continue;
      const o = chambers[j];
      const or = o.r - inset;
      const odx = hx - o.cx;
      const ody = hy - o.cy;
      if (odx * odx + ody * ody <= or * or + 1e-4) {
        inOther = true;
        break;
      }
    }
    if (inOther) continue; // still inside the union via the window / other lobe
    const nx = (hx - c.cx) / maxR;
    const ny = (hy - c.cy) / maxR;
    if (!best || t < best.t) best = { t, nx, ny, hx, hy };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Presets — two built-ins plus user-saved presets kept in localStorage.
// ---------------------------------------------------------------------------

const BUILTIN_PRESETS = [
  {
    id: "builtin:balanced",
    name: "Balanced Drop",
    builtin: true,
    values: {
      ballsExp: 12,
      size: 1,
      pack: 1,
      heading: 315,
      velocity: 1,
      collide: false,
      colorMode: "xy",
      vessel: "circle",
      spawn: "gaussian",
    },
  },
  {
    id: "builtin:beam",
    name: "Parallel Beam",
    builtin: true,
    values: {
      ballsExp: 12,
      size: 0.4,
      pack: 0.45,
      heading: 90,
      velocity: 2.5,
      collide: false,
      colorMode: "angle",
      vessel: "circle",
      spawn: "gaussian",
    },
  },
  {
    id: "builtin:revival",
    name: "Star Revival",
    builtin: true,
    values: {
      ballsExp: 11,
      size: 0.6,
      pack: 1,
      heading: 90,
      velocity: 1,
      collide: false,
      colorMode: "angle",
      vessel: "circle",
      spawn: "star",
      orbit: true,
      orbitP: 1,
      orbitQ: 5,
    },
  },
  {
    id: "builtin:twin",
    name: "Coupled Chambers",
    builtin: true,
    values: {
      ballsExp: 12,
      size: 0.45,
      pack: 0.55,
      heading: 20,
      velocity: 2.2,
      collide: false,
      colorMode: "angle",
      vessel: "twin",
      spawn: "gaussian",
    },
  },
  {
    id: "builtin:triad",
    name: "Triple Resonance",
    builtin: true,
    values: {
      ballsExp: 12,
      size: 0.4,
      pack: 0.5,
      heading: 90,
      velocity: 1.8,
      collide: false,
      colorMode: "xy",
      vessel: "triad",
      spawn: "ring",
    },
  },
  {
    id: "builtin:annulus",
    name: "Ring Chamber",
    builtin: true,
    values: {
      ballsExp: 12,
      size: 0.5,
      pack: 0.7,
      heading: 45,
      velocity: 2,
      collide: false,
      colorMode: "angle",
      vessel: "annulus",
      spawn: "arc",
    },
  },
  {
    id: "builtin:chain",
    name: "Waveguide Chain",
    builtin: true,
    values: {
      ballsExp: 12,
      size: 0.4,
      pack: 0.45,
      heading: 0,
      velocity: 2.4,
      collide: false,
      colorMode: "index",
      vessel: "chain",
      spawn: "gaussian",
    },
  },
  {
    id: "builtin:flower",
    name: "Rosette Bloom",
    builtin: true,
    values: {
      ballsExp: 12,
      size: 0.4,
      pack: 0.5,
      heading: 90,
      velocity: 1.8,
      collide: false,
      colorMode: "angle",
      vessel: "flower",
      spawn: "ring",
    },
  },
  {
    id: "builtin:necklace",
    name: "Resonance Ring",
    builtin: true,
    values: {
      ballsExp: 12,
      size: 0.4,
      pack: 0.6,
      heading: 30,
      velocity: 2,
      collide: false,
      colorMode: "angle",
      vessel: "necklace",
      spawn: "ring",
    },
  },
];

const PRESETS_STORAGE_KEY = "circleDrop.presets.v1";

function loadCustomPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCustomPresets(list) {
  try {
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // localStorage unavailable (private mode, quota, etc.) — preset just won't persist.
  }
}

let customPresets = loadCustomPresets();

function currentSettingsSnapshot() {
  return {
    ballsExp: Number(ui.balls.value),
    size: Number(ui.size.value),
    pack: Number(ui.pack.value),
    heading: Number(ui.heading.value),
    velocity: velocityMultiplierFromSlider(),
    collide: ui.collide.checked,
    colorMode: ui.colorMode.value,
    vessel: ui.vessel.value,
    spawn: ui.spawn.value,
    orbit: ui.orbit.checked,
    orbitP: Number(ui.orbitP.value),
    orbitQ: Number(ui.orbitQ.value),
  };
}

function applyPresetValues(values) {
  ui.balls.value = String(values.ballsExp);
  ui.size.value = String(values.size);
  ui.pack.value = String(values.pack);
  ui.heading.value = String(values.heading);
  ui.velocity.value = String(Math.log10(Math.max(values.velocity, 0.1)));
  ui.collide.checked = !!values.collide;
  ui.colorMode.value = values.colorMode;
  ui.vessel.value = values.vessel || "circle";
  ui.spawn.value = values.spawn;
  ui.orbit.checked = !!values.orbit && ui.vessel.value === "circle";
  if (values.orbitP != null) ui.orbitP.value = String(values.orbitP);
  if (values.orbitQ != null) ui.orbitQ.value = String(values.orbitQ);

  // A preset restarts the run from its own center, ignoring any clicked spot.
  state.spawnNX = 0;
  state.spawnNY = 0;
  state.collideBalls = ui.collide.checked;
  state.vessel = ui.vessel.value;
  vesselCache = null;
  updateCollideHint(ballCountFromSlider());
  updateVesselHint();
  updateOrbitReadout();

  rebuild(ballCountFromSlider());
}

function findPreset(id) {
  return (
    BUILTIN_PRESETS.find((p) => p.id === id) ||
    customPresets.find((p) => p.id === id)
  );
}

function renderPresetOptions(selectId) {
  const sel = ui.presetSelect;
  const prevValue = selectId || sel.value;
  sel.innerHTML = "";

  const addGroup = (label, items) => {
    if (!items.length) return;
    const group = document.createElement("optgroup");
    group.label = label;
    items.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      group.appendChild(opt);
    });
    sel.appendChild(group);
  };

  addGroup("Built-in", BUILTIN_PRESETS);
  addGroup("Saved", customPresets);

  const stillExists = [...BUILTIN_PRESETS, ...customPresets].some(
    (p) => p.id === prevValue
  );
  sel.value = stillExists ? prevValue : BUILTIN_PRESETS[1].id;
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  state.dpr = Math.min(window.devicePixelRatio || 1, 2);
  state.w = Math.max(1, Math.floor(rect.width * state.dpr));
  state.h = Math.max(1, Math.floor(rect.height * state.dpr));
  canvas.width = state.w;
  canvas.height = state.h;
  state.cx = state.w * 0.5;
  state.cy = state.h * 0.52;
  state.radius = Math.min(state.w, state.h) * 0.42;
  vesselCache = null;
}

function computeBallRadius(count) {
  // Size balls so a full count roughly fills the bowl, scaled by the slider.
  const area = Math.PI * state.radius * state.radius * 0.62;
  const base = Math.sqrt(area / (count * Math.PI));
  // Allow sub-device-pixel radii at huge counts; the renderer floors to 1px.
  return Math.max(0.4 * state.dpr, base * Number(ui.size.value));
}

function applyRadii() {
  state.ballR = computeBallRadius(state.count || ballCountFromSlider());
  state.cellSize = Math.max(state.ballR * 2.15, 1);
  state.gridW = Math.ceil(state.w / state.cellSize) + 2;
  state.gridH = Math.ceil(state.h / state.cellSize) + 2;
  if (!state.heads || state.heads.length !== state.gridW * state.gridH) {
    state.heads = new Int32Array(state.gridW * state.gridH);
  }
}

function spawnPositions(count, coreR) {
  const positions = [];
  const mode = state.spawn;
  const cx = state.cx;
  const cy = state.cy;
  const R = state.radius;
  // Packing radius multiplier: <1 packs tighter, >1 spreads the cluster out.
  const pack = Number(ui.pack.value);
  const gap = Math.max(coreR * 1.02, R / Math.sqrt(count) * 0.9) * pack;

  if (mode === "gaussian") {
    // Tight Gaussian ball: spread scales with count and the packing radius.
    const sigma = Math.max(coreR, R / Math.sqrt(count) * 0.9)
      * Math.sqrt(count) * 0.32 * pack;
    const clampR = R * 0.98;
    // Box–Muller for a 2D normal distribution around the bowl center
    for (let i = 0; i < count; i++) {
      let gx;
      let gy;
      do {
        const u1 = Math.random() || 1e-9;
        const u2 = Math.random();
        const mag = Math.sqrt(-2 * Math.log(u1));
        gx = mag * Math.cos(2 * Math.PI * u2) * sigma;
        gy = mag * Math.sin(2 * Math.PI * u2) * sigma;
      } while (gx * gx + gy * gy > clampR * clampR);
      positions.push(cx + gx, cy + gy);
    }
  } else if (mode === "line") {
    const y = cy - R * 0.55;
    const span = R * 1.55;
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      positions.push(cx - span * 0.5 + t * span, y);
    }
  } else if (mode === "rain") {
    const cols = Math.ceil(Math.sqrt(count * 1.6));
    const rows = Math.ceil(count / cols);
    const startX = cx - ((cols - 1) * gap) * 0.5;
    const startY = cy - R * 0.85;
    let i = 0;
    for (let row = 0; row < rows && i < count; row++) {
      for (let col = 0; col < cols && i < count; col++) {
        const jitter = ((i * 17) % 7) * 0.12 * coreR;
        positions.push(startX + col * gap + jitter, startY - row * gap * 0.9);
        i++;
      }
    }
  } else if (mode === "ring") {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 - Math.PI * 0.5;
      const rr = R - coreR * 2.2;
      positions.push(
        cx + Math.cos(a) * rr,
        cy + Math.sin(a) * rr * 0.35 - R * 0.35
      );
    }
  } else if (mode === "star") {
    // Five-point star outline — a recognizable shape to watch dissolve/re-form.
    const points = 5;
    const outer = R * 0.82;
    const inner = R * 0.34;
    const segs = points * 2;
    for (let i = 0; i < count; i++) {
      const t = (i / count) * segs; // which edge of the star
      const seg = Math.floor(t);
      const f = t - seg;
      const r0 = seg % 2 === 0 ? outer : inner;
      const r1 = seg % 2 === 0 ? inner : outer;
      const a0 = (seg / segs) * Math.PI * 2 - Math.PI / 2;
      const a1 = ((seg + 1) / segs) * Math.PI * 2 - Math.PI / 2;
      const rr = r0 + (r1 - r0) * f;
      const aa = a0 + (a1 - a0) * f;
      positions.push(cx + Math.cos(aa) * rr, cy + Math.sin(aa) * rr);
    }
  } else if (mode === "arc") {
    // A thick angular band in the upper region.
    const rows = Math.max(2, Math.round(Math.sqrt(count / 6)));
    const per = Math.ceil(count / rows);
    let i = 0;
    for (let row = 0; row < rows && i < count; row++) {
      const rr = R * (0.55 + 0.32 * (row / Math.max(1, rows - 1)));
      for (let k = 0; k < per && i < count; k++) {
        const a = -Math.PI * 0.9 + (k / Math.max(1, per - 1)) * Math.PI * 0.8;
        positions.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
        i++;
      }
    }
  } else {
    const cols = Math.ceil(Math.sqrt(count * 1.15));
    const rows = Math.ceil(count / cols) + 2;
    const startX = cx - ((cols - 1) * gap) * 0.5;
    const startY = cy - R * 0.72;
    let i = 0;
    for (let row = 0; row < rows && i < count; row++) {
      const offset = (row % 2) * (gap * 0.5);
      for (let col = 0; col < cols && i < count; col++) {
        const x = startX + col * gap + offset;
        const y = startY - row * gap * 0.866;
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy < (R - coreR) * (R - coreR) || y < cy) {
          positions.push(x, y);
          i++;
        }
      }
    }
    while (positions.length / 2 < count) {
      const i = positions.length / 2;
      const t = i / count;
      positions.push(
        cx + (t - 0.5) * R * 1.4,
        cy - R * 0.9 - (i % 20) * gap
      );
    }
  }

  // Translate the whole cluster to the chosen spawn point, then pull any point
  // that landed outside the vessel back into its interior (not onto the rim).
  const offX = state.spawnNX * R;
  const offY = state.spawnNY * R;
  for (let k = 0; k < positions.length; k += 2) {
    const [px, py] = relocateInside(
      positions[k] + offX,
      positions[k + 1] + offY,
      coreR
    );
    positions[k] = px;
    positions[k + 1] = py;
  }

  return positions;
}

/** Largest lattice edge (nodes per side) allowed in sheet mode, for smooth fps. */
const SHEET_MAX_SIDE = 120;

function rebuild(count) {
  if (ui.mode3d && ui.mode3d.checked) {
    rebuild3d();
    return;
  }
  state3d.enabled = false;
  resize();
  state.heading = headingRadians();
  state.speed = launchSpeed();
  state.collideBalls = ui.collide.checked;
  state.colorMode = ui.colorMode.value;
  state.vessel = ui.vessel.value;
  state.spawn = ui.spawn.value;
  state.orbit = ui.orbit.checked && state.vessel === "circle";
  state.sheet = ui.sheet.checked;

  // Sheet mode needs a perfect square lattice with fixed connectivity, and the
  // per-node ball–ball collisions would just shred the mesh, so force them off.
  if (state.sheet) {
    const side = Math.max(16, Math.min(SHEET_MAX_SIDE, Math.round(Math.sqrt(count))));
    state.sheetCols = side;
    state.sheetRows = side;
    count = side * side;
    state.collideBalls = false;
    state.orbit = false;
  }

  state.count = count;
  state.stepCount = 0;
  vesselCache = null;
  imageData = null; // start any long-exposure trail fresh on a new run
  applyRadii();

  const n = count;
  state.x = new Float32Array(n);
  state.y = new Float32Array(n);
  state.vx = new Float32Array(n);
  state.vy = new Float32Array(n);
  state.ox = new Float32Array(n);
  state.oy = new Float32Array(n);
  state.colors = new Uint32Array(n);
  state.next = new Int32Array(n);

  if (state.sheet) {
    buildSheetLattice(n);
  } else if (state.orbit) {
    buildRevivalOrbit(n);
  } else {
    // Every ball launches with the same heading, so the cluster flies parallel.
    const vx = Math.cos(state.heading) * state.speed;
    const vy = Math.sin(state.heading) * state.speed;
    const pos = spawnPositions(n, state.ballR);
    for (let i = 0; i < n; i++) {
      const x = pos[i * 2];
      const y = pos[i * 2 + 1];
      state.x[i] = x;
      state.y[i] = y;
      state.ox[i] = x;
      state.oy[i] = y;
      state.vx[i] = vx;
      state.vy[i] = vy;
      state.colors[i] = colorFromOrigin(x, y, i, n);
    }
  }

  updateOutputs();
}

/**
 * Paint a sheet node from its lattice UV (and/or birth position). UV gradients
 * stay a clear "ink pattern" on the ribbon no matter how the sheet folds.
 */
function colorFromSheet(u, v, ox, oy, index, count) {
  const mode = state.sheetColor;
  let h;
  let s = 0.82;
  let l = 0.55;

  if (mode === "u") {
    h = u * 300;
  } else if (mode === "v") {
    h = v * 300;
  } else if (mode === "diag") {
    h = ((u + v) * 0.5) * 300;
  } else if (mode === "radial") {
    const du = u - 0.5;
    const dv = v - 0.5;
    h = Math.min(1, Math.hypot(du, dv) * 2) * 300;
  } else if (mode === "angle") {
    h = ((Math.atan2(v - 0.5, u - 0.5) + Math.PI) / (Math.PI * 2)) * 360;
  } else if (mode === "xy") {
    return colorFromOrigin(ox, oy, index, count);
  } else {
    // uv — clear 2D ink: hue from U, lightness from V
    h = u * 300;
    l = 0.32 + v * 0.42;
  }

  const [r, g, b] = hslToRgb(h, s, l);
  return (255 << 24) | (b << 16) | (g << 8) | r;
}

/**
 * Lay out a square lattice of nodes (a flat "sheet" of material) centered on the
 * spawn point. Row-major index j*cols+i gives fixed 4-neighbour connectivity, so
 * the renderer can draw it as a continuous surface that folds instead of thinning
 * into loose dots. Every node launches with the shared heading, like the dots.
 */
function buildSheetLattice(n) {
  const side = state.sheetCols;
  const R = state.radius;
  const pack = Number(ui.pack.value);
  // Packing radius scales how large the initial flat sheet is inside the vessel.
  const L = R * 0.95 * Math.min(1.4, Math.max(0.25, pack));
  const s0 = L / Math.max(1, side - 1);
  state.sheetSpacing = s0;
  state.sheetColor = ui.sheetColor.value;

  const offX = state.spawnNX * R;
  const offY = state.spawnNY * R;
  const startX = state.cx + offX - L * 0.5;
  const startY = state.cy + offY - L * 0.5;

  const vx = Math.cos(state.heading) * state.speed;
  const vy = Math.sin(state.heading) * state.speed;
  const denom = Math.max(1, side - 1);

  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const idx = j * side + i;
      const u = i / denom;
      const v = j / denom;
      // relocateInside is a no-op for points already inside, so a fitting sheet
      // stays perfectly flat; only nodes poking past a wall get nudged in.
      const [px, py] = relocateInside(startX + i * s0, startY + j * s0, state.ballR);
      state.x[idx] = px;
      state.y[idx] = py;
      state.ox[idx] = px;
      state.oy[idx] = py;
      state.vx[idx] = vx;
      state.vy[idx] = vy;
      state.colors[idx] = colorFromSheet(u, v, px, py, idx, n);
    }
  }
}

/**
 * Build a rational revival orbit: take the chosen shape, fold it into the
 * annulus outside the caustic circle, and launch each ball tangent to that
 * caustic. All balls then share one period and re-form the shape on cycle.
 */
function buildRevivalOrbit(n) {
  const g = orbitGeometry();
  state.orbitBounces = g.bounces;
  state.orbitPeriod = g.period;
  state.orbitCaustic = g.caustic;

  const cx = state.cx;
  const cy = state.cy;
  const Rw = state.radius - state.ballR;
  const bInner = Math.min(g.caustic + state.ballR * 0.5, Rw * 0.97);
  const bOuter = Rw * 0.995;
  const speed = state.speed;

  // Revival needs a center-based caustic, so ignore any click-placed offset.
  const savedNX = state.spawnNX;
  const savedNY = state.spawnNY;
  state.spawnNX = 0;
  state.spawnNY = 0;
  const pos = spawnPositions(n, state.ballR);
  state.spawnNX = savedNX;
  state.spawnNY = savedNY;

  for (let i = 0; i < n; i++) {
    let dx = pos[i * 2] - cx;
    let dy = pos[i * 2 + 1] - cy;
    let r = Math.hypot(dx, dy);
    let phi;
    if (r < 1e-6) {
      phi = Math.random() * Math.PI * 2;
    } else {
      phi = Math.atan2(dy, dx);
    }
    // Fold the shape's radius into the annulus [bInner, bOuter].
    const rNorm = Math.min(1, r / Rw);
    const rr = bInner + (bOuter - bInner) * rNorm;

    const x = cx + Math.cos(phi) * rr;
    const y = cy + Math.sin(phi) * rr;

    // Velocity tangent to the caustic (radius g.caustic), consistent CCW sense.
    const ratio = Math.min(1, g.caustic / rr);
    const delta = phi + Math.PI - Math.asin(ratio);

    state.x[i] = x;
    state.y[i] = y;
    state.ox[i] = x;
    state.oy[i] = y;
    state.vx[i] = Math.cos(delta) * speed;
    state.vy[i] = Math.sin(delta) * speed;
    state.colors[i] = colorFromOrigin(x, y, i, n);
  }
}

function clearHash() {
  state.heads.fill(-1);
}

function insertHash(i) {
  const cx = Math.floor(state.x[i] / state.cellSize);
  const cy = Math.floor(state.y[i] / state.cellSize);
  if (cx < 0 || cy < 0 || cx >= state.gridW || cy >= state.gridH) {
    state.next[i] = -1;
    return;
  }
  const idx = cy * state.gridW + cx;
  state.next[i] = state.heads[idx];
  state.heads[idx] = i;
}

/**
 * Elastic (billiard-style) ball–ball collision, equal mass. Only used when
 * "Ball collisions" is enabled; otherwise balls ignore each other entirely.
 */
function collidePair(i, j, minDist) {
  let dx = state.x[j] - state.x[i];
  let dy = state.y[j] - state.y[i];
  let dist2 = dx * dx + dy * dy;
  const min2 = minDist * minDist;

  if (dist2 < 1e-10) {
    const a = (i * 12.9898 + j * 78.233) % (Math.PI * 2);
    dx = Math.cos(a) * 1e-3;
    dy = Math.sin(a) * 1e-3;
    dist2 = dx * dx + dy * dy;
  }
  if (dist2 >= min2) return;

  const dist = Math.sqrt(dist2);
  const nx = dx / dist;
  const ny = dy / dist;

  // Positional correction so they don't sink into each other
  const overlap = (minDist - dist) * 0.5;
  state.x[i] -= nx * overlap;
  state.y[i] -= ny * overlap;
  state.x[j] += nx * overlap;
  state.y[j] += ny * overlap;

  const rvx = state.vx[j] - state.vx[i];
  const rvy = state.vy[j] - state.vy[i];
  const velN = rvx * nx + rvy * ny;
  if (velN >= 0) return;

  const e = state.restitution;
  const jImp = (-(1 + e) * velN) * 0.5;
  state.vx[i] -= jImp * nx;
  state.vy[i] -= jImp * ny;
  state.vx[j] += jImp * nx;
  state.vy[j] += jImp * ny;
}

function resolveCollisions() {
  const n = state.count;
  const minDist = state.ballR * 2;
  const gw = state.gridW;

  clearHash();
  for (let i = 0; i < n; i++) insertHash(i);

  for (let i = 0; i < n; i++) {
    const cx = Math.floor(state.x[i] / state.cellSize);
    const cy = Math.floor(state.y[i] / state.cellSize);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const gx = cx + ox;
        const gy = cy + oy;
        if (gx < 0 || gy < 0 || gx >= gw || gy >= state.gridH) continue;
        let j = state.heads[gy * gw + gx];
        while (j !== -1) {
          if (j > i) collidePair(i, j, minDist);
          j = state.next[j];
        }
      }
    }
  }
}

/**
 * Safety projection: if a ball is left outside the vessel (e.g. pushed there by a
 * ball–ball collision), pull it back inside and flip the outward velocity.
 */
function constrainVessel(i) {
  const inset = state.ballR;
  if (vesselContains(state.x[i], state.y[i], inset)) return;

  const ox = state.x[i];
  const oy = state.y[i];
  const [px, py] = vesselProject(ox, oy, inset);
  let nx = ox - px;
  let ny = oy - py;
  const nlen = Math.hypot(nx, ny) || 1;
  nx /= nlen;
  ny /= nlen;

  const [nvx, nvy] = reflectVelocity(
    state.vx[i],
    state.vy[i],
    nx,
    ny,
    state.restitution
  );
  state.vx[i] = nvx;
  state.vy[i] = nvy;
  state.x[i] = px;
  state.y[i] = py;
}

/**
 * Advance one ball by time `h` with continuous reflections off the vessel wall.
 * Solves segment–boundary intersections so bounce points stay step-size independent.
 * Always tests for an exit along the ray (needed for concave unions like twin/triad,
 * where the endpoint can sit back inside after clipping a cusp).
 */
function advanceBall(i, h) {
  const inset = state.ballR;
  const e = state.restitution;

  let px = state.x[i];
  let py = state.y[i];
  let vx = state.vx[i];
  let vy = state.vy[i];
  let remaining = h;

  for (let guard = 0; guard < 24; guard++) {
    const hit = findVesselHit(px, py, vx, vy, remaining, inset);
    if (!hit) {
      px += vx * remaining;
      py += vy * remaining;
      if (!vesselContains(px, py, inset)) {
        // Concave unions (twin / chain / rosette / …) can leave the segment just
        // past a window cusp with no clean crossing detected. Project back inside
        // AND reflect the outward velocity — otherwise the ball pins to the wall
        // and glides along it, so over time every ball piles onto the rim.
        const [qx, qy] = vesselProject(px, py, inset);
        let nx = px - qx;
        let ny = py - qy;
        const nlen = Math.hypot(nx, ny);
        if (nlen > 1e-9) {
          nx /= nlen;
          ny /= nlen;
          const reflected = reflectVelocity(vx, vy, nx, ny, e);
          vx = reflected[0];
          vy = reflected[1];
        }
        px = qx;
        py = qy;
      }
      break;
    }

    px = hit.hx;
    py = hit.hy;
    const reflected = reflectVelocity(vx, vy, hit.nx, hit.ny, e);
    vx = reflected[0];
    vy = reflected[1];

    // Nudge slightly inward so the next query doesn't re-hit the same wall.
    px -= hit.nx * 1e-4;
    py -= hit.ny * 1e-4;

    remaining *= 1 - hit.t;
    if (remaining <= 1e-12) break;
  }

  state.x[i] = px;
  state.y[i] = py;
  state.vx[i] = vx;
  state.vy[i] = vy;
}

function step(dt) {
  const n = state.count;

  // Free flight (no ball–ball collisions): exact continuous reflection, so one
  // pass handles any speed and the pattern depends only on elapsed time.
  if (!(state.collideBalls && n <= COLLISION_LIMIT)) {
    for (let i = 0; i < n; i++) advanceBall(i, dt);
    return;
  }

  // Collisions on: substep so overlaps resolve before balls travel too far.
  const travel = state.speed * dt;
  const sub = Math.min(8, Math.max(1, Math.ceil(travel / (state.radius * 0.5))));
  const h = dt / sub;
  for (let s = 0; s < sub; s++) {
    for (let i = 0; i < n; i++) advanceBall(i, h);
    const passes = n > 8000 ? 3 : n > 2000 ? 2 : 1;
    for (let p = 0; p < passes; p++) resolveCollisions();
    for (let i = 0; i < n; i++) constrainVessel(i);
  }
}

let imageData = null;

function drawBallsImageData() {
  const { w, h, count, ballR, colors, x, y } = state;
  if (!imageData || imageData.width !== w || imageData.height !== h) {
    imageData = ctx.createImageData(w, h);
  }
  const data = imageData.data;

  for (let p = 0; p < data.length; p += 4) {
    data[p] = 12;
    data[p + 1] = 10;
    data[p + 2] = 9;
    data[p + 3] = 255;
  }

  const r = Math.max(1, Math.round(ballR));
  const r2 = r * r;
  for (let i = 0; i < count; i++) {
    const cx = (x[i] + 0.5) | 0;
    const cy = (y[i] + 0.5) | 0;
    const c = colors[i];
    const cr = c & 255;
    const cg = (c >> 8) & 255;
    const cb = (c >> 16) & 255;
    const x0 = Math.max(0, cx - r);
    const x1 = Math.min(w - 1, cx + r);
    const y0 = Math.max(0, cy - r);
    const y1 = Math.min(h - 1, cy + r);
    for (let py = y0; py <= y1; py++) {
      const dy = py - cy;
      const dy2 = dy * dy;
      const row = py * w;
      for (let px = x0; px <= x1; px++) {
        const dx = px - cx;
        if (dx * dx + dy2 > r2) continue;
        const idx = (row + px) << 2;
        data[idx] = cr;
        data[idx + 1] = cg;
        data[idx + 2] = cb;
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

/**
 * Long-exposure renderer: instead of clearing, fade the previous frame toward
 * the background and stamp the current balls on top. Persistent streaks expose
 * the billiard caustics — the "ghost highways" where trajectories bunch up —
 * that any single random-looking frame hides. While paused the buffer holds so
 * you can study a pattern; the velocity slider then scrubs how fast it evolves.
 */
function drawTrails() {
  const { w, h, count, ballR, colors, x, y } = state;
  if (!imageData || imageData.width !== w || imageData.height !== h) {
    imageData = ctx.createImageData(w, h);
    const d = imageData.data;
    for (let p = 0; p < d.length; p += 4) {
      d[p] = 12;
      d[p + 1] = 10;
      d[p + 2] = 9;
      d[p + 3] = 255;
    }
  }
  const data = imageData.data;

  // Fade toward the background only while advancing, so a paused frame freezes.
  if (state.running) {
    const bgR = 12;
    const bgG = 10;
    const bgB = 9;
    const decay = state.trailDecay;
    for (let p = 0; p < data.length; p += 4) {
      // `| 0` truncates toward the background so faint pixels reach it exactly.
      data[p] = bgR + (((data[p] - bgR) * decay) | 0);
      data[p + 1] = bgG + (((data[p + 1] - bgG) * decay) | 0);
      data[p + 2] = bgB + (((data[p + 2] - bgB) * decay) | 0);
    }
  }

  const r = Math.max(1, Math.round(ballR));
  const r2 = r * r;
  for (let i = 0; i < count; i++) {
    const cx = (x[i] + 0.5) | 0;
    const cy = (y[i] + 0.5) | 0;
    const c = colors[i];
    const cr = c & 255;
    const cg = (c >> 8) & 255;
    const cb = (c >> 16) & 255;
    const x0 = Math.max(0, cx - r);
    const x1 = Math.min(w - 1, cx + r);
    const y0 = Math.max(0, cy - r);
    const y1 = Math.min(h - 1, cy + r);
    for (let py = y0; py <= y1; py++) {
      const dy = py - cy;
      const dy2 = dy * dy;
      const row = py * w;
      for (let px = x0; px <= x1; px++) {
        const dx = px - cx;
        if (dx * dx + dy2 > r2) continue;
        const idx = (row + px) << 2;
        data[idx] = cr;
        data[idx + 1] = cg;
        data[idx + 2] = cb;
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

function strokeVesselPath(v) {
  const kind = v.kind;
  ctx.beginPath();

  if (kind === "circle") {
    ctx.arc(v.cx, v.cy, v.r, 0, Math.PI * 2);
    return;
  }

  if (kind === "ellipse") {
    ctx.ellipse(v.cx, v.cy, v.a, v.b, 0, 0, Math.PI * 2);
    return;
  }

  if (kind === "stadium") {
    const { cx, cy, rw, L } = v;
    ctx.moveTo(cx - L, cy - rw);
    ctx.lineTo(cx + L, cy - rw);
    ctx.arc(cx + L, cy, rw, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(cx - L, cy + rw);
    ctx.arc(cx - L, cy, rw, Math.PI / 2, -Math.PI / 2);
    ctx.closePath();
    return;
  }

  if (kind === "annulus") {
    ctx.arc(v.cx, v.cy, v.outer, 0, Math.PI * 2);
    return;
  }

  // twin / triad: draw each chamber arc, skipping the open coupling windows
  const chambers = v.chambers;
  for (let i = 0; i < chambers.length; i++) {
    const c = chambers[i];
    const windowAngles = [];
    for (let j = 0; j < chambers.length; j++) {
      if (i === j) continue;
      const o = chambers[j];
      const d = Math.hypot(o.cx - c.cx, o.cy - c.cy);
      if (d >= c.r + o.r || d <= Math.abs(c.r - o.r)) continue;
      // Angle of chord where the two circles meet (window edge).
      const ang = Math.acos(
        Math.min(1, Math.max(-1, (c.r * c.r + d * d - o.r * o.r) / (2 * c.r * d)))
      );
      const base = Math.atan2(o.cy - c.cy, o.cx - c.cx);
      windowAngles.push([base - ang, base + ang]);
    }

    if (!windowAngles.length) {
      ctx.moveTo(c.cx + c.r, c.cy);
      ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
      continue;
    }

    // Draw the exterior arc(s): full circle minus each window sector.
    // Merge overlapping windows then stroke the complement.
    windowAngles.sort((a, b) => a[0] - b[0]);
    const merged = [windowAngles[0].slice()];
    for (let k = 1; k < windowAngles.length; k++) {
      const last = merged[merged.length - 1];
      if (windowAngles[k][0] <= last[1]) {
        last[1] = Math.max(last[1], windowAngles[k][1]);
      } else {
        merged.push(windowAngles[k].slice());
      }
    }

    // Walk around the circle drawing arcs between windows.
    let cursor = merged[merged.length - 1][1] - Math.PI * 2;
    for (let k = 0; k < merged.length; k++) {
      const [w0, w1] = merged[k];
      if (w0 - cursor > 1e-4) {
        ctx.moveTo(c.cx + Math.cos(cursor) * c.r, c.cy + Math.sin(cursor) * c.r);
        ctx.arc(c.cx, c.cy, c.r, cursor, w0);
      }
      cursor = w1;
    }
  }
}

function drawBowlOverlay() {
  const v = getVessel();
  const dpr = state.dpr;

  // Soft outer halo (slightly expanded)
  ctx.save();
  if (v.kind === "annulus") {
    ctx.beginPath();
    ctx.arc(v.cx, v.cy, v.outer + 2 * dpr, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(243, 235, 224, 0.14)";
    ctx.lineWidth = 3 * dpr;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(v.cx, v.cy, v.inner - 2 * dpr, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(243, 235, 224, 0.1)";
    ctx.lineWidth = 2.5 * dpr;
    ctx.stroke();
  } else {
    strokeVesselPath(v);
    ctx.strokeStyle = "rgba(243, 235, 224, 0.14)";
    ctx.lineWidth = 3 * dpr;
    ctx.stroke();
  }

  // Accent rim
  strokeVesselPath(v);
  ctx.strokeStyle = "rgba(232, 93, 4, 0.4)";
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();

  if (v.kind === "annulus") {
    ctx.beginPath();
    ctx.arc(v.cx, v.cy, v.inner, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(232, 93, 4, 0.4)";
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();
  }

  // Window markers for coupled chambers — faint dashed chords at each aperture
  if (v.chambers) {
    const chambers = v.chambers;
    ctx.setLineDash([4 * dpr, 5 * dpr]);
    ctx.strokeStyle = "rgba(244, 140, 6, 0.35)";
    ctx.lineWidth = 1.25 * dpr;
    for (let i = 0; i < chambers.length; i++) {
      for (let j = i + 1; j < chambers.length; j++) {
        const a = chambers[i];
        const b = chambers[j];
        const d = Math.hypot(b.cx - a.cx, b.cy - a.cy);
        if (d >= a.r + b.r || d <= Math.abs(a.r - b.r)) continue;
        const ang = Math.acos(
          Math.min(1, Math.max(-1, (a.r * a.r + d * d - b.r * b.r) / (2 * a.r * d)))
        );
        const base = Math.atan2(b.cy - a.cy, b.cx - a.cx);
        const p0x = a.cx + Math.cos(base - ang) * a.r;
        const p0y = a.cy + Math.sin(base - ang) * a.r;
        const p1x = a.cx + Math.cos(base + ang) * a.r;
        const p1y = a.cy + Math.sin(base + ang) * a.r;
        ctx.beginPath();
        ctx.moveTo(p0x, p0y);
        ctx.lineTo(p1x, p1y);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function fillVesselInterior() {
  const v = getVessel();
  ctx.fillStyle = "rgba(255, 244, 230, 0.02)";

  if (v.kind === "annulus") {
    ctx.beginPath();
    ctx.arc(v.cx, v.cy, v.outer, 0, Math.PI * 2);
    ctx.arc(v.cx, v.cy, v.inner, 0, Math.PI * 2, true);
    ctx.fill("evenodd");
    return;
  }

  if (v.chambers) {
    ctx.beginPath();
    for (const c of v.chambers) {
      ctx.moveTo(c.cx + c.r, c.cy);
      ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
    }
    ctx.fill();
    return;
  }

  strokeVesselPath(v);
  ctx.fill();
}

/** Trace the vessel interior as a closed path and set it as the clip region. */
function clipToVessel() {
  const v = getVessel();
  if (v.kind === "annulus") {
    ctx.beginPath();
    ctx.arc(v.cx, v.cy, v.outer, 0, Math.PI * 2);
    ctx.arc(v.cx, v.cy, v.inner, 0, Math.PI * 2, true);
    ctx.clip("evenodd");
    return;
  }
  if (v.chambers) {
    ctx.beginPath();
    for (const c of v.chambers) {
      ctx.moveTo(c.cx + c.r, c.cy);
      ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
    }
    ctx.clip();
    return;
  }
  strokeVesselPath(v); // circle / ellipse / stadium produce a closed fillable path
  ctx.clip();
}

/**
 * Sheet renderer: draw the lattice as a continuous deforming surface. Each cell
 * is the quad of its four corner nodes, flat-filled with the cell's birth color.
 * Clipping to the vessel keeps folds and window-spanning cells from painting the
 * empty regions, and cells stretched far past their birth size are dropped so a
 * genuine tear reads as a gap rather than a giant smeared triangle.
 */
function drawSheet(now) {
  const { w, h, cx, cy, radius, x, y, colors } = state;
  const cols = state.sheetCols;
  const rows = state.sheetRows;

  const bg = ctx.createRadialGradient(cx, cy * 0.85, radius * 0.1, cx, cy, radius * 1.35);
  bg.addColorStop(0, "#1c1612");
  bg.addColorStop(0.55, "#100d0b");
  bg.addColorStop(1, "#080706");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  clipToVessel();

  // Drop a cell if any edge stretched beyond this — marks a fold-over tear.
  const maxEdge = Math.max(state.sheetSpacing * 28, state.radius * 0.35);
  const maxEdge2 = maxEdge * maxEdge;

  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = a + cols;

      const ax = x[a];
      const ay = y[a];
      const bx = x[b];
      const by = y[b];
      const dx2 = bx - ax;
      const dy2 = by - ay;
      if (dx2 * dx2 + dy2 * dy2 > maxEdge2) continue;
      const ex = x[d] - ax;
      const ey = y[d] - ay;
      if (ex * ex + ey * ey > maxEdge2) continue;

      const col = colors[a];
      ctx.fillStyle = `rgb(${col & 255},${(col >> 8) & 255},${(col >> 16) & 255})`;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineTo(x[c], y[c]);
      ctx.lineTo(x[d], y[d]);
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.restore();
  drawBowlOverlay();
  drawSpawnMarker(now);
}

let markerPulseUntil = 0;

function drawSpawnMarker(now) {
  const { cx, cy, radius, dpr } = state;
  const x = cx + state.spawnNX * radius;
  const y = cy + state.spawnNY * radius;

  const pulse = Math.max(0, (markerPulseUntil - now) / 700);
  const base = 9 * dpr;
  const ring = base + pulse * 22 * dpr;
  const alpha = 0.5 + pulse * 0.5;

  ctx.save();
  ctx.lineWidth = 1.5 * dpr;
  ctx.strokeStyle = `rgba(255, 244, 230, ${0.35 + pulse * 0.4})`;
  ctx.beginPath();
  ctx.arc(x, y, ring, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = `rgba(232, 93, 4, ${alpha})`;
  ctx.lineWidth = 2 * dpr;
  const cross = base * 0.7;
  ctx.beginPath();
  ctx.moveTo(x - cross, y);
  ctx.lineTo(x + cross, y);
  ctx.moveTo(x, y - cross);
  ctx.lineTo(x, y + cross);
  ctx.stroke();
  ctx.restore();
}

function draw(now) {
  const { w, h, cx, cy, radius, ballR, count } = state;

  if (state.sheet) {
    drawSheet(now);
    return;
  }

  if (state.trails) {
    drawTrails();
    drawBowlOverlay();
    drawSpawnMarker(now);
    return;
  }

  if (count > 5000) {
    drawBallsImageData();
    drawBowlOverlay();
    drawSpawnMarker(now);
    return;
  }

  const bg = ctx.createRadialGradient(
    cx,
    cy * 0.85,
    radius * 0.1,
    cx,
    cy,
    radius * 1.35
  );
  bg.addColorStop(0, "#1c1612");
  bg.addColorStop(0.55, "#100d0b");
  bg.addColorStop(1, "#080706");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  drawBowlOverlay();

  fillVesselInterior();

  const r = ballR;
  for (let i = 0; i < count; i++) {
    const c = state.colors[i];
    const rr = c & 255;
    const gg = (c >> 8) & 255;
    const bb = (c >> 16) & 255;
    ctx.beginPath();
    ctx.arc(state.x[i], state.y[i], r, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
    ctx.fill();
    if (count <= 2500) {
      ctx.beginPath();
      ctx.arc(
        state.x[i] - r * 0.28,
        state.y[i] - r * 0.28,
        r * 0.35,
        0,
        Math.PI * 2
      );
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fill();
    }
  }

  drawSpawnMarker(now);
}

// ---------------------------------------------------------------------------
// 3D mode — a separate world where particles/sheets fly and fold inside a
// closed 3D chamber (sphere / cube / cylinder), projected back to the 2D canvas.
// Kept independent from the 2D pipeline so nothing above changes.
// ---------------------------------------------------------------------------

const state3d = {
  enabled: false,
  chamber: "sphere",
  isSheet: true,
  n: 0,
  cols: 0,
  rows: 0,
  spacing: 0,
  speed: 0,
  x: null,
  y: null,
  z: null,
  vx: null,
  vy: null,
  vz: null,
  colors: null,
  yaw: 0.7,
  pitch: -0.35,
  autoRotate: true,
  scale: 0,
};

// Projection scratch (camera-space + screen), sized to particle count.
let s3sx = null;
let s3sy = null;
let s3zc = null; // distance from camera (>0 in front)
let s3quadOrder = null;

function alloc3d(n) {
  state3d.x = new Float32Array(n);
  state3d.y = new Float32Array(n);
  state3d.z = new Float32Array(n);
  state3d.vx = new Float32Array(n);
  state3d.vy = new Float32Array(n);
  state3d.vz = new Float32Array(n);
  state3d.colors = new Uint32Array(n);
  s3sx = new Float32Array(n);
  s3sy = new Float32Array(n);
  s3zc = new Float32Array(n);
}

function rebuild3d() {
  resize();
  state.stepCount = 0;
  state3d.enabled = true;
  state3d.chamber = ui.chamber3d.value;
  state3d.isSheet = ui.sheet.checked;
  state3d.autoRotate = ui.autorotate3d.checked;
  state3d.speed = velocityMultiplierFromSlider() * 1.1;
  state3d.scale = Math.min(state.w, state.h) * 0.34;
  state.sheetColor = ui.sheetColor.value;

  const az = headingRadians();
  const el = 0.62; // launch elevation so a flat sheet moves out of its own plane
  const sp = state3d.speed;
  const dvx = Math.cos(el) * Math.cos(az) * sp;
  const dvy = Math.sin(el) * sp;
  const dvz = Math.cos(el) * Math.sin(az) * sp;

  const req = ballCountFromSlider();

  if (state3d.isSheet) {
    const side = Math.max(12, Math.min(70, Math.round(Math.sqrt(req))));
    state3d.cols = side;
    state3d.rows = side;
    const n = side * side;
    state3d.n = n;
    state.count = n;
    alloc3d(n);

    const s = 0.72 * Math.min(1.3, Math.max(0.3, Number(ui.pack.value)));
    const ds = (2 * s) / (side - 1);
    state3d.spacing = ds;
    const denom = side - 1;
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        const idx = j * side + i;
        const u = i / denom;
        const v = j / denom;
        const px = -s + i * ds;
        const py = -s + j * ds;
        state3d.x[idx] = px;
        state3d.y[idx] = py;
        state3d.z[idx] = 0;
        state3d.vx[idx] = dvx;
        state3d.vy[idx] = dvy;
        state3d.vz[idx] = dvz;
        state3d.colors[idx] = colorFromSheet(u, v, px, py, idx, n);
      }
    }
    const q = (side - 1) * (side - 1);
    s3quadOrder = new Int32Array(q);
    for (let k = 0; k < q; k++) s3quadOrder[k] = k;
  } else {
    const n = Math.min(40000, req);
    state3d.n = n;
    state.count = n;
    alloc3d(n);
    const spread = 0.16;
    for (let i = 0; i < n; i++) {
      // Gaussian-ish tight cluster near center (rejection inside a small ball).
      let gx;
      let gy;
      let gz;
      do {
        gx = (Math.random() * 2 - 1) * spread;
        gy = (Math.random() * 2 - 1) * spread;
        gz = (Math.random() * 2 - 1) * spread;
      } while (gx * gx + gy * gy + gz * gz > spread * spread);
      state3d.x[i] = gx;
      state3d.y[i] = gy;
      state3d.z[i] = gz;
      state3d.vx[i] = dvx;
      state3d.vy[i] = dvy;
      state3d.vz[i] = dvz;
      const [r, g, b] = hslToRgb((i / n) * 300, 0.8, 0.55);
      state3d.colors[i] = (255 << 24) | (b << 16) | (g << 8) | r;
    }
    s3quadOrder = null;
  }

  updateOutputs();
}

/** Earliest exit fraction t∈(0,1] of ray p+t·d from a sphere of radius R (from inside). */
function sphereExitT(px, py, pz, dx, dy, dz, R) {
  const A = dx * dx + dy * dy + dz * dz;
  const B = 2 * (px * dx + py * dy + pz * dz);
  const C = px * px + py * py + pz * pz - R * R;
  if (A === 0) return Infinity;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / (2 * A);
  const t2 = (-B + sq) / (2 * A);
  let t = Infinity;
  if (t1 > 1e-9 && t1 <= 1) t = t1;
  if (t2 > 1e-9 && t2 <= 1 && t2 < t) t = t2;
  return t;
}

/** Earliest exit of ray from a disk of radius R in the xy-plane (cylinder wall). */
function radialExitT(px, py, dx, dy, R) {
  const A = dx * dx + dy * dy;
  const B = 2 * (px * dx + py * dy);
  const C = px * px + py * py - R * R;
  if (A === 0) return Infinity;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / (2 * A);
  const t2 = (-B + sq) / (2 * A);
  let t = Infinity;
  if (t1 > 1e-9 && t1 <= 1) t = t1;
  if (t2 > 1e-9 && t2 <= 1 && t2 < t) t = t2;
  return t;
}

function advance3d(i, dt) {
  const inset = 0.006;
  let px = state3d.x[i];
  let py = state3d.y[i];
  let pz = state3d.z[i];
  let vx = state3d.vx[i];
  let vy = state3d.vy[i];
  let vz = state3d.vz[i];
  let rem = dt;
  const chamber = state3d.chamber;
  const W = 1 - inset;

  for (let guard = 0; guard < 16; guard++) {
    const dx = vx * rem;
    const dy = vy * rem;
    const dz = vz * rem;
    let t = Infinity;
    let nx = 0;
    let ny = 0;
    let nz = 0;

    if (chamber === "cube") {
      let axis = -1;
      if (dx > 0) { const tt = (W - px) / dx; if (tt > 1e-9 && tt <= 1 && tt < t) { t = tt; axis = 0; nx = 1; ny = 0; nz = 0; } }
      else if (dx < 0) { const tt = (-W - px) / dx; if (tt > 1e-9 && tt <= 1 && tt < t) { t = tt; axis = 0; nx = -1; ny = 0; nz = 0; } }
      if (dy > 0) { const tt = (W - py) / dy; if (tt > 1e-9 && tt <= 1 && tt < t) { t = tt; axis = 1; nx = 0; ny = 1; nz = 0; } }
      else if (dy < 0) { const tt = (-W - py) / dy; if (tt > 1e-9 && tt <= 1 && tt < t) { t = tt; axis = 1; nx = 0; ny = -1; nz = 0; } }
      if (dz > 0) { const tt = (W - pz) / dz; if (tt > 1e-9 && tt <= 1 && tt < t) { t = tt; axis = 2; nx = 0; ny = 0; nz = 1; } }
      else if (dz < 0) { const tt = (-W - pz) / dz; if (tt > 1e-9 && tt <= 1 && tt < t) { t = tt; axis = 2; nx = 0; ny = 0; nz = -1; } }
      if (axis === -1) t = Infinity;
    } else if (chamber === "cylinder") {
      const tr = radialExitT(px, py, dx, dy, W);
      if (isFinite(tr)) {
        const hx = px + dx * tr;
        const hy = py + dy * tr;
        const inv = 1 / (Math.hypot(hx, hy) || 1);
        t = tr; nx = hx * inv; ny = hy * inv; nz = 0;
      }
      let tz = Infinity;
      let zs = 0;
      if (dz > 0) { tz = (W - pz) / dz; zs = 1; }
      else if (dz < 0) { tz = (-W - pz) / dz; zs = -1; }
      if (tz > 1e-9 && tz <= 1 && tz < t) { t = tz; nx = 0; ny = 0; nz = zs; }
    } else {
      // sphere
      const ts = sphereExitT(px, py, pz, dx, dy, dz, W);
      if (isFinite(ts)) {
        const hx = px + dx * ts;
        const hy = py + dy * ts;
        const hz = pz + dz * ts;
        const inv = 1 / W;
        t = ts; nx = hx * inv; ny = hy * inv; nz = hz * inv;
      }
    }

    if (!isFinite(t)) {
      px += dx; py += dy; pz += dz;
      break;
    }

    px += dx * t;
    py += dy * t;
    pz += dz * t;
    const vn = vx * nx + vy * ny + vz * nz;
    vx -= 2 * vn * nx;
    vy -= 2 * vn * ny;
    vz -= 2 * vn * nz;
    px -= nx * 1e-4;
    py -= ny * 1e-4;
    pz -= nz * 1e-4;
    rem *= 1 - t;
    if (rem <= 1e-9) break;
  }

  // Safety clamp so numerical drift can't leak a particle outside the chamber.
  if (chamber === "cube") {
    if (px > W) px = W; else if (px < -W) px = -W;
    if (py > W) py = W; else if (py < -W) py = -W;
    if (pz > W) pz = W; else if (pz < -W) pz = -W;
  } else if (chamber === "cylinder") {
    const rr = Math.hypot(px, py);
    if (rr > W) { const k = W / rr; px *= k; py *= k; }
    if (pz > W) pz = W; else if (pz < -W) pz = -W;
  } else {
    const rr = Math.hypot(px, py, pz);
    if (rr > W) { const k = W / rr; px *= k; py *= k; pz *= k; }
  }

  state3d.x[i] = px;
  state3d.y[i] = py;
  state3d.z[i] = pz;
  state3d.vx[i] = vx;
  state3d.vy[i] = vy;
  state3d.vz[i] = vz;
}

function step3d(dt) {
  const n = state3d.n;
  for (let i = 0; i < n; i++) advance3d(i, dt);
}

function updateCamera3d(dt) {
  if (state3d.autoRotate) state3d.yaw += 0.25 * dt;
}

function drawChamberWire(camParams) {
  const { project } = camParams;
  ctx.strokeStyle = "rgba(232, 93, 4, 0.28)";
  ctx.lineWidth = 1.1 * state.dpr;
  const chamber = state3d.chamber;

  const strokeLoop = (pts) => {
    ctx.beginPath();
    for (let k = 0; k < pts.length; k++) {
      const p = project(pts[k][0], pts[k][1], pts[k][2]);
      if (k === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
  };

  if (chamber === "cube") {
    const c = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) c.push([sx, sy, sz]);
    const edges = [
      [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
      [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
    ];
    ctx.beginPath();
    for (const [a, b] of edges) {
      const pa = project(c[a][0], c[a][1], c[a][2]);
      const pb = project(c[b][0], c[b][1], c[b][2]);
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]);
    }
    ctx.stroke();
    return;
  }

  const ring = (axis) => {
    const pts = [];
    for (let a = 0; a <= 48; a++) {
      const th = (a / 48) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      if (axis === 0) pts.push([0, c, s]);
      else if (axis === 1) pts.push([c, 0, s]);
      else pts.push([c, s, 0]);
    }
    return pts;
  };

  if (chamber === "cylinder") {
    const top = [];
    const bot = [];
    for (let a = 0; a <= 48; a++) {
      const th = (a / 48) * Math.PI * 2;
      top.push([Math.cos(th), Math.sin(th), 1]);
      bot.push([Math.cos(th), Math.sin(th), -1]);
    }
    strokeLoop(top);
    strokeLoop(bot);
    ctx.beginPath();
    for (let a = 0; a < 4; a++) {
      const th = (a / 4) * Math.PI * 2;
      const pa = project(Math.cos(th), Math.sin(th), 1);
      const pb = project(Math.cos(th), Math.sin(th), -1);
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]);
    }
    ctx.stroke();
    return;
  }

  strokeLoop(ring(0));
  strokeLoop(ring(1));
  strokeLoop(ring(2));
}

function draw3d(now) {
  const { w, h } = state;
  const scx = state.cx;
  const scy = state.cy;
  const scale = state3d.scale;

  const bg = ctx.createRadialGradient(scx, scy * 0.85, scale * 0.1, scx, scy, scale * 2.2);
  bg.addColorStop(0, "#161210");
  bg.addColorStop(0.6, "#0e0b0a");
  bg.addColorStop(1, "#070606");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const yaw = state3d.yaw;
  const pitch = state3d.pitch;
  const cyaw = Math.cos(yaw);
  const syaw = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const spp = Math.sin(pitch);
  const camDist = 3.3;
  const focal = 2.6;

  const project = (px, py, pz) => {
    const X = px * cyaw + pz * syaw;
    const Zt = -px * syaw + pz * cyaw;
    const Yc = py * cp - Zt * spp;
    const Zc = py * spp + Zt * cp;
    const zc = Math.max(0.05, camDist - Zc);
    const f = (scale * focal) / zc;
    return [scx + X * f, scy - Yc * f, zc];
  };

  drawChamberWire({ project });

  const n = state3d.n;
  const x = state3d.x;
  const y = state3d.y;
  const z = state3d.z;
  for (let i = 0; i < n; i++) {
    const p = project(x[i], y[i], z[i]);
    s3sx[i] = p[0];
    s3sy[i] = p[1];
    s3zc[i] = p[2];
  }

  if (state3d.isSheet) {
    drawSheet3d();
  } else {
    // Points: brighten with proximity for depth cue.
    const colors = state3d.colors;
    for (let i = 0; i < n; i++) {
      const zc = s3zc[i];
      const r = Math.max(0.7, Math.min(6, (scale * focal) / zc * 0.01));
      const shade = Math.max(0.35, Math.min(1, 1.5 - zc * 0.28));
      const c = colors[i];
      const cr = (c & 255) * shade;
      const cg = ((c >> 8) & 255) * shade;
      const cb = ((c >> 16) & 255) * shade;
      ctx.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
      ctx.fillRect(s3sx[i] - r, s3sy[i] - r, r * 2, r * 2);
    }
  }
}

function drawSheet3d() {
  const cols = state3d.cols;
  const rows = state3d.rows;
  const x = state3d.x;
  const y = state3d.y;
  const z = state3d.z;
  const colors = state3d.colors;
  const order = s3quadOrder;
  const qcols = cols - 1;

  // Sort quads far→near (painter's) by mean camera distance.
  const meanZc = (k) => {
    const j = (k / qcols) | 0;
    const i = k - j * qcols;
    const a = j * cols + i;
    return s3zc[a] + s3zc[a + 1] + s3zc[a + cols] + s3zc[a + cols + 1];
  };
  Array.prototype.sort.call(order, (p, q) => meanZc(q) - meanZc(p));

  // Directional light in world space for solid shading.
  const lx = 0.35;
  const ly = 0.68;
  const lz = 0.64;
  const maxEdge = Math.max(state3d.spacing * 30, 0.4);
  const maxEdge2 = maxEdge * maxEdge;

  for (let idx = 0; idx < order.length; idx++) {
    const k = order[idx];
    const j = (k / qcols) | 0;
    const i = k - j * qcols;
    const a = j * cols + i;
    const b = a + 1;
    const c = a + cols + 1;
    const d = a + cols;

    // World-space tear cull.
    const e1x = x[b] - x[a];
    const e1y = y[b] - y[a];
    const e1z = z[b] - z[a];
    if (e1x * e1x + e1y * e1y + e1z * e1z > maxEdge2) continue;
    const e2x = x[d] - x[a];
    const e2y = y[d] - y[a];
    const e2z = z[d] - z[a];
    if (e2x * e2x + e2y * e2y + e2z * e2z > maxEdge2) continue;

    // Face normal (double-sided) for lambert shading.
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const shade = 0.32 + 0.68 * Math.abs(nx * lx + ny * ly + nz * lz);

    const col = colors[a];
    const cr = (col & 255) * shade;
    const cg = ((col >> 8) & 255) * shade;
    const cb = ((col >> 16) & 255) * shade;
    ctx.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
    ctx.beginPath();
    ctx.moveTo(s3sx[a], s3sy[a]);
    ctx.lineTo(s3sx[b], s3sy[b]);
    ctx.lineTo(s3sx[c], s3sy[c]);
    ctx.lineTo(s3sx[d], s3sy[d]);
    ctx.closePath();
    ctx.fill();
  }
}

function frame(now) {
  const rawDt = Math.min(0.033, (now - lastT) / 1000);
  lastT = now;

  if (state3d.enabled) {
    if (state.running && state3d.n > 0) {
      step3d(rawDt);
      state.stepCount++;
    }
    updateCamera3d(rawDt);
    draw3d(now);
    fpsAccum += rawDt;
    fpsFrames++;
    if (fpsAccum >= 0.5) {
      ui.statFps.textContent = `${Math.round(fpsFrames / fpsAccum)} fps`;
      ui.statSteps.textContent = `${state.stepCount.toLocaleString()} steps`;
      fpsAccum = 0;
      fpsFrames = 0;
    }
    requestAnimationFrame(frame);
    return;
  }

  if (state.running && state.count > 0) {
    step(rawDt);
    state.stepCount++;
  }

  draw(now);

  fpsAccum += rawDt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    ui.statFps.textContent = `${Math.round(fpsFrames / fpsAccum)} fps`;
    ui.statSteps.textContent = `${state.stepCount.toLocaleString()} steps`;
    fpsAccum = 0;
    fpsFrames = 0;
  }

  requestAnimationFrame(frame);
}

function bindUI() {
  const refreshLabels = () => updateOutputs();

  ui.balls.addEventListener("input", () => {
    refreshLabels();
  });
  ui.balls.addEventListener("change", () => {
    rebuild(ballCountFromSlider());
  });

  ui.size.addEventListener("input", () => {
    refreshLabels();
    applyRadii();
  });

  ui.pack.addEventListener("input", () => {
    refreshLabels();
    rebuild(state.count || ballCountFromSlider());
  });

  // Heading only affects the next Restart / spawn — live runs keep bounced paths.
  ui.heading.addEventListener("input", () => {
    refreshLabels();
    state.heading = headingRadians();
  });

  // Velocity scales each ball's current speed in place; directions and positions stay.
  ui.velocity.addEventListener("input", () => {
    refreshLabels();
    if (state3d.enabled) {
      const next = velocityMultiplierFromSlider() * 1.1;
      const prev = state3d.speed || next;
      state3d.speed = next;
      if (prev <= 0 || state3d.n === 0) return;
      const scale = next / prev;
      for (let i = 0; i < state3d.n; i++) {
        state3d.vx[i] *= scale;
        state3d.vy[i] *= scale;
        state3d.vz[i] *= scale;
      }
      return;
    }
    const next = launchSpeed();
    const prev = state.speed || next;
    state.speed = next;
    if (prev <= 0 || state.count === 0) return;
    const scale = next / prev;
    for (let i = 0; i < state.count; i++) {
      state.vx[i] *= scale;
      state.vy[i] *= scale;
    }
  });

  ui.collide.addEventListener("change", () => {
    state.collideBalls = ui.collide.checked;
    updateCollideHint(state.count || ballCountFromSlider());
  });

  ui.colorMode.addEventListener("change", () => {
    state.colorMode = ui.colorMode.value;
    recolorParticles();
  });

  ui.sheetColor.addEventListener("change", () => {
    state.sheetColor = ui.sheetColor.value;
    if (state3d.enabled) rebuild3d();
    else recolorParticles();
  });

  ui.trails.addEventListener("change", () => {
    state.trails = ui.trails.checked;
    imageData = null; // clear any leftover buffer when toggling modes
  });

  ui.sheet.addEventListener("change", () => {
    rebuild(ballCountFromSlider());
  });

  ui.mode3d.addEventListener("change", () => {
    rebuild(ballCountFromSlider());
  });

  ui.chamber3d.addEventListener("change", () => {
    if (state3d.enabled) rebuild3d();
  });

  ui.autorotate3d.addEventListener("change", () => {
    state3d.autoRotate = ui.autorotate3d.checked;
  });

  ui.spawn.addEventListener("change", () => {
    rebuild(ballCountFromSlider());
  });

  ui.vessel.addEventListener("change", () => {
    state.vessel = ui.vessel.value;
    vesselCache = null;
    updateVesselHint();
    updateOrbitReadout();
    rebuild(ballCountFromSlider());
  });

  ui.orbit.addEventListener("change", () => {
    updateOrbitReadout();
    rebuild(ballCountFromSlider());
  });

  const onOrbitParam = () => {
    // Keep p strictly below q so the rotation number stays valid.
    if (Number(ui.orbitP.value) >= Number(ui.orbitQ.value)) {
      ui.orbitP.value = String(Number(ui.orbitQ.value) - 1);
    }
    updateOrbitReadout();
    if (ui.orbit.checked) rebuild(ballCountFromSlider());
  };
  ui.orbitP.addEventListener("input", onOrbitParam);
  ui.orbitQ.addEventListener("input", onOrbitParam);

  ui.restart.addEventListener("click", () => {
    rebuild(ballCountFromSlider());
  });

  ui.pause.addEventListener("click", () => {
    state.running = !state.running;
    ui.pause.textContent = state.running ? "Pause" : "Resume";
  });

  // Click (or drag) inside the vessel to relaunch the cluster from that point.
  const placeFromEvent = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (state.w / rect.width);
    const py = (ev.clientY - rect.top) * (state.h / rect.height);
    let nx = (px - state.cx) / state.radius;
    let ny = (py - state.cy) / state.radius;
    const clamped = clampSpawnOffset(nx, ny);
    state.spawnNX = clamped[0];
    state.spawnNY = clamped[1];
    markerPulseUntil = performance.now() + 700;
    rebuild(ballCountFromSlider());
  };

  let dragging = false;
  let orbitLastX = 0;
  let orbitLastY = 0;
  canvas.addEventListener("pointerdown", (ev) => {
    dragging = true;
    canvas.setPointerCapture(ev.pointerId);
    if (state3d.enabled) {
      orbitLastX = ev.clientX;
      orbitLastY = ev.clientY;
      state3d.autoRotate = false;
      if (ui.autorotate3d) ui.autorotate3d.checked = false;
      return;
    }
    placeFromEvent(ev);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    if (state3d.enabled) {
      state3d.yaw += (ev.clientX - orbitLastX) * 0.01;
      state3d.pitch += (ev.clientY - orbitLastY) * 0.01;
      const lim = Math.PI / 2 - 0.05;
      state3d.pitch = Math.max(-lim, Math.min(lim, state3d.pitch));
      orbitLastX = ev.clientX;
      orbitLastY = ev.clientY;
      return;
    }
    placeFromEvent(ev);
  });
  const endDrag = () => {
    dragging = false;
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  window.addEventListener("resize", () => {
    const n = state.count || ballCountFromSlider();
    rebuild(n);
  });

  ui.presetSelect.addEventListener("change", () => {
    const preset = findPreset(ui.presetSelect.value);
    if (preset) applyPresetValues(preset.values);
  });

  ui.savePreset.addEventListener("click", () => {
    const name = window.prompt("Name this preset:", "My preset");
    if (!name || !name.trim()) return;
    const id = `custom:${Date.now()}`;
    customPresets.push({ id, name: name.trim(), values: currentSettingsSnapshot() });
    saveCustomPresets(customPresets);
    renderPresetOptions(id);
  });

  ui.deletePreset.addEventListener("click", () => {
    const id = ui.presetSelect.value;
    const idx = customPresets.findIndex((p) => p.id === id);
    if (idx === -1) return; // built-ins can't be deleted
    customPresets.splice(idx, 1);
    saveCustomPresets(customPresets);
    renderPresetOptions();
  });
}

bindUI();
renderPresetOptions("builtin:twin");
applyPresetValues(findPreset("builtin:twin").values);
requestAnimationFrame((t) => {
  lastT = t;
  requestAnimationFrame(frame);
});
