import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* =====================================================================
   CONFIG — tweak gameplay and model orientation here
   ===================================================================== */
const CFG = {
  assets: {
    player: './assets/pesawat_player.glb',
    enemy: './assets/drone_musuh.glb',
    coin: './assets/coin.glb',
  },
  // Rotation (radians) applied to each model right after loading so its nose points toward -Z (the flight direction).
  // If a model still faces backwards, toggle that entry between 0 and Math.PI.
  // player.glb: nose points +Z and the tail fins point +Y (upright). The game flies toward -Z, so turn it 180° about Y.
  modelYaw: { player: Math.PI, enemy: 0, coin: 0 },
  // Extra per-model offsets in radians (applied before the yaw): x = pitch (nose up/down), z = roll (set Math.PI if a model is upside down)
  modelTilt: { player: { x: 0, z: 0 }, enemy: { x: 0, z: 0 }, coin: { x: 0, z: 0 } },
  maxBank: 0.7,         // max roll angle in radians (~40°) at full left/right steering
  // Longest dimension of each model in world units (GLBs are auto-normalized).
  modelSize: { player: 7, enemy: 8, coin: 5 },

  speed: 70,            // player forward speed (units/s)
  maxHP: 100,
  // Wave progression: each wave is bigger, faster and fires more often
  waves: [
    { count: 4,  max: 4, speed: 1.0,  fire: 1.0, hp: 2 },
    { count: 6,  max: 5, speed: 1.12, fire: 0.9, hp: 2 },
    { count: 8,  max: 6, speed: 1.25, fire: 0.8, hp: 3 },
    { count: 10, max: 7, speed: 1.4,  fire: 0.7, hp: 3 },
  ],
  maxRockets: 10, rocketSpeed: 210, rocketRadius: 24,
  rocketReload: 1.0,    // seconds for the manual quick-reload (press R) — refills every slot
  rocketRegen: 3.5,     // seconds for passive auto-regeneration of ONE rocket
  rocketTurn: 3.6,      // max homing turn rate (rad/s) — lower = wider, lazier curves
  bossHP: 60,
  coinCount: 10,
  crystalPickup: [3, 4],   // crystals gained per crystal pickup (random 3 or 4)
  crystalKill: 3,          // crystals gained per drone destroyed by the player
  crystalBoss: 40,         // crystals for destroying the Overlord
  laserSpeed: 320,
  fireInterval: 0.12,

  cell: 44,             // city grid cell size
  buildingWidth: 24,
  gridN: 15,            // visible grid (cells per side)
};

// Quick orientation testing without editing code, e.g.  index.html?yaw=0  ?yaw=180  ?roll=180  ?pitch=90  (degrees, player model only)
{
  const q = new URLSearchParams(location.search);
  const rd = (k) => (q.has(k) && Number.isFinite(parseFloat(q.get(k))) ? (parseFloat(q.get(k)) * Math.PI) / 180 : null);
  const y = rd('yaw'), px = rd('pitch'), rz = rd('roll');
  if (y !== null) CFG.modelYaw.player = y;
  if (px !== null) CFG.modelTilt.player.x = px;
  if (rz !== null) CFG.modelTilt.player.z = rz;
}

/* =====================================================================
   HELPERS
   ===================================================================== */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rand = (a, b) => a + Math.random() * (b - a);
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
const TAU = Math.PI * 2;
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');
document.body.classList.add('menu-open');
document.addEventListener('contextmenu', (e) => e.preventDefault());

const V3 = THREE.Vector3;
const UP = new V3(0, 1, 0);

/* =====================================================================
   SAVE DATA · PAINTS · UPGRADES · LANGUAGES  (persisted in localStorage)
   ===================================================================== */
const SAVE_KEY = 'mechflight.save.v1';
const MAX_LV = 5;
const PAINTS = [   // color = hex applied to the airframe (null keeps the model's own colors)
  { id: 'stock',  color: null,     css: '#9aa4b8', cost: 0 },
  { id: 'red',    color: 0xe02033, css: '#e02033', cost: 15 },
  { id: 'blue',   color: 0x2a6bff, css: '#2a6bff', cost: 15 },
  { id: 'green',  color: 0x22d96a, css: '#22d96a', cost: 15 },
  { id: 'purple', color: 0x9b4dff, css: '#9b4dff', cost: 30 },
  { id: 'pink',   color: 0xff2e88, css: '#ff2e88', cost: 30 },
];
const UPGRADES = [  // crystal cost to go from level N to N+1
  { id: 'speed',    cost: [10, 20, 35, 55, 80] },
  { id: 'nitro',    cost: [10, 20, 35, 55, 80] },
  { id: 'handling', cost: [10, 20, 35, 55, 80] },
];
const LANGS = [{ id: 'en', label: 'English' }];   // single-language UI; add entries here (plus an I18N block) to offer more

function defaultSave() {
  return {
    v: 1, bank: 0, paint: 'stock', owned: ['stock'], lv: { speed: 0, nitro: 0, handling: 0 }, bestWave: 0,
    lang: 'en', langChosen: false, muted: false, vibrate: true,      // English unless the player picks another language
  };
}
function loadSave() {
  const d = defaultSave();
  try {
    const o = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
    if (!o || typeof o !== 'object') return d;
    d.bank = Math.max(0, Math.floor(Number(o.bank) || 0));
    d.owned = ['stock', ...(Array.isArray(o.owned) ? o.owned : []).filter((id) => PAINTS.some((p) => p.id === id) && id !== 'stock')];
    d.paint = d.owned.includes(o.paint) ? o.paint : 'stock';
    for (const k of Object.keys(d.lv)) d.lv[k] = clamp(Math.floor(Number(o.lv && o.lv[k]) || 0), 0, MAX_LV);
    d.bestWave = clamp(Math.floor(Number(o.bestWave) || 0), 0, 4);
    if (o.langChosen === true && LANGS.some((l) => l.id === o.lang)) { d.lang = o.lang; d.langChosen = true; }   // only an explicit choice overrides English
    d.muted = !!o.muted; d.vibrate = o.vibrate !== false;
  } catch (_) { /* storage blocked or corrupt: start fresh */ }
  return d;
}
let SAVE = loadSave();
function saveNow() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(SAVE)); } catch (_) { /* private mode: progress lasts for this session only */ } }
addEventListener('pagehide', saveNow);
function haptic(ms) { if (!SAVE.vibrate) return; try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {} }

// Upgrade effects (level 0..5)
const lv = (k) => SAVE.lv[k] | 0;
/** Add crystals to the run counter and to the persistent Garage wallet. */
function awardCrystals(n) { S.coins += n; SAVE.bank += n; saveNow(); }
const crystalPickup = () => CFG.crystalPickup[0] + Math.floor(Math.random() * (CFG.crystalPickup[1] - CFG.crystalPickup[0] + 1));
const topSpeed = () => CFG.speed * (1 + 0.06 * lv('speed'));      // +6% forward speed per level
const boostPow = () => 1.1 + 0.08 * lv('nitro');                  // extra speed while nitro is on

const I18N = {
  en: {
    title: 'Cyberpunk Mech-Flight & City Conquest', 'title.main': 'Mech-Flight', 'title.sub': 'City Conquest',
    hull: 'Hull', nitro: 'Nitro', score: 'Score', crystals: 'Crystals', rockets: 'Rockets', reloading: 'Reloading', wave: 'Wave', overlord: 'Overlord drone',
    hint: 'WASD / arrows to fly · Space to fire · Shift boost · F rocket · R reload · C camera · Esc pause',
    lede: 'Neon sprawl, hostile drones, one fighter. Survive four waves of drones, then take down the Overlord. Drones shoot back, so keep moving. Crystals repair your hull, and rockets hit hard.',
    'cl.fly': 'Fly', 'cl.fire': 'Fire', 'cl.boost': 'Boost', 'cl.rocket': 'Rocket', 'cl.cam': 'Camera',
    'cd.fly': 'W A S D or arrow keys', 'cd.fire': 'Space', 'cd.boost': 'Hold Shift', 'cd.rocket': 'F or E (R to reload)', 'cd.cam': 'C (or the camera button)',
    'cm.fly': 'Left stick', 'cm.fire': 'Fire button (hold)', 'cm.boost': 'Boost button (hold)', 'cm.rocket': 'Rocket button (Reload when empty)', 'cm.cam': 'Camera icon, top left',
    launch: 'Launch', garage: 'Garage', settings: 'Settings', back: 'Back',
    paused: 'Paused', resume: 'Resume', restart: 'Restart', levels: 'Level Select', 'pause.hint': 'Esc or P resumes · M toggles sound',
    'end.win': 'City secured', 'end.lose': 'Systems down', 'end.sub.win': 'The Overlord is scrap. The skyline is yours.',
    'end.sub.boss': 'Your fighter went down against the Overlord.', 'end.sub.wave': 'Your fighter went down on wave {n}.',
    'r.drones': 'Drones', again: 'Fly again',
    'g.paint': 'Body paint', 'g.upgrades': 'Upgrades', 'g.equip': 'Equip', 'g.equipped': 'Equipped', 'g.level': 'Lv', 'g.max': 'MAX',
    'g.poor': 'Not enough crystals', 'g.bought': '{n} unlocked', 'g.upgraded': '{n} upgraded to Lv {l}',
    'paint.stock': 'Stock', 'paint.red': 'Red', 'paint.blue': 'Blue', 'paint.green': 'Green', 'paint.purple': 'Neon Purple', 'paint.pink': 'Cyber Pink',
    'u.speed': 'Top Speed', 'u.speed.d': 'Faster cruising speed, +6% per level',
    'u.nitro': 'Nitro Acceleration', 'u.nitro.d': 'Stronger, quicker-charging nitro boost',
    'u.handling': 'Handling', 'u.handling.d': 'Sharper steering and faster response',
    'levels.sub': 'Start a new run from any wave you have reached.', boss: 'Boss: Overlord', 'boss.sub': 'Face the Overlord drone', 'l.drones': '{c} drones', 'l.locked': 'Locked',
    'sound': 'Sound', on: 'on', off: 'off', 's.lang': 'Language', vibration: 'Vibration', progress: 'Progress', 's.reset': 'Reset', 's.confirm': 'Tap again to confirm', 's.done': 'Progress reset',
    cam0: 'Chase Cam', cam1: 'Cockpit', cam2: 'Top-Down', cam3: 'Close Cam',
    'msg.full': 'Rockets full', 'msg.reloading': 'Reloading…', 'msg.empty.t': 'Out of rockets: tap Reload', 'msg.empty.k': 'Out of rockets: press R', 'msg.ready': 'Rockets ready',
    'msg.wave': 'Wave {n}  ·  {c} drones', 'msg.cleared': 'Wave {n} cleared  +{b}', 'msg.bonus': '+{b} wave bonus',
    'msg.boss': 'Warning: Overlord drone inbound', 'msg.minions': 'Overlord launches drones', 'msg.bossdown': '+5000  Overlord down',
    'msg.crystal': '+100  +{n} crystals', 'msg.kill': '+{n} crystals', 'msg.blocked': 'Blocked',
  },
};
function t(key, vars) {
  let str = (I18N[SAVE.lang] && I18N[SAVE.lang][key]);
  if (str === undefined) str = I18N.en[key] !== undefined ? I18N.en[key] : key;
  if (vars) for (const k of Object.keys(vars)) str = str.split(`{${k}}`).join(vars[k]);
  return str;
}

/* =====================================================================
   RENDERER / SCENE / CAMERA
   ===================================================================== */
const renderer = new THREE.WebGLRenderer({
  canvas: $('game'), antialias: !isTouch, powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.5 : 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const FOG_COLOR = 0x140828;
const scene = new THREE.Scene();
scene.background = new THREE.Color(FOG_COLOR);
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0055);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;

const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.5, 1200);

// Post-processing (neon bloom) — skipped on touch devices for performance
const useBloom = !isTouch;
let composer = null;
if (useBloom) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.5, 0.9));
  composer.addPass(new OutputPass());
}

let camBaseFov = 65;
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camBaseFov = w / h < 1 ? 80 : 65;
  camera.fov = camBaseFov;
  camera.updateProjectionMatrix();
  if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); }
}
addEventListener('resize', resize);
addEventListener('orientationchange', () => setTimeout(resize, 200));
resize();

/* =====================================================================
   LIGHTING
   ===================================================================== */
scene.add(new THREE.AmbientLight(0x5a3a9a, 1.4));
const sun = new THREE.DirectionalLight(0x19f3ff, 1.6);
sun.position.set(-60, 120, -40);
scene.add(sun);

const neonLights = [0xff2e88, 0x19f3ff, 0x9b6bff].map((c) => {
  const l = new THREE.PointLight(c, 2500, 260, 2);
  scene.add(l);
  return l;
});

/* =====================================================================
   PROCEDURAL CITY (recycled grid, deterministic per cell)
   ===================================================================== */
const { cell: CELL, buildingWidth: BW, gridN: N } = CFG;
const NEON = [0x19f3ff, 0xff2e88, 0x9b6bff];
const TIERS = [28, 50, 80, 115];

function hash(x, z, s = 0) {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(s + 1, 2147483629)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Building definition for a grid cell, or null for streets/plazas. */
function cityCell(cx, cz) {
  if (Math.abs(cx) <= 1 && Math.abs(cz) <= 1) return null; // base plaza
  if (hash(cx, cz, 1) < 0.12) return null;                  // open lots
  const tier = Math.min(3, Math.floor(hash(cx, cz, 2) * 4));
  return { tier, h: TIERS[tier], col: Math.floor(hash(cx, cz, 3) * 3) };
}

/** Height of the building covering world point (x,z), or 0. */
function heightAt(x, z) {
  const cx = Math.round(x / CELL), cz = Math.round(z / CELL);
  const d = cityCell(cx, cz);
  if (!d) return 0;
  return Math.abs(x - cx * CELL) <= BW / 2 && Math.abs(z - cz * CELL) <= BW / 2 ? d.h : 0;
}

function windowCanvas(hex) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 128, 128);
  const css = '#' + hex.toString(16).padStart(6, '0');
  for (let r = 0; r < 4; r++) for (let q = 0; q < 4; q++) {
    if (Math.random() < 0.5) {
      g.globalAlpha = rand(0.5, 1);
      g.fillStyle = css;
      g.fillRect(q * 32 + 6, r * 32 + 8, 20, 14);
    }
  }
  return c;
}

