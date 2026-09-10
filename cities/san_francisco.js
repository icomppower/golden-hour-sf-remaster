// ============================================================================
//  CITY: San Francisco — "Golden Hour"
//  Terrain city: coastline + hills, Golden Gate + Bay Bridge, cable cars, and
//  a library of ~25 SF landmark types. Ported onto the shared engine (core
//  parity: uses the engine's cameras/HUD/minimap/tour; SF-only night mode,
//  aerial/overlook cameras and 3D map labels were dropped). ?city=san_francisco
// ============================================================================
export const CITY = {
  id:'san_francisco',
  name:'GOLDEN HOUR',
  subtitle:'SAN FRANCISCO · 金色黃昏',
  tagline:'SAN FRANCISCO SUNSET DRIVE · 金色黃昏',
  seed:1337,
  tiltToGround:true, slopeGravity:true, safeMinY:1,
  theme:{
    exposure:1.12, fogColor:0xd97b52, fog:0.00105, carColor:0xc22b20,
    sunPos:[-235,73,-460], sunColor:0xffa565, sunInt:2.6,
    sky:{top:0x14224f, mid:0x7a3f5c, bot:0xff8a44},
    hemiSky:0x8a6bb8, hemiGround:0x4a3428, hemiInt:0.62, ambColor:0xffc29a, ambInt:0.22,
    fillColor:0x6a5aa8, fillInt:0.35, fillPos:[200,120,300], ground:0x2b2622,
    env:{stops:[[0,'#14224f'],[0.4,'#c05a3a'],[0.6,'#ff9e5a'],[1,'#3a2622']],sun:[40,44,44]},
    bloom:[0.55,0.65,0.84],
  },
  start:{x:-300,z:120,heading:Math.PI},
  bounds:{x0:-520,x1:640,z0:-820,z1:540},

  districts(x,z){
    if(z<-250)return'THE HEADLANDS';
    if(x>120&&z<-120)return'FINANCIAL DISTRICT';
    if(x<-260)return'THE AVENUES';
    if(z>60)return'THE MISSION';
    return'SAN FRANCISCO';
  },

  build(api){
    const {THREE,scene,rand,clamp,lerp,buildCar,registerBeacon}=api;
    const smoothstep=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
    const gauss=(x,z,cx,cz,h,s)=>h*Math.exp(-((x-cx)**2+(z-cz)**2)/(2*s*s));

    // ---- data ---------------------------------------------------------------
    const D={
      mesh:{W:1720,D:1560,SX:246,SZ:222,CX:0,CZ:-110}, sunDir:[-0.45,0.14,-0.88],
      coast:{north:{at:-245,blend:60},east:{at:285,blend:67},west:{at:-455,blend:50},south:null},
      waterDepth:-13, baseHeight:8, undulation:{amp:3.0,fx:0.021,fz:0.019},
      hills:[
        {x:70,z:-150,h:46,s:52},{x:35,z:-180,h:44,s:48},{x:110,z:-205,h:34,s:44},
        {x:-60,z:-140,h:42,s:70},{x:205,z:-140,h:22,s:42},{x:-160,z:-60,h:28,s:46},
        {x:-30,z:45,h:82,s:92},{x:-70,z:210,h:60,s:88},{x:-70,z:72,h:44,s:54},
        {x:-120,z:15,h:32,s:52},{x:45,z:195,h:30,s:68},{x:155,z:82,h:26,s:66},
        {x:-350,z:-40,h:18,s:92},{x:-350,z:125,h:16,s:92},
      ],
      islands:[{x:-330,z:-780,h:58,s:130},{x:-120,z:-820,h:46,s:150},{x:40,z:-360,h:16,s:32},
        {x:-140,z:-430,h:20,s:44},{x:430,z:-30,h:30,s:50},{x:620,z:10,h:48,s:120}],
      grid:{x:[-450,300,75],z:[-240,510,75],roadW:12}, downtown:{x:180,z:-165,s:82},
      park:{x0:-430,x1:-90,z0:-40,z1:70}, trees:{count:560},
      bridges:[
        {label:'Golden Gate Bridge',axis:'z',line:-300,span:[-250,-658],deckY:24,towers:[-340,-570],color:0xe0451f,towerH:68,dip:6,endRise:6,rampIn:50,rampOut:48},
        {label:'Bay Bridge',axis:'x',line:-90,span:[248,592],deckY:20,towers:[330,515],anchor:430,color:0x9aa0a8,towerH:40,dip:7,mid:22,endRise:3,rampIn:42,rampOut:36},
      ],
      switchback:{x:35,z0:-186,z1:-244,amp:16,turns:4.5,yTop:46,yBot:20,color:0xb0563c},
      clearCircles:[[35,-206,30]],
      police:{parked:[150,-100],patrol:{axis:'z',fixed:150,a:-238,b:300}},
      cableCars:[{axis:'z',fixed:75,a:-232,b:-20,speed:9,cars:2}],
      landmarks:[
        {type:'pyramid',x:175,z:-172,h:165,label:'Transamerica Pyramid'},
        {type:'crownTower',x:205,z:-150,h:150,clear:24,label:'Salesforce Tower'},
        {type:'darkTower',x:150,z:-160,h:122,clear:15,label:'555 California'},
        {type:'coitTower',x:110,z:-205,label:'Coit Tower'},
        {type:'antennaTower',x:-30,z:45,label:'Sutro Tower'},
        {type:'cathedral',x:72,z:-150,clear:20,label:'Grace Cathedral'},
        {type:'church',x:70,z:-200,clear:17,label:'Saints Peter & Paul'},
        {type:'clockTower',x:235,z:-205,clear:42,label:'Ferry Building'},
        {type:'domeCivic',x:5,z:-70,clear:40,label:'City Hall'},
        {type:'rotunda',x:-175,z:-215,clear:32,label:'Palace of Fine Arts'},
        {type:'column',x:130,z:-120,clear:15,label:'Union Square'},
        {type:'pagoda',x:-75,z:-95,clear:20,label:'Japantown Peace Pagoda'},
        {type:'rowHouses',x:-110,z:-55,clear:32,label:'Painted Ladies'},
        {type:'theatre',x:-70,z:100,clear:32,blade:'CASTRO',flag:['#e40303','#ff8c00','#ffed00','#008026','#004dff','#750787'],label:'Castro Theatre'},
        {type:'mission',x:5,z:100,clear:18,label:'Mission Dolores'},
        {type:'copperTower',x:-165,z:15,clear:22,label:'de Young Museum'},
        {type:'glasshouse',x:-115,z:-2,clear:24,label:'Conservatory of Flowers'},
        {type:'windmill',x:-425,z:30,clear:22,label:'Dutch Windmill'},
        {type:'stadium',x:250,z:-45,clear:50,label:'Oracle Park'},
        {type:'bottle',x:222,z:-18,text:'Coca-Cola',color:0xd21a1a,label:'Coca-Cola Bottle'},
        {type:'islandPrison',x:40,z:-360,label:'Alcatraz'},
        {type:'policeStation',x:165,z:-100,sign:'S F P D',label:'SFPD'},
        {type:'gate',x:100,z:-105,plaque:'天下為公',clearRect:[78,122,-182,-98],label:'Chinatown · Dragon Gate'},
        {type:'wharf',x:20,z:-232,clear:26,label:"Fisherman's Wharf"},
        {type:'marker',x:35,z:-215,label:'Lombard Street'},
      ],
    };

    // ---- terrain height -----------------------------------------------------
    const C=D.coast, WATER_Y=D.waterDepth, BASE_H=D.baseHeight, U=D.undulation;
    function coast(x,z){let f=1;
      if(C.north)f=Math.min(f,smoothstep(C.north.at-C.north.blend,C.north.at,z));
      if(C.south)f=Math.min(f,1-smoothstep(C.south.at,C.south.at+C.south.blend,z));
      if(C.east)f=Math.min(f,1-smoothstep(C.east.at,C.east.at+C.east.blend,x));
      if(C.west)f=Math.min(f,smoothstep(C.west.at-C.west.blend,C.west.at,x));return f;}
    function cityLand(x,z){let h=BASE_H;for(const g of D.hills)h+=gauss(x,z,g.x,g.z,g.h,g.s);h+=U.amp*Math.sin(x*U.fx)*Math.cos(z*U.fz);return h;}
    function terrainH(x,z){let h=lerp(WATER_Y,cityLand(x,z),coast(x,z));for(const g of D.islands)h+=gauss(x,z,g.x,g.z,g.h,g.s);return h;}
    const BRIDGES=D.bridges.map(bd=>{
      const axis=bd.axis,line=bd.line,deckY=bd.deckY??24,s0=bd.span[0],s1=bd.span[1],lo=Math.min(s0,s1),hi=Math.max(s0,s1);
      const at=(s)=>axis==='z'?terrainH(line,s):terrainH(s,line);const y0=at(s0),y1=at(s1);const rampIn=bd.rampIn??50,rampOut=bd.rampOut??48;
      const profile=(s)=>{if(s<lo||s>hi)return -Infinity;const dIn=Math.abs(s-s0),dOut=Math.abs(s-s1);
        if(dIn<rampIn)return lerp(y0,deckY,smoothstep(0,rampIn,dIn));if(dOut<rampOut)return lerp(deckY,y1,smoothstep(rampOut,0,dOut));return deckY;};
      const peak=deckY+(bd.towerH??42),dip=deckY+(bd.dip??7),mid=deckY+(bd.mid??22),low=deckY+(bd.endRise??4);
      const T=bd.towers||[],A=bd.anchor;const keys=[[s0,low]];
      if(T.length){if(A!=null)keys.push([T[0],peak],[(T[0]+A)/2,dip],[A,mid],[(A+T[1])/2,dip],[T[1],peak]);
        else if(T.length>1)keys.push([T[0],peak],[(T[0]+T[1])/2,dip],[T[1],peak]);else keys.push([T[0],peak]);}
      keys.push([s1,low]);keys.sort((a,b)=>a[0]-b[0]);
      const cable=(s)=>{for(let i=0;i<keys.length-1;i++){const[a,ya]=keys[i],[b,yb]=keys[i+1];if(s>=a&&s<=b)return lerp(ya,yb,smoothstep(a,b,s));}return low;};
      return {...bd,axis,line,deckY,s0,s1,lo,hi,profile,cable,peak};
    });
    const LB=D.switchback;
    function switchPath(z){const t=clamp((z-LB.z0)/(LB.z1-LB.z0),0,1);return {x:LB.x+LB.amp*Math.sin(t*Math.PI*LB.turns),y:lerp(LB.yTop,LB.yBot,smoothstep(0,1,t)),t};}
    function switchHeight(x,z){if(!LB||z>LB.z0+3||z<LB.z1-3)return null;const p=switchPath(clamp(z,LB.z1,LB.z0));const d=Math.abs(x-p.x),HALF=5.5,EDGE=7;if(d>HALF+EDGE)return null;return {y:p.y,blend:smoothstep(HALF+EDGE,HALF,d)};}
    function groundH(x,z){let t=terrainH(x,z);
      for(const b of BRIDGES){const along=b.axis==='z'?z:x,perp=b.axis==='z'?x:z;if(Math.abs(perp-b.line)<8.5&&along>=b.lo&&along<=b.hi)t=Math.max(t,b.profile(along));}
      if(LB){const L=switchHeight(x,z);if(L)return lerp(t,L.y,L.blend);}return t;}

    // ---- terrain mesh -------------------------------------------------------
    {const T=D.mesh;const geo=new THREE.PlaneGeometry(T.W,T.D,T.SX,T.SZ);geo.rotateX(-Math.PI/2);
      const pos=geo.attributes.position,colors=new Float32Array(pos.count*3),c=new THREE.Color(),G=D.park;
      for(let i=0;i<pos.count;i++){const x=pos.getX(i)+T.CX,z=pos.getZ(i)+T.CZ,h=terrainH(x,z);pos.setY(i,h);pos.setX(i,x);pos.setZ(i,z);
        const e=2.5,slope=Math.hypot(terrainH(x+e,z)-terrainH(x-e,z),terrainH(x,z+e)-terrainH(x,z-e))/(2*e);
        c.setRGB(0.30+0.11*rand(),0.26+0.07*rand(),0.12+0.04*rand());
        if(slope>0.35)c.lerp(new THREE.Color(0.28,0.24,0.22),smoothstep(0.35,0.7,slope));
        if(coast(x,z)>0.6&&z<(T.CZ+T.D/2-40))c.lerp(new THREE.Color(0.40,0.36,0.32),0.55);
        if(G&&x>G.x0&&x<G.x1&&z>G.z0&&z<G.z1&&h>1)c.lerp(new THREE.Color(0.22,0.34,0.18),0.7);
        if(h>-1.5&&h<2.5)c.lerp(new THREE.Color(0.68,0.58,0.42),0.8);if(h<-1.5)c.setRGB(0.08,0.12,0.13);
        colors[i*3]=c.r;colors[i*3+1]=c.g;colors[i*3+2]=c.b;}
      geo.setAttribute('color',new THREE.BufferAttribute(colors,3));geo.computeVertexNormals();
      const m=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({vertexColors:true,roughness:1,metalness:0,envMapIntensity:0.15}));m.receiveShadow=true;scene.add(m);}

    // ---- water --------------------------------------------------------------
    const SUN_DIR=new THREE.Vector3(...D.sunDir).normalize();
    const waterMat=new THREE.ShaderMaterial({fog:true,
      uniforms:THREE.UniformsUtils.merge([THREE.UniformsLib.fog,{time:{value:0},sunDir:{value:SUN_DIR},night:{value:0}}]),
      vertexShader:`
        #include <fog_pars_vertex>
        varying vec3 vWorld;
        void main(){vec4 wp=modelMatrix*vec4(position,1.0);vWorld=wp.xyz;vec4 mvPosition=viewMatrix*wp;gl_Position=projectionMatrix*mvPosition;
        #include <fog_vertex>
        }`,
      fragmentShader:`
        #include <fog_pars_fragment>
        varying vec3 vWorld;uniform float time;uniform vec3 sunDir;uniform float night;
        void main(){vec3 p=vWorld;float t=time;
          vec3 n=normalize(vec3(sin(p.x*0.08+t*1.3)*0.05+sin(p.x*0.21+p.z*0.09+t*2.1)*0.03+sin((p.x+p.z)*0.05+t*0.7)*0.04,1.0,sin(p.z*0.07+t*1.1)*0.05+sin((p.z-p.x)*0.17+t*1.7)*0.03));
          vec3 V=normalize(cameraPosition-p);float fres=pow(1.0-max(dot(V,n),0.0),3.0);vec3 refDir=reflect(-V,n);
          vec3 skyRef=mix(vec3(0.95,0.48,0.26),vec3(0.22,0.26,0.46),clamp(refDir.y*2.4,0.0,1.0));
          vec3 deep=vec3(0.05,0.09,0.15);vec3 col=mix(deep,skyRef,0.22+0.68*fres);
          vec3 H=normalize(V+sunDir);vec3 ns=normalize(n*vec3(2.4,1.0,1.15));
          col+=vec3(1.3,0.75,0.38)*pow(max(dot(H,ns),0.0),160.0)*2.2;col+=vec3(1.0,0.55,0.28)*pow(max(dot(H,ns),0.0),24.0)*0.35;
          gl_FragColor=vec4(col,1.0);
        #include <fog_fragment>
        }`});
    {const w=new THREE.Mesh(new THREE.PlaneGeometry(4200,4200,1,1),waterMat);w.rotation.x=-Math.PI/2;w.position.set(0,0,-150);scene.add(w);}

    // ---- roads (ribbons clipped to land) ------------------------------------
    const GR=D.grid,XS=[],ZS=[];
    for(let x=GR.x[0];x<=GR.x[1];x+=GR.x[2])XS.push(x);
    for(let z=GR.z[0];z<=GR.z[1];z+=GR.z[2])ZS.push(z);
    const ROAD_W=GR.roadW||12,LIFT=0.13,lampSpots=[],dashMats=[];
    function onRoadLand(x,z){for(const b of BRIDGES){const perp=b.axis==='z'?x:z,along=b.axis==='z'?z:x;if(Math.abs(perp-b.line)<9&&along>=b.lo-4&&along<=b.hi+4)return true;}return coast(x,z)>0.5;}
    {const posArr=[],colArr=[],idxArr=[];
      function addRibbon(pts,width){const base=posArr.length/3;
        for(let i=0;i<pts.length;i++){const p=pts[i],q=pts[Math.min(i+1,pts.length-1)],q0=pts[Math.max(i-1,0)];
          let dx=q.x-q0.x,dz=q.z-q0.z;const L=Math.hypot(dx,dz)||1;dx/=L;dz/=L;const px=-dz,pz=dx;
          for(const s of[-0.5,0.5]){const vx=p.x+px*width*s,vz=p.z+pz*width*s;posArr.push(vx,groundH(vx,vz)+LIFT,vz);const g=0.045+0.014*rand();colArr.push(g,g,g+0.006);}
          if(i>0){const a=base+(i-1)*2,b=a+1,c2=base+i*2,d=c2+1;idxArr.push(a,b,c2,b,d,c2);}}}
      const _m=new THREE.Matrix4(),_q=new THREE.Quaternion(),_s=new THREE.Vector3(1,1,1);
      function decorate(pts){let acc=0,lampAcc=20,side=1;
        for(let i=1;i<pts.length;i++){const p0=pts[i-1],p1=pts[i];const dx=p1.x-p0.x,dz=p1.z-p0.z,L=Math.hypot(dx,dz);acc+=L;lampAcc+=L;
          if(acc>9){acc=0;const y0=groundH(p0.x,p0.z),y1=groundH(p1.x,p1.z);const dir=new THREE.Vector3(dx,y1-y0,dz).normalize();_q.setFromUnitVectors(new THREE.Vector3(0,0,1),dir);
            _m.compose(new THREE.Vector3(p1.x,groundH(p1.x,p1.z)+LIFT+0.02,p1.z),_q,_s);dashMats.push(_m.clone());}
          if(lampAcc>46){lampAcc=0;side*=-1;const px=-dz/L,pz=dx/L;lampSpots.push({x:p1.x+px*6.6*side,z:p1.z+pz*6.6*side});}}}
      function line(axis,fixed,from,to){const step=4*Math.sign(to-from);let run=[];const flush=()=>{if(run.length>1){addRibbon(run,ROAD_W);decorate(run);}run=[];};
        for(let s=from;(to-s)*Math.sign(to-from)>=0;s+=step){const p=axis==='z'?{x:fixed,z:s}:{x:s,z:fixed};if(onRoadLand(p.x,p.z))run.push(p);else flush();}flush();}
      const zBridge=BRIDGES.find(b=>b.axis==='x'),xBridge=BRIDGES.find(b=>b.axis==='z');const zEnd=GR.z[1]+2,xEndW=GR.x[0]-8,xEndE=GR.x[1]+8;
      for(const x of XS){const nb=xBridge&&Math.abs(x-xBridge.line)<1;line('z',x,nb?Math.min(xBridge.s1,xBridge.s0)-6:-244,zEnd);}
      for(const z of ZS){const eb=zBridge&&Math.abs(z-zBridge.line)<1;line('x',z,xEndW,eb?Math.max(zBridge.s1,zBridge.s0)+6:xEndE);}
      const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(posArr,3));geo.setAttribute('color',new THREE.Float32BufferAttribute(colArr,3));geo.setIndex(idxArr);geo.computeVertexNormals();
      const m=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({vertexColors:true,roughness:0.92,metalness:0,envMapIntensity:0.25}));m.receiveShadow=true;scene.add(m);}
    {const g=new THREE.PlaneGeometry(0.28,3.2);g.rotateX(-Math.PI/2);const inst=new THREE.InstancedMesh(g,new THREE.MeshBasicMaterial({color:0xf0e4b8,fog:true}),dashMats.length);dashMats.forEach((mat,i)=>inst.setMatrixAt(i,mat));scene.add(inst);}
    {const poleG=new THREE.CylinderGeometry(0.09,0.13,5.6,6),poleM=new THREE.MeshStandardMaterial({color:0x2a2a30,roughness:0.8});
      const headG=new THREE.SphereGeometry(0.32,8,6),headM=new THREE.MeshStandardMaterial({color:0x332a20,emissive:0xffbf7a,emissiveIntensity:2.6,roughness:0.5});
      const poles=new THREE.InstancedMesh(poleG,poleM,lampSpots.length),heads=new THREE.InstancedMesh(headG,headM,lampSpots.length);const m=new THREE.Matrix4();
      lampSpots.forEach((s,i)=>{const y=terrainH(s.x,s.z);m.makeTranslation(s.x,y+2.8,s.z);poles.setMatrixAt(i,m);m.makeTranslation(s.x,y+5.75,s.z);heads.setMatrixAt(i,m);});scene.add(poles);scene.add(heads);}

    // ---- texture helpers ----------------------------------------------------
    function makeFacade(){const c=document.createElement('canvas');c.width=128;c.height=256;const g=c.getContext('2d');const e=document.createElement('canvas');e.width=128;e.height=256;const ge=e.getContext('2d');
      g.fillStyle='#d9d5d0';g.fillRect(0,0,128,256);ge.fillStyle='#000';ge.fillRect(0,0,128,256);const cols=10,rows=30,cw=128/cols,rh=256/rows,warm=['#ffb361','#ffd9a0','#ff9e4a','#ffe9c4'];
      for(let r=0;r<rows;r++)for(let cc=0;cc<cols;cc++){const x=cc*cw+2.5,y=r*rh+2,w=cw-5,h=rh-4;g.fillStyle='#39424c';g.fillRect(x,y,w,h);if(rand()<0.24){ge.fillStyle=warm[(rand()*warm.length)|0];ge.fillRect(x,y,w,h);}}
      const map=new THREE.CanvasTexture(c);map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=4;const em=new THREE.CanvasTexture(e);em.colorSpace=THREE.SRGBColorSpace;em.anisotropy=4;return {map,em};}
    function makeText(text,w,h,bg,fg,font){const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.fillStyle=bg;g.fillRect(0,0,w,h);g.fillStyle=fg;g.font=font;g.textAlign='center';g.textBaseline='middle';g.fillText(text,w/2,h/2+4);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;return t;}
    function makeVSign(text,bg,fg){const c=document.createElement('canvas');c.width=128;c.height=512;const g=c.getContext('2d');g.fillStyle=bg;g.fillRect(0,0,128,512);g.fillStyle=fg;g.font='bold 82px Arial';g.textAlign='center';g.textBaseline='middle';for(let i=0;i<text.length;i++)g.fillText(text[i],64,(i+0.5)*512/text.length);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;return t;}
    function makeStripes(cols){const c=document.createElement('canvas');c.width=64;c.height=cols.length*8;const g=c.getContext('2d');cols.forEach((col,i)=>{g.fillStyle=col;g.fillRect(0,i*8,64,8);});const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;}

    // ---- buildings ----------------------------------------------------------
    const bldgPts=[];
    const CLEAR=[],CLEAR_RECT=[];
    for(const o of D.landmarks){if(o.clear)CLEAR.push({x:o.x,z:o.z,r:o.clear});if(o.clearRect)CLEAR_RECT.push(o.clearRect);}
    for(const c of D.clearCircles||[])CLEAR.push({x:c[0],z:c[1],r:c[2]});
    {const {map,em}=makeFacade();
      const sideM=new THREE.MeshStandardMaterial({map,emissiveMap:em,emissive:0xffffff,emissiveIntensity:0.85,roughness:0.75,metalness:0.08,envMapIntensity:0.3});
      const topM=new THREE.MeshStandardMaterial({color:0x615c55,roughness:0.95,envMapIntensity:0.1});
      const mats=[sideM,sideM,topM,topM,sideM,sideM],items=[];const dtc=D.downtown;
      for(let ix=0;ix<XS.length-1;ix++)for(let iz=0;iz<ZS.length-1;iz++){const cx=(XS[ix]+XS[ix+1])/2,cz=(ZS[iz]+ZS[iz+1])/2;if(rand()<0.13)continue;
        const dt=Math.exp(-((cx-dtc.x)**2+(cz-dtc.z)**2)/(2*dtc.s*dtc.s));const n=2+((rand()*2.6+dt*2.5)|0);
        for(let k=0;k<n;k++){const bx=cx+(rand()-0.5)*44,bz=cz+(rand()-0.5)*44;let skip=false;
          for(const r of CLEAR_RECT)if(bx>r[0]&&bx<r[1]&&bz>r[2]&&bz<r[3]){skip=true;break;}
          if(!skip)for(const c of CLEAR)if(Math.hypot(bx-c.x,bz-c.z)<c.r){skip=true;break;}if(skip)continue;
          const h0=terrainH(bx,bz);if(h0<2.5)continue;const e=3,slope=Math.hypot(terrainH(bx+e,bz)-terrainH(bx-e,bz),terrainH(bx,bz+e)-terrainH(bx,bz-e))/(2*e);if(slope>0.78)continue;
          const fw=12+rand()*18,fd=12+rand()*18;let H=Math.min((15+rand()*24)*(1+3.5*dt),155);const col=new THREE.Color();
          if(dt>0.35)col.setHSL(0.58+0.05*rand(),0.14,0.34+0.22*rand());else col.setHSL(rand(),0.16+0.16*rand(),0.60+0.20*rand());
          items.push({x:bx,z:bz,y:h0,w:fw,d:fd,h:H,col:col.clone(),rot:(rand()-0.5)*0.12});}}
      const inst=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),mats,items.length);inst.castShadow=true;inst.receiveShadow=true;
      const m=new THREE.Matrix4(),q=new THREE.Quaternion(),eu=new THREE.Euler();
      items.forEach((b,i)=>{eu.set(0,b.rot,0);q.setFromEuler(eu);m.compose(new THREE.Vector3(b.x,b.y+(b.h-16)/2,b.z),q,new THREE.Vector3(b.w,b.h+16,b.d));inst.setMatrixAt(i,m);inst.setColorAt(i,b.col);bldgPts.push({x:b.x,z:b.z});});scene.add(inst);}

    // ---- trees --------------------------------------------------------------
    {const g=new THREE.ConeGeometry(1.6,5.5,6),m=new THREE.MeshStandardMaterial({color:0x2b4026,roughness:1,envMapIntensity:0.35}),spots=[];const TR=D.trees,G=D.park;
      for(let i=0;i<TR.count;i++){let x,z;if(G&&i<210){x=G.x0+rand()*(G.x1-G.x0);z=G.z0+rand()*(G.z1-G.z0);}else{x=D.mesh.CX-D.mesh.W/2+rand()*D.mesh.W;z=D.mesh.CZ-D.mesh.D/2+rand()*D.mesh.D;}
        const h=terrainH(x,z);if(h<2)continue;let onRoad=false;for(const rx of XS)if(Math.abs(x-rx)<9)onRoad=true;for(const rz of ZS)if(Math.abs(z-rz)<9)onRoad=true;if(onRoad)continue;spots.push({x,z,h,s:0.7+rand()*1.1});}
      const inst=new THREE.InstancedMesh(g,m,spots.length);inst.castShadow=true;const mm=new THREE.Matrix4(),q=new THREE.Quaternion(),eu=new THREE.Euler();
      spots.forEach((s,i)=>{eu.set(0,rand()*6.28,0);q.setFromEuler(eu);mm.compose(new THREE.Vector3(s.x,s.h+2.6*s.s,s.z),q,new THREE.Vector3(s.s,s.s,s.s));inst.setMatrixAt(i,mm);});scene.add(inst);}

    // ---- landmarks ----------------------------------------------------------
    const LG=new THREE.Group();scene.add(LG);const anim=[];
    const ctx={THREE,terrainH,groundH,makeFacade,makeText,makeVSign,makeStripes,anim,add(m){LG.add(m);return m;},rand};
    const LIB=makeLandmarkLibrary(ctx);
    for(const o of D.landmarks){const fn=o.type==='custom'?o.build:LIB[o.type];if(fn)fn(o,ctx);}

    // ---- switchback street --------------------------------------------------
    {const brick=new THREE.MeshStandardMaterial({color:LB.color??0xb0563c,roughness:0.85,envMapIntensity:0.2});const posArr=[],idxArr=[],pts=[];
      for(let z=LB.z0;z>=LB.z1;z-=1.5){const p=switchPath(z);pts.push({x:p.x,y:p.y,z});}
      for(let i=0;i<pts.length;i++){const p=pts[i],q=pts[Math.min(i+1,pts.length-1)],q0=pts[Math.max(i-1,0)];let dx=q.x-q0.x,dz=q.z-q0.z;const L=Math.hypot(dx,dz)||1;dx/=L;dz/=L;const nx=-dz,nz=dx;
        for(const s of[-5.5,5.5])posArr.push(p.x+nx*s,p.y+0.18,p.z+nz*s);if(i>0){const a=(i-1)*2,b=a+1,c=i*2,d=c+1;idxArr.push(a,b,c,b,d,c);}}
      const rg=new THREE.BufferGeometry();rg.setAttribute('position',new THREE.Float32BufferAttribute(posArr,3));rg.setIndex(idxArr);rg.computeVertexNormals();const road=new THREE.Mesh(rg,brick);road.receiveShadow=true;scene.add(road);}

    // ---- bridge meshes ------------------------------------------------------
    for(const b of BRIDGES)buildBridgeMesh(b);
    function buildBridgeMesh(b){const steel=new THREE.MeshStandardMaterial({color:b.color??0x9aa0a8,roughness:0.5,metalness:0.55,envMapIntensity:0.6});
      const isZ=b.axis==='z',line=b.line,deckY=b.deckY;const A=(s)=>isZ?new THREE.Vector3(line,0,s):new THREE.Vector3(s,0,line);const perpV=(o)=>isZ?new THREE.Vector3(o,0,0):new THREE.Vector3(0,0,o);
      const dLo=Math.min(b.s0,b.s1),dHi=Math.max(b.s0,b.s1),midS=(dLo+dHi)/2,len=dHi-dLo;
      const deckG=isZ?new THREE.BoxGeometry(17,1.4,len):new THREE.BoxGeometry(len,1.4,17);const deck=new THREE.Mesh(deckG,steel);deck.position.copy(A(midS));deck.position.y=deckY-0.8;deck.castShadow=deck.receiveShadow=true;scene.add(deck);
      for(const ts of(b.towers||[])){for(const o of[-1,1]){const colG=isZ?new THREE.BoxGeometry(2.6,b.peak-deckY+8,3.4):new THREE.BoxGeometry(3.4,b.peak-deckY+8,2.6);const col=new THREE.Mesh(colG,steel);col.position.copy(A(ts)).add(perpV(o*7.3));col.position.y=deckY+(b.peak-deckY+8)/2-4;col.castShadow=true;scene.add(col);}
        for(const yy of[deckY+14,deckY+(b.peak-deckY)*0.7,b.peak+2]){const brG=isZ?new THREE.BoxGeometry(15,2.0,2.2):new THREE.BoxGeometry(2.2,2.0,15);const br=new THREE.Mesh(brG,steel);br.position.copy(A(ts));br.position.y=yy;scene.add(br);}
        const bcn=new THREE.Mesh(new THREE.SphereGeometry(0.5,8,6),new THREE.MeshStandardMaterial({color:0xff2211,emissive:0xff2211,emissiveIntensity:2.5}));bcn.position.copy(A(ts));bcn.position.y=b.peak+4;scene.add(bcn);registerBeacon(bcn);}
      if(b.anchor!=null){const base=(isZ?terrainH(line,b.anchor):terrainH(b.anchor,line)),ph=deckY+30-base;const pierG=isZ?new THREE.BoxGeometry(16,ph,12):new THREE.BoxGeometry(12,ph,16);const pier=new THREE.Mesh(pierG,new THREE.MeshStandardMaterial({color:0xbfb8ac,roughness:0.9}));pier.position.copy(A(b.anchor));pier.position.y=base+ph/2;pier.castShadow=true;scene.add(pier);}
      for(const o of[-1,1]){const pts=[];for(let s=dLo;s<=dHi;s+=4){const p=A(s).add(perpV(o*7.3));p.y=b.cable(s);pts.push(p);}const tube=new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts),140,0.38,6),steel);tube.castShadow=true;scene.add(tube);}
      {const segs=[];for(let s=dLo+8;s<=dHi-6;s+=7){const cy=b.cable(s);if(cy-deckY>1.5)for(const o of[-1,1])segs.push({s,cy,o});}const inst=new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07,0.07,1,4),steel,segs.length);const m=new THREE.Matrix4();
        segs.forEach((sg,i)=>{const l=sg.cy-deckY+0.5;m.makeScale(1,l,1);const pp=A(sg.s).add(perpV(sg.o*7.3));m.setPosition(pp.x,deckY+l/2-0.5,pp.z);inst.setMatrixAt(i,m);});scene.add(inst);}
      for(const o of[-1,1]){const rG=isZ?new THREE.BoxGeometry(0.4,1.0,len):new THREE.BoxGeometry(len,1.0,0.4);const r=new THREE.Mesh(rG,steel);r.position.copy(A(midS)).add(perpV(o*8.5));r.position.y=deckY+0.5;scene.add(r);}}

    // ---- car helpers, traffic, cable cars, police ---------------------------
    const _up=new THREE.Vector3(),_fw=new THREE.Vector3(),_rt=new THREE.Vector3(),_bm=new THREE.Matrix4();
    function orientOnGround(obj,x,z,heading,smooth){const e=1.6;_up.set(groundH(x-e,z)-groundH(x+e,z),2*e,groundH(x,z-e)-groundH(x,z+e)).normalize();
      _fw.set(Math.sin(heading),0,Math.cos(heading));_fw.addScaledVector(_up,-_fw.dot(_up)).normalize();_rt.crossVectors(_up,_fw);_bm.makeBasis(_rt,_up,_fw);
      obj.quaternion.slerp(new THREE.Quaternion().setFromRotationMatrix(_bm),smooth??1);const y=groundH(x,z);obj.position.set(x,smooth!=null?lerp(obj.position.y,y,smooth):y,z);}
    const traffic=[];
    {const colors=[0xd8d8dc,0x2a3a55,0x6a7a72,0x8a4a3a,0x3a3a3e,0xc2a24a],roads=[];const eastShore=(C.east?C.east.at:400)+25,westShore=(C.west?C.west.at:-400)-8;
      XS.forEach((x,i)=>{if(i%2===0&&x>westShore&&x<eastShore)roads.push({axis:'z',fixed:x,a:-238,b:GR.z[1]-30});});ZS.forEach((z,i)=>{if(i%2===1)roads.push({axis:'x',fixed:z,a:westShore,b:eastShore-30});});
      if(roads.length)for(let i=0;i<16;i++){const r=roads[(rand()*roads.length)|0],t=buildCar(colors[(rand()*colors.length)|0]);scene.add(t.group);traffic.push({car:t,road:r,dir:rand()<0.5?1:-1,speed:8+rand()*7,s:r.a+rand()*(r.b-r.a)});}}
    // police
    const policeBeacons=[];
    function makePolice(){const p=buildCar(0xf0f0f2);
      const barBase=new THREE.Mesh(new THREE.BoxGeometry(1.15,0.10,0.32),new THREE.MeshStandardMaterial({color:0x14141a}));barBase.position.set(0,1.40,-0.25);p.group.add(barBase);
      const rM=new THREE.MeshStandardMaterial({color:0x400000,emissive:0xff2020,emissiveIntensity:0.3}),bM=new THREE.MeshStandardMaterial({color:0x000040,emissive:0x2244ff,emissiveIntensity:0.3});
      const rL=new THREE.Mesh(new THREE.BoxGeometry(0.45,0.18,0.30),rM);rL.position.set(-0.28,1.53,-0.25);p.group.add(rL);const bL=new THREE.Mesh(new THREE.BoxGeometry(0.45,0.18,0.30),bM);bL.position.set(0.28,1.53,-0.25);p.group.add(bL);
      policeBeacons.push({r:rM,b:bM});scene.add(p.group);return p;}
    if(D.police){if(D.police.parked){const pk=makePolice();orientOnGround(pk.group,D.police.parked[0],D.police.parked[1],Math.PI/2+0.25);}
      if(D.police.patrol){const pt=makePolice();traffic.push({car:pt,road:D.police.patrol,dir:1,speed:13,s:D.police.patrol.a+40});}}
    // cable cars
    const cableCars=[];
    function buildCableCar(){const g=new THREE.Group();
      const body=new THREE.Mesh(new THREE.BoxGeometry(2.5,1.7,5.4),new THREE.MeshStandardMaterial({color:0x8a2a20,roughness:0.55,metalness:0.1,envMapIntensity:0.4}));body.position.y=1.5;body.castShadow=true;g.add(body);
      const skirt=new THREE.Mesh(new THREE.BoxGeometry(2.6,0.6,5.5),new THREE.MeshStandardMaterial({color:0xf0e4c0,roughness:0.6}));skirt.position.y=0.75;g.add(skirt);
      const roof=new THREE.Mesh(new THREE.BoxGeometry(2.9,0.28,5.9),new THREE.MeshStandardMaterial({color:0xd8cdb0,roughness:0.7}));roof.position.y=2.5;g.add(roof);
      const glow=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.3,0.1),new THREE.MeshStandardMaterial({color:0x442200,emissive:0xffe08a,emissiveIntensity:1.8}));glow.position.set(0,1.5,2.75);g.add(glow);
      const wg=new THREE.CylinderGeometry(0.34,0.34,0.28,10);wg.rotateZ(Math.PI/2);const wm=new THREE.MeshStandardMaterial({color:0x14141a,roughness:0.9});
      for(const[wx,wz]of[[-1.05,1.6],[1.05,1.6],[-1.05,-1.6],[1.05,-1.6]]){const w=new THREE.Mesh(wg,wm);w.position.set(wx,0.34,wz);g.add(w);}scene.add(g);return g;}
    for(const line of D.cableCars||[])for(let i=0;i<(line.cars||2);i++)cableCars.push({group:buildCableCar(),road:line,dir:i?-1:1,speed:line.speed||9,s:line.a+(i*(line.b-line.a)/((line.cars||2)))});

    // ---- minimap landmarks --------------------------------------------------
    const shortCode=(label)=>{const w=label.replace(/[·]/g,' ').split(/\s+/).filter(s=>/[A-Za-z0-9]/.test(s));if(w.length>=2)return (w[0][0]+w[1][0]+(w[2]?w[2][0]:'')).toUpperCase();return label.slice(0,3).toUpperCase();};
    const landmarks=D.landmarks.filter(o=>o.type!=='marker').map(o=>({x:o.x,z:o.z,name:o.label.toUpperCase(),short:shortCode(o.label)}));
    for(const b of BRIDGES)landmarks.push({x:b.axis==='z'?b.line:(b.s0+b.s1)/2,z:b.axis==='z'?(b.s0+b.s1)/2:b.line,name:b.label.toUpperCase(),short:shortCode(b.label)});

    // ---- world contract -----------------------------------------------------
    let elapsed=0;
    return {
      collide:()=>null,
      groundH,
      onVoid:(x,z)=>groundH(x,z)<0.2,
      landmarks,
      minimapBlocks:bldgPts,
      trafficPoints:()=>traffic.map(t=>({x:t.road.axis==='z'?t.road.fixed:t.s,z:t.road.axis==='z'?t.s:t.road.fixed})),
      size:1500,
      update(dt){
        elapsed+=dt;waterMat.uniforms.time.value=elapsed;
        for(const t of traffic){t.s+=t.dir*t.speed*dt;if(t.s>t.road.b)t.s=t.road.a;if(t.s<t.road.a)t.s=t.road.b;
          let x,z,heading;if(t.road.axis==='z'){x=t.road.fixed;z=t.s;heading=t.dir>0?0:Math.PI;}else{x=t.s;z=t.road.fixed;heading=t.dir>0?Math.PI/2:-Math.PI/2;}
          const fx=Math.sin(heading),fz=Math.cos(heading);x+=fz*2.7;z-=fx*2.7;orientOnGround(t.car.group,x,z,heading,1);}
        for(const cc of cableCars){cc.s+=cc.dir*cc.speed*dt;if(cc.s>cc.road.b){cc.s=cc.road.b;cc.dir=-1;}if(cc.s<cc.road.a){cc.s=cc.road.a;cc.dir=1;}orientOnGround(cc.group,cc.road.fixed,cc.s,cc.dir>0?0:Math.PI,1);}
        const flash=Math.floor(elapsed*5)%2;for(const pb of policeBeacons){pb.r.emissiveIntensity=flash?4.5:0.25;pb.b.emissiveIntensity=flash?0.25:4.5;}
        for(const fn of anim)fn(elapsed,dt);
      },
    };
  }
};

