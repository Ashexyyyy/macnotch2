import {useEffect,useRef,useState} from "react"; import {invoke} from "@tauri-apps/api/core";
type Pin={name:string;path:string;exe:string};
const DEF={theme:"dark",accent:"#0a84ff",glass:.7,speed:1,dockSize:52,magnify:.7,autohide:false,hideTaskbar:true,notch:1,
  pins:[{name:"Files",path:"C:\\Windows\\explorer.exe",exe:"explorer.exe"},{name:"Notepad",path:"C:\\Windows\\notepad.exe",exe:"notepad.exe"}] as Pin[]};
type Cfg=typeof DEF;
const read=():Cfg=>{try{return {...DEF,...JSON.parse(localStorage.cfg||"{}")}}catch{return DEF}};
export function useCfg(){const[c,s]=useState(read);
  useEffect(()=>{const f=()=>s(read());addEventListener("storage",f);addEventListener("cfg",f);return()=>{removeEventListener("storage",f);removeEventListener("cfg",f)}},[]);
  const set=(p:Partial<Cfg>)=>{localStorage.cfg=JSON.stringify({...read(),...p});dispatchEvent(new Event("cfg"))};return[c,set] as const;}
const useInterval=(fn:()=>void,ms:number)=>{useEffect(()=>{fn();const t=setInterval(fn,ms);return()=>clearInterval(t)},[]);};
type Media={title:string;artist:string;playing:boolean}|null; type Bat={percent:number;charging:boolean;present:boolean};
const useMedia=()=>{const[m,s]=useState<Media>(null);useInterval(()=>{invoke<Media>("get_media").then(s).catch(()=>s(null))},1500);return m;};
const useBat=()=>{const[b,s]=useState<Bat>({percent:100,charging:false,present:false});useInterval(()=>{invoke<Bat>("get_battery").then(s)},15000);return b;};
const useVol=()=>{const[v,s]=useState(0.5);useEffect(()=>{invoke<number>("get_volume").then(s)},[]);return[v,(x:number)=>{s(x);invoke("set_volume",{v:x})}] as const;};
const useRadios=()=>{const[r,s]=useState({wifi:false,bluetooth:false});const f=()=>invoke<typeof r>("get_radios").then(s).catch(()=>{});useInterval(f,4000);return[r,f] as const;};
const useIcons=()=>{const[m,s]=useState<Record<string,string>>(()=>{try{return JSON.parse(localStorage.icons||"{}")}catch{return{}}});const asked=useRef(new Set<string>());
  const ask=async(paths:string[])=>{const miss=paths.filter(p=>p&&!m[p]&&!asked.current.has(p));if(!miss.length)return;miss.forEach(p=>asked.current.add(p));
    try{const r=JSON.parse(await invoke<string>("get_icons",{paths:miss})||"{}");const n={...JSON.parse(localStorage.icons||"{}"),...r};localStorage.icons=JSON.stringify(n);s(n)}catch{}};
  return[m,ask] as const;};
const Bars=({on}:{on:boolean})=><span className={"viz"+(on?" on":"")}>{[0,1,2,3].map(i=><i key={i} style={{animationDelay:i*.15+"s"}}/>)}</span>;
const ctl=(a:string)=>invoke("media_ctl",{action:a});
const open=(t:string)=>invoke("open_target",{target:t});
const base=(p:string)=>(p.split("\\").pop()||"").toLowerCase();
const Icon=({src,fb}:{src?:string;fb:string})=>src?<img src={src} draggable={false}/>:<span className="fb">{fb}</span>;