const buildingMats = NEON.map((hex) => {
  const src = windowCanvas(hex);
  return TIERS.map((h) => {
    const t = new THREE.CanvasTexture(src);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1, h / 32);
    t.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({
      color: 0x1b1433, roughness: 0.6, metalness: 0.4,
      emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.5,
    });
  });
});

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const roofs = new THREE.InstancedMesh(boxGeo, new THREE.MeshBasicMaterial({ toneMapped: false }), N * N);
roofs.frustumCulled = false;
scene.add(roofs);

const buildings = [];
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const m = new THREE.Mesh(boxGeo, buildingMats[0][0]);
  m.userData = { cx: null, cz: null, idx: i * N + j, i, j };
  scene.add(m);
  buildings.push(m);
}

const _mat = new THREE.Matrix4(), _col = new THREE.Color(), _q = new THREE.Quaternion(), _s = new V3(), _p = new V3();

function updateCity(center) {
  const pcx = Math.round(center.x / CELL), pcz = Math.round(center.z / CELL);
  let dirty = false;
  for (const m of buildings) {
    const u = m.userData;
    const cx = u.i + N * Math.round((pcx - u.i) / N);
    const cz = u.j + N * Math.round((pcz - u.j) / N);
    if (cx === u.cx && cz === u.cz) continue;
    u.cx = cx; u.cz = cz; dirty = true;
    const d = cityCell(cx, cz);
    m.visible = !!d;
    if (d) {
      m.material = buildingMats[d.col][d.tier];
      m.scale.set(BW, d.h, BW);
      m.position.set(cx * CELL, d.h / 2, cz * CELL);
      _p.set(cx * CELL, d.h + 0.4, cz * CELL);
      _s.set(BW + 1.5, 0.8, BW + 1.5);
      _col.setHex(NEON[d.col]).multiplyScalar(1.1);
    } else {
      _p.set(0, -50, 0); _s.set(0, 0, 0); _col.setHex(0);
    }
    _mat.compose(_p, _q, _s);
    roofs.setMatrixAt(u.idx, _mat);
    roofs.setColorAt(u.idx, _col);
  }
  if (dirty) {
    roofs.instanceMatrix.needsUpdate = true;
    if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
  }
}

// Ground with neon street grid (snaps to cell so lines stay put)
const GS = CELL * 31;
const groundCanvas = document.createElement('canvas');
groundCanvas.width = groundCanvas.height = 128;
{
  const g = groundCanvas.getContext('2d');
  g.fillStyle = '#0b0618'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#ff2e88'; g.lineWidth = 6; g.strokeRect(0, 0, 128, 128);
}
const groundTex = new THREE.CanvasTexture(groundCanvas);
groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
groundTex.repeat.set(GS / CELL, GS / CELL);
groundTex.colorSpace = THREE.SRGBColorSpace;
groundTex.anisotropy = 8;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(GS, GS), new THREE.MeshBasicMaterial({ map: groundTex }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// Home base: landing ring, tower and beacon beam at the origin
const base = new THREE.Group();
const ring = new THREE.Mesh(new THREE.TorusGeometry(26, 0.7, 8, 64), new THREE.MeshBasicMaterial({ color: 0x19f3ff, toneMapped: false }));
ring.rotation.x = Math.PI / 2; ring.position.y = 0.8;
const tower = new THREE.Mesh(new THREE.CylinderGeometry(3, 5, 34, 8), new THREE.MeshStandardMaterial({ color: 0x1b1433, emissive: 0xff2e88, emissiveIntensity: 0.8 }));
tower.position.y = 17;
const beam = new THREE.Mesh(
  new THREE.CylinderGeometry(0.7, 0.7, 420, 8, 1, true),
  new THREE.MeshBasicMaterial({ color: 0x19f3ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
beam.position.y = 210;
base.add(ring, tower, beam);
scene.add(base);

/* =====================================================================
   WARP DUST (stars wrap around the player inside a shader)
   ===================================================================== */
const STAR_BOX = 520;
const starGeo = new THREE.BufferGeometry();
{
  const n = 1800, pos = new Float32Array(n * 3), size = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos.set([rand(0, STAR_BOX), rand(0, STAR_BOX), rand(0, STAR_BOX)], i * 3);
    size[i] = rand(0.6, 2.2);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
}
const starMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uC: { value: new V3() }, uS: { value: STAR_BOX }, uPx: { value: 1 } },
  vertexShader: `
    uniform vec3 uC; uniform float uS; uniform float uPx;
    attribute float aSize; varying float vA;
    void main(){
      vec3 p = mod(position - uC + uS*0.5, uS) - uS*0.5;
      vec4 mv = viewMatrix * vec4(p + uC, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = clamp(aSize * uPx * 40.0 / -mv.z, 1.0, 5.0);
      vA = smoothstep(uS*0.5, uS*0.3, length(p));
    }`,
  fragmentShader: `
    varying float vA;
    void main(){
      float d = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.0, d) * vA;
      gl_FragColor = vec4(mix(vec3(0.5,0.9,1.0), vec3(1.0,0.5,0.9), gl_PointCoord.x), a);
    }`,
});
starMat.uniforms.uPx.value = renderer.getPixelRatio();
const stars = new THREE.Points(starGeo, starMat);
stars.frustumCulled = false;
scene.add(stars);

// Nitro warp streaks: lines stretched along the flight direction while boosting
const STREAK_BOX = 300;
const streakGeo = new THREE.BufferGeometry();
{
  const n = 900, pos = new Float32Array(n * 6), end = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = rand(0, STREAK_BOX), y = rand(0, STREAK_BOX), z = rand(0, STREAK_BOX);
    pos.set([x, y, z, x, y, z], i * 6);
    end[i * 2 + 1] = 1;
  }
  streakGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  streakGeo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
}
const streakMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uC: { value: new V3() }, uS: { value: STREAK_BOX }, uDir: { value: new V3(0, 0, -1) }, uLen: { value: 34 }, uBoost: { value: 0 } },
  vertexShader: `
    uniform vec3 uC; uniform float uS; uniform vec3 uDir; uniform float uLen; uniform float uBoost;
    attribute float aEnd; varying float vA;
    void main(){
      vec3 p = mod(position - uC + uS*0.5, uS) - uS*0.5;
      vec3 w = p + uC + uDir * (aEnd * uLen * uBoost);
      gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      vA = smoothstep(uS*0.5, uS*0.25, length(p)) * (1.0 - aEnd) * uBoost;
    }`,
  fragmentShader: `varying float vA; void main(){ gl_FragColor = vec4(0.55, 0.95, 1.0, vA * 0.9); }`,
});
const streaks = new THREE.LineSegments(streakGeo, streakMat);
streaks.frustumCulled = false;
streaks.visible = false;
scene.add(streaks);

/* =====================================================================
   MODELS — fallbacks first, GLB swapped in when loaded
   ===================================================================== */
function fbPlayer() {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color: 0x2a2150, metalness: 0.8, roughness: 0.3, emissive: 0x19f3ff, emissiveIntensity: 0.25 });
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.9, 5, 4), m);
  body.rotation.x = -Math.PI / 2;
  const wing = new THREE.Mesh(new THREE.BoxGeometry(6, 0.15, 1.8), m);
  wing.position.z = 0.8;
  g.add(body, wing);
  return g;
}
function fbEnemy() {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color: 0x330a1f, emissive: 0xff2e88, emissiveIntensity: 0.8 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.25, 8, 24), m);
  ring.rotation.x = Math.PI / 2;
  g.add(new THREE.Mesh(new THREE.OctahedronGeometry(2.2), m), ring);
  return g;
}
function fbCoin() {
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(1.8), new THREE.MeshStandardMaterial({ color: 0xffc83d, emissive: 0xffa800, emissiveIntensity: 0.9, metalness: 0.5, roughness: 0.2 }));
  m.scale.y = 1.5;
  const g = new THREE.Group(); g.add(m); return g;
}

const templates = { player: fbPlayer(), enemy: fbEnemy(), coin: fbCoin() };
const registry = { player: new Set(), enemy: new Set(), coin: new Set() };

/** Guarantee a physically-based material so paint keeps real lighting (gradients, reflections, metal). */
function ensureStandard(m) {
  if (m.isMeshStandardMaterial) return m;                 // includes MeshPhysicalMaterial (GLB materials)
  const s = new THREE.MeshStandardMaterial({
    color: m.color ? m.color.clone() : new THREE.Color(0xffffff), map: m.map || null, side: m.side,
    transparent: m.transparent, opacity: m.opacity, vertexColors: !!m.vertexColors,
    metalness: 0.55, roughness: 0.4, name: m.name,
  });
  return s;
}

/** Fill an entity's holder with a cloned model (own materials, so flashes don't leak). */
function fill(ent, kind) {
  ent.holder.clear();
  const c = templates[kind].clone(true);
  const mats = [];
  c.traverse((o) => {
    if (!o.isMesh) return;
    o.material = ensureStandard(o.material.clone());
    const m = o.material, u = m.userData;
    if (m.emissive) { u.e0 = m.emissive.getHex(); u.i0 = m.emissiveIntensity; u.e00 = u.e0; u.i00 = u.i0; }
    if (m.color) u.c0 = m.color.getHex();                 // originals, so a paint can be undone / re-applied
    u.m0 = m.metalness; u.r0 = m.roughness;
    mats.push(m);
  });
  ent.holder.add(c);
  ent.mats = mats;
  if (kind === 'player') applyPaint(ent);
}

/**
 * Repaint the airframe WITHOUT flattening it:
 *  - hue/saturation come from the paint, but each part keeps its own lightness, so dark panels stay dark,
 *    bright plates stay bright and the model's shading survives;
 *  - textured materials are only multiplied by a tint, so the baked detail / normal-lit gradients remain;
 *  - metalness, roughness, maps and emissive are never touched, so reflections and the metallic look stay;
 *  - glass, glow, engine and near-black trim keep their original look.
 */
const _pc = { h: 0, s: 0, l: 0 }, _oc = { h: 0, s: 0, l: 0 }, _tint = new THREE.Color(), _tmp = new THREE.Color();
function paintTint(m, paintHex) {
  const u = m.userData;
  _tmp.setHex(paintHex).getHSL(_pc, THREE.SRGBColorSpace);
  if (m.map) {                                            // texture carries the shading: tint it, lifted so it doesn't go muddy
    return _tint.setHSL(_pc.h, _pc.s, clamp(_pc.l + 0.12, 0.45, 0.72), THREE.SRGBColorSpace);
  }
  _tmp.setHex(u.c0).getHSL(_oc, THREE.SRGBColorSpace);
  if (_oc.l < 0.1) return null;                           // black rubber / dark trim stays as modelled
  const l = clamp(_pc.l * (0.55 + 0.9 * _oc.l), 0.07, 0.82);   // keep the part's own light/dark relationship
  const sat = clamp(_pc.s * (0.75 + 0.25 * _oc.s), 0, 1);
  return _tint.setHSL(_pc.h, sat, l, THREE.SRGBColorSpace);
}
function applyPaint(ent) {
  const p = PAINTS.find((x) => x.id === SAVE.paint) || PAINTS[0];
  for (const m of ent.mats) {
    const u = m.userData;
    if (!m.color || u.c0 === undefined) continue;
    m.color.setHex(u.c0);                                 // always start from the original so repaints never stack
    if (u.m0 !== undefined) { m.metalness = u.m0; m.roughness = u.r0; }
    if (m.emissive && u.e00 !== undefined) { m.emissive.setHex(u.e00); m.emissiveIntensity = u.i00; u.e0 = u.e00; u.i0 = u.i00; }
    if (!p.color) continue;
    const skip = m.transparent || m.opacity < 1 || /glass|canopy|cockpit|window|light|glow|flame|engine|thrust|jet/i.test(m.name || '');
    if (skip) continue;
    const tint = paintTint(m, p.color);
    if (tint) m.color.copy(tint);
  }
}
function makeEntity(kind) {
  const ent = { holder: new THREE.Group(), mats: [] };
  fill(ent, kind);
  registry[kind].add(ent);
  return ent;
}

function normalizeModel(src, size, yaw, kind, tilt = { x: 0, z: 0 }) {
  const box = new THREE.Box3().setFromObject(src);
  const center = box.getCenter(new V3());
  const dim = box.getSize(new V3());
  src.position.sub(center);
  const wrap = new THREE.Group();
  wrap.add(src);
  wrap.scale.setScalar(size / Math.max(dim.x, dim.y, dim.z));
  wrap.rotation.set(tilt.x, yaw, tilt.z, 'YXZ');   // fix roll/pitch first, then turn the nose to -Z
  if (kind === 'coin') { // give the crystal an energy glow
    src.traverse((o) => {
      if (o.isMesh && o.material && o.material.emissive) {
        o.material.emissive.setHex(0xffb300);
        o.material.emissiveIntensity = 0.5;
        if (o.material.map) o.material.emissiveMap = o.material.map;
      }
    });
  }
  const g = new THREE.Group();
  g.add(wrap);
  return g;
}

const manager = new THREE.LoadingManager();
manager.onProgress = (_u, l, t) => { $('load-text').textContent = `Loading models ${l}/${t}`; };
manager.onLoad = () => { $('load-text').textContent = 'Models ready'; };
const loader = new GLTFLoader(manager);
for (const kind of Object.keys(CFG.assets)) {
  loader.load(
    CFG.assets[kind],
    (gltf) => {
      templates[kind] = normalizeModel(gltf.scene, CFG.modelSize[kind], CFG.modelYaw[kind], kind, CFG.modelTilt[kind]);
      registry[kind].forEach((ent) => fill(ent, kind));
    },
    undefined,
    (err) => {
      console.warn(`Could not load ${CFG.assets[kind]} — using fallback mesh.`, err);
      $('load-text').textContent = 'Some models failed to load — using fallback shapes';
    },
  );
}

