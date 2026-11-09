"use strict";

/* =====================================================
   1. SETTINGS AND DATA
   ===================================================== */
const CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php"; // free orbit data (TLE) service
// Real Earth photos (NASA-style maps shipped with the three.js examples)
const TEX = "https://raw.githubusercontent.com/mrdoob/three.js/r128/examples/textures/planets/";
const TEX_BACKUP = "https://cdn.jsdelivr.net/npm/three-globe@2.31.0/example/img/earth-blue-marble.jpg";
// Real cities: used for dots on the globe and for the "nearest city" readout. [name, lat, lon]
const CITIES = [
  ["Delhi", 28.61, 77.21], ["Kolkata", 22.57, 88.36], ["Mumbai", 19.08, 72.88], ["Dhaka", 23.81, 90.41],
  ["Dubai", 25.2, 55.27], ["Singapore", 1.35, 103.82], ["Beijing", 39.9, 116.41], ["Tokyo", 35.68, 139.69],
  ["Sydney", -33.87, 151.21], ["Moscow", 55.76, 37.62], ["London", 51.51, -0.13], ["Paris", 48.86, 2.35],
  ["Cairo", 30.04, 31.24], ["Lagos", 6.52, 3.38], ["Nairobi", -1.29, 36.82], ["Cape Town", -33.92, 18.42],
  ["New York", 40.71, -74.01], ["Los Angeles", 34.05, -118.24], ["Mexico City", 19.43, -99.13], ["Sao Paulo", -23.55, -46.63]
];
const EARTH_RADIUS = 6371;      // km, used to scale the 3D scene (1 unit = Earth radius)
const EQUATOR_RADIUS = 6378.137; // km, used for perigee and apogee
const MU = 398600.4418;         // Earth gravitational constant (km^3/s^2)
const DEFAULT_ID = 25544;       // ISS

// Quick-pick list. These are real NORAD IDs; names and orbits are loaded live from CelesTrak.
const POPULAR = [
  { id: 25544, name: "ISS (ZARYA)" }, { id: 20580, name: "Hubble Space Telescope" },
  { id: 48274, name: "Tiangong (CSS Tianhe)" }, { id: 25994, name: "Terra" },
  { id: 27424, name: "Aqua" }, { id: 33591, name: "NOAA 19" },
  { id: 49260, name: "Landsat 9" }, { id: 41866, name: "GOES 16" }
];

// One object keeps the app's current state together
const state = { satrec: null, name: "", id: null, epoch: null, current: null, follow: false, snap: true, request: 0 };

// Simulated clock: scale 1 = real time. Higher scale = time runs faster so you can SEE the satellite move.
const clock = { realBase: Date.now(), simBase: Date.now(), scale: 1 };
function simNow() { return new Date(clock.simBase + (Date.now() - clock.realBase) * clock.scale); }
function setScale(scale) {
  const current = scale === 1 ? Date.now() : simNow().getTime(); // "Live" jumps back to real time
  clock.simBase = current; clock.realBase = Date.now(); clock.scale = scale;
  document.querySelectorAll("[data-scale]").forEach((b) => {
    const on = Number(b.dataset.scale) === scale;
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
  });
  log(scale === 1 ? "Time: LIVE (real time)." : "Time speed x" + scale + " (simulation).");
}

const $ = (id) => document.getElementById(id);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* =====================================================
   2. SMALL UI HELPERS
   ===================================================== */
const logLines = [];
function log(message) { // add a timestamped line to the terminal
  const time = new Date().toISOString().slice(11, 19);
  logLines.push("[" + time + "] " + message);
  if (logLines.length > 40) logLines.shift();
  const box = $("logBox");
  box.textContent = logLines.join("\n");
  box.scrollTop = box.scrollHeight;
}

function setLink(stateName) { // LIVE, LOADING, ERROR or STANDBY
  [$("linkChip"), $("sideLink")].forEach((node) => { node.textContent = stateName; node.dataset.state = stateName; });
}

