//! Sonda de tests: usa la misma función de apagado que el servidor real.
use markvi_server::watch::shutdown_signal;

#[tokio::main]
async fn main() {
    println!("ready");
    shutdown_signal().await;
    println!("bye");
}
