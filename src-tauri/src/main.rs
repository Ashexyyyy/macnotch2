#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{ffi::c_void, os::windows::process::CommandExt, process::Command, sync::Mutex, time::Instant};
use serde::Serialize;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use windows::{core::{w, PCWSTR, PWSTR, Result as WR}, Devices::Radios::*, Media::Control::*,
  Win32::{Foundation::*, Graphics::Dwm::*, Media::Audio::{Endpoints::IAudioEndpointVolume, *}, System::{Com::*, Power::*, Threading::*}, UI::WindowsAndMessaging::*}};

static ORIG: Mutex<Option<RECT>> = Mutex::new(None);
static LAST_BLUR: Mutex<Option<Instant>> = Mutex::new(None);

fn run(cmd: &str, args: &[&str]) -> String {
  Command::new(cmd).args(args).creation_flags(0x08000000).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}
fn ps(script: &str, arg: &str) -> String {
  Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", script]).env("MN", arg).creation_flags(0x08000000)
    .output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}
fn after(l: &str) -> String { l.splitn(2, ':').nth(1).unwrap_or("").trim().to_string() }

// ---------- audio / battery / media ----------
#[derive(Serialize)] struct Battery { percent: u8, charging: bool, present: bool }
#[derive(Serialize)] struct Media { title: String, artist: String, playing: bool }
fn endpoint() -> WR<IAudioEndpointVolume> { unsafe {
  let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
  let e: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
  e.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
}}
#[tauri::command] fn get_volume() -> f32 { endpoint().and_then(|e| unsafe { e.GetMasterVolumeLevelScalar() }).unwrap_or(0.0) }
#[tauri::command] fn set_volume(v: f32) { if let Ok(e) = endpoint() { unsafe { let _ = e.SetMasterVolumeLevelScalar(v.clamp(0.0, 1.0), std::ptr::null()); } } }
#[tauri::command] fn get_battery() -> Battery { unsafe {
  let mut s = SYSTEM_POWER_STATUS::default();
  if GetSystemPowerStatus(&mut s).is_err() { return Battery { percent: 100, charging: false, present: false }; }
  Battery { percent: if s.BatteryLifePercent == 255 { 100 } else { s.BatteryLifePercent }, charging: s.ACLineStatus == 1, present: s.BatteryFlag & 128 == 0 }
}}
fn session() -> Option<GlobalSystemMediaTransportControlsSession> {
  GlobalSystemMediaTransportControlsSessionManager::RequestAsync().ok()?.get().ok()?.GetCurrentSession().ok()
}
#[tauri::command] async fn get_media() -> Option<Media> {
  let s = session()?; let p = s.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
  let playing = s.GetPlaybackInfo().ok()?.PlaybackStatus().ok()? == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
  Some(Media { title: p.Title().ok()?.to_string(), artist: p.Artist().ok()?.to_string(), playing })
}
#[tauri::command] async fn media_ctl(action: String) { if let Some(s) = session() { let _ = match action.as_str() {
  "next" => s.TrySkipNextAsync(), "prev" => s.TrySkipPreviousAsync(), _ => s.TryTogglePlayPauseAsync() }; } }