function setPill(id, text, tone) {
  const pill = $(id);
  pill.textContent = text;
  pill.dataset.tone = tone;
}

/* =====================================================
   3. DATA: CelesTrak requests
   ===================================================== */
async function fetchTle(id) {
  const res = await fetch(CELESTRAK + "?CATNR=" + encodeURIComponent(id) + "&FORMAT=TLE");
  if (!res.ok) throw new Error("CelesTrak answered with status " + res.status);
  const lines = (await res.text()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const first = lines.findIndex((l) => l.startsWith("1 "));
  if (first === -1 || !lines[first + 1]) throw new Error("No orbit data found for NORAD ID " + id);
  return { name: first > 0 ? lines[first - 1] : "NORAD " + id, line1: lines[first], line2: lines[first + 1] };
}

async function searchRemote(query, signal) { // search by name, returns [{id, name}]
  const res = await fetch(CELESTRAK + "?NAME=" + encodeURIComponent(query) + "&FORMAT=JSON", { signal });
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data.slice(0, 8).map((o) => ({ id: o.NORAD_CAT_ID, name: o.OBJECT_NAME })) : [];
  } catch (err) {
    return []; // CelesTrak sends plain text when nothing matches
  }
}

/* =====================================================
   4. SATELLITE MATH (Satellite.js)
   ===================================================== */
function computePosition(date) {
  if (!state.satrec) return null;
  const pv = satellite.propagate(state.satrec, date); // SGP4 model
  if (!pv.position) return null;                       // fails if the orbit has decayed
  const gmst = satellite.gstime(date);                 // Earth's rotation angle
  const geo = satellite.eciToGeodetic(pv.position, gmst);
  const v = pv.velocity;
  return {
    eci: pv.position, gmst: gmst,
    lat: satellite.degreesLat(geo.latitude), lon: satellite.degreesLong(geo.longitude),
    alt: geo.height, speed: Math.hypot(v.x, v.y, v.z)
  };
}

function orbitInfo(satrec) { // numbers that describe the orbit shape
  const periodMin = (2 * Math.PI) / satrec.no;          // satrec.no is radians per minute
  const periodSec = periodMin * 60;
  const a = Math.cbrt(MU * Math.pow(periodSec / (2 * Math.PI), 2)); // semi-major axis (km)
  const e = satrec.ecco;
  const epochYear = satrec.epochyr < 57 ? 2000 + satrec.epochyr : 1900 + satrec.epochyr;
  return {
    periodMin: periodMin, inclination: (satrec.inclo * 180) / Math.PI, ecc: e,
    perigee: a * (1 - e) - EQUATOR_RADIUS, apogee: a * (1 + e) - EQUATOR_RADIUS,
    epoch: new Date(Date.UTC(epochYear, 0, 1) + (satrec.epochdays - 1) * 86400000)
  };
}

/* =====================================================
   5. 3D GLOBE (Three.js)
   Axes: satellite.js (x, y, z) becomes three.js (x, z, -y)
   ===================================================== */
const globe = { ready: false, zoom: 3, drag: null };

function toScene(p) { return new THREE.Vector3(p.x / EARTH_RADIUS, p.z / EARTH_RADIUS, -p.y / EARTH_RADIUS); }

