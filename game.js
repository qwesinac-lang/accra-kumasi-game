// Accra -> Kumasi bus: the STC Coach on the shortened N6, in the browser.
// Driving model and camera follow the Blender controller (stc_arrow_drive_road.py): same throttle,
// brake, jerk and steering feel, bicycle model on the rear axle, Ackermann front wheels, and a chase
// camera you orbit with the mouse that swings back behind the bus by itself.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const $ = (id) => document.getElementById(id);
const WHEELBASE = 7.73, TRACK = 2.32, FRONT_X = 3.88, REAR_X = -3.85, LAT = 1.16, WHEEL_R = 0.66;
const MOUSE_SENS = 0.0025;          // radians per pixel
const MAX_FORWARD_SPEED = 200 / 3.6; // 200 km/h, converted to metres per second
const RECENTER_AFTER = 1.0;         // seconds without mouse movement before the camera returns behind the bus
const CAM_MIN_H = 1.2;              // metres the camera keeps above the ground
const SIDE = -2.8;                  // chase camera sits a little to the right of the bus
const KEYS = { ArrowUp: 'UP', KeyW: 'UP', ArrowDown: 'DOWN', KeyS: 'DOWN', ArrowLeft: 'LEFT', KeyA: 'LEFT',
  ArrowRight: 'RIGHT', KeyD: 'RIGHT', Space: 'BRAKE' };
// phones and tablets get the on-screen console; add ?mobile to the address to force it on a computer
const TOUCH = matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('mobile');
const LAYERS = ['road', 'terrain', 'town', 'trees', ...(TOUCH ? [] : ['trees_far']), 'bus'];
if (TOUCH) document.body.classList.add('touch');

// Blender (x east, y north, z up) -> three.js (x, y up, z south)
const v3 = (bx, by, bz) => new THREE.Vector3(bx, bz, -by);
const wrap = (a) => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ease = (dt, rate) => 1 - Math.exp(-dt * rate);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- renderer, sky, light
const renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, TOUCH ? 1.25 : 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const SKY = new THREE.Color('#a9cbea');
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 450, TOUCH ? 1600 : 2600);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.3, 4000);
scene.add(new THREE.HemisphereLight(0xe4f1ff, 0x5d5136, 1.35));
const sun = new THREE.DirectionalLight(0xfff3dc, 2.4);
const SUN_DIR = new THREE.Vector3(-0.45, 0.78, 0.43).normalize();
sun.castShadow = true;
sun.shadow.mapSize.set(TOUCH ? 1024 : 2048, TOUCH ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, near: 10, far: 700 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.5;
scene.add(sun, sun.target);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- ground heights (vertical ray casts)
class HeightGrid {
  constructor(meshes, cell = 16) {
    let n = 0;
    for (const m of meshes) n += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    const T = new Float32Array(n * 9);
    const v = new THREE.Vector3();
    let k = 0;
    for (const m of meshes) {
      m.updateWorldMatrix(true, false);
      const pos = m.geometry.attributes.position, idx = m.geometry.index;
      const cnt = idx ? idx.count : pos.count;
      for (let i = 0; i < cnt; i++) {
        v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld);
        T[k++] = v.x; T[k++] = v.y; T[k++] = v.z;
      }
    }
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < T.length; i += 3) {
      x0 = Math.min(x0, T[i]); x1 = Math.max(x1, T[i]); z0 = Math.min(z0, T[i + 2]); z1 = Math.max(z1, T[i + 2]);
    }
    Object.assign(this, { T, cell, x0, z0, nx: Math.ceil((x1 - x0) / cell) + 1, nz: Math.ceil((z1 - z0) / cell) + 1 });
    const cells = (t, fn) => {
      const o = t * 9;
      const ax = Math.floor((Math.min(T[o], T[o + 3], T[o + 6]) - x0) / cell);
      const bx = Math.floor((Math.max(T[o], T[o + 3], T[o + 6]) - x0) / cell);
      const az = Math.floor((Math.min(T[o + 2], T[o + 5], T[o + 8]) - z0) / cell);
      const bz = Math.floor((Math.max(T[o + 2], T[o + 5], T[o + 8]) - z0) / cell);
      for (let cz = az; cz <= bz; cz++) for (let cx = ax; cx <= bx; cx++) fn(cz * this.nx + cx);
    };
    const start = new Uint32Array(this.nx * this.nz + 1);
    for (let t = 0; t < n; t++) cells(t, (c) => start[c + 1]++);
    for (let c = 0; c < this.nx * this.nz; c++) start[c + 1] += start[c];
    const fill = start.slice(0, -1);
    const ids = new Uint32Array(start[start.length - 1]);
    for (let t = 0; t < n; t++) cells(t, (c) => { ids[fill[c]++] = t; });
    Object.assign(this, { start, ids });
  }

  height(x, z) {               // highest surface under (x, z), or null off the map
    const cx = Math.floor((x - this.x0) / this.cell), cz = Math.floor((z - this.z0) / this.cell);
    if (cx < 0 || cz < 0 || cx >= this.nx || cz >= this.nz) return null;
    const c = cz * this.nx + cx, T = this.T;
    let best = -Infinity;
    for (let p = this.start[c]; p < this.start[c + 1]; p++) {
      const o = this.ids[p] * 9;
      const ax = T[o], az = T[o + 2], bx = T[o + 3], bz = T[o + 5], qx = T[o + 6], qz = T[o + 8];
      const d = (bz - qz) * (ax - qx) + (qx - bx) * (az - qz);
      if (Math.abs(d) < 1e-9) continue;
      const a = ((bz - qz) * (x - qx) + (qx - bx) * (z - qz)) / d;
      const b = ((qz - az) * (x - qx) + (ax - qx) * (z - qz)) / d;
      const g = 1 - a - b;
      if (a < -1e-5 || b < -1e-5 || g < -1e-5) continue;
      const y = a * T[o + 1] + b * T[o + 4] + g * T[o + 7];
      if (y > best) best = y;
    }
    return best === -Infinity ? null : best;
  }
}

