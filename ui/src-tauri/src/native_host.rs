//! Native-messaging host manifests: the small JSON files each browser reads
//! to find the `gloss-bridge` program the Gloss extension connects to. Gloss
//! writes them on every launch, so the path stays right after the app is
//! moved or updated.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Host name the extension passes to `connectNative`.
pub const HOST_NAME: &str = "sh.aay.gloss";
/// Id of the Chrome Web Store listing, fixed by the `key` in the
/// extension's manifest, so load-unpacked builds get the same id.
pub const CHROME_EXTENSION_ID: &str = include_str!("../../../extension/EXTENSION_ID");
/// The Firefox add-on id from the extension's `browser_specific_settings`.
pub const FIREFOX_EXTENSION_ID: &str = "gloss@aay.sh";
/// Where the Chrome-family extension is installed from.
pub const CHROME_STORE_URL: &str = "https://chromewebstore.google.com/detail/gloss/";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Family {
    Chromium,
    Firefox,
}

/// A browser Gloss knows how to register with.
#[derive(Clone, Debug)]
pub struct BrowserTarget {
    pub id: &'static str,
    pub name: &'static str,
    pub family: Family,
    /// The `NativeMessagingHosts` folder for this browser and user.
    pub dir: PathBuf,
}

/// What the Settings sheet shows for one browser.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRegistration {
    pub id: String,
    pub name: String,
    pub family: Family,
    /// The browser's profile folder exists on this machine.
    pub installed: bool,
    /// The manifest is in place with the current bridge path.
    pub registered: bool,
    pub manifest_path: String,
    pub error: Option<String>,
}

/// The browsers this platform can register, installed or not. A browser
/// counts as installed when the parent of its hosts folder exists.
pub fn targets() -> Vec<BrowserTarget> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let mut out = Vec::new();
    let mut add = |id: &'static str, name: &'static str, family: Family, dir: PathBuf| {
        out.push(BrowserTarget { id, name, family, dir });
    };
    #[cfg(target_os = "macos")]
    {
        let support = home.join("Library/Application Support");
        add("chrome", "Google Chrome", Family::Chromium, support.join("Google/Chrome/NativeMessagingHosts"));
        add("chromium", "Chromium", Family::Chromium, support.join("Chromium/NativeMessagingHosts"));
        add("brave", "Brave", Family::Chromium, support.join("BraveSoftware/Brave-Browser/NativeMessagingHosts"));
        add("edge", "Microsoft Edge", Family::Chromium, support.join("Microsoft Edge/NativeMessagingHosts"));
        add("arc", "Arc", Family::Chromium, support.join("Arc/User Data/NativeMessagingHosts"));
        add("vivaldi", "Vivaldi", Family::Chromium, support.join("Vivaldi/NativeMessagingHosts"));
        add("firefox", "Firefox", Family::Firefox, support.join("Mozilla/NativeMessagingHosts"));
    }
    #[cfg(target_os = "linux")]
    {
        let config = home.join(".config");
        add("chrome", "Google Chrome", Family::Chromium, config.join("google-chrome/NativeMessagingHosts"));
        add("chromium", "Chromium", Family::Chromium, config.join("chromium/NativeMessagingHosts"));
        add("brave", "Brave", Family::Chromium, config.join("BraveSoftware/Brave-Browser/NativeMessagingHosts"));
        add("edge", "Microsoft Edge", Family::Chromium, config.join("microsoft-edge/NativeMessagingHosts"));
        add("vivaldi", "Vivaldi", Family::Chromium, config.join("vivaldi/NativeMessagingHosts"));
        add("firefox", "Firefox", Family::Firefox, home.join(".mozilla/native-messaging-hosts"));
    }
    #[cfg(target_os = "windows")]
    {
        // Windows browsers find the manifest through the registry; the files
        // live in the Gloss home folder and the registry keys point at them.
        let base = home.join(".gloss").join("native-hosts");
        add("chrome", "Google Chrome", Family::Chromium, base.join("chrome"));
        add("edge", "Microsoft Edge", Family::Chromium, base.join("edge"));
        add("firefox", "Firefox", Family::Firefox, base.join("firefox"));
    }
    out
}

