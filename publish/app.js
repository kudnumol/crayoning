"use strict";
/* ============================================================
   РЕДАКТОР ТРАНСПОРТНЫХ СХЕМ  —  одиночный HTML файл (SVG)
   ============================================================ */

/* ---------- ЛОГГЕР (требование: возможность читать логи) ---------- */
const Log = {
  buf: [],
  el: null,
  add(level, ...args){
    const ts = new Date().toISOString().split('T')[1].replace('Z','');
    const msg = args.map(a=> typeof a==='object'? JSON.stringify(a): String(a)).join(' ');
    const line = `[${ts}] ${level.toUpperCase()} ${msg}`;
    this.buf.push(line);
    if(this.buf.length>2000) this.buf.shift();
    if(this.el){
      const d=document.createElement('div');
      d.className='logline'+(level==='error'?' err':level==='warn'?' warn':'');
      d.textContent=line;
      this.el.appendChild(d);
      this.el.scrollTop=this.el.scrollHeight;
    }
  },
  info(...a){this.add('info',...a)},
  warn(...a){this.add('warn',...a)},
  error(...a){this.add('error',...a)},
  download(){
    const blob=new Blob([this.buf.join('\n')],{type:'text/plain'});
    const u=URL.createObjectURL(blob); const a=document.createElement('a');
    a.href=u; a.download='metro-editor-'+Date.now()+'.log'; a.click();
    setTimeout(()=>URL.revokeObjectURL(u),1000);
  },
  clear(){this.buf=[]; if(this.el) this.el.innerHTML='';}
};
window.addEventListener('error', e=> Log.error('JS error:', e.message, 'at', e.filename+':'+e.lineno));
window.addEventListener('unhandledrejection', e=> Log.error('Promise reject:', e.reason));

/* ---------- СОСТОЯНИЕ ---------- */
const GRID = 24;                     // шаг сетки в "мировых" единицах
const SVGNS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('svg');

let state = {
  routes: [],          // {id,name,num,color,width,points:[{x,y}],stations:[{x,y,type,label,dir,fontSize,fontWeight}]}
  nodes: [],           // узлы пересадок: {id,x,y,type:'interchange'|'mega',label,dir,fontSize,fontWeight,links:[{routeId,idx}]}
  selectedRoute: null, // id
  nextId: 1
};
let view = { x: 0, y: 0, scale: 1 };   // pan offset (screen px) + scale
let mode = 'select';                    // select | draw | station | edit
let drawing = null;                     // route id currently being drawn
let history = [], future = [];
let showGrid = true;
let cornerRadius = 24;          // радиус скругления поворотов линии
let canvasBg = '#ffffff';       // фон холста
let gridColor1 = '#eef1f5', gridColor2 = '#dde3ea';
let labelColor = '#1a1a1a';     // цвет подписей (адаптируется к фону)
let editTarget = null;          // {routeId,idx} для попапа удаления точки

/* station option state */
let stOpts = { type:'dot', dir:'e', fontSize:14, fontWeight:'600' };

/* ---------- УТИЛИТЫ ---------- */
const uid = ()=> state.nextId++;
function snap(v){ return Math.round(v/GRID)*GRID; }
function getRoute(id){ return state.routes.find(r=>r.id===id); }
function selRoute(){ return getRoute(state.selectedRoute); }

function screenToWorld(sx, sy){
  return { x:(sx-view.x)/view.scale, y:(sy-view.y)/view.scale };
}
function worldToScreen(wx, wy){
  return { x: wx*view.scale+view.x, y: wy*view.scale+view.y };
}

/* применить фон холста: подбираем цвета сетки и подписей под светлоту фона */
function isDarkColor(hex){
  const c=hex.replace('#',''); const r=parseInt(c.substr(0,2),16),g=parseInt(c.substr(2,2),16),b=parseInt(c.substr(4,2),16);
  return (0.299*r+0.587*g+0.114*b) < 128;
}
/* осветлить/затемнить цвет: amt в [-1..1], отрицательное = темнее */
function shade(hex, amt){
  const c=hex.replace('#',''); const r=parseInt(c.substr(0,2),16),g=parseInt(c.substr(2,2),16),b=parseInt(c.substr(4,2),16);
  const f=v=> Math.max(0,Math.min(255, Math.round(amt<0 ? v*(1+amt) : v+(255-v)*amt)));
  const h=v=>('0'+f(v).toString(16)).slice(-2);
  return '#'+h(r)+h(g)+h(b);
}
function setBg(color){
  canvasBg=color;
  const dark=isDarkColor(color);
  document.getElementById('canvasWrap').style.background=color;
  if(dark){ gridColor1=shade(color,0.18); gridColor2=shade(color,0.32); labelColor='#f0f2f5'; }
  else    { gridColor1=shade(color,-0.16); gridColor2=shade(color,-0.28); labelColor='#1a1a1a'; }
  render();
}

/* шаг привязки угла в градусах: 0 = свободно, 90/45 = квадрат, 30 = треугольник */
let angleStepDeg = 45;
const TRI_H = Math.sqrt(3)/2;   // высота равностороннего треугольника со стороной 1
/* направления ЛИНИЙ треугольной сетки — только 0/60/120/180/240/300°
   (заданы в координатах базиса i,j; мир: (i*G + j*G/2, j*G*√3/2)).
   Вертикали (90°) нет — её нет среди линий сетки. */
const TRI_DIRS = [[1,0],[0,1],[-1,1],[-1,0],[0,-1],[1,-1]];

/* тип решётки по выбранному шагу угла */
function gridType(){ return angleStepDeg===30 ? 'tri' : (angleStepDeg===0 ? 'free' : 'square'); }

/* ближайший узел ТРЕУГОЛЬНОЙ (изометрической) решётки.
   Базис: e1=(G,0), e2=(G/2, G·√3/2). Соседние узлы дают направления 0/60/120°,
   дальние — 30/90/150° → как раз нужные углы для схем метро. */
function latticeTri(x, y){
  const rowH = GRID*TRI_H;
  let best={x:0,y:0}, bd=Infinity;
  const jc = y/rowH;
  for(const j of [Math.floor(jc), Math.ceil(jc)]){
    const ic = (x - j*GRID/2)/GRID;
    for(const i of [Math.floor(ic), Math.ceil(ic)]){
      const px = i*GRID + j*GRID/2, py = j*rowH;
      const d = (px-x)*(px-x)+(py-y)*(py-y);
      if(d<bd){ bd=d; best={x:Math.round(px), y:Math.round(py)}; }
    }
  }
  return best;
}
/* ориентации линий сетки (неориентированные направления) для текущего режима */
function gridOrientations(){
  const t=gridType();
  if(t==='free') return null;
  if(t==='tri') return [[1,0],[0.5,TRI_H],[-0.5,TRI_H]];
  if(angleStepDeg===90) return [[1,0],[0,1]];
  return [[1,0],[0,1],[1,1],[1,-1]];     // 45°
}
/* пересечение прямой (A, dir da) и прямой (B, dir db) */
function lineIntersect(A, da, B, db){
  const cross = da[0]*db[1]-da[1]*db[0];
  if(Math.abs(cross)<1e-9) return null;        // параллельны
  const ex=B[0]-A[0], ey=B[1]-A[1];
  const s=(ex*db[1]-ey*db[0])/cross;
  return [A[0]+s*da[0], A[1]+s*da[1]];
}
/* «жёсткая» позиция средней вершины: ближайшее к курсору пересечение линий сетки,
   проходящих через соседей A и B, чтобы ОБА сегмента легли на грани сетки */
function rigidVertex(A, B, cx, cy){
  const ors=gridOrientations();
  if(!ors) return snapPoint(cx,cy);
  let best=null, bd=Infinity;
  for(const da of ors) for(const db of ors){
    if(da===db) continue;
    const p=lineIntersect([A.x,A.y],da,[B.x,B.y],db);
    if(!p) continue;
    const d=(p[0]-cx)*(p[0]-cx)+(p[1]-cy)*(p[1]-cy);
    if(d<bd){ bd=d; best=p; }
  }
  // прямой проход (оба сегмента вдоль одной грани, если A и B на ней лежат)
  for(const o of ors){
    if(Math.abs((B.x-A.x)*o[1]-(B.y-A.y)*o[0])>1e-6) continue;
    const t=((cx-A.x)*o[0]+(cy-A.y)*o[1])/(o[0]*o[0]+o[1]*o[1]);
    const p=[A.x+t*o[0], A.y+t*o[1]];
    const d=(p[0]-cx)*(p[0]-cx)+(p[1]-cy)*(p[1]-cy);
    if(d<bd){ bd=d; best=p; }
  }
  if(!best) return snapPoint(cx,cy);
  return snapPoint(best[0], best[1]);          // на узел сетки (точно)
}

/* привязка одиночной точки к узлу текущей решётки */
function snapPoint(x, y){
  const t=gridType();
  if(t==='tri') return latticeTri(x,y);
  if(t==='free') return { x:Math.round(x), y:Math.round(y) };
  return { x:snap(x), y:snap(y) };
}

/* ограничение угла относительно предыдущей точки + привязка к решётке */
function constrainAngle(prev, x, y){
  const dx = x-prev.x, dy = y-prev.y;
  if(dx===0 && dy===0) return {x,y};
  const len = Math.hypot(dx,dy);
  const t = gridType();

  if(t==='free') return { x:Math.round(x), y:Math.round(y) };

  if(t==='tri'){
    // только направления линий сетки (кратные 60°): 0/60/120/180/240/300
    let m=Math.round(Math.atan2(dy,dx)/(Math.PI/3)); m=((m%6)+6)%6;
    const [i,j]=TRI_DIRS[m];
    const vx=i*GRID + j*GRID/2, vy=j*GRID*TRI_H;
    const vlen2=vx*vx+vy*vy;
    let n=Math.round((dx*vx+dy*vy)/vlen2);
    if(n<1) n=1;
    return { x:Math.round(prev.x+n*vx), y:Math.round(prev.y+n*vy) };
  }
  // квадрат: угол к 45/90, длина по оси, концы на узлы квадратной сетки
  const step = angleStepDeg*Math.PI/180;
  const ang = Math.round(Math.atan2(dy,dx)/step)*step;
  return { x:snap(prev.x + Math.cos(ang)*len), y:snap(prev.y + Math.sin(ang)*len) };
}