// ---------------------------------------------------------------- loading
const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/');
const loader = new GLTFLoader().setDRACOLoader(draco);
let grid, route, busNodes, lane, stops, towns, spawns;

async function load() {
  const manifest = await (await fetch('assets/manifest.json')).json();
  route = await (await fetch('assets/route.json')).json();
  const total = LAYERS.reduce((a, name) => a + (manifest.files[`${name}.glb`] || 0), 0);
  const got = {};
  const progress = () => {
    const sum = Object.values(got).reduce((a, b) => a + b, 0);
    $('loadbar').style.width = `${Math.min(100, (sum / total) * 100).toFixed(0)}%`;
    $('loadtxt').textContent = `Loading the road… ${(sum / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`;
  };
  const layers = {};
  await Promise.all(LAYERS.map(async (name) => {
    const gltf = await loader.loadAsync(`assets/${name}.glb`, (e) => { got[name] = e.loaded; progress(); });
    layers[name] = gltf.scene;
  }));
  $('loadtxt').textContent = 'Preparing the road surface…';
  await new Promise((r) => setTimeout(r, 30));

  const ground = [];
  for (const [name, root] of Object.entries(layers)) {
    scene.add(root);
    root.traverse((o) => {
      if (!o.isMesh) return;
      const chain = `${o.name}|${o.parent?.name}|${o.parent?.parent?.name}`;
      const isBus = name === 'bus';
      o.castShadow = isBus || name === 'town' || name === 'trees';
      o.receiveShadow = name !== 'trees_far';
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (isBus && /glazing|glass/i.test(m.name)) {          // the web model loses Blender's glass: make it see-through
          Object.assign(m, { transparent: true, opacity: 0.32, depthWrite: false, roughness: 0.05, metalness: 0.1 });
        }
        if (/^Line_|Markings/.test(m.name) || /Markings/.test(chain)) {
          m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
        }
      }
      if ((name === 'road' || name === 'terrain') && /(^|\|)(Road_\d|Road_Furniture|Terminals|Terrain_)/.test(chain)) ground.push(o);
      if (!isBus) { o.matrixAutoUpdate = false; o.updateMatrix(); }
    });
  }
  grid = new HeightGrid(ground);

  const bus = layers.bus;
  const node = (n) => bus.getObjectByName(n);
  busNodes = { root: node('BusRoot'), body: node('BusBody'),
    steer: { FL: node('Steer_FL'), FR: node('Steer_FR') },
    wheel: { FL: node('Wheel_FL'), FR: node('Wheel_FR'), RL: node('Wheel_RL'), RR: node('Wheel_RR') } };
  busNodes.bodyRest = busNodes.body.position.clone();

  lane = route.lanes.to_kumasi;
  stops = route.stops.filter((s) => s.direction === 'to_kumasi').sort((a, b) => a.s_m - b.s_m);
  towns = route.towns;
  spawns = Object.fromEntries(route.spawns.map((s) => [s.name.includes('Accra') ? 'accra' : 'kumasi', s]));
  buildRouteBar();
  resetTrip();
  $('loadbar').style.width = '100%';
  $('loadtxt').textContent = 'Ready.';
  $('play').disabled = false;
  $('play').textContent = 'Start driving';
}

