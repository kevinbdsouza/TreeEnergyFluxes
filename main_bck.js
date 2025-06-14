import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ---------- helpers ------------------------------------------------------ */
const uniform = (lo, hi) => Math.random() * (hi - lo) + lo;
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
const qSolDiv   = document.getElementById('q_solar_display');
const fluxInfoC = document.getElementById('flux_info_canopy');

const seasonSel = document.getElementById('season');
const forestSel = document.getElementById('forest_type');
const updateBtn = document.getElementById('updateButton');

/* ---------- three.js scene set-up --------------------------------------- */
let scene, camera, renderer, controls;
let canopyGroup, trunkMesh, snowMesh, soilMesh, fluxArrows;

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);

  camera = new THREE.PerspectiveCamera(75, innerWidth/innerHeight, 0.1, 1000);
  camera.position.set(10,7,10); camera.lookAt(0,1,0);

  renderer = new THREE.WebGLRenderer({antialias:true});
  renderer.setSize(innerWidth,innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.target.set(0,1,0);

  scene.add(new THREE.AmbientLight(0xffffff,0.7));
  const sun = new THREE.DirectionalLight(0xffffff,1.2);
  sun.position.set(5,10,7.5); sun.castShadow=true;
  sun.shadow.mapSize.width = sun.shadow.mapSize.height = 1024;
  scene.add(sun);

  canopyGroup = new THREE.Group();  scene.add(canopyGroup);
  fluxArrows  = new THREE.Group();  scene.add(fluxArrows);

  window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});
  document.querySelectorAll('.fluxToggle').forEach(cb=>cb.addEventListener('change',setArrowVisibility));
  updateBtn.addEventListener('click',updateVisualisation);

  updateVisualisation();
}

/* ---------- parameter sampler (JS mirror of Python) --------------------- */
function sampleParams(season, forest){
  const p={season,forest_type:forest,Q_solar:0,alpha_can:0,A_can:0,LAI:0,H_canopy:0,
           A_trunk_plan:0,A_trunk_vert:0,A_snow:0,Hsnow:0,A_soil:0,
           T_atm:0,T_deep:0,u:0};
  if(season==='summer'){
      p.T_atm=uniform(293,303); p.Q_solar=uniform(400,800);
      p.T_deep=p.T_atm+uniform(-4,-2);
  }else{
      p.T_atm=uniform(258,273); p.Q_solar=uniform(50,200);
      p.T_deep=uniform(268,274);
  }
  p.u=uniform(0.5, forest==='none'?2:3);

  if(forest==='coniferous'){
    p.alpha_can=uniform(0.05,0.10);
    p.A_can=season==='summer'?uniform(0.5,0.8):uniform(0.4,0.7);
    p.LAI=uniform(3,5);
  }else if(forest==='deciduous'){
    p.alpha_can=uniform(0.15,0.20);
    p.A_can=season==='summer'?uniform(0.6,0.9):uniform(0.1,0.2);
    p.LAI=season==='summer'?uniform(4,6):uniform(0.3,0.7);
  }
  p.H_canopy = p.A_can>0?uniform(10,20):0;

  if(forest!=='none'){
    p.A_trunk_plan=uniform(0.01,0.05);
    p.A_trunk_vert=uniform(1,3)*p.A_trunk_plan;
  }
  const avail=1-p.A_trunk_plan;
  p.A_snow = (season==='summer' ? 0 : uniform(0.6,1)) * avail;
  if(p.A_snow<1e-3) p.A_snow=0;
  p.A_soil = avail-p.A_snow;
  p.Hsnow  = p.A_snow>0?uniform(0.05,1):0;
  return p;
}

/* ---------- mock temps & flux (demo only) ------------------------------- */
function mockTemps(p){
  const T0=p.season==='summer'?298:265;
  return {
    air    : p.T_atm,
    canopy : T0+uniform(-2,8),
    trunk  : T0+uniform(-3,3),
    snow   : p.A_snow?Math.min(273.15,T0+uniform(-1,1)):T0-5,
    soil   : T0+uniform(-4,2)
  };
}

function mockFlux(p, T){
  const Hc=-(T.canopy-p.T_atm)*5;
  return {canopy:{conv_atm:Hc,net:Hc}};
}

/* ---------- colours from temperature ----------------------------------- */
const tempColour = (T,Tref)=>{
  const d=T-Tref, c=new THREE.Color();
  if(d<-10) c.setRGB(0,0,1);
  else if(d<-2) c.lerpColors(new THREE.Color(0,0,1),new THREE.Color(0,0.8,1),(d+10)/8);
  else if(d<2)  c.lerpColors(new THREE.Color(0,0.8,1),new THREE.Color(0,1,0),(d+2)/4);
  else if(d<10) c.lerpColors(new THREE.Color(1,1,0),new THREE.Color(1,0,0),(d-2)/8);
  else          c.setRGB(1,0,0);
  return c;
};