// ---------- brightness / radios / wifi ----------
#[tauri::command] async fn get_brightness() -> u32 { ps("(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness", "").parse().unwrap_or(60) }
#[tauri::command] async fn set_brightness(v: u32) { ps(&format!("Invoke-CimMethod -InputObject (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods) -MethodName WmiSetBrightness -Arguments @{{Timeout=1;Brightness={}}}", v.min(100)), ""); }
fn radio(k: RadioKind) -> Option<Radio> {
  let _ = Radio::RequestAccessAsync().ok()?.get();
  Radio::GetRadiosAsync().ok()?.get().ok()?.into_iter().find(|r| r.Kind().ok() == Some(k))
}
#[derive(Serialize)] struct Radios { wifi: bool, bluetooth: bool }
#[tauri::command] async fn get_radios() -> Radios {
  let on = |k| radio(k).map(|r| r.State().ok() == Some(RadioState::On)).unwrap_or(false);
  Radios { wifi: on(RadioKind::WiFi), bluetooth: on(RadioKind::Bluetooth) }
}
#[tauri::command] async fn set_radio(kind: String, on: bool) {
  let k = if kind == "wifi" { RadioKind::WiFi } else { RadioKind::Bluetooth };
  if let Some(r) = radio(k) { let _ = r.SetStateAsync(if on { RadioState::On } else { RadioState::Off }).and_then(|a| a.get()); }
}
#[derive(Serialize)] struct Net { ssid: String, secure: bool }
#[derive(Serialize)] struct Wifi { networks: Vec<Net>, known: Vec<String>, current: String }
#[tauri::command] async fn wifi_scan() -> Wifi {
  let mut nets: Vec<Net> = vec![];
  for l in run("netsh", &["wlan", "show", "networks", "mode=bssid"]).lines() { let t = l.trim();
    if t.starts_with("SSID") { let s = after(t); if !s.is_empty() && !nets.iter().any(|n| n.ssid == s) { nets.push(Net { ssid: s, secure: true }); } }
    else if t.starts_with("Authentication") { if let Some(n) = nets.last_mut() { n.secure = !after(t).eq_ignore_ascii_case("open"); } } }
  let known = run("netsh", &["wlan", "show", "profiles"]).lines().filter(|l| l.contains("Profile") && l.contains(':')).map(after).collect();
  let current = run("netsh", &["wlan", "show", "interfaces"]).lines().map(|l| l.trim()).find(|l| l.starts_with("SSID")).map(after).unwrap_or_default();
  Wifi { networks: nets, known, current }
}
#[tauri::command] async fn wifi_connect(ssid: String, password: Option<String>) {
  if let Some(p) = password.filter(|p| !p.is_empty()) {
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let xml = format!(r#"<?xml version="1.0"?><WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"><name>{s}</name><SSIDConfig><SSID><name>{s}</name></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>auto</connectionMode><MSM><security><authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption><sharedKey><keyType>passphrase</keyType><protected>false</protected><keyMaterial>{p}</keyMaterial></sharedKey></security></MSM></WLANProfile>"#, s = esc(&ssid), p = esc(&p));
    let f = std::env::temp_dir().join("mn_wifi.xml"); let _ = std::fs::write(&f, xml);
    run("netsh", &["wlan", "add", "profile", &format!("filename={}", f.display())]); let _ = std::fs::remove_file(&f);
  }
  run("netsh", &["wlan", "connect", &format!("name={}", ssid)]);
}

// ---------- apps, icons, running windows ----------
#[derive(Serialize)] struct App { name: String, path: String }
fn walk(d: &std::path::Path, out: &mut Vec<App>) { if let Ok(rd) = std::fs::read_dir(d) { for e in rd.flatten() { let p = e.path();
  if p.is_dir() { walk(&p, out) } else if p.extension().map(|x| x.eq_ignore_ascii_case("lnk")).unwrap_or(false) {
    let n = p.file_stem().unwrap().to_string_lossy().to_string();
    if !n.to_lowercase().contains("uninstall") { out.push(App { name: n, path: p.to_string_lossy().to_string() }); } } } } }
#[tauri::command] fn list_apps() -> Vec<App> { let mut v = vec![];
  for var in ["ProgramData", "APPDATA"] { if let Ok(b) = std::env::var(var) { walk(&std::path::Path::new(&b).join("Microsoft\\Windows\\Start Menu\\Programs"), &mut v); } }
  v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())); v.dedup_by(|a, b| a.name == b.name); v }
