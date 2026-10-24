// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

//! Safari's own API for the extension that ships inside Gloss.app: whether
//! the user has turned it on, and opening Safari's Extensions settings at
//! it. Both calls go through the SafariServices framework and only work
//! from the app that contains the extension, which Gloss is.
#![cfg(target_os = "macos")]

use std::ffi::CStr;
use std::panic::AssertUnwindSafe;
use std::sync::mpsc;
use std::time::Duration;

use block2::{ManualBlockEncoding, RcBlock};
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};
use objc2_foundation::NSString;

#[link(name = "SafariServices", kind = "framework")]
extern "C" {}

/// Bundle identifier of `Gloss Extension.appex`, as the Xcode project sets it.
pub const EXTENSION_ID: &str = "sh.aay.gloss.Extension";

/// Safari answers these calls asynchronously; this is how long to wait.
const WAIT: Duration = Duration::from_secs(5);

// SafariServices forwards each completion block over an XPC connection,
// which refuses a block that carries no Objective-C type signature. These
// give the two completion blocks the signatures a compiler would emit:
// `void (^)(id, id)` and `void (^)(id)`.
struct StateAndError;
unsafe impl ManualBlockEncoding for StateAndError {
    type Arguments = (*mut AnyObject, *mut AnyObject);
    type Return = ();
    const ENCODING_CSTR: &'static CStr = c"v24@?0@8@16";
}

struct ErrorOnly;
unsafe impl ManualBlockEncoding for ErrorOnly {
    type Arguments = (*mut AnyObject,);
    type Return = ();
    const ENCODING_CSTR: &'static CStr = c"v16@?0@8";
}

/// The text of an NSError, or a generic line when Safari gave none.
fn describe(err: *mut AnyObject) -> String {
    if err.is_null() {
        return "Safari gave no reason".into();
    }
    unsafe {
        let desc: *mut NSString = msg_send![err, localizedDescription];
        if desc.is_null() {
            "Safari gave no reason".into()
        } else {
            (*desc).to_string()
        }
    }
}

/// Whether the extension is enabled in Safari. The error names what Safari
/// said, such as the extension not being registered with it yet. Blocks for
/// up to `WAIT`, so call it off the main thread. An Objective-C exception
/// from the call becomes an error rather than ending the process.
pub fn extension_enabled() -> Result<bool, String> {
    let (tx, rx) = mpsc::channel::<Result<bool, String>>();
    let block = RcBlock::with_encoding::<_, _, _, StateAndError>(
        move |state: *mut AnyObject, err: *mut AnyObject| {
            let result = if state.is_null() {
                Err(describe(err))
            } else {
                let enabled: Bool = unsafe { msg_send![state, isEnabled] };
                Ok(enabled.as_bool())
            };
            let _ = tx.send(result);
        },
    );
    let ident = NSString::from_str(EXTENSION_ID);
    let ident_ref: &NSString = &ident;
    let block_ref: &block2::Block<_> = &block;
    let called = objc2::exception::catch(AssertUnwindSafe(|| unsafe {
        let _: () = msg_send![
            class!(SFSafariExtensionManager),
            getStateOfSafariExtensionWithIdentifier: ident_ref,
            completionHandler: block_ref
        ];
    }));
    if let Err(e) = called {
        return Err(format!("Safari refused the request: {e:?}"));
    }
    rx.recv_timeout(WAIT)
        .unwrap_or_else(|_| Err("Safari did not answer".into()))
}

/// Opens Safari's Settings › Extensions pane at the Gloss extension, where
/// the user turns it on. Same rules as `extension_enabled`.
pub fn show_preferences() -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let block = RcBlock::with_encoding::<_, _, _, ErrorOnly>(move |err: *mut AnyObject| {
        let _ = tx.send(if err.is_null() {
            Ok(())
        } else {
            Err(describe(err))
        });
    });
    let ident = NSString::from_str(EXTENSION_ID);
    let ident_ref: &NSString = &ident;
    let block_ref: &block2::Block<_> = &block;
    let called = objc2::exception::catch(AssertUnwindSafe(|| unsafe {
        let _: () = msg_send![
            class!(SFSafariApplication),
            showPreferencesForExtensionWithIdentifier: ident_ref,
            completionHandler: block_ref
        ];
    }));
    if let Err(e) = called {
        return Err(format!("Safari refused the request: {e:?}"));
    }
    rx.recv_timeout(WAIT)
        .unwrap_or_else(|_| Err("Safari did not answer".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Outside Gloss.app Safari answers with an error rather than a state;
    // the point is that the call comes back through the bridging, with
    // neither an abort nor a caught exception.
    #[test]
    fn asks_safari_for_the_extension_state() {
        let r = extension_enabled();
        println!("state: {r:?}");
        if let Err(e) = &r {
            assert!(!e.contains("refused"), "{e}");
        }
    }
}
