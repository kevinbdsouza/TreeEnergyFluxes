import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ---------- helpers ------------------------------------------------------ */
const uniform = (lo, hi) => Math.random() * (hi - lo) + lo; // Keep for makeTree, etc.
const colours = {
  solar     : 0xffff00,
  longwave  : 0xff00ff,
  sensible  : 0xff8c00,
  latent    : 0x00bfff,
  conduction: 0x00ff00,
  melt      : 0xffffff
};

/* ---------- DOM handles -------------------------------------------------- */
const tAirDiv   = document.getElementById('t_air');
const tCanDiv   = document.getElementById('t_canopy');
const tTrDiv    = document.getElementById('t_trunk');
const tSnDiv    = document.getElementById('t_snow');
const tSoDiv    = document.getElementById('t_soil');
const fluxValuesDiv = document.getElementById('flux_values');

const seasonSel = document.getElementById('season');
const forestSel = document.getElementById('forest_type');
const updateBtn = document.getElementById('updateButton');
const treeCountInput = document.getElementById('tree_count');
const treeSpacingInput = document.getElementById('tree_spacing');
// ensure slider labels and positions match initial values
treeCountInput.value = 1;  treeSpacingInput.value = 10;
document.getElementById('tree_count_val').textContent   = treeCountInput.value;
document.getElementById('tree_spacing_val').textContent = treeSpacingInput.value;

/* ---------- three.js scene set-up --------------------------------------- */
let scene, camera, renderer, controls;
let canopyGroup, trunkMesh, snowMesh, soilMesh, fluxArrows, extraTreesGroup; // trunkMesh here is the large central one if used

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbfd1e5);

  camera = new THREE.PerspectiveCamera(75, innerWidth/innerHeight, 0.1, 1000);
  camera.position.set(12,8,15); camera.lookAt(0,2,0);

  renderer = new THREE.WebGLRenderer({antialias:true});
  renderer.setSize(innerWidth,innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 6;
  controls.maxDistance = 40;
  controls.target.set(0,2,0);

  scene.add(new THREE.HemisphereLight(0xffffbb,0x080820,0.6));
  const sun = new THREE.DirectionalLight(0xffffff,1.2);
  sun.position.set(15,20,30); sun.castShadow=true;
  sun.shadow.mapSize.width = sun.shadow.mapSize.height = 1024;
  scene.add(sun);
  const sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.8,16,16),
      new THREE.MeshBasicMaterial({color:0xffffaa})
  );
  sunMesh.position.copy(sun.position);
  scene.add(sunMesh);

  const windDir = new THREE.Vector3(1,-0.3,0).normalize();
  const windGroup = new THREE.Group();
  for(let i=0;i<3;i++){
    const o = new THREE.Vector3(-8 - i*1.5,6+i*0.5,-2);
    const a = new THREE.ArrowHelper(windDir, o, 4, 0x99ccff, 1, 0.5);
    windGroup.add(a);
  }
  scene.add(windGroup);

  canopyGroup = new THREE.Group();  scene.add(canopyGroup);
  extraTreesGroup = new THREE.Group(); scene.add(extraTreesGroup);
  fluxArrows  = new THREE.Group();  scene.add(fluxArrows);

  window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});
  document.querySelectorAll('.fluxToggle').forEach(cb=>cb.addEventListener('change',setArrowVisibility));
  updateBtn.addEventListener('click',updateVisualisation); // This will now call the async version

  updateVisualisation(); // Initial call
}

/* ---------- PARAMETER SAMPLER, MOCK TEMPS & FLUX ARE NOW REPLACED BY PYTHON BACKEND --------------------- */
// const sampleParams = ... (remove or comment out)
// const mockTemps = ... (remove or comment out)
// const mockFlux = ... (remove or comment out)


/* ---------- colours from temperature ----------------------------------- */
const tempColour = (T,Tref)=>{
  const d=T-Tref; const c=new THREE.Color();
  if (T === null || T === undefined || Tref === null || Tref === undefined) { // Handle cases where T might be null (e.g. snow)
    return new THREE.Color(0xcccccc); // Default color for missing temp data
  }
  // Original logic:
  if(d<-10) c.setRGB(0,0,1);
  else if(d<-2) c.lerpColors(new THREE.Color(0,0,1),new THREE.Color(0,0.8,1),(d+10)/8);
  else if(d<2)  c.lerpColors(new THREE.Color(0,0.8,1),new THREE.Color(0,1,0),(d+2)/4);
  else if(d<10) c.lerpColors(new THREE.Color(1,1,0),new THREE.Color(1,0,0),(d-2)/8);
  else          c.setRGB(1,0,0);
  return c;
};

