// ============================================================================
//  VERBATIM COPY of icomppower/sf-sunset-drive engine.js @ 8fa56535ffde138a17b2885de9ee53f0c054f005
//  Do not edit. Physics, camera, input, HUD, minimap and tour must stay
//  byte-identical to upstream; the remaster only replaces the world build.
//  Any fix belongs upstream first, then re-copy. See docs/DIVERGENCE.md.
// ============================================================================
// ============================================================================
//  Golden Hour — 3D City Driving Engine (shared core)
//  ---------------------------------------------------------------------------
//  The engine owns everything you DON'T want to re-tune per city:
//    input + steering, car physics + collision, camera modes, HUD, minimap,
//    landmark TOUR mode, touch controls, env-map reflections, sky, start,
//    audio, the render loop.
//  A city is a data+build module (see cities/*.js). It supplies only its WORLD:
//    geometry, landmarks, collision, traffic. Call runCity(CITY).
//
//  CITY contract:
//    { id, name, subtitle, tagline, seed, theme, start:{x,z,heading},
//      bounds:{x0,x1,z0,z1}, districts?(x,z)->string,
//      build(api) -> world }
//  api = { THREE, scene, renderer, rand, rr, pick, clamp, lerp,
//          buildCar, windowTex, palm, registerBeacon }
//  world = { collide(nx,nz), groundH?(x,z), landmarks?, minimapBlocks?,
//            trafficPoints?()->[{x,z}], size?, update?(dt), districts?(x,z) }
//  Convention: +x = East, -x = West, +z = South, -z = North. Forward = (sinθ,cosθ).
// ============================================================================
import * as THREE from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;