function latLonToVector(lat, lon, r) { // lat/lon in degrees on a sphere of radius r
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  return new THREE.Vector3(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
}

function loadTexture(urls, onLoad, onFail) { // try each URL until one works
  const loader = new THREE.TextureLoader().setCrossOrigin("anonymous");
  const tryNext = (i) => {
    if (i >= urls.length) { if (onFail) onFail(); return; }
    loader.load(urls[i], onLoad, undefined, () => tryNext(i + 1));
  };
  tryNext(0);
}

// Direction of the Sun (simple astronomy formula), used to light the day side of the Earth
function sunDirection(date) {
  const n = date.getTime() / 86400000 - 10957.5; // days since year 2000
  const g = ((357.528 + 0.9856003 * n) * Math.PI) / 180;
  const lam = ((280.46 + 0.9856474 * n + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI) / 180;
  const eps = (23.439 * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(lam), Math.sin(eps) * Math.sin(lam), -Math.cos(eps) * Math.sin(lam));
}

// A small 3D satellite: body, two solar panels and a dish that points at the Earth
function buildSatelliteModel() {
  const group = new THREE.Group();
  const metal = new THREE.MeshBasicMaterial({ color: 0xE5E7EB }), panelMat = new THREE.MeshBasicMaterial({ color: 0x4F6BED });
  group.add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.045), metal));
  [-1, 1].forEach((side) => {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.002, 0.034), panelMat);
    panel.position.x = side * 0.055;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.003, 0.003), metal);
    arm.position.x = side * 0.02;
    group.add(panel, arm);
  });
  const dish = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.016, 14), metal);
  dish.rotation.x = Math.PI / 2; dish.position.z = 0.03;
  group.add(dish);
  return group;
}

// Distance in km between two lat/lon points (haversine formula)
function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h));
}
function nearestCity(lat, lon) {
  let best = { name: "", km: Infinity };
  CITIES.forEach((c) => { const km = distanceKm(lat, lon, c[1], c[2]); if (km < best.km) best = { name: c[0], km: km }; });
  return best;
}