/* ---------- scene builders (ensure buildColumn and makeTree are up-to-date from previous steps) ---- */
function ensureGround(){
  if(soilMesh) return;
  const size=100;
  const g=new THREE.PlaneGeometry(size,size);
  soilMesh=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:0x8b7765,roughness:1}));
  soilMesh.rotation.x=-Math.PI/2; soilMesh.receiveShadow=true; scene.add(soilMesh);
  const grid=new THREE.GridHelper(size,size/2,0x444444,0x888888); grid.material.opacity=0.3; grid.material.transparent=true;
  scene.add(grid);
}

function buildColumn(p, nTrees=1, spacing=10){ // p will now come from Python backend
  canopyGroup.clear(); // fluxArrows are cleared in drawFluxes
  extraTreesGroup.clear();
  if(trunkMesh){scene.remove(trunkMesh);trunkMesh=null;} // This is the large central trunk
  if(snowMesh ){scene.remove(snowMesh );snowMesh =null;}
  ensureGround();

  /* snow */
  if(p.A_snow > 0 && p.Hsnow > 0){ // Check Hsnow as well
    const scale=Math.sqrt(p.A_snow/(p.A_snow+p.A_soil + 1e-6)); // Add epsilon for safety
    const size=19*scale;
    const g=new THREE.BoxGeometry(size,p.Hsnow,size);
    snowMesh=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:0xffffff,roughness:0.8,metalness:0.1}));
    snowMesh.position.y=p.Hsnow/2; snowMesh.castShadow=snowMesh.receiveShadow=true; scene.add(snowMesh);
  }

  /* trunk (central one, if A_trunk_plan is for it) */
  if(p.A_trunk_plan > 0 && p.H_canopy > 0){
     const radius=Math.max(0.1,Math.min(Math.sqrt(p.A_trunk_plan*100/Math.PI),2));
     const g=new THREE.CylinderGeometry(radius*0.6,radius,p.H_canopy,12,3);
     trunkMesh=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:0x8b4513,roughness:0.8}));
     trunkMesh.position.y=p.H_canopy/2; trunkMesh.castShadow=true; scene.add(trunkMesh);
  }

  /* realistic mini-trees */
  if(p.A_can > 0 && p.H_canopy > 0){
    const n=Math.max(1,Math.floor(p.A_can*30)); // Using the increased density factor
    const spread=5*Math.sqrt(p.A_can);
    for(let i=0;i<n;i++){
      const tree=makeTree(p); // p contains LAI, H_canopy etc. needed by makeTree
      const ang=(i/n)*Math.PI*2+Math.random()*0.4;
      const rad=uniform(0,spread);
      tree.position.set(Math.cos(ang)*rad,p.H_canopy,Math.sin(ang)*rad);
      canopyGroup.add(tree);
    }
  }

  // additional surrounding trees
  const totalTrees = Math.max(1, Math.floor(nTrees));
  const gridSize = Math.ceil(Math.sqrt(totalTrees));
  const center = Math.floor(gridSize/2);
  let placed = 0;
  for(let r=0; r<gridSize && placed<totalTrees; r++){
    for(let c=0; c<gridSize && placed<totalTrees; c++){
      const isCenter = r===center && c===center;
      if(isCenter){placed++; continue;} // central tree handled above
      if(placed>=totalTrees) break;
      placed++;
      const tree = makeTree(p, uniform(0.9, 1.1));
      tree.position.set((c-center)*spacing, 0, (r-center)*spacing);
      extraTreesGroup.add(tree);
    }
  }
  const h = p.H_canopy > 0 ? p.H_canopy : 15;
  controls.target.set(0,h/2,0);
  camera.position.set(h*1.2,h, h*1.6);
  controls.update();
}

