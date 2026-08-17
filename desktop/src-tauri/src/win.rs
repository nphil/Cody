//! The crate's entire `unsafe` surface: DPAPI and `ShellExecuteW`.
//!
//! Both are Win32 calls with no safe wrapper in the ecosystem we depend on.
//! Every block below owns its buffers for the whole call, checks the return
//! value before reading any out-parameter, and frees what Windows allocated.

#![allow(unsafe_code)]

use std::path::Path;

/// UTF-16, NUL-terminated. Win32 string parameters are never length-carrying,
/// so the terminator is the contract.
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
mod ffi {
    use super::wide;
    use std::path::Path;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            // SAFETY-relevant invariant: the caller keeps `data` alive for
            // the whole call; DPAPI only reads through this pointer.
            pbData: data.as_ptr() as *mut u8,
        }
    }

    /// Reads an out-blob into an owned Vec and releases the buffer DPAPI
    /// allocated with `LocalAlloc`.
    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        if out.pbData.is_null() || out.cbData == 0 {
            return Vec::new();
        }
        let owned = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as *mut core::ffi::c_void);
        owned
    }

    /// Ties the ciphertext to the current Windows user account.
    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        let input = blob(data);
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: `input` borrows `data`, which outlives the call. `out` is
        // only read after a non-zero return, which is what guarantees DPAPI
        // populated it.
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut out,
            )
        };
        if ok == 0 {
            return None;
        }
        Some(unsafe { take(out) })
    }

    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        let input = blob(data);
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: as in `protect`.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut out,
            )
        };
        if ok == 0 {
            return None;
        }
        Some(unsafe { take(out) })
    }

    /// Launch a detached process through the shell. This is the pattern the
    /// Tauri updater uses to run an NSIS installer over a live process:
    /// `ShellExecuteW` and then exit immediately, never waiting on the child.
    pub fn shell_execute(path: &Path, parameters: &str) -> Result<(), String> {
        let file = wide(&path.to_string_lossy());
        let params = wide(parameters);
        let verb = wide("open");
        // SAFETY: all three buffers are NUL-terminated and live until the
        // call returns; ShellExecuteW copies what it needs.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                params.as_ptr(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        // Documented convention: any value <= 32 is an error code.
        if result as isize <= 32 {
            return Err(format!(
                "Windows refused to launch the installer (code {}).",
                result as isize
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
    ffi::protect(data)
}

#[cfg(windows)]
pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    ffi::unprotect(data)
}

#[cfg(windows)]
pub fn shell_execute(path: &Path, parameters: &str) -> Result<(), String> {
    ffi::shell_execute(path, parameters)
}

#[cfg(not(windows))]
pub fn protect(_data: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(not(windows))]
pub fn unprotect(_data: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(not(windows))]
pub fn shell_execute(_path: &Path, _parameters: &str) -> Result<(), String> {
    Err("Windows only".into())
}

#[cfg(test)]
mod tests {
    use super::wide;

    #[test]
    fn wide_strings_are_nul_terminated() {
        assert_eq!(wide("ok"), vec![b'o' as u16, b'k' as u16, 0]);
        assert_eq!(wide(""), vec![0]);
    }
}
