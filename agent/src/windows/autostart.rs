use super::xml_escape;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
const TASK_NAME: &str = "AgyFamilyMonitor";

fn system_tool(name: &str) -> Result<PathBuf, &'static str> {
    std::env::var_os("SystemRoot")
        .map(|p| PathBuf::from(p).join("System32").join(name))
        .ok_or("无法定位 Windows 系统目录")
}

fn command(name: &str) -> Result<Command, &'static str> {
    let mut command = Command::new(system_tool(name)?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Ok(command)
}

fn current_sid() -> Result<String, &'static str> {
    let output = command("whoami.exe")?
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .map_err(|_| "无法读取当前用户身份")?;
    let text = String::from_utf8_lossy(&output.stdout);
    let sid = text
        .trim()
        .rsplit(',')
        .next()
        .unwrap_or("")
        .trim_matches('"');
    if !output.status.success()
        || !sid.starts_with("S-1-")
        || !sid
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, 'S' | '-'))
    {
        return Err("无法识别当前用户 SID");
    }
    Ok(sid.into())
}

fn task_xml(exe: &Path, sid: &str, data_dir: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{sid}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Author"><UserId>{sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
<Actions Context="Author"><Exec><Command>{exe}</Command><Arguments>--background --data-dir &quot;{data_dir}&quot;</Arguments><WorkingDirectory>{data_dir}</WorkingDirectory></Exec></Actions>
</Task>"#,
        exe = xml_escape(&exe.to_string_lossy()),
        sid = xml_escape(sid),
        data_dir = xml_escape(&data_dir.to_string_lossy())
    )
}

fn utf16_bytes(xml: &str) -> Vec<u8> {
    std::iter::once(0xfeffu16)
        .chain(xml.encode_utf16())
        .flat_map(u16::to_le_bytes)
        .collect()
}

pub fn same_binary(current: &Path, target: &Path) -> bool {
    if !target.is_file() {
        return false;
    }
    if current.canonicalize().ok() == target.canonicalize().ok() {
        return true;
    }
    use sha2::{Digest, Sha256};
    let Ok(a) = fs::read(current) else {
        return false;
    };
    let Ok(b) = fs::read(target) else {
        return false;
    };
    a.len() == b.len() && Sha256::digest(&a) == Sha256::digest(&b)
}

pub fn needs_update(data_dir: &Path) -> bool {
    let Ok(current) = std::env::current_exe() else {
        return false;
    };
    !same_binary(&current, &data_dir.join("AgyFamilyMonitor.exe"))
}

pub fn install(data_dir: &Path) -> Result<(), &'static str> {
    fs::create_dir_all(data_dir).map_err(|_| "无法创建程序目录")?;
    let current = std::env::current_exe().map_err(|_| "无法定位当前程序")?;
    let target = data_dir.join("AgyFamilyMonitor.exe");
    if current.canonicalize().ok() != target.canonicalize().ok()
        && !same_binary(&current, &target)
        && fs::copy(&current, &target).is_err()
    {
        stop()?;
        let mut copied = false;
        for _ in 0..25 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if fs::copy(&current, &target).is_ok() {
                copied = true;
                break;
            }
        }
        if !copied {
            return Err("无法复制客户端，可能已有后台实例");
        }
    }
    super::toast::register_shortcut(&target)?;
    let xml = task_xml(&target, &current_sid()?, data_dir);
    let path = data_dir.join("autostart-task.xml");
    fs::write(&path, utf16_bytes(&xml)).map_err(|_| "无法生成启动任务")?;
    let result = command("schtasks.exe")?
        .args(["/Create", "/TN", TASK_NAME, "/XML"])
        .arg(&path)
        .arg("/F")
        .output()
        .map_err(|_| "无法创建登录启动任务")?;
    let _ = fs::remove_file(path);
    if !result.status.success() {
        return Err("当前用户无法创建登录任务，请检查任务计划程序策略。");
    }
    Ok(())
}

pub fn disable_task() -> Result<(), &'static str> {
    if installed() {
        let result = command("schtasks.exe")?
            .args(["/Delete", "/TN", TASK_NAME, "/F"])
            .output()
            .map_err(|_| "无法删除启动任务")?;
        if !result.status.success() {
            return Err("启动任务删除失败");
        }
    }
    Ok(())
}

pub fn remove() -> Result<(), &'static str> {
    disable_task()?;
    super::toast::remove_shortcut()
}
pub fn start(data_dir: &Path) -> Result<(), &'static str> {
    if installed()
        && command("schtasks.exe")
            .and_then(|mut c| {
                c.args(["/Run", "/TN", TASK_NAME])
                    .output()
                    .map_err(|_| "任务启动失败")
            })
            .is_ok_and(|o| o.status.success())
    {
        return Ok(());
    }
    let mut child = Command::new(data_dir.join("AgyFamilyMonitor.exe"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        child.creation_flags(0x08000000);
    }
    child
        .args(["--background", "--data-dir"])
        .arg(data_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "无法开启后台采集，请重新打开客户端")?;
    Ok(())
}
pub fn stop() -> Result<(), &'static str> {
    if installed() {
        let _ = command("schtasks.exe")?
            .args(["/End", "/TN", TASK_NAME])
            .output()
            .map_err(|_| "无法停止后台任务")?;
    }
    let pid = format!("PID ne {}", std::process::id());
    let _ = command("taskkill.exe")?
        .args(["/F", "/FI", &pid, "/IM", "AgyFamilyMonitor.exe"])
        .output();
    Ok(())
}
pub fn installed() -> bool {
    command("schtasks.exe")
        .and_then(|mut c| {
            c.args(["/Query", "/TN", TASK_NAME])
                .output()
                .map_err(|_| "任务查询失败")
        })
        .is_ok_and(|o| o.status.success())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_is_current_user_without_elevation_and_xml_escaped() {
        let xml = task_xml(
            Path::new("C:/A&B/Monitor.exe"),
            "S-1-5-21-1",
            Path::new("C:/A&B"),
        );
        assert!(xml.contains("encoding=\"UTF-16\""));
        assert!(xml.contains("A&amp;B"));
        assert!(xml.contains("LeastPrivilege"));
        assert!(xml.contains("InteractiveToken"));
        assert!(xml.contains("--background"));
        assert!(!xml.contains("HighestAvailable"));
        let bytes = utf16_bytes(&xml);
        assert_eq!(&bytes[..2], &[0xff, 0xfe]);
    }

    #[test]
    fn detects_when_installed_binary_needs_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join("new.exe");
        let target = dir.path().join("AgyFamilyMonitor.exe");
        fs::write(&current, b"v2-binary-bytes").unwrap();
        assert!(!same_binary(&current, &target));
        fs::write(&target, b"v1-binary-bytes").unwrap();
        assert!(!same_binary(&current, &target));
        fs::write(&target, b"v2-binary-bytes").unwrap();
        assert!(same_binary(&current, &target));
    }
}