/* =====================================================================
   PLAYER
   ===================================================================== */
const player = new THREE.Group();
player.rotation.order = 'YXZ';
scene.add(player);
const pivot = new THREE.Group();          // roll happens here
player.add(pivot);
const playerEnt = { holder: new THREE.Group(), mats: [] };
registry.player.add(playerEnt);
fill(playerEnt, 'player');
pivot.add(playerEnt.holder);
// Power-up shield: faint wireframe shell, only visible while the shield is active
const shieldMesh = new THREE.Mesh(
  new THREE.IcosahedronGeometry(5.5, 1),
  new THREE.MeshBasicMaterial({ color: 0x19f3ff, wireframe: true, transparent: true, opacity: 0.25, toneMapped: false }));
shieldMesh.visible = false;
player.add(shieldMesh);

const fwd = new V3(0, 0, -1);
const pbox = new THREE.Box3();
const S = {
  state: 'menu', time: 0,
  hp: CFG.maxHP, score: 0, coins: 0, kills: 0,
  yaw: 0, pitch: 0, roll: 0, rollVel: 0, ix: 0, iy: 0,
  speedMul: 1, invuln: 0, shake: 0, fireCd: 0, side: 1, spawnTimer: 0,
  paused: false, combo: 0, comboT: 0,
  cam: 0,
  boost: 0, boosting: false, nitro: 100, nitroLock: false, nitroDelay: 0,
  shield: 0, multi: 0, shieldFlash: 0, bossPhase: false, bossTimer: 0, boss: null,
  rockets: CFG.maxRockets, rocketCd: 0, rocketSide: 1, reloading: false, reloadT: 0, reloadTick: 0, regenT: 0,
  wave: 0, waveKills: 0, waveSpawned: 0, waveActive: false, waveCleared: false, waveDelay: 0,
};

/* =====================================================================
   INPUT (keyboard + virtual joystick + fire button)
   ===================================================================== */
const keys = new Set();
addEventListener('keydown', (e) => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const K = (...c) => c.some((k) => keys.has(k));

const stick = { x: 0, y: 0 };
let touchFire = false, touchBoost = false, touchRocket = false;
{
  const el = $('stick'), knob = $('knob');
  let id = null;
  const move = (e) => {
    const r = el.getBoundingClientRect(), R = r.width / 2;
    let dx = e.clientX - (r.left + R), dy = e.clientY - (r.top + R);
    const m = Math.hypot(dx, dy);
    if (m > R) { dx *= R / m; dy *= R / m; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const nx = dx / R, ny = -dy / R;
    stick.x = Math.abs(nx) < 0.08 ? 0 : nx;
    stick.y = Math.abs(ny) < 0.08 ? 0 : ny;
  };
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null; stick.x = stick.y = 0; knob.style.transform = '';
  };
  el.addEventListener('pointerdown', (e) => { id = e.pointerId; el.setPointerCapture(id); move(e); });
  el.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e); });
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', end);

  // Hold-style touch button: each finger is tracked by pointerId, so stick + fire + boost work together.
  const buzz = haptic;
  const holdBtn = (id, set, haptic) => {
    const b = $(id);
    let pid = null;
    const up = (e) => { if (pid !== null && e.pointerId !== pid) return; pid = null; set(false); b.classList.remove('down'); };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (pid !== null) return;
      pid = e.pointerId; set(true); b.classList.add('down'); buzz(haptic);
      try { b.setPointerCapture(pid); } catch (_) {}
    });
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
  };
  holdBtn('fire', (v) => { touchFire = v; }, 8);
  holdBtn('boost-btn', (v) => { touchBoost = v; }, 14);
  holdBtn('rocket-btn', (v) => { touchRocket = v; }, 18);
}
// iOS Safari: block pinch / double-tap zoom gestures over the canvas and controls
['gesturestart', 'gesturechange'].forEach((t) => addEventListener(t, (e) => e.preventDefault()));

const inp = { x: 0, y: 0, fire: false, boost: false, rocket: false };
function readInput() {
  inp.x = clamp(Number(K('KeyD', 'ArrowRight')) - Number(K('KeyA', 'ArrowLeft')) + stick.x, -1, 1);
  inp.y = clamp(Number(K('KeyW', 'ArrowUp')) - Number(K('KeyS', 'ArrowDown')) + stick.y, -1, 1);
  inp.fire = K('Space') || touchFire;
  inp.boost = K('ShiftLeft', 'ShiftRight') || touchBoost;
  inp.rocket = K('KeyF', 'KeyE') || touchRocket;
}

/* =====================================================================
   AUDIO — procedural Web Audio (no audio files). Unlocked on Launch.
   ===================================================================== */
const SFX_GAIN = 3;   // per-sound loudness multiplier
const MASTER = 1.0;
let AC = null, master = null, noiseBuf = null, muted = SAVE.muted;
function initAudio() {
  if (AC) return;
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    master = AC.createGain();
    master.gain.value = muted ? 0 : MASTER;
    // compressor keeps the louder mix punchy without clipping
    const comp = AC.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 20; comp.ratio.value = 8;
    comp.attack.value = 0.003; comp.release.value = 0.15;
    master.connect(comp);
    comp.connect(AC.destination);
    noiseBuf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    buildEngine();
  } catch { AC = null; }
}

/* Continuous jet engine: detuned saws + sub + filtered noise, with a slow rumble LFO */
let jet = null;
function buildEngine() {
  const osc = (type, f) => { const o = AC.createOscillator(); o.type = type; o.frequency.value = f; o.start(); return o; };
  const o1 = osc('sawtooth', 55), o2 = osc('sawtooth', 55.7), o3 = osc('sine', 27.5);
  const mix = AC.createGain(); mix.gain.value = 0.5;
  [[o1, 0.3], [o2, 0.3], [o3, 0.6]].forEach(([o, v]) => { const g = AC.createGain(); g.gain.value = v; o.connect(g).connect(mix); });

  const lp = AC.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 350; lp.Q.value = 2;
  mix.connect(lp);

  const nSrc = AC.createBufferSource();            // airy roar
  nSrc.buffer = noiseBuf; nSrc.loop = true;
  const bp = AC.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 600; bp.Q.value = 0.7;
  const nGain = AC.createGain(); nGain.gain.value = 0.12;
  nSrc.connect(bp).connect(nGain).connect(lp);
  nSrc.start();

  const lfo = osc('sine', 6), lfoG = AC.createGain(); lfoG.gain.value = 1.5;   // subtle pitch wobble
  lfo.connect(lfoG); lfoG.connect(o1.frequency); lfoG.connect(o2.frequency);

  const out = AC.createGain(); out.gain.value = 0;
  lp.connect(out).connect(master);
  jet = { o1, o2, o3, lp, nGain, out };
}
function updateEngineSound() {
  if (!jet || !AC) return;
  const now = AC.currentTime, on = S.state === 'playing' && !S.paused;
  const f = 55 * (0.7 + 0.3 * S.speedMul) + S.boost * 85 + S.iy * 4;   // boost = big pitch rise; crashes dip it
  jet.o1.frequency.setTargetAtTime(f, now, 0.08);
  jet.o2.frequency.setTargetAtTime(f * 1.012, now, 0.08);
  jet.o3.frequency.setTargetAtTime(f * 0.5, now, 0.08);
  jet.lp.frequency.setTargetAtTime(350 + S.boost * 1700, now, 0.1);    // brighter when boosting
  jet.nGain.gain.setTargetAtTime(0.12 + S.boost * 0.55, now, 0.1);
  jet.out.gain.setTargetAtTime(on ? 0.14 + S.boost * 0.16 : 0, now, on ? 0.15 : 0.4);
}
function tone(type, f0, f1, dur, vol, delay = 0) {
  const t = AC.currentTime + delay, o = AC.createOscillator(), g = AC.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(vol * SFX_GAIN, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol, f0, f1, delay = 0) {
  const t = AC.currentTime + delay, src = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
  src.buffer = noiseBuf;
  f.type = 'lowpass';
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(vol * SFX_GAIN, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t); src.stop(t + dur + 0.02);
}
const SFX = {
  laser() { const j = rand(0.92, 1.08); tone('sawtooth', 1200 * j, 160, 0.13, 0.06); tone('square', 2400 * j, 400, 0.05, 0.02); },
  tick() { tone('square', 420, 200, 0.05, 0.04); },
  boom() { noise(0.7, 0.35, 2200, 60); tone('sine', 150, 28, 0.55, 0.35); tone('sawtooth', 90, 30, 0.3, 0.12); },
  coin() { tone('sine', 988, 988, 0.09, 0.12); tone('sine', 1319, 1319, 0.2, 0.12, 0.07); },
  hit() { noise(0.3, 0.3, 900, 80); tone('sawtooth', 200, 50, 0.25, 0.15); },
  warn() { tone('square', 300, 900, 0.35, 0.03); },
  eshot() { tone('square', 220, 80, 0.12, 0.025); },
  boost() { noise(0.6, 0.18, 400, 3500); tone('sawtooth', 110, 420, 0.5, 0.06); },
  shield() { tone('triangle', 700, 1400, 0.12, 0.1); tone('triangle', 1400, 500, 0.2, 0.06, 0.1); },
  power() { [440, 660, 880].forEach((f, i) => tone('triangle', f, f * 1.5, 0.18, 0.09, i * 0.07)); },
  rocket() { noise(0.4, 0.25, 1400, 300); tone('sawtooth', 180, 520, 0.4, 0.08); },
  reloadStart() {     // two mechanical clacks, then a servo whir
    tone('square', 160, 70, 0.07, 0.12); noise(0.09, 0.3, 3500, 400);
    tone('square', 220, 90, 0.07, 0.12, 0.14); noise(0.09, 0.3, 3500, 400, 0.14);
    tone('sawtooth', 90, 150, 0.35, 0.05, 0.28);
  },
  ratchet() { noise(0.04, 0.22, 4500, 800); tone('square', 320, 160, 0.03, 0.06); },
  reloadEnd() {       // heavy bolt-lock clunk x2 and a ready chime
    tone('square', 130, 55, 0.09, 0.2); noise(0.12, 0.45, 2500, 200);
    tone('square', 170, 60, 0.09, 0.2, 0.13); noise(0.12, 0.45, 2500, 200, 0.13);
    tone('triangle', 880, 1320, 0.18, 0.12, 0.3);
  },
  regen() { noise(0.05, 0.12, 3800, 900); tone('square', 520, 380, 0.05, 0.05); tone('triangle', 1040, 1240, 0.08, 0.05, 0.05); },
  dry() { tone('square', 260, 140, 0.05, 0.1); noise(0.04, 0.2, 3000, 600); },
  rocketBoom() { noise(1.0, 0.5, 2800, 50); tone('sine', 110, 22, 0.8, 0.5); tone('sawtooth', 70, 25, 0.5, 0.2); },
  wave() { [392, 523, 659, 784].forEach((f, i) => tone('triangle', f, f, 0.22, 0.12, i * 0.1)); },
  lose() { tone('sawtooth', 330, 40, 1.2, 0.15); noise(1, 0.2, 1500, 50); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, f, 0.28, 0.1, i * 0.12)); },
};
function sfx(kind) { if (AC && !muted) SFX[kind](); }
function setMuted(m) {
  muted = m;
  if (master) master.gain.value = m ? 0 : MASTER;
  SAVE.muted = m; saveNow();
  $('mute').textContent = muteLabel();
}
const muteLabel = () => `${t('sound')}: ${t(muted ? 'off' : 'on')}`;

/* =====================================================================
   PARTICLES
   ===================================================================== */
const fx = [];
function burst(pos, color, count = 50, speed = 40, size = 2.5) {
  const geo = new THREE.BufferGeometry();
  const p = new Float32Array(count * 3), v = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    p.set([pos.x, pos.y, pos.z], i * 3);
    const d = new V3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(0.2, 1) * speed);
    v.set([d.x, d.y, d.z], i * 3);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const mat = new THREE.PointsMaterial({ color, size, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  fx.push({ pts, v, t: 0, max: 0.9 });
}
function updateFx(dt) {
  for (let k = fx.length - 1; k >= 0; k--) {
    const f = fx[k];
    f.t += dt;
    const a = f.pts.geometry.attributes.position;
    for (let i = 0; i < a.count; i++) {
      a.array[i * 3] += f.v[i * 3] * dt;
      a.array[i * 3 + 1] += f.v[i * 3 + 1] * dt;
      a.array[i * 3 + 2] += f.v[i * 3 + 2] * dt;
    }
    for (let i = 0; i < f.v.length; i++) f.v[i] *= 0.96;
    a.needsUpdate = true;
    f.pts.material.opacity = Math.max(0, 1 - f.t / f.max);
    if (f.t >= f.max) {
      scene.remove(f.pts);
      f.pts.geometry.dispose(); f.pts.material.dispose();
      fx.splice(k, 1);
    }
  }
}

/* Expanding shockwave ring (always faces the camera) */
const rings = [];
const ringGeo = new THREE.RingGeometry(0.8, 1, 48);
function shockwave(pos, color, size = 16) {
  const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
    color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  }));
  m.position.copy(pos);
  scene.add(m);
  rings.push({ m, t: 0, size });
}
function updateRings(dt) {
  for (let k = rings.length - 1; k >= 0; k--) {
    const r = rings[k];
    r.t += dt;
    const u = r.t / 0.55;
    r.m.scale.setScalar(1 + u * r.size);
    r.m.material.opacity = Math.max(0, 1 - u);
    r.m.quaternion.copy(camera.quaternion);
    if (u >= 1) { scene.remove(r.m); r.m.material.dispose(); rings.splice(k, 1); }
  }
}

