#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  use tauri::Manager;
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Windows 无边框窗口：显式开启圆角并给 DWM 阴影边框着色，避免白边。
      #[cfg(windows)]
      if let Some(window) = app.get_webview_window("main") {
        apply_rounded_corners(&window);
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

// 给无边框窗口设置 Win11 圆角与深色边框，与暗色主题顶栏/底栏一致。
#[cfg(windows)]
fn apply_rounded_corners(window: &tauri::WebviewWindow) {
  use windows::Win32::Foundation::COLORREF;
  use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
  };

  let Ok(hwnd) = window.hwnd() else { return };

  unsafe {
    // 在 Windows 10 上该属性不受支持，调用失败直接忽略。
    let preference = DWMWCP_ROUND;
    let _ = DwmSetWindowAttribute(
      hwnd,
      DWMWA_WINDOW_CORNER_PREFERENCE,
      std::ptr::addr_of!(preference).cast(),
      std::mem::size_of_val(&preference) as u32,
    );

    // 0x00BBGGRR：#2B3341（应用边框色，暗色主题下清晰可见，与面板描边一致）。
    let border = COLORREF(0x0041332B);
    let _ = DwmSetWindowAttribute(
      hwnd,
      DWMWA_BORDER_COLOR,
      std::ptr::addr_of!(border).cast(),
      std::mem::size_of_val(&border) as u32,
    );
  }
}