// ---------------------------------------------------------------- bus state + driving model
const bus = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, speed: 0, angle: 0, throttle: 0, acceleration: 0,
  brake: 0, bodyRoll: 0, bodyPitch: 0, spin: { FL: 0, FR: 0, RL: 0, RR: 0 } };
const keys = new Set();
const touch = { steer: 0, gas: false, reverse: false };     // mobile console state
const WHEEL_POS = [['FL', FRONT_X, TRACK / 2], ['FR', FRONT_X, -TRACK / 2], ['RL', REAR_X, TRACK / 2], ['RR', REAR_X, -TRACK / 2]];

function groundPose(x, y, yaw, hint) {
  const c = Math.cos(yaw), s = Math.sin(yaw), h = {};
  for (const [k, lx, ly] of WHEEL_POS) {
    const g = grid.height(x + lx * c - ly * s, -(y + lx * s + ly * c));
    if (g === null || (hint !== undefined && g > hint + 3.0)) return null;   // off the map or a wall-like step
    h[k] = g;
  }
  const front = (h.FL + h.FR) / 2, rear = (h.RL + h.RR) / 2, left = (h.FL + h.RL) / 2, right = (h.FR + h.RR) / 2;
  return { z: rear + (front - rear) * -REAR_X / (FRONT_X - REAR_X),
    pitch: -Math.atan2(front - rear, WHEELBASE), roll: Math.atan2(left - right, TRACK) };
}

function placeBus(x, y, yaw) {
  Object.assign(bus, { x, y, yaw, speed: 0, angle: 0, throttle: 0, acceleration: 0, brake: 0 });
  const p = groundPose(x, y, yaw);
  if (p) Object.assign(bus, { z: p.z, pitch: p.pitch, roll: p.roll });
}

function drive(dt) {
  const demand = (keys.has('UP') ? 1 : 0) - (keys.has('DOWN') ? 1 : 0);
  const opposing = demand * bus.speed < -0.1;
  const brakeTarget = keys.has('BRAKE') ? 1.0 : opposing ? 0.75 : 0.0;
  bus.brake += (brakeTarget - bus.brake) * ease(dt, 4);
  const wanted = brakeTarget ? 0.0 : demand;
  bus.throttle += (wanted - bus.throttle) * ease(dt, 1.5);
  const engine = bus.throttle * 3.0 / (1 + (Math.abs(bus.speed) / 55) ** 2);
  const resistance = Math.abs(bus.speed) > 0.02 ? Math.sign(bus.speed) * (0.08 + 0.00025 * bus.speed * bus.speed) : 0;
  const braking = Math.abs(bus.speed) > 0.01 ? Math.sign(bus.speed) * bus.brake * 2.6 : 0;
  const grade = Math.abs(bus.speed) > 0.3 ? -9.81 * Math.sin(bus.pitch) * 0.35 : 0;   // hills
  const desired = engine - resistance - braking - grade;
  const jerk = bus.brake > 0.1 ? 2.2 : 1.1;
  bus.acceleration += clamp(desired - bus.acceleration, -jerk * dt, jerk * dt);
  const before = bus.speed;
  bus.speed = clamp(bus.speed + bus.acceleration * dt, -2.5, MAX_FORWARD_SPEED);
  if ((bus.brake > 0.1 && before * bus.speed < 0) || (brakeTarget && Math.abs(bus.speed) < 0.04)) {
    bus.speed = 0; bus.acceleration = 0;
  }
  const limit = (30 * Math.PI / 180) / (1 + Math.abs(bus.speed) / 12);
  const steerInput = clamp((keys.has('LEFT') ? 1 : 0) - (keys.has('RIGHT') ? 1 : 0) + touch.steer, -1, 1);
  const target = limit * steerInput;
  const change = (target - bus.angle) * ease(dt, 2.2);
  const maxRate = 18 * Math.PI / 180 * dt;
  bus.angle += clamp(change, -maxRate, maxRate);

  let yaw = bus.yaw;
  let rx = bus.x - 3.85 * Math.cos(yaw), ry = bus.y - 3.85 * Math.sin(yaw);
  const omega = bus.speed * Math.tan(bus.angle) / WHEELBASE;
  rx += bus.speed * Math.cos(yaw + omega * dt / 2) * dt;
  ry += bus.speed * Math.sin(yaw + omega * dt / 2) * dt;
  yaw += omega * dt;
  const nx = rx + 3.85 * Math.cos(yaw), ny = ry + 3.85 * Math.sin(yaw);
  const pose = groundPose(nx, ny, yaw, bus.z);
  if (pose) {
    Object.assign(bus, { x: nx, y: ny, yaw });
    const f = ease(dt, 14);
    bus.z += (pose.z - bus.z) * f;
    bus.pitch += (pose.pitch - bus.pitch) * f;
    bus.roll += (pose.roll - bus.roll) * f;
  } else {
    bus.speed = 0; bus.acceleration = 0;      // edge of the world
  }
  for (const [k] of WHEEL_POS) {
    const lateral = k.endsWith('L') ? LAT : -LAT, longitudinal = k.startsWith('F') ? WHEELBASE : 0;
    bus.spin[k] += Math.sign(bus.speed) * Math.hypot(bus.speed - omega * lateral, omega * longitudinal) * dt / WHEEL_R;
  }
  bus.bodyRoll += (clamp(-bus.speed * omega * 0.009, -0.052, 0.052) - bus.bodyRoll) * ease(dt, 3);
  bus.bodyPitch += (clamp(-bus.acceleration * 0.010, -0.025, 0.025) - bus.bodyPitch) * ease(dt, 3);
}