/* Floating text (+score, +crystal ...) — spawned at a projected world position */
const floaters = $('floaters');
const _pv = new V3();
function floatAt(pos, text, cls = 'score', dy = 0) {
  let x = innerWidth / 2, y = innerHeight * 0.45;
  if (pos) {
    _pv.copy(pos).project(camera);
    if (_pv.z < 1) { x = (_pv.x * 0.5 + 0.5) * innerWidth; y = (-_pv.y * 0.5 + 0.5) * innerHeight; }
  }
  x = clamp(x + rand(-14, 14), 50, innerWidth - 50);
  y = clamp(y - dy, 70, innerHeight - 70);
  const el = document.createElement('div');
  el.className = `floater ${cls}`;
  el.textContent = text;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.addEventListener('animationend', () => el.remove());
  floaters.appendChild(el);
  while (floaters.children.length > 14) floaters.firstChild.remove();
}

function clearEffects() {
  fx.forEach((f) => { scene.remove(f.pts); f.pts.geometry.dispose(); f.pts.material.dispose(); });
  fx.length = 0;
  rings.forEach((r) => { scene.remove(r.m); r.m.material.dispose(); });
  rings.length = 0;
  floaters.innerHTML = '';
}

/* =====================================================================
   LASERS
   ===================================================================== */
const laserGeo = new THREE.CylinderGeometry(0.15, 0.15, 5, 6).rotateX(Math.PI / 2);
const laserMats = [new THREE.MeshBasicMaterial({ color: 0x19f3ff, toneMapped: false }), new THREE.MeshBasicMaterial({ color: 0xff2e88, toneMapped: false })];
const lasers = [];
for (let i = 0; i < 72; i++) {
  const mesh = new THREE.Mesh(laserGeo, laserMats[i % 2]);
  mesh.visible = false;
  scene.add(mesh);
  lasers.push({ mesh, vel: new V3(), life: 0, on: false, box: new THREE.Box3() });
}
const _t = new V3();
const _lq = new THREE.Quaternion(), _aq = new THREE.Quaternion();
function spawnLaser(origin, angle) {
  const l = lasers.find((x) => !x.on);
  if (!l) return;
  _aq.setFromAxisAngle(UP, -angle);
  _lq.copy(player.quaternion).multiply(_aq);
  l.mesh.position.copy(origin);
  l.mesh.quaternion.copy(_lq);
  l.vel.set(0, 0, -1).applyQuaternion(_lq).multiplyScalar(CFG.laserSpeed);
  l.life = 1.4; l.on = true; l.mesh.visible = true;
}
function fireLaser() {
  if (S.multi > 0) {                       // triple spread
    _t.set(0, -0.2, -3.5).applyQuaternion(player.quaternion).add(player.position);
    [-0.12, 0, 0.12].forEach((a) => spawnLaser(_t, a));
  } else {
    S.side *= -1;
    _t.set(S.side * 1.6, -0.2, -3.5).applyQuaternion(player.quaternion).add(player.position);
    spawnLaser(_t, 0);
  }
  sfx('laser');
}

/* =====================================================================
   ROCKETS — secondary weapon: slower, homing a little, big blast radius
   ===================================================================== */
const rockets = [];
{
  const body = new THREE.CylinderGeometry(0.35, 0.35, 3, 8).rotateX(Math.PI / 2);
  const nose = new THREE.ConeGeometry(0.35, 1.2, 8).rotateX(Math.PI / 2).translate(0, 0, 2.1);
  const glow = new THREE.SphereGeometry(0.7, 8, 6).translate(0, 0, -1.8);
  const mBody = new THREE.MeshBasicMaterial({ color: 0xffb347, toneMapped: false });
  const mNose = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const mGlow = new THREE.MeshBasicMaterial({ color: 0xff7a1a, toneMapped: false });
  for (let i = 0; i < 12; i++) {                 // pool of in-flight rocket meshes (max ammo is 10)
    const g = new THREE.Group();
    g.add(new THREE.Mesh(body, mBody), new THREE.Mesh(nose, mNose), new THREE.Mesh(glow, mGlow));
    g.visible = false;
    scene.add(g);
    rockets.push({ mesh: g, vel: new V3(), life: 0, on: false, trail: 0, age: 0, target: null, box: new THREE.Box3() });
  }
}
const _ra = new V3(), _rb = new V3(), _rq = new THREE.Quaternion(), _rq2 = new THREE.Quaternion();

/** Nearest live drone in full 3D (no cone limit); falls back to the boss if no drones remain. */
function nearestTarget(from) {
  let best = null, bd = Infinity;
  for (const e of enemies) {
    const d = e.obj.position.distanceToSquared(from);
    if (d < bd) { bd = d; best = e; }
  }
  return best || S.boss || null;
}

function startReload() {
  if (S.state !== 'playing' || S.paused || S.reloading) return;
  if (S.rockets >= CFG.maxRockets) { floatAt(player.position, t('msg.full'), 'score'); return; }
  S.reloading = true; S.reloadT = 0; S.reloadTick = 0.3;
  sfx('reloadStart');
  floatAt(player.position, t('msg.reloading'), 'power');
}

function fireRocket() {
  if (S.reloading || S.rocketCd > 0) return;
  if (S.rockets < 1) {                       // empty: dry click + hint
    S.rocketCd = 0.8; sfx('dry');
    floatAt(player.position, t(isTouch ? 'msg.empty.t' : 'msg.empty.k'), 'dmg');
    return;
  }
  const r = rockets.find((x) => !x.on);
  if (!r) return;
  S.rockets--; S.rocketCd = 0.6; S.rocketSide *= -1;
  S.shake = Math.max(S.shake, 0.25);
  r.mesh.position.set(S.rocketSide * 1.2, -0.9, -2).applyQuaternion(player.quaternion).add(player.position);
  r.vel.copy(fwd).multiplyScalar(CFG.rocketSpeed);
  r.mesh.lookAt(_t.copy(r.mesh.position).add(r.vel));
  r.life = 2.6; r.trail = 0; r.age = 0; r.on = true; r.mesh.visible = true;
  r.target = nearestTarget(r.mesh.position);     // lock on at launch
  sfx('rocket');
}

function explodeRocket(pos) {
  const R = CFG.rocketRadius;
  shockwave(pos, 0xffa030, 34);
  shockwave(pos, 0xffffff, 18);
  burst(pos, 0xffa030, 90, 70, 3.5);
  burst(pos, 0xff2e88, 50, 40, 3);
  burst(pos, 0xffffff, 30, 100, 1.6);
  sfx('rocketBoom');
  S.shake = Math.max(S.shake, 0.55);
  for (const e of [...enemies]) {           // area damage
    if (e.obj.position.distanceTo(pos) < R) {
      e.hp -= 4;
      if (e.hp <= 0) killEnemy(e, true); else flashEnemy(e);
    }
  }
  if (S.boss && S.boss.obj.position.distanceTo(pos) < R + 16) hitBoss(pos, 8);
}

function updateRockets(dt) {
  S.rocketCd -= dt;
  if (S.reloading) {                         // reload sequence: ratchet clicks, then refill to max
    S.reloadT += dt; S.reloadTick -= dt;
    if (S.reloadTick <= 0) { sfx('ratchet'); S.reloadTick = 0.3; }
    if (S.reloadT >= CFG.rocketReload) {
      S.reloading = false; S.rockets = CFG.maxRockets; S.regenT = 0;
      sfx('reloadEnd');
      floatAt(player.position, t('msg.ready'), 'heal');
    }
  }
  else if (S.rockets < CFG.maxRockets) {     // passive regen: one rocket every rocketRegen seconds
    S.regenT += dt;
    if (S.regenT >= CFG.rocketRegen) {
      S.regenT -= CFG.rocketRegen; S.rockets++;
      sfx('regen');
    }
  } else S.regenT = 0;
  if (inp.rocket) fireRocket();

  for (const r of rockets) {
    if (!r.on) continue;
    const p = r.mesh.position;

    // Homing: steer toward the locked target with a limited turn rate, so the missile arcs through the air
    r.age += dt;
    if (r.target && r.target !== S.boss && !enemies.includes(r.target)) r.target = null;   // target destroyed
    if (!r.target) r.target = nearestTarget(p);                                              // re-acquire
    if (r.target && r.age > 0.15) {                                                          // short straight launch
      const tp = r.target.obj.position;
      const lead = (tp.distanceTo(p) / CFG.rocketSpeed) * 0.6;                               // aim slightly ahead of the target
      _ra.copy(tp).addScaledVector(r.target.vel, lead).sub(p).normalize();                   // desired heading
      _rb.copy(r.vel).normalize();                                                           // current heading
      const ang = _rb.angleTo(_ra);
      if (ang > 1e-4) {
        _rq.setFromUnitVectors(_rb, _ra);
        _rq2.identity().slerp(_rq, Math.min(1, (CFG.rocketTurn * dt) / ang));                // rotate by at most rocketTurn·dt
        _rb.applyQuaternion(_rq2);
      }
      r.vel.copy(_rb).multiplyScalar(CFG.rocketSpeed);
      r.mesh.lookAt(_t.copy(p).add(r.vel));
    }

    p.addScaledVector(r.vel, dt);
    r.life -= dt;
    r.trail -= dt;
    if (r.trail <= 0) { burst(_t.copy(p).addScaledVector(r.vel, -0.02), 0xffa030, 4, 6, 2.2); r.trail = 0.04; }

    let boom = r.life <= 0 || p.y < 0.5 || p.y < heightAt(p.x, p.z);
    if (!boom) {
      r.box.setFromCenterAndSize(p, _t.set(5, 5, 5));
      for (const e of enemies) {
        e.box.setFromCenterAndSize(e.obj.position, _t.set(8, 6, 8));
        if (r.box.intersectsBox(e.box)) { boom = true; break; }
      }
      if (!boom && S.boss && r.box.intersectsBox(S.boss.box)) boom = true;
    }
    if (boom) { r.on = false; r.mesh.visible = false; explodeRocket(p.clone()); }
  }
}

/* =====================================================================
   ENEMY PROJECTILES
   ===================================================================== */
const bulletGeo = new THREE.CylinderGeometry(0.35, 0.35, 4, 8).rotateX(Math.PI / 2);
const bulletMat = new THREE.MeshBasicMaterial({ color: 0xff2030, toneMapped: false });
const bullets = [];
for (let i = 0; i < 140; i++) {
  const mesh = new THREE.Mesh(bulletGeo, bulletMat);
  mesh.visible = false;
  scene.add(mesh);
  bullets.push({ mesh, vel: new V3(), life: 0, on: false, dmg: 10, s: 1, box: new THREE.Box3() });
}
function fireBullet(from, dir, speed = 105, scale = 1, dmg = 10) {
  const b = bullets.find((x) => !x.on);
  if (!b) return;
  b.mesh.position.copy(from);
  b.vel.copy(dir).normalize().multiplyScalar(speed);
  b.mesh.lookAt(_t.copy(from).add(b.vel));
  b.mesh.scale.setScalar(scale);
  b.life = 4; b.dmg = dmg; b.s = scale; b.on = true; b.mesh.visible = true;
}
function updateBullets(dt) {
  for (const b of bullets) {
    if (!b.on) continue;
    const p = b.mesh.position;
    p.addScaledVector(b.vel, dt);
    b.life -= dt;
    let dead = b.life <= 0;
    if (!dead && (p.y < 0.5 || p.y < heightAt(p.x, p.z))) { burst(p, 0xff2030, 6, 12, 1.4); dead = true; }
    if (!dead) {
      b.box.setFromCenterAndSize(p, _t.set(3 * b.s, 3 * b.s, 3 * b.s));
      if (pbox.intersectsBox(b.box)) { burst(p, 0xff2030, 14, 30, 2); dead = true; hurt(b.dmg); }
    }
    if (dead) { b.on = false; b.mesh.visible = false; }
  }
}

/* =====================================================================
   ENEMIES — patrol → chase (weaving strafe) → windup → dash → retreat
   ===================================================================== */
const enemies = [];
const _m4 = new THREE.Matrix4(), _eq = new THREE.Quaternion();
const _des = new V3(), _n = new V3(), _side = new V3(), _aim = new V3();

/** Place a drone inside the player's forward view cone (independent of the active camera), 190-290 units out — never behind. */
const _ndc = new V3();
function placeEnemy(e) {
  const tanV = Math.tan(THREE.MathUtils.degToRad(camBaseFov / 2)), tanH = tanV * camera.aspect;
  let x = 0, y = 0, z = 0, ok = false;
  for (let tries = 0; tries < 8 && !ok; tries++) {
    const d = rand(190, 290);
    // random direction in the central part of the forward view, rotated into the player's heading
    _ndc.set(rand(-0.7, 0.7) * tanH, rand(-0.35, 0.55) * tanV, -1).normalize().applyQuaternion(player.quaternion);
    x = player.position.x + _ndc.x * d;
    y = player.position.y + _ndc.y * d;
    z = player.position.z + _ndc.z * d;
    ok = y > Math.max(14, heightAt(x, z) + 8) && y < 150;   // clear of rooftops and the ceiling
  }
  if (!ok) y = clamp(Math.max(y, heightAt(x, z) + 8, 14), 14, 150);
  e.obj.position.set(x, y, z);
  e.home.set(x, y, z);
}
function spawnEnemy(withFx = true) {
  const ent = makeEntity('enemy');
  const obj = new THREE.Group();
  obj.add(ent.holder);
  scene.add(obj);
  const e = {
    obj, ent, hp: S.bossPhase ? 2 : waveDef().hp, vel: new V3(), home: new V3(), phase: rand(0, TAU), flash: 0, box: new THREE.Box3(),
    state: 'chase', stateT: 0, cd: rand(1, 3), dodgeCd: 0, dashDir: new V3(), shotCd: rand(1, 2.5),   // engage immediately
  };
  placeEnemy(e);
  if (withFx) { shockwave(e.obj.position, 0xff2e88, 14); burst(e.obj.position, 0xff2e88, 20, 25, 2); }  // warp-in flash
  enemies.push(e);
}
function removeEnemy(e) {
  scene.remove(e.obj);
  registry.enemy.delete(e.ent);
  e.ent.mats.forEach((m) => m.dispose());
  enemies.splice(enemies.indexOf(e), 1);
}
function setGlow(e, hex, intensity) {
  e.ent.mats.forEach((m) => { if (m.emissive) { m.emissive.setHex(hex); m.emissiveIntensity = intensity; } });
}
function restoreGlow(e) {
  e.ent.mats.forEach((m) => { if (m.emissive) { m.emissive.setHex(m.userData.e0); m.emissiveIntensity = m.userData.i0; } });
}
function flashEnemy(e) { e.flash = 0.08; setGlow(e, 0xffffff, 1.5); }

