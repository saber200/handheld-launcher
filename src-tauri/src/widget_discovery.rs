use std::io::Write;
use std::sync::Mutex;

// Serialize publish/revoke, including replacement and failure-time credential scrubbing.
static PUBLICATION: Mutex<()> = Mutex::new(());
const FILE_NAME: &str = "widget-ipc.json";

pub fn publish(port: u16, token: &str) -> Result<(), String> {
    if port == 0 || token.is_empty() {
        return Err("discovery requires a nonzero port and a nonempty token".into());
    }
    store(document(Some((port, token)))?)
}

pub fn revoke() -> Result<(), String> {
    // Deliberately omit token; old consumers also reject protocol zero and port zero.
    store(document(None)?)
}

fn document(endpoint: Option<(u16, &str)>) -> Result<Vec<u8>, String> {
    let mut value = serde_json::json!({
        "proto": 0,
        "port": 0,
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
    });
    if let Some((port, token)) = endpoint {
        value["proto"] = 1.into();
        value["port"] = port.into();
        value["token"] = token.into();
    }
    serde_json::to_vec(&value).map_err(|error| error.to_string())
}

fn store(body: Vec<u8>) -> Result<(), String> {
    let _guard = PUBLICATION.lock().map_err(|_| "discovery lock poisoned")?;
    platform::store(&body)
}

fn io_error() -> String {
    std::io::Error::last_os_error().to_string()
}