/* ---------------- Notch ---------------- */
export function Notch(){
  const[c]=useCfg();const[isOpen,setOpen]=useState(false);const m=useMedia();const t=useRef(0);
  const toggle=(o:boolean)=>{setOpen(o);invoke("set_notch",{expanded:o,scale:c.notch});};
  useEffect(()=>{invoke("set_notch",{expanded:isOpen,scale:c.notch})},[c.notch]);
  const stop=(a:string)=>(e:React.MouseEvent)=>{e.stopPropagation();ctl(a)};
  return <div className={"notch"+(isOpen?" open":"")} onClick={()=>!isOpen&&toggle(true)} onMouseEnter={()=>clearTimeout(t.current)} onMouseLeave={()=>{t.current=window.setTimeout(()=>toggle(false),500)}}>
    <div style={{zoom:c.notch}}>
    {!isOpen?<div className="compact"><span>{m?.title?"♪ "+m.title.slice(0,16):""}</span><Bars on={!!m?.playing}/></div>
    :<div className="expanded"><div className="art">♫</div><div className="meta"><b>{m?.title||"Nothing playing"}</b><small>{m?.artist||"Play something in Spotify, Edge…"}</small><Bars on={!!m?.playing}/></div>
      <div className="btns"><button onClick={stop("prev")}>⏮</button><button onClick={stop("toggle")}>{m?.playing?"⏸":"▶"}</button><button onClick={stop("next")}>⏭</button></div></div>}
    </div></div>;
}