export function runCity(CITY){
  // ---------- theme (per-city, all optional with golden-hour defaults) ----------
  const T=CITY.theme||{};
  const TH={
    background:T.background??0xf6b27a, fogColor:T.fogColor??0xf0a878, fog:T.fog??0.0011,
    exposure:T.exposure??1.3,
    sky:T.sky||{top:0x2a4a86,mid:0xf2a86a,bot:0xffd9a0},
    sunPos:T.sunPos||[-420,240,-160], sunColor:T.sunColor??0xffc27a, sunInt:T.sunInt??3.0,
    hemiSky:T.hemiSky??0xffe0b8, hemiGround:T.hemiGround??0x5a4048, hemiInt:T.hemiInt??1.35,
    ambColor:T.ambColor??0xffd9b0, ambInt:T.ambInt??0.35,
    fillColor:T.fillColor??0x88aaff, fillInt:T.fillInt??0.35, fillPos:T.fillPos||[300,120,220],
    carColor:T.carColor??0xff4d3d,
    env:T.env||{stops:[[0,'#33528e'],[0.45,'#e79a5e'],[0.62,'#ffcf8c'],[1,'#7a5a44']],sun:[48,42,46]},
    bloom:T.bloom||[0.55,0.7,0.82],
    ground:T.ground??0x6b6f63,
  };

  // ---------- seeded rng ----------
  let _seed=CITY.seed||1337;
  const rand=()=>{_seed=(_seed*1103515245+12345)&0x7fffffff;return _seed/0x7fffffff;};
  const rr=(a,b)=>a+rand()*(b-a);
  const pick=arr=>arr[(rand()*arr.length)|0];

  // ---------- scene / renderer / camera / post ----------
  const scene=new THREE.Scene();
  scene.background=new THREE.Color(TH.background);
  scene.fog=new THREE.FogExp2(TH.fogColor,TH.fog);

  const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
  renderer.setSize(innerWidth,innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.shadowMap.enabled=true;
  renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=TH.exposure;
  document.body.appendChild(renderer.domElement);

  const camera=new THREE.PerspectiveCamera(64,innerWidth/innerHeight,0.5,4000);
  camera.position.set(0,40,60);

  const composer=new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene,camera));
  const bloom=new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),...TH.bloom);
  composer.addPass(bloom);

  // ---------- env map (sky reflections for metal/glass) ----------
  (function envMap(){
    const c=document.createElement('canvas');c.width=256;c.height=128;const x=c.getContext('2d');
    const g=x.createLinearGradient(0,0,0,128);
    for(const[p,col]of TH.env.stops)g.addColorStop(p,col);
    x.fillStyle=g;x.fillRect(0,0,256,128);
    const[sx,sy,sr]=TH.env.sun;
    const sg=x.createRadialGradient(sx,sy,2,sx,sy,sr);
    sg.addColorStop(0,'#fff6e0');sg.addColorStop(0.4,'rgba(255,210,140,.8)');sg.addColorStop(1,'rgba(255,200,120,0)');
    x.fillStyle=sg;x.fillRect(0,0,sx+sr*2,sy+sr*2);
    const tex=new THREE.CanvasTexture(c);tex.mapping=THREE.EquirectangularReflectionMapping;
    const pmrem=new THREE.PMREMGenerator(renderer);pmrem.compileEquirectangularShader();
    scene.environment=pmrem.fromEquirectangular(tex).texture;
    tex.dispose();pmrem.dispose();
  })();

  // ---------- lighting ----------
  const hemi=new THREE.HemisphereLight(TH.hemiSky,TH.hemiGround,TH.hemiInt);scene.add(hemi);
  const amb=new THREE.AmbientLight(TH.ambColor,TH.ambInt);scene.add(amb);
  const sun=new THREE.DirectionalLight(TH.sunColor,TH.sunInt);
  sun.position.set(...TH.sunPos);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);
  const SS=340;
  sun.shadow.camera.left=-SS;sun.shadow.camera.right=SS;sun.shadow.camera.top=SS;sun.shadow.camera.bottom=-SS;
  sun.shadow.camera.near=1;sun.shadow.camera.far=1400;sun.shadow.bias=-0.0004;sun.shadow.normalBias=0.6;
  scene.add(sun);scene.add(sun.target);
  const fill=new THREE.DirectionalLight(TH.fillColor,TH.fillInt);fill.position.set(...TH.fillPos);scene.add(fill);

  // ---------- sky dome ----------
  (function sky(){
    const g=new THREE.SphereGeometry(2600,32,20);
    const m=new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,uniforms:{
      top:{value:new THREE.Color(TH.sky.top)},mid:{value:new THREE.Color(TH.sky.mid)},bot:{value:new THREE.Color(TH.sky.bot)},
      sun:{value:new THREE.Vector3(...TH.sunPos).normalize()}},
      vertexShader:`varying vec3 vp;void main(){vp=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader:`varying vec3 vp;uniform vec3 top,mid,bot,sun;void main(){float h=clamp(vp.y*1.1+0.15,0.0,1.0);
        vec3 c=mix(bot,mid,smoothstep(0.0,0.42,h));c=mix(c,top,smoothstep(0.4,0.95,h));
        float s=max(dot(vp,sun),0.0);c+=vec3(1.0,0.6,0.25)*pow(s,7.0)*0.9;c+=vec3(1.0,0.5,0.3)*pow(s,60.0)*1.4;
        gl_FragColor=vec4(c,1.0);}`});
    scene.add(new THREE.Mesh(g,m));
  })();
  // sun billboard
  (function sunDisc(){
    const c=document.createElement('canvas');c.width=c.height=128;const x=c.getContext('2d');
    const gr=x.createRadialGradient(64,64,4,64,64,64);gr.addColorStop(0,'rgba(255,245,220,1)');gr.addColorStop(.3,'rgba(255,200,120,.9)');gr.addColorStop(1,'rgba(255,160,90,0)');
    x.fillStyle=gr;x.fillRect(0,0,128,128);
    const s=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),blending:THREE.AdditiveBlending,depthWrite:false,depthTest:false}));
    const d=new THREE.Vector3(...TH.sunPos).normalize().multiplyScalar(1900);
    s.scale.set(340,340,1);s.position.copy(d);scene.add(s);
  })();

  // ---------- shared mesh helpers (exposed to the city via api) ----------
  const winTexPool=[];
  function windowTex(cols,rows,base,lit){
    const c=document.createElement('canvas');c.width=cols*16;c.height=rows*16;const x=c.getContext('2d');
    x.fillStyle=base;x.fillRect(0,0,c.width,c.height);
    for(let r=0;r<rows;r++)for(let cc=0;cc<cols;cc++){const on=rand()<0.34;x.fillStyle=on?lit:'rgba(20,26,40,0.9)';x.fillRect(cc*16+3,r*16+3,10,11);}
    const t=new THREE.CanvasTexture(c);t.anisotropy=4;return t;
  }
  function buildCar(color){
    const g=new THREE.Group();
    const body=new THREE.Mesh(new THREE.BoxGeometry(2.1,0.9,4.4),new THREE.MeshStandardMaterial({color,roughness:0.35,metalness:0.5}));
    body.position.y=0.75;body.castShadow=true;g.add(body);
    const cabin=new THREE.Mesh(new THREE.BoxGeometry(1.8,0.7,2.2),new THREE.MeshStandardMaterial({color:0x1a1e28,roughness:0.2,metalness:0.4,emissive:0x0a0c14}));
    cabin.position.set(0,1.35,-0.2);cabin.castShadow=true;g.add(cabin);
    const wheelG=new THREE.CylinderGeometry(0.5,0.5,0.4,12);const wheelM=new THREE.MeshStandardMaterial({color:0x111111,roughness:0.8});
    const wheels=[];
    for(const[wx,wz]of[[-1,1.4],[1,1.4],[-1,-1.4],[1,-1.4]]){
      const w=new THREE.Mesh(wheelG,wheelM);w.rotation.z=Math.PI/2;w.position.set(wx,0.5,wz);w.castShadow=true;g.add(w);
      wheels.push({front:wz>0,spin:w});
    }
    const hl=new THREE.Mesh(new THREE.SphereGeometry(0.18,8,8),new THREE.MeshBasicMaterial({color:0xfff2c8}));hl.position.set(-0.6,0.7,2.25);g.add(hl);
    const hr=hl.clone();hr.position.x=0.6;g.add(hr);
    const tl=new THREE.Mesh(new THREE.SphereGeometry(0.16,8,8),new THREE.MeshBasicMaterial({color:0xff2a1a}));tl.position.set(-0.6,0.7,-2.25);g.add(tl);
    const tr=tl.clone();tr.position.x=0.6;g.add(tr);
    return {group:g,wheels};
  }
  const trunkMat=new THREE.MeshStandardMaterial({color:0x8a6a44,roughness:1});
  const frondMat=new THREE.MeshStandardMaterial({color:0x3f7a35,roughness:0.9,side:THREE.DoubleSide});
  function palm(x,z,s=1,parent=scene){
    const g=new THREE.Group();
    const th=rr(9,15)*s;
    const trunk=new THREE.Mesh(new THREE.CylinderGeometry(0.35*s,0.6*s,th,7),trunkMat);trunk.position.y=th/2;trunk.castShadow=true;g.add(trunk);
    const crown=new THREE.Group();crown.position.y=th;const fGeo=new THREE.PlaneGeometry(1.6*s,7*s);
    for(let i=0;i<9;i++){const f=new THREE.Mesh(fGeo,frondMat);const a=i/9*Math.PI*2;f.position.set(Math.cos(a)*2.4*s,-0.3,Math.sin(a)*2.4*s);f.rotation.set(-0.9,a,0);f.castShadow=true;crown.add(f);}
    g.add(crown);g.position.set(x,0.5,z);parent.add(g);return g;
  }
  const beacons=[];
  const api={THREE,scene,renderer,rand,rr,pick,clamp,lerp,buildCar,windowTex,palm,winTexPool,
    registerBeacon:m=>beacons.push(m)};

  // ---------- ground plane (city may cover it) ----------
  (function ground(){
    const p=new THREE.Mesh(new THREE.PlaneGeometry(6000,6000),new THREE.MeshStandardMaterial({color:TH.ground,roughness:1}));
    p.rotation.x=-Math.PI/2;p.position.y=-0.05;p.receiveShadow=true;scene.add(p);
  })();

  // ---------- build the city world ----------
  const world=CITY.build(api)||{};
  const collide=world.collide||(()=>null);
  const groundH=world.groundH||(()=>0);
  const landmarks=world.landmarks||[];
  const minimapBlocks=world.minimapBlocks||[];
  const trafficPoints=world.trafficPoints||(()=>[]);
  const worldSize=world.size||1000;
  const districts=world.districts||CITY.districts||(()=>'');
  const B=CITY.bounds||{x0:-worldSize/2,x1:worldSize/2,z0:-worldSize/2,z1:worldSize/2};

  // ground-normal car tilt (terrain cities set CITY.tiltToGround)
  const _up=new THREE.Vector3(),_fw=new THREE.Vector3(),_rt=new THREE.Vector3(),_bm=new THREE.Matrix4(),_qq=new THREE.Quaternion();
  function orientCar(obj,x,z,heading,smooth){
    const e=1.6;_up.set(groundH(x-e,z)-groundH(x+e,z),2*e,groundH(x,z-e)-groundH(x,z+e)).normalize();
    _fw.set(Math.sin(heading),0,Math.cos(heading));_fw.addScaledVector(_up,-_fw.dot(_up)).normalize();
    _rt.crossVectors(_up,_fw);_bm.makeBasis(_rt,_up,_fw);
    obj.quaternion.slerp(_qq.setFromRotationMatrix(_bm),smooth);
    const y=groundH(x,z);obj.position.set(x,lerp(obj.position.y,y,smooth),z);return y;
  }

  // ---------- player ----------
  const player=buildCar(TH.carColor);scene.add(player.group);
  const START=CITY.start||{x:0,z:0,heading:0};
  const st={x:START.x,z:START.z,heading:START.heading,vf:0,vs:0,steer:0,y:groundH(START.x,START.z)};
  // A trail of recent safe road positions. `lastSafe` alone was useless for RESET:
  // it is refreshed every frame while you drive, so resetting dropped you exactly
  // where you already stood. safeTrail[0] is ~1.6s behind you, always on a road.
  let lastSafe={x:START.x,z:START.z,h:START.heading};
  const safeTrail=[{...lastSafe}];
  let trailAcc=0;

  // ---------- text / title ----------
  document.title=`${CITY.name||'Golden Hour'} — 3D City Driving`;
  const $=s=>document.querySelector(s);
  if($('#title h1'))$('#title h1').textContent=CITY.name||'GOLDEN HOUR';
  if($('#title p'))$('#title p').textContent=CITY.subtitle||'';
  if($('#overlay h1'))$('#overlay h1').textContent=CITY.name||'GOLDEN HOUR';
  if($('#overlay h2'))$('#overlay h2').textContent=CITY.tagline||CITY.subtitle||'3D CITY DRIVING';

  // ---------- controls ----------
  const keys={};
  addEventListener('keydown',e=>{const k=e.key.toLowerCase();keys[k]=true;
    if(k==='c')cycleCam();if(k==='r')respawn();if(k==='t')toggleTour();
    if(CITY.onKey)CITY.onKey(k,{st,showToast});
    if([' ','arrowup','arrowdown','arrowleft','arrowright'].includes(k))e.preventDefault();});
  addEventListener('keyup',e=>{keys[e.key.toLowerCase()]=false;});
  const touch={left:false,right:false,gas:false,brake:false,drift:false};
  function bindTouch(id,prop){const el=document.getElementById(id);if(!el)return;
    const on=e=>{e.preventDefault();touch[prop]=true;el.classList.add('on');};
    const off=e=>{e.preventDefault();touch[prop]=false;el.classList.remove('on');};
    el.addEventListener('touchstart',on,{passive:false});el.addEventListener('touchend',off);el.addEventListener('touchcancel',off);}
  if('ontouchstart'in window)document.body.classList.add('touch');
  bindTouch('tLeft','left');bindTouch('tRight','right');bindTouch('tGas','gas');bindTouch('tBrake','brake');bindTouch('tDrift','drift');
  const tCam=document.getElementById('tCam');if(tCam)tCam.addEventListener('touchstart',e=>{e.preventDefault();cycleCam();});
  const tReset=document.getElementById('tReset');
  if(tReset)tReset.addEventListener('touchstart',e=>{e.preventDefault();respawn();});
  const tTour=document.getElementById('tTour');if(tTour)tTour.addEventListener('touchstart',e=>{e.preventDefault();toggleTour();});

  // ---------- camera modes ----------
  let viewMode=0; // 0 chase, 1 hood, 2 cinematic
  const camPos=new THREE.Vector3(START.x,8,START.z+18);
  const camLook=new THREE.Vector3();
  function cycleCam(){viewMode=(viewMode+1)%3;showToast(['CHASE','HOOD','CINEMATIC'][viewMode]);}

  // ---------- HUD / toast ----------
  const speedEl=document.getElementById('speed');
  const gearEl=document.getElementById('gear');
  const toastEl=document.getElementById('toast');
  function showToast(t){if(!toastEl)return;toastEl.textContent=t;toastEl.style.opacity=1;clearTimeout(showToast._t);showToast._t=setTimeout(()=>toastEl.style.opacity=0,1200);}
  let nearLm=null;
  function locationLabel(x,z){
    let best=null,bd=1e9;
    for(const lm of landmarks){const d=Math.hypot(x-lm.x,z-lm.z);if(d<bd){bd=d;best=lm;}}
    if(best&&bd<95){if(nearLm!==best){nearLm=best;showToast('◉ '+best.name);}return '◉ '+best.name;}
    if(bd>140)nearLm=null;
    return districts(x,z);
  }
  function respawn(){
    let to=safeTrail[0], home=false;
    if(!to||Math.hypot(st.x-to.x,st.z-to.z)<3){to={x:START.x,z:START.z,h:START.heading};home=true;}
    st.x=to.x;st.z=to.z;st.heading=to.h;st.vf=0;st.vs=0;st.steer=0;st.y=groundH(to.x,to.z);
    // snap the car and the camera, otherwise both lerp across the map
    if(CITY.tiltToGround)st.y=orientCar(player.group,st.x,st.z,st.heading,1);
    else player.group.position.set(st.x,st.y,st.z);
    camPos.set(st.x-Math.sin(st.heading)*14,st.y+7,st.z-Math.cos(st.heading)*14);
    safeTrail.length=0;safeTrail.push({x:to.x,z:to.z,h:to.h});trailAcc=0;
    showToast(home?'RESET · BACK TO START':'RESET');
  }

  // ---------- landmark tour ----------
  const cpRing=new THREE.Mesh(new THREE.TorusGeometry(11,1.3,10,36),new THREE.MeshBasicMaterial({color:0x6fd6ff}));
  cpRing.rotation.x=Math.PI/2;cpRing.visible=false;scene.add(cpRing);
  const cpBeam=new THREE.Mesh(new THREE.CylinderGeometry(2,2,240,12,1,true),new THREE.MeshBasicMaterial({color:0x6fd6ff,transparent:true,opacity:0.22,side:THREE.DoubleSide,depthWrite:false}));
  cpBeam.visible=false;scene.add(cpBeam);
  const tour={active:false,idx:0,visited:new Set(),t0:0,done:false};
  const tourEl=document.getElementById('tour');
  function toggleTour(){
    if(!landmarks.length)return;
    tour.active=!tour.active;
    if(tour.active){tour.visited=new Set();tour.idx=0;tour.done=false;tour.t0=game.t;showToast('★ LANDMARK TOUR — follow the beam');}
    else{cpRing.visible=cpBeam.visible=false;if(tourEl)tourEl.style.display='none';showToast('TOUR OFF');}
  }
  function updateTour(){
    if(!tour.active)return;
    while(tour.idx<landmarks.length&&tour.visited.has(tour.idx))tour.idx++;
    if(tour.idx>=landmarks.length){cpRing.visible=cpBeam.visible=false;
      if(!tour.done){tour.done=true;const s=(game.t-tour.t0).toFixed(1);showToast('🏁 TOUR COMPLETE · '+s+'s');if(tourEl)tourEl.textContent='🏁 ALL '+landmarks.length+' LANDMARKS · '+s+'s';}
      return;}
    const tgt=landmarks[tour.idx];
    const d=Math.hypot(st.x-tgt.x,st.z-tgt.z);
    cpRing.position.set(tgt.x,groundH(tgt.x,tgt.z)+3,tgt.z);cpBeam.position.set(tgt.x,groundH(tgt.x,tgt.z)+110,tgt.z);cpRing.visible=cpBeam.visible=true;
    const p=1+Math.sin(game.t*4)*0.14;cpRing.scale.set(p,p,1);
    if(d<44){tour.visited.add(tour.idx);tour.idx++;showToast('✓ '+tgt.name+'   ('+tour.visited.size+'/'+landmarks.length+')');return;}
    if(tourEl){tourEl.style.display='block';tourEl.textContent='TOUR ▸ '+tgt.name+'   '+Math.round(d)+'m   ('+tour.visited.size+'/'+landmarks.length+')';}
  }

  // ---------- start / audio ----------
  const overlay=document.getElementById('overlay');
  let started=false,actx,eng;
  function initEngineSound(){
    const o=actx.createOscillator();const g=actx.createGain();const o2=actx.createOscillator();
    o.type='sawtooth';o2.type='square';o.frequency.value=60;o2.frequency.value=30;
    g.gain.value=0.0;const f=actx.createBiquadFilter();f.type='lowpass';f.frequency.value=600;
    o.connect(f);o2.connect(f);f.connect(g);g.connect(actx.destination);o.start();o2.start();eng={o,o2,g};
  }
  function start(){if(started)return;started=true;if(overlay){overlay.style.opacity=0;setTimeout(()=>overlay.style.display='none',800);}
    try{actx=new(window.AudioContext||window.webkitAudioContext)();initEngineSound();}catch(e){}
    setTimeout(()=>{const t=document.getElementById('title'),h=document.getElementById('hint');if(t)t.style.opacity=0;if(h)h.style.opacity=0;},7000);}
  const startBtn=document.getElementById('startBtn');
  if(startBtn){startBtn.addEventListener('click',start);startBtn.addEventListener('touchstart',e=>{e.preventDefault();start();});}

  // ---------- minimap ----------
  const miniC=document.getElementById('mini');const mtx=miniC&&miniC.getContext('2d');
  if(miniC){miniC.width=miniC.width||150;}
  function drawMini(){
    if(!mtx)return;
    const R=miniC.width, sc=R/(worldSize*1.1);
    mtx.clearRect(0,0,R,R);mtx.fillStyle='rgba(30,20,16,0.5)';mtx.fillRect(0,0,R,R);
    mtx.save();mtx.translate(R/2,R/2);
    mtx.fillStyle='rgba(120,120,130,0.5)';
    for(const b of minimapBlocks)mtx.fillRect(b.x*sc-1.3,b.z*sc-1.3,2.6,2.6);
    mtx.fillStyle='rgba(255,180,90,0.7)';
    for(const t of trafficPoints())mtx.fillRect(t.x*sc-0.8,t.z*sc-0.8,1.6,1.6);
    const lim=R/2-9, showLbl=R>=140;mtx.font='7px -apple-system,Arial';mtx.textAlign='center';
    for(const lm of landmarks){const px=clamp(lm.x*sc,-lim,lim),pz=clamp(lm.z*sc,-lim,lim);
      mtx.fillStyle='#ffd45a';mtx.save();mtx.translate(px,pz);mtx.rotate(Math.PI/4);mtx.fillRect(-2.6,-2.6,5.2,5.2);mtx.restore();
      if(showLbl&&lm.short){mtx.fillStyle='rgba(20,14,10,0.85)';mtx.fillRect(px-9,pz-11,18,7);mtx.fillStyle='#ffe6a0';mtx.fillText(lm.short,px,pz-5);}}
    if(tour.active&&tour.idx<landmarks.length){const lm=landmarks[tour.idx];const px=clamp(lm.x*sc,-lim,lim),pz=clamp(lm.z*sc,-lim,lim);
      mtx.strokeStyle='#6fd6ff';mtx.lineWidth=1.6;mtx.beginPath();mtx.arc(px,pz,6.5,0,7);mtx.stroke();}
    mtx.fillStyle='#ff4d3d';mtx.beginPath();
    const px=st.x*sc,pz=st.z*sc;
    mtx.moveTo(px+Math.sin(st.heading)*4,pz+Math.cos(st.heading)*4);
    mtx.lineTo(px+Math.sin(st.heading+2.5)*3,pz+Math.cos(st.heading+2.5)*3);
    mtx.lineTo(px+Math.sin(st.heading-2.5)*3,pz+Math.cos(st.heading-2.5)*3);
    mtx.closePath();mtx.fill();mtx.restore();
  }

  // ---------- resize ----------
  addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);composer.setSize(innerWidth,innerHeight);});

  // ---------- physics ----------
  function step(dt){
    let th=0,steerIn=0;
    if(keys['w']||keys['arrowup']||touch.gas)th=1;
    if(keys['s']||keys['arrowdown']||touch.brake)th=-1;
    if(keys['a']||keys['arrowleft']||touch.left)steerIn=-1;
    if(keys['d']||keys['arrowright']||touch.right)steerIn=1;
    const drifting=keys[' ']||touch.drift;

    st.steer=lerp(st.steer,steerIn,1-Math.exp(-9*dt));
    const maxF=54;
    if(th>0)st.vf+=th*34*dt;
    else if(th<0){if(st.vf>0)st.vf+=th*46*dt;else st.vf+=th*22*dt;}
    st.vf*=(1-(drifting?0.4:0.9)*dt*0.5);
    st.vf-=Math.sign(st.vf)*8*dt;
    st.vf=clamp(st.vf,-18,maxF);
    if(Math.abs(st.vf)<0.05)st.vf=0;

    const spd=Math.abs(st.vf);
    const turn=st.steer*2.4*dt*clamp(spd/7,0,1)/(1+spd*0.015);
    st.heading-=turn;  // steer right (+) curves toward screen-right
    if(drifting)st.vs+=st.steer*-Math.sign(st.vf||1)*spd*0.5*dt;
    st.vs*=(1-(drifting?2.2:6.5)*dt);

    const fx=Math.sin(st.heading),fz=Math.cos(st.heading);
    const rxc=Math.cos(st.heading),rzc=-Math.sin(st.heading);
    if(CITY.slopeGravity){const e=2.0,gx=(groundH(st.x+e,st.z)-groundH(st.x-e,st.z))/(2*e),gz=(groundH(st.x,st.z+e)-groundH(st.x,st.z-e))/(2*e);
      const ax=-9.8*0.5*gx,az=-9.8*0.5*gz;st.vf+=(ax*fx+az*fz)*dt;st.vs+=(ax*rxc+az*rzc)*dt;}
    let nx=st.x+(fx*st.vf+rxc*st.vs)*dt;
    let nz=st.z+(fz*st.vf+rzc*st.vs)*dt;

    if(collide(nx,nz)){
      const ox=collide(nx,st.z),oz2=collide(st.x,nz);
      if(!ox){nz=st.z;}else if(!oz2){nx=st.x;}else{nx=st.x;nz=st.z;}
      st.vf*=0.3;st.vs*=0.3;
    }
    nx=clamp(nx,B.x0,B.x1);nz=clamp(nz,B.z0,B.z1);
    st.x=nx;st.z=nz;st.y=groundH(st.x,st.z);
    if(world.onVoid&&world.onVoid(st.x,st.z)){respawn();return;}
    if(!collide(st.x,st.z)&&spd>2&&st.y>(CITY.safeMinY??-1e9)){
      lastSafe={x:st.x,z:st.z,h:st.heading};
      trailAcc+=dt;
      if(trailAcc>0.4){trailAcc=0;safeTrail.push({...lastSafe});if(safeTrail.length>5)safeTrail.shift();}
    }

    if(CITY.tiltToGround){st.y=orientCar(player.group,st.x,st.z,st.heading,1-Math.exp(-14*dt));}
    else{player.group.position.set(st.x,st.y,st.z);
      player.group.rotation.y=st.heading-(drifting?st.steer*0.25:0);
      player.group.rotation.z=lerp(player.group.rotation.z,-st.steer*spd*0.006,0.1);}
    for(const w of player.wheels)w.spin.rotation.x+=st.vf*dt/0.5;

    if(world.update)world.update(dt);

    if(speedEl)speedEl.firstChild.textContent=Math.round(spd*2.2);
    if(gearEl)gearEl.textContent=locationLabel(st.x,st.z);
    updateTour();

    if(eng){const rpm=60+spd*7+(th>0?18:0);eng.o.frequency.value=rpm;eng.o2.frequency.value=rpm*0.5;
      eng.g.gain.value=lerp(eng.g.gain.value,clamp(0.02+spd*0.0016,0,0.09),0.1);if(actx.state==='suspended')actx.resume();}
  }

  function updateCamera(dt){
    const fx=Math.sin(st.heading),fz=Math.cos(st.heading);const spd=Math.abs(st.vf);const y=st.y;
    if(viewMode===2){const t=game.t*0.25;const tp=new THREE.Vector3(st.x+Math.sin(t)*46,y+32+Math.sin(t*0.5)*6,st.z+Math.cos(t)*46);
      camPos.lerp(tp,1-Math.exp(-3*dt));camera.position.copy(camPos);camera.lookAt(st.x,y+3,st.z);
      if(camera.fov!==60){camera.fov=60;camera.updateProjectionMatrix();}}
    else if(viewMode===1){const tp=new THREE.Vector3(st.x+fx*1.6,y+2.0,st.z+fz*1.6);
      camPos.lerp(tp,1-Math.exp(-16*dt));camera.position.copy(camPos);camLook.set(st.x+fx*24,y+2.0,st.z+fz*24);camera.lookAt(camLook);
      const tf=62+spd*0.3;if(Math.abs(camera.fov-tf)>0.1){camera.fov=lerp(camera.fov,tf,0.08);camera.updateProjectionMatrix();}}
    else{const back=13+spd*0.14;const tp=new THREE.Vector3(st.x-fx*back,y+6.5+spd*0.03,st.z-fz*back);
      tp.y=Math.max(tp.y,groundH(tp.x,tp.z)+1.8);
      camPos.lerp(tp,1-Math.exp(-6*dt));camera.position.copy(camPos);camLook.set(st.x+fx*8,y+1.8,st.z+fz*8);camera.lookAt(camLook);
      const tf=60+spd*0.32;if(Math.abs(camera.fov-tf)>0.1){camera.fov=lerp(camera.fov,tf,0.08);camera.updateProjectionMatrix();}}
    sun.position.set(st.x+TH.sunPos[0],TH.sunPos[1],st.z+TH.sunPos[2]);sun.target.position.set(st.x,st.y,st.z);
  }

  // ---------- loop ----------
  let last=performance.now(),blink=0;
  const game=window.__game={t:0,speed:0,x:st.x,z:st.z,frames:0};
  function frame(now){
    requestAnimationFrame(frame);
    const dt=Math.min(0.05,(now-last)/1000);last=now;
    if(started)step(dt);
    updateCamera(dt);drawMini();
    blink+=dt;const bo=(Math.sin(blink*4)>0);for(const b of beacons)b.visible=bo;
    composer.render();
    game.t+=dt;game.speed=Math.abs(st.vf);game.x=st.x;game.z=st.z;game.frames++;
  }
  requestAnimationFrame(frame);

  return {scene,camera,renderer,state:st,showToast,toggleTour,start};
}