/* ---------- ИСТОРИЯ ---------- */
function snapshot(){ return JSON.stringify(state); }
function pushHistory(){
  history.push(snapshot());
  if(history.length>100) history.shift();
  future = [];
  updateUndoButtons();
}
function restore(json){
  state = JSON.parse(json);
  render(); renderRouteList(); syncRouteOpts();
}
function undo(){
  if(!history.length){ return; }
  future.push(snapshot());
  restore(history.pop());
  Log.info('undo'); updateUndoButtons();
}
function redo(){
  if(!future.length){ return; }
  history.push(snapshot());
  restore(future.pop());
  Log.info('redo'); updateUndoButtons();
}
function updateUndoButtons(){
  document.getElementById('tbUndo').disabled = !history.length;
  document.getElementById('tbRedo').disabled = !future.length;
}

/* ---------- РЕНДЕР ---------- */
function render(){
  // clear
  while(svg.firstChild) svg.removeChild(svg.firstChild);

  const W = svg.clientWidth, H = svg.clientHeight;

  // defs (drop shadow optional)
  const g = el('g', { transform:`translate(${view.x},${view.y}) scale(${view.scale})` });

  // grid (квадратная или треугольная — по выбранному шагу угла)
  if(showGrid){
    const gridG = el('g',{});
    const a = screenToWorld(0,0), b = screenToWorld(W,H);
    const wr = {x0:a.x, y0:a.y, x1:b.x, y1:b.y};
    const sw = 1/view.scale;
    if(gridType()==='tri'){
      const spacing = GRID*TRI_H;
      drawGridFamily(gridG, 0,   spacing, wr, gridColor1, sw);
      drawGridFamily(gridG, 60,  spacing, wr, gridColor1, sw);
      drawGridFamily(gridG, 120, spacing, wr, gridColor1, sw);
    } else {
      const startX = Math.floor(wr.x0/GRID)*GRID, endX = Math.ceil(wr.x1/GRID)*GRID;
      const startY = Math.floor(wr.y0/GRID)*GRID, endY = Math.ceil(wr.y1/GRID)*GRID;
      for(let x=startX;x<=endX;x+=GRID)
        gridG.appendChild(el('line',{x1:x,y1:startY,x2:x,y2:endY,
          stroke:(x%(GRID*5)===0)?gridColor2:gridColor1,'stroke-width':sw}));
      for(let y=startY;y<=endY;y+=GRID)
        gridG.appendChild(el('line',{x1:startX,y1:y,x2:endX,y2:y,
          stroke:(y%(GRID*5)===0)?gridColor2:gridColor1,'stroke-width':sw}));
      // для режима 45° показываем диагонали (это тоже линии сетки)
      if(angleStepDeg===45){
        const ds=GRID/Math.SQRT2;
        drawGridFamily(gridG, 45,  ds, wr, gridColor1, sw);
        drawGridFamily(gridG, 135, ds, wr, gridColor1, sw);
      }
    }
    g.appendChild(gridG);
  }

  // routes (lines)
  for(const r of state.routes){
    if(r.points.length>=2){
      const d = roundedPathData(r.points, cornerRadius);
      g.appendChild(el('path',{d, fill:'none', stroke:r.color, 'stroke-width':r.width,
        'stroke-linejoin':'round','stroke-linecap':'round'}));
    }
  }

  // preview line while drawing
  if(drawing!=null && previewPt){
    const r = getRoute(drawing);
    if(r && r.points.length){
      const last = r.points[r.points.length-1];
      g.appendChild(el('line',{x1:last.x,y1:last.y,x2:previewPt.x,y2:previewPt.y,
        stroke:r.color,'stroke-width':r.width,'stroke-dasharray':`${6/view.scale} ${6/view.scale}`,
        'stroke-linecap':'round',opacity:.6}));
      g.appendChild(el('circle',{cx:previewPt.x,cy:previewPt.y,r:r.width/2,fill:r.color,opacity:.5}));
    }
  }

  // line stations (dot/tick/limited/terminus)
  for(const r of state.routes)
    for(const st of (r.stations||[]))
      drawStation(g, r, st);

  // interchange/mega nodes (поверх линий)
  for(const n of state.nodes) drawNode(g, n);

  // handles (поверх всего)
  if(mode==='edit'){
    const r=selRoute();
    if(r){
      for(const p of r.points) g.appendChild(diamond(p.x,p.y,7,'#4f8cff'));
    }
    for(const n of state.nodes) g.appendChild(diamond(n.x,n.y,8,'#f9a01b'));
  } else if(mode==='draw' && drawing!=null){
    const r=getRoute(drawing);
    if(r) for(const p of r.points)
      g.appendChild(el('circle',{cx:p.x,cy:p.y,r:5/view.scale+1,
        fill:'#fff',stroke:r.color,'stroke-width':2/view.scale}));
  }

  svg.appendChild(g);

  // если открыт попап завершения — держим его у последней точки
  if(drawing!=null && document.getElementById('finishPopup').classList.contains('show')){
    showFinishPopup();
  }
  // попап удаления точки — держим у вершины
  if(editTarget && document.getElementById('editPopup').classList.contains('show')){
    const r=getRoute(editTarget.routeId);
    if(r && r.points[editTarget.idx]){
      const s=worldToScreen(r.points[editTarget.idx].x, r.points[editTarget.idx].y);
      const ep=document.getElementById('editPopup'); ep.style.left=s.x+'px'; ep.style.top=s.y+'px';
    }
  }
}

/* семейство параллельных линий под углом angleDeg с шагом spacing,
   проходящих через узел (0,0), в пределах видимого мира wr */
function drawGridFamily(gridG, angleDeg, spacing, wr, color, sw){
  const th=angleDeg*Math.PI/180;
  const dx=Math.cos(th), dy=Math.sin(th);     // направление линии
  const nx=-dy, ny=dx;                         // нормаль
  const corners=[[wr.x0,wr.y0],[wr.x1,wr.y0],[wr.x0,wr.y1],[wr.x1,wr.y1]];
  let omin=Infinity, omax=-Infinity;
  for(const c of corners){ const o=c[0]*nx+c[1]*ny; omin=Math.min(omin,o); omax=Math.max(omax,o); }
  const kmin=Math.floor(omin/spacing), kmax=Math.ceil(omax/spacing);
  const L=Math.hypot(wr.x1-wr.x0, wr.y1-wr.y0)+spacing*2;
  for(let k=kmin;k<=kmax;k++){
    const off=k*spacing, bx=off*nx, by=off*ny;
    gridG.appendChild(el('line',{x1:bx-dx*L, y1:by-dy*L, x2:bx+dx*L, y2:by+dy*L,
      stroke:color, 'stroke-width':sw}));
  }
}

/* ромб-маркер для режима редактирования (визуально не похож на станцию) */
function diamond(x,y,sizePx,color){
  const hs=sizePx/view.scale;
  return el('rect',{x:x-hs,y:y-hs,width:hs*2,height:hs*2,fill:'#fff',
    stroke:color,'stroke-width':2.5/view.scale,transform:`rotate(45 ${x} ${y})`});
}

/* нарисовать станцию + подпись. labelCol — переопределение цвета подписи (для экспорта) */
function drawStation(g, r, st, labelCol){
  const w = r.width;
  const sg = el('g',{});
  const type = st.type;
  if(type==='dot'){
    sg.appendChild(el('circle',{cx:st.x,cy:st.y,r:w*0.55,fill:'#fff',stroke:r.color,'stroke-width':w*0.35}));
  } else if(type==='interchange'){
    sg.appendChild(el('circle',{cx:st.x,cy:st.y,r:w*0.85,fill:'#fff',stroke:'#222','stroke-width':w*0.3}));
  } else if(type==='mega'){
    sg.appendChild(el('circle',{cx:st.x,cy:st.y,r:w*1.15,fill:'#fff',stroke:'#222','stroke-width':w*0.32}));
    sg.appendChild(el('circle',{cx:st.x,cy:st.y,r:w*0.45,fill:'#222'}));
  } else if(type==='tick'){
    // короткая чёрточка ПЕРПЕНДИКУЛЯРНО линии в точке станции
    const ang = lineAngleAt(r.points, st.x, st.y);   // угол касательной линии, °
    sg.appendChild(el('rect',{x:st.x-w*0.18,y:st.y-w*0.9,width:w*0.36,height:w*1.8,
      fill:'#fff',stroke:r.color,'stroke-width':w*0.18,rx:w*0.1,
      transform:`rotate(${ang} ${st.x} ${st.y})`}));
  } else if(type==='limited'){
    sg.appendChild(el('circle',{cx:st.x,cy:st.y,r:w*0.55,fill:r.color,stroke:'#fff','stroke-width':w*0.3}));
  } else if(type==='terminus'){
    // бейдж в ЦВЕТЕ ЛИНИИ с НОМЕРОМ линии (1–3 цифры)
    const num = (r.num!=null && r.num!=='') ? String(r.num) : '';
    const h = w*1.8;
    const bw = Math.max(h, w*0.78*Math.max(1,num.length) + w*0.7);
    sg.appendChild(el('rect',{x:st.x-bw/2,y:st.y-h/2,width:bw,height:h,
      fill:r.color,stroke:'#fff','stroke-width':w*0.26,rx:h*0.34}));
    if(num){
      const t=el('text',{x:st.x,y:st.y,'text-anchor':'middle','dominant-baseline':'central',
        'font-size':w*1.1,'font-weight':'700',fill:'#fff',
        'font-family':'-apple-system,Segoe UI,Arial,sans-serif'});
      t.textContent=num; sg.appendChild(t);
    }
  }
  drawLabel(sg, st, w, labelCol);
  g.appendChild(sg);
}

