//! Minimal file-access shim. Native builds read from disk; wasm32 builds read
//! from an in-memory table the host (JS) fills via `register` before use.
use std::io;
use std::path::Path;

#[cfg(target_arch = "wasm32")]
static FILES: std::sync::Mutex<std::collections::BTreeMap<String, Vec<u8>>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

#[cfg(target_arch = "wasm32")]
pub fn register(path: &str, bytes: Vec<u8>) {
    FILES.lock().unwrap().insert(path.to_string(), bytes);
}

pub fn read(path: &Path) -> io::Result<Vec<u8>> {
    #[cfg(target_arch = "wasm32")]
    {
        let key = path.to_string_lossy().replace('\\', "/");
        FILES
            .lock()
            .unwrap()
            .get(&key)
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, key))
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::fs::read(path)
    }
}