// Paste your LATEST makeTree function here (from the "more realistic" and "more cones" steps)
function makeTree(p, size=1) {
    const g = new THREE.Group();
    const trunkHeight = p.H_canopy * uniform(0.20, 0.35);
    const foliageCrownVisualHeight = p.H_canopy * uniform(0.35, 0.65);
    const foliageCrownRadiusFactor = uniform(1.8, 4.5);
    const trunkBottomRadius = Math.max(0.05, p.H_canopy * 0.015 * uniform(0.8, 1.2) * Math.sqrt(Math.max(0.1,p.LAI) / 4 + 0.1));
    const trunkTopRadius = trunkBottomRadius * uniform(0.5, 0.75);
    const trunkGeo = new THREE.CylinderGeometry(trunkTopRadius, trunkBottomRadius, trunkHeight, 12, 2);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x654321, roughness: 0.9 });
    const trunkMesh = new THREE.Mesh(trunkGeo, trunkMat);
    trunkMesh.position.y = trunkHeight / 2;
    g.add(trunkMesh);

    const foliageBaseY = trunkHeight;
    let foliageColor;
    if (p.forest_type === 'deciduous') {
        if (p.season === 'winter') foliageColor = 0xA0522D;
        else foliageColor = (p.alpha_can > 0.17 && p.LAI > 3) ? 0x55AB3A : 0x3D8B3A;
    } else if (p.forest_type === 'coniferous') {
        foliageColor = (p.season === 'winter') ? 0x1E5631 : 0x228B22;
    } else foliageColor = 0x333333;

    const folMat = new THREE.MeshStandardMaterial({
        color: foliageColor, roughness: 0.85, metalness: 0.05,
        flatShading: p.forest_type === 'coniferous'
    });

    if (p.forest_type === 'coniferous') {
        const coneRadius = trunkBottomRadius * foliageCrownRadiusFactor * uniform(0.5, 0.8);
        const coneActualHeight = foliageCrownVisualHeight * uniform(0.9, 1.1);
        const folGeo = new THREE.ConeGeometry(coneRadius, coneActualHeight, 10, Math.max(2, Math.floor(coneActualHeight / (coneRadius * 0.5))));
        const f = new THREE.Mesh(folGeo, folMat);
        f.position.y = foliageBaseY + coneActualHeight / 2;
        g.add(f);
    } else if (p.forest_type === 'deciduous') {
        const overallCrownRadius = trunkBottomRadius * foliageCrownRadiusFactor * uniform(0.7, 1.1);
        const crownCenterY = foliageBaseY + foliageCrownVisualHeight * 0.45;
        let numBlobs;
        if (p.season === 'winter') numBlobs = Math.max(1, Math.floor(p.LAI * uniform(1.5, 3.0) + uniform(0, 2)));
        else numBlobs = Math.max(3, Math.floor(p.LAI * uniform(1.0, 1.8) + uniform(2, 5)));

        for (let i = 0; i < numBlobs; i++) {
            let blobRadius = overallCrownRadius * uniform(0.25, 0.55) / Math.pow(Math.max(1,numBlobs), 0.25);
            blobRadius = Math.max(blobRadius, 0.1);
            if (p.season === 'winter' && p.LAI < 0.6) blobRadius *= uniform(0.6, 0.8);
            const folGeo = new THREE.SphereGeometry(blobRadius, 6, 4);
            const f = new THREE.Mesh(folGeo, folMat);
            const R_norm = uniform(0.05, 1.0);
            const R = R_norm * overallCrownRadius * (p.season === 'winter' ? uniform(0.6,0.9) : 1.0);
            const theta = uniform(0, 2 * Math.PI);
            const phi_rand_pow = (p.season === 'winter' && p.LAI < 0.8) ? 0.8 : 1.6;
            const phi = Math.acos(1 - 2 * Math.pow(uniform(0,1), phi_rand_pow) );
            let x = R * Math.sin(phi) * Math.cos(theta);
            let z = R * Math.sin(phi) * Math.sin(theta);
            let y_in_crown = R * Math.cos(phi) * ( (p.season === 'winter' && p.LAI < 0.8) ? uniform(0.5,0.8) : uniform(0.4,0.7) );
            f.position.set(
                x * uniform(0.9, 1.1),
                crownCenterY + y_in_crown + uniform(-0.05,0.05) * overallCrownRadius,
                z * uniform(0.9, 1.1)
            );
            f.position.y = Math.max(f.position.y, foliageBaseY + blobRadius * 0.2);
            g.add(f);
        }
    }
    g.traverse(child => { if (child.isMesh) child.castShadow = true; });
    const baseScaleVariation = uniform(0.95, 1.05);
    const sx = baseScaleVariation * uniform(0.95,1.05) * size;
    const sy = baseScaleVariation * uniform(0.95,1.05) * size;
    const sz = baseScaleVariation * uniform(0.95,1.05) * size;
    g.scale.set(sx, sy, sz);
    return g;
}