function initGlobe() {
  const box = $("globe"), canvas = $("canvas");
  globe.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
  globe.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  globe.scene = new THREE.Scene();
  globe.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  globe.camera.position.z = globe.zoom;
  globe.view = new THREE.Group(); // everything that rotates together
  globe.scene.add(globe.view);

  // Earth: real photo map, shiny oceans, city lights on the night side, clouds and a thin atmosphere
  const earthMat = new THREE.MeshPhongMaterial({ color: 0x1a2a55, shininess: 14, specular: new THREE.Color(0x2a2a2a), emissive: 0xffffff, emissiveIntensity: 0 });
  globe.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), earthMat);
  globe.view.add(globe.earth);
  loadTexture([TEX + "earth_atmos_2048.jpg", TEX_BACKUP], (t) => { earthMat.map = t; earthMat.color.set(0xffffff); earthMat.needsUpdate = true; },
    () => log("Earth map could not load. Showing a plain globe. Check your internet connection."));
  loadTexture([TEX + "earth_specular_2048.jpg"], (t) => { earthMat.specularMap = t; earthMat.needsUpdate = true; });
  loadTexture([TEX + "earth_lights_2048.png"], (t) => { earthMat.emissiveMap = t; earthMat.emissiveIntensity = 0.9; earthMat.needsUpdate = true; });

  const cloudMat = new THREE.MeshPhongMaterial({ transparent: true, opacity: 0, depthWrite: false });
  globe.clouds = new THREE.Mesh(new THREE.SphereGeometry(1.012, 48, 36), cloudMat);
  loadTexture([TEX + "earth_clouds_1024.png"], (t) => { cloudMat.map = t; cloudMat.opacity = 0.4; cloudMat.needsUpdate = true; });
  const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.03, 48, 36),
    new THREE.MeshBasicMaterial({ color: 0x5aa9ff, transparent: true, opacity: 0.1, side: THREE.BackSide }));
  globe.sun = new THREE.DirectionalLight(0xffffff, 1.2); // the Sun
  globe.view.add(globe.clouds, atmosphere, globe.sun);
  globe.scene.add(new THREE.AmbientLight(0xffffff, 0.12));

  // Latitude and longitude grid lines every 30 degrees
  const gridPts = [];
  for (let lat = -60; lat <= 60; lat += 30) {
    for (let lon = 0; lon < 360; lon += 6) gridPts.push(latLonToVector(lat, lon, 1.002), latLonToVector(lat, lon + 6, 1.002));
  }
  for (let lon = 0; lon < 360; lon += 30) {
    for (let lat = -90; lat < 90; lat += 6) gridPts.push(latLonToVector(lat, lon, 1.002), latLonToVector(lat + 6, lon, 1.002));
  }
  const grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gridPts),
    new THREE.LineBasicMaterial({ color: 0xA78BFA, transparent: true, opacity: 0.1 }));
  globe.earth.add(grid);
  // White dots for real cities, so you can tell where on Earth the satellite is
  globe.earth.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(CITIES.map((c) => latLonToVector(c[1], c[2], 1.004))),
    new THREE.PointsMaterial({ color: 0xF8FAFC, size: 0.014 }))); // child of the Earth, so it spins with it

  globe.orbitLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xA78BFA }));
  globe.view.add(globe.orbitLine);
  globe.marker = buildSatelliteModel();
  globe.ring = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.078, 40),
    new THREE.MeshBasicMaterial({ color: 0xA3E635, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
  globe.ground = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 8), new THREE.MeshBasicMaterial({ color: 0x10B981 }));
  const nadirGeo = new THREE.BufferGeometry();
  nadirGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
  globe.nadir = new THREE.Line(nadirGeo,
    new THREE.LineBasicMaterial({ color: 0x10B981, transparent: true, opacity: 0.6 }));
  globe.view.add(globe.marker, globe.ring, globe.ground, globe.nadir);

  // Stars: random points far away
  const stars = [];
  for (let i = 0; i < 500; i++) stars.push(new THREE.Vector3(Math.random() - .5, Math.random() - .5, Math.random() - .5).normalize().multiplyScalar(60));
  globe.scene.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(stars), new THREE.PointsMaterial({ color: 0xffffff, size: 0.12, sizeAttenuation: true })));

  // Keep the canvas the same size as its box
  new ResizeObserver(() => {
    const w = box.clientWidth, h = box.clientHeight;
    globe.renderer.setSize(w, h, false);
    globe.camera.aspect = w / h;
    globe.camera.updateProjectionMatrix();
  }).observe(box);

  // Mouse, touch, wheel and keyboard controls
  // Touch and mouse: one finger rotates, two fingers pinch to zoom
  const pointers = new Map(); // all fingers currently touching the globe
  let pinchStart = null;
  const pinchDistance = () => { const [p1, p2] = [...pointers.values()]; return Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1; };
  canvas.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    setFollow(false); state.snap = false;
    if (pointers.size === 2) pinchStart = pinchDistance();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId), cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    if (pointers.size === 2) { // fingers moving apart = zoom in, together = zoom out
      const dist = pinchDistance();
      if (pinchStart) globe.zoom = clamp(globe.zoom * (pinchStart / dist), 1.4, 18);
      pinchStart = dist;
    } else if (pointers.size === 1) {
      rotateView((cur.x - prev.x) * 0.006, (cur.y - prev.y) * 0.006);
    }
  });
  const endPointer = (e) => { pointers.delete(e.pointerId); pinchStart = null; };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomBy(e.deltaY * 0.003); }, { passive: false });
  canvas.addEventListener("keydown", (e) => {
    const keys = { ArrowLeft: [-0.1, 0], ArrowRight: [0.1, 0], ArrowUp: [0, -0.1], ArrowDown: [0, 0.1] };
    if (keys[e.key]) { e.preventDefault(); setFollow(false); state.snap = false; rotateView(keys[e.key][0], keys[e.key][1]); }
    if (e.key === "+" || e.key === "=") zoomBy(-0.4);
    if (e.key === "-") zoomBy(0.4);
  });
  globe.ready = true;
  animate();
}

function rotateView(dy, dx) {
  globe.view.rotation.y += dy;
  globe.view.rotation.x = clamp(globe.view.rotation.x + dx, -1.4, 1.4);
}
function zoomBy(amount) { globe.zoom = clamp(globe.zoom + amount, 1.4, 18); }

function setFollow(on) {
  state.follow = on;
  $("followBtn").classList.toggle("on", on);
  $("followBtn").setAttribute("aria-pressed", String(on));
}