/* подпись станции/узла */
function drawLabel(sg, st, w, labelCol){
  if(!st.label) return;
  const off = w*1.4 + 4;
  let tx=st.x, ty=st.y, anchor='middle', baseline='middle';
  const d=st.dir;
  if(d.includes('e')){tx+=off;anchor='start';}
  if(d.includes('w')){tx-=off;anchor='end';}
  if(d.includes('n')){ty-=off;baseline='auto';}
  if(d.includes('s')){ty+=off;baseline='hanging';}
  if(d==='c'){anchor='middle';baseline='middle';}
  const t = el('text',{x:tx,y:ty,'text-anchor':anchor,'dominant-baseline':baseline,
    'font-size':st.fontSize||14,'font-weight':st.fontWeight||'600',
    'font-family':'-apple-system,Segoe UI,Arial,sans-serif',fill:labelCol||labelColor});
  t.textContent = st.label;
  sg.appendChild(t);
}

/* радиус маркера узла-пересадки (по самой толстой из его линий) */
function nodeRadius(n){
  let w=9;
  for(const l of n.links){ const r=getRoute(l.routeId); if(r) w=Math.max(w,r.width); }
  return n.type==='mega'? w*1.25 : w*0.95;
}
/* нарисовать узел-пересадку (общий для нескольких линий) */
function drawNode(g, n, labelCol){
  let w=9; for(const l of n.links){ const r=getRoute(l.routeId); if(r) w=Math.max(w,r.width); }
  const sg=el('g',{});
  if(n.type==='mega'){
    sg.appendChild(el('circle',{cx:n.x,cy:n.y,r:w*1.25,fill:'#fff',stroke:'#222','stroke-width':w*0.32}));
    sg.appendChild(el('circle',{cx:n.x,cy:n.y,r:w*0.5,fill:'#222'}));
  } else {
    sg.appendChild(el('circle',{cx:n.x,cy:n.y,r:w*0.95,fill:'#fff',stroke:'#222','stroke-width':w*0.32}));
  }
  drawLabel(sg, n, w, labelCol);
  g.appendChild(sg);
}