/* ---------- scene builders ---------------------------------------------- */
function ensureGround(){
  if(soilMesh) return;
  const g=new THREE.PlaneGeometry(20,20);
  soilMesh=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:0x8b4513}));
  soilMesh.rotation.x=-Math.PI/2; soilMesh.receiveShadow=true; scene.add(soilMesh);
}
function buildColumn(p){
  canopyGroup.clear(); fluxArrows.clear();
  if(trunkMesh){scene.remove(trunkMesh);trunkMesh=null;}
  if(snowMesh ){scene.remove(snowMesh );snowMesh =null;}
  ensureGround();

  /* snow */
  if(p.A_snow>0){
    const scale=Math.sqrt(p.A_snow/(p.A_snow+p.A_soil));
    const size=19*scale;
    const g=new THREE.BoxGeometry(size,p.Hsnow,size);
    snowMesh=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:0xffffff,transparent:true,opacity:0.9}));
    snowMesh.position.y=p.Hsnow/2; snowMesh.castShadow=snowMesh.receiveShadow=true; scene.add(snowMesh);
  }

  /* trunk (referring to the central, larger optional trunk, not individual tree trunks from makeTree) */
  if(p.A_trunk_plan>0 && p.H_canopy>0){ // This seems to be for a potential larger, single trunk if design implied one
    const radius=Math.max(0.1,Math.min(Math.sqrt(p.A_trunk_plan*100/Math.PI),2));
    const g=new THREE.CylinderGeometry(radius*0.6,radius,p.H_canopy,10);
    // Check if this trunkMesh is the same as the one in makeTree, or a different concept.
    // Based on its singular nature and direct add to scene, it's separate from canopyGroup trees.
    // The previous version of makeTree had its own trunk. The current one does too.
    // This large trunkMesh is only added if p.A_trunk_plan > 0 and p.H_canopy > 0.
    // It's distinct from the "realistic mini-trees" in canopyGroup.
    if (trunkMesh) scene.remove(trunkMesh); // ensure old one is removed if params change
    trunkMesh=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:0x8b4513}));
    trunkMesh.position.y=p.H_canopy/2; trunkMesh.castShadow=true; scene.add(trunkMesh);
  }

  /* realistic mini-trees (these are the ones forming the canopy, including cone-like ones) */
  if(p.A_can>0 && p.H_canopy>0){
    // MODIFICATION: Increased the multiplier from 10 to 30 for more trees
    const n=Math.max(1,Math.floor(p.A_can*30)); // Was p.A_can*10
    const spread=5*Math.sqrt(p.A_can); // Spread radius for the trees
    for(let i=0;i<n;i++){
      const tree=makeTree(p); // makeTree will generate a cone-like tree if p.forest_type is coniferous
      const ang=(i/n)*Math.PI*2+Math.random()*0.4; // Distribute trees in a somewhat circular pattern
      const rad=uniform(0,spread);
      tree.position.set(Math.cos(ang)*rad,p.H_canopy,Math.sin(ang)*rad); // Base of tree model at p.H_canopy height
      canopyGroup.add(tree);
    }
  }
}