// ============================================================================
//  LANDMARK TYPE LIBRARY (SF palette). builder(o,ctx) places one landmark.
// ============================================================================
function makeLandmarkLibrary(ctx){
  const {THREE,terrainH,groundH,makeFacade,makeText,makeVSign,makeStripes,anim,add}=ctx;
  const M=(opt)=>new THREE.MeshStandardMaterial(opt);
  return {
  marker(){},
  pyramid(o){const h=terrainH(o.x,o.z),H=o.h??165,pyM=M({color:o.color??0xd8d2c8,roughness:0.55,metalness:0.22,envMapIntensity:0.6});
    const py=new THREE.Mesh(new THREE.ConeGeometry(o.base??15.5,H,4),pyM);py.position.set(o.x,h+H/2,o.z);py.rotation.y=Math.PI/4;py.castShadow=true;add(py);
    const sp=new THREE.Mesh(new THREE.ConeGeometry(1.4,18,6),M({color:0xfff2da,emissive:0xffe8c0,emissiveIntensity:2}));sp.position.set(o.x,h+H+7,o.z);add(sp);},
  crownTower(o){const y=terrainH(o.x,o.z),H=o.h??150;const{map,em}=makeFacade();map.wrapS=map.wrapT=THREE.RepeatWrapping;map.repeat.set(5,3);em.wrapS=em.wrapT=THREE.RepeatWrapping;em.repeat.set(5,3);
    const body=new THREE.Mesh(new THREE.CylinderGeometry(o.rTop??9.5,o.rBot??13,H,24),M({map,emissiveMap:em,emissive:0xffffff,emissiveIntensity:0.85,color:0xbfc8d4,roughness:0.5,metalness:0.25,envMapIntensity:0.5}));body.position.set(o.x,y+H/2-4,o.z);body.castShadow=true;add(body);
    const cm=M({color:0x1a2030,emissive:0xfff2da,emissiveIntensity:1.2,roughness:0.5,side:THREE.DoubleSide});const crown=new THREE.Mesh(new THREE.CylinderGeometry(9.0,9.4,12,24,1,true),cm);crown.position.set(o.x,y+H+2-4,o.z);add(crown);anim.push(t=>{cm.emissiveIntensity=1.7+0.6*Math.sin(t*0.9);});},
  darkTower(o){const y=terrainH(o.x,o.z),H=o.h??122;const{map,em}=makeFacade();map.wrapS=map.wrapT=THREE.RepeatWrapping;map.repeat.set(4,4);em.wrapS=em.wrapT=THREE.RepeatWrapping;em.repeat.set(4,4);
    const t=new THREE.Mesh(new THREE.BoxGeometry(o.w??20,H,o.d??20),M({map,emissiveMap:em,emissive:0xffffff,emissiveIntensity:0.7,color:o.color??0x6a4a44,roughness:0.5,metalness:0.3,envMapIntensity:0.5}));t.position.set(o.x,y+H/2,o.z);t.castShadow=true;add(t);},
  coitTower(o){const hc=terrainH(o.x,o.z),cm=M({color:0xdcd6c8,roughness:0.65,envMapIntensity:0.3});
    const s=new THREE.Mesh(new THREE.CylinderGeometry(2.9,3.4,28,16),cm);s.position.set(o.x,hc+14,o.z);s.castShadow=true;add(s);
    const top=new THREE.Mesh(new THREE.CylinderGeometry(3.2,3.2,4.5,16),cm);top.position.set(o.x,hc+30,o.z);top.castShadow=true;add(top);
    const band=new THREE.Mesh(new THREE.CylinderGeometry(3.28,3.28,1.6,16),M({color:0x332a1a,emissive:0xffd9a0,emissiveIntensity:1.8}));band.position.set(o.x,hc+30,o.z);add(band);
    const cap=new THREE.Mesh(new THREE.CylinderGeometry(2.3,3.2,1.4,16),cm);cap.position.set(o.x,hc+33,o.z);add(cap);},
  antennaTower(o){const sh=terrainH(o.x,o.z),legM=M({color:0xd8dde2,roughness:0.6}),legM2=M({color:0xc23b22,roughness:0.6});
    for(let i=0;i<3;i++){const a=i/3*Math.PI*2;const leg=new THREE.Mesh(new THREE.CylinderGeometry(0.7,1.4,80,6),i===1?legM2:legM);leg.position.set(o.x+Math.cos(a)*7,sh+40,o.z+Math.sin(a)*7);leg.rotation.z=Math.cos(a)*0.06;leg.rotation.x=-Math.sin(a)*0.06;leg.castShadow=true;add(leg);}
    const waist=new THREE.Mesh(new THREE.TorusGeometry(7,0.5,6,12),legM2);waist.rotation.x=Math.PI/2;waist.position.set(o.x,sh+52,o.z);add(waist);const mast=new THREE.Mesh(new THREE.BoxGeometry(10,3,10),legM2);mast.position.set(o.x,sh+80,o.z);add(mast);},
  domeCivic(o){const y=terrainH(o.x,o.z),stone=M({color:0xe4dcc8,roughness:0.7,envMapIntensity:0.3});
    const base=new THREE.Mesh(new THREE.BoxGeometry(52,17,34),stone);base.position.set(o.x,y+8.5,o.z);base.castShadow=base.receiveShadow=true;add(base);
    const drum=new THREE.Mesh(new THREE.CylinderGeometry(9,10,10,22),stone);drum.position.set(o.x,y+22,o.z);add(drum);
    const dome=new THREE.Mesh(new THREE.SphereGeometry(9.5,22,14,0,Math.PI*2,0,Math.PI/2),M({color:0xcaa93f,roughness:0.32,metalness:0.8,envMapIntensity:1.0}));dome.position.set(o.x,y+27,o.z);dome.castShadow=true;add(dome);
    const lan=new THREE.Mesh(new THREE.CylinderGeometry(1.7,1.7,4.5,12),M({color:0xcaa93f,emissive:0xffdf6a,emissiveIntensity:1.1,metalness:0.7,roughness:0.4}));lan.position.set(o.x,y+38.5,o.z);add(lan);
    const cup=new THREE.Mesh(new THREE.SphereGeometry(1.1,10,8),M({color:0xcaa93f,metalness:0.8,roughness:0.3}));cup.position.set(o.x,y+41.5,o.z);add(cup);
    for(let i=0;i<8;i++){const col=new THREE.Mesh(new THREE.CylinderGeometry(0.8,0.8,13,10),stone);col.position.set(o.x-24.5+i*7,y+6.5,o.z+18);col.castShadow=true;add(col);}},
  rotunda(o){const y=terrainH(o.x,o.z),ochre=M({color:0xc99a6a,roughness:0.75,envMapIntensity:0.3});
    const rot=new THREE.Mesh(new THREE.CylinderGeometry(9,9,15,18),ochre);rot.position.set(o.x,y+7.5,o.z);rot.castShadow=true;add(rot);
    const dome=new THREE.Mesh(new THREE.SphereGeometry(9,18,12,0,Math.PI*2,0,Math.PI/2),M({color:0xb5895c,roughness:0.6}));dome.position.set(o.x,y+15,o.z);dome.castShadow=true;add(dome);
    const oc=new THREE.Mesh(new THREE.CylinderGeometry(3,3.4,4,14),ochre);oc.position.set(o.x,y+24,o.z);add(oc);
    for(let i=0;i<15;i++){const a=(i/14-0.5)*1.7;const col=new THREE.Mesh(new THREE.CylinderGeometry(0.75,0.75,13,8),ochre);col.position.set(o.x+Math.sin(a)*24,y+6.5,o.z+16+(1-Math.cos(a))*20);col.castShadow=true;add(col);}},
  cathedral(o){const y=terrainH(o.x,o.z),grey=M({color:0xcfcabb,roughness:0.8,envMapIntensity:0.2});
    const nave=new THREE.Mesh(new THREE.BoxGeometry(14,20,26),grey);nave.position.set(o.x,y+10,o.z);nave.castShadow=true;add(nave);
    for(const s of[-1,1]){const t=new THREE.Mesh(new THREE.BoxGeometry(6,30,6),grey);t.position.set(o.x+s*7.5,y+15,o.z+11);t.castShadow=true;add(t);const sp=new THREE.Mesh(new THREE.ConeGeometry(4,10,4),grey);sp.rotation.y=Math.PI/4;sp.position.set(o.x+s*7.5,y+35,o.z+11);add(sp);}
    const rose=new THREE.Mesh(new THREE.CircleGeometry(3,20),M({color:0x332a22,emissive:0xffcf7a,emissiveIntensity:1.4}));rose.position.set(o.x,y+18,o.z+13.1);add(rose);},
  church(o){const y=terrainH(o.x,o.z),white=M({color:0xf0ece0,roughness:0.7});
    const body=new THREE.Mesh(new THREE.BoxGeometry(12,14,18),white);body.position.set(o.x,y+7,o.z);body.castShadow=true;add(body);
    for(const s of[-1,1]){const t=new THREE.Mesh(new THREE.BoxGeometry(4.5,26,4.5),white);t.position.set(o.x+s*4.6,y+13,o.z-8);t.castShadow=true;add(t);const sp=new THREE.Mesh(new THREE.ConeGeometry(3,9,8),white);sp.position.set(o.x+s*4.6,y+30.5,o.z-8);add(sp);}},
  column(o){const y=terrainH(o.x,o.z),stone=M({color:0xd8d0c0,roughness:0.7});
    const plaza=new THREE.Mesh(new THREE.BoxGeometry(26,0.6,26),M({color:0xbfae94,roughness:0.9}));plaza.position.set(o.x,y+0.3,o.z);plaza.receiveShadow=true;add(plaza);
    const col=new THREE.Mesh(new THREE.CylinderGeometry(0.9,1.1,22,14),stone);col.position.set(o.x,y+11,o.z);col.castShadow=true;add(col);
    const v=new THREE.Mesh(new THREE.ConeGeometry(1.1,3,8),M({color:0xcaa93f,metalness:0.7,roughness:0.4,emissive:0x3a3010,emissiveIntensity:0.4}));v.position.set(o.x,y+23.5,o.z);add(v);},
  pagoda(o){const y=terrainH(o.x,o.z),stone=M({color:0xd6d0c4,roughness:0.7});
    const b0=new THREE.Mesh(new THREE.CylinderGeometry(5,6,3,12),stone);b0.position.set(o.x,y+1.5,o.z);add(b0);
    for(const[r,yy]of[[4.6,5.2],[3.9,8.2],[3.2,11],[2.5,13.4],[1.8,15.4]]){const pil=new THREE.Mesh(new THREE.CylinderGeometry(1.2,1.2,2.6,10),stone);pil.position.set(o.x,y+yy-1.6,o.z);add(pil);const roof=new THREE.Mesh(new THREE.ConeGeometry(r,1.7,12),stone);roof.position.set(o.x,y+yy,o.z);roof.castShadow=true;add(roof);}
    const fin=new THREE.Mesh(new THREE.ConeGeometry(0.6,3,8),M({color:0xcaa93f,metalness:0.6,roughness:0.4}));fin.position.set(o.x,y+17.6,o.z);add(fin);},
  theatre(o){const y=terrainH(o.x,o.z);
    const th=new THREE.Mesh(new THREE.BoxGeometry(22,14,26),M({color:0xe0d2b4,roughness:0.75}));th.position.set(o.x,y+7,o.z+4);th.castShadow=true;add(th);
    const marq=new THREE.Mesh(new THREE.BoxGeometry(20,5,6),M({color:0x5a1020,emissive:0xff3050,emissiveIntensity:1.0}));marq.position.set(o.x,y+9,o.z-9.5);add(marq);
    const bt=makeVSign(o.blade??'CINEMA','#3a0a12','#ffcf4a');const blade=new THREE.Mesh(new THREE.PlaneGeometry(4,17),M({map:bt,emissiveMap:bt,emissive:0xffffff,emissiveIntensity:1.7,side:THREE.DoubleSide}));blade.position.set(o.x-9,y+16,o.z-9.5);add(blade);
    if(o.flag){const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.3,0.3,36,8),M({color:0xcccccc,metalness:0.6,roughness:0.4}));pole.position.set(o.x+16,y+18,o.z+6);add(pole);
      const fg=new THREE.PlaneGeometry(16,10,20,5);fg.userData.baseX=fg.attributes.position.array.slice();const flag=new THREE.Mesh(fg,M({map:makeStripes(o.flag),side:THREE.DoubleSide,roughness:0.85,emissive:0x333333,emissiveIntensity:0.18}));flag.position.set(o.x+24,y+30,o.z+6);add(flag);
      anim.push(t=>{const pa=fg.attributes.position,bx=fg.userData.baseX;for(let i=0;i<pa.count;i++){const lx=bx[i*3];pa.setZ(i,Math.sin(lx*0.7+t*4.5)*(lx+8)/16*1.3);}pa.needsUpdate=true;});}},
  mission(o){const y=terrainH(o.x,o.z),adobe=M({color:0xdcc9a8,roughness:0.85});
    const body=new THREE.Mesh(new THREE.BoxGeometry(16,10,22),adobe);body.position.set(o.x,y+5,o.z);body.castShadow=true;add(body);
    const roof=new THREE.Mesh(new THREE.BoxGeometry(17,1.2,23),M({color:0x9a5533,roughness:0.9}));roof.position.set(o.x,y+10.6,o.z);add(roof);
    const wall=new THREE.Mesh(new THREE.BoxGeometry(16,5,1.4),adobe);wall.position.set(o.x,y+12.5,o.z+11);add(wall);
    for(const bxo of[-4.5,0,4.5]){const bell=new THREE.Mesh(new THREE.SphereGeometry(0.7,8,6),M({color:0x2a2018}));bell.position.set(o.x+bxo,y+12.6,o.z+11.5);add(bell);}},
  copperTower(o){const y=terrainH(o.x,o.z),cu=M({color:0x7d8a5a,roughness:0.6,metalness:0.4,envMapIntensity:0.4});
    const t=new THREE.Mesh(new THREE.BoxGeometry(10,34,10),cu);t.position.set(o.x,y+17,o.z);t.rotation.y=0.42;t.castShadow=true;add(t);
    const top=new THREE.Mesh(new THREE.BoxGeometry(12,4,12),cu);top.position.set(o.x,y+35,o.z);top.rotation.y=0.72;add(top);
    const mus=new THREE.Mesh(new THREE.BoxGeometry(30,8,20),cu);mus.position.set(o.x+16,y+4,o.z+6);mus.castShadow=true;add(mus);},
  glasshouse(o){const y=terrainH(o.x,o.z),glass=M({color:0xf2f6f2,roughness:0.3,metalness:0.1,emissive:0xbfe0d0,emissiveIntensity:0.28});
    const hall=new THREE.Mesh(new THREE.BoxGeometry(20,6,10),glass);hall.position.set(o.x,y+3,o.z);add(hall);
    const dome=new THREE.Mesh(new THREE.SphereGeometry(6,16,12,0,Math.PI*2,0,Math.PI/2),glass);dome.position.set(o.x,y+6,o.z);add(dome);
    const cup=new THREE.Mesh(new THREE.ConeGeometry(1.6,4,10),glass);cup.position.set(o.x,y+13,o.z);add(cup);},
  windmill(o){const y=terrainH(o.x,o.z),wood=M({color:0x9a8055,roughness:0.85});
    const t=new THREE.Mesh(new THREE.CylinderGeometry(3.5,5,16,12),wood);t.position.set(o.x,y+8,o.z);t.castShadow=true;add(t);
    const cap=new THREE.Mesh(new THREE.ConeGeometry(4,4,12),M({color:0x5a4030,roughness:0.9}));cap.position.set(o.x,y+18,o.z);add(cap);
    const hub=new THREE.Group();hub.position.set(o.x,y+17,o.z+4.5);const sm=M({color:0xece4d0,roughness:0.8,side:THREE.DoubleSide});
    for(let i=0;i<4;i++){const pv=new THREE.Group();pv.rotation.z=i*Math.PI/2;const bl=new THREE.Mesh(new THREE.BoxGeometry(1.7,12,0.3),sm);bl.position.y=6.5;pv.add(bl);hub.add(pv);}add(hub);anim.push(t2=>{hub.rotation.z=t2*0.6;});},
  clockTower(o){const y=terrainH(o.x,o.z),st=M({color:0xe2d8c2,roughness:0.7,envMapIntensity:0.3}),tr=M({color:0xcabfa4,roughness:0.75});
    const hall=new THREE.Mesh(new THREE.BoxGeometry(82,15,16),st);hall.position.set(o.x,y+7,o.z);hall.castShadow=hall.receiveShadow=true;add(hall);
    const corn=new THREE.Mesh(new THREE.BoxGeometry(84,1.4,18),tr);corn.position.set(o.x,y+15,o.z);add(corn);
    const am=M({color:0x2a2620,roughness:0.95});for(let i=0;i<14;i++){const a=new THREE.Mesh(new THREE.BoxGeometry(3.6,8,1.4),am);a.position.set(o.x-39+i*6,y+4.5,o.z+8.4);add(a);}
    const tw=new THREE.Mesh(new THREE.BoxGeometry(11,50,11),st);tw.position.set(o.x,y+40,o.z);tw.castShadow=true;add(tw);
    const bel=new THREE.Mesh(new THREE.BoxGeometry(9.2,8,9.2),tr);bel.position.set(o.x,y+67,o.z);add(bel);
    const sp=new THREE.Mesh(new THREE.ConeGeometry(6.2,8,4),M({color:0x8a9a7a,roughness:0.7}));sp.rotation.y=Math.PI/4;sp.position.set(o.x,y+75,o.z);add(sp);
    const cm=M({color:0xfff4d8,emissive:0xffe8b0,emissiveIntensity:1.9});for(const[dz,ry]of[[5.7,0],[-5.7,Math.PI]]){const clk=new THREE.Mesh(new THREE.CircleGeometry(3.0,24),cm);clk.position.set(o.x,y+56,o.z+dz);clk.rotation.y=ry;add(clk);}},
  islandPrison(o){const y=terrainH(o.x,o.z);
    const cell=new THREE.Mesh(new THREE.BoxGeometry(26,7,12),M({color:0xd0c8b4,roughness:0.85}));cell.position.set(o.x,y+1.5,o.z);add(cell);
    const lhM=M({color:0xffffff,emissive:0xfff2c0,emissiveIntensity:0});const lh=new THREE.Mesh(new THREE.CylinderGeometry(1,1.4,12,8),M({color:0xe8e2d4,roughness:0.7}));lh.position.set(o.x-9,y+8,o.z+5);add(lh);
    const b=new THREE.Mesh(new THREE.SphereGeometry(0.9,8,6),lhM);b.position.set(o.x-9,y+14.6,o.z+5);add(b);anim.push(t=>{lhM.emissiveIntensity=(Math.sin(t*2.2)>0.75)?4:0;});},
  stadium(o){const y=terrainH(o.x,o.z),sm=M({color:0x2f6b4f,roughness:0.8});
    for(let i=0;i<20;i++){const a=-Math.PI*0.12+i/19*Math.PI*1.55,rx=o.x+Math.cos(a)*26,rz=o.z+Math.sin(a)*22;const seg=new THREE.Mesh(new THREE.BoxGeometry(6,7,4),sm);seg.position.set(rx,y+3.5,rz);seg.lookAt(o.x,y+3.5,o.z);seg.castShadow=true;add(seg);}
    const field=new THREE.Mesh(new THREE.CircleGeometry(20,26),M({color:0x3f8a3f,roughness:1}));field.rotation.x=-Math.PI/2;field.position.set(o.x,y+0.2,o.z);add(field);
    for(let i=0;i<4;i++){const a=-0.15+i/3*1.4,lx=o.x+Math.cos(a)*28,lz=o.z+Math.sin(a)*24;const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.4,0.5,20,6),M({color:0x333333}));pole.position.set(lx,y+10,lz);add(pole);const bank=new THREE.Mesh(new THREE.BoxGeometry(4,2,0.6),M({color:0x222222,emissive:0xfff2c0,emissiveIntensity:2}));bank.position.set(lx,y+20,lz);bank.lookAt(o.x,y+8,o.z);add(bank);}},
  bottle(o){const y=terrainH(o.x,o.z);
    const prof=[[0,0],[3.6,0],[3.8,1.2],[3.6,5],[2.5,7.2],[3.1,9],[3.1,14.5],[2.3,17.5],[1.2,19.5],[1.2,23],[1.5,23.6],[1.5,25]];
    const bot=new THREE.Mesh(new THREE.LatheGeometry(prof.map(([r,yy])=>new THREE.Vector2(r,yy)),24),M({color:o.color??0xd21a1a,roughness:0.32,metalness:0.2,envMapIntensity:0.8}));bot.position.set(o.x,y,o.z);bot.castShadow=true;add(bot);
    const cap=new THREE.Mesh(new THREE.CylinderGeometry(1.5,1.5,1.4,16),M({color:0xb01414,roughness:0.4,metalness:0.4}));cap.position.set(o.x,y+25.6,o.z);add(cap);
    const lt=makeText(o.text??'SODA',512,150,'#ffffff',o.color?('#'+o.color.toString(16)):'#d21a1a','italic bold 92px Georgia,serif');const lab=new THREE.Mesh(new THREE.CylinderGeometry(3.18,3.18,4.6,24,1,true),M({map:lt,roughness:0.5,side:THREE.DoubleSide}));lab.position.set(o.x,y+11.5,o.z);add(lab);},
  rowHouses(o){const trimM=M({color:0xf5efe4,roughness:0.7}),winM=M({color:0x241a12,emissive:0xffd98a,emissiveIntensity:1.15}),foundM=M({color:0x6a5a50,roughness:0.9});
    const pastel=o.colors??[0xe8a9be,0xa9c9e8,0xc7e0b0,0xf3d9a0,0xd7b6e6,0x9fd8cf,0xecc0a0];const roofCols=[0x6a4a4a,0x4a5a6a,0x5a5a4a,0x6a5540,0x554a5a,0x40554f,0x6a5040];
    const n=o.count??7,step=o.step??8.0,rowZ=o.z,x0=o.x-(n-1)*step/2,w=7.0,d=8.2;
    for(let i=0;i<n;i++){const x=x0+i*step,t0=terrainH(x,rowZ),by=t0+i*(o.rise??1.25),bodyM=M({color:pastel[i%pastel.length],roughness:0.75}),roofM=M({color:roofCols[i%roofCols.length],roughness:0.85});
      const fh=by-(t0-2.5);const found=new THREE.Mesh(new THREE.BoxGeometry(w,fh,d),foundM);found.position.set(x,(by+t0-2.5)/2,rowZ);add(found);
      const g0=new THREE.Mesh(new THREE.BoxGeometry(w,5,d),bodyM);g0.position.set(x,by+2.5,rowZ);g0.castShadow=g0.receiveShadow=true;add(g0);
      const b1=new THREE.Mesh(new THREE.BoxGeometry(w+0.3,0.6,d+0.3),trimM);b1.position.set(x,by+5.1,rowZ);add(b1);
      const g1=new THREE.Mesh(new THREE.BoxGeometry(w,4.6,d),bodyM);g1.position.set(x,by+7.6,rowZ);g1.castShadow=true;add(g1);
      const corn=new THREE.Mesh(new THREE.BoxGeometry(w+0.5,0.7,d+0.5),trimM);corn.position.set(x,by+10,rowZ);add(corn);
      const bay=new THREE.Mesh(new THREE.BoxGeometry(3.3,9.4,1.8),bodyM);bay.position.set(x,by+4.7,rowZ+d/2+0.7);bay.castShadow=true;add(bay);
      for(const wy of[by+3.2,by+7.4]){const win=new THREE.Mesh(new THREE.PlaneGeometry(2.1,2.4),winM);win.position.set(x,wy,rowZ+d/2+1.62);add(win);}
      const shape=new THREE.Shape();shape.moveTo(-w/2-0.5,0);shape.lineTo(w/2+0.5,0);shape.lineTo(0,3.6);shape.closePath();
      const rg=new THREE.ExtrudeGeometry(shape,{depth:d+0.6,bevelEnabled:false});rg.translate(0,0,-(d+0.6)/2);const roof=new THREE.Mesh(rg,roofM);roof.position.set(x,by+10.3,rowZ);roof.castShadow=true;add(roof);
      for(let s=0;s<3;s++){const stp=new THREE.Mesh(new THREE.BoxGeometry(2.6,0.5,1.0),trimM);stp.position.set(x,by+0.25+s*0.5,rowZ+d/2+1.8+s*0.9);add(stp);}}},
  gate(o){const gz=o.z,gy=terrainH(o.x,gz),redM=M({color:0xa8281e,roughness:0.6,envMapIntensity:0.3}),jadeM=M({color:0x1f6e52,roughness:0.55,envMapIntensity:0.4}),stoneM=M({color:0x9a948a,roughness:0.9});const cx=o.x;
    function pillar(x,hgt,rad){const p=new THREE.Mesh(new THREE.CylinderGeometry(rad*0.82,rad,hgt,12),redM);p.position.set(x,terrainH(x,gz)+hgt/2,gz);p.castShadow=true;add(p);const base=new THREE.Mesh(new THREE.CylinderGeometry(rad*1.4,rad*1.5,1.6,12),stoneM);base.position.set(x,terrainH(x,gz)+0.8,gz);add(base);}
    pillar(cx-12,17,1.05);pillar(cx+12,17,1.05);pillar(cx-20,11.5,0.8);pillar(cx+20,11.5,0.8);
    const beam=new THREE.Mesh(new THREE.BoxGeometry(30,2.4,2.8),redM);beam.position.set(cx,gy+16.3,gz);beam.castShadow=true;add(beam);
    const mainRoof=new THREE.Mesh(new THREE.ConeGeometry(19,5.6,4),jadeM);mainRoof.scale.z=0.42;mainRoof.rotation.y=Math.PI/4;mainRoof.position.set(cx,gy+20.3,gz);mainRoof.castShadow=true;add(mainRoof);
    const pt=makeText(o.plaque??'天下為公',768,192,'#0d3b2e','#f2c94c','bold 138px "PingFang TC","Songti TC","Heiti TC",serif');const pm=M({map:pt,emissiveMap:pt,emissive:0xffffff,emissiveIntensity:0.8});
    for(const s of[-1,1]){const pq=new THREE.Mesh(new THREE.PlaneGeometry(11,2.75),pm);pq.position.set(cx,gy+14.4,gz+s*1.42);if(s<0)pq.rotation.y=Math.PI;add(pq);}},
  policeStation(o){const y=terrainH(o.x,o.z);
    const st=new THREE.Mesh(new THREE.BoxGeometry(26,9,15),M({color:0x9aa2ac,roughness:0.85,envMapIntensity:0.2}));st.position.set(o.x,y+2.5,o.z);st.castShadow=st.receiveShadow=true;add(st);
    const sg=makeText(o.sign??'POLICE',512,128,'#10141c','#e8f0ff','bold 88px Arial');const sign=new THREE.Mesh(new THREE.PlaneGeometry(11,2.4),M({map:sg,emissiveMap:sg,emissive:0xffffff,emissiveIntensity:1.5}));sign.position.set(o.x,y+5.6,o.z+7.58);add(sign);
    for(const s of[-1,1]){const gl=new THREE.Mesh(new THREE.SphereGeometry(0.38,8,6),M({color:0x0a1030,emissive:0x2255ff,emissiveIntensity:3}));gl.position.set(o.x+s*4.5,y+3.2,o.z+7.7);add(gl);}},
  wharf(o){const y=terrainH(o.x,o.z);
    for(let i=0;i<4;i++){const shed=new THREE.Mesh(new THREE.BoxGeometry(14,8,11),M({color:i%2?0xd8c9b0:0xc85a3a,roughness:0.8}));shed.position.set(o.x-26+i*17,y+4,o.z);shed.castShadow=true;add(shed);}
    const sX=o.x-46;const disc=new THREE.Mesh(new THREE.CircleGeometry(5.6,28),M({color:0xf4e3b0,emissive:0xffcf5a,emissiveIntensity:0.7,side:THREE.DoubleSide}));disc.position.set(sX,y+17,o.z+5.3);add(disc);
    const crab=new THREE.Mesh(new THREE.SphereGeometry(2.4,10,8),M({color:0xd8402a,roughness:0.55}));crab.scale.set(1.4,0.9,0.4);crab.position.set(sX,y+17,o.z+5.6);add(crab);},
  };
}
export default CITY;