/* ---------------- Menu bar ---------------- */
export function MenuBar(){
  const[c]=useCfg();const[now,setNow]=useState(new Date());useEffect(()=>{const t=setInterval(()=>setNow(new Date()),1000);return()=>clearInterval(t)},[]);
  const b=useBat();const[v]=useVol();const[r]=useRadios();const cc=()=>invoke("toggle_win",{label:"control"});
  useEffect(()=>{invoke("set_layout",{top:28,bottom:c.autohide?0:c.dockSize+36,hideTaskbar:c.hideTaskbar,scale:window.devicePixelRatio})},[c.dockSize,c.autohide,c.hideTaskbar]);
  return <div className="menubar">
    <div className="left"><b onClick={()=>invoke("toggle_win",{label:"settings"})}>MacNotch</b><span onClick={()=>invoke("toggle_win",{label:"launchpad"})}>Launchpad</span><span onClick={()=>invoke("toggle_win",{label:"settings"})}>Settings</span></div>
    <div className="right">
      <span>{b.present?`${b.charging?"⚡":"🔋"} ${b.percent}%`:"🔌"}</span>
      <span className={r.bluetooth?"":"off"} onClick={cc}>ᛒ</span><span className={r.wifi?"":"off"} onClick={cc}>📶</span>
      <span onClick={cc}>{v===0?"🔇":"🔊"}</span><span onClick={cc}>⚙︎</span>
      <span>{now.toLocaleDateString([],{weekday:"short",month:"short",day:"numeric"})}  {now.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>
    </div></div>;
}

/* ---------------- Dock (replaces taskbar) ---------------- */
type Win={hwnd:number;title:string;exe:string;active:boolean};
interface Item{name:string;icon:string;launch:string;pin:Pin|null;win?:Win;sp?:"lp"|"st";gap?:boolean}
export function Dock(){
  const[c,set]=useCfg();const[wins,setWins]=useState<Win[]>([]);const[icons,ask]=useIcons();
  const[mx,setMx]=useState<number|null>(null);const[hid,setHid]=useState(false);const[hop,setHop]=useState("");
  const ref=useRef<HTMLDivElement>(null);const tm=useRef(0);const wd=useRef(500);
  useInterval(()=>{invoke<Win[]>("list_windows").then(setWins).catch(()=>{})},1500);
  const seen=new Set(c.pins.map(p=>p.exe.toLowerCase()));
  const pinned:Item[]=c.pins.map(p=>({name:p.name,icon:p.path,launch:p.path,pin:p,win:wins.find(w=>base(w.exe)===p.exe.toLowerCase())}));
  const extra:Item[]=wins.filter(w=>{const b=base(w.exe);if(!b||seen.has(b))return false;seen.add(b);return true}).map((w,i)=>({name:w.title,icon:w.exe,launch:"",pin:null,win:w,gap:i===0}));
  const items:Item[]=[{name:"Launchpad",icon:"",launch:"",pin:null,sp:"lp"},...pinned,...extra,{name:"MacNotch Settings",icon:"",launch:"",pin:null,sp:"st",gap:true}];
  useEffect(()=>{ask([...c.pins.map(p=>p.path),...extra.map(e=>e.icon)])},[c.pins.length,extra.map(e=>e.icon).join()]);
  const gone=c.autohide&&hid;
  useEffect(()=>{if(ref.current)wd.current=Math.ceil(ref.current.offsetWidth)+Math.round(c.dockSize*1.2)+20;
    invoke("resize_dock",{w:wd.current,h:gone?8:Math.round(c.dockSize*(1+c.magnify*.8))+40})},[items.length,c.dockSize,c.magnify,gone]);
  const scale=(i:number)=>{if(mx===null||!ref.current)return 1;const el=ref.current.querySelectorAll<HTMLElement>(".it")[i];if(!el)return 1;
    const r=el.getBoundingClientRect();return 1+c.magnify*Math.max(0,1-Math.abs(mx-(r.left+r.width/2))/(c.dockSize*2))**2;};
  const click=(it:Item)=>{if(it.sp==="lp")return invoke("toggle_win",{label:"launchpad"});if(it.sp==="st")return invoke("toggle_win",{label:"settings"});
    if(it.win)return invoke("focus_window",{hwnd:it.win.hwnd});setHop(it.name);setTimeout(()=>setHop(""),800);open(it.launch);};
  const ctx=(e:React.MouseEvent,it:Item)=>{e.preventDefault();if(it.sp)return;
    if(it.pin)set({pins:c.pins.filter(p=>p.path!==it.pin!.path)});
    else if(it.win){const b=base(it.win.exe);set({pins:[...c.pins,{name:b[0].toUpperCase()+b.slice(1).replace(".exe",""),path:it.win.exe,exe:b}]});}};
  return <div className="dockwrap" onMouseEnter={()=>{clearTimeout(tm.current);setHid(false)}} onMouseLeave={()=>{setMx(null);if(c.autohide)tm.current=window.setTimeout(()=>setHid(true),700)}}>
    {!gone&&<div ref={ref} className="dock glass" style={{"--ic":c.dockSize+"px"} as React.CSSProperties} onMouseMove={e=>setMx(e.clientX)}>
      {items.map((it,i)=><span key={it.sp||it.launch+it.icon+i} className="slot">{it.gap&&<span className="sep"/>}
        <button className={"it"+(hop===it.name?" hop":"")} title={it.name+(it.sp?"":"  (right-click: pin/unpin)")} style={{transform:`scale(${scale(i)})`}} onClick={()=>click(it)} onContextMenu={e=>ctx(e,it)}>
          <Icon src={icons[it.icon]} fb={it.sp==="lp"?"🚀":it.sp==="st"?"⚙️":it.name[0]}/>{it.win&&<i className={"dot"+(it.win.active?" act":"")}/>}</button></span>)}
    </div>}</div>;
}

/* ---------------- Control Center ---------------- */
type Wifi={networks:{ssid:string;secure:boolean}[];known:string[];current:string};
export function ControlCenter(){
  const[c,set]=useCfg();const[v,setV]=useVol();const m=useMedia();const b=useBat();const[r,refresh]=useRadios();
  const[br,setBr]=useState(60);const bt=useRef(0);const[open,setOpen]=useState(false);const[w,setW]=useState<Wifi|null>(null);
  const[ask,setAsk]=useState("");const[pw,setPw]=useState("");const[busy,setBusy]=useState("");
  useEffect(()=>{invoke<number>("get_brightness").then(setBr).catch(()=>{})},[]);
  const scan=()=>invoke<Wifi>("wifi_scan").then(setW);
  useEffect(()=>{if(open){scan();const t=setInterval(scan,8000);return()=>clearInterval(t)}},[open]);
  const join=async(ssid:string,p?:string)=>{setBusy(ssid);await invoke("wifi_connect",{ssid,password:p||null});setAsk("");setPw("");setBusy("");scan();};
  const radio=(k:string,on:boolean)=>{invoke("set_radio",{kind:k,on:!on});setTimeout(refresh,900);};
  return <div className="cc glass">
    <div className="row">
      <div className={"tile"+(r.wifi?" on":"")} onClick={()=>radio("wifi",r.wifi)}>📶<small>Wi‑Fi</small></div>
      <div className={"tile"+(r.bluetooth?" on":"")} onClick={()=>radio("bluetooth",r.bluetooth)}>ᛒ<small>Bluetooth</small></div>
      <div className="tile" onClick={()=>set({theme:c.theme==="dark"?"light":"dark"})}>{c.theme==="dark"?"🌙":"☀️"}<small>{c.theme}</small></div></div>
    <div className="link" onClick={()=>setOpen(!open)}>Wi‑Fi networks {open?"▾":"▸"}</div>
    {open&&<div className="nets">{!w?<small>Scanning…</small>:w.networks.length===0?<small>{r.wifi?"No networks found":"Wi‑Fi is off"}</small>:
      w.networks.map(n=><div key={n.ssid}><div className="net" onClick={()=>(w.known.includes(n.ssid)||!n.secure)?join(n.ssid):setAsk(ask===n.ssid?"":n.ssid)}>
        <span>{n.ssid===w.current?"✓ ":""}{n.ssid}</span><span>{busy===n.ssid?"…":n.secure?"🔒":""}</span></div>
        {ask===n.ssid&&<div className="pw"><input type="password" placeholder="Password" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&join(n.ssid,pw)}/><button onClick={()=>join(n.ssid,pw)}>Join</button></div>}</div>)}</div>}
    <label>Brightness</label><input type="range" min={5} max={100} value={br} onChange={e=>{const x=+e.target.value;setBr(x);clearTimeout(bt.current);bt.current=window.setTimeout(()=>invoke("set_brightness",{v:x}),150)}}/>
    <label>Volume</label><input type="range" min={0} max={1} step={0.01} value={v} onChange={e=>setV(+e.target.value)}/>
    <div className="card"><b>{m?.title||"Not playing"}</b><small>{m?.artist}</small><div className="btns"><button onClick={()=>ctl("prev")}>⏮</button><button onClick={()=>ctl("toggle")}>{m?.playing?"⏸":"▶"}</button><button onClick={()=>ctl("next")}>⏭</button></div></div>
    <div className="card"><small>Battery</small><b>{b.present?`${b.percent}%${b.charging?" · charging":""}`:"Plugged in"}</b></div>
    <div className="row"><button className="btn" onClick={()=>{invoke("hide_win",{label:"control"});invoke("toggle_win",{label:"settings"})}}>Settings…</button><button className="btn red" onClick={()=>invoke("quit_app")}>Quit</button></div>
  </div>;
}