function makeTree(p) {
    const g = new THREE.Group();

    // --- Parameters for the tree model parts ---
    // The "tree unit" base (local y=0) will be placed at world y=p.H_canopy in buildColumn
    const trunkHeight = p.H_canopy * uniform(0.20, 0.35); // Visible upper trunk part
    const foliageCrownVisualHeight = p.H_canopy * uniform(0.35, 0.65); // Approximate height of the foliage part
    const foliageCrownRadiusFactor = uniform(1.8, 4.5); // How wide foliage is relative to trunk radius

    // --- Trunk ---
    // LAI influences trunk radius, sqrt for less aggressive scaling
    const trunkBottomRadius = Math.max(0.05, p.H_canopy * 0.015 * uniform(0.8, 1.2) * Math.sqrt(Math.max(0.1,p.LAI) / 4 + 0.1));
    const trunkTopRadius = trunkBottomRadius * uniform(0.5, 0.75); // Tapering
    const trunkGeo = new THREE.CylinderGeometry(trunkTopRadius, trunkBottomRadius, trunkHeight, 8); // 8 radial segments
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x654321 /* Darker Brown */, roughness: 0.9 });
    const trunkMesh = new THREE.Mesh(trunkGeo, trunkMat);
    trunkMesh.position.y = trunkHeight / 2; // Position trunk so its base is at local y=0
    g.add(trunkMesh);

    // --- Foliage ---
    const foliageBaseY = trunkHeight; // Foliage starts where the trunk segment ends
    let foliageColor;

    if (p.forest_type === 'deciduous') {
        if (p.season === 'winter') {
            foliageColor = 0xA0522D; // Sienna/Brownish for bare/dead leaves
        } else { // Deciduous Summer
            // Lighter green for higher LAI and potentially higher albedo scenarios
            foliageColor = (p.alpha_can > 0.17 && p.LAI > 3) ? 0x55AB3A : 0x3D8B3A;
        }
    } else if (p.forest_type === 'coniferous') {
        foliageColor = (p.season === 'winter') ? 0x1E5631 : 0x228B22; // Darker green for winter coniferous
    } else { // Fallback for 'none' type if it somehow gets to make a tree (A_can > 0)
        foliageColor = 0x333333; // Dark grey
    }

    const folMat = new THREE.MeshStandardMaterial({
        color: foliageColor,
        roughness: 0.85,
        metalness: 0.05,
        // Apply flatShading for a slightly more stylized, low-poly look for conifers
        flatShading: p.forest_type === 'coniferous'
    });

    if (p.forest_type === 'coniferous') {
        const coneRadius = trunkBottomRadius * foliageCrownRadiusFactor * uniform(0.5, 0.8); // Cones generally narrower than deciduous
        const coneActualHeight = foliageCrownVisualHeight * uniform(0.9, 1.1);
        // radialSegments, heightSegments (more height segments for smoother slope)
        const folGeo = new THREE.ConeGeometry(coneRadius, coneActualHeight, 10, Math.max(2, Math.floor(coneActualHeight / (coneRadius * 0.5))));
        const f = new THREE.Mesh(folGeo, folMat);
        f.position.y = foliageBaseY + coneActualHeight / 2; // Position cone on top of trunk segment
        g.add(f);
    } else if (p.forest_type === 'deciduous') {
        const overallCrownRadius = trunkBottomRadius * foliageCrownRadiusFactor * uniform(0.7, 1.1);
        const crownCenterY = foliageBaseY + foliageCrownVisualHeight * 0.45; // Center of the blob cluster

        let numBlobs;
        if (p.season === 'winter') {
            // Fewer, sparser blobs for winter deciduous, representing bare branches or very few leaves
            numBlobs = Math.max(1, Math.floor(p.LAI * uniform(1.5, 3.0) + uniform(0, 2)));
        } else { // Summer deciduous
            numBlobs = Math.max(3, Math.floor(p.LAI * uniform(1.0, 1.8) + uniform(2, 5)));
        }

        for (let i = 0; i < numBlobs; i++) {
            // Smaller individual blobs if there are many of them
            let blobRadius = overallCrownRadius * uniform(0.25, 0.55) / Math.pow(Math.max(1,numBlobs), 0.25);
            blobRadius = Math.max(blobRadius, 0.1); // Minimum blob radius
            if (p.season === 'winter' && p.LAI < 0.6) { // Make winter "branch clusters" smaller
                blobRadius *= uniform(0.6, 0.8);
            }

            const folGeo = new THREE.SphereGeometry(blobRadius, 6, 4); // Low-poly spheres for blobs
            const f = new THREE.Mesh(folGeo, folMat);

            // Distribute blobs to form a somewhat spherical/ellipsoidal crown
            const R_norm = uniform(0.05, 1.0); // Normalized distance from crown center (avoid all at exact center)
            // Reduce spread for winter to make it look more "compact" or bare
            const R = R_norm * overallCrownRadius * (p.season === 'winter' ? uniform(0.6,0.9) : 1.0);

            const theta = uniform(0, 2 * Math.PI); // Azimuthal angle
            // Polar angle distribution: Pow > 1 biases towards equator (flatter crown), < 1 towards poles
            const phi_rand_pow = (p.season === 'winter' && p.LAI < 0.8) ? 0.8 : 1.6; // More stick-like/vertical for bare winter
            const phi = Math.acos(1 - 2 * Math.pow(uniform(0,1), phi_rand_pow) );

            let x = R * Math.sin(phi) * Math.cos(theta);
            let z = R * Math.sin(phi) * Math.sin(theta);
            // Vertical distribution within the crown, make it a bit flatter overall
            let y_in_crown = R * Math.cos(phi) * ( (p.season === 'winter' && p.LAI < 0.8) ? uniform(0.5,0.8) : uniform(0.4,0.7) );

            f.position.set(
                x * uniform(0.9, 1.1), // Add slight irregularity to blob positions
                crownCenterY + y_in_crown + uniform(-0.05,0.05) * overallCrownRadius,
                z * uniform(0.9, 1.1)
            );
            // Ensure blobs are generally above the trunk top
            f.position.y = Math.max(f.position.y, foliageBaseY + blobRadius * 0.2);

            g.add(f);
        }
    }

    // Apply cast shadow to all meshes in the group
    g.traverse(child => {
        if (child.isMesh) {
            child.castShadow = true;
        }
    });

    // Add slight random variation to the overall size and proportions of the tree model
    const baseScaleVariation = uniform(0.85, 1.15);
    g.scale.set(
        baseScaleVariation * uniform(0.9,1.1), // Width
        baseScaleVariation * uniform(0.85,1.15),// Height
        baseScaleVariation * uniform(0.9,1.1)  // Depth
    );

    return g;
}