function angleDiff(target, current) { // shortest way round a circle
  return (((target - current) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
}

function buildOrbitLine() { // one full orbit starting now, in space coordinates
  const info = orbitInfo(state.satrec), start = simNow().getTime(), points = [];
  for (let i = 0; i <= 180; i++) {
    const pv = satellite.propagate(state.satrec, new Date(start + (i / 180) * info.periodMin * 60000));
    if (pv.position) points.push(toScene(pv.position));
  }
  globe.orbitLine.geometry.dispose();
  globe.orbitLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
  const rMax = points.reduce((m, p) => Math.max(m, p.length()), 1);
  globe.zoom = clamp(rMax * 1.9 + 0.9, 2.6, 15); // zoom out for high orbits
}

function animate() {
  requestAnimationFrame(animate);
  const now = simNow(), p = computePosition(now);
  state.current = p;
  const gmst = satellite.gstime(now);
  globe.earth.rotation.y = gmst;                                   // Earth turns once per day
  globe.clouds.rotation.y = gmst + (now.getTime() / 3.6e6) * 0.002; // clouds drift slowly
  globe.sun.position.copy(sunDirection(now)).multiplyScalar(10);   // day and night
  globe.marker.visible = globe.ring.visible = globe.ground.visible = globe.nadir.visible = !!p;
  if (p) {
    const pos = toScene(p.eci);
    const groundPos = latLonToVector(p.lat, p.lon, 1.004).applyAxisAngle(new THREE.Vector3(0, 1, 0), p.gmst);
    globe.marker.position.copy(pos);
    globe.marker.lookAt(0, 0, 0);                  // dish points at the Earth
    globe.ring.position.copy(pos);
    globe.ring.lookAt(globe.camera.position);      // ring always faces the viewer
    globe.ground.position.copy(groundPos);
    globe.nadir.geometry.attributes.position.set([groundPos.x, groundPos.y, groundPos.z, pos.x, pos.y, pos.z]);
    globe.nadir.geometry.attributes.position.needsUpdate = true;
    globe.nadir.frustumCulled = false;
    if (state.follow || state.snap) { // turn the globe so the satellite faces us
      const ease = reduceMotion ? 1 : 0.06;
      const dy = angleDiff(Math.atan2(-pos.x, pos.z), globe.view.rotation.y);
      const dx = Math.asin(pos.y / pos.length()) - globe.view.rotation.x;
      globe.view.rotation.y += dy * ease;
      globe.view.rotation.x += dx * ease;
      if (state.snap && Math.abs(dy) < 0.02 && Math.abs(dx) < 0.02) state.snap = false; // one-time snap done
    }
  }
  const cam = globe.camera.position;
  // On tall, narrow screens (phones) the sideways view is smaller, so move the camera back to keep the whole Earth visible
  const targetZ = globe.zoom / Math.min(1, globe.camera.aspect);
  cam.z += (targetZ - cam.z) * (reduceMotion ? 1 : 0.08);
  const k = cam.z / 3; // keep the satellite visible when zoomed out
  globe.marker.scale.setScalar(k);
  globe.ring.scale.setScalar(k * (reduceMotion ? 1 : 1 + 0.15 * Math.sin(Date.now() / 300)));
  globe.renderer.render(globe.scene, globe.camera);
}

/* =====================================================
   6. TELEMETRY DISPLAY (runs every second)
   ===================================================== */
function updateTelemetry() {
  const now = simNow();
  $("utc").textContent = "UTC " + now.toISOString().slice(11, 19) + (clock.scale > 1 ? " · x" + clock.scale : "");
  const p = state.current;
  if (!p) { setPill("trackPill", "NO FIX", "idle"); return; }
  setPill("trackPill", "TRACKING", "good");
  const lat = Math.abs(p.lat).toFixed(3) + "° " + (p.lat >= 0 ? "N" : "S");
  const lon = Math.abs(p.lon).toFixed(3) + "° " + (p.lon >= 0 ? "E" : "W");
  const near = nearestCity(p.lat, p.lon);
  const nearText = near.name + " · " + Math.round(near.km).toLocaleString("en-IN") + " km";
  $("tLat").textContent = lat;
  $("tLon").textContent = lon;
  $("tAlt").textContent = p.alt.toFixed(1) + " km";
  $("tVel").textContent = p.speed.toFixed(3) + " km/s";
  $("tKmh").textContent = Math.round(p.speed * 3600).toLocaleString("en-IN") + " km/h";
  $("tNear").textContent = nearText;
  $("globeTag").textContent = state.name + "\n" + lat + "  " + lon + "\nNearest city: " + nearText;
  const age = (now.getTime() - state.epoch) / 86400000; // days since the TLE was made
  if (age <= 3) setPill("agePill", "TLE FRESH", "good");
  else if (age <= 14) setPill("agePill", "TLE AGING", "warn");
  else setPill("agePill", "TLE STALE", "bad");
}

function showOrbitInfo(info) {
  $("oId").textContent = state.id;
  $("oInc").textContent = info.inclination.toFixed(2) + "°";
  $("oPer").textContent = info.periodMin.toFixed(1) + " min";
  $("oEcc").textContent = info.ecc.toFixed(6);
  $("oPerigee").textContent = Math.round(info.perigee).toLocaleString("en-IN") + " km";
  $("oApogee").textContent = Math.round(info.apogee).toLocaleString("en-IN") + " km";
  $("oEpoch").textContent = info.epoch.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/* =====================================================
   7. TRACKING A SATELLITE
   ===================================================== */
async function trackSatellite(id) {
  const myRequest = ++state.request; // ignore old answers if the user clicks again quickly
  setLink("LOADING");
  log("Requesting orbit data for NORAD " + id + " ...");
  try {
    const tle = await fetchTle(id);
    if (myRequest !== state.request) return;
    const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
    if (!satellite.propagate(satrec, simNow()).position) throw new Error("Could not calculate a position for this satellite.");
    state.satrec = satrec; state.name = tle.name; state.id = id;
    const info = orbitInfo(satrec);
    state.epoch = info.epoch.getTime();
    $("satName").textContent = tle.name;
    showOrbitInfo(info);
    buildOrbitLine();
    setFollow(false);
    state.snap = true; // turn the globe once towards the satellite, then let it move freely
    setLink("LIVE");
    document.querySelectorAll("#satList .btn").forEach((b) => b.setAttribute("aria-current", String(Number(b.dataset.id) === Number(id))));
    try { localStorage.setItem("lastSat", String(id)); } catch (err) { /* storage may be blocked, that is fine */ }
    log("LOCK " + tle.name + " | period " + info.periodMin.toFixed(1) + " min | inc " + info.inclination.toFixed(1) + " deg");
  } catch (err) {
    if (myRequest !== state.request) return;
    setLink("ERROR");
    log("ERROR " + (err.message || "Request failed") + ". Check your internet connection.");
  }
}

/* =====================================================
   8. SEARCH WITH AUTOCOMPLETE
   ===================================================== */
const input = $("q"), list = $("suggest");
let suggestions = [], activeIndex = -1, searchTimer = null, searchAbort = null;

function renderSuggestions() {
  list.replaceChildren();
  suggestions.forEach((s, i) => {
    const li = document.createElement("li");
    li.id = "opt" + i;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === activeIndex));
    li.textContent = s.name + "  ·  " + s.id; // textContent keeps typed text safe
    li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(s); });
    list.appendChild(li);
  });
  list.hidden = suggestions.length === 0;
  input.setAttribute("aria-expanded", String(!list.hidden));
  if (activeIndex >= 0) input.setAttribute("aria-activedescendant", "opt" + activeIndex);
  else input.removeAttribute("aria-activedescendant");
}