/* ---------------- Launchpad ---------------- */
export function Launchpad(){
  const[apps,setApps]=useState<{name:string;path:string}[]>([]);const[q,setQ]=useState("");const[icons,ask]=useIcons();const[c,set]=useCfg();
  useEffect(()=>{invoke<typeof apps>("list_apps").then(async a=>{setApps(a);for(let i=0;i<a.length;i+=25)await ask(a.slice(i,i+25).map(x=>x.path))})},[]);
  useEffect(()=>{const k=(e:KeyboardEvent)=>e.key==="Escape"&&invoke("hide_win",{label:"launchpad"});addEventListener("keydown",k);return()=>removeEventListener("keydown",k)},[]);
  const go=(p:string)=>{open(p);invoke("hide_win",{label:"launchpad"})};
  const pin=async(a:{name:string;path:string})=>{const t=await invoke<string>("resolve_lnk",{path:a.path});if(!c.pins.some(p=>p.path===a.path))set({pins:[...c.pins,{name:a.name,path:a.path,exe:base(t)}]})};
  return <div className="lp glass"><input autoFocus placeholder="Search apps…  (right-click an app to pin it to the Dock)" value={q} onChange={e=>setQ(e.target.value)}/>
    <div className="grid">{apps.filter(a=>a.name.toLowerCase().includes(q.toLowerCase())).map(a=>
      <button key={a.path} onClick={()=>go(a.path)} onContextMenu={e=>{e.preventDefault();pin(a)}}><div className="ai"><Icon src={icons[a.path]} fb={a.name[0]}/></div><small>{a.name}</small></button>)}</div></div>;
}