function killEnemy(e, byPlayer) {
  const p = e.obj.position;
  burst(p, 0xff2e88, 80, 60, 3);
  burst(p, 0xffc83d, 40, 35, 2.4);
  burst(p, 0xffffff, 20, 90, 1.5);
  burst(p, 0x19f3ff, 24, 18, 4.5);
  shockwave(p, 0xff2e88, 18);
  sfx('boom');
  S.shake = Math.max(S.shake, 0.35);
  if (byPlayer) {
    S.combo = S.comboT > 0 ? S.combo + 1 : 1;   // chain kills within 3s for a multiplier
    S.comboT = 3;
    const mult = Math.min(5, S.combo), pts = 250 * mult;
    S.score += pts;
    floatAt(p, mult > 1 ? `+${pts}  ×${mult} combo` : `+${pts}`, mult > 1 ? 'combo' : 'score');
    awardCrystals(CFG.crystalKill);
    floatAt(p, t('msg.kill', { n: CFG.crystalKill }), 'coin', 30);
  }
  removeEnemy(e);
  S.kills++;
  if (!S.bossPhase) S.waveKills++;
}

function updateEnemies(dt) {
  const wd = waveDef();
  const chaseSpeed = 40 * wd.speed + S.waveKills * 0.5;   // each wave is faster

  for (let k = enemies.length - 1; k >= 0; k--) {
    const e = enemies[k], p = e.obj.position;
    _n.copy(player.position).sub(p);
    const dist = _n.length();

    if (dist > 520) {                          // left behind: bring it back into play
      restoreGlow(e); e.state = 'chase'; placeEnemy(e); continue;
    }
    _n.divideScalar(dist || 1);                // _n = unit vector enemy → player
    e.cd -= dt; e.stateT -= dt; e.dodgeCd -= dt;
    let rate = 1.6;

    switch (e.state) {
      case 'patrol': {
        const t = S.time * 0.4 + e.phase;
        _des.set(e.home.x + Math.cos(t) * 70, e.home.y + Math.sin(t * 1.7) * 12, e.home.z + Math.sin(t) * 70).sub(p).setLength(30 * wd.speed);
        if (dist < 260) e.state = 'chase';
        break;
      }
      case 'chase': {                          // weave side to side while closing in
        _side.crossVectors(_n, UP).normalize();
        _des.copy(_n).multiplyScalar(chaseSpeed).addScaledVector(_side, Math.sin(S.time * 1.6 + e.phase) * 22);
        _des.y += Math.cos(S.time * 2.3 + e.phase) * 8;
        e.shotCd -= dt;                        // drones shoot while closing in
        if (e.shotCd <= 0 && dist > 35 && dist < 230) {
          const lead = (dist / 105) * 0.55;    // partial lead: dodgeable if you keep moving
          _aim.copy(player.position).addScaledVector(fwd, topSpeed() * (1 + S.boost * boostPow()) * lead);
          _aim.x += rand(-4, 4); _aim.y += rand(-3, 3); _aim.z += rand(-4, 4);
          fireBullet(p, _aim.sub(p));
          sfx('eshot');
          e.shotCd = rand(1.6, 2.8) * wd.fire;
        }
        if (dist > 320) e.state = 'patrol';
        else if (dist < 90 && e.cd <= 0) { e.state = 'windup'; e.stateT = 0.6; sfx('warn'); }
        break;
      }
      case 'windup': {                         // telegraph: stop and glow red
        _des.set(0, 6, 0);
        rate = 4;
        setGlow(e, 0xff2030, 0.7 + 0.5 * Math.sin(S.time * 40));
        if (e.stateT <= 0) {
          restoreGlow(e);
          e.state = 'dash'; e.stateT = 0.8;
          e.dashDir.copy(player.position).addScaledVector(fwd, topSpeed() * 0.4).sub(p).normalize(); // lead the target
        }
        break;
      }
      case 'dash': {
        _des.copy(e.dashDir).multiplyScalar(105 * Math.min(1.3, wd.speed));
        rate = 6;
        if (e.stateT <= 0) { e.state = 'retreat'; e.stateT = 1.4; e.cd = rand(3, 5); }
        break;
      }
      default: {                               // 'retreat'
        _des.copy(_n).multiplyScalar(-36);
        _des.y += 16;
        rate = 2.5;
        if (e.stateT <= 0) e.state = 'chase';
      }
    }

    // sidestep incoming lasers
    if (e.dodgeCd <= 0 && e.state !== 'dash') {
      for (const l of lasers) {
        if (!l.on) continue;
        _side.copy(l.mesh.position).sub(p);
        if (_side.lengthSq() < 28 * 28 && l.vel.dot(_side) < 0) {
          if (Math.random() < 0.6) {
            _side.crossVectors(l.vel, UP).normalize();
            if (Math.random() < 0.5) _side.negate();
            e.vel.addScaledVector(_side, 48);
          }
          e.dodgeCd = 1.2;
          break;
        }
      }
    }

    e.vel.lerp(_des, damp(rate, dt));
    p.addScaledVector(e.vel, dt);

    // stay above rooftops and below the ceiling
    const floor = Math.max(8, heightAt(p.x, p.z) + 6);
    if (p.y < floor) p.y += (floor - p.y) * Math.min(1, dt * 6);
    p.y = Math.min(p.y, 150);

    // face direction of travel
    if (e.vel.lengthSq() > 1) {
      _m4.lookAt(p, _des.copy(p).add(e.vel), UP);
      _eq.setFromRotationMatrix(_m4);
      e.obj.quaternion.slerp(_eq, damp(6, dt));
    }

    if (e.flash > 0) {
      e.flash -= dt;
      if (e.flash <= 0 && e.state !== 'windup') restoreGlow(e);
    }

    // Drone <-> Player collision (Box3)
    e.box.setFromCenterAndSize(p, _side.set(6, 4, 6));
    if (pbox.intersectsBox(e.box)) {
      hurt(20);
      killEnemy(e, false);
    }
  }
}

/* =====================================================================
   WAVES
   ===================================================================== */
const waveDef = () => CFG.waves[Math.min(S.wave, CFG.waves.length - 1)];

function startWave(i) {
  S.wave = i; S.waveKills = 0; S.waveSpawned = 0;
  if (i > SAVE.bestWave) { SAVE.bestWave = i; saveNow(); }
  S.waveActive = false; S.waveCleared = false; S.waveDelay = 2.2;
  const d = CFG.waves[i];
  banner(t('msg.wave', { n: i + 1, c: d.count }));
  sfx('wave');
}

function updateWaves(dt) {
  if (S.bossPhase) return;
  const d = waveDef();

  if (S.waveDelay > 0) {                       // breather between waves
    S.waveDelay -= dt;
    if (S.waveDelay <= 0) {
      if (S.waveCleared) {
        if (S.wave + 1 >= CFG.waves.length) beginBossIntro(); else startWave(S.wave + 1);
      } else S.waveActive = true;
    }
    return;
  }
  if (!S.waveActive) return;

  S.spawnTimer -= dt;
  if (S.waveSpawned < d.count && enemies.length < d.max && S.spawnTimer <= 0) {
    spawnEnemy(); S.waveSpawned++; S.spawnTimer = 0.8;
  }

  if (S.waveKills >= d.count && enemies.length === 0) {   // wave cleared: reward + short pause
    S.waveActive = false; S.waveCleared = true; S.waveDelay = 3.5;
    const bonus = 500 * (S.wave + 1), heal = Math.min(20, CFG.maxHP - S.hp);
    S.score += bonus; S.hp += heal;
    S.rockets = Math.min(CFG.maxRockets, S.rockets + 2);
    banner(t('msg.cleared', { n: S.wave + 1, b: bonus }));
    floatAt(player.position, t('msg.bonus', { b: bonus }), 'combo');
    if (heal > 0) floatAt(player.position, `+${heal} HP`, 'heal', 34);
    sfx('wave');
  }
}

/* =====================================================================
   BOSS — Overlord drone
   ===================================================================== */
function banner(text) {
  const el = $('banner');
  el.textContent = text;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}
function beginBossIntro() {
  S.bossPhase = true;
  if (SAVE.bestWave < CFG.waves.length) { SAVE.bestWave = CFG.waves.length; saveNow(); }
  S.bossTimer = 3;
  banner(t('msg.boss'));
  [0, 350, 700].forEach((t) => setTimeout(() => sfx('warn'), t));
  $('goal-panel').classList.add('hidden');
  $('boss').classList.remove('hidden');
}
function spawnBoss() {
  const ent = makeEntity('enemy');
  ent.holder.scale.setScalar(3.6);
  ent.mats.forEach((m) => {                    // red tint that survives flash/restore
    if (m.emissive) { m.emissive.setHex(0x550010); m.emissiveIntensity = 0.8; m.userData.e0 = 0x550010; m.userData.i0 = 0.8; }
  });
  const obj = new THREE.Group();
  obj.add(ent.holder);
  const halo = new THREE.Mesh(new THREE.TorusGeometry(24, 0.5, 8, 48), new THREE.MeshBasicMaterial({ color: 0xff2e88, toneMapped: false }));
  halo.rotation.x = Math.PI / 2;
  obj.add(halo);
  obj.position.set(player.position.x - Math.sin(S.yaw) * 280, 125, player.position.z - Math.cos(S.yaw) * 280);
  scene.add(obj);
  S.boss = {
    obj, ent, halo, hp: CFG.bossHP, max: CFG.bossHP, vel: new V3(), t: 0, angle: rand(0, TAU),
    cdA: 3, cdB: 6, flash: 0, stage: 0, box: new THREE.Box3(),
  };
  S.boss.box.setFromCenterAndSize(obj.position, _t.set(28, 18, 28));
  sfx('boom');
}
function removeBoss() {
  const b = S.boss;
  if (!b) return;
  scene.remove(b.obj);
  registry.enemy.delete(b.ent);
  b.ent.mats.forEach((m) => m.dispose());
  S.boss = null;
}
function bossMinions() {
  for (let i = 0; i < 2; i++) {
    spawnEnemy(false);
    const e = enemies[enemies.length - 1];
    e.obj.position.copy(S.boss.obj.position).add(_t.set(rand(-25, 25), -15, rand(-25, 25)));
    e.home.copy(e.obj.position);
    e.state = 'chase';
  }
}
function hitBoss(at, dmg = 1) {
  const b = S.boss;
  b.hp -= dmg; S.score += 10 * dmg;
  b.flash = 0.06;
  setGlow(b, 0xffffff, 1.2);
  burst(at, 0xff9ec8, 8, 30, 2);
  sfx('tick');
  if (b.hp <= 0) killBoss();
}
function killBoss() {
  const p = S.boss.obj.position.clone();
  for (let i = 0; i < 8; i++) {
    burst(p.clone().add(new V3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(18)), i % 2 ? 0xff2e88 : 0xffc83d, 70, 70, 3.2);
  }
  shockwave(p, 0xff2e88, 40); shockwave(p, 0xffc83d, 26); shockwave(p, 0xffffff, 60);
  [0, 160, 320, 500, 700].forEach((t) => setTimeout(() => sfx('boom'), t));
  S.shake = 1.2;
  S.score += 5000;
  awardCrystals(CFG.crystalBoss);
  floatAt(p, t('msg.bossdown'), 'combo');
  removeBoss();
  endGame(true);
}
function updateBoss(dt) {
  const b = S.boss;
  if (!b) return;
  const p = b.obj.position;
  b.t += dt;

  // orbit the player at ~130 units, above the skyline
  const a = b.angle + b.t * 0.3;
  _aim.set(player.position.x + Math.cos(a) * 130, 125 + Math.sin(b.t * 0.7) * 14, player.position.z + Math.sin(a) * 130).sub(p);
  _des.copy(_aim).multiplyScalar(0.9);
  if (_des.length() > 100) _des.setLength(100);
  b.vel.lerp(_des, damp(2, dt));
  p.addScaledVector(b.vel, dt);
  _m4.lookAt(p, player.position, UP);
  _eq.setFromRotationMatrix(_m4);
  b.obj.quaternion.slerp(_eq, damp(3, dt));
  b.halo.scale.setScalar(1 + Math.sin(b.t * 4) * 0.05);

  const pct = b.hp / b.max, enraged = pct < 0.5;
  if ((b.stage === 0 && pct <= 0.66) || (b.stage === 1 && pct <= 0.33)) {
    b.stage++; bossMinions(); banner(t('msg.minions'));
  }

  b.cdA -= dt; b.cdB -= dt;
  if (b.cdA <= 0) {                            // aimed 3-shot volley
    const lead = (p.distanceTo(player.position) / 85) * 0.5;
    _aim.copy(player.position).addScaledVector(fwd, topSpeed() * (1 + S.boost * boostPow()) * lead).sub(p).normalize();
    _side.crossVectors(_aim, UP).normalize();
    for (let i = -1; i <= 1; i++) fireBullet(p, _des.copy(_aim).addScaledVector(_side, i * 0.14), 85, 2.2, 15);
    sfx('eshot');
    b.cdA = enraged ? 1.7 : 2.5;
  }
  if (b.cdB <= 0) {                            // expanding ring — slip through the gaps
    const n = enraged ? 20 : 14, ph = rand(0, TAU);
    for (let i = 0; i < n; i++) {
      const ang = ph + (i / n) * TAU;
      fireBullet(p, _des.set(Math.cos(ang), (player.position.y - p.y) / 160, Math.sin(ang)), 70, 1.8, 12);
    }
    sfx('warn');
    S.shake = Math.max(S.shake, 0.3);
    b.cdB = enraged ? 4.5 : 7;
  }

  if (b.flash > 0) { b.flash -= dt; if (b.flash <= 0) restoreGlow(b); }

  b.box.setFromCenterAndSize(p, _side.set(28, 18, 28));
  if (pbox.intersectsBox(b.box)) {             // ramming the boss hurts and bounces you away
    hurt(25);
    _n.copy(player.position).sub(p).normalize();
    player.position.addScaledVector(_n, 26);
    S.speedMul = 0.3;
    pbox.setFromCenterAndSize(player.position, _side.set(4, 2.5, 4));
  }
}

