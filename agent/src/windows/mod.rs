pub mod autostart;
pub mod dpapi;
pub mod toast;

use std::path::Path;

#[cfg(windows)]
pub fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
pub fn replace_file(from: &Path, to: &Path) -> Result<(), &'static str> {
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from = wide(from.as_os_str());
    let to = wide(to.as_os_str());
    // Both paths are owned configuration files; atomically replace without a delete gap.
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err("无法原子保存配置")
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
pub fn replace_file(from: &Path, to: &Path) -> Result<(), &'static str> {
    std::fs::rename(from, to).map_err(|_| "无法保存配置")
}

#[cfg(windows)]
pub struct Instance(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Instance {
    pub fn acquire(data_dir: &Path) -> Result<Self, &'static str> {
        use sha2::{Digest, Sha256};
        use windows_sys::Win32::{
            Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS},
            System::Threading::CreateMutexW,
        };
        let canonical = data_dir
            .canonicalize()
            .unwrap_or_else(|_| data_dir.to_path_buf());
        let hash = hex::encode(Sha256::digest(
            canonical.to_string_lossy().to_ascii_lowercase().as_bytes(),
        ));
        let name = wide(std::ffi::OsStr::new(&format!(
            "Local\\AgyFamilyMonitor-{hash}"
        )));
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err("无法建立客户端运行锁");
        }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe { CloseHandle(handle) };
            return Err("此客户端已在运行，请先停止后台任务。");
        }
        Ok(Self(handle))
    }
}
#[cfg(windows)]
impl Drop for Instance {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}
#[cfg(not(windows))]
pub struct Instance;
#[cfg(not(windows))]
impl Instance {
    pub fn acquire(_: &Path) -> Result<Self, &'static str> {
        Ok(Self)
    }
}

pub fn prepare_console(background: bool) -> bool {
    #[cfg(all(windows, not(debug_assertions)))]
    if !background {
        unsafe {
            use windows_sys::Win32::System::Console::*;
            let stdout = GetStdHandle(STD_OUTPUT_HANDLE);
            if !stdout.is_null() && stdout != windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
                return false;
            }
            if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
                return AllocConsole() != 0;
            }
        }
    }
    let _ = background;
    false
}

pub fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