/* ---------- arrow helpers ------------------------------------------------ */
function addArrow(orig,dir,len,col,cat){
  const head=0.5, wid=0.3;
  const a=new THREE.ArrowHelper(dir.clone().normalize(),orig,len,col,head,wid);
  a.userData.category=cat; fluxArrows.add(a);
}
const arrowCats=()=>[...document.querySelectorAll('.fluxToggle')].filter(cb=>cb.checked).map(cb=>cb.value);
function setArrowVisibility(){const act=arrowCats(); fluxArrows.children.forEach(a=>a.visible=act.includes(a.userData.category));}
function drawFluxes(flux,p){
  fluxArrows.clear(); if(!flux) return;
  const pos={
    canopy:new THREE.Vector3(0,p.H_canopy+1,0),
    trunk :new THREE.Vector3(0,p.H_canopy/2,0),
    snow  :new THREE.Vector3(0,p.Hsnow||0.2,0),
    soil  :new THREE.Vector3(0,0.05,0),
    sky   :new THREE.Vector3(0,p.H_canopy+6,0)
  };
  const act=arrowCats();

  /* demo: canopy sensible only */
  const H=flux.canopy?.conv_atm||0;
  if(act.includes('sensible') && Math.abs(H)>1){
    const dir=new THREE.Vector3(0, H>0?-1:1,0);
    addArrow(pos.canopy,dir,2+Math.abs(H)/50,colours.sensible,'sensible');
  }

  /* solar */
  if(act.includes('solar')){
    const nArr=Math.min(5,Math.max(1,Math.floor(p.Q_solar/150)));
    for(let i=0;i<nArr;i++){
      const o=pos.sky.clone().add(new THREE.Vector3(uniform(-5,5),uniform(0,2),uniform(-5,5)));
      addArrow(o,new THREE.Vector3(0,-1,0),3*(p.Q_solar/800),colours.solar,'solar');
    }
  }
  setArrowVisibility();
}

/* ---------- update ------------------------------------------------------- */
function updateVisualisation(){
  const p  = sampleParams(seasonSel.value, forestSel.value);
  const T  = mockTemps(p);
  const Fx = mockFlux(p,T);

  buildColumn(p);

  /* colour nodes */
  const ref=p.T_atm;
  tAirDiv .textContent=`Air     : ${ref.toFixed(1)} K`;
  tCanDiv .textContent=`Canopy : ${T.canopy.toFixed(1)} K`;
  tTrDiv  .textContent=`Trunk  : ${T.trunk .toFixed(1)} K`;
  tSnDiv  .textContent=`Snow   : ${p.A_snow?T.snow.toFixed(1)+' K':'—'}`;
  tSoDiv  .textContent=`Soil   : ${T.soil .toFixed(1)} K`;

  canopyGroup.children.forEach(t=>t.children[1].material.color=tempColour(T.canopy,ref)); // foliage
  if(trunkMesh) trunkMesh.material.color=tempColour(T.trunk,ref);
  if(snowMesh ) snowMesh .material.color=tempColour(T.snow ,ref-5);
  soilMesh.material.color=tempColour(T.soil ,p.T_deep);

  /* flux arrows & text */
  drawFluxes(Fx,p);
  qSolDiv .textContent=`Q\u2099 : ${p.Q_solar.toFixed(0)} W m⁻²`;
  fluxInfoC.textContent=`Canopy sensible H : ${Fx.canopy.conv_atm.toFixed(1)} W m⁻²`;
}

/* ---------- animate ------------------------------------------------------ */
function animate(){requestAnimationFrame(animate);controls.update();renderer.render(scene,camera);}

init();
animate();