/* =====================================================================
   COINS (energy crystals)
   ===================================================================== */
const coins = [];
const coinBox = new THREE.Box3();
function placeCoin(c, initial) {
  let x, z;
  if (initial) {
    const a = rand(0, TAU), d = rand(60, 320);
    x = player.position.x + Math.cos(a) * d; z = player.position.z + Math.sin(a) * d;
  } else {
    const h = S.yaw + rand(-0.8, 0.8), d = rand(200, 420);
    x = player.position.x - Math.sin(h) * d; z = player.position.z - Math.cos(h) * d;
  }
  const y = Math.max(rand(15, 100), heightAt(x, z) + 10);
  c.obj.position.set(x, y, z);
}
function initCoins() {
  coins.forEach((c) => { scene.remove(c.obj); registry.coin.delete(c.ent); c.ent.mats.forEach((m) => m.dispose()); });
  coins.length = 0;
  for (let i = 0; i < CFG.coinCount; i++) {
    const ent = makeEntity('coin');
    const obj = new THREE.Group();
    obj.add(ent.holder);
    scene.add(obj);
    const c = { obj, ent, ph: rand(0, TAU) };
    placeCoin(c, true);
    coins.push(c);
  }
}
function updateCoins(dt, collect) {
  for (const c of coins) {
    c.ent.holder.rotation.y += dt * 2.2;
    c.ent.holder.position.y = Math.sin(S.time * 2 + c.ph) * 0.8;
    if (c.obj.position.distanceToSquared(player.position) > 520 * 520) placeCoin(c, false);
    if (!collect) continue;
    coinBox.setFromCenterAndSize(c.obj.position, _t.set(6, 6, 6));
    if (pbox.intersectsBox(coinBox)) {
      const healed = Math.min(5, CFG.maxHP - S.hp);
      const gain = crystalPickup();
      S.score += 100; awardCrystals(gain);
      S.hp += healed;
      burst(c.obj.position, 0xffc83d, 36, 30, 2.2);
      shockwave(c.obj.position, 0xffc83d, 8);
      floatAt(c.obj.position, t('msg.crystal', { n: gain }), 'coin');
      if (healed > 0) floatAt(c.obj.position, `+${healed} HP`, 'heal', 30);
      sfx('coin');
      placeCoin(c, false);
    }
  }
}

/* =====================================================================
   POWER-UPS — shield and triple laser, floating in the city
   ===================================================================== */
const POWER = {
  shield: { color: 0x19f3ff, label: 'Shield online', dur: 8 },
  multi: { color: 0xff2e88, label: 'Triple laser', dur: 10 },
};
const powerups = [];
function buildPowerMesh(type) {
  const c = POWER[type].color, g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: c, toneMapped: false });
  if (type === 'shield') {
    g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(2.6, 1), new THREE.MeshBasicMaterial({ color: c, wireframe: true, toneMapped: false })),
      new THREE.Mesh(new THREE.OctahedronGeometry(1), mat));
  } else {
    for (let i = -1; i <= 1; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.55, 3, 6), mat);
      cone.rotation.x = -Math.PI / 2;
      cone.position.x = i * 1.6;
      g.add(cone);
    }
  }
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 70, 6, 1, true),
    new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  g.add(beam);
  return g;
}
function setPowerType(pw, type) {
  pw.type = type;
  pw.obj.clear();
  pw.body = buildPowerMesh(type);
  pw.obj.add(pw.body);
}
function initPowerups() {
  powerups.forEach((pw) => scene.remove(pw.obj));
  powerups.length = 0;
  for (let i = 0; i < 2; i++) {
    const pw = { obj: new THREE.Group(), type: '', body: null, ph: rand(0, TAU), wait: 0 };
    setPowerType(pw, i === 0 ? 'shield' : 'multi');
    placeCoin(pw, true);
    scene.add(pw.obj);
    powerups.push(pw);
  }
}
function collectPower(pw) {
  const def = POWER[pw.type];
  if (pw.type === 'shield') S.shield = def.dur; else S.multi = def.dur;
  burst(pw.obj.position, def.color, 40, 35, 2.4);
  shockwave(pw.obj.position, def.color, 12);
  floatAt(pw.obj.position, def.label, 'power');
  sfx('power');
  pw.wait = rand(8, 14);
  pw.obj.visible = false;
}
function updatePowerups(dt, collect) {
  for (const pw of powerups) {
    if (pw.wait > 0) {                         // respawn after a delay, ahead of the player
      pw.wait -= dt;
      if (pw.wait <= 0) {
        setPowerType(pw, Math.random() < 0.5 ? 'shield' : 'multi');
        placeCoin(pw, false);
        pw.obj.visible = true;
      }
      continue;
    }
    pw.obj.rotation.y += dt * 1.8;
    pw.body.position.y = Math.sin(S.time * 2 + pw.ph);
    if (pw.obj.position.distanceToSquared(player.position) > 520 * 520) placeCoin(pw, false);
    if (!collect) continue;
    coinBox.setFromCenterAndSize(pw.obj.position, _t.set(8, 8, 8));
    if (pbox.intersectsBox(coinBox)) collectPower(pw);
  }
}

/* =====================================================================
   DAMAGE / GAME FLOW
   ===================================================================== */
function hurt(n) {
  if (S.state !== 'playing' || S.invuln > 0) return;
  if (S.shield > 0) {                          // shield absorbs the hit
    S.shieldFlash = 1; S.invuln = 0.3; S.shake = Math.max(S.shake, 0.3);
    sfx('shield');
    floatAt(player.position, t('msg.blocked'), 'score');
    return;
  }
  S.hp = Math.max(0, S.hp - n);
  S.invuln = 0.8;
  S.shake = 0.8;
  S.combo = 0; S.comboT = 0;
  sfx('hit');
  floatAt(player.position, `-${n} HP`, 'dmg');
  const d = $('damage');
  d.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => d.classList.remove('on')));
  if (S.hp <= 0) {
    burst(player.position, 0x19f3ff, 90, 60, 3);
    burst(player.position, 0xff2e88, 60, 40, 3);
    shockwave(player.position, 0x19f3ff, 22);
    sfx('boom');
    pivot.visible = false;
    endGame(false);
  }
}

const bBox = new THREE.Box3();
function collideCity() {
  const pcx = Math.round(player.position.x / CELL), pcz = Math.round(player.position.z / CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const cx = pcx + dx, cz = pcz + dz, d = cityCell(cx, cz);
    if (!d) continue;
    bBox.min.set(cx * CELL - BW / 2, 0, cz * CELL - BW / 2);
    bBox.max.set(cx * CELL + BW / 2, d.h, cz * CELL + BW / 2);
    if (pbox.intersectsBox(bBox)) return { cx, cz, top: d.h };
  }
  return null;
}

function updatePlayer(dt, auto) {
  let tx = inp.x, ty = inp.y;
  if (auto) { tx = Math.sin(S.time * 0.4) * 0.6; ty = Math.sin(S.time * 0.25) * 0.2; }
  const hl = lv('handling');                                // Garage: handling level 0..5
  S.ix += (tx - S.ix) * damp(7 + 1.1 * hl, dt);
  S.iy += (ty - S.iy) * damp(7 + 1.1 * hl, dt);
  S.pitch += (S.iy * 0.55 - S.pitch) * damp(4 + 0.6 * hl, dt);

  // Banked turn: the jet rolls into the turn (spring-damper = smooth, with a touch of overshoot)
  // and the actual turn rate follows the bank angle, so the heading change builds as the wing drops.
  // Stick released -> target bank is 0 -> it rolls back to level on its own.
  const bankTarget = -S.ix * CFG.maxBank;                 // right input -> right wing down (negative Z roll)
  S.rollVel += ((bankTarget - S.roll) * (60 + 8 * hl) - S.rollVel * 11) * dt;
  S.roll += S.rollVel * dt;
  const bankFrac = clamp(-S.roll / CFG.maxBank, -1, 1);
  S.yaw -= (S.ix * 0.4 + bankFrac * 0.6) * 1.5 * (1 + 0.07 * hl) * dt;

  player.rotation.set(S.pitch, S.yaw, 0);
  pivot.rotation.z = S.roll;
  fwd.set(0, 0, -1).applyQuaternion(player.quaternion);

  S.speedMul += (1 - S.speedMul) * damp(1.2, dt);

  // Nitro: hold Shift / Boost. Drains fast, recharges after a short delay.
  const want = !auto && inp.boost && !S.nitroLock && S.nitro > 0;
  if (want) {
    S.nitro = Math.max(0, S.nitro - (38 - 2 * lv('nitro')) * dt);
    S.nitroDelay = 1;
    if (S.nitro <= 0) S.nitroLock = true;
  } else {
    S.nitroDelay -= dt;
    if (S.nitroDelay <= 0) S.nitro = Math.min(100, S.nitro + (22 + 5 * lv('nitro')) * dt);
    if (S.nitroLock && S.nitro >= 25) S.nitroLock = false;
  }
  if (want && !S.boosting) sfx('boost');
  S.boosting = want;
  S.boost += ((want ? 1 : 0) - S.boost) * damp(want ? 5 + 1.2 * lv('nitro') : 3, dt);
  if (S.boost > 0.4) S.shake = Math.max(S.shake, 0.07 * S.boost);

  player.position.addScaledVector(fwd, topSpeed() * S.speedMul * (1 + S.boost * boostPow()) * dt);
  player.position.y = clamp(player.position.y, 3, 170);

  pbox.setFromCenterAndSize(player.position, _t.set(4, 2.5, 4));
}

function updateCombat(dt) {
  S.invuln = Math.max(0, S.invuln - dt);
  pivot.visible = S.hp > 0 && (S.invuln <= 0 || Math.floor(S.time * 20) % 2 === 0);

  // shooting
  S.fireCd -= dt;
  if (inp.fire && S.fireCd <= 0) { fireLaser(); S.fireCd = CFG.fireInterval; S.shake = Math.max(S.shake, 0.16); }
  S.comboT = Math.max(0, S.comboT - dt);
  S.shield = Math.max(0, S.shield - dt);
  S.multi = Math.max(0, S.multi - dt);
  S.shieldFlash = Math.max(0, S.shieldFlash - dt * 3);
  shieldMesh.visible = S.cam !== 1 && S.shield > 0 && (S.shield > 2 || Math.floor(S.time * 8) % 2 === 0);
  shieldMesh.material.opacity = 0.22 + S.shieldFlash * 0.6;
  shieldMesh.rotation.y += dt;
  if (S.bossTimer > 0) { S.bossTimer -= dt; if (S.bossTimer <= 0) spawnBoss(); }

  // buildings
  const hit = collideCity();
  if (hit) {
    const p = player.position, cx = hit.cx * CELL, cz = hit.cz * CELL;
    if (p.y > hit.top - 5) p.y = hit.top + 4;
    else if (Math.abs(p.x - cx) > Math.abs(p.z - cz)) p.x = cx + Math.sign(p.x - cx || 1) * (BW / 2 + 4);
    else p.z = cz + Math.sign(p.z - cz || 1) * (BW / 2 + 4);
    S.speedMul = 0.3;
    hurt(15);
    pbox.setFromCenterAndSize(p, _t.set(4, 2.5, 4));
  }

  // lasers
  for (const l of lasers) {
    if (!l.on) continue;
    const p = l.mesh.position;
    p.addScaledVector(l.vel, dt);
    l.life -= dt;
    let dead = l.life <= 0;
    if (!dead && p.y < heightAt(p.x, p.z)) { burst(p, 0xff2e88, 8, 15, 1.5); dead = true; }
    if (!dead) {
      l.box.setFromCenterAndSize(p, _t.set(4, 4, 4));
      for (const e of enemies) {
        e.box.setFromCenterAndSize(e.obj.position, _t.set(7, 5, 7));
        if (l.box.intersectsBox(e.box)) {
          dead = true;
          burst(p, 0x19f3ff, 10, 25, 1.8);
          if (--e.hp <= 0) killEnemy(e, true);
          else { flashEnemy(e); e.vel.addScaledVector(_n.copy(l.vel).normalize(), 16); sfx('tick'); }
          break;
        }
      }
      if (!dead && S.boss && l.box.intersectsBox(S.boss.box)) { dead = true; hitBoss(p); }
    }
    if (dead) { l.on = false; l.mesh.visible = false; }
  }

  updateWaves(dt);
  updateRockets(dt);
  updateBullets(dt);
  updateEnemies(dt);
  updateBoss(dt);
  updateCoins(dt, true);
  updatePowerups(dt, true);
}