function choose(s) {
  input.value = s.name;
  suggestions = []; activeIndex = -1;
  renderSuggestions();
  trackSatellite(s.id);
}

input.addEventListener("input", () => {
  const q = input.value.trim().toLowerCase();
  activeIndex = -1;
  suggestions = q ? POPULAR.filter((s) => s.name.toLowerCase().includes(q) || String(s.id).startsWith(q)) : [];
  renderSuggestions();
  clearTimeout(searchTimer);
  if (searchAbort) searchAbort.abort();
  if (q.length < 3 || /^\d+$/.test(q)) return;
  searchTimer = setTimeout(async () => { // wait until the user stops typing
    searchAbort = new AbortController();
    try {
      const found = await searchRemote(q, searchAbort.signal);
      if (input.value.trim().toLowerCase() !== q) return;
      const seen = new Set(suggestions.map((s) => String(s.id)));
      suggestions = suggestions.concat(found.filter((s) => !seen.has(String(s.id)))).slice(0, 8);
      renderSuggestions();
    } catch (err) { /* aborted or offline: ignore */ }
  }, 350);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" && suggestions.length) { e.preventDefault(); activeIndex = (activeIndex + 1) % suggestions.length; renderSuggestions(); }
  else if (e.key === "ArrowUp" && suggestions.length) { e.preventDefault(); activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length; renderSuggestions(); }
  else if (e.key === "Escape") { suggestions = []; activeIndex = -1; renderSuggestions(); }
});
input.addEventListener("blur", () => { suggestions = []; renderSuggestions(); });