const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qc = new THREE.Quaternion();
function poseBus() {
  const n = busNodes;
  n.root.position.copy(v3(bus.x, bus.y, bus.z));
  // Blender rotations (yaw about Z, pitch about Y, roll about X) in three.js axes
  n.root.quaternion.copy(qa.setFromAxisAngle(AY, bus.yaw))
    .multiply(qb.setFromAxisAngle(AZ, -bus.pitch)).multiply(qc.setFromAxisAngle(AX, bus.roll));
  n.body.quaternion.copy(qa.setFromAxisAngle(AZ, -bus.bodyPitch)).multiply(qb.setFromAxisAngle(AX, bus.bodyRoll));
  const t = Math.tan(bus.angle);
  for (const [k, lateral] of [['FL', LAT], ['FR', -LAT]]) {
    n.steer[k].quaternion.setFromAxisAngle(AY, Math.atan(WHEELBASE * t / (WHEELBASE - lateral * t)));
  }
  for (const k of ['FL', 'FR', 'RL', 'RR']) n.wheel[k].quaternion.setFromAxisAngle(AZ, -bus.spin[k]);
}

// ---------------------------------------------------------------- camera: chase (mouse orbit) or driver seat
const cam = { mode: 'chase', pos: new THREE.Vector3(), vel: new THREE.Vector3(), aim: new THREE.Vector3(),
  aimVel: new THREE.Vector3(), heading: 0, orbit: 0, elev0: Math.atan2(6.4, 15), elev: Math.atan2(6.4, 15),
  dist: Math.hypot(15, 6.4), lastMouse: -1e9, look: 0, lookUp: 0 };

function snapCamera() {
  const p = v3(bus.x, bus.y, bus.z);
  cam.pos.copy(p); cam.vel.set(0, 0, 0); cam.aim.copy(p).y += 1.8; cam.aimVel.set(0, 0, 0);
  cam.heading = bus.yaw; cam.orbit = 0; cam.elev = cam.elev0;
}

