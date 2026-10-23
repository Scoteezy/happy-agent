//! The IPC writer owns this worker, including while Python is executing.
//!
//! Observe hang-up independently of the synchronous request handler. Never read
//! protocol bytes here and never put a duration limit on a live owner's work.

// This module is the narrow native descriptor boundary; the interpreter stays safe Rust.
#![allow(unsafe_code)]

use std::io;

pub(crate) fn watch() -> io::Result<()> {
    let watcher = Watcher::new()?;
    let _ = std::thread::Builder::new()
        .name("monty-owner".into())
        .spawn(move || {
            let status = if watcher.wait().is_ok() { 0 } else { 74 };
            // The interpreter may hold allocator or stdio locks. Do not run
            // destructors or exit handlers after its owner disappears.
            // SAFETY: terminates this worker only; no borrowed data escapes the process.
            unsafe { libc::_exit(status) };
        })?;
    Ok(())
}

#[cfg(target_os = "macos")]
struct Watcher(std::os::fd::OwnedFd);

#[cfg(target_os = "macos")]
impl Watcher {
    fn new() -> io::Result<Self> {
        use std::os::fd::{FromRawFd, OwnedFd};
        // SAFETY: kqueue has no arguments and returns a fresh owned descriptor on success.
        let descriptor = unsafe { libc::kqueue() };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: descriptor is a fresh, valid descriptor owned exclusively by this scope.
        let queue = unsafe { OwnedFd::from_raw_fd(descriptor) };
        let change = libc::kevent {
            ident: 0,
            filter: libc::EVFILT_READ,
            flags: libc::EV_ADD | libc::EV_CLEAR,
            fflags: 0,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        // SAFETY: the change points to one initialized event; no output buffer is supplied.
        if unsafe {
            libc::kevent(
                descriptor,
                &change,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(queue))
    }

    fn wait(self) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        loop {
            // SAFETY: kevent is a C record whose zeroed integer and pointer fields are valid.
            let mut event = unsafe { std::mem::zeroed::<libc::kevent>() };
            // SAFETY: the owned queue remains open and event is writable for one result.
            let count = unsafe {
                libc::kevent(
                    self.0.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    &mut event,
                    1,
                    std::ptr::null(),
                )
            };
            if count < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if event.flags & libc::EV_ERROR != 0 {
                return Err(io::Error::from_raw_os_error(event.data as i32));
            }
            if event.flags & libc::EV_EOF != 0 {
                return Ok(());
            }
            // EV_CLEAR delivers input readiness once per arrival. Unread
            // frames neither spin this thread nor hide a later writer close.
        }
    }
}

#[cfg(target_os = "linux")]
struct Watcher;

#[cfg(target_os = "linux")]
impl Watcher {
    fn new() -> io::Result<Self> {
        Ok(Self)
    }

    fn wait(self) -> io::Result<()> {
        let mut descriptor = libc::pollfd {
            fd: 0,
            events: 0,
            revents: 0,
        };
        loop {
            // SAFETY: descriptor is one initialized pollfd, writable for the duration of poll.
            if unsafe { libc::poll(&mut descriptor, 1, -1) } < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if descriptor.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
                return Err(io::Error::other("worker IPC input failed"));
            }
            if descriptor.revents & libc::POLLHUP != 0 {
                return Ok(());
            }
        }
    }
}