/// The manifest for one browser family, pointing at `bridge_path`.
pub fn manifest_json(family: Family, bridge_path: &Path) -> String {
    let mut m = serde_json::json!({
        "name": HOST_NAME,
        "description": "Relays the Gloss browser extension to the Gloss app",
        "path": bridge_path.to_string_lossy(),
        "type": "stdio",
    });
    match family {
        Family::Chromium => {
            m["allowed_origins"] = serde_json::json!([format!("chrome-extension://{}/", CHROME_EXTENSION_ID.trim())]);
        }
        Family::Firefox => {
            m["allowed_extensions"] = serde_json::json!([FIREFOX_EXTENSION_ID]);
        }
    }
    serde_json::to_string_pretty(&m).unwrap_or_default()
}

fn manifest_path(target: &BrowserTarget) -> PathBuf {
    target.dir.join(format!("{}.json", HOST_NAME))
}

fn installed(target: &BrowserTarget) -> bool {
    if cfg!(target_os = "windows") {
        return true;
    }
    target.dir.parent().map(|p| p.is_dir()).unwrap_or(false)
}

/// Writes the manifest for every installed browser, replacing a stale one.
/// Nothing here fails the app: each browser reports its own error.
pub fn register_all(bridge_path: &Path) -> Vec<BrowserRegistration> {
    targets()
        .iter()
        .map(|t| {
            let path = manifest_path(t);
            let mut reg = BrowserRegistration {
                id: t.id.to_string(),
                name: t.name.to_string(),
                family: t.family,
                installed: installed(t),
                registered: false,
                manifest_path: path.to_string_lossy().to_string(),
                error: None,
            };
            if !reg.installed {
                return reg;
            }
            let wanted = manifest_json(t.family, bridge_path);
            let current = std::fs::read_to_string(&path).ok();
            let result = if current.as_deref() == Some(wanted.as_str()) {
                Ok(())
            } else {
                std::fs::create_dir_all(&t.dir).and_then(|_| std::fs::write(&path, &wanted))
            };
            match result.and_then(|_| registry_register(t, &path)) {
                Ok(()) => reg.registered = true,
                Err(e) => reg.error = Some(e.to_string()),
            }
            reg
        })
        .collect()
}

/// Removes every manifest Gloss wrote.
pub fn unregister_all() -> Vec<BrowserRegistration> {
    targets()
        .iter()
        .map(|t| {
            let path = manifest_path(t);
            let mut reg = BrowserRegistration {
                id: t.id.to_string(),
                name: t.name.to_string(),
                family: t.family,
                installed: installed(t),
                registered: false,
                manifest_path: path.to_string_lossy().to_string(),
                error: None,
            };
            if path.exists() {
                if let Err(e) = std::fs::remove_file(&path) {
                    reg.error = Some(e.to_string());
                }
            }
            if let Err(e) = registry_unregister(t) {
                reg.error = Some(e.to_string());
            }
            reg
        })
        .collect()
}

/// Whether the manifests all point at `bridge_path` right now.
pub fn status(bridge_path: &Path) -> Vec<BrowserRegistration> {
    targets()
        .iter()
        .map(|t| {
            let path = manifest_path(t);
            let wanted = manifest_json(t.family, bridge_path);
            BrowserRegistration {
                id: t.id.to_string(),
                name: t.name.to_string(),
                family: t.family,
                installed: installed(t),
                registered: std::fs::read_to_string(&path).ok().as_deref() == Some(wanted.as_str()),
                manifest_path: path.to_string_lossy().to_string(),
                error: None,
            }
        })
        .collect()
}

