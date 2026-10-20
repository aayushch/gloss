//! Starts or brings forward the Gloss app from the bridge, which runs while
//! the app may not: the browser spawns the bridge whenever the extension
//! connects, even with Gloss closed.

use std::process::Command;

/// Opens a `gloss://` URL with the system, which launches Gloss when it is
/// not running and hands the URL to it when it is.
pub fn open_url(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let ok = Command::new("open").arg(url).status().map(|s| s.success()).unwrap_or(false);
        if ok {
            return Ok(());
        }
        // The URL scheme is registered only once Gloss has been launched
        // from its installed location; the bundle id works regardless.
        Command::new("open").args(["-b", "sh.aay.gloss"]).status()?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(url).status()?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd").args(["/c", "start", "", url]).status()?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = url;
        Err(std::io::Error::other("no way to launch Gloss on this platform"))
    }
}