fn write_and_replace(
    mut file: std::fs::File,
    body: &[u8],
    replace: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let result = file
        .write_all(body)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())
        .and_then(|_| replace());
    if let Err(error) = result {
        // Never delete files, and do not leave credentials in an abandoned temporary file.
        return match file.set_len(0).and_then(|_| file.sync_all()) {
            Ok(()) => Err(error),
            Err(scrub) => Err(format!("{error}; temporary credential scrub failed: {scrub}")),
        };
    }
    Ok(())
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::path::{Component, Path, PathBuf, Prefix};
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Security::Authorization::*;
    use windows_sys::Win32::Security::*;
    use windows_sys::Win32::Storage::FileSystem::*;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows_sys::Win32::UI::Shell::{FOLDERID_RoamingAppData, SHGetKnownFolderPath};

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    struct Local(*mut c_void);
    impl Drop for Local {
        fn drop(&mut self) {
            unsafe { LocalFree(self.0) };
        }
    }

    fn wide(path: &Path) -> Result<Vec<u16>, String> {
        let mut text: Vec<u16> = path.as_os_str().encode_wide().collect();
        if text.contains(&0) {
            return Err("NUL in discovery path".into());
        }
        text.push(0);
        Ok(text)
    }

    unsafe fn wide_string(ptr: *const u16) -> Vec<u16> {
        let mut len = 0;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        std::slice::from_raw_parts(ptr, len).to_vec()
    }

    fn roaming() -> Result<PathBuf, String> {
        let mut ptr = null_mut();
        let status = unsafe {
            SHGetKnownFolderPath(&FOLDERID_RoamingAppData, 0, null_mut(), &mut ptr)
        };
        if status < 0 || ptr.is_null() {
            if !ptr.is_null() {
                unsafe { CoTaskMemFree(ptr.cast()) };
            }
            return Err(format!("RoamingAppData lookup failed: {status:#x}"));
        }
        use std::os::windows::ffi::OsStringExt;
        let path = unsafe { std::ffi::OsString::from_wide(&wide_string(ptr)) };
        unsafe { CoTaskMemFree(ptr.cast()) };
        Ok(path.into())
    }

    struct Security {
        // usize storage gives TOKEN_USER the alignment required by GetTokenInformation.
        user: Vec<usize>,
        descriptor: Local,
    }

    impl Security {
        fn new() -> Result<Self, String> {
            unsafe {
                let mut token = null_mut();
                if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                    return Err(io_error());
                }
                let token = Handle(token);
                let mut bytes = 0;
                GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut bytes);
                if bytes < size_of::<TOKEN_USER>() as u32 {
                    return Err("invalid token user size".into());
                }
                let mut user = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
                if GetTokenInformation(token.0, TokenUser, user.as_mut_ptr().cast(), bytes, &mut bytes) == 0 {
                    return Err(io_error());
                }
                let sid = (*(user.as_ptr().cast::<TOKEN_USER>())).User.Sid;
                let mut text = null_mut();
                if ConvertSidToStringSidW(sid, &mut text) == 0 {
                    return Err(io_error());
                }
                let text_guard = Local(text.cast());
                let sid_text = String::from_utf16(&wide_string(text)).map_err(|e| e.to_string())?;
                drop(text_guard);
                // Protected DACL, one explicit ACE, no inherited or additional principals.
                let sddl = wide(Path::new(&format!("O:{sid_text}D:P(A;;FA;;;{sid_text})")))?;
                let mut descriptor = null_mut();
                if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, null_mut()) == 0 {
                    return Err(io_error());
                }
                Ok(Self { user, descriptor: Local(descriptor) })
            }
        }

        fn attributes(&self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.descriptor.0,
                bInheritHandle: 0,
            }
        }

        fn verify(&self, handle: HANDLE) -> Result<(), String> {
            unsafe {
                let mut owner = null_mut();
                let mut dacl = null_mut();
                let mut descriptor = null_mut();
                let status = GetSecurityInfo(handle, SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    &mut owner, null_mut(), &mut dacl, null_mut(), &mut descriptor);
                let _descriptor = Local(descriptor);
                if status != 0 {
                    return Err(format!("discovery ACL query failed: {status}"));
                }
                let sid = (*(self.user.as_ptr().cast::<TOKEN_USER>())).User.Sid;
                let mut control = 0;
                let mut revision = 0;
                if owner.is_null() || EqualSid(owner, sid) == 0 || dacl.is_null()
                    || GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) == 0
                    || control & SE_DACL_PROTECTED == 0 || (*dacl).AceCount != 1 {
                    return Err("discovery file must have a protected current-user-only ACL".into());
                }
                let mut ace = null_mut();
                if GetAce(dacl, 0, &mut ace) == 0 {
                    return Err(io_error());
                }
                let ace = &*(ace.cast::<ACCESS_ALLOWED_ACE>());
                if ace.Header.AceType != 0 || ace.Header.AceFlags != 0
                    || ace.Mask != FILE_ALL_ACCESS
                    || EqualSid((&ace.SidStart as *const u32).cast_mut().cast(), sid) == 0 {
                    return Err("discovery ACL grants unexpected access".into());
                }
                Ok(())
            }
        }

        fn verify_directory(&self, handle: HANDLE) -> Result<(), String> {
            unsafe {
                let mut owner = null_mut();
                let mut dacl = null_mut();
                let mut descriptor = null_mut();
                let status = GetSecurityInfo(handle, SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    &mut owner, null_mut(), &mut dacl, null_mut(), &mut descriptor);
                let _descriptor = Local(descriptor);
                if status != 0 {
                    return Err(format!("discovery directory ACL query failed: {status}"));
                }
                let user = (*(self.user.as_ptr().cast::<TOKEN_USER>())).User.Sid;
                let trusted = |sid: PSID| {
                    !sid.is_null() && (EqualSid(sid, user) != 0
                        || IsWellKnownSid(sid, WinLocalSystemSid) != 0
                        || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0)
                };
                if !trusted(owner) || dacl.is_null() || IsValidAcl(dacl) == 0 {
                    return Err("unsafe discovery directory owner or DACL".into());
                }
                // Shared application directories may inherit normal SYSTEM/admin/user
                // entries and grant others read/traverse access. Never repair their ACL.
                // DELETE_CHILD is critical: it bypasses the discovery file's own DACL.
                let mutation = FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA
                    | FILE_WRITE_ATTRIBUTES | FILE_DELETE_CHILD | DELETE | WRITE_DAC
                    // MAXIMUM_ALLOWED is an access-request bit, not a normal ACE grant;
                    // reject it conservatively without adding SystemServices bindings.
                    | WRITE_OWNER | GENERIC_WRITE | GENERIC_ALL | 0x0200_0000;
                for index in 0..u32::from((*dacl).AceCount) {
                    let mut raw = null_mut();
                    if GetAce(dacl, index, &mut raw) == 0 { return Err(io_error()); }
                    let header = &*raw.cast::<ACE_HEADER>();
                    if u32::from(header.AceFlags) & INHERIT_ONLY_ACE != 0 {
                        continue;
                    }
                    // Basic deny ACEs cannot add access. Unknown/object/callback ACEs
                    // fail closed rather than guessing their SID layout or conditions.
                    if header.AceType == 1 { continue; } // ACCESS_DENIED_ACE_TYPE
                    if header.AceType != 0 // ACCESS_ALLOWED_ACE_TYPE
                        || usize::from(header.AceSize) < size_of::<ACCESS_ALLOWED_ACE>() {
                        return Err("unsupported discovery directory ACE".into());
                    }
                    let ace = &*raw.cast::<ACCESS_ALLOWED_ACE>();
                    let sid = (&ace.SidStart as *const u32).cast_mut().cast();
                    if ace.Mask & mutation != 0 && !trusted(sid) {
                        return Err("untrusted principal can modify discovery directory".into());
                    }
                }
                // Actual create/rename operations also enforce the current token's
                // effective access; a grant to Administrators alone is not sufficient.
                Ok(())
            }
        }
    }

    fn pin_directory(path: &Path) -> Result<Handle, String> {
        let path = wide(path)?;
        // Pin every ancestor without write/delete sharing to prevent junction/rename races.
        let raw = unsafe { CreateFileW(path.as_ptr(), FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_SHARE_READ, null(), OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
        if raw == INVALID_HANDLE_VALUE { return Err(io_error()); }
        let handle = Handle(raw);
        let mut info = unsafe { zeroed::<BY_HANDLE_FILE_INFORMATION>() };
        if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
            return Err(io_error());
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err("reparse point or non-directory in discovery path".into());
        }
        Ok(handle)
    }

    pub(super) fn store(body: &[u8]) -> Result<(), String> {
        let security = Security::new()?;
        let root = roaming()?;
        let mut components = root.components();
        if !matches!(components.next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_)))
            || !matches!(components.next(), Some(Component::RootDir))
            || components.any(|c| !matches!(c, Component::Normal(_))) {
            return Err("discovery requires an absolute local drive path".into());
        }
        let mut ancestors: Vec<_> = root.ancestors().collect();
        ancestors.reverse();
        let mut pins = Vec::new();
        for ancestor in ancestors { pins.push(pin_directory(ancestor)?); }
        security.verify_directory(pins.last().unwrap().0)?;
        let directory = root.join("handheld-launcher");
        let attrs = security.attributes();
        if unsafe { CreateDirectoryW(wide(&directory)?.as_ptr(), &attrs) } == 0
            && unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
            return Err(io_error());
        }
        pins.push(pin_directory(&directory)?);
        // Fail closed rather than repair an unsafe preexisting directory.
        security.verify_directory(pins.last().unwrap().0)?;
        store_in(&directory, body, &security)
    }

    // The caller retains ancestor pins for the entire publication.
    fn store_in(directory: &Path, body: &[u8], security: &Security) -> Result<(), String> {
        let pin = pin_directory(directory)?;
        security.verify_directory(pin.0)?;
        let attrs = security.attributes();
        let temporary = directory.join(format!(".widget-ipc-{}.tmp", crate::widget_protocol::random_token()?));
        let temporary_wide = wide(&temporary)?;
        let destination = wide(&directory.join(FILE_NAME))?;
        let raw = unsafe { CreateFileW(temporary_wide.as_ptr(), GENERIC_WRITE | READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_DELETE, &attrs, CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
        if raw == INVALID_HANDLE_VALUE { return Err(io_error()); }
        let file = unsafe { std::fs::File::from_raw_handle(raw) };
        security.verify(file.as_raw_handle())?;
        // Replace the entry, not a symlink/hardlink referent; retain the NEW file ACL.
        write_and_replace(file, body, || {
            if unsafe { MoveFileExW(temporary_wide.as_ptr(), destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 {
                Err(io_error())
            } else { Ok(()) }
        })
    }
    #[cfg(test)]
    mod tests {
        use super::*;

        // Random test fixtures are retained; never access the real discovery path.
        fn isolated(security: &Security, extra: &str) -> PathBuf {
            let path = std::env::temp_dir().join(format!(
                "widget-discovery-test-{}", crate::widget_protocol::random_token().unwrap()));
            unsafe {
                let sid = (*(security.user.as_ptr().cast::<TOKEN_USER>())).User.Sid;
                let mut text = null_mut();
                assert_ne!(ConvertSidToStringSidW(sid, &mut text), 0);
                let _text = Local(text.cast());
                let sid = String::from_utf16(&wide_string(text)).unwrap();
                let sddl = wide(Path::new(&format!(
                    "O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA){extra}"))).unwrap();
                let mut descriptor = null_mut();
                assert_ne!(ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(), 1, &mut descriptor, null_mut()), 0);
                let _descriptor = Local(descriptor);
                let attrs = SECURITY_ATTRIBUTES {
                    nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: descriptor,
                    bInheritHandle: 0,
                };
                assert_ne!(CreateDirectoryW(wide(&path).unwrap().as_ptr(), &attrs), 0);
            }
            path
        }

        fn checked_file(path: &Path, security: &Security) -> std::fs::File {
            let file = std::fs::File::open(path).unwrap();
            security.verify(file.as_raw_handle()).unwrap();
            file
        }

        fn acl_snapshot(handle: HANDLE) -> (Vec<u8>, Vec<u8>, u16, u32) {
            unsafe {
                let mut owner = null_mut();
                let mut dacl = null_mut();
                let mut descriptor = null_mut();
                assert_eq!(GetSecurityInfo(handle, SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    &mut owner, null_mut(), &mut dacl, null_mut(), &mut descriptor), 0);
                let _descriptor = Local(descriptor);
                assert!(!owner.is_null() && !dacl.is_null());
                let mut control = 0;
                let mut revision = 0;
                assert_ne!(GetSecurityDescriptorControl(descriptor, &mut control, &mut revision), 0);
                let owner = std::slice::from_raw_parts(owner.cast::<u8>(),
                    GetLengthSid(owner) as usize).to_vec();
                let dacl = std::slice::from_raw_parts(dacl.cast::<u8>(),
                    usize::from((*dacl).AclSize)).to_vec();
                (owner, dacl, control, revision)
            }
        }

        #[test]
        fn shared_directory_allows_trusted_and_read_only_aces() {
            let security = Security::new().unwrap();
            let path = isolated(&security, "(A;OICI;GRGX;;;WD)");
            let pin = pin_directory(&path).unwrap();
            security.verify_directory(pin.0).unwrap();
            assert!(security.verify(pin.0).is_err());
            let before = acl_snapshot(pin.0);
            store_in(&path, b"test-only", &security).unwrap();
            checked_file(&path.join(FILE_NAME), &security);
            assert_eq!(acl_snapshot(pin.0), before);
            // Publishing must not replace the shared ACL with the file-only ACL.
            security.verify_directory(pin.0).unwrap();
            assert!(security.verify(pin.0).is_err());
        }

        #[test]
        fn shared_directory_rejects_untrusted_mutation() {
            let security = Security::new().unwrap();
            // DELETE_CHILD, WRITE_DAC, WRITE_OWNER, write data, generic write/all.
            for mask in ["0x40", "0x40000", "0x80000", "0x2", "GW", "GA"] {
                let path = isolated(&security, &format!("(A;;{mask};;;WD)"));
                let pin = pin_directory(&path).unwrap();
                assert!(security.verify_directory(pin.0).is_err());
                assert!(store_in(&path, b"test-only", &security).is_err());
                assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);
            }
        }

        #[test]
        fn atomic_replace_keeps_old_alias_and_new_file_acl() {
            let security = Security::new().unwrap();
            let path = isolated(&security, "");
            store_in(&path, b"old-test-token", &security).unwrap();
            let alias = path.join("old-alias");
            std::fs::hard_link(path.join(FILE_NAME), &alias).unwrap();
            let revoked = document(None).unwrap();
            store_in(&path, &revoked, &security).unwrap();
            checked_file(&path.join(FILE_NAME), &security);
            assert_eq!(std::fs::read(path.join(FILE_NAME)).unwrap(), revoked);
            assert_eq!(std::fs::read(alias).unwrap(), b"old-test-token");
        }

        #[test]
        fn failed_move_scrubs_temporary_and_retains_destination() {
            let security = Security::new().unwrap();
            let path = isolated(&security, "");
            std::fs::create_dir(path.join(FILE_NAME)).unwrap();
            assert!(store_in(&path, b"test-secret", &security).is_err());
            let temps: Vec<_> = std::fs::read_dir(&path).unwrap().map(Result::unwrap)
                .filter(|e| e.file_name().to_string_lossy().starts_with(".widget-ipc-")).collect();
            assert_eq!(temps.len(), 1);
            assert_eq!(checked_file(&temps[0].path(), &security).metadata().unwrap().len(), 0);
            assert!(path.join(FILE_NAME).is_dir());
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod platform {
    use super::*;
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::io::{AsRawFd, FromRawFd};
    use std::path::{Component, PathBuf};

    #[repr(C)]
    struct Passwd {
        name: *mut c_char,
        passwd: *mut c_char,
        uid: u32,
        gid: u32,
        #[cfg(target_os = "macos")]
        change: i64,
        #[cfg(target_os = "macos")]
        class: *mut c_char,
        gecos: *mut c_char,
        dir: *mut c_char,
        shell: *mut c_char,
        #[cfg(target_os = "macos")]
        expire: i64,
        #[cfg(target_os = "macos")]
        fields: c_int,
    }

    unsafe extern "C" {
        fn getuid() -> u32;
        fn geteuid() -> u32;
        fn getpwuid_r(uid: u32, pwd: *mut Passwd, buf: *mut c_char,
            len: usize, result: *mut *mut Passwd) -> c_int;
        fn openat(fd: c_int, name: *const c_char, flags: c_int, ...) -> c_int;
        fn mkdirat(fd: c_int, name: *const c_char, mode: u32) -> c_int;
        fn renameat(from_fd: c_int, from: *const c_char,
            to_fd: c_int, to: *const c_char) -> c_int;
    }

    #[cfg(target_os = "linux")]
    const DIRECTORY_FLAGS: c_int = 0x10000 | 0x20000 | 0x80000;
    #[cfg(target_os = "macos")]
    const DIRECTORY_FLAGS: c_int = 0x100000 | 0x100 | 0x1000000;
    #[cfg(target_os = "linux")]
    const CREATE_FLAGS: c_int = 1 | 0x40 | 0x80 | 0x20000 | 0x80000;
    #[cfg(target_os = "macos")]
    const CREATE_FLAGS: c_int = 1 | 0x200 | 0x800 | 0x100 | 0x1000000;

    fn home(uid: u32) -> Result<PathBuf, String> {
        // Use the account database, not HOME or XDG_CONFIG_HOME.
        let mut record: Passwd = unsafe { std::mem::zeroed() };
        let mut buffer = vec![0u8; 65536];
        let mut result = std::ptr::null_mut();
        let status = unsafe { getpwuid_r(uid, &mut record, buffer.as_mut_ptr().cast(),
            buffer.len(), &mut result) };
        if status != 0 || result.is_null() || record.dir.is_null() || record.uid != uid {
            return Err(format!("account home lookup failed: {status}"));
        }
        let bytes = unsafe { CStr::from_ptr(record.dir) }.to_bytes();
        Ok(std::ffi::OsStr::from_bytes(bytes).into())
    }

    fn open_directory(parent: &std::fs::File, name: &CStr) -> Result<std::fs::File, String> {
        let fd = unsafe { openat(parent.as_raw_fd(), name.as_ptr(), DIRECTORY_FLAGS) };
        if fd < 0 { return Err(io_error()); }
        Ok(unsafe { std::fs::File::from_raw_fd(fd) })
    }

    fn check_directory(file: &std::fs::File, uid: u32, require_user: bool) -> Result<(), String> {
        let info = file.metadata().map_err(|e| e.to_string())?;
        // The final directory is shared with other application features: 0755 is
        // safe, but another user must not be able to rename/unlink its children.
        if !info.is_dir() || (info.uid() != uid && (require_user || info.uid() != 0))
            || info.mode() & 0o022 != 0 {
            return Err("unsafe discovery directory ownership or permissions".into());
        }
        Ok(())
    }

    pub(super) fn store(body: &[u8]) -> Result<(), String> {
        let uid = unsafe { getuid() };
        if uid != unsafe { geteuid() } {
            return Err("refusing discovery under a different effective user".into());
        }
        let home = home(uid)?;
        if !home.is_absolute() || home == std::path::Path::new("/") {
            return Err("invalid account home".into());
        }
        let mut directory = std::fs::File::open("/").map_err(|e| e.to_string())?;
        for component in home.components() {
            match component {
                Component::RootDir => continue,
                Component::Normal(name) => {
                    let name = CString::new(name.as_bytes()).map_err(|e| e.to_string())?;
                    directory = open_directory(&directory, &name)?;
                    check_directory(&directory, uid, false)?;
                }
                _ => return Err("ambiguous account home".into()),
            }
        }
        #[cfg(target_os = "macos")]
        let subdirs = ["Library", "Application Support", "handheld-launcher"];
        #[cfg(target_os = "linux")]
        let subdirs = [".config", "handheld-launcher"];
        for (index, name) in subdirs.iter().enumerate() {
            let name = CString::new(*name).map_err(|e| e.to_string())?;
            let made = unsafe { mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
            if made != 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists {
                return Err(io_error());
            }
            directory = open_directory(&directory, &name)?;
            check_directory(&directory, uid, index + 1 == subdirs.len())?;
        }
        store_in(&directory, body, uid)
    }

    fn store_in(directory: &std::fs::File, body: &[u8], uid: u32) -> Result<(), String> {
        check_directory(directory, uid, true)?;
        // Descriptor-relative operations never follow an existing target or directory link.
        let temporary = CString::new(format!(".widget-ipc-{}.tmp", crate::widget_protocol::random_token()?))
            .map_err(|e| e.to_string())?;
        let fd = unsafe { openat(directory.as_raw_fd(), temporary.as_ptr(), CREATE_FLAGS, 0o600u32) };
        if fd < 0 { return Err(io_error()); }
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        file.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        let info = file.metadata().map_err(|e| e.to_string())?;
        if !info.is_file() || info.uid() != uid || info.mode() & 0o777 != 0o600 || info.nlink() != 1 {
            return Err("unsafe temporary discovery file".into());
        }
        let destination = CString::new(FILE_NAME).map_err(|e| e.to_string())?;
        write_and_replace(file, body, || {
            if unsafe { renameat(directory.as_raw_fd(), temporary.as_ptr(),
                directory.as_raw_fd(), destination.as_ptr()) } != 0 {
                Err(io_error())
            } else { Ok(()) }
        })?;
        directory.sync_all().map_err(|e| e.to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::{symlink, DirBuilderExt};

        // Deliberately retained: never touch the real discovery directory or delete files.
        fn isolated(mode: u32) -> (PathBuf, std::fs::File) {
            let path = std::env::temp_dir().join(format!(
                "widget-discovery-test-{}", crate::widget_protocol::random_token().unwrap()));
            std::fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
            let directory = std::fs::File::open(&path).unwrap();
            directory.set_permissions(std::fs::Permissions::from_mode(mode)).unwrap();
            (path, directory)
        }

        #[test]
        fn shared_directory_policy_does_not_change_permissions() {
            let uid = unsafe { getuid() };
            for mode in [0o700, 0o750, 0o755, 0o770, 0o777] {
                let (path, dir) = isolated(mode);
                assert_eq!(check_directory(&dir, uid, true).is_ok(), mode & 0o022 == 0);
                if mode & 0o022 != 0 {
                    assert!(store_in(&dir, b"test-only", uid).is_err());
                    assert_eq!(std::fs::read_dir(path).unwrap().count(), 0);
                }
                assert_eq!(dir.metadata().unwrap().mode() & 0o777, mode);
                assert!(check_directory(&dir, uid.wrapping_add(1), true).is_err());
            }
        }

        #[test]
        fn publication_replaces_inode_and_preserves_private_permissions() {
            let (path, dir) = isolated(0o755);
            let uid = unsafe { getuid() };
            let old = document(Some((12345, "old-test-token"))).unwrap();
            store_in(&dir, &old, uid).unwrap();
            let destination = path.join(FILE_NAME);
            let old_inode = std::fs::metadata(&destination).unwrap().ino();
            let alias = path.join("old-alias");
            std::fs::hard_link(&destination, &alias).unwrap();
            let revoked = document(None).unwrap();
            store_in(&dir, &revoked, uid).unwrap();
            assert_eq!(std::fs::read(&destination).unwrap(), revoked);
            assert_eq!(std::fs::read(alias).unwrap(), old);
            let info = std::fs::metadata(destination).unwrap();
            assert_ne!(info.ino(), old_inode);
            assert_eq!(info.mode() & 0o777, 0o600);
            assert_eq!(info.uid(), uid);
            assert_eq!(info.nlink(), 1);
            assert_eq!(dir.metadata().unwrap().mode() & 0o777, 0o755);
        }

        #[test]
        fn symlinks_are_not_followed() {
            let (path, dir) = isolated(0o700);
            let referent = path.join("untouched");
            std::fs::write(&referent, b"original").unwrap();
            symlink(&referent, path.join(FILE_NAME)).unwrap();
            store_in(&dir, b"replacement", unsafe { getuid() }).unwrap();
            assert_eq!(std::fs::read(referent).unwrap(), b"original");
            assert!(!std::fs::symlink_metadata(path.join(FILE_NAME)).unwrap().file_type().is_symlink());
            symlink(&path, path.join("directory-link")).unwrap();
            assert!(open_directory(&dir, &CString::new("directory-link").unwrap()).is_err());
        }

        #[test]
        fn failed_rename_retains_empty_private_temporary_file() {
            let (path, dir) = isolated(0o700);
            std::fs::create_dir(path.join(FILE_NAME)).unwrap();
            assert!(store_in(&dir, b"test-secret", unsafe { getuid() }).is_err());
            let temps: Vec<_> = std::fs::read_dir(&path).unwrap().map(Result::unwrap)
                .filter(|e| e.file_name().to_string_lossy().starts_with(".widget-ipc-")).collect();
            assert_eq!(temps.len(), 1);
            let info = temps[0].metadata().unwrap();
            assert_eq!(info.len(), 0);
            assert_eq!(info.mode() & 0o777, 0o600);
            assert!(path.join(FILE_NAME).is_dir());
        }
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod platform {
    pub(super) fn store(_: &[u8]) -> Result<(), String> {
        Err("secure discovery is unsupported on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_has_expected_fields_and_escapes_token() {
        let token = "quoted\"token\\with\nnewline";
        let value: serde_json::Value = serde_json::from_slice(&document(Some((32123, token))).unwrap()).unwrap();
        assert_eq!(value["proto"], 1);
        assert_eq!(value["port"], 32123);
        assert_eq!(value["token"], token);
        assert_eq!(value["pid"], std::process::id());
        assert_eq!(value["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(value.as_object().unwrap().len(), 5);
    }

    #[test]
    fn revocation_is_invalid_and_contains_no_token() {
        let value: serde_json::Value = serde_json::from_slice(&document(None).unwrap()).unwrap();
        assert_eq!(value["proto"], 0);
        assert_eq!(value["port"], 0);
        assert!(value.get("token").is_none());
        assert_eq!(value.as_object().unwrap().len(), 4);
    }

    #[test]
    fn invalid_endpoint_is_rejected_before_filesystem_access() {
        assert!(publish(0, "secret").is_err());
        assert!(publish(12345, "").is_err());
    }
}