function el(tag, attrs){
  const e = document.createElementNS(SVGNS, tag);
  for(const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

/* путь со скруглёнными углами: на каждом изломе вместо острого угла —
   дуга радиусом r. Благодаря этому поворот происходит ВНЕ узла:
   линия идёт прямо до точки скругления, затем плавно поворачивает. */
function roundedPathData(pts, r){
  if(pts.length<2) return '';
  if(pts.length===2 || r<=0)
    return pts.map((p,i)=>(i?'L':'M')+p.x+' '+p.y).join(' ');
  let d = `M${pts[0].x} ${pts[0].y}`;
  for(let i=1;i<pts.length-1;i++){
    const p0=pts[i-1], p1=pts[i], p2=pts[i+1];
    const v1={x:p0.x-p1.x, y:p0.y-p1.y}, v2={x:p2.x-p1.x, y:p2.y-p1.y};
    const l1=Math.hypot(v1.x,v1.y)||1, l2=Math.hypot(v2.x,v2.y)||1;
    const rr=Math.min(r, l1/2, l2/2);
    const a={x:p1.x+v1.x/l1*rr, y:p1.y+v1.y/l1*rr};
    const b={x:p1.x+v2.x/l2*rr, y:p1.y+v2.y/l2*rr};
    d += ` L${a.x.toFixed(2)} ${a.y.toFixed(2)} Q${p1.x} ${p1.y} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
  }
  const last=pts[pts.length-1];
  d += ` L${last.x} ${last.y}`;
  return d;
}

/* ---------- UI: список маршрутов ---------- */
function renderRouteList(){
  const box = document.getElementById('routeList');
  box.innerHTML='';
  if(!state.routes.length){
    box.innerHTML='<div class="hint">Нет маршрутов. Создай новый, чтобы начать.</div>';
    return;
  }
  for(const r of state.routes){
    const d=document.createElement('div');
    d.className='route-item'+(r.id===state.selectedRoute?' sel':'');
    d.innerHTML=`<span class="swatch" style="background:${r.color}"></span>
      <span class="nm">${escapeHtml(r.name)}</span>
      <span class="cnt">${r.points.length}т · ${(r.stations||[]).length}ст</span>`;
    d.onclick=()=>{ state.selectedRoute=r.id; syncRouteOpts(); renderRouteList(); render(); };
    box.appendChild(d);
  }
}
function escapeHtml(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

function syncRouteOpts(){
  const r=selRoute();
  const box=document.getElementById('routeOpts');
  if(!r){ box.style.opacity=.4; box.style.pointerEvents='none'; return; }
  box.style.opacity=1; box.style.pointerEvents='auto';
  document.getElementById('routeName').value=r.name;
  document.getElementById('routeNum').value=r.num!=null?r.num:'';
  document.getElementById('routeColor').value=r.color;
  document.getElementById('routeWidth').value=r.width;
  document.getElementById('widthVal').textContent=r.width;
}

/* ---------- РЕЖИМЫ ---------- */
function setMode(m){
  mode=m;
  document.getElementById('modeTag').textContent =
    m==='draw'?'рисование':m==='station'?'станции':m==='edit'?'редактирование':'выбор';
  document.getElementById('btnDraw').classList.toggle('active', m==='draw');
  document.getElementById('btnDraw').textContent = m==='draw'?'✏️ Рисование: ВКЛ':'✏️ Режим рисования';
  document.getElementById('btnStation').classList.toggle('active', m==='station');
  document.getElementById('btnStation').textContent = m==='station'?'🚉 Станции: ВКЛ':'🚉 Режим станций';
  document.getElementById('btnEdit').classList.toggle('active', m==='edit');
  document.getElementById('btnEdit').textContent = m==='edit'?'✎ Редактирование: ВКЛ':'✎ Режим редактирования';
  svg.style.cursor = m==='select'?'grab':'crosshair';
  // canvas banner
  const banner=document.getElementById('banner');
  if(m==='draw'){
    banner.className='show draw';
    banner.textContent='✏️ Кликайте по карте, чтобы строить линию. Кликните по последней точке — завершить';
  } else if(m==='station'){
    banner.className='show station';
    banner.textContent='🚉 Кликайте у линии, чтобы поставить станцию. Клик по станции — удалить';
  } else if(m==='edit'){
    banner.className='show edit';
    banner.textContent='✎ Тяните точки. Клик по линии — добавить точку, двойной клик по точке — удалить';
  } else {
    banner.className='';
  }
  hideFinishPopup(); hideEditPopup();
  if(m!=='draw'){ finishDrawing(); }
  Log.info('mode →', m);
  render();
}

/* ---------- РИСОВАНИЕ ---------- */
let previewPt=null;
function startDrawing(){
  const r = selRoute();
  if(!r){ toast('Сначала создай или выбери линию слева','err'); return; }
  // Рисуем по ВЫБРАННОЙ линии (продолжаем её). Новые линии — вручную кнопкой.
  if(r.points.length>0) toast('Продолжаем линию «'+r.name+'». Новую — кнопкой «+ Новый маршрут»');
  setMode('draw');
  drawing = state.selectedRoute;
  Log.info('start drawing route', drawing);
}
function createRoute(silent){
  pushHistory();
  const id=uid();
  const n=state.routes.length+1;
  const color=palette[(state.routes.length)%palette.length];
  state.routes.push({id,name:'Линия '+n,num:String(n),
    color,width:8,points:[],stations:[]});
  state.selectedRoute=id;
  Log.info('add route', id);
  renderRouteList(); syncRouteOpts(); render();
  return id;
}
function finishDrawing(){
  if(drawing!=null){ ensureTerminals(getRoute(drawing)); Log.info('finish drawing route', drawing); }
  drawing=null; previewPt=null;
}

/* угол (°) → одно из 8 направлений подписи */
function angleToDir(deg){
  let a=((deg%360)+360)%360;
  return ['e','se','s','sw','w','nw','n','ne'][Math.round(a/45)%8];
}
/* авто-конечные станции (бейдж с номером) на обоих концах линии.
   Помечаются terminal:'start'|'end', чтобы переноситься при продлении. */
function ensureTerminals(r){
  if(!r || r.points.length<2) return;
  r.stations=r.stations||[];
  const ends=[{idx:0,key:'start'},{idx:r.points.length-1,key:'end'}];
  for(const e of ends){
    const p=r.points[e.idx];
    if(state.nodes.some(n=>Math.hypot(n.x-p.x,n.y-p.y)<GRID*0.6)) continue; // на конце пересадка
    const other = e.idx===0 ? r.points[1] : r.points[r.points.length-2];
    const dir = angleToDir(Math.atan2(p.y-other.y, p.x-other.x)*180/Math.PI);
    const term = r.stations.find(s=>s.terminal===e.key);
    if(term){ term.x=p.x; term.y=p.y; term.dir=dir; }
    else r.stations.push({x:p.x,y:p.y,type:'terminus',label:'',dir,fontSize:14,fontWeight:'600',terminal:e.key});
  }
}

/* попап Завершить/Продолжить у последней точки */
function showFinishPopup(){
  const r=getRoute(drawing); if(!r||!r.points.length) return;
  const last=r.points[r.points.length-1];
  const s=worldToScreen(last.x,last.y);
  const wrap=document.getElementById('canvasWrap').getBoundingClientRect();
  const fp=document.getElementById('finishPopup');
  fp.style.left=s.x+'px';
  fp.style.top=s.y+'px';
  fp.classList.add('show');
}
function hideFinishPopup(){ document.getElementById('finishPopup').classList.remove('show'); }

/* ближайшая линия к точке (для выбора кликом в режиме редактирования) */
function hitTestRoute(wx, wy, maxDistScreen){
  let bestId=null, bestD=Infinity;
  for(const r of state.routes){
    if(r.points.length<1) continue;
    const n=nearestOnPolyline(r.points, wx, wy);
    const d=Math.hypot(n.x-wx, n.y-wy)*view.scale;       // в экранных px
    const tol=(maxDistScreen||10)+r.width*view.scale/2;
    if(d<tol && d<bestD){ bestD=d; bestId=r.id; }
  }
  return bestId;
}
/* индекс вершины выбранной линии рядом с точкой (экранный допуск) */
function vertexAt(r, wx, wy){
  for(let i=0;i<r.points.length;i++){
    const p=r.points[i];
    if(Math.hypot(p.x-wx,p.y-wy)*view.scale < 11){ return i; }
  }
  return -1;
}
function addPoint(wx, wy){
  const r=getRoute(drawing); if(!r) return;
  let pt;
  if(r.points.length){
    pt = constrainAngle(r.points[r.points.length-1], wx, wy);
  } else {
    pt = snapPoint(wx, wy);
  }
  pushHistory();
  r.points.push(pt);
  Log.info('add point', pt, 'route', r.id, 'total', r.points.length);
  render(); renderRouteList();
}

/* ---------- СТАНЦИИ ---------- */
function addStation(wx, wy){
  const r=selRoute();
  if(!r){ toast('Выбери маршрут','err'); return; }
  if(r.points.length<1){ toast('У маршрута нет точек','err'); return; }
  // привязка к ближайшей точке на ломаной + сдвиг от изгибов
  const near = stationOnStraight(r.points, wx, wy);
  pushHistory();
  const st={ x:near.x, y:near.y, type:stOpts.type,
    label:document.getElementById('stationLabel').value.trim(),
    dir:stOpts.dir, fontSize:+document.getElementById('fontSize').value,
    fontWeight:document.getElementById('fontWeight').value };
  r.stations=r.stations||[];
  r.stations.push(st);
  Log.info('add station', st, 'route', r.id);
  render(); renderRouteList();
}
function removeStationAt(wx, wy){
  const r=selRoute(); if(!r||!r.stations) return false;
  for(let i=r.stations.length-1;i>=0;i--){
    const s=r.stations[i];
    if(Math.hypot(s.x-wx,s.y-wy) < r.width*1.4 + 6){
      pushHistory();
      r.stations.splice(i,1);
      Log.info('remove station idx',i,'route',r.id);
      render(); renderRouteList();
      return true;
    }
  }
  return false;
}
/* угол (в градусах) касательной линии в ближайшей к (x,y) точке —
   нужен, чтобы станция-«тире» стояла перпендикулярно линии на любом наклоне */
function lineAngleAt(points, x, y){
  if(!points || points.length<2) return 0;
  let bestD=Infinity, ang=0;
  for(let i=0;i<points.length-1;i++){
    const a=points[i], b=points[i+1];
    const dx=b.x-a.x, dy=b.y-a.y, len2=dx*dx+dy*dy||1;
    let t=((x-a.x)*dx+(y-a.y)*dy)/len2; t=Math.max(0,Math.min(1,t));
    const px=a.x+dx*t, py=a.y+dy*t, d=Math.hypot(px-x,py-y);
    if(d<bestD){ bestD=d; ang=Math.atan2(dy,dx)*180/Math.PI; }
  }
  return ang;
}

function nearestOnPolyline(points, x, y){
  if(points.length===1) return {x:points[0].x,y:points[0].y,seg:0,t:0};
  let best={x:points[0].x,y:points[0].y,seg:0,t:0}, bestD=Infinity;
  for(let i=0;i<points.length-1;i++){
    const a=points[i], b=points[i+1];
    const dx=b.x-a.x, dy=b.y-a.y;
    const len2=dx*dx+dy*dy||1;
    let t=((x-a.x)*dx+(y-a.y)*dy)/len2;
    t=Math.max(0,Math.min(1,t));
    const px=a.x+dx*t, py=a.y+dy*t;
    const d=Math.hypot(px-x,py-y);
    if(d<bestD){bestD=d;best={x:px,y:py,seg:i,t};}
  }
  return best;
}

/* положение станции на ПРЯМОМ участке: если ближайшая точка попадает
   в зону скругления у внутреннего излома, сдвигаем её вдоль сегмента
   за пределы дуги, чтобы линия проходила сквозь кружок прямо,
   а поворот оставался после станции. */
function stationOnStraight(points, x, y){
  const n=nearestOnPolyline(points, x, y);
  if(points.length<3) return {x:n.x, y:n.y};
  const i=n.seg, a=points[i], b=points[i+1];
  const segLen=Math.hypot(b.x-a.x, b.y-a.y)||1;
  const ux=(b.x-a.x)/segLen, uy=(b.y-a.y)/segLen;     // направление сегмента
  let s = n.t*segLen;                                  // расстояние от a вдоль сегмента
  const clear = cornerRadius + 2;                      // запас, чтобы выйти за дугу
  // начало сегмента (a) — внутренний излом?
  if(i>0 && s < clear) s = Math.min(clear, segLen/2);
  // конец сегмента (b) — внутренний излом?
  if(i < points.length-2 && (segLen - s) < clear) s = Math.max(segLen - clear, segLen/2);
  return { x:Math.round(a.x+ux*s), y:Math.round(a.y+uy*s) };
}

/* ---------- ПРИЛИПАНИЕ СТАНЦИЙ (параметризация по сегментам) ---------- */
/* {seg,t} ближайшей точки на ломаной */
function segT(points, x, y){ const n=nearestOnPolyline(points,x,y); return {seg:n.seg, t:n.t}; }
/* координата по {seg,t} на текущей геометрии */
function posFromSegT(points, p){
  if(points.length<2) return {x:points[0]?points[0].x:0, y:points[0]?points[0].y:0};
  let seg=Math.max(0, Math.min(p.seg, points.length-2));
  const a=points[seg], b=points[seg+1];
  return { x:a.x+(b.x-a.x)*p.t, y:a.y+(b.y-a.y)*p.t };
}
/* запомнить положения станций маршрута как (seg,t) — до изменения геометрии */
function captureStationParams(r){
  if(!r||!r.stations) return [];
  return r.stations.map(s=> segT(r.points, s.x, s.y));
}
/* вернуть станции на их (seg,t) после изменения геометрии — «прилипание» */
function applyStationParams(r, params){
  if(!r||!r.stations||!params) return;
  for(let i=0;i<r.stations.length;i++){
    if(!params[i]) continue;
    const p=posFromSegT(r.points, params[i]);
    r.stations[i].x=Math.round(p.x); r.stations[i].y=Math.round(p.y);
  }
}
/* длина ломаной и точка на заданном расстоянии вдоль неё */
function polyLen(pts){ let d=0; for(let i=0;i<pts.length-1;i++) d+=Math.hypot(pts[i+1].x-pts[i].x,pts[i+1].y-pts[i].y); return d; }
function pointAtDist(pts, dist){
  if(pts.length<2) return {x:pts[0].x, y:pts[0].y};
  let d=dist;
  for(let i=0;i<pts.length-1;i++){
    const seg=Math.hypot(pts[i+1].x-pts[i].x, pts[i+1].y-pts[i].y);
    if(d<=seg || i===pts.length-2){ const t=seg?Math.max(0,Math.min(1,d/seg)):0;
      return {x:pts[i].x+(pts[i+1].x-pts[i].x)*t, y:pts[i].y+(pts[i+1].y-pts[i].y)*t}; }
    d-=seg;
  }
  const L=pts[pts.length-1]; return {x:L.x,y:L.y};
}
/* доля длины (0..1) для каждой станции — устойчиво к вставке изломов при выравнивании */
function captureStationFracs(r){
  const tot=polyLen(r.points)||1;
  return (r.stations||[]).map(s=>{
    const n=nearestOnPolyline(r.points, s.x, s.y);
    let d=0; for(let i=0;i<n.seg;i++) d+=Math.hypot(r.points[i+1].x-r.points[i].x, r.points[i+1].y-r.points[i].y);
    const a=r.points[n.seg], b=r.points[n.seg+1];
    if(a&&b) d+=n.t*Math.hypot(b.x-a.x,b.y-a.y);
    return d/tot;
  });
}
function applyStationFracs(r, fracs){
  if(!r.stations) return;
  const tot=polyLen(r.points);
  for(let i=0;i<r.stations.length;i++){
    if(fracs[i]==null) continue;
    const p=pointAtDist(r.points, fracs[i]*tot);
    r.stations[i].x=Math.round(p.x); r.stations[i].y=Math.round(p.y);
  }
}

/* заново привязать станции к линии (после удаления вершины) */
function reprojectStations(r){
  if(!r||!r.stations) return;
  for(const s of r.stations){
    const np = s.type==='tick' ? nearestOnPolyline(r.points,s.x,s.y) : stationOnStraight(r.points,s.x,s.y);
    s.x=Math.round(np.x); s.y=Math.round(np.y);
  }
}

/* пересечение двух отрезков (или null) */
function segIntersect(p1,p2,p3,p4){
  const d=(p2.x-p1.x)*(p4.y-p3.y)-(p2.y-p1.y)*(p4.x-p3.x);
  if(Math.abs(d)<1e-6) return null;
  const t=((p3.x-p1.x)*(p4.y-p3.y)-(p3.y-p1.y)*(p4.x-p3.x))/d;
  const u=((p3.x-p1.x)*(p2.y-p1.y)-(p3.y-p1.y)*(p2.x-p1.x))/d;
  if(t<-0.15||t>1.15||u<-0.15||u>1.15) return null;
  return { x:p1.x+t*(p2.x-p1.x), y:p1.y+t*(p2.y-p1.y) };
}

/* ---------- УЗЛЫ ПЕРЕСАДОК ---------- */
function nodeAt(wx,wy){
  for(let i=state.nodes.length-1;i>=0;i--){
    const n=state.nodes[i];
    if(Math.hypot(n.x-wx,n.y-wy) < nodeRadius(n)+6/view.scale) return n;
  }
  return null;
}
function stationAt(r, wx, wy){
  if(!r||!r.stations) return -1;
  for(let i=r.stations.length-1;i>=0;i--){
    const s=r.stations[i];
    if(s.terminal) continue;   // конечные следуют за концом линии, отдельно не тянутся
    if(Math.hypot(s.x-wx,s.y-wy) < r.width*1.2+4/view.scale) return i;
  }
  return -1;
}
/* индексы вершин узлов сдвигаются при вставке/удалении точек */
function reindexInsertNodes(routeId, k){
  for(const n of state.nodes) for(const l of n.links) if(l.routeId===routeId && l.idx>=k) l.idx++;
}
function reindexDeleteNodes(routeId, j){
  for(const n of state.nodes) for(const l of n.links) if(l.routeId===routeId && l.idx>j) l.idx--;
}
function vertexIsNode(routeId, idx){
  return state.nodes.find(n=> n.links.some(l=>l.routeId===routeId && l.idx===idx)) || null;
}
/* гарантировать вершину маршрута в точке pt; вернуть её индекс */
function ensureVertex(r, pt){
  for(let i=0;i<r.points.length;i++){
    if(Math.hypot(r.points[i].x-pt.x, r.points[i].y-pt.y) < GRID*0.8){
      r.points[i]={x:pt.x,y:pt.y}; return i;
    }
  }
  const n=nearestOnPolyline(r.points, pt.x, pt.y);
  const k=n.seg+1;
  r.points.splice(k,0,{x:pt.x,y:pt.y});
  reindexInsertNodes(r.id, k);
  return k;
}
/* поставить пересадку: на пересечение линий, привязать ко всем близким */
function addInterchange(wx, wy){
  const near=[];
  for(const r of state.routes){ if(r.points.length<2) continue;
    const n=nearestOnPolyline(r.points,wx,wy);
    const d=Math.hypot(n.x-wx,n.y-wy);
    if(d*view.scale < 32 + r.width*view.scale/2) near.push({r,n,d});
  }
  if(!near.length){ return false; }
  near.sort((a,b)=>a.d-b.d);
  let pt=null;
  if(near.length>=2){
    const A=near[0], B=near[1];
    const x=segIntersect(A.r.points[A.n.seg],A.r.points[A.n.seg+1],
                          B.r.points[B.n.seg],B.r.points[B.n.seg+1]);
    if(x) pt=snapPoint(x.x, x.y);
  }
  if(!pt) pt=snapPoint(near[0].n.x, near[0].n.y);
  pushHistory();
  const links=[];
  for(const r of state.routes){ if(r.points.length<2) continue;
    const n=nearestOnPolyline(r.points, pt.x, pt.y);
    if(Math.hypot(n.x-pt.x,n.y-pt.y) < GRID*1.3){
      links.push({routeId:r.id, idx:ensureVertex(r, pt)});
    }
  }
  if(!links.length) links.push({routeId:near[0].r.id, idx:ensureVertex(near[0].r, pt)});
  const node={ id:uid(), x:pt.x, y:pt.y, type:stOpts.type,
    label:document.getElementById('stationLabel').value.trim(),
    dir:stOpts.dir, fontSize:+document.getElementById('fontSize').value,
    fontWeight:document.getElementById('fontWeight').value, links };
  state.nodes.push(node);
  Log.info('add interchange node', node.id, 'links', links.length, 'at', pt);
  render(); renderRouteList();
  return true;
}
/* добавить обычную станцию на конкретный маршрут */
function addStationTo(routeId, wx, wy){
  const r=getRoute(routeId); if(!r||r.points.length<1) return;
  const near = stOpts.type==='tick' ? nearestOnPolyline(r.points,wx,wy) : stationOnStraight(r.points,wx,wy);
  pushHistory();
  r.stations=r.stations||[];
  r.stations.push({ x:Math.round(near.x), y:Math.round(near.y), type:stOpts.type,
    label:document.getElementById('stationLabel').value.trim(),
    dir:stOpts.dir, fontSize:+document.getElementById('fontSize').value,
    fontWeight:document.getElementById('fontWeight').value });
  Log.info('add station', stOpts.type, 'route', routeId);
  render(); renderRouteList();
}
/* удалить станцию или узел рядом с точкой */
function removeStationOrNodeAt(wx, wy){
  const nd=nodeAt(wx,wy);
  if(nd){ pushHistory(); state.nodes=state.nodes.filter(n=>n.id!==nd.id); Log.info('remove node',nd.id); render(); renderRouteList(); return true; }
  for(const r of state.routes){ if(!r.stations) continue;
    for(let i=r.stations.length-1;i>=0;i--){ const s=r.stations[i];
      if(Math.hypot(s.x-wx,s.y-wy) < r.width*1.4+6){
        pushHistory(); r.stations.splice(i,1); render(); renderRouteList(); return true;
      }
    }
  }
  return false;
}
function startPan(e){ isPanning=true; panStart={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y}; svg.style.cursor='grabbing'; }

/* привести узлы в соответствие с вершинами маршрута после его изменения:
   узел встаёт на свою вершину этого маршрута, остальные линии узла подтягиваются */
function resyncNodesForRoute(r){
  for(const n of state.nodes){
    const lk=n.links.find(l=>l.routeId===r.id);
    if(!lk || !r.points[lk.idx]) continue;
    const p=r.points[lk.idx];
    n.x=p.x; n.y=p.y;
    for(const l of n.links){
      if(l.routeId===r.id) continue;
      const r2=getRoute(l.routeId);
      if(r2 && r2.points[l.idx]) r2.points[l.idx]={x:p.x, y:p.y};
    }
  }
}
/* направление P→Q совпадает с одной из линий сетки? */
function isGridDir(P, Q){
  const dx=Q.x-P.x, dy=Q.y-P.y;
  if(dx===0 && dy===0) return true;
  const ors=gridOrientations(); if(!ors) return true;
  for(const o of ors){ if(Math.abs(dx*o[1]-dy*o[0]) < 0.5) return true; }
  return false;
}
function samePt(a,b){ return Math.abs(a.x-b.x)<0.5 && Math.abs(a.y-b.y)<0.5; }

/* выровнять линию строго по линиям сетки.
   Узлы-пересадки — ЯКОРЯ (не двигаются, другие линии не страдают).
   Где сегмент к якорю не ложится на сетку — вставляем излом (доп. точку). */
function alignRoute(r){
  if(!r || r.points.length<2) return;
  const fracs=captureStationFracs(r);   // позиции станций как доля длины (устойчиво к изломам)
  const anchor=new Set();
  for(const n of state.nodes) for(const l of n.links) if(l.routeId===r.id) anchor.add(l.idx);
  const orig=r.points, out=[];
  out.push(anchor.has(0) ? {x:orig[0].x,y:orig[0].y} : snapPoint(orig[0].x,orig[0].y));
  for(let i=1;i<orig.length;i++){
    const prev=out[out.length-1];
    if(anchor.has(i)){
      const Q={x:orig[i].x, y:orig[i].y};        // якорь не двигаем
      if(!isGridDir(prev, Q)){                    // нужен излом
        const M=rigidVertex(prev, Q, (prev.x+Q.x)/2, (prev.y+Q.y)/2);
        if(M && !samePt(M,prev) && !samePt(M,Q)) out.push(M);
      }
      out.push(Q);
    } else {
      out.push(constrainAngle(prev, orig[i].x, orig[i].y));
    }
  }
  r.points=out;
  // переиндексация узлов этого маршрута по позициям якорей
  for(const n of state.nodes) for(const l of n.links) if(l.routeId===r.id){
    const k=out.findIndex(p=>p.x===n.x && p.y===n.y);
    if(k>=0) l.idx=k;
  }
  applyStationFracs(r, fracs);   // станции — по доле длины
  ensureTerminals(r);            // конечные — точно на концах (с верным направлением)
}

/* ---------- СОБЫТИЯ ХОЛСТА ---------- */
let isPanning=false, panStart=null, spaceDown=false, draggingHandle=null;

svg.addEventListener('mousedown', e=>{
  hideEditPopup();   // любой клик по холсту убирает попап точки (он не должен перехватывать клики)
  const rect=svg.getBoundingClientRect();
  const sx=e.clientX-rect.left, sy=e.clientY-rect.top;
  const w=screenToWorld(sx,sy);

  // pan: middle button OR space held OR select mode drag on empty
  if(e.button===1 || (spaceDown && e.button===0)){
    isPanning=true; panStart={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y};
    svg.style.cursor='grabbing'; e.preventDefault(); return;
  }

  if(mode==='draw' && e.button===0){
    const r=getRoute(drawing);
    // клик по последней точке → попап Завершить/Продолжить (точку не добавляем)
    if(r && r.points.length>=2){
      const last=r.points[r.points.length-1];
      if(Math.hypot(last.x-w.x,last.y-w.y)*view.scale < 12){ showFinishPopup(); return; }
    }
    hideFinishPopup();
    addPoint(w.x,w.y); return;
  }
  if(mode==='station' && e.button===0){
    // удаление узла/станции по клику
    if(removeStationOrNodeAt(w.x,w.y)) return;
    if(stOpts.type==='interchange' || stOpts.type==='mega'){
      if(!addInterchange(w.x,w.y)){ startPan(e); }   // нет линий рядом → пан
      return;
    }
    // обычная станция — только если клик ПО линии, иначе пан
    const hit=hitTestRoute(w.x,w.y);
    if(hit){ state.selectedRoute=hit; syncRouteOpts(); renderRouteList(); addStationTo(hit,w.x,w.y); }
    else { startPan(e); }
    return;
  }
  if(mode==='edit' && e.button===0){
    // a) схватить узел-пересадку → тянем все его линии
    const nd=nodeAt(w.x,w.y);
    if(nd){
      draggingHandle={kind:'node', nodeId:nd.id, moved:false,
        perRoute:nd.links.map(l=>({routeId:l.routeId, idx:l.idx, sparams:captureStationParams(getRoute(l.routeId))}))};
      return;
    }
    const r=selRoute();
    if(r){
      // b) схватить станцию выбранной линии
      const si=stationAt(r,w.x,w.y);
      if(si>=0){ draggingHandle={kind:'station', route:r.id, idx:si, moved:false}; return; }
      // c) схватить вершину
      const vi=vertexAt(r,w.x,w.y);
      if(vi>=0){
        const nodeForVtx=vertexIsNode(r.id, vi);
        if(nodeForVtx){
          draggingHandle={kind:'node', nodeId:nodeForVtx.id, moved:false,
            perRoute:nodeForVtx.links.map(l=>({routeId:l.routeId, idx:l.idx, sparams:captureStationParams(getRoute(l.routeId))}))};
          return;
        }
        draggingHandle={kind:'vertex', route:r.id, idx:vi, moved:false, sparams:captureStationParams(r)};
        return;
      }
      // d) клик по телу выбранной линии → вставить вершину и сразу тянуть
      if(r.points.length>=2){
        const n=nearestOnPolyline(r.points,w.x,w.y);
        if(Math.hypot(n.x-w.x,n.y-w.y)*view.scale < 8 + r.width*view.scale/2){
          pushHistory();
          r.points.splice(n.seg+1,0,{x:snap(n.x),y:snap(n.y)});
          reindexInsertNodes(r.id, n.seg+1);
          draggingHandle={kind:'vertex', route:r.id, idx:n.seg+1, moved:true, sparams:captureStationParams(r)};
          Log.info('insert vertex at seg',n.seg);
          render(); renderRouteList(); return;
        }
      }
    }
    // e) клик по другой линии → выбрать её
    const hit=hitTestRoute(w.x,w.y);
    if(hit && hit!==state.selectedRoute){ state.selectedRoute=hit; syncRouteOpts(); renderRouteList(); render(); return; }
    startPan(e); return;   // f) иначе пан
  }
  // select mode: клик по линии выбирает её, иначе — пан
  if(mode==='select' && e.button===0){
    const hit=hitTestRoute(w.x,w.y);
    if(hit){ state.selectedRoute=hit; syncRouteOpts(); renderRouteList(); render(); return; }
    startPan(e);
  }
});

window.addEventListener('mousemove', e=>{
  if(!isPanning && !draggingHandle && !(mode==='draw' && drawing!=null)) return;
  const rect=svg.getBoundingClientRect();
  const sx=e.clientX-rect.left, sy=e.clientY-rect.top;
  const w=screenToWorld(sx,sy);

  if(isPanning && panStart){
    view.x=panStart.vx+(e.clientX-panStart.x);
    view.y=panStart.vy+(e.clientY-panStart.y);
    render(); return;
  }
  if(draggingHandle){
    if(!draggingHandle.moved){ pushHistory(); draggingHandle.moved=true; }
    const k=draggingHandle.kind || 'vertex';
    if(k==='vertex'){
      const r=getRoute(draggingHandle.route);
      const idx=draggingHandle.idx;
      const A = idx>0 ? r.points[idx-1] : null;
      const B = idx<r.points.length-1 ? r.points[idx+1] : null;
      if(A && B && gridType()!=='free'){
        // жёстко: оба соседних сегмента остаются на линиях сетки
        r.points[idx] = rigidVertex(A, B, w.x, w.y);
      } else {
        const nb = A || B;
        r.points[idx] = nb ? constrainAngle(nb, w.x, w.y) : snapPoint(w.x, w.y);
      }
      applyStationParams(r, draggingHandle.sparams);   // станции «прилипают»
      render(); return;
    }
    if(k==='station'){
      const r=getRoute(draggingHandle.route);
      const st=r.stations[draggingHandle.idx];
      const np = st.type==='tick' ? nearestOnPolyline(r.points,w.x,w.y) : stationOnStraight(r.points,w.x,w.y);
      st.x=Math.round(np.x); st.y=Math.round(np.y);
      render(); return;
    }
    if(k==='node'){
      const node=state.nodes.find(n=>n.id===draggingHandle.nodeId);
      const np=snapPoint(w.x, w.y);
      node.x=np.x; node.y=np.y;
      for(const pr of draggingHandle.perRoute){
        const r=getRoute(pr.routeId);
        if(!r) continue;
        r.points[pr.idx]={x:np.x, y:np.y};      // вершина каждой линии следует за узлом
        applyStationParams(r, pr.sparams);       // станции этих линий прилипают
      }
      render(); return;
    }
  }
  if(mode==='draw' && drawing!=null){
    const r=getRoute(drawing);
    if(r && r.points.length){
      previewPt=constrainAngle(r.points[r.points.length-1], w.x, w.y);
      render();
    }
  }
});

window.addEventListener('mouseup', e=>{
  if(isPanning){ isPanning=false; svg.style.cursor=mode==='select'?'grab':'crosshair'; }
  if(draggingHandle){
    const dh=draggingHandle; draggingHandle=null; renderRouteList();
    // клик по вершине без перетаскивания → попап (удалить / продлить)
    if(!dh.moved && dh.kind==='vertex'){ showEditPopup(dh.route, dh.idx); }
  }
});

svg.addEventListener('dblclick', e=>{
  const rect=svg.getBoundingClientRect();
  const w=screenToWorld(e.clientX-rect.left, e.clientY-rect.top);
  if(mode==='edit'){
    const r=selRoute(); if(!r) return;
    const vi=vertexAt(r,w.x,w.y);
    if(vi>=0){ showEditPopup(r.id, vi); }
  }
});

/* попап у точки: удалить, а для конца линии — ещё и продлить */
function showEditPopup(routeId, idx){
  editTarget={routeId, idx};
  const r=getRoute(routeId); const p=r.points[idx];
  const isEnd = r.points.length>=2 && (idx===0 || idx===r.points.length-1);
  document.getElementById('epExtend').style.display = isEnd ? 'inline-block' : 'none';
  const s=worldToScreen(p.x,p.y);
  const ep=document.getElementById('editPopup');
  ep.style.left=s.x+'px'; ep.style.top=s.y+'px'; ep.classList.add('show');
}
function hideEditPopup(){ document.getElementById('editPopup').classList.remove('show'); editTarget=null; }

/* развернуть порядок точек маршрута (чтобы продлевать от его начала) */
function reverseRoute(r){
  r.points.reverse();
  const L=r.points.length;
  for(const n of state.nodes) for(const l of n.links) if(l.routeId===r.id) l.idx=L-1-l.idx;
  if(r.stations) for(const s of r.stations){
    if(s.terminal==='start') s.terminal='end'; else if(s.terminal==='end') s.terminal='start';
  }
}
/* продлить линию от выбранного конца — переключиться в режим рисования */
function extendFromVertex(routeId, idx){
  const r=getRoute(routeId); if(!r) return;
  const last=r.points.length-1;
  if(idx!==0 && idx!==last){ toast('Продлевать можно только с конца линии','err'); return; }
  if(idx===0) reverseRoute(r);       // продлеваем добавлением в конец
  state.selectedRoute=routeId;
  hideEditPopup();
  setMode('draw');
  drawing=routeId;
  syncRouteOpts(); renderRouteList();
  toast('Продолжайте линию — кликайте по карте');
}
function deleteVertexTarget(){
  if(!editTarget) return;
  const r=getRoute(editTarget.routeId); if(!r){ hideEditPopup(); return; }
  const idx=editTarget.idx;
  if(r.points.length<=2){ toast('В линии минимум 2 точки','err'); hideEditPopup(); return; }
  if(vertexIsNode(r.id, idx)){ toast('Это узел пересадки — удалите пересадку в режиме станций','err'); hideEditPopup(); return; }
  pushHistory();
  r.points.splice(idx,1);
  reindexDeleteNodes(r.id, idx);
  reprojectStations(r);
  Log.info('delete vertex', idx, 'route', r.id);
  hideEditPopup(); render(); renderRouteList();
}
document.getElementById('epDelete').onclick=deleteVertexTarget;
document.getElementById('epCancel').onclick=hideEditPopup;
document.getElementById('epExtend').onclick=()=>{ if(editTarget) extendFromVertex(editTarget.routeId, editTarget.idx); };

/* zoom */
svg.addEventListener('wheel', e=>{
  e.preventDefault();
  hideFinishPopup(); hideEditPopup();
  const rect=svg.getBoundingClientRect();
  const sx=e.clientX-rect.left, sy=e.clientY-rect.top;
  const before=screenToWorld(sx,sy);
  const factor = e.deltaY<0 ? 1.12 : 1/1.12;
  view.scale=Math.max(0.15,Math.min(6, view.scale*factor));
  const after=screenToWorld(sx,sy);
  view.x += (after.x-before.x)*view.scale;
  view.y += (after.y-before.y)*view.scale;
  updateZoomTag(); render();
},{passive:false});

function updateZoomTag(){ document.getElementById('zoomTag').textContent=Math.round(view.scale*100)+'%'; }

/* keyboard */
window.addEventListener('keydown', e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT') return;
  if(e.code==='Space'){ spaceDown=true; svg.style.cursor='grab'; e.preventDefault(); }
  if(e.key==='Escape'){ hideFinishPopup(); finishDrawing(); setMode('select'); }
  if(e.key==='Enter' && mode==='draw' && drawing!=null){ showFinishPopup(); }
  if(e.key==='Backspace' && mode==='draw' && drawing!=null){
    const r=getRoute(drawing); if(r&&r.points.length){ pushHistory(); r.points.pop(); render(); renderRouteList(); }
    e.preventDefault();
  }
  if((e.ctrlKey||e.metaKey)&&e.key==='z'){ e.preventDefault(); undo(); }
  if((e.ctrlKey||e.metaKey)&&(e.key==='y'||(e.shiftKey&&e.key==='z'))){ e.preventDefault(); redo(); }
});
window.addEventListener('keyup', e=>{
  if(e.code==='Space'){ spaceDown=false; svg.style.cursor=mode==='select'?'grab':'crosshair'; }
});

/* ---------- ДЕЙСТВИЯ UI ---------- */
const palette=['#e3242b','#0098d4','#00a651','#f9a01b','#7b2d8e','#8c4a2f','#e377c2','#111111'];
document.getElementById('btnAddRoute').onclick=()=>{ finishDrawing(); createRoute(); startDrawing(); };
document.getElementById('btnDelRoute').onclick=()=>{
  const r=selRoute(); if(!r) return;
  if(!confirm('Удалить маршрут "'+r.name+'"?')) return;
  pushHistory();
  state.routes=state.routes.filter(x=>x.id!==r.id);
  // вычистить ссылки узлов на удалённый маршрут, убрать опустевшие узлы
  for(const n of state.nodes) n.links=n.links.filter(l=>l.routeId!==r.id);
  state.nodes=state.nodes.filter(n=>n.links.length>0);
  state.selectedRoute=state.routes.length?state.routes[0].id:null;
  Log.info('delete route', r.id);
  renderRouteList(); syncRouteOpts(); render();
};
document.getElementById('routeName').oninput=e=>{ const r=selRoute(); if(r){r.name=e.target.value; renderRouteList();} };
document.getElementById('routeName').onchange=()=>pushHistory();
document.getElementById('routeNum').oninput=e=>{ const r=selRoute(); if(r){r.num=e.target.value; render();} };
document.getElementById('routeNum').onchange=()=>pushHistory();
document.getElementById('bgChoice').onchange=e=>{ setBg(e.target.value); Log.info('bg', e.target.value); };
document.getElementById('routeColor').oninput=e=>{ const r=selRoute(); if(r){r.color=e.target.value; renderRouteList(); render();} };
document.getElementById('routeColor').onchange=()=>pushHistory();
document.getElementById('routeWidth').oninput=e=>{ const r=selRoute(); if(r){r.width=+e.target.value; document.getElementById('widthVal').textContent=e.target.value; render();} };
document.getElementById('routeWidth').onchange=()=>pushHistory();

document.getElementById('btnDraw').onclick=()=>{ mode==='draw'?setMode('select'):startDrawing(); };
document.getElementById('btnEdit').onclick=()=>{ mode==='edit'?setMode('select'):setMode('edit'); };
document.getElementById('btnAlign').onclick=()=>{
  const r=selRoute(); if(!r){ toast('Выбери линию','err'); return; }
  if(mode!=='edit') setMode('edit');
  pushHistory(); alignRoute(r);
  Log.info('align route', r.id); render(); renderRouteList(); toast('Линия выровнена по углам');
};
document.getElementById('btnAlignAll').onclick=()=>{
  if(!state.routes.length){ toast('Нет линий','err'); return; }
  if(mode!=='edit') setMode('edit');
  pushHistory();
  for(const r of state.routes) alignRoute(r);
  Log.info('align all routes', state.routes.length);
  render(); renderRouteList(); toast('Все линии выровнены по сетке');
};
document.getElementById('fpFinish').onclick=()=>{ hideFinishPopup(); finishDrawing(); setMode('select'); toast('Линия завершена'); };
document.getElementById('fpContinue').onclick=()=>{ hideFinishPopup(); };
document.getElementById('angleStep').onchange=e=>{ angleStepDeg=+e.target.value; Log.info('angle step', angleStepDeg); render(); };
document.getElementById('cornerRadius').oninput=e=>{ cornerRadius=+e.target.value; document.getElementById('cornerVal').textContent=e.target.value; render(); };
document.getElementById('btnStation').onclick=()=>{ mode==='station'?setMode('select'):setMode('station'); };

/* station option pickers */
function bindTypeSeg(id){
  document.querySelectorAll('#'+id+' button').forEach(b=>{
    b.onclick=()=>{
      document.querySelectorAll('#stationType button,#stationType2 button').forEach(x=>x.classList.remove('sel'));
      b.classList.add('sel'); stOpts.type=b.dataset.t; Log.info('station type', stOpts.type);
    };
  });
}
bindTypeSeg('stationType'); bindTypeSeg('stationType2');
document.querySelectorAll('#dirGrid button').forEach(b=>{
  b.onclick=()=>{ document.querySelectorAll('#dirGrid button').forEach(x=>x.classList.remove('sel'));
    b.classList.add('sel'); stOpts.dir=b.dataset.d; };
});
document.getElementById('fontSize').onchange=e=>stOpts.fontSize=+e.target.value;

/* toolbar */
document.getElementById('tbUndo').onclick=undo;
document.getElementById('tbRedo').onclick=redo;
document.getElementById('tbZoomIn').onclick=()=>{ zoomCenter(1.2); };
document.getElementById('tbZoomOut').onclick=()=>{ zoomCenter(1/1.2); };
document.getElementById('tbZoomReset').onclick=()=>{ view.scale=1; updateZoomTag(); render(); };
document.getElementById('tbFit').onclick=fitToContent;
function zoomCenter(f){
  const cx=svg.clientWidth/2, cy=svg.clientHeight/2;
  const before=screenToWorld(cx,cy);
  view.scale=Math.max(0.15,Math.min(6,view.scale*f));
  const after=screenToWorld(cx,cy);
  view.x+=(after.x-before.x)*view.scale; view.y+=(after.y-before.y)*view.scale;
  updateZoomTag(); render();
}
function bbox(){
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,has=false;
  for(const r of state.routes){
    for(const p of r.points){has=true;minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}
    for(const s of (r.stations||[])){has=true;minX=Math.min(minX,s.x);minY=Math.min(minY,s.y);maxX=Math.max(maxX,s.x);maxY=Math.max(maxY,s.y);}
  }
  for(const n of (state.nodes||[])){has=true;minX=Math.min(minX,n.x);minY=Math.min(minY,n.y);maxX=Math.max(maxX,n.x);maxY=Math.max(maxY,n.y);}
  return has?{minX,minY,maxX,maxY}:null;
}
function fitToContent(){
  const b=bbox(); if(!b){ view={x:svg.clientWidth/2,y:svg.clientHeight/2,scale:1}; updateZoomTag(); render(); return; }
  const pad=80;
  const bw=(b.maxX-b.minX)||100, bh=(b.maxY-b.minY)||100;
  const s=Math.min((svg.clientWidth-pad*2)/bw,(svg.clientHeight-pad*2)/bh,3);
  view.scale=Math.max(0.15,s);
  view.x=(svg.clientWidth - bw*view.scale)/2 - b.minX*view.scale;
  view.y=(svg.clientHeight - bh*view.scale)/2 - b.minY*view.scale;
  updateZoomTag(); render();
}

/* grid + log toggles */
document.getElementById('btnGrid').onclick=e=>{ showGrid=!showGrid; e.target.textContent='Сетка: '+(showGrid?'вкл':'выкл'); render(); };
document.getElementById('btnLog').onclick=()=>{ document.getElementById('logPanel').classList.toggle('open'); };
Log.el=document.getElementById('logBody');
document.getElementById('logClose').onclick=()=>document.getElementById('logPanel').classList.remove('open');
document.getElementById('logDownload').onclick=()=>Log.download();
document.getElementById('logClear').onclick=()=>Log.clear();

/* ---------- СОХРАНЕНИЕ / ЗАГРУЗКА ---------- */
const overlay=document.getElementById('overlay');
let modalMode='save';
function openModal(title,hint,text,action,actionLabel){
  document.getElementById('modalTitle').textContent=title;
  document.getElementById('modalHint').textContent=hint;
  document.getElementById('modalText').value=text;
  document.getElementById('modalText').readOnly = (action==null);
  const ab=document.getElementById('modalAction');
  ab.style.display=action?'inline-block':'none';
  ab.textContent=actionLabel||'OK';
  ab.onclick=action;
  overlay.classList.add('open');
}
document.getElementById('modalCancel').onclick=()=>overlay.classList.remove('open');
document.getElementById('modalCopy').onclick=()=>{
  navigator.clipboard.writeText(document.getElementById('modalText').value).then(()=>toast('Скопировано'));
};
document.getElementById('btnSaveJson').onclick=()=>{
  openModal('Код карты','Скопируй код в текстовый файл, чтобы продолжить позже.',
    JSON.stringify(state), null);
};
document.getElementById('btnLoadJson').onclick=()=>{
  openModal('Загрузить карту','Вставь сюда код карты и нажми «Загрузить».','',()=>{
    try{
      const obj=JSON.parse(document.getElementById('modalText').value);
      if(!obj.routes) throw new Error('нет поля routes');
      pushHistory(); state=obj;
      state.nodes=state.nodes||[];
      state.nextId=state.nextId||Math.max(1,...state.routes.map(r=>r.id))+1;
      state.selectedRoute=state.routes.length?state.routes[0].id:null;
      overlay.classList.remove('open');
      renderRouteList(); syncRouteOpts(); fitToContent();
      Log.info('map loaded, routes:',state.routes.length); toast('Карта загружена');
    }catch(err){ Log.error('load failed', err.message); toast('Ошибка: '+err.message,'err'); }
  },'Загрузить');
};

/* ---------- ПОДЕЛИТЬСЯ ССЫЛКОЙ (карта в адресе) ---------- */
function stateToParam(){ return btoa(unescape(encodeURIComponent(JSON.stringify(state)))); }
function paramToState(p){ return JSON.parse(decodeURIComponent(escape(atob(p)))); }
function loadFromHash(){
  const m=(location.hash||'').match(/map=([^&]+)/);
  if(!m) return false;
  try{
    const obj=paramToState(m[1]);
    if(!obj || !obj.routes) return false;
    state=obj; state.nodes=state.nodes||[];
    state.selectedRoute=state.routes.length?state.routes[0].id:null;
    state.nextId=state.nextId||(Math.max(1,...state.routes.map(r=>r.id))+1);
    Log.info('map loaded from URL, routes:', state.routes.length);
    return true;
  }catch(e){ Log.error('hash load failed', e.message); return false; }
}
document.getElementById('btnShare').onclick=()=>{
  try{
    const b64=stateToParam();
    const url=location.origin+location.pathname+'#map='+b64;
    window.history.replaceState(null,'','#map='+b64);   // сохранить в адресной строке
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(url).then(()=>toast('Ссылка скопирована')).catch(()=>{
        openModal('Ссылка на карту','Скопируйте ссылку вручную:', url, null);
      });
    } else {
      openModal('Ссылка на карту','Скопируйте ссылку вручную:', url, null);
    }
    Log.info('share link', url.length, 'символов');
    if(url.length>16000) toast('Карта большая — ссылка длинная, но рабочая','err');
  }catch(e){ Log.error('share failed', e.message); toast('Не удалось создать ссылку','err'); }
};

/* ---------- СООБЩИТЬ О ПРОБЛЕМЕ ---------- */
function gatherReport(desc){
  return { description:String(desc||''), map:JSON.stringify(state),
    ua:navigator.userAgent, window:window.innerWidth+'x'+window.innerHeight,
    zoom:Math.round(view.scale*100), angle:angleStepDeg,
    routes:state.routes.length, nodes:(state.nodes||[]).length,
    log:Log.buf.slice(-80).join('\n'), time:new Date().toISOString() };
}
async function sendReport(){
  const desc=document.getElementById('modalText').value.trim();
  if(!desc){ toast('Опишите проблему','err'); return; }
  const payload=gatherReport(desc);
  const ab=document.getElementById('modalAction'); ab.disabled=true; ab.textContent='Отправка…';
  try{
    const res=await fetch('/api/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!res.ok) throw new Error('HTTP '+res.status);
    overlay.classList.remove('open'); toast('Спасибо! Отчёт отправлен'); Log.info('report sent ok');
  }catch(e){
    Log.error('report send failed', e.message);
    // фолбэк: показать всё для ручной отправки (локальный файл / бэкенд недоступен)
    openModal('Не удалось отправить автоматически',
      'Бэкенд недоступен (или открыт локальный файл). Скопируйте текст и пришлите вручную:',
      desc+'\n\n----- тех.данные -----\n'+JSON.stringify(payload,null,2), null);
  } finally { ab.disabled=false; ab.textContent='Отправить'; }
}
document.getElementById('btnReport').onclick=()=>{
  openModal('Сообщить о проблеме',
    'Опишите, что пошло не так. Код карты, журнал и данные браузера приложатся автоматически.',
    '', sendReport, 'Отправить');
  document.getElementById('modalText').placeholder='Например: при выравнивании линия 2 ушла с сетки…';
};

/* ---------- ЭКСПОРТ ---------- */
function buildExportSVG(scale=2){
  const b=bbox(); if(!b){ toast('Пустая карта','err'); return null; }
  const pad=40;
  const w=(b.maxX-b.minX)+pad*2, h=(b.maxY-b.minY)+pad*2;
  const ns=SVGNS;
  const out=document.createElementNS(ns,'svg');
  out.setAttribute('xmlns',ns);
  out.setAttribute('width',w); out.setAttribute('height',h);
  out.setAttribute('viewBox',`${b.minX-pad} ${b.minY-pad} ${w} ${h}`);
  const bg=document.createElementNS(ns,'rect');
  bg.setAttribute('x',b.minX-pad);bg.setAttribute('y',b.minY-pad);
  bg.setAttribute('width',w);bg.setAttribute('height',h);bg.setAttribute('fill','#ffffff');
  out.appendChild(bg);
  const g=document.createElementNS(ns,'g');
  // lines
  for(const r of state.routes){
    if(r.points.length>=2){
      const p=document.createElementNS(ns,'path');
      p.setAttribute('d', roundedPathData(r.points, cornerRadius));
      p.setAttribute('fill','none');p.setAttribute('stroke',r.color);
      p.setAttribute('stroke-width',r.width);p.setAttribute('stroke-linejoin','round');
      p.setAttribute('stroke-linecap','round');
      g.appendChild(p);
    }
  }
  for(const r of state.routes) for(const st of (r.stations||[])) drawStation(g,r,st,'#1a1a1a');
  for(const n of (state.nodes||[])) drawNode(g,n,'#1a1a1a');
  out.appendChild(g);
  return out;
}
document.getElementById('btnExportSvg').onclick=()=>{
  const out=buildExportSVG(); if(!out) return;
  const s=new XMLSerializer().serializeToString(out);
  const blob=new Blob([s],{type:'image/svg+xml'});
  const u=URL.createObjectURL(blob);const a=document.createElement('a');
  a.href=u;a.download='metro-map.svg';a.click();
  setTimeout(()=>URL.revokeObjectURL(u),1000);
  Log.info('export SVG'); toast('SVG сохранён');
};
document.getElementById('btnExportPng').onclick=()=>{
  const out=buildExportSVG(); if(!out) return;
  const scale=2;
  const w=+out.getAttribute('width'), h=+out.getAttribute('height');
  const s=new XMLSerializer().serializeToString(out);
  const img=new Image();
  const svgBlob=new Blob([s],{type:'image/svg+xml;charset=utf-8'});
  const url=URL.createObjectURL(svgBlob);
  img.onload=()=>{
    const c=document.createElement('canvas');
    c.width=w*scale; c.height=h*scale;
    const ctx=c.getContext('2d');
    ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height);
    ctx.drawImage(img,0,0,c.width,c.height);
    URL.revokeObjectURL(url);
    c.toBlob(bl=>{
      const u=URL.createObjectURL(bl);const a=document.createElement('a');
      a.href=u;a.download='metro-map.png';a.click();
      setTimeout(()=>URL.revokeObjectURL(u),1000);
      Log.info('export PNG'); toast('PNG сохранён');
    },'image/png');
  };
  img.onerror=(e)=>{ Log.error('PNG render error'); toast('Ошибка экспорта PNG','err'); };
  img.src=url;
};

/* ---------- ОЧИСТКА / ПРИМЕР ---------- */
document.getElementById('btnClear').onclick=()=>{
  if(!confirm('Очистить всю карту?')) return;
  pushHistory();
  state={routes:[],nodes:[],selectedRoute:null,nextId:1};
  renderRouteList(); syncRouteOpts(); render(); Log.info('cleared');
};
document.getElementById('btnSample').onclick=loadSample;

function loadSample(){
  pushHistory();
  state={routes:[],nodes:[],selectedRoute:null,nextId:1};
  const G=GRID;
  // Красная линия (горизонталь с изгибом)
  const red={id:uid(),name:'Красная',num:'1',color:'#e3242b',width:9,
    points:[{x:2*G,y:6*G},{x:6*G,y:6*G},{x:9*G,y:9*G},{x:14*G,y:9*G},{x:18*G,y:9*G}],
    stations:[
      {x:2*G,y:6*G,type:'terminus',label:'Западная',dir:'n',fontSize:14,fontWeight:'600'},
      {x:6*G,y:6*G,type:'dot',label:'Парк',dir:'n',fontSize:13,fontWeight:'600'},
      {x:14*G,y:9*G,type:'dot',label:'Рынок',dir:'s',fontSize:13,fontWeight:'600'},
      {x:18*G,y:9*G,type:'terminus',label:'Восточная',dir:'e',fontSize:14,fontWeight:'600'}
    ]};
  // Синяя линия (вертикаль через центр)
  const blue={id:uid(),name:'Синяя',num:'2',color:'#0098d4',width:9,
    points:[{x:9*G,y:3*G},{x:9*G,y:9*G},{x:9*G,y:15*G}],
    stations:[
      {x:9*G,y:3*G,type:'terminus',label:'Север',dir:'n',fontSize:14,fontWeight:'600'},
      {x:9*G,y:6*G,type:'dot',label:'Музей',dir:'e',fontSize:13,fontWeight:'600'},
      {x:9*G,y:12*G,type:'dot',label:'Стадион',dir:'e',fontSize:13,fontWeight:'600'},
      {x:9*G,y:15*G,type:'terminus',label:'Юг',dir:'s',fontSize:14,fontWeight:'600'}
    ]};
  // Зелёная диагональ
  const green={id:uid(),name:'Зелёная',num:'3',color:'#00a651',width:9,
    points:[{x:4*G,y:14*G},{x:9*G,y:9*G},{x:13*G,y:5*G}],
    stations:[
      {x:4*G,y:14*G,type:'terminus',label:'Озеро',dir:'sw',fontSize:14,fontWeight:'600'}
    ]};
  state.routes=[red,blue,green];
  // Центр — пересадка трёх линий на пересечении (9G,9G)
  state.nodes.push({id:uid(),x:9*G,y:9*G,type:'interchange',label:'Центр',dir:'sw',
    fontSize:14,fontWeight:'600',
    links:[{routeId:red.id,idx:2},{routeId:blue.id,idx:1},{routeId:green.id,idx:1}]});
  // Аэропорт — мега-станция на конце зелёной
  state.nodes.push({id:uid(),x:13*G,y:5*G,type:'mega',label:'Аэропорт',dir:'ne',
    fontSize:14,fontWeight:'600',links:[{routeId:green.id,idx:2}]});
  state.selectedRoute=red.id;
  renderRouteList(); syncRouteOpts(); fitToContent();
  Log.info('sample loaded'); toast('Пример загружен');
}

/* ---------- TOAST ---------- */
let toastTimer=null;
function toast(msg,type){
  const t=document.getElementById('toast');
  t.textContent=msg; t.className='toast show'+(type==='err'?' err':'');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove('show'),2200);
}

/* ---------- ИНИЦИАЛИЗАЦИЯ ---------- */
function init(){
  Log.info('editor init');
  view={x:0,y:0,scale:1};
  // центр координат (0,0) примерно в центр экрана
  view.x=svg.clientWidth/2;
  view.y=svg.clientHeight/2;
  // чистый холст + одна пустая линия, сразу режим рисования
  state={routes:[],nodes:[],selectedRoute:null,nextId:1};
  history=[]; future=[];
  setBg('#ffffff');         // белый фон по умолчанию
  if(loadFromHash()){
    renderRouteList(); syncRouteOpts(); setMode('select'); fitToContent();
  } else {
    createRoute(true);
    startDrawing();         // первый же клик ставит точку
    renderRouteList(); syncRouteOpts();
  }
  updateUndoButtons();
  updateZoomTag();
  window.addEventListener('resize', render);
  render();
}
init();
