//! Incorpora la salida del build de Bun al binario.
//!
//! No ejecuta Bun: el orden del build es explícito en `package.json`
//! (`bun run frontend:build` antes de `cargo build`). Si falta la salida,
//! el error indica qué comando hay que ejecutar.

use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=frontend/dist");

    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let dist = crate_dir.join("frontend").join("dist");
    let manifest = dist.join("manifest.json");
    if !manifest.is_file() {
        panic!(
            "no existe {}. Ejecuta `bun run frontend:build` antes de compilar Markvi.",
            manifest.display()
        );
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&dist).expect("lectura de frontend/dist") {
        let path = entry.expect("entrada de frontend/dist").path();
        if !path.is_file() || path.file_name().is_some_and(|name| name == "manifest.json") {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        entries.push((name, path));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut code = String::from("// Generado por build.rs. No editar.\n");
    code.push_str(&format!(
        "pub const MANIFEST: &str = include_str!({:?});\n",
        manifest.to_string_lossy()
    ));
    code.push_str("pub static FILES: &[(&str, &[u8])] = &[\n");
    for (name, path) in &entries {
        code.push_str(&format!(
            "    ({:?}, include_bytes!({:?})),\n",
            format!("/{name}"),
            path.to_string_lossy()
        ));
    }
    code.push_str("];\n");

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("frontend_assets.rs");
    fs::write(out, code).expect("escritura de frontend_assets.rs");
}