#[tauri::command] async fn resolve_lnk(path: String) -> String { ps("(New-Object -ComObject WScript.Shell).CreateShortcut($env:MN).TargetPath", &path) }
#[tauri::command] async fn get_icons(paths: Vec<String>) -> String {
  ps(r#"[Console]::OutputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Drawing;$r=@{};foreach($p in ($env:MN -split '\|')){try{$i=[System.Drawing.Icon]::ExtractAssociatedIcon($p);$m=New-Object IO.MemoryStream;$i.ToBitmap().Save($m,[Drawing.Imaging.ImageFormat]::Png);$r[$p]='data:image/png;base64,'+[Convert]::ToBase64String($m.ToArray())}catch{}};$r|ConvertTo-Json -Compress"#, &paths.join("|"))
}
#[derive(Serialize)] struct Win { hwnd: isize, title: String, exe: String, active: bool }
unsafe extern "system" fn enum_cb(h: HWND, l: LPARAM) -> BOOL {
  let v = &mut *(l.0 as *mut Vec<Win>);
  if !IsWindowVisible(h).as_bool() || GetWindow(h, GW_OWNER).is_ok() { return BOOL(1); }
  if (GetWindowLongW(h, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW.0 != 0 { return BOOL(1); }
  let mut cloaked = 0u32; let _ = DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut c_void, 4);
  if cloaked != 0 { return BOOL(1); }
  let n = GetWindowTextLengthW(h); if n == 0 { return BOOL(1); }
  let mut b = vec![0u16; n as usize + 1]; let n = GetWindowTextW(h, &mut b); let title = String::from_utf16_lossy(&b[..n as usize]);
  if title == "Program Manager" { return BOOL(1); }
  let mut pid = 0u32; GetWindowThreadProcessId(h, Some(&mut pid)); if pid == std::process::id() { return BOOL(1); }
  let exe = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok().and_then(|p| {
    let mut buf = [0u16; 520]; let mut len = buf.len() as u32;
    let r = QueryFullProcessImageNameW(p, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).ok().map(|_| String::from_utf16_lossy(&buf[..len as usize]));
    let _ = CloseHandle(p); r }).unwrap_or_default();
  v.push(Win { hwnd: h.0 as isize, title, exe, active: h == GetForegroundWindow() }); BOOL(1)
}
#[tauri::command] fn list_windows() -> Vec<Win> { let mut v: Vec<Win> = vec![]; unsafe { let _ = EnumWindows(Some(enum_cb), LPARAM(&mut v as *mut _ as isize)); } v }
#[tauri::command] fn focus_window(hwnd: isize) { unsafe { let h = HWND(hwnd as _); if IsIconic(h).as_bool() { let _ = ShowWindow(h, SW_RESTORE); } let _ = SetForegroundWindow(h); } }
#[tauri::command] fn open_target(target: String) { let _ = Command::new("cmd").args(["/C", "start", "", &target]).creation_flags(0x08000000).spawn(); }

// ---------- shell layout: hide taskbar + reserve work area ----------
fn taskbar(show: bool) { unsafe { for c in [w!("Shell_TrayWnd"), w!("Shell_SecondaryTrayWnd")] {
  if let Ok(h) = FindWindowW(c, PCWSTR::null()) { let _ = ShowWindow(h, if show { SW_SHOW } else { SW_HIDE }); } } } }
fn set_area(r: &mut RECT) { unsafe { let _ = SystemParametersInfoW(SPI_SETWORKAREA, 0, Some(r as *mut _ as *mut c_void), SPIF_SENDCHANGE); } }
#[tauri::command] fn set_layout(top: i32, bottom: i32, hide_taskbar: bool, scale: f64) { unsafe {
  let mut o = ORIG.lock().unwrap();
  if o.is_none() { let mut r = RECT::default();
    if SystemParametersInfoW(SPI_GETWORKAREA, 0, Some(&mut r as *mut _ as *mut c_void), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)).is_ok() { *o = Some(r); } }
  taskbar(!hide_taskbar);
  let mut r = if hide_taskbar { RECT { left: 0, top: 0, right: GetSystemMetrics(SM_CXSCREEN), bottom: GetSystemMetrics(SM_CYSCREEN) - (bottom as f64 * scale) as i32 } }
              else { o.unwrap_or_default() };
  r.top += (top as f64 * scale) as i32; set_area(&mut r);
}}
fn restore() { taskbar(true); if let Some(mut r) = *ORIG.lock().unwrap() { set_area(&mut r); } }
#[tauri::command] fn quit_app(app: AppHandle) { restore(); app.exit(0); }

// ---------- windows ----------
#[tauri::command] fn toggle_win(app: AppHandle, label: String) { if let Some(w) = app.get_webview_window(&label) {
  if w.is_visible().unwrap_or(false) { let _ = w.hide(); }
  else { if let Some(t) = *LAST_BLUR.lock().unwrap() { if t.elapsed().as_millis() < 300 { return; } } let _ = w.show(); let _ = w.set_focus(); } } }