/* ---------- arrow helpers ------------------------------------------------ */
function addArrow(orig, dir, len, col, cat) {
  const head = Math.max(0.8, len * 0.3);
  const wid  = head * 0.8;
  const o    = orig.clone().add(dir.clone().normalize().multiplyScalar(head));
  const a = new THREE.ArrowHelper(dir.clone().normalize(), o, Math.max(0.1, len - head), col, head, wid);
  a.userData.category = cat;
  fluxArrows.add(a);
}
const scaleLen = val => 0.5 + Math.abs(val)/40;
const arrowDir = val => new THREE.Vector3(0, val < 0 ? 1 : -1, 0);
const arrowCats=()=>[...document.querySelectorAll('.fluxToggle')].filter(cb=>cb.checked).map(cb=>cb.value);
function setArrowVisibility(){const act=arrowCats(); fluxArrows.children.forEach(a=>a.visible=act.includes(a.userData.category));}

function drawFluxes(Fx, p){ // Fx and p will come from Python backend
  fluxArrows.clear();
  if(!Fx || Object.keys(Fx).length === 0) { // Check if Fx is valid
      console.warn("Flux data is missing or empty. Skipping arrow drawing.");
      setArrowVisibility(); // Still ensure visibility rules apply to empty set
      return;
  }

  const pos={
    canopy:new THREE.Vector3(3,p.H_canopy+1,0),
    trunk :new THREE.Vector3(3,p.H_canopy/2,0),
    snow  :new THREE.Vector3(3,(p.Hsnow||0.2),0),
    soil  :new THREE.Vector3(3,0.05,0),
    sky   :new THREE.Vector3(3,p.H_canopy+6,0)
  };
  const act=arrowCats();

  // Canopy sensible heat flux (example)
  if(Fx.canopy && Fx.canopy.conv_atm !== undefined && act.includes('sensible')){
    const H = Fx.canopy.conv_atm; // Python's conv_atm for canopy is -h(Tc-Ta), so negative is upward flux
    if(Math.abs(H)>1){ // Check magnitude
      addArrow(pos.canopy, arrowDir(H), scaleLen(H), colours.sensible, 'sensible');
    }
  }
  if(Fx.trunk && Fx.trunk.conv_atm !== undefined && act.includes('sensible')){
    const H = Fx.trunk.conv_atm;
    if(Math.abs(H)>1){
      addArrow(pos.trunk, arrowDir(H), scaleLen(H), colours.sensible, 'sensible');
    }
  }
  if(Fx.snow && Fx.snow.conv_atm !== undefined && act.includes('sensible')){
    const H = Fx.snow.conv_atm;
    if(Math.abs(H)>1){
      addArrow(pos.snow, arrowDir(H), scaleLen(H), colours.sensible, 'sensible');
    }
  }
  if(Fx.soil && Fx.soil.conv_atm !== undefined && act.includes('sensible')){
    const H = Fx.soil.conv_atm;
    if(Math.abs(H)>1){
      addArrow(pos.soil, arrowDir(H), scaleLen(H), colours.sensible, 'sensible');
    }
  }

  // Solar radiation (example)
  if(p.Q_solar !== undefined && act.includes('solar')){
    const nArr=Math.min(5,Math.max(1,Math.floor(p.Q_solar/150)));
    for(let i=0;i<nArr;i++){
      const o=pos.sky.clone().add(new THREE.Vector3(uniform(-5,5),uniform(0,2),uniform(-5,5)));
      addArrow(o,new THREE.Vector3(0,-1,0), 4*(p.Q_solar/800), colours.solar,'solar');
    }
  }
  
  // TODO: Add more arrows for other flux components (LW, LE, Conduction, Melt)
  // using data from Fx (e.g., Fx.canopy.LW_atm, Fx.soil.latent_evap, etc.)
  // and p for positions/magnitudes if needed.
  // Example for LW from canopy to atmosphere:
  if (Fx.canopy && Fx.canopy.LW_atm !== undefined && act.includes('longwave')) {
    const Lnet_can_atm = Fx.canopy.LW_atm; // LW_can_atm = ei*A_can*(LW_down - lw(T_can))
                                         // Positive if LW_down > lw(T_can) (net gain for canopy)
    if (Math.abs(Lnet_can_atm) > 1) {
      addArrow(pos.canopy, arrowDir(-Lnet_can_atm), scaleLen(Lnet_can_atm), colours.longwave, 'longwave');
    }
  }
  if (Fx.trunk && Fx.trunk.LW_atm !== undefined && act.includes('longwave')) {
    const L = Fx.trunk.LW_atm;
    if (Math.abs(L) > 1) {
      addArrow(pos.trunk, arrowDir(-L), scaleLen(L), colours.longwave, 'longwave');
    }
  }
  if (Fx.snow && Fx.snow.LW_atm !== undefined && act.includes('longwave')) {
    const L = Fx.snow.LW_atm;
    if (Math.abs(L) > 1) {
      addArrow(pos.snow, arrowDir(-L), scaleLen(L), colours.longwave, 'longwave');
    }
  }
  if (Fx.soil && Fx.soil.LW_atm !== undefined && act.includes('longwave')) {
    const L = Fx.soil.LW_atm;
    if (Math.abs(L) > 1) {
      addArrow(pos.soil, arrowDir(-L), scaleLen(L), colours.longwave, 'longwave');
    }
  }
  // Example for Latent Heat from canopy:
  if (Fx.canopy && Fx.canopy.latent_evap !== undefined && act.includes('latent')) {
    const LE_can = Fx.canopy.latent_evap; // latent_evap = -Lv * dot_m_vap_can (energy loss)
    if (Math.abs(LE_can) > 1) {
        addArrow(pos.canopy, arrowDir(LE_can), scaleLen(LE_can), colours.latent, 'latent');
    }
  }
  if (Fx.soil && Fx.soil.latent_evap !== undefined && act.includes('latent')) {
    const LE_soil = Fx.soil.latent_evap;
    if (Math.abs(LE_soil) > 1) {
      addArrow(pos.soil, arrowDir(LE_soil), scaleLen(LE_soil), colours.latent, 'latent');
    }
  }
  if (Fx.soil && Fx.soil.cond_to_deep !== undefined && act.includes('conduction')) {
    const C_deep = Fx.soil.cond_to_deep;
    if (Math.abs(C_deep) > 1) {
      addArrow(pos.soil, arrowDir(C_deep), scaleLen(C_deep), colours.conduction, 'conduction');
    }
  }
  if (Fx.snow && Fx.snow.melt_sink !== undefined && act.includes('melt')) {
    const M = Fx.snow.melt_sink;
    if (Math.abs(M) > 1) {
      addArrow(pos.snow, new THREE.Vector3(0,-1,0), scaleLen(M), colours.melt, 'melt');
    }
  }

  // Conduction between components
  if (Fx.canopy && Fx.canopy.cond_to_trunk !== undefined && act.includes('conduction')) {
    const C = Fx.canopy.cond_to_trunk;
    if (Math.abs(C) > 1) {
      const dir = C < 0 ? new THREE.Vector3(0,-1,0) : new THREE.Vector3(0,1,0);
      addArrow(pos.canopy, dir, scaleLen(C), colours.conduction, 'conduction');
    }
  }
  if (Fx.trunk && Fx.trunk.cond_to_soil !== undefined && act.includes('conduction')) {
    const C = Fx.trunk.cond_to_soil;
    if (Math.abs(C) > 1) {
      const dir = C < 0 ? new THREE.Vector3(0,-1,0) : new THREE.Vector3(0,1,0);
      addArrow(pos.trunk, dir, scaleLen(C), colours.conduction, 'conduction');
    }
  }
  if (Fx.trunk && Fx.trunk.cond_to_snow !== undefined && act.includes('conduction')) {
    const C = Fx.trunk.cond_to_snow;
    if (Math.abs(C) > 1) {
      const dir = C < 0 ? new THREE.Vector3(0,-1,0) : new THREE.Vector3(0,1,0);
      addArrow(pos.trunk, dir, scaleLen(C), colours.conduction, 'conduction');
    }
  }
  if (Fx.snow && Fx.snow.cond_to_soil !== undefined && act.includes('conduction')) {
    const C = Fx.snow.cond_to_soil;
    if (Math.abs(C) > 1) {
      const dir = C < 0 ? new THREE.Vector3(0,-1,0) : new THREE.Vector3(0,1,0);
      addArrow(pos.snow, dir, scaleLen(C), colours.conduction, 'conduction');
    }
  }


  setArrowVisibility();
}