function look(dx, dy) {
  cam.lastMouse = performance.now() / 1000;
  if (cam.mode === 'chase') {
    cam.orbit = wrap(cam.orbit - dx * MOUSE_SENS);
    cam.elev = clamp(cam.elev + dy * MOUSE_SENS, 0.03, 1.3);
  } else {
    cam.look = clamp(cam.look - dx * MOUSE_SENS, -1.9, 1.9);
    cam.lookUp = clamp(cam.lookUp - dy * MOUSE_SENS, -0.6, 0.5);
  }
}

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
function updateCamera(dt, now) {
  const idle = now - cam.lastMouse > RECENTER_AFTER;
  if (cam.mode === 'driver') {
    if (idle) { const k = ease(dt, 2.5); cam.look -= cam.look * k; cam.lookUp -= cam.lookUp * k; }
    const root = busNodes.root;
    root.updateMatrixWorld();
    // driver's seat: front left (traffic drives on the right), eyes above the dashboard
    camera.position.copy(root.localToWorld(tmp.set(4.7, 2.95, -0.62)));
    const d = 30;
    camera.lookAt(root.localToWorld(tmp2.set(4.7 + d * Math.cos(cam.look) * Math.cos(cam.lookUp),
      2.95 - 1.2 + d * Math.sin(cam.lookUp), -0.62 - d * Math.sin(cam.look) * Math.cos(cam.lookUp))));
    return;
  }
  cam.heading += wrap(bus.yaw - cam.heading) * ease(dt, 2.4);
  if (idle) {
    const k = ease(dt, 0.9 + 0.12 * Math.abs(bus.speed));
    cam.orbit -= cam.orbit * k;
    cam.elev += (cam.elev0 - cam.elev) * k;
  }
  const target = v3(bus.x, bus.y, bus.z);
  cam.vel.addScaledVector(tmp.subVectors(target, cam.pos), 16 * dt).addScaledVector(cam.vel, -8 * dt);
  cam.pos.addScaledVector(cam.vel, dt);
  const h = cam.heading + cam.orbit;
  const fwd = tmp.set(Math.cos(h), 0, -Math.sin(h)), left = tmp2.set(-Math.sin(h), 0, -Math.cos(h));
  const p = cam.pos.clone().addScaledVector(fwd, -cam.dist * Math.cos(cam.elev)).addScaledVector(left, SIDE);
  p.y += cam.dist * Math.sin(cam.elev);
  const g = grid.height(p.x, p.z);
  if (g !== null && p.y < g + CAM_MIN_H) p.y = g + CAM_MIN_H;
  camera.position.copy(p);
  const ahead = 1 + Math.max(0, bus.speed) * 0.18;
  const aimWanted = v3(bus.x + ahead * Math.cos(bus.yaw), bus.y + ahead * Math.sin(bus.yaw), bus.z + 1.8);
  cam.aimVel.addScaledVector(aimWanted.sub(cam.aim), 36 * dt).addScaledVector(cam.aimVel, -12 * dt);
  cam.aim.addScaledVector(cam.aimVel, dt);
  camera.lookAt(cam.aim);
}

// ---------------------------------------------------------------- trip: route progress, stops, towns
const trip = { started: false, time: 0, li: 0, s: 0, next: 0, dwell: 0, done: false, served: 0, missed: 0,
  welcomed: new Set(), state: [] };

function resetTrip() {
  const sp = spawns.accra, yaw = Math.atan2(sp.heading[1], sp.heading[0]);
  // start at the terminal exit so the chase camera isn't above the canopy roof
  placeBus(sp.pos[0] + 10 * Math.cos(yaw), sp.pos[1] + 10 * Math.sin(yaw), yaw);
  Object.assign(trip, { started: false, time: 0, li: 0, s: 0, next: 0, dwell: 0, done: false, served: 0, missed: 0 });
  trip.welcomed = new Set(['Accra']);
  trip.state = stops.map(() => '');
  for (const k of Object.keys(bus.spin)) bus.spin[k] = 0;
  snapCamera();
  updateRouteBar();
}