/* ---------------- Settings ---------------- */
const Row=({l,children}:{l:string;children:React.ReactNode})=><div className="srow"><span>{l}</span><div>{children}</div></div>;
const Tog=({on,set}:{on:boolean;set:(b:boolean)=>void})=><i className={"tog"+(on?" on":"")} onClick={()=>set(!on)}/>;
const Rng=(p:{v:number;min:number;max:number;step:number;set:(n:number)=>void})=><input type="range" min={p.min} max={p.max} step={p.step} value={p.v} onChange={e=>p.set(+e.target.value)}/>;
const COLORS=["#0a84ff","#bf5af2","#ff375f","#ff9f0a","#30d158","#64d2ff"];
export function Settings(){
  const[c,set]=useCfg();const[tab,setTab]=useState("General");const[auto,setAuto]=useState(false);
  useEffect(()=>{invoke<boolean>("autostart_state").then(setAuto)},[]);
  return <div className="set glass"><div className="stitle" data-tauri-drag-region><i className="tl r" onClick={()=>invoke("hide_win",{label:"settings"})}/><span data-tauri-drag-region>MacNotch Settings</span></div>
    <div className="sbody"><div className="side">{["General","Appearance","Dock","Notch"].map(t=><div key={t} className={tab===t?"on":""} onClick={()=>setTab(t)}>{t}</div>)}</div>
    <div className="pane">
      {tab==="General"&&<><Row l="Launch at Windows startup"><Tog on={auto} set={b=>{setAuto(b);invoke("autostart",{on:b})}}/></Row>
        <Row l="Replace the Windows taskbar"><Tog on={c.hideTaskbar} set={b=>set({hideTaskbar:b})}/></Row>
        <Row l="Theme"><button className="btn" onClick={()=>set({theme:"dark"})}>Dark</button> <button className="btn" onClick={()=>set({theme:"light"})}>Light</button></Row>
        <Row l="Quit MacNotch (restores taskbar)"><button className="btn red" onClick={()=>invoke("quit_app")}>Quit</button></Row></>}
      {tab==="Appearance"&&<><Row l="Accent color"><span className="swr">{COLORS.map(x=><i key={x} className="sw" style={{background:x}} onClick={()=>set({accent:x})}/>)}<input type="color" value={c.accent} onChange={e=>set({accent:e.target.value})}/></span></Row>
        <Row l="Panel opacity"><Rng v={c.glass} min={.3} max={1} step={.05} set={n=>set({glass:n})}/></Row>
        <Row l="Animation speed"><Rng v={c.speed} min={.5} max={2} step={.1} set={n=>set({speed:n})}/></Row></>}
      {tab==="Dock"&&<><Row l="Icon size"><Rng v={c.dockSize} min={36} max={80} step={2} set={n=>set({dockSize:n})}/></Row>
        <Row l="Magnification"><Rng v={c.magnify} min={0} max={1.2} step={.1} set={n=>set({magnify:n})}/></Row>
        <Row l="Auto-hide"><Tog on={c.autohide} set={b=>set({autohide:b})}/></Row>
        <div className="sub">Pinned apps (add more from Launchpad; right-click a Dock icon to pin/unpin)</div>
        {c.pins.map(p=><Row key={p.path} l={p.name}><button className="btn" onClick={()=>set({pins:c.pins.filter(x=>x.path!==p.path)})}>Remove</button></Row>)}</>}
      {tab==="Notch"&&<Row l="Notch size"><Rng v={c.notch} min={.8} max={1.5} step={.05} set={n=>set({notch:n})}/></Row>}
    </div></div></div>;
}