$("searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (activeIndex >= 0) return choose(suggestions[activeIndex]);
  if (!q) { log("Type a satellite name or NORAD ID first."); input.focus(); return; }
  if (/^\d{1,9}$/.test(q)) return trackSatellite(Number(q));
  if (suggestions.length) return choose(suggestions[0]);
  log("Searching CelesTrak for \"" + q + "\" ...");
  try {
    const found = await searchRemote(q);
    if (found.length) choose(found[0]); else log("No satellite found for \"" + q + "\".");
  } catch (err) { setLink("ERROR"); log("ERROR search failed. Check your internet connection."); }
});

/* =====================================================
   9. START-UP
   ===================================================== */
function setupPage() {
  POPULAR.forEach((s) => { // quick-pick buttons
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "btn ghost"; btn.textContent = s.name; btn.dataset.id = s.id;
    btn.addEventListener("click", () => trackSatellite(s.id));
    $("satList").appendChild(btn);
  });
  $("followBtn").addEventListener("click", () => setFollow(!state.follow));
  $("zoomIn").addEventListener("click", () => zoomBy(-0.5));   // zoom buttons for phones
  $("zoomOut").addEventListener("click", () => zoomBy(0.5));
  $("resetBtn").addEventListener("click", () => { setFollow(false); state.snap = true; if (state.satrec) buildOrbitLine(); });
  document.querySelectorAll("[data-scale]").forEach((b) => b.addEventListener("click", () => setScale(Number(b.dataset.scale))));

  const menuBtn = $("menuBtn"), side = $("sidebar");
  menuBtn.addEventListener("click", () => {
    const open = side.classList.toggle("open");
    menuBtn.setAttribute("aria-expanded", String(open));
  });
  side.querySelectorAll("nav a").forEach((a) => a.addEventListener("click", () => {
    side.querySelectorAll("nav a").forEach((x) => x.classList.remove("active"));
    a.classList.add("active");
    side.classList.remove("open");
    menuBtn.setAttribute("aria-expanded", "false");
  }));
}

function start() {
  setupPage();
  if (typeof THREE === "undefined" || typeof satellite === "undefined") {
    setLink("ERROR");
    log("ERROR Three.js or Satellite.js did not load. Check your internet connection and reload.");
    return;
  }
  initGlobe();
  setInterval(updateTelemetry, 1000);
  setInterval(() => { if (state.satrec) buildOrbitLine(); }, 600000); // refresh orbit ring every 10 minutes
  setInterval(() => { // terminal heartbeat every 15 seconds
    const p = state.current;
    if (p) log(state.name + " LAT " + p.lat.toFixed(2) + " LON " + p.lon.toFixed(2) + " ALT " + p.alt.toFixed(0) + "km");
  }, 15000);
  let saved = DEFAULT_ID;
  try { saved = Number(localStorage.getItem("lastSat")) || DEFAULT_ID; } catch (err) { /* ignore */ }
  trackSatellite(saved);
}

window.addEventListener("DOMContentLoaded", start);