#[tauri::command] fn hide_win(app: AppHandle, label: String) { if let Some(w) = app.get_webview_window(&label) { let _ = w.hide(); } }
#[tauri::command] fn set_notch(app: AppHandle, expanded: bool, scale: f64) { if let Some(w) = app.get_webview_window("notch") {
  let (sw, sh) = if expanded { (420.0 * scale, 170.0 * scale) } else { (220.0 * scale, 40.0 * scale) };
  let f = w.scale_factor().unwrap_or(1.0);
  if let Ok(Some(m)) = w.primary_monitor() { let x = m.position().x + ((m.size().width as f64 - sw * f) / 2.0) as i32;
    let _ = w.set_size(LogicalSize::new(sw, sh)); let _ = w.set_position(PhysicalPosition::new(x, m.position().y)); } } }
#[tauri::command] fn resize_dock(app: AppHandle, w: f64, h: f64) { if let Some(win) = app.get_webview_window("dock") { if let Ok(Some(m)) = win.primary_monitor() {
  let f = m.scale_factor(); let x = m.position().x + ((m.size().width as f64 - w * f) / 2.0) as i32; let y = m.position().y + (m.size().height as f64 - h * f) as i32;
  let _ = win.set_size(LogicalSize::new(w, h)); let _ = win.set_position(PhysicalPosition::new(x, y)); } } }
#[tauri::command] fn autostart(app: AppHandle, on: bool) { let a = app.autolaunch(); let _ = if on { a.enable() } else { a.disable() }; }
#[tauri::command] fn autostart_state(app: AppHandle) -> bool { app.autolaunch().is_enabled().unwrap_or(false) }

fn spawn(app: &AppHandle, label: &str, w: f64, h: f64, x: f64, y: f64, visible: bool) -> tauri::Result<()> {
  WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
    .decorations(false).transparent(true).always_on_top(true).skip_taskbar(true).resizable(false).shadow(false)
    .visible(visible).inner_size(w, h).position(x, y).build()?; Ok(())
}
fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
    .invoke_handler(tauri::generate_handler![get_volume, set_volume, get_battery, get_media, media_ctl, get_brightness, set_brightness,
      get_radios, set_radio, wifi_scan, wifi_connect, list_apps, resolve_lnk, get_icons, list_windows, focus_window, open_target,
      set_layout, quit_app, toggle_win, hide_win, set_notch, resize_dock, autostart, autostart_state])
    .setup(|app| {
      let h = app.handle();
      let m = h.primary_monitor()?.expect("monitor"); let f = m.scale_factor();
      let (sw, sh) = (m.size().width as f64 / f, m.size().height as f64 / f);
      spawn(h, "menubar", sw, 28.0, 0.0, 0.0, true)?;
      spawn(h, "dock", 700.0, 110.0, (sw - 700.0) / 2.0, sh - 110.0, true)?;
      spawn(h, "notch", 220.0, 40.0, (sw - 220.0) / 2.0, 0.0, true)?;
      spawn(h, "control", 340.0, 600.0_f64.min(sh - 60.0), sw - 352.0, 36.0, false)?;
      spawn(h, "launchpad", 860.0, 600.0, (sw - 860.0) / 2.0, (sh - 600.0) / 2.0, false)?;
      spawn(h, "settings", 760.0, 540.0, (sw - 760.0) / 2.0, (sh - 540.0) / 2.0, false)?;
      if let Some(mb) = h.get_webview_window("menubar") { let _ = window_vibrancy::apply_acrylic(&mb, Some((18, 18, 22, 150))); }
      for l in ["control", "launchpad"] { if let Some(c) = h.get_webview_window(l) { let c2 = c.clone();
        c.on_window_event(move |e| if let WindowEvent::Focused(false) = e { *LAST_BLUR.lock().unwrap() = Some(Instant::now()); let _ = c2.hide(); }); } }
      Ok(())
    })
    .build(tauri::generate_context!()).expect("error")
    .run(|_, e| { if let RunEvent::Exit = e { restore(); } });
}
