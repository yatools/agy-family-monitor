use agy_usage_core::{
    discovery::{DiscoveryConfig, SessionRoot},
    Source,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub device_id: String,
    pub device_token: String,
    /// Hex-encoded 32-byte key, specified by the shared Agent API contract.
    pub pseudonym_key: String,
}

impl Credentials {
    pub fn key(&self) -> Result<Vec<u8>, &'static str> {
        let key = hex::decode(&self.pseudonym_key).map_err(|_| "设备匿名化密钥格式无效")?;
        if key.len() != 32 || self.device_id.is_empty() || self.device_token.len() < 32 {
            return Err("设备凭据无效");
        }
        Ok(key)
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ExtraRoot {
    pub path: PathBuf,
    pub source: Source,
}

#[derive(Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub api_base_url: String,
    pub protected_credentials: Option<String>,
    pub extra_roots: Vec<ExtraRoot>,
    pub cc_switch_dir: Option<PathBuf>,
    pub notifications_enabled: bool,
    pub quota_enabled: bool,
    pub quota_cli_path: Option<PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            api_base_url: "https://agent-token.lupages.com".to_string(),
            protected_credentials: None,
            extra_roots: vec![],
            cc_switch_dir: None,
            notifications_enabled: true,
            quota_enabled: true,
            quota_cli_path: None,
        }
    }
}

impl Config {
    pub fn load(data_dir: &Path) -> Result<Self, &'static str> {
        let path = data_dir.join("config.json");
        match fs::read(path) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|_| "本地配置无效，请检查 config.json")
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err("无法读取本地配置"),
        }
    }
    pub fn save(&self, data_dir: &Path) -> Result<(), &'static str> {
        fs::create_dir_all(data_dir).map_err(|_| "无法创建客户端目录")?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|_| "配置序列化失败")?;
        let temporary = data_dir.join("config.json.new");
        let mut file = fs::File::create(&temporary).map_err(|_| "无法保存配置")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "无法保存配置")?;
        drop(file);
        // Windows rename does not replace an existing file; use ReplaceFileW below.
        crate::windows::replace_file(&temporary, &data_dir.join("config.json"))
    }
    pub fn credentials(&self) -> Result<Option<Credentials>, &'static str> {
        let Some(encoded) = &self.protected_credentials else {
            return Ok(None);
        };
        let encrypted = STANDARD.decode(encoded).map_err(|_| "凭据编码无效")?;
        let bytes = crate::windows::dpapi::unprotect(&encrypted)?;
        let credentials: Credentials =
            serde_json::from_slice(&bytes).map_err(|_| "凭据结构无效")?;
        credentials.key()?;
        Ok(Some(credentials))
    }
    pub fn set_credentials(&mut self, credentials: &Credentials) -> Result<(), &'static str> {
        credentials.key()?;
        let bytes = serde_json::to_vec(credentials).map_err(|_| "凭据编码失败")?;
        self.protected_credentials = Some(STANDARD.encode(crate::windows::dpapi::protect(&bytes)?));
        Ok(())
    }
    pub fn apply(&self, discovery: &mut DiscoveryConfig) {
        if discovery.cc_switch_dir.is_none() {
            discovery.cc_switch_dir = self.cc_switch_dir.clone();
        }
        discovery
            .extra_roots
            .extend(self.extra_roots.iter().map(|r| SessionRoot {
                path: r.path.clone(),
                source: r.source,
            }));
    }
}

pub fn default_data_dir() -> Result<PathBuf, &'static str> {
    std::env::var_os("LOCALAPPDATA")
        .map(|p| PathBuf::from(p).join("AgyFamilyMonitor"))
        .ok_or("无法定位 LocalAppData，请指定 --data-dir")
}