function reset() {
  Object.assign(S, { hp: CFG.maxHP, score: 0, coins: 0, kills: 0, yaw: 0, pitch: 0, roll: 0, rollVel: 0, ix: 0, iy: 0, speedMul: 1, invuln: 0, shake: 0, fireCd: 0, spawnTimer: 0, paused: false, combo: 0, comboT: 0,
    boost: 0, boosting: false, nitro: 100, nitroLock: false, nitroDelay: 0, shield: 0, multi: 0, shieldFlash: 0, bossPhase: false, bossTimer: 0,
    rockets: CFG.maxRockets, rocketCd: 0, reloading: false, reloadT: 0, reloadTick: 0, regenT: 0, wave: 0, waveKills: 0, waveSpawned: 0, waveActive: false, waveCleared: false, waveDelay: 0 });
  clearEffects();
  rockets.forEach((r) => { r.on = false; r.mesh.visible = false; });
  removeBoss();
  bullets.forEach((b) => { b.on = false; b.mesh.visible = false; });
  shieldMesh.visible = false;
  $('goal-panel').classList.remove('hidden');
  $('boss').classList.add('hidden');
  $('banner').classList.remove('show');
  player.position.set(0, 55, 80);
  pivot.visible = true;
  [...enemies].forEach(removeEnemy);
  lasers.forEach((l) => { l.on = false; l.mesh.visible = false; });
  initCoins();
  initPowerups();
  player.rotation.set(0, 0, 0);
  updatePlayer(0, false);
  updateCamera(0, true);
}

function startGame(fromWave = 0) {
  initAudio();
  if (AC && AC.state === 'suspended') AC.resume();
  reset();
  S.state = 'playing';
  S.paused = false;
  PANELS.forEach((id) => $(id).classList.add('hidden'));
  if (fromWave >= CFG.waves.length) { S.wave = CFG.waves.length - 1; beginBossIntro(); }   // level select: boss
  else startWave(fromWave);
  document.body.classList.remove('paused', 'menu-open');
  $('menu').classList.add('hidden');
  $('end').classList.add('hidden');
  $('pause').classList.add('hidden');
  $('hud').classList.remove('hidden');
}

/* ---------- Pause ---------- */
function pause() {
  if (S.state !== 'playing' || S.paused) return;
  S.paused = true;
  keys.clear(); touchFire = false; touchBoost = false; touchRocket = false; stick.x = stick.y = 0;
  $('knob').style.transform = '';
  ['fire', 'boost-btn', 'rocket-btn'].forEach((id) => $(id).classList.remove('down'));
  document.body.classList.add('paused', 'menu-open');
  $('pause-bank').textContent = SAVE.bank;
  $('pause').classList.remove('hidden');
  if (AC && AC.state === 'running') AC.suspend();
  $('resume').focus();
}
function resume() {
  if (!S.paused) return;
  S.paused = false;
  document.body.classList.remove('paused', 'menu-open');
  $('pause').classList.add('hidden');
  if (AC && AC.state === 'suspended') AC.resume();
}

function endGame(win) {
  S.state = win ? 'win' : 'over';
  sfx(win ? 'win' : 'lose');
  $('end-title').textContent = t(win ? 'end.win' : 'end.lose');
  $('end-sub').textContent = win ? t('end.sub.win') : S.bossPhase ? t('end.sub.boss') : t('end.sub.wave', { n: S.wave + 1 });
  $('r-score').textContent = S.score;
  $('r-kills').textContent = S.kills;
  $('r-coins').textContent = S.coins;
  setTimeout(() => {
    if (S.state === 'playing') return;
    $('end').classList.remove('hidden');
    $('hud').classList.add('hidden');
    document.body.classList.add('menu-open');
  }, 900);
}

$('start').addEventListener('click', () => startGame(0));
$('restart').addEventListener('click', () => startGame(0));
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'Escape' || e.code === 'KeyP') { if (panelOpen()) closePanel(); else if (S.paused) resume(); else pause(); }
  else if (e.code === 'KeyM') setMuted(!muted);
  else if (e.code === 'KeyC') cycleCam();
  else if (e.code === 'KeyR') startReload();
  else if (e.code === 'Enter' && S.state !== 'playing') startGame();
});
$('pause-btn').addEventListener('click', (e) => { e.currentTarget.blur(); pause(); });
$('resume').addEventListener('click', resume);
$('reload-btn').addEventListener('pointerdown', (e) => { e.preventDefault(); haptic(12); startReload(); });
$('cam-btn').addEventListener('click', (e) => { e.currentTarget.blur(); cycleCam(); });
$('pause-restart').addEventListener('click', () => startGame(0));
$('mute').addEventListener('click', (e) => { setMuted(!muted); e.currentTarget.blur(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
// Rotating the phone drops every finger on the controls, so pause instead of letting the jet fly on blind.
if (isTouch) {
  const mq = matchMedia('(orientation: portrait)'), onRotate = () => pause();
  if (mq.addEventListener) mq.addEventListener('change', onRotate); else if (mq.addListener) mq.addListener(onRotate);
}
// Hybrid laptops / tablets with a mouse: switch the touch layout on the first real finger tap.
addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') document.body.classList.add('touch'); }, { passive: true });

/* =====================================================================
   CAMERA / WORLD / HUD
   ===================================================================== */
/* Camera modes: 0 chase · 1 cockpit · 2 top-down · 3 close (behind the engines) */
const CAMS = ['Chase Cam', 'Cockpit', 'Top-Down', 'Close Cam'];
const CAM_FOV = [0, 10, -5, 12];                       // extra FOV per mode
const CAM_OFFS = [new V3(0, 4, 11), null, null, new V3(0, 1.8, 6.5)];
const CAM_RATE = [8, 0, 6, 14];                        // position follow stiffness
const camQ = new THREE.Quaternion(), camE = new THREE.Euler(0, 0, 0, 'YXZ'), rollQ = new THREE.Quaternion();
const camDesired = new V3(), lookS = new V3(), lookT = new V3(), fwdH = new V3();
const AXIS_Z = new V3(0, 0, 1);
let camSnap = true;

function applyCamMode() {
  const m = S.cam;
  playerEnt.holder.visible = m !== 1;                  // hide the airframe from inside the cockpit
  playerEnt.holder.scale.setScalar(m === 2 ? 2.6 : 1); // bigger model so it reads from high above
  document.body.classList.toggle('cam-cockpit', m === 1);
  document.body.classList.toggle('cam-top', m === 2);
  $('cam-name').textContent = t('cam' + m);
  const badge = $('cam-badge');
  badge.classList.remove('pop'); void badge.offsetWidth; badge.classList.add('pop');
  camSnap = true;
}
function setCam(i) { S.cam = (i + CAMS.length) % CAMS.length; applyCamMode(); }
function cycleCam() { if (S.state === 'playing' && !S.paused) setCam(S.cam + 1); }

function updateCamera(dt, snapArg = false) {
  const snap = snapArg || camSnap;
  camSnap = false;
  const m = S.cam;
  scene.fog.density += ((m === 2 ? 0.0032 : 0.0055) - scene.fog.density) * damp(3, dt);   // clearer view from above
  S.shake = Math.max(0, S.shake - dt * 2);

  if (m === 1) {                                       // cockpit: rigid, at the pilot's eyes, banks with the jet
    camera.position.set(0, 0.7, -1.4).applyQuaternion(player.quaternion).add(player.position);
    rollQ.setFromAxisAngle(AXIS_Z, S.roll * 0.7);   // slightly damped so the cockpit view stays comfortable
    camera.quaternion.copy(player.quaternion).multiply(rollQ);
    if (S.shake > 0) camera.position.add(_t.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(S.shake * 0.5));
  } else if (m === 2) {                                // top-down tactical view, screen-up = flight direction
    fwdH.set(-Math.sin(S.yaw), 0, -Math.cos(S.yaw));
    camDesired.copy(player.position).addScaledVector(fwdH, -30);
    camDesired.y = Math.max(player.position.y + 110, 135);
    lookT.copy(player.position).addScaledVector(fwdH, 30);
    if (snap) { camera.position.copy(camDesired); lookS.copy(lookT); }
    else { camera.position.lerp(camDesired, damp(CAM_RATE[2] + S.boost * 6, dt)); lookS.lerp(lookT, damp(10, dt)); }
    if (S.shake > 0) camera.position.add(_t.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(S.shake * 0.9));
    camera.lookAt(lookS);
  } else {                                             // chase (0) and close (3): offset behind the aircraft
    camE.set(S.pitch * 0.35, S.yaw, 0);
    camQ.setFromEuler(camE);
    camDesired.copy(CAM_OFFS[m]);
    camDesired.z += S.boost * (m === 0 ? 4 : 2.5);
    if (m === 3) camDesired.x += Math.sin(S.time * 0.9) * 0.35;   // slight cinematic sway
    camDesired.applyQuaternion(camQ).add(player.position);
    lookT.copy(fwd).multiplyScalar(m === 0 ? 30 : 25).add(player.position);
    if (snap) { camera.position.copy(camDesired); lookS.copy(lookT); }
    else {
      camera.position.lerp(camDesired, damp(CAM_RATE[m] + S.boost * 10, dt));
      lookS.lerp(lookT, damp(10 + (m === 3 ? 4 : 0), dt));
    }
    camera.position.y = Math.max(camera.position.y, 2);
    if (S.shake > 0) camera.position.add(_t.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(S.shake * 0.9));
    camera.lookAt(lookS);
    camera.rotateZ(S.roll * (m === 0 ? 0.3 : 0.5));
  }

  const fov = camBaseFov + CAM_FOV[m] + S.boost * (m === 1 ? 18 : 22);   // FOV kick while boosting
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
}
applyCamMode();

function updateWorld() {
  const p = player.position;
  updateCity(p);
  ground.position.set(Math.round(p.x / CELL) * CELL, 0, Math.round(p.z / CELL) * CELL);
  starMat.uniforms.uC.value.copy(p);
  streaks.visible = S.boost > 0.02;
  streakMat.uniforms.uC.value.copy(p);
  streakMat.uniforms.uDir.value.copy(fwd);
  streakMat.uniforms.uBoost.value = S.boost;
  const t = S.time;
  neonLights[0].position.set(p.x + Math.cos(t * 0.5) * 70, 45, p.z - 70);
  neonLights[1].position.set(p.x - 60, 25 + Math.sin(t) * 10, p.z + Math.sin(t * 0.4) * 80);
  neonLights[2].position.set(p.x + 50, 70, p.z + Math.cos(t * 0.6) * 90);
}

const hud = { hp: -1, score: -1, coins: -1, kills: -1, wk: -1, wv: -1, rk: -1, rl: -2, nitro: -1, boost: -1, sh: -1, mu: -1, boss: -1 };
const boostBtn = $('boost-btn'), nitroFill = $('nitro-fill'), bossFill = $('boss-fill'), boostFx = $('boost-fx'), puShield = $('pu-shield'), puMulti = $('pu-multi');
const hpFill = $('hp-fill');
function updateHUD() {
  if (hud.hp !== S.hp) {
    hud.hp = S.hp;
    $('hp-val').textContent = Math.ceil(S.hp);
    hpFill.style.width = `${(S.hp / CFG.maxHP) * 100}%`;
    hpFill.className = S.hp < 25 ? 'low' : S.hp < 50 ? 'mid' : '';
  }
  if (hud.score !== S.score) { hud.score = S.score; $('score').textContent = S.score; }
  if (hud.coins !== SAVE.bank) { hud.coins = SAVE.bank; $('coins').textContent = SAVE.bank; }
  const wd = waveDef();
  if (hud.wk !== S.waveKills || hud.wv !== S.wave) {
    hud.wk = S.waveKills; hud.wv = S.wave;
    $('kills').textContent = Math.min(S.waveKills, wd.count);
    $('goal').textContent = wd.count;
    $('wave-label').textContent = `${t('wave')} ${S.wave + 1}`;
  }
  const rl = S.reloading ? Math.round(Math.min(1, S.reloadT / CFG.rocketReload) * 100) : -1;
  if (hud.rk !== S.rockets || hud.rl !== rl) {
    hud.rk = S.rockets; hud.rl = rl;
    $('rocket-label').textContent = rl >= 0 ? t('reloading') : t('rockets');
    $('rockets').textContent = rl >= 0 ? `${rl}%` : `${S.rockets}/${CFG.maxRockets}`;
    $('rockets').classList.toggle('empty', S.rockets === 0 && rl < 0);
    $('reload-bar').classList.toggle('hidden', rl < 0);
    $('reload-fill').style.width = `${Math.max(rl, 0)}%`;
    const rbtn = $('reload-btn');
    rbtn.classList.toggle('busy', rl >= 0);
    rbtn.classList.toggle('alert', S.rockets === 0 && rl < 0);
    rbtn.style.setProperty('--p', Math.max(rl, 0));
    $('rocket-btn').classList.toggle('empty', S.rockets === 0);
  }

  const n = Math.round(S.nitro);
  if (hud.nitro !== n) { hud.nitro = n; nitroFill.style.width = `${n}%`; boostBtn.style.setProperty('--n', n); }
  nitroFill.classList.toggle('lock', S.nitroLock);
  boostBtn.classList.toggle('lock', !!S.nitroLock);
  const bo = Math.round(S.boost * 100) / 100;
  if (hud.boost !== bo) { hud.boost = bo; boostFx.style.opacity = bo; }

  const sh = Math.ceil(S.shield), mu = Math.ceil(S.multi);
  if (hud.sh !== sh) { hud.sh = sh; puShield.classList.toggle('hidden', sh <= 0); puShield.lastElementChild.textContent = `${sh}s`; }
  if (hud.mu !== mu) { hud.mu = mu; puMulti.classList.toggle('hidden', mu <= 0); puMulti.lastElementChild.textContent = `${mu}s`; }

  const bh = S.boss ? Math.round((S.boss.hp / S.boss.max) * 100) : (S.bossPhase ? 100 : -1);
  if (hud.boss !== bh && bh >= 0) { hud.boss = bh; bossFill.style.width = `${bh}%`; }
}

/* =====================================================================
   RADAR — heading-up circular minimap (forward is always "up")
   ===================================================================== */
const radarEl = $('radar'), rg = radarEl.getContext('2d');
const RS = 150, RC = RS / 2, RR = 70, RANGE = 320;     // logical size, centre, radius (px), world range (units)
{
  const dpr = Math.min(devicePixelRatio || 1, 2);
  radarEl.width = radarEl.height = Math.round(RS * dpr);
  rg.scale(dpr, dpr);
}
const rp = { x: 0, y: 0, out: false };
function radarMap(pos) {                                // world -> radar pixels, rotated by player heading
  const dx = pos.x - player.position.x, dz = pos.z - player.position.z;
  const sn = Math.sin(S.yaw), cs = Math.cos(S.yaw);
  const ahead = -dx * sn - dz * cs, right = dx * cs - dz * sn;
  let rx = (right / RANGE) * RR, ry = (-ahead / RANGE) * RR;
  const m = Math.hypot(rx, ry), lim = RR - 4;
  rp.out = m > lim;                                      // off-range targets pin to the rim
  if (rp.out) { rx *= lim / m; ry *= lim / m; }
  rp.x = RC + rx; rp.y = RC + ry;
}
function radarDot(pos, color, r) {
  radarMap(pos);
  rg.globalAlpha = rp.out ? 0.55 : 1;
  rg.fillStyle = color; rg.strokeStyle = color; rg.lineWidth = 1.5;
  rg.beginPath(); rg.arc(rp.x, rp.y, r, 0, TAU); rg.fill();
  const dy = pos.y - player.position.y;                  // small tick: target is well above / below you
  if (Math.abs(dy) > 22) {
    const sgn = dy > 0 ? -1 : 1;
    rg.beginPath(); rg.moveTo(rp.x, rp.y + sgn * (r + 1)); rg.lineTo(rp.x, rp.y + sgn * (r + 5)); rg.stroke();
  }
  rg.globalAlpha = 1;
}
let radarT = 0;
function updateRadar(dt) {
  if (S.state !== 'playing') return;
  radarT += dt;
  if (radarT < 0.033) return;                            // ~30 fps is plenty
  radarT = 0;
  const g = rg;
  g.clearRect(0, 0, RS, RS);
  g.save();
  g.beginPath(); g.arc(RC, RC, RR + 3, 0, TAU); g.clip();

  const bg = g.createRadialGradient(RC, RC, 0, RC, RC, RR);
  bg.addColorStop(0, 'rgba(25,243,255,0.10)'); bg.addColorStop(1, 'rgba(10,6,20,0.55)');
  g.fillStyle = bg; g.fillRect(0, 0, RS, RS);

  g.strokeStyle = 'rgba(25,243,255,0.22)'; g.lineWidth = 1;
  for (const r of [RR / 3, (2 * RR) / 3]) { g.beginPath(); g.arc(RC, RC, r, 0, TAU); g.stroke(); }
  g.beginPath(); g.moveTo(RC, RC - RR); g.lineTo(RC, RC + RR); g.moveTo(RC - RR, RC); g.lineTo(RC + RR, RC); g.stroke();

  // camera field of view wedge (forward = up)
  const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(camBaseFov / 2)) * camera.aspect);
  g.fillStyle = 'rgba(255,46,136,0.10)';
  g.beginPath(); g.moveTo(RC, RC); g.arc(RC, RC, RR, -Math.PI / 2 - half, -Math.PI / 2 + half); g.closePath(); g.fill();

  if (g.createConicGradient) {                           // rotating scanner sweep
    const sw = g.createConicGradient((S.time * 1.6) % TAU, RC, RC);
    sw.addColorStop(0, 'rgba(25,243,255,0)'); sw.addColorStop(0.8, 'rgba(25,243,255,0)'); sw.addColorStop(1, 'rgba(25,243,255,0.28)');
    g.fillStyle = sw; g.fillRect(0, 0, RS, RS);
  }

  // home base
  radarMap(base.position);
  g.globalAlpha = rp.out ? 0.5 : 1; g.strokeStyle = '#19f3ff'; g.lineWidth = 1.5;
  g.strokeRect(rp.x - 3, rp.y - 3, 6, 6); g.globalAlpha = 1;

  for (const c of coins) radarDot(c.obj.position, '#ffc83d', 2.2);

  for (const pw of powerups) {                           // power-ups as diamonds
    if (pw.wait > 0) continue;
    radarMap(pw.obj.position);
    g.save(); g.translate(rp.x, rp.y); g.rotate(Math.PI / 4);
    g.globalAlpha = rp.out ? 0.55 : 1;
    g.fillStyle = pw.type === 'shield' ? '#7ff7ff' : '#ff7ac0';
    g.fillRect(-2.5, -2.5, 5, 5);
    g.restore();
  }

  for (const e of enemies) {                             // red drones; blink when about to dash
    const warn = e.state === 'windup' && Math.floor(S.time * 12) % 2 === 0;
    radarDot(e.obj.position, warn ? '#ffffff' : '#ff3b5c', warn ? 4 : 2.8);
  }
  if (S.boss) {
    radarDot(S.boss.obj.position, '#ff2e88', 6);
    g.strokeStyle = '#ff2e88'; g.lineWidth = 1;
    g.beginPath(); g.arc(rp.x, rp.y, 9 + Math.sin(S.time * 6) * 1.5, 0, TAU); g.stroke();
  }

  // player marker
  g.shadowColor = '#19f3ff'; g.shadowBlur = 8; g.fillStyle = '#19f3ff';
  g.beginPath(); g.moveTo(RC, RC - 6); g.lineTo(RC + 4.5, RC + 5); g.lineTo(RC, RC + 2.5); g.lineTo(RC - 4.5, RC + 5); g.closePath(); g.fill();
  g.shadowBlur = 0;

  g.restore();
  g.strokeStyle = 'rgba(25,243,255,0.65)'; g.lineWidth = 1.5;
  g.beginPath(); g.arc(RC, RC, RR + 1, 0, TAU); g.stroke();
}

/* =====================================================================
   MAIN LOOP
   ===================================================================== */
const clock = new THREE.Clock();
reset();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (S.paused) {                       // frozen frame: no simulation, keep canvas alive
    if (composer) composer.render(); else renderer.render(scene, camera);
    return;
  }
  S.time += dt;
  readInput();

  if (S.state === 'playing') {
    updatePlayer(dt, false);
    updateCombat(dt);
  } else {
    updatePlayer(dt, true);   // autopilot behind the menu / end screens
    updateCoins(dt, false);
    updatePowerups(dt, false);
  }

  updateFx(dt);
  updateRings(dt);
  updateWorld();
  updateCamera(dt);
  updateHUD();
  updateEngineSound();
  updateRadar(dt);

  if (composer) composer.render(); else renderer.render(scene, camera);
});