function updateFluxValues(Fx, Qsolar){
  fluxValuesDiv.innerHTML='';
  if(Qsolar !== undefined){
    const d=document.createElement('div');
    d.textContent=`Qsolar: ${Qsolar.toFixed(1)} W m⁻²`;
    fluxValuesDiv.appendChild(d);
  }
  if(!Fx) return;
  for(const [node,comps] of Object.entries(Fx)){
    for(const [k,v] of Object.entries(comps)){
      if(k==='net') continue;
      if(Math.abs(v) < 0.01) continue;
      const d=document.createElement('div');
      d.textContent=`${node} ${k}: ${v.toFixed(1)} W m⁻²`;
      fluxValuesDiv.appendChild(d);
    }
  }
}

/* ---------- update (MODIFIED TO FETCH FROM PYTHON) --------------------- */
async function updateVisualisation(){
  updateBtn.disabled = true;
  updateBtn.textContent = "Loading...";

  const selectedSeason = seasonSel.value;
  const selectedForest = forestSel.value;

  try {
    // Use a relative path so the API works both locally (with `app.py`) and when
    // deployed (e.g. to Vercel where the endpoint lives at `/api/run_simulation`).
    const response = await fetch('/api/run_simulation', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ season: selectedSeason, forest_type: selectedForest }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();

    if (data.error) {
        throw new Error(`Backend error: ${data.error}`);
    }

    const p_backend  = data.parameters;
    const T_backend  = data.temperatures;
    const Fx_backend = data.fluxes;

    // Use the data from backend
    const nTrees = parseInt(treeCountInput.value); 
    const spacing = parseFloat(treeSpacingInput.value);
    buildColumn(p_backend, nTrees, spacing);

    /* colour nodes */
    const ref_T_atm = p_backend.T_atm; // Air temp for reference
    tAirDiv.textContent = `Air      : ${ref_T_atm !== undefined ? ref_T_atm.toFixed(1) : '—'} K`;
    tCanDiv.textContent = `Canopy   : ${T_backend.canopy !== null && T_backend.canopy !== undefined ? T_backend.canopy.toFixed(1) : '—'} K`;
    tTrDiv.textContent  = `Trunk    : ${T_backend.trunk !== null && T_backend.trunk !== undefined ? T_backend.trunk.toFixed(1) : '—'} K`;
    // Display snow temp only if snow is present according to parameters
    tSnDiv.textContent  = `Snow     : ${(p_backend.A_snow > 0 && T_backend.snow !== null && T_backend.snow !== undefined) ? T_backend.snow.toFixed(1) + ' K' : '—'}`;
    tSoDiv.textContent  = `Soil     : ${T_backend.soil !== null && T_backend.soil !== undefined ? T_backend.soil.toFixed(1) : '—'} K`;
    



    /* flux arrows & text */
    drawFluxes(Fx_backend, p_backend); // Pass backend fluxes and parameters
    updateFluxValues(Fx_backend, p_backend.Q_solar);

  } catch (error) {
    console.error('Error fetching or processing data:', error);
    // Display error to user or revert to some default state
    tAirDiv.textContent   = `Air      : Error`;
    tCanDiv.textContent   = `Canopy   : Error`;
    // Clear other fields or show error message
    alert(`Failed to update visualization: ${error.message}`);
  } finally {
    updateBtn.disabled = false;
    updateBtn.textContent = "Sample and Run";
  }
}

/* ---------- animate ------------------------------------------------------ */
function animate(){requestAnimationFrame(animate);controls.update();renderer.render(scene,camera);}

init();
animate();