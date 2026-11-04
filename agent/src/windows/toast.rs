use std::path::{Path, PathBuf};
pub const APP_ID: &str = "AgyFamilyMonitor.App";

fn shortcut_path() -> Result<PathBuf, &'static str> {
    std::env::var_os("APPDATA")
        .map(|p| {
            PathBuf::from(p).join("Microsoft/Windows/Start Menu/Programs/Agy Family Monitor.lnk")
        })
        .ok_or("无法定位当前用户开始菜单")
}

#[cfg(windows)]
struct ComApartment;
#[cfg(windows)]
impl ComApartment {
    fn new() -> ::windows::core::Result<Self> {
        unsafe {
            ::windows::Win32::System::Com::CoInitializeEx(
                None,
                ::windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
            )
            .ok()?;
        }
        Ok(Self)
    }
}
#[cfg(windows)]
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { ::windows::Win32::System::Com::CoUninitialize() }
    }
}

#[cfg(windows)]
fn write_shortcut(exe: &Path, path: &Path) -> ::windows::core::Result<()> {
    use ::windows::{
        core::{w, Interface, PCWSTR},
        Win32::{
            Foundation::PROPERTYKEY,
            System::Com::{
                CoCreateInstance, IPersistFile, StructuredStorage::PROPVARIANT,
                CLSCTX_INPROC_SERVER,
            },
            UI::Shell::{
                IShellLinkW,
                PropertiesSystem::{IPropertyStore, PSGetPropertyKeyFromName},
                ShellLink,
            },
        },
    };
    let _apartment = ComApartment::new()?;
    let executable = super::wide(exe.as_os_str());
    let path = super::wide(path.as_os_str());
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(PCWSTR(executable.as_ptr()))?;
        link.SetArguments(w!("--status"))?;
        let store: IPropertyStore = link.cast()?;
        let mut key = PROPERTYKEY::default();
        PSGetPropertyKeyFromName(w!("System.AppUserModel.ID"), &mut key)?;
        store.SetValue(&key, &PROPVARIANT::from(APP_ID))?;
        store.Commit()?;
        let persist: IPersistFile = link.cast()?;
        persist.Save(PCWSTR(path.as_ptr()), true)
    }
}

pub fn register_shortcut(exe: &Path) -> Result<(), &'static str> {
    let path = shortcut_path()?;
    std::fs::create_dir_all(path.parent().ok_or("开始菜单路径无效")?)
        .map_err(|_| "无法创建通知快捷方式目录")?;
    #[cfg(windows)]
    {
        write_shortcut(exe, &path).map_err(|_| "无法注册 Windows 通知应用身份")
    }
    #[cfg(not(windows))]
    {
        let _ = (exe, path);
        Err("Windows 通知仅支持 Windows")
    }
}

pub fn remove_shortcut() -> Result<(), &'static str> {
    let path = shortcut_path()?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法移除客户端快捷方式"),
    }
}

#[cfg(windows)]
pub fn show(id: &str, message: &str) -> Result<(), &'static str> {
    use ::windows::{
        core::HSTRING,
        Data::Xml::Dom::XmlDocument,
        UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager},
    };
    use sha2::{Digest, Sha256};
    let _apartment = ComApartment::new().map_err(|_| "无法初始化 Windows 通知")?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))
        .map_err(|_| "通知身份尚未安装，请运行 --install")?;
    if notifier.Setting().map_err(|_| "无法查询通知权限")? != NotificationSetting::Enabled {
        return Err("Windows 通知被禁用，通知游标已保留");
    }
    let message: String = message
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(512)
        .collect();
    let xml=format!("<toast><visual><binding template=\"ToastGeneric\"><text>Agy Family Monitor</text><text>{}</text></binding></visual></toast>",super::xml_escape(&message));
    let document = XmlDocument::new().map_err(|_| "无法创建通知")?;
    document
        .LoadXml(&HSTRING::from(xml))
        .map_err(|_| "通知内容无效")?;
    let toast =
        ToastNotification::CreateToastNotification(&document).map_err(|_| "无法创建通知")?;
    let tag = hex::encode(Sha256::digest(id.as_bytes()));
    toast
        .SetTag(&HSTRING::from(&tag[..16]))
        .map_err(|_| "无法设置通知标识")?;
    notifier.Show(&toast).map_err(|_| "Windows 通知显示失败")
}
#[cfg(not(windows))]
pub fn show(_: &str, _: &str) -> Result<(), &'static str> {
    Err("Windows 通知仅支持 Windows")
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn shortcut_can_be_created_in_an_isolated_directory_without_installing() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("test.lnk");
        write_shortcut(&std::env::current_exe().unwrap(), &path).unwrap();
        assert!(path.metadata().unwrap().len() > 0);
    }
}