function routeProgress() {
  let best = trip.li, bd = Infinity;
  const scan = (a, b) => {
    for (let i = Math.max(0, a); i < Math.min(lane.length, b); i++) {
      const dx = lane[i][0] - bus.x, dy = lane[i][1] - bus.y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
  };
  scan(trip.li - 40, trip.li + 40);
  if (bd > 80 * 80) scan(0, lane.length);
  trip.li = best;
  trip.s = -15 + 5 * best;
  return Math.sqrt(bd);
}

function backOnRoad() {
  routeProgress();
  const i = clamp(trip.li, 1, lane.length - 2);
  const a = lane[i - 1], b = lane[i + 1];
  placeBus(lane[i][0], lane[i][1], Math.atan2(b[1] - a[1], b[0] - a[0]));
  snapCamera();
  toast('Back on the road');
}

let toastTimer = 0;
function toast(text, sub = '') {
  $('toast').innerHTML = text + (sub ? `<small>${sub}</small>` : '');
  $('toast').style.opacity = 1;
  toastTimer = 3.2;
}

function updateTrip(dt) {
  if (!trip.started && Math.abs(bus.speed) > 0.3) trip.started = true;
  if (trip.started && !trip.done) trip.time += dt;
  routeProgress();
  for (const t of towns) {
    if (!trip.welcomed.has(t.name) && trip.s > t.s_m - 180 && trip.s < t.s_m + 150) {
      trip.welcomed.add(t.name);
      toast(t.name === 'Kumasi' ? 'Welcome to Kumasi' : `Welcome to ${t.name}`, `${t.real_km} km from Accra on the real N6`);
    }
  }
  const st = stops[trip.next];
  const stopped = Math.abs(bus.speed) < 0.7;
  if (st) {
    const d = Math.hypot(st.pos[0] - bus.x, st.pos[1] - bus.y);
    if (d < 15 && stopped) {
      trip.dwell += dt;
      if (trip.dwell > 0.2 && trip.dwell - dt <= 0.2) toast(`${st.name} bus stop`, 'Passengers boarding…');
      if (trip.dwell > 2.5) {
        trip.state[trip.next] = 'served'; trip.served++; trip.next++; trip.dwell = 0;
        toast(`Passengers on board at ${st.name}`, stops[trip.next] ? `Next stop: ${stops[trip.next].name}` : 'Next stop: Kumasi terminal');
      }
    } else trip.dwell = 0;
    if (trip.s > st.s_m + 70) {
      trip.state[trip.next] = 'missed'; trip.missed++; trip.next++; trip.dwell = 0;
      toast(`Missed the ${st.name} stop`, 'Stop at the blue shelter in the lay-by');
    }
  } else if (!trip.done) {
    const k = spawns.kumasi;
    if (Math.hypot(k.pos[0] - bus.x, k.pos[1] - bus.y) < 35 && stopped && trip.s > route.length_m - 60) {
      trip.dwell += dt;
      if (trip.dwell > 1.5) finish();
    } else trip.dwell = 0;
  }
}

function finish() {
  trip.done = true;
  document.exitPointerLock?.();
  $('card').innerHTML = `<div class="flag"><i></i><i></i><i></i></div>
    <h1>Arrived in <span>Kumasi</span></h1>
    <div class="tag">Accra → Kumasi in ${fmtTime(trip.time)} · ${trip.served} of ${stops.length} stops served${trip.missed ? ` · ${trip.missed} missed` : ''}</div>
    <button id="play">Drive again</button>`;
  $('overlay').style.display = 'flex';
  $('play').onclick = () => { resetTrip(); start(); };
}

// ---------------------------------------------------------------- HUD
function buildRouteBar() {
  const track = $('track');
  for (const st of stops) {
    const d = document.createElement('div');
    d.className = 'tick';
    d.style.left = `${(st.s_m / route.length_m) * 100}%`;
    d.title = st.name;
    track.appendChild(d);
    st.el = d;
  }
}

function updateRouteBar() {
  const f = clamp(trip.s / route.length_m, 0, 1) * 100;
  $('fill').style.width = `${f}%`;
  $('me').style.left = `${f}%`;
  stops.forEach((st, i) => { st.el.className = `tick ${trip.state[i]}`; });
}

let hudTimer = 0;
function updateHud(dt) {
  hudTimer -= dt;
  if (toastTimer > 0 && (toastTimer -= dt) <= 0) $('toast').style.opacity = 0;
  if (hudTimer > 0) return;
  hudTimer = 0.1;
  $('kmh').textContent = Math.round(Math.abs(bus.speed) * 3.6);
  const rev = bus.speed < -0.1 || (keys.has('DOWN') && Math.abs(bus.speed) < 0.1);
  $('gear').textContent = rev ? 'R' : 'D';
  $('gear').className = `gear${rev ? ' r' : ''}`;
  $('time').textContent = fmtTime(trip.time);
  const here = [...towns].reverse().find((t) => trip.s >= t.s_m - 180);
  $('place').textContent = here ? `${here.name} · ${here.real_km} km` : 'Accra';
  const st = stops[trip.next];
  if (st) {
    $('stopname').textContent = st.name;
    const along = st.s_m - trip.s;
    $('stopdist').textContent = along > 30 ? `${Math.round(along)} m` : 'Stop at the shelter on the right';
  } else {
    $('stopname').textContent = trip.done ? 'Arrived' : 'Kumasi terminal';
    $('stopdist').textContent = trip.done ? '' : `${Math.max(0, Math.round(route.length_m - trip.s))} m`;
  }
  $('stopcount').textContent = `${trip.served} served · ${trip.missed} missed · ${stops.length} stops`;
  $('progtxt').textContent = `${(Math.max(0, trip.s) / 1000).toFixed(1)} / ${(route.length_m / 1000).toFixed(1)} km`;
  updateRouteBar();
}

// ---------------------------------------------------------------- engine sound
let audio = null, muted = false;
function startAudio() {
  if (audio) return;
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator(), osc2 = ctx.createOscillator(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    osc.type = 'sawtooth'; osc2.type = 'square'; filter.type = 'lowpass'; filter.frequency.value = 420; gain.gain.value = 0;
    osc.connect(filter); osc2.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc2.start();
    audio = { ctx, osc, osc2, filter, gain };
  } catch (e) { audio = null; }
}
function updateAudio() {
  if (!audio) return;
  const t = audio.ctx.currentTime, rev = 38 + Math.abs(bus.speed) * 3.2 + bus.throttle * 14;
  audio.osc.frequency.setTargetAtTime(rev, t, 0.1);
  audio.osc2.frequency.setTargetAtTime(rev * 0.5, t, 0.1);
  audio.gain.gain.setTargetAtTime(muted ? 0 : 0.035 + 0.03 * Math.abs(bus.throttle), t, 0.1);
}

// ---------------------------------------------------------------- input
addEventListener('keydown', (e) => {
  if (KEYS[e.code]) { keys.add(KEYS[e.code]); e.preventDefault(); return; }
  if (e.repeat) return;
  if (e.code === 'KeyC') { cam.orbit = 0; cam.elev = cam.elev0; cam.look = 0; cam.lookUp = 0; }
  if (e.code === 'KeyV') { cam.mode = cam.mode === 'chase' ? 'driver' : 'chase'; if (cam.mode === 'chase') snapCamera(); }
  if (e.code === 'KeyR' && grid) backOnRoad();
  if (e.code === 'KeyM') muted = !muted;
});
addEventListener('keyup', (e) => { if (KEYS[e.code]) keys.delete(KEYS[e.code]); });
addEventListener('blur', () => keys.clear());

const canvas = $('c');
let dragging = false;
const lockMouse = () => { try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch (e) { /* drag to look instead */ } };
canvas.addEventListener('click', () => {
  if (!TOUCH && playing && document.pointerLockElement !== canvas) lockMouse();
});
document.addEventListener('pointerlockchange', () => {
  $('hint').style.display = playing && !TOUCH && document.pointerLockElement !== canvas ? 'block' : 'none';
});
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas || dragging) look(e.movementX, e.movementY);
});
canvas.addEventListener('pointerdown', (e) => { if (document.pointerLockElement !== canvas) { dragging = true; canvas.setPointerCapture(e.pointerId); } });
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointercancel', () => { dragging = false; });
let lastTouch = null;
canvas.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (lastTouch) look((t.clientX - lastTouch.x) * 1.6, (t.clientY - lastTouch.y) * 1.6);
  lastTouch = { x: t.clientX, y: t.clientY };
}, { passive: true });
canvas.addEventListener('touchend', () => { lastTouch = null; });
addEventListener('wheel', (e) => {
  if (!playing) return;
  cam.dist = clamp(cam.dist * (e.deltaY < 0 ? 0.9 : 1.1), 7, 60);
}, { passive: true });

