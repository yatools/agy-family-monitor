#[cfg(windows)]
fn transform(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, &'static str> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(|_| "凭据数据过大")?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // Current-user scope (not LOCAL_MACHINE), with no dialogs or fallback plaintext.
    let result = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if result == 0 {
        return Err("Windows DPAPI 凭据保护失败，请使用原 Windows 用户重新绑定。");
    }
    let copied = if output.cbData == 0 {
        Vec::new()
    } else {
        if output.pbData.is_null() {
            return Err("DPAPI 返回无效数据");
        }
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec()
    };
    unsafe { LocalFree(output.pbData as *mut core::ffi::c_void) };
    Ok(copied)
}
#[cfg(not(windows))]
fn transform(_: &[u8], _: bool) -> Result<Vec<u8>, &'static str> {
    Err("设备凭据保护仅支持 Windows x64")
}

pub fn protect(bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
    transform(bytes, true)
}
pub fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
    transform(bytes, false)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn current_user_roundtrip_and_tampering_rejected() {
        let plain = b"synthetic-device-secret-never-store-plaintext";
        let mut protected = protect(plain).unwrap();
        assert!(!protected.windows(plain.len()).any(|w| w == plain));
        assert_eq!(unprotect(&protected).unwrap(), plain);
        let last = protected.len() - 1;
        protected[last] ^= 0xff;
        assert!(unprotect(&protected).is_err());
    }
}