/* =====================================================================
   PAUSE MENU PANELS — Garage · Level select · Settings · Language
   ===================================================================== */
const PANELS = ['garage', 'levels', 'settings'];
let panelFrom = 'pause';
const panelOpen = () => PANELS.find((id) => !$(id).classList.contains('hidden')) || null;
const focusFirst = (id) => { const b = $(id).querySelector('button:not([disabled])'); if (b) b.focus({ preventScroll: true }); };
function openPanel(id, from) {
  panelFrom = from;
  $(from).classList.add('hidden');
  $(id).classList.remove('hidden');
  renderPanel(id);
  focusFirst(id);
}
function closePanel() {
  if (!panelOpen()) return;
  PANELS.forEach((id) => $(id).classList.add('hidden'));
  $(panelFrom).classList.remove('hidden');
  $('pause-bank').textContent = SAVE.bank;
  focusFirst(panelFrom);
}
function renderPanel(id = panelOpen()) {
  if (id === 'garage') renderGarage(); else if (id === 'levels') renderLevels(); else if (id === 'settings') renderSettings();
}

/* ---- Garage ---- */
let gTimer = 0;
function gMsg(text, bad) {
  const el = $('g-msg');
  el.textContent = text; el.classList.toggle('bad', !!bad);
  clearTimeout(gTimer); gTimer = setTimeout(() => { el.textContent = ''; }, 2200);
}
function renderGarage() {
  $('g-bank').textContent = SAVE.bank;
  $('g-paints').innerHTML = PAINTS.map((p) => {
    const owned = SAVE.owned.includes(p.id), on = SAVE.paint === p.id;
    const note = on ? t('g.equipped') : owned ? t('g.equip') : `◆ ${p.cost}`;
    return `<button type="button" class="swatch${on ? ' on' : ''}${owned ? '' : ' locked'}" data-paint="${p.id}" style="--c:${p.css}" aria-pressed="${on}"><i></i><span>${t('paint.' + p.id)}</span><em>${note}</em></button>`;
  }).join('');
  $('g-upgrades').innerHTML = UPGRADES.map((u) => {
    const l = lv(u.id), max = l >= MAX_LV, cost = u.cost[l];
    const pips = Array.from({ length: MAX_LV }, (_, i) => `<b class="${i < l ? 'f' : ''}"></b>`).join('');
    const poor = !max && SAVE.bank < cost;
    return `<div class="upg"><div class="uh"><strong>${t('u.' + u.id)}</strong><small>${t('g.level')} ${l}/${MAX_LV}</small></div><p>${t('u.' + u.id + '.d')}</p><div class="pips">${pips}</div><button type="button" class="btn small${max ? ' ghost' : ''}${poor ? ' poor' : ''}" data-up="${u.id}"${max ? ' disabled' : ''}>${max ? t('g.max') : '◆ ' + cost}</button></div>`;
  }).join('');
}
$('garage').addEventListener('click', (e) => {
  const sw = e.target.closest('[data-paint]'), up = e.target.closest('[data-up]');
  if (sw) {
    const p = PAINTS.find((x) => x.id === sw.dataset.paint);
    if (!p) return;
    if (!SAVE.owned.includes(p.id)) {
      if (SAVE.bank < p.cost) { sfx('dry'); gMsg(t('g.poor'), true); return; }
      SAVE.bank -= p.cost; SAVE.owned.push(p.id); sfx('coin');
      gMsg(t('g.bought', { n: t('paint.' + p.id) }));
    } else sfx('tick');
    SAVE.paint = p.id; applyPaint(playerEnt); saveNow(); haptic(10); renderGarage();
  } else if (up) {
    const u = UPGRADES.find((x) => x.id === up.dataset.up);
    if (!u) return;
    const l = lv(u.id);
    if (l >= MAX_LV) return;
    if (SAVE.bank < u.cost[l]) { sfx('dry'); gMsg(t('g.poor'), true); return; }
    SAVE.bank -= u.cost[l]; SAVE.lv[u.id] = l + 1; saveNow(); sfx('power'); haptic(14);
    gMsg(t('g.upgraded', { n: t('u.' + u.id), l: l + 1 }));
    renderGarage();
  }
});

/* ---- Level select ---- */
function renderLevels() {
  const total = CFG.waves.length + 1;
  $('l-list').innerHTML = Array.from({ length: total }, (_, i) => {
    const boss = i >= CFG.waves.length, open = i <= SAVE.bestWave;
    const name = boss ? t('boss') : `${t('wave')} ${i + 1}`;
    const sub = !open ? t('l.locked') : boss ? t('boss.sub') : t('l.drones', { c: CFG.waves[i].count });
    return `<button type="button" class="lvl${open ? '' : ' locked'}" data-lvl="${i}"${open ? '' : ' disabled'}><b>${String(i + 1).padStart(2, '0')}</b><span><strong>${name}</strong><small>${sub}</small></span></button>`;
  }).join('');
}
$('levels').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lvl]');
  if (b && !b.disabled) startGame(Number(b.dataset.lvl));
});

/* ---- Settings ---- */
let resetArmed = 0;
function renderSettings() {
  $('s-lang').innerHTML = LANGS.map((l) => `<button type="button" class="${SAVE.lang === l.id ? 'on' : ''}" data-lang="${l.id}" aria-pressed="${SAVE.lang === l.id}">${l.label}</button>`).join('');
  $('mute').textContent = muteLabel();
  $('s-vib').textContent = t(SAVE.vibrate ? 'on' : 'off');
  $('s-vib-row').classList.toggle('hidden', !('vibrate' in navigator));
  $('s-reset').textContent = resetArmed ? t('s.confirm') : t('s.reset');
}
$('s-lang').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lang]');
  if (!b) return;
  SAVE.lang = b.dataset.lang; SAVE.langChosen = true; saveNow(); applyLang();
});
$('s-vib').addEventListener('click', () => { SAVE.vibrate = !SAVE.vibrate; saveNow(); haptic(15); renderSettings(); });
$('s-reset').addEventListener('click', () => {
  if (!resetArmed) { resetArmed = setTimeout(() => { resetArmed = 0; if (panelOpen() === 'settings') renderSettings(); }, 3000); renderSettings(); return; }
  clearTimeout(resetArmed); resetArmed = 0;
  const keep = { lang: SAVE.lang, langChosen: SAVE.langChosen, muted: SAVE.muted, vibrate: SAVE.vibrate };
  SAVE = Object.assign(defaultSave(), keep);
  saveNow(); applyPaint(playerEnt); hud.coins = -99; renderSettings();
  $('s-note').textContent = t('s.done');
  setTimeout(() => { $('s-note').textContent = ''; }, 2200);
});

/* ---- Navigation buttons ---- */
const nav = (btn, id, from) => $(btn).addEventListener('click', () => openPanel(id, from));
nav('pause-garage', 'garage', 'pause'); nav('pause-levels', 'levels', 'pause'); nav('pause-settings', 'settings', 'pause');
nav('menu-garage', 'garage', 'menu'); nav('menu-settings', 'settings', 'menu'); nav('end-garage', 'garage', 'end');
PANELS.forEach((id) => $(`${id}-back`).addEventListener('click', closePanel));

/* ---- Language ---- */
function applyLang() {
  document.documentElement.lang = SAVE.lang;
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    let key = el.dataset.i18n;
    if (key.startsWith('cx.')) key = (isTouch ? 'cm.' : 'cd.') + key.slice(3);
    el.textContent = t(key);
  });
  $('cam-name').textContent = t('cam' + S.cam);
  $('mute').textContent = muteLabel();
  for (const k of Object.keys(hud)) hud[k] = -99;            // force the HUD to redraw its labels
  if (panelOpen()) renderPanel();
}
applyLang();