// ---------------------------------------------------------------- mobile console
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ } };
function hold(el, on, off) {          // press-and-hold control that works with several fingers at once
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); capture(el, e); el.classList.add('on'); on(); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    el.addEventListener(ev, () => { if (el.classList.contains('on')) { el.classList.remove('on'); off(); } });
  }
}
hold($('gas'), () => { touch.gas = true; }, () => { touch.gas = false; });
hold($('brake'), () => keys.add('BRAKE'), () => keys.delete('BRAKE'));
const setGear = (rev) => {
  touch.reverse = rev;
  $('gearD').classList.toggle('sel', !rev);
  $('gearR').classList.toggle('sel', rev);
};
$('gearD').addEventListener('pointerdown', (e) => { e.preventDefault(); setGear(false); });
$('gearR').addEventListener('pointerdown', (e) => { e.preventDefault(); setGear(true); });
const wheelEl = $('wheel'), wheelSvg = $('wheelsvg');
let wheelStart = null;
wheelEl.addEventListener('pointerdown', (e) => {
  e.preventDefault(); capture(wheelEl, e);
  wheelStart = { x: e.clientX, steer: touch.steer };
});
wheelEl.addEventListener('pointermove', (e) => {
  if (!wheelStart) return;
  touch.steer = clamp(wheelStart.steer - (e.clientX - wheelStart.x) / 70, -1, 1);   // drag right = steer right
  wheelSvg.style.transform = `rotate(${-touch.steer * 120}deg)`;
});
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  wheelEl.addEventListener(ev, () => { wheelStart = null; });
}
const tap = (id, fn) => $(id).addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); });
tap('tView', () => { cam.mode = cam.mode === 'chase' ? 'driver' : 'chase'; if (cam.mode === 'chase') snapCamera(); });
tap('tCam', () => { cam.orbit = 0; cam.elev = cam.elev0; cam.look = 0; cam.lookUp = 0; });
tap('tRoad', () => { if (grid) backOnRoad(); });
tap('tSound', () => { muted = !muted; $('tSound').classList.toggle('off', muted); });