/// macOS runs an app downloaded in a quarantined folder from a random
/// read-only copy ("app translocation"). A bridge path inside it goes stale
/// as soon as the app is moved, so the user is told to move Gloss first.
pub fn translocated(exe: &Path) -> bool {
    exe.to_string_lossy().contains("/AppTranslocation/")
}

#[cfg(target_os = "windows")]
fn registry_register(t: &BrowserTarget, manifest: &Path) -> std::io::Result<()> {
    let key = match t.family {
        Family::Chromium if t.id == "edge" => format!(r"Software\Microsoft\Edge\NativeMessagingHosts\{}", HOST_NAME),
        Family::Chromium => format!(r"Software\Google\Chrome\NativeMessagingHosts\{}", HOST_NAME),
        Family::Firefox => format!(r"Software\Mozilla\NativeMessagingHosts\{}", HOST_NAME),
    };
    let status = std::process::Command::new("reg")
        .args(["add", &format!(r"HKCU\{}", key), "/ve", "/t", "REG_SZ", "/d", &manifest.to_string_lossy(), "/f"])
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other("reg add failed"))
    }
}

#[cfg(not(target_os = "windows"))]
fn registry_register(_t: &BrowserTarget, _manifest: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn registry_unregister(t: &BrowserTarget) -> std::io::Result<()> {
    let key = match t.family {
        Family::Chromium if t.id == "edge" => format!(r"Software\Microsoft\Edge\NativeMessagingHosts\{}", HOST_NAME),
        Family::Chromium => format!(r"Software\Google\Chrome\NativeMessagingHosts\{}", HOST_NAME),
        Family::Firefox => format!(r"Software\Mozilla\NativeMessagingHosts\{}", HOST_NAME),
    };
    let _ = std::process::Command::new("reg").args(["delete", &format!(r"HKCU\{}", key), "/f"]).status()?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn registry_unregister(_t: &BrowserTarget) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifests_name_the_host_and_allow_the_extension() {
        let chrome: serde_json::Value = serde_json::from_str(&manifest_json(Family::Chromium, Path::new("/Applications/Gloss.app/Contents/MacOS/gloss-bridge"))).unwrap();
        assert_eq!(chrome["name"], HOST_NAME);
        assert_eq!(chrome["type"], "stdio");
        assert_eq!(chrome["path"], "/Applications/Gloss.app/Contents/MacOS/gloss-bridge");
        let origin = chrome["allowed_origins"][0].as_str().unwrap();
        assert!(origin.starts_with("chrome-extension://") && origin.ends_with('/'));
        assert_eq!(origin.len(), "chrome-extension://".len() + 32 + 1);
        let firefox: serde_json::Value = serde_json::from_str(&manifest_json(Family::Firefox, Path::new("/x"))).unwrap();
        assert_eq!(firefox["allowed_extensions"][0], FIREFOX_EXTENSION_ID);
        assert!(firefox.get("allowed_origins").is_none());
        assert!(translocated(Path::new("/private/var/folders/x/AppTranslocation/abc/d/Gloss.app/Contents/MacOS/gloss-bridge")));
        assert!(!translocated(Path::new("/Applications/Gloss.app/Contents/MacOS/gloss-bridge")));
    }

    #[test]
    fn registration_writes_only_for_installed_browsers() {
        let dir = tempfile::tempdir().unwrap();
        let present = BrowserTarget { id: "t", name: "Test", family: Family::Chromium, dir: dir.path().join("Test/NativeMessagingHosts") };
        std::fs::create_dir_all(dir.path().join("Test")).unwrap();
        assert!(installed(&present));
        let absent = BrowserTarget { id: "a", name: "Absent", family: Family::Firefox, dir: dir.path().join("Absent/NativeMessagingHosts") };
        // Windows browsers find the host through the registry, so every
        // browser there counts as installed and gets its registration.
        assert_eq!(installed(&absent), cfg!(target_os = "windows"));
    }
}
