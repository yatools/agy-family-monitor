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
        r#"<?xml version="1.0" encoding="UTF-8"?>
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

pub fn install(data_dir: &Path) -> Result<(), &'static str> {
    fs::create_dir_all(data_dir).map_err(|_| "无法创建程序目录")?;
    let current = std::env::current_exe().map_err(|_| "无法定位当前程序")?;
    let target = data_dir.join("AgyFamilyMonitor.exe");
    if current.canonicalize().ok() != target.canonicalize().ok() {
        fs::copy(current, &target).map_err(|_| "无法复制客户端，可能已有后台实例")?;
    }
    super::toast::register_shortcut(&target)?;
    let xml = task_xml(&target, &current_sid()?, data_dir);
    let path = data_dir.join("autostart-task.xml");
    fs::write(&path, xml).map_err(|_| "无法生成启动任务")?;
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

pub fn remove() -> Result<(), &'static str> {
    if installed() {
        let result = command("schtasks.exe")?
            .args(["/Delete", "/TN", TASK_NAME, "/F"])
            .output()
            .map_err(|_| "无法删除启动任务")?;
        if !result.status.success() {
            return Err("启动任务删除失败");
        }
    }
    super::toast::remove_shortcut()
}
pub fn stop() -> Result<(), &'static str> {
    if installed() {
        let _ = command("schtasks.exe")?
            .args(["/End", "/TN", TASK_NAME])
            .output()
            .map_err(|_| "无法停止后台任务")?;
    }
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
        assert!(xml.contains("A&amp;B"));
        assert!(xml.contains("LeastPrivilege"));
        assert!(xml.contains("InteractiveToken"));
        assert!(xml.contains("--background"));
        assert!(!xml.contains("HighestAvailable"));
    }
}
