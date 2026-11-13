import {useEffect} from "react"; import {createRoot} from "react-dom/client"; import {getCurrentWindow} from "@tauri-apps/api/window";
import {MenuBar,Notch,Dock,ControlCenter,Settings,Launchpad,useCfg} from "./App"; import "./styles.css";
const label=getCurrentWindow().label;
const M:Record<string,()=>JSX.Element>={menubar:MenuBar,notch:Notch,dock:Dock,control:ControlCenter,settings:Settings,launchpad:Launchpad};
function Root(){const[c]=useCfg();
  useEffect(()=>{const d=document.documentElement;d.dataset.theme=c.theme;d.style.setProperty("--accent",c.accent);d.style.setProperty("--ga",String(c.glass));d.style.setProperty("--spd",String(1/c.speed));},[c]);
  const C=M[label]||Dock;return <C/>;}
createRoot(document.getElementById("root")!).render(<Root/>);