function touchFrame(dt) {
  if (!wheelStart && touch.steer !== 0) {            // the wheel springs back to centre when you let go
    touch.steer -= touch.steer * ease(dt, 6);
    if (Math.abs(touch.steer) < 0.01) touch.steer = 0;
    wheelSvg.style.transform = `rotate(${-touch.steer * 120}deg)`;
  }
  keys.delete('UP'); keys.delete('DOWN');
  if (touch.gas) keys.add(touch.reverse ? 'DOWN' : 'UP');
}
if (TOUCH) {
  $('controls').innerHTML = `
    <b>Steering wheel</b><span>drag left / right to steer</span>
    <b>GAS · BRAKE</b><span>hold to drive · hold to stop</span>
    <b>D · R</b><span>drive forward · reverse</span>
    <b>Swipe the road</b><span>look around the bus (it swings back behind you)</span>
    <b>VIEW · CAM · ROAD</b><span>driver seat · camera behind · back on the road</span>
    <b>Bus stops</b><span>stop in the lay-by at the blue shelter until passengers board</span>`;
}

// ---------------------------------------------------------------- main loop
let playing = false;
function start() {
  playing = true;
  $('overlay').style.display = 'none';
  $('hud').style.display = 'block';
  startAudio();
  audio?.ctx.resume?.();
  if (!TOUCH) { lockMouse(); return; }
  $('console').style.display = 'block';
  // full screen and sideways on phones (both are optional: some browsers refuse)
  document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })
    .then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
  if (innerHeight > innerWidth) toast('Turn your phone sideways', 'for a wider view of the road');
}
$('play').onclick = () => start();

const clock = new THREE.Clock();
function step(dt, now) {
  if (playing && !trip.done) {
    if (TOUCH) touchFrame(dt);
    drive(dt);
    updateTrip(dt);
  }
  poseBus();
  updateCamera(dt, now);
  const p = v3(bus.x, bus.y, bus.z);
  sun.position.copy(p).addScaledVector(SUN_DIR, 300);
  sun.target.position.copy(p);
  sun.target.updateMatrixWorld();
  if (playing) { updateHud(dt); updateAudio(); }
}
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(0.075, clock.getDelta());
  if (!grid) return;
  step(dt, performance.now() / 1000);
  renderer.render(scene, camera);
}

// test hook: run the game for some seconds without waiting for animation frames, then draw once
let simTime = 0;
function simulate(seconds, dt = 1 / 30) {
  for (let t = 0; t < seconds; t += dt) { simTime += dt; step(dt, performance.now() / 1000 + simTime); }
  renderer.render(scene, camera);
}
window.__game = { bus, cam, trip, keys, touch, scene, camera, get grid() { return grid; }, get busNodes() { return busNodes; },
  look, backOnRoad, start, simulate, setGear };
load().then(frame).catch((err) => {
  console.error(err);
  $('err').style.display = 'block';
  $('err').textContent = `Could not load the game: ${err.message}. Check your connection and reload.`;